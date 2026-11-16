#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { getStateDir } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');

const DEFAULT_REMOTE_PORT = 18765;
const MAX_ACTION_BODY_BYTES = 256 * 1024;
const CONFIG_FILE_NAME = 'remote-config.json';

// ==================== 配置与内网安全校验 ====================

function getRemoteConfigPath() {
  return path.join(getStateDir(), CONFIG_FILE_NAME);
}

function loadOrCreateRemoteConfig(options = {}) {
  const { resetToken = false } = options;
  const cfgPath = getRemoteConfigPath();
  const loaded = safeReadJsonSync(cfgPath, null);
  const existing = (loaded.ok && loaded.data && typeof loaded.data === 'object') ? loaded.data : {};

  const envPort = Number(process.env.AG_REMOTE_PORT);
  const port = (Number.isInteger(envPort) && envPort > 0 && envPort < 65536)
    ? envPort
    : ((Number.isInteger(existing.port) && existing.port > 0 && existing.port < 65536) ? existing.port : DEFAULT_REMOTE_PORT);

  let token = (!resetToken && typeof existing.token === 'string' && existing.token.length >= 24)
    ? existing.token
    : '';
  let changed = !loaded.ok || !existing.token || resetToken || existing.port !== port;

  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }

  const next = {
    port,
    token,
    updatedAt: changed ? new Date().toISOString() : (existing.updatedAt || new Date().toISOString())
  };

  if (changed) {
    safeWriteJsonSync(cfgPath, next, {
      indent: 2,
      validate: (d) => d && typeof d.token === 'string' && d.token.length >= 24
    });
    try {
      fs.chmodSync(cfgPath, 0o600);
    } catch {}
  }

  return next;
}

function normalizeRemoteIp(rawAddr) {
  let ip = String(rawAddr || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  return ip.toLowerCase();
}

function parseIpv4Parts(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return parts;
}

function isTailscaleCgnatIpv4(ip) {
  const p = parseIpv4Parts(ip);
  return Boolean(p && p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

function isRfc1918Ipv4(ip) {
  const p = parseIpv4Parts(ip);
  if (!p) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function isAllowedPrivateAddress(rawAddr) {
  const ip = normalizeRemoteIp(rawAddr);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const p = parseIpv4Parts(ip);
  if (p) {
    if (p[0] === 127) return true;
    if (isRfc1918Ipv4(ip)) return true;
    if (isTailscaleCgnatIpv4(ip)) return true;
    return false;
  }
  // 链路本地 fe80::/10 与 ULA fc00::/7 (包含 Tailscale IPv6 fd7a:...)
  if (/^fe[89ab][0-9a-f]:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

function enumerateLocalAddresses() {
  const nets = os.networkInterfaces();
  const tailscale = [];
  const lan = [];
  const seen = new Set();

  for (const [ifName, entries] of Object.entries(nets)) {
    for (const info of entries || []) {
      if (!info || info.family !== 'IPv4' || info.internal) continue;
      const addr = String(info.address || '').trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);

      if (isTailscaleCgnatIpv4(addr)) {
        tailscale.push({ iface: ifName, address: addr, kind: 'tailscale' });
      } else if (isRfc1918Ipv4(addr)) {
        lan.push({ iface: ifName, address: addr, kind: 'lan' });
      }
    }
  }

  // en0 / en1 排到局域网首位
  lan.sort((a, b) => {
    const score = (x) => (x.iface === 'en0' ? 0 : (x.iface.startsWith('en') ? 1 : 2));
    return score(a) - score(b);
  });

  const bindIps = ['127.0.0.1', ...tailscale.map((x) => x.address), ...lan.map((x) => x.address)];
  return { tailscale, lan, bindIps };
}

function timingSafeTokenMatch(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(cookieHeader) {
  const map = {};
  const raw = String(cookieHeader || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { map[k] = decodeURIComponent(v); } catch { map[k] = v; }
    }
  }
  return map;
}

function extractRequestToken(req, urlObj) {
  const queryToken = urlObj.searchParams.get('token') || '';
  const headerToken = String(req.headers['x-ag-remote-token'] || '').trim();
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.ag_remote_token || '';
  return {
    token: queryToken || headerToken || cookieToken,
    fromQuery: Boolean(queryToken)
  };
}

// ==================== 纯 JS 零依赖 QR Code 生成器 (Byte 模式, L 纠错) ====================

const QR_GF_EXP = new Uint8Array(512);
const QR_GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_GF_EXP[i] = x;
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) QR_GF_EXP[i] = QR_GF_EXP[i - 255];
})();

function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
}

function qrRsGenPoly(ecLen) {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = QR_GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function qrRsEncode(dataBytes, ecLen) {
  const gen = qrRsGenPoly(ecLen);
  const res = new Uint8Array(dataBytes.length + ecLen);
  res.set(dataBytes, 0);
  for (let i = 0; i < dataBytes.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= qrGfMul(gen[j], coef);
      }
    }
  }
  return Array.from(res.slice(dataBytes.length));
}

// [version]: [totalDataBytes, ecBytesPerBlock, group1Blocks, group1Data, group2Blocks, group2Data, alignCenters]
const QR_SPECS_L = {
  1:  [19,   7, 1, 19, 0,  0, []],
  2:  [34,  10, 1, 34, 0,  0, [6, 18]],
  3:  [55,  15, 1, 55, 0,  0, [6, 22]],
  4:  [80,  20, 1, 80, 0,  0, [6, 26]],
  5:  [108, 26, 1, 108, 0, 0, [6, 30]],
  6:  [136, 18, 2, 68, 0,  0, [6, 34]],
  7:  [156, 20, 2, 78, 0,  0, [6, 22, 38]],
  8:  [194, 24, 2, 97, 0,  0, [6, 24, 42]],
  9:  [232, 30, 2, 116, 0, 0, [6, 26, 46]],
  10: [274, 18, 2, 68, 2, 69, [6, 28, 50]]
};

function encodeQrCodeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const charCountBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + charCountBits + bytes.length * 8;
    if (neededBits <= QR_SPECS_L[v][0] * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('QR URL 过长');

  const [totalDataBytes, ecPerBlock, g1Count, g1Data, g2Count, g2Data, alignPos] = QR_SPECS_L[version];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataBytes * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  for (let idx = 0; bits.length < maxBits; idx++) {
    pushBits(padBytes[idx % 2], 8);
  }

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    dataBytes.push(byte);
  }

  const blocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1Count; i++) {
    const blk = dataBytes.slice(offset, offset + g1Data);
    offset += g1Data;
    blocks.push(blk);
    ecBlocks.push(qrRsEncode(blk, ecPerBlock));
  }
  for (let i = 0; i < g2Count; i++) {
    const blk = dataBytes.slice(offset, offset + g2Data);
    offset += g2Data;
    blocks.push(blk);
    ecBlocks.push(qrRsEncode(blk, ecPerBlock));
  }

  const interleaved = [];
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) interleaved.push(ec[i]);
  }

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFixed = (r, c, val) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = val;
    reserved[r][c] = true;
  };

  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const onBorder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = onBorder && (
          r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        );
        setFixed(rr, cc, dark);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFixed(6, i, dark);
    setFixed(i, 6, dark);
  }
  setFixed(size - 8, 8, true); // Dark module

  // Alignment patterns
  if (alignPos.length) {
    for (const r of alignPos) {
      for (const c of alignPos) {
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFixed(r + dr, c + dc, dark);
          }
        }
      }
    }
  }

  // Reserve format info cells
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
    if (i < 8) {
      reserved[8][size - 1 - i] = true;
      reserved[size - 1 - i][8] = true;
    }
  }

  // Reserve & write 18-bit version info for v >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFixed(a, b, bit);
      setFixed(b, a, bit);
    }
  }

  // Place data bits in zig-zag order
  const dataBits = [];
  for (const byte of interleaved) {
    for (let b = 7; b >= 0; b--) dataBits.push(((byte >>> b) & 1) === 1);
  }
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (!reserved[r][c]) {
          modules[r][c] = bitIdx < dataBits.length ? dataBits[bitIdx++] : false;
        }
      }
    }
    upward = !upward;
  }

  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r, _c) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  const writeFormat = (grid, maskId) => {
    const data = (0b01 << 3) | maskId; // ECC L = 01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmtBits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = ((fmtBits >>> i) & 1) === 1;
      if (i < 6) grid[i][8] = bit;
      else if (i < 8) grid[i + 1][8] = bit;
      else grid[size - 15 + i][8] = bit;

      if (i < 8) grid[8][size - 1 - i] = bit;
      else if (i < 9) grid[8][15 - i] = bit;
      else grid[8][15 - i - 1] = bit;
    }
  };

  const evalPenalty = (grid) => {
    let score = 0;
    for (let r = 0; r < size; r++) {
      let runCol = 1;
      let runRow = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) runRow++;
        else { if (runRow >= 5) score += 3 + (runRow - 5); runRow = 1; }
        if (grid[c][r] === grid[c - 1][r]) runCol++;
        else { if (runCol >= 5) score += 3 + (runCol - 5); runCol = 1; }
      }
      if (runRow >= 5) score += 3 + (runRow - 5);
      if (runCol >= 5) score += 3 + (runCol - 5);
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
      }
    }
    return score;
  };

  let bestGrid = null;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const grid = modules.map((row, r) => row.map((v, c) => (reserved[r][c] ? v : (v ^ maskFns[m](r, c)))));
    writeFormat(grid, m);
    const sc = evalPenalty(grid);
    if (sc < bestScore) {
      bestScore = sc;
      bestGrid = grid;
    }
  }
  return bestGrid;
}

function renderTerminalQr(url) {
  const grid = encodeQrCodeMatrix(url);
  const size = grid.length;
  const pad = 2;
  const total = size + pad * 2;
  const isDark = (r, c) => {
    const rr = r - pad;
    const cc = c - pad;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false;
    return grid[rr][cc];
  };
  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let row = '';
    for (let c = 0; c < total; c++) {
      // 白底黑码使用终端反色呈现（暗模块输出空格还是█按常规黑底白码反转以兼容所有终端）
      const top = isDark(r, c);
      const bot = r + 1 < total ? isDark(r + 1, c) : false;
      // 反色：浅色终端/深色终端下白边黑码更易识别
      if (!top && !bot) row += '█';
      else if (top && bot) row += ' ';
      else if (top && !bot) row += '▄';
      else row += '▀';
    }
    lines.push(row);
  }
  return lines.join('\n');
}

// ==================== CDP 目标枚举与脚本求值 ====================

function getDevToolsPortFile() {
  const appData = process.env.APPDATA || (
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config')
  );
  return path.join(appData, 'Antigravity', 'DevToolsActivePort');
}

async function listAntigravityCdpTargets() {
  const portFile = getDevToolsPortFile();
  if (!fs.existsSync(portFile)) {
    throw new Error('Antigravity 未运行或未开启远程调试端口');
  }
  const firstLine = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]?.trim();
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('DevToolsActivePort 端口号无效');
  }

  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2500)
  });
  if (!res.ok) {
    throw new Error(`查询 Antigravity CDP 页面列表失败 (${res.status})`);
  }
  const pages = await res.json();
  return (Array.isArray(pages) ? pages : [])
    .filter((p) => p && p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(String(p.url || '')) && p.webSocketDebuggerUrl)
    .map((p) => ({
      id: String(p.id),
      title: String(p.title || 'Antigravity'),
      url: String(p.url || ''),
      wsUrl: String(p.webSocketDebuggerUrl)
    }));
}

function evalInCdpTarget(wsUrl, expression, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('CDP 请求超时'));
    }, timeoutMs);

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true
        }
      }));
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        if (msg.error) {
          finish(new Error(msg.error.message || 'CDP Runtime.evaluate 错误'));
        } else if (msg.result?.exceptionDetails) {
          const desc = msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text || '页面执行异常';
          finish(new Error(desc));
        } else {
          finish(null, msg.result?.result?.value);
        }
      } catch (e) {
        finish(e);
      }
    });

    ws.addEventListener('error', () => finish(new Error('CDP WebSocket 连接失败')));
  });
}

async function pickCdpTarget(requestedId) {
  const targets = await listAntigravityCdpTargets();
  if (!targets.length) {
    throw new Error('未找到激活的 Antigravity 对话窗口');
  }
  const cleanWindows = targets.map((t) => ({ id: t.id, title: t.title }));
  if (requestedId) {
    const found = targets.find((t) => t.id === requestedId);
    if (found) return { target: found, windows: cleanWindows };
  }
  return { target: targets[0], windows: cleanWindows };
}

async function fetchSnapshotFromTarget(requestedTargetId) {
  const { target, windows } = await pickCdpTarget(requestedTargetId);
  const expr = `(() => {
    const fn = window.__AGEnhancer?.getMobileSnapshot;
    if (typeof fn !== 'function') {
      return { ok: false, error: '当前窗口尚未注入增强挂件 (请确保 live-host 已连接)' };
    }
    return fn();
  })()`;
  const snap = await evalInCdpTarget(target.wsUrl, expr);
  if (!snap || typeof snap !== 'object') {
    throw new Error('未能读取窗口快照');
  }
  return {
    ...snap,
    currentTargetId: target.id,
    windows
  };
}

async function performActionInTarget(payload) {
  const { target } = await pickCdpTarget(payload?.targetId);
  const serialized = JSON.stringify(payload || {});
  const expr = `(async () => {
    const fn = window.__AGEnhancer?.performMobileAction;
    if (typeof fn !== 'function') {
      return { ok: false, error: '当前窗口尚未注入 v1.6.0 控制接口' };
    }
    return await fn(${serialized});
  })()`;
  const actionResult = await evalInCdpTarget(target.wsUrl, expr, 6000);
  const settleMs = payload?.action === 'switch-conversation' ? 250 : 120;
  await new Promise((r) => setTimeout(r, settleMs));
  const snapshot = await fetchSnapshotFromTarget(target.id).catch(() => null);
  return {
    ok: Boolean(actionResult?.ok),
    actionResult: actionResult || null,
    snapshot
  };
}

// ==================== 移动端极速 PWA HTML & 资源 ====================

function buildMobileIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#09090b"/>
  <circle cx="256" cy="256" r="172" fill="none" stroke="url(#g)" stroke-width="26"/>
  <path d="M256 124 L350 364 L302 364 L280 304 L232 304 L210 364 L162 364 Z M256 184 L241 264 L271 264 Z" fill="#f4f4f5"/>
</svg>`;
}

function buildManifestJson() {
  return JSON.stringify({
    name: 'Antigravity 极速遥控',
    short_name: 'AG Remote',
    start_url: '/',
    display: 'standalone',
    background_color: '#09090b',
    theme_color: '#09090b',
    icons: [
      { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
}

function buildServiceWorkerJs() {
  return `'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
`;
}

function buildUnauthorizedHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Antigravity 遥控未授权</title>
  <style>
    body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:#09090b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
    .card{max-width:400px;width:100%;padding:22px;border-radius:16px;background:#18181b;border:1px solid rgba(255,255,255,.12);line-height:1.6}
    h1{margin:0 0 10px;font-size:18px}
    p{margin:0 0 12px;color:#a1a1aa;font-size:14px}
    code{display:block;padding:10px 12px;border-radius:10px;background:#09090b;color:#38bdf8;font-size:13px;border:1px solid rgba(56,189,248,.25)}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔒 需要配对口令</h1>
    <p>当前浏览器未携带有效的遥控配对 Token。请在 Mac 终端运行下方命令重新扫码打开：</p>
    <code>ag-context-meter remote</code>
  </div>
</body>
</html>`;
}

function buildMobileAppHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#09090b">
  <title>Antigravity Remote</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon.svg">
  <style>
    :root{
      --bg:#09090b;--card:#18181b;--card2:#27272a;--border:rgba(255,255,255,.1);
      --fg:#f4f4f5;--muted:#a1a1aa;--accent:#38bdf8;--green:#34d399;--amber:#fbbf24;--red:#f87171;
      --vvh:100dvh;
    }
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    html,body{
      margin:0;padding:0;width:100%;height:var(--vvh,100dvh);position:fixed;inset:0;overflow:hidden;
      background:var(--bg);color:var(--fg);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;
      font-size:14px;line-height:1.45;overscroll-behavior:none;
    }
    .app{
      display:flex;flex-direction:column;width:100%;height:100%;
      padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);
      padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);
    }
    .topbar{
      flex-shrink:0;display:flex;align-items:center;gap:6px;padding:8px 10px;
      border-bottom:1px solid var(--border);background:rgba(24,24,27,.94);backdrop-filter:blur(14px);
    }
    .icon-btn{
      appearance:none;border:1px solid var(--border);background:var(--card2);color:var(--fg);
      border-radius:10px;height:34px;min-width:34px;padding:0 9px;font-size:13px;font-weight:600;
      display:inline-flex;align-items:center;justify-content:center;gap:4px;flex-shrink:0;cursor:pointer;
    }
    .icon-btn.is-on{border-color:rgba(52,211,153,.55);background:rgba(16,185,129,.18);color:var(--green)}
    .title-wrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
    .title-row{display:flex;align-items:center;gap:6px;min-width:0}
    .dot{width:8px;height:8px;border-radius:99px;background:var(--green);flex-shrink:0}
    .dot.busy{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .dot.err{background:var(--red)}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.85)}}
    .conv-title{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sub-meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .quota-pill{
      appearance:none;border:1px solid var(--border);background:var(--card2);color:var(--fg);
      border-radius:10px;padding:4px 8px;font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;
      flex-shrink:0;cursor:pointer;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;
    }
    .quota-pill span:last-child{font-size:10px;color:var(--muted);font-weight:500}
    .quota-drawer{
      position:fixed;top:calc(env(safe-area-inset-top) + 52px);right:10px;left:10px;max-width:360px;margin-left:auto;
      z-index:60;background:#18181b;border:1px solid rgba(255,255,255,.16);border-radius:14px;
      padding:12px;box-shadow:0 16px 40px rgba(0,0,0,.6);
    }
    .quota-drawer[hidden]{display:none}
    .qcard{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--border);margin-bottom:8px}
    .qhead{display:flex;justify-content:space-between;font-weight:600;font-size:12.5px;margin-bottom:6px}
    .qsub{margin-top:5px}
    .qsub-row{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px}
    .qbar{height:5px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden}
    .qfill{height:100%;border-radius:99px}
    .qreset{font-size:10.5px;color:var(--muted);margin-top:2px}
    .messages{
      flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
      padding:10px 12px;display:flex;flex-direction:column;gap:10px;
    }
    .msg{border-radius:14px;padding:10px 12px;word-break:break-word;white-space:pre-wrap}
    .msg.user{align-self:flex-end;max-width:88%;background:#0369a1;color:#f0f9ff;border-bottom-right-radius:4px}
    .msg.assistant{align-self:stretch;background:var(--card);border:1px solid var(--border)}
    .msg.assistant.is-risk{border-color:rgba(248,113,113,.65);box-shadow:0 0 0 1px rgba(248,113,113,.2)}
    .risk-tag{
      display:block;margin-bottom:6px;padding:4px 8px;border-radius:8px;
      background:rgba(239,68,68,.16);border:1px solid rgba(239,68,68,.45);color:#fca5a5;font-size:12px;font-weight:600;
    }
    .thought-box{margin-bottom:8px;padding:6px 9px;border-radius:9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12px;color:#d4d4d8}
    .thought-box summary{cursor:pointer;font-weight:600;color:#93c5fd;list-style:none}
    .thought-body{margin-top:6px;white-space:pre-wrap;color:#a1a1aa;max-height:220px;overflow-y:auto}
    .empty-tip{margin:auto;text-align:center;color:var(--muted);padding:24px 12px;font-size:13px}
    .approval-dock{
      flex-shrink:0;padding:8px 10px;background:rgba(24,24,27,.98);border-top:1px solid var(--border);
      display:flex;flex-direction:column;gap:6px;
    }
    .approval-dock[hidden]{display:none}
    .approval-card{
      padding:8px 10px;border-radius:12px;background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.35);
      display:flex;flex-direction:column;gap:6px;
    }
    .approval-card.is-risk{background:rgba(239,68,68,.14);border-color:rgba(248,113,113,.8)}
    .approval-ctx{font-size:12px;color:#e4e4e7;max-height:54px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
    .approval-btns{display:flex;gap:8px;flex-wrap:wrap}
    .ap-btn{
      flex:1 1 110px;min-height:42px;border-radius:10px;border:none;font-size:14px;font-weight:700;cursor:pointer;
    }
    .ap-btn.approve{background:#10b981;color:#052e16}
    .ap-btn.reject{background:#3f3f46;color:#f4f4f5;border:1px solid rgba(255,255,255,.15)}
    .composer-dock{
      flex-shrink:0;background:rgba(15,15,18,.98);border-top:1px solid var(--border);padding:6px 10px 8px;
      display:flex;flex-direction:column;gap:6px;
    }
    .chips{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding-bottom:1px}
    .chips::-webkit-scrollbar{display:none}
    .chip{
      appearance:none;flex-shrink:0;border:1px solid var(--border);background:var(--card2);color:#e4e4e7;
      border-radius:999px;padding:6px 11px;font-size:12.5px;white-space:nowrap;cursor:pointer;
    }
    .chip.suggest{border-color:rgba(56,189,248,.45);background:rgba(56,189,248,.14);color:#7dd3fc;font-weight:500}
    .chip.stop{border-color:rgba(248,113,113,.5);background:rgba(239,68,68,.16);color:#fca5a5}
    .input-row{display:flex;align-items:flex-end;gap:8px}
    textarea{
      flex:1 1 auto;min-height:40px;max-height:110px;resize:none;border-radius:12px;
      border:1px solid rgba(255,255,255,.16);background:#18181b;color:var(--fg);
      padding:9px 12px;font-size:15px;line-height:1.35;font-family:inherit;outline:none;
    }
    textarea:focus{border-color:var(--accent)}
    .send-btn{
      flex-shrink:0;height:40px;min-width:60px;border:none;border-radius:12px;
      background:var(--accent);color:#082f49;font-size:14.5px;font-weight:700;cursor:pointer;
    }
    .send-btn:disabled{opacity:.45}
    .drawer-backdrop{
      position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.58);display:flex;justify-content:flex-start;
    }
    .drawer-backdrop[hidden]{display:none}
    .drawer{
      width:min(82vw,320px);height:100%;background:#18181b;border-right:1px solid var(--border);
      padding:calc(env(safe-area-inset-top) + 12px) 12px calc(env(safe-area-inset-bottom) + 12px);
      display:flex;flex-direction:column;gap:10px;overflow-y:auto;
    }
    .drawer-h{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:15px}
    .win-select{
      width:100%;padding:8px 10px;border-radius:10px;background:#27272a;color:var(--fg);
      border:1px solid var(--border);font-size:13px;
    }
    .conv-item{
      width:100%;text-align:left;padding:10px 12px;border-radius:10px;border:1px solid transparent;
      background:rgba(255,255,255,.04);color:var(--fg);font-size:13.5px;cursor:pointer;
    }
    .conv-item.active{border-color:rgba(56,189,248,.6);background:rgba(56,189,248,.14);font-weight:600}
    .toast{
      position:fixed;top:calc(env(safe-area-inset-top) + 56px);left:50%;transform:translateX(-50%);
      z-index:80;background:#27272a;color:#fff;padding:7px 14px;border-radius:999px;font-size:12.5px;
      border:1px solid rgba(255,255,255,.15);box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;
    }
    .toast[hidden]{display:none}
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <button id="btn-drawer" class="icon-btn" type="button" aria-label="会话与窗口">☰</button>
      <div class="title-wrap">
        <div class="title-row">
          <span id="status-dot" class="dot"></span>
          <span id="conv-title" class="conv-title">正在连接 Mac…</span>
        </div>
        <div id="sub-meta" class="sub-meta">Tailscale / 内网直连</div>
      </div>
      <button id="btn-quota" class="quota-pill" type="button">
        <span id="quota-main">G4 -- · C --</span>
        <span id="ctx-badge">--%</span>
      </button>
      <button id="btn-wake" class="icon-btn" type="button" title="屏幕常亮防锁屏">🔆</button>
      <button id="btn-auto" class="icon-btn" type="button" title="安全自动确认">🤖 关</button>
    </header>

    <div id="quota-drawer" class="quota-drawer" hidden></div>

    <main id="messages" class="messages">
      <div class="empty-tip">正在读取桌面端对话画面…</div>
    </main>

    <section id="approval-dock" class="approval-dock" hidden></section>

    <footer class="composer-dock">
      <div id="chips" class="chips"></div>
      <div class="input-row">
        <textarea id="input" rows="1" placeholder="发消息给桌面端 Antigravity…"></textarea>
        <button id="btn-send" class="send-btn" type="button">发送</button>
      </div>
    </footer>
  </div>

  <div id="drawer-backdrop" class="drawer-backdrop" hidden>
    <div class="drawer">
      <div class="drawer-h">
        <span>会话与窗口</span>
        <button id="btn-new-chat" class="icon-btn" type="button">+ 新对话</button>
      </div>
      <select id="win-select" class="win-select"></select>
      <div id="conv-list" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>
  </div>

  <div id="toast" class="toast" hidden></div>

  <script>
  (function(){
    const urlParams = new URLSearchParams(location.search);
    const urlToken = urlParams.get('token') || '';
    if (urlToken) {
      history.replaceState(null, '', location.pathname);
    }

    let currentTargetId = '';
    let latestSnap = null;
    let wakeLock = null;
    let wakeWanted = false;
    let pollTimer = null;
    let toastTimer = null;
    let sending = false;
    let stickBottom = true;

    const $ = (id) => document.getElementById(id);
    const msgEl = $('messages');

    function syncViewportHeight() {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      document.documentElement.style.setProperty('--vvh', h + 'px');
      document.body.style.transform = top ? 'translateY(' + top + 'px)' : '';
      if (stickBottom) msgEl.scrollTop = msgEl.scrollHeight;
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportHeight);
      window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    window.addEventListener('resize', syncViewportHeight);
    syncViewportHeight();

    msgEl.addEventListener('scroll', () => {
      stickBottom = (msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight) < 80;
    });

    function showToast(txt) {
      const el = $('toast');
      el.textContent = txt;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
    }

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function fmtPct(frac) {
      return typeof frac === 'number' ? Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%' : '--%';
    }
    function fmtPctOne(frac) {
      return typeof frac === 'number' ? (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%' : '--%';
    }
    function fmtReset(iso) {
      if (!iso) return '重置时间未知';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const diffMin = Math.floor((d.getTime() - Date.now()) / 60000);
      const hhmm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      if (diffMin <= 0) return '即将重置 · ' + hhmm;
      const days = Math.floor(diffMin / 1440);
      const hrs = Math.floor((diffMin % 1440) / 60);
      const mins = diffMin % 60;
      const cd = days > 0 ? days + '天' + hrs + 'h' : (hrs > 0 ? hrs + 'h' + mins + 'm' : mins + 'm');
      return cd + '后重置 · ' + (d.getMonth()+1) + '/' + d.getDate() + ' ' + hhmm;
    }
    function qColor(frac) {
      if (typeof frac !== 'number') return '#9ca3af';
      const p = frac * 100;
      return p >= 50 ? '#34d399' : (p >= 20 ? '#fbbf24' : '#f87171');
    }

    async function apiAction(payload) {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: currentTargetId || undefined, ...payload })
      });
      if (res.status === 401) {
        location.reload();
        return null;
      }
      const data = await res.json();
      if (data?.snapshot) renderSnapshot(data.snapshot);
      return data;
    }

    function renderQuotaDrawer(snap) {
      const box = $('quota-drawer');
      if (box.hidden) return;
      const renderPool = (title, pool) => {
        const rows = [];
        if (pool?.fiveHour) {
          rows.push(['⏱️ 5 小时限额', pool.fiveHour]);
        }
        if (pool?.weekly) {
          rows.push(['📅 每周限额', pool.weekly]);
        }
        if (!rows.length && pool) {
          rows.push(['当前额度', pool]);
        }
        return '<div class="qcard"><div class="qhead"><span>' + esc(title) + '</span><span style="color:' + qColor(pool?.remainingFraction) + '">' + fmtPctOne(pool?.remainingFraction) + '</span></div>' +
          rows.map(([label, b]) => {
            const pct = typeof b.remainingFraction === 'number' ? Math.max(0, Math.min(100, b.remainingFraction * 100)) : 0;
            const col = qColor(b.remainingFraction);
            return '<div class="qsub"><div class="qsub-row"><span>' + esc(label) + '</span><strong style="color:' + col + '">' + fmtPctOne(b.remainingFraction) + '</strong></div>' +
              '<div class="qbar"><div class="qfill" style="width:' + pct.toFixed(1) + '%;background:' + col + '"></div></div>' +
              '<div class="qreset">' + esc(fmtReset(b.resetTime)) + '</div></div>';
          }).join('') + '</div>';
      };
      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<strong style="font-size:13.5px">双窗口剩余配额</strong>' +
          '<button id="btn-refresh-quota" class="icon-btn" style="height:26px;font-size:12px" type="button">↻ 刷新</button>' +
        '</div>' +
        renderPool('Gemini 4 / 3.8', snap?.quota?.gemini) +
        renderPool('Claude 5.5 / GPT', snap?.quota?.claude);
      $('btn-refresh-quota').onclick = async () => {
        await apiAction({ action: 'refresh-quota' });
        showToast('已刷新配额');
      };
    }

    function renderSnapshot(snap) {
      if (!snap || snap.ok === false) {
        $('status-dot').className = 'dot err';
        $('conv-title').textContent = snap?.error || '连接异常';
        return;
      }
      latestSnap = snap;
      if (snap.currentTargetId) currentTargetId = snap.currentTargetId;

      $('status-dot').className = snap.busy ? 'dot busy' : 'dot';
      $('conv-title').textContent = snap.title || 'Antigravity';
      $('sub-meta').textContent = [snap.model || '', snap.pulseText || (snap.busy ? 'AI 正在运行…' : '空闲')].filter(Boolean).join(' · ');

      const gStr = fmtPct(snap.quota?.gemini?.remainingFraction);
      const cStr = fmtPct(snap.quota?.claude?.remainingFraction);
      $('quota-main').textContent = 'G4 ' + gStr + ' · C ' + cStr;
      $('ctx-badge').textContent = snap.contextBadge || '--%';

      const autoBtn = $('btn-auto');
      autoBtn.textContent = snap.autoAccept ? '🤖 开' : '🤖 关';
      autoBtn.classList.toggle('is-on', Boolean(snap.autoAccept));

      renderQuotaDrawer(snap);

      // Messages
      const wasBottom = stickBottom;
      const msgs = Array.isArray(snap.messages) ? snap.messages : [];
      if (!msgs.length) {
        msgEl.innerHTML = '<div class="empty-tip">当前会话暂无消息，直接发送指令或点左上方切换对话</div>';
      } else {
        const html = msgs.map((m) => {
          if (m.role === 'user') {
            return '<div class="msg user">' + esc(m.text) + '</div>';
          }
          const risk = m.highRisk ? '<span class="risk-tag">' + esc(m.riskText || '🛡️ 检测到高危命令，请人工核对') + '</span>' : '';
          const thought = m.thoughtLabel
            ? '<details class="thought-box"><summary>💡 ' + esc(m.thoughtLabel) + (m.thoughtText ? '（点此看思考译文）' : '（桌面端折叠中）') + '</summary>' +
              (m.thoughtText ? '<div class="thought-body">' + esc(m.thoughtText) + '</div>' : '') + '</details>'
            : '';
          return '<div class="msg assistant' + (m.highRisk ? ' is-risk' : '') + '">' + risk + thought + esc(m.text || (snap.busy ? '正在生成内容…' : '')) + '</div>';
        }).join('');
        if (msgEl.dataset.lastHtml !== html) {
          msgEl.innerHTML = html;
          msgEl.dataset.lastHtml = html;
          if (wasBottom) msgEl.scrollTop = msgEl.scrollHeight;
        }
      }

      // Pending Approvals
      const approvals = Array.isArray(snap.pendingApprovals) ? snap.pendingApprovals : [];
      const dock = $('approval-dock');
      if (!approvals.length) {
        dock.hidden = true;
        dock.innerHTML = '';
      } else {
        dock.hidden = false;
        const firstRisk = approvals.some((a) => a.highRisk);
        const ctx = approvals[0]?.contextText || '桌面端正在等待你的操作确认';
        dock.innerHTML = '<div class="approval-card' + (firstRisk ? ' is-risk' : '') + '">' +
          (firstRisk ? '<div style="font-size:12px;font-weight:700;color:#fca5a5">' + esc(approvals[0].riskText || '🛡️ 高危操作确认') + '</div>' : '') +
          '<div class="approval-ctx">' + esc(ctx) + '</div>' +
          '<div class="approval-btns">' + approvals.map((a) =>
            '<button class="ap-btn ' + (a.kind === 'reject' ? 'reject' : 'approve') + '" data-idx="' + a.index + '" data-label="' + esc(a.label) + '" type="button">' +
            (a.kind === 'reject' ? '❌ ' : '✅ ') + esc(a.label) + '</button>'
          ).join('') + '</div></div>';
        dock.querySelectorAll('.ap-btn').forEach((btn) => {
          btn.onclick = async () => {
            btn.disabled = true;
            const res = await apiAction({ action: 'click-approval', index: Number(btn.dataset.idx), label: btn.dataset.label });
            if (res?.ok) showToast('已触发: ' + btn.dataset.label);
            else showToast(res?.actionResult?.error || '操作失败');
          };
        });
      }

      // Quick Chips & Next Step Suggestions
      const chips = $('chips');
      const items = [];
      if (snap.busy) {
        items.push({ cls: 'chip stop', text: '⏹ 停止生成', act: () => apiAction({ action: 'stop' }) });
      } else {
        for (const s of (snap.suggestions || [])) {
          items.push({ cls: 'chip suggest', text: '💡 ' + s, raw: s, isSuggest: true });
        }
      }
      items.push({ cls: 'chip', text: '🗜️ /compact', act: () => apiAction({ action: 'send', text: '/compact' }) });
      items.push({ cls: 'chip', text: '💡 展开/收起思考', act: () => apiAction({ action: 'toggle-thinking' }) });

      chips.innerHTML = '';
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = it.cls;
        b.textContent = it.text;
        b.onclick = async () => {
          if (it.isSuggest) {
            const ta = $('input');
            if (!ta.value.trim()) {
              stickBottom = true;
              await apiAction({ action: 'send', text: it.raw });
              showToast('已发送建议');
            } else {
              ta.value = it.raw;
              ta.focus();
            }
          } else if (it.act) {
            await it.act();
          }
        };
        chips.appendChild(b);
      }

      // Drawer Windows & Conversations
      const winSel = $('win-select');
      if (Array.isArray(snap.windows)) {
        const winHtml = snap.windows.map((w) =>
          '<option value="' + esc(w.id) + '"' + (w.id === currentTargetId ? ' selected' : '') + '>窗口：' + esc(w.title) + '</option>'
        ).join('');
        if (winSel.dataset.lastHtml !== winHtml) {
          winSel.innerHTML = winHtml;
          winSel.dataset.lastHtml = winHtml;
        }
      }
      const convList = $('conv-list');
      if (Array.isArray(snap.conversations)) {
        const convHtml = snap.conversations.map((c) =>
          '<button class="conv-item' + (c.active ? ' active' : '') + '" data-cid="' + esc(c.id) + '" type="button">' + esc(c.title) + '</button>'
        ).join('');
        if (convList.dataset.lastHtml !== convHtml) {
          convList.innerHTML = convHtml;
          convList.dataset.lastHtml = convHtml;
        }
      }
    }

    async function fetchSnapshot() {
      try {
        const q = currentTargetId ? '?targetId=' + encodeURIComponent(currentTargetId) : '';
        const res = await fetch('/api/snapshot' + q, { cache: 'no-store' });
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json();
        renderSnapshot(data);
      } catch {
        $('status-dot').className = 'dot err';
        $('sub-meta').textContent = '连接中断，正在重连…';
      } finally {
        schedulePoll();
      }
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      if (document.hidden) return;
      const ms = latestSnap?.busy ? 900 : 2500;
      pollTimer = setTimeout(fetchSnapshot, ms);
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void fetchSnapshot();
        if (wakeWanted) void acquireWakeLock();
      } else {
        clearTimeout(pollTimer);
      }
    });
    window.addEventListener('pageshow', () => { void fetchSnapshot(); });

    async function acquireWakeLock() {
      if (!('wakeLock' in navigator)) return false;
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
        return true;
      } catch {
        return false;
      }
    }

    $('btn-wake').onclick = async () => {
      wakeWanted = !wakeWanted;
      if (wakeWanted) {
        const ok = await acquireWakeLock();
        $('btn-wake').classList.toggle('is-on', ok);
        showToast(ok ? '🔆 屏幕常亮已开启' : '当前浏览器不支持常亮锁');
        if (!ok) wakeWanted = false;
      } else {
        if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
        $('btn-wake').classList.remove('is-on');
        showToast('已关闭屏幕常亮');
      }
    };

    $('btn-auto').onclick = async () => {
      const r = await apiAction({ action: 'toggle-auto-accept' });
      if (r?.ok) showToast(r.actionResult?.autoAccept ? '🤖 已开启安全自动确认' : '🤖 已关闭自动确认');
    };

    $('btn-quota').onclick = (e) => {
      e.stopPropagation();
      const box = $('quota-drawer');
      box.hidden = !box.hidden;
      if (!box.hidden && latestSnap) renderQuotaDrawer(latestSnap);
    };
    document.addEventListener('click', (e) => {
      const box = $('quota-drawer');
      if (!box.hidden && !box.contains(e.target) && e.target !== $('btn-quota')) box.hidden = true;
    });

    $('conv-list').addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('.conv-item');
      if (!btn || !btn.dataset.cid) return;
      $('drawer-backdrop').hidden = true;
      stickBottom = true;
      showToast('正在切换会话…');
      const r = await apiAction({ action: 'switch-conversation', id: btn.dataset.cid });
      if (!r?.ok) showToast(r?.actionResult?.error || '切换会话失败');
    });
    $('btn-drawer').onclick = () => { $('drawer-backdrop').hidden = false; };
    $('drawer-backdrop').onclick = (e) => { if (e.target === $('drawer-backdrop')) $('drawer-backdrop').hidden = true; };
    $('btn-new-chat').onclick = async () => {
      $('drawer-backdrop').hidden = true;
      await apiAction({ action: 'switch-conversation', id: 'new' });
    };
    $('win-select').onchange = () => {
      currentTargetId = $('win-select').value;
      $('drawer-backdrop').hidden = true;
      stickBottom = true;
      void fetchSnapshot();
    };

    const ta = $('input');
    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(110, Math.max(40, ta.scrollHeight)) + 'px';
    };
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('focus', () => { setTimeout(syncViewportHeight, 120); });

    async function sendInput() {
      const text = ta.value.trim();
      if (!text || sending) return;
      sending = true;
      $('btn-send').disabled = true;
      try {
        stickBottom = true;
        const r = await apiAction({ action: 'send', text });
        if (r?.ok) {
          ta.value = '';
          autoGrow();
        } else {
          showToast(r?.actionResult?.error || '发送失败');
        }
      } finally {
        sending = false;
        $('btn-send').disabled = false;
      }
    }
    $('btn-send').onclick = sendInput;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendInput();
      }
    });

    void fetchSnapshot();
  })();
  </script>
</body>
</html>`;
}

// ==================== HTTP 服务器管理器（仅监听本机回环 + 内网私网 IP） ====================

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let len = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > MAX_ACTION_BODY_BYTES) {
        aborted = true;
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function createRemoteHttpHandler(initialConfig) {
  let activeConfig = initialConfig;
  let lastMtimeMs = 0;
  try {
    lastMtimeMs = fs.statSync(getRemoteConfigPath()).mtimeMs;
  } catch {}

  const getActiveConfig = () => {
    try {
      const cfgPath = getRemoteConfigPath();
      const mtime = fs.statSync(cfgPath).mtimeMs;
      if (mtime !== lastMtimeMs) {
        lastMtimeMs = mtime;
        activeConfig = loadOrCreateRemoteConfig();
      }
    } catch {}
    return activeConfig;
  };

  const cachedHtml = buildMobileAppHtml();
  const cachedIcon = buildMobileIconSvg();
  const cachedManifest = buildManifestJson();
  const cachedSw = buildServiceWorkerJs();
  const cached401 = buildUnauthorizedHtml();

  return async (req, res) => {
    const config = getActiveConfig();
    const remoteIp = req.socket?.remoteAddress || '';
    if (!isAllowedPrivateAddress(remoteIp)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden: Private network only');
      return;
    }

    const hostHeader = String(req.headers.host || `127.0.0.1:${config.port}`);
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', `http://${hostHeader}`);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    const pathname = urlObj.pathname;

    // 静态 PWA 元数据无任何敏感状态，允许系统桌面图标抓取稳定通过
    if (pathname === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(cachedIcon);
      return;
    }
    if (pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(cachedManifest);
      return;
    }
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(cachedSw);
      return;
    }

    const { token, fromQuery } = extractRequestToken(req, urlObj);
    const authed = timingSafeTokenMatch(token, config.token);
    if (!authed) {
      if (pathname.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '未授权，请在终端运行 ag-context-meter remote 重新扫码' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(cached401);
      }
      return;
    }

    if (fromQuery) {
      res.setHeader('Set-Cookie', `ag_remote_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(cachedHtml);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      try {
        const targetId = urlObj.searchParams.get('targetId') || '';
        const snap = await fetchSnapshotFromTarget(targetId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(snap));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取 Antigravity 状态失败' }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      try {
        const payload = await readJsonBody(req);
        const result = await performActionInTarget(payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err?.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '操作失败' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  };
}

function startMobileRemoteServer() {
  const config = loadOrCreateRemoteConfig();
  const handler = createRemoteHttpHandler(config);
  const boundServers = new Map();
  let stopped = false;

  const tryBindAddress = (ip) => {
    if (stopped || boundServers.has(ip)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.once('error', () => {
        try { srv.close(); } catch {}
        resolve(false);
      });
      srv.listen(config.port, ip, () => {
        boundServers.set(ip, srv);
        resolve(true);
      });
    });
  };

  const syncBindings = async () => {
    const { bindIps } = enumerateLocalAddresses();
    for (const ip of bindIps) {
      await tryBindAddress(ip);
    }
  };

  const ifaceTimer = setInterval(() => {
    if (!stopped) void syncBindings();
  }, 15000);
  ifaceTimer.unref?.();

  void syncBindings().then(() => {
    const activeIps = Array.from(boundServers.keys());
    if (activeIps.length) {
      console.log(`Mobile Remote PWA ready on port ${config.port} (${activeIps.join(', ')})`);
    }
  });

  return {
    config,
    getBoundAddresses: () => Array.from(boundServers.keys()),
    stop: () => {
      stopped = true;
      clearInterval(ifaceTimer);
      for (const srv of boundServers.values()) {
        try { srv.close(); } catch {}
      }
      boundServers.clear();
    }
  };
}

function buildRemoteInfo({ resetToken = false } = {}) {
  const cfg = loadOrCreateRemoteConfig({ resetToken });
  const { tailscale, lan } = enumerateLocalAddresses();
  const buildUrl = (ip) => `http://${ip}:${cfg.port}/?token=${cfg.token}`;
  const tailscaleUrls = tailscale.map((x) => ({ ...x, url: buildUrl(x.address) }));
  const lanUrls = lan.map((x) => ({ ...x, url: buildUrl(x.address) }));
  const primary = tailscaleUrls[0] || lanUrls[0] || { iface: 'lo0', address: '127.0.0.1', kind: 'loopback', url: buildUrl('127.0.0.1') };
  return {
    port: cfg.port,
    token: cfg.token,
    configPath: getRemoteConfigPath(),
    primaryUrl: primary.url,
    primaryKind: primary.kind,
    tailscaleUrls,
    lanUrls,
    localUrl: buildUrl('127.0.0.1')
  };
}

function printRemoteCli({ resetToken = false, jsonMode = false } = {}) {
  const info = buildRemoteInfo({ resetToken });
  if (jsonMode) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log('');
  console.log('📱 Antigravity 手机极速遥控面板（纯内网直连 / 免修改官方包）');
  if (resetToken) console.log('🔑 已重置并生成新的配对 Token（旧链接将自动失效）');
  console.log('');

  if (info.tailscaleUrls.length) {
    console.log(`✅ Tailscale 内网首选（支持外出 4G/5G 安全直连）：`);
    for (const item of info.tailscaleUrls) {
      console.log(`   [${item.iface}] ${item.url}`);
    }
  } else {
    console.log('⭕ 当前未检测到在线 Tailscale IP（仅显示同一 Wi-Fi 局域网链接；开启 Tailscale 后会自动热绑定并支持出门 5G 访问）');
  }

  if (info.lanUrls.length) {
    console.log('📶 同 Wi-Fi 局域网直连：');
    for (const item of info.lanUrls) {
      console.log(`   [${item.iface}] ${item.url}`);
    }
  }
  console.log(`🖥️ 本机调试地址：${info.localUrl}`);
  console.log('');
  console.log('📷 用 iPhone 相机扫描下方二维码即可打开：');
  console.log('');
  console.log(renderTerminalQr(info.primaryUrl));
  console.log('');
  console.log('💡 iPhone 最佳防杀后台 & 全屏无遮挡配置：');
  console.log('   1. 扫码在 Safari 打开后，点击底部「分享」→「添加到主屏幕」');
  console.log('   2. 以后直接从桌面图标启动，即成为独立全屏 App（已内置键盘防遮挡与切回秒刷新）');
  console.log('   3. 盯着长任务时可点右上角 🔆 图标开启屏幕常亮防锁屏');
  console.log('');
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--print-info')) {
    printRemoteCli({
      resetToken: args.has('--reset-token'),
      jsonMode: args.has('--json')
    });
  } else {
    startMobileRemoteServer();
  }
}

module.exports = {
  DEFAULT_REMOTE_PORT,
  loadOrCreateRemoteConfig,
  isAllowedPrivateAddress,
  enumerateLocalAddresses,
  encodeQrCodeMatrix,
  renderTerminalQr,
  startMobileRemoteServer,
  buildRemoteInfo,
  printRemoteCli
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getStateDir, resolveActiveCdpTarget } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');

const DEFAULT_REMOTE_PORT = 18765;
const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const CONFIG_FILE_NAME = 'remote-config.json';
const MOBILE_UI_VERSION = '1.7.1';

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

const isVirtualBridgeIface = (name) => /^(?:bridge|vmenet|vmnet|vboxnet|docker|br-|veth|awdl|llw|utun)/i.test(String(name || ''));

function enumerateLocalAddresses() {
  const nets = os.networkInterfaces();
  const tailscale = [];
  const lan = [];
  const tailscaleIpv6 = [];
  const seen = new Set();

  for (const [ifName, entries] of Object.entries(nets)) {
    for (const info of entries || []) {
      if (!info || info.internal) continue;
      const addr = String(info.address || '').trim();
      if (!addr) continue;
      if (info.family === 'IPv6') {
        const cleanV6 = normalizeRemoteIp(addr);
        if (/^fd7a:115c:a1e0:/i.test(cleanV6) && !seen.has(cleanV6)) {
          seen.add(cleanV6);
          tailscaleIpv6.push(cleanV6);
        }
        continue;
      }
      if (info.family !== 'IPv4' || seen.has(addr)) continue;
      seen.add(addr);

      if (isTailscaleCgnatIpv4(addr)) {
        tailscale.push({ iface: ifName, address: addr, kind: 'tailscale' });
      } else if (isRfc1918Ipv4(addr)) {
        lan.push({ iface: ifName, address: addr, kind: 'lan' });
      }
    }
  }

  // 物理网卡 (en0 / en* / eth* / wlan*) 排在虚拟网桥 (bridge100 等) 之前
  lan.sort((a, b) => {
    const score = (x) => {
      if (isVirtualBridgeIface(x.iface)) return 3;
      if (x.iface === 'en0') return 0;
      if (/^(?:en|eth|wlan|wi-fi)/i.test(x.iface)) return 1;
      return 2;
    };
    return score(a) - score(b);
  });

  const physicalLan = lan.filter((x) => !isVirtualBridgeIface(x.iface));
  const bindIps = ['127.0.0.1', '::1', ...tailscale.map((x) => x.address), ...lan.map((x) => x.address), ...tailscaleIpv6];
  return { tailscale, lan, physicalLan, tailscaleIpv6, bindIps };
}

let cachedHostMeta = null;
let cachedHostMetaAt = 0;

function detectHostIdentityMeta({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedHostMeta && now - cachedHostMetaAt < 45000) {
    return cachedHostMeta;
  }

  const skipProbes = process.env.AG_REMOTE_SKIP_PROBES === '1';
  let localHostLabel = '';
  if (!skipProbes && process.platform === 'darwin') {
    try {
      localHostLabel = execFileSync('scutil', ['--get', 'LocalHostName'], {
        timeout: 500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {}
  }
  if (!localHostLabel) {
    localHostLabel = String(os.hostname() || '').trim();
  }
  localHostLabel = localHostLabel.replace(/\.+$/, '').replace(/\.local$/i, '').trim();
  const bonjourHost = localHostLabel ? `${localHostLabel}.local` : '';

  let tailscaleDnsName = '';
  let tailscaleNodeName = '';
  if (!skipProbes) {
    const tsBins = process.platform === 'darwin'
      ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
      : ['tailscale'];
    for (const bin of tsBins) {
      try {
        const out = execFileSync(bin, ['status', '--json'], {
          timeout: 800,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const parsed = JSON.parse(out);
        const dns = String(parsed?.Self?.DNSName || '').trim().replace(/\.+$/, '');
        const hostName = String(parsed?.Self?.HostName || '').trim();
        if (dns) tailscaleDnsName = dns;
        if (dns) tailscaleNodeName = dns.split('.')[0] || hostName;
        else if (hostName) tailscaleNodeName = hostName;
        break;
      } catch {}
    }
  }

  const deviceName = tailscaleNodeName || localHostLabel || 'antigravity-mac';
  cachedHostMeta = { localHostLabel, bonjourHost, tailscaleDnsName, tailscaleNodeName, deviceName };
  cachedHostMetaAt = now;
  return cachedHostMeta;
}

function encodeEndpointsParam(endpoints) {
  const compact = (Array.isArray(endpoints) ? endpoints : [])
    .filter((ep) => ep && typeof ep.url === 'string' && /^https?:\/\//i.test(ep.url))
    .map(({ url, kind, priority }) => ({
      url,
      kind: String(kind || 'lan'),
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 100
    }));
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
}

function decodeEndpointsParam(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((ep) => ep && typeof ep.url === 'string' && /^https?:\/\//i.test(ep.url))
      .map((ep) => ({
        url: String(ep.url),
        kind: String(ep.kind || 'lan'),
        priority: Number.isFinite(Number(ep.priority)) ? Number(ep.priority) : 100
      }));
  } catch {
    return [];
  }
}

function formatHostForUrl(host) {
  const clean = String(host || '').trim();
  if (!clean) return '127.0.0.1';
  if (clean.includes(':') && !clean.startsWith('[')) return `[${clean}]`;
  return clean;
}

function buildFusedPairingUrl({ entryHost, port, token, name, hosts, endpoints }) {
  const authority = `${formatHostForUrl(entryHost)}:${port}`;
  const cleanHosts = Array.isArray(hosts) ? hosts.filter(Boolean) : [];
  const encodedEndpoints = encodeEndpointsParam(endpoints);
  return `http://${authority}/?token=${encodeURIComponent(token || '')}`
    + `&address=${encodeURIComponent(authority)}`
    + `&name=${encodeURIComponent(name || 'antigravity-mac')}`
    + `&hosts=${encodeURIComponent(cleanHosts.join(','))}`
    + `&endpoints=${encodedEndpoints}`;
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
    fromQuery: Boolean(queryToken),
    fromCookie: Boolean(!queryToken && !headerToken && cookieToken),
    uiVersion: cookies.ag_ui_ver || ''
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
  10: [274, 18, 2, 68, 2, 69, [6, 28, 50]],
  11: [324, 20, 4, 81, 0,  0, [6, 30, 54]],
  12: [370, 24, 2, 92, 2, 93, [6, 32, 58]],
  13: [428, 26, 4, 107, 0, 0, [6, 34, 62]],
  14: [461, 30, 3, 115, 1, 116, [6, 26, 46, 66]],
  15: [523, 22, 5, 87, 1, 88, [6, 26, 48, 70]],
  16: [589, 24, 5, 98, 1, 99, [6, 26, 50, 74]],
  17: [647, 28, 1, 107, 5, 108, [6, 30, 54, 78]],
  18: [721, 30, 5, 120, 1, 121, [6, 30, 56, 82]],
  19: [795, 28, 3, 113, 4, 114, [6, 30, 58, 86]],
  20: [861, 28, 3, 107, 5, 108, [6, 34, 62, 90]]
};

function encodeQrCodeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
  let version = 0;
  for (let v = 1; v <= 20; v++) {
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

function renderQrSvg(url) {
  const grid = encodeQrCodeMatrix(url);
  const size = grid.length;
  const pad = 3;
  const total = size + pad * 2;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        pathData += `M${c + pad} ${r + pad}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="200" height="200" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="2.5" fill="#ffffff"/><path d="${pathData}" fill="#09090b"/></svg>`;
}

// ==================== CDP 目标枚举与脚本求值 ====================

async function listAntigravityCdpTargets() {
  const { port, targets } = await resolveActiveCdpTarget({ timeoutMs: 2500 });
  if (!port) {
    throw new Error('Antigravity 未运行或未开启远程调试端口');
  }
  return targets
    .filter((p) => p && p.webSocketDebuggerUrl)
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
    name: 'Antigravity 远程操作',
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
  <title>Antigravity 远程未授权</title>
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
    <p>当前浏览器未携带有效的远程配对 Token。请在 Mac 终端运行下方命令重新扫码打开：</p>
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
      --app-h:100dvh;
    }
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    html,body{
      margin:0;padding:0;width:100%;height:100%;position:fixed;top:0;left:0;right:0;bottom:0;overflow:hidden;
      background:var(--bg);color:var(--fg);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;
      font-size:14px;line-height:1.45;overscroll-behavior:none;
    }
    .app{
      display:flex;flex-direction:column;width:100%;height:100%;
      padding-top:env(safe-area-inset-top);
      padding-bottom:max(8px,calc(env(safe-area-inset-bottom,0px) - 10px));
      padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);
    }
    .app.kb-open{padding-bottom:4px}
    .topbar{
      flex-shrink:0;display:flex;align-items:center;gap:8px;padding:8px 12px;
      border-bottom:1px solid rgba(255,255,255,.07);background:rgba(12,12,15,.88);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    }
    .icon-btn{
      appearance:none;border:none;background:transparent;color:#a1a1aa;
      border-radius:10px;height:34px;min-width:34px;padding:0 6px;
      display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;
    }
    .icon-btn:active{background:rgba(255,255,255,.08);color:#fff}
    .title-wrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
    .title-row{display:flex;align-items:center;gap:6px;min-width:0}
    .dot{width:7px;height:7px;border-radius:99px;background:var(--green);flex-shrink:0}
    .dot.busy{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .dot.err{background:var(--red)}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}
    .conv-title{font-size:15px;font-weight:600;color:#fafafa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
    .sub-meta{font-size:11px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
    .quota-pill{
      appearance:none;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.05);color:#e4e4e7;
      border-radius:11px;padding:5px 10px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;
      flex-shrink:0;cursor:pointer;display:flex;flex-direction:column;align-items:flex-end;line-height:1.2;gap:1px;
    }
    .quota-pill span:last-child{font-size:10px;color:#71717a;font-weight:500}
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
      padding:14px 16px 12px;display:flex;flex-direction:column;gap:16px;
    }
    .msg{word-break:break-word}
    .msg.user{
      align-self:flex-end;max-width:84%;padding:10px 14px;border-radius:18px 18px 4px 18px;
      background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#f8fafc;
      font-size:14.5px;line-height:1.48;white-space:pre-wrap;
      box-shadow:0 2px 12px rgba(37,99,235,.22);
    }
    .msg.assistant{align-self:stretch;background:transparent;border:none;padding:2px 2px}
    .msg.assistant .msg-plain{white-space:pre-wrap;font-size:14.5px;line-height:1.65;color:#e4e4e7}
    .msg.assistant.is-risk{padding:10px 12px;border-radius:14px;background:rgba(239,68,68,.06);border:1px solid rgba(248,113,113,.5)}
    .busy-pill{
      display:inline-flex;align-items:center;gap:8px;align-self:flex-start;
      padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
      font-size:12.5px;color:#a1a1aa;
    }
    .busy-spark{width:7px;height:7px;border-radius:99px;background:#38bdf8;animation:pulse 1s infinite ease-in-out}
    .md-body{font-size:14px;line-height:1.62;color:var(--fg)}
    .md-body>:first-child{margin-top:0}
    .md-body>:last-child{margin-bottom:0}
    .md-body h1{font-size:19px;font-weight:700;margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--border);line-height:1.35;color:#fff}
    .md-body h2{font-size:17px;font-weight:700;margin:12px 0 6px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.07);line-height:1.35;color:#fff}
    .md-body h3{font-size:15.5px;font-weight:700;margin:11px 0 5px;line-height:1.38;color:#f4f4f5}
    .md-body h4,.md-body h5,.md-body h6{font-size:14.5px;font-weight:600;margin:9px 0 4px;color:#e4e4e7}
    .md-body p{margin:6px 0}
    .md-body ul,.md-body ol{margin:6px 0;padding-left:20px}
    .md-body li{margin:4px 0}
    .md-body li>p{margin:2px 0}
    .md-body strong,.md-body b{font-weight:700;color:#fff}
    .md-body em{color:#e4e4e7}
    .md-body hr{border:none;border-top:1px solid var(--border);margin:10px 0}
    .md-body a{color:#38bdf8;text-decoration:underline;text-underline-offset:2px}
    .md-body blockquote{margin:8px 0;padding:6px 10px;border-left:3px solid #38bdf8;background:rgba(56,189,248,.08);border-radius:0 8px 8px 0;color:#d4d4d8}
    .md-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.1);color:#7dd3fc}
    .md-body code.md-pill{background:rgba(56,189,248,.14);border:1px solid rgba(56,189,248,.28);color:#bae6fd}
    .md-body pre{margin:8px 0;padding:10px 12px;border-radius:10px;background:#09090b;border:1px solid rgba(255,255,255,.1);overflow-x:auto;-webkit-overflow-scrolling:touch}
    .md-body pre code{background:none;padding:0;border:none;color:#e4e4e7;font-size:12px;line-height:1.5;white-space:pre}
    .md-table-wrap{margin:8px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:10px}
    .md-body table{width:max-content;min-width:100%;border-collapse:collapse;font-size:12.5px}
    .md-body th,.md-body td{padding:6px 9px;border-bottom:1px solid rgba(255,255,255,.08);border-right:1px solid rgba(255,255,255,.06);text-align:left;vertical-align:top;max-width:260px}
    .md-body th{background:rgba(255,255,255,.05);font-weight:600;color:#fff}
    .md-body tr:last-child td{border-bottom:none}
    .md-body th:last-child,.md-body td:last-child{border-right:none}
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
      flex-shrink:0;background:transparent;padding:2px 10px 4px;
      display:flex;flex-direction:column;gap:6px;
    }
    .chips{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 2px}
    .chips::-webkit-scrollbar{display:none}
    .chip{
      appearance:none;flex-shrink:0;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#a1a1aa;
      border-radius:999px;padding:5px 11px;font-size:12px;white-space:nowrap;cursor:pointer;
    }
    .chip.suggest{border-color:rgba(56,189,248,.32);background:rgba(56,189,248,.09);color:#7dd3fc;font-weight:500}
    .attach-hint{
      display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 12px;border-radius:12px;
      background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.28);font-size:12px;color:#bae6fd;
    }
    .attach-hint[hidden]{display:none}
    .composer-card{
      background:#16161a;border:1px solid rgba(255,255,255,.11);border-radius:22px;
      padding:10px 10px 8px 12px;display:flex;flex-direction:column;gap:6px;
      box-shadow:0 8px 28px rgba(0,0,0,.45);transition:border-color .15s ease;
    }
    .composer-card:focus-within{border-color:rgba(56,189,248,.45)}
    .composer-card textarea{
      width:100%;min-height:28px;max-height:112px;resize:none;border:none;background:transparent;
      color:var(--fg);padding:2px 4px;font-size:15px;line-height:1.42;font-family:inherit;outline:none;
    }
    .composer-card textarea::placeholder{color:#71717a}
    .composer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;padding-top:2px}
    .toolbar-left{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto}
    .toolbar-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .ghost-btn{
      appearance:none;border:none;background:transparent;color:#a1a1aa;
      height:32px;padding:0 7px;border-radius:999px;font-size:12.5px;font-weight:500;
      display:inline-flex;align-items:center;gap:4px;cursor:pointer;min-width:0;max-width:100%;
    }
    .ghost-btn:active{background:rgba(255,255,255,.08);color:#fff}
    .ghost-btn.icon-only{width:32px;padding:0;justify-content:center}
    .ghost-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .send-circle{
      appearance:none;flex-shrink:0;width:32px;height:32px;border-radius:999px;border:none;
      background:#27272a;color:#71717a;display:inline-flex;align-items:center;justify-content:center;
      cursor:pointer;transition:background-color .15s ease,color .15s ease,transform .1s ease;
    }
    .send-circle.ready{background:#38bdf8;color:#082f49}
    .send-circle.stop{background:rgba(239,68,68,.2);color:#f87171;border:1px solid rgba(248,113,113,.45)}
    .send-circle:active{transform:scale(.94)}
    .send-circle:disabled{opacity:.5}
    .sheet-backdrop{
      position:fixed;top:0;left:0;right:0;height:var(--app-h,100vh);z-index:75;background:rgba(0,0,0,.58);display:flex;align-items:flex-end;justify-content:center;
    }
    .sheet-backdrop[hidden]{display:none}
    .sheet{
      width:100%;max-width:520px;max-height:72dvh;background:#18181b;border-top:1px solid rgba(255,255,255,.16);
      border-radius:18px 18px 0 0;padding:12px 14px calc(env(safe-area-inset-bottom) + 14px);
      display:flex;flex-direction:column;gap:8px;overflow:hidden;
    }
    .sheet-title{font-size:15px;font-weight:700;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
    .sheet-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;-webkit-overflow-scrolling:touch}
    .sheet-opt{
      width:100%;text-align:left;padding:11px 12px;border-radius:11px;border:1px solid var(--border);
      background:rgba(255,255,255,.04);color:var(--fg);font-size:14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;
    }
    .sheet-opt.active{border-color:rgba(56,189,248,.65);background:rgba(56,189,248,.16);color:#fff;font-weight:600}
    .drawer-backdrop{
      position:fixed;top:0;left:0;right:0;height:var(--app-h,100vh);z-index:70;background:rgba(0,0,0,0);display:flex;justify-content:flex-start;
      opacity:0;visibility:hidden;pointer-events:none;
      transition:opacity .22s ease,visibility .22s ease,background-color .22s ease;
    }
    .drawer-backdrop.open{
      background:rgba(0,0,0,.58);opacity:1;visibility:visible;pointer-events:auto;
    }
    .drawer-backdrop.dragging{
      transition:none;opacity:1;visibility:visible;pointer-events:auto;
    }
    .drawer{
      width:min(82vw,320px);height:100%;background:#18181b;border-right:1px solid var(--border);
      padding:calc(env(safe-area-inset-top) + 12px) 12px 16px;
      display:flex;flex-direction:column;gap:10px;overflow-y:auto;
      transform:translateX(-100%);transition:transform .24s cubic-bezier(.22,1,.36,1);
      will-change:transform;
    }
    .drawer-backdrop.open .drawer{transform:translateX(0)}
    .drawer-backdrop.dragging .drawer{transition:none}
    .new-chat-btn{
      appearance:none;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#fafafa;
      font-size:14.5px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
      flex-shrink:0;
    }
    .new-chat-btn:active{background:rgba(56,189,248,.18);border-color:rgba(56,189,248,.5);color:#fff}
    .drawer-sub{font-size:12px;font-weight:600;color:#71717a;padding:2px 4px 0;flex-shrink:0}
    .conv-item{
      width:100%;text-align:left;padding:11px 12px;border-radius:11px;border:1px solid transparent;
      background:rgba(255,255,255,.04);color:var(--fg);font-size:14px;cursor:pointer;
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
      <button id="btn-drawer" class="icon-btn" type="button" aria-label="会话与窗口">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>
      </button>
      <div class="title-wrap">
        <div class="title-row">
          <span id="status-dot" class="dot"></span>
          <span id="conv-title" class="conv-title">正在连接 Mac…</span>
        </div>
        <div id="sub-meta" class="sub-meta">内网直连</div>
      </div>
      <button id="btn-quota" class="quota-pill" type="button">
        <span id="quota-main">G4 -- · C --</span>
        <span id="ctx-badge">--%</span>
      </button>
    </header>

    <div id="quota-drawer" class="quota-drawer" hidden></div>

    <main id="messages" class="messages">
      <div class="empty-tip">正在读取桌面端对话画面…</div>
    </main>

    <section id="approval-dock" class="approval-dock" hidden></section>

    <footer class="composer-dock">
      <div id="attach-hint" class="attach-hint" hidden></div>
      <div id="chips" class="chips"></div>
      <div class="composer-card">
        <textarea id="input" rows="1" placeholder="发消息给 Antigravity…"></textarea>
        <input id="img-input" type="file" accept="image/*" multiple hidden>
        <div class="composer-toolbar">
          <div class="toolbar-left">
            <button id="btn-img" class="ghost-btn icon-only" type="button" title="拍照或上传图片" aria-label="上传图片">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button id="btn-model-inline" class="ghost-btn" type="button" title="切换模型">
              <span id="model-inline-label" class="ghost-label">切换模型</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.7"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button id="btn-perm-inline" class="ghost-btn" type="button" title="切换权限预设" style="flex-shrink:0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;color:#fbbf24"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>
              <span id="perm-inline-label">权限</span>
            </button>
          </div>
          <div class="toolbar-right">
            <button id="btn-send" class="send-circle" type="button" aria-label="发送消息">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>

  <div id="sheet-backdrop" class="sheet-backdrop" hidden>
    <div class="sheet">
      <div class="sheet-title">
        <span id="sheet-title-text">选择选项</span>
        <button id="sheet-close" class="icon-btn" style="height:28px;font-size:12px" type="button">关闭</button>
      </div>
      <div id="sheet-list" class="sheet-list"></div>
    </div>
  </div>

  <div id="drawer-backdrop" class="drawer-backdrop" aria-hidden="true">
    <div id="drawer-panel" class="drawer">
      <button id="btn-new-chat" class="new-chat-btn" type="button">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>新建对话</span>
      </button>
      <div class="drawer-sub">历史对话</div>
      <div id="conv-list" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>
  </div>

  <div id="toast" class="toast" hidden></div>

  <script>
  (function(){
    const PAIR_STORAGE_KEY = 'ag_remote_pair_v1';
    function decodeEndpointsClient(raw) {
      if (!raw) return [];
      try {
        let b64 = String(raw).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const json = typeof TextDecoder === 'function' ? new TextDecoder().decode(bytes) : decodeURIComponent(escape(bin));
        const list = JSON.parse(json);
        return Array.isArray(list) ? list.filter((x) => x && typeof x.url === 'string' && /^https?:\\/\\//i.test(x.url)) : [];
      } catch {
        return [];
      }
    }
    function loadStoredPair() {
      try {
        const raw = localStorage.getItem(PAIR_STORAGE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        return (p && typeof p === 'object') ? p : null;
      } catch {
        return null;
      }
    }
    function saveStoredPair(st) {
      try {
        localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify({
          token: st.token || '',
          name: st.name || '',
          hosts: Array.isArray(st.hosts) ? st.hosts : [],
          endpoints: Array.isArray(st.endpoints) ? st.endpoints : []
        }));
      } catch {}
    }

    const urlParams = new URLSearchParams(location.search);
    const urlToken = urlParams.get('token') || '';
    const urlName = urlParams.get('name') || '';
    const urlHosts = (urlParams.get('hosts') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const urlEndpoints = decodeEndpointsClient(urlParams.get('endpoints') || '');
    const storedPair = loadStoredPair() || {};
    const pairState = {
      token: urlToken || storedPair.token || '',
      name: urlName || storedPair.name || '',
      hosts: urlHosts.length ? urlHosts : (Array.isArray(storedPair.hosts) ? storedPair.hosts : []),
      endpoints: urlEndpoints.length ? urlEndpoints : (Array.isArray(storedPair.endpoints) ? storedPair.endpoints : [])
    };
    if (urlToken || urlEndpoints.length || urlHosts.length) {
      saveStoredPair(pairState);
      history.replaceState(null, '', location.pathname);
    }
    let apiBase = '';
    function authHeaders(extra) {
      const h = Object.assign({}, extra || {});
      if (pairState.token) h['X-AG-Remote-Token'] = pairState.token;
      return h;
    }
    function getCandidateEndpoints() {
      const seen = new Set();
      const list = [];
      const add = (url, kind, priority) => {
        const clean = String(url || '').replace(/\\/+$/, '');
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        list.push({ url: clean, kind: kind || 'lan', priority: Number.isFinite(priority) ? priority : 100 });
      };
      for (const ep of (pairState.endpoints || [])) add(ep.url, ep.kind, ep.priority);
      const portStr = location.port ? ':' + location.port : '';
      const proto = location.protocol === 'https:' ? 'https:' : 'http:';
      for (const h of (pairState.hosts || [])) {
        const hostFmt = (h.includes(':') && !h.startsWith('[')) ? ('[' + h + ']') : h;
        const kind = h.endsWith('.local') ? 'bonjour' : (h.includes('.ts.net') || /^100\\./.test(h) ? 'tailscale' : 'lan');
        add(proto + '//' + hostFmt + portStr, kind, 300);
      }
      add(location.origin, 'current', 999);
      list.sort((a, b) => a.priority - b.priority);
      return list;
    }
    let failoverBusy = null;
    async function tryFailoverEndpoint() {
      if (failoverBusy) return failoverBusy;
      failoverBusy = (async () => {
        const candidates = getCandidateEndpoints();
        if (candidates.length <= 1 && !apiBase) return false;
        const probeOne = async (ep) => {
          const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
          const t = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 1800) : null;
          try {
            const r = await fetch(ep.url + '/api/ping', {
              headers: authHeaders(),
              cache: 'no-store',
              signal: ctrl ? ctrl.signal : undefined
            });
            if (!r.ok) return null;
            const d = await r.json().catch(() => null);
            return d && d.ok ? { ep, data: d } : null;
          } catch {
            return null;
          } finally {
            if (t) clearTimeout(t);
          }
        };
        const probed = await Promise.all(candidates.map(probeOne));
        const winner = probed.find(Boolean);
        if (!winner) return false;
        const nextBase = winner.ep.url === location.origin ? '' : winner.ep.url;
        const changed = nextBase !== apiBase;
        apiBase = nextBase;
        if (Array.isArray(winner.data?.endpoints) && winner.data.endpoints.length) {
          pairState.endpoints = winner.data.endpoints;
          if (Array.isArray(winner.data.hosts)) pairState.hosts = winner.data.hosts;
          saveStoredPair(pairState);
        }
        if (changed) {
          const kindName = winner.ep.kind === 'tailscale' ? 'Tailscale' : (winner.ep.kind === 'bonjour' ? 'Bonjour' : 'Wi-Fi');
          showToast('已自动切至 ' + kindName + ' 通道');
        }
        return true;
      })();
      try {
        return await failoverBusy;
      } finally {
        failoverBusy = null;
      }
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

    const appEl = document.querySelector('.app');
    let maxVvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

    function getFullLayoutHeight() {
      const vvH = window.visualViewport ? window.visualViewport.height : 0;
      return Math.round(vvH || window.innerHeight || document.documentElement?.clientHeight || 0);
    }

    function syncViewportHeight() {
      const vv = window.visualViewport;
      const curH = vv ? vv.height : window.innerHeight;
      const isInputFocused = document.activeElement === $('input');
      if (!isInputFocused && curH > maxVvHeight) {
        maxVvHeight = curH;
      }
      const baseH = Math.max(maxVvHeight, window.innerHeight || 0);
      const kbOpen = Boolean(isInputFocused && vv && (baseH - curH > 100));
      if (kbOpen) {
        const top = vv.offsetTop || 0;
        document.body.style.bottom = 'auto';
        document.body.style.height = Math.round(curH) + 'px';
        document.documentElement.style.setProperty('--app-h', Math.round(curH) + 'px');
        document.body.style.transform = top ? 'translateY(' + top + 'px)' : '';
        appEl?.classList.add('kb-open');
      } else {
        document.body.style.bottom = '0';
        document.body.style.height = '100%';
        document.documentElement.style.setProperty('--app-h', getFullLayoutHeight() + 'px');
        document.body.style.transform = '';
        appEl?.classList.remove('kb-open');
      }
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
      const doPost = () => fetch((apiBase || '') + '/api/action', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ targetId: currentTargetId || undefined, ...payload })
      });
      let res;
      try {
        res = await doPost();
      } catch (err) {
        if (await tryFailoverEndpoint()) {
          res = await doPost();
        } else {
          throw err;
        }
      }
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
      $('sub-meta').textContent = snap.pulseText || (snap.busy ? '正在生成内容…' : (snap.contextBadge || '空闲'));

      const gStr = fmtPct(snap.quota?.gemini?.remainingFraction);
      const cStr = fmtPct(snap.quota?.claude?.remainingFraction);
      $('quota-main').textContent = 'G4 ' + gStr + ' · C ' + cStr;
      $('ctx-badge').textContent = snap.contextBadge || '--%';
      $('model-inline-label').textContent = snap.model || '切换模型';
      $('perm-inline-label').textContent = snap.permissionLabel || '权限';

      renderQuotaDrawer(snap);
      syncSendButtonUI();

      // Messages
      const wasBottom = stickBottom;
      const msgs = Array.isArray(snap.messages) ? snap.messages : [];
      if (!msgs.length && !snap.busy) {
        msgEl.innerHTML = '<div class="empty-tip">暂无消息，发一句话或在屏幕右滑切换会话</div>';
      } else {
        let html = msgs.map((m) => {
          if (m.role === 'user') {
            return '<div class="msg user">' + esc(m.text) + '</div>';
          }
          const risk = m.highRisk ? '<span class="risk-tag">' + esc(m.riskText || '🛡️ 检测到高危命令，请人工核对') + '</span>' : '';
          const thought = m.thoughtLabel
            ? '<details class="thought-box"><summary>💡 ' + esc(m.thoughtLabel) + (m.thoughtText ? ' · 展开思考' : '') + '</summary>' +
              (m.thoughtText ? '<div class="thought-body">' + esc(m.thoughtText) + '</div>' : '') + '</details>'
            : '';
          const bodyHtml = m.html
            ? '<div class="md-body">' + m.html + '</div>'
            : '<div class="msg-plain">' + esc(m.text || '') + '</div>';
          return '<div class="msg assistant' + (m.highRisk ? ' is-risk' : '') + '">' + risk + thought + bodyHtml + '</div>';
        }).join('');
        if (snap.busy) {
          html += '<div class="busy-pill"><span class="busy-spark"></span><span>正在思考与执行…</span></div>';
        }
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

      // 轻盈下一步建议 & 快捷操作胶囊（模型/权限已并入输入卡片内部工具栏）
      const chips = $('chips');
      const items = [];
      if (!snap.busy) {
        for (const s of (snap.suggestions || [])) {
          items.push({ cls: 'chip suggest', text: '✦ ' + s, raw: s, isSuggest: true });
        }
      }
      items.push({ cls: 'chip', text: '/compact', act: () => apiAction({ action: 'send', text: '/compact' }) });
      items.push({ cls: 'chip', text: '展开/收起思考', act: () => apiAction({ action: 'toggle-thinking' }) });

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

      // Drawer Conversations
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
      const q = currentTargetId ? '?targetId=' + encodeURIComponent(currentTargetId) : '';
      const doFetch = () => fetch((apiBase || '') + '/api/snapshot' + q, { headers: authHeaders(), cache: 'no-store' });
      try {
        let res = await doFetch();
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json();
        renderSnapshot(data);
      } catch {
        const switched = await tryFailoverEndpoint();
        if (switched) {
          try {
            const retryRes = await doFetch();
            if (retryRes.status === 401) { location.reload(); return; }
            const retryData = await retryRes.json();
            renderSnapshot(retryData);
            return;
          } catch {}
        }
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
      } else {
        clearTimeout(pollTimer);
      }
    });
    window.addEventListener('pageshow', () => { void fetchSnapshot(); });

    function openSheet(title, options, onSelect) {
      $('sheet-title-text').textContent = title;
      const listEl = $('sheet-list');
      listEl.innerHTML = options.map((o, idx) =>
        '<button class="sheet-opt' + (o.active ? ' active' : '') + '" data-idx="' + idx + '" type="button">' +
        '<span>' + esc(o.label) + '</span>' + (o.active ? '<span>✓</span>' : '') + '</button>'
      ).join('');
      listEl.onclick = async (e) => {
        const btn = e.target?.closest?.('.sheet-opt');
        if (!btn) return;
        const opt = options[Number(btn.dataset.idx)];
        $('sheet-backdrop').hidden = true;
        if (opt) await onSelect(opt);
      };
      $('sheet-backdrop').hidden = false;
    }
    $('sheet-close').onclick = () => { $('sheet-backdrop').hidden = true; };
    $('sheet-backdrop').onclick = (e) => { if (e.target === $('sheet-backdrop')) $('sheet-backdrop').hidden = true; };

    function openModelPicker() {
      const opts = (latestSnap?.modelOptions || []).map((m) => ({
        label: m.label,
        modelId: m.modelId,
        active: Boolean(m.selected || m.label === latestSnap?.model)
      }));
      if (!opts.length) {
        showToast('未检测到可用模型列表');
        return;
      }
      openSheet('切换模型', opts, async (opt) => {
        showToast('正在切换至 ' + opt.label + '…');
        const r = await apiAction({ action: 'select-model', label: opt.label, modelId: opt.modelId });
        if (r?.ok) showToast('已切换到 ' + (r.actionResult?.model || opt.label));
        else showToast(r?.actionResult?.error || '切换模型失败');
      });
    }

    function openPermPicker() {
      const cur = (latestSnap?.permissionLabel || '').toLowerCase();
      const opts = (latestSnap?.permissionOptions || [
        { key: 'turbo', label: '⚡ 无限 (Turbo)' },
        { key: 'auto', label: '🛡️ 自动 (Auto)' },
        { key: 'default', label: '🔒 默认 (Default)' },
        { key: 'request_review', label: '👁️ 请求审查 (Review)' }
      ]).map((p) => ({
        key: p.key,
        label: p.label,
        active: Boolean(cur && p.label.toLowerCase().includes(cur))
      }));
      openSheet('切换权限预设', opts, async (opt) => {
        showToast('正在切换权限…');
        const r = await apiAction({ action: 'select-permission', preset: opt.key });
        if (r?.ok) showToast('已切换权限: ' + (r.actionResult?.permissionLabel || opt.label));
        else showToast(r?.actionResult?.error || '切换权限失败');
      });
    }

    $('btn-model-inline').onclick = openModelPicker;
    $('btn-perm-inline').onclick = openPermPicker;

    // 拍照/传图压缩并注入桌面端输入框
    let uploadedNames = [];
    function compressAndReadImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          const lowType = String(file.type || '').toLowerCase();
          if (file.size <= 350 * 1024 && ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(lowType)) {
            resolve({ name: file.name || 'image.jpg', mimeType: file.type, base64: dataUrl });
            return;
          }
          const img = new Image();
          img.onerror = () => resolve({ name: file.name || 'image.jpg', mimeType: file.type || 'image/jpeg', base64: dataUrl });
          img.onload = () => {
            const maxDim = 1920;
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > maxDim || h > maxDim) {
              const scale = maxDim / Math.max(w, h);
              w = Math.round(w * scale);
              h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const outUrl = canvas.toDataURL('image/jpeg', 0.85);
            const baseName = (file.name || 'mobile').replace(/\\.[^.]+$/, '') + '.jpg';
            resolve({ name: baseName, mimeType: 'image/jpeg', base64: outUrl });
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    }

    $('btn-img').onclick = () => $('img-input').click();
    $('img-input').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      showToast('正在上传 ' + files.length + ' 张图片…');
      for (const f of files) {
        try {
          const payload = await compressAndReadImage(f);
          const r = await apiAction({ action: 'upload-image', ...payload });
          if (r?.ok) {
            uploadedNames.push(payload.name);
          } else {
            showToast(r?.actionResult?.error || '传图失败');
          }
        } catch (err) {
          showToast(err?.message || '传图失败');
        }
      }
      if (uploadedNames.length) {
        const hint = $('attach-hint');
        hint.innerHTML = '<span>🖼️ 已传至桌面端: ' + esc(uploadedNames.slice(-3).join('、')) + (uploadedNames.length > 3 ? ' 等' + uploadedNames.length + '张' : '') + '</span><button type="button" style="background:none;border:none;color:#bae6fd;font-weight:700;cursor:pointer">✕</button>';
        hint.querySelector('button').onclick = () => { uploadedNames = []; hint.hidden = true; syncSendButtonUI(); };
        hint.hidden = false;
        syncSendButtonUI();
        showToast('✅ 图片已附带到输入框');
      }
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

    const backdropEl = $('drawer-backdrop');
    const drawerEl = $('drawer-panel');
    function openDrawer() {
      backdropEl.classList.remove('dragging');
      drawerEl.style.transform = '';
      backdropEl.style.backgroundColor = '';
      backdropEl.classList.add('open');
      backdropEl.setAttribute('aria-hidden', 'false');
    }
    function closeDrawer() {
      backdropEl.classList.remove('dragging', 'open');
      drawerEl.style.transform = '';
      backdropEl.style.backgroundColor = '';
      backdropEl.setAttribute('aria-hidden', 'true');
    }

    $('conv-list').addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('.conv-item');
      if (!btn || !btn.dataset.cid) return;
      closeDrawer();
      stickBottom = true;
      showToast('正在切换会话…');
      const r = await apiAction({ action: 'switch-conversation', id: btn.dataset.cid });
      if (!r?.ok) showToast(r?.actionResult?.error || '切换会话失败');
    });
    $('btn-drawer').onclick = openDrawer;
    backdropEl.onclick = (e) => { if (e.target === backdropEl) closeDrawer(); };
    $('btn-new-chat').onclick = async () => {
      closeDrawer();
      showToast('已新建对话');
      await apiAction({ action: 'switch-conversation', id: 'new' });
    };

    // 全屏随手右滑打开左侧抽屉 & 左滑关闭抽屉
    let swipeState = null;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { swipeState = null; return; }
      const t = e.touches[0];
      const isOpen = backdropEl.classList.contains('open');
      const target = e.target;
      if (!isOpen) {
        if (!$('quota-drawer').hidden || !$('sheet-backdrop').hidden) return;
        if (target?.closest?.('pre, .md-table-wrap, .chips, textarea, select')) return;
        if (t.clientX > window.innerWidth * 0.85) return;
      }
      swipeState = {
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
        isOpen,
        dragging: false,
        dx: 0
      };
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!swipeState || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - swipeState.startX;
      const dy = t.clientY - swipeState.startY;
      swipeState.dx = dx;

      if (!swipeState.dragging) {
        if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx)) {
          swipeState = null;
          return;
        }
        const wantOpenDrag = !swipeState.isOpen && dx > 14 && dx > Math.abs(dy) * 1.25;
        const wantCloseDrag = swipeState.isOpen && dx < -14 && Math.abs(dx) > Math.abs(dy) * 1.25;
        if (wantOpenDrag || wantCloseDrag) {
          swipeState.dragging = true;
          backdropEl.classList.add('dragging');
        }
      }

      if (swipeState.dragging) {
        const w = drawerEl.offsetWidth || 300;
        const progress = swipeState.isOpen
          ? Math.max(0, Math.min(1, 1 + dx / w))
          : Math.max(0, Math.min(1, dx / w));
        drawerEl.style.transform = 'translateX(' + ((progress - 1) * 100).toFixed(2) + '%)';
        backdropEl.style.backgroundColor = 'rgba(0,0,0,' + (0.58 * progress).toFixed(3) + ')';
      }
    }, { passive: true });

    const finishSwipe = () => {
      if (!swipeState) return;
      const st = swipeState;
      swipeState = null;
      if (!st.dragging) return;
      const elapsed = Math.max(1, Date.now() - st.startTime);
      const velocity = Math.abs(st.dx) / elapsed;
      if (!st.isOpen) {
        if (st.dx > 52 || (st.dx > 26 && velocity > 0.35)) openDrawer();
        else closeDrawer();
      } else {
        if (st.dx < -45 || (st.dx < -24 && velocity > 0.35)) closeDrawer();
        else openDrawer();
      }
    };
    document.addEventListener('touchend', finishSwipe, { passive: true });
    document.addEventListener('touchcancel', finishSwipe, { passive: true });

    const ta = $('input');
    const SEND_ARROW_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    const STOP_SQUARE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';

    function syncSendButtonUI() {
      const btn = $('btn-send');
      if (!btn) return;
      const hasContent = Boolean(ta.value.trim() || uploadedNames.length);
      if (hasContent) {
        btn.className = 'send-circle ready';
        btn.innerHTML = SEND_ARROW_SVG;
        btn.setAttribute('aria-label', '发送消息');
      } else if (latestSnap?.busy) {
        btn.className = 'send-circle stop';
        btn.innerHTML = STOP_SQUARE_SVG;
        btn.setAttribute('aria-label', '停止生成');
      } else {
        btn.className = 'send-circle';
        btn.innerHTML = SEND_ARROW_SVG;
        btn.setAttribute('aria-label', '发送消息');
      }
    }

    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(112, Math.max(28, ta.scrollHeight)) + 'px';
      syncSendButtonUI();
    };
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('focus', () => { setTimeout(syncViewportHeight, 120); });
    ta.addEventListener('blur', () => { setTimeout(syncViewportHeight, 80); });

    async function sendInput() {
      if (sending) return;
      const rawText = ta.value.trim();
      if (!rawText && !uploadedNames.length && latestSnap?.busy) {
        await apiAction({ action: 'stop' });
        showToast('已请求停止生成');
        return;
      }
      const text = rawText || (uploadedNames.length ? '请查看图片' : '');
      if (!text) return;
      sending = true;
      $('btn-send').disabled = true;
      try {
        stickBottom = true;
        const r = await apiAction({ action: 'send', text });
        if (r?.ok) {
          ta.value = '';
          uploadedNames = [];
          $('attach-hint').hidden = true;
          autoGrow();
        } else {
          showToast(r?.actionResult?.error || '发送失败');
        }
      } finally {
        sending = false;
        $('btn-send').disabled = false;
        syncSendButtonUI();
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

function isAllowedPrivateOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return false;
  try {
    const u = new URL(rawOrigin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const cleanHost = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!cleanHost) return false;
    if (cleanHost === 'localhost' || cleanHost.endsWith('.local') || cleanHost.endsWith('.ts.net')) return true;
    return isAllowedPrivateAddress(cleanHost);
  } catch {
    return false;
  }
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

    const reqOrigin = String(req.headers.origin || '').trim();
    if (reqOrigin && isAllowedPrivateOrigin(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AG-Remote-Token');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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

    const { token, fromQuery, fromCookie, uiVersion } = extractRequestToken(req, urlObj);
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

    const cookiesToSet = [];
    if (fromQuery) {
      cookiesToSet.push(`ag_remote_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }

    if (req.method === 'GET' && pathname === '/') {
      if (uiVersion !== MOBILE_UI_VERSION) {
        cookiesToSet.push(`ag_ui_ver=${MOBILE_UI_VERSION}; Path=/; SameSite=Lax; Max-Age=31536000`);
      }
      if (cookiesToSet.length) res.setHeader('Set-Cookie', cookiesToSet);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(cachedHtml);
      return;
    }

    if (cookiesToSet.length) {
      res.setHeader('Set-Cookie', cookiesToSet);
    }

    if (req.method === 'GET' && pathname === '/api/ping') {
      const snapInfo = collectFusedEndpointDescriptor(config.port);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        port: config.port,
        name: snapInfo.deviceName,
        hosts: snapInfo.hosts,
        endpoints: snapInfo.endpoints
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      if ((fromCookie || uiVersion) && uiVersion !== MOBILE_UI_VERSION) {
        res.setHeader('Set-Cookie', `ag_ui_ver=${MOBILE_UI_VERSION}; Path=/; SameSite=Lax; Max-Age=31536000`);
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, reloadRequired: true, error: '界面已升级，正在自动刷新…' }));
        return;
      }
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
  let ifaceTimer = null;
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

  const tryBindDualStackWildcard = () => {
    if (stopped || boundServers.has('::')) return Promise.resolve(false);
    return new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.once('error', () => {
        try { srv.close(); } catch {}
        resolve(false);
      });
      srv.listen({ port: config.port, host: '::', ipv6Only: false }, () => {
        boundServers.set('::', srv);
        resolve(true);
      });
    });
  };

  const syncBindings = async () => {
    if (boundServers.has('::')) return;
    const { bindIps } = enumerateLocalAddresses();
    for (const ip of bindIps) {
      await tryBindAddress(ip);
    }
  };

  void tryBindDualStackWildcard().then(async (ok) => {
    if (stopped) return;
    if (ok) {
      const activeIps = enumerateLocalAddresses().bindIps;
      console.log(`Mobile Remote PWA ready on dual-stack [::]:${config.port} (${activeIps.join(', ')})`);
      return;
    }
    ifaceTimer = setInterval(() => {
      if (!stopped) void syncBindings();
    }, 15000);
    ifaceTimer.unref?.();
    await syncBindings();
    const activeIps = Array.from(boundServers.keys());
    if (activeIps.length) {
      console.log(`Mobile Remote PWA ready on port ${config.port} (${activeIps.join(', ')})`);
    }
  });

  return {
    config,
    getBoundAddresses: () => (boundServers.has('::') ? enumerateLocalAddresses().bindIps : Array.from(boundServers.keys())),
    stop: () => {
      stopped = true;
      if (ifaceTimer) clearInterval(ifaceTimer);
      for (const srv of boundServers.values()) {
        try { srv.close(); } catch {}
      }
      boundServers.clear();
    }
  };
}

function collectFusedEndpointDescriptor(port) {
  const { tailscale, lan, physicalLan } = enumerateLocalAddresses();
  const meta = detectHostIdentityMeta();
  const primaryLan = physicalLan[0] || lan[0] || null;
  const secondaryLan = physicalLan[1] || lan[1] || null;

  const endpoints = [];
  const seenHosts = new Set();
  const addEp = (host, kind, priority, iface = '') => {
    const cleanHost = String(host || '').trim();
    if (!cleanHost || seenHosts.has(cleanHost) || endpoints.length >= 5) return;
    seenHosts.add(cleanHost);
    endpoints.push({
      url: `http://${formatHostForUrl(cleanHost)}:${port}`,
      host: cleanHost,
      kind,
      priority,
      iface
    });
  };

  if (primaryLan) addEp(primaryLan.address, 'lan', 0, primaryLan.iface);
  if (secondaryLan) addEp(secondaryLan.address, 'lan', 50, secondaryLan.iface);
  if (tailscale[0]) addEp(tailscale[0].address, 'tailscale', 100, tailscale[0].iface);
  if (tailscale.length > 0 && meta.tailscaleDnsName) {
    addEp(meta.tailscaleDnsName, 'tailscale', 150, tailscale[0]?.iface || 'utun0');
  }
  if (meta.bonjourHost && primaryLan) {
    addEp(meta.bonjourHost, 'bonjour', 200, primaryLan.iface);
  }
  if (endpoints.length === 0) {
    addEp('127.0.0.1', 'loopback', 900, 'lo0');
  }

  return {
    tailscale,
    lan,
    primaryLan,
    deviceName: meta.deviceName,
    bonjourHost: meta.bonjourHost,
    tailscaleDnsName: meta.tailscaleDnsName,
    hosts: endpoints.map((ep) => ep.host),
    endpoints: endpoints.map(({ url, kind, priority }) => ({ url, kind, priority }))
  };
}

function buildRemoteInfo({ resetToken = false } = {}) {
  const cfg = loadOrCreateRemoteConfig({ resetToken });
  const desc = collectFusedEndpointDescriptor(cfg.port);

  const mkFused = (entryHost) => buildFusedPairingUrl({
    entryHost,
    port: cfg.port,
    token: cfg.token,
    name: desc.deviceName,
    hosts: desc.hosts,
    endpoints: desc.endpoints
  });

  const tsEntryHost = desc.tailscale[0]?.address || desc.tailscaleDnsName || '';
  const tsDisplayHost = (desc.tailscale.length > 0 && desc.tailscaleDnsName)
    ? desc.tailscaleDnsName
    : (desc.tailscale[0]?.address || '');
  const lanEntryHost = desc.primaryLan?.address || '';
  const bonjourEntryHost = (desc.bonjourHost && desc.primaryLan) ? desc.bonjourHost : '';

  const channels = [
    {
      key: 'lan',
      label: '此 Wi-Fi',
      labelEn: 'This Wi-Fi',
      available: Boolean(desc.primaryLan),
      displayHost: desc.primaryLan?.address || '',
      entryHost: lanEntryHost,
      iface: desc.primaryLan?.iface || ''
    },
    {
      key: 'tailscale',
      label: 'Tailscale',
      labelEn: 'Tailscale',
      available: desc.tailscale.length > 0,
      displayHost: tsDisplayHost,
      entryHost: tsEntryHost,
      iface: desc.tailscale[0]?.iface || ''
    },
    {
      key: 'bonjour',
      label: 'Bonjour',
      labelEn: 'Bonjour',
      available: Boolean(bonjourEntryHost),
      displayHost: bonjourEntryHost,
      entryHost: bonjourEntryHost,
      iface: desc.primaryLan?.iface || ''
    }
  ].map((ch) => {
    if (!ch.available || !ch.entryHost) return { ...ch, url: '', qrSvg: '' };
    const url = mkFused(ch.entryHost);
    return { ...ch, url, qrSvg: renderQrSvg(url) };
  });

  const tailscaleUrls = desc.tailscale.map((x) => {
    const url = mkFused(x.address);
    return { ...x, url, qrSvg: renderQrSvg(url) };
  });
  const lanUrls = desc.lan.map((x) => {
    const url = mkFused(x.address);
    return { ...x, url, qrSvg: renderQrSvg(url) };
  });

  const pickedChannel = channels.find((c) => c.key === 'tailscale' && c.available)
    || channels.find((c) => c.key === 'lan' && c.available)
    || channels.find((c) => c.available);
  const localUrl = mkFused('127.0.0.1');
  const primary = pickedChannel
    ? { iface: pickedChannel.iface, address: pickedChannel.entryHost, kind: pickedChannel.key, url: pickedChannel.url, qrSvg: pickedChannel.qrSvg }
    : { iface: 'lo0', address: '127.0.0.1', kind: 'loopback', url: localUrl, qrSvg: renderQrSvg(localUrl) };

  return {
    port: cfg.port,
    token: cfg.token,
    configPath: getRemoteConfigPath(),
    deviceName: desc.deviceName,
    bonjourHost: desc.bonjourHost,
    tailscaleDnsName: desc.tailscaleDnsName,
    hosts: desc.hosts,
    endpoints: desc.endpoints,
    channels,
    fusedUrl: primary.url,
    primaryUrl: primary.url,
    primaryKind: primary.kind,
    qrSvg: primary.qrSvg,
    tailscaleUrls,
    lanUrls,
    localUrl
  };
}

function printRemoteCli({ resetToken = false, jsonMode = false } = {}) {
  const info = buildRemoteInfo({ resetToken });
  if (jsonMode) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log('');
  console.log(`📱 Antigravity 手机远程操作面板（一码三用多通道融合 · ${info.deviceName}）`);
  if (resetToken) console.log('🔑 已重置并生成新的配对 Token（旧链接将自动失效）');
  console.log('');

  for (const ch of (info.channels || [])) {
    if (ch.available) {
      console.log(`✅ ${ch.label.padEnd(10, ' ')} ${ch.displayHost} (${ch.iface || 'auto'})`);
    } else {
      console.log(`⭕ ${ch.label.padEnd(10, ' ')} 未就绪`);
    }
  }
  console.log('');
  console.log(`🔗 融合配对链接: ${info.fusedUrl}`);
  console.log(`🖥️ 本机调试地址: ${info.localUrl}`);
  console.log('');
  console.log('📷 用 iPhone 相机扫描下方融合二维码即可打开：');
  console.log('');
  const primaryGrid = encodeQrCodeMatrix(info.primaryUrl);
  const cols = Number(process.stdout.columns || 0);
  const qrForTerminal = (cols > 0 && cols < primaryGrid.length + 6)
    ? `http://${(info.tailscaleUrls[0]?.address || info.lanUrls[0]?.address || '127.0.0.1')}:${info.port}/?token=${info.token}`
    : info.primaryUrl;
  console.log(renderTerminalQr(qrForTerminal));
  console.log('');
  console.log('💡 一码三用说明：');
  console.log('   1. 扫码在 Safari 打开后，点击底部「分享」→「添加到主屏幕」');
  console.log('   2. 二维码与链接已融合 Wi-Fi / Tailscale / Bonjour 多端点，换网或离线时自动切换通道');
  console.log('   3. 在聊天区右滑即可拉出左侧会话抽屉，底部可直接切换模型/权限与拍照传图');
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
  isAllowedPrivateOrigin,
  enumerateLocalAddresses,
  encodeEndpointsParam,
  decodeEndpointsParam,
  buildFusedPairingUrl,
  encodeQrCodeMatrix,
  renderTerminalQr,
  renderQrSvg,
  buildMobileAppHtml,
  startMobileRemoteServer,
  buildRemoteInfo,
  printRemoteCli
};

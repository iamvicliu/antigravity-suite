#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync, spawn } = require('child_process');
const { getStateDir, resolveActiveCdpTarget } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');
const { detectProxyConfig } = require('./meter-proxy');

const DEFAULT_REMOTE_PORT = 18765;
const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const CONFIG_FILE_NAME = 'remote-config.json';
const TUNNEL_STATE_FILE_NAME = '.cloudflared-tunnel-state.json';
const MOBILE_UI_VERSION = '1.9.8';

// ==================== 配置与内网安全校验 ====================

function getRemoteConfigPath() {
  return path.join(getStateDir(), CONFIG_FILE_NAME);
}

function getTunnelStatePath() {
  return path.join(getStateDir(), TUNNEL_STATE_FILE_NAME);
}

function extractCloudflareTunnelToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const m = text.match(/\beyJ[A-Za-z0-9+/_-]{8,}=*(?:\.[A-Za-z0-9+/_-]+=*)*/);
  if (!m) return '';
  const matched = m[0];
  if (!matched.includes('.')) {
    const eqMatch = matched.match(/=+$/);
    if (eqMatch && eqMatch[0].length > 2) return '';
    const unpadded = matched.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    if (unpadded.length % 4 === 1) return '';
    const padLen = (4 - (unpadded.length % 4)) % 4;
    return unpadded + '='.repeat(padLen);
  }
  const parts = matched.split('.');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return '';
  return matched;
}

function decodeBase64JsonObject(seg) {
  const clean = String(seg || '').trim();
  if (!clean) return null;
  const eqMatch = clean.match(/=+$/);
  if (eqMatch && eqMatch[0].length > 2) return null;
  const normalized = clean.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+$/.test(normalized) || normalized.length % 4 === 1) return null;
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const decoded = Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validateCloudflareTunnelToken(raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return {
      ok: false,
      token: '',
      error: '请粘贴 Cloudflare Tunnel Token 或 cloudflared service install 命令'
    };
  }
  const token = extractCloudflareTunnelToken(input);
  if (!token) {
    return {
      ok: false,
      token: '',
      error: '未能识别有效的 Cloudflare Tunnel Token（须以 eyJ 开头，或完整粘贴 cloudflared service install 命令）'
    };
  }
  if (!token.includes('.')) {
    const payload = decodeBase64JsonObject(token);
    if (!payload) {
      return {
        ok: false,
        token: '',
        error: 'Cloudflare Tunnel Token 格式损坏（Base64 JSON 解析失败，请检查是否截断或缺少结尾 =）'
      };
    }
    if (
      typeof payload.a !== 'string' || !payload.a.trim()
      || typeof payload.t !== 'string' || !payload.t.trim()
      || typeof payload.s !== 'string' || !payload.s.trim()
    ) {
      return {
        ok: false,
        token: '',
        error: 'Cloudflare Tunnel Token 缺少必要字段 (a/t/s)，请从 Zero Trust 控制台重新复制'
      };
    }
    return { ok: true, token, error: '' };
  }
  const parts = token.split('.');
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, token: '', error: 'Cloudflare Tunnel Token JWT 结构无效' };
  }
  const header = decodeBase64JsonObject(parts[0]);
  const payload = decodeBase64JsonObject(parts[1]);
  if (!header || !payload) {
    return {
      ok: false,
      token: '',
      error: 'Cloudflare Tunnel Token JWT 解析失败，请检查是否完整复制'
    };
  }
  return { ok: true, token, error: '' };
}

function validateTunnelHostname(raw) {
  let text = String(raw || '').trim();
  if (!text) {
    return {
      ok: false,
      origin: '',
      error: '请填写有效的 Cloudflare HTTPS 固定域名（例如 https://ag.example.com）'
    };
  }
  if (/^http:\/\//i.test(text)) {
    return {
      ok: false,
      origin: '',
      error: '固定域名必须使用 https://（不能使用 http://）；若无自有域名请点击「改用免登录临时隧道」'
    };
  }
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol !== 'https:' || !host || !host.includes('.')) {
      return {
        ok: false,
        origin: '',
        error: '请填写有效的 Cloudflare HTTPS 固定域名（例如 https://ag.example.com）'
      };
    }
    if (host === 'cloudflareaccess.com' || host.endsWith('.cloudflareaccess.com')) {
      return {
        ok: false,
        origin: '',
        error: '*.cloudflareaccess.com 是 Cloudflare Access 登录门户而非隧道公网域名（访问会停在 /#/NoAuth）；请填写隧道 Public Hostname 绑定的自有域名，若无自有域名请点「改用免登录临时隧道」'
      };
    }
    if (host === 'dash.cloudflare.com' || host === 'one.dash.cloudflare.com') {
      return {
        ok: false,
        origin: '',
        error: '请勿填写 Cloudflare 控制台地址；请填写隧道 Public Hostname 绑定的自有域名，或改用免登录临时隧道'
      };
    }
    if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) {
      return {
        ok: false,
        origin: '',
        error: '*.trycloudflare.com 为临时随机域名，无需手填；请直接点击「改用免登录临时隧道」'
      };
    }
    return { ok: true, origin: u.origin, error: '' };
  } catch {
    return {
      ok: false,
      origin: '',
      error: '请填写有效的 Cloudflare HTTPS 固定域名（例如 https://ag.example.com）'
    };
  }
}

function normalizeTunnelHostname(raw) {
  const res = validateTunnelHostname(raw);
  return res.ok ? res.origin : '';
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
  const rawCh = (existing.enabledChannels && typeof existing.enabledChannels === 'object') ? existing.enabledChannels : {};
  const defaultTunnelOn = typeof existing.tunnelEnabled === 'boolean'
    ? existing.tunnelEnabled
    : false;
  const tunnelEnabled = typeof rawCh.tunnel === 'boolean' ? rawCh.tunnel : defaultTunnelOn;
  const enabledChannels = {
    lan: typeof rawCh.lan === 'boolean' ? rawCh.lan : true,
    tailscale: typeof rawCh.tailscale === 'boolean' ? rawCh.tailscale : true,
    bonjour: typeof rawCh.bonjour === 'boolean' ? rawCh.bonjour : true,
    tunnel: tunnelEnabled
  };
  const tunnelMode = existing.tunnelMode === 'named' ? 'named' : 'quick';
  const tunnelToken = typeof existing.tunnelToken === 'string'
    ? extractCloudflareTunnelToken(existing.tunnelToken)
    : '';
  const tunnelHostname = normalizeTunnelHostname(existing.tunnelHostname || '');

  let changed = !loaded.ok || !existing.token || resetToken || existing.port !== port;

  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }

  const next = {
    ...existing,
    port,
    token,
    tunnelEnabled,
    enabledChannels,
    tunnelMode,
    tunnelToken,
    tunnelHostname,
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

// ==================== 已关联远程设备追踪（内存级，随 Token 隔离） ====================

const DEVICE_ONLINE_TTL_MS = 15000;
const MAX_PAIRED_DEVICES = 50;
let trackedDeviceToken = '';
const pairedDevicesMap = new Map();

function syncTrackedDeviceToken(activeToken) {
  const clean = String(activeToken || '');
  if (clean && clean !== trackedDeviceToken) {
    pairedDevicesMap.clear();
    trackedDeviceToken = clean;
  }
}

function parseDeviceLabel(rawUa, rawHint) {
  const hint = String(rawHint || '').trim();
  if (/^iPad$/i.test(hint)) return 'iPad';
  if (/^iPhone$/i.test(hint)) return 'iPhone';
  const ua = String(rawUa || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows NT/i.test(ua)) return 'Windows';
  return '移动设备';
}

function recordPairedDeviceAccess(req, activeToken, now = Date.now(), activeTunnelUrl = '') {
  if (!req) return null;
  syncTrackedDeviceToken(activeToken);
  const headers = req.headers || {};
  const headerDevId = String(headers['x-ag-device-id'] || '').trim().slice(0, 64);
  const deviceHint = String(headers['x-ag-device-hint'] || '').trim().slice(0, 24);
  const ua = String(headers['user-agent'] || '').trim();
  const cleanIp = normalizeRemoteIp(req.socket?.remoteAddress || req.ip || '');

  // 过滤本机非浏览器健康检查或 CLI 脚本探测，避免误计为关联设备（Cloudflare 隧道透传请求除外）
  const reqCh = detectRequestChannel(req, activeTunnelUrl);
  if (!headerDevId && reqCh === 'loopback' && !/Mozilla\/|Mobile|Safari|Chrome|Firefox/i.test(ua)) {
    return null;
  }

  const fallbackId = 'ua-' + crypto.createHash('sha1').update(`${cleanIp}|${ua}`).digest('hex').slice(0, 12);
  const deviceId = headerDevId || fallbackId;
  let prev = pairedDevicesMap.get(deviceId) || null;
  if (headerDevId && pairedDevicesMap.has(fallbackId)) {
    const fallbackEntry = pairedDevicesMap.get(fallbackId);
    if (!prev && fallbackEntry) prev = fallbackEntry;
    pairedDevicesMap.delete(fallbackId);
  }

  const record = {
    id: deviceId,
    label: parseDeviceLabel(ua, deviceHint),
    channel: reqCh,
    ip: cleanIp,
    firstSeenAt: prev?.firstSeenAt || now,
    lastSeenAt: now
  };
  pairedDevicesMap.set(deviceId, record);

  if (pairedDevicesMap.size > MAX_PAIRED_DEVICES) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [k, v] of pairedDevicesMap.entries()) {
      if ((v?.lastSeenAt || 0) < oldestSeen) {
        oldestSeen = v?.lastSeenAt || 0;
        oldestKey = k;
      }
    }
    if (oldestKey) pairedDevicesMap.delete(oldestKey);
  }
  return record;
}

function getPairedDevicesSummary(activeToken, now = Date.now()) {
  syncTrackedDeviceToken(activeToken);
  const devices = Array.from(pairedDevicesMap.values())
    .sort((a, b) => (b.lastSeenAt - a.lastSeenAt))
    .map((d) => ({
      id: d.id,
      label: d.label,
      channel: d.channel,
      ip: d.ip,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
      online: (now - d.lastSeenAt) <= DEVICE_ONLINE_TTL_MS
    }));
  const onlineCount = devices.filter((d) => d.online).length;
  return {
    pairedCount: devices.length,
    onlineCount,
    devices
  };
}

function saveRemoteTunnelConfig(patch = {}) {
  const cur = loadOrCreateRemoteConfig();
  const patchCh = (patch.enabledChannels && typeof patch.enabledChannels === 'object') ? patch.enabledChannels : {};
  const nextTunnelEnabled = patch.enabled !== undefined
    ? Boolean(patch.enabled)
    : (patch.tunnelEnabled !== undefined
        ? Boolean(patch.tunnelEnabled)
        : (typeof patchCh.tunnel === 'boolean' ? patchCh.tunnel : cur.tunnelEnabled));
  const nextEnabledChannels = {
    lan: typeof patchCh.lan === 'boolean' ? patchCh.lan : cur.enabledChannels.lan,
    tailscale: typeof patchCh.tailscale === 'boolean' ? patchCh.tailscale : cur.enabledChannels.tailscale,
    bonjour: typeof patchCh.bonjour === 'boolean' ? patchCh.bonjour : cur.enabledChannels.bonjour,
    tunnel: nextTunnelEnabled
  };
  const nextModeRaw = patch.tunnelMode !== undefined ? patch.tunnelMode : cur.tunnelMode;
  const nextMode = nextModeRaw === 'named' ? 'named' : 'quick';
  const nextToken = patch.tunnelToken !== undefined
    ? extractCloudflareTunnelToken(patch.tunnelToken)
    : cur.tunnelToken;
  const nextHost = patch.tunnelHostname !== undefined
    ? normalizeTunnelHostname(patch.tunnelHostname)
    : cur.tunnelHostname;

  const next = {
    ...cur,
    tunnelEnabled: nextTunnelEnabled,
    enabledChannels: nextEnabledChannels,
    tunnelMode: nextMode,
    tunnelToken: nextToken,
    tunnelHostname: nextHost,
    updatedAt: new Date().toISOString()
  };

  const cfgPath = getRemoteConfigPath();
  safeWriteJsonSync(cfgPath, next, {
    indent: 2,
    validate: (d) => d && typeof d.token === 'string' && d.token.length >= 24
  });
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch {}
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

function parseHostHeaderHostname(rawHost) {
  const text = String(rawHost || '').trim();
  if (!text) return '';
  try {
    return new URL(`http://${text}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return text.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  }
}

function isTailscaleIp(rawAddr) {
  const ip = normalizeRemoteIp(rawAddr);
  if (!ip) return false;
  return isTailscaleCgnatIpv4(ip) || /^fd7a:115c:a1e0:/i.test(ip);
}

function isLoopbackIp(rawAddr) {
  const ip = normalizeRemoteIp(rawAddr);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const p = parseIpv4Parts(ip);
  return Boolean(p && p[0] === 127);
}

function detectRequestChannel(reqOrIp, hostOrTunnelUrl = '', maybeTunnelUrl = '') {
  const isStringCall = typeof reqOrIp === 'string';
  const headers = (!isStringCall && reqOrIp && reqOrIp.headers) ? reqOrIp.headers : {};
  const remoteIp = normalizeRemoteIp(isStringCall ? reqOrIp : (reqOrIp?.socket?.remoteAddress || reqOrIp?.ip || ''));
  const localIp = isStringCall ? '' : normalizeRemoteIp(reqOrIp?.socket?.localAddress || '');
  const hostName = parseHostHeaderHostname(isStringCall ? hostOrTunnelUrl : (headers.host || ''));
  const activeTunnelUrl = isStringCall ? maybeTunnelUrl : hostOrTunnelUrl;
  let activeTunnelHost = '';
  if (activeTunnelUrl) {
    try { activeTunnelHost = new URL(activeTunnelUrl).hostname.toLowerCase(); } catch {}
  }
  if (
    (!remoteIp || isLoopbackIp(remoteIp))
    && (
      headers['cf-connecting-ip']
      || headers['cf-ray']
      || hostName.endsWith('.trycloudflare.com')
      || (activeTunnelHost && hostName === activeTunnelHost)
    )
  ) {
    return 'tunnel';
  }
  if (hostName.endsWith('.local')) {
    return 'bonjour';
  }
  if (
    hostName.endsWith('.ts.net')
    || isTailscaleIp(hostName)
    || isTailscaleIp(remoteIp)
    || isTailscaleIp(localIp)
  ) {
    return 'tailscale';
  }
  if (isLoopbackIp(remoteIp) && (!hostName || hostName === 'localhost' || isLoopbackIp(hostName))) {
    return 'loopback';
  }
  return 'lan';
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

function buildFusedPairingUrl({ entryBaseUrl, entryHost, port, token, name, hosts, endpoints }) {
  let cleanBase = '';
  let authority = '';
  if (entryBaseUrl) {
    try {
      const u = new URL(String(entryBaseUrl));
      cleanBase = `${u.protocol}//${u.host}`;
      authority = u.host;
    } catch {}
  }
  if (!cleanBase) {
    authority = `${formatHostForUrl(entryHost)}:${port}`;
    cleanBase = `http://${authority}`;
  }
  const cleanHosts = Array.isArray(hosts) ? hosts.filter(Boolean) : [];
  const encodedEndpoints = encodeEndpointsParam(endpoints);
  return `${cleanBase}/?token=${encodeURIComponent(token || '')}`
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
  20: [861, 28, 3, 107, 5, 108, [6, 34, 62, 90]],
  21: [932, 28, 4, 116, 4, 117, [6, 28, 50, 72, 94]],
  22: [1006, 28, 2, 111, 7, 112, [6, 26, 50, 74, 98]],
  23: [1094, 30, 4, 121, 5, 122, [6, 30, 54, 78, 102]],
  24: [1174, 30, 6, 117, 4, 118, [6, 28, 54, 80, 106]],
  25: [1276, 26, 8, 106, 4, 107, [6, 32, 58, 84, 110]]
};

function encodeQrCodeMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
  let version = 0;
  for (let v = 1; v <= 25; v++) {
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

function listElectronWebContentsTargets() {
  try {
    const electron = require('electron');
    const all = electron?.webContents?.getAllWebContents?.();
    if (!Array.isArray(all) || !all.length) return [];
    return all
      .filter((wc) => {
        if (!wc || wc.isDestroyed?.()) return false;
        if (wc.hostWebContents) return false;
        const url = String(wc.getURL?.() || '');
        return /^https:\/\/127\.0\.0\.1:\d+\//.test(url);
      })
      .map((wc) => ({
        id: `wc-${wc.id}`,
        title: String(wc.getTitle?.() || 'Antigravity'),
        url: String(wc.getURL?.() || ''),
        wc
      }));
  } catch {
    return [];
  }
}

async function listAntigravityCdpTargets() {
  const electronTargets = listElectronWebContentsTargets();
  if (electronTargets.length) {
    return electronTargets;
  }

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

function evalInElectronWebContents(wc, expression, timeoutMs = 4500) {
  if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') {
    return Promise.reject(new Error('目标窗口已关闭'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('页面执行超时'));
    }, timeoutMs);
    Promise.resolve(wc.executeJavaScript(expression, true))
      .then((val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err || '页面执行异常')));
      });
  });
}

function evalInTarget(target, expression, timeoutMs = 4500) {
  if (target?.wc) {
    return evalInElectronWebContents(target.wc, expression, timeoutMs);
  }
  return evalInCdpTarget(target.wsUrl, expression, timeoutMs);
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

// ==================== 多项目融合目录、会话状态汇总与防缩水缓存 ====================

const SESSION_CATALOG_FILE_NAME = 'remote-session-catalog.json';
const MAX_ARCHIVED_TOMBSTONES = 500;
const INTERNAL_EMPTY_PROJECT_IDS = new Set(['outside-of-project', 'standalone']);

function isCatalogTestEnv() {
  return process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

const CREDIBLE_TRAJ_IDLE_STATUSES = new Set([
  'CASCADE_RUN_STATUS_IDLE',
  'CASCADE_RUN_STATUS_DONE',
  'CASCADE_RUN_STATUS_COMPLETED',
  'CASCADE_RUN_STATUS_STOPPED',
  'CASCADE_RUN_STATUS_CANCELED',
  'CASCADE_RUN_STATUS_CANCELLED'
]);
const CREDIBLE_STATUS_VALUES = new Set(['waiting', 'running', 'error', 'idle']);

function normalizeTrajectoryStatus(rawStatus, termReason, options = {}) {
  const s = String(rawStatus || '').trim();
  const r = String(termReason || '').trim();
  const fallback = CREDIBLE_STATUS_VALUES.has(options.fallbackStatus) ? options.fallbackStatus : '';
  if (
    options.hasPendingApprovals ||
    s === 'CASCADE_RUN_STATUS_WAITING_FOR_USER' ||
    options.subagentWaiting ||
    options.domStatus === 'waiting'
  ) {
    return 'waiting';
  }
  if (
    options.activeBusy ||
    options.domBusy ||
    s === 'CASCADE_RUN_STATUS_RUNNING' ||
    options.subagentRunning ||
    options.domStatus === 'running'
  ) {
    return 'running';
  }
  if (
    r === 'EXECUTOR_TERMINATION_REASON_ERROR' ||
    s === 'CASCADE_RUN_STATUS_ERROR' ||
    s === 'CASCADE_RUN_STATUS_FAILED' ||
    options.domStatus === 'error'
  ) {
    return 'error';
  }
  const explicitTrajIdle = Boolean(
    CREDIBLE_TRAJ_IDLE_STATUSES.has(s) ||
    (r && r !== 'EXECUTOR_TERMINATION_REASON_UNSPECIFIED' && !s)
  );
  if (explicitTrajIdle || options.explicitIdle) {
    return 'idle';
  }
  if (fallback) {
    return fallback;
  }
  return 'unknown';
}

function statusToLabel(status) {
  if (status === 'waiting') return '待确认';
  if (status === 'running') return '运行中';
  if (status === 'error') return '异常';
  if (status === 'unknown') return '未知';
  return '';
}

function parseIsoTimestampMs(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 1e12 && raw < 4e12 ? raw : 0;
  }
  const s = String(raw || '').trim();
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function decodeFileUriToPath(rawUri) {
  const s = String(rawUri || '').trim();
  if (!s) return '';
  if (!/^file:\/\//i.test(s)) return path.resolve(s);
  try {
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname || '');
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p ? path.resolve(p) : '';
  } catch {
    return '';
  }
}

function matchWorkspaceToProjectId(traj, projectsMetaMap) {
  const meta = traj?.trajectoryMetadata || {};
  const uris = [];
  for (const ws of (Array.isArray(traj?.workspaces) ? traj.workspaces : [])) {
    if (ws?.workspaceFolderAbsoluteUri) uris.push(ws.workspaceFolderAbsoluteUri);
    if (ws?.gitRootAbsoluteUri) uris.push(ws.gitRootAbsoluteUri);
  }
  for (const ws of (Array.isArray(meta.workspaces) ? meta.workspaces : [])) {
    if (ws?.workspaceFolderAbsoluteUri) uris.push(ws.workspaceFolderAbsoluteUri);
    if (ws?.gitRootAbsoluteUri) uris.push(ws.gitRootAbsoluteUri);
  }
  for (const u of (Array.isArray(meta.workspaceUris) ? meta.workspaceUris : [])) {
    uris.push(u);
  }

  for (const uri of uris) {
    const wsPath = decodeFileUriToPath(uri);
    if (!wsPath) continue;
    for (const proj of projectsMetaMap.values()) {
      for (const pPath of proj.workspacePaths) {
        if (wsPath === pPath || wsPath.startsWith(pPath + path.sep) || pPath.startsWith(wsPath + path.sep)) {
          return proj.id;
        }
      }
    }
  }
  return '';
}

function loadProjectsMetaFromDisk(options = {}, cacheRef = null) {
  const explicitDir = String(options.configDir || process.env.AG_CONFIG_DIR || '').trim();
  let configDir = explicitDir;
  if (!configDir) {
    if (isCatalogTestEnv()) return { metaMap: new Map(), excludedIds: new Set() };
    configDir = path.join(os.homedir(), '.gemini', 'config');
  }
  const projectsDir = path.join(configDir, 'projects');
  const nowMs = Date.now();
  if (
    cacheRef &&
    !options.bypassCache &&
    cacheRef.projectsDir === projectsDir &&
    cacheRef.data &&
    nowMs - cacheRef.fetchedAt < 10000
  ) {
    return cacheRef.data;
  }

  const metaMap = new Map();
  const excludedIds = new Set();
  const archivedIds = new Set();
  try {
    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const readRes = safeReadJsonSync(path.join(projectsDir, f), null);
        const parsed = readRes?.ok ? readRes.data : null;
        if (!parsed || typeof parsed !== 'object') continue;
        const id = String(parsed.id || parsed.projectId || f.slice(0, -5)).trim();
        const name = String(parsed.name || id).trim();
        if (parsed.archived === true) {
          if (id) {
            excludedIds.add(id);
            archivedIds.add(id);
          }
          continue;
        }
        if (parsed.sidecar || name === 'swarm/swarm_board') {
          if (id) excludedIds.add(id);
          continue;
        }
        if (!id || !name) continue;
        const workspacePaths = [];
        const resources = Array.isArray(parsed.projectResources?.resources) ? parsed.projectResources.resources : [];
        for (const r of resources) {
          const uri = r?.gitFolder?.folderUri || r?.folderUri;
          const p = decodeFileUriToPath(uri);
          if (p) workspacePaths.push(p);
        }
        metaMap.set(id, { id, name, primaryPath: workspacePaths[0] || '', workspacePaths });
      }
    }
  } catch {}

  const resData = { metaMap, excludedIds, archivedIds };
  if (cacheRef) {
    cacheRef.projectsDir = projectsDir;
    cacheRef.fetchedAt = nowMs;
    cacheRef.data = resData;
  }
  return resData;
}

function withRaceTimeout(promise, ms, fallback = null) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function inspectSubagentRecord(cid, traj, snapConv, knownSubIds = null, knownRoots = null) {
  const id = String(cid || '').trim();
  const meta = traj?.trajectoryMetadata || {};
  const rawRoot = String(
    meta.rootConversationId ||
    meta.parentConversationId ||
    traj?.parentConversationId ||
    snapConv?.rootConversationId ||
    snapConv?.parentConversationId ||
    (knownRoots?.get ? knownRoots.get(id) : '') ||
    ''
  ).trim();
  const rootId = (rawRoot && rawRoot !== id) ? rawRoot : '';
  const isSub = Boolean(
    knownSubIds?.has?.(id) ||
    rootId ||
    meta.parentConversationId ||
    traj?.parentConversationId ||
    meta.isSubagent ||
    traj?.isSubagent ||
    snapConv?.parentConversationId ||
    snapConv?.isSubagent
  );
  return { isSub, rootId };
}

function createSessionCatalogStore() {
  const registryByDir = new Map();
  const projectsCache = { projectsDir: '', fetchedAt: 0, data: null };
  const trajCache = { at: 0, data: null };

  function getStickyStoreForDir(stateDir) {
    const dir = String(stateDir || getStateDir());
    let entry = registryByDir.get(dir);
    if (!entry) {
      const filePath = path.join(dir, SESSION_CATALOG_FILE_NAME);
      const savedRes = safeReadJsonSync(filePath, null);
      const saved = savedRes?.ok ? savedRes.data : null;
      const map = new Map();
      const subagentIds = new Set(Array.isArray(saved?.subagentIds) ? saved.subagentIds.map((x) => String(x || '').trim()).filter(Boolean) : []);
      const subagentRoots = new Map();
      if (saved?.subagentRoots && typeof saved.subagentRoots === 'object') {
        for (const [k, v] of Object.entries(saved.subagentRoots)) {
          if (k && v) subagentRoots.set(String(k), String(v));
        }
      }
      const subagentStates = new Map();
      if (saved?.subagentStates && typeof saved.subagentStates === 'object') {
        for (const [k, v] of Object.entries(saved.subagentStates)) {
          if (k && v && typeof v === 'object' && v.rootId && (v.status === 'waiting' || v.status === 'running')) {
            subagentStates.set(String(k), {
              rootId: String(v.rootId),
              status: String(v.status),
              updatedAt: Number(v.updatedAt) || 0
            });
          }
        }
      }
      const rawItems = Array.isArray(saved?.conversations) ? saved.conversations : [];
      for (const item of rawItems) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const cid = String(item.id);
        const subInfo = inspectSubagentRecord(cid, null, item, subagentIds, subagentRoots);
        if (subInfo.isSub) {
          subagentIds.add(cid);
          if (subInfo.rootId) subagentRoots.set(cid, subInfo.rootId);
          continue;
        }
        const savedStatus = (CREDIBLE_STATUS_VALUES.has(item.status) || item.status === 'unknown') ? item.status : 'unknown';
        map.set(cid, { ...item, id: cid, status: savedStatus, statusLabel: statusToLabel(savedStatus) });
      }
      entry = { dir, filePath, map, subagentIds, subagentRoots, subagentStates, lastSig: '', lastActiveSessionId: '', catalogRevision: '' };
      registryByDir.set(dir, entry);
    }
    return entry;
  }

  function buildActiveCatalogItems(store, activeSessionId = '', snapConvMap = null) {
    const items = [];
    let archivedCount = 0;
    for (const c of store.map.values()) {
      if (store.subagentIds.has(c.id)) continue;
      if (c.archived) {
        archivedCount += 1;
        continue;
      }
      const isActive = Boolean((activeSessionId && c.id === activeSessionId) || snapConvMap?.get(c.id)?.active);
      const unread = Boolean(!isActive && c.updatedAt > 0 && c.lastViewedAt > 0 && (c.updatedAt - c.lastViewedAt > 3000));
      const itemStatus = (CREDIBLE_STATUS_VALUES.has(c.status) || c.status === 'unknown') ? c.status : 'unknown';
      items.push({
        id: c.id,
        title: c.title,
        active: isActive,
        projectId: c.projectId || 'ungrouped',
        projectName: c.projectName || '未归属项目',
        status: itemStatus,
        statusLabel: statusToLabel(itemStatus),
        unread,
        pinned: Boolean(c.pinned),
        updatedAt: c.updatedAt
      });
    }
    items.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const revPayload = items
      .map((c) => `${c.id}\t${c.title}\t${c.projectId}\t${c.status}\t${c.unread ? 1 : 0}\t${c.pinned ? 1 : 0}\t${c.updatedAt}`)
      .join('\n') + `|s:${store.subagentIds.size}|a:${archivedCount}`;
    const catalogRevision = crypto.createHash('sha1').update(revPayload).digest('hex').slice(0, 16);
    return { items, catalogRevision };
  }

  async function fetchTrajectories(options = {}) {
    const customConnect = options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__;
    const nowMs = Date.now();
    if (!customConnect && !options.bypassCache && trajCache.data && nowMs - trajCache.at < 2000) {
      return trajCache.data;
    }

    let connectFn = customConnect;
    if (!connectFn) {
      if (isCatalogTestEnv()) return null;
      try {
        connectFn = require('./local-api').connect;
      } catch {
        return null;
      }
    }

    try {
      const api = typeof connectFn === 'function' ? await withRaceTimeout(connectFn(), 1200, null) : connectFn;
      if (!api || typeof api.call !== 'function') return null;
      const [trajRes, listProjRes] = await Promise.all([
        withRaceTimeout(Promise.resolve().then(() => api.call('GetAllCascadeTrajectories', {})).catch(() => null), 1500, null),
        withRaceTimeout(Promise.resolve().then(() => api.call('ListProjects', {})).catch(() => null), 1000, null)
      ]);
      const hasSummaries = Boolean(trajRes && trajRes.trajectorySummaries && typeof trajRes.trajectorySummaries === 'object');
      const data = {
        trajOk: hasSummaries,
        summaries: hasSummaries ? trajRes.trajectorySummaries : {},
        projectIds: Array.isArray(listProjRes?.projectIds) ? listProjRes.projectIds : []
      };
      if (!customConnect && hasSummaries) {
        trajCache.at = Date.now();
        trajCache.data = data;
      }
      return data;
    } catch {
      return null;
    }
  }

  async function enrichSnapshot(snap, options = {}) {
    if (!snap || typeof snap !== 'object' || snap.ok === false) return snap;

    const store = getStickyStoreForDir(options.stateDir || getStateDir());
    const { metaMap: projectsMeta, excludedIds: excludedProjectIds, archivedIds: archivedProjectIds } = loadProjectsMetaFromDisk(options, projectsCache);
    const trajData = await fetchTrajectories(options);

    // 1. 构建项目名称字典（融合磁盘配置 + 语言服务项目 ID + 前端 DOM/Fiber 项目组）
    const projectNameMap = new Map();
    for (const p of projectsMeta.values()) {
      projectNameMap.set(p.id, p.name);
    }
    for (const pid of (trajData?.projectIds || [])) {
      const id = String(pid || '').trim();
      if (!id || id === 'swarm/swarm_board' || excludedProjectIds.has(id)) continue;
      if (!projectNameMap.has(id)) {
        projectNameMap.set(id, id === 'default-cli-project' ? 'CLI Project' : id);
      }
    }
    for (const fp of (Array.isArray(snap.projects) ? snap.projects : [])) {
      const id = String(fp?.id || '').trim();
      const name = String(fp?.name || '').trim();
      if (!id || !name || name === 'swarm/swarm_board' || excludedProjectIds.has(id)) continue;
      if (!projectNameMap.has(id) || projectNameMap.get(id) === id) {
        projectNameMap.set(id, name);
      }
    }

    // 2. 索引快照与轨迹，统一识别 Subagent（跨越轨迹 / 快照 / 持久化缓存三源）并清库汇总状态
    const snapConvMap = new Map();
    for (const c of (Array.isArray(snap.conversations) ? snap.conversations : [])) {
      if (c && c.id) snapConvMap.set(String(c.id), c);
    }
    const summaries = trajData?.summaries || {};
    const rootTrajs = new Map();
    const subagentRollup = new Map();
    const candidateIds = new Set([...store.map.keys(), ...Object.keys(summaries), ...snapConvMap.keys()]);
    const seenSubIds = new Set();
    const rootIds = [];

    for (const cid of candidateIds) {
      const t = summaries[cid];
      const sc = snapConvMap.get(cid);
      const cached = store.map.get(cid);
      const subInfo = inspectSubagentRecord(cid, t, sc || cached, store.subagentIds, store.subagentRoots);
      if (subInfo.isSub) {
        store.subagentIds.add(cid);
        seenSubIds.add(cid);
        const rootId = subInfo.rootId || store.subagentRoots.get(cid) || store.subagentStates.get(cid)?.rootId || '';
        if (rootId) store.subagentRoots.set(cid, rootId);
        const prevSub = store.subagentStates.get(cid);
        const hasChildData = Boolean(t || sc);
        const childStatus = hasChildData
          ? normalizeTrajectoryStatus(t?.status, t?.latestExecutorTerminationReason, {
              domBusy: Boolean(sc?.domBusy),
              domStatus: sc?.status,
              fallbackStatus: prevSub?.status
            })
          : (prevSub?.status || 'unknown');
        const childArchived = t?.annotations?.archived === true;
        if (!childArchived && (childStatus === 'waiting' || childStatus === 'running') && rootId) {
          store.subagentStates.set(cid, {
            rootId,
            status: childStatus,
            updatedAt: Math.max(parseIsoTimestampMs(t?.lastModifiedTime), parseIsoTimestampMs(sc?.timeKey), Number(prevSub?.updatedAt) || 0)
          });
        } else if (hasChildData && (childArchived || childStatus === 'idle' || childStatus === 'error')) {
          store.subagentStates.delete(cid);
        }
        if (rootId) {
          const prevRoll = subagentRollup.get(rootId) || { waiting: false, running: false, maxUpdatedAt: 0 };
          if (!childArchived) {
            if (childStatus === 'waiting') prevRoll.waiting = true;
            else if (childStatus === 'running') prevRoll.running = true;
          }
          const modMs = Math.max(parseIsoTimestampMs(t?.lastModifiedTime), parseIsoTimestampMs(sc?.timeKey), Number(prevSub?.updatedAt) || 0);
          if (modMs > prevRoll.maxUpdatedAt) prevRoll.maxUpdatedAt = modMs;
          subagentRollup.set(rootId, prevRoll);
        }
        store.map.delete(cid);
        continue;
      }
      if (t) rootTrajs.set(cid, t);
      rootIds.push(cid);
    }

    for (const [subId, subRec] of store.subagentStates.entries()) {
      if (seenSubIds.has(subId) || !subRec || !subRec.rootId) continue;
      const prevRoll = subagentRollup.get(subRec.rootId) || { waiting: false, running: false, maxUpdatedAt: 0 };
      if (subRec.status === 'waiting') prevRoll.waiting = true;
      else if (subRec.status === 'running') prevRoll.running = true;
      if ((Number(subRec.updatedAt) || 0) > prevRoll.maxUpdatedAt) prevRoll.maxUpdatedAt = Number(subRec.updatedAt) || 0;
      subagentRollup.set(subRec.rootId, prevRoll);
    }

    const activeSessionId = String(snap.sessionId || '').trim();
    const hasPendingApprovals = Array.isArray(snap.pendingApprovals) && snap.pendingApprovals.length > 0;
    const nowMs = Date.now();

    for (const id of rootIds) {
      const prev = store.map.get(id);
      const t = rootTrajs.get(id);
      const sc = snapConvMap.get(id);
      const roll = subagentRollup.get(id);
      const isActive = Boolean((activeSessionId && id === activeSessionId) || sc?.active);

      const snapPid = String(sc?.projectId || '').trim();
      const trajPid = String(t?.trajectoryMetadata?.projectId || '').trim();
      const wsPid = t ? matchWorkspaceToProjectId(t, projectsMeta) : '';
      let projectId = (snapPid && snapPid !== 'ungrouped') ? snapPid : (trajPid || wsPid || String(prev?.projectId || '').trim());
      if (projectId === 'outside-of-project' && !projectNameMap.has('outside-of-project')) {
        projectNameMap.set('outside-of-project', '独立对话');
      }
      const projArchived = Boolean(projectId && archivedProjectIds?.has(projectId));

      const archived = ((t?.annotations?.archived === true || projArchived) && !isActive)
        ? true
        : ((t && !projArchived) ? false : Boolean(prev?.archived && !isActive));

      const snapTitle = String(sc?.title || '').trim();
      const isUsefulSnapTitle = Boolean(snapTitle && snapTitle !== id.slice(0, 8));
      const trajTitle = String(t?.annotations?.title || t?.summary || '').trim();
      const title = (isUsefulSnapTitle ? snapTitle : '') || trajTitle || prev?.title || snapTitle || id.slice(0, 8);

      const modMs = parseIsoTimestampMs(t?.lastModifiedTime);
      const scTimeMs = parseIsoTimestampMs(sc?.timeKey);
      const subMs = roll?.maxUpdatedAt || 0;
      const updatedAt = Math.max(modMs, scTimeMs, subMs, Number(prev?.updatedAt) || 0) || nowMs;

      const viewMs = Math.max(
        parseIsoTimestampMs(t?.annotations?.lastUserViewTime),
        Number(prev?.lastViewedAt) || 0,
        isActive ? Math.max(updatedAt, nowMs) : 0
      );

      const pinned = Boolean(
        sc?.pinned !== undefined ? sc.pinned
          : (t?.annotations?.pinned !== undefined ? t.annotations.pinned : prev?.pinned)
      );

      const status = normalizeTrajectoryStatus(t?.status, t?.latestExecutorTerminationReason, {
        hasPendingApprovals: isActive && hasPendingApprovals,
        activeBusy: isActive && Boolean(snap.busy),
        domBusy: Boolean(sc?.domBusy),
        domStatus: sc?.status,
        subagentWaiting: Boolean(roll?.waiting),
        subagentRunning: Boolean(roll?.running),
        fallbackStatus: prev?.status
      });

      const projectName = String(
        projectNameMap.get(projectId) ||
        sc?.projectName ||
        prev?.projectName ||
        (projectId ? projectId : '未归属项目')
      );

      if (projectId && !archived && !excludedProjectIds.has(projectId) && !projectNameMap.has(projectId)) {
        projectNameMap.set(projectId, projectName);
      }

      store.map.set(id, {
        id,
        title: title.slice(0, 100),
        projectId: projectId || 'ungrouped',
        projectName,
        pinned,
        archived,
        updatedAt,
        lastViewedAt: viewMs,
        status,
        statusLabel: statusToLabel(status)
      });
    }

    // 4. 全量保留非归档根会话并落盘（仅回收超量已归档墓碑）
    const nonArchivedPersisted = [];
    const archivedTombstones = [];
    for (const item of store.map.values()) {
      if (item.archived) archivedTombstones.push(item);
      else nonArchivedPersisted.push(item);
    }
    nonArchivedPersisted.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    archivedTombstones.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const keptArchived = archivedTombstones.slice(0, MAX_ARCHIVED_TOMBSTONES);
    const persistedAll = [...nonArchivedPersisted, ...keptArchived];
    if (archivedTombstones.length > MAX_ARCHIVED_TOMBSTONES) {
      store.map.clear();
      for (const item of persistedAll) store.map.set(item.id, item);
    }

    store.lastActiveSessionId = activeSessionId;
    const { items: allActiveConvs, catalogRevision } = buildActiveCatalogItems(store, activeSessionId, snapConvMap);
    store.catalogRevision = catalogRevision;

    const persistSig = JSON.stringify([
      store.subagentIds.size,
      Array.from(store.subagentStates.entries()).sort((a, b) => a[0].localeCompare(b[0])),
      persistedAll.map((c) => [c.id, c.title, c.projectId, c.archived, c.pinned, c.updatedAt, c.status, c.lastViewedAt])
    ]);
    if (persistSig !== store.lastSig) {
      store.lastSig = persistSig;
      safeWriteJsonSync(store.filePath, {
        version: 2,
        updatedAt: nowMs,
        subagentIds: Array.from(store.subagentIds).sort(),
        subagentRoots: Object.fromEntries(store.subagentRoots),
        subagentStates: Object.fromEntries(store.subagentStates),
        conversations: persistedAll
      });
    }

    // 5. 基于全量未归档会话聚合并排序多项目列表（包含空项目，过滤内部空项目）
    const activeConvObj = allActiveConvs.find((c) => c.active);
    const currentProjectId = String(snap.currentProjectId || activeConvObj?.projectId || '').trim();
    const projectStats = new Map();

    const ensureProjBucket = (pid, name) => {
      if (!projectStats.has(pid)) {
        projectStats.set(pid, {
          id: pid,
          name: name || pid,
          conversationCount: 0,
          runningCount: 0,
          waitingCount: 0,
          unreadCount: 0,
          lastActiveAt: 0
        });
      }
      return projectStats.get(pid);
    };

    for (const [pid, name] of projectNameMap.entries()) {
      ensureProjBucket(pid, name);
    }

    for (const c of allActiveConvs) {
      const pid = c.projectId || 'ungrouped';
      const bucket = ensureProjBucket(pid, c.projectName || '未归属项目');
      bucket.conversationCount += 1;
      if (c.status === 'running') bucket.runningCount += 1;
      if (c.status === 'waiting') bucket.waitingCount += 1;
      if (c.unread) bucket.unreadCount += 1;
      if (c.updatedAt > bucket.lastActiveAt) bucket.lastActiveAt = c.updatedAt;
    }

    const projects = Array.from(projectStats.values())
      .filter((p) => !(INTERNAL_EMPTY_PROJECT_IDS.has(p.id) && p.conversationCount === 0))
      .filter((p) => !(p.id === 'ungrouped' && p.conversationCount === 0))
      .map((p) => ({
        ...p,
        isEmpty: p.conversationCount === 0,
        active: Boolean(currentProjectId && p.id === currentProjectId)
      }))
      .sort((a, b) => {
        if ((a.conversationCount > 0) !== (b.conversationCount > 0)) {
          return a.conversationCount > 0 ? -1 : 1;
        }
        if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });

    // 支持快照首屏分窗大小（0=全量，>0 时确保每项目至少前3条及当前活跃会话且总条数受控，其余通过 /api/conversations 分页拉取）
    const convLimit = options.convLimit === undefined ? 0 : Math.max(0, Number(options.convLimit) || 0);
    let outputConvs = allActiveConvs;
    if (convLimit > 0 && allActiveConvs.length > convLimit) {
      const picked = new Set();
      if (activeConvObj) picked.add(activeConvObj.id);
      const perProj = new Map();
      for (const c of allActiveConvs) {
        const cnt = perProj.get(c.projectId) || 0;
        if (cnt < 3 && picked.size < convLimit) {
          picked.add(c.id);
          perProj.set(c.projectId, cnt + 1);
        }
      }
      for (const c of allActiveConvs) {
        if (picked.size >= convLimit) break;
        picked.add(c.id);
      }
      outputConvs = allActiveConvs.filter((c) => picked.has(c.id));
    }

    const currentProj = projects.find((p) => p.id === currentProjectId);
    const currentProjectName = String(snap.currentProjectName || currentProj?.name || '').trim();

    return {
      ...snap,
      currentProjectId,
      currentProjectName,
      catalogRevision,
      totalConversations: allActiveConvs.length,
      hasMoreConversations: outputConvs.length < allActiveConvs.length,
      projects,
      conversations: outputConvs
    };
  }

  function listConversations(options = {}) {
    const store = getStickyStoreForDir(options.stateDir || getStateDir());
    const projectId = String(options.projectId || '').trim();
    const offset = Math.max(0, Number.parseInt(options.offset ?? 0, 10) || 0);
    const rawLimit = options.limit === undefined || options.limit === null || options.limit === '' ? 100 : Number.parseInt(options.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 0;
    const activeSessionId = String(options.activeSessionId ?? store.lastActiveSessionId ?? '').trim();

    const { items: allItems, catalogRevision } = buildActiveCatalogItems(store, activeSessionId, null);
    const items = projectId ? allItems.filter((c) => c.projectId === projectId) : allItems;
    const total = items.length;
    const sliced = limit > 0 ? items.slice(offset, offset + limit) : items.slice(offset);
    return {
      ok: true,
      total,
      offset,
      hasMore: offset + sliced.length < total,
      catalogRevision,
      conversations: sliced
    };
  }

  function invalidateProjectsCache() {
    projectsCache.fetchedAt = 0;
    projectsCache.data = null;
    trajCache.at = 0;
  }

  return { enrichSnapshot, listConversations, invalidateProjectsCache };
}

const defaultCatalogStore = createSessionCatalogStore();

async function enrichSnapshotWithCatalog(snap, options = {}) {
  const withCatalog = await defaultCatalogStore.enrichSnapshot(snap, options);
  return await defaultHistoryManager.enrichMessages(withCatalog, options);
}

function listCatalogConversations(options = {}) {
  return defaultCatalogStore.listConversations(options);
}

// ==================== 宿主机目录浏览、新建子目录与远程创建项目 ====================

function resolveHostPathInput(rawPath, homeDir = os.homedir()) {
  const baseHome = path.resolve(String(homeDir || os.homedir()));
  const raw = String(rawPath ?? '').trim();
  if (raw.includes('\0')) {
    throw Object.assign(new Error('目录路径包含非法字符'), { status: 400 });
  }
  if (!raw || raw === '~') return baseHome;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(baseHome, raw.slice(2));
  }
  if (!path.isAbsolute(raw)) {
    return path.resolve(baseHome, raw);
  }
  return path.resolve(raw);
}

function readGitDefaultBranchFromDisk(dirPath) {
  try {
    const gitHeadPath = path.join(dirPath, '.git', 'HEAD');
    if (fs.existsSync(gitHeadPath) && fs.statSync(gitHeadPath).isFile()) {
      const head = fs.readFileSync(gitHeadPath, 'utf8').trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m && m[1]) return m[1].trim();
    }
  } catch {}
  return '';
}

function buildUniqueSuggestedProjectName(baseName, existingNamesSet, matchedExisting) {
  if (matchedExisting?.name) return matchedExisting.name;
  const clean = String(baseName || '').trim() || 'new-project';
  const hasConflict = (candidate) => existingNamesSet.has(candidate.toLowerCase());
  if (!hasConflict(clean)) return clean;
  for (let i = 2; i < 100; i++) {
    const cand = `${clean} (${i})`;
    if (!hasConflict(cand)) return cand;
  }
  return `${clean}-${Date.now().toString(36).slice(-4)}`;
}

function listHostDirectories(options = {}) {
  const homeDir = path.resolve(String(options.homeDir || os.homedir()));
  const showHidden = Boolean(options.showHidden);
  const resolvedPath = resolveHostPathInput(options.dirPath, homeDir);

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw Object.assign(new Error('无权限读取该目录'), { status: 403 });
    }
    throw Object.assign(new Error('目标路径不存在或无法访问'), { status: 400 });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('目标路径不是文件夹'), { status: 400 });
  }

  let dirents;
  try {
    dirents = fs.readdirSync(resolvedPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw Object.assign(new Error('无权限列出该目录内容'), { status: 403 });
    }
    throw Object.assign(new Error('读取目录列表失败'), { status: 400 });
  }

  const { metaMap } = loadProjectsMetaFromDisk({
    configDir: options.configDir,
    bypassCache: options.bypassCache !== undefined ? Boolean(options.bypassCache) : true
  });
  const primaryPathMap = new Map();
  const existingNamesSet = new Set();
  for (const proj of metaMap.values()) {
    if (proj.name) existingNamesSet.add(proj.name.toLowerCase());
    if (proj.primaryPath) {
      const norm = path.resolve(proj.primaryPath);
      if (!primaryPathMap.has(norm)) {
        primaryPathMap.set(norm, { id: proj.id, name: proj.name });
      }
    }
  }

  const rootCandidates = [
    { label: '主目录 (~)', path: homeDir },
    { label: 'codebase', path: path.join(homeDir, 'codebase') },
    { label: 'shared', path: path.join(homeDir, 'shared') },
    { label: 'Projects', path: path.join(homeDir, 'Projects') },
    { label: 'Developer', path: path.join(homeDir, 'Developer') },
    { label: 'Desktop', path: path.join(homeDir, 'Desktop') },
    { label: 'Documents', path: path.join(homeDir, 'Documents') }
  ];
  const roots = [];
  const seenRoots = new Set();
  for (const rc of rootCandidates) {
    const abs = path.resolve(rc.path);
    if (seenRoots.has(abs)) continue;
    try {
      if (fs.statSync(abs).isDirectory()) {
        fs.accessSync(abs, fs.constants.R_OK);
        seenRoots.add(abs);
        roots.push({ label: rc.label, path: abs });
      }
    } catch {}
  }

  const allEntries = [];
  for (const d of dirents) {
    const name = String(d?.name || '');
    if (!name || name === '.' || name === '..') continue;
    const isHidden = name.startsWith('.');
    if (!showHidden && isHidden) continue;
    const childFull = path.join(resolvedPath, name);
    let isDir = false;
    try {
      if (d.isDirectory()) isDir = true;
      else if (d.isSymbolicLink() && fs.statSync(childFull).isDirectory()) isDir = true;
    } catch {}
    if (!isDir) continue;
    const linked = primaryPathMap.get(childFull) || null;
    let isGitRepo = false;
    try {
      isGitRepo = fs.existsSync(path.join(childFull, '.git'));
    } catch {}
    allEntries.push({
      name,
      path: childFull,
      isHidden,
      isGitRepo,
      existingProjectId: linked?.id || '',
      existingProjectName: linked?.name || ''
    });
  }

  allEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  const MAX_DIR_ENTRIES = 300;
  const truncated = allEntries.length > MAX_DIR_ENTRIES;
  const entries = truncated ? allEntries.slice(0, MAX_DIR_ENTRIES) : allEntries;

  const parsedRoot = path.parse(resolvedPath).root;
  const parentPath = resolvedPath === parsedRoot ? null : path.dirname(resolvedPath);
  const currentName = path.basename(resolvedPath) || resolvedPath;
  const existingProject = primaryPathMap.get(resolvedPath) || null;
  let selfIsGitRepo = false;
  try {
    selfIsGitRepo = fs.existsSync(path.join(resolvedPath, '.git'));
  } catch {}
  const suggestedName = buildUniqueSuggestedProjectName(currentName, existingNamesSet, existingProject);

  return {
    ok: true,
    path: resolvedPath,
    currentName,
    parentPath,
    isGitRepo: selfIsGitRepo,
    existingProject,
    suggestedName,
    showHidden,
    roots,
    entries,
    truncated
  };
}

function createHostSubdirectory(payload = {}, options = {}) {
  const homeDir = path.resolve(String(options.homeDir || os.homedir()));
  const rawParent = String(payload?.parentPath || '').trim();
  if (!rawParent) {
    throw Object.assign(new Error('缺少父目录路径'), { status: 400 });
  }
  const resolvedParent = resolveHostPathInput(rawParent, homeDir);
  let parentStat;
  try {
    parentStat = fs.statSync(resolvedParent);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw Object.assign(new Error('无权限访问父目录'), { status: 403 });
    }
    throw Object.assign(new Error('父目录不存在'), { status: 400 });
  }
  if (!parentStat.isDirectory()) {
    throw Object.assign(new Error('父路径不是文件夹'), { status: 400 });
  }

  const rawName = String(payload?.name || '').trim();
  if (!rawName || rawName === '.' || rawName === '..' || /[\\/\0]/.test(rawName)) {
    throw Object.assign(new Error('文件夹名称非法，不可为空或包含斜杠'), { status: 400 });
  }

  const targetPath = path.join(resolvedParent, rawName);
  if (fs.existsSync(targetPath)) {
    const st = fs.statSync(targetPath);
    if (!st.isDirectory()) {
      throw Object.assign(new Error('同名文件已存在且不是文件夹'), { status: 400 });
    }
    return { ok: true, existed: true, path: targetPath, name: rawName };
  }

  try {
    fs.mkdirSync(targetPath);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw Object.assign(new Error('无权限在该目录创建文件夹'), { status: 403 });
    }
    throw Object.assign(new Error(err?.message || '创建文件夹失败'), { status: 500 });
  }
  return { ok: true, existed: false, path: targetPath, name: rawName };
}

async function createRemoteProject(payload = {}, options = {}) {
  const homeDir = path.resolve(String(options.homeDir || os.homedir()));
  const rawFolder = String(payload?.folderPath || '').trim();
  if (!rawFolder) {
    throw Object.assign(new Error('请选择项目文件夹路径'), { status: 400 });
  }
  const resolvedPath = resolveHostPathInput(rawFolder, homeDir);
  if (resolvedPath === path.parse(resolvedPath).root) {
    throw Object.assign(new Error('不支持直接以系统根目录作为项目'), { status: 400 });
  }

  let dirStat;
  try {
    dirStat = fs.statSync(resolvedPath);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      throw Object.assign(new Error('无权限访问所选文件夹'), { status: 403 });
    }
    throw Object.assign(new Error('所选项目目录不存在'), { status: 400 });
  }
  if (!dirStat.isDirectory()) {
    throw Object.assign(new Error('所选路径不是文件夹'), { status: 400 });
  }

  const requestedName = String(payload?.name || '').trim();
  const projectName = requestedName || path.basename(resolvedPath) || 'new-project';
  const forceNew = Boolean(payload?.forceNew);
  const requestedExistingId = String(payload?.existingProjectId || '').trim();

  const { metaMap } = loadProjectsMetaFromDisk({ configDir: options.configDir, bypassCache: true });
  let matchedExisting = null;
  for (const proj of metaMap.values()) {
    if (proj.primaryPath && path.resolve(proj.primaryPath) === resolvedPath) {
      matchedExisting = proj;
      break;
    }
  }
  if (!matchedExisting && requestedExistingId && metaMap.has(requestedExistingId)) {
    matchedExisting = metaMap.get(requestedExistingId);
  }

  if (matchedExisting && !forceNew && (!requestedName || requestedName.toLowerCase() === matchedExisting.name.toLowerCase())) {
    return {
      ok: true,
      alreadyExists: true,
      project: {
        id: matchedExisting.id,
        name: matchedExisting.name,
        folderPath: resolvedPath
      }
    };
  }

  const customConnect = options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__;
  let connectFn = customConnect;
  if (!connectFn && !isCatalogTestEnv()) {
    try {
      connectFn = require('./local-api').connect;
    } catch {}
  }

  let lsApi = null;
  if (connectFn) {
    try {
      lsApi = typeof connectFn === 'function' ? await withRaceTimeout(connectFn(), 1500, null) : connectFn;
    } catch {
      lsApi = null;
    }
  }

  if (!forceNew && requestedExistingId && lsApi && typeof lsApi.call === 'function') {
    try {
      const readRes = await withRaceTimeout(lsApi.call('ReadProject', { id: requestedExistingId }), 1500, null);
      const rp = readRes?.project;
      if (rp && rp.id === requestedExistingId && !rp.archived) {
        const rpName = String(rp.name || requestedName || '').trim();
        if (!requestedName || requestedName.toLowerCase() === rpName.toLowerCase()) {
          return {
            ok: true,
            alreadyExists: true,
            project: {
              id: rp.id,
              name: rpName,
              folderPath: resolvedPath
            }
          };
        }
      }
    } catch {}
  }

  for (const proj of metaMap.values()) {
    if (proj.name && proj.name.toLowerCase() === projectName.toLowerCase()) {
      throw Object.assign(new Error(`同名项目「${proj.name}」已存在，请修改项目名称`), { status: 400 });
    }
  }

  const folderUri = pathToFileURL(resolvedPath).href.replace(/\/+$/, '');
  let isGitRepo = false;
  try {
    isGitRepo = fs.existsSync(path.join(resolvedPath, '.git'));
  } catch {}
  let defaultBranch = isGitRepo ? readGitDefaultBranchFromDisk(resolvedPath) : '';

  if (lsApi && typeof lsApi.call === 'function') {
    try {
      const resolvedFolder = await withRaceTimeout(lsApi.call('ResolveFolder', { folderUri }), 2500, null);
      if (resolvedFolder && (resolvedFolder.resourceType === 'FOLDER_TYPE_GIT_FOLDER' || resolvedFolder.resourceType === 2)) {
        isGitRepo = true;
      }
    } catch {}
    if (isGitRepo) {
      try {
        const repoRes = await withRaceTimeout(lsApi.call('GetRepoInfos', { repoUris: [folderUri] }), 2500, null);
        const branches = Array.isArray(repoRes?.repos?.[0]?.branches) ? repoRes.repos[0].branches : [];
        if (branches.length) {
          const names = branches.map((b) => String(b?.name || '').trim()).filter(Boolean);
          const cur = branches.find((b) => b?.isCurrentBranch && b?.name)?.name;
          if (names.includes('main')) defaultBranch = 'main';
          else if (names.includes('master')) defaultBranch = 'master';
          else if (cur) defaultBranch = String(cur).trim();
          else if (names[0] && !defaultBranch) defaultBranch = names[0];
        }
      } catch {}
    }
  }

  const projectId = crypto.randomUUID();
  const resource = isGitRepo
    ? { gitFolder: { folderUri, defaultBranch: defaultBranch || '' } }
    : { folderUri };
  const projectObj = {
    id: projectId,
    name: projectName,
    projectResources: { resources: [resource] },
    permissionGrants: { v2Migrated: true },
    settings: {},
    isWorkspaceOnly: false
  };

  let created = false;
  let lastLsError = '';
  if (lsApi && typeof lsApi.call === 'function') {
    try {
      await lsApi.call('CreateProject', { project: projectObj });
      created = true;
    } catch (err) {
      lastLsError = err?.message || 'CreateProject 调用失败';
    }
  }

  const effectiveConfigDir = String(options.configDir || process.env.AG_CONFIG_DIR || '').trim()
    || (isCatalogTestEnv() ? '' : path.join(os.homedir(), '.gemini', 'config'));
  if (!created) {
    const canFallback = Boolean(options.allowDiskFallback || options.configDir || process.env.AG_CONFIG_DIR);
    if (!canFallback || !effectiveConfigDir) {
      throw Object.assign(new Error(lastLsError || '无法连接 Antigravity 语言服务以创建项目'), { status: 503 });
    }
    const projFile = path.join(effectiveConfigDir, 'projects', `${projectId}.json`);
    const writeRes = safeWriteJsonSync(projFile, projectObj, {
      indent: 2,
      validate: (d) => d && d.id === projectId && d.name === projectName
    });
    if (!writeRes?.ok) {
      throw Object.assign(new Error(writeRes?.error || '保存项目配置失败'), { status: 500 });
    }
  }

  defaultCatalogStore.invalidateProjectsCache();
  return {
    ok: true,
    alreadyExists: false,
    project: {
      id: projectId,
      name: projectName,
      folderPath: resolvedPath,
      folderUri,
      isGitRepo,
      defaultBranch
    }
  };
}

// ==================== 全量会话轨迹读取、Markdown 渲染与向上分页 ====================

function escSafeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSafeMarkdownToHtml(rawMd) {
  const src = String(rawMd || '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  const codeBlocks = [];
  const withCodePlaceholders = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escSafeHtml(String(code || '').replace(/\n$/, ''))}</code></pre>`);
    return `\n\u0000CB${idx}\u0000\n`;
  });

  const formatInline = (text) => {
    const inlineCodes = [];
    const tokens = [];
    let s = String(text || '').replace(/`([^`\n]+)`/g, (_m, c) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${escSafeHtml(c)}</code>`);
      return `\u0000IC${idx}\u0000`;
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, rawUrl) => {
      const idx = tokens.length;
      if (/^https?:\/\//i.test(rawUrl)) {
        tokens.push(`<a href="${escSafeHtml(rawUrl)}" target="_blank" rel="noopener">${escSafeHtml(label)}</a>`);
      } else if (/^file:\/\//i.test(rawUrl)) {
        tokens.push(`<code class="md-pill">${escSafeHtml(label)}</code>`);
      } else {
        tokens.push(escSafeHtml(label));
      }
      return `\u0000LN${idx}\u0000`;
    });
    let escaped = escSafeHtml(s);
    escaped = escaped.replace(/\*\*([^\n*][^\n]*?[^\n*]|[^\n*])\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/(^|[^*])\*([^\s*\n][^*\n]*?[^\s*\n]|[^\s*\n])\*(?!\*)/g, '$1<em>$2</em>');
    escaped = escaped.replace(/\u0000LN(\d+)\u0000/g, (_m, idx) => tokens[Number(idx)] || '');
    escaped = escaped.replace(/\u0000IC(\d+)\u0000/g, (_m, idx) => inlineCodes[Number(idx)] || '');
    return escaped;
  };

  const splitTableCells = (line) => {
    let trimmed = line.trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map((c) => c.trim());
  };
  const isTableSep = (line) => /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);

  const lines = withCodePlaceholders.split('\n');
  const out = [];
  let para = [];
  let listTag = '';
  let listItems = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((ln) => formatInline(ln)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!listItems.length || !listTag) return;
    out.push(`<${listTag}>${listItems.map((it) => `<li>${formatInline(it)}</li>`).join('')}</${listTag}>`);
    listTag = '';
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const cbMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (cbMatch) {
      flushPara();
      flushList();
      out.push(codeBlocks[Number(cbMatch[1])] || '');
      continue;
    }
    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      flushPara();
      flushList();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${formatInline(hMatch[2])}</h${lvl}>`);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push('<hr>');
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushPara();
      flushList();
      const bqLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        bqLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      i--;
      const isAlert = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(bqLines[0] || '');
      const clsAttr = isAlert ? ' class="md-alert"' : '';
      out.push(`<blockquote${clsAttr}>${bqLines.map((l) => formatInline(l)).join('<br>')}</blockquote>`);
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      flushList();
      const headers = splitTableCells(trimmed);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().includes('|') && !/^\s*$/.test(lines[i])) {
        bodyRows.push(splitTableCells(lines[i]));
        i++;
      }
      i--;
      const thead = `<thead><tr>${headers.map((h) => `<th>${formatInline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map((row) => `<tr>${headers.map((_, ci) => `<td>${formatInline(row[ci] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listTag !== 'ul') {
        flushList();
        listTag = 'ul';
      }
      listItems.push(ulMatch[1]);
      continue;
    }
    const olMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (olMatch) {
      flushPara();
      if (listTag !== 'ol') {
        flushList();
        listTag = 'ol';
      }
      listItems.push(olMatch[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

function formatTrajectoryUserInput(ui) {
  if (!ui || typeof ui !== 'object') return '';
  const pieces = [];
  if (Array.isArray(ui.items)) {
    for (const it of ui.items) {
      if (!it || typeof it !== 'object') continue;
      if (typeof it.text === 'string' && it.text) {
        pieces.push(it.text);
      } else if (it.item?.file?.absoluteUri) {
        const uri = String(it.item.file.absoluteUri);
        const base = decodeURIComponent(uri.split('/').pop() || uri);
        pieces.push(`@${base}`);
      } else if (it.item?.directory?.absoluteUri) {
        const uri = String(it.item.directory.absoluteUri);
        const base = decodeURIComponent(uri.replace(/\/+$/, '').split('/').pop() || uri);
        pieces.push(`@${base}`);
      } else if (it.item?.slashCommand?.info?.name) {
        pieces.push(`/${it.item.slashCommand.info.name}`);
      }
    }
  }
  let raw = pieces.join(' ').trim() || String(ui.userResponse || '').trim();
  const urMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (urMatch) raw = urMatch[1];
  raw = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
  if (!raw || /^(?:<SYSTEM_MESSAGE>|<CONTEXT_SUMMARY>)/i.test(raw)) {
    raw = '';
  }
  if (!raw && Array.isArray(ui.media) && ui.media.length > 0) {
    raw = '[图片附件]';
  } else if (raw && Array.isArray(ui.media) && ui.media.length > 0) {
    raw += `\n[附带 ${ui.media.length} 张图片]`;
  }
  return raw;
}

function extractMessagesFromTrajectorySteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return [];
  const messages = [];
  let pendingThoughts = [];

  const flushPendingThoughtsOnly = (idxTag) => {
    if (!pendingThoughts.length) return;
    messages.push({
      id: `t-think-${idxTag}`,
      role: 'assistant',
      text: '',
      html: '',
      thoughtLabel: '思考过程',
      thoughtText: pendingThoughts.join('\n\n'),
      highRisk: false,
      riskText: ''
    });
    pendingThoughts = [];
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const type = String(step.type || '');
    if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const userText = formatTrajectoryUserInput(step.userInput);
      if (!userText) continue;
      flushPendingThoughtsOnly(i);
      messages.push({
        id: `t-u-${i}`,
        role: 'user',
        text: userText
      });
      continue;
    }
    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const pr = step.plannerResponse || {};
      const thought = String(pr.thinking || pr.thought || '').trim();
      if (thought) pendingThoughts.push(thought);
      const replyRaw = String(pr.modifiedResponse ?? pr.response ?? '').trim();
      if (replyRaw) {
        const replyText = replyRaw;
        const thoughtText = pendingThoughts.join('\n\n');
        messages.push({
          id: `t-a-${i}`,
          role: 'assistant',
          text: replyText,
          html: renderSafeMarkdownToHtml(replyText),
          thoughtLabel: thoughtText ? '思考过程' : '',
          thoughtText,
          highRisk: false,
          riskText: ''
        });
        pendingThoughts = [];
      }
    }
  }
  flushPendingThoughtsOnly('end');
  return messages;
}

function normMsgPrefix(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function mergeTrajectoryAndDomMessages(trajMsgs, domMessages, options = {}) {
  const domList = Array.isArray(domMessages) ? domMessages.filter(Boolean) : [];
  const baseList = Array.isArray(trajMsgs) ? trajMsgs.map((m) => ({ ...m })) : [];
  if (!baseList.length) {
    return domList.map((m, idx) => ({ ...m, msgIndex: idx }));
  }

  for (const dm of domList) {
    if (dm.role !== 'assistant') continue;
    const dSig = normMsgPrefix(dm.text);
    const matchTarget = baseList
      .slice(-8)
      .reverse()
      .find((tm) => tm.role === 'assistant' && dSig && normMsgPrefix(tm.text) && (
        normMsgPrefix(tm.text).startsWith(dSig.slice(0, 32)) || dSig.startsWith(normMsgPrefix(tm.text).slice(0, 32))
      ));
    if (matchTarget) {
      if (dm.highRisk) {
        matchTarget.highRisk = true;
        matchTarget.riskText = dm.riskText || matchTarget.riskText || '';
      }
      if (options.busy && String(dm.text || '').length > String(matchTarget.text || '').length) {
        matchTarget.text = dm.text;
        matchTarget.html = dm.html || matchTarget.html;
      }
      if (!matchTarget.thoughtText && dm.thoughtText) {
        matchTarget.thoughtLabel = dm.thoughtLabel || '思考过程';
        matchTarget.thoughtText = dm.thoughtText;
      }
    }
  }

  // 如果桌面 DOM 末尾刚发送/流式生成了轨迹接口尚未索引的最新消息，无损补入尾部
  const lastBaseUserSig = (() => {
    for (let i = baseList.length - 1; i >= 0; i--) {
      if (baseList[i].role === 'user') return normMsgPrefix(baseList[i].text);
    }
    return '';
  })();
  let startAppendIdx = -1;
  for (let i = domList.length - 1; i >= 0; i--) {
    if (domList[i].role === 'user' && lastBaseUserSig && normMsgPrefix(domList[i].text) === lastBaseUserSig) {
      startAppendIdx = i + 1;
      break;
    }
  }
  if (startAppendIdx >= 0) {
    const tailBaseMsgs = baseList.slice(-4);
    for (let j = startAppendIdx; j < domList.length; j++) {
      const dm = domList[j];
      const dSig = normMsgPrefix(dm.text);
      const dup = tailBaseMsgs.some((bm) => bm.role === dm.role && dSig && normMsgPrefix(bm.text).startsWith(dSig.slice(0, 32)));
      if (!dup) {
        baseList.push({ ...dm, id: `dom-tail-${j}` });
      }
    }
  } else if (!lastBaseUserSig && domList.length) {
    for (let j = 0; j < domList.length; j++) {
      const dm = domList[j];
      if (dm.role === 'user') baseList.push({ ...dm, id: `dom-tail-${j}` });
    }
  }

  return baseList.map((m, idx) => ({ ...m, msgIndex: idx }));
}

function createConversationHistoryManager() {
  const cache = new Map();
  const MAX_CACHE_ENTRIES = 12;

  function touchCache(sessionId, rec) {
    if (cache.has(sessionId)) cache.delete(sessionId);
    cache.set(sessionId, rec);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }

  async function fetchTrajectoryMessages(sessionId, options = {}) {
    const customConnect = options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__;
    let connectFn = customConnect;
    if (!connectFn) {
      if (isCatalogTestEnv()) return null;
      try {
        connectFn = require('./local-api').connect;
      } catch {
        return null;
      }
    }
    try {
      const api = typeof connectFn === 'function' ? await withRaceTimeout(connectFn(), 1200, null) : connectFn;
      if (!api || typeof api.call !== 'function') return null;
      const res = await withRaceTimeout(
        Promise.resolve().then(() => api.call('GetCascadeTrajectory', { cascadeId: sessionId })).catch(() => null),
        2500,
        null
      );
      const steps = res?.trajectory?.steps;
      if (!Array.isArray(steps)) return null;
      return extractMessagesFromTrajectorySteps(steps);
    } catch {
      return null;
    }
  }

  async function resolveFullMessages(sessionId, domMessages, options = {}) {
    const sid = String(sessionId || '').trim();
    const domTail = Array.isArray(domMessages) ? domMessages : [];
    if (!sid) {
      return domTail.map((m, idx) => ({ ...m, msgIndex: idx }));
    }
    const existing = cache.get(sid);
    const nowMs = Date.now();
    const ttl = options.busy ? 1000 : 3500;
    let trajMsgs = null;
    if (!options.bypassCache && existing && Array.isArray(existing.trajMsgs) && (nowMs - existing.at < ttl)) {
      trajMsgs = existing.trajMsgs;
    } else {
      const fetched = await fetchTrajectoryMessages(sid, options);
      if (Array.isArray(fetched)) {
        trajMsgs = fetched;
      } else if (existing && Array.isArray(existing.trajMsgs)) {
        trajMsgs = existing.trajMsgs;
      }
    }

    const merged = mergeTrajectoryAndDomMessages(trajMsgs, domTail, { busy: Boolean(options.busy) });
    touchCache(sid, {
      trajMsgs: Array.isArray(trajMsgs) ? trajMsgs : (existing?.trajMsgs || null),
      domTail: domTail.length ? domTail : (existing?.domTail || []),
      merged,
      at: nowMs
    });
    return merged;
  }

  async function enrichMessages(snap, options = {}) {
    if (!snap || typeof snap !== 'object' || snap.ok === false) return snap;
    const fullMsgs = await resolveFullMessages(snap.sessionId, snap.messages, {
      ...options,
      busy: Boolean(snap.busy)
    });
    const rawLimit = options.msgLimit === undefined ? 30 : Math.max(0, Number(options.msgLimit) || 0);
    const startIdx = (rawLimit > 0 && fullMsgs.length > rawLimit) ? (fullMsgs.length - rawLimit) : 0;
    const sliced = fullMsgs.slice(startIdx);
    return {
      ...snap,
      totalMessages: fullMsgs.length,
      messagesStartIndex: startIdx,
      hasEarlierMessages: startIdx > 0,
      messages: sliced
    };
  }

  async function getMessagesPage(options = {}) {
    const sid = String(options.sessionId || '').trim();
    if (!sid) return { ok: false, error: '缺少 sessionId 参数' };
    const limit = Math.max(1, Math.min(200, Number.parseInt(options.limit ?? 30, 10) || 30));
    const existing = cache.get(sid);
    const fullMsgs = await resolveFullMessages(sid, existing?.domTail || [], options);
    const total = fullMsgs.length;
    const hasBefore = options.before !== undefined && options.before !== null && options.before !== '';
    const rawBefore = hasBefore ? Number.parseInt(options.before, 10) : total;
    const endIdx = Math.max(0, Math.min(total, Number.isFinite(rawBefore) ? rawBefore : total));
    const startIdx = Math.max(0, endIdx - limit);
    return {
      ok: true,
      sessionId: sid,
      totalMessages: total,
      startIndex: startIdx,
      endIndex: endIdx,
      hasEarlier: startIdx > 0,
      messages: fullMsgs.slice(startIdx, endIdx)
    };
  }

  return { enrichMessages, getMessagesPage };
}

const defaultHistoryManager = createConversationHistoryManager();

function getConversationMessagesPage(options = {}) {
  return defaultHistoryManager.getMessagesPage(options);
}

async function fetchSnapshotFromTarget(requestedTargetId, snapOptions = {}) {
  const { target, windows } = await pickCdpTarget(requestedTargetId);
  const expr = `(() => {
    const fn = window.__AGEnhancer?.getMobileSnapshot;
    if (typeof fn !== 'function') {
      return { ok: false, error: '当前窗口尚未注入增强挂件 (请确保 live-host 已连接)' };
    }
    return fn();
  })()`;
  const snap = await evalInTarget(target, expr);
  if (!snap || typeof snap !== 'object') {
    throw new Error('未能读取窗口快照');
  }
  const baseSnap = {
    ...snap,
    currentTargetId: target.id,
    windows
  };
  try {
    return await enrichSnapshotWithCatalog(baseSnap, snapOptions);
  } catch {
    return baseSnap;
  }
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
  const actionResult = await evalInTarget(target, expr, 6000);
  const act = payload?.action;
  const settleMs = (act === 'switch-conversation' || act === 'new-conversation') ? 260 : 120;
  await new Promise((r) => setTimeout(r, settleMs));
  const snapshot = await fetchSnapshotFromTarget(target.id, {
    convLimit: 100,
    bypassCache: act === 'send' || act === 'switch-conversation' || act === 'new-conversation'
  }).catch(() => null);
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
    <h1>需要配对口令</h1>
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
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
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
      background:var(--bg);color:var(--fg);touch-action:manipulation;
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
    .sub-meta{font-size:12px;color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;cursor:pointer;display:inline-flex;align-items:center;gap:3px}
    .sub-meta:active{color:#38bdf8}
    .quota-pill{
      appearance:none;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.05);color:#e4e4e7;
      border-radius:11px;padding:5px 10px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
      flex-shrink:0;cursor:pointer;display:flex;flex-direction:column;align-items:flex-end;line-height:1.2;gap:1px;
    }
    .quota-pill span:last-child{font-size:11.5px;color:#a1a1aa;font-weight:500}
    .quota-drawer{
      position:fixed;top:calc(env(safe-area-inset-top) + 52px);right:10px;left:10px;max-width:360px;margin-left:auto;
      z-index:60;background:#18181b;border:1px solid rgba(255,255,255,.16);border-radius:14px;
      padding:12px;box-shadow:0 16px 40px rgba(0,0,0,.6);
    }
    .quota-drawer[hidden]{display:none}
    .qcard{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--border);margin-bottom:8px}
    .qhead{display:flex;justify-content:space-between;font-weight:600;font-size:13.5px;margin-bottom:6px}
    .qsub{margin-top:5px}
    .qsub-row{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px}
    .qbar{height:5px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden}
    .qfill{height:100%;border-radius:99px}
    .qreset{font-size:11.5px;color:var(--muted);margin-top:2px}
    .messages{
      position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
      padding:14px 16px 12px;display:flex;flex-direction:column;gap:16px;
    }
    .msg{word-break:break-word}
    .msg.user{
      align-self:flex-end;max-width:84%;padding:10px 14px;border-radius:18px 18px 4px 18px;
      background:#1d4ed8;color:#f8fafc;
      font-size:14.5px;line-height:1.48;white-space:pre-wrap;
      box-shadow:none;
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
      background:rgba(239,68,68,.16);border:1px solid rgba(239,68,68,.45);color:#fca5a5;font-size:12.5px;font-weight:600;
    }
    .thought-box{margin-bottom:8px;padding:6px 9px;border-radius:9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12.5px;color:#d4d4d8}
    .thought-box summary{cursor:pointer;font-weight:600;color:#93c5fd;list-style:none}
    .thought-body{margin-top:6px;white-space:pre-wrap;color:#a1a1aa;max-height:220px;overflow-y:auto}
    .empty-tip{margin:auto;text-align:center;color:var(--muted);padding:24px 12px;font-size:13px}
    .mode-entry-card{
      margin:auto;width:100%;max-width:400px;padding:16px 14px;border-radius:16px;
      background:#18181b;border:1px solid rgba(255,255,255,.12);
      display:flex;flex-direction:column;gap:10px;
    }
    .mode-entry-title{font-size:13px;font-weight:600;color:#e4e4e7;line-height:1.45}
    .mode-entry-list{display:flex;flex-direction:column;gap:8px}
    .mode-entry-btn{
      appearance:none;width:100%;padding:10px 12px;border-radius:11px;
      border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.04);color:#f4f4f5;
      display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;cursor:pointer;
      transition:border-color .15s ease,background-color .15s ease;
    }
    .mode-entry-btn:active{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.6)}
    .mode-entry-btn.active{border-color:rgba(56,189,248,.55);background:rgba(56,189,248,.1)}
    .mode-entry-left{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
    .mode-entry-name{font-size:13.5px;font-weight:600;color:#fafafa}
    .mode-entry-host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mode-entry-tag{font-size:11.5px;font-weight:600;color:#38bdf8;flex-shrink:0;white-space:nowrap}
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
    .approval-ctx{font-size:12.5px;color:#e4e4e7;max-height:54px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
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
      border-radius:999px;padding:5px 11px;font-size:12.5px;white-space:nowrap;cursor:pointer;
    }
    .chip.suggest{border-color:rgba(56,189,248,.32);background:rgba(56,189,248,.09);color:#7dd3fc;font-weight:500}
    .attach-hint{
      display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 12px;border-radius:12px;
      background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.28);font-size:12.5px;color:#bae6fd;
    }
    .attach-hint[hidden]{display:none}
    .composer-card{
      background:#16161a;border:1px solid rgba(255,255,255,.11);border-radius:22px;
      padding:10px 10px 8px 12px;display:flex;flex-direction:column;gap:6px;
      box-shadow:0 8px 28px rgba(0,0,0,.45);transition:border-color .15s ease;
    }
    .composer-card:focus-within{border-color:rgba(56,189,248,.45)}
    .composer-card textarea{
      width:100%;min-height:28px;max-height:148px;resize:none;border:none;background:transparent;
      color:var(--fg);padding:2px 4px;font-size:16px;line-height:1.42;font-family:inherit;outline:none;
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
      padding:calc(env(safe-area-inset-top) + 12px) 12px calc(16px + env(safe-area-inset-bottom));
      display:flex;flex-direction:column;gap:10px;overflow-y:auto;
      transform:translateX(-100%);transition:transform .24s cubic-bezier(.22,1,.36,1);
      will-change:transform;
    }
    .drawer-backdrop.open .drawer{transform:translateX(0)}
    .drawer-backdrop.dragging .drawer{transition:none}
    .new-chat-group{display:flex;align-items:stretch;gap:6px;flex-shrink:0}
    .new-chat-btn{
      appearance:none;flex:1 1 auto;min-width:0;min-height:44px;padding:10px 12px;border-radius:12px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#fafafa;
      font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;
    }
    .new-chat-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .new-chat-pick-btn{
      appearance:none;width:42px;min-height:44px;flex-shrink:0;border-radius:12px;
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#d4d4d8;
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .new-chat-btn:active,.new-chat-pick-btn:active{background:rgba(56,189,248,.18);border-color:rgba(56,189,248,.5);color:#fff}
    .conv-toolbar{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .conv-view-tabs{
      flex:1 1 auto;min-width:0;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;border-radius:10px;
      background:rgba(255,255,255,.04);border:1px solid var(--border);
    }
    .conv-tab{
      appearance:none;border:none;background:transparent;color:#a1a1aa;border-radius:7px;
      padding:6px 8px;font-size:12px;font-weight:600;cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;gap:4px;
    }
    .conv-tab.active{background:rgba(56,189,248,.18);color:#e0f2fe}
    .tab-count{font-size:11px;opacity:.78;font-variant-numeric:tabular-nums}
    .new-proj-mini-btn{
      appearance:none;height:34px;padding:0 10px;border-radius:10px;flex-shrink:0;
      border:1px solid rgba(56,189,248,.34);background:rgba(56,189,248,.12);color:#bae6fd;
      font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;white-space:nowrap;
    }
    .new-proj-mini-btn:active{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.6);color:#fff}
    .proj-group{display:flex;flex-direction:column;gap:5px;margin-top:6px}
    .proj-group:first-child{margin-top:0}
    .proj-head{
      display:flex;align-items:center;gap:4px;padding:3px 5px 3px 3px;border-radius:11px;
      background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);
      transition:background-color .14s ease,border-color .14s ease;
    }
    .proj-group.is-current .proj-head{
      background:rgba(56,189,248,.11);border-color:rgba(56,189,248,.34);
    }
    .proj-toggle{
      appearance:none;flex:1 1 auto;min-width:0;border:none;background:transparent;color:#fafafa;
      padding:6px 7px;border-radius:8px;font-size:14.5px;font-weight:700;letter-spacing:-.01em;
      display:flex;align-items:center;gap:6px;cursor:pointer;text-align:left;
    }
    .proj-icon{display:inline-flex;align-items:center;justify-content:center;color:#38bdf8;flex-shrink:0}
    .proj-group.is-ungrouped .proj-icon{color:#a1a1aa}
    .proj-chev{font-size:11px;color:#a1a1aa;width:12px;flex-shrink:0;text-align:center;font-weight:700}
    .proj-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-stat-dot{width:6px;height:6px;border-radius:99px;flex-shrink:0}
    .proj-stat-dot.running{background:var(--green);animation:pulse 1.1s infinite ease-in-out}
    .proj-stat-dot.waiting{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .proj-count{
      margin-left:auto;padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.09);
      font-size:11px;color:#d4d4d8;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;
    }
    .proj-new-btn{
      appearance:none;width:28px;height:28px;flex-shrink:0;border-radius:8px;
      border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#d4d4d8;
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;line-height:1;
    }
    .proj-new-btn:active{background:rgba(56,189,248,.18);border-color:rgba(56,189,248,.45);color:#fff}
    .proj-body{
      display:flex;flex-direction:column;gap:4px;margin-left:11px;padding-left:9px;
      border-left:1.5px solid rgba(255,255,255,.1);
    }
    .proj-empty-sec{margin-top:8px;border-top:1px dashed var(--border);padding-top:8px;display:flex;flex-direction:column;gap:5px}
    .proj-empty-toggle{
      appearance:none;border:none;background:transparent;color:#a1a1aa;font-size:13px;font-weight:700;
      padding:5px 7px;border-radius:8px;display:flex;align-items:center;gap:6px;cursor:pointer;text-align:left;
    }
    .proj-empty-row{
      display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 6px 6px 10px;
      border-radius:9px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06);
      color:#e4e4e7;font-size:13.5px;font-weight:600;
    }
    .proj-empty-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
    /* 新建项目与电脑目录浏览器弹窗 */
    .sheet.proj-modal{max-width:540px;max-height:84dvh;gap:10px}
    .proj-roots-bar{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-shrink:0;padding-bottom:2px}
    .proj-roots-bar::-webkit-scrollbar{display:none}
    .proj-root-pill{
      appearance:none;flex-shrink:0;padding:5px 10px;border-radius:999px;border:1px solid var(--border);
      background:rgba(255,255,255,.05);color:#e4e4e7;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
    }
    .proj-root-pill.active{border-color:rgba(56,189,248,.6);background:rgba(56,189,248,.16);color:#e0f2fe}
    .proj-path-row{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .proj-path-input,.proj-field-input{
      flex:1 1 auto;min-width:0;height:36px;padding:0 10px;border-radius:10px;border:1px solid var(--border);
      background:rgba(9,9,11,.75);color:var(--fg);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;
    }
    .proj-field-input{font-family:inherit;font-size:14px}
    .proj-path-input:focus,.proj-field-input:focus{border-color:rgba(56,189,248,.6)}
    .proj-act-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0}
    .proj-act-btn{
      appearance:none;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--border);
      background:rgba(255,255,255,.05);color:#d4d4d8;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px;
    }
    .proj-act-btn.active{border-color:rgba(56,189,248,.55);background:rgba(56,189,248,.14);color:#bae6fd}
    .proj-act-btn:disabled{opacity:.42;cursor:default}
    .proj-mkdir-row{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .proj-mkdir-row[hidden]{display:none}
    .proj-dir-list{
      display:flex;flex-direction:column;gap:5px;min-height:120px;max-height:34dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;
      padding:2px 0;
    }
    .proj-dir-item{
      width:100%;text-align:left;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.035);color:var(--fg);font-size:13.5px;font-weight:500;cursor:pointer;
      display:flex;align-items:center;gap:8px;
    }
    .proj-dir-item:active{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.45)}
    .proj-dir-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-dir-badges{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}
    .proj-tag{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:999px;line-height:1.4}
    .proj-tag.git{background:rgba(52,211,153,.15);color:#6ee7b7}
    .proj-tag.linked{background:rgba(56,189,248,.16);color:#7dd3fc}
    .proj-summary-card{
      padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--border);
      font-size:12px;color:#d4d4d8;display:flex;flex-direction:column;gap:3px;flex-shrink:0;
    }
    .proj-summary-card.is-warn{border-color:rgba(245,158,11,.55);background:rgba(245,158,11,.12);color:#fde68a}
    .proj-summary-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;word-break:break-all;font-size:11.5px}
    .proj-name-row{display:flex;flex-direction:column;gap:5px;flex-shrink:0}
    .proj-name-label{font-size:12px;font-weight:600;color:#a1a1aa}
    .proj-primary-btn{
      appearance:none;width:100%;height:42px;border-radius:11px;border:none;background:#38bdf8;color:#082f49;
      font-size:14.5px;font-weight:700;cursor:pointer;flex-shrink:0;
    }
    .proj-primary-btn:disabled{opacity:.5;cursor:default}
    .conv-item{
      width:100%;text-align:left;padding:9px 11px;border-radius:10px;border:1px solid transparent;
      background:rgba(255,255,255,.04);color:var(--fg);font-size:13.5px;cursor:pointer;
      display:flex;flex-direction:column;gap:3px;
    }
    .conv-item.active{border-color:rgba(56,189,248,.6);background:rgba(56,189,248,.14);font-weight:600}
    .conv-item.is-unread .c-title{font-weight:600;color:#fff}
    .c-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%}
    .c-dot{width:7px;height:7px;border-radius:99px;flex-shrink:0;background:rgba(255,255,255,.16)}
    .c-dot.running{background:var(--green);animation:pulse 1.1s infinite ease-in-out}
    .c-dot.waiting{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .c-dot.error{background:var(--red)}
    .c-dot.unknown{background:transparent;border:1.5px solid #71717a}
    .c-dot.unread{background:var(--accent)}
    .c-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
    .c-badge{
      flex-shrink:0;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:999px;line-height:1.4;
    }
    .c-badge.running{background:rgba(34,197,94,.16);color:#86efac}
    .c-badge.waiting{background:rgba(245,158,11,.18);color:#fde68a}
    .c-badge.error{background:rgba(239,68,68,.18);color:#fca5a5}
    .c-badge.unknown{background:rgba(113,113,122,.18);color:#a1a1aa}
    .c-time{flex-shrink:0;font-size:11px;color:#71717a;font-variant-numeric:tabular-nums}
    .c-sub{font-size:11px;color:#a1a1aa;padding-left:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .conv-more-btn{
      appearance:none;width:100%;padding:8px 10px;border-radius:9px;border:1px dashed var(--border);
      background:rgba(255,255,255,.03);color:#a1a1aa;font-size:12px;cursor:pointer;margin-top:2px;
    }
    .composer-card.drag-over{border-color:#38bdf8;background:rgba(56,189,248,.07)}
    .load-earlier-btn{
      appearance:none;align-self:center;padding:6px 14px;border-radius:999px;
      border:1px solid var(--border);background:rgba(255,255,255,.05);color:#cbd5e1;
      font-size:12px;font-weight:500;cursor:pointer;flex-shrink:0;
    }
    .load-earlier-btn:disabled{opacity:.6;cursor:default}
    .perm-ico{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
    .perm-ico.turbo{color:#fbbf24}
    .perm-ico.auto{color:#38bdf8}
    .perm-ico.default{color:#a1a1aa}
    .perm-ico.request_review{color:#c084fc}
    .perm-ico.unknown{color:#71717a}
    .drawer-brand{display:none}
    .conv-list{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;overflow-y:auto}
    .toast{
      position:fixed;top:calc(env(safe-area-inset-top) + 56px);left:50%;transform:translateX(-50%);
      z-index:80;background:#27272a;color:#fff;padding:7px 14px;border-radius:999px;font-size:12.5px;
      border:1px solid rgba(255,255,255,.15);box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;
    }
    .toast[hidden]{display:none}
    /* 细滚动条 */
    .messages,.conv-list,.drawer,.sheet-list,.thought-body,.md-body pre,.md-table-wrap{
      scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;
    }
    .messages{scrollbar-gutter:stable}
    .messages::-webkit-scrollbar,.conv-list::-webkit-scrollbar,.drawer::-webkit-scrollbar,.sheet-list::-webkit-scrollbar,.thought-body::-webkit-scrollbar,.md-body pre::-webkit-scrollbar,.md-table-wrap::-webkit-scrollbar{
      width:6px;height:6px;
    }
    .messages::-webkit-scrollbar-thumb,.conv-list::-webkit-scrollbar-thumb,.drawer::-webkit-scrollbar-thumb,.sheet-list::-webkit-scrollbar-thumb,.thought-body::-webkit-scrollbar-thumb,.md-body pre::-webkit-scrollbar-thumb,.md-table-wrap::-webkit-scrollbar-thumb{
      background:rgba(255,255,255,.14);border-radius:99px;
    }
    .messages::-webkit-scrollbar-thumb:hover,.conv-list::-webkit-scrollbar-thumb:hover,.drawer::-webkit-scrollbar-thumb:hover,.sheet-list::-webkit-scrollbar-thumb:hover,.md-table-wrap::-webkit-scrollbar-thumb:hover{
      background:rgba(255,255,255,.26);
    }
    .messages::-webkit-scrollbar-track,.conv-list::-webkit-scrollbar-track,.drawer::-webkit-scrollbar-track,.sheet-list::-webkit-scrollbar-track,.md-table-wrap::-webkit-scrollbar-track{
      background:transparent;
    }
    /* 鼠标设备悬停交互 */
    @media (hover:hover){
      .icon-btn:hover{background:rgba(255,255,255,.08);color:#f4f4f5}
      .quota-pill:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.18)}
      .chip:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.18);color:#e4e4e7}
      .chip.suggest:hover{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.5);color:#bae6fd}
      .ghost-btn:hover{background:rgba(255,255,255,.08);color:#e4e4e7}
      .send-circle.ready:hover{background:#7dd3fc}
      .send-circle.stop:hover{background:rgba(239,68,68,.3)}
      .new-chat-btn:hover,.new-chat-pick-btn:hover{background:rgba(255,255,255,.11);border-color:rgba(56,189,248,.4);color:#fff}
      .conv-tab:hover{color:#e4e4e7}
      .new-proj-mini-btn:hover{background:rgba(56,189,248,.22);border-color:rgba(56,189,248,.55);color:#fff}
      .proj-head:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.15)}
      .proj-toggle:hover,.proj-empty-toggle:hover{color:#fff}
      .proj-new-btn:hover{background:rgba(56,189,248,.16);border-color:rgba(56,189,248,.45);color:#fff}
      .proj-root-pill:hover,.proj-act-btn:hover,.proj-dir-item:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18)}
      .proj-primary-btn:hover{background:#7dd3fc}
      .conv-more-btn:hover{background:rgba(255,255,255,.07);color:#e4e4e7}
      .conv-item:hover{background:rgba(255,255,255,.08)}
      .conv-item.active:hover{background:rgba(56,189,248,.18)}
      .sheet-opt:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18)}
      .sheet-opt.active:hover{background:rgba(56,189,248,.22)}
    }
    /* 电脑端宽屏控制台适配（>= 860px 且具备精细鼠标指针与足够高度，避免横屏手机/平板误入双栏） */
    @media (min-width:860px) and (min-height:521px) and (hover:hover) and (pointer:fine){
      body{display:flex;flex-direction:row}
      .app{
        flex:1 1 auto;min-width:0;width:auto;height:100%;position:relative;
        padding-top:0;padding-bottom:0;
      }
      .topbar{height:54px;padding:0 24px;gap:12px}
      .conv-title{font-size:15.5px}
      .sub-meta{font-size:12px}
      .quota-pill{flex-direction:row;align-items:center;gap:8px;padding:6px 12px;font-size:12px;border-radius:10px}
      .quota-pill span:last-child{font-size:11.5px;color:#a1a1aa;padding-left:8px;border-left:1px solid rgba(255,255,255,.12)}
      .drawer-backdrop{
        order:-1;position:relative;top:auto;left:auto;right:auto;bottom:auto;
        width:268px;height:100%;flex-shrink:0;z-index:10;
        opacity:1;visibility:visible;pointer-events:auto;background:transparent;
        overflow:hidden;transition:width .2s cubic-bezier(.22,1,.36,1);
      }
      body.sidebar-collapsed .drawer-backdrop{width:0;pointer-events:none}
      .drawer{
        width:268px;height:100%;min-height:0;overflow:hidden;
        background:#111114;border-right:1px solid rgba(255,255,255,.08);
        padding:14px 12px 14px;transform:none!important;transition:none;gap:10px;
      }
      .drawer-brand{
        display:flex;align-items:center;gap:8px;padding:2px 4px 6px;
        font-size:13.5px;font-weight:700;color:#fafafa;letter-spacing:-.01em;flex-shrink:0;
      }
      .drawer-brand-dot{
        width:8px;height:8px;border-radius:99px;
        background:#38bdf8;box-shadow:none;
      }
      .new-chat-btn,.new-chat-pick-btn{min-height:38px;border-radius:10px}
      .new-chat-btn{padding:8px 10px;font-size:13px}
      .conv-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:2px}
      .proj-toggle{font-size:13.5px;padding:5px 7px}
      .conv-item{
        padding:7px 10px;font-size:12.5px;border-radius:9px;
        transition:background-color .14s ease,border-color .14s ease;
      }
      .messages{
        padding:24px max(24px,calc(50% - 410px)) 18px;gap:18px;
      }
      .msg.user{max-width:72%;font-size:14.5px;padding:11px 16px}
      .md-body{font-size:14.5px}
      .md-body code{font-size:13px}
      .md-body pre code{font-size:12.5px}
      .approval-dock{padding:10px max(24px,calc(50% - 410px))}
      .composer-dock{
        padding:6px max(24px,calc(50% - 410px)) 18px;gap:8px;
      }
      .composer-card{
        border-radius:18px;padding:12px 14px 10px 16px;
        box-shadow:0 12px 36px rgba(0,0,0,.4);
      }
      .composer-card textarea{min-height:32px;max-height:200px;font-size:14.5px}
      .quota-drawer{
        position:absolute;top:60px;right:24px;left:auto;width:348px;max-width:none;margin-left:0;
      }
      .sheet-backdrop{
        align-items:center;padding:24px;background:rgba(0,0,0,.55);
        backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
      }
      .sheet{
        max-width:440px;max-height:min(560px,80vh);border-radius:16px;
        border:1px solid rgba(255,255,255,.14);padding:16px;
        box-shadow:0 24px 64px rgba(0,0,0,.65);
      }
      .sheet.proj-modal{max-width:520px;max-height:min(680px,86vh)}
      .sheet-opt{padding:10px 12px;font-size:13.5px}
      .toast{top:18px}
    }
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
        <div id="sub-meta" class="sub-meta">正在检测连接通道…</div>
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
        <textarea id="input" rows="1" enterkeyhint="enter" placeholder="发消息给 Antigravity…（回车换行，点右侧按钮发送）"></textarea>
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
              <span id="perm-inline-icon" class="perm-ico unknown" data-perm-mode="unknown"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
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

  <div id="proj-modal-backdrop" class="sheet-backdrop" hidden>
    <div class="sheet proj-modal" role="dialog" aria-label="新建项目">
      <div class="sheet-title">
        <span>新建项目 · 选择电脑目录</span>
        <button id="proj-modal-close" class="icon-btn" style="height:28px;font-size:12px" type="button">关闭</button>
      </div>
      <div id="proj-roots" class="proj-roots-bar"></div>
      <div class="proj-path-row">
        <input id="proj-path-input" class="proj-path-input" type="text" placeholder="输入电脑路径，例如 ~/codebase/my-app">
        <button id="proj-path-go" class="proj-act-btn" type="button">前往</button>
      </div>
      <div class="proj-act-row">
        <button id="proj-up-btn" class="proj-act-btn" type="button">↑ 上级目录</button>
        <button id="proj-hidden-btn" class="proj-act-btn" type="button">显示隐藏目录</button>
        <button id="proj-mkdir-toggle" class="proj-act-btn" type="button">＋ 新建文件夹</button>
      </div>
      <div id="proj-mkdir-row" class="proj-mkdir-row" hidden>
        <input id="proj-mkdir-input" class="proj-field-input" type="text" placeholder="输入新文件夹名称…">
        <button id="proj-mkdir-confirm" class="proj-act-btn active" type="button">创建</button>
      </div>
      <div id="proj-dir-list" class="proj-dir-list"></div>
      <div id="proj-selected-summary" class="proj-summary-card"></div>
      <div class="proj-name-row">
        <label class="proj-name-label" for="proj-name-input">项目名称</label>
        <input id="proj-name-input" class="proj-field-input" type="text" placeholder="输入项目名称…">
      </div>
      <button id="proj-create-submit" class="proj-primary-btn" type="button">创建项目并进入对话</button>
    </div>
  </div>

  <div id="drawer-backdrop" class="drawer-backdrop" aria-hidden="true">
    <div id="drawer-panel" class="drawer">
      <div class="drawer-brand">
        <span class="drawer-brand-dot"></span>
        <span>Antigravity Remote</span>
      </div>
      <div class="new-chat-group">
        <button id="btn-new-chat" class="new-chat-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span id="new-chat-label" class="new-chat-label">新建对话</span>
        </button>
        <button id="btn-new-chat-project" class="new-chat-pick-btn" type="button" title="选择项目新建对话" aria-label="选择项目新建对话">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="conv-toolbar">
        <div id="conv-view-tabs" class="conv-view-tabs" role="tablist" aria-label="会话视图切换">
          <button class="conv-tab active" data-conv-view="projects" type="button" role="tab" aria-selected="true">按项目 <span id="tab-proj-count" class="tab-count"></span></button>
          <button class="conv-tab" data-conv-view="recent" type="button" role="tab" aria-selected="false">最近活跃 <span id="tab-conv-count" class="tab-count"></span></button>
        </div>
        <button id="btn-new-project" class="new-proj-mini-btn" type="button" title="浏览电脑目录创建新项目" aria-label="新建项目">＋ 新建项目</button>
      </div>
      <div id="conv-list" class="conv-list"></div>
    </div>
  </div>

  <div id="toast" class="toast" hidden></div>

  <script>
  (function(){
    const PAIR_STORAGE_KEY = 'ag_remote_pair_v1';
    const DEVICE_ID_STORAGE_KEY = 'ag_remote_device_id_v1';
    const deviceId = (() => {
      try {
        let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY) || '';
        if (!id) {
          id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
          localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
        }
        return id;
      } catch {
        return '';
      }
    })();
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
    function encodeEndpointsClient(list) {
      try {
        const json = JSON.stringify(Array.isArray(list) ? list : []);
        let bin = '';
        if (typeof TextEncoder === 'function') {
          const bytes = new TextEncoder().encode(json);
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        } else {
          bin = unescape(encodeURIComponent(json));
        }
        return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      } catch {
        return '';
      }
    }
    function detectKindFromOrigin(rawUrl) {
      const origin = String(rawUrl || '').toLowerCase();
      if (origin.includes('.trycloudflare.com') || origin.startsWith('https://')) return 'tunnel';
      if (origin.includes('.ts.net') || origin.startsWith('http://100.') || origin.startsWith('https://100.')) return 'tailscale';
      if (origin.includes('.local:') || origin.endsWith('.local')) return 'bonjour';
      return 'lan';
    }
    function formatKindLabel(kind) {
      if (kind === 'tunnel') return 'Cloudflare 隧道';
      if (kind === 'tailscale') return 'Tailscale';
      if (kind === 'bonjour') return 'Bonjour';
      return '局域网';
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
    const isManualEntry = urlParams.get('manual') === '1';
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
    if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    let apiBase = '';
    const isIpadDesktopUa = (() => {
      try {
        return Number(navigator.maxTouchPoints || 0) > 1 && /Mac/i.test(String(navigator.platform || ''));
      } catch {
        return false;
      }
    })();
    function authHeaders(extra) {
      const h = Object.assign({}, extra || {});
      if (pairState.token) h['X-AG-Remote-Token'] = pairState.token;
      if (deviceId) h['X-AG-Device-Id'] = deviceId;
      if (isIpadDesktopUa) h['X-AG-Device-Hint'] = 'iPad';
      return h;
    }
    function getCandidateEndpoints() {
      const seen = new Set();
      const list = [];
      const isHttpsPage = location.protocol === 'https:';
      const add = (url, kind, priority) => {
        const clean = String(url || '').replace(/\\/+$/, '');
        if (!clean || seen.has(clean)) return;
        if (isHttpsPage && clean.toLowerCase().startsWith('http://')) return;
        seen.add(clean);
        list.push({ url: clean, kind: kind || 'lan', priority: Number.isFinite(priority) ? priority : 100 });
      };
      for (const ep of (pairState.endpoints || [])) add(ep.url, ep.kind, ep.priority);
      const portStr = location.port ? ':' + location.port : '';
      for (const h of (pairState.hosts || [])) {
        const hostFmt = (h.includes(':') && !h.startsWith('[')) ? ('[' + h + ']') : h;
        const kind = h.endsWith('.local') ? 'bonjour' : (h.includes('.ts.net') || h.startsWith('100.') ? 'tailscale' : 'lan');
        if (!isHttpsPage) {
          add('http://' + hostFmt + (portStr || ':18765'), kind, 300);
        }
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
          const kindName = winner.ep.kind === 'tunnel' ? 'Cloudflare' : (winner.ep.kind === 'tailscale' ? 'Tailscale' : (winner.ep.kind === 'bonjour' ? 'Bonjour' : '局域网'));
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
    let programmaticScrollTop = null;

    const $ = (id) => document.getElementById(id);
    const msgEl = $('messages');
    let activeSnapAbort = null;

    function fetchWithTimeout(url, init, timeoutMs, externalCtrl) {
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
      const ctrl = externalCtrl || (typeof AbortController === 'function' ? new AbortController() : null);
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, ms) : null;
      const opts = Object.assign({}, init || {}, ctrl ? { signal: ctrl.signal } : {});
      return fetch(url, opts).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    function getActiveChannelLabel() {
      return formatKindLabel(detectKindFromOrigin(apiBase || location.origin || ''));
    }

    function getEnabledModeEntries() {
      const order = { tunnel: 0, lan: 1, tailscale: 2, bonjour: 3, loopback: 9 };
      const byKind = new Map();
      const sorted = [...(pairState.endpoints || [])].sort((a, b) => (Number(a?.priority) || 999) - (Number(b?.priority) || 999));
      for (const ep of sorted) {
        if (!ep || !ep.url) continue;
        const k = ep.kind || detectKindFromOrigin(ep.url);
        if (k === 'loopback' && sorted.length > 1) continue;
        if (!byKind.has(k)) {
          byKind.set(k, { url: String(ep.url).replace(/\\/+$/, ''), kind: k });
        }
      }
      if (byKind.size === 0) {
        const curKind = detectKindFromOrigin(location.origin);
        byKind.set(curKind, { url: String(location.origin || '').replace(/\\/+$/, ''), kind: curKind });
      }
      return Array.from(byKind.values()).sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5));
    }

    function buildClientEntryUrl(targetBaseUrl) {
      const cleanBase = String(targetBaseUrl || '').replace(/\\/+$/, '');
      const params = [];
      if (pairState.token) params.push('token=' + encodeURIComponent(pairState.token));
      if (pairState.name) params.push('name=' + encodeURIComponent(pairState.name));
      if (pairState.hosts?.length) params.push('hosts=' + encodeURIComponent(pairState.hosts.join(',')));
      const encEps = encodeEndpointsClient(pairState.endpoints || []);
      if (encEps) params.push('endpoints=' + encodeURIComponent(encEps));
      params.push('manual=1');
      return cleanBase + '/?' + params.join('&');
    }

    function enterConnectionMode(ep) {
      if (!ep || !ep.url) return;
      if (activeSnapAbort) {
        try { activeSnapAbort.abort(); } catch {}
        activeSnapAbort = null;
      }
      clearTimeout(pollTimer);
      saveStoredPair(pairState);
      const cleanTarget = String(ep.url).replace(/\\/+$/, '');
      const cleanCur = String(location.origin || '').replace(/\\/+$/, '');
      if (cleanTarget === cleanCur) {
        apiBase = '';
        const modeName = formatKindLabel(ep.kind);
        $('sub-meta').textContent = '正在通过 ' + modeName + ' 连接…';
        renderModeEntryGate('正在通过 ' + modeName + ' 连接 Mac…');
        void fetchSnapshot();
        return;
      }
      location.href = buildClientEntryUrl(cleanTarget);
    }

    function renderModeEntryGate(statusText) {
      if (latestSnap) return;
      const entries = getEnabledModeEntries();
      const curOrigin = String(apiBase || location.origin || '').replace(/\\/+$/, '');
      const btnsHtml = entries.map((ep, idx) => {
        let hostText = ep.url;
        try { hostText = new URL(ep.url).host; } catch {}
        const isCurrent = ep.url === curOrigin;
        return '<button class="mode-entry-btn' + (isCurrent ? ' active' : '') + '" data-mode-idx="' + idx + '" type="button">'
          + '<span class="mode-entry-left">'
          + '<span class="mode-entry-name">' + esc(formatKindLabel(ep.kind)) + '</span>'
          + '<span class="mode-entry-host">' + esc(hostText) + '</span>'
          + '</span>'
          + '<span class="mode-entry-tag">' + (isCurrent ? '当前入口 →' : '直接进入 →') + '</span>'
          + '</button>';
      }).join('');
      msgEl.innerHTML = '<div id="mode-entry-panel" class="mode-entry-card">'
        + '<div id="mode-entry-status" class="mode-entry-title">' + esc(statusText || '请选择或等待连接方式进入：') + '</div>'
        + '<div class="mode-entry-list">' + btnsHtml + '</div>'
        + '</div>';
      msgEl.querySelectorAll('.mode-entry-btn').forEach((btn) => {
        btn.onclick = () => {
          const ep = entries[Number(btn.dataset.modeIdx)];
          if (ep) enterConnectionMode(ep);
        };
      });
    }

    function openModeSwitcherSheet() {
      const entries = getEnabledModeEntries();
      if (!entries.length) return;
      const curOrigin = String(apiBase || location.origin || '').replace(/\\/+$/, '');
      const opts = entries.map((ep) => {
        let hostText = ep.url;
        try { hostText = new URL(ep.url).host; } catch {}
        return {
          label: formatKindLabel(ep.kind) + ' · ' + hostText,
          active: ep.url === curOrigin,
          ep
        };
      });
      openSheet('切换连接方式（已开启）', opts, async (opt) => {
        if (opt?.ep) enterConnectionMode(opt.ep);
      });
    }

    $('sub-meta').textContent = '正在连接 · ' + getActiveChannelLabel();
    $('sub-meta').onclick = openModeSwitcherSheet;

    const appEl = document.querySelector('.app');
    let maxVvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

    function getFullLayoutHeight() {
      const vvH = window.visualViewport ? window.visualViewport.height : 0;
      return Math.round(vvH || window.innerHeight || document.documentElement?.clientHeight || 0);
    }

    const desktopMq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width:860px) and (min-height:521px) and (hover:hover) and (pointer:fine)')
      : null;
    const isDesktopLayout = () => {
      if (desktopMq) return desktopMq.matches;
      const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer:fine)').matches;
      return window.innerWidth >= 860 && window.innerHeight > 520 && (fine || Number(navigator.maxTouchPoints || 0) <= 1);
    };

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
    window.addEventListener('orientationchange', () => {
      maxVvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      setTimeout(() => {
        maxVvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        syncViewportHeight();
        if (typeof syncSidebarA11y === 'function') syncSidebarA11y();
      }, 150);
    });
    syncViewportHeight();

    msgEl.addEventListener('scroll', () => {
      if (programmaticScrollTop !== null && Math.abs(msgEl.scrollTop - programmaticScrollTop) <= 2) {
        programmaticScrollTop = null;
        return;
      }
      programmaticScrollTop = null;
      stickBottom = (msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight) < 80;
      if (msgEl.scrollTop <= 50 && !stickBottom && msgEl.scrollHeight > msgEl.clientHeight + 40) {
        void loadEarlierMessages();
      }
    });
    msgEl.addEventListener('click', (e) => {
      if (e.target?.closest?.('#btn-load-earlier')) {
        void loadEarlierMessages();
      }
    });

    function showToast(txt) {
      const el = $('toast');
      el.textContent = txt;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
    }

    function esc(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
      const doPost = () => fetchWithTimeout((apiBase || '') + '/api/action', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ targetId: currentTargetId || undefined, ...payload })
      }, 8000);
      let res;
      try {
        res = await doPost();
        if (res.status === 403) throw new Error('channel_disabled');
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
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      let data = null;
      if (ctype.includes('application/json')) {
        data = await res.json().catch(() => null);
      }
      if (!data) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text().catch(() => '');
        throw new Error(text ? text.slice(0, 80) : '响应格式异常');
      }
      if (!res.ok && data.ok !== false) {
        data = Object.assign({ ok: false, error: 'HTTP ' + res.status }, data);
      }
      if (data?.snapshot) renderSnapshot(data.snapshot);
      return data;
    }

    function renderQuotaDrawer(snap) {
      const box = $('quota-drawer');
      if (box.hidden) return;
      const renderPool = (title, pool) => {
        const rows = [];
        if (pool?.fiveHour) {
          rows.push(['5 小时限额', pool.fiveHour]);
        }
        if (pool?.weekly) {
          rows.push(['每周限额', pool.weekly]);
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
        try {
          const r = await apiAction({ action: 'refresh-quota' });
          if (r?.ok) showToast('已刷新配额');
          else showToast(r?.error || r?.actionResult?.error || '刷新配额失败');
        } catch (e) {
          showToast(e?.message || '刷新配额失败');
        }
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
      if (Array.isArray(snap.endpoints) && snap.endpoints.length) {
        pairState.endpoints = snap.endpoints;
        if (Array.isArray(snap.hosts) && snap.hosts.length) pairState.hosts = snap.hosts;
        saveStoredPair(pairState);
      }

      $('status-dot').className = snap.busy ? 'dot busy' : 'dot';
      $('conv-title').textContent = snap.title || 'Antigravity';
      const chSuffix = getEnabledModeEntries().length > 1 ? ' ▾' : '';
      $('sub-meta').textContent = getActiveChannelLabel() + chSuffix + ' · ' + (snap.pulseText || (snap.busy ? '正在生成内容…' : (snap.contextBadge || '已连接')));

      const gStr = fmtPct(snap.quota?.gemini?.remainingFraction);
      const cStr = fmtPct(snap.quota?.claude?.remainingFraction);
      $('quota-main').textContent = 'G4 ' + gStr + ' · C ' + cStr;
      $('ctx-badge').textContent = snap.contextBadge || '--%';
      $('model-inline-label').textContent = snap.model || '切换模型';
      syncPermInlineUi(snap.permissionKey, snap.permissionLabel);
      const newChatLabelEl = $('new-chat-label');
      if (newChatLabelEl) {
        newChatLabelEl.textContent = snap.currentProjectName ? ('新建对话 · ' + snap.currentProjectName) : '新建对话';
      }

      renderQuotaDrawer(snap);
      syncSendButtonUI();

      // Messages (full history + upward pagination + gap backfill + scroll anchor)
      const snapSid = snap.isNewConversation ? '__new__' : String(snap.sessionId || '');
      if (snapSid !== activeMsgSessionId) {
        activeMsgSessionId = snapSid;
        sessionMsgsByIndex.clear();
        loadingEarlierMsgs = false;
        backfillingMsgGaps = false;
        stickBottom = true;
      }
      const rawMsgs = Array.isArray(snap.messages) ? snap.messages : [];
      const totalMsgs = Number(snap.totalMessages);
      if (Number.isFinite(totalMsgs) && totalMsgs >= 0) {
        for (const k of Array.from(sessionMsgsByIndex.keys())) {
          if (totalMsgs === 0 || k >= totalMsgs) sessionMsgsByIndex.delete(k);
        }
      } else if (!rawMsgs.length) {
        sessionMsgsByIndex.clear();
      }
      const baseIdx = Number.isFinite(Number(snap.messagesStartIndex)) ? Number(snap.messagesStartIndex) : 0;
      for (let idx = 0; idx < rawMsgs.length; idx++) {
        const m = rawMsgs[idx];
        if (!m) continue;
        const mIdx = Number.isFinite(Number(m.msgIndex)) ? Number(m.msgIndex) : (baseIdx + idx);
        sessionMsgsByIndex.set(mIdx, { ...m, msgIndex: mIdx });
      }
      renderMessagesView(snap);
      if (snapSid && snapSid !== '__new__' && findMissingMsgRanges(totalMsgs).length > 0) {
        void backfillMissingMsgGaps(snapSid);
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
            try {
              const res = await apiAction({ action: 'click-approval', index: Number(btn.dataset.idx), label: btn.dataset.label });
              if (res?.ok) showToast('已触发: ' + btn.dataset.label);
              else {
                btn.disabled = false;
                showToast(res?.error || res?.actionResult?.error || '操作失败');
              }
            } catch (e) {
              btn.disabled = false;
              showToast(e?.message || '操作失败');
            }
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

      const chipsSig = JSON.stringify(items.map((it) => [it.cls, it.text, it.raw || '']));
      if (chips.dataset.sig !== chipsSig) {
        chips.dataset.sig = chipsSig;
        chips.innerHTML = '';
        for (const it of items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = it.cls;
          b.textContent = it.text;
          b.onclick = async () => {
            try {
              if (it.isSuggest) {
                const taEl = $('input');
                if (!taEl.value.trim()) {
                  stickBottom = true;
                  const r = await apiAction({ action: 'send', text: it.raw });
                  if (r?.ok) showToast('已发送建议');
                  else showToast(r?.error || r?.actionResult?.error || '发送失败');
                } else {
                  taEl.value = it.raw;
                  if (typeof autoGrow === 'function') autoGrow();
                  taEl.focus();
                }
              } else if (it.act) {
                const r = await it.act();
                if (r && !r.ok) showToast(r.error || r.actionResult?.error || '操作失败');
              }
            } catch (e) {
              showToast(e?.message || '操作失败');
            }
          };
          chips.appendChild(b);
        }
      }

      // Drawer Conversations & Multi-Project Grouping
      reconcileExtraConversations(snap);
      renderConversationList(snap);
    }

    const CONV_VIEW_KEY = 'ag_remote_conv_view_v1';
    const COLLAPSED_PROJ_KEY = 'ag_remote_collapsed_projects_v1';
    let convViewMode = (() => {
      try {
        const v = localStorage.getItem(CONV_VIEW_KEY);
        return v === 'recent' ? 'recent' : 'projects';
      } catch {
        return 'projects';
      }
    })();
    let collapsedProjMap = (() => {
      try {
        const raw = localStorage.getItem(COLLAPSED_PROJ_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      } catch {
        return {};
      }
    })();
    let emptyProjExpanded = false;
    let recentDisplayLimit = 50;
    let nextGlobalOffset = 0;
    const projOffsetMap = new Map();
    const extraConvMap = new Map();
    let loadingMoreConvs = false;
    let lastSyncedCatalogRev = '';
    let syncingExtraConvs = false;
    let pendingCatalogRev = '';

    function saveConvUiPrefs() {
      try {
        localStorage.setItem(CONV_VIEW_KEY, convViewMode);
        localStorage.setItem(COLLAPSED_PROJ_KEY, JSON.stringify(collapsedProjMap));
      } catch {}
    }

    function syncConvTabsUi() {
      const tabsEl = $('conv-view-tabs');
      if (!tabsEl) return;
      tabsEl.querySelectorAll('.conv-tab').forEach((btn) => {
        const isActive = btn.getAttribute('data-conv-view') === convViewMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    function getMergedConversations(snap) {
      const merged = new Map();
      for (const [id, c] of extraConvMap.entries()) {
        if (id && c) merged.set(id, c);
      }
      for (const c of (Array.isArray(snap?.conversations) ? snap.conversations : [])) {
        if (c && c.id) merged.set(c.id, c);
      }
      return Array.from(merged.values()).sort((a, b) =>
        (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) ||
        ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)) ||
        String(a.id).localeCompare(String(b.id))
      );
    }

    async function fetchPagedConversations(url) {
      const res = await fetchWithTimeout((apiBase || '') + url, { headers: authHeaders(), cache: 'no-store' }, 5000);
      if (res.status === 401) { location.reload(); return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    async function triggerRefreshExtraConversations(rev) {
      const targetRev = String(rev || '').trim();
      if (!targetRev || targetRev === lastSyncedCatalogRev) return;
      pendingCatalogRev = targetRev;
      if (syncingExtraConvs) return;
      syncingExtraConvs = true;
      try {
        while (pendingCatalogRev && pendingCatalogRev !== lastSyncedCatalogRev) {
          const reqRev = pendingCatalogRev;
          const rebuilt = new Map();
          let globalCoveredAll = false;
          let latestRespRev = '';

          if (nextGlobalOffset > 0) {
            const lim = Math.max(nextGlobalOffset, extraConvMap.size, 150);
            const data = await fetchPagedConversations('/api/conversations?offset=0&limit=' + lim);
            if (!data) break;
            const rows = Array.isArray(data.conversations) ? data.conversations : [];
            for (const c of rows) {
              if (c && c.id) rebuilt.set(c.id, c);
            }
            globalCoveredAll = !data.hasMore;
            const tot = Number(data.total);
            nextGlobalOffset = Math.min(Math.max(nextGlobalOffset, rows.length), Number.isFinite(tot) ? tot : rows.length);
            if (data.catalogRevision) latestRespRev = String(data.catalogRevision);
          }

          if (!globalCoveredAll && projOffsetMap.size > 0) {
            for (const [pid, pOff] of Array.from(projOffsetMap.entries())) {
              if (!(pOff > 0)) continue;
              const lim = Math.max(pOff, 150);
              const data = await fetchPagedConversations('/api/conversations?offset=0&limit=' + lim + '&projectId=' + encodeURIComponent(pid));
              if (!data) continue;
              const rows = Array.isArray(data.conversations) ? data.conversations : [];
              for (const c of rows) {
                if (c && c.id) rebuilt.set(c.id, c);
              }
              const tot = Number(data.total);
              projOffsetMap.set(pid, Math.min(Math.max(pOff, rows.length), Number.isFinite(tot) ? tot : rows.length));
              if (data.catalogRevision) latestRespRev = String(data.catalogRevision);
            }
          }

          const curSid = String(latestSnap?.sessionId || '');
          extraConvMap.clear();
          for (const [id, c] of rebuilt.entries()) {
            const isAct = Boolean(curSid && id === curSid);
            extraConvMap.set(id, { ...c, active: isAct, unread: isAct ? false : Boolean(c.unread) });
          }
          lastSyncedCatalogRev = latestRespRev || reqRev;
          if (pendingCatalogRev === reqRev || pendingCatalogRev === lastSyncedCatalogRev) {
            pendingCatalogRev = '';
          }
          if (latestSnap) renderConversationList(latestSnap);
        }
      } catch {
      } finally {
        syncingExtraConvs = false;
      }
    }

    function reconcileExtraConversations(snap) {
      const rev = String(snap?.catalogRevision || '').trim();
      if (extraConvMap.size === 0 && nextGlobalOffset === 0 && projOffsetMap.size === 0) {
        if (rev) lastSyncedCatalogRev = rev;
        return;
      }
      const activeSid = String(snap?.sessionId || '');
      const snapConvs = Array.isArray(snap?.conversations) ? snap.conversations : [];
      for (const c of snapConvs) {
        if (c && c.id && extraConvMap.has(c.id)) {
          extraConvMap.set(c.id, c);
        }
      }
      for (const [id, c] of extraConvMap.entries()) {
        if (!c) continue;
        const isAct = Boolean(activeSid && id === activeSid);
        if (Boolean(c.active) !== isAct || (isAct && c.unread)) {
          extraConvMap.set(id, { ...c, active: isAct, unread: isAct ? false : Boolean(c.unread) });
        }
      }
      if (rev && rev !== lastSyncedCatalogRev) {
        void triggerRefreshExtraConversations(rev);
      }
    }

    async function loadMoreConversations(opts = {}) {
      if (loadingMoreConvs) return;
      loadingMoreConvs = true;
      try {
        const wasEmpty = extraConvMap.size === 0 && nextGlobalOffset === 0 && projOffsetMap.size === 0;
        const pid = String(opts.projectId || '').trim();
        const offset = pid ? (projOffsetMap.get(pid) || 0) : nextGlobalOffset;
        const limit = 150;
        let q = '/api/conversations?offset=' + offset + '&limit=' + limit;
        if (pid) q += '&projectId=' + encodeURIComponent(pid);
        const data = await fetchPagedConversations(q);
        if (!data) return;
        const rows = Array.isArray(data?.conversations) ? data.conversations : [];
        const curSid = String(latestSnap?.sessionId || '');
        for (const c of rows) {
          if (!c || !c.id) continue;
          const isAct = Boolean(curSid && c.id === curSid);
          extraConvMap.set(c.id, { ...c, active: isAct, unread: isAct ? false : Boolean(c.unread) });
        }
        if (pid) {
          projOffsetMap.set(pid, offset + rows.length);
        } else {
          nextGlobalOffset = offset + rows.length;
          recentDisplayLimit = Math.max(recentDisplayLimit + rows.length, extraConvMap.size);
        }
        if (wasEmpty && data?.catalogRevision) {
          lastSyncedCatalogRev = String(data.catalogRevision);
        }
        if (latestSnap) renderConversationList(latestSnap);
      } catch (err) {
        showToast(err?.message || '加载更多会话失败');
      } finally {
        loadingMoreConvs = false;
      }
    }

    function formatRelTime(ts) {
      const n = Number(ts) || 0;
      if (!n || n <= 0) return '';
      const diff = Math.max(0, Date.now() - n);
      const mins = Math.floor(diff / 60000);
      if (mins < 2) return '刚刚';
      if (mins < 60) return mins + 'm';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h';
      const days = Math.floor(hrs / 24);
      return days + 'd';
    }

    function statusDotHtml(c) {
      if (c.status === 'waiting') return '<span class="c-dot waiting" title="待确认"></span>';
      if (c.status === 'running') return '<span class="c-dot running" title="运行中"></span>';
      if (c.status === 'error') return '<span class="c-dot error" title="异常中断"></span>';
      if (c.status === 'unknown') return '<span class="c-dot unknown" title="状态未知"></span>';
      if (c.unread) return '<span class="c-dot unread" title="有新结果"></span>';
      return '<span class="c-dot"></span>';
    }

    function renderConvItemHtml(c, showProjectName) {
      const cls = 'conv-item' + (c.active ? ' active' : '') + (c.unread ? ' is-unread' : '');
      const titleText = (c.pinned ? '📌 ' : '') + String(c.title || c.id || '');
      let badgeHtml = '';
      if (c.status === 'waiting') badgeHtml = '<span class="c-badge waiting">' + esc(c.statusLabel || '待确认') + '</span>';
      else if (c.status === 'running') badgeHtml = '<span class="c-badge running">' + esc(c.statusLabel || '运行中') + '</span>';
      else if (c.status === 'error') badgeHtml = '<span class="c-badge error">' + esc(c.statusLabel || '异常') + '</span>';
      else if (c.status === 'unknown') badgeHtml = '<span class="c-badge unknown">' + esc(c.statusLabel || '未知') + '</span>';
      const rel = formatRelTime(c.updatedAt);
      const rightMeta = badgeHtml || (rel ? '<span class="c-time">' + esc(rel) + '</span>' : '');
      let subHtml = '';
      if (showProjectName || (badgeHtml && rel)) {
        const subParts = [];
        if (showProjectName && c.projectName) subParts.push(c.projectName);
        if (rel) subParts.push(rel);
        if (subParts.length) subHtml = '<div class="c-sub">' + esc(subParts.join(' · ')) + '</div>';
      }
      return '<button class="' + cls + '" data-cid="' + esc(c.id) + '" type="button">' +
        '<div class="c-row">' + statusDotHtml(c) + '<span class="c-title">' + esc(titleText) + '</span>' + rightMeta + '</div>' +
        subHtml + '</button>';
    }

    const FOLDER_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    const FOLDER_SM_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

    function renderConversationList(snap) {
      const convList = $('conv-list');
      if (!convList || !snap) return;
      const convs = getMergedConversations(snap);
      const totalAllCount = Math.max(convs.length, Number(snap.totalConversations) || 0);
      const rawProjects = Array.isArray(snap.projects) ? snap.projects : [];
      const projMap = new Map();
      const grouped = new Map();

      for (const p of rawProjects) {
        if (!p || !p.id) continue;
        projMap.set(p.id, p);
        grouped.set(p.id, []);
      }
      for (const c of convs) {
        const pid = c.projectId || 'ungrouped';
        if (!projMap.has(pid)) {
          projMap.set(pid, {
            id: pid,
            name: c.projectName || (pid === 'ungrouped' ? '未归属项目' : pid),
            conversationCount: 0,
            runningCount: 0,
            waitingCount: 0,
            isEmpty: false
          });
        }
        if (!grouped.has(pid)) grouped.set(pid, []);
        grouped.get(pid).push(c);
      }

      const projCountEl = $('tab-proj-count');
      const convCountEl = $('tab-conv-count');
      if (projCountEl) projCountEl.textContent = projMap.size ? ('(' + projMap.size + ')') : '';
      if (convCountEl) convCountEl.textContent = totalAllCount ? ('(' + totalAllCount + ')') : '';
      syncConvTabsUi();

      let html = '';
      if (convViewMode === 'recent') {
        if (!convs.length && !totalAllCount) {
          html = '<div class="empty-tip" style="padding:18px 8px">暂无历史对话</div>';
        } else {
          const shown = convs.slice(0, recentDisplayLimit);
          html = shown.map((c) => renderConvItemHtml(c, true)).join('');
          if (shown.length < totalAllCount || snap.hasMoreConversations) {
            html += '<button class="conv-more-btn" data-conv-more="1" type="button">加载更多历史对话 (' + shown.length + '/' + totalAllCount + ')</button>';
          }
        }
      } else {
        const orderedProjects = Array.from(projMap.values());
        const nonEmptyProjects = orderedProjects.filter((p) => (p.conversationCount > 0) || (grouped.get(p.id)?.length || 0) > 0);
        const emptyProjects = orderedProjects.filter((p) => (p.conversationCount || 0) === 0 && (grouped.get(p.id)?.length || 0) === 0 && p.id !== 'ungrouped');

        if (!nonEmptyProjects.length && !emptyProjects.length) {
          html = '<div class="empty-tip" style="padding:18px 8px">暂无项目与历史对话</div>';
        } else {
          html = nonEmptyProjects.map((p) => {
            const list = grouped.get(p.id) || [];
            const projTotal = Math.max(list.length, Number(p.conversationCount) || 0);
            const hasRunning = (p.runningCount > 0) || list.some((x) => x.status === 'running');
            const hasWaiting = (p.waitingCount > 0) || list.some((x) => x.status === 'waiting');
            const collapsed = Boolean(collapsedProjMap[p.id]);
            const isCurrentProj = Boolean(snap.currentProjectId && p.id === snap.currentProjectId);
            const isUngroupedProj = p.id === 'ungrouped';
            const groupCls = 'proj-group' + (isCurrentProj ? ' is-current' : '') + (isUngroupedProj ? ' is-ungrouped' : '');
            const statDot = hasWaiting
              ? '<span class="proj-stat-dot waiting" title="有待确认操作"></span>'
              : (hasRunning ? '<span class="proj-stat-dot running" title="有运行中对话"></span>' : '');
            const newBtnHtml = !isUngroupedProj
              ? '<button class="proj-new-btn" data-new-proj="' + esc(p.id) + '" type="button" title="在 ' + esc(p.name) + ' 中新建对话" aria-label="在 ' + esc(p.name) + ' 中新建对话">+</button>'
              : '';
            const projMoreHtml = list.length < projTotal
              ? '<button class="conv-more-btn" data-proj-more="' + esc(p.id) + '" type="button">加载该项目更多对话 (' + list.length + '/' + projTotal + ')</button>'
              : '';
            const itemsHtml = collapsed ? '' : ('<div class="proj-body">' + list.map((c) => renderConvItemHtml(c, false)).join('') + projMoreHtml + '</div>');
            return '<div class="' + groupCls + '">' +
              '<div class="proj-head">' +
                '<button class="proj-toggle" data-proj-toggle="' + esc(p.id) + '" type="button" aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
                  '<span class="proj-chev">' + (collapsed ? '▸' : '▾') + '</span>' +
                  '<span class="proj-icon">' + FOLDER_ICON_SVG + '</span>' +
                  '<span class="proj-name">' + esc(p.name) + '</span>' +
                  statDot +
                  '<span class="proj-count">' + projTotal + '</span>' +
                '</button>' +
                newBtnHtml +
              '</div>' +
              itemsHtml +
            '</div>';
          }).join('');

          if (emptyProjects.length) {
            html += '<div class="proj-empty-sec">' +
              '<button class="proj-empty-toggle" data-empty-toggle="1" type="button" aria-expanded="' + (emptyProjExpanded ? 'true' : 'false') + '">' +
                '<span class="proj-chev">' + (emptyProjExpanded ? '▾' : '▸') + '</span>' +
                '<span>空项目 (' + emptyProjects.length + ')</span>' +
              '</button>' +
              (emptyProjExpanded ? emptyProjects.map((p) =>
                '<div class="proj-empty-row">' +
                  '<span class="proj-icon" style="opacity:.8">' + FOLDER_SM_SVG + '</span>' +
                  '<span class="proj-empty-name">' + esc(p.name) + '</span>' +
                  '<button class="proj-new-btn" data-new-proj="' + esc(p.id) + '" type="button" title="在 ' + esc(p.name) + ' 中新建对话">+</button>' +
                '</div>'
              ).join('') : '') +
            '</div>';
          }
        }
      }

      if (convList.dataset.lastHtml !== html) {
        convList.innerHTML = html;
        convList.dataset.lastHtml = html;
      }
    }

    let snapshotInflight = false;
    let snapshotSeq = 0;
    async function fetchSnapshot() {
      if (snapshotInflight) return;
      snapshotInflight = true;
      const mySeq = ++snapshotSeq;
      const q = currentTargetId ? '?targetId=' + encodeURIComponent(currentTargetId) : '';
      const doFetch = () => {
        if (activeSnapAbort) { try { activeSnapAbort.abort(); } catch {} }
        activeSnapAbort = typeof AbortController === 'function' ? new AbortController() : null;
        return fetchWithTimeout((apiBase || '') + '/api/snapshot' + q, { headers: authHeaders(), cache: 'no-store' }, latestSnap ? 4500 : 2200, activeSnapAbort);
      };
      try {
        let res = await doFetch();
        if (res.status === 401) { location.reload(); return; }
        if (res.status === 403) throw new Error('channel_disabled');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (mySeq === snapshotSeq) renderSnapshot(data);
      } catch {
        $('sub-meta').textContent = '连接中断 · 正在切换可用通道…';
        if (!latestSnap) {
          renderModeEntryGate('正在自动尝试备用通道，也可直接点击已开启的方式立即进入：');
        }
        const switched = await tryFailoverEndpoint();
        if (switched) {
          try {
            const retryRes = await doFetch();
            if (retryRes.status === 401) { location.reload(); return; }
            if (retryRes.status === 403) throw new Error('channel_disabled');
            if (!retryRes.ok) throw new Error('HTTP ' + retryRes.status);
            const retryData = await retryRes.json();
            if (mySeq === snapshotSeq) renderSnapshot(retryData);
            return;
          } catch {}
        }
        $('status-dot').className = 'dot err';
        $('sub-meta').textContent = '连接中断，点击可切换连接方式';
        if (!latestSnap) {
          renderModeEntryGate('当前入口暂未连通，请点击下方已开启的连接方式直接进入：');
        }
      } finally {
        snapshotInflight = false;
        activeSnapAbort = null;
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

    let activeSheetState = null;
    $('sheet-list').addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('.sheet-opt');
      if (!btn || !activeSheetState) return;
      const idx = Number(btn.getAttribute('data-idx'));
      const opt = activeSheetState.options[idx];
      const onSelect = activeSheetState.onSelect;
      activeSheetState = null;
      $('sheet-backdrop').hidden = true;
      if (opt && typeof onSelect === 'function') await onSelect(opt);
    });
    function openSheet(title, options, onSelect) {
      $('sheet-title-text').textContent = title;
      const listEl = $('sheet-list');
      activeSheetState = { options, onSelect };
      listEl.innerHTML = options.map((o, idx) =>
        '<button class="sheet-opt' + (o.active ? ' active' : '') + '" data-idx="' + idx + '" type="button">' +
        '<span>' + esc(o.label) + '</span>' + (o.active ? '<span>✓</span>' : '') + '</button>'
      ).join('');
      $('sheet-backdrop').hidden = false;
    }
    $('sheet-close').addEventListener('click', () => { $('sheet-backdrop').hidden = true; });
    $('sheet-backdrop').addEventListener('click', (e) => { if (e.target === $('sheet-backdrop')) $('sheet-backdrop').hidden = true; });

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
        try {
          const r = await apiAction({ action: 'select-model', label: opt.label, modelId: opt.modelId });
          if (r?.ok) showToast('已切换到 ' + (r.actionResult?.model || opt.label));
          else showToast(r?.error || r?.actionResult?.error || '切换模型失败');
        } catch (err) {
          showToast(err?.message || '切换模型失败');
        }
      });
    }

    const PERM_ICONS = {
      turbo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
      auto: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11.2 14.2 15.5 10"/></svg>',
      default: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
      request_review: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.8"/></svg>',
      unknown: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    };

    function resolvePermKey(rawKey, rawLabel) {
      const k = String(rawKey || '').trim().toLowerCase();
      if (k === 'turbo' || k === 'auto' || k === 'default' || k === 'request_review') return k;
      const lbl = String(rawLabel || '').trim().toLowerCase();
      if (!lbl) return 'unknown';
      if (/(?:turbo|无限|unrestricted)/i.test(lbl)) return 'turbo';
      if (/(?:request_review|review|请求审核|请求审查|审核|审查)/i.test(lbl)) return 'request_review';
      if (/(?:\bauto\b|自动)/i.test(lbl)) return 'auto';
      if (/(?:\bdefault\b|默认)/i.test(lbl)) return 'default';
      return 'unknown';
    }

    function syncPermInlineUi(rawKey, rawLabel) {
      const mode = resolvePermKey(rawKey, rawLabel);
      const lblEl = $('perm-inline-label');
      if (lblEl) {
        lblEl.textContent = String(rawLabel || '').trim() || ({ turbo: '无限', auto: '自动', default: '默认', request_review: '请求审核' }[mode]) || '权限';
      }
      const icoEl = $('perm-inline-icon');
      if (icoEl) {
        icoEl.className = 'perm-ico ' + mode;
        icoEl.setAttribute('data-perm-mode', mode);
        const svgHtml = PERM_ICONS[mode] || PERM_ICONS.unknown;
        if (icoEl.dataset.svgMode !== mode) {
          icoEl.innerHTML = svgHtml;
          icoEl.dataset.svgMode = mode;
        }
      }
    }

    let activeMsgSessionId = null;
    const sessionMsgsByIndex = new Map();
    let loadingEarlierMsgs = false;
    let backfillingMsgGaps = false;

    function getOrderedSessionMessages() {
      return Array.from(sessionMsgsByIndex.values()).sort((a, b) => (a.msgIndex - b.msgIndex));
    }

    function findMissingMsgRanges(totalCount) {
      if (sessionMsgsByIndex.size === 0) return [];
      const keys = Array.from(sessionMsgsByIndex.keys()).sort((a, b) => a - b);
      const minIdx = keys[0];
      const maxKey = keys[keys.length - 1];
      const maxEnd = (Number.isFinite(totalCount) && totalCount > 0) ? Math.max(totalCount, maxKey + 1) : (maxKey + 1);
      const keySet = new Set(keys);
      const ranges = [];
      let gapStart = -1;
      for (let idx = minIdx; idx < maxEnd; idx++) {
        if (!keySet.has(idx)) {
          if (gapStart < 0) gapStart = idx;
        } else if (gapStart >= 0) {
          ranges.push([gapStart, idx]);
          gapStart = -1;
        }
      }
      if (gapStart >= 0) ranges.push([gapStart, maxEnd]);
      return ranges;
    }

    async function backfillMissingMsgGaps(expectedSid) {
      if (backfillingMsgGaps || !expectedSid || expectedSid === '__new__' || expectedSid !== activeMsgSessionId) return;
      backfillingMsgGaps = true;
      try {
        while (expectedSid === activeMsgSessionId) {
          const ranges = findMissingMsgRanges(Number(latestSnap?.totalMessages));
          if (!ranges.length) break;
          const [gapStart, gapEnd] = ranges[0];
          let cursorEnd = gapEnd;
          let progressed = false;
          while (cursorEnd > gapStart && expectedSid === activeMsgSessionId) {
            const chunkLim = Math.max(1, Math.min(200, cursorEnd - gapStart));
            const q = '/api/messages?sessionId=' + encodeURIComponent(expectedSid) + '&before=' + cursorEnd + '&limit=' + chunkLim;
            const res = await fetchWithTimeout((apiBase || '') + q, { headers: authHeaders(), cache: 'no-store' }, 5000);
            if (res.status === 401) { location.reload(); return; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (expectedSid !== activeMsgSessionId) return;
            const rows = Array.isArray(data?.messages) ? data.messages : [];
            if (!rows.length) break;
            const baseIdx = Number.isFinite(Number(data?.startIndex)) ? Number(data.startIndex) : Math.max(0, cursorEnd - rows.length);
            for (let i = 0; i < rows.length; i++) {
              const m = rows[i];
              if (!m) continue;
              const mIdx = Number.isFinite(Number(m.msgIndex)) ? Number(m.msgIndex) : (baseIdx + i);
              sessionMsgsByIndex.set(mIdx, { ...m, msgIndex: mIdx });
              progressed = true;
            }
            renderMessagesView(latestSnap);
            if (baseIdx >= cursorEnd) break;
            cursorEnd = baseIdx;
          }
          if (!progressed) break;
        }
      } catch {
      } finally {
        backfillingMsgGaps = false;
      }
    }

    function setMsgScrollTop(nextTop) {
      const maxScroll = Math.max(0, (msgEl.scrollHeight || 0) - (msgEl.clientHeight || 0));
      const clamped = (msgEl.scrollHeight > 0 && msgEl.clientHeight > 0)
        ? Math.max(0, Math.min(maxScroll, nextTop))
        : Math.max(0, nextTop);
      programmaticScrollTop = clamped;
      msgEl.scrollTop = clamped;
    }

    function measureMsgViewportMetrics(el) {
      if (!el || typeof el.offsetTop !== 'number') return null;
      const byOffset = el.offsetTop - msgEl.scrollTop;
      const er = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const br = typeof msgEl.getBoundingClientRect === 'function' ? msgEl.getBoundingClientRect() : null;
      const h = (typeof el.offsetHeight === 'number' && el.offsetHeight > 0) ? el.offsetHeight : (er?.height || 0);
      if (er && br && Number.isFinite(er.top) && Number.isFinite(br.top) && Math.abs((er.top - br.top) - byOffset) < 4) {
        return { offset: er.top - br.top, height: er.height || h };
      }
      return { offset: byOffset, height: h };
    }

    function captureReadingAnchor() {
      const fallbackTop = msgEl.scrollTop;
      const nodes = msgEl.querySelectorAll('[data-msg-idx]');
      if (!nodes.length) return { msgIndex: null, viewportOffset: 0, fallbackTop };
      let chosen = null;
      let chosenMetrics = null;
      for (let i = 0; i < nodes.length; i++) {
        const m = measureMsgViewportMetrics(nodes[i]);
        if (!m) return { msgIndex: null, viewportOffset: 0, fallbackTop };
        chosen = nodes[i];
        chosenMetrics = m;
        if (m.offset + m.height > 0.5 || (m.height === 0 && m.offset >= 0)) {
          break;
        }
      }
      if (!chosen || !chosenMetrics) return { msgIndex: null, viewportOffset: 0, fallbackTop };
      const idx = Number(chosen.getAttribute('data-msg-idx'));
      if (!Number.isFinite(idx)) return { msgIndex: null, viewportOffset: 0, fallbackTop };
      return { msgIndex: idx, viewportOffset: chosenMetrics.offset, fallbackTop };
    }

    function restoreReadingAnchor(anchor) {
      if (!anchor) return;
      if (anchor.msgIndex !== null && anchor.msgIndex !== undefined) {
        const targetEl = msgEl.querySelector('[data-msg-idx="' + anchor.msgIndex + '"]');
        const curMetrics = measureMsgViewportMetrics(targetEl);
        if (curMetrics) {
          setMsgScrollTop(msgEl.scrollTop + (curMetrics.offset - anchor.viewportOffset));
          return;
        }
      }
      setMsgScrollTop(anchor.fallbackTop);
    }

    function renderMessagesView(snap, opts = {}) {
      const msgs = getOrderedSessionMessages();
      if (!msgs.length && !snap?.busy) {
        const emptyTipText = (snap?.isNewConversation && snap?.currentProjectName)
          ? ('正在「' + esc(snap.currentProjectName) + '」下新建对话，发一句话即可开始…')
          : ('暂无消息，发一句话' + (isDesktopLayout() ? '或在左侧切换会话' : '或在屏幕右滑切换会话'));
        const emptyHtml = '<div class="empty-tip">' + emptyTipText + '</div>';
        if (msgEl.dataset.lastHtml !== emptyHtml) {
          msgEl.innerHTML = emptyHtml;
          msgEl.dataset.lastHtml = emptyHtml;
        }
        return;
      }

      const earliestIdx = msgs.length ? Math.max(0, Number(msgs[0].msgIndex) || 0) : 0;
      let html = '';
      if (earliestIdx > 0) {
        html += '<button class="load-earlier-btn" id="btn-load-earlier" data-before="' + earliestIdx + '" type="button"' +
          (loadingEarlierMsgs ? ' disabled' : '') + '>' +
          (loadingEarlierMsgs ? '正在加载更早内容…' : ('↑ 加载更早的对话内容（前 ' + earliestIdx + ' 条）')) + '</button>';
      }
      html += msgs.map((m) => {
        if (m.role === 'user') {
          return '<div class="msg user" data-msg-idx="' + m.msgIndex + '">' + esc(m.text) + '</div>';
        }
        const risk = m.highRisk ? '<span class="risk-tag">' + esc(m.riskText || '🛡️ 检测到高危命令，请人工核对') + '</span>' : '';
        const thought = m.thoughtLabel
          ? '<details class="thought-box"><summary>💡 ' + esc(m.thoughtLabel) + (m.thoughtText ? ' · 展开思考' : '') + '</summary>' +
            (m.thoughtText ? '<div class="thought-body">' + esc(m.thoughtText) + '</div>' : '') + '</details>'
          : '';
        const bodyHtml = m.html
          ? '<div class="md-body">' + m.html + '</div>'
          : '<div class="msg-plain">' + esc(m.text || '') + '</div>';
        return '<div class="msg assistant' + (m.highRisk ? ' is-risk' : '') + '" data-msg-idx="' + m.msgIndex + '">' + risk + thought + bodyHtml + '</div>';
      }).join('');
      if (snap?.busy) {
        html += '<div class="busy-pill"><span class="busy-spark"></span><span>正在思考与执行…</span></div>';
      }

      if (msgEl.dataset.lastHtml !== html) {
        const shouldPreserve = !stickBottom || Boolean(opts.preserveAnchor);
        const anchor = shouldPreserve ? captureReadingAnchor() : null;
        msgEl.innerHTML = html;
        msgEl.dataset.lastHtml = html;
        if (!shouldPreserve) {
          programmaticScrollTop = msgEl.scrollHeight;
          msgEl.scrollTop = msgEl.scrollHeight;
        } else if (anchor) {
          restoreReadingAnchor(anchor);
        }
      }
    }

    async function loadEarlierMessages() {
      const msgs = getOrderedSessionMessages();
      const earliestIdx = msgs.length ? Math.max(0, Number(msgs[0].msgIndex) || 0) : 0;
      const reqSid = activeMsgSessionId;
      if (loadingEarlierMsgs || !reqSid || reqSid === '__new__' || !(earliestIdx > 0)) return;
      loadingEarlierMsgs = true;
      const btn = $('btn-load-earlier');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '正在加载更早内容…';
      }
      try {
        const q = '/api/messages?sessionId=' + encodeURIComponent(reqSid) + '&before=' + earliestIdx + '&limit=30';
        const res = await fetchWithTimeout((apiBase || '') + q, { headers: authHeaders(), cache: 'no-store' }, 5000);
        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (reqSid !== activeMsgSessionId) return;
        const rows = Array.isArray(data?.messages) ? data.messages : [];
        const baseIdx = Number.isFinite(Number(data?.startIndex)) ? Number(data.startIndex) : Math.max(0, earliestIdx - rows.length);
        stickBottom = false;
        for (let i = 0; i < rows.length; i++) {
          const m = rows[i];
          if (!m) continue;
          const mIdx = Number.isFinite(Number(m.msgIndex)) ? Number(m.msgIndex) : (baseIdx + i);
          sessionMsgsByIndex.set(mIdx, { ...m, msgIndex: mIdx });
        }
        loadingEarlierMsgs = false;
        renderMessagesView(latestSnap, { preserveAnchor: true });
      } catch (err) {
        loadingEarlierMsgs = false;
        msgEl.dataset.lastHtml = '';
        renderMessagesView(latestSnap);
        showToast(err?.message || '加载更早消息失败');
      }
    }

    function openPermPicker() {
      const curKey = resolvePermKey(latestSnap?.permissionKey, latestSnap?.permissionLabel);
      const cur = (latestSnap?.permissionLabel || '').toLowerCase();
      const opts = (latestSnap?.permissionOptions || [
        { key: 'turbo', label: '⚡ 无限 (Turbo)' },
        { key: 'auto', label: '🛡️ 自动 (Auto)' },
        { key: 'default', label: '🔒 默认 (Default)' },
        { key: 'request_review', label: '👁️ 请求审核 (Review)' }
      ]).map((p) => ({
        key: p.key,
        label: p.label,
        active: curKey !== 'unknown' ? (p.key === curKey) : Boolean(cur && p.label.toLowerCase().includes(cur))
      }));
      openSheet('切换权限预设', opts, async (opt) => {
        showToast('正在切换权限…');
        try {
          const r = await apiAction({ action: 'select-permission', preset: opt.key });
          if (r?.ok) {
            syncPermInlineUi(r.actionResult?.permissionKey || opt.key, r.actionResult?.permissionLabel || opt.label);
            showToast('已切换权限: ' + (r.actionResult?.permissionLabel || opt.label));
          } else {
            showToast(r?.error || r?.actionResult?.error || '切换权限失败');
          }
        } catch (err) {
          showToast(err?.message || '切换权限失败');
        }
      });
    }

    $('btn-model-inline').addEventListener('click', openModelPicker);
    $('btn-perm-inline').addEventListener('click', openPermPicker);

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

    async function uploadImageFiles(rawFiles) {
      const files = Array.from(rawFiles || []).filter(Boolean);
      if (!files.length) return;
      showToast('正在上传 ' + files.length + ' 张图片…');
      for (const f of files) {
        try {
          const payload = await compressAndReadImage(f);
          const r = await apiAction({ action: 'upload-image', ...payload });
          if (r?.ok) {
            uploadedNames.push(payload.name);
          } else {
            showToast(r?.error || r?.actionResult?.error || '传图失败');
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
    }

    $('btn-img').onclick = () => $('img-input').click();
    $('img-input').onchange = (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      void uploadImageFiles(files);
    };

    const composerCardEl = document.querySelector('.composer-card');
    let dragDepth = 0;
    const hasDraggedFiles = (e) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    if (composerCardEl) {
      composerCardEl.addEventListener('dragenter', (e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth += 1;
        composerCardEl.classList.add('drag-over');
      });
      composerCardEl.addEventListener('dragover', (e) => {
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        composerCardEl.classList.add('drag-over');
      });
      composerCardEl.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) composerCardEl.classList.remove('drag-over');
      });
      composerCardEl.addEventListener('drop', (e) => {
        dragDepth = 0;
        composerCardEl.classList.remove('drag-over');
        if (!hasDraggedFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const imgFiles = Array.from(e.dataTransfer?.files || []).filter((f) => String(f.type || '').startsWith('image/'));
        if (imgFiles.length) void uploadImageFiles(imgFiles);
      });
    }
    document.addEventListener('dragover', (e) => {
      if (hasDraggedFiles(e)) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      dragDepth = 0;
      if (composerCardEl) composerCardEl.classList.remove('drag-over');
      if (hasDraggedFiles(e)) e.preventDefault();
    });

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
    function syncSidebarA11y() {
      const btnDrawer = $('btn-drawer');
      const visible = isDesktopLayout()
        ? !document.body.classList.contains('sidebar-collapsed')
        : backdropEl.classList.contains('open');
      if (!visible && backdropEl.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch {}
      }
      backdropEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if ('inert' in backdropEl) backdropEl.inert = !visible;
      if (btnDrawer) btnDrawer.setAttribute('aria-expanded', visible ? 'true' : 'false');
    }
    function openDrawer() {
      backdropEl.classList.remove('dragging');
      drawerEl.style.transform = '';
      backdropEl.style.backgroundColor = '';
      backdropEl.classList.add('open');
      syncSidebarA11y();
    }
    function closeDrawer() {
      backdropEl.classList.remove('dragging', 'open');
      drawerEl.style.transform = '';
      backdropEl.style.backgroundColor = '';
      syncSidebarA11y();
    }

    async function startNewConversationInProject(projectId, projectName) {
      if (!isDesktopLayout()) closeDrawer();
      stickBottom = true;
      try {
        const payload = { action: 'new-conversation' };
        if (projectId) payload.projectId = projectId;
        const r = await apiAction(payload);
        if (r?.ok) {
          showToast(projectName ? ('已在「' + projectName + '」中新建对话') : '已新建对话');
        } else {
          showToast(r?.error || r?.actionResult?.error || '新建对话失败');
        }
      } catch (err) {
        showToast(err?.message || '新建对话失败');
      }
    }

    function openNewChatProjectPicker() {
      const projs = (latestSnap?.projects || []).filter((p) => p && p.id && p.id !== 'ungrouped');
      const opts = [
        {
          isCreateProject: true,
          label: '📁 新建项目（选择电脑目录）…',
          active: false
        },
        ...projs.map((p) => ({
          projectId: p.id,
          projectName: p.name,
          label: p.name + (p.conversationCount > 0 ? (' (' + p.conversationCount + ')') : ' (空项目)'),
          active: Boolean(latestSnap?.currentProjectId && p.id === latestSnap.currentProjectId)
        })),
        {
          projectId: '',
          projectName: '',
          label: '默认工作区（不指定项目）',
          active: !latestSnap?.currentProjectId
        }
      ];
      openSheet('选择项目新建对话', opts, async (opt) => {
        if (opt?.isCreateProject) {
          await openCreateProjectModal();
          return;
        }
        await startNewConversationInProject(opt.projectId, opt.projectName);
      });
    }

    const projBrowserState = {
      currentPath: '',
      parentPath: null,
      showHidden: false,
      isGitRepo: false,
      existingProject: null,
      navFailedError: '',
      justCreatedButNavFailed: false,
      loading: false,
      submitting: false
    };

    function renderProjModalSummary() {
      const sumEl = $('proj-selected-summary');
      if (!sumEl) return;
      if (projBrowserState.navFailedError && projBrowserState.existingProject) {
        sumEl.classList.add('is-warn');
        const exName = projBrowserState.existingProject.name || $('proj-name-input')?.value || '';
        const headline = projBrowserState.justCreatedButNavFailed
          ? ('项目「' + exName + '」已创建，但未成功进入新对话')
          : ('未能进入已有项目「' + exName + '」');
        sumEl.innerHTML =
          '<div><strong>' + esc(headline) + '</strong></div>' +
          '<div>原因：' + esc(projBrowserState.navFailedError) + '（请点击下方按钮重试进入已有项目）</div>' +
          '<div class="proj-summary-path">' + esc(projBrowserState.currentPath) + '</div>';
        return;
      }
      sumEl.classList.remove('is-warn');
      const repoBadge = projBrowserState.isGitRepo ? 'Git 仓库' : '普通目录';
      const linkedHint = projBrowserState.existingProject
        ? (' · 已关联项目「' + projBrowserState.existingProject.name + '」（可直接进入或修改下方名称另建）')
        : '';
      sumEl.innerHTML =
        '<div><strong>当前选中目录</strong> (' + esc(repoBadge) + esc(linkedHint) + ')</div>' +
        '<div class="proj-summary-path">' + esc(projBrowserState.currentPath) + '</div>';
    }

    function syncCreateProjectSubmitUi() {
      const submitBtn = $('proj-create-submit');
      if (!submitBtn) return;
      const typedName = String($('proj-name-input')?.value || '').trim();
      const ex = projBrowserState.existingProject;
      const matchesExisting = Boolean(ex && typedName && typedName.toLowerCase() === String(ex.name || '').toLowerCase());
      if (projBrowserState.submitting) {
        submitBtn.disabled = true;
        submitBtn.textContent = (projBrowserState.navFailedError && matchesExisting)
          ? '正在重试进入项目…'
          : '正在创建并打开项目…';
        return;
      }
      const hasPath = Boolean(projBrowserState.currentPath);
      submitBtn.disabled = !hasPath || !typedName;
      if (matchesExisting) {
        submitBtn.textContent = (projBrowserState.navFailedError ? '重试进入已有项目「' : '进入已有项目「') + ex.name + '」';
      } else {
        submitBtn.textContent = '创建项目并进入对话';
      }
    }

    function renderDirBrowserData(data) {
      projBrowserState.currentPath = String(data?.path || '');
      projBrowserState.parentPath = data?.parentPath || null;
      projBrowserState.isGitRepo = Boolean(data?.isGitRepo);
      projBrowserState.existingProject = data?.existingProject || null;
      projBrowserState.navFailedError = '';
      projBrowserState.justCreatedButNavFailed = false;
      projBrowserState.showHidden = Boolean(data?.showHidden);

      const pathIn = $('proj-path-input');
      if (pathIn) pathIn.value = projBrowserState.currentPath;
      const upBtn = $('proj-up-btn');
      if (upBtn) upBtn.disabled = !projBrowserState.parentPath || projBrowserState.loading;
      const hidBtn = $('proj-hidden-btn');
      if (hidBtn) hidBtn.classList.toggle('active', projBrowserState.showHidden);

      const rootsEl = $('proj-roots');
      if (rootsEl) {
        const roots = Array.isArray(data?.roots) ? data.roots : [];
        rootsEl.innerHTML = roots.map((r) => {
          const isCur = projBrowserState.currentPath === r.path;
          return '<button class="proj-root-pill' + (isCur ? ' active' : '') + '" data-root-path="' + esc(r.path) + '" type="button">' + esc(r.label) + '</button>';
        }).join('');
      }

      const listEl = $('proj-dir-list');
      if (listEl) {
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        if (!entries.length) {
          listEl.innerHTML = '<div class="empty-tip" style="padding:18px 8px">当前目录下暂无子文件夹，可直接用当前目录创建项目，或点击上方「＋ 新建文件夹」</div>';
        } else {
          listEl.innerHTML = entries.map((d) => {
            const gitTag = d.isGitRepo ? '<span class="proj-tag git">Git</span>' : '';
            const linkedTag = d.existingProjectName ? ('<span class="proj-tag linked">已关联: ' + esc(d.existingProjectName) + '</span>') : '';
            return '<button class="proj-dir-item" data-dir-path="' + esc(d.path) + '" type="button">' +
              '<span class="proj-icon">' + FOLDER_SM_SVG + '</span>' +
              '<span class="proj-dir-label">' + esc(d.name) + '</span>' +
              '<span class="proj-dir-badges">' + gitTag + linkedTag + '</span>' +
              '<span style="color:#71717a;font-size:13px">›</span>' +
            '</button>';
          }).join('') + (data?.truncated ? '<div style="text-align:center;font-size:11.5px;color:#71717a;padding:4px 0">仅显示前 300 个子目录，可输入路径精确定位</div>' : '');
        }
      }

      renderProjModalSummary();

      const nameIn = $('proj-name-input');
      if (nameIn) nameIn.value = String(data?.suggestedName || data?.currentName || '');
      syncCreateProjectSubmitUi();
    }

    async function loadHostDirListing(targetPath) {
      projBrowserState.loading = true;
      const listEl = $('proj-dir-list');
      if (listEl && !listEl.children.length) {
        listEl.innerHTML = '<div class="empty-tip" style="padding:18px 8px">正在读取电脑目录…</div>';
      }
      try {
        const params = [];
        if (targetPath !== undefined && targetPath !== null && String(targetPath).trim()) {
          params.push('path=' + encodeURIComponent(String(targetPath).trim()));
        }
        if (projBrowserState.showHidden) params.push('showHidden=1');
        const q = '/api/fs/dirs' + (params.length ? ('?' + params.join('&')) : '');
        const res = await fetchWithTimeout((apiBase || '') + q, { headers: authHeaders(), cache: 'no-store' }, 5000);
        if (res.status === 401) { location.reload(); return false; }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok === false) {
          throw new Error(data?.error || ('读取目录失败 (HTTP ' + res.status + ')'));
        }
        projBrowserState.loading = false;
        renderDirBrowserData(data);
        return true;
      } catch (err) {
        projBrowserState.loading = false;
        if (listEl && !projBrowserState.currentPath) {
          listEl.innerHTML = '<div class="empty-tip" style="padding:18px 8px">' + esc(err?.message || '读取电脑目录失败') + '</div>';
        }
        showToast(err?.message || '读取电脑目录失败');
        syncCreateProjectSubmitUi();
        return false;
      }
    }

    async function openCreateProjectModal() {
      const backdrop = $('proj-modal-backdrop');
      if (!backdrop) return;
      projBrowserState.navFailedError = '';
      projBrowserState.justCreatedButNavFailed = false;
      if ($('proj-mkdir-row')) $('proj-mkdir-row').hidden = true;
      if ($('proj-mkdir-input')) $('proj-mkdir-input').value = '';
      backdrop.hidden = false;
      const initialPath = projBrowserState.currentPath || '';
      await loadHostDirListing(initialPath);
    }

    function closeCreateProjectModal() {
      const backdrop = $('proj-modal-backdrop');
      if (backdrop) backdrop.hidden = true;
    }

    async function createNewSubdirInModal() {
      const nameIn = $('proj-mkdir-input');
      const dirName = String(nameIn?.value || '').trim();
      if (!dirName) {
        showToast('请输入新文件夹名称');
        nameIn?.focus?.();
        return;
      }
      try {
        const res = await fetchWithTimeout((apiBase || '') + '/api/fs/mkdir', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ parentPath: projBrowserState.currentPath, name: dirName })
        }, 5000);
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok === false) {
          throw new Error(data?.error || '创建文件夹失败');
        }
        if (nameIn) nameIn.value = '';
        if ($('proj-mkdir-row')) $('proj-mkdir-row').hidden = true;
        showToast(data.existed ? ('已进入文件夹「' + data.name + '」') : ('已创建文件夹「' + data.name + '」'));
        await loadHostDirListing(data.path);
      } catch (err) {
        showToast(err?.message || '创建文件夹失败');
      }
    }

    async function submitCreateProjectModal() {
      if (projBrowserState.submitting) return;
      const folderPath = String(projBrowserState.currentPath || '').trim();
      const projectName = String($('proj-name-input')?.value || '').trim();
      if (!folderPath) {
        showToast('请先选择项目目录');
        return;
      }
      if (!projectName) {
        showToast('请输入项目名称');
        return;
      }
      projBrowserState.submitting = true;
      syncCreateProjectSubmitUi();
      try {
        const ex = projBrowserState.existingProject;
        const forceNew = Boolean(ex && ex.name && projectName.toLowerCase() !== String(ex.name).toLowerCase());
        const res = await fetchWithTimeout((apiBase || '') + '/api/projects', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            folderPath,
            name: projectName,
            forceNew,
            existingProjectId: (!forceNew && ex?.id) ? ex.id : undefined,
            targetId: currentTargetId || undefined
          })
        }, 8000);
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok === false) {
          throw new Error(data?.error || ('创建项目失败 (HTTP ' + res.status + ')'));
        }
        if (data.snapshot) renderSnapshot(data.snapshot);
        else void fetchSnapshot();
        const createdName = data.project?.name || projectName;
        const createdId = String(data.project?.id || ex?.id || '').trim();
        const navFailed = (data.navOk === false) || Boolean(data.navResult && data.navResult.ok === false);
        if (navFailed) {
          const reason = String(data.navError || data.navResult?.error || '桌面端未能进入新对话').trim();
          projBrowserState.existingProject = { id: createdId, name: createdName };
          projBrowserState.navFailedError = reason;
          projBrowserState.justCreatedButNavFailed = !data.alreadyExists;
          const nameIn = $('proj-name-input');
          if (nameIn) nameIn.value = createdName;
          renderProjModalSummary();
          showToast(
            data.alreadyExists
              ? ('未能进入已有项目「' + createdName + '」：' + reason)
              : ('项目「' + createdName + '」已创建，但未成功进入对话：' + reason + '（可点击重试进入）')
          );
          return;
        }
        projBrowserState.navFailedError = '';
        projBrowserState.justCreatedButNavFailed = false;
        closeCreateProjectModal();
        if (!isDesktopLayout()) closeDrawer();
        stickBottom = true;
        showToast(data.alreadyExists ? ('已进入项目「' + createdName + '」') : ('已创建并进入项目「' + createdName + '」'));
      } catch (err) {
        showToast(err?.message || '创建项目失败');
      } finally {
        projBrowserState.submitting = false;
        syncCreateProjectSubmitUi();
      }
    }

    const newProjMiniBtn = $('btn-new-project');
    if (newProjMiniBtn) newProjMiniBtn.addEventListener('click', () => { void openCreateProjectModal(); });
    $('proj-modal-close')?.addEventListener('click', closeCreateProjectModal);
    $('proj-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target === $('proj-modal-backdrop')) closeCreateProjectModal();
    });
    $('proj-roots')?.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.proj-root-pill');
      const target = btn?.getAttribute?.('data-root-path');
      if (target) void loadHostDirListing(target);
    });
    $('proj-dir-list')?.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('.proj-dir-item');
      const target = btn?.getAttribute?.('data-dir-path');
      if (target) void loadHostDirListing(target);
    });
    $('proj-up-btn')?.addEventListener('click', () => {
      if (projBrowserState.parentPath) void loadHostDirListing(projBrowserState.parentPath);
    });
    $('proj-hidden-btn')?.addEventListener('click', () => {
      projBrowserState.showHidden = !projBrowserState.showHidden;
      void loadHostDirListing(projBrowserState.currentPath || '');
    });
    $('proj-mkdir-toggle')?.addEventListener('click', () => {
      const row = $('proj-mkdir-row');
      if (!row) return;
      row.hidden = !row.hidden;
      if (!row.hidden) $('proj-mkdir-input')?.focus?.();
    });
    $('proj-mkdir-confirm')?.addEventListener('click', () => { void createNewSubdirInModal(); });
    $('proj-mkdir-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void createNewSubdirInModal();
      }
    });
    $('proj-path-go')?.addEventListener('click', () => {
      const val = String($('proj-path-input')?.value || '').trim();
      if (val) void loadHostDirListing(val);
    });
    $('proj-path-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const val = String($('proj-path-input')?.value || '').trim();
        if (val) void loadHostDirListing(val);
      }
    });
    $('proj-name-input')?.addEventListener('input', () => {
      const typedName = String($('proj-name-input')?.value || '').trim();
      const ex = projBrowserState.existingProject;
      if (projBrowserState.navFailedError && (!ex || typedName.toLowerCase() !== String(ex.name || '').toLowerCase())) {
        projBrowserState.navFailedError = '';
        projBrowserState.justCreatedButNavFailed = false;
        renderProjModalSummary();
      }
      syncCreateProjectSubmitUi();
    });
    $('proj-create-submit')?.addEventListener('click', () => { void submitCreateProjectModal(); });

    const convViewTabsEl = $('conv-view-tabs');
    if (convViewTabsEl) {
      convViewTabsEl.addEventListener('click', (e) => {
        const tab = e.target?.closest?.('.conv-tab');
        if (!tab) return;
        const nextMode = tab.getAttribute('data-conv-view');
        if (nextMode !== 'projects' && nextMode !== 'recent') return;
        if (convViewMode === nextMode) return;
        convViewMode = nextMode;
        saveConvUiPrefs();
        if (latestSnap) renderConversationList(latestSnap);
        else syncConvTabsUi();
      });
    }

    $('conv-list').addEventListener('click', async (e) => {
      const newProjBtn = e.target?.closest?.('.proj-new-btn');
      if (newProjBtn) {
        e.stopPropagation();
        const pid = newProjBtn.getAttribute('data-new-proj') || '';
        if (!pid) return;
        const matchedProj = (latestSnap?.projects || []).find((p) => p.id === pid);
        await startNewConversationInProject(pid, matchedProj?.name || '');
        return;
      }

      const toggleBtn = e.target?.closest?.('.proj-toggle');
      if (toggleBtn) {
        const pid = toggleBtn.getAttribute('data-proj-toggle') || '';
        if (!pid) return;
        if (collapsedProjMap[pid]) delete collapsedProjMap[pid];
        else collapsedProjMap[pid] = true;
        saveConvUiPrefs();
        if (latestSnap) renderConversationList(latestSnap);
        return;
      }

      const emptyToggleBtn = e.target?.closest?.('.proj-empty-toggle');
      if (emptyToggleBtn) {
        emptyProjExpanded = !emptyProjExpanded;
        if (latestSnap) renderConversationList(latestSnap);
        return;
      }

      const moreBtn = e.target?.closest?.('.conv-more-btn');
      if (moreBtn) {
        const projMorePid = moreBtn.getAttribute('data-proj-more') || '';
        if (projMorePid) {
          await loadMoreConversations({ projectId: projMorePid });
        } else {
          const merged = getMergedConversations(latestSnap);
          const totalCount = Math.max(merged.length, Number(latestSnap?.totalConversations) || 0);
          if (merged.length < totalCount) {
            await loadMoreConversations({ projectId: '' });
          } else {
            recentDisplayLimit = Math.max(recentDisplayLimit + 150, totalCount);
            if (latestSnap) renderConversationList(latestSnap);
          }
        }
        return;
      }

      const btn = e.target?.closest?.('.conv-item');
      const cid = btn?.getAttribute('data-cid') || btn?.dataset?.cid || '';
      if (!btn || !cid) return;
      if (!isDesktopLayout()) closeDrawer();
      stickBottom = true;
      showToast('正在切换会话…');
      try {
        const r = await apiAction({ action: 'switch-conversation', id: cid });
        if (!r?.ok) showToast(r?.error || r?.actionResult?.error || '切换会话失败');
      } catch (err) {
        showToast(err?.message || '切换会话失败');
      }
    });
    $('btn-drawer').addEventListener('click', () => {
      if (isDesktopLayout()) {
        document.body.classList.toggle('sidebar-collapsed');
        syncSidebarA11y();
      } else {
        openDrawer();
      }
    });
    backdropEl.addEventListener('click', (e) => { if (!isDesktopLayout() && e.target === backdropEl) closeDrawer(); });
    $('btn-new-chat').addEventListener('click', async () => {
      const pid = latestSnap?.currentProjectId || '';
      const pname = pid ? (latestSnap?.currentProjectName || '') : '';
      await startNewConversationInProject(pid, pname);
    });
    const newChatProjBtn = $('btn-new-chat-project');
    if (newChatProjBtn) {
      newChatProjBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNewChatProjectPicker();
      });
    }
    const handleLayoutChange = () => {
      if (isDesktopLayout() && backdropEl.classList.contains('open')) {
        closeDrawer();
      } else {
        syncSidebarA11y();
      }
      if (typeof autoGrow === 'function') autoGrow();
    };
    window.addEventListener('resize', handleLayoutChange);
    if (desktopMq) {
      if (typeof desktopMq.addEventListener === 'function') desktopMq.addEventListener('change', handleLayoutChange);
      else if (typeof desktopMq.addListener === 'function') desktopMq.addListener(handleLayoutChange);
    }
    syncSidebarA11y();

    // 全屏随手右滑打开左侧抽屉 & 左滑关闭抽屉（仅移动端启用）
    let swipeState = null;
    document.addEventListener('touchstart', (e) => {
      if (isDesktopLayout() || e.touches.length !== 1) { swipeState = null; return; }
      const t = e.touches[0];
      const isOpen = backdropEl.classList.contains('open');
      const target = e.target;
      if (!isOpen) {
        if (!$('quota-drawer').hidden || !$('sheet-backdrop').hidden || !$('proj-modal-backdrop').hidden) return;
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
      if (!swipeState || isDesktopLayout() || e.touches.length !== 1) return;
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
      const maxH = isDesktopLayout() ? 200 : 148;
      ta.style.height = Math.min(maxH, Math.max(28, ta.scrollHeight)) + 'px';
      syncSendButtonUI();
    };
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('focus', () => { setTimeout(syncViewportHeight, 120); });
    ta.addEventListener('blur', () => { setTimeout(syncViewportHeight, 80); });
    ta.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imgFiles = [];
      for (const it of items) {
        if (String(it.type || '').startsWith('image/')) {
          const f = it.getAsFile?.();
          if (f) imgFiles.push(f);
        }
      }
      if (!imgFiles.length) {
        const directFiles = Array.from(e.clipboardData?.files || []).filter((f) => String(f.type || '').startsWith('image/'));
        imgFiles.push(...directFiles);
      }
      if (imgFiles.length) {
        e.preventDefault();
        void uploadImageFiles(imgFiles);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('proj-modal-backdrop').hidden) { closeCreateProjectModal(); return; }
      if (!$('sheet-backdrop').hidden) { $('sheet-backdrop').hidden = true; return; }
      if (!$('quota-drawer').hidden) { $('quota-drawer').hidden = true; return; }
      if (!isDesktopLayout() && backdropEl.classList.contains('open')) closeDrawer();
    });

    async function sendInput() {
      if (sending) return;
      const rawText = ta.value.trim();
      if (!rawText && !uploadedNames.length && latestSnap?.busy) {
        try {
          const r = await apiAction({ action: 'stop' });
          if (r?.ok) showToast('已请求停止生成');
          else showToast(r?.error || r?.actionResult?.error || '停止失败');
        } catch (err) {
          showToast(err?.message || '停止失败');
        }
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
          showToast(r?.error || r?.actionResult?.error || '发送失败');
        }
      } catch (err) {
        showToast(err?.message || '发送失败');
      } finally {
        sending = false;
        $('btn-send').disabled = false;
        syncSendButtonUI();
      }
    }
    $('btn-send').addEventListener('click', sendInput);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        void sendInput();
      }
    });

    renderModeEntryGate(
      isManualEntry
        ? ('正在通过 ' + getActiveChannelLabel() + ' 连接 Mac…')
        : '正在自动连接最佳通道，也可直接点击已开启的方式立即进入：'
    );
    void fetchSnapshot();
  })();
  </script>
</body>
</html>`;
}

// ==================== HTTP 服务器管理器（双栈监听，入口强制仅放行本机及内网私网/Tailscale 来源） ====================

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let settled = false;
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      len += buf.length;
      if (len > MAX_ACTION_BODY_BYTES) {
        try { req.pause(); } catch {}
        finishErr(Object.assign(new Error('请求体过大'), { status: 413 }));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = chunks.length ? Buffer.concat(chunks, len).toString('utf8') : '';
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { status: 400 }));
      }
    });
    req.on('close', () => {
      if (!settled && !req.complete) {
        finishErr(Object.assign(new Error('请求连接已中断'), { status: 400 }));
      }
    });
    req.on('error', finishErr);
  });
}

function isAllowedPrivateOrigin(rawOrigin, extraOrigin = '') {
  if (!rawOrigin || typeof rawOrigin !== 'string') return false;
  try {
    const u = new URL(rawOrigin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (extraOrigin) {
      try {
        const eu = new URL(extraOrigin);
        if (u.origin === eu.origin) return true;
      } catch {}
    }
    const cleanHost = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!cleanHost) return false;
    if (cleanHost === 'localhost' || cleanHost.endsWith('.local') || cleanHost.endsWith('.ts.net')) return true;
    return isAllowedPrivateAddress(cleanHost);
  } catch {
    return false;
  }
}

// ==================== Cloudflare Tunnel 管理 (免登录 Quick Tunnel + 自有账号 Named Tunnel) ====================

function resolveCloudflaredBinary() {
  const candidates = [];
  if (process.env.AG_CLOUDFLARED_BIN) candidates.push(process.env.AG_CLOUDFLARED_BIN);
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
    );
  } else {
    candidates.push(
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
      '/usr/bin/cloudflared'
    );
  }
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['cloudflared'], {
      timeout: 600,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).split(/\r?\n/)[0]?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return '';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeTunnelStateFile(payload) {
  const stPath = getTunnelStatePath();
  safeWriteJsonSync(stPath, payload, { indent: 2 });
  try {
    fs.chmodSync(stPath, 0o600);
  } catch {}
}

function removeTunnelStateFile() {
  try {
    const stPath = getTunnelStatePath();
    if (fs.existsSync(stPath)) fs.unlinkSync(stPath);
  } catch {}
}

function reapStaleCloudflaredPid() {
  const stPath = getTunnelStatePath();
  const loaded = safeReadJsonSync(stPath, null);
  if (!loaded.ok || !loaded.data || !Number.isInteger(loaded.data.pid)) {
    removeTunnelStateFile();
    return false;
  }
  const pid = loaded.data.pid;
  if (!isPidAlive(pid)) {
    removeTunnelStateFile();
    return false;
  }
  let shouldKill = process.platform === 'win32';
  if (!shouldKill) {
    try {
      const cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        timeout: 600,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      shouldKill = /cloudflared/i.test(cmdline);
    } catch {}
  }
  if (shouldKill) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  removeTunnelStateFile();
  return shouldKill;
}

function readPersistedTunnelStatus() {
  const cfg = loadOrCreateRemoteConfig();
  if (!cfg.tunnelEnabled) {
    return {
      enabled: false,
      mode: cfg.tunnelMode,
      state: 'stopped',
      pid: null,
      publicUrl: '',
      error: '',
      binaryAvailable: Boolean(resolveCloudflaredBinary())
    };
  }
  const loaded = safeReadJsonSync(getTunnelStatePath(), null);
  if (loaded.ok && loaded.data && Number.isInteger(loaded.data.pid) && isPidAlive(loaded.data.pid)) {
    return {
      enabled: true,
      mode: loaded.data.mode === 'named' ? 'named' : 'quick',
      state: loaded.data.state || 'running',
      pid: loaded.data.pid,
      publicUrl: String(loaded.data.publicUrl || ''),
      error: String(loaded.data.error || ''),
      binaryAvailable: Boolean(resolveCloudflaredBinary())
    };
  }
  return {
    enabled: true,
    mode: cfg.tunnelMode,
    state: 'stopped',
    pid: null,
    publicUrl: '',
    error: '',
    binaryAvailable: Boolean(resolveCloudflaredBinary())
  };
}

function createCloudflareTunnelController(getPort) {
  let child = null;
  let state = 'stopped';
  let publicUrl = '';
  let errorMsg = '';
  let mode = 'quick';
  let killEscalationTimer = null;
  let lastAutoRetryAt = 0;

  const getStatus = () => {
    const cfg = loadOrCreateRemoteConfig();
    return {
      enabled: Boolean(cfg.tunnelEnabled),
      mode: cfg.tunnelMode || mode,
      state,
      pid: (child && child.pid && isPidAlive(child.pid)) ? child.pid : null,
      publicUrl: state === 'running' ? publicUrl : '',
      error: errorMsg,
      binaryAvailable: Boolean(resolveCloudflaredBinary())
    };
  };

  const stop = async () => {
    if (killEscalationTimer) {
      clearTimeout(killEscalationTimer);
      killEscalationTimer = null;
    }
    const target = child;
    child = null;
    state = 'stopped';
    publicUrl = '';
    errorMsg = '';
    removeTunnelStateFile();
    if (target && !target.killed) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        target.once('exit', finish);
        try { target.kill('SIGTERM'); } catch { finish(); }
        killEscalationTimer = setTimeout(() => {
          try { target.kill('SIGKILL'); } catch {}
          finish();
        }, 450);
        killEscalationTimer.unref?.();
      });
    }
    return getStatus();
  };

  const start = async (overrideCfg = null) => {
    let cfg = overrideCfg || loadOrCreateRemoteConfig();
    mode = cfg.tunnelMode === 'named' ? 'named' : 'quick';
    if (!cfg.tunnelEnabled) {
      return await stop();
    }
    const bin = resolveCloudflaredBinary();
    if (!bin) {
      state = 'error';
      publicUrl = '';
      errorMsg = '未检测到 cloudflared（macOS 可执行 brew install cloudflared 安装）';
      return getStatus();
    }
    if (mode === 'named') {
      const hostCheck = validateTunnelHostname(cfg.tunnelHostname);
      if (!hostCheck.ok) {
        state = 'error';
        publicUrl = '';
        errorMsg = !String(cfg.tunnelHostname || '').trim()
          ? '请先填写有效的 Cloudflare 固定域名 (https://...) 与 Tunnel Token'
          : hostCheck.error;
        return getStatus();
      }
      const tokCheck = validateCloudflareTunnelToken(cfg.tunnelToken);
      if (!tokCheck.ok) {
        state = 'error';
        publicUrl = '';
        errorMsg = !String(cfg.tunnelToken || '').trim()
          ? '请先填写有效的 Cloudflare 固定域名 (https://...) 与 Tunnel Token'
          : tokCheck.error;
        return getStatus();
      }
      if (tokCheck.token && tokCheck.token !== cfg.tunnelToken) {
        cfg = { ...cfg, tunnelToken: tokCheck.token };
      }
    }

    if (child) await stop();
    mode = cfg.tunnelMode === 'named' ? 'named' : 'quick';
    state = 'starting';
    publicUrl = '';
    errorMsg = '';

    const port = Number(typeof getPort === 'function' ? getPort() : cfg.port) || DEFAULT_REMOTE_PORT;
    const args = mode === 'named'
      ? ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run']
      : ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`];

    const childEnv = { ...process.env };
    const appendNoProxy = (cur) => {
      const base = String(cur || '').trim();
      const parts = base ? base.split(',').map((s) => s.trim()).filter(Boolean) : [];
      for (const local of ['127.0.0.1', 'localhost', '::1']) {
        if (!parts.includes(local)) parts.push(local);
      }
      return parts.join(',');
    };
    childEnv.NO_PROXY = appendNoProxy(childEnv.NO_PROXY);
    childEnv.no_proxy = appendNoProxy(childEnv.no_proxy);
    try {
      const proxyCfg = detectProxyConfig();
      const proxyUrl = proxyCfg?.httpProxy || proxyCfg?.allProxy || proxyCfg?.url;
      if (proxyCfg?.enabled && proxyUrl && !childEnv.HTTPS_PROXY && !childEnv.https_proxy) {
        childEnv.HTTPS_PROXY = proxyUrl;
        childEnv.HTTP_PROXY = proxyUrl;
      }
    } catch {}
    if (mode === 'named') {
      childEnv.TUNNEL_TOKEN = cfg.tunnelToken;
    }

    return await new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve(getStatus());
      };

      const waitTimer = setTimeout(settle, 9000);
      waitTimer.unref?.();

      const spawned = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
        windowsHide: true
      });
      child = spawned;
      let lastErrLine = '';

      const handleChunk = (buf) => {
        if (child !== spawned) return;
        const text = String(buf || '');
        const cleanLines = text
          .replace(/\x1b\[[0-9;]*m/g, '')
          .replace(/\beyJ[A-Za-z0-9+/_-]{8,}=*(?:\.[A-Za-z0-9+/_-]+=*)*/g, '[REDACTED]')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of cleanLines) {
          if (/\b(?:ERR|FTL|FATAL)\b/i.test(line) || /\bfailed to\b/i.test(line)) {
            lastErrLine = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+(?:ERR|FTL)\s*/i, '').slice(0, 180);
          }
        }
        if (mode === 'quick') {
          const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
          if (m) {
            publicUrl = m[0];
            state = 'running';
            errorMsg = '';
            writeTunnelStateFile({
              pid: spawned.pid,
              mode,
              state,
              publicUrl,
              error: '',
              startedAt: Date.now()
            });
            clearTimeout(waitTimer);
            settle();
          } else {
            const mErr = text.match(/failed to request quick Tunnel:\s*([^\r\n]+)/i);
            if (mErr) errorMsg = `Cloudflare 临时隧道连接失败: ${mErr[1].trim()}`;
          }
        } else {
          if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(text)) {
            publicUrl = cfg.tunnelHostname;
            state = 'running';
            errorMsg = '';
            writeTunnelStateFile({
              pid: spawned.pid,
              mode,
              state,
              publicUrl,
              error: '',
              startedAt: Date.now()
            });
            clearTimeout(waitTimer);
            settle();
          } else if (/(?:failed to unmarshal|Provided Tunnel token is not valid|Unauthorized|ERR .*token)/i.test(text)) {
            errorMsg = 'Cloudflare Tunnel Token 无效或已被吊销';
          }
        }
      };

      spawned.stdout?.on('data', handleChunk);
      spawned.stderr?.on('data', handleChunk);

      spawned.once('error', (err) => {
        if (child !== spawned) return;
        child = null;
        state = 'error';
        publicUrl = '';
        errorMsg = err?.message || '启动 cloudflared 失败';
        removeTunnelStateFile();
        clearTimeout(waitTimer);
        settle();
      });

      spawned.once('exit', (code) => {
        if (child !== spawned) return;
        child = null;
        if (state !== 'stopped') {
          state = 'error';
          publicUrl = '';
          if (!errorMsg) {
            errorMsg = lastErrLine
              ? `cloudflared 异常退出: ${lastErrLine}`
              : `cloudflared 意外退出 (code=${code ?? 'signal'})`;
          }
        }
        removeTunnelStateFile();
        clearTimeout(waitTimer);
        settle();
      });
    });
  };

  const ensureRunning = () => {
    const cfg = loadOrCreateRemoteConfig();
    if (!cfg.tunnelEnabled) return getStatus();
    if (state === 'running' || state === 'starting') return getStatus();
    const now = Date.now();
    if (state === 'error' && now - lastAutoRetryAt < 8000) return getStatus();
    lastAutoRetryAt = now;
    void start(cfg);
    return getStatus();
  };

  return {
    start,
    stop,
    getStatus,
    ensureRunning,
    configure: async (patch = {}) => {
      const prevCfg = loadOrCreateRemoteConfig();
      const patchCh = (patch.enabledChannels && typeof patch.enabledChannels === 'object') ? patch.enabledChannels : {};
      const nextTunnelEnabled = patch.enabled !== undefined
        ? Boolean(patch.enabled)
        : (patch.tunnelEnabled !== undefined
            ? Boolean(patch.tunnelEnabled)
            : (typeof patchCh.tunnel === 'boolean' ? patchCh.tunnel : prevCfg.tunnelEnabled));
      const nextModeRaw = patch.tunnelMode !== undefined ? patch.tunnelMode : prevCfg.tunnelMode;
      const nextMode = nextModeRaw === 'named' ? 'named' : 'quick';
      const touchesTunnel = patch.enabled !== undefined
        || patch.tunnelEnabled !== undefined
        || patch.tunnelMode !== undefined
        || patch.tunnelHostname !== undefined
        || patch.tunnelToken !== undefined
        || typeof patchCh.tunnel === 'boolean';

      let validationError = '';
      if (patch.tunnelToken !== undefined && String(patch.tunnelToken || '').trim()) {
        const tokCheck = validateCloudflareTunnelToken(patch.tunnelToken);
        if (!tokCheck.ok) validationError = tokCheck.error;
      }
      if (!validationError && touchesTunnel && nextTunnelEnabled && nextMode === 'named') {
        const hostRaw = patch.tunnelHostname !== undefined ? patch.tunnelHostname : prevCfg.tunnelHostname;
        const hostCheck = validateTunnelHostname(hostRaw);
        if (!hostCheck.ok) {
          validationError = hostCheck.error;
        } else {
          const effTokenRaw = patch.tunnelToken !== undefined ? patch.tunnelToken : prevCfg.tunnelToken;
          const tokCheck = validateCloudflareTunnelToken(effTokenRaw);
          if (!tokCheck.ok) {
            validationError = !String(effTokenRaw || '').trim()
              ? '请粘贴 Cloudflare Tunnel Token 或 cloudflared service install 命令'
              : tokCheck.error;
          }
        }
      }
      if (validationError) {
        if (child) await stop();
        state = 'error';
        publicUrl = '';
        errorMsg = validationError;
        return getStatus();
      }

      const nextCfg = saveRemoteTunnelConfig(patch);
      if (!nextCfg.tunnelEnabled) {
        await stop();
        return getStatus();
      }
      const tunnelConfigChanged = prevCfg.tunnelEnabled !== nextCfg.tunnelEnabled
        || prevCfg.tunnelMode !== nextCfg.tunnelMode
        || prevCfg.tunnelHostname !== nextCfg.tunnelHostname
        || prevCfg.tunnelToken !== nextCfg.tunnelToken;
      if (!tunnelConfigChanged && (state === 'running' || state === 'starting')) {
        errorMsg = '';
        return getStatus();
      }
      await stop();
      return await start(nextCfg);
    }
  };
}

function createRemoteHttpHandler(initialConfig, options = {}) {
  const getTunnelOrigin = typeof options.getTunnelOrigin === 'function' ? options.getTunnelOrigin : () => '';
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

  // 按客户端 IP 统计失败 Token 次数（60 秒窗口内失败 12 次触发限流 429）
  const failedAuthMap = new Map();
  const RATE_LIMIT_WINDOW_MS = 60000;
  const RATE_LIMIT_MAX_FAILS = 12;

  const isRateLimited = (clientKey) => {
    const rec = failedAuthMap.get(clientKey);
    if (!rec) return false;
    if (Date.now() - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
      failedAuthMap.delete(clientKey);
      return false;
    }
    return rec.count >= RATE_LIMIT_MAX_FAILS;
  };

  const recordAuthFailure = (clientKey) => {
    const now = Date.now();
    if (failedAuthMap.size > 512) {
      for (const [k, v] of failedAuthMap.entries()) {
        if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) failedAuthMap.delete(k);
      }
    }
    const prev = failedAuthMap.get(clientKey);
    if (!prev || now - prev.windowStart > RATE_LIMIT_WINDOW_MS) {
      failedAuthMap.set(clientKey, { count: 1, windowStart: now });
    } else {
      prev.count += 1;
    }
  };

  const cachedHtml = buildMobileAppHtml();
  const cachedIcon = buildMobileIconSvg();
  const cachedManifest = buildManifestJson();
  const cachedSw = buildServiceWorkerJs();
  const cached401 = buildUnauthorizedHtml();

  return async (req, res) => {
    const config = getActiveConfig();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const HTML_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; base-uri 'none'; frame-ancestors 'none'";
    const remoteIp = req.socket?.remoteAddress || '';
    if (!isAllowedPrivateAddress(remoteIp)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden: Private network only');
      return;
    }

    const activeTunnelUrl = getTunnelOrigin() || readPersistedTunnelStatus().publicUrl || config.tunnelHostname || '';
    const reqOrigin = String(req.headers.origin || '').trim();
    if (reqOrigin && isAllowedPrivateOrigin(reqOrigin, activeTunnelUrl)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AG-Remote-Token, X-AG-Device-Id, X-AG-Device-Hint');
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

    const reqChannel = detectRequestChannel(req, activeTunnelUrl);
    const enabledMap = config.enabledChannels || {
      lan: true,
      tailscale: true,
      bonjour: true,
      tunnel: Boolean(config.tunnelEnabled)
    };
    if (reqChannel !== 'loopback' && !enabledMap[reqChannel]) {
      const chNames = { lan: '局域网', tailscale: 'Tailscale', bonjour: 'Bonjour', tunnel: 'Cloudflare 隧道' };
      const msg = `${chNames[reqChannel] || reqChannel} 连接方式已停用`;
      if (pathname.startsWith('/api/')) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, channelDisabled: reqChannel, error: msg }));
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`403 Forbidden: ${msg}`);
      }
      return;
    }

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

    const fromLoopback = !remoteIp || isLoopbackIp(remoteIp);
    const clientKey = String((fromLoopback && req.headers['cf-connecting-ip']) || normalizeRemoteIp(remoteIp) || 'unknown');
    if (isRateLimited(clientKey)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
      res.end(JSON.stringify({ ok: false, error: 'Too many failed auth attempts. Retry in 60s.' }));
      return;
    }

    const { token, fromQuery, fromCookie, uiVersion } = extractRequestToken(req, urlObj);
    const authed = timingSafeTokenMatch(token, config.token);
    if (!authed) {
      recordAuthFailure(clientKey);
      if (pathname.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '未授权，请在终端运行 ag-context-meter remote 重新扫码' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_CSP });
        res.end(cached401);
      }
      return;
    }
    failedAuthMap.delete(clientKey);

    const isHttpsForwarded = fromLoopback && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
    const secureAttr = isHttpsForwarded ? '; Secure' : '';
    const cookiesToSet = [];
    if (fromQuery) {
      cookiesToSet.push(`ag_remote_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=31536000`);
    }

    if (pathname === '/' || pathname === '/api/ping' || pathname === '/api/snapshot' || pathname === '/api/action') {
      recordPairedDeviceAccess(req, config.token, Date.now(), activeTunnelUrl);
    }

    if (req.method === 'GET' && pathname === '/') {
      if (uiVersion !== MOBILE_UI_VERSION) {
        cookiesToSet.push(`ag_ui_ver=${MOBILE_UI_VERSION}; Path=/; SameSite=Lax${secureAttr}; Max-Age=31536000`);
      }
      if (cookiesToSet.length) res.setHeader('Set-Cookie', cookiesToSet);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_CSP });
      res.end(cachedHtml);
      return;
    }

    if (cookiesToSet.length) {
      res.setHeader('Set-Cookie', cookiesToSet);
    }

    if (req.method === 'GET' && pathname === '/api/ping') {
      const snapInfo = collectFusedEndpointDescriptor(config.port, activeTunnelUrl ? {
        enabled: Boolean(config.tunnelEnabled),
        state: 'running',
        publicUrl: activeTunnelUrl,
        mode: config.tunnelMode
      } : null, config.enabledChannels);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        port: config.port,
        name: snapInfo.deviceName,
        hosts: snapInfo.hosts,
        endpoints: snapInfo.endpoints,
        enabledChannels: config.enabledChannels
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      if ((fromCookie || uiVersion) && uiVersion !== MOBILE_UI_VERSION) {
        res.setHeader('Set-Cookie', `ag_ui_ver=${MOBILE_UI_VERSION}; Path=/; SameSite=Lax${secureAttr}; Max-Age=31536000`);
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, reloadRequired: true, error: '界面已升级，正在自动刷新…' }));
        return;
      }
      try {
        const targetId = urlObj.searchParams.get('targetId') || '';
        const rawLimit = urlObj.searchParams.get('convLimit');
        const convLimit = rawLimit === 'all' || rawLimit === '0'
          ? 0
          : (rawLimit !== null && rawLimit !== '' ? Math.max(1, Number.parseInt(rawLimit, 10) || 100) : 100);
        const rawMsgLimit = urlObj.searchParams.get('msgLimit');
        const msgLimit = rawMsgLimit === 'all' || rawMsgLimit === '0'
          ? 0
          : (rawMsgLimit !== null && rawMsgLimit !== '' ? Math.max(1, Number.parseInt(rawMsgLimit, 10) || 30) : 30);
        const snap = await fetchSnapshotFromTarget(targetId, { convLimit, msgLimit });
        let payloadOut = snap;
        if (snap && snap.ok !== false) {
          const snapInfo = collectFusedEndpointDescriptor(config.port, activeTunnelUrl ? {
            enabled: Boolean(config.tunnelEnabled),
            state: 'running',
            publicUrl: activeTunnelUrl,
            mode: config.tunnelMode
          } : null, config.enabledChannels);
          payloadOut = {
            ...snap,
            hosts: snapInfo.hosts,
            endpoints: snapInfo.endpoints,
            enabledChannels: config.enabledChannels
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payloadOut));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取 Antigravity 状态失败' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      try {
        const projectId = urlObj.searchParams.get('projectId') || '';
        const offset = Math.max(0, Number.parseInt(urlObj.searchParams.get('offset') || '0', 10) || 0);
        const rawLimit = urlObj.searchParams.get('limit') || '100';
        const limit = (rawLimit === 'all' || rawLimit === '0') ? 0 : Math.max(1, Number.parseInt(rawLimit, 10) || 100);
        const page = listCatalogConversations({ projectId, offset, limit });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(page));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取会话列表失败' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/messages') {
      try {
        const sessionId = urlObj.searchParams.get('sessionId') || '';
        if (!String(sessionId).trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '缺少 sessionId 参数' }));
          return;
        }
        const before = urlObj.searchParams.get('before');
        const rawLimit = urlObj.searchParams.get('limit') || '30';
        const limit = Math.max(1, Math.min(200, Number.parseInt(rawLimit, 10) || 30));
        const page = await getConversationMessagesPage({ sessionId, before, limit });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(page));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取会话消息失败' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/fs/dirs') {
      try {
        const dirPath = urlObj.searchParams.get('path') || '';
        const rawHidden = String(urlObj.searchParams.get('showHidden') || '').trim().toLowerCase();
        const showHidden = rawHidden === '1' || rawHidden === 'true';
        const listing = listHostDirectories({
          dirPath,
          showHidden,
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.configDir ? { configDir: options.configDir } : {})
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(listing));
      } catch (err) {
        res.writeHead(err?.status || 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取目录失败' }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/fs/mkdir') {
      try {
        const payload = await readJsonBody(req);
        const result = createHostSubdirectory(payload, {
          ...(options.homeDir ? { homeDir: options.homeDir } : {})
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const errHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (err?.status === 413) errHeaders.Connection = 'close';
        res.writeHead(err?.status || 400, errHeaders);
        res.end(JSON.stringify({ ok: false, error: err?.message || '创建文件夹失败' }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/projects') {
      try {
        const payload = await readJsonBody(req);
        const createdRes = await createRemoteProject(payload, {
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.configDir ? { configDir: options.configDir } : {}),
          ...(options.localApiConnect ? { localApiConnect: options.localApiConnect } : {}),
          ...(options.allowDiskFallback !== undefined ? { allowDiskFallback: options.allowDiskFallback } : {})
        });
        const shouldNavigate = payload?.openInDesktop !== false && options.openInDesktop !== false && Boolean(createdRes?.project?.id);
        let navOk = shouldNavigate ? false : null;
        let navError = '';
        let navResult = null;
        let snapshot = null;
        const doPerformAction = typeof options.performAction === 'function' ? options.performAction : performActionInTarget;
        const doFetchSnapshot = typeof options.fetchSnapshot === 'function' ? options.fetchSnapshot : fetchSnapshotFromTarget;
        if (shouldNavigate) {
          const checkNavOk = (r) => Boolean(r && r.ok !== false && (!r.actionResult || r.actionResult.ok !== false));
          if (!createdRes.alreadyExists && !options.performAction) {
            await new Promise((r) => setTimeout(r, 180));
          }
          let actionRes = await doPerformAction({
            action: 'new-conversation',
            projectId: createdRes.project.id,
            targetId: payload?.targetId || ''
          }).catch((err) => ({ ok: false, error: err?.message || '未能切换桌面端至新建项目' }));
          if (!checkNavOk(actionRes) && !createdRes.alreadyExists && !options.performAction) {
            await new Promise((r) => setTimeout(r, 350));
            actionRes = await doPerformAction({
              action: 'new-conversation',
              projectId: createdRes.project.id,
              targetId: payload?.targetId || ''
            }).catch((err) => ({ ok: false, error: err?.message || '未能切换桌面端至新建项目' }));
          }
          const rawNav = (actionRes?.actionResult && typeof actionRes.actionResult === 'object')
            ? actionRes.actionResult
            : (actionRes && typeof actionRes === 'object' ? actionRes : {});
          navOk = checkNavOk(actionRes);
          navError = navOk ? '' : String(rawNav.error || actionRes?.error || '桌面端未能进入该项目新对话');
          navResult = {
            ...rawNav,
            ok: navOk,
            ...(navError ? { error: navError } : {})
          };
          snapshot = actionRes?.snapshot || await doFetchSnapshot(payload?.targetId || '', { convLimit: 100, bypassCache: true }).catch(() => null);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ...createdRes,
          navOk,
          navError,
          navResult,
          snapshot
        }));
      } catch (err) {
        const errHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (err?.status === 413) errHeaders.Connection = 'close';
        res.writeHead(err?.status || 400, errHeaders);
        res.end(JSON.stringify({ ok: false, error: err?.message || '创建项目失败' }));
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
        const errHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
        if (err?.status === 413) errHeaders.Connection = 'close';
        res.writeHead(err?.status || 500, errHeaders);
        res.end(JSON.stringify({ ok: false, error: err?.message || '操作失败' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  };
}

function startMobileRemoteServer() {
  reapStaleCloudflaredPid();
  const config = loadOrCreateRemoteConfig();
  const tunnelCtrl = createCloudflareTunnelController(() => config.port);
  const handler = createRemoteHttpHandler(config, {
    getTunnelOrigin: () => tunnelCtrl.getStatus().publicUrl || ''
  });
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
    } else {
      ifaceTimer = setInterval(() => {
        if (!stopped) void syncBindings();
      }, 15000);
      ifaceTimer.unref?.();
      await syncBindings();
      const activeIps = Array.from(boundServers.keys());
      if (activeIps.length) {
        console.log(`Mobile Remote PWA ready on port ${config.port} (${activeIps.join(', ')})`);
      }
    }
    const latestCfg = loadOrCreateRemoteConfig();
    if (!stopped && latestCfg.tunnelEnabled) {
      void tunnelCtrl.start(latestCfg);
    }
  });

  const stop = async () => {
    stopped = true;
    if (ifaceTimer) clearInterval(ifaceTimer);
    for (const srv of boundServers.values()) {
      try { srv.close(); } catch {}
    }
    boundServers.clear();
    await tunnelCtrl.stop();
  };

  process.once('exit', () => {
    try { void tunnelCtrl.stop(); } catch {}
  });

  return {
    config,
    getBoundAddresses: () => (boundServers.has('::') ? enumerateLocalAddresses().bindIps : Array.from(boundServers.keys())),
    getTunnelStatus: () => tunnelCtrl.getStatus(),
    ensureTunnelRunning: () => tunnelCtrl.ensureRunning(),
    configureTunnel: (patch) => tunnelCtrl.configure(patch),
    stop
  };
}

function collectFusedEndpointDescriptor(port, tunnelStatus = null, enabledChannels = null) {
  const { tailscale, lan, physicalLan } = enumerateLocalAddresses();
  const meta = detectHostIdentityMeta();
  const primaryLan = physicalLan[0] || lan[0] || null;
  const secondaryLan = physicalLan[1] || null;
  const en = {
    lan: enabledChannels?.lan !== false,
    tailscale: enabledChannels?.tailscale !== false,
    bonjour: enabledChannels?.bonjour !== false,
    tunnel: enabledChannels?.tunnel !== false
  };

  const endpoints = [];
  const seenHosts = new Set();
  const addEp = (host, kind, priority, iface = '') => {
    const cleanHost = String(host || '').trim();
    if (!cleanHost || seenHosts.has(cleanHost) || endpoints.length >= 6) return;
    seenHosts.add(cleanHost);
    endpoints.push({
      url: `http://${formatHostForUrl(cleanHost)}:${port}`,
      host: cleanHost,
      kind,
      priority,
      iface
    });
  };

  if (en.lan && primaryLan) addEp(primaryLan.address, 'lan', 0, primaryLan.iface);
  if (en.lan && secondaryLan) addEp(secondaryLan.address, 'lan', 50, secondaryLan.iface);
  if (en.tailscale && tailscale[0]) addEp(tailscale[0].address, 'tailscale', 100, tailscale[0].iface);
  if (en.tailscale && tailscale.length > 0 && meta.tailscaleDnsName) {
    addEp(meta.tailscaleDnsName, 'tailscale', 150, tailscale[0]?.iface || 'utun0');
  }
  if (en.bonjour && meta.bonjourHost && primaryLan) {
    addEp(meta.bonjourHost, 'bonjour', 200, primaryLan.iface);
  }
  const tunnelUrl = String(tunnelStatus?.publicUrl || '').trim().replace(/\/+$/, '');
  if (en.tunnel && tunnelStatus?.enabled && tunnelStatus?.state === 'running' && /^https:\/\//i.test(tunnelUrl)) {
    try {
      const tu = new URL(tunnelUrl);
      if (!seenHosts.has(tu.host)) {
        seenHosts.add(tu.host);
        endpoints.push({
          url: tunnelUrl,
          host: tu.host,
          kind: 'tunnel',
          priority: 250,
          iface: 'cloudflare'
        });
      }
    } catch {}
  }
  const anyEnabled = en.lan || en.tailscale || en.bonjour || en.tunnel;
  if (endpoints.length === 0 && anyEnabled) {
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

function buildRemoteInfo({ resetToken = false, tunnelStatus = null } = {}) {
  const cfg = loadOrCreateRemoteConfig({ resetToken });
  if (resetToken) {
    pairedDevicesMap.clear();
    trackedDeviceToken = cfg.token;
  }
  const devSummary = getPairedDevicesSummary(cfg.token);
  const persisted = readPersistedTunnelStatus();
  const effTunnel = (tunnelStatus && typeof tunnelStatus === 'object')
    ? {
        enabled: tunnelStatus.enabled !== undefined ? Boolean(tunnelStatus.enabled) : Boolean(cfg.tunnelEnabled),
        mode: tunnelStatus.mode || cfg.tunnelMode,
        state: tunnelStatus.state || (cfg.tunnelEnabled ? persisted.state : 'stopped'),
        pid: tunnelStatus.pid || persisted.pid || null,
        publicUrl: (tunnelStatus.publicUrl || (cfg.tunnelEnabled ? persisted.publicUrl : '') || '').replace(/\/+$/, ''),
        error: tunnelStatus.error || '',
        binaryAvailable: tunnelStatus.binaryAvailable !== undefined ? Boolean(tunnelStatus.binaryAvailable) : Boolean(resolveCloudflaredBinary())
      }
    : persisted;

  const desc = collectFusedEndpointDescriptor(cfg.port, effTunnel, cfg.enabledChannels);

  const mkFused = (entryHost, entryBaseUrl = '') => buildFusedPairingUrl({
    entryBaseUrl,
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

  const tunnelActiveUrl = (effTunnel.enabled && effTunnel.state === 'running' && /^https:\/\//i.test(effTunnel.publicUrl))
    ? effTunnel.publicUrl
    : '';
  let tunnelHostDisplay = '';
  if (tunnelActiveUrl) {
    try { tunnelHostDisplay = new URL(tunnelActiveUrl).host; } catch {}
  }

  const enCh = cfg.enabledChannels || { lan: true, tailscale: true, bonjour: true, tunnel: Boolean(cfg.tunnelEnabled) };
  const tunnelChannel = {
    key: 'tunnel',
    label: 'Cloudflare 隧道',
    labelEn: 'Cloudflare Tunnel',
    enabled: Boolean(enCh.tunnel),
    detected: Boolean(effTunnel.binaryAvailable),
    available: Boolean(enCh.tunnel && tunnelActiveUrl),
    state: effTunnel.state || 'stopped',
    mode: cfg.tunnelMode || 'quick',
    binaryAvailable: Boolean(effTunnel.binaryAvailable),
    hasTunnelToken: Boolean(cfg.tunnelToken),
    tunnelHostname: cfg.tunnelHostname || '',
    error: effTunnel.error || '',
    rawHost: tunnelHostDisplay,
    displayHost: !enCh.tunnel
      ? '已停用'
      : (tunnelHostDisplay
          ? (cfg.tunnelMode === 'named' ? tunnelHostDisplay : `随时随地 · ${tunnelHostDisplay}`)
          : (effTunnel.state === 'starting'
              ? '正在分配公网隧道…'
              : (effTunnel.error || '未就绪'))),
    entryHost: tunnelHostDisplay,
    entryBaseUrl: tunnelActiveUrl,
    iface: 'cloudflare'
  };

  const mkQrSafe = (entryHost, entryBaseUrl = '') => {
    const full = mkFused(entryHost, entryBaseUrl);
    try {
      return { url: full, qrSvg: renderQrSvg(full) };
    } catch {
      const compactEps = (desc.endpoints || []).filter((e) => e.kind === 'tunnel' || e.priority === 0 || e.priority === 100);
      const compact = buildFusedPairingUrl({
        entryBaseUrl,
        entryHost,
        port: cfg.port,
        token: cfg.token,
        name: desc.deviceName,
        hosts: [],
        endpoints: compactEps
      });
      try {
        return { url: compact, qrSvg: renderQrSvg(compact) };
      } catch {
        const bare = entryBaseUrl
          ? `${entryBaseUrl.replace(/\/+$/, '')}/?token=${encodeURIComponent(cfg.token)}`
          : `http://${formatHostForUrl(entryHost)}:${cfg.port}/?token=${encodeURIComponent(cfg.token)}`;
        return { url: bare, qrSvg: renderQrSvg(bare) };
      }
    }
  };

  const channels = [
    {
      key: 'lan',
      label: '局域网',
      labelEn: 'LAN',
      enabled: Boolean(enCh.lan),
      detected: Boolean(desc.primaryLan),
      available: Boolean(enCh.lan && desc.primaryLan),
      rawHost: lanEntryHost,
      displayHost: enCh.lan ? lanEntryHost : (lanEntryHost ? `已停用 · ${lanEntryHost}` : '已停用'),
      entryHost: lanEntryHost,
      iface: desc.primaryLan?.iface || ''
    },
    {
      key: 'tailscale',
      label: 'Tailscale',
      labelEn: 'Tailscale',
      enabled: Boolean(enCh.tailscale),
      detected: desc.tailscale.length > 0,
      available: Boolean(enCh.tailscale && desc.tailscale.length > 0),
      rawHost: tsDisplayHost,
      displayHost: enCh.tailscale ? tsDisplayHost : (tsDisplayHost ? `已停用 · ${tsDisplayHost}` : '已停用'),
      entryHost: tsEntryHost,
      iface: desc.tailscale[0]?.iface || ''
    },
    {
      key: 'bonjour',
      label: 'Bonjour',
      labelEn: 'Bonjour',
      enabled: Boolean(enCh.bonjour),
      detected: Boolean(bonjourEntryHost),
      available: Boolean(enCh.bonjour && bonjourEntryHost),
      rawHost: bonjourEntryHost,
      displayHost: enCh.bonjour ? bonjourEntryHost : (bonjourEntryHost ? `已停用 · ${bonjourEntryHost}` : '已停用'),
      entryHost: bonjourEntryHost,
      iface: desc.primaryLan?.iface || ''
    },
    tunnelChannel
  ].map((ch) => {
    if (!ch.available || (!ch.entryHost && !ch.entryBaseUrl)) return { ...ch, url: '', qrSvg: '' };
    const { url, qrSvg } = mkQrSafe(ch.entryHost, ch.entryBaseUrl || '');
    return { ...ch, url, qrSvg };
  });

  const tailscaleUrls = enCh.tailscale ? desc.tailscale.map((x) => ({ ...x, ...mkQrSafe(x.address) })) : [];
  const lanUrls = enCh.lan ? desc.lan.map((x) => ({ ...x, ...mkQrSafe(x.address) })) : [];

  const pickedChannel = channels.find((c) => c.key === 'tunnel' && c.available)
    || channels.find((c) => c.key === 'tailscale' && c.available)
    || channels.find((c) => c.key === 'lan' && c.available)
    || channels.find((c) => c.available);
  const localBuilt = mkQrSafe('127.0.0.1');
  const localUrl = localBuilt.url;
  const primary = pickedChannel
    ? { iface: pickedChannel.iface, address: pickedChannel.entryHost, kind: pickedChannel.key, url: pickedChannel.url, qrSvg: pickedChannel.qrSvg }
    : { iface: '', address: '', kind: 'none', url: '', qrSvg: '' };

  return {
    port: cfg.port,
    token: cfg.token,
    configPath: getRemoteConfigPath(),
    deviceName: desc.deviceName,
    bonjourHost: desc.bonjourHost,
    tailscaleDnsName: desc.tailscaleDnsName,
    enabledChannels: enCh,
    tunnelEnabled: Boolean(cfg.tunnelEnabled),
    tunnelMode: cfg.tunnelMode,
    tunnelHostname: cfg.tunnelHostname || '',
    hasTunnelToken: Boolean(cfg.tunnelToken),
    tunnelStatus: {
      enabled: Boolean(cfg.tunnelEnabled),
      mode: cfg.tunnelMode,
      state: effTunnel.state,
      publicUrl: tunnelActiveUrl,
      error: effTunnel.error || '',
      binaryAvailable: Boolean(effTunnel.binaryAvailable)
    },
    hosts: desc.hosts,
    endpoints: desc.endpoints,
    channels,
    pairedCount: devSummary.pairedCount,
    onlineCount: devSummary.onlineCount,
    pairedDevices: devSummary.devices,
    fusedUrl: primary.url,
    primaryUrl: primary.url,
    primaryKind: primary.kind,
    qrSvg: primary.qrSvg,
    tailscaleUrls,
    lanUrls,
    localUrl
  };
}

function printRemoteCli({ resetToken = false, jsonMode = false, tunnelAction = '' } = {}) {
  if (tunnelAction === 'on' || tunnelAction === 'off') {
    saveRemoteTunnelConfig({ enabled: tunnelAction === 'on' });
    if (!jsonMode) {
      console.log(tunnelAction === 'on'
        ? '✅ 已开启 Cloudflare 远程公网隧道（若桌面端正在运行，点弹窗刷新或在弹窗开关切换即可生效）'
        : '⭕ 已关闭 Cloudflare 远程公网隧道');
    }
  }
  const info = buildRemoteInfo({ resetToken });
  if (jsonMode) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log('');
  console.log(`📱 Antigravity 手机远程操作面板（多通道融合 · ${info.deviceName}）`);
  if (resetToken) console.log('🔑 已重置并生成新的配对 Token（旧链接将自动失效）');
  console.log('');

  for (const ch of (info.channels || [])) {
    if (ch.available) {
      console.log(`✅ ${ch.label.padEnd(14, ' ')} ${ch.displayHost} (${ch.iface || 'auto'})`);
    } else {
      console.log(`⭕ ${ch.label.padEnd(14, ' ')} ${ch.key === 'tunnel' ? ch.displayHost : '未就绪'}`);
    }
  }
  console.log('');
  console.log(`🔗 配对链接: ${info.fusedUrl}`);
  console.log(`🖥️ 本机调试地址: ${info.localUrl}`);
  console.log('');
  console.log('📷 用 iPhone 相机扫描下方二维码即可打开：');
  console.log('');
  if (info.primaryUrl) {
    try {
      const primaryGrid = encodeQrCodeMatrix(info.primaryUrl);
      const cols = Number(process.stdout.columns || 0);
      const qrForTerminal = (cols > 0 && cols < primaryGrid.length + 6)
        ? `http://${(info.tailscaleUrls[0]?.address || info.lanUrls[0]?.address || '127.0.0.1')}:${info.port}/?token=${info.token}`
        : info.primaryUrl;
      console.log(renderTerminalQr(qrForTerminal));
    } catch (err) {
      console.log(`⚠️ 融合二维码字符过长已降级，请直接复制上方融合链接或缩短主机名后重试 (${err?.message || err})`);
    }
  } else {
    console.log('⚠️ 所有连接通道均已停用，请启用至少一种连接方式。');
  }
  console.log('');
  console.log('💡 使用提示：');
  console.log('   1. 扫码在 Safari 打开后，点击底部「分享」→「添加到主屏幕」');
  console.log('   2. 支持 ag-context-meter remote --tunnel on|off 开关 Cloudflare 公网隧道（免装 Tailscale）');
  console.log('   3. 在聊天区右滑即可拉出左侧会话抽屉，底部可直接切换模型/权限与拍照传图');
  console.log('');
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const tIdx = rawArgs.indexOf('--tunnel');
  const tunnelAction = (tIdx >= 0 && rawArgs[tIdx + 1]) ? String(rawArgs[tIdx + 1]).trim().toLowerCase() : '';
  if (args.has('--print-info')) {
    printRemoteCli({
      resetToken: args.has('--reset-token'),
      jsonMode: args.has('--json'),
      tunnelAction
    });
  } else {
    startMobileRemoteServer();
  }
}

module.exports = {
  DEFAULT_REMOTE_PORT,
  loadOrCreateRemoteConfig,
  saveRemoteTunnelConfig,
  extractCloudflareTunnelToken,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  normalizeTunnelHostname,
  resolveCloudflaredBinary,
  createCloudflareTunnelController,
  isAllowedPrivateAddress,
  isAllowedPrivateOrigin,
  detectRequestChannel,
  enumerateLocalAddresses,
  encodeEndpointsParam,
  decodeEndpointsParam,
  buildFusedPairingUrl,
  encodeQrCodeMatrix,
  renderTerminalQr,
  renderQrSvg,
  buildMobileAppHtml,
  normalizeTrajectoryStatus,
  renderSafeMarkdownToHtml,
  extractMessagesFromTrajectorySteps,
  createSessionCatalogStore,
  enrichSnapshotWithCatalog,
  listCatalogConversations,
  getConversationMessagesPage,
  listHostDirectories,
  createHostSubdirectory,
  createRemoteProject,
  readJsonBody,
  createRemoteHttpHandler,
  recordPairedDeviceAccess,
  getPairedDevicesSummary,
  startMobileRemoteServer,
  buildRemoteInfo,
  printRemoteCli
};

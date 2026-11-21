#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile, execFileSync, spawn } = require('child_process');
const { getStateDir, resolveActiveCdpTarget } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');
const { detectProxyConfig } = require('./meter-proxy');

const DEFAULT_REMOTE_PORT = 18765;
const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const CONFIG_FILE_NAME = 'remote-config.json';
const TUNNEL_STATE_FILE_NAME = '.cloudflared-tunnel-state.json';
const MOBILE_UI_VERSION = '2.1.0';
const PING_GIF_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const DEFAULT_REMOTE_DISPLAY_CONFIG = {
  showContextPanel: true,
  showUsagePanel: true,
  showQuotaPill: true,
  showChannelMeta: true,
  showSidebar: true,
  showThinking: true,
  showQuickChips: true,
  showComposerTools: true,
  showApprovals: true
};

function sanitizeRemoteDisplayConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for (const [k, defVal] of Object.entries(DEFAULT_REMOTE_DISPLAY_CONFIG)) {
    out[k] = typeof src[k] === 'boolean' ? src[k] : defVal;
  }
  return out;
}

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
    : true;
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
  const remoteDisplay = sanitizeRemoteDisplayConfig(existing.remoteDisplay);

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
    remoteDisplay,
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
const MAX_CLIENT_SESSIONS = 128;
const CLIENT_SESSION_TTL_MS = 24 * 3600 * 1000;
let trackedDeviceToken = '';
const pairedDevicesMap = new Map();
const remoteClientSessions = new Map();
let actionQueueTail = Promise.resolve();

function enqueueRemoteAction(task) {
  const next = actionQueueTail.then(task, task);
  actionQueueTail = next.catch(() => {});
  return next;
}

function syncTrackedDeviceToken(activeToken) {
  const clean = String(activeToken || '');
  if (clean && clean !== trackedDeviceToken) {
    pairedDevicesMap.clear();
    remoteClientSessions.clear();
    trackedDeviceToken = clean;
  }
}

function extractRequestClientId(req, urlObj = null, body = null) {
  const raw = String(
    req?.headers?.['x-ag-client-id']
    || urlObj?.searchParams?.get('clientId')
    || body?.clientId
    || ''
  ).trim().slice(0, 64);
  return /^[A-Za-z0-9._:-]{4,64}$/.test(raw) ? raw : '';
}

function getOrCreateClientSession(clientId, activeToken, now = Date.now()) {
  const cleanId = String(clientId || '').trim();
  if (!/^[A-Za-z0-9._:-]{4,64}$/.test(cleanId)) return null;
  syncTrackedDeviceToken(activeToken);
  if (remoteClientSessions.has(cleanId)) {
    const existing = remoteClientSessions.get(cleanId);
    existing.lastSeenAt = now;
    return existing;
  }
  for (const [k, s] of Array.from(remoteClientSessions.entries())) {
    if (!s || (now - (s.lastSeenAt || 0)) > CLIENT_SESSION_TTL_MS) {
      remoteClientSessions.delete(k);
    }
  }
  while (remoteClientSessions.size >= MAX_CLIENT_SESSIONS) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [k, s] of remoteClientSessions.entries()) {
      if ((s?.lastSeenAt || 0) < oldestSeen) {
        oldestSeen = s?.lastSeenAt || 0;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    remoteClientSessions.delete(oldestKey);
  }
  const created = {
    clientId: cleanId,
    conversationId: '',
    targetId: '',
    createdAt: now,
    lastSeenAt: now
  };
  remoteClientSessions.set(cleanId, created);
  return created;
}

function getRemoteClientSession(clientId) {
  const cleanId = String(clientId || '').trim();
  const s = remoteClientSessions.get(cleanId);
  return s ? { ...s } : null;
}

function clearRemoteClientSessionsForTests() {
  remoteClientSessions.clear();
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
  let urlParams = null;
  if (typeof req.url === 'string' && req.url.includes('?')) {
    try {
      urlParams = new URL(req.url, 'http://localhost').searchParams;
    } catch {}
  }
  const queryProbe = urlParams?.get('probe') || '';
  if (queryProbe === '1' || String(headers['x-ag-probe'] || '').trim() === '1') {
    return null;
  }

  const rawDevId = String(headers['x-ag-device-id'] || urlParams?.get('did') || '').trim().slice(0, 64);
  const headerDevId = /^[A-Za-z0-9._:-]{4,64}$/.test(rawDevId) ? rawDevId : '';
  const rawFp = String(headers['x-ag-device-fp'] || urlParams?.get('fp') || '').trim().slice(0, 64);
  const deviceFp = /^[A-Za-z0-9._x@-]{4,64}$/.test(rawFp) ? rawFp : '';
  const deviceHint = String(headers['x-ag-device-hint'] || urlParams?.get('hint') || '').trim().slice(0, 24);
  const ua = String(headers['user-agent'] || '').trim();
  const label = parseDeviceLabel(ua, deviceHint);
  const cleanIp = normalizeRemoteIp(req.socket?.remoteAddress || req.ip || '');

  // 过滤本机非浏览器健康检查或 CLI 脚本探测，避免误计为关联设备（Cloudflare 隧道透传请求除外）
  const reqCh = detectRequestChannel(req, activeTunnelUrl);
  if (!headerDevId && reqCh === 'loopback' && !/Mozilla\/|Mobile|Safari|Chrome|Firefox/i.test(ua)) {
    return null;
  }

  const localHostIps = getLocalHostIpSet();
  const isSelfIp = Boolean(cleanIp && localHostIps.has(cleanIp));
  const fallbackId = 'ua-' + crypto.createHash('sha1').update(`${cleanIp}|${ua}`).digest('hex').slice(0, 12);
  let finalId = headerDevId || fallbackId;
  let prev = pairedDevicesMap.get(finalId) || null;
  let earliestFirstSeen = prev?.firstSeenAt || now;
  let mergedFp = deviceFp || prev?.fp || '';
  const prevLanIp = (prev?.lastLanIp && !localHostIps.has(prev.lastLanIp)) ? prev.lastLanIp : '';
  const prevTsIp = (prev?.lastTailscaleIp && !localHostIps.has(prev.lastTailscaleIp)) ? prev.lastTailscaleIp : '';
  const freshLanHit = reqCh === 'lan' && !isSelfIp && isRfc1918Ipv4(cleanIp);
  const freshTsHit = reqCh === 'tailscale' && !isSelfIp && isTailscaleCgnatIpv4(cleanIp);
  let lastLanIp = freshLanHit ? cleanIp : prevLanIp;
  let lastLanSeenAt = freshLanHit ? now : (prev?.lastLanSeenAt || 0);
  let lastTailscaleIp = freshTsHit ? cleanIp : prevTsIp;
  let lastTailscaleSeenAt = freshTsHit ? now : (prev?.lastTailscaleSeenAt || 0);

  if (headerDevId && pairedDevicesMap.has(fallbackId)) {
    const fallbackEntry = pairedDevicesMap.get(fallbackId);
    if (fallbackEntry) {
      earliestFirstSeen = Math.min(earliestFirstSeen, fallbackEntry.firstSeenAt || now);
      if (!mergedFp && fallbackEntry.fp) mergedFp = fallbackEntry.fp;
      if (!lastLanIp && fallbackEntry.lastLanIp && !localHostIps.has(fallbackEntry.lastLanIp)) {
        lastLanIp = fallbackEntry.lastLanIp;
      }
      if ((fallbackEntry.lastLanSeenAt || 0) > lastLanSeenAt) lastLanSeenAt = fallbackEntry.lastLanSeenAt || 0;
      if (!lastTailscaleIp && fallbackEntry.lastTailscaleIp && !localHostIps.has(fallbackEntry.lastTailscaleIp)) {
        lastTailscaleIp = fallbackEntry.lastTailscaleIp;
      }
      if ((fallbackEntry.lastTailscaleSeenAt || 0) > lastTailscaleSeenAt) lastTailscaleSeenAt = fallbackEntry.lastTailscaleSeenAt || 0;
      if (!prev) prev = fallbackEntry;
    }
    pairedDevicesMap.delete(fallbackId);
  }

  // 同一物理设备跨通道（如 Cloudflare <-> Tailscale <-> LAN）或跨源切换时自动去重合并
  for (const [k, v] of Array.from(pairedDevicesMap.entries())) {
    if (k === finalId || !v) continue;
    if (v.label !== label || !ua || v.ua !== ua) continue;
    const fpCompatible = (mergedFp && v.fp) ? (mergedFp === v.fp) : true;
    if (!fpCompatible) continue;
    const exactFpMatch = Boolean(mergedFp && v.fp && mergedFp === v.fp);
    const matchesInitialNav = k.startsWith('ua-') || !headerDevId;
    const switchedInactiveChannel = v.channel !== reqCh && (now - (v.lastSeenAt || 0)) > 2500;
    if (!exactFpMatch && !matchesInitialNav && !switchedInactiveChannel) continue;

    earliestFirstSeen = Math.min(earliestFirstSeen, v.firstSeenAt || now);
    if (!mergedFp && v.fp) mergedFp = v.fp;
    if (!lastLanIp && v.lastLanIp && !localHostIps.has(v.lastLanIp)) lastLanIp = v.lastLanIp;
    if ((v.lastLanSeenAt || 0) > lastLanSeenAt) lastLanSeenAt = v.lastLanSeenAt || 0;
    if (!lastTailscaleIp && v.lastTailscaleIp && !localHostIps.has(v.lastTailscaleIp)) lastTailscaleIp = v.lastTailscaleIp;
    if ((v.lastTailscaleSeenAt || 0) > lastTailscaleSeenAt) lastTailscaleSeenAt = v.lastTailscaleSeenAt || 0;
    if (!headerDevId && !k.startsWith('ua-')) {
      finalId = k;
      prev = v;
    } else {
      if (!prev) prev = v;
      pairedDevicesMap.delete(k);
    }
  }

  if (finalId !== fallbackId && pairedDevicesMap.has(fallbackId)) {
    const fb = pairedDevicesMap.get(fallbackId);
    if (fb && fb.label === label && ua && fb.ua === ua) {
      earliestFirstSeen = Math.min(earliestFirstSeen, fb.firstSeenAt || now);
      if (!mergedFp && fb.fp) mergedFp = fb.fp;
      if (!lastLanIp && fb.lastLanIp && !localHostIps.has(fb.lastLanIp)) lastLanIp = fb.lastLanIp;
      if ((fb.lastLanSeenAt || 0) > lastLanSeenAt) lastLanSeenAt = fb.lastLanSeenAt || 0;
      if (!lastTailscaleIp && fb.lastTailscaleIp && !localHostIps.has(fb.lastTailscaleIp)) lastTailscaleIp = fb.lastTailscaleIp;
      if ((fb.lastTailscaleSeenAt || 0) > lastTailscaleSeenAt) lastTailscaleSeenAt = fb.lastTailscaleSeenAt || 0;
      pairedDevicesMap.delete(fallbackId);
    }
  }

  const record = {
    id: finalId,
    label,
    channel: reqCh,
    ip: cleanIp,
    ua,
    fp: mergedFp,
    lastLanIp,
    lastLanSeenAt,
    lastTailscaleIp,
    lastTailscaleSeenAt,
    firstSeenAt: earliestFirstSeen,
    lastSeenAt: now
  };
  pairedDevicesMap.set(finalId, record);

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
  const rawDisplay = patch.remoteDisplay !== undefined
    ? patch.remoteDisplay
    : (patch.displayConfig !== undefined ? patch.displayConfig : null);
  const nextRemoteDisplay = rawDisplay && typeof rawDisplay === 'object'
    ? sanitizeRemoteDisplayConfig({ ...(cur.remoteDisplay || DEFAULT_REMOTE_DISPLAY_CONFIG), ...rawDisplay })
    : sanitizeRemoteDisplayConfig(cur.remoteDisplay);

  const next = {
    ...cur,
    tunnelEnabled: nextTunnelEnabled,
    enabledChannels: nextEnabledChannels,
    tunnelMode: nextMode,
    tunnelToken: nextToken,
    tunnelHostname: nextHost,
    remoteDisplay: nextRemoteDisplay,
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

function ipv4ToInt(ip) {
  const p = parseIpv4Parts(String(ip || ''));
  if (!p) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function getLocalHostIpSet(netsMap = os.networkInterfaces()) {
  const set = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(netsMap || {})) {
    for (const info of entries || []) {
      if (!info || !info.address) continue;
      const clean = normalizeRemoteIp(info.address);
      if (clean) set.add(clean);
    }
  }
  return set;
}

function isIpInLocalPhysicalLanSubnet(ip, netsMap = os.networkInterfaces()) {
  const targetInt = ipv4ToInt(ip);
  if (targetInt === null) return false;
  for (const [ifName, entries] of Object.entries(netsMap || {})) {
    if (isVirtualBridgeIface(ifName)) continue;
    for (const info of entries || []) {
      if (!info || info.internal || info.family !== 'IPv4') continue;
      if (!isRfc1918Ipv4(info.address) || !info.netmask) continue;
      if (String(info.address) === String(ip)) continue;
      const addrInt = ipv4ToInt(info.address);
      const maskInt = ipv4ToInt(info.netmask);
      if (addrInt === null || maskInt === null || maskInt === 0) continue;
      if ((addrInt & maskInt) === (targetInt & maskInt)) return true;
    }
  }
  return false;
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

let cachedCdpTargets = null;
let cachedCdpTargetsAt = 0;
const CDP_TARGETS_CACHE_TTL_MS = 10000;

function invalidateCdpTargetsCache() {
  cachedCdpTargets = null;
  cachedCdpTargetsAt = 0;
}

async function listAntigravityCdpTargets(options = {}) {
  const electronTargets = listElectronWebContentsTargets();
  if (electronTargets.length) {
    return electronTargets;
  }

  const nowMs = Date.now();
  if (!isCatalogTestEnv() && !options.force && Array.isArray(cachedCdpTargets) && cachedCdpTargets.length && (nowMs - cachedCdpTargetsAt < CDP_TARGETS_CACHE_TTL_MS)) {
    return cachedCdpTargets;
  }

  const { port, targets } = await resolveActiveCdpTarget({ timeoutMs: 2500 });
  if (!port) {
    invalidateCdpTargetsCache();
    throw new Error('Antigravity 未运行或未开启远程调试端口');
  }
  const mapped = targets
    .filter((p) => p && p.webSocketDebuggerUrl)
    .map((p) => ({
      id: String(p.id),
      title: String(p.title || 'Antigravity'),
      url: String(p.url || ''),
      wsUrl: String(p.webSocketDebuggerUrl)
    }));
  if (!isCatalogTestEnv() && mapped.length) {
    cachedCdpTargets = mapped;
    cachedCdpTargetsAt = Date.now();
  } else {
    invalidateCdpTargetsCache();
  }
  return mapped;
}

function evalInElectronWebContents(wc, expression, timeoutMs = 4500) {
  if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') {
    const err = new Error('目标窗口已关闭');
    err.cdpDispatched = false;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('页面执行超时');
      err.cdpDispatched = dispatched;
      reject(err);
    }, timeoutMs);
    Promise.resolve()
      .then(() => {
        dispatched = true;
        return wc.executeJavaScript(expression, true);
      })
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
        const wrapped = err instanceof Error ? err : new Error(String(err || '页面执行异常'));
        wrapped.cdpDispatched = dispatched;
        reject(wrapped);
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
    let requestSent = false;
    let timer = null;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) {
        if (err.cdpDispatched === undefined) err.cdpDispatched = requestSent;
        reject(err);
      } else {
        resolve(val);
      }
    };

    timer = setTimeout(() => {
      finish(new Error('CDP 请求超时'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      requestSent = true;
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

    ws.addEventListener('error', () => finish(new Error(requestSent ? 'CDP 连接在执行期间断开' : 'CDP WebSocket 连接失败')));
    ws.addEventListener('close', () => finish(new Error(requestSent ? 'CDP 连接在执行期间断开' : 'CDP WebSocket 连接失败')));
  });
}

async function pickCdpTarget(requestedId, options = {}) {
  let targets = await listAntigravityCdpTargets(options);
  if (!targets.length) {
    invalidateCdpTargetsCache();
    if (!options.force) targets = await listAntigravityCdpTargets({ force: true });
  }
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

async function evalInPickedTarget(requestedId, expression, timeoutMs = 4500, options = {}) {
  const idempotent = Boolean(options.idempotent);
  const pickFn = typeof options.pickTarget === 'function' ? options.pickTarget : pickCdpTarget;
  const evalFn = typeof options.evalInTarget === 'function' ? options.evalInTarget : evalInTarget;
  let picked = await pickFn(requestedId);
  try {
    const value = await evalFn(picked.target, expression, timeoutMs);
    return { value, target: picked.target, windows: picked.windows };
  } catch (err) {
    invalidateCdpTargetsCache();
    const msg = String(err?.message || '');
    const isTargetOrConnErr = /(?:CDP WebSocket 连接失败|CDP 连接在执行期间断开|目标窗口已关闭|未找到激活|CDP 请求超时|页面执行超时)/.test(msg);
    if (!isTargetOrConnErr) {
      throw err;
    }
    const mayHaveExecuted = Boolean(err?.cdpDispatched) || /(?:超时|执行期间断开)/.test(msg);
    if (!idempotent && mayHaveExecuted) {
      throw err;
    }
    picked = await pickFn(requestedId, { force: true });
    const value = await evalFn(picked.target, expression, timeoutMs);
    return { value, target: picked.target, windows: picked.windows };
  }
}

// ==================== 多项目融合目录、会话状态汇总与防缩水缓存 ====================

const SESSION_CATALOG_FILE_NAME = 'remote-session-catalog.json';
const MAX_ARCHIVED_TOMBSTONES = 500;
const INTERNAL_EMPTY_PROJECT_IDS = new Set(['outside-of-project', 'standalone']);
globalThis.__AG_REMOTE_BOOT_SEQ = (globalThis.__AG_REMOTE_BOOT_SEQ || 0) + 1;
const REMOTE_SERVER_BOOT_AT = Math.max(Date.now() * 1000, (Number(globalThis.__AG_REMOTE_LAST_BOOT_AT) || 0) + 1);
globalThis.__AG_REMOTE_LAST_BOOT_AT = REMOTE_SERVER_BOOT_AT;
const REMOTE_SERVER_BOOT_ID = `${REMOTE_SERVER_BOOT_AT}-${process.pid}-${globalThis.__AG_REMOTE_BOOT_SEQ.toString(36)}`;
let remoteServerSnapSeq = 0;

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

function safeDecodeURIComponent(raw) {
  const s = String(raw ?? '');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodeFileUriToPath(rawUri) {
  const s = String(rawUri || '').trim();
  if (!s) return '';
  if (!/^file:\/\//i.test(s)) return path.resolve(s);
  try {
    const u = new URL(s);
    let p = safeDecodeURIComponent(u.pathname || '');
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
        const fp = path.join(projectsDir, f);
        const readRes = safeReadJsonSync(fp, null);
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
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(fp).mtimeMs) || 0;
        } catch {}
        metaMap.set(id, { id, name, primaryPath: workspacePaths[0] || '', workspacePaths, mtimeMs });
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

let cachedLocalApi = null;
let cachedLocalApiAt = 0;
let inflightLocalApiPromise = null;
const LOCAL_API_CACHE_TTL_MS = 15000;

function invalidateSharedLocalApi() {
  cachedLocalApi = null;
  cachedLocalApiAt = 0;
  inflightLocalApiPromise = null;
}

async function getSharedLocalApi() {
  const nowMs = Date.now();
  if (cachedLocalApi && (nowMs - cachedLocalApiAt < LOCAL_API_CACHE_TTL_MS)) {
    return cachedLocalApi;
  }
  if (!inflightLocalApiPromise) {
    inflightLocalApiPromise = (async () => {
      let connectFn;
      try {
        connectFn = require('./local-api').connect;
      } catch {
        return null;
      }
      const api = await withRaceTimeout(Promise.resolve().then(() => connectFn()).catch(() => null), 1200, null);
      if (api && typeof api.call === 'function') {
        cachedLocalApi = api;
        cachedLocalApiAt = Date.now();
        return api;
      }
      return null;
    })().finally(() => {
      inflightLocalApiPromise = null;
    });
  }
  return await inflightLocalApiPromise;
}

async function resolveLocalApi(options = {}) {
  const customConnect = options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__;
  if (customConnect) {
    return typeof customConnect === 'function'
      ? await withRaceTimeout(Promise.resolve().then(() => customConnect()).catch(() => null), 1200, null)
      : customConnect;
  }
  if (isCatalogTestEnv()) return null;
  return await getSharedLocalApi();
}

async function callLocalLanguageServer(method, body, timeoutMs = 1500, options = {}) {
  const isCustom = Boolean(options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__);
  const api = await resolveLocalApi(options);
  if (!api || typeof api.call !== 'function') return null;
  if (isCustom) {
    return await withRaceTimeout(
      Promise.resolve().then(() => api.call(method, body)).catch(() => null),
      timeoutMs,
      null
    );
  }
  try {
    return await withRaceTimeout(
      Promise.resolve().then(() => api.call(method, body)),
      timeoutMs,
      null
    );
  } catch {
    invalidateSharedLocalApi();
    const retryApi = await getSharedLocalApi();
    if (!retryApi || typeof retryApi.call !== 'function') return null;
    return await withRaceTimeout(
      Promise.resolve().then(() => retryApi.call(method, body)).catch(() => null),
      timeoutMs,
      null
    );
  }
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
    if (!customConnect && !options.bypassCache && !options.bypassCatalogCache && trajCache.data && nowMs - trajCache.at < 2000) {
      return trajCache.data;
    }

    try {
      const api = await resolveLocalApi(options);
      if (!api || typeof api.call !== 'function') return null;
      const runBatch = async (client, allowThrow) => {
        let trajFailed = false;
        const [trajRes, listProjRes] = await Promise.all([
          withRaceTimeout(
            Promise.resolve()
              .then(() => client.call('GetAllCascadeTrajectories', {}))
              .catch((err) => {
                trajFailed = true;
                if (allowThrow) throw err;
                return null;
              }),
            1500,
            null
          ),
          withRaceTimeout(Promise.resolve().then(() => client.call('ListProjects', {})).catch(() => null), 1000, null)
        ]);
        return { trajRes, listProjRes, trajFailed };
      };
      let batch = await runBatch(api, !customConnect).catch(() => null);
      if ((!batch || batch.trajFailed) && !customConnect) {
        invalidateSharedLocalApi();
        const retryApi = await resolveLocalApi(options);
        if (retryApi && typeof retryApi.call === 'function') {
          batch = await runBatch(retryApi, false).catch(() => null);
        }
      }
      const trajRes = batch?.trajRes || null;
      const listProjRes = batch?.listProjRes || null;
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
        isActive ? Math.max(updatedAt, 1) : 0
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

    // 上限淘汰 subagent 缓存：清理指向已归档根会话的状态并限制集合规模防止长驻内存膨胀
    const MAX_SUBAGENT_STATES = 500;
    const MAX_SUBAGENT_IDS = 2000;
    for (const [subId, subRec] of Array.from(store.subagentStates.entries())) {
      const rootItem = subRec?.rootId ? store.map.get(subRec.rootId) : null;
      if (rootItem && rootItem.archived) store.subagentStates.delete(subId);
    }
    if (store.subagentStates.size > MAX_SUBAGENT_STATES) {
      const sortedSubStates = Array.from(store.subagentStates.entries())
        .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0));
      store.subagentStates.clear();
      for (const [k, v] of sortedSubStates.slice(0, MAX_SUBAGENT_STATES)) {
        store.subagentStates.set(k, v);
      }
    }
    if (store.subagentIds.size > MAX_SUBAGENT_IDS) {
      const protectedIds = new Set([...store.subagentStates.keys(), ...seenSubIds]);
      for (const sid of Array.from(store.subagentIds)) {
        if (store.subagentIds.size <= MAX_SUBAGENT_IDS) break;
        if (!protectedIds.has(sid)) {
          store.subagentIds.delete(sid);
          store.subagentRoots.delete(sid);
        }
      }
      // 极端情况下即使受保护项偏多，仍按插入顺序严格守住 MAX_SUBAGENT_IDS 容量上限
      for (const sid of Array.from(store.subagentIds)) {
        if (store.subagentIds.size <= MAX_SUBAGENT_IDS) break;
        store.subagentIds.delete(sid);
        store.subagentRoots.delete(sid);
      }
    }
    if (store.subagentRoots.size > MAX_SUBAGENT_IDS) {
      for (const sid of Array.from(store.subagentRoots.keys())) {
        if (store.subagentRoots.size <= MAX_SUBAGENT_IDS) break;
        if (!store.subagentIds.has(sid) && !store.subagentStates.has(sid)) {
          store.subagentRoots.delete(sid);
        }
      }
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

    const ensureProjBucket = (pid, name, seedLastActiveAt = 0) => {
      if (!projectStats.has(pid)) {
        projectStats.set(pid, {
          id: pid,
          name: name || pid,
          conversationCount: 0,
          runningCount: 0,
          waitingCount: 0,
          unreadCount: 0,
          lastActiveAt: Number(seedLastActiveAt) || 0
        });
      }
      return projectStats.get(pid);
    };

    for (const [pid, name] of projectNameMap.entries()) {
      ensureProjBucket(pid, name, projectsMeta.get(pid)?.mtimeMs || 0);
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
        if ((a.id === 'ungrouped') !== (b.id === 'ungrouped')) {
          return a.id === 'ungrouped' ? 1 : -1;
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
    const activeTraj = activeSessionId ? summaries[activeSessionId] : null;
    const _activeTrajSig = activeTraj
      ? `${activeTraj.status || ''}|${activeTraj.stepCount ?? ''}|${activeTraj.lastModifiedTime || ''}`
      : '';

    return {
      ...snap,
      serverBootId: REMOTE_SERVER_BOOT_ID,
      serverBootAt: REMOTE_SERVER_BOOT_AT,
      snapSeq: ++remoteServerSnapSeq,
      currentProjectId,
      currentProjectName,
      catalogRevision,
      totalConversations: allActiveConvs.length,
      hasMoreConversations: outputConvs.length < allActiveConvs.length,
      projects,
      conversations: outputConvs,
      _activeTrajSig
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

const SENSITIVE_SYSTEM_PREFIXES = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/private/etc',
  '/private/var',
  '/Applications/Antigravity.app'
];
const SENSITIVE_DIR_SEGMENTS_RE = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|1Password|\.gemini|\.kube|\.docker|\.npmrc|\.netrc)(?:\/|$)/i;

function isSensitiveHostPath(absPath, options = {}) {
  const normalized = path.resolve(String(absPath || '')).replace(/\\/g, '/');
  if (!normalized) return true;
  if (SENSITIVE_DIR_SEGMENTS_RE.test(normalized)) {
    return true;
  }
  const normalizedLower = normalized.toLowerCase();
  // 生产环境无条件屏蔽全部系统前缀（含 /var 与 /private/var，且大小写无关以覆盖 macOS APFS）；
  // 仅在自动化测试环境（NODE_TEST_CONTEXT）下对 os.tmpdir() 内的隔离临时沙箱放行 /var 前缀以便单测运行
  let inTestTmpDir = false;
  if (!options.forceProd && (isCatalogTestEnv() || Boolean(process.env.NODE_TEST_CONTEXT))) {
    const tmpLogical = path.resolve(os.tmpdir()).replace(/\\/g, '/').toLowerCase();
    let tmpReal = tmpLogical;
    try { tmpReal = fs.realpathSync(os.tmpdir()).replace(/\\/g, '/').toLowerCase(); } catch {}
    inTestTmpDir = normalizedLower === tmpLogical
      || normalizedLower.startsWith(`${tmpLogical}/`)
      || normalizedLower === tmpReal
      || normalizedLower.startsWith(`${tmpReal}/`);
  }
  for (const prefix of SENSITIVE_SYSTEM_PREFIXES) {
    const prefixLower = prefix.toLowerCase();
    if (inTestTmpDir && (prefixLower === '/var' || prefixLower === '/private/var')) continue;
    if (normalizedLower === prefixLower || normalizedLower.startsWith(`${prefixLower}/`)) {
      return true;
    }
  }
  return false;
}

function isPathWithinRoot(candidatePath, rootPath) {
  const cand = path.resolve(String(candidatePath || ''));
  const root = path.resolve(String(rootPath || ''));
  const rel = path.relative(root, cand);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRealPathWithFallback(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const probeRealAt = (p) => {
    let lst = null;
    try {
      lst = fs.lstatSync(p);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw Object.assign(new Error(`无法安全检查路径状态 (${err?.code || 'ERR'})`), { status: 403 });
    }
    try {
      return fs.realpathSync(p);
    } catch (err) {
      // 已存在的符号链接（悬空软链/循环软链/无权限目标）一律直接拒绝，绝不回溯拼接放行
      if (lst?.isSymbolicLink()) {
        throw Object.assign(new Error(`检测到悬空或无法解析目标的符号链接 (${err?.code || 'ERR'})，已拒绝访问`), { status: 403 });
      }
      throw Object.assign(new Error(`无法安全验证真实物理路径 (${err?.code || 'ERR'})`), { status: 403 });
    }
  };

  const directReal = probeRealAt(abs);
  if (directReal !== null) return directReal;

  // 仅当目标确实不存在（lstatSync 返回 ENOENT）时，逐级向上校验祖先 lstatSync + realpathSync
  let cur = abs;
  const pending = [];
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      throw Object.assign(new Error('无法确认目标路径的真实物理根目录，已拒绝访问'), { status: 403 });
    }
    pending.unshift(path.basename(cur));
    cur = parent;
    const ancestorReal = probeRealAt(cur);
    if (ancestorReal !== null) {
      return path.resolve(ancestorReal, ...pending);
    }
  }
}

function resolveAllowedHostRoots(options = {}) {
  const homeDir = path.resolve(String(options.homeDir || os.homedir()));
  const rawRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
    ? options.allowedRoots
    : [homeDir];
  const logicalRoots = [];
  const realRoots = [];
  const seen = new Set();
  for (const r of rawRoots) {
    const s = String(r || '').trim();
    if (!s) continue;
    const abs = path.resolve(s);
    if (seen.has(abs)) continue;
    seen.add(abs);
    logicalRoots.push(abs);
    realRoots.push(resolveRealPathWithFallback(abs));
  }
  if (!logicalRoots.length) {
    logicalRoots.push(homeDir);
    realRoots.push(resolveRealPathWithFallback(homeDir));
  }
  return { homeDir, realHomeDir: resolveRealPathWithFallback(homeDir), logicalRoots, realRoots };
}

function assertSafeHostDirectoryPath(rawPath, options = {}) {
  const { homeDir, realHomeDir, logicalRoots, realRoots } = resolveAllowedHostRoots(options);
  const resolvedPath = resolveHostPathInput(rawPath, homeDir);
  const matchedRootIdx = logicalRoots.findIndex((root) => isPathWithinRoot(resolvedPath, root));
  if (matchedRootIdx < 0) {
    throw Object.assign(new Error('目标路径超出允许访问的宿主机根目录边界'), { status: 403 });
  }
  if (isSensitiveHostPath(resolvedPath)) {
    throw Object.assign(new Error('禁止访问敏感系统或凭证目录'), { status: 403 });
  }
  // 显式经 lstatSync 检查非 ENOENT 错误（如 EACCES/ELOOP）并经 realpathSync 二次校验真实物理路径
  let lstat = null;
  try {
    lstat = fs.lstatSync(resolvedPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw Object.assign(new Error(`无法安全检查目标路径状态 (${err?.code || 'ERR'})`), { status: 403 });
    }
  }
  const realPath = resolveRealPathWithFallback(resolvedPath);
  const matchedRealIdx = realRoots.findIndex((root) => isPathWithinRoot(realPath, root));
  if (matchedRealIdx < 0) {
    throw Object.assign(new Error('检测到符号链接指向授权目录之外，已拒绝访问'), { status: 403 });
  }
  if (isSensitiveHostPath(realPath)) {
    throw Object.assign(new Error('检测到符号链接指向敏感目录，已拒绝访问'), { status: 403 });
  }
  return {
    resolvedPath,
    realPath,
    lstat,
    homeDir,
    realHomeDir,
    matchedRoot: logicalRoots[matchedRootIdx],
    matchedRealRoot: realRoots[matchedRealIdx],
    logicalRoots,
    realRoots
  };
}

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
  const showHidden = Boolean(options.showHidden);
  const {
    resolvedPath,
    realPath,
    homeDir,
    matchedRoot,
    matchedRealRoot,
    realRoots
  } = assertSafeHostDirectoryPath(options.dirPath, options);

  let stat;
  try {
    stat = fs.statSync(realPath);
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
    dirents = fs.readdirSync(realPath, { withFileTypes: true });
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
    if (isSensitiveHostPath(childFull)) continue;
    let isDir = false;
    try {
      if (d.isDirectory()) {
        isDir = true;
      } else if (d.isSymbolicLink()) {
        const realChild = fs.realpathSync(childFull);
        if (!realRoots.some((r) => isPathWithinRoot(realChild, r)) || isSensitiveHostPath(realChild)) {
          continue;
        }
        if (fs.statSync(realChild).isDirectory()) isDir = true;
      }
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
  const candidateParent = resolvedPath === parsedRoot ? '' : path.dirname(resolvedPath);
  const atBoundary = resolvedPath === matchedRoot
    || realPath === matchedRealRoot
    || !candidateParent
    || !isPathWithinRoot(candidateParent, matchedRoot);
  const parentPath = atBoundary ? '' : candidateParent;
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
  const rawParent = String(payload?.parentPath || '').trim();
  if (!rawParent) {
    throw Object.assign(new Error('缺少父目录路径'), { status: 400 });
  }
  const { resolvedPath: resolvedParent, realPath: realParent } = assertSafeHostDirectoryPath(rawParent, options);
  let parentStat;
  try {
    parentStat = fs.statSync(realParent);
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
  const { realPath: realTargetPath } = assertSafeHostDirectoryPath(targetPath, options);
  let existingLstat = null;
  try {
    existingLstat = fs.lstatSync(targetPath);
  } catch {}
  if (existingLstat) {
    const st = fs.statSync(realTargetPath);
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
  const rawFolder = String(payload?.folderPath || '').trim();
  if (!rawFolder) {
    throw Object.assign(new Error('请选择项目文件夹路径'), { status: 400 });
  }
  const {
    resolvedPath,
    realPath,
    homeDir,
    realHomeDir
  } = assertSafeHostDirectoryPath(rawFolder, options);
  if (
    resolvedPath === path.parse(resolvedPath).root ||
    resolvedPath === homeDir ||
    realPath === realHomeDir
  ) {
    throw Object.assign(new Error('不支持直接以用户主目录或系统根目录作为项目，请选择具体项目子目录'), { status: 400 });
  }

  let dirStat;
  try {
    dirStat = fs.statSync(realPath);
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
  if (!requestedName) {
    throw Object.assign(new Error('请输入项目名称'), { status: 400 });
  }
  const projectName = requestedName;
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
        const base = safeDecodeURIComponent(uri.split('/').pop() || uri);
        pieces.push(`@${base}`);
      } else if (it.item?.directory?.absoluteUri) {
        const uri = String(it.item.directory.absoluteUri);
        const base = safeDecodeURIComponent(uri.replace(/\/+$/, '').split('/').pop() || uri);
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

function extractMessagesFromTrajectorySteps(steps, options = {}) {
  if (!Array.isArray(steps) || !steps.length) return [];
  const lazyHtml = Boolean(options?.lazyHtml);
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
          html: lazyHtml ? null : renderSafeMarkdownToHtml(replyText),
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

function ensureMessagesHtmlRendered(msgs, sourceList = null) {
  if (!Array.isArray(msgs)) return [];
  let srcById = null;
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || m.html !== null) continue;
    m.html = m.text ? renderSafeMarkdownToHtml(m.text) : '';
    if (Array.isArray(sourceList) && m.id) {
      if (!srcById) {
        srcById = new Map();
        for (const tm of sourceList) {
          if (tm && tm.id) srcById.set(tm.id, tm);
        }
      }
      const src = srcById.get(m.id);
      if (src && src.text === m.text) src.html = m.html;
    }
  }
  return msgs;
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
        matchTarget.html = dm.html || null;
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
  const inflightMap = new Map();
  const fetchGenMap = new Map();
  const MAX_CACHE_ENTRIES = 24;
  const MAX_FETCH_GEN_ENTRIES = 2000;

  function touchCache(sessionId, rec) {
    if (cache.has(sessionId)) cache.delete(sessionId);
    cache.set(sessionId, rec);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }

  function nextFetchGen(sessionId) {
    const next = (fetchGenMap.get(sessionId) || 0) + 1;
    if (fetchGenMap.has(sessionId)) fetchGenMap.delete(sessionId);
    fetchGenMap.set(sessionId, next);
    while (fetchGenMap.size > MAX_FETCH_GEN_ENTRIES) {
      const oldestKey = fetchGenMap.keys().next().value;
      if (oldestKey !== undefined) fetchGenMap.delete(oldestKey);
      else break;
    }
    return next;
  }

  function findInflightBySession(sessionId) {
    const prefix = `${sessionId}\n`;
    for (const [key, entry] of inflightMap.entries()) {
      if (key.startsWith(prefix)) return entry;
    }
    return null;
  }

  async function fetchTrajectoryMessages(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const customConnect = options.localApiConnect || globalThis.__AG_REMOTE_TEST_API__;
    if (!customConnect && isCatalogTestEnv()) return null;

    const reqSig = String(options.trajSig || '').trim();
    const inflightKey = `${sid}\n${reqSig}`;
    if (!options.bypassCache) {
      const existingEntry = inflightMap.get(inflightKey);
      if (existingEntry) {
        return await existingEntry.promise;
      }
    }

    const gen = nextFetchGen(sid);
    const startedAt = Date.now();
    let entry = null;
    const promise = (async () => {
      try {
        const res = await callLocalLanguageServer('GetCascadeTrajectory', { cascadeId: sid }, 4500, options);
        const steps = res?.trajectory?.steps;
        if (!Array.isArray(steps)) {
          return { messages: null, fetchedSig: reqSig, gen, startedAt };
        }
        return {
          messages: extractMessagesFromTrajectorySteps(steps, { lazyHtml: true }),
          fetchedSig: reqSig,
          gen,
          startedAt
        };
      } catch {
        return { messages: null, fetchedSig: reqSig, gen, startedAt };
      } finally {
        if (inflightMap.get(inflightKey) === entry) {
          inflightMap.delete(inflightKey);
        }
      }
    })();
    entry = { promise, sig: reqSig, gen, startedAt };
    inflightMap.set(inflightKey, entry);
    return await promise;
  }

  async function resolveFullMessages(sessionId, domMessages, options = {}) {
    const sid = String(sessionId || '').trim();
    const domTail = Array.isArray(domMessages) ? domMessages : [];
    if (!sid) {
      return { merged: domTail.map((m, idx) => ({ ...m, msgIndex: idx })), trajMsgs: null };
    }
    const existing = cache.get(sid);
    const nowMs = Date.now();
    const ttl = options.busy ? 1000 : 3500;
    const trajSig = String(options.trajSig || '').trim();
    const knownOldSig = String(existing?.trajSig || '').trim();
    const observedOldSig = String(existing?.observedSig || '').trim();
    const sigMismatch = Boolean(
      trajSig && (
        (knownOldSig && knownOldSig !== trajSig) ||
        (!knownOldSig && observedOldSig && observedOldSig !== trajSig)
      )
    );
    const verifiedIdleMatch = Boolean(trajSig && knownOldSig && knownOldSig === trajSig && !options.busy);
    const withinTtl = Boolean(existing && existing.at > 0 && (nowMs - existing.at < ttl));
    const trajHit = !options.bypassCache &&
      Boolean(existing && Array.isArray(existing.trajMsgs)) &&
      !sigMismatch &&
      (verifiedIdleMatch || withinTtl);

    if (trajHit) {
      const trajMsgs = existing.trajMsgs;
      const merged = mergeTrajectoryAndDomMessages(trajMsgs, domTail, { busy: Boolean(options.busy) });
      // Never extend `at` on cache hits: TTL must measure elapsed time since actual RPC fetch.
      // For unknown-signature warm entries (knownOldSig === ''), record observedSig without promoting it to trajSig.
      const nextObservedSig = knownOldSig ? '' : (observedOldSig || trajSig || '');
      touchCache(sid, {
        trajMsgs,
        trajSig: knownOldSig,
        observedSig: nextObservedSig,
        domTail: domTail.length ? domTail : (existing?.domTail || []),
        merged,
        at: existing.at || 0,
        gen: existing.gen || 0
      });
      return { merged, trajMsgs };
    }

    const fetchRes = await fetchTrajectoryMessages(sid, { ...options, trajSig });
    const latestExisting = cache.get(sid);
    const latestGen = fetchGenMap.get(sid) || 0;
    const isSuperseded = Boolean(
      !fetchRes ||
      fetchRes.gen < latestGen ||
      (latestExisting?.gen && latestExisting.gen > fetchRes.gen)
    );
    const fetchedMsgs = Array.isArray(fetchRes?.messages) ? fetchRes.messages : null;
    const trajFetchedFresh = Boolean(fetchedMsgs && fetchRes.fetchedSig === trajSig);

    if (isSuperseded) {
      const activeTrajMsgs = Array.isArray(latestExisting?.trajMsgs)
        ? latestExisting.trajMsgs
        : (fetchedMsgs || (Array.isArray(existing?.trajMsgs) ? existing.trajMsgs : null));
      const merged = mergeTrajectoryAndDomMessages(activeTrajMsgs, domTail, { busy: Boolean(options.busy) });
      return { merged, trajMsgs: activeTrajMsgs };
    }

    const baseRec = latestExisting || existing;
    let trajMsgs = null;
    if (trajFetchedFresh) {
      trajMsgs = fetchedMsgs;
    } else if (baseRec && Array.isArray(baseRec.trajMsgs)) {
      trajMsgs = baseRec.trajMsgs;
    }

    const merged = mergeTrajectoryAndDomMessages(trajMsgs, domTail, { busy: Boolean(options.busy) });
    const nextTrajSig = trajFetchedFresh ? trajSig : String(baseRec?.trajSig || '');
    const nextObservedSig = trajFetchedFresh ? '' : String(baseRec?.observedSig || '');
    const nextAt = trajFetchedFresh ? fetchRes.startedAt : (baseRec?.at || 0);
    const nextGen = trajFetchedFresh ? fetchRes.gen : (baseRec?.gen || 0);
    const persistedTrajMsgs = Array.isArray(trajMsgs)
      ? trajMsgs
      : (Array.isArray(baseRec?.trajMsgs) ? baseRec.trajMsgs : null);
    touchCache(sid, {
      trajMsgs: persistedTrajMsgs,
      trajSig: nextTrajSig,
      observedSig: nextObservedSig,
      domTail: domTail.length ? domTail : (baseRec?.domTail || []),
      merged,
      at: nextAt,
      gen: nextGen
    });
    return { merged, trajMsgs: persistedTrajMsgs };
  }

  async function warmSession(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid || sid === 'new') return;
    const existing = cache.get(sid);
    if (existing && Array.isArray(existing.trajMsgs)) return;
    const activeInflight = findInflightBySession(sid);
    if (activeInflight) {
      await activeInflight.promise;
      return;
    }
    const warmSig = String(options.trajSig || '').trim();
    const fetchRes = await fetchTrajectoryMessages(sid, { ...options, trajSig: warmSig });
    if (
      Array.isArray(fetchRes?.messages) &&
      fetchRes.gen === (fetchGenMap.get(sid) || 0) &&
      !cache.get(sid)?.trajMsgs
    ) {
      touchCache(sid, {
        trajMsgs: fetchRes.messages,
        trajSig: fetchRes.fetchedSig || '',
        observedSig: '',
        domTail: [],
        merged: [],
        at: fetchRes.startedAt,
        gen: fetchRes.gen
      });
    }
  }

  async function enrichMessages(snap, options = {}) {
    if (!snap || typeof snap !== 'object' || snap.ok === false) return snap;
    const { _activeTrajSig, ...cleanSnap } = snap;
    const { merged: fullMsgs, trajMsgs } = await resolveFullMessages(cleanSnap.sessionId, cleanSnap.messages, {
      ...options,
      trajSig: _activeTrajSig || '',
      busy: Boolean(cleanSnap.busy)
    });
    const rawLimit = options.msgLimit === undefined ? 30 : Math.max(0, Number(options.msgLimit) || 0);
    const startIdx = (rawLimit > 0 && fullMsgs.length > rawLimit) ? (fullMsgs.length - rawLimit) : 0;
    const sliced = ensureMessagesHtmlRendered(fullMsgs.slice(startIdx), trajMsgs);
    return {
      ...cleanSnap,
      totalMessages: fullMsgs.length,
      messagesStartIndex: startIdx,
      hasEarlierMessages: startIdx > 0,
      historySource: trajMsgs ? 'trajectory' : 'dom',
      messages: sliced
    };
  }

  async function getMessagesPage(options = {}) {
    const sid = String(options.sessionId || '').trim();
    if (!sid) return { ok: false, error: '缺少 sessionId 参数' };
    const limit = Math.max(1, Math.min(200, Number.parseInt(options.limit ?? 30, 10) || 30));
    const existing = cache.get(sid);
    const hasBefore = options.before !== undefined && options.before !== null && options.before !== '';
    const parsedBefore = hasBefore ? Number.parseInt(options.before, 10) : NaN;
    if (
      hasBefore &&
      !options.bypassCache &&
      !options.trajSig &&
      existing &&
      Array.isArray(existing.merged) &&
      existing.merged.length > 0 &&
      Number.isFinite(parsedBefore) &&
      parsedBefore > 0 &&
      parsedBefore <= existing.merged.length
    ) {
      const endIdx = parsedBefore;
      const startIdx = Math.max(0, endIdx - limit);
      return {
        ok: true,
        sessionId: sid,
        totalMessages: existing.merged.length,
        startIndex: startIdx,
        endIndex: endIdx,
        hasEarlier: startIdx > 0,
        messages: ensureMessagesHtmlRendered(existing.merged.slice(startIdx, endIdx), existing.trajMsgs)
      };
    }

    const { merged: fullMsgs, trajMsgs } = await resolveFullMessages(sid, existing?.domTail || [], options);
    const total = fullMsgs.length;
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
      messages: ensureMessagesHtmlRendered(fullMsgs.slice(startIdx, endIdx), trajMsgs)
    };
  }

  return { enrichMessages, getMessagesPage, warmSession };
}

const defaultHistoryManager = createConversationHistoryManager();

function getConversationMessagesPage(options = {}) {
  return defaultHistoryManager.getMessagesPage(options);
}

function warmConversationSession(sessionId, options = {}) {
  return defaultHistoryManager.warmSession(sessionId, options);
}

async function fetchSnapshotFromTarget(requestedTargetId, snapOptions = {}) {
  const serializedOpts = JSON.stringify({
    conversationId: String(snapOptions?.conversationId || '').trim(),
    clientId: String(snapOptions?.clientId || '').trim()
  });
  const expr = `(async () => {
    const fnAsync = window.__AGEnhancer?.getMobileSnapshotAsync;
    if (typeof fnAsync === 'function') {
      return await fnAsync(${serializedOpts});
    }
    const fn = window.__AGEnhancer?.getMobileSnapshot;
    if (typeof fn !== 'function') {
      return { ok: false, error: '当前窗口尚未注入增强挂件 (请确保 live-host 已连接)' };
    }
    return fn();
  })()`;
  const { value: snap, target, windows } = await evalInPickedTarget(requestedTargetId, expr, 7000, { idempotent: true });
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
    return { ...baseSnap, serverBootId: REMOTE_SERVER_BOOT_ID, serverBootAt: REMOTE_SERVER_BOOT_AT, snapSeq: ++remoteServerSnapSeq };
  }
}

async function performActionInTarget(payload, options = {}) {
  return await enqueueRemoteAction(async () => {
    const act = String(payload?.action || '').trim();
    const warmId = (act === 'switch-conversation' && payload?.id && String(payload.id).trim() !== 'new' && String(payload.id).trim() !== 'follow-desktop')
      ? String(payload.id).trim()
      : '';
    const warmPromise = warmId
      ? defaultHistoryManager.warmSession(warmId).catch(() => null)
      : Promise.resolve();
    const serialized = JSON.stringify(payload || {});
    const expr = `(async () => {
      const fn = window.__AGEnhancer?.performMobileAction;
      if (typeof fn !== 'function') {
        return { ok: false, error: '当前窗口尚未注入 v1.6.0 控制接口' };
      }
      return await fn(${serialized});
    })()`;
    const actionTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000;
    const { value: actionResult, target } = await evalInPickedTarget(payload?.targetId, expr, actionTimeoutMs, {
      idempotent: false,
      pickTarget: options.pickTarget,
      evalInTarget: options.evalInTarget
    });
    const settleMs = (act === 'switch-conversation' || act === 'new-conversation')
      ? (actionResult?.verifiedState ? 45 : 180)
      : 80;
    await Promise.all([new Promise((r) => setTimeout(r, settleMs)), warmPromise]);
    const snapConvId = act === 'switch-conversation'
      ? (payload?.id && payload.id !== 'new' && payload.id !== 'follow-desktop' ? String(payload.id) : '')
      : (act === 'new-conversation' ? '' : (payload?.conversationId ? String(payload.conversationId) : ''));
    const snapshot = await fetchSnapshotFromTarget(target.id, {
      convLimit: 100,
      conversationId: snapConvId,
      clientId: payload?.clientId ? String(payload.clientId) : '',
      bypassCache: act === 'send',
      bypassCatalogCache: act === 'switch-conversation' || act === 'new-conversation'
    }).catch(() => null);
    return {
      ok: Boolean(actionResult?.ok),
      actionResult: actionResult || null,
      snapshot
    };
  });
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
    :root{color-scheme:light dark}
    body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:#09090b;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
    .card{max-width:400px;width:100%;padding:22px;border-radius:16px;background:#18181b;border:1px solid rgba(255,255,255,.12);line-height:1.6}
    h1{margin:0 0 10px;font-size:18px}
    p{margin:0 0 12px;color:#a1a1aa;font-size:14px}
    code{display:block;padding:10px 12px;border-radius:10px;background:#09090b;color:#38bdf8;font-size:13px;border:1px solid rgba(56,189,248,.25)}
    @media (prefers-color-scheme:light){
      body{background:#f8fafc;color:#18181b}
      .card{background:#ffffff;border-color:rgba(15,23,42,.12);box-shadow:0 8px 28px rgba(15,23,42,.06)}
      p{color:#52525b}
      code{background:#f1f5f9;color:#0284c7;border-color:rgba(2,132,199,.28)}
    }
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
  <meta id="meta-theme-color" name="theme-color" content="#09090b">
  <title>Antigravity Remote</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon.svg">
  <script id="ag-theme-boot">(function(){try{var p=localStorage.getItem('ag_remote_theme_v1');if(p!=='light'&&p!=='dark'&&p!=='system')p='system';var l=p==='light'||(p==='system'&&typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: light)').matches);var t=l?'light':'dark';var d=document.documentElement;d.setAttribute('data-theme',t);d.setAttribute('data-theme-pref',p);d.style.colorScheme=t;var m=document.getElementById('meta-theme-color');if(m)m.setAttribute('content',l?'#f8fafc':'#09090b');}catch{}})();</script>
  <style>
    :root{
      color-scheme:dark;
      --bg:#09090b;--topbar-bg:rgba(12,12,15,.88);--topbar-border:rgba(255,255,255,.07);
      --drawer-bg:#18181b;--sidebar-bg:#111114;--sidebar-border:rgba(255,255,255,.08);
      --card:#18181b;--card2:#27272a;--composer-bg:#16161a;--composer-border:rgba(255,255,255,.11);
      --composer-shadow:0 8px 28px rgba(0,0,0,.45);--composer-shadow-lg:0 12px 36px rgba(0,0,0,.4);
      --approval-dock-bg:rgba(24,24,27,.98);
      --surface-subtle:rgba(255,255,255,.04);--surface-soft:rgba(255,255,255,.05);--surface-hover:rgba(255,255,255,.08);
      --surface-strong:rgba(255,255,255,.07);--surface-strong-hover:rgba(255,255,255,.11);
      --border:rgba(255,255,255,.1);--border-subtle:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.16);
      --fg:#f4f4f5;--fg-strong:#fafafa;--fg-secondary:#e4e4e7;--fg-sub:#d4d4d8;--muted:#a1a1aa;--placeholder:#71717a;
      --accent:#38bdf8;--accent-fg:#7dd3fc;--accent-strong-fg:#bae6fd;--accent-bg:rgba(56,189,248,.1);--accent-border:rgba(56,189,248,.32);
      --green:#34d399;--amber:#fbbf24;--red:#f87171;--risk-fg:#fca5a5;--risk-bg:rgba(239,68,68,.14);
      --code-bg:rgba(255,255,255,.1);--pre-bg:#09090b;--qbar-bg:rgba(255,255,255,.12);--thought-summary:#93c5fd;
      --ap-approve-bg:#10b981;--ap-approve-fg:#052e16;--ap-reject-bg:#3f3f46;--ap-reject-fg:#f4f4f5;
      --user-bg:#1d4ed8;--user-fg:#f8fafc;--send-ready-fg:#082f49;
      --toast-bg:#27272a;--toast-fg:#fff;--backdrop-bg:rgba(0,0,0,.58);
      --pop-shadow:0 16px 40px rgba(0,0,0,.6);--sheet-shadow:0 24px 64px rgba(0,0,0,.65);
      --scroll-thumb:rgba(255,255,255,.14);--scroll-thumb-hover:rgba(255,255,255,.26);
      --seg-track:rgba(255,255,255,.05);--seg-active-bg:#27272a;--seg-active-shadow:0 1px 3px rgba(0,0,0,.35);
      --input-bg:rgba(9,9,11,.75);
      --proj-head-bg:rgba(255,255,255,.06);--proj-head-border:rgba(255,255,255,.09);
      --proj-count-bg:rgba(255,255,255,.09);
      --badge-run-bg:rgba(34,197,94,.16);--badge-run-fg:#86efac;
      --badge-wait-bg:rgba(245,158,11,.18);--badge-wait-fg:#fde68a;
      --badge-err-bg:rgba(239,68,68,.18);--badge-err-fg:#fca5a5;
      --badge-unk-bg:rgba(113,113,122,.18);--badge-unk-fg:#a1a1aa;
      --git-tag-bg:rgba(52,211,153,.15);--git-tag-fg:#6ee7b7;
      --warn-card-bg:rgba(245,158,11,.12);--warn-card-border:rgba(245,158,11,.55);--warn-card-fg:#fde68a;
      --perm-review:#c084fc;
      --app-h:100dvh;
      --modal-h:100dvh;
    }
    @media (prefers-color-scheme:light){
      :root:not([data-theme="dark"]){
        color-scheme:light;
        --bg:#f8fafc;--topbar-bg:rgba(248,250,252,.88);--topbar-border:rgba(15,23,42,.08);
        --drawer-bg:#ffffff;--sidebar-bg:#f1f5f9;--sidebar-border:rgba(15,23,42,.08);
        --card:#ffffff;--card2:#e2e8f0;--composer-bg:#ffffff;--composer-border:rgba(15,23,42,.13);
        --composer-shadow:0 6px 24px rgba(15,23,42,.07);--composer-shadow-lg:0 10px 30px rgba(15,23,42,.08);
        --approval-dock-bg:rgba(248,250,252,.96);
        --surface-subtle:rgba(15,23,42,.035);--surface-soft:rgba(15,23,42,.045);--surface-hover:rgba(15,23,42,.07);
        --surface-strong:#ffffff;--surface-strong-hover:rgba(15,23,42,.06);
        --border:rgba(15,23,42,.1);--border-subtle:rgba(15,23,42,.07);--border-strong:rgba(15,23,42,.15);
        --fg:#18181b;--fg-strong:#09090b;--fg-secondary:#27272a;--fg-sub:#3f3f46;--muted:#52525b;--placeholder:#71717a;
        --accent:#0284c7;--accent-fg:#0369a1;--accent-strong-fg:#075985;--accent-bg:rgba(2,132,199,.09);--accent-border:rgba(2,132,199,.3);
        --green:#059669;--amber:#d97706;--red:#dc2626;--risk-fg:#b91c1c;--risk-bg:rgba(239,68,68,.09);
        --code-bg:rgba(15,23,42,.06);--pre-bg:#f1f5f9;--qbar-bg:rgba(15,23,42,.1);--thought-summary:#0284c7;
        --ap-approve-bg:#059669;--ap-approve-fg:#ffffff;--ap-reject-bg:#e4e4e7;--ap-reject-fg:#18181b;
        --user-bg:#2563eb;--user-fg:#ffffff;--send-ready-fg:#ffffff;
        --toast-bg:#18181b;--toast-fg:#fafafa;--backdrop-bg:rgba(15,23,42,.36);
        --pop-shadow:0 14px 36px rgba(15,23,42,.14);--sheet-shadow:0 20px 56px rgba(15,23,42,.18);
        --scroll-thumb:rgba(15,23,42,.18);--scroll-thumb-hover:rgba(15,23,42,.32);
        --seg-track:rgba(15,23,42,.06);--seg-active-bg:#ffffff;--seg-active-shadow:0 1px 3px rgba(15,23,42,.12);
        --input-bg:#f8fafc;
        --proj-head-bg:rgba(15,23,42,.055);--proj-head-border:rgba(15,23,42,.1);
        --proj-count-bg:rgba(15,23,42,.08);
        --badge-run-bg:rgba(5,150,105,.13);--badge-run-fg:#047857;
        --badge-wait-bg:rgba(217,119,6,.14);--badge-wait-fg:#b45309;
        --badge-err-bg:rgba(220,38,38,.13);--badge-err-fg:#b91c1c;
        --badge-unk-bg:rgba(82,82,91,.12);--badge-unk-fg:#52525b;
        --git-tag-bg:rgba(5,150,105,.13);--git-tag-fg:#047857;
        --warn-card-bg:rgba(245,158,11,.12);--warn-card-border:rgba(217,119,6,.5);--warn-card-fg:#92400e;
        --perm-review:#7c3aed;
      }
    }
    html[data-theme="light"]{
      color-scheme:light;
      --bg:#f8fafc;--topbar-bg:rgba(248,250,252,.88);--topbar-border:rgba(15,23,42,.08);
      --drawer-bg:#ffffff;--sidebar-bg:#f1f5f9;--sidebar-border:rgba(15,23,42,.08);
      --card:#ffffff;--card2:#e2e8f0;--composer-bg:#ffffff;--composer-border:rgba(15,23,42,.13);
      --composer-shadow:0 6px 24px rgba(15,23,42,.07);--composer-shadow-lg:0 10px 30px rgba(15,23,42,.08);
      --approval-dock-bg:rgba(248,250,252,.96);
      --surface-subtle:rgba(15,23,42,.035);--surface-soft:rgba(15,23,42,.045);--surface-hover:rgba(15,23,42,.07);
      --surface-strong:#ffffff;--surface-strong-hover:rgba(15,23,42,.06);
      --border:rgba(15,23,42,.1);--border-subtle:rgba(15,23,42,.07);--border-strong:rgba(15,23,42,.15);
      --fg:#18181b;--fg-strong:#09090b;--fg-secondary:#27272a;--fg-sub:#3f3f46;--muted:#52525b;--placeholder:#71717a;
      --accent:#0284c7;--accent-fg:#0369a1;--accent-strong-fg:#075985;--accent-bg:rgba(2,132,199,.09);--accent-border:rgba(2,132,199,.3);
      --green:#059669;--amber:#d97706;--red:#dc2626;--risk-fg:#b91c1c;--risk-bg:rgba(239,68,68,.09);
      --code-bg:rgba(15,23,42,.06);--pre-bg:#f1f5f9;--qbar-bg:rgba(15,23,42,.1);--thought-summary:#0284c7;
      --ap-approve-bg:#059669;--ap-approve-fg:#ffffff;--ap-reject-bg:#e4e4e7;--ap-reject-fg:#18181b;
      --user-bg:#2563eb;--user-fg:#ffffff;--send-ready-fg:#ffffff;
      --toast-bg:#18181b;--toast-fg:#fafafa;--backdrop-bg:rgba(15,23,42,.36);
      --pop-shadow:0 14px 36px rgba(15,23,42,.14);--sheet-shadow:0 20px 56px rgba(15,23,42,.18);
      --scroll-thumb:rgba(15,23,42,.18);--scroll-thumb-hover:rgba(15,23,42,.32);
      --seg-track:rgba(15,23,42,.06);--seg-active-bg:#ffffff;--seg-active-shadow:0 1px 3px rgba(15,23,42,.12);
      --input-bg:#f8fafc;
      --proj-head-bg:rgba(15,23,42,.055);--proj-head-border:rgba(15,23,42,.1);
      --proj-count-bg:rgba(15,23,42,.08);
      --badge-run-bg:rgba(5,150,105,.13);--badge-run-fg:#047857;
      --badge-wait-bg:rgba(217,119,6,.14);--badge-wait-fg:#b45309;
      --badge-err-bg:rgba(220,38,38,.13);--badge-err-fg:#b91c1c;
      --badge-unk-bg:rgba(82,82,91,.12);--badge-unk-fg:#52525b;
      --git-tag-bg:rgba(5,150,105,.13);--git-tag-fg:#047857;
      --warn-card-bg:rgba(245,158,11,.12);--warn-card-border:rgba(217,119,6,.5);--warn-card-fg:#92400e;
      --perm-review:#7c3aed;
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
      border-bottom:1px solid var(--topbar-border);background:var(--topbar-bg);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    }
    .icon-btn{
      appearance:none;border:none;background:transparent;color:var(--muted);
      border-radius:10px;height:34px;min-width:34px;padding:0 6px;
      display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;
    }
    .icon-btn:active{background:var(--surface-hover);color:var(--fg-strong)}
    .title-wrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
    .title-row{display:flex;align-items:center;gap:6px;min-width:0}
    .dot{width:7px;height:7px;border-radius:99px;background:var(--green);flex-shrink:0}
    .dot.busy{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .dot.err{background:var(--red)}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}
    .conv-title{font-size:15px;font-weight:600;color:var(--fg-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
    .sub-meta{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;cursor:pointer;display:inline-flex;align-items:center;gap:3px}
    .sub-meta:active{color:var(--accent)}
    .quota-pill{
      appearance:none;border:1px solid var(--border);background:var(--surface-soft);color:var(--fg-secondary);
      border-radius:11px;padding:5px 10px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
      flex-shrink:0;cursor:pointer;display:flex;flex-direction:column;align-items:flex-end;line-height:1.2;gap:1px;
    }
    .quota-pill span:last-child{font-size:11.5px;color:var(--muted);font-weight:500}
    .quota-drawer{
      position:fixed;top:calc(env(safe-area-inset-top) + 52px);right:10px;left:10px;max-width:360px;margin-left:auto;
      z-index:60;background:var(--card);border:1px solid var(--border-strong);border-radius:14px;
      padding:12px;box-shadow:var(--pop-shadow);
    }
    .quota-drawer[hidden]{display:none}
    .qcard{padding:8px 10px;border-radius:10px;background:var(--surface-subtle);border:1px solid var(--border);margin-bottom:8px}
    .qhead{display:flex;justify-content:space-between;font-weight:600;font-size:13.5px;margin-bottom:6px}
    .qsub{margin-top:5px}
    .qsub-row{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px}
    .qbar{height:5px;border-radius:99px;background:var(--qbar-bg);overflow:hidden}
    .qfill{height:100%;border-radius:99px}
    .qreset{font-size:11.5px;color:var(--muted);margin-top:2px}
    .messages{
      position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
      padding:14px 16px 12px;display:flex;flex-direction:column;gap:16px;
    }
    .msg{word-break:break-word}
    .msg.user{
      align-self:flex-end;max-width:84%;padding:10px 14px;border-radius:18px 18px 4px 18px;
      background:var(--user-bg);color:var(--user-fg);
      font-size:14.5px;line-height:1.48;white-space:pre-wrap;
      box-shadow:none;
    }
    .msg.assistant{align-self:stretch;background:transparent;border:none;padding:2px 2px}
    .msg.assistant .msg-plain{white-space:pre-wrap;font-size:14.5px;line-height:1.65;color:var(--fg-secondary)}
    .msg.assistant.is-risk{padding:10px 12px;border-radius:14px;background:var(--risk-bg);border:1px solid rgba(248,113,113,.5)}
    .busy-pill{
      display:inline-flex;align-items:center;gap:8px;align-self:flex-start;
      padding:6px 12px;border-radius:999px;background:var(--surface-subtle);border:1px solid var(--border-subtle);
      font-size:12.5px;color:var(--muted);
    }
    .busy-spark{width:7px;height:7px;border-radius:99px;background:var(--accent);animation:pulse 1s infinite ease-in-out}
    .md-body{font-size:14px;line-height:1.62;color:var(--fg)}
    .md-body>:first-child{margin-top:0}
    .md-body>:last-child{margin-bottom:0}
    .md-body h1{font-size:19px;font-weight:700;margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--border);line-height:1.35;color:var(--fg-strong)}
    .md-body h2{font-size:17px;font-weight:700;margin:12px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--topbar-border);line-height:1.35;color:var(--fg-strong)}
    .md-body h3{font-size:15.5px;font-weight:700;margin:11px 0 5px;line-height:1.38;color:var(--fg)}
    .md-body h4,.md-body h5,.md-body h6{font-size:14.5px;font-weight:600;margin:9px 0 4px;color:var(--fg-secondary)}
    .md-body p{margin:6px 0}
    .md-body ul,.md-body ol{margin:6px 0;padding-left:20px}
    .md-body li{margin:4px 0}
    .md-body li>p{margin:2px 0}
    .md-body strong,.md-body b{font-weight:700;color:var(--fg-strong)}
    .md-body em{color:var(--fg-secondary)}
    .md-body hr{border:none;border-top:1px solid var(--border);margin:10px 0}
    .md-body a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
    .md-body blockquote{margin:8px 0;padding:6px 10px;border-left:3px solid var(--accent);background:var(--accent-bg);border-radius:0 8px 8px 0;color:var(--fg-sub)}
    .md-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;padding:1px 5px;border-radius:5px;background:var(--code-bg);color:var(--accent-fg)}
    .md-body code.md-pill{background:var(--accent-bg);border:1px solid var(--accent-border);color:var(--accent-strong-fg)}
    .md-body pre{margin:8px 0;padding:10px 12px;border-radius:10px;background:var(--pre-bg);border:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch}
    .md-body pre code{background:none;padding:0;border:none;color:var(--fg-secondary);font-size:12px;line-height:1.5;white-space:pre}
    .md-table-wrap{margin:8px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:10px}
    .md-body table{width:max-content;min-width:100%;border-collapse:collapse;font-size:12.5px}
    .md-body th,.md-body td{padding:6px 9px;border-bottom:1px solid var(--border-subtle);border-right:1px solid var(--topbar-border);text-align:left;vertical-align:top;max-width:260px}
    .md-body th{background:var(--surface-soft);font-weight:600;color:var(--fg-strong)}
    .md-body tr:last-child td{border-bottom:none}
    .md-body th:last-child,.md-body td:last-child{border-right:none}
    .risk-tag{
      display:block;margin-bottom:6px;padding:4px 8px;border-radius:8px;
      background:var(--risk-bg);border:1px solid rgba(239,68,68,.45);color:var(--risk-fg);font-size:12.5px;font-weight:600;
    }
    .thought-box{margin-bottom:8px;padding:6px 9px;border-radius:9px;background:var(--surface-subtle);border:1px solid var(--border-subtle);font-size:12.5px;color:var(--fg-sub)}
    .thought-box summary{cursor:pointer;font-weight:600;color:var(--thought-summary);list-style:none}
    .thought-body{margin-top:6px;white-space:pre-wrap;color:var(--muted);max-height:220px;overflow-y:auto}
    .messages.is-switching{opacity:.58;transition:opacity .12s ease}
    .empty-tip{margin:auto;text-align:center;color:var(--muted);padding:24px 12px;font-size:13px}
    .mode-entry-card{
      margin:auto;width:100%;max-width:400px;padding:16px 14px;border-radius:16px;
      background:var(--card);border:1px solid var(--border);
      display:flex;flex-direction:column;gap:10px;
    }
    .mode-entry-title{font-size:13px;font-weight:600;color:var(--fg-secondary);line-height:1.45}
    .mode-entry-list{display:flex;flex-direction:column;gap:8px}
    .mode-entry-btn{
      appearance:none;width:100%;padding:10px 12px;border-radius:11px;
      border:1px solid var(--border);background:var(--surface-subtle);color:var(--fg);
      display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;cursor:pointer;
      transition:border-color .15s ease,background-color .15s ease;
    }
    .mode-entry-btn:active{background:var(--accent-bg);border-color:var(--accent)}
    .mode-entry-btn.active{border-color:var(--accent);background:var(--accent-bg)}
    .mode-entry-left{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
    .mode-entry-name{font-size:13.5px;font-weight:600;color:var(--fg-strong)}
    .mode-entry-host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mode-entry-tag{font-size:11.5px;font-weight:600;color:var(--accent);flex-shrink:0;white-space:nowrap}
    .approval-dock{
      flex-shrink:0;padding:8px 10px;background:var(--approval-dock-bg);border-top:1px solid var(--border);
      display:flex;flex-direction:column;gap:6px;
    }
    .approval-dock[hidden]{display:none}
    .approval-card{
      padding:8px 10px;border-radius:12px;background:var(--accent-bg);border:1px solid var(--accent-border);
      display:flex;flex-direction:column;gap:6px;
    }
    .approval-card.is-risk{background:var(--risk-bg);border-color:rgba(248,113,113,.8)}
    .approval-ctx{font-size:12.5px;color:var(--fg-secondary);max-height:54px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
    .approval-btns{display:flex;gap:8px;flex-wrap:wrap}
    .ap-btn{
      flex:1 1 110px;min-height:42px;border-radius:10px;border:none;font-size:14px;font-weight:700;cursor:pointer;
    }
    .ap-btn.approve{background:var(--ap-approve-bg);color:var(--ap-approve-fg)}
    .ap-btn.reject{background:var(--ap-reject-bg);color:var(--ap-reject-fg);border:1px solid var(--border)}
    .composer-dock{
      flex-shrink:0;background:transparent;padding:2px 10px 4px;
      display:flex;flex-direction:column;gap:6px;
    }
    .chips{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 2px}
    .chips::-webkit-scrollbar{display:none}
    .chip{
      appearance:none;flex-shrink:0;border:1px solid var(--border-subtle);background:var(--surface-subtle);color:var(--muted);
      border-radius:999px;padding:5px 11px;font-size:12.5px;white-space:nowrap;cursor:pointer;
    }
    .chip.suggest{border-color:var(--accent-border);background:var(--accent-bg);color:var(--accent-fg);font-weight:500}
    .attach-hint{
      display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 12px;border-radius:12px;
      background:var(--accent-bg);border:1px solid var(--accent-border);font-size:12.5px;color:var(--accent-strong-fg);
    }
    .attach-hint[hidden]{display:none}
    .composer-card{
      background:var(--composer-bg);border:1px solid var(--composer-border);border-radius:22px;
      padding:10px 10px 8px 12px;display:flex;flex-direction:column;gap:6px;
      box-shadow:var(--composer-shadow);transition:border-color .15s ease;
    }
    .composer-card:focus-within{border-color:var(--accent-border)}
    .composer-card textarea{
      width:100%;min-height:28px;max-height:148px;resize:none;border:none;background:transparent;
      color:var(--fg);padding:2px 4px;font-size:16px;line-height:1.42;font-family:inherit;outline:none;
    }
    .composer-card textarea::placeholder{color:var(--placeholder)}
    .composer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:6px;padding-top:2px}
    .toolbar-left{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto}
    .toolbar-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .ghost-btn{
      appearance:none;border:none;background:transparent;color:var(--muted);
      height:32px;padding:0 7px;border-radius:999px;font-size:12.5px;font-weight:500;
      display:inline-flex;align-items:center;gap:4px;cursor:pointer;min-width:0;max-width:100%;
    }
    .ghost-btn:active{background:var(--surface-hover);color:var(--fg-strong)}
    .ghost-btn.icon-only{width:32px;padding:0;justify-content:center}
    .ghost-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .send-circle{
      appearance:none;flex-shrink:0;width:32px;height:32px;border-radius:999px;border:none;
      background:var(--card2);color:var(--placeholder);display:inline-flex;align-items:center;justify-content:center;
      cursor:pointer;transition:background-color .15s ease,color .15s ease,transform .1s ease;
    }
    .send-circle.ready{background:var(--accent);color:var(--send-ready-fg)}
    .send-circle.stop{background:var(--risk-bg);color:var(--red);border:1px solid rgba(248,113,113,.45)}
    .send-circle.pending{background:var(--card2);color:var(--muted);border:1px solid var(--border);cursor:not-allowed;pointer-events:none}
    .send-circle:active{transform:scale(.94)}
    .send-circle:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
    .send-circle:disabled:active{transform:none}
    [hidden],.sheet-speed-btn[hidden],.sheet-sub-text[hidden],.sheet-back-btn[hidden]{display:none!important}
    .sheet-backdrop{
      position:fixed;top:0;left:0;right:0;height:var(--modal-h,100dvh);z-index:75;background:var(--backdrop-bg);box-shadow:0 0 0 100vmax var(--backdrop-bg);display:flex;align-items:flex-end;justify-content:center;
    }
    .sheet-backdrop[hidden]{display:none}
    .sheet{
      width:100%;max-width:520px;max-height:min(calc(var(--modal-h,100dvh) * 0.72),calc(var(--modal-h,100dvh) - env(safe-area-inset-top,0px) - 16px));background:var(--card);border-top:1px solid var(--border-strong);
      border-radius:18px 18px 0 0;padding:12px 14px calc(env(safe-area-inset-bottom) + 14px);box-shadow:0 240px 0 0 var(--card);
      display:flex;flex-direction:column;gap:8px;overflow:hidden;
    }
    .sheet-title{font-size:15px;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0}
    .sheet-title-left{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
    .sheet-sub-text{font-size:11.5px;font-weight:400;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sheet-title-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .sheet-back-btn{
      appearance:none;height:28px;padding:0 9px;border-radius:8px;
      border:1px solid var(--border-strong);background:var(--surface-subtle);color:var(--fg);
      font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:4px;cursor:pointer;flex-shrink:0;
    }
    .sheet-back-btn:active{background:var(--surface-hover)}
    .sheet-speed-btn{
      appearance:none;height:28px;padding:0 10px;border-radius:8px;
      border:1px solid var(--accent-border);background:var(--accent-bg);color:var(--accent-strong-fg);
      font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:5px;cursor:pointer;
    }
    .sheet-speed-btn:active{filter:brightness(1.08)}
    .sheet-speed-btn:disabled{opacity:.65;cursor:default}
    .sheet-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;-webkit-overflow-scrolling:touch}
    .sheet-stage-viewport{width:100%;overflow:hidden}
    .sheet-stage-track{display:flex;width:200%;align-items:flex-start;transition:transform .24s cubic-bezier(.22,1,.36,1);will-change:transform}
    .sheet-stage-track.step-effort{transform:translateX(-50%)}
    .sheet-stage-pane{width:50%;flex:0 0 50%;display:flex;flex-direction:column;gap:6px;max-height:56dvh;overflow-y:auto;padding-right:2px;-webkit-overflow-scrolling:touch}
    .sheet-opt.sliding-out{background:rgba(56,189,248,.18);border-color:rgba(56,189,248,.55)}
    .sheet-opt{
      width:100%;text-align:left;padding:11px 12px;border-radius:11px;border:1px solid var(--border);
      background:var(--surface-subtle);color:var(--fg);font-size:14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;
    }
    .sheet-opt.active{border-color:var(--accent);background:var(--accent-bg);color:var(--fg-strong);font-weight:600}
    .sheet-opt-left{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
    .sheet-opt-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .sheet-opt-host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sheet-opt-right,.mode-entry-right{display:inline-flex;align-items:center;gap:7px;flex-shrink:0;margin-left:8px}
    .mode-pill{font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:999px;line-height:1.4}
    .mode-pill.fast{background:rgba(52,211,153,.16);color:#10b981;border:1px solid rgba(52,211,153,.35)}
    .mode-pill.cur{background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent-border)}
    .lat-badge{font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;padding:2px 7px;border-radius:999px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
    .lat-badge.fast{background:rgba(52,211,153,.14);color:#10b981}
    .lat-badge.mid{background:rgba(251,191,36,.14);color:#d97706}
    .lat-badge.slow{background:rgba(249,115,22,.16);color:#ea580c}
    .lat-badge.err{background:rgba(248,113,113,.14);color:#ef4444}
    .lat-badge.muted,.lat-badge.pending{background:var(--surface-subtle);color:var(--muted)}
    .mini-spin{display:inline-block;width:11px;height:11px;border-radius:999px;border:1.5px solid var(--accent-border);border-top-color:var(--accent);animation:agspin .7s linear infinite;flex-shrink:0}
    @keyframes agspin{to{transform:rotate(360deg)}}
    .drawer-backdrop{
      position:fixed;top:0;left:0;right:0;height:var(--modal-h,100dvh);z-index:70;background:rgba(0,0,0,0);display:flex;justify-content:flex-start;
      opacity:0;visibility:hidden;pointer-events:none;
      transition:opacity .22s ease,visibility .22s ease,background-color .22s ease;
    }
    .drawer-backdrop.open{
      background:var(--backdrop-bg);opacity:1;visibility:visible;pointer-events:auto;
    }
    .drawer-backdrop.dragging{
      transition:none;opacity:1;visibility:visible;pointer-events:auto;
    }
    .drawer{
      width:min(82vw,320px);height:100%;background:var(--drawer-bg);border-right:1px solid var(--border);
      padding:calc(env(safe-area-inset-top) + 12px) 12px calc(16px + env(safe-area-inset-bottom));
      display:flex;flex-direction:column;gap:10px;overflow:hidden;
      transform:translateX(-100%);transition:transform .24s cubic-bezier(.22,1,.36,1);
      will-change:transform;
    }
    .drawer-backdrop.open .drawer{transform:translateX(0)}
    .drawer-backdrop.dragging .drawer{transition:none}
    .new-chat-group{display:flex;align-items:stretch;gap:6px;flex-shrink:0}
    .new-chat-btn{
      appearance:none;flex:1 1 auto;min-width:0;min-height:44px;padding:6px 10px;border-radius:12px;
      background:var(--surface-strong);border:1px solid var(--border);color:var(--fg-strong);
      font-size:14px;font-weight:600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;
    }
    .new-chat-main{display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;line-height:1.2}
    .new-chat-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .new-chat-sub{display:block;width:100%;max-width:100%;font-size:10.5px;font-weight:500;line-height:1.22;color:var(--muted);white-space:normal;overflow-wrap:anywhere;word-break:break-word;text-align:center}
    .new-chat-sub[hidden]{display:none}
    .new-chat-pick-btn{
      appearance:none;width:42px;min-height:44px;flex-shrink:0;border-radius:12px;
      background:var(--surface-strong);border:1px solid var(--border);color:var(--fg-sub);
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
    }
    .new-chat-btn:active,.new-chat-pick-btn:active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--fg-strong)}
    .conv-toolbar{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .conv-view-tabs{
      flex:1 1 auto;min-width:0;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:3px;border-radius:10px;
      background:var(--seg-track);border:1px solid var(--border-subtle);
    }
    .conv-tab{
      appearance:none;border:none;background:transparent;color:var(--muted);border-radius:7px;
      padding:6px 8px;font-size:12px;font-weight:600;cursor:pointer;
      display:inline-flex;align-items:center;justify-content:center;gap:4px;
    }
    .conv-tab.active{background:var(--accent-bg);color:var(--accent-strong-fg)}
    .tab-count{font-size:11px;opacity:.78;font-variant-numeric:tabular-nums}
    .new-proj-mini-btn{
      appearance:none;width:34px;height:34px;padding:0;border-radius:10px;flex-shrink:0;
      border:1px solid var(--border-subtle);background:var(--surface-subtle);color:var(--muted);
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
      transition:background-color .14s ease,border-color .14s ease,color .14s ease;
    }
    .new-proj-mini-btn:active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--accent-strong-fg)}
    .proj-group{display:flex;flex-direction:column;gap:5px;margin-top:6px}
    .proj-group:first-child{margin-top:0}
    .proj-head{
      display:flex;align-items:center;gap:4px;padding:3px 5px 3px 3px;border-radius:11px;
      background:var(--proj-head-bg);border:1px solid var(--proj-head-border);
      transition:background-color .14s ease,border-color .14s ease;
    }
    .proj-group.is-current .proj-head{
      background:var(--accent-bg);border-color:var(--accent-border);
    }
    .proj-toggle{
      appearance:none;flex:1 1 auto;min-width:0;border:none;background:transparent;color:var(--fg-strong);
      padding:6px 7px;border-radius:8px;font-size:14.5px;font-weight:700;letter-spacing:-.01em;
      display:flex;align-items:center;gap:6px;cursor:pointer;text-align:left;
    }
    .proj-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--accent);flex-shrink:0}
    .proj-group.is-ungrouped .proj-icon{color:var(--muted)}
    .proj-chev{font-size:11px;color:var(--muted);width:12px;flex-shrink:0;text-align:center;font-weight:700}
    .proj-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-stat-dot{width:6px;height:6px;border-radius:99px;flex-shrink:0}
    .proj-stat-dot.running{background:var(--green);animation:pulse 1.1s infinite ease-in-out}
    .proj-stat-dot.waiting{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .proj-count{
      margin-left:auto;padding:1px 7px;border-radius:999px;background:var(--proj-count-bg);
      font-size:11px;color:var(--fg-sub);font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;
    }
    .proj-new-btn{
      appearance:none;width:28px;height:28px;flex-shrink:0;border-radius:8px;
      border:1px solid var(--border);background:var(--surface-soft);color:var(--fg-sub);
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;line-height:1;
    }
    .proj-new-btn:active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--fg-strong)}
    .proj-body{
      display:flex;flex-direction:column;gap:4px;margin-left:11px;padding-left:9px;
      border-left:1.5px solid var(--border);
    }
    .proj-group.is-empty .proj-chev{opacity:.4}
    /* 新建项目与电脑目录浏览器弹窗 */
    .sheet.proj-modal{max-width:540px;max-height:min(680px,calc(var(--modal-h,100dvh) * 0.84),calc(var(--modal-h,100dvh) - env(safe-area-inset-top,0px) - 16px));gap:10px}
    .proj-modal-body{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:10px}
    .proj-roots-bar{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;flex-shrink:0;padding-bottom:2px}
    .proj-roots-bar::-webkit-scrollbar{display:none}
    .proj-root-pill{
      appearance:none;flex-shrink:0;padding:5px 10px;border-radius:999px;border:1px solid var(--border);
      background:var(--surface-soft);color:var(--fg-secondary);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
    }
    .proj-root-pill.active{border-color:var(--accent-border);background:var(--accent-bg);color:var(--accent-strong-fg)}
    .proj-path-row{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .proj-path-input,.proj-field-input{
      flex:1 1 auto;min-width:0;height:36px;padding:0 10px;border-radius:10px;border:1px solid var(--border);
      background:var(--input-bg);color:var(--fg);font-size:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;
    }
    .proj-field-input{font-family:inherit;font-size:16px}
    .proj-path-input:focus,.proj-field-input:focus{border-color:var(--accent-border)}
    .proj-act-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0}
    .proj-act-btn{
      appearance:none;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--border);
      background:var(--surface-soft);color:var(--fg-sub);font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px;
    }
    .proj-act-btn.active{border-color:var(--accent-border);background:var(--accent-bg);color:var(--accent-strong-fg)}
    .proj-act-btn:disabled{opacity:.42;cursor:default}
    .proj-mkdir-row{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .proj-mkdir-row[hidden]{display:none}
    .proj-dir-list{
      display:flex;flex-direction:column;gap:5px;flex:0 0 auto;min-height:104px;max-height:calc(var(--modal-h,100dvh) * 0.32);overflow-y:auto;-webkit-overflow-scrolling:touch;
      padding:2px 0;
    }
    .proj-dir-item{
      width:100%;text-align:left;padding:9px 11px;border-radius:10px;border:1px solid var(--border-subtle);
      background:var(--surface-subtle);color:var(--fg);font-size:13.5px;font-weight:500;cursor:pointer;
      display:flex;align-items:center;gap:8px;
    }
    .proj-dir-item:active{background:var(--accent-bg);border-color:var(--accent-border)}
    .proj-dir-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-dir-badges{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}
    .proj-tag{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:999px;line-height:1.4}
    .proj-tag.git{background:var(--git-tag-bg);color:var(--git-tag-fg)}
    .proj-tag.linked{background:var(--accent-bg);color:var(--accent-fg)}
    .proj-summary-card{
      padding:8px 10px;border-radius:10px;background:var(--surface-subtle);border:1px solid var(--border);
      font-size:12px;color:var(--fg-sub);display:flex;flex-direction:column;gap:3px;flex-shrink:0;
    }
    .proj-summary-card.is-warn{border-color:var(--warn-card-border);background:var(--warn-card-bg);color:var(--warn-card-fg)}
    .proj-summary-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-fg);word-break:break-all;font-size:11.5px}
    .proj-name-row{display:flex;flex-direction:column;gap:5px;flex-shrink:0}
    .proj-name-label{font-size:12px;font-weight:600;color:var(--muted)}
    .proj-primary-btn{
      appearance:none;width:100%;height:42px;border-radius:11px;border:none;background:var(--accent);color:var(--send-ready-fg);
      font-size:14.5px;font-weight:700;cursor:pointer;flex-shrink:0;
    }
    .proj-primary-btn:disabled{opacity:.5;cursor:default}
    .drawer-sub{font-size:12px;font-weight:600;color:var(--placeholder);padding:2px 4px 0;flex-shrink:0}
    .drawer-nav-bar{display:flex;align-items:center;gap:6px;min-height:26px;padding:2px 2px 0;flex-shrink:0}
    .drawer-nav-bar[hidden]{display:none}
    .drawer-back-btn{
      appearance:none;height:26px;padding:0 9px;border-radius:8px;
      border:1px solid var(--border);background:var(--surface-subtle);color:var(--fg);
      font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:3px;cursor:pointer;flex-shrink:0;
    }
    .drawer-back-btn:active{background:var(--accent-bg);border-color:var(--accent-border)}
    .drawer-proj-title{font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto}
    .proj-item{
      width:100%;text-align:left;padding:10px 11px;border-radius:11px;border:1px solid var(--border);
      background:var(--surface-subtle);color:var(--fg);font-size:13.5px;display:flex;align-items:center;
      justify-content:space-between;gap:8px;cursor:pointer;transition:background-color .14s ease,border-color .14s ease;
    }
    .proj-item.active{border-color:var(--accent);background:var(--accent-bg);font-weight:600}
    .proj-item-left{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto}
    .proj-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-item-right{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;color:var(--muted);font-size:13px}
    @keyframes agconvfade{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}
    .conv-list.anim-enter{animation:agconvfade .18s ease}
    .conv-item{
      width:100%;text-align:left;padding:9px 11px;border-radius:10px;border:1px solid transparent;
      background:var(--surface-subtle);color:var(--fg);font-size:13.5px;cursor:pointer;
      display:flex;flex-direction:column;gap:3px;
    }
    .conv-item.active{border-color:var(--accent);background:var(--accent-bg);font-weight:600}
    .conv-item.is-unread .c-title{font-weight:600;color:var(--fg-strong)}
    .c-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%}
    .c-dot{width:7px;height:7px;border-radius:99px;flex-shrink:0;background:var(--border-strong)}
    .c-dot.running{background:var(--green);animation:pulse 1.1s infinite ease-in-out}
    .c-dot.waiting{background:var(--amber);animation:pulse 1s infinite ease-in-out}
    .c-dot.error{background:var(--red)}
    .c-dot.unknown{background:transparent;border:1.5px solid var(--placeholder)}
    .c-dot.unread{background:var(--accent)}
    .c-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
    .c-badge{
      flex-shrink:0;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:999px;line-height:1.4;
    }
    .c-badge.running{background:var(--badge-run-bg);color:var(--badge-run-fg)}
    .c-badge.waiting{background:var(--badge-wait-bg);color:var(--badge-wait-fg)}
    .c-badge.error{background:var(--badge-err-bg);color:var(--badge-err-fg)}
    .c-badge.unknown{background:var(--badge-unk-bg);color:var(--badge-unk-fg)}
    .c-time{flex-shrink:0;font-size:11px;color:var(--placeholder);font-variant-numeric:tabular-nums}
    .c-sub{font-size:11px;color:var(--muted);padding-left:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .conv-more-btn{
      appearance:none;width:100%;padding:8px 10px;border-radius:9px;border:1px dashed var(--border);
      background:var(--surface-subtle);color:var(--muted);font-size:12px;cursor:pointer;margin-top:2px;
    }
    .composer-card.drag-over{border-color:var(--accent);background:var(--accent-bg)}
    .load-earlier-btn{
      appearance:none;align-self:center;padding:6px 14px;border-radius:999px;
      border:1px solid var(--border);background:var(--surface-soft);color:var(--fg-sub);
      font-size:12px;font-weight:500;cursor:pointer;flex-shrink:0;
    }
    .load-earlier-btn:disabled{opacity:.6;cursor:default}
    .perm-ico{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
    .perm-ico.turbo{color:var(--amber)}
    .perm-ico.auto{color:var(--accent)}
    .perm-ico.default{color:var(--muted)}
    .perm-ico.request_review{color:var(--perm-review)}
    .perm-ico.unknown{color:var(--placeholder)}
    .drawer-brand{display:none}
    .conv-list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px;display:flex;flex-direction:column;gap:6px}
    .drawer-footer{flex-shrink:0;padding-top:8px;border-top:1px solid var(--border-subtle)}
    .theme-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:3px;border-radius:11px;background:var(--seg-track);border:1px solid var(--border-subtle)}
    .theme-seg-btn{
      appearance:none;border:none;background:transparent;color:var(--muted);
      height:30px;padding:0;border-radius:8px;
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
      transition:background-color .15s ease,color .15s ease,box-shadow .15s ease;
    }
    .theme-seg-btn.active{background:var(--seg-active-bg);color:var(--fg-strong);box-shadow:var(--seg-active-shadow)}
    .toast{
      position:fixed;top:calc(env(safe-area-inset-top) + 56px);left:50%;transform:translateX(-50%);
      z-index:80;background:var(--toast-bg);color:var(--toast-fg);padding:7px 14px;border-radius:999px;font-size:12.5px;
      border:1px solid var(--border);box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;
    }
    .toast[hidden]{display:none}
    /* 细滚动条 */
    .messages,.conv-list,.drawer,.sheet-list,.proj-modal-body,.thought-body,.md-body pre,.md-table-wrap{
      scrollbar-width:thin;scrollbar-color:var(--scroll-thumb) transparent;
    }
    .messages{scrollbar-gutter:stable}
    .messages::-webkit-scrollbar,.conv-list::-webkit-scrollbar,.drawer::-webkit-scrollbar,.sheet-list::-webkit-scrollbar,.proj-modal-body::-webkit-scrollbar,.thought-body::-webkit-scrollbar,.md-body pre::-webkit-scrollbar,.md-table-wrap::-webkit-scrollbar{
      width:6px;height:6px;
    }
    .messages::-webkit-scrollbar-thumb,.conv-list::-webkit-scrollbar-thumb,.drawer::-webkit-scrollbar-thumb,.sheet-list::-webkit-scrollbar-thumb,.proj-modal-body::-webkit-scrollbar-thumb,.thought-body::-webkit-scrollbar-thumb,.md-body pre::-webkit-scrollbar-thumb,.md-table-wrap::-webkit-scrollbar-thumb{
      background:var(--scroll-thumb);border-radius:99px;
    }
    .messages::-webkit-scrollbar-thumb:hover,.conv-list::-webkit-scrollbar-thumb:hover,.drawer::-webkit-scrollbar-thumb:hover,.sheet-list::-webkit-scrollbar-thumb:hover,.proj-modal-body::-webkit-scrollbar-thumb:hover,.md-table-wrap::-webkit-scrollbar-thumb:hover{
      background:var(--scroll-thumb-hover);
    }
    .messages::-webkit-scrollbar-track,.conv-list::-webkit-scrollbar-track,.drawer::-webkit-scrollbar-track,.sheet-list::-webkit-scrollbar-track,.proj-modal-body::-webkit-scrollbar-track,.md-table-wrap::-webkit-scrollbar-track{
      background:transparent;
    }
    /* 鼠标设备悬停交互 */
    @media (hover:hover){
      .icon-btn:hover,.top-panel-btn:hover{background:var(--surface-hover);color:var(--fg)}
      .quota-pill:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .mode-entry-btn:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .chip:hover{background:var(--surface-hover);border-color:var(--border-strong);color:var(--fg-secondary)}
      .chip.suggest:hover{background:var(--accent-bg);border-color:var(--accent);color:var(--accent-strong-fg)}
      .ghost-btn:hover{background:var(--surface-hover);color:var(--fg-secondary)}
      .send-circle.ready:hover{filter:brightness(1.08)}
      .send-circle.stop:hover{opacity:.9}
      .new-chat-btn:hover,.new-chat-pick-btn:hover{background:var(--surface-strong-hover);border-color:var(--accent-border);color:var(--fg-strong)}
      .conv-tab:hover{color:var(--fg-secondary)}
      .new-proj-mini-btn:hover{background:var(--surface-hover);border-color:var(--border-strong);color:var(--fg-strong)}
      .proj-head:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .proj-toggle:hover{color:var(--fg-strong)}
      .proj-new-btn:hover{background:var(--accent-bg);border-color:var(--accent-border);color:var(--fg-strong)}
      .proj-root-pill:hover,.proj-act-btn:hover,.proj-dir-item:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .proj-primary-btn:hover{filter:brightness(1.08)}
      .conv-more-btn:hover{background:var(--surface-hover);color:var(--fg-secondary)}
      .conv-item:hover,.proj-item:hover,.usage-src-btn:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .conv-item.active:hover,.proj-item.active:hover{background:var(--accent-bg)}
      .drawer-back-btn:hover,.sheet-back-btn:hover{background:var(--surface-hover);color:var(--fg-strong)}
      .sheet-opt:hover{background:var(--surface-hover);border-color:var(--border-strong)}
      .sheet-opt.active:hover{background:var(--accent-bg)}
      .theme-seg-btn:not(.active):hover{color:var(--fg)}
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
      .quota-pill span:last-child{font-size:11.5px;color:var(--muted);padding-left:8px;border-left:1px solid var(--border)}
      .drawer-backdrop{
        order:-1;position:relative;top:auto;left:auto;right:auto;bottom:auto;
        width:268px;height:100%;flex-shrink:0;z-index:10;
        opacity:1;visibility:visible;pointer-events:auto;background:transparent;
        overflow:hidden;transition:width .2s cubic-bezier(.22,1,.36,1);
      }
      body.sidebar-collapsed .drawer-backdrop{width:0;pointer-events:none}
      .drawer{
        width:268px;height:100%;min-height:0;overflow:hidden;
        background:var(--sidebar-bg);border-right:1px solid var(--sidebar-border);
        padding:14px 12px 14px;transform:none!important;transition:none;gap:10px;
      }
      .drawer-brand{
        display:flex;align-items:center;gap:8px;padding:2px 4px 6px;
        font-size:13.5px;font-weight:700;color:var(--fg-strong);letter-spacing:-.01em;flex-shrink:0;
      }
      .drawer-brand-dot{
        width:8px;height:8px;border-radius:99px;
        background:var(--accent);box-shadow:none;
      }
      .new-chat-btn,.new-chat-pick-btn{min-height:38px;border-radius:10px}
      .new-chat-btn{padding:5px 10px;font-size:13px}
      .new-chat-sub{font-size:10px}
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
        box-shadow:var(--composer-shadow-lg);
      }
      .composer-card textarea{min-height:32px;max-height:200px;font-size:14.5px}
      .quota-drawer{
        position:absolute;top:60px;right:24px;left:auto;width:368px;max-width:none;margin-left:0;
      }
      .sheet-backdrop{
        align-items:center;padding:24px;background:var(--backdrop-bg);
        backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
      }
      .sheet{
        max-width:440px;max-height:min(560px,80vh);border-radius:16px;
        border:1px solid var(--border-strong);padding:16px;
        box-shadow:var(--sheet-shadow);
      }
      .sheet.proj-modal{max-width:520px;max-height:min(680px,86vh)}
      .proj-path-input{font-size:13px}
      .proj-field-input{font-size:14px}
      .sheet-opt{padding:10px 12px;font-size:13.5px}
      .toast{top:18px}
    }
    .topbar-actions{display:flex;align-items:center;gap:5px;flex-shrink:0}
    .top-panel-btn{
      appearance:none;border:1px solid var(--border);background:var(--surface-subtle);color:var(--fg);
      border-radius:10px;height:32px;padding:0 7px;display:inline-flex;align-items:center;gap:4px;
      font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;flex-shrink:0;
      transition:border-color .15s ease,background-color .15s ease,color .15s ease;
    }
    .top-panel-btn:active{background:var(--surface-hover)}
    .top-panel-btn.active{border-color:var(--accent);background:var(--accent-bg);color:var(--accent-strong-fg)}
    .top-panel-btn[hidden]{display:none!important}
    .ctx-drawer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px}
    .ctx-stat-box{padding:7px 9px;border-radius:9px;background:var(--surface-subtle);border:1px solid var(--border)}
    .ctx-stat-lbl{font-size:11px;color:var(--muted)}
    .ctx-stat-val{font-size:13px;font-weight:600;color:var(--fg-strong);margin-top:2px;font-variant-numeric:tabular-nums}
    .usage-src-tabs{display:flex;gap:5px;margin-bottom:8px}
    .usage-src-btn{
      flex:1;appearance:none;border:1px solid var(--border);background:var(--surface-subtle);color:var(--muted);
      border-radius:8px;padding:5px 6px;font-size:12px;font-weight:500;cursor:pointer;
    }
    .usage-src-btn.active{border-color:var(--accent);background:var(--accent-bg);color:var(--accent-strong-fg);font-weight:600}
    .usage-kpi-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:8px}
    .usage-bars{display:flex;align-items:flex-end;gap:3px;height:46px;padding:6px 4px 2px;border-radius:9px;background:var(--surface-subtle);border:1px solid var(--border)}
    .usage-bar-col{flex:1;min-width:4px;border-radius:3px 3px 0 0;background:var(--accent)}
    .follow-desk-btn{
      appearance:none;margin:0 10px 8px;padding:7px 10px;border-radius:10px;
      border:1px solid var(--accent-border);background:var(--accent-bg);color:var(--accent-strong-fg);
      font-size:12.5px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;
    }
    .follow-desk-btn:active{filter:brightness(1.08)}
    .isolated-badge{
      display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;font-size:10.5px;font-weight:600;
      background:var(--accent-bg);border:1px solid var(--accent-border);color:var(--accent-strong-fg);flex-shrink:0;
    }
    body.hide-thinking .thought-box{display:none!important}
    body.hide-composer-tools .composer-toolbar .toolbar-left{display:none!important}
    @media (max-width:430px){
      .top-panel-btn{padding:0 6px;gap:3px;font-size:11px}
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
      <div class="topbar-actions">
        <button id="btn-context-panel" class="top-panel-btn" type="button" aria-label="上下文窗口面板" title="上下文窗口面板">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><circle cx="12" cy="12" r="9" opacity=".35"/><path d="M12 3a9 9 0 1 1-6.36 2.64" stroke-linecap="round"/></svg>
          <span id="ctx-top-val">--%</span>
        </button>
        <button id="btn-usage-panel" class="top-panel-btn" type="button" aria-label="本机已记录用量面板" title="本机已记录用量面板">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          <span id="usage-top-val">用量</span>
        </button>
        <button id="btn-quota" class="quota-pill" type="button">
          <span id="quota-main">G4 -- · C --</span>
          <span id="ctx-badge">--%</span>
        </button>
      </div>
    </header>

    <div id="context-drawer" class="quota-drawer top-drawer context-drawer" hidden></div>
    <div id="usage-drawer" class="quota-drawer top-drawer usage-drawer" hidden></div>
    <div id="quota-drawer" class="quota-drawer" hidden></div>

    <main id="messages" class="messages">
      <div class="empty-tip">正在读取桌面端对话画面…</div>
    </main>

    <section id="approval-dock" class="approval-dock" hidden></section>

    <footer class="composer-dock">
      <div id="attach-hint" class="attach-hint" hidden></div>
      <div id="chips" class="chips"></div>
      <div class="composer-card">
        <textarea id="input" rows="1" enterkeyhint="enter" placeholder="发消息…"></textarea>
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
        <button id="sheet-back-btn" class="sheet-back-btn" type="button" hidden>‹ 返回</button>
        <div class="sheet-title-left">
          <span id="sheet-title-text">选择选项</span>
          <span id="sheet-sub-text" class="sheet-sub-text" hidden></span>
        </div>
        <div class="sheet-title-actions">
          <button id="sheet-action-btn" class="sheet-speed-btn" type="button" hidden>⚡ 测速</button>
          <button id="sheet-close" class="icon-btn" style="height:28px;font-size:12px" type="button">关闭</button>
        </div>
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
      <div id="proj-modal-body" class="proj-modal-body">
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
          <input id="proj-name-input" class="proj-field-input" type="text" placeholder="请填写项目名称…">
        </div>
        <button id="proj-create-submit" class="proj-primary-btn" type="button">创建项目并进入对话</button>
      </div>
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
          <span class="new-chat-main">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span id="new-chat-label" class="new-chat-label">新建对话</span>
          </span>
          <span id="new-chat-sub" class="new-chat-sub" hidden></span>
        </button>
        <button id="btn-new-chat-project" class="new-chat-pick-btn" type="button" title="选择项目新建对话" aria-label="选择项目新建对话">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <button id="btn-follow-desktop" class="follow-desk-btn" type="button" hidden>🔄 同步桌面当前会话</button>
      <div class="conv-toolbar">
        <div id="conv-view-tabs" class="conv-view-tabs" role="tablist" aria-label="会话视图切换">
          <button class="conv-tab active" data-conv-view="projects" type="button" role="tab" aria-selected="true">按项目 <span id="tab-proj-count" class="tab-count"></span></button>
          <button class="conv-tab" data-conv-view="recent" type="button" role="tab" aria-selected="false">活跃 <span id="tab-conv-count" class="tab-count"></span></button>
        </div>
        <button id="btn-new-project" class="new-proj-mini-btn" type="button" title="新建项目（选择电脑目录）" aria-label="新建项目">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3.5"/><path d="M18 15v6"/><path d="M15 18h6"/></svg>
        </button>
      </div>
      <div id="drawer-nav-bar" class="drawer-nav-bar" hidden><span class="drawer-sub">历史项目</span></div>
      <div id="conv-list" class="conv-list"></div>
      <div class="drawer-footer">
        <div id="theme-seg" class="theme-seg" role="radiogroup" aria-label="切换外观">
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="system" title="跟随系统" aria-label="跟随系统">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </button>
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="light" title="浅色模式" aria-label="浅色模式">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          </button>
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="dark" title="深色模式" aria-label="深色模式">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast" hidden></div>

  <script>
  (function(){
    const PAIR_STORAGE_KEY = 'ag_remote_pair_v1';
    const DEVICE_ID_STORAGE_KEY = 'ag_remote_device_id_v1';
    const CLIENT_ID_SESSION_KEY = 'ag_remote_client_id_v1';
    const CONV_ID_SESSION_KEY = 'ag_remote_conv_id_v1';
    const TARGET_ID_SESSION_KEY = 'ag_remote_target_id_v1';
    const USAGE_SRC_SESSION_KEY = 'ag_remote_usage_src_v1';
    const DRAFT_SESSION_PREFIX = 'ag_remote_draft_v1:';
    const SPEED_STORAGE_KEY = 'ag_remote_speed_v1';
    const MANUAL_LOCK_SESSION_KEY = 'ag_remote_manual_lock_v1';
    const urlParams = new URLSearchParams(location.search);
    const urlToken = urlParams.get('token') || '';
    const urlName = urlParams.get('name') || '';
    const urlDid = String(urlParams.get('did') || '').trim();
    const urlBcid = String(urlParams.get('bcid') || '').trim();
    const isManualEntry = urlParams.get('manual') === '1';
    const isAutoSwitched = urlParams.get('autosw') === '1';

    const deviceId = (() => {
      try {
        if ((isAutoSwitched || isManualEntry) && /^dev-[a-z0-9_-]{6,60}$/i.test(urlDid)) {
          localStorage.setItem(DEVICE_ID_STORAGE_KEY, urlDid);
          return urlDid;
        }
        let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY) || '';
        if (!id) {
          id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
          localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
        }
        return id;
      } catch {
        return (isAutoSwitched || isManualEntry) && /^dev-[a-z0-9_-]{6,60}$/i.test(urlDid) ? urlDid : '';
      }
    })();

    const clientId = (() => {
      try {
        if (isAutoSwitched && /^agb-[a-z0-9_-]{4,64}$/i.test(urlBcid)) {
          sessionStorage.setItem(CLIENT_ID_SESSION_KEY, urlBcid);
          return urlBcid;
        }
        let cid = sessionStorage.getItem(CLIENT_ID_SESSION_KEY) || '';
        if (!/^agb-[a-z0-9_-]{4,64}$/i.test(cid)) {
          cid = 'agb-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
          sessionStorage.setItem(CLIENT_ID_SESSION_KEY, cid);
        }
        return cid;
      } catch {
        return 'agb-' + Math.random().toString(36).slice(2, 10);
      }
    })();

    const deviceFp = (() => {
      try {
        const scr = (typeof screen === 'object' && screen) ? screen : {};
        const swRaw = Number(scr.width) || 0;
        const shRaw = Number(scr.height) || 0;
        const sw = Math.min(swRaw, shRaw);
        const sh = Math.max(swRaw, shRaw);
        const dpr = Math.round((Number(window.devicePixelRatio) || 1) * 100);
        const plat = String(navigator.platform || '');
        const cores = Number(navigator.hardwareConcurrency || 0);
        let tz = '';
        try { tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch {}
        const raw = [sw + 'x' + sh, dpr, plat, cores, tz].join('|');
        let h = 2166136261;
        for (let i = 0; i < raw.length; i++) {
          h ^= raw.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        return 'fp-' + h.toString(16) + '-' + sw + 'x' + sh;
      } catch {
        return '';
      }
    })();

    function b64UrlDecodeJson(raw) {
      if (!raw) return null;
      try {
        let b64 = String(raw).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const json = typeof TextDecoder === 'function' ? new TextDecoder().decode(bytes) : decodeURIComponent(escape(bin));
        return JSON.parse(json);
      } catch {
        return null;
      }
    }
    function b64UrlEncodeJson(obj) {
      try {
        const json = JSON.stringify(obj);
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
    function decodeEndpointsClient(raw) {
      const list = b64UrlDecodeJson(raw);
      return Array.isArray(list) ? list.filter((x) => x && typeof x.url === 'string' && /^https?:\\/\\//i.test(x.url)) : [];
    }
    function encodeEndpointsClient(list) {
      return b64UrlEncodeJson(Array.isArray(list) ? list : []);
    }
    function decodeSpeedTestClient(raw) {
      const parsed = b64UrlDecodeJson(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.results || typeof parsed.results !== 'object') return null;
      return {
        running: false,
        testedAt: Number(parsed.testedAt) || 0,
        results: parsed.results
      };
    }
    function encodeSpeedTestClient(st) {
      if (!st || !st.testedAt || !st.results || typeof st.results !== 'object') return '';
      const compactResults = {};
      for (const [k, v] of Object.entries(st.results)) {
        if (!v || typeof v !== 'object') continue;
        compactResults[k] = {
          ok: Boolean(v.ok),
          ms: Number.isFinite(v.ms) ? v.ms : null,
          reason: String(v.reason || ''),
          via: String(v.via || ''),
          url: String(v.url || '')
        };
      }
      return b64UrlEncodeJson({ testedAt: st.testedAt, results: compactResults });
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
    function isRawIpHost(host) {
      const h = String(host || '').replace(/^\\[|\\]$/g, '').toLowerCase();
      if (!h) return false;
      return /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) || h.includes(':');
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
    function loadStoredSpeed() {
      try {
        const raw = localStorage.getItem(SPEED_STORAGE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || typeof p !== 'object' || typeof p.results !== 'object') return null;
        return { running: false, testedAt: Number(p.testedAt) || 0, results: p.results || {} };
      } catch {
        return null;
      }
    }
    function saveStoredSpeed(st) {
      try {
        const compactResults = {};
        for (const [k, v] of Object.entries(st?.results || {})) {
          if (!v || typeof v !== 'object') continue;
          compactResults[k] = {
            ok: Boolean(v.ok),
            ms: Number.isFinite(v.ms) ? v.ms : null,
            reason: String(v.reason || ''),
            via: String(v.via || ''),
            url: String(v.url || ''),
            testedAt: Number(v.testedAt) || 0
          };
        }
        localStorage.setItem(SPEED_STORAGE_KEY, JSON.stringify({
          testedAt: Number(st?.testedAt) || 0,
          results: compactResults
        }));
      } catch {}
    }

    const urlHosts = (urlParams.get('hosts') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const urlEndpoints = decodeEndpointsClient(urlParams.get('endpoints') || '');
    const urlSpeed = decodeSpeedTestClient(urlParams.get('spd') || '');
    const storedPair = loadStoredPair() || {};
    const pairState = {
      token: urlToken || storedPair.token || '',
      name: urlName || storedPair.name || '',
      hosts: urlHosts.length ? urlHosts : (Array.isArray(storedPair.hosts) ? storedPair.hosts : []),
      endpoints: urlEndpoints.length ? urlEndpoints : (Array.isArray(storedPair.endpoints) ? storedPair.endpoints : [])
    };
    if (isManualEntry) {
      try { sessionStorage.setItem(MANUAL_LOCK_SESSION_KEY, '1'); } catch {}
    } else if (urlToken && !isAutoSwitched) {
      try { sessionStorage.removeItem(MANUAL_LOCK_SESSION_KEY); } catch {}
    }
    let manualLocked = isManualEntry || (() => {
      try { return sessionStorage.getItem(MANUAL_LOCK_SESSION_KEY) === '1'; } catch { return false; }
    })();

    const storedSpeed = loadStoredSpeed();
    let speedTestState = (urlSpeed && urlSpeed.testedAt >= (storedSpeed?.testedAt || 0))
      ? urlSpeed
      : (storedSpeed || { running: false, testedAt: 0, results: {} });
    if (urlSpeed && urlSpeed.testedAt) saveStoredSpeed(speedTestState);

    if (urlToken || urlEndpoints.length || urlHosts.length || urlDid || urlBcid || urlSpeed || isManualEntry || isAutoSwitched) {
      saveStoredPair(pairState);
      try { history.replaceState(null, '', location.pathname); } catch {}
    }
    if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    let apiBase = '';
    let activeSheetKind = '';
    let activeDrawerProject = '';
    let autoSwitchChecked = false;
    let navigatingAway = false;
    let currentTargetId = (() => {
      try { return sessionStorage.getItem(TARGET_ID_SESSION_KEY) || ''; } catch { return ''; }
    })();
    let selectedConversationId = (() => {
      try { return sessionStorage.getItem(CONV_ID_SESSION_KEY) || ''; } catch { return ''; }
    })();
    let usageSourceFilter = (() => {
      try {
        const s = sessionStorage.getItem(USAGE_SRC_SESSION_KEY) || 'all';
        return (s === 'desktop' || s === 'cli' || s === 'all') ? s : 'all';
      } catch { return 'all'; }
    })();
    let cachedUsageData = null;
    let cachedContextResp = null;
    let latestDisplayConfig = null;
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
      if (clientId) h['X-AG-Client-Id'] = clientId;
      if (deviceId) h['X-AG-Device-Id'] = deviceId;
      if (deviceFp) h['X-AG-Device-Fp'] = deviceFp;
      if (isIpadDesktopUa) h['X-AG-Device-Hint'] = 'iPad';
      return h;
    }

    function fetchWithTimeout(url, init, timeoutMs, externalCtrl) {
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
      const ctrl = externalCtrl || (typeof AbortController === 'function' ? new AbortController() : null);
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, ms) : null;
      const opts = Object.assign({}, init || {}, ctrl ? { signal: ctrl.signal } : {});
      return fetch(url, opts).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    function nowPerfMs() {
      return (typeof performance === 'object' && typeof performance.now === 'function') ? performance.now() : Date.now();
    }

    async function probeEndpointOnce(ep, timeoutMs) {
      const isHttpsPage = location.protocol === 'https:';
      const cleanUrl = String(ep?.url || '').replace(/\\/+$/, '');
      const epIsHttp = cleanUrl.toLowerCase().startsWith('http://');
      const effectiveTimeout = (isHttpsPage && epIsHttp) ? Math.min(600, timeoutMs) : timeoutMs;
      const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      const t0 = nowPerfMs();
      try {
        const r = await fetchWithTimeout(cleanUrl + '/api/ping?probe=1&_n=' + encodeURIComponent(nonce) + '&_t=' + Date.now(), {
          headers: authHeaders({ 'X-AG-Probe': '1' }),
          cache: 'no-store'
        }, effectiveTimeout);
        if (r.status === 403) return { ok: false, ms: null, reason: 'disabled', data: null };
        if (!r.ok) return { ok: false, ms: null, reason: (isHttpsPage && epIsHttp) ? 'https_restricted' : 'unreachable', data: null };
        const d = await r.json().catch(() => null);
        if (!d || d.ok !== true) {
          return { ok: false, ms: null, reason: (isHttpsPage && epIsHttp) ? 'https_restricted' : 'unreachable', data: null };
        }
        if (d.nonce && d.nonce !== nonce) {
          return { ok: false, ms: null, reason: 'unreachable', data: null };
        }
        if (d.service !== 'ag-mobile-remote' && !Array.isArray(d.endpoints) && typeof d.port !== 'number') {
          return { ok: false, ms: null, reason: 'unreachable', data: null };
        }
        const ms = Math.max(1, Math.round(nowPerfMs() - t0));
        return { ok: true, ms, reason: 'ok', data: d };
      } catch {
        return { ok: false, ms: null, reason: (isHttpsPage && epIsHttp) ? 'https_restricted' : 'unreachable', data: null };
      }
    }

    async function fetchServerProbeHints(force) {
      try {
        const url = (apiBase || '') + '/api/probe-hints?probe=1' + (force ? '&force=1' : '') + '&_t=' + Date.now();
        const r = await fetchWithTimeout(url, {
          headers: authHeaders({ 'X-AG-Probe': '1' }),
          cache: 'no-store'
        }, 2400);
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        return (d && d.ok && d.hints && typeof d.hints === 'object') ? d.hints : null;
      } catch {
        return null;
      }
    }

    function mergeServerHintIntoProbe(res, serverHints, nowTs) {
      const sh = (!res.ok && serverHints && typeof serverHints === 'object') ? serverHints[res.kind] : null;
      if (sh && sh.ok && Number.isFinite(sh.ms)) {
        return {
          kind: res.kind,
          url: res.url,
          ok: true,
          ms: sh.ms,
          reason: 'server_hint',
          via: 'server',
          data: res.data || null,
          testedAt: nowTs
        };
      }
      if (sh && sh.ok === false && sh.reason === 'unreachable') {
        return {
          kind: res.kind,
          url: res.url,
          ok: false,
          ms: null,
          reason: 'unreachable',
          via: 'server',
          data: null,
          testedAt: nowTs
        };
      }
      return {
        kind: res.kind,
        url: res.url,
        ok: Boolean(res.ok),
        ms: res.ok && Number.isFinite(res.ms) ? res.ms : null,
        reason: res.reason || (res.ok ? 'ok' : 'unreachable'),
        via: String(res.via || ''),
        data: res.data || null,
        testedAt: res.testedAt || nowTs
      };
    }

    async function probeEndpointLatency(ep, timeoutMs) {
      const tMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1500;
      const p1 = await probeEndpointOnce(ep, tMs);
      if (!p1.ok) {
        return {
          kind: ep.kind,
          url: ep.url,
          ok: false,
          ms: null,
          reason: p1.reason || 'unreachable',
          data: null,
          testedAt: Date.now()
        };
      }
      let bestMs = p1.ms;
      let latestData = p1.data;
      if (p1.ms < 900) {
        const p2 = await probeEndpointOnce(ep, Math.min(700, tMs));
        if (p2.ok && Number.isFinite(p2.ms)) {
          bestMs = Math.min(bestMs, p2.ms);
          if (p2.data) latestData = p2.data;
        }
      }
      return {
        kind: ep.kind,
        url: ep.url,
        ok: true,
        ms: bestMs,
        reason: 'ok',
        data: latestData,
        testedAt: Date.now()
      };
    }

    function pickFastestReachable(resultsMap, entries) {
      const order = { lan: 0, tailscale: 1, bonjour: 2, tunnel: 3, loopback: 9 };
      const list = [];
      for (const ep of (entries || [])) {
        if (!ep || !ep.kind) continue;
        const r = resultsMap && resultsMap[ep.kind];
        if (r && r.ok && Number.isFinite(r.ms)) {
          list.push({ kind: ep.kind, url: r.url || ep.url, ms: r.ms, data: r.data || null });
        }
      }
      list.sort((a, b) => (a.ms - b.ms) || ((order[a.kind] ?? 5) - (order[b.kind] ?? 5)));
      return list;
    }

    function navigateEntryUrl(targetUrl, useReplace) {
      if (navigatingAway) return;
      navigatingAway = true;
      clearTimeout(pollTimer);
      if (useReplace && typeof location.replace === 'function') {
        location.replace(targetUrl);
      } else {
        location.href = targetUrl;
      }
    }

    let speedTestBusy = null;
    async function runSpeedTest(opts) {
      const o = opts || {};
      const wantAutoSwitch = Boolean(o.autoSwitch);
      const silent = Boolean(o.silent);
      if (speedTestBusy) {
        await speedTestBusy;
        return speedTestState;
      }
      speedTestBusy = (async () => {
        const entries = getEnabledModeEntries();
        speedTestState.running = true;
        renderModeSwitcherSheet();
        if (!latestSnap) {
          renderModeEntryGate(
            isManualEntry
              ? ('正在通过 ' + getActiveChannelLabel() + ' 连接 Mac…')
              : '正在并发测速各可用通道，自动选择最快路线…'
          );
        }
        const needServerHints = location.protocol === 'https:'
          && entries.some((ep) => String(ep.url || '').toLowerCase().startsWith('http://'));
        const [probed, serverHints] = await Promise.all([
          Promise.all(entries.map((ep) => probeEndpointLatency(ep, o.timeoutMs || 1500))),
          needServerHints ? fetchServerProbeHints(!silent) : Promise.resolve(null)
        ]);
        const nextResults = {};
        let refreshedMeta = false;
        const nowTs = Date.now();
        for (const res of probed) {
          if (!res || !res.kind) continue;
          const merged = mergeServerHintIntoProbe(res, serverHints, nowTs);
          nextResults[merged.kind] = {
            ok: merged.ok,
            ms: merged.ms,
            reason: merged.reason,
            via: merged.via,
            url: merged.url,
            testedAt: merged.testedAt
          };
          if (res.data && Array.isArray(res.data.endpoints) && res.data.endpoints.length) {
            pairState.endpoints = res.data.endpoints;
            if (Array.isArray(res.data.hosts)) pairState.hosts = res.data.hosts;
            refreshedMeta = true;
          }
        }
        if (refreshedMeta) saveStoredPair(pairState);
        speedTestState = {
          running: false,
          testedAt: Date.now(),
          results: nextResults
        };
        saveStoredSpeed(speedTestState);
        renderModeSwitcherSheet();

        const ranked = pickFastestReachable(nextResults, entries);
        const best = ranked[0] || null;
        if (!silent) {
          if (best) {
            showToast('⚡ 测速完成：' + formatKindLabel(best.kind) + ' 最快 (' + best.ms + ' ms)');
          } else {
            showToast('测速未连通，请检查当前网络');
          }
        }

        const curOrigin = String(apiBase || location.origin || '').replace(/\\/+$/, '');
        const curKind = detectKindFromOrigin(curOrigin);
        const curRes = nextResults[curKind] || null;

        if (wantAutoSwitch && !manualLocked && !isAutoSwitched && best) {
          const sameEntry = best.url === curOrigin || best.kind === curKind;
          const significantlyFaster = !curRes || !curRes.ok
            || (curKind === 'tunnel' && best.kind !== 'tunnel' && (!curRes.ms || best.ms < curRes.ms))
            || (Number.isFinite(curRes.ms) && (curRes.ms - best.ms >= 15) && best.ms <= curRes.ms * 0.75);
          if (!sameEntry && significantlyFaster) {
            if (activeSnapAbort) {
              try { activeSnapAbort.abort(); } catch {}
              activeSnapAbort = null;
            }
            clearTimeout(pollTimer);
            const targetUrl = buildClientEntryUrl(best.url, { autoSwitched: true });
            navigateEntryUrl(targetUrl, true);
            return speedTestState;
          }
        }

        if (!latestSnap) {
          renderModeEntryGate(
            isManualEntry
              ? ('正在通过 ' + getActiveChannelLabel() + ' 连接 Mac…')
              : (best ? ('最快通道：' + formatKindLabel(best.kind) + ' (' + best.ms + ' ms)，可直接点击进入：') : '当前入口暂未连通，请点击下方已开启的连接方式直接进入：')
          );
        }
        return speedTestState;
      })();
      try {
        return await speedTestBusy;
      } finally {
        speedTestBusy = null;
      }
    }

    let failoverBusy = null;
    async function tryFailoverEndpoint() {
      if (failoverBusy) return failoverBusy;
      failoverBusy = (async () => {
        const entries = getEnabledModeEntries();
        const extra = [];
        const seenUrls = new Set(entries.map((e) => e.url));
        for (const ep of (pairState.endpoints || [])) {
          const clean = String(ep?.url || '').replace(/\\/+$/, '');
          if (clean && !seenUrls.has(clean)) {
            seenUrls.add(clean);
            extra.push({ url: clean, kind: ep.kind || detectKindFromOrigin(clean) });
          }
        }
        const candidates = entries.concat(extra);
        if (candidates.length <= 1 && !apiBase) return false;
        const needServerHints = location.protocol === 'https:'
          && candidates.some((ep) => String(ep.url || '').toLowerCase().startsWith('http://'));
        const [probed, serverHints] = await Promise.all([
          Promise.all(candidates.map((ep) => probeEndpointLatency(ep, 1600))),
          needServerHints ? fetchServerProbeHints(true) : Promise.resolve(null)
        ]);
        const nextResults = Object.assign({}, speedTestState.results || {});
        const nowTs = Date.now();
        const mergedList = [];
        for (const res of probed) {
          if (!res || !res.kind) continue;
          const merged = mergeServerHintIntoProbe(res, serverHints, nowTs);
          mergedList.push(merged);
          if (merged.ok || !nextResults[merged.kind]) {
            nextResults[merged.kind] = {
              ok: merged.ok,
              ms: merged.ms,
              reason: merged.reason,
              via: merged.via,
              url: merged.url,
              testedAt: merged.testedAt
            };
          }
        }
        speedTestState = { running: false, testedAt: Date.now(), results: nextResults };
        saveStoredSpeed(speedTestState);
        renderModeSwitcherSheet();

        const order = { lan: 0, tailscale: 1, bonjour: 2, tunnel: 3, loopback: 9 };
        const winners = mergedList
          .filter((r) => r && r.ok && Number.isFinite(r.ms))
          .sort((a, b) => (a.ms - b.ms) || ((order[a.kind] ?? 5) - (order[b.kind] ?? 5)));
        const winner = winners[0] || null;
        if (!winner) return false;

        if (Array.isArray(winner.data?.endpoints) && winner.data.endpoints.length) {
          pairState.endpoints = winner.data.endpoints;
          if (Array.isArray(winner.data.hosts)) pairState.hosts = winner.data.hosts;
          saveStoredPair(pairState);
        }
        if (location.protocol === 'https:' && winner.url.toLowerCase().startsWith('http://')) {
          navigateEntryUrl(buildClientEntryUrl(winner.url, { autoSwitched: true }), true);
          return true;
        }
        const nextBase = winner.url === String(location.origin || '').replace(/\\/+$/, '') ? '' : winner.url;
        const changed = nextBase !== apiBase;
        apiBase = nextBase;
        if (changed) {
          showToast('已自动切至最快通道：' + formatKindLabel(winner.kind) + ' (' + winner.ms + ' ms)');
        }
        return true;
      })();
      try {
        return await failoverBusy;
      } finally {
        failoverBusy = null;
      }
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

    function formatClockTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    }

    function formatLatencyBadge(kind) {
      if (speedTestState.running) {
        return { cls: 'pending', html: '<span class="mini-spin"></span><span>测速中</span>' };
      }
      const r = speedTestState.results ? speedTestState.results[kind] : null;
      if (!r) return { cls: 'muted', html: '未测速' };
      if (r.ok && Number.isFinite(r.ms)) {
        const cls = r.ms < 80 ? 'fast' : (r.ms <= 250 ? 'mid' : 'slow');
        return { cls, html: esc(r.ms + ' ms') };
      }
      if (r.reason === 'https_restricted') return { cls: 'muted', html: '需切 HTTP' };
      if (r.reason === 'disabled') return { cls: 'err', html: '已停用' };
      return { cls: 'err', html: '不可达' };
    }

    function buildClientEntryUrl(targetBaseUrl, opts) {
      const o = opts || {};
      const cleanBase = String(targetBaseUrl || '').replace(/\\/+$/, '');
      const params = [];
      if (pairState.token) params.push('token=' + encodeURIComponent(pairState.token));
      if (pairState.name) params.push('name=' + encodeURIComponent(pairState.name));
      if (deviceId) params.push('did=' + encodeURIComponent(deviceId));
      if (o.autoSwitched && clientId) params.push('bcid=' + encodeURIComponent(clientId));
      if (pairState.hosts?.length) params.push('hosts=' + encodeURIComponent(pairState.hosts.join(',')));
      const encEps = encodeEndpointsClient(pairState.endpoints || []);
      if (encEps) params.push('endpoints=' + encodeURIComponent(encEps));
      const encSpd = encodeSpeedTestClient(speedTestState);
      if (encSpd) params.push('spd=' + encodeURIComponent(encSpd));
      if (o.autoSwitched) {
        params.push('autosw=1');
      } else if (o.manual !== false) {
        params.push('manual=1');
      }
      return cleanBase + '/?' + params.join('&');
    }

    function enterConnectionMode(ep) {
      if (!ep || !ep.url) return;
      manualLocked = true;
      try { sessionStorage.setItem(MANUAL_LOCK_SESSION_KEY, '1'); } catch {}
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
      navigateEntryUrl(buildClientEntryUrl(cleanTarget, { manual: true }), false);
    }

    function renderModeEntryGate(statusText) {
      if (latestSnap) return;
      const entries = getEnabledModeEntries();
      const curOrigin = String(apiBase || location.origin || '').replace(/\\/+$/, '');
      const ranked = pickFastestReachable(speedTestState.results, entries);
      const fastestKind = (entries.length > 1 && ranked.length > 0) ? ranked[0].kind : '';
      const btnsHtml = entries.map((ep, idx) => {
        let hostText = ep.url;
        try { hostText = new URL(ep.url).host; } catch {}
        const isCurrent = ep.url === curOrigin;
        const badge = formatLatencyBadge(ep.kind);
        const fastPill = (fastestKind && ep.kind === fastestKind) ? ' <span class="mode-pill fast">最快</span>' : '';
        return '<button class="mode-entry-btn' + (isCurrent ? ' active' : '') + '" data-mode-idx="' + idx + '" type="button">'
          + '<span class="mode-entry-left">'
          + '<span class="mode-entry-name">' + esc(formatKindLabel(ep.kind)) + fastPill + '</span>'
          + '<span class="mode-entry-host">' + esc(hostText) + '</span>'
          + '</span>'
          + '<span class="mode-entry-right">'
          + '<span class="lat-badge ' + badge.cls + '">' + badge.html + '</span>'
          + '<span class="mode-entry-tag">' + (isCurrent ? '当前 →' : '进入 →') + '</span>'
          + '</span>'
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

    function configureSheetChrome(cfg) {
      const c = cfg || {};
      activeSheetKind = c.kind || '';
      $('sheet-title-text').textContent = c.title || '选择选项';
      const subEl = $('sheet-sub-text');
      if (subEl) {
        if (c.subText) {
          subEl.hidden = false;
          subEl.textContent = c.subText;
        } else {
          subEl.hidden = true;
          subEl.textContent = '';
        }
      }
      const backBtn = $('sheet-back-btn');
      if (backBtn) {
        if (typeof c.onBack === 'function') {
          backBtn.hidden = false;
          backBtn.onclick = (ev) => {
            ev?.stopPropagation?.();
            c.onBack();
          };
        } else {
          backBtn.hidden = true;
          backBtn.onclick = null;
        }
      }
      const actBtn = $('sheet-action-btn');
      if (actBtn) {
        if (c.showSpeed) {
          actBtn.hidden = false;
          actBtn.disabled = Boolean(c.speedDisabled);
          actBtn.innerHTML = c.speedHtml || '⚡ 测速';
          actBtn.onclick = typeof c.onSpeedClick === 'function' ? c.onSpeedClick : null;
        } else {
          actBtn.hidden = true;
          actBtn.disabled = false;
          actBtn.onclick = null;
        }
      }
    }

    function closeSheet() {
      activeSheetKind = '';
      const backBtn = $('sheet-back-btn');
      if (backBtn) {
        backBtn.hidden = true;
        backBtn.onclick = null;
      }
      const actBtn = $('sheet-action-btn');
      if (actBtn) {
        actBtn.hidden = true;
        actBtn.onclick = null;
      }
      $('sheet-backdrop').hidden = true;
    }

    function renderModeSwitcherSheet() {
      const backdrop = $('sheet-backdrop');
      if (!backdrop || backdrop.hidden || activeSheetKind !== 'mode') return;
      const entries = getEnabledModeEntries();
      const curOrigin = String(apiBase || location.origin || '').replace(/\\/+$/, '');
      const ranked = pickFastestReachable(speedTestState.results, entries);
      const fastestKind = (entries.length > 1 && ranked.length > 0) ? ranked[0].kind : '';

      const subMsg = speedTestState.running
        ? '⏳ 正在并发测速各通道延迟…'
        : (speedTestState.testedAt > 0
            ? ('最近测速 ' + formatClockTime(speedTestState.testedAt) + ' · 延迟仅供参考')
            : '尚未测速 · 点击右侧「测速」获取延迟参考');

      configureSheetChrome({
        kind: 'mode',
        title: '切换连接方式',
        subText: subMsg,
        showSpeed: true,
        speedDisabled: Boolean(speedTestState.running),
        speedHtml: speedTestState.running ? '<span class="mini-spin"></span><span>测速中…</span>' : '⚡ 测速',
        onSpeedClick: (ev) => {
          ev.stopPropagation();
          void runSpeedTest({ autoSwitch: false, silent: false });
        },
        onBack: null
      });

      const listEl = $('sheet-list');
      listEl.innerHTML = entries.map((ep, idx) => {
        let hostText = ep.url;
        try { hostText = new URL(ep.url).host; } catch {}
        const isCurrent = ep.url === curOrigin;
        const badge = formatLatencyBadge(ep.kind);
        const pills = ((fastestKind && ep.kind === fastestKind) ? '<span class="mode-pill fast">最快</span>' : '')
          + (isCurrent ? '<span class="mode-pill cur">当前</span>' : '');
        return '<button class="sheet-opt' + (isCurrent ? ' active' : '') + '" data-idx="' + idx + '" type="button">'
          + '<span class="sheet-opt-left">'
          + '<span class="sheet-opt-top"><span>' + esc(formatKindLabel(ep.kind)) + '</span>' + pills + '</span>'
          + '<span class="sheet-opt-host">' + esc(hostText) + '</span>'
          + '</span>'
          + '<span class="sheet-opt-right">'
          + '<span class="lat-badge ' + badge.cls + '">' + badge.html + '</span>'
          + (isCurrent ? '<span>✓</span>' : '')
          + '</span>'
          + '</button>';
      }).join('');
      listEl.onclick = (e) => {
        const btn = e.target?.closest?.('.sheet-opt');
        if (!btn) return;
        const ep = entries[Number(btn.dataset.idx)];
        closeSheet();
        if (ep) enterConnectionMode(ep);
      };
    }

    function openModeSwitcherSheet() {
      const entries = getEnabledModeEntries();
      if (!entries.length) return;
      activeSheetKind = 'mode';
      $('sheet-backdrop').hidden = false;
      renderModeSwitcherSheet();
      if (speedTestState.testedAt === 0 && !speedTestState.running) {
        void runSpeedTest({ autoSwitch: false, silent: true });
      }
    }

    $('sub-meta').textContent = '正在连接 · ' + getActiveChannelLabel();
    $('sub-meta').onclick = openModeSwitcherSheet;

    const appEl = document.querySelector('.app');

    function getFullLayoutHeight() {
      const vvH = window.visualViewport ? window.visualViewport.height : 0;
      return Math.round(vvH || window.innerHeight || document.documentElement?.clientHeight || 0);
    }

    let maxVvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    let lockedModalBaseH = getFullLayoutHeight();
    let lastLayoutWidth = window.innerWidth || 0;
    let lastTextBlurAt = 0;
    let activeShiftedSheet = null;
    let activeModalSheetShiftY = 0;
    let activeSheetLockedHeight = 0;
    let activeScrolledModalBody = null;
    let activeModalBodyScrollY = 0;
    let viewportSyncTimers = [];

    const desktopMq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width:860px) and (min-height:521px) and (hover:hover) and (pointer:fine)')
      : null;
    const isDesktopLayout = () => {
      if (desktopMq) return desktopMq.matches;
      const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer:fine)').matches;
      return window.innerWidth >= 860 && window.innerHeight > 520 && (fine || Number(navigator.maxTouchPoints || 0) <= 1);
    };

    function isTextEntryElement(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
      if (tag === 'INPUT') {
        const type = String(el.type || 'text').toLowerCase();
        if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) {
          return false;
        }
        return !el.disabled && !el.readOnly;
      }
      return Boolean(el.isContentEditable);
    }

    function getOpenModalBackdrop() {
      const projBackdrop = $('proj-modal-backdrop');
      if (projBackdrop && !projBackdrop.hidden) return projBackdrop;
      const sheetBackdrop = $('sheet-backdrop');
      if (sheetBackdrop && !sheetBackdrop.hidden) return sheetBackdrop;
      return null;
    }

    function clearScrollBodyOffset(bodyEl) {
      if (!bodyEl) return;
      // 仅移除临时 paddingBottom，保留 bodyEl.scrollTop 避免把用户手动滚动定位的已填输入框滚出视野
      bodyEl.style.paddingBottom = '';
    }

    function resetModalSheetShift() {
      if (activeShiftedSheet) {
        activeShiftedSheet.style.transform = '';
        activeShiftedSheet.style.height = '';
      }
      clearScrollBodyOffset(activeScrolledModalBody);
      const openBackdrop = getOpenModalBackdrop();
      const sheetEl = openBackdrop?.querySelector?.('.sheet');
      if (sheetEl) {
        if (sheetEl !== activeShiftedSheet) {
          sheetEl.style.transform = '';
          sheetEl.style.height = '';
        }
        const bodyEl = sheetEl.querySelector?.('.proj-modal-body');
        if (bodyEl && bodyEl !== activeScrolledModalBody) {
          clearScrollBodyOffset(bodyEl);
        }
      }
      activeShiftedSheet = null;
      activeModalSheetShiftY = 0;
      activeSheetLockedHeight = 0;
      activeScrolledModalBody = null;
      activeModalBodyScrollY = 0;
    }

    function computeModalSheetShiftY(metrics) {
      const rawTop = Number(metrics?.rawTop);
      const rawBottom = Number(metrics?.rawBottom);
      const sheetRawTop = metrics?.sheetRawTop !== undefined && metrics?.sheetRawTop !== null
        ? Number(metrics.sheetRawTop)
        : null;
      const vvTop = Number(metrics?.vvTop) || 0;
      const vvHeight = Number(metrics?.vvHeight) || 0;
      const safeTopGap = Number.isFinite(metrics?.safeTopGap) ? Number(metrics.safeTopGap) : 12;
      const safeBottomGap = Number.isFinite(metrics?.safeBottomGap) ? Number(metrics.safeBottomGap) : 14;
      const hasScrollBody = Boolean(metrics?.hasScrollBody);
      if (!Number.isFinite(rawTop) || !Number.isFinite(rawBottom) || !(vvHeight > 0)) return 0;

      const vvBottom = vvTop + vvHeight;
      const minTop = vvTop + safeTopGap;
      const maxBottom = vvBottom - safeBottomGap;
      const hasSheetTop = sheetRawTop !== null && Number.isFinite(sheetRawTop);
      const sheetTopOk = (!hasSheetTop || vvTop <= 0) ? true : (sheetRawTop >= minTop);

      // 只要聚焦输入框和弹窗顶边（在正向视觉偏移下）均已完整处于可视安全区内，严格禁止任何位移
      if (rawBottom <= maxBottom && rawTop >= minTop && sheetTopOk) return 0;

      const minShiftForSheetTop = hasSheetTop ? Math.ceil(minTop - sheetRawTop) : -Infinity;
      const minShiftForInputTop = Math.ceil(minTop - rawTop);
      const maxShiftForInputBottom = Math.floor(maxBottom - rawBottom);

      if (hasScrollBody) {
        if (rawBottom > maxBottom && minShiftForSheetTop <= 0) {
          return Math.max(maxShiftForInputBottom, minShiftForSheetTop);
        }
        const needDownShift = Math.max(0, hasSheetTop ? minShiftForSheetTop : 0, minShiftForInputTop);
        if (needDownShift > 0) return needDownShift;
        return Math.max(maxShiftForInputBottom, minShiftForSheetTop);
      }

      if (rawBottom > maxBottom) {
        return Math.max(maxShiftForInputBottom, minShiftForSheetTop, minShiftForInputTop);
      }
      const downTarget = Math.max(0, hasSheetTop ? minShiftForSheetTop : 0, minShiftForInputTop);
      return Math.max(minShiftForInputTop, Math.min(downTarget, Math.max(0, maxShiftForInputBottom)));
    }

    function syncModalKeyboardOffset() {
      const openBackdrop = getOpenModalBackdrop();
      const activeEl = document.activeElement;
      if (!openBackdrop || isDesktopLayout() || !isTextEntryElement(activeEl) || !openBackdrop.contains(activeEl)) {
        resetModalSheetShift();
        return;
      }
      const sheetEl = openBackdrop.querySelector('.sheet');
      if (!sheetEl || typeof activeEl.getBoundingClientRect !== 'function' || typeof sheetEl.getBoundingClientRect !== 'function') {
        resetModalSheetShift();
        return;
      }
      if (activeShiftedSheet && activeShiftedSheet !== sheetEl) {
        resetModalSheetShift();
      }
      const vv = window.visualViewport;
      const vvTop = vv ? (Number(vv.offsetTop) || 0) : 0;
      const vvHeight = vv ? (Number(vv.height) || window.innerHeight || 0) : (window.innerHeight || 0);
      const baseH = Math.max(maxVvHeight || 0, lockedModalBaseH || 0, window.innerHeight || 0);
      const kbLikelyOpen = Boolean(vv && ((baseH - vvHeight > 60) || vvTop > 2));
      if (!kbLikelyOpen) {
        resetModalSheetShift();
        return;
      }

      const scrollBody = sheetEl.querySelector('.proj-modal-body') || sheetEl.querySelector('.sheet-list') || null;
      const hasScrollBody = Boolean(scrollBody && scrollBody.contains(activeEl));
      const appliedShift = activeShiftedSheet === sheetEl ? activeModalSheetShiftY : 0;
      // 仅补偿本逻辑自身施加的滚动增量（activeModalBodyScrollY），不得叠加用户手动下滑的 scrollTop 导致偏移过大
      const bodyScroll = (hasScrollBody && activeScrolledModalBody === scrollBody) ? (Number(activeModalBodyScrollY) || 0) : 0;
      const sheetRect = sheetEl.getBoundingClientRect();
      const bodyRect = scrollBody && typeof scrollBody.getBoundingClientRect === 'function' ? scrollBody.getBoundingClientRect() : null;
      const rect = activeEl.getBoundingClientRect();

      const sheetRawTop = sheetRect.top - appliedShift;
      const sheetRawHeight = (activeShiftedSheet === sheetEl && activeSheetLockedHeight > 0) ? activeSheetLockedHeight : sheetRect.height;
      const bodyRawTop = bodyRect ? (bodyRect.top - appliedShift) : sheetRawTop;
      const rawTop = rect.top - appliedShift + bodyScroll;
      const rawBottom = rect.bottom - appliedShift + bodyScroll;
      const minTop = vvTop + 12;
      const maxBottom = vvTop + vvHeight - 14;
      const sheetTopOk = vvTop <= 0 ? true : (sheetRawTop >= minTop);

      if (rawBottom <= maxBottom && rawTop >= minTop && sheetTopOk) {
        resetModalSheetShift();
        return;
      }

      if (vvTop > 0 && (rawTop < minTop || !sheetTopOk) && typeof window.scrollTo === 'function') {
        try { window.scrollTo(0, 0); } catch {}
      }

      const nextShift = computeModalSheetShiftY({
        rawTop,
        rawBottom,
        sheetRawTop,
        vvTop,
        vvHeight,
        safeTopGap: 12,
        safeBottomGap: 14,
        hasScrollBody
      });

      const remainingOverlap = Math.max(0, Math.ceil((rawBottom + nextShift) - maxBottom));
      sheetEl.style.transform = nextShift ? ('translateY(' + nextShift + 'px)') : '';

      if (remainingOverlap > 0 && hasScrollBody) {
        if (sheetRawHeight > 0) {
          sheetEl.style.height = sheetRawHeight + 'px';
          activeSheetLockedHeight = sheetRawHeight;
        }
        const maxBodyScroll = Math.max(0, Math.floor(rawTop - bodyRawTop - 4));
        const targetScroll = Math.max(0, Math.min(remainingOverlap, maxBodyScroll));
        const prevApplied = activeScrolledModalBody === scrollBody ? (Number(activeModalBodyScrollY) || 0) : 0;
        const userBaseScroll = Math.max(0, (Number(scrollBody.scrollTop) || 0) - prevApplied);
        scrollBody.style.paddingBottom = (targetScroll + 28) + 'px';
        scrollBody.scrollTop = userBaseScroll + targetScroll;
        activeScrolledModalBody = scrollBody;
        activeModalBodyScrollY = targetScroll;
      } else {
        sheetEl.style.height = '';
        activeSheetLockedHeight = 0;
        clearScrollBodyOffset(activeScrolledModalBody);
        if (scrollBody && scrollBody !== activeScrolledModalBody) {
          clearScrollBodyOffset(scrollBody);
        }
        activeScrolledModalBody = null;
        activeModalBodyScrollY = 0;
      }

      activeShiftedSheet = (nextShift || remainingOverlap > 0) ? sheetEl : null;
      activeModalSheetShiftY = nextShift;
    }

    function syncViewportHeight() {
      const vv = window.visualViewport;
      const curH = vv ? vv.height : (window.innerHeight || document.documentElement?.clientHeight || 0);
      const curW = window.innerWidth || 0;
      const desktop = isDesktopLayout();
      const activeEl = document.activeElement;
      const anyTextFocused = isTextEntryElement(activeEl);
      const openModal = getOpenModalBackdrop();
      const isComposerFocused = !openModal && activeEl === $('input');

      if (!anyTextFocused && Math.abs(curW - lastLayoutWidth) > 2) {
        lastLayoutWidth = curW;
        maxVvHeight = curH;
        lockedModalBaseH = Math.round(curH);
      } else if (!anyTextFocused && curH > maxVvHeight) {
        maxVvHeight = curH;
      }

      const refFullH = Math.max(maxVvHeight || 0, window.innerHeight || 0, lockedModalBaseH || 0);
      const recentlyBlurred = (Date.now() - lastTextBlurAt) < 380;
      const kbLikelyActive = Boolean(vv && ((refFullH - curH > 60) || ((Number(vv.offsetTop) || 0) > 2)));
      const freezeModalShrink = !desktop && (anyTextFocused || kbLikelyActive || recentlyBlurred);
      if (desktop || !freezeModalShrink || curH >= lockedModalBaseH) {
        lockedModalBaseH = Math.round(curH);
      }
      const modalBaseH = Math.max(lockedModalBaseH || 0, Math.round(curH || 0));
      document.documentElement.style.setProperty('--modal-h', modalBaseH + 'px');

      const baseH = Math.max(maxVvHeight || 0, window.innerHeight || 0);
      const kbOpenForComposer = Boolean(!desktop && !openModal && isComposerFocused && vv && (baseH - curH > 100));
      if (kbOpenForComposer) {
        const top = vv.offsetTop || 0;
        document.body.style.bottom = 'auto';
        document.body.style.height = Math.round(curH) + 'px';
        document.documentElement.style.setProperty('--app-h', Math.round(curH) + 'px');
        document.body.style.transform = top ? 'translateY(' + top + 'px)' : '';
        appEl?.classList.add('kb-open');
      } else {
        document.body.style.bottom = '0';
        document.body.style.height = '100%';
        const appHeightPx = (!desktop && openModal && (anyTextFocused || kbLikelyActive || recentlyBlurred))
          ? modalBaseH
          : getFullLayoutHeight();
        document.documentElement.style.setProperty('--app-h', appHeightPx + 'px');
        document.body.style.transform = '';
        appEl?.classList.remove('kb-open');
      }
      syncModalKeyboardOffset();
      if (!openModal && stickBottom) msgEl.scrollTop = msgEl.scrollHeight;
    }

    function scheduleViewportSyncBurst() {
      for (const tid of viewportSyncTimers) clearTimeout(tid);
      viewportSyncTimers = [];
      for (const delay of [60, 180, 320]) {
        viewportSyncTimers.push(setTimeout(() => { syncViewportHeight(); }, delay));
      }
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportHeight);
      window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
    window.addEventListener('resize', syncViewportHeight);
    document.addEventListener('focusin', (e) => {
      if (isTextEntryElement(e?.target || document.activeElement)) {
        syncViewportHeight();
        scheduleViewportSyncBurst();
      }
    });
    document.addEventListener('focusout', (e) => {
      if (isTextEntryElement(e?.target)) {
        lastTextBlurAt = Date.now();
        setTimeout(syncViewportHeight, 16);
        scheduleViewportSyncBurst();
      }
    });
    window.addEventListener('orientationchange', () => {
      const nextH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      maxVvHeight = nextH;
      lockedModalBaseH = Math.round(nextH || 0);
      lastLayoutWidth = window.innerWidth || 0;
      setTimeout(() => {
        const settledH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        maxVvHeight = settledH;
        lockedModalBaseH = Math.round(settledH || 0);
        lastLayoutWidth = window.innerWidth || 0;
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
    msgEl.addEventListener('toggle', (e) => {
      const target = e?.target;
      if (target && target.classList && target.classList.contains('thought-box')) {
        hydrateThoughtDetails(target);
      }
    }, true);
    msgEl.addEventListener('click', (e) => {
      if (e.target?.closest?.('#btn-load-earlier')) {
        void loadEarlierMessages();
        return;
      }
      const sum = e.target?.closest?.('summary');
      const detailsEl = sum?.parentElement;
      if (detailsEl && detailsEl.classList?.contains?.('thought-box')) {
        setTimeout(() => hydrateThoughtDetails(detailsEl), 0);
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
      if (typeof frac !== 'number') return 'var(--muted)';
      const p = frac * 100;
      return p >= 50 ? 'var(--green)' : (p >= 20 ? 'var(--amber)' : 'var(--red)');
    }

    let snapshotInflight = false;
    let snapshotSeq = 0;
    function invalidateInflightSnapshotPolls() {
      snapshotSeq += 1;
      snapshotInflight = false;
      if (activeSnapAbort) {
        try { activeSnapAbort.abort(); } catch {}
        activeSnapAbort = null;
      }
      schedulePoll();
    }

    async function apiAction(payload, opts) {
      const act = String(payload?.action || '').trim();
      const isNavAction = act === 'new-conversation' || act === 'switch-conversation';
      const actionStartEpoch = ++clientSyncEpoch;
      const myNavSeq = isNavAction ? (++lastNavActionSeq) : 0;
      if (isNavAction) invalidateInflightSnapshotPolls();
      const bodyPayload = {
        targetId: currentTargetId || undefined,
        conversationId: (isNavAction ? undefined : selectedConversationId) || undefined,
        clientId: clientId || undefined,
        ...payload
      };
      const doPost = () => fetchWithTimeout((apiBase || '') + '/api/action', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(bodyPayload)
      }, 8000);
      try {
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
        if (data?.snapshot && !opts?.skipAutoRender && (!isNavAction || myNavSeq === lastNavActionSeq)) {
          const snapApplied = renderSnapshot(data.snapshot, {
            reqStartEpoch: actionStartEpoch,
            advanceFloorOnApply: isNavAction
          });
          if (snapApplied && isNavAction) invalidateInflightSnapshotPolls();
        }
        return data;
      } finally {
        if (isNavAction && myNavSeq === lastNavActionSeq && !snapshotInflight) {
          schedulePoll();
        }
      }
    }

    function fmtNumShort(n) {
      const v = Number(n || 0);
      if (!Number.isFinite(v) || v <= 0) return '0';
      if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 1 : 2).replace(/\\.0+$/, '') + 'M';
      if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\\.0$/, '') + 'k';
      return String(Math.round(v));
    }

    function renderMarkdownSafe(rawText) {
      const src = String(rawText || '');
      if (!src) return '';
      const fence = String.fromCharCode(96).repeat(3);
      const inlineBt = String.fromCharCode(96);
      const parts = src.split(fence);
      let out = '';
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          const nlIdx = parts[i].indexOf('\\n');
          const codeBody = nlIdx >= 0 ? parts[i].slice(nlIdx + 1) : parts[i];
          out += '<pre><code>' + esc(codeBody) + '</code></pre>';
        } else {
          const segs = parts[i].split(inlineBt);
          let lineHtml = '';
          for (let j = 0; j < segs.length; j++) {
            lineHtml += j % 2 === 1
              ? ('<code>' + esc(segs[j]) + '</code>')
              : esc(segs[j]).replace(/\\n/g, '<br>');
          }
          out += lineHtml;
        }
      }
      return out;
    }

    function saveDraftForConv(convId, text) {
      const key = DRAFT_SESSION_PREFIX + (convId || '__desktop__');
      try {
        if (text) sessionStorage.setItem(key, text);
        else sessionStorage.removeItem(key);
      } catch {}
    }

    function loadDraftForConv(convId) {
      const key = DRAFT_SESSION_PREFIX + (convId || '__desktop__');
      try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
    }

    function applySelectedConversation(nextId) {
      const oldId = selectedConversationId;
      if (oldId !== nextId && typeof ta !== 'undefined' && ta) {
        saveDraftForConv(oldId, ta.value || '');
      }
      selectedConversationId = nextId || '';
      try {
        if (selectedConversationId) sessionStorage.setItem(CONV_ID_SESSION_KEY, selectedConversationId);
        else sessionStorage.removeItem(CONV_ID_SESSION_KEY);
      } catch {}
      if (oldId !== selectedConversationId && typeof ta !== 'undefined' && ta) {
        ta.value = loadDraftForConv(selectedConversationId);
        if (typeof autoGrow === 'function') autoGrow();
      }
    }

    function getEffectiveDisplayConfig(snap) {
      const raw = snap?.displayConfig || latestDisplayConfig || {};
      return {
        showContextPanel: raw.showContextPanel !== false,
        showUsagePanel: raw.showUsagePanel !== false,
        showQuotaPill: raw.showQuotaPill !== false,
        showChannelMeta: raw.showChannelMeta !== false,
        showSidebar: raw.showSidebar !== false,
        showThinking: raw.showThinking !== false,
        showQuickChips: raw.showQuickChips !== false,
        showComposerTools: raw.showComposerTools !== false,
        showApprovals: raw.showApprovals !== false
      };
    }

    function applyRemoteDisplayConfig(snap) {
      if (snap?.displayConfig) latestDisplayConfig = snap.displayConfig;
      const cfg = getEffectiveDisplayConfig(snap);
      const ctxBtn = $('btn-context-panel');
      const usageBtn = $('btn-usage-panel');
      const quotaBtn = $('btn-quota');
      const subMeta = $('sub-meta');
      const drawerBtn = $('btn-drawer');
      const chipsEl = $('chips');
      const dockEl = $('approval-dock');

      if (ctxBtn) ctxBtn.hidden = !cfg.showContextPanel;
      if (!cfg.showContextPanel && $('context-drawer') && !$('context-drawer').hidden) {
        $('context-drawer').hidden = true;
        ctxBtn?.classList.remove('active');
      }
      if (usageBtn) usageBtn.hidden = !cfg.showUsagePanel;
      if (!cfg.showUsagePanel && $('usage-drawer') && !$('usage-drawer').hidden) {
        $('usage-drawer').hidden = true;
        usageBtn?.classList.remove('active');
      }
      if (quotaBtn) quotaBtn.hidden = !cfg.showQuotaPill;
      if (!cfg.showQuotaPill && $('quota-drawer') && !$('quota-drawer').hidden) {
        $('quota-drawer').hidden = true;
        quotaBtn?.classList.remove('active');
      }
      if (subMeta) subMeta.hidden = !cfg.showChannelMeta;
      if (drawerBtn) drawerBtn.hidden = !cfg.showSidebar;
      if (!cfg.showSidebar && typeof closeDrawer === 'function') closeDrawer();
      if (document.body?.classList) {
        document.body.classList.toggle('hide-thinking', !cfg.showThinking);
        document.body.classList.toggle('hide-composer-tools', !cfg.showComposerTools);
      }
      if (chipsEl) chipsEl.hidden = !cfg.showQuickChips;
      if (dockEl && !cfg.showApprovals) dockEl.hidden = true;
      return cfg;
    }

    function syncTopbarDrawerButtons() {
      $('btn-context-panel')?.classList.toggle('active', Boolean($('context-drawer') && !$('context-drawer').hidden));
      $('btn-usage-panel')?.classList.toggle('active', Boolean($('usage-drawer') && !$('usage-drawer').hidden));
      $('btn-quota')?.classList.toggle('active', Boolean($('quota-drawer') && !$('quota-drawer').hidden));
    }

    async function fetchContextPanelData() {
      const qs = [];
      if (currentTargetId) qs.push('targetId=' + encodeURIComponent(currentTargetId));
      if (selectedConversationId) qs.push('conversationId=' + encodeURIComponent(selectedConversationId));
      const q = qs.length ? '?' + qs.join('&') : '';
      try {
        const res = await fetchWithTimeout((apiBase || '') + '/api/context' + q, { headers: authHeaders(), cache: 'no-store' }, 4500);
        if (res.status === 401) { location.reload(); return null; }
        const data = await res.json().catch(() => null);
        if (data?.ok) cachedContextResp = data;
        renderContextDrawer(latestSnap, cachedContextResp);
        return data;
      } catch {
        return null;
      }
    }

    async function fetchUsageData(force) {
      const q = force ? '?force=1' : '';
      try {
        const res = await fetchWithTimeout((apiBase || '') + '/api/usage' + q, { headers: authHeaders(), cache: 'no-store' }, 6000);
        if (res.status === 401) { location.reload(); return null; }
        const json = await res.json().catch(() => null);
        if (json?.ok && json.data) {
          cachedUsageData = json.data;
          if ($('usage-top-val') && cachedUsageData.summary?.totalTokens) {
            $('usage-top-val').textContent = fmtNumShort(cachedUsageData.summary.totalTokens);
          }
        }
        renderUsageDrawer(cachedUsageData);
        return json;
      } catch {
        renderUsageDrawer(cachedUsageData);
        return null;
      }
    }

    function openTopDrawer(kind) {
      const ctxBox = $('context-drawer');
      const usageBox = $('usage-drawer');
      const quotaBox = $('quota-drawer');
      const targetBox = kind === 'context' ? ctxBox : (kind === 'usage' ? usageBox : (kind === 'quota' ? quotaBox : null));
      const willOpen = Boolean(targetBox && targetBox.hidden);

      if (ctxBox) ctxBox.hidden = true;
      if (usageBox) usageBox.hidden = true;
      if (quotaBox) quotaBox.hidden = true;

      if (willOpen && targetBox) {
        targetBox.hidden = false;
        if (kind === 'context') {
          renderContextDrawer(latestSnap, cachedContextResp);
          void fetchContextPanelData();
        } else if (kind === 'usage') {
          renderUsageDrawer(cachedUsageData);
          void fetchUsageData(false);
        } else if (kind === 'quota' && latestSnap) {
          renderQuotaDrawer(latestSnap);
        }
      }
      syncTopbarDrawerButtons();
    }

    function renderContextDrawer(snap, ctxRes) {
      const box = $('context-drawer');
      if (!box || box.hidden) return;
      const cp = ctxRes?.contextPanel || snap?.contextPanel || {};
      const pct = typeof cp.usagePercent === 'number' ? Math.max(0, Math.min(100, cp.usagePercent)) : null;
      const usedStr = cp.usedText || (cp.usedTokens ? fmtNumShort(cp.usedTokens) : '—');
      const limitStr = cp.limitText || (cp.limitTokens ? fmtNumShort(cp.limitTokens) : '—');
      const remainStr = cp.remainingText || (cp.limitTokens && cp.usedTokens != null ? fmtNumShort(Math.max(0, cp.limitTokens - cp.usedTokens)) : '—');
      const speedStr = cp.speedText || (cp.tokPerSec != null ? cp.tokPerSec + ' tok/s' : '—');
      const cacheStr = cp.cacheHitRate != null ? cp.cacheHitRate + '%' : '—';
      const durStr = cp.durationText || (cp.lastDurationSec != null ? cp.lastDurationSec + 's' : '—');
      const modelStr = cp.modelDisplayName || ctxRes?.model || snap?.model || '—';
      const barCol = pct == null ? 'var(--accent)' : (pct >= 85 ? 'var(--red)' : (pct >= 65 ? 'var(--amber)' : 'var(--green)'));
      const isolatedTag = snap?.isolated ? '<span class="isolated-badge">独立浏览中</span>' : '';

      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">' +
          '<div style="display:flex;align-items:center;gap:6px;min-width:0"><strong style="font-size:13.5px">上下文窗口面板</strong>' + isolatedTag + '</div>' +
          '<button id="btn-refresh-context" class="icon-btn" style="height:26px;font-size:12px" type="button">↻ 刷新</button>' +
        '</div>' +
        '<div class="qcard">' +
          '<div class="qhead"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(ctxRes?.title || snap?.title || '当前会话') + '</span><span style="color:' + barCol + '">' + (pct != null ? pct.toFixed(1) + '%' : '--%') + '</span></div>' +
          '<div class="qbar"><div class="qfill" style="width:' + (pct != null ? pct.toFixed(1) : 0) + '%;background:' + barCol + '"></div></div>' +
          '<div class="qreset" style="margin-top:5px">模型：' + esc(modelStr) + '</div>' +
        '</div>' +
        '<div class="ctx-drawer-grid">' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">当前已用 / 上限</div><div class="ctx-stat-val">' + esc(usedStr) + ' / ' + esc(limitStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">剩余可用</div><div class="ctx-stat-val">' + esc(remainStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">输出速度 · 耗时</div><div class="ctx-stat-val">' + esc(speedStr) + ' · ' + esc(durStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">缓存命中率</div><div class="ctx-stat-val">' + esc(cacheStr) + '</div></div>' +
        '</div>' +
        (cp.sessionCostText ? '<div class="qreset" style="margin-top:6px">' + esc(cp.roundCostText ? cp.roundCostText + ' · ' : '') + esc(cp.sessionCostText) + '</div>' : '');

      const refBtn = $('btn-refresh-context');
      if (refBtn) refBtn.onclick = () => { void fetchContextPanelData(); };
    }

    function renderUsageDrawer(usageData) {
      const box = $('usage-drawer');
      if (!box || box.hidden) return;
      const summary = usageData?.summary || latestSnap?.usageSummary || {};
      const bySrc = usageData?.dailyMapBySource || null;
      const allMap = usageData?.dailyMap || {};
      const activeMap = (usageSourceFilter === 'desktop' && bySrc?.desktop)
        ? bySrc.desktop
        : ((usageSourceFilter === 'cli' && bySrc?.cli) ? bySrc.cli : allMap);
      const dayKeys = Object.keys(activeMap || {}).sort().slice(-14);
      let maxVal = 1;
      for (const k of dayKeys) {
        const v = Number(activeMap[k]?.totalTokens ?? activeMap[k]?.total ?? 0) || 0;
        if (v > maxVal) maxVal = v;
      }
      const barsHtml = dayKeys.length
        ? '<div class="usage-bars">' + dayKeys.map((k) => {
            const v = Number(activeMap[k]?.totalTokens ?? activeMap[k]?.total ?? 0) || 0;
            const h = Math.max(8, Math.round((v / maxVal) * 100));
            return '<div class="usage-bar-col" style="height:' + h + '%" title="' + esc(k + ': ' + fmtNumShort(v)) + '"></div>';
          }).join('') + '</div>'
        : '<div class="qreset">点击右上角刷新同步完整日均统计</div>';

      const todayStr = fmtNumShort(summary.todayTokens || 0);
      const sevenStr = fmtNumShort(summary.sevenDayTokens || 0);
      const thirtyStr = fmtNumShort(summary.thirtyDayTokens || 0);
      const totalStr = fmtNumShort(summary.totalTokens || 0);
      const costNum = Number(usageData?.referenceCost?.totalUsd ?? usageData?.costEstimate?.totalUsd ?? summary.totalCostUsd ?? 0) || 0;
      const costStr = costNum > 0 ? '$' + costNum.toFixed(2) : '—';

      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<strong style="font-size:13.5px">本机已记录用量面板</strong>' +
          '<button id="btn-refresh-usage" class="icon-btn" style="height:26px;font-size:12px" type="button">↻ 刷新</button>' +
        '</div>' +
        '<div class="usage-src-tabs">' +
          [['all', '全部'], ['desktop', '桌面端'], ['cli', 'CLI']].map(([k, lbl]) =>
            '<button class="usage-src-btn' + (usageSourceFilter === k ? ' active' : '') + '" data-src="' + k + '" type="button">' + lbl + '</button>'
          ).join('') +
        '</div>' +
        '<div class="usage-kpi-grid">' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">今日用量</div><div class="ctx-stat-val">' + esc(todayStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">近 7 天 / 30 天</div><div class="ctx-stat-val">' + esc(sevenStr) + ' / ' + esc(thirtyStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">累计总用量</div><div class="ctx-stat-val">' + esc(totalStr) + '</div></div>' +
          '<div class="ctx-stat-box"><div class="ctx-stat-lbl">API 参考等值</div><div class="ctx-stat-val">' + esc(costStr) + '</div></div>' +
        '</div>' +
        barsHtml;

      box.querySelectorAll('.usage-src-btn').forEach((btn) => {
        btn.onclick = () => {
          usageSourceFilter = btn.getAttribute('data-src') || 'all';
          try { sessionStorage.setItem(USAGE_SRC_SESSION_KEY, usageSourceFilter); } catch {}
          renderUsageDrawer(cachedUsageData);
        };
      });
      const refUsage = $('btn-refresh-usage');
      if (refUsage) refUsage.onclick = () => { void fetchUsageData(true); };
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

    let selectedProjectId = null;
    let selectedProjectFallbackName = '';
    let selectedProjectEpoch = 0;
    let clientSyncEpoch = 0;
    let minAcceptableReqStartEpoch = 0;
    let lastRenderedServerBootId = '';
    let lastRenderedServerBootAt = 0;
    let lastRenderedServerSnapSeq = 0;
    const retiredServerBootIds = new Set();
    let lastNavActionSeq = 0;

    function isNonProjectBucket(raw) {
      const pid = String(raw || '').trim();
      return !pid || pid === 'ungrouped' || pid === 'outside-of-project' || pid === 'standalone';
    }

    function normalizeProjectId(raw) {
      const pid = String(raw || '').trim();
      return isNonProjectBucket(pid) ? '' : pid;
    }

    function setUserSelectedProject(rawPid, fallbackName) {
      selectedProjectId = normalizeProjectId(rawPid);
      selectedProjectFallbackName = selectedProjectId ? String(fallbackName || '').trim() : '';
      selectedProjectEpoch = ++clientSyncEpoch;
      return selectedProjectEpoch;
    }

    // 方案 A：仅首次加载按宿主初始化选中项目；之后完全由手机端操作决定，不因桌面切换或后台轮询反向改写
    function syncSelectedProjectFromSnapshot(snap) {
      if (!snap || snap.ok === false) return;
      const snapPid = normalizeProjectId(snap.currentProjectId);
      const projects = Array.isArray(snap.projects) ? snap.projects : null;
      const hasProj = (pid) => Boolean(pid && (!projects || projects.some((p) => p && p.id === pid)));
      if (selectedProjectId === null) {
        selectedProjectId = hasProj(snapPid) ? snapPid : '';
        return;
      }
      if (selectedProjectId && !hasProj(selectedProjectId)) {
        selectedProjectId = '';
        selectedProjectFallbackName = '';
      }
    }

    function getEffectiveSelectedProject(snap) {
      const projects = Array.isArray(snap?.projects) ? snap.projects : [];
      const pid = selectedProjectId !== null
        ? selectedProjectId
        : normalizeProjectId(snap?.currentProjectId);
      if (!pid) return { id: '', name: '' };
      const matched = projects.find((p) => p && p.id === pid);
      const name = String(
        matched?.name ||
        (pid === normalizeProjectId(snap?.currentProjectId) ? snap?.currentProjectName : '') ||
        selectedProjectFallbackName ||
        ''
      ).trim();
      return { id: pid, name };
    }

    function syncNewChatButtonUi(snap) {
      const newChatLabelEl = $('new-chat-label');
      if (newChatLabelEl) newChatLabelEl.textContent = '新建对话';
      const eff = getEffectiveSelectedProject(snap);
      const newChatSubEl = $('new-chat-sub');
      if (newChatSubEl) {
        newChatSubEl.textContent = eff.name;
        newChatSubEl.hidden = !eff.name;
      }
      const newChatBtnEl = $('btn-new-chat');
      if (newChatBtnEl) {
        newChatBtnEl.title = eff.name ? ('在「' + eff.name + '」中新建对话') : '新建对话';
      }
    }

    function renderSnapshot(snap, opts) {
      if (!snap || snap.ok === false) {
        $('status-dot').className = 'dot err';
        $('conv-title').textContent = snap?.error || '连接异常';
        return false;
      }
      const reqEpoch = typeof opts?.reqStartEpoch === 'number' ? opts.reqStartEpoch : null;
      if (reqEpoch !== null && reqEpoch < minAcceptableReqStartEpoch) {
        return false;
      }
      const bootId = String(snap.serverBootId || '').trim();
      const bootAt = Number(snap.serverBootAt) || 0;
      const snapSeqNum = Number.isInteger(snap.snapSeq) && snap.snapSeq > 0 ? snap.snapSeq : 0;
      if (bootId) {
        if (retiredServerBootIds.has(bootId)) {
          return false;
        }
        if (lastRenderedServerBootId && bootId !== lastRenderedServerBootId) {
          if (bootAt > 0 && lastRenderedServerBootAt > 0 && bootAt < lastRenderedServerBootAt) {
            return false;
          }
          if (lastRenderedServerBootAt > 0 && bootAt <= 0) {
            return false;
          }
        } else if (snapSeqNum > 0 && snapSeqNum < lastRenderedServerSnapSeq) {
          return false;
        }
      } else if (snapSeqNum > 0 && snapSeqNum < lastRenderedServerSnapSeq) {
        return false;
      }
      if (reqEpoch !== null) {
        minAcceptableReqStartEpoch = opts?.advanceFloorOnApply
          ? Math.max(minAcceptableReqStartEpoch, ++clientSyncEpoch)
          : Math.max(minAcceptableReqStartEpoch, reqEpoch);
      }
      if (bootId) {
        if (lastRenderedServerBootId && bootId !== lastRenderedServerBootId) {
          retiredServerBootIds.add(lastRenderedServerBootId);
          lastRenderedServerBootId = bootId;
          lastRenderedServerBootAt = bootAt > 0 ? bootAt : lastRenderedServerBootAt;
          lastRenderedServerSnapSeq = snapSeqNum;
        } else {
          if (!lastRenderedServerBootId) lastRenderedServerBootId = bootId;
          if (bootAt > lastRenderedServerBootAt) lastRenderedServerBootAt = bootAt;
          if (snapSeqNum > lastRenderedServerSnapSeq) lastRenderedServerSnapSeq = snapSeqNum;
        }
      } else if (snapSeqNum > lastRenderedServerSnapSeq) {
        lastRenderedServerSnapSeq = snapSeqNum;
      }
      latestSnap = snap;
      syncSelectedProjectFromSnapshot(snap);
      if ($('btn-follow-desktop')) $('btn-follow-desktop').hidden = !Boolean(snap.isolated);
      if (snap.currentTargetId) {
        currentTargetId = snap.currentTargetId;
        try { sessionStorage.setItem(TARGET_ID_SESSION_KEY, currentTargetId); } catch {}
      }
      if (Array.isArray(snap.endpoints) && snap.endpoints.length) {
        pairState.endpoints = snap.endpoints;
        if (Array.isArray(snap.hosts) && snap.hosts.length) pairState.hosts = snap.hosts;
        saveStoredPair(pairState);
        if (!manualLocked && !isAutoSwitched && !autoSwitchChecked && getEnabledModeEntries().length > 1) {
          autoSwitchChecked = true;
          void runSpeedTest({ autoSwitch: true, silent: true });
        }
      }

      const displayCfg = applyRemoteDisplayConfig(snap);
      $('status-dot').className = snap.busy ? 'dot busy' : 'dot';
      $('conv-title').textContent = snap.title || 'Antigravity';
      $('sub-meta').textContent = getActiveChannelLabel() + (snap.isolated ? ' · 独立视图' : '') + ' ▾ · ' + (snap.pulseText || (snap.busy ? '正在生成内容…' : (snap.contextBadge || '已连接')));

      const gStr = fmtPct(snap.quota?.gemini?.remainingFraction);
      const cStr = fmtPct(snap.quota?.claude?.remainingFraction);
      $('quota-main').textContent = 'G4 ' + gStr + ' · C ' + cStr;
      $('ctx-badge').textContent = snap.contextBadge || '--%';
      const cp = snap.contextPanel || {};
      const ctxPctMatch = String(snap.contextBadge || '').match(/(\\d+(?:\\.\\d+)?)%/);
      const ctxPctNum = typeof cp.usagePercent === 'number'
        ? Math.round(cp.usagePercent) + '%'
        : (ctxPctMatch ? ctxPctMatch[1] + '%' : '--%');
      if ($('ctx-top-val')) $('ctx-top-val').textContent = ctxPctNum;
      if ($('usage-top-val')) {
        const totTok = Number(cachedUsageData?.summary?.totalTokens || snap.usageSummary?.totalTokens || 0);
        $('usage-top-val').textContent = totTok > 0 ? fmtNumShort(totTok) : '用量';
      }
      $('model-inline-label').textContent = snap.model || '切换模型';
      syncPermInlineUi(snap.permissionKey, snap.permissionLabel);
      syncNewChatButtonUi(snap);

      renderQuotaDrawer(snap);
      if ($('context-drawer') && !$('context-drawer').hidden) renderContextDrawer(snap, cachedContextResp);
      if ($('usage-drawer') && !$('usage-drawer').hidden) renderUsageDrawer(cachedUsageData);
      syncSendButtonUI();

      // Messages (full history + upward pagination + gap backfill + scroll anchor)
      msgEl.classList.remove('is-switching');
      const snapSid = snap.isNewConversation ? '__new__' : String(snap.sessionId || '');
      const nextHistSource = snap.historySource === 'trajectory' || snap.historySource === 'dom' ? snap.historySource : '';
      if (snapSid !== activeMsgSessionId) {
        activeMsgSessionId = snapSid;
        activeMsgHistorySource = nextHistSource;
        sessionMsgsByIndex.clear();
        openThoughtIdxSet.clear();
        loadingEarlierMsgs = false;
        backfillingMsgGaps = false;
        stickBottom = true;
      } else if (activeMsgHistorySource === 'dom' && nextHistSource === 'trajectory') {
        // RPC 偶发降级 domTail（写入 0..59 临时键）后恢复全量轨迹时，清空旧临时键防止前 60 条重复错序
        sessionMsgsByIndex.clear();
        activeMsgHistorySource = 'trajectory';
      } else if (nextHistSource) {
        activeMsgHistorySource = nextHistSource;
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
      if (!displayCfg.showApprovals || !approvals.length) {
        dock.hidden = true;
        dock.innerHTML = '';
      } else {
        dock.hidden = false;
        const firstRisk = approvals.some((a) => a.highRisk);
        const ctx = approvals[0]?.contextText || '桌面端正在等待你的操作确认';
        dock.innerHTML = '<div class="approval-card' + (firstRisk ? ' is-risk' : '') + '">' +
          (firstRisk ? '<div style="font-size:12px;font-weight:700;color:var(--risk-fg)">' + esc(approvals[0].riskText || '🛡️ 高危操作确认') + '</div>' : '') +
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
      items.push({
        cls: 'chip',
        text: '展开/收起思考',
        act: () => {
          const boxes = Array.from(document.querySelectorAll('#messages .thought-box'));
          if (!boxes.length) { showToast('当前消息暂无思考过程'); return { ok: true }; }
          const anyClosed = boxes.some((b) => !(b.open || (typeof b.hasAttribute === 'function' && b.hasAttribute('open'))));
          boxes.forEach((b) => {
            b.open = anyClosed;
            if (typeof b.setAttribute === 'function' && typeof b.removeAttribute === 'function') {
              if (anyClosed) b.setAttribute('open', '');
              else b.removeAttribute('open');
            }
            hydrateThoughtDetails(b);
          });
          return { ok: true };
        }
      });

      const chipsSig = JSON.stringify(items.map((it) => [it.cls, it.text, it.raw || '']));
      if (chips.dataset.sig !== chipsSig) {
        chips.dataset.sig = chipsSig;
        chips.innerHTML = '';
        for (const it of items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = it.cls;
          b.textContent = it.text;
          bindButtonClick(b, async () => {
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
          });
          chips.appendChild(b);
        }
      }

      // Drawer Conversations & Multi-Project Grouping (with projectGroups drilldown fallback)
      const useDrilldownDrawer = shouldUseDrilldownDrawer(snap);
      const navBarEl = $('drawer-nav-bar');
      const convToolbarEl = document.querySelector('.conv-toolbar');
      if (navBarEl) navBarEl.hidden = !useDrilldownDrawer;
      if (convToolbarEl) convToolbarEl.hidden = useDrilldownDrawer;
      if (useDrilldownDrawer) {
        renderDrawerProjectsAndConversations(snap);
      } else {
        reconcileExtraConversations(snap);
        renderConversationList(snap);
      }
      return true;
    }

    function shouldUseDrilldownDrawer(snap) {
      return Boolean(
        (!Array.isArray(snap?.projects) || !snap.projects.length) &&
        Array.isArray(snap?.projectGroups) &&
        snap.projectGroups.length > 0
      );
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
        const orderedProjects = Array.from(projMap.values()).filter((p) =>
          !isNonProjectBucket(p.id) || (p.conversationCount > 0) || ((grouped.get(p.id)?.length || 0) > 0)
        );
        const effProj = getEffectiveSelectedProject(snap);

        if (!orderedProjects.length) {
          html = '<div class="empty-tip" style="padding:18px 8px">暂无项目与历史对话</div>';
        } else {
          html = orderedProjects.map((p) => {
            const list = grouped.get(p.id) || [];
            const projTotal = Math.max(list.length, Number(p.conversationCount) || 0);
            const isEmptyProj = projTotal === 0 && list.length === 0;
            const hasRunning = (p.runningCount > 0) || list.some((x) => x.status === 'running');
            const hasWaiting = (p.waitingCount > 0) || list.some((x) => x.status === 'waiting');
            const collapsed = !isEmptyProj && Boolean(collapsedProjMap[p.id]);
            const isCurrentProj = Boolean(effProj.id && p.id === effProj.id);
            const isUngroupedProj = isNonProjectBucket(p.id);
            const groupCls = 'proj-group' + (isCurrentProj ? ' is-current' : '') + (isUngroupedProj ? ' is-ungrouped' : '') + (isEmptyProj ? ' is-empty' : '');
            const statDot = hasWaiting
              ? '<span class="proj-stat-dot waiting" title="有待确认操作"></span>'
              : (hasRunning ? '<span class="proj-stat-dot running" title="有运行中对话"></span>' : '');
            const newBtnHtml = !isUngroupedProj
              ? '<button class="proj-new-btn" data-new-proj="' + esc(p.id) + '" type="button" title="在 ' + esc(p.name) + ' 中新建对话" aria-label="在 ' + esc(p.name) + ' 中新建对话">+</button>'
              : '';
            const projMoreHtml = list.length < projTotal
              ? '<button class="conv-more-btn" data-proj-more="' + esc(p.id) + '" type="button">加载该项目更多对话 (' + list.length + '/' + projTotal + ')</button>'
              : '';
            const itemsHtml = (isEmptyProj || collapsed) ? '' : ('<div class="proj-body">' + list.map((c) => renderConvItemHtml(c, false)).join('') + projMoreHtml + '</div>');
            const chevChar = isEmptyProj ? '·' : (collapsed ? '▸' : '▾');
            const expandedAttr = isEmptyProj ? '' : (' aria-expanded="' + (collapsed ? 'false' : 'true') + '"');
            return '<div class="' + groupCls + '">' +
              '<div class="proj-head">' +
                '<button class="proj-toggle" data-proj-toggle="' + esc(p.id) + '" type="button"' + expandedAttr + '>' +
                  '<span class="proj-chev">' + chevChar + '</span>' +
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
        }
      }

      if (convList.dataset.lastHtml !== html) {
        convList.innerHTML = html;
        convList.dataset.lastHtml = html;
      }
    }

    function normalizeProjectGroups(snap) {
      const rawGroups = Array.isArray(snap?.projectGroups) ? snap.projectGroups : [];
      if (rawGroups.length) {
        return rawGroups.map((g, idx) => {
          const convs = Array.isArray(g.conversations) ? g.conversations : [];
          const name = String(g.name || '未命名项目').trim() || '未命名项目';
          const key = String(g.key || g.id || ('proj:' + idx + ':' + name));
          return {
            id: String(g.id || ''),
            key,
            name,
            count: Math.max(Number(g.count) || 0, convs.length),
            isCollapsed: Boolean(g.isCollapsed),
            active: Boolean(g.active || convs.some((c) => c.active)),
            conversations: convs
          };
        });
      }
      const convs = Array.isArray(snap?.conversations) ? snap.conversations : [];
      const map = new Map();
      for (const c of convs) {
        if (!c || !c.id) continue;
        const pName = String(c.project || '默认项目').trim() || '默认项目';
        if (!map.has(pName)) {
          map.set(pName, {
            id: '',
            key: 'proj:' + pName,
            name: pName,
            count: 0,
            isCollapsed: false,
            active: false,
            conversations: []
          });
        }
        const g = map.get(pName);
        g.conversations.push(c);
        g.count = g.conversations.length;
        if (c.active) g.active = true;
      }
      return Array.from(map.values());
    }

    function renderDrawerProjectsAndConversations(snap, animate) {
      const convList = $('conv-list');
      const navBar = $('drawer-nav-bar');
      if (!convList) return;
      const groups = normalizeProjectGroups(snap);
      let selectedGroup = activeDrawerProject
        ? groups.find((g) => g.key === activeDrawerProject || g.id === activeDrawerProject || g.name === activeDrawerProject)
        : null;
      if (activeDrawerProject && !selectedGroup) {
        activeDrawerProject = '';
      }

      if (animate && convList.classList) {
        convList.classList.remove('anim-enter');
        try { void convList.offsetWidth; } catch {}
        convList.classList.add('anim-enter');
      }

      if (selectedGroup) {
        if (navBar) {
          const navHtml = '<button id="btn-drawer-back" class="drawer-back-btn" type="button">‹ 返回项目</button>'
            + '<span class="drawer-proj-title" title="' + esc(selectedGroup.name) + '">📁 ' + esc(selectedGroup.name) + '</span>';
          if (navBar.dataset.lastHtml !== navHtml) {
            navBar.innerHTML = navHtml;
            navBar.dataset.lastHtml = navHtml;
          }
        }
        const convHtml = selectedGroup.conversations.length
          ? selectedGroup.conversations.map((c) =>
              '<button class="conv-item' + (c.active ? ' active' : '') + '" data-cid="' + esc(c.id) + '" type="button">' + esc(c.title) + '</button>'
            ).join('')
          : '<div class="empty-tip" style="padding:16px 8px">该项目暂无可切换会话</div>';
        if (convList.dataset.lastHtml !== convHtml) {
          convList.innerHTML = convHtml;
          convList.dataset.lastHtml = convHtml;
        }
        return;
      }

      if (navBar) {
        const navHtml = '<span class="drawer-sub">项目列表 (' + groups.length + ')</span>';
        if (navBar.dataset.lastHtml !== navHtml) {
          navBar.innerHTML = navHtml;
          navBar.dataset.lastHtml = navHtml;
        }
      }
      const projHtml = groups.length
        ? groups.map((g) =>
            '<button class="proj-item' + (g.active ? ' active' : '') + '" data-proj-key="' + esc(g.key) + '" type="button">'
            + '<span class="proj-item-left"><span>📁</span><span class="proj-item-name">' + esc(g.name) + '</span>'
            + (g.active ? '<span class="mode-pill cur">当前</span>' : '')
            + '</span>'
            + '<span class="proj-item-right"><span class="lat-badge muted">' + esc(g.count) + '</span><span>›</span></span>'
            + '</button>'
          ).join('')
        : '<div class="empty-tip" style="padding:16px 8px">暂无历史项目</div>';
      if (convList.dataset.lastHtml !== projHtml) {
        convList.innerHTML = projHtml;
        convList.dataset.lastHtml = projHtml;
      }
    }

    async function fetchSnapshot() {
      if (snapshotInflight) return;
      snapshotInflight = true;
      const mySeq = ++snapshotSeq;
      const fetchStartEpoch = ++clientSyncEpoch;
      const qs = [];
      if (currentTargetId) qs.push('targetId=' + encodeURIComponent(currentTargetId));
      if (selectedConversationId) qs.push('conversationId=' + encodeURIComponent(selectedConversationId));
      const q = qs.length ? '?' + qs.join('&') : '';
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
        if (mySeq === snapshotSeq) renderSnapshot(data, { reqStartEpoch: fetchStartEpoch });
      } catch {
        if (mySeq !== snapshotSeq) return;
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
            if (mySeq === snapshotSeq) renderSnapshot(retryData, { reqStartEpoch: fetchStartEpoch });
            return;
          } catch {}
        }
        $('status-dot').className = 'dot err';
        $('sub-meta').textContent = '连接中断，点击可切换连接方式';
        if (!latestSnap) {
          renderModeEntryGate('当前入口暂未连通，请点击下方已开启的连接方式直接进入：');
        }
      } finally {
        if (mySeq === snapshotSeq) {
          snapshotInflight = false;
          activeSnapAbort = null;
          schedulePoll();
        }
      }
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      if (document.hidden || navigatingAway) return;
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

    function closeSheet() {
      const backdrop = $('sheet-backdrop');
      if (backdrop && backdrop.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch {}
      }
      if (backdrop) backdrop.hidden = true;
      resetModalSheetShift();
      syncViewportHeight();
    }

    let activeSheetState = null;
    async function handleSheetListClick(e) {
      const btn = e?.target?.closest?.('.sheet-opt');
      if (!btn || !activeSheetState) return;
      const idx = Number(btn.getAttribute('data-idx'));
      const opt = activeSheetState.options[idx];
      const onSelect = activeSheetState.onSelect;
      activeSheetState = null;
      closeSheet();
      if (opt && typeof onSelect === 'function') await onSelect(opt);
    }
    const sheetListEl = $('sheet-list');
    sheetListEl.onclick = handleSheetListClick;
    if (!(typeof EventTarget === 'function' && sheetListEl instanceof EventTarget) && typeof sheetListEl.addEventListener === 'function') {
      sheetListEl.addEventListener('click', handleSheetListClick);
    }
    function openSheet(title, options, onSelect) {
      configureSheetChrome({
        kind: 'generic',
        title,
        subText: '',
        showSpeed: false,
        onBack: null
      });
      const listEl = $('sheet-list');
      activeSheetState = { options, onSelect };
      listEl.innerHTML = options.map((o, idx) =>
        '<button class="sheet-opt' + (o.active ? ' active' : '') + '" data-idx="' + idx + '" type="button">' +
        '<span>' + esc(o.label) + '</span>' + (o.active ? '<span>✓</span>' : '') + '</button>'
      ).join('');
      listEl.onclick = handleSheetListClick;
      $('sheet-backdrop').hidden = false;
      syncViewportHeight();
    }
    $('sheet-close').onclick = closeSheet;
    $('sheet-backdrop').onclick = (e) => {
      if (e.target === $('sheet-backdrop')) closeSheet();
    };

    const EFFORT_META = {
      max: { label: '最高 · Max', short: 'Max', rank: 0 },
      xhigh: { label: '超高 · XHigh', short: 'XHigh', rank: 1 },
      high: { label: '高 · High', short: 'High', rank: 2 },
      medium: { label: '中 · Medium', short: 'Medium', rank: 3 },
      low: { label: '低 · Low', short: 'Low', rank: 4 }
    };

    function groupModelsByBaseId(modelOptions, currentModelLabel) {
      const groups = [];
      const groupMap = new Map();
      for (const m of (modelOptions || [])) {
        if (!m || !m.label) continue;
        const rawLabel = String(m.label).trim();
        const rawModelId = String(m.modelId || '').trim();
        const idMatch = rawModelId.match(/^(.*?)-(xhigh|high|medium|low|max)$/i);
        const lblMatch = rawLabel.match(/^(.*?)\\s*\\((XHigh|High|Medium|Low|Max)\\)\\s*$/i);
        const effortKey = idMatch
          ? idMatch[2].toLowerCase()
          : (lblMatch ? lblMatch[2].toLowerCase() : '');
        const baseModelId = idMatch
          ? idMatch[1].toLowerCase()
          : (rawModelId || (lblMatch ? lblMatch[1].trim() : rawLabel)).toLowerCase();
        const baseLabel = lblMatch ? lblMatch[1].trim() : rawLabel;
        const meta = EFFORT_META[effortKey] || { label: effortKey || rawLabel, short: effortKey || '', rank: 9 };
        const isActive = Boolean(m.selected || rawLabel === currentModelLabel);

        if (!groupMap.has(baseModelId)) {
          const g = {
            baseModelId,
            baseLabel,
            active: false,
            hasEffortChoice: false,
            variants: []
          };
          groupMap.set(baseModelId, g);
          groups.push(g);
        }
        const grp = groupMap.get(baseModelId);
        if (isActive) grp.active = true;
        grp.variants.push({
          label: rawLabel,
          modelId: rawModelId,
          effortKey,
          effortLabel: meta.label,
          effortShort: meta.short,
          rank: meta.rank,
          active: isActive
        });
      }
      for (const grp of groups) {
        grp.variants.sort((a, b) => a.rank - b.rank);
        grp.hasEffortChoice = grp.variants.length > 1;
      }
      return groups;
    }

    async function applyModelSelection(opt) {
      if (!opt) return;
      showToast('正在切换至 ' + opt.label + '…');
      try {
        const r = await apiAction({ action: 'select-model', label: opt.label, modelId: opt.modelId });
        if (r?.ok) showToast('已切换到 ' + (r.actionResult?.model || opt.label));
        else showToast(r?.error || r?.actionResult?.error || '切换模型失败');
      } catch (err) {
        showToast(err?.message || '切换模型失败');
      }
    }

    function openModelPicker() {
      activeSheetState = null;
      const groups = groupModelsByBaseId(latestSnap?.modelOptions || [], latestSnap?.model || '');
      if (!groups.length) {
        showToast('未检测到可用模型列表');
        return;
      }
      configureSheetChrome({
        kind: 'model',
        title: '切换模型',
        subText: '',
        showSpeed: false,
        onBack: null
      });
      const listEl = $('sheet-list');
      const groupsHtml = groups.map((g, gIdx) => {
        const activeVar = g.variants.find((v) => v.active);
        const effPill = (g.hasEffortChoice && activeVar?.effortShort)
          ? '<span class="mode-pill cur">' + esc(activeVar.effortShort) + '</span>'
          : '';
        const rightTag = g.hasEffortChoice
          ? ('<span class="lat-badge muted">' + g.variants.length + ' 档 ›</span>')
          : (g.active ? '<span>✓</span>' : '');
        return '<button class="sheet-opt' + (g.active ? ' active' : '') + '" data-group-idx="' + gIdx + '" type="button">'
          + '<span class="sheet-opt-left">'
          + '<span class="sheet-opt-top"><span>' + esc(g.baseLabel) + '</span>' + effPill + '</span>'
          + (g.baseModelId ? ('<span class="sheet-opt-host">' + esc(g.baseModelId) + '</span>') : '')
          + '</span>'
          + '<span class="sheet-opt-right">' + rightTag + '</span>'
          + '</button>';
      }).join('');

      listEl.innerHTML =
        '<div class="sheet-stage-viewport">'
        + '<div id="sheet-stage-track" class="sheet-stage-track">'
        + '<div id="model-group-pane" class="sheet-stage-pane">' + groupsHtml + '</div>'
        + '<div id="model-effort-pane" class="sheet-stage-pane"></div>'
        + '</div>'
        + '</div>';

      const findPane = (id) => $(id) || listEl.querySelector?.('#' + id) || null;
      listEl.onclick = async (e) => {
        const varBtn = e.target?.closest?.('[data-variant-idx]');
        if (varBtn) {
          const g = groups[Number(varBtn.dataset.groupIdx)];
          const v = g?.variants?.[Number(varBtn.dataset.variantIdx)];
          closeSheet();
          if (v) await applyModelSelection(v);
          return;
        }
        const grpBtn = e.target?.closest?.('[data-group-idx]');
        if (!grpBtn) return;
        const gIdx = Number(grpBtn.dataset.groupIdx);
        const g = groups[gIdx];
        if (!g) return;
        if (!g.hasEffortChoice) {
          closeSheet();
          await applyModelSelection(g.variants[0]);
          return;
        }
        const trackEl = findPane('sheet-stage-track');
        const groupPane = findPane('model-group-pane');
        const effortPane = findPane('model-effort-pane');
        if (groupPane) {
          groupPane.querySelectorAll?.('.sheet-opt.sliding-out')?.forEach?.((el) => el.classList.remove('sliding-out'));
        }
        grpBtn.classList?.add?.('sliding-out');
        if (effortPane) {
          effortPane.innerHTML = g.variants.map((v, vIdx) =>
            '<button class="sheet-opt' + (v.active ? ' active' : '') + '" data-group-idx="' + gIdx + '" data-variant-idx="' + vIdx + '" type="button">'
            + '<span class="sheet-opt-left">'
            + '<span class="sheet-opt-top"><span>' + esc(v.effortLabel) + '</span>' + (v.active ? '<span class="mode-pill cur">当前</span>' : '') + '</span>'
            + '<span class="sheet-opt-host">' + esc(v.modelId || v.label) + '</span>'
            + '</span>'
            + '<span class="sheet-opt-right">' + (v.active ? '<span>✓</span>' : '') + '</span>'
            + '</button>'
          ).join('');
        }
        if (trackEl) trackEl.classList.add('step-effort');
        configureSheetChrome({
          kind: 'model-effort',
          title: g.baseLabel,
          subText: '选择思考等级 · ' + g.baseModelId,
          showSpeed: false,
          onBack: () => {
            if (trackEl) trackEl.classList.remove('step-effort');
            if (groupPane) {
              groupPane.querySelectorAll?.('.sheet-opt.sliding-out')?.forEach?.((el) => el.classList.remove('sliding-out'));
            }
            configureSheetChrome({
              kind: 'model',
              title: '切换模型',
              subText: '',
              showSpeed: false,
              onBack: null
            });
          }
        });
      };
      $('sheet-backdrop').hidden = false;
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
    let activeMsgHistorySource = '';
    const sessionMsgsByIndex = new Map();
    const openThoughtIdxSet = new Set();
    let loadingEarlierMsgs = false;
    let backfillingMsgGaps = false;

    function hydrateThoughtDetails(detailsEl) {
      if (!detailsEl) return;
      const idx = Number(detailsEl.getAttribute('data-thought-idx'));
      if (!Number.isFinite(idx)) return;
      const isOpen = Boolean(detailsEl.open || (typeof detailsEl.hasAttribute === 'function' && detailsEl.hasAttribute('open')));
      if (isOpen) {
        openThoughtIdxSet.add(idx);
        if (!detailsEl.querySelector('.thought-body')) {
          const m = sessionMsgsByIndex.get(idx);
          if (m?.thoughtText) {
            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'thought-body';
            bodyDiv.textContent = m.thoughtText;
            detailsEl.appendChild(bodyDiv);
          }
        }
      } else {
        openThoughtIdxSet.delete(idx);
      }
    }

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
        const isThoughtOpen = Boolean(m.thoughtText && openThoughtIdxSet.has(m.msgIndex));
        const thought = m.thoughtLabel
          ? '<details class="thought-box" data-thought-idx="' + m.msgIndex + '"' + (isThoughtOpen ? ' open' : '') + '><summary>💡 ' + esc(m.thoughtLabel) + (m.thoughtText ? ' · 展开思考' : '') + '</summary>' +
            (isThoughtOpen ? '<div class="thought-body">' + esc(m.thoughtText) + '</div>' : '') + '</details>'
          : '';
        const bodyHtml = m.html
          ? '<div class="md-body">' + m.html + '</div>'
          : '<div class="md-body">' + renderMarkdownSafe(m.text || '') + '</div>';
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

    function bindButtonClick(el, fn) {
      if (!el || typeof fn !== 'function') return;
      const seenEvents = typeof WeakSet === 'function' ? new WeakSet() : null;
      const isNativeTarget = typeof EventTarget === 'function' && el instanceof EventTarget;
      const wrapped = (e) => {
        if (e && typeof e === 'object') {
          if (seenEvents) {
            if (seenEvents.has(e)) return;
            seenEvents.add(e);
          } else if (e.__agClickHandled) {
            return;
          } else {
            try { e.__agClickHandled = true; } catch {}
          }
        }
        return fn(e);
      };
      el.onclick = wrapped;
      if (!isNativeTarget && typeof el.addEventListener === 'function') {
        el.addEventListener('click', wrapped);
      }
    }

    bindButtonClick($('btn-model-inline'), openModelPicker);
    bindButtonClick($('btn-perm-inline'), openPermPicker);

    const THEME_STORAGE_KEY = 'ag_remote_theme_v1';
    const lightSchemeMq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null;

    function normalizeThemePref(raw) {
      return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
    }
    function readStoredThemePref() {
      try { return normalizeThemePref(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return 'system'; }
    }
    let activeThemePref = readStoredThemePref();
    function resolveEffectiveTheme(pref) {
      if (pref === 'light' || pref === 'dark') return pref;
      return lightSchemeMq && lightSchemeMq.matches ? 'light' : 'dark';
    }
    function applyTheme(rawPref, persist = false) {
      const pref = normalizeThemePref(rawPref);
      activeThemePref = pref;
      if (persist) {
        try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch {}
      }
      const effective = resolveEffectiveTheme(pref);
      const docEl = document.documentElement;
      docEl.setAttribute('data-theme', effective);
      docEl.setAttribute('data-theme-pref', pref);
      docEl.style.colorScheme = effective;
      const metaColor = $('meta-theme-color');
      if (metaColor) metaColor.setAttribute('content', effective === 'light' ? '#f8fafc' : '#09090b');

      const seg = $('theme-seg');
      if (seg) {
        seg.querySelectorAll('.theme-seg-btn').forEach((btn) => {
          const active = btn.getAttribute('data-theme-mode') === pref;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
      }
      return { pref, effective };
    }
    function selectThemePref(nextPref) {
      const { pref, effective } = applyTheme(nextPref, true);
      const effText = effective === 'light' ? '浅色' : '深色';
      showToast(pref === 'system' ? ('已设为跟随系统（当前' + effText + '）') : ('已切换为固定' + effText));
    }
    const themeSegEl = $('theme-seg');
    if (themeSegEl) {
      themeSegEl.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.theme-seg-btn');
        const mode = btn?.getAttribute?.('data-theme-mode');
        if (!mode) return;
        selectThemePref(mode);
      });
    }
    if (lightSchemeMq) {
      const onSystemSchemeChange = () => {
        if (activeThemePref === 'system') applyTheme('system', false);
      };
      if (typeof lightSchemeMq.addEventListener === 'function') lightSchemeMq.addEventListener('change', onSystemSchemeChange);
      else if (typeof lightSchemeMq.addListener === 'function') lightSchemeMq.addListener(onSystemSchemeChange);
    }
    window.addEventListener('storage', (e) => {
      if (e && e.key === THEME_STORAGE_KEY) applyTheme(e.newValue, false);
    });
    applyTheme(activeThemePref, false);

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
        hint.innerHTML = '<span>🖼️ 已传至桌面端: ' + esc(uploadedNames.slice(-3).join('、')) + (uploadedNames.length > 3 ? ' 等' + uploadedNames.length + '张' : '') + '</span><button type="button" style="background:none;border:none;color:var(--accent-strong-fg);font-weight:700;cursor:pointer">✕</button>';
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

    if ($('btn-context-panel')) {
      $('btn-context-panel').onclick = (e) => {
        e.stopPropagation();
        openTopDrawer('context');
      };
    }
    if ($('btn-usage-panel')) {
      $('btn-usage-panel').onclick = (e) => {
        e.stopPropagation();
        openTopDrawer('usage');
      };
    }
    $('btn-quota').onclick = (e) => {
      e.stopPropagation();
      openTopDrawer('quota');
    };
    document.addEventListener('click', (e) => {
      const t = e.target;
      const pairs = [
        ['context-drawer', 'btn-context-panel'],
        ['usage-drawer', 'btn-usage-panel'],
        ['quota-drawer', 'btn-quota']
      ];
      for (const [drawerId, btnId] of pairs) {
        const box = $(drawerId);
        const btn = $(btnId);
        if (box && !box.hidden && !box.contains(t) && t !== btn && !btn?.contains?.(t)) {
          box.hidden = true;
        }
      }
      syncTopbarDrawerButtons();
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
      const mySelEpoch = setUserSelectedProject(projectId, projectName);
      const pid = selectedProjectId;
      syncNewChatButtonUi(latestSnap);
      if (latestSnap) renderConversationList(latestSnap);
      if (!isDesktopLayout()) closeDrawer();
      stickBottom = true;
      const myNavSeqSnapshot = lastNavActionSeq;
      try {
        const payload = { action: 'new-conversation' };
        if (pid) payload.projectId = pid;
        const r = await apiAction(payload);
        const isCurrentNav = mySelEpoch === selectedProjectEpoch && lastNavActionSeq === myNavSeqSnapshot + 1;
        if (r?.ok) {
          if (isCurrentNav) {
            applySelectedConversation(String(r?.snapshot?.activeConversationId || r?.snapshot?.sessionId || '__new__'));
            showToast(projectName ? ('已在「' + projectName + '」中新建对话') : '已新建对话');
          }
        } else if (isCurrentNav) {
          showToast(r?.error || r?.actionResult?.error || '新建对话失败');
        }
      } catch (err) {
        if (mySelEpoch === selectedProjectEpoch && lastNavActionSeq === myNavSeqSnapshot + 1) {
          showToast(err?.message || '新建对话失败');
        }
      }
    }

    function openNewChatProjectPicker() {
      const projs = (latestSnap?.projects || []).filter((p) => p && !isNonProjectBucket(p.id));
      const effProj = getEffectiveSelectedProject(latestSnap);
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
          active: Boolean(effProj.id && p.id === effProj.id)
        })),
        {
          projectId: '',
          projectName: '',
          label: '默认工作区（不指定项目）',
          active: !effProj.id
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
        ? (' · 已关联项目「' + projBrowserState.existingProject.name + '」（填写同名可直接进入，或填写新名称另建）')
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
              '<span style="color:var(--placeholder);font-size:13px">›</span>' +
            '</button>';
          }).join('') + (data?.truncated ? '<div style="text-align:center;font-size:11.5px;color:var(--placeholder);padding:4px 0">仅显示前 300 个子目录，可输入路径精确定位</div>' : '');
        }
      }

      renderProjModalSummary();

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
      if ($('proj-name-input')) $('proj-name-input').value = '';
      backdrop.hidden = false;
      resetModalSheetShift();
      syncViewportHeight();
      syncCreateProjectSubmitUi();
      const initialPath = projBrowserState.currentPath || '';
      await loadHostDirListing(initialPath);
    }

    function closeCreateProjectModal() {
      const backdrop = $('proj-modal-backdrop');
      if (backdrop && backdrop.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch {}
      }
      if (backdrop) backdrop.hidden = true;
      resetModalSheetShift();
      syncViewportHeight();
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
      const createStartEpoch = ++clientSyncEpoch;
      const createSelEpochBefore = selectedProjectEpoch;
      const myNavSeq = ++lastNavActionSeq;
      invalidateInflightSnapshotPolls();
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
        const createdName = data.project?.name || projectName;
        const createdId = String(data.project?.id || ex?.id || '').trim();
        const navFailed = (data.navOk === false) || Boolean(data.navResult && data.navResult.ok === false);
        let didSetCreatedSelection = false;
        if (!navFailed && createdId && selectedProjectEpoch === createSelEpochBefore) {
          setUserSelectedProject(createdId, createdName);
          didSetCreatedSelection = true;
        }
        let appliedCreateSnap = false;
        if (data.snapshot && myNavSeq === lastNavActionSeq) {
          appliedCreateSnap = renderSnapshot(data.snapshot, {
            reqStartEpoch: createStartEpoch,
            advanceFloorOnApply: true
          });
          if (appliedCreateSnap) invalidateInflightSnapshotPolls();
        }
        if (!appliedCreateSnap) {
          if (didSetCreatedSelection) {
            syncNewChatButtonUi(latestSnap);
            if (latestSnap) renderConversationList(latestSnap);
          }
          if (!data.snapshot) void fetchSnapshot();
        }
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
        if (myNavSeq === lastNavActionSeq && !snapshotInflight) schedulePoll();
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
    function bindSafeImeEnter(el, onEnter, opts) {
      if (!el || typeof el.addEventListener !== 'function') return;
      let imeComposing = false;
      el.addEventListener('compositionstart', () => { imeComposing = true; });
      el.addEventListener('compositionend', () => { imeComposing = false; });
      el.addEventListener('keydown', (e) => {
        if (imeComposing || e.isComposing || e.keyCode === 229) return;
        if (e.key !== 'Enter') return;
        if (opts?.requireMod && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        onEnter(e);
      });
    }

    $('proj-mkdir-confirm')?.addEventListener('click', () => { void createNewSubdirInModal(); });
    bindSafeImeEnter($('proj-mkdir-input'), () => { void createNewSubdirInModal(); });
    $('proj-path-go')?.addEventListener('click', () => {
      const val = String($('proj-path-input')?.value || '').trim();
      if (val) void loadHostDirListing(val);
    });
    bindSafeImeEnter($('proj-path-input'), () => {
      const val = String($('proj-path-input')?.value || '').trim();
      if (val) void loadHostDirListing(val);
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
    if ($('drawer-nav-bar')) {
      $('drawer-nav-bar').addEventListener('click', (e) => {
        const backBtn = e.target?.closest?.('#btn-drawer-back');
        if (!backBtn) return;
        activeDrawerProject = '';
        renderDrawerProjectsAndConversations(latestSnap, true);
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

      const toggleBtn = e.target?.closest?.('.proj-toggle') || e.target?.closest?.('.proj-head')?.querySelector?.('.proj-toggle');
      if (toggleBtn) {
        const pid = toggleBtn.getAttribute('data-proj-toggle') || '';
        if (!pid) return;
        const wasSelected = getEffectiveSelectedProject(latestSnap).id === pid;
        const clickedChev = Boolean(e.target?.closest?.('.proj-chev'));
        const isEmptyGroup = Boolean(toggleBtn.closest?.('.proj-group')?.classList?.contains('is-empty'));
        const matchedProj = (latestSnap?.projects || []).find((p) => p && p.id === pid);
        setUserSelectedProject(pid, matchedProj?.name || '');
        syncNewChatButtonUi(latestSnap);
        if (!isEmptyGroup) {
          if (collapsedProjMap[pid]) {
            delete collapsedProjMap[pid];
            saveConvUiPrefs();
          } else if (wasSelected || clickedChev || isNonProjectBucket(pid)) {
            collapsedProjMap[pid] = true;
            saveConvUiPrefs();
          }
        }
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

      function applyOptimisticSidebarConvClick(clickedBtn) {
        const convListEl = $('conv-list');
        if (!convListEl || !clickedBtn) return;
        convListEl.querySelectorAll('.conv-item').forEach((el) => {
          if (el !== clickedBtn) el.classList.remove('active');
        });
        clickedBtn.classList.add('active');
        clickedBtn.classList.remove('is-unread');
        const effId = getEffectiveSelectedProject(latestSnap).id;
        convListEl.querySelectorAll('.proj-group').forEach((grp) => {
          const grpPid = grp.querySelector('.proj-toggle')?.getAttribute('data-proj-toggle') || '';
          grp.classList.toggle('is-current', Boolean(effId && grpPid === effId));
        });
        convListEl.dataset.lastHtml = '';
      }

      const projBtn = e.target?.closest?.('.proj-item');
      if (projBtn && projBtn.dataset.projKey) {
        const projKey = projBtn.dataset.projKey;
        activeDrawerProject = projKey;
        renderDrawerProjectsAndConversations(latestSnap, true);
        const groups = normalizeProjectGroups(latestSnap);
        const pickedGrp = groups.find((g) => g.key === projKey);
        if (pickedGrp && pickedGrp.isCollapsed && !pickedGrp.conversations.length) {
          try {
            await apiAction({ action: 'expand-project', groupId: pickedGrp.id, name: pickedGrp.name });
          } catch {}
        }
        return;
      }

      const btn = e.target?.closest?.('.conv-item');
      const cid = btn?.getAttribute('data-cid') || btn?.dataset?.cid || '';
      if (!btn || !cid) return;
      const matchedConv = getMergedConversations(latestSnap).find((x) => x && x.id === cid);
      const mySwitchSelEpoch = matchedConv
        ? setUserSelectedProject(matchedConv.projectId, matchedConv.projectName)
        : selectedProjectEpoch;
      if (matchedConv) {
        syncNewChatButtonUi(latestSnap);
      }
      applyOptimisticSidebarConvClick(btn);
      const prevSessionId = String(latestSnap?.sessionId || '');
      const isSwitchingToOther = Boolean(cid && prevSessionId && prevSessionId !== cid);
      const myNavSeqSnapshot = lastNavActionSeq;
      if (isSwitchingToOther) {
        msgEl.classList.add('is-switching');
        if (matchedConv?.title) $('conv-title').textContent = matchedConv.title;
      }
      if (!isDesktopLayout()) closeDrawer();
      stickBottom = true;
      showToast('正在切换会话…');
      try {
        applySelectedConversation(cid);
        const r = await apiAction({ action: 'switch-conversation', id: cid, isolated: true });
        if (!r?.ok && mySwitchSelEpoch === selectedProjectEpoch) {
          showToast(r?.error || r?.actionResult?.error || '切换会话失败');
          if (latestSnap && lastNavActionSeq === myNavSeqSnapshot + 1) {
            $('conv-title').textContent = latestSnap.title || 'Antigravity';
          }
        }
      } catch (err) {
        if (mySwitchSelEpoch === selectedProjectEpoch) {
          showToast(err?.message || '切换会话失败');
          if (latestSnap && lastNavActionSeq === myNavSeqSnapshot + 1) {
            $('conv-title').textContent = latestSnap.title || 'Antigravity';
          }
        }
      } finally {
        if (lastNavActionSeq === myNavSeqSnapshot + 1) {
          msgEl.classList.remove('is-switching');
        }
      }
    });
    if ($('btn-follow-desktop')) {
      $('btn-follow-desktop').onclick = async () => {
        if (!isDesktopLayout()) closeDrawer();
        stickBottom = true;
        showToast('正在同步桌面端当前会话…');
        try {
          applySelectedConversation('');
          const r = await apiAction({ action: 'switch-conversation', id: 'follow-desktop' });
          if (r?.ok) showToast('已同步桌面当前会话');
          else showToast(r?.error || r?.actionResult?.error || '同步失败');
        } catch (err) {
          showToast(err?.message || '同步失败');
        }
      };
    }
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
      const eff = getEffectiveSelectedProject(latestSnap);
      await startNewConversationInProject(eff.id, eff.name);
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
        const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';
        backdropEl.style.backgroundColor = (isLightTheme ? 'rgba(15,23,42,' : 'rgba(0,0,0,') + ((isLightTheme ? 0.36 : 0.58) * progress).toFixed(3) + ')';
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
      if (sending) {
        btn.disabled = true;
        btn.className = 'send-circle pending';
        btn.innerHTML = '<span class="mini-spin"></span>';
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('aria-label', '正在处理…');
        return;
      }
      btn.removeAttribute?.('aria-busy');
      const hasContent = Boolean(ta.value.trim() || uploadedNames.length);
      if (hasContent) {
        btn.disabled = false;
        btn.className = 'send-circle ready';
        btn.innerHTML = SEND_ARROW_SVG;
        btn.setAttribute('aria-label', '发送消息');
      } else if (latestSnap?.busy) {
        btn.disabled = false;
        btn.className = 'send-circle stop';
        btn.innerHTML = STOP_SQUARE_SVG;
        btn.setAttribute('aria-label', '停止生成');
      } else {
        btn.disabled = true;
        btn.className = 'send-circle';
        btn.innerHTML = SEND_ARROW_SVG;
        btn.setAttribute('aria-label', '发送消息');
      }
    }

    const autoGrow = () => {
      ta.style.height = 'auto';
      const maxH = isDesktopLayout() ? 200 : 148;
      ta.style.height = Math.min(maxH, Math.max(28, ta.scrollHeight)) + 'px';
      saveDraftForConv(selectedConversationId, ta.value || '');
      syncSendButtonUI();
    };
    {
      const initDraft = loadDraftForConv(selectedConversationId);
      if (initDraft) {
        ta.value = initDraft;
        autoGrow();
      }
    }
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
      if (!$('sheet-backdrop').hidden) { closeSheet(); return; }
      if (!$('quota-drawer').hidden || ($('context-drawer') && !$('context-drawer').hidden) || ($('usage-drawer') && !$('usage-drawer').hidden)) {
        openTopDrawer(null);
        return;
      }
      if (!isDesktopLayout() && backdropEl.classList.contains('open')) closeDrawer();
    });

    async function sendInput() {
      if (sending) return;
      const rawText = ta.value.trim();
      if (!rawText && !uploadedNames.length && latestSnap?.busy) {
        sending = true;
        syncSendButtonUI();
        try {
          const r = await apiAction({ action: 'stop' }, { skipAutoRender: true });
          if (r?.ok) showToast('已请求停止生成');
          else showToast(r?.error || r?.actionResult?.error || '停止失败');
          sending = false;
          if (r?.snapshot) renderSnapshot(r.snapshot);
        } catch (err) {
          showToast(err?.message || '停止失败');
        } finally {
          sending = false;
          syncSendButtonUI();
        }
        return;
      }
      const text = rawText || (uploadedNames.length ? '请查看图片' : '');
      if (!text) return;
      sending = true;
      syncSendButtonUI();
      try {
        stickBottom = true;
        const r = await apiAction({ action: 'send', text }, { skipAutoRender: true });
        if (r?.ok) {
          ta.value = '';
          saveDraftForConv(selectedConversationId, '');
          uploadedNames = [];
          $('attach-hint').hidden = true;
          ta.style.height = 'auto';
          const maxH = isDesktopLayout() ? 180 : 112;
          ta.style.height = Math.min(maxH, Math.max(28, ta.scrollHeight)) + 'px';
        } else {
          showToast(r?.error || r?.actionResult?.error || '发送失败');
        }
        sending = false;
        if (r?.snapshot) renderSnapshot(r.snapshot);
      } catch (err) {
        showToast(err?.message || '发送失败');
      } finally {
        sending = false;
        syncSendButtonUI();
      }
    }
    bindButtonClick($('btn-send'), sendInput);
    syncSendButtonUI();
    bindSafeImeEnter(ta, () => { void sendInput(); }, { requireMod: true });

    renderModeEntryGate(
      isManualEntry
        ? ('正在通过 ' + getActiveChannelLabel() + ' 连接 Mac…')
        : '正在自动测试并切换至最快通道，也可直接点击下方方式进入：'
    );
    if (isAutoSwitched) {
      const curKind = detectKindFromOrigin(location.origin);
      const curMs = speedTestState.results?.[curKind]?.ms;
      showToast('⚡ 已自动切换至最快路线：' + getActiveChannelLabel() + (Number.isFinite(curMs) ? ' (' + curMs + ' ms)' : ''));
      if (location.protocol !== 'https:') {
        const missingAny = getEnabledModeEntries().some((ep) => {
          const sr = speedTestState.results?.[ep.kind];
          return !sr || sr.via === 'server' || sr.reason === 'https_restricted';
        });
        if (missingAny) void runSpeedTest({ autoSwitch: false, silent: true });
      }
    } else if (!manualLocked && getEnabledModeEntries().length > 1) {
      autoSwitchChecked = true;
      void runSpeedTest({ autoSwitch: true, silent: true });
    } else if (speedTestState.testedAt === 0) {
      void runSpeedTest({ autoSwitch: false, silent: true });
    }
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
    if (u.protocol === 'https:' && cleanHost.endsWith('.trycloudflare.com')) return true;
    if (cleanHost === 'localhost' || cleanHost.endsWith('.local') || cleanHost.endsWith('.ts.net')) return true;
    return isAllowedPrivateAddress(cleanHost);
  } catch {
    return false;
  }
}

// ==================== Cloudflare Tunnel 管理 (免登录 Quick Tunnel + 自有账号 Named Tunnel) ====================

function getCloudflaredInstallGuide(platform = process.platform) {
  const commands = {
    darwin: 'brew install cloudflared',
    win32: 'winget install --id Cloudflare.cloudflared',
    linux: 'mkdir -p ~/.local/bin && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared'
  };
  const key = commands[platform] ? platform : 'linux';
  return {
    platform: key,
    command: commands[key],
    commands
  };
}

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
      const installGuide = getCloudflaredInstallGuide();
      state = 'error';
      publicUrl = '';
      errorMsg = `未检测到 cloudflared（可执行 ${installGuide.command} 安装）`;
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
      if (!touchesTunnel && !tunnelConfigChanged) {
        return getStatus();
      }
      await stop();
      return await start(nextCfg);
    }
  };
}

function acceptsGzipEncoding(rawHeader) {
  if (Array.isArray(rawHeader)) rawHeader = rawHeader.join(',');
  const raw = String(rawHeader || '').trim().toLowerCase();
  if (!raw) return false;
  let gzipQ = null;
  let starQ = null;
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(';').map((s) => s.trim()).filter(Boolean);
    const coding = parts[0];
    let q = 1;
    for (let i = 1; i < parts.length; i++) {
      const eqIdx = parts[i].indexOf('=');
      if (eqIdx < 0) continue;
      const k = parts[i].slice(0, eqIdx).trim();
      const v = parts[i].slice(eqIdx + 1).trim();
      if (k === 'q') {
        q = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(v) ? Number(v) : 0;
      }
    }
    if (coding === 'gzip' || coding === 'x-gzip') {
      gzipQ = gzipQ === null ? q : Math.min(gzipQ, q);
    } else if (coding === '*') {
      starQ = starQ === null ? q : Math.min(starQ, q);
    }
  }
  if (gzipQ !== null) return gzipQ > 0;
  return starQ !== null && starQ > 0;
}

const PROBE_HINT_CACHE_TTL_MS = 3000;
const LAN_RECENT_SEEN_TTL_MS = 12000;
const probeHintCache = new Map();
let cachedTailscaleBin = '';

function execFileAsync(bin, args, timeoutMs = 1000) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, {
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      });
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' });
    }
  });
}

function parseTailscalePingOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const m = rawLine.match(/pong\s+from\s+.*?\(([^)\s]+)\)\s+via\s+(\S+)\s+in\s+(?:<\s*)?([0-9.]+)(ms|s)/i);
    if (!m) continue;
    const peerIp = String(m[1] || '').trim();
    const viaRaw = String(m[2] || '').trim();
    const val = Number(m[3]);
    const unit = String(m[4] || 'ms').toLowerCase();
    const rawMs = unit === 's' ? val * 1000 : val;
    const ms = Number.isFinite(rawMs) ? Math.max(1, Math.round(rawMs)) : 1;
    const isDerp = /^DERP\b/i.test(viaRaw);
    let viaIp = '';
    if (!isDerp) {
      const bracketMatch = viaRaw.match(/^\[([^\]]+)\]:\d+$/);
      viaIp = bracketMatch ? bracketMatch[1] : viaRaw.replace(/:\d+$/, '');
    }
    return {
      ok: true,
      peerIp,
      viaRaw,
      viaIp,
      viaLanIp: (!isDerp && isRfc1918Ipv4(viaIp)) ? viaIp : '',
      isDerp,
      ms
    };
  }
  return { ok: false, peerIp: '', viaRaw: '', viaIp: '', viaLanIp: '', isDerp: false, ms: null };
}

async function pingLanIpRtt(ip, execFn = execFileAsync, netsMap = os.networkInterfaces()) {
  if (!isRfc1918Ipv4(ip)) return null;
  if (getLocalHostIpSet(netsMap).has(ip)) return null;
  let args;
  let timeoutMs = 850;
  if (process.platform === 'win32') {
    args = ['-n', '1', '-w', '350', ip];
    timeoutMs = 700;
  } else if (process.platform === 'linux') {
    args = ['-n', '-c', '2', '-i', '0.15', '-W', '1', ip];
    timeoutMs = 1200;
  } else {
    args = ['-n', '-c', '2', '-i', '0.1', '-W', '300', ip];
    timeoutMs = 850;
  }
  const res = await execFn('ping', args, timeoutMs);
  const out = `${res.stdout}\n${res.stderr}`;
  const statsMatch = out.match(/(?:round-trip|rtt)\s+[^=]*=\s*([0-9.]+)\//i);
  if (statsMatch) {
    const ms = Number(statsMatch[1]);
    if (Number.isFinite(ms)) return { ok: true, ms: Math.max(1, Math.round(ms)) };
  }
  const times = [];
  for (const m of out.matchAll(/time[=<]\s*([0-9.]+)\s*ms/ig)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) times.push(v);
  }
  if (times.length) {
    return { ok: true, ms: Math.max(1, Math.round(Math.min(...times))) };
  }
  return null;
}

async function probeClientPrivateReachability(req, config, opts = {}) {
  const {
    force = false,
    now = Date.now(),
    networkInterfaces: customNets,
    execAsync: customExec,
    skipProbes = process.env.AG_REMOTE_SKIP_PROBES === '1'
  } = opts || {};
  if (skipProbes) return {};
  const netsMap = typeof customNets === 'function' ? customNets() : (customNets || os.networkInterfaces());
  const execFn = typeof customExec === 'function' ? customExec : execFileAsync;
  const localHostIps = getLocalHostIpSet(netsMap);

  const headers = req?.headers || {};
  let urlParams = null;
  if (typeof req?.url === 'string' && req.url.includes('?')) {
    try { urlParams = new URL(req.url, 'http://localhost').searchParams; } catch {}
  }
  const rawDevId = String(headers['x-ag-device-id'] || urlParams?.get('did') || '').trim().slice(0, 64);
  const headerDevId = /^[A-Za-z0-9._:-]{4,64}$/.test(rawDevId) ? rawDevId : '';
  const rawFp = String(headers['x-ag-device-fp'] || urlParams?.get('fp') || '').trim().slice(0, 64);
  const deviceFp = /^[A-Za-z0-9._x@-]{4,64}$/.test(rawFp) ? rawFp : '';
  const deviceHint = String(headers['x-ag-device-hint'] || urlParams?.get('hint') || '').trim().slice(0, 24);
  const ua = String(headers['user-agent'] || '').trim();
  const label = parseDeviceLabel(ua, deviceHint);
  const cacheKey = headerDevId || deviceFp || ua || 'anon';

  if (!force) {
    const cached = probeHintCache.get(cacheKey);
    if (cached && (now - cached.at) < PROBE_HINT_CACHE_TTL_MS) {
      return cached.hints;
    }
  }

  let rec = headerDevId ? (pairedDevicesMap.get(headerDevId) || null) : null;
  if (!rec) {
    let bestSeen = -1;
    for (const v of pairedDevicesMap.values()) {
      if (!v || v.label !== label) continue;
      if (ua && v.ua && v.ua !== ua) continue;
      if (deviceFp && v.fp && v.fp !== deviceFp) continue;
      if ((v.lastSeenAt || 0) > bestSeen) {
        bestSeen = v.lastSeenAt || 0;
        rec = v;
      }
    }
  }

  const en = config?.enabledChannels || {
    lan: true,
    tailscale: true,
    bonjour: true,
    tunnel: Boolean(config?.tunnelEnabled)
  };
  const rawKnownLanIp = rec?.lastLanIp || '';
  const lanSeenRecently = (now - (rec?.lastLanSeenAt || 0)) <= LAN_RECENT_SEEN_TTL_MS;
  const knownLanIp = (rawKnownLanIp && lanSeenRecently && !localHostIps.has(rawKnownLanIp) && isIpInLocalPhysicalLanSubnet(rawKnownLanIp, netsMap))
    ? rawKnownLanIp
    : '';
  const rawKnownTsIp = rec?.lastTailscaleIp || '';
  const knownTsIp = (rawKnownTsIp && !localHostIps.has(rawKnownTsIp)) ? rawKnownTsIp : '';

  const labelToOs = {
    iPhone: 'ios',
    iPad: 'ios',
    Android: 'android',
    Mac: 'macos',
    Windows: 'windows'
  };
  const targetOs = labelToOs[label] || '';

  const runTsProbe = async () => {
    if (!en.tailscale && !en.lan) return { statusAvailable: false, pong: null };
    const candidates = cachedTailscaleBin
      ? [cachedTailscaleBin]
      : (process.platform === 'darwin'
          ? ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
          : ['tailscale']);
    let workingBin = '';
    let parsedStatus = null;
    for (const bin of candidates) {
      if (bin.startsWith('/') && !customExec && !fs.existsSync(bin)) continue;
      const stRes = await execFn(bin, ['status', '--json'], 800);
      if (stRes.stdout && stRes.stdout.trim().startsWith('{')) {
        try {
          parsedStatus = JSON.parse(stRes.stdout);
          workingBin = bin;
          if (!customExec) cachedTailscaleBin = bin;
          break;
        } catch {}
      }
    }
    if (!workingBin || !parsedStatus || typeof parsedStatus !== 'object') {
      return { statusAvailable: false, pong: null };
    }

    const probeIps = [];
    if (knownTsIp && isTailscaleCgnatIpv4(knownTsIp)) {
      probeIps.push(knownTsIp);
    } else if (targetOs === 'ios' || targetOs === 'android') {
      const mobilePeers = [];
      for (const p of Object.values(parsedStatus.Peer || {})) {
        if (!p || !p.Online) continue;
        if (String(p.OS || '').toLowerCase() !== targetOs) continue;
        const ip4 = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.find((ip) => isTailscaleCgnatIpv4(String(ip))) : '';
        if (ip4 && !localHostIps.has(String(ip4))) mobilePeers.push(String(ip4));
      }
      if (mobilePeers.length === 1) {
        probeIps.push(mobilePeers[0]);
      }
    }
    if (!probeIps.length) return { statusAvailable: true, pong: null };

    const pongs = await Promise.all(probeIps.map(async (ip) => {
      const pr = await execFn(workingBin, ['ping', '--c', '1', '--timeout', '1s', ip], 1250);
      return parseTailscalePingOutput(`${pr.stdout}\n${pr.stderr}`);
    }));
    const validPongs = pongs.filter((p) => p && p.ok && Number.isFinite(p.ms));
    validPongs.sort((a, b) => a.ms - b.ms);
    return { statusAvailable: true, pong: validPongs[0] || null };
  };

  const [tsRes, initialLanPing] = await Promise.all([
    runTsProbe(),
    (en.lan && knownLanIp) ? pingLanIpRtt(knownLanIp, execFn, netsMap) : Promise.resolve(null)
  ]);

  let lanPing = initialLanPing;
  const tsPong = tsRes?.pong || null;
  if (!lanPing?.ok && en.lan && tsPong?.ok && !tsPong.isDerp && tsPong.viaLanIp && !localHostIps.has(tsPong.viaLanIp) && isIpInLocalPhysicalLanSubnet(tsPong.viaLanIp, netsMap)) {
    lanPing = { ok: true, ms: Math.max(2, tsPong.ms) };
    if (rec) {
      rec.lastLanIp = tsPong.viaLanIp;
      rec.lastLanSeenAt = now;
    }
  }
  if (tsPong?.ok && rec && isTailscaleCgnatIpv4(tsPong.peerIp) && !localHostIps.has(tsPong.peerIp)) {
    rec.lastTailscaleIp = tsPong.peerIp;
    rec.lastTailscaleSeenAt = now;
  }

  const hints = {};
  if (en.tailscale) {
    if (tsPong?.ok) {
      hints.tailscale = { ok: true, ms: tsPong.ms, via: 'server' };
    } else if (tsRes?.statusAvailable) {
      hints.tailscale = { ok: false, ms: null, reason: 'unreachable', via: 'server' };
    }
  }
  if (lanPing?.ok) {
    if (en.lan) {
      hints.lan = { ok: true, ms: lanPing.ms, via: 'server' };
    }
    if (en.bonjour && detectHostIdentityMeta().bonjourHost) {
      hints.bonjour = { ok: true, ms: lanPing.ms + 5, via: 'server' };
    }
  } else if (tsPong?.ok && !tsPong.viaLanIp) {
    if (en.lan) hints.lan = { ok: false, ms: null, reason: 'unreachable', via: 'server' };
    if (en.bonjour) hints.bonjour = { ok: false, ms: null, reason: 'unreachable', via: 'server' };
  }

  if (probeHintCache.size > 64) probeHintCache.clear();
  probeHintCache.set(cacheKey, { at: now, hints });
  return hints;
}

function extractCompactUsageSummary(usagePayload) {
  if (!usagePayload || typeof usagePayload !== 'object') return null;
  const sum = usagePayload.summary || {};
  return {
    totalTokens: Number(sum.grandTotalTokens ?? sum.totalTokens ?? 0) || 0,
    todayTokens: Number(sum.todayTokens ?? 0) || 0,
    monthTokens: Number(sum.monthTokens ?? 0) || 0,
    yearTokens: Number(sum.yearTokens ?? 0) || 0,
    planName: String(usagePayload.planStatus?.tierName || '').trim()
  };
}

function createRemoteHttpHandler(initialConfig, options = {}) {
  const getTunnelOrigin = typeof options.getTunnelOrigin === 'function' ? options.getTunnelOrigin : () => '';
  const fetchSnapshot = typeof options.fetchSnapshot === 'function' ? options.fetchSnapshot : fetchSnapshotFromTarget;
  const performAction = typeof options.performAction === 'function' ? options.performAction : performActionInTarget;
  const getUsageData = typeof options.getUsageData === 'function'
    ? options.getUsageData
    : async (opts = {}) => {
        const { collectTokenHistoryAsync } = require('./meter-collector');
        return await collectTokenHistoryAsync(opts);
      };
  let activeConfig = initialConfig;
  let lastMtimeMs = 0;
  let cachedUsageData = null;
  let cachedUsageAt = 0;
  try {
    lastMtimeMs = fs.statSync(getRemoteConfigPath()).mtimeMs;
  } catch {}

  const getCachedUsageSummary = async () => {
    const now = Date.now();
    if (cachedUsageData && (now - cachedUsageAt) < 15000) {
      return extractCompactUsageSummary(cachedUsageData);
    }
    if (typeof options.getUsageData !== 'function' && typeof options.fetchSnapshot === 'function') {
      return null;
    }
    try {
      const data = await Promise.race([
        getUsageData({ force: false }),
        new Promise((resolve) => setTimeout(() => resolve(null), 500))
      ]);
      if (data && typeof data === 'object') {
        cachedUsageData = data;
        cachedUsageAt = Date.now();
        return extractCompactUsageSummary(data);
      }
    } catch {}
    return cachedUsageData ? extractCompactUsageSummary(cachedUsageData) : null;
  };

  const enrichSnapshotPayload = (snap, config, activeTunnelUrl, clientId = '', fallbackUsageSummary = null) => {
    if (!snap || snap.ok === false) return snap;
    const snapInfo = collectFusedEndpointDescriptor(config.port, activeTunnelUrl ? {
      enabled: Boolean(config.tunnelEnabled),
      state: 'running',
      publicUrl: activeTunnelUrl,
      mode: config.tunnelMode
    } : null, config.enabledChannels);
    const activeConvId = snap.activeConversationId || snap.sessionId || '';
    const out = {
      ...snap,
      activeConversationId: activeConvId,
      hosts: snapInfo.hosts,
      endpoints: snapInfo.endpoints,
      enabledChannels: config.enabledChannels,
      displayConfig: sanitizeRemoteDisplayConfig(config.remoteDisplay)
    };
    if (clientId) out.clientId = clientId;
    if (!out.usageSummary && fallbackUsageSummary) {
      out.usageSummary = fallbackUsageSummary;
    }
    return out;
  };

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
  const cachedHtmlGzip = zlib.gzipSync(Buffer.from(cachedHtml, 'utf8'), { level: 1 });
  const cachedIcon = buildMobileIconSvg();
  const cachedManifest = buildManifestJson();
  const cachedSw = buildServiceWorkerJs();
  const cached401 = buildUnauthorizedHtml();

  function sendPayload(req, res, statusCode, headers, bodyStr) {
    const raw = typeof bodyStr === 'string' ? bodyStr : String(bodyStr || '');
    if (acceptsGzipEncoding(req?.headers?.['accept-encoding']) && Buffer.byteLength(raw, 'utf8') >= 1024) {
      const gz = raw === cachedHtml ? cachedHtmlGzip : zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 1 });
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(gz);
      return;
    }
    res.writeHead(statusCode, headers);
    res.end(raw);
  }

  return async (req, res) => {
    const config = getActiveConfig();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const HTML_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self' http: https:; base-uri 'none'; frame-ancestors 'none'";
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AG-Remote-Token, X-AG-Device-Id, X-AG-Client-Id, X-AG-Device-Hint, X-AG-Device-Fp, X-AG-Probe');
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
    if (req.method === 'GET' && pathname === '/api/ping.gif') {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': String(PING_GIF_BUFFER.length),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Timing-Allow-Origin': '*'
      });
      res.end(PING_GIF_BUFFER);
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

    // Same-Site 跨端口 CSRF 加固：所有写请求强制要求 application/json，并严格校验同源（协议+主机+有效端口）Origin 或自定义 X-AG-Remote-Token 请求头
    const reqMethodUpper = String(req.method || 'GET').toUpperCase();
    if (reqMethodUpper !== 'GET' && reqMethodUpper !== 'HEAD' && reqMethodUpper !== 'OPTIONS') {
      const rawCt = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (rawCt !== 'application/json') {
        res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: '写接口仅接受 Content-Type: application/json 请求' }));
        return;
      }
      const headerToken = String(req.headers['x-ag-remote-token'] || '').trim();
      const hasValidCustomHeader = Boolean(headerToken && timingSafeTokenMatch(headerToken, config.token));
      const reqProto = (isHttpsForwarded || Boolean(req.socket?.encrypted)) ? 'https:' : 'http:';
      const reqHostHeader = String(req.headers.host || '').trim();
      const parseOriginTuple = (rawUrl) => {
        if (!rawUrl || String(rawUrl).toLowerCase() === 'null') return null;
        try {
          const u = new URL(rawUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
          const effPort = u.port || (u.protocol === 'https:' ? '443' : '80');
          return { protocol: u.protocol, hostname: u.hostname.toLowerCase(), port: effPort };
        } catch {
          return null;
        }
      };
      const reqTuple = reqHostHeader ? parseOriginTuple(`${reqProto}//${reqHostHeader}`) : null;
      const isSameOriginTuple = (t) => Boolean(
        t && reqTuple && t.protocol === reqTuple.protocol && t.hostname === reqTuple.hostname && t.port === reqTuple.port
      );
      const rawOrigin = String(req.headers.origin || '').trim();
      const rawReferer = String(req.headers.referer || '').trim();
      let sameOriginByOrigin = false;
      if (rawOrigin) {
        const originTuple = parseOriginTuple(rawOrigin);
        if (!isSameOriginTuple(originTuple)) {
          if (!hasValidCustomHeader) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: '检测到跨协议/跨源或跨端口写请求，已拦截 (CSRF)' }));
            return;
          }
        } else {
          sameOriginByOrigin = true;
        }
      } else if (rawReferer) {
        const refTuple = parseOriginTuple(rawReferer);
        if (!isSameOriginTuple(refTuple) && !hasValidCustomHeader) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: '检测到跨协议/跨源 Referer 写请求，已拦截 (CSRF)' }));
          return;
        }
      }
      // 仅凭 Cookie 鉴权的写请求必须提供严格同源 Origin（或有效自定义 X-AG-Remote-Token），禁止仅凭 Referer 放行
      if (fromCookie && !hasValidCustomHeader && !sameOriginByOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'Cookie 鉴权写请求须提供同源 Origin 或 X-AG-Remote-Token 请求头' }));
        return;
      }
    }

    const secureAttr = isHttpsForwarded ? '; Secure' : '';
    const cookiesToSet = [];
    if (fromQuery) {
      cookiesToSet.push(`ag_remote_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=31536000`);
    }

    const isProbeReq = urlObj.searchParams.get('probe') === '1' || String(req.headers['x-ag-probe'] || '').trim() === '1';
    if (!isProbeReq && (pathname === '/' || pathname === '/api/ping' || pathname === '/api/snapshot' || pathname === '/api/action')) {
      recordPairedDeviceAccess(req, config.token, Date.now(), activeTunnelUrl);
    }

    if (req.method === 'GET' && pathname === '/') {
      if (uiVersion !== MOBILE_UI_VERSION) {
        cookiesToSet.push(`ag_ui_ver=${MOBILE_UI_VERSION}; Path=/; SameSite=Lax${secureAttr}; Max-Age=31536000`);
      }
      if (cookiesToSet.length) res.setHeader('Set-Cookie', cookiesToSet);
      sendPayload(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_CSP }, cachedHtml);
      return;
    }

    if (cookiesToSet.length) {
      res.setHeader('Set-Cookie', cookiesToSet);
    }

    if (req.method === 'GET' && pathname === '/api/ping') {
      const probeNonce = String(urlObj.searchParams.get('_n') || '').trim().slice(0, 40);
      const snapInfo = collectFusedEndpointDescriptor(config.port, activeTunnelUrl ? {
        enabled: Boolean(config.tunnelEnabled),
        state: 'running',
        publicUrl: activeTunnelUrl,
        mode: config.tunnelMode
      } : null, config.enabledChannels);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        service: 'ag-mobile-remote',
        nonce: probeNonce,
        port: config.port,
        name: snapInfo.deviceName,
        hosts: snapInfo.hosts,
        endpoints: snapInfo.endpoints,
        enabledChannels: config.enabledChannels,
        displayConfig: sanitizeRemoteDisplayConfig(config.remoteDisplay)
      }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/probe-hints') {
      try {
        const forceProbe = urlObj.searchParams.get('force') === '1';
        const hints = await probeClientPrivateReachability(req, config, { force: forceProbe });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, hints }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, hints: {}, error: err?.message || '' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/usage') {
      try {
        const force = urlObj.searchParams.get('force') === '1';
        const data = await getUsageData({ force });
        if (data && typeof data === 'object') {
          cachedUsageData = data;
          cachedUsageAt = Date.now();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, data: data || null }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取本机用量失败' }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/context') {
      try {
        const clientId = extractRequestClientId(req, urlObj);
        const session = clientId ? getOrCreateClientSession(clientId, config.token) : null;
        const targetId = urlObj.searchParams.get('targetId') || session?.targetId || '';
        const convId = (urlObj.searchParams.get('conversationId') || session?.conversationId || '').trim();
        const snap = await fetchSnapshot(targetId, { conversationId: convId, clientId });
        if (!snap || snap.ok === false) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: snap?.error || '读取上下文窗口失败' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          clientId,
          conversationId: snap.activeConversationId || snap.sessionId || convId,
          title: snap.title || '',
          model: snap.model || '',
          contextBadge: snap.contextBadge || '',
          pulseText: snap.pulseText || '',
          contextPanel: snap.contextPanel || null
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取上下文窗口失败' }));
      }
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
        const clientId = extractRequestClientId(req, urlObj);
        const session = clientId ? getOrCreateClientSession(clientId, config.token) : null;
        const hasExplicitTarget = urlObj.searchParams.has('targetId');
        const hasExplicitConv = urlObj.searchParams.has('conversationId');
        const targetId = hasExplicitTarget
          ? (urlObj.searchParams.get('targetId') || '')
          : (session?.targetId || '');
        const reqConvId = hasExplicitConv
          ? (urlObj.searchParams.get('conversationId') || '').trim()
          : (session?.conversationId || '');
        if (session) {
          if (hasExplicitTarget) session.targetId = targetId;
          if (hasExplicitConv) session.conversationId = reqConvId;
        }
        const rawLimit = urlObj.searchParams.get('convLimit');
        const convLimit = rawLimit === 'all' || rawLimit === '0'
          ? 0
          : (rawLimit !== null && rawLimit !== '' ? Math.max(1, Number.parseInt(rawLimit, 10) || 100) : 100);
        const rawMsgLimit = urlObj.searchParams.get('msgLimit');
        const msgLimit = rawMsgLimit === 'all' || rawMsgLimit === '0'
          ? 0
          : (rawMsgLimit !== null && rawMsgLimit !== '' ? Math.max(1, Number.parseInt(rawMsgLimit, 10) || 30) : 30);
        const snap = await fetchSnapshot(targetId, { conversationId: reqConvId, clientId, convLimit, msgLimit });
        if (session && snap && snap.ok !== false) {
          if (!session.targetId && snap.currentTargetId) session.targetId = snap.currentTargetId;
          if (!session.conversationId && (snap.activeConversationId || snap.sessionId)) {
            session.conversationId = String(snap.activeConversationId || snap.sessionId || '');
          }
        }
        const usageSummary = (snap && snap.ok !== false && !snap.usageSummary)
          ? await getCachedUsageSummary()
          : null;
        const payloadOut = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
        sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(payloadOut));
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
        sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(page));
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
        sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(page));
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
          ...(Array.isArray(options.allowedRoots) ? { allowedRoots: options.allowedRoots } : {}),
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
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(Array.isArray(options.allowedRoots) ? { allowedRoots: options.allowedRoots } : {})
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
        const clientId = extractRequestClientId(req, urlObj, payload);
        const session = clientId ? getOrCreateClientSession(clientId, config.token) : null;
        const createdRes = await createRemoteProject(payload, {
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(Array.isArray(options.allowedRoots) ? { allowedRoots: options.allowedRoots } : {}),
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
            targetId: payload?.targetId || '',
            clientId,
            conversationId: ''
          }).catch((err) => ({ ok: false, error: err?.message || '未能切换桌面端至新建项目' }));
          if (!checkNavOk(actionRes) && !createdRes.alreadyExists && !options.performAction) {
            await new Promise((r) => setTimeout(r, 350));
            actionRes = await doPerformAction({
              action: 'new-conversation',
              projectId: createdRes.project.id,
              targetId: payload?.targetId || '',
              clientId,
              conversationId: ''
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
          snapshot = actionRes?.snapshot || await doFetchSnapshot(payload?.targetId || '', { convLimit: 100, msgLimit: 30, bypassCache: true, clientId }).catch(() => null);
          if (navOk && session) {
            session.conversationId = String(snapshot?.activeConversationId || snapshot?.sessionId || '__new__');
            if (snapshot?.currentTargetId) session.targetId = snapshot.currentTargetId;
          }
          if (snapshot && snapshot.ok !== false) {
            const usageSummary = !snapshot.usageSummary ? await getCachedUsageSummary() : null;
            snapshot = enrichSnapshotPayload(snapshot, config, activeTunnelUrl, clientId, usageSummary);
          }
        }
        sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({
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
        const clientId = extractRequestClientId(req, urlObj, payload);
        const session = clientId ? getOrCreateClientSession(clientId, config.token) : null;
        const effectiveTargetId = String(payload?.targetId || session?.targetId || '').trim();
        const actionName = String(payload?.action || '').trim();

        if (actionName === 'switch-conversation' && (clientId || payload?.isolated === true)) {
          const nextId = String(payload?.id || '').trim();
          if (!nextId) {
            sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({ ok: false, error: '缺少会话 ID' }));
            return;
          }
          if (nextId === 'follow-desktop') {
            if (session) session.conversationId = '';
            const snap = await fetchSnapshot(effectiveTargetId, { clientId, convLimit: 100, msgLimit: 30 });
            if (session && snap && snap.ok !== false && (snap.activeConversationId || snap.sessionId)) {
              session.conversationId = String(snap.activeConversationId || snap.sessionId || '');
            }
            const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
            const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
            sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({
              ok: Boolean(snap && snap.ok !== false),
              actionResult: { ok: Boolean(snap && snap.ok !== false), id: enriched?.sessionId || '', isolated: false },
              snapshot: enriched
            }));
            return;
          }
          if (nextId !== 'new') {
            if (session) {
              session.conversationId = nextId;
              if (payload?.targetId) session.targetId = effectiveTargetId;
            }
            if (!options.fetchSnapshot && typeof defaultHistoryManager?.warmSession === 'function') {
              defaultHistoryManager.warmSession(nextId).catch(() => null);
            }
            const snap = await fetchSnapshot(effectiveTargetId, {
              conversationId: nextId,
              clientId,
              convLimit: 100,
              msgLimit: 30,
              bypassCatalogCache: true
            });
            const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
            const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
            sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({
              ok: Boolean(snap && snap.ok !== false),
              actionResult: { ok: Boolean(snap && snap.ok !== false), id: nextId, isolated: true },
              snapshot: enriched
            }));
            return;
          }
          const newResult = await performAction({
            ...payload,
            clientId,
            targetId: effectiveTargetId || undefined,
            conversationId: '',
            restoreDesktop: false
          });
          if (session) {
            session.conversationId = String(newResult?.snapshot?.activeConversationId || newResult?.snapshot?.sessionId || '__new__');
          }
          if (newResult?.snapshot) {
            const usageSummary = !newResult.snapshot.usageSummary ? await getCachedUsageSummary() : null;
            newResult.snapshot = enrichSnapshotPayload(newResult.snapshot, config, activeTunnelUrl, clientId, usageSummary);
          }
          sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(newResult));
          return;
        }

        if (actionName === 'new-conversation') {
          const newResult = await performAction({
            ...payload,
            clientId,
            targetId: effectiveTargetId || undefined,
            conversationId: '',
            restoreDesktop: false
          });
          if (session && newResult?.ok !== false) {
            session.conversationId = String(newResult?.snapshot?.activeConversationId || newResult?.snapshot?.sessionId || '__new__');
            if (newResult?.snapshot?.currentTargetId) session.targetId = newResult.snapshot.currentTargetId;
          }
          if (newResult?.snapshot) {
            const usageSummary = !newResult.snapshot.usageSummary ? await getCachedUsageSummary() : null;
            newResult.snapshot = enrichSnapshotPayload(newResult.snapshot, config, activeTunnelUrl, clientId, usageSummary);
          }
          sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(newResult));
          return;
        }

        if (actionName === 'switch-window') {
          const nextTargetId = String(payload?.targetId || '').trim();
          if (session) {
            session.targetId = nextTargetId;
            session.conversationId = '';
          }
          const snap = await fetchSnapshot(nextTargetId, { clientId, convLimit: 100, msgLimit: 30 });
          if (session && snap && snap.ok !== false && (snap.activeConversationId || snap.sessionId)) {
            session.conversationId = String(snap.activeConversationId || snap.sessionId || '');
          }
          const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
          const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
          sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify({
            ok: Boolean(snap && snap.ok !== false),
            actionResult: { ok: Boolean(snap && snap.ok !== false), targetId: enriched?.currentTargetId || nextTargetId },
            snapshot: enriched
          }));
          return;
        }

        const effectiveConvId = String(payload?.conversationId || session?.conversationId || '').trim();
        const result = await performAction({
          ...payload,
          clientId,
          targetId: effectiveTargetId || undefined,
          conversationId: effectiveConvId || undefined
        });
        if (session && result?.snapshot && result.snapshot.ok !== false) {
          const respSid = String(result.snapshot.activeConversationId || result.snapshot.sessionId || '');
          if (respSid && respSid !== '__new__' && (effectiveConvId === '__new__' || !session.conversationId)) {
            session.conversationId = respSid;
          }
        }
        if (result?.snapshot) {
          const usageSummary = !result.snapshot.usageSummary ? await getCachedUsageSummary() : null;
          result.snapshot = enrichSnapshotPayload(result.snapshot, config, activeTunnelUrl, clientId, usageSummary);
        }
        sendPayload(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(result));
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
    remoteClientSessions.clear();
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
  const cloudflaredInstall = getCloudflaredInstallGuide();
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
    installCommand: cloudflaredInstall.command,
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
    remoteDisplay: sanitizeRemoteDisplayConfig(cfg.remoteDisplay),
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
      binaryAvailable: Boolean(effTunnel.binaryAvailable),
      installCommand: cloudflaredInstall.command
    },
    cloudflaredInstall,
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
  getCloudflaredInstallGuide,
  resolveCloudflaredBinary,
  createCloudflareTunnelController,
  isAllowedPrivateAddress,
  isAllowedPrivateOrigin,
  detectRequestChannel,
  parseTailscalePingOutput,
  getLocalHostIpSet,
  isIpInLocalPhysicalLanSubnet,
  probeClientPrivateReachability,
  clearPairedDevicesForTests: () => {
    pairedDevicesMap.clear();
    remoteClientSessions.clear();
    probeHintCache.clear();
  },
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  sanitizeRemoteDisplayConfig,
  getRemoteClientSession,
  clearRemoteClientSessionsForTests,
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
  createConversationHistoryManager,
  enrichSnapshotWithCatalog,
  listCatalogConversations,
  getConversationMessagesPage,
  warmConversationSession,
  isSensitiveHostPath,
  resolveAllowedHostRoots,
  assertSafeHostDirectoryPath,
  listHostDirectories,
  createHostSubdirectory,
  createRemoteProject,
  evalInCdpTarget,
  evalInPickedTarget,
  performActionInTarget,
  acceptsGzipEncoding,
  readJsonBody,
  createRemoteHttpHandler,
  recordPairedDeviceAccess,
  getPairedDevicesSummary,
  startMobileRemoteServer,
  buildRemoteInfo,
  printRemoteCli
};

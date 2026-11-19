#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { getStateDir, resolveActiveCdpTarget } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');
const { detectProxyConfig } = require('./meter-proxy');

const DEFAULT_REMOTE_PORT = 18765;
const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const CONFIG_FILE_NAME = 'remote-config.json';
const TUNNEL_STATE_FILE_NAME = '.cloudflared-tunnel-state.json';
const MOBILE_UI_VERSION = '2.0.0';
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

async function fetchSnapshotFromTarget(requestedTargetId, opts = {}) {
  const { target, windows } = await pickCdpTarget(requestedTargetId);
  const serializedOpts = JSON.stringify({
    conversationId: String(opts?.conversationId || '').trim(),
    clientId: String(opts?.clientId || '').trim()
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
  const snap = await evalInTarget(target, expr, 7000);
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
  return await enqueueRemoteAction(async () => {
    const { target } = await pickCdpTarget(payload?.targetId);
    const serialized = JSON.stringify(payload || {});
    const expr = `(async () => {
      const fn = window.__AGEnhancer?.performMobileAction;
      if (typeof fn !== 'function') {
        return { ok: false, error: '当前窗口尚未注入 v1.6.0 控制接口' };
      }
      return await fn(${serialized});
    })()`;
    const actionResult = await evalInTarget(target, expr, 8000);
    const settleMs = payload?.action === 'switch-conversation' ? 250 : 120;
    await new Promise((r) => setTimeout(r, settleMs));
    const snapConvId = payload?.action === 'switch-conversation'
      ? (payload?.id && payload.id !== 'new' ? String(payload.id) : '')
      : (payload?.conversationId ? String(payload.conversationId) : '');
    const snapshot = await fetchSnapshotFromTarget(target.id, {
      conversationId: snapConvId,
      clientId: payload?.clientId ? String(payload.clientId) : ''
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
      --app-h:100dvh;
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
      flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
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
      width:100%;min-height:28px;max-height:112px;resize:none;border:none;background:transparent;
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
      position:fixed;top:0;left:0;right:0;height:var(--app-h,100vh);z-index:75;background:var(--backdrop-bg);display:flex;align-items:flex-end;justify-content:center;
    }
    .sheet-backdrop[hidden]{display:none}
    .sheet{
      width:100%;max-width:520px;max-height:72dvh;background:var(--card);border-top:1px solid var(--border-strong);
      border-radius:18px 18px 0 0;padding:12px 14px calc(env(safe-area-inset-bottom) + 14px);
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
      position:fixed;top:0;left:0;right:0;height:var(--app-h,100vh);z-index:70;background:rgba(0,0,0,0);display:flex;justify-content:flex-start;
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
    .new-chat-btn{
      appearance:none;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;
      background:var(--surface-strong);border:1px solid var(--border);color:var(--fg-strong);
      font-size:14.5px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
      flex-shrink:0;
    }
    .new-chat-btn:active{background:var(--accent-bg);border-color:var(--accent-border);color:var(--fg-strong)}
    .drawer-sub{font-size:12px;font-weight:600;color:var(--placeholder);padding:2px 4px 0;flex-shrink:0}
    .drawer-nav-bar{display:flex;align-items:center;gap:6px;min-height:26px;padding:2px 2px 0;flex-shrink:0}
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
      width:100%;text-align:left;padding:11px 12px;border-radius:11px;border:1px solid transparent;
      background:var(--surface-subtle);color:var(--fg);font-size:14px;cursor:pointer;
    }
    .conv-item.active{border-color:var(--accent);background:var(--accent-bg);font-weight:600}
    .composer-card.drag-over{border-color:var(--accent);background:var(--accent-bg)}
    .drawer-brand{display:none}
    .conv-list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px;display:flex;flex-direction:column;gap:6px}
    .drawer-footer{flex-shrink:0;padding-top:10px;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:7px}
    .drawer-footer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px;font-size:12px;font-weight:600;color:var(--muted)}
    .drawer-footer-hint{font-size:11.5px;font-weight:500;color:var(--placeholder)}
    .theme-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:3px;border-radius:11px;background:var(--seg-track);border:1px solid var(--border-subtle)}
    .theme-seg-btn{
      appearance:none;border:none;background:transparent;color:var(--muted);
      height:32px;padding:0 6px;border-radius:8px;font-size:12px;font-weight:500;
      display:inline-flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;white-space:nowrap;
      transition:background-color .15s ease,color .15s ease,box-shadow .15s ease;
    }
    .theme-seg-btn.active{background:var(--seg-active-bg);color:var(--fg-strong);font-weight:600;box-shadow:var(--seg-active-shadow)}
    .toast{
      position:fixed;top:calc(env(safe-area-inset-top) + 56px);left:50%;transform:translateX(-50%);
      z-index:80;background:var(--toast-bg);color:var(--toast-fg);padding:7px 14px;border-radius:999px;font-size:12.5px;
      border:1px solid var(--border);box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;
    }
    .toast[hidden]{display:none}
    /* 细滚动条 */
    .messages,.conv-list,.drawer,.sheet-list,.thought-body,.md-body pre,.md-table-wrap{
      scrollbar-width:thin;scrollbar-color:var(--scroll-thumb) transparent;
    }
    .messages{scrollbar-gutter:stable}
    .messages::-webkit-scrollbar,.conv-list::-webkit-scrollbar,.drawer::-webkit-scrollbar,.sheet-list::-webkit-scrollbar,.thought-body::-webkit-scrollbar,.md-body pre::-webkit-scrollbar,.md-table-wrap::-webkit-scrollbar{
      width:6px;height:6px;
    }
    .messages::-webkit-scrollbar-thumb,.conv-list::-webkit-scrollbar-thumb,.drawer::-webkit-scrollbar-thumb,.sheet-list::-webkit-scrollbar-thumb,.thought-body::-webkit-scrollbar-thumb,.md-body pre::-webkit-scrollbar-thumb,.md-table-wrap::-webkit-scrollbar-thumb{
      background:var(--scroll-thumb);border-radius:99px;
    }
    .messages::-webkit-scrollbar-thumb:hover,.conv-list::-webkit-scrollbar-thumb:hover,.drawer::-webkit-scrollbar-thumb:hover,.sheet-list::-webkit-scrollbar-thumb:hover,.md-table-wrap::-webkit-scrollbar-thumb:hover{
      background:var(--scroll-thumb-hover);
    }
    .messages::-webkit-scrollbar-track,.conv-list::-webkit-scrollbar-track,.drawer::-webkit-scrollbar-track,.sheet-list::-webkit-scrollbar-track,.md-table-wrap::-webkit-scrollbar-track{
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
      .new-chat-btn:hover{background:var(--surface-strong-hover);border-color:var(--accent-border);color:var(--fg-strong)}
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
      .new-chat-btn{min-height:38px;padding:8px 12px;font-size:13px;border-radius:10px}
      .conv-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:2px}
      .conv-item{
        padding:9px 10px;font-size:13.5px;border-radius:9px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
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
      .composer-card textarea{min-height:32px;max-height:180px;font-size:14.5px}
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
        <button id="btn-theme" class="icon-btn" type="button" title="切换外观模式" aria-label="切换外观模式">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;color:var(--amber)"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>
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

  <div id="drawer-backdrop" class="drawer-backdrop" aria-hidden="true">
    <div id="drawer-panel" class="drawer">
      <div class="drawer-brand">
        <span class="drawer-brand-dot"></span>
        <span>Antigravity Remote</span>
      </div>
      <button id="btn-new-chat" class="new-chat-btn" type="button">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>新建对话</span>
      </button>
      <button id="btn-follow-desktop" class="follow-desk-btn" type="button">🔄 同步桌面当前会话</button>
      <div id="drawer-nav-bar" class="drawer-nav-bar"><span class="drawer-sub">历史项目</span></div>
      <div id="conv-list" class="conv-list"></div>
      <div class="drawer-footer">
        <div class="drawer-footer-head">
          <span>外观模式</span>
          <span id="theme-mode-hint" class="drawer-footer-hint">跟随系统</span>
        </div>
        <div id="theme-seg" class="theme-seg" role="radiogroup" aria-label="外观模式">
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="system" title="跟随系统深浅色">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span>跟随</span>
          </button>
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="light" title="固定浅色模式">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            <span>浅色</span>
          </button>
          <button class="theme-seg-btn" type="button" role="radio" aria-checked="false" data-theme-mode="dark" title="固定深色模式">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            <span>深色</span>
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

    async function apiAction(payload, opts) {
      const bodyPayload = {
        targetId: currentTargetId || undefined,
        conversationId: selectedConversationId || undefined,
        clientId: clientId || undefined,
        ...payload
      };
      const doPost = () => fetchWithTimeout((apiBase || '') + '/api/action', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(bodyPayload)
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
      if (data?.snapshot && !opts?.skipAutoRender) renderSnapshot(data.snapshot);
      return data;
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

    function renderSnapshot(snap) {
      if (!snap || snap.ok === false) {
        $('status-dot').className = 'dot err';
        $('conv-title').textContent = snap?.error || '连接异常';
        return;
      }
      latestSnap = snap;
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
      $('perm-inline-label').textContent = snap.permissionLabel || '权限';

      renderQuotaDrawer(snap);
      if ($('context-drawer') && !$('context-drawer').hidden) renderContextDrawer(snap, cachedContextResp);
      if ($('usage-drawer') && !$('usage-drawer').hidden) renderUsageDrawer(cachedUsageData);
      syncSendButtonUI();

      // Messages (preserve local expanded thought boxes across polls)
      const wasBottom = stickBottom;
      const openThoughtSet = new Set();
      try {
        msgEl.querySelectorAll('.thought-box').forEach((box, idx) => {
          if (box.open) openThoughtSet.add(box.getAttribute('data-thought-id') || String(idx));
        });
      } catch {}
      const msgs = Array.isArray(snap.messages) ? snap.messages : [];
      if (!msgs.length && !snap.busy) {
        const emptyHtml = '<div class="empty-tip">暂无消息，发一句话' + (isDesktopLayout() ? '或在左侧切换会话' : '或在屏幕右滑切换会话') + '</div>';
        if (msgEl.dataset.lastHtml !== emptyHtml) {
          msgEl.innerHTML = emptyHtml;
          msgEl.dataset.lastHtml = emptyHtml;
        }
      } else {
        let html = msgs.map((m, idx) => {
          if (m.role === 'user') {
            return '<div class="msg user">' + esc(m.text) + '</div>';
          }
          const risk = m.highRisk ? '<span class="risk-tag">' + esc(m.riskText || '🛡️ 检测到高危命令，请人工核对') + '</span>' : '';
          const tId = esc(m.id || String(idx));
          const thought = m.thoughtLabel
            ? '<details class="thought-box" data-thought-id="' + tId + '"><summary>💡 ' + esc(m.thoughtLabel) + (m.thoughtText ? ' · 展开思考' : '') + '</summary>' +
              (m.thoughtText ? '<div class="thought-body">' + esc(m.thoughtText) + '</div>' : '') + '</details>'
            : '';
          const bodyHtml = m.html
            ? '<div class="md-body">' + m.html + '</div>'
            : '<div class="md-body">' + renderMarkdownSafe(m.text || '') + '</div>';
          return '<div class="msg assistant' + (m.highRisk ? ' is-risk' : '') + '">' + risk + thought + bodyHtml + '</div>';
        }).join('');
        if (snap.busy) {
          html += '<div class="busy-pill"><span class="busy-spark"></span><span>正在思考与执行…</span></div>';
        }
        if (msgEl.dataset.lastHtml !== html) {
          msgEl.innerHTML = html;
          msgEl.dataset.lastHtml = html;
          if (openThoughtSet.size > 0) {
            msgEl.querySelectorAll('.thought-box').forEach((box, idx) => {
              const key = box.getAttribute('data-thought-id') || String(idx);
              if (openThoughtSet.has(key)) box.open = true;
            });
          }
          if (wasBottom) msgEl.scrollTop = msgEl.scrollHeight;
        }
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
          const anyClosed = boxes.some((b) => !b.open);
          boxes.forEach((b) => { b.open = anyClosed; });
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

      // Drawer Conversations (aggregated by project -> click project to view conversations -> back to project list)
      renderDrawerProjectsAndConversations(snap);
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

    let snapshotInflight = false;
    let snapshotSeq = 0;
    async function fetchSnapshot() {
      if (snapshotInflight) return;
      snapshotInflight = true;
      const mySeq = ++snapshotSeq;
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

    function openSheet(title, options, onSelect) {
      configureSheetChrome({
        kind: 'generic',
        title,
        subText: '',
        showSpeed: false,
        onBack: null
      });
      const listEl = $('sheet-list');
      listEl.innerHTML = options.map((o, idx) =>
        '<button class="sheet-opt' + (o.active ? ' active' : '') + '" data-idx="' + idx + '" type="button">' +
        '<span>' + esc(o.label) + '</span>' + (o.active ? '<span>✓</span>' : '') + '</button>'
      ).join('');
      listEl.onclick = async (e) => {
        const btn = e.target?.closest?.('.sheet-opt');
        if (!btn) return;
        const opt = options[Number(btn.dataset.idx ?? btn.getAttribute('data-idx'))];
        closeSheet();
        if (opt) await onSelect(opt);
      };
      $('sheet-backdrop').hidden = false;
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
        try {
          const r = await apiAction({ action: 'select-permission', preset: opt.key });
          if (r?.ok) showToast('已切换权限: ' + (r.actionResult?.permissionLabel || opt.label));
          else showToast(r?.error || r?.actionResult?.error || '切换权限失败');
        } catch (err) {
          showToast(err?.message || '切换权限失败');
        }
      });
    }

    $('btn-model-inline').onclick = openModelPicker;
    $('btn-perm-inline').onclick = openPermPicker;

    const THEME_STORAGE_KEY = 'ag_remote_theme_v1';
    const lightSchemeMq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null;
    const THEME_ICON_SYSTEM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
    const THEME_ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    const THEME_ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

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
      const hint = $('theme-mode-hint');
      const effLabel = effective === 'light' ? '浅色' : '深色';
      if (hint) {
        hint.textContent = pref === 'system' ? ('跟随 · ' + effLabel) : ('固定' + effLabel);
      }
      const themeBtn = $('btn-theme');
      if (themeBtn) {
        themeBtn.innerHTML = pref === 'light' ? THEME_ICON_SUN : (pref === 'dark' ? THEME_ICON_MOON : THEME_ICON_SYSTEM);
        const label = pref === 'system'
          ? ('外观：跟随系统（当前' + effLabel + '）')
          : ('外观：固定' + effLabel);
        themeBtn.title = label;
        themeBtn.setAttribute('aria-label', label);
      }
      return { pref, effective };
    }
    function selectThemePref(nextPref) {
      const { pref, effective } = applyTheme(nextPref, true);
      const effText = effective === 'light' ? '浅色' : '深色';
      showToast(pref === 'system' ? ('外观已设为跟随系统（当前' + effText + '）') : ('外观已切换为固定' + effText));
    }
    function openThemePicker() {
      const curPref = activeThemePref;
      const sysLabel = lightSchemeMq && lightSchemeMq.matches ? '浅色' : '深色';
      const opts = [
        { mode: 'system', label: '🖥️ 跟随系统（当前：' + sysLabel + '）', active: curPref === 'system' },
        { mode: 'light', label: '☀️ 固定浅色', active: curPref === 'light' },
        { mode: 'dark', label: '🌙 固定深色', active: curPref === 'dark' }
      ];
      openSheet('外观模式', opts, async (opt) => {
        selectThemePref(opt.mode);
      });
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
    if ($('btn-theme')) {
      $('btn-theme').addEventListener('click', openThemePicker);
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

    if ($('drawer-nav-bar')) {
      $('drawer-nav-bar').addEventListener('click', (e) => {
        const backBtn = e.target?.closest?.('#btn-drawer-back');
        if (!backBtn) return;
        activeDrawerProject = '';
        renderDrawerProjectsAndConversations(latestSnap, true);
      });
    }

    $('conv-list').addEventListener('click', async (e) => {
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
      if (!btn || !btn.dataset.cid) return;
      const cid = String(btn.dataset.cid);
      if (!isDesktopLayout()) closeDrawer();
      stickBottom = true;
      showToast('正在切换会话…');
      try {
        applySelectedConversation(cid);
        const r = await apiAction({ action: 'switch-conversation', id: cid, isolated: true });
        if (!r?.ok) showToast(r?.error || r?.actionResult?.error || '切换会话失败');
      } catch (err) {
        showToast(err?.message || '切换会话失败');
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
    $('btn-drawer').onclick = () => {
      if (isDesktopLayout()) {
        document.body.classList.toggle('sidebar-collapsed');
        syncSidebarA11y();
      } else {
        openDrawer();
      }
    };
    backdropEl.onclick = (e) => { if (!isDesktopLayout() && e.target === backdropEl) closeDrawer(); };
    $('btn-new-chat').onclick = async () => {
      if (!isDesktopLayout()) closeDrawer();
      try {
        const r = await apiAction({ action: 'switch-conversation', id: 'new' });
        if (r?.ok) {
          const newId = String(r?.snapshot?.activeConversationId || r?.snapshot?.sessionId || '__new__');
          applySelectedConversation(newId);
          showToast('已新建对话');
        } else {
          showToast(r?.error || r?.actionResult?.error || '新建对话失败');
        }
      } catch (err) {
        showToast(err?.message || '新建对话失败');
      }
    };
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
      const maxH = isDesktopLayout() ? 180 : 112;
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
    $('btn-send').onclick = sendInput;
    syncSendButtonUI();
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendInput();
      }
    });

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
      if (!touchesTunnel && !tunnelConfigChanged) {
        return getStatus();
      }
      await stop();
      return await start(nextCfg);
    }
  };
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
  const cachedIcon = buildMobileIconSvg();
  const cachedManifest = buildManifestJson();
  const cachedSw = buildServiceWorkerJs();
  const cached401 = buildUnauthorizedHtml();

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': HTML_CSP });
      res.end(cachedHtml);
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
        const snap = await fetchSnapshot(targetId, { conversationId: reqConvId, clientId });
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payloadOut));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '读取 Antigravity 状态失败' }));
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
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: '缺少会话 ID' }));
            return;
          }
          if (nextId === 'follow-desktop') {
            if (session) session.conversationId = '';
            const snap = await fetchSnapshot(effectiveTargetId, { clientId });
            if (session && snap && snap.ok !== false && (snap.activeConversationId || snap.sessionId)) {
              session.conversationId = String(snap.activeConversationId || snap.sessionId || '');
            }
            const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
            const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
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
            const snap = await fetchSnapshot(effectiveTargetId, { conversationId: nextId, clientId });
            const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
            const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
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
            restoreDesktop: false
          });
          if (session) {
            session.conversationId = String(newResult?.snapshot?.activeConversationId || newResult?.snapshot?.sessionId || '__new__');
          }
          if (newResult?.snapshot) {
            const usageSummary = !newResult.snapshot.usageSummary ? await getCachedUsageSummary() : null;
            newResult.snapshot = enrichSnapshotPayload(newResult.snapshot, config, activeTunnelUrl, clientId, usageSummary);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(newResult));
          return;
        }

        if (actionName === 'switch-window') {
          const nextTargetId = String(payload?.targetId || '').trim();
          if (session) {
            session.targetId = nextTargetId;
            session.conversationId = '';
          }
          const snap = await fetchSnapshot(nextTargetId, { clientId });
          if (session && snap && snap.ok !== false && (snap.activeConversationId || snap.sessionId)) {
            session.conversationId = String(snap.activeConversationId || snap.sessionId || '');
          }
          const usageSummary = (snap && snap.ok !== false && !snap.usageSummary) ? await getCachedUsageSummary() : null;
          const enriched = enrichSnapshotPayload(snap, config, activeTunnelUrl, clientId, usageSummary);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
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
  readJsonBody,
  createRemoteHttpHandler,
  recordPairedDeviceAccess,
  getPairedDevicesSummary,
  startMobileRemoteServer,
  buildRemoteInfo,
  printRemoteCli
};

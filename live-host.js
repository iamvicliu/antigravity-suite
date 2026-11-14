'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect } = require('./local-api');
const {
  collect,
  collectTokenHistoryAsync,
  recordModelCalls,
  getPluginSettings,
  savePluginSettings,
  launchCliSession,
  getContextUnlockStatus,
  applyContextUnlock,
  restoreContextUnlock
} = require('./meter-collector');
const { getStateDir } = require('./asar-engine');
const { safeReadJsonSync, safeWriteJsonSync } = require('./meter-storage');
const { tryHotInject } = require('./install');

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 传输体积上限
const MAX_RECORD_CALLS = 500; // 单批次最大记录数
const MAX_TRANSLATE_BATCH = 30; // 单次批量翻译最大条数
const ALLOWED_ROUTES = [
  '/scan',
  '/token-history',
  '/record-calls',
  '/get-settings',
  '/save-settings',
  '/launch-cli',
  '/context-unlock-status',
  '/context-unlock-apply',
  '/context-unlock-restore',
  '/enhance-status',
  '/enhance-apply',
  '/enhance-restore',
  '/restart-language-servers',
  '/modules-status',
  '/toggle-module',
  '/restart-host',
  '/export-markdown',
  '/translate-zh',
  '/localize-conversations',
  '/brain-stats'
];

const customTitlesPath = path.join(getStateDir(), 'custom-conversation-titles.json');
let customTitlesCache = { mtimeMs: -1, data: {} };

// 从状态目录按需读取用户自定义会话标题映射，避免硬编码个人会话记录
function getCustomConversationTitles() {
  try {
    if (!fs.existsSync(customTitlesPath)) {
      customTitlesCache = { mtimeMs: -1, data: {} };
      return customTitlesCache.data;
    }
    const stat = fs.statSync(customTitlesPath);
    if (stat.mtimeMs !== customTitlesCache.mtimeMs) {
      const loaded = safeReadJsonSync(customTitlesPath, {});
      if (loaded.ok && loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data)) {
        customTitlesCache = { mtimeMs: stat.mtimeMs, data: loaded.data };
      } else {
        customTitlesCache = { mtimeMs: stat.mtimeMs, data: {} };
      }
    }
  } catch {}
  return customTitlesCache.data;
}

const translationCachePath = path.join(getStateDir(), 'zh-translation-cache.json');
let translationCache = {};
try {
  const loaded = safeReadJsonSync(translationCachePath, {});
  if (loaded.ok && loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data)) {
    translationCache = loaded.data;
  }
} catch {}

const inFlightTranslations = new Map();

function persistTranslationCache() {
  try {
    const keys = Object.keys(translationCache);
    if (keys.length > 3000) {
      const keep = {};
      for (const k of keys.slice(-2500)) keep[k] = translationCache[k];
      translationCache = keep;
    }
    safeWriteJsonSync(translationCachePath, translationCache, {
      indent: 2,
      validate: (d) => d && typeof d === 'object' && !Array.isArray(d)
    });
  } catch {}
}

function splitTextForTranslate(text, maxLen = 1200) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf('. ', maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.2) cut = maxLen;
    else cut += 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translateSingleChunkToZh(chunk) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(chunk)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'AntigravityContextMeter/1.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) throw new Error(`翻译接口 HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
}

async function translateToZh(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '';
  if (typeof translationCache[text] === 'string' && translationCache[text]) {
    return translationCache[text];
  }
  if (inFlightTranslations.has(text)) {
    return inFlightTranslations.get(text);
  }
  const job = (async () => {
    try {
      const chunks = splitTextForTranslate(text);
      const parts = [];
      for (const ch of chunks) {
        const zh = await translateSingleChunkToZh(ch);
        if (zh) parts.push(zh);
      }
      const merged = parts.join('').trim();
      if (merged) {
        translationCache[text] = merged;
        return merged;
      }
      return null;
    } catch {
      return null;
    } finally {
      inFlightTranslations.delete(text);
    }
  })();
  inFlightTranslations.set(text, job);
  return job;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  const runners = Array.from({ length: count }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function cleanTextForTitle(raw) {
  let s = String(raw || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/@\[[^\]]+\]/g, ' ');
  s = s.replace(/(?:~\/|\/Users\/|\/Applications\/|\/System\/|\/etc\/|\/var\/|\/tmp\/|[A-Za-z]:\\)[^\s"'`<>|]+/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/[#>*_~|[\]{}]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[，。！？：；、,.!?:;\-—·\s]+|[，。！？：；、,.!?:;\-—·\s]+$/g, '').trim();
  return s;
}

function extractTitleFromLocalTranscript(id, allowEnglish = false) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  const logsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  const compactLogPath = path.join(logsDir, 'transcript.jsonl');
  const fullLogPath = path.join(logsDir, 'transcript_full.jsonl');
  const logPath = fs.existsSync(compactLogPath) ? compactLogPath : (fs.existsSync(fullLogPath) ? fullLogPath : null);
  if (!logPath) return null;
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry && entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
        const m = entry.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        const raw = (m ? m[1] : entry.content);
        const cleaned = cleanTextForTitle(raw);
        if (!cleaned) return null;
        const zhMatches = cleaned.match(/[\u4e00-\u9fff]/g) || [];
        if (zhMatches.length >= 2 || allowEnglish) {
          return cleaned.slice(0, 18).replace(/[，。！？：；、,.!?:;\-—·\s]+$/g, '').trim();
        }
        return null;
      }
    }
  } catch {}
  return null;
}

function calcDirSizeBytes(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    try {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        total += calcDirSizeBytes(full);
      } else if (ent.isFile()) {
        total += fs.lstatSync(full).size;
      }
    } catch {}
  }
  return total;
}

function collectBrainStats() {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  if (!fs.existsSync(brainDir)) {
    return { ok: true, totalBytes: 0, totalMB: 0, count: 0, topSessions: [] };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: e.message || '读取缓存目录失败' };
  }
  let totalBytes = 0;
  const sessions = [];
  const customTitles = getCustomConversationTitles();
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const id = ent.name;
    const bytes = calcDirSizeBytes(path.join(brainDir, id));
    totalBytes += bytes;
    const title = customTitles[id] || extractTitleFromLocalTranscript(id, true) || id.slice(0, 8);
    sessions.push({
      id,
      shortId: id.slice(0, 8),
      title,
      bytes,
      mb: Number((bytes / (1024 * 1024)).toFixed(1))
    });
  }
  sessions.sort((a, b) => b.bytes - a.bytes);
  return {
    ok: true,
    totalBytes,
    totalMB: Number((totalBytes / (1024 * 1024)).toFixed(1)),
    count: sessions.length,
    topSessions: sessions.slice(0, 5)
  };
}

(async () => {
  let api = await connect();
  const secret = crypto.randomBytes(32).toString('hex');
  const stamp = path.join(getStateDir(), '.live-session.json');
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin !== api.origin) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', api.origin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || req.headers['x-ag-context-token'] !== secret) { res.writeHead(403); res.end(); return; }
    let body = '';
    let bodyLength = 0;
    let exceeded = false;
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求体积超出限制（最大 1MB）' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (exceeded) return;
      try {
        const request = JSON.parse(body || '{}');
        if (req.url === '/record-calls') {
          const calls = Array.isArray(request.calls) ? request.calls : [];
          if (calls.length > MAX_RECORD_CALLS) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `单次入账记录数超出上限（最多 ${MAX_RECORD_CALLS} 条）` }));
            return;
          }
          const resCall = recordModelCalls(calls);
          if (resCall && typeof resCall === 'object' && resCall.ok === false) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, changed: false, error: resCall.error || '入账落盘失败' }));
            return;
          }
          const changed = (resCall && typeof resCall === 'object') ? !!resCall.changed : !!resCall;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, changed }));
          return;
        }
        if (req.url === '/get-settings') {
          const result = getPluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/save-settings') {
          const result = savePluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/launch-cli') {
          const result = await launchCliSession(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/context-unlock-status') {
          const result = await getContextUnlockStatus(undefined, request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/context-unlock-apply') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: '已禁用二进制解锁（保护官方签名与账号合规）' }));
          return;
        }
        if (req.url === '/context-unlock-restore') {
          const result = restoreContextUnlock();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/enhance-status') {
          const { getEnhanceStatus } = require('./meter-enhance');
          const result = getEnhanceStatus(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }
        if (req.url === '/enhance-apply') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: '已禁用二进制内核补丁（保护 macOS 官方签名与账号安全，中文标题已由免改包桥接接管）' }));
          return;
        }
        if (req.url === '/enhance-restore') {
          const { restoreAllEnhance } = require('./meter-enhance');
          const result = restoreAllEnhance(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/restart-language-servers') {
          const { restartLanguageServers } = require('./meter-enhance');
          const result = restartLanguageServers();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/modules-status') {
          const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: loadModulesConfig(), disk: inspectDiskModules(request?.asarPath || null) }));
          return;
        }
        if (req.url === '/toggle-module') {
          const { loadModulesConfig, saveModulesConfig, inspectDiskModules, normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
          const cfg = loadModulesConfig();
          const mod = request?.name;
          if (!cfg.modules[mod]) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `未知模块: ${mod}` }));
            return;
          }
          const extra = request?.opts || {};
          if (mod === 'chinese') {
            const nextLang = normalizeClientLanguage(extra.language, Boolean(request?.enable));
            cfg.modules.chinese.language = nextLang;
            cfg.modules.chinese.enabled = nextLang === 'zh-CN';
            if (extra.brandTitle !== undefined) cfg.modules.chinese.brandTitle = normalizeBrandTitle(extra.brandTitle);
            cfg.modules.chinese.lastUpdated = new Date().toISOString();
          } else {
            cfg.modules[mod].enabled = Boolean(request?.enable);
            if (mod === 'proxy') {
              if (extra.proxyUrl) cfg.modules.proxy.proxyUrl = extra.proxyUrl;
              if (extra.bypassList) cfg.modules.proxy.bypassList = extra.bypassList;
            }
          }
          saveModulesConfig(cfg);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, status: 'config_toggled', data: cfg, disk: inspectDiskModules(extra.asarPath || null), restartRequired: true }));
          return;
        }
        if (req.url === '/restart-host') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, supported: false }));
          return;
        }
        if (req.url === '/token-history') {
          const data = await collectTokenHistoryAsync({ force: request.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        if (req.url === '/export-markdown') {
          const id = String(request.id || '').trim();
          if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: '无效的会话 ID' }));
            return;
          }
          const logsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
          const fullLogPath = path.join(logsDir, 'transcript_full.jsonl');
          const compactLogPath = path.join(logsDir, 'transcript.jsonl');
          const logPath = fs.existsSync(fullLogPath) ? fullLogPath : (fs.existsSync(compactLogPath) ? compactLogPath : null);
          if (!logPath) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: '未找到对应会话的日志文件' }));
            return;
          }
          const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
          const sections = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
              const match = entry.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              const text = (match ? match[1] : entry.content).trim();
              if (text) sections.push(`## 👤 用户\n\n${text}`);
            } else if (entry.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string') {
              const text = entry.content.trim();
              if (text) sections.push(`## 🤖 Antigravity\n\n${text}`);
            }
          }
          const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
          const header = [
            '# Antigravity 会话记录',
            '',
            `- 会话 ID: \`${id}\``,
            `- 导出时间: ${exportedAt}`,
            `- 对话轮次: ${sections.length}`,
            '',
            '---',
            ''
          ].join('\n');
          const markdown = header + sections.join('\n\n---\n\n') + '\n';
          const downloadsDir = path.join(os.homedir(), 'Downloads');
          fs.mkdirSync(downloadsDir, { recursive: true });
          const savedPath = path.join(downloadsDir, `antigravity-session-${id.slice(0, 8)}.md`);
          fs.writeFileSync(savedPath, markdown, 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, markdown, savedPath, turnsCount: sections.length }));
          return;
        }
        if (req.url === '/translate-zh') {
          const rawList = Array.isArray(request.texts) ? request.texts : [];
          const uniqueTexts = [];
          const seen = new Set();
          for (const item of rawList) {
            if (typeof item !== 'string') continue;
            const trimmed = item.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            uniqueTexts.push(trimmed);
            if (uniqueTexts.length >= MAX_TRANSLATE_BATCH) break;
          }
          const translations = {};
          const pending = [];
          for (const text of uniqueTexts) {
            if (typeof translationCache[text] === 'string' && translationCache[text]) {
              translations[text] = translationCache[text];
            } else {
              pending.push(text);
            }
          }
          let added = false;
          if (pending.length) {
            const results = await mapConcurrent(pending, 4, async (text) => {
              const zh = await translateToZh(text);
              return [text, zh];
            });
            for (const [text, zh] of results) {
              if (zh) {
                translations[text] = zh;
                added = true;
              }
            }
          }
          if (added) persistTranslationCache();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, translations }));
          return;
        }
        if (req.url === '/localize-conversations') {
          const rawItems = Array.isArray(request.items) ? request.items.slice(0, 50) : [];
          const customTitles = getCustomConversationTitles();
          const titles = {};
          const toTranslate = [];
          for (const item of rawItems) {
            const id = String(item?.id || '').trim();
            const title = String(item?.title || '').trim();
            if (!id) continue;
            if (customTitles[id]) {
              if (title !== customTitles[id]) {
                titles[id] = customTitles[id];
              }
              continue;
            }
            if (!title || /[\u4e00-\u9fff]/.test(title) || !/[a-zA-Z]/.test(title)) {
              continue;
            }
            const fromTranscript = extractTitleFromLocalTranscript(id);
            if (fromTranscript && fromTranscript !== title) {
              titles[id] = fromTranscript;
              continue;
            }
            if (typeof translationCache[title] === 'string' && translationCache[title]) {
              titles[id] = translationCache[title];
            } else {
              toTranslate.push({ id, title });
            }
          }
          let added = false;
          if (toTranslate.length) {
            const results = await mapConcurrent(toTranslate, 4, async ({ id, title }) => {
              const zh = await translateToZh(title);
              return [id, zh];
            });
            for (const [id, zh] of results) {
              if (zh) {
                titles[id] = zh;
                added = true;
              }
            }
          }
          if (added) persistTranslationCache();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, titles }));
          return;
        }
        if (req.url === '/brain-stats') {
          const stats = collectBrainStats();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(stats));
          return;
        }
        const data = await collect(api.origin, request.id, { force: request.force === true });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, data }));
      }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const info = { port: server.address().port, token: secret, pid: process.pid, origin: api.origin, startedAt: Date.now() };
    fs.writeFileSync(stamp, JSON.stringify(info));
    console.log('Context Meter local bridge ready on loopback port ' + info.port);
  });
  let misses = 0;
  let checking = false;
  const check = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const a = await connect();
      misses = 0;
      if (a.origin !== api.origin) {
        api = a;
        const info = { port: server.address().port, token: secret, pid: process.pid, origin: api.origin, startedAt: Date.now() };
        fs.writeFileSync(stamp, JSON.stringify(info));
      }
      await tryHotInject({ onlyMissing: true });
    } catch {
      if (++misses >= 10) {
        clearInterval(check);
        try { fs.unlinkSync(stamp); } catch {}
        server.close();
        process.exit(0);
      }
    } finally {
      checking = false;
    }
  }, 3000);
})().catch(e => { console.error(e.message); process.exitCode = 1; });

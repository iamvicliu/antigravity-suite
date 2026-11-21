'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { resolveActiveCdpTarget } = require('./asar-engine');
function request(url, body, token) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { rejectUnauthorized: false, agent: false, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {} }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`)));
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
/**
 * 检查目标 PID 是否仍存活（EPERM 说明进程存在但无权发信号）。
 */
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 当桌面客户端未开启 DevTools 调试端口或运行独立 agy CLI 时，
 * 扫描 ~/.gemini/(antigravity|antigravity-ide)/daemon/*.json 发现本地语言服务，并优先选用存活 PID 对应的凭证。
 */
function discoverFromHubDaemonFiles(options = {}) {
  const daemonDirs = Array.isArray(options?.daemonDirs) && options.daemonDirs.length
    ? options.daemonDirs
    : ['antigravity', 'antigravity-ide'].map(dir => path.join(os.homedir(), '.gemini', dir, 'daemon'));
  const checkPidAlive = typeof options?.isPidAlive === 'function' ? options.isPidAlive : defaultIsPidAlive;
  const candidates = [];
  for (const dirPath of daemonDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.json$/i.test(name)) continue;
      const fullPath = path.join(dirPath, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const csrfToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
        const httpsPort = typeof parsed?.httpsPort === 'number' && parsed.httpsPort > 0 ? parsed.httpsPort : null;
        const httpPort = typeof parsed?.httpPort === 'number' && parsed.httpPort > 0 ? parsed.httpPort : null;
        const port = httpsPort || httpPort;
        if (!csrfToken || !port) continue;
        const rawPid = parsed?.pid;
        const pidNum = (rawPid != null && rawPid !== '') ? Number(rawPid) : NaN;
        const hasPid = Number.isInteger(pidNum) && pidNum > 0;
        const aliveRank = hasPid ? (checkPidAlive(pidNum) ? 2 : 0) : 1;
        const protocol = httpsPort ? 'https' : 'http';
        candidates.push({
          aliveRank,
          mtimeMs: stat.mtimeMs,
          origin: `${protocol}://127.0.0.1:${port}`,
          csrfToken
        });
      } catch {
        // 忽略损坏或正在写入的守护进程文件
      }
    }
  }
  candidates.sort((a, b) => (b.aliveRank - a.aliveRank) || (b.mtimeMs - a.mtimeMs));
  for (const item of candidates) {
    return {
      origin: item.origin,
      page: null,
      call: async (method, body) =>
        JSON.parse(await request(`${item.origin}/exa.language_server_pb.LanguageServerService/${method}`, body, item.csrfToken))
    };
  }
  return null;
}

async function connect() {
  try {
    const { targets } = await resolveActiveCdpTarget({ timeoutMs: 2500 });
    const page = targets[0];
    if (!page) throw new Error('Antigravity window not found');
    const origin = new URL(page.url).origin;
    const html = await request(origin + '/');
    const configMatch = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (!configMatch) throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
    const token = JSON.parse(configMatch[1]).csrfToken;
    if (!token) throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
    return { origin, page, call: async (method, body) => JSON.parse(await request(`${origin}/exa.language_server_pb.LanguageServerService/${method}`, body, token)) };
  } catch (err) {
    const fallback = discoverFromHubDaemonFiles();
    if (fallback) return fallback;
    throw err;
  }
}
module.exports = { connect, discoverFromHubDaemonFiles };

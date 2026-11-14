#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'upstreams.json');

/**
 * 读取上游基线账本 JSON。
 */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`未找到上游基线文件: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * 写回上游基线账本 JSON。
 */
function saveManifest(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 调用 GitHub API：优先通过已认证的 gh CLI（遇到偶发 EOF 重试一次），失败后降级使用原生 fetch。
 */
async function githubApiJson(endpoint) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        timeout: 12000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return JSON.parse(out);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.stderr || err?.message || '');
      if (/404|Not Found/i.test(msg)) {
        const notFound = new Error('NOT_FOUND');
        notFound.code = 'NOT_FOUND';
        throw notFound;
      }
    }
  }

  const res = await fetch(`https://api.github.com/${endpoint}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'antigravity-suite-upstream-checker'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (res.status === 404) {
    const notFound = new Error('NOT_FOUND');
    notFound.code = 'NOT_FOUND';
    throw notFound;
  }
  if (!res.ok) {
    throw new Error(`GitHub API 请求失败 (${res.status}): ${lastErr ? lastErr.message : res.statusText}`);
  }
  return res.json();
}

/**
 * 判断文件变更是否命中禁止改包/解锁红线模式。
 */
function isForbiddenFile(filename, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const lower = String(filename || '').toLowerCase();
  return patterns.some((pat) => lower.includes(String(pat).toLowerCase()));
}

/**
 * 查询单个上游仓库的最新状态并与已吸收基线比对。
 */
async function inspectUpstream(entry) {
  const repo = entry.repo;
  const branch = entry.branch || 'main';
  const result = {
    repo,
    branch,
    absorbedSha: entry.absorbedSha,
    absorbedVersion: entry.version || null,
    localTargets: entry.localTargets || [],
    mergeStrategy: entry.mergeStrategy || '',
    status: 'unknown',
    latestSha: null,
    latestDate: null,
    latestMessage: null,
    latestReleaseTag: null,
    aheadBy: 0,
    commits: [],
    files: [],
    error: null
  };

  try {
    const commit = await githubApiJson(`repos/${repo}/commits/${encodeURIComponent(branch)}`);
    result.latestSha = commit.sha;
    result.latestDate = commit.commit?.committer?.date || commit.commit?.author?.date || null;
    result.latestMessage = String(commit.commit?.message || '').split(/\r?\n/)[0];

    try {
      const rel = await githubApiJson(`repos/${repo}/releases/latest`);
      result.latestReleaseTag = rel.tag_name || null;
    } catch (e) {
      if (e.code !== 'NOT_FOUND') {
        result.latestReleaseTag = null;
      }
    }

    if (entry.absorbedSha === result.latestSha) {
      result.status = 'up_to_date';
      return result;
    }

    const cmp = await githubApiJson(`repos/${repo}/compare/${entry.absorbedSha}...${result.latestSha}`);
    result.status = 'update_available';
    result.aheadBy = Number(cmp.ahead_by || (Array.isArray(cmp.commits) ? cmp.commits.length : 0));
    result.commits = (Array.isArray(cmp.commits) ? cmp.commits : []).slice(-15).map((c) => ({
      sha: c.sha,
      shortSha: String(c.sha || '').slice(0, 7),
      date: c.commit?.committer?.date || null,
      message: String(c.commit?.message || '').split(/\r?\n/)[0]
    }));
    result.files = (Array.isArray(cmp.files) ? cmp.files : []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      blocked: isForbiddenFile(f.filename, entry.forbiddenPatterns)
    }));
  } catch (err) {
    result.status = 'error';
    result.error = err.message;
  }

  return result;
}

/**
 * 将某个上游仓库标记为已同步到指定（或最新）Commit SHA。
 */
async function markSynced(targetRepo, rawSha, rawVersion) {
  const manifest = loadManifest();
  const entry = manifest.upstreams.find((item) => item.repo === targetRepo);
  if (!entry) {
    throw new Error(`未在 upstreams.json 中找到上游仓库: ${targetRepo}`);
  }
  let nextSha = rawSha;
  let nextVersion = rawVersion || entry.version;
  if (!nextSha || nextSha === 'latest') {
    const branch = entry.branch || 'main';
    const commit = await githubApiJson(`repos/${entry.repo}/commits/${encodeURIComponent(branch)}`);
    nextSha = commit.sha;
    if (!rawVersion) {
      try {
        const rel = await githubApiJson(`repos/${entry.repo}/releases/latest`);
        if (rel?.tag_name) nextVersion = rel.tag_name;
      } catch {}
    }
  }
  entry.absorbedSha = nextSha;
  if (nextVersion) entry.version = nextVersion;
  saveManifest(manifest);
  return entry;
}

function formatDateLocal(isoStr) {
  if (!isoStr) return '未知时间';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function printHumanReport(results) {
  console.log('🔍 参考项目上游更新巡检结果（基于 upstreams.json 基线账本）：\n');
  let updateCount = 0;
  let errorCount = 0;

  for (const r of results) {
    const curVer = r.absorbedVersion ? ` ${r.absorbedVersion}` : '';
    const relNote = r.latestReleaseTag && r.latestReleaseTag !== r.absorbedVersion
      ? ` -> 最新 Release: ${r.latestReleaseTag}`
      : '';
    if (r.status === 'up_to_date') {
      console.log(`✅ [已是最新] ${r.repo} (${String(r.absorbedSha).slice(0, 7)}${curVer})`);
      console.log(`   最近提交: ${formatDateLocal(r.latestDate)} · ${r.latestMessage}`);
      console.log(`   对应模块: ${r.localTargets.join(', ')}\n`);
    } else if (r.status === 'update_available') {
      updateCount++;
      console.log(`🆕 [发现更新] ${r.repo} (领先 ${r.aheadBy} 个提交: ${String(r.absorbedSha).slice(0, 7)}${curVer} -> ${String(r.latestSha).slice(0, 7)}${relNote})`);
      console.log(`   最新时间: ${formatDateLocal(r.latestDate)}`);
      console.log(`   对应本地: ${r.localTargets.join(', ')}`);
      console.log(`   合入策略: ${r.mergeStrategy}`);
      if (r.commits.length) {
        console.log('   新增提交:');
        for (const c of r.commits) {
          console.log(`     - ${c.shortSha} ${c.message}`);
        }
      }
      if (r.files.length) {
        const safeFiles = r.files.filter((f) => !f.blocked);
        const blockedFiles = r.files.filter((f) => f.blocked);
        if (safeFiles.length) {
          console.log(`   可审阅合入文件 (${safeFiles.length}): ${safeFiles.slice(0, 12).map((f) => f.filename).join(', ')}${safeFiles.length > 12 ? ' ...' : ''}`);
        }
        if (blockedFiles.length) {
          console.log(`   ⛔ 触及免改包红线已标记跳过 (${blockedFiles.length}): ${blockedFiles.map((f) => f.filename).join(', ')}`);
        }
      }
      console.log('');
    } else {
      errorCount++;
      console.log(`⚠️ [查询失败] ${r.repo}: ${r.error}\n`);
    }
  }

  if (updateCount === 0 && errorCount === 0) {
    console.log(`🎉 全部 ${results.length} 个参考项目均已对齐最新基线，暂无需要合入的上游更新。`);
  } else {
    console.log(`📌 汇总: ${updateCount} 个上游仓库有新提交，${errorCount} 个查询失败。合入验收后可运行：`);
    console.log('   ag-context-meter upstreams --mark-synced <owner/repo> latest [版本号]');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`用法: node scripts/check-upstreams.js [选项]

选项:
  --json                              输出 JSON 格式巡检结果
  --mark-synced <repo> [sha] [ver]    更新 upstreams.json 中指定仓库的已吸收基线 (sha 可传 latest)
  -h, --help                          显示帮助信息`);
    return;
  }

  const syncIdx = args.indexOf('--mark-synced');
  if (syncIdx !== -1) {
    const repo = args[syncIdx + 1];
    const sha = args[syncIdx + 2] || 'latest';
    const ver = args[syncIdx + 3] || null;
    if (!repo) {
      throw new Error('请指定仓库名，例如: --mark-synced yiheng8023/antigravity-chinese latest v3.3.49');
    }
    const updated = await markSynced(repo, sha, ver);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ ok: true, updated }, null, 2));
    } else {
      console.log(`✅ 已更新基线: ${updated.repo} -> ${updated.absorbedSha.slice(0, 7)} (${updated.version || '-'})`);
    }
    return;
  }

  const manifest = loadManifest();
  const results = await Promise.all((manifest.upstreams || []).map(inspectUpstream));
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    printHumanReport(results);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ 上游检查失败:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { inspectUpstream, loadManifest, markSynced };

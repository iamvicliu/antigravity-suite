'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { getStateDir } = require('./asar-engine');

const DEFAULT_TTL_MS = 15000;
const DEFAULT_TEST_PREVIEW_MS = 5000;
const MAX_UNREAD_TOTAL = 999;
const MAX_APPROVAL_TOTAL = 99;
const CACHE_BINARY_PREFIX = 'ag-dock-overlay-';
const APP_BUNDLE_DIRNAME = 'AntigravityDockOverlay.app';
const APP_EXECUTABLE_NAME = 'AntigravityDockOverlay';
const APP_BUNDLE_IDENTIFIER = 'com.antigravity.context-meter.dock-overlay';

function buildOverlayInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity Dock 提醒</string>
  <key>CFBundleExecutable</key>
  <string>${APP_EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_EXECUTABLE_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <false/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function isDockOverlaySupportedPlatform(platform = process.platform) {
  return platform === 'darwin';
}

function normalizeBool(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (val === 'false' || val === '0' || val === 0) return false;
  if (val === 'true' || val === '1' || val === 1) return true;
  return fallback;
}

function normalizeDockBadgePrefs(uiPrefs) {
  const src = (uiPrefs && typeof uiPrefs === 'object' && !Array.isArray(uiPrefs)) ? uiPrefs : {};
  const rawEnabled = src.dockBadgeEnabled !== undefined ? src.dockBadgeEnabled : src.enabled;
  const rawStyle = src.dockBadgeStyle !== undefined ? src.dockBadgeStyle : src.style;
  const rawColorTier = src.dockBadgeColorTier !== undefined ? src.dockBadgeColorTier : src.colorTier;
  const rawAutoClear = src.dockBadgeAutoClear !== undefined ? src.dockBadgeAutoClear : src.autoClear;

  const styleStr = typeof rawStyle === 'string' ? rawStyle.trim().toLowerCase() : '';
  return {
    enabled: normalizeBool(rawEnabled, true),
    style: styleStr === 'badge' ? 'badge' : 'capsule',
    colorTier: normalizeBool(rawColorTier, true),
    autoClear: normalizeBool(rawAutoClear, true)
  };
}

function clampInt(val, min, max) {
  const num = Number(val);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeLocale(rawLocale) {
  if (typeof rawLocale !== 'string') return '';
  const trimmed = rawLocale.trim();
  if (!trimmed || trimmed.length > 32) return '';
  return trimmed;
}

function aggregateDockStates(windowsMap, nowMs = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const effectiveNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const effectiveTtl = (Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 0) ? Number(ttlMs) : DEFAULT_TTL_MS;

  let entries = [];
  if (windowsMap instanceof Map) {
    entries = Array.from(windowsMap.values());
  } else if (Array.isArray(windowsMap)) {
    entries = windowsMap;
  } else if (windowsMap && typeof windowsMap === 'object') {
    entries = Object.values(windowsMap);
  }

  const unionUnreadIds = new Set();
  let fallbackUnreadSum = 0;
  let approval = 0;
  let highRisk = false;
  let running = false;
  let windowCount = 0;
  let latestLocale = '';
  let latestUpdatedAt = -Infinity;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.offline === true) continue;
    const updatedAt = Number(entry.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    if (effectiveNow - updatedAt > effectiveTtl) continue;

    windowCount += 1;
    if (Array.isArray(entry.unreadIds)) {
      for (const rawId of entry.unreadIds) {
        if (typeof rawId === 'string') {
          const trimmed = rawId.trim();
          if (trimmed) unionUnreadIds.add(trimmed);
        }
      }
    } else {
      fallbackUnreadSum += clampInt(entry.unreadCount ?? entry.unread ?? 0, 0, MAX_UNREAD_TOTAL);
    }
    approval += clampInt(entry.approvalCount ?? entry.approval ?? 0, 0, MAX_APPROVAL_TOTAL);
    if (entry.highRisk === true) highRisk = true;
    if (entry.running === true) running = true;

    const loc = normalizeLocale(entry.locale);
    if (loc && updatedAt >= latestUpdatedAt) {
      latestUpdatedAt = updatedAt;
      latestLocale = loc;
    }
  }

  return {
    unread: Math.min(MAX_UNREAD_TOTAL, unionUnreadIds.size + fallbackUnreadSum),
    approval: Math.min(MAX_APPROVAL_TOTAL, approval),
    highRisk,
    running,
    locale: latestLocale || 'zh-CN',
    windowCount
  };
}

function loadInitialUiPrefsSafe() {
  try {
    const { getPluginSettings } = require('./meter-collector');
    return getPluginSettings()?.uiPreferences || {};
  } catch {
    return {};
  }
}

function execFileAsync(execFileFn, file, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFileFn(file, args, opts, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          stdout: stdout ? String(stdout) : '',
          stderr: stderr ? String(stderr) : ''
        });
      });
    } catch (err) {
      resolve({ ok: false, error: err, stdout: '', stderr: '' });
    }
  });
}

function createMacosDockBadgeManager(options = {}) {
  const platform = options.platform || process.platform;
  const supported = isDockOverlaySupportedPlatform(platform);
  const stateDir = options.stateDir || getStateDir();
  const binDir = path.join(stateDir, 'bin');
  const swiftSourcePath = options.swiftSourcePath || path.join(__dirname, 'scripts', 'macos-dock-overlay.swift');
  const ttlMs = (Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0)
    ? Number(options.ttlMs)
    : DEFAULT_TTL_MS;
  const disableSpawn = options.disableSpawn === true;
  const hasCustomExecFile = typeof options.execFile === 'function';
  const hasCustomSpawn = typeof options.spawn === 'function';
  const spawnFn = hasCustomSpawn ? options.spawn : spawn;
  const execFileFn = hasCustomExecFile ? options.execFile : execFile;

  const initialUiPrefs = options.uiPreferences !== undefined ? options.uiPreferences : loadInitialUiPrefsSafe();
  let prefs = normalizeDockBadgePrefs(initialUiPrefs);

  const windows = new Map();
  let stopped = false;
  let ttlTimer = null;
  let previewState = null;
  let previewTimer = null;

  let swiftcAvailable = supported ? null : false;
  let compiled = false;
  let compiling = false;
  let compileErrorCode = '';
  let compileError = '';
  let compileErrorDetail = '';
  let compiledBinPath = '';
  let compiledAppPath = '';
  let compiledHash = '';
  let compilePromise = null;

  function clearCompileError() {
    compileErrorCode = '';
    compileError = '';
    compileErrorDetail = '';
  }

  function setCompileError(code, message, detail = '') {
    compileErrorCode = code || '';
    compileError = message || '';
    compileErrorDetail = String(detail || '').trim().slice(0, 400);
  }

  let helperChild = null;
  let helperStoppingPromise = null;
  let helperStdoutBuf = '';
  let helperStderrTail = '';
  let helperStartedAt = 0;
  let restartAttempts = 0;
  let restartTimer = null;
  let lastSentFrameJson = '';

  let launchMode = 'spawn';
  let triedAppBundleFallback = false;
  let switchingToAppBundle = false;
  let socketServer = null;
  let socketClient = null;
  let socketPath = '';
  let socketBuf = '';
  let socketConnectTimer = null;

  let axTrusted = null;
  let dockFound = null;
  let iconSide = 0;

  function computeSourceHash8() {
    const src = fs.readFileSync(swiftSourcePath);
    return crypto.createHash('sha256').update(src).digest('hex').slice(0, 8);
  }

  function cleanupOldBinaries(keepFilename) {
    try {
      if (!fs.existsSync(binDir)) return;
      const entries = fs.readdirSync(binDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!ent.name.startsWith(CACHE_BINARY_PREFIX)) continue;
        if (keepFilename && ent.name === keepFilename) continue;
        // 跳过同进程或别的进程正在临时编译中的文件（超过 5 分钟再清理）
        if (ent.name.includes('.tmp-')) {
          try {
            const st = fs.statSync(path.join(binDir, ent.name));
            if (Date.now() - st.mtimeMs < 300000) continue;
          } catch {}
        }
        try {
          fs.unlinkSync(path.join(binDir, ent.name));
        } catch {}
      }
    } catch {}
  }

  function cleanupSocketArtifacts() {
    if (socketConnectTimer) {
      clearTimeout(socketConnectTimer);
      socketConnectTimer = null;
    }
    if (socketClient) {
      try { socketClient.destroy(); } catch {}
      socketClient = null;
    }
    if (socketServer) {
      try { socketServer.close(); } catch {}
      socketServer = null;
    }
    if (socketPath) {
      try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
      socketPath = '';
    }
    socketBuf = '';
  }

  function isHelperActive() {
    if (launchMode === 'app-bundle') {
      return Boolean(socketClient && !socketClient.destroyed && socketClient.writable);
    }
    return Boolean(helperChild && !helperChild.killed && helperChild.exitCode === null);
  }

  async function ensureCompiled() {
    if (!supported || disableSpawn || stopped) return false;

    let hash8 = '';
    try {
      if (!fs.existsSync(swiftSourcePath)) {
        setCompileError(
          'MISSING_SOURCE',
          '缺少 Dock 图标提醒所需的原生组件文件（现有配置不受影响），请重新下载或更新插件后重试',
          swiftSourcePath
        );
        compiled = false;
        return false;
      }
      hash8 = computeSourceHash8();
    } catch (err) {
      setCompileError(
        'READ_SOURCE_FAILED',
        '暂时无法读取 Dock 图标提醒的组件文件，请检查文件夹读取权限后重试',
        err?.message || '读取原生浮层源码失败'
      );
      compiled = false;
      return false;
    }

    const appPath = path.join(binDir, APP_BUNDLE_DIRNAME);
    const contentsDir = path.join(appPath, 'Contents');
    const macOsDir = path.join(contentsDir, 'MacOS');
    const resourcesDir = path.join(contentsDir, 'Resources');
    const infoPlistPath = path.join(contentsDir, 'Info.plist');
    const execPath = path.join(macOsDir, APP_EXECUTABLE_NAME);
    const hashFilePath = path.join(resourcesDir, 'source.sha256');
    const macTargetArch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    const macTargetTriple = `${macTargetArch}-apple-macosx13.0`;
    const expectedBuildSig = `${hash8}-mac13-${macTargetArch}`;

    try {
      if (fs.existsSync(execPath) && fs.existsSync(infoPlistPath) && fs.existsSync(hashFilePath)) {
        const st = fs.statSync(execPath);
        const savedHash = fs.readFileSync(hashFilePath, 'utf8').trim();
        if (st.isFile() && st.size > 0 && savedHash === expectedBuildSig) {
          try { fs.chmodSync(execPath, 0o755); } catch {}
          compiledBinPath = execPath;
          compiledAppPath = appPath;
          compiledHash = hash8;
          compiled = true;
          clearCompileError();
          swiftcAvailable = true;
          cleanupOldBinaries('');
          return true;
        }
      }
    } catch {}

    if (compilePromise) {
      return await compilePromise;
    }

    compilePromise = (async () => {
      compiling = true;
      clearCompileError();
      try {
        if (!hasCustomExecFile) {
          const cltRes = await execFileAsync(execFileFn, 'xcode-select', ['-p'], { timeout: 3000 });
          if (!cltRes.ok || !cltRes.stdout.trim()) {
            swiftcAvailable = false;
            setCompileError(
              'NO_SWIFTC',
              '你的 Mac 尚未安装 Apple 命令行开发工具，暂时无法启用 Dock 图标提醒（其他功能不受影响）；请在「终端」运行 xcode-select --install 安装后重试',
              cltRes.stderr || cltRes.error?.message || 'xcode-select -p unavailable'
            );
            compiled = false;
            return false;
          }
        }
        const verRes = await execFileAsync(execFileFn, 'swiftc', ['--version'], { timeout: 5000 });
        if (!verRes.ok) {
          swiftcAvailable = false;
          setCompileError(
            'NO_SWIFTC',
            '你的 Mac 尚未安装 Apple 命令行开发工具，暂时无法启用 Dock 图标提醒（其他功能不受影响）；请在「终端」运行 xcode-select --install 安装后重试',
            verRes.stderr || verRes.error?.message || 'swiftc --version unavailable'
          );
          compiled = false;
          return false;
        }
        swiftcAvailable = true;

        if (stopped) return false;
        fs.mkdirSync(macOsDir, { recursive: true });
        fs.mkdirSync(resourcesDir, { recursive: true });
        const tmpOut = path.join(binDir, `${APP_EXECUTABLE_NAME}.tmp-${process.pid}-${Date.now()}`);
        const compRes = await execFileAsync(
          execFileFn,
          'swiftc',
          ['-O', '-swift-version', '6', '-target', macTargetTriple, swiftSourcePath, '-o', tmpOut],
          { timeout: 60000 }
        );
        if (!compRes.ok || !fs.existsSync(tmpOut)) {
          try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
          const detail = (compRes.stderr || compRes.error?.message || 'swiftc 编译失败').trim().split(/\r?\n/)[0];
          setCompileError(
            'COMPILE_FAILED',
            'Dock 图标提醒组件编译未通过（原有功能不受影响），请确认系统开发工具版本兼容后重试',
            detail
          );
          compiled = false;
          return false;
        }
        fs.writeFileSync(infoPlistPath, buildOverlayInfoPlist(), 'utf8');
        try { fs.chmodSync(tmpOut, 0o755); } catch {}
        fs.renameSync(tmpOut, execPath);

        if (!hasCustomExecFile) {
          const signRes = await execFileAsync(
            execFileFn,
            'codesign',
            ['--force', '--sign', '-', '--identifier', APP_BUNDLE_IDENTIFIER, appPath],
            { timeout: 15000 }
          );
          if (!signRes.ok) {
            const signDetail = (signRes.stderr || signRes.error?.message || 'codesign 签名失败').trim().split(/\r?\n/)[0];
            setCompileError(
              'COMPILE_FAILED',
              'Dock 图标提醒组件签名未通过（原有功能不受影响），请重试或重启 Antigravity',
              signDetail
            );
            compiled = false;
            return false;
          }
        }

        fs.writeFileSync(hashFilePath, `${expectedBuildSig}\n`, 'utf8');
        compiledBinPath = execPath;
        compiledAppPath = appPath;
        compiledHash = hash8;
        compiled = true;
        clearCompileError();
        cleanupOldBinaries('');
        return true;
      } catch (err) {
        setCompileError(
          'COMPILE_FAILED',
          'Dock 图标提醒组件编译过程出现异常（原有功能不受影响），请重试或重启 Antigravity',
          err?.message || '编译原生 Dock 浮层失败'
        );
        compiled = false;
        return false;
      } finally {
        compiling = false;
        compilePromise = null;
      }
    })();

    return await compilePromise;
  }

  function buildFramePayload() {
    const agg = aggregateDockStates(windows, Date.now(), ttlMs);
    const activePreview = previewState && Date.now() < previewState.expiresAt ? previewState : null;
    const unread = activePreview ? Math.max(agg.unread, activePreview.unread) : agg.unread;
    const approval = activePreview ? Math.max(agg.approval, activePreview.approval) : agg.approval;
    const highRisk = Boolean(agg.highRisk || activePreview?.highRisk);
    const running = Boolean(agg.running || activePreview?.running);
    const hasContent = unread > 0 || approval > 0 || highRisk || running;
    const visible = Boolean(prefs.enabled && !stopped && hasContent);

    return {
      visible,
      unread,
      approval,
      highRisk,
      running,
      style: prefs.style,
      colorTier: prefs.colorTier,
      locale: (activePreview?.locale) || agg.locale || 'zh-CN'
    };
  }

  function writeFrameToHelper(frameObj, force = false) {
    const line = JSON.stringify(frameObj);
    if (launchMode === 'app-bundle') {
      if (!socketClient || socketClient.destroyed || !socketClient.writable) return false;
      if (!force && line === lastSentFrameJson) return true;
      try {
        socketClient.write(line + '\n');
        lastSentFrameJson = line;
        return true;
      } catch {
        return false;
      }
    }
    if (!helperChild || helperChild.killed || helperChild.exitCode !== null) return false;
    if (!helperChild.stdin || helperChild.stdin.destroyed || !helperChild.stdin.writable) return false;
    if (!force && line === lastSentFrameJson) return true;
    try {
      helperChild.stdin.write(line + '\n');
      lastSentFrameJson = line;
      return true;
    } catch {
      return false;
    }
  }

  async function switchToAppBundleMode() {
    if (switchingToAppBundle || stopped || !prefs.enabled) return false;
    if (!compiled || !compiledAppPath || hasCustomSpawn || disableSpawn) return false;
    switchingToAppBundle = true;
    triedAppBundleFallback = true;
    try {
      await stopHelperProcess();
      if (stopped || !prefs.enabled) return false;
      launchMode = 'app-bundle';
      restartAttempts = 0;
      return await startAppBundleViaLaunchServices();
    } finally {
      switchingToAppBundle = false;
    }
  }

  function handleHelperStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg && msg.type === 'status') {
        if (typeof msg.axTrusted === 'boolean') axTrusted = msg.axTrusted;
        if (typeof msg.dockFound === 'boolean') dockFound = msg.dockFound;
        if (typeof msg.iconSide === 'number' && Number.isFinite(msg.iconSide)) {
          iconSide = Math.max(0, Math.round(msg.iconSide));
        }
        if (
          msg.axTrusted === false &&
          launchMode === 'spawn' &&
          !triedAppBundleFallback &&
          !switchingToAppBundle &&
          !hasCustomSpawn &&
          !disableSpawn &&
          !stopped &&
          prefs.enabled &&
          compiledAppPath
        ) {
          void switchToAppBundleMode();
        }
      }
    } catch {}
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  async function startAppBundleViaLaunchServices() {
    if (!supported || disableSpawn || stopped || !prefs.enabled) return false;
    if (!compiled || !compiledAppPath) return false;
    if (helperStoppingPromise) return false;
    if (isHelperActive()) return true;

    clearRestartTimer();
    cleanupSocketArtifacts();
    lastSentFrameJson = '';

    const sockFile = path.join(os.tmpdir(), `ag-dock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.sock`);
    socketPath = sockFile;

    return await new Promise((resolve) => {
      let resolved = false;
      const done = (ok) => {
        if (resolved) return;
        resolved = true;
        resolve(ok);
      };

      const srv = net.createServer((conn) => {
        if (stopped || socketServer !== srv || socketClient) {
          try { conn.destroy(); } catch {}
          return;
        }
        if (socketConnectTimer) {
          clearTimeout(socketConnectTimer);
          socketConnectTimer = null;
        }
        socketClient = conn;
        socketBuf = '';
        helperStartedAt = Date.now();
        clearCompileError();
        conn.on('data', (chunk) => {
          socketBuf += chunk.toString('utf8');
          let nlIdx;
          while ((nlIdx = socketBuf.indexOf('\n')) !== -1) {
            const line = socketBuf.slice(0, nlIdx);
            socketBuf = socketBuf.slice(nlIdx + 1);
            handleHelperStdoutLine(line);
          }
        });
        conn.on('error', () => {});
        conn.on('close', () => {
          const uptimeMs = Date.now() - helperStartedAt;
          if (socketClient === conn) {
            socketClient = null;
            lastSentFrameJson = '';
          }
          if (uptimeMs >= 15000) restartAttempts = 0;
          if (!stopped && prefs.enabled && !helperStoppingPromise && !switchingToAppBundle && launchMode === 'app-bundle') {
            if (restartAttempts < 5) {
              restartAttempts += 1;
              const delayMs = Math.min(10000, 1000 * Math.pow(2, restartAttempts - 1));
              restartTimer = setTimeout(() => {
                restartTimer = null;
                void ensureHelperRunning();
              }, delayMs);
              restartTimer.unref?.();
            }
          }
        });
        writeFrameToHelper(buildFramePayload(), true);
        done(true);
      });

      srv.on('error', (err) => {
        cleanupSocketArtifacts();
        setCompileError(
          'SPAWN_FAILED',
          '无法创建 Dock 图标提醒本地通道（其他功能不受影响），请重试或重启 Antigravity',
          err?.message || 'unix socket listen failed'
        );
        done(false);
      });

      socketServer = srv;
      srv.listen(sockFile, () => {
        try { fs.chmodSync(sockFile, 0o600); } catch {}
        socketConnectTimer = setTimeout(() => {
          socketConnectTimer = null;
          if (!socketClient && !resolved) {
            cleanupSocketArtifacts();
            done(false);
          }
        }, 6000);
        socketConnectTimer.unref?.();

        execFileFn(
          '/usr/bin/open',
          ['-g', '-n', '-a', compiledAppPath, '--args', '--socket', sockFile],
          { timeout: 6000 },
          (err, _stdout, stderr) => {
            if (err) {
              cleanupSocketArtifacts();
              setCompileError(
                'SPAWN_FAILED',
                '无法通过 LaunchServices 启动 AntigravityDockOverlay（其他功能不受影响），请重试或重启 Antigravity',
                (stderr ? String(stderr) : '') || err.message || 'open -a AntigravityDockOverlay failed'
              );
              done(false);
            }
          }
        );
      });
    });
  }

  function spawnHelperIfReady() {
    if (!supported || disableSpawn || stopped || !prefs.enabled) return false;
    if (!compiled || !compiledBinPath) return false;
    if (helperStoppingPromise) return false;
    if (helperChild && !helperChild.killed && helperChild.exitCode === null) return true;

    clearRestartTimer();
    lastSentFrameJson = '';
    helperStdoutBuf = '';
    helperStderrTail = '';

    let child;
    try {
      child = spawnFn(compiledBinPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      setCompileError(
        'SPAWN_FAILED',
        '无法启动 Dock 图标提醒后台组件（其他功能不受影响），请重试或重启 Antigravity',
        err?.message || '拉起 Dock 浮层进程失败'
      );
      return false;
    }

    clearCompileError();
    helperChild = child;
    helperStartedAt = Date.now();

    child.stdout?.on('data', (chunk) => {
      helperStdoutBuf += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = helperStdoutBuf.indexOf('\n')) !== -1) {
        const line = helperStdoutBuf.slice(0, nlIdx);
        helperStdoutBuf = helperStdoutBuf.slice(nlIdx + 1);
        handleHelperStdoutLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      helperStderrTail = (helperStderrTail + text).slice(-600);
    });

    child.stdin?.on('error', () => {});

    child.on('exit', () => {
      const uptimeMs = Date.now() - helperStartedAt;
      if (helperChild === child) {
        helperChild = null;
        lastSentFrameJson = '';
      }
      if (uptimeMs >= 15000) {
        restartAttempts = 0;
      }
      if (!stopped && prefs.enabled && !helperStoppingPromise && !switchingToAppBundle && launchMode === 'spawn') {
        if (restartAttempts < 5) {
          restartAttempts += 1;
          const delayMs = Math.min(10000, 1000 * Math.pow(2, restartAttempts - 1));
          restartTimer = setTimeout(() => {
            restartTimer = null;
            void ensureHelperRunning();
          }, delayMs);
          restartTimer.unref?.();
        }
      }
    });

    writeFrameToHelper(buildFramePayload(), true);
    return true;
  }

  async function ensureHelperRunning() {
    if (!supported || disableSpawn || stopped || !prefs.enabled) return false;
    if (helperStoppingPromise) {
      await helperStoppingPromise;
    }
    if (stopped || !prefs.enabled) return false;
    const ok = await ensureCompiled();
    if (!ok || stopped || !prefs.enabled) return false;
    if (launchMode === 'app-bundle') {
      return await startAppBundleViaLaunchServices();
    }
    return spawnHelperIfReady();
  }

  function stopHelperProcess() {
    clearRestartTimer();
    if (helperStoppingPromise) return helperStoppingPromise;

    if (socketClient || socketServer || socketPath) {
      helperStoppingPromise = new Promise((resolve) => {
        const conn = socketClient;
        if (conn && !conn.destroyed && conn.writable) {
          try {
            const hideFrame = JSON.stringify({
              visible: false,
              unread: 0,
              approval: 0,
              highRisk: false,
              running: false,
              style: prefs.style,
              colorTier: prefs.colorTier,
              locale: 'zh-CN'
            });
            conn.write(hideFrame + '\n');
            conn.end();
          } catch {}
        }
        setTimeout(() => {
          cleanupSocketArtifacts();
          lastSentFrameJson = '';
          helperStoppingPromise = null;
          resolve();
        }, 80);
      });
      return helperStoppingPromise;
    }

    const child = helperChild;
    if (!child || child.exitCode !== null) {
      helperChild = null;
      lastSentFrameJson = '';
      return Promise.resolve();
    }

    helperStoppingPromise = new Promise((resolve) => {
      let done = false;
      let termTimer = null;
      let killTimer = null;

      const finish = () => {
        if (done) return;
        done = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (helperChild === child) {
          helperChild = null;
        }
        lastSentFrameJson = '';
        helperStoppingPromise = null;
        resolve();
      };

      child.once('exit', finish);

      try {
        const hideFrame = JSON.stringify({
          visible: false,
          unread: 0,
          approval: 0,
          highRisk: false,
          running: false,
          style: prefs.style,
          colorTier: prefs.colorTier,
          locale: 'zh-CN'
        });
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(hideFrame + '\n');
          child.stdin.end();
        }
      } catch {}

      termTimer = setTimeout(() => {
        if (done) return;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          if (done) return;
          try { child.kill('SIGKILL'); } catch {}
          finish();
        }, 250);
        killTimer.unref?.();
      }, 400);
      termTimer.unref?.();
    });

    return helperStoppingPromise;
  }

  function syncOverlayFrame() {
    if (!supported || disableSpawn || stopped || !prefs.enabled) return;
    if (isHelperActive()) {
      writeFrameToHelper(buildFramePayload(), false);
    } else if (!compilePromise && !helperStoppingPromise && !restartTimer && !switchingToAppBundle) {
      void ensureHelperRunning();
    }
  }

  function ensureTtlTimer() {
    if (windows.size === 0) {
      if (ttlTimer) {
        clearInterval(ttlTimer);
        ttlTimer = null;
      }
      return;
    }
    if (ttlTimer) return;
    ttlTimer = setInterval(() => {
      const now = Date.now();
      let pruned = false;
      for (const [wid, entry] of windows.entries()) {
        if (!entry || entry.offline === true || now - Number(entry.updatedAt || 0) > ttlMs) {
          windows.delete(wid);
          pruned = true;
        }
      }
      if (windows.size === 0) {
        clearInterval(ttlTimer);
        ttlTimer = null;
      }
      if (pruned) {
        syncOverlayFrame();
      }
    }, 3000);
    ttlTimer.unref?.();
  }

  function updateWindowState(payload) {
    if (stopped || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: '无效的窗口状态对象' };
    }
    const rawId = typeof payload.windowId === 'string' ? payload.windowId.trim() : '';
    if (!rawId || rawId.length > 128) {
      return { ok: false, error: '缺少有效的 windowId' };
    }

    if (payload.offline === true) {
      windows.delete(rawId);
      ensureTtlTimer();
      syncOverlayFrame();
      return { ok: true, removed: true, status: getStatus() };
    }

    let cleanUnreadIds;
    if (Array.isArray(payload.unreadIds)) {
      const seen = new Set();
      for (const item of payload.unreadIds) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed || trimmed.length > 128 || /[\x00-\x1f\x7f]/.test(trimmed)) continue;
        seen.add(trimmed);
        if (seen.size >= 200) break;
      }
      cleanUnreadIds = Array.from(seen);
    }

    const entry = {
      windowId: rawId,
      unreadCount: clampInt(payload.unreadCount ?? payload.unread ?? (cleanUnreadIds ? cleanUnreadIds.length : 0), 0, MAX_UNREAD_TOTAL),
      ...(cleanUnreadIds !== undefined ? { unreadIds: cleanUnreadIds } : {}),
      approvalCount: clampInt(payload.approvalCount ?? payload.approval ?? 0, 0, MAX_APPROVAL_TOTAL),
      highRisk: Boolean(payload.highRisk),
      running: Boolean(payload.running),
      locale: normalizeLocale(payload.locale) || 'zh-CN',
      offline: false,
      updatedAt: Date.now()
    };
    windows.set(rawId, entry);
    ensureTtlTimer();
    syncOverlayFrame();

    return { ok: true, status: getStatus() };
  }

  function clearPreviewTimer() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
  }

  function applyPreferences(uiPrefs) {
    const prevEnabled = prefs.enabled;
    prefs = normalizeDockBadgePrefs(uiPrefs);
    if (stopped) return prefs;

    if (!prefs.enabled) {
      clearPreviewTimer();
      previewState = null;
      void stopHelperProcess();
    } else if (supported && !disableSpawn) {
      if (!prevEnabled || !isHelperActive()) {
        restartAttempts = 0;
        void ensureHelperRunning();
      } else {
        writeFrameToHelper(buildFramePayload(), true);
      }
    }
    return prefs;
  }

  async function triggerTestPreview(optsOrDuration = DEFAULT_TEST_PREVIEW_MS) {
    if (!supported) {
      return {
        ok: false,
        supported: false,
        errorCode: 'UNSUPPORTED',
        error: '当前使用的是非 macOS 系统，Dock 图标提醒仅支持苹果电脑（不影响其他功能使用）'
      };
    }
    if (!prefs.enabled) {
      return {
        ok: false,
        supported: true,
        errorCode: 'DISABLED',
        error: '你尚未开启「启用 macOS Dock 图标提醒」开关，请先打开该开关后再点「测试提醒」'
      };
    }
    if (stopped) {
      return {
        ok: false,
        supported: true,
        errorCode: 'STOPPED',
        error: 'Dock 图标提醒服务当前已停止（现有配置不受影响），请重启 Antigravity 后重试'
      };
    }

    const optsObj = (optsOrDuration && typeof optsOrDuration === 'object' && !Array.isArray(optsOrDuration))
      ? optsOrDuration
      : { durationMs: optsOrDuration };
    const rawDur = Number(optsObj.durationMs !== undefined ? optsObj.durationMs : DEFAULT_TEST_PREVIEW_MS);
    const safeDuration = Number.isFinite(rawDur) ? clampInt(rawDur, 100, 15000) : DEFAULT_TEST_PREVIEW_MS;
    const previewLocale = normalizeLocale(optsObj.locale) || 'zh-CN';
    if (!disableSpawn) {
      const ok = await ensureHelperRunning();
      if (!ok) {
        return {
          ok: false,
          supported: true,
          errorCode: 'HELPER_START_FAILED',
          error: compileError || 'Dock 图标提醒组件暂时未能启动（现有配置不受影响），请确认辅助功能权限或重启 Antigravity 后重试',
          status: getStatus()
        };
      }
    }

    clearPreviewTimer();
    previewState = {
      unread: 3,
      approval: 2,
      highRisk: false,
      running: false,
      locale: previewLocale,
      expiresAt: Date.now() + safeDuration
    };
    writeFrameToHelper(buildFramePayload(), true);

    previewTimer = setTimeout(() => {
      previewTimer = null;
      previewState = null;
      syncOverlayFrame();
    }, safeDuration);
    previewTimer.unref?.();

    return { ok: true, testing: true, durationMs: safeDuration, status: getStatus() };
  }

  async function openAccessibilitySettings() {
    if (!supported) {
      return {
        ok: false,
        supported: false,
        errorCode: 'UNSUPPORTED',
        error: '当前使用的是非 macOS 系统，无法打开苹果电脑的「辅助功能」设置'
      };
    }
    if (disableSpawn) {
      return { ok: true, dryRun: true };
    }
    if (compiled && compiledAppPath && !hasCustomExecFile) {
      try {
        await execFileAsync(
          execFileFn,
          '/usr/bin/open',
          ['-g', '-n', '-a', compiledAppPath, '--args', '--prompt-ax'],
          { timeout: 3000 }
        );
      } catch {}
    }
    const res = await execFileAsync(
      execFileFn,
      'open',
      ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'],
      { timeout: 5000 }
    );
    if (!res.ok) {
      return {
        ok: false,
        errorCode: 'OPEN_AX_FAILED',
        error: '未能自动打开「系统设置」，请手动前往「系统设置 → 隐私与安全性 → 辅助功能」勾选 AntigravityDockOverlay（或 Antigravity）的权限'
      };
    }
    return { ok: true };
  }

  function getStatus() {
    const agg = aggregateDockStates(windows, Date.now(), ttlMs);
    const helperRunning = isHelperActive();
    return {
      ok: true,
      supported,
      platform,
      enabled: prefs.enabled,
      style: prefs.style,
      colorTier: prefs.colorTier,
      autoClear: prefs.autoClear,
      swiftcAvailable,
      compiled,
      compiling,
      compileErrorCode,
      compileError,
      compileErrorDetail,
      binaryHash: compiledHash,
      binaryPath: compiled ? compiledBinPath : '',
      appBundlePath: compiled ? compiledAppPath : '',
      launchMode,
      helperRunning,
      helperPid: helperRunning && launchMode === 'spawn' ? (helperChild?.pid || null) : null,
      axTrusted,
      dockFound,
      iconSide,
      previewActive: Boolean(previewState && Date.now() < previewState.expiresAt),
      windowCount: agg.windowCount,
      aggregated: agg,
      lastStderr: helperStderrTail || ''
    };
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearRestartTimer();
    clearPreviewTimer();
    previewState = null;
    if (ttlTimer) {
      clearInterval(ttlTimer);
      ttlTimer = null;
    }
    windows.clear();
    await stopHelperProcess();
  }

  if (options.autoStart !== false && supported && prefs.enabled && !disableSpawn) {
    void ensureHelperRunning();
  }

  return {
    updateWindowState,
    applyPreferences,
    triggerTestPreview,
    openAccessibilitySettings,
    getStatus,
    stop
  };
}

module.exports = {
  createMacosDockBadgeManager,
  aggregateDockStates,
  normalizeDockBadgePrefs,
  isDockOverlaySupportedPlatform
};

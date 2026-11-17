'use strict';
/**
 * 跨平台终端探测、原生路径选择器与 CLI 多终端启动模块 (meter-terminals.js)
 * 支持 macOS (Terminal.app / iTerm2 / Ghostty / Warp / Rex / Kitty / WezTerm / Alacritty)、
 * Windows (PowerShell / CMD / Git Bash / WSL / Warp / Windows Terminal) 与 Linux 主流终端，
 * 并支持自定义可执行程序 / .app 路径。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

function escapePosixArg(arg) {
  const s = String(arg ?? '');
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function escapeAppleScriptString(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function escapePowerShellSingleQuoted(str) {
  return String(str ?? '').replace(/'/g, "''");
}

function escapeYamlDoubleQuoted(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function expandHomePath(rawPath, homedir = os.homedir()) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homedir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homedir, trimmed.slice(2));
  }
  return trimmed;
}

function toWslPath(winPath) {
  const s = String(winPath || '').trim();
  const match = s.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  if (/^[a-zA-Z]:$/.test(s)) {
    return `/mnt/${s[0].toLowerCase()}`;
  }
  return s.replace(/\\/g, '/');
}

function findInPath(binName, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const rawPath = env.PATH || env.Path || '';
  const dirs = String(rawPath).split(sep).filter(Boolean);
  for (const dir of dirs) {
    const cand = pathMod.join(dir, binName);
    try {
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return null;
}

function firstExistingPath(candidates = [], options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const homedir = options.homedir || os.homedir();
  for (const raw of candidates) {
    if (!raw) continue;
    const expanded = expandHomePath(raw, homedir);
    try {
      if (existsSync(expanded)) return expanded;
    } catch {}
  }
  return null;
}

function normalizeMacAppBinary(appOrBinPath, innerRelBin) {
  if (!appOrBinPath) return null;
  if (appOrBinPath.endsWith('.app') && innerRelBin) {
    return path.posix.join(appOrBinPath, 'Contents', 'MacOS', innerRelBin);
  }
  return appOrBinPath;
}

const TERMINAL_CATALOG = {
  darwin: [
    {
      id: 'auto',
      name: '自动默认 (Terminal.app)',
      description: '使用系统默认 AppleScript 启动 Terminal.app',
      detect: () => '/System/Applications/Utilities/Terminal.app'
    },
    {
      id: 'terminal',
      name: 'Terminal (系统终端)',
      description: 'macOS 内置终端',
      detect: (ctx) => firstExistingPath([
        '/System/Applications/Utilities/Terminal.app',
        '/Applications/Utilities/Terminal.app'
      ], ctx)
    },
    {
      id: 'iterm2',
      name: 'iTerm2',
      description: 'macOS 经典专业终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/iTerm.app',
        '~/Applications/iTerm.app'
      ], ctx)
    },
    {
      id: 'ghostty',
      name: 'Ghostty',
      description: '原生 GPU 加速现代终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/Ghostty.app',
        '~/Applications/Ghostty.app',
        '/opt/homebrew/bin/ghostty',
        '/usr/local/bin/ghostty'
      ], ctx) || findInPath('ghostty', ctx)
    },
    {
      id: 'warp',
      name: 'Warp',
      description: '现代化 AI 协同终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/Warp.app',
        '/Applications/WarpPreview.app',
        '~/Applications/Warp.app',
        '~/Applications/WarpPreview.app'
      ], ctx)
    },
    {
      id: 'rex',
      name: 'Rex',
      description: '多工作区原生协同终端 (支持正式版与 Beta 版)',
      detect: (ctx) => firstExistingPath([
        '/Applications/Rex.app',
        '/Applications/Rex Beta.app',
        '~/Applications/Rex.app',
        '~/Applications/Rex Beta.app',
        '~/.rex/bin/rex'
      ], ctx) || findInPath('rex', ctx)
    },
    {
      id: 'kitty',
      name: 'Kitty',
      description: '基于 GPU 的跨平台轻量终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/kitty.app',
        '~/Applications/kitty.app',
        '/opt/homebrew/bin/kitty',
        '/usr/local/bin/kitty'
      ], ctx) || findInPath('kitty', ctx)
    },
    {
      id: 'wezterm',
      name: 'WezTerm',
      description: 'Rust 编写的 GPU 跨平台多路终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/WezTerm.app',
        '~/Applications/WezTerm.app',
        '/opt/homebrew/bin/wezterm',
        '/usr/local/bin/wezterm'
      ], ctx) || findInPath('wezterm', ctx)
    },
    {
      id: 'alacritty',
      name: 'Alacritty',
      description: '极简高速 OpenGL 终端',
      detect: (ctx) => firstExistingPath([
        '/Applications/Alacritty.app',
        '~/Applications/Alacritty.app',
        '/opt/homebrew/bin/alacritty',
        '/usr/local/bin/alacritty'
      ], ctx) || findInPath('alacritty', ctx)
    },
    {
      id: 'custom',
      name: '自定义程序路径',
      description: '手动输入或浏览选择本机任意终端应用 / 脚本',
      isCustom: true,
      detect: (ctx) => {
        const custom = expandHomePath(ctx.customPath, ctx.homedir);
        return (custom && ctx.existsSync(custom)) ? custom : null;
      }
    }
  ],
  win32: [
    {
      id: 'auto',
      name: '自动默认 (原生居中控制台)',
      description: '内置窗口居中定位与焦点激活',
      detect: () => 'cmd.exe'
    },
    {
      id: 'powershell',
      name: 'PowerShell',
      description: '优先使用 PowerShell 7 (pwsh.exe)，回退 Windows PowerShell',
      detect: (ctx) => {
        const sysRoot = ctx.env.SystemRoot || ctx.env.windir || 'C:\\Windows';
        return firstExistingPath([
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
          path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        ], ctx) || findInPath('pwsh.exe', ctx) || findInPath('powershell.exe', ctx);
      }
    },
    {
      id: 'cmd',
      name: 'CMD (命令提示符)',
      description: 'Windows 标准命令行窗口',
      detect: (ctx) => {
        const sysRoot = ctx.env.SystemRoot || ctx.env.windir || 'C:\\Windows';
        return firstExistingPath([
          ctx.env.ComSpec,
          path.win32.join(sysRoot, 'System32', 'cmd.exe')
        ], ctx) || findInPath('cmd.exe', ctx);
      }
    },
    {
      id: 'gitbash',
      name: 'Git Bash',
      description: 'Git for Windows 附带的 Bash 终端环境',
      detect: (ctx) => {
        const localApp = ctx.env.LOCALAPPDATA || path.win32.join(ctx.homedir, 'AppData', 'Local');
        const userProf = ctx.env.USERPROFILE || ctx.homedir;
        return firstExistingPath([
          'C:\\Program Files\\Git\\git-bash.exe',
          'C:\\Program Files (x86)\\Git\\git-bash.exe',
          path.win32.join(localApp, 'Programs', 'Git', 'git-bash.exe'),
          path.win32.join(userProf, 'scoop', 'apps', 'git', 'current', 'git-bash.exe')
        ], ctx) || findInPath('git-bash.exe', ctx);
      }
    },
    {
      id: 'wsl',
      name: 'WSL (Linux 子系统)',
      description: 'Windows Subsystem for Linux 终端环境',
      detect: (ctx) => {
        const sysRoot = ctx.env.SystemRoot || ctx.env.windir || 'C:\\Windows';
        const localApp = ctx.env.LOCALAPPDATA || path.win32.join(ctx.homedir, 'AppData', 'Local');
        return firstExistingPath([
          path.win32.join(sysRoot, 'System32', 'wsl.exe'),
          path.win32.join(localApp, 'Microsoft', 'WindowsApps', 'wsl.exe')
        ], ctx) || findInPath('wsl.exe', ctx);
      }
    },
    {
      id: 'warp',
      name: 'Warp',
      description: 'Warp for Windows 现代终端',
      detect: (ctx) => {
        const localApp = ctx.env.LOCALAPPDATA || path.win32.join(ctx.homedir, 'AppData', 'Local');
        return firstExistingPath([
          path.win32.join(localApp, 'Programs', 'Warp', 'warp.exe'),
          'C:\\Program Files\\Warp\\warp.exe'
        ], ctx) || findInPath('warp.exe', ctx);
      }
    },
    {
      id: 'wt',
      name: 'Windows Terminal',
      description: '微软现代多标签终端 (wt.exe)',
      detect: (ctx) => {
        const localApp = ctx.env.LOCALAPPDATA || path.win32.join(ctx.homedir, 'AppData', 'Local');
        return firstExistingPath([
          path.win32.join(localApp, 'Microsoft', 'WindowsApps', 'wt.exe')
        ], ctx) || findInPath('wt.exe', ctx);
      }
    },
    {
      id: 'custom',
      name: '自定义程序路径',
      description: '手动输入或浏览选择 .exe / .cmd / .bat 终端程序',
      isCustom: true,
      detect: (ctx) => {
        const custom = expandHomePath(ctx.customPath, ctx.homedir);
        return (custom && ctx.existsSync(custom)) ? custom : null;
      }
    }
  ],
  linux: [
    {
      id: 'auto',
      name: '自动默认 (系统终端)',
      description: '自动探测可用的 Linux 图形终端',
      detect: () => 'x-terminal-emulator'
    },
    { id: 'gnome-terminal', name: 'GNOME Terminal', description: 'GNOME 桌面默认终端', detect: (ctx) => findInPath('gnome-terminal', ctx) },
    { id: 'konsole', name: 'Konsole', description: 'KDE 桌面终端', detect: (ctx) => findInPath('konsole', ctx) },
    { id: 'kitty', name: 'Kitty', description: 'GPU 加速终端', detect: (ctx) => findInPath('kitty', ctx) },
    { id: 'wezterm', name: 'WezTerm', description: 'GPU 加速跨平台终端', detect: (ctx) => findInPath('wezterm', ctx) },
    { id: 'alacritty', name: 'Alacritty', description: '高速 OpenGL 终端', detect: (ctx) => findInPath('alacritty', ctx) },
    { id: 'xfce4-terminal', name: 'XFCE Terminal', description: 'XFCE 轻量终端', detect: (ctx) => findInPath('xfce4-terminal', ctx) },
    { id: 'xterm', name: 'XTerm', description: '标准 X11 终端', detect: (ctx) => findInPath('xterm', ctx) },
    {
      id: 'custom',
      name: '自定义程序路径',
      description: '手动输入或选择本机终端可执行文件',
      isCustom: true,
      detect: (ctx) => {
        const custom = expandHomePath(ctx.customPath, ctx.homedir);
        return (custom && ctx.existsSync(custom)) ? custom : null;
      }
    }
  ]
};

function detectAvailableTerminals(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const customPath = String(options.customPath || '').trim();
  const existsSync = options.existsSync || fs.existsSync;

  const ctx = { platform, env, homedir, customPath, existsSync };
  const catalog = TERMINAL_CATALOG[platform] || TERMINAL_CATALOG.linux;

  const terminals = catalog.map((item) => {
    let executablePath = null;
    try {
      executablePath = item.detect(ctx) || null;
    } catch {
      executablePath = null;
    }
    const installed = item.id === 'auto' ? true : Boolean(executablePath);
    return {
      id: item.id,
      name: item.name,
      platform,
      installed,
      executablePath: executablePath || (item.isCustom ? customPath : null) || null,
      description: item.description,
      isCustom: Boolean(item.isCustom)
    };
  });

  return {
    ok: true,
    platform,
    terminals,
    defaultTerminalId: 'auto'
  };
}

function writeWarpLaunchConfig({ homedir, platform, env, cwd, commandLine, mkdirSync, writeFileSync }) {
  const configDir = platform === 'win32'
    ? path.win32.join(env.APPDATA || path.win32.join(homedir, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'launch_configurations')
    : path.posix.join(homedir, '.warp', 'launch_configurations');
  const configPath = platform === 'win32'
    ? path.win32.join(configDir, 'antigravity_cli.yaml')
    : path.posix.join(configDir, 'antigravity_cli.yaml');

  const yamlContent = [
    '---',
    'name: antigravity_cli',
    'windows:',
    '  - tabs:',
    '      - title: Antigravity CLI',
    '        layout:',
    `          cwd: "${escapeYamlDoubleQuoted(cwd)}"`,
    '          commands:',
    `            - exec: "${escapeYamlDoubleQuoted(commandLine)}"`
  ].join('\n') + '\n';

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, yamlContent, 'utf8');
  return { configPath, yamlContent, uri: 'warp://launch/antigravity_cli' };
}

function buildShellStrings({ cwd, cliInfo, cliArgs, terminalName, testOnly }) {
  const safeCwd = escapePosixArg(cwd);
  if (testOnly) {
    const msg = `[Antigravity Suite] 终端连接测试成功 (${terminalName})`;
    const posixInner = `printf '\\n%s\\n\\n' ${escapePosixArg(msg)}; pwd`;
    const posixFull = `cd ${safeCwd} && ${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`;
    return { posixInner, posixFull };
  }
  const safeCli = escapePosixArg(cliInfo?.exePath || 'agy');
  const safeArgs = (Array.isArray(cliArgs) ? cliArgs : []).map(escapePosixArg).join(' ');
  const posixInner = safeArgs ? `${safeCli} ${safeArgs}` : safeCli;
  const posixFull = `cd ${safeCwd} && ${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`;
  return { posixInner, posixFull };
}

function launchInConfiguredTerminal(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const existsSync = options.existsSync || fs.existsSync;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const chmodSync = options.chmodSync || fs.chmodSync;
  const spawnImpl = options.spawnImpl || spawn;
  const dryRun = options.dryRun === true;
  const testOnly = options.testOnly === true;

  const terminalId = String(options.terminalApp || 'auto').trim().toLowerCase() || 'auto';
  const customTerminalPath = expandHomePath(options.customTerminalPath || '', homedir);
  const cwd = options.cwd || process.cwd();
  const cliInfo = options.cliInfo || { cliPath: 'agy', exePath: 'agy', source: testOnly ? 'test' : 'default' };
  const cliArgs = Array.isArray(options.cliArgs) ? options.cliArgs : [];

  const detected = detectAvailableTerminals({ platform, env, homedir, customPath: customTerminalPath, existsSync });
  const targetEntry = detected.terminals.find((t) => t.id === terminalId);

  if (!targetEntry) {
    return {
      ok: false,
      code: 'TERMINAL_UNKNOWN',
      error: `不支持的终端配置: ${terminalId}`,
      terminalId,
      cwd
    };
  }

  if (terminalId === 'custom') {
    if (!customTerminalPath) {
      return {
        ok: false,
        code: 'CUSTOM_PATH_EMPTY',
        error: '已选择“自定义程序路径”，但尚未填写或选择终端程序路径。',
        terminalId,
        cwd
      };
    }
    if (!existsSync(customTerminalPath)) {
      return {
        ok: false,
        code: 'TERMINAL_NOT_FOUND',
        error: `指定的自定义终端路径不存在: ${customTerminalPath}`,
        terminalId,
        customTerminalPath,
        cwd
      };
    }
  } else if (terminalId !== 'auto' && !targetEntry.installed) {
    return {
      ok: false,
      code: 'TERMINAL_NOT_FOUND',
      error: `本机未检测到 ${targetEntry.name}，请在设置中确认安装状态或改用自定义路径。`,
      terminalId,
      terminal: targetEntry.name,
      cwd
    };
  }

  const { posixInner, posixFull } = buildShellStrings({
    cwd,
    cliInfo,
    cliArgs,
    terminalName: targetEntry.name,
    testOnly
  });

  let spawnSpec = null;
  let extraArtifacts = null;

  try {
    if (platform === 'darwin') {
      const execPath = targetEntry.executablePath;
      if (terminalId === 'auto' || terminalId === 'terminal') {
        const script = `tell application "Terminal"\n  do script "${escapeAppleScriptString(posixFull)}"\n  activate\nend tell`;
        spawnSpec = { file: 'osascript', args: ['-e', script], options: { detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'iterm2') {
        const escapedCmd = escapeAppleScriptString(posixFull);
        const script = [
          'tell application "iTerm"',
          '  activate',
          '  try',
          '    set newWin to (create window with default profile)',
          `    tell current session of newWin to write text "${escapedCmd}"`,
          '  on error',
          '    tell current window',
          '      create tab with default profile',
          `      tell current session to write text "${escapedCmd}"`,
          '    end tell',
          '  end try',
          'end tell'
        ].join('\n');
        spawnSpec = { file: 'osascript', args: ['-e', script], options: { detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'rex') {
        const escapedCmd = escapeAppleScriptString(posixInner);
        const escapedCwd = escapeAppleScriptString(cwd);
        const script = [
          'tell application id "com.superlogical.rex"',
          '  activate',
          `  run command "${escapedCmd}" at "${escapedCwd}"`,
          'end tell'
        ].join('\n');
        spawnSpec = { file: 'osascript', args: ['-e', script], options: { detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'warp') {
        if (!dryRun || options.allowDryWrite) {
          extraArtifacts = writeWarpLaunchConfig({
            homedir,
            platform,
            env,
            cwd,
            commandLine: posixInner,
            mkdirSync,
            writeFileSync
          });
        } else {
          extraArtifacts = {
            configPath: path.posix.join(homedir, '.warp', 'launch_configurations', 'antigravity_cli.yaml'),
            uri: 'warp://launch/antigravity_cli',
            commandLine: posixInner
          };
        }
        spawnSpec = { file: '/usr/bin/open', args: ['warp://launch/antigravity_cli'], options: { detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'ghostty') {
        if (execPath && execPath.endsWith('.app')) {
          spawnSpec = {
            file: '/usr/bin/open',
            args: ['-na', execPath, '--args', `--working-directory=${cwd}`, '-e', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        } else {
          spawnSpec = {
            file: execPath || 'ghostty',
            args: [`--working-directory=${cwd}`, '-e', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        }
      } else if (terminalId === 'kitty') {
        if (execPath && execPath.endsWith('.app')) {
          spawnSpec = {
            file: '/usr/bin/open',
            args: ['-na', execPath, '--args', '--directory', cwd, '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        } else {
          spawnSpec = {
            file: execPath || 'kitty',
            args: ['--directory', cwd, '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        }
      } else if (terminalId === 'wezterm') {
        const wezBin = normalizeMacAppBinary(execPath, 'wezterm') || 'wezterm';
        spawnSpec = {
          file: wezBin,
          args: ['start', '--cwd', cwd, '--', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
          options: { cwd, env, detached: true, stdio: 'ignore' }
        };
      } else if (terminalId === 'alacritty') {
        if (execPath && execPath.endsWith('.app')) {
          spawnSpec = {
            file: '/usr/bin/open',
            args: ['-na', execPath, '--args', '--working-directory', cwd, '-e', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        } else {
          spawnSpec = {
            file: execPath || 'alacritty',
            args: ['--working-directory', cwd, '-e', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        }
      } else if (terminalId === 'custom') {
        if (customTerminalPath.endsWith('.app')) {
          const cmdFile = path.join(os.tmpdir(), 'ag-suite-cli-launch.command');
          const scriptBody = `#!/bin/zsh\ncd ${escapePosixArg(cwd)}\n${posixInner}\nexec "\${SHELL:-/bin/zsh}" -i\n`;
          if (!dryRun || options.allowDryWrite) {
            writeFileSync(cmdFile, scriptBody, 'utf8');
            chmodSync(cmdFile, 0o755);
          }
          extraArtifacts = { commandFile: cmdFile, scriptBody };
          spawnSpec = {
            file: '/usr/bin/open',
            args: ['-a', customTerminalPath, cmdFile],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        } else {
          spawnSpec = {
            file: customTerminalPath,
            args: ['-e', '/bin/zsh', '-lic', `${posixInner}; exec "\${SHELL:-/bin/zsh}" -i`],
            options: { cwd, env, detached: true, stdio: 'ignore' }
          };
        }
      }
    } else if (platform === 'win32') {
      const execPath = targetEntry.executablePath;
      const winExecLower = String(terminalId === 'custom' ? customTerminalPath : (execPath || '')).toLowerCase();
      const buildPsCmd = () => {
        const psCwd = escapePowerShellSingleQuoted(cwd);
        if (testOnly) {
          return `Set-Location -LiteralPath '${psCwd}'; Write-Host '[Antigravity Suite] 终端连接测试成功 (PowerShell)' -ForegroundColor Cyan`;
        }
        const psExe = escapePowerShellSingleQuoted(cliInfo.exePath);
        const psArgs = cliArgs.map((a) => `'${escapePowerShellSingleQuoted(a)}'`).join(' ');
        return `Set-Location -LiteralPath '${psCwd}'; & '${psExe}' ${psArgs}`;
      };
      const buildCmdCmd = () => {
        if (testOnly) {
          return `cd /d "${cwd}" && echo [Antigravity Suite] Terminal test OK (${targetEntry.name})`;
        }
        const cmdArgs = cliArgs.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
        return `cd /d "${cwd}" && "${cliInfo.exePath}" ${cmdArgs}`;
      };

      const dispatchWinKind = (() => {
        if (terminalId !== 'custom') return terminalId;
        if (winExecLower.endsWith('pwsh.exe') || winExecLower.endsWith('powershell.exe')) return 'powershell';
        if (winExecLower.endsWith('cmd.exe')) return 'cmd';
        if (winExecLower.endsWith('git-bash.exe') || winExecLower.includes('bash.exe')) return 'gitbash';
        if (winExecLower.endsWith('wsl.exe')) return 'wsl';
        if (winExecLower.endsWith('warp.exe')) return 'warp';
        if (winExecLower.endsWith('wt.exe')) return 'wt';
        return 'raw_custom';
      })();

      if (dispatchWinKind === 'powershell') {
        const psBin = terminalId === 'custom' ? customTerminalPath : (execPath || 'powershell.exe');
        spawnSpec = {
          file: psBin,
          args: ['-NoExit', '-Command', buildPsCmd()],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false }
        };
      } else if (dispatchWinKind === 'cmd' || dispatchWinKind === 'auto') {
        const cmdBin = terminalId === 'custom' ? customTerminalPath : (execPath || 'cmd.exe');
        spawnSpec = {
          file: cmdBin,
          args: ['/s', '/k', `"${buildCmdCmd()}"`],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }
        };
      } else if (dispatchWinKind === 'gitbash') {
        const gbBin = terminalId === 'custom' ? customTerminalPath : execPath;
        const gbCmd = testOnly
          ? `printf '\\n[Antigravity Suite] 终端连接测试成功 (Git Bash)\\n'; pwd; exec bash -i`
          : `${escapePosixArg(toWslPath(cliInfo.exePath).replace(/^\/mnt\/([a-z])\//, '/$1/'))} ${cliArgs.map(escapePosixArg).join(' ')}; exec bash -i`;
        spawnSpec = {
          file: gbBin,
          args: [`--cd=${cwd}`, '-i', '-c', gbCmd],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false }
        };
      } else if (dispatchWinKind === 'wsl') {
        const wslBin = terminalId === 'custom' ? customTerminalPath : (execPath || 'wsl.exe');
        const wslCwd = toWslPath(cwd);
        const wslInner = testOnly
          ? `printf '\\n[Antigravity Suite] 终端连接测试成功 (WSL)\\n'; pwd; exec bash -i`
          : `if command -v agy >/dev/null 2>&1; then agy ${cliArgs.map(escapePosixArg).join(' ')}; else ${escapePosixArg(toWslPath(cliInfo.exePath))} ${cliArgs.map(escapePosixArg).join(' ')}; fi; exec bash -i`;
        spawnSpec = {
          file: wslBin,
          args: ['--cd', cwd, '--', 'bash', '-lic', `cd ${escapePosixArg(wslCwd)} && ${wslInner}`],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false }
        };
      } else if (dispatchWinKind === 'warp') {
        const warpExecCmd = testOnly
          ? `echo [Antigravity Suite] Terminal test OK (Warp)`
          : `"${cliInfo.exePath}" ${cliArgs.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ')}`;
        if (!dryRun || options.allowDryWrite) {
          extraArtifacts = writeWarpLaunchConfig({
            homedir,
            platform,
            env,
            cwd,
            commandLine: warpExecCmd,
            mkdirSync,
            writeFileSync
          });
        } else {
          extraArtifacts = {
            configPath: path.win32.join(env.APPDATA || path.win32.join(homedir, 'AppData', 'Roaming'), 'warp', 'Warp', 'data', 'launch_configurations', 'antigravity_cli.yaml'),
            uri: 'warp://launch/antigravity_cli',
            commandLine: warpExecCmd
          };
        }
        spawnSpec = {
          file: 'cmd.exe',
          args: ['/c', 'start', '', 'warp://launch/antigravity_cli'],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: true }
        };
      } else if (dispatchWinKind === 'wt') {
        const wtBin = terminalId === 'custom' ? customTerminalPath : (execPath || 'wt.exe');
        spawnSpec = {
          file: wtBin,
          args: ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', buildPsCmd()],
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false }
        };
      } else {
        spawnSpec = {
          file: customTerminalPath,
          args: testOnly ? [] : cliArgs,
          options: { cwd, env, detached: true, stdio: 'ignore', windowsHide: false }
        };
      }
    } else {
      // Linux
      const execPath = terminalId === 'custom' ? customTerminalPath : (targetEntry.executablePath || terminalId);
      if (terminalId === 'gnome-terminal') {
        spawnSpec = { file: execPath, args: ['--working-directory', cwd, '--', 'bash', '-lic', `${posixInner}; exec bash`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'konsole') {
        spawnSpec = { file: execPath, args: ['--workdir', cwd, '-e', 'bash', '-lic', `${posixInner}; exec bash`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'kitty') {
        spawnSpec = { file: execPath, args: ['--directory', cwd, 'bash', '-lic', `${posixInner}; exec bash`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'wezterm') {
        spawnSpec = { file: execPath, args: ['start', '--cwd', cwd, '--', 'bash', '-lic', `${posixInner}; exec bash`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      } else if (terminalId === 'alacritty') {
        spawnSpec = { file: execPath, args: ['--working-directory', cwd, '-e', 'bash', '-lic', `${posixInner}; exec bash`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      } else {
        spawnSpec = { file: execPath, args: ['-e', `bash -lic ${escapePosixArg(posixFull)}`], options: { cwd, env, detached: true, stdio: 'ignore' } };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        testOnly,
        platform,
        terminalId,
        terminal: targetEntry.name,
        executablePath: targetEntry.executablePath || customTerminalPath || null,
        cliPath: cliInfo.cliPath,
        exePath: cliInfo.exePath,
        cwd,
        cwdSource: options.wsSource || 'custom',
        model: options.model || null,
        skipPermissions: Boolean(options.skipPermissions),
        args: cliArgs,
        spawnSpec,
        extraArtifacts
      };
    }

    const child = spawnImpl(spawnSpec.file, spawnSpec.args, spawnSpec.options);
    child?.unref?.();

    return {
      ok: true,
      testOnly,
      platform,
      nativePlacement: false,
      fallback: false,
      terminalId,
      terminal: targetEntry.name,
      executablePath: targetEntry.executablePath || customTerminalPath || null,
      pid: child?.pid || null,
      cliPath: cliInfo.cliPath,
      exePath: cliInfo.exePath,
      cliSource: cliInfo.source,
      cwd,
      cwdSource: options.wsSource || 'custom',
      model: options.model || null,
      skipPermissions: Boolean(options.skipPermissions),
      args: cliArgs
    };
  } catch (err) {
    return {
      ok: false,
      code: 'TERMINAL_LAUNCH_ERROR',
      terminalId,
      terminal: targetEntry?.name || terminalId,
      error: `使用 ${targetEntry?.name || terminalId} 启动失败: ${err?.message || err}`,
      cliPath: cliInfo.cliPath,
      cwd
    };
  }
}

async function pickTerminalExecutableDialog(options = {}) {
  const platform = options.platform || process.platform;
  const electronDialog = options.electronDialog || null;
  const targetWin = options.targetWin || null;

  if (electronDialog && typeof electronDialog.showOpenDialog === 'function') {
    const dialogOpts = platform === 'darwin'
      ? { title: '选择终端应用程序', defaultPath: '/Applications', properties: ['openFile'] }
      : platform === 'win32'
        ? {
            title: '选择终端程序',
            defaultPath: 'C:\\Program Files',
            filters: [
              { name: '可执行程序', extensions: ['exe', 'cmd', 'bat'] },
              { name: '所有文件', extensions: ['*'] }
            ],
            properties: ['openFile']
          }
        : { title: '选择终端可执行文件', defaultPath: '/usr/bin', properties: ['openFile'] };

    const res = targetWin
      ? await electronDialog.showOpenDialog(targetWin, dialogOpts)
      : await electronDialog.showOpenDialog(dialogOpts);
    if (!res || res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) {
      return { ok: true, canceled: true, path: '' };
    }
    const picked = String(res.filePaths[0]).replace(/\/+$/, '');
    return { ok: true, canceled: false, path: picked };
  }

  return new Promise((resolve) => {
    if (platform === 'darwin') {
      const script = 'POSIX path of (choose file with prompt "请选择终端应用程序 (.app 或可执行文件)" default location POSIX file "/Applications")';
      execFile('osascript', ['-e', script], { timeout: 60000 }, (err, stdout) => {
        if (err) {
          const msg = String(err.message || '');
          if (err.code === 1 || /cancel|-128/i.test(msg)) {
            resolve({ ok: true, canceled: true, path: '' });
          } else {
            resolve({ ok: false, error: msg || '打开系统文件选择器失败' });
          }
          return;
        }
        const picked = String(stdout || '').trim().replace(/\/+$/, '');
        resolve(picked ? { ok: true, canceled: false, path: picked } : { ok: true, canceled: true, path: '' });
      });
    } else if (platform === 'win32') {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$f = New-Object System.Windows.Forms.OpenFileDialog;',
        "$f.Title = '选择终端可执行程序';",
        "$f.Filter = 'Executables (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat|All files (*.*)|*.*';",
        "if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write($f.FileName) }"
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 60000, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: err.message || '打开文件选择对话框失败' });
          return;
        }
        const picked = String(stdout || '').trim();
        resolve(picked ? { ok: true, canceled: false, path: picked } : { ok: true, canceled: true, path: '' });
      });
    } else {
      execFile('zenity', ['--file-selection', '--title=选择终端可执行文件'], { timeout: 60000 }, (err, stdout) => {
        if (err) {
          if (err.code === 1) resolve({ ok: true, canceled: true, path: '' });
          else resolve({ ok: false, error: '当前环境未安装 zenity 文件对话框，请手动输入终端路径' });
          return;
        }
        const picked = String(stdout || '').trim();
        resolve(picked ? { ok: true, canceled: false, path: picked } : { ok: true, canceled: true, path: '' });
      });
    }
  });
}

module.exports = {
  TERMINAL_CATALOG,
  expandHomePath,
  toWslPath,
  detectAvailableTerminals,
  launchInConfiguredTerminal,
  pickTerminalExecutableDialog
};

#!/usr/bin/env bash
set -euo pipefail

# Antigravity 免改包增强套件 — macOS CLI 与随客户端自启守护一键配置脚本
# 零硬编码用户名，全部路径基于 $HOME 与当前仓库目录动态生成。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_SRC="$REPO_DIR/bin/ag-context-meter"
LOCAL_BIN_DIR="$HOME/.local/bin"
BIN_DEST="$LOCAL_BIN_DIR/ag-context-meter"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
CURRENT_USER="$(id -un | tr -cd 'a-zA-Z0-9._-')"
LABEL="${AG_LIVE_LABEL:-com.${CURRENT_USER}.ag-live-helper}"
PLIST_PATH="$LAUNCH_AGENTS_DIR/${LABEL}.plist"
LOG_PATH="$HOME/Library/Logs/antigravity-hans.log"
PORT_FILE="$HOME/Library/Application Support/Antigravity/DevToolsActivePort"
SOCKET_FILE="$HOME/Library/Application Support/Antigravity/SingletonSocket"

ENABLE_AUTO=1
DISABLE_REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --no-auto)
      ENABLE_AUTO=0
      ;;
    --no-remote)
      DISABLE_REMOTE=1
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./scripts/setup-macos-cdp.sh [选项]

选项:
  --no-auto    仅配置 ~/.local/bin/ag-context-meter 软链，不写入 LaunchAgent 后台自启守护
  --no-remote  仅启用桌面端界面增强，禁用 18765 手机远程监听端口
  -h, --help   显示帮助信息
EOF
      exit 0
      ;;
    *)
      echo "未知选项: $arg" >&2
      exit 1
      ;;
  esac
done

# 1. 检查 Node.js 运行时版本（需 >= 22.4，内置 WebSocket / fetch）
DEFAULT_NODE_PATHS="${AG_DEFAULT_NODE_PATHS-/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin}"
if [ -n "$DEFAULT_NODE_PATHS" ]; then
  export PATH="${DEFAULT_NODE_PATHS}:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  for cand in \
    "$HOME/.volta/bin" \
    "$HOME/.asdf/shims" \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.fnm/current/bin" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin"
  do
    if [ -x "$cand/node" ]; then
      export PATH="$cand:$PATH"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  NVM_NODES_DIR="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [ -d "$NVM_NODES_DIR" ]; then
    while IFS= read -r nvm_ver; do
      [ -n "$nvm_ver" ] || continue
      if [ -x "$NVM_NODES_DIR/$nvm_ver/bin/node" ]; then
        export PATH="$NVM_NODES_DIR/$nvm_ver/bin:$PATH"
        break
      fi
    done < <(ls -1 "$NVM_NODES_DIR" 2>/dev/null | sort -V -r)
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 node，请先安装 Node.js 22.4+（例如：brew install node@22）" >&2
  exit 1
fi
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 4)) {
  console.error(`❌ 当前 Node.js 版本 (${process.versions.node}) 过低，需要 >= 22.4.0`);
  process.exit(1);
}
'
NODE_BIN_DIR="$(node -e 'const fs = require("fs"), path = require("path"); console.log(path.dirname(fs.realpathSync(process.execPath)));' 2>/dev/null || dirname "$(command -v node)")"

# 2. 配置 ~/.local/bin/ag-context-meter 软链
chmod +x "$BIN_SRC"
mkdir -p "$LOCAL_BIN_DIR"
ln -sf "$BIN_SRC" "$BIN_DEST"
echo "✅ 已链接 CLI 命令: $BIN_DEST -> $BIN_SRC"

# 若目标不在标准目录 ~/.local/share/antigravity-suite，自动创建软链以便直接定位
STANDARD_SHARE_DIR="$HOME/.local/share/antigravity-suite"
if [ ! -e "$STANDARD_SHARE_DIR" ]; then
  mkdir -p "$(dirname "$STANDARD_SHARE_DIR")"
  ln -s "$REPO_DIR" "$STANDARD_SHARE_DIR"
  echo "✅ 已建立运行目录软链: $STANDARD_SHARE_DIR -> $REPO_DIR"
fi

# 3. 仅在开启自启时写入 LaunchAgent（传 --no-auto 时零写入系统后台自启目录）
if [ "$ENABLE_AUTO" -eq 1 ]; then
  LAUNCHD_PATH="$(NODE_BIN_DIR="$NODE_BIN_DIR" node -e '
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const items = [process.env.NODE_BIN_DIR, "/opt/homebrew/opt/node@22/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
console.log(escXml(Array.from(new Set(items.filter(Boolean))).join(":")));
')"
  REMOTE_ENV_ENTRY=""
  AUTO_ARGS=()
  if [ "$DISABLE_REMOTE" -eq 1 ]; then
    REMOTE_ENV_ENTRY="    <key>AG_DISABLE_MOBILE_REMOTE</key>
    <string>1</string>
"
    AUTO_ARGS+=(--no-remote)
  fi
  ENV_BLOCK="  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${LAUNCHD_PATH}</string>
${REMOTE_ENV_ENTRY}  </dict>
"
  mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN_DEST}</string>
    <string>_auto-trigger</string>
  </array>
${ENV_BLOCK}  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>5</integer>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>WatchPaths</key>
  <array>
    <string>${PORT_FILE}</string>
    <string>${SOCKET_FILE}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF
  echo "✅ 已写入 LaunchAgent 配置文件: $PLIST_PATH"
  "$BIN_DEST" auto-on ${AUTO_ARGS[@]:+"${AUTO_ARGS[@]}"}
else
  echo "⚪ 已跳过 LaunchAgent 后台自启守护 (--no-auto)，可随时手动运行：ag-context-meter live${DISABLE_REMOTE:+ --no-remote}"
fi

echo ""
echo "📋 安装状态与提示："
if [ -r "$PORT_FILE" ]; then
  echo "  - 已检测到 Antigravity DevToolsActivePort（CDP 就绪）"
elif command -v lsof >/dev/null 2>&1 && lsof -nP -a -c Antigravity -iTCP -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  - 已通过进程端口监听检测到运行中的 Antigravity（免读 DevToolsActivePort 文件）"
else
  echo "  - 当前未检测到运行中的 Antigravity CDP 端口：请确认 Antigravity 已开启远程调试端口，或重新启动 Antigravity。"
fi

echo "  - 安全说明：本脚本 100% 零修改 Antigravity.app / app.asar；若无需后台自启可加 --no-auto，若仅需桌面增强（关闭 18765 手机远程端口）可加 --no-remote 或设置 AG_DISABLE_MOBILE_REMOTE=1"

case ":$PATH:" in
  *":$LOCAL_BIN_DIR:"*)
    echo "  - 可以直接在终端执行：ag-context-meter status / live / stop / auto-on / auto-off"
    ;;
  *)
    echo "  - 提示：请将 $LOCAL_BIN_DIR 加入 ~/.zshrc PATH："
    echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
    echo "  - 也可直接使用：$BIN_DEST status"
    ;;
esac

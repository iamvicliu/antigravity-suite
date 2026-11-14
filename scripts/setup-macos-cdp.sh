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

ENABLE_AUTO=1
for arg in "$@"; do
  case "$arg" in
    --no-auto)
      ENABLE_AUTO=0
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./scripts/setup-macos-cdp.sh [选项]

选项:
  --no-auto   仅配置 ~/.local/bin/ag-context-meter 软链，不安装 LaunchAgent 自启守护
  -h, --help  显示帮助信息
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
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
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

# 2. 配置 ~/.local/bin/ag-context-meter 软链
chmod +x "$BIN_SRC"
mkdir -p "$LOCAL_BIN_DIR"
ln -sf "$BIN_SRC" "$BIN_DEST"
echo "✅ 已链接 CLI 命令: $BIN_DEST -> $BIN_SRC"

# 若目标不在标准目录 ~/.local/share/antigravity-context-viewer，可由用户设置环境变量或创建软链以便直接定位
STANDARD_SHARE_DIR="$HOME/.local/share/antigravity-context-viewer"
if [ ! -e "$STANDARD_SHARE_DIR" ]; then
  mkdir -p "$(dirname "$STANDARD_SHARE_DIR")"
  ln -s "$REPO_DIR" "$STANDARD_SHARE_DIR"
  echo "✅ 已建立运行目录软链: $STANDARD_SHARE_DIR -> $REPO_DIR"
fi

# 3. 写入 LaunchAgent（通过 WatchPaths 监听 DevToolsActivePort，随 Antigravity 启动自动挂载）
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
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${PORT_FILE}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF
echo "✅ 已写入 LaunchAgent 配置文件: $PLIST_PATH"

if [ "$ENABLE_AUTO" -eq 1 ]; then
  "$BIN_DEST" auto-on
fi

echo ""
echo "📋 安装状态与提示："
if [ -f "$PORT_FILE" ]; then
  echo "  - 已检测到 Antigravity DevToolsActivePort（CDP 就绪）"
else
  echo "  - 当前未检测到 DevToolsActivePort：请确认 Antigravity 已开启远程调试端口，或重新启动 Antigravity。"
fi

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

# Antigravity Suite

[简体中文](README.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

> **100% zero-patch enhancement & remote control suite for Google Antigravity desktop (macOS) — never modifies `app.asar` or Apple code signatures, safe across official updates, and instant to toggle.**

## Core Highlights

1. **🇨🇳 Instant Chinese / English UI Toggle (Zero-Token Local Thought Translation)**
   - Switch instantly between Simplified Chinese UI (+ zero-token local caching translation for Thinking blocks & titles) and original English right inside **`⚙️`**, without restarting.
2. **📱 4-Channel Mobile & Desktop Remote Control (Zero-Config Cloudflare Tunnel + Multi-Session Isolation)**
   - Scan a single QR code to chat, switch models/permissions, upload images, and approve actions over **LAN**, **Tailscale**, **Bonjour (`*.local`)**, or a **default-enabled no-login Cloudflare Quick Tunnel (`*.trycloudflare.com`)** (with custom named domain support and copy-paste `cloudflared` install guides for macOS / Windows / Linux).
   - Automatic concurrent latency probing picks the fastest route, merges cross-channel counts per device, blocks unchecked channels with HTTP `403`, and isolates active conversations/drafts per browser tab (`X-AG-Client-Id`).
   - Built-in mobile/remote top-bar drawers for live context window usage, local token stats, 9 configurable visibility toggles in **`⚙️` → Remote**, and **System / Light / Dark** appearance sync.
   - Multi-project grouped session switching, per-project new chats, and remote host directory browsing/project creation (strictly bounded within `$HOME` & registered workspaces with sensitive-path and symlink escape guards); composer uses `Enter` for newline and `Cmd/Ctrl + Enter` to send (with Safari IME composition protection).
3. **📊 Context Window, 240K Auto-Compact & Dual Quota Capsules**
   - Live top-bar ring meter, token breakdown, 52-week heatmap, API cost comparison, and **Gemini 4 / Claude** 5-hour + weekly quota capsules (`G4` / `C`).
   - Official clients wait until 512K tokens to compact, often causing 4–5 minute full recomputation stalls after prompt cache expires past 250K–330K; real-time bottom-capsule & popover alerts detect 0% cache drops (328K risk), while default-enabled **240K Auto-Compact** triggers `/compact` automatically when idle.
4. **⚡ Composer Efficiency Suite & Quick Tools**
   - **14 built-in recommended quick actions** (grouped by scenario & priority with zero-latency two-line hover tooltips) plus custom quick prompts; slash commands (`/compact`, `/plan`, `/goal`, `/swarm`, `/boost`, `/teamwork`, etc.) automatically select from the Lexical slash menu into native command pills. Supports per-item **auto-send on click** for custom prompts, an opt-in toggle for built-in no-arg commands (`/compact`, Reload Rules), **`⌘/Ctrl + click`** to temporarily invert insert/send behavior, and non-destructive **draft protection** (never overwrites existing composer drafts).
   - One-click **`✨ Optimize` / `↩ Undo`** next to Send prefers fast low-tier models with multi-model fallback; `Tab` next-step suggestions truncate cleanly in-line with full-text hover tooltips.
   - Quick switch the top 9 conversations with **`⌘1`–`⌘9`** (or **`⌘⇧[` / `⌘⇧]`** / **`⌃Tab`**), edit right-side previews in-place with **`⌘S`**, and launch `agy` directly in your terminal (**`>_ CLI`**) with mux host support.
5. **🛡️ Dangerous Command Red-Frame Interception**
   - Highlights destructive shell commands (`rm -rf`, `git reset --hard`, `git clean -f`, `git push`, `sudo`, `kill -9`, `DROP/DELETE`, `op item`) with red warning frames and pauses for manual approval even when Auto-Accept is enabled.
6. **🔄 Auto Update Check & One-Click Hot Upgrade**
   - Automatically checks GitHub in the background; when a new version is available, **`⚙️`** shows a red dot so you can click **"立即更新" (Update Now)** and hot-reload without restarting Antigravity.

---

## 🚀 Zero-Patch Installation (macOS)

Requires **macOS**, **Google Antigravity**, and **Node.js `22.4.0+`**.

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> Optional flags: `--no-auto` skips installing the `LaunchAgent` auto-launcher (you can run `ag-context-meter install-launcher` to create a standalone app icon in `~/Applications`), and `--no-remote` (or `AG_DISABLE_MOBILE_REMOTE=1`) disables the remote control server.
>
> **Windows / Linux**: Start Antigravity with `--remote-debugging-port=9222` (or let CDP auto-detect), then run `node cli.js live` from the cloned directory (`node cli.js status` to check).

Add `~/.local/bin` to your shell `PATH` if needed:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
ag-context-meter status
```

---

## 🛠️ Daily Commands & Uninstall

| Command | Purpose |
| :--- | :--- |
| `ag-context-meter status` | Verify live modules, auto-launch daemon status, and untouched official `app.asar` |
| `ag-context-meter remote` | Print 4-channel pairing URLs, Cloudflare tunnel status, connected devices & QR code (`--tunnel on|off`, `--reset-token`, `--json`) |
| `ag-context-meter live` | Hot-inject into the running Antigravity window (`--no-remote` to disable remote server) |
| `ag-context-meter restart` | Safely relaunch Antigravity (`v2.33.0+`) with CDP debugging enabled and inject enhancements |
| `ag-context-meter update` | Pull latest `main` commits and hot-reload the running window without restarting |
| `ag-context-meter stop` | Temporarily unload enhancements for the current session |
| `ag-context-meter auto-off` / `auto-on` | Disable or re-enable automatic CDP injection on Antigravity launch |
| `ag-context-meter install-launcher` | Optional standalone launcher app in `~/Applications` for `--no-auto` setups |

**Complete uninstall**: run `ag-context-meter auto-off`, then remove the LaunchAgent plist (`~/Library/LaunchAgents/com.$(id -un).ag-live-helper.plist`), `~/.local/bin/ag-context-meter`, `~/.local/share/antigravity-context-viewer`, and optionally `~/Library/Application Support/AntigravityContextMeter`.

---

## 🔒 Security Principles

- **Untouched official app**: Legacy `app.asar` / binary patching commands are gated off; enhancements mount strictly via in-memory CDP injection.
- **Channel gates & random token**: Remote control enables private channels (`LAN` / `Tailscale` / `Bonjour`) plus the default no-login Cloudflare Quick Tunnel (toggleable anytime in **`⚙️` → Remote** or disabled via `--no-remote`). Disabled channels return HTTP `403`, every request verifies a 48-char random token (rotatable anytime), and named tunnel tokens are stored only locally (`0600`) in `remote-config.json`.
- **Path protection**: Inline file editing enforces blocklists against system directories and credential stores (`.ssh`, `.gnupg`, `1Password`, `Antigravity.app`).

---

## 🧪 Testing & Credits

```bash
npm run test:suite
```

For detailed troubleshooting, 5-tab settings overview, and upstream acknowledgements, see the full **[简体中文 README](README.md)**. Licensed under the [MIT License](LICENSE).

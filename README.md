# Antigravity Suite

> **专为 Google Antigravity 桌面端（macOS）打造的一站式免改包体验增强套件**

在不改动官方安装包的前提下，将**📱 手机远程操作 PWA（一码三用融合配对 · Wi-Fi / Tailscale / Bonjour 自动切网）**、**⚙️ 统一设置中心（多终端 CLI 启动 / 主题调色 / 套餐订阅 / 中英实时热切）**、**上下文与双池配额看板**、**全中文界面与零 Token 思考中译**、**右侧文件行内编辑**、**下一步 `Tab` 补全**以及**高危命令红框预警**直接注入桌面端，开箱即用：

- **零修改官方包**：不修改 `Antigravity.app` 原文件，保留 macOS 系统签名，官方升级不受影响
- **随客户端自启**：打开 Antigravity 自动挂载增强界面，关闭客户端自动休眠，无需手动启动
- **秒级无痕还原**：随时执行 `ag-context-meter stop`，即可立即卸下全部增强组件恢复原版

<p align="center">
  <img src="assets/mac-preview.png" alt="Antigravity Suite macOS 桌面端真实全景效果" width="100%">
</p>

---

## 一、装上它，能帮你解决哪 6 个日常痛点？

1. **📱 手机远程操作 PWA（一码三用融合配对 · 告别官方远程卡顿、杀后台与键盘遮挡）**
   - 官方 Remote 依赖 Google 云端中继，在手机 Safari 中常见加载慢、切后台断连与键盘遮挡输入框的问题。
   - **一码三用融合配对（Wi-Fi / Tailscale / Bonjour）**：点击桌面端右上角工具栏中的 **`「📱 远程」`**（弹窗标题 **`「手机远程操作配对」`**，或终端运行 `ag-context-meter remote`），生成**单枚高清融合二维码与单条配对链接**：同一套载荷同时嵌入 **`此 Wi-Fi`（物理局域网 IP）**、**`Tailscale`（Tailnet IP / MagicDNS `*.ts.net`）** 与 **`Bonjour`（`*.local` 局域网域名）** 多端点列表（弹窗下方三行状态清单支持点击切换引导主机，无需双 Tab 来回切码）。用 iPhone 扫码在 Safari 打开后点 **「分享」→「添加到主屏幕」**，即可作为**纯内网毫秒直连的全屏独立 App** 稳定使用。
   - **断线自动切网容灾 & 4G/5G 可用**：首次扫码会将多通道端点列表与凭证持久化至手机本地；室内切出门（Wi-Fi → 4G/5G Tailscale）或局域网重分配 IP 时，客户端并发探测 `GET /api/ping` 在毫秒级自动切换可用通道；服务端采用 IPv4/IPv6 双栈 `[::]:18765` 监听与私网 `Origin`/IP 白名单 + 48 位随机口令保护，可在弹窗点 **「重置密钥」**（或运行 `ag-context-meter remote --reset-token`）立即作废旧链接。
   - **流畅不遮挡 & 完整操控**：全宽无框 Markdown 排版、灵动岛与 `visualViewport` 键盘动态适配、切回前台 **50ms 内**瞬时重连；复刻 Mac 圆角输入卡，支持**全屏右滑切换会话**、内嵌**切换模型（`XHigh/High/Medium/Low`）与权限预设（含 `无限 (Turbo)`）**、**`+` 拍照/相册压缩传图**、**`G4/C` 双窗口配额**与**高危命令红框一键审批**。
   - **安全可控**：不碰账号鉴权与私有 API，所有对话均在桌面正版端运行，仅允许私网 IP 访问并带 48 位随机配对口令保护。

<p align="center">
  <img src="assets/mobile-preview.jpg" alt="手机极速 PWA 遥控真机效果（主对话界面与全屏右滑抽屉）" width="88%">
</p>

2. **🇨🇳 全中文界面 + 实时双语热切 + 英文思考中译（零大模型 Token）**
   - **完整本地汉化**：菜单、设置页、权限弹窗、报错提示全面中文化（适配 `2.32.1`，含 **2,282 条** 精确词条与 **239 条** 动态正则；并将权限 `Turbo` 统一译为 **`无限`**、模型徽章 `New` 统一译为 **`新增`**）。
   - **思考与标题自动中译**：AI 的英文**思考过程 (Thought)** 与左侧英文会话标题自动译为中文并本地缓存复用，**不消耗任何 AI 模型 Token**。
   - **免重启实时中英热切 & 防误折**：通过顶栏 **`⚙️ 统一设置`** 下拉框可在 **简体中文 / English** 间**免重启实时热切**，同步刷新宿主界面、Shadow DOM 看板（含 Token 概览卡片 `总计`/`今日`/`本月`/`本年` 与热力图浮窗）及底部能量胶囊，支持 `registerLocale` 扩展语言词典（已移除旧版左下角独立悬浮切换圆标）；正在阅读展开的思考块时，新消息到达不会自动折叠并保持滚动位置，手动重命名对话后自动锁定标题。

3. **📊 告别“额度与上下文盲盒”**
   - **顶栏合并看板**：将输出速率（`tok/s`）并入主上下文徽章，点击统一打开上下文与费用看板；查看提示词 / 思考 / 工具占比、**52 周使用热力图**与折算 API 账单（Token 概览卡片与热力图浮窗均已支持中英双语实时切换）。
   - **双模型配额池（`G4` / `C`）**：独立外置配额徽章，保留多子组 Gemini/Claude 额度池与 Google AI Ultra (`5x` / `20x`) Prompt / Flow 积分池；悬停或点开查看 **5 小时限额 + 每周限额** 双进度条和精准重置倒计时（支持 `0%` 耗尽精准展示）。
   - **输入框底部能量条 (`v1.4.0`)**：结合 `GetAvailableModels` 与实时会话预算动态解析每款模型上下文上限（`1M` / `512k` / `128k`），切换模型即时刷新分母，实时跟踪输出速度（`tok/s`）、缓存命中率与 5 小时窗口倒计时。

4. **⚡ 少打字、快翻找 + 一键多终端 CLI & 统一设置**
   - **顶栏 `>_ CLI` 与 `⚙️ 统一设置`**：一键用本地终端拉起 `agy` CLI 会话，支持自动探测 macOS / Windows 主流终端（Terminal、iTerm2、Ghostty、Warp、Kitty、WezTerm、cmux、Windows Terminal 等）或自定义终端路径，并可配置 `--dangerously-skip-permissions` 免审核与默认启动模型（或不指定模型跟随默认）；面板全部配置项已收敛至 `⚙️` 统一设置中心，展开浮层时自动提升完整祖先层叠上下文 (`z-index: 2147483646`)，彻底避免被宿主顶部栏遮挡。
   - **零 Token 下一步建议**：AI 回复结束后、输入框为空时自动推演 2～4 条下一步操作；按 **`Tab` 或 `→`** 一键补全，**`↓`/`↑`** 切换候选，**`Esc`** 收起（开始打字、唤醒 `@`/`/` 菜单或 AI 思考时自动隐藏）。
   - **输入区快捷胶囊**：常驻输入框上方，一键触发 `/compact` 压缩、`/plan` 规划、重载 `AGENTS`、复制会话 ID 与导出完整 Markdown。
   - **悬浮长对话电梯**：贴边悬浮于输入框右侧（移除内圈多余边框，采用匹配 Antigravity 原生视觉的 **shadcn/ui（Lucide）极简矢量描边图标**，平时仅露图标不遮文字，悬停展开标签），一键直达 **顶部**、**上一轮**、**下一轮**、**底部** 与 **展开/收起思考**。

5. **✏️ 右侧预览直接改文件 + 外链直达系统浏览器**
   - **所见即改**：在右侧预览 `.md` 方案或代码时，顶栏自动提供 **`✏️ 编辑`** 按钮——一键就地修改，按 **`⌘S` / `Ctrl+S`**（或点 `💾 保存`）写回硬盘，后台刷新也不会打断编辑，点 **`↩️ 完成`** 退出并同步预览。
   - **系统浏览器打开外链**：在聊天区或文档中按住 **`⌘ Cmd` + 点击**任意网址或 `` `https://...` `` 行内代码链接，直接用系统默认浏览器打开，不再被塞进右侧窄栏预览。

6. **🛡️ 省心又防闯祸（高危命令红框预警 + 安全自动确认）**
   - **安全步骤自动放行**：开启 **`🤖 自动确认`** 后，常规文件读写与安全步骤确认按钮将自动点击。
   - **高危指令强拦截**：一旦检测到 `rm -rf`、`git reset --hard`、`git clean -f`、`git push`、`sudo`、`kill -9`、`DROP/DELETE`、`op item` 等高危命令，卡片会立刻显示**醒目红框与顶部警示条**，且自动确认**强制跳过**，交由你人工把关。

---

## 二、各位置核心组件速查表

| 界面位置 | 组件名称 | 核心作用 |
| :--- | :--- | :--- |
| **顶栏右上工具条** | **手机远程配对 (`📱 远程`)** | 点击弹出「一码三用」融合配对二维码，展示 `此 Wi-Fi` / `Tailscale` / `Bonjour` 状态与切换、复制链接及重置密钥 |
| **顶栏右侧** | **上下文圆环 & 费用看板** | 合并展示上下文占用与输出速度；点开查看 Token 分类（`总计`/`今日`/`本月`/`本年`）、52 周热力图与 API 折算费用 |
| **顶栏右侧** | **模型额度双胶囊 (`G4` / `C`)** | 展示 Gemini 4 与 Claude/GPT 多子组余量与 Google AI Ultra (`5x`/`20x`) 积分池；看 **5h + 每周** 双进度条与倒计时 |
| **顶栏右侧** | **CLI 启动与统一设置 (`>_ CLI` · `⚙️`)** | 一键调起已探测的多端命令行（支持免审核与默认模型）；`⚙️` 集中管理主题配色、套餐订阅、网络直连与实时中英切换 |
| **全局界面** | **全汉化 + 实时双语 + 思考中译** | 全界面汉化（含 `Turbo → 无限` / `New → 新增`）、英文思考与标题缓存中译、防误折/防回弹、`⚙️` 内免重启秒切中英 |
| **右侧预览栏** | **行内编辑器 (`✏️ 编辑`)** | 查看文件时直接点击编辑、`⌘S` 保存回本地、`↩️ 完成` 退出并刷新预览 |
| **聊天主区** | **高危命令红框 (`🛡️`) & `⌘` 外链** | 高危指令自动红框警告；按住 `⌘ Cmd` 点击外链或代码内网址直接用系统浏览器打开 |
| **输入框上方** | **常用快捷胶囊栏** | 一键填入 `/compact`、`/plan `、重载 `AGENTS`；复制会话 UUID、导出 Markdown、开关自动确认、查看 Brain 缓存体积 |
| **输入框内部** | **下一步建议补全 (`Tab` / `→`)** | AI 回复后零 Token 智能推荐下一步动作，支持 `Tab` / `→` 填入、`↓`/`↑` 切换、`Esc` 隐藏 |
| **输入框右侧** | **长对话电梯** | 无内框 Lucide 极简矢量导航条，一键跳转顶部、上一轮、下一轮、底部或批量展开/收起思考块 |
| **输入框底边** | **实时能量条 (`Pulse v1.4.0`)** | 动态解析每款模型上下文上限（`1M`/`512k`/`128k`），实时显示生成速度（`tok/s`）、缓存命中与 5h 窗口倒计时 |

> ⚡ **可选内置 Agent 提速规则**：仓库内附带 [`rules/fast-io-AGENTS.md`](rules/fast-io-AGENTS.md)（源自 `oil-oil/agy-fast-io`），通过只读白名单命令绕过桌面端云端审查、同轮并行读文件及合并必审命令，可显著减少 AI 回合数与等待耗时，可直接并入你的全局 `AGENTS.md` / `CLAUDE.md`。

---

## 三、怎么安装？（二选一）

需要环境：**macOS + Node.js 22.4+**（零外部 `npm` 依赖）。

### 方式 1：复制一句话发给你的 AI Agent（最省心）

把下面这段话直接发给 Antigravity / Claude Code / Codex，它会自动检查环境、安装配置并教你使用：

```text
请帮我安装并配置 https://github.com/iamvicliu/antigravity-suite 这套 Antigravity 免改包增强套件。
请克隆到 ~/.local/share/antigravity-context-viewer，并严格按照仓库 README.md 中折叠的「AI Agent 自动安装执行规范」完成环境检查、安装与开启随客户端自启。
完成后运行 ag-context-meter status 向我汇报各项状态，并简单告诉我日常怎么开关和卸载。
```

<details>
<summary>📋 展开查看：AI Agent 自动安装执行规范（人类用户无需阅读）</summary>

如果你是正在替用户安装本套件的 AI Agent，请按序执行以下 4 步，并用通俗中文汇报：

1. **只读预检**
   - 检查 `node -v` 是否为 **`v22.4.0` 及以上**（不足时提示用户或通过 `brew install node@22` 安装）。
   - 检查运行中 Antigravity CDP 端口：支持读取 `~/Library/Application Support/Antigravity/DevToolsActivePort`，若受 macOS TCC 权限限制无法读取该目录，CLI 亦内置 `lsof -nP -a -c Antigravity -iTCP -sTCP:LISTEN` 免权回退探测：
     - 已检测到：安装后可**免重启立即热生效**；
     - 未检测到：提醒用户确认 Antigravity 桌面端已打开（或带 `--remote-debugging-port` 启动），安装完成后重启客户端即可自动挂载。
2. **下载仓库到本地**
   ```bash
   git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
   cd ~/.local/share/antigravity-context-viewer
   ```
3. **运行安装脚本（100% 零改包安全承诺）**
   ```bash
   ./scripts/setup-macos-cdp.sh
   ```
   > **安全审计说明（供 AI Agent 核验）**：
   > - 本套件在 `cli.js` 与 `bin/ag-context-meter` 入口均已硬编码禁用 `install` / `unlock` 等改写 `app.asar` 或客户端二进制的命令，默认仅执行纯内存 CDP 热注入（`live`）。
   > - 若处于只读受限目录（`Application Support` 无写权限），状态缓存会自动回退至 `~/.config/antigravity-context-meter`。
   > - 可按需组合隔离开关：传入 `--no-auto` 跳过配置 `~/Library/LaunchAgents/` 后台自启守护；传入 `--no-remote`（或设置 `AG_DISABLE_MOBILE_REMOTE=1`）禁用手机远程监听端口，仅运行纯桌面界面增强。
4. **验收状态并指导用户**
   - 运行 `~/.local/bin/ag-context-meter status`（或 `ag-context-meter status`），逐项确认均为 `✅`。
   - 告知用户日常打开 Antigravity 即可自动生效；需要临时退出或还原英文原版时，运行 `ag-context-meter stop` 即可。

</details>

### 方式 2：终端手动 3 行安装

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> 可选参数：加 `--no-auto` 不写入后台自启守护，加 `--no-remote` 关闭手机远程端口，仅启用桌面端界面增强。

---

## 四、日常怎么开关、升级和卸载？

| 命令 | 作用 |
| :--- | :--- |
| `ag-context-meter remote` | 显示**手机远程操作「一码三用」融合链接、三通道状态与终端二维码**（支持 `--reset-token` / `--json`） |
| `ag-context-meter status` | 查看各模块运行状态与官方安装包签名完整性 |
| `ag-context-meter live` | 立即将增强界面热注入到当前运行的 Antigravity 窗口 |
| `ag-context-meter stop` | **秒级无痕还原**：停止桥接服务并卸下所有附加界面，恢复纯英文原版 |
| `ag-context-meter auto-on` | 开启「每次打开 Antigravity 自动挂载」 |
| `ag-context-meter auto-off` | 关闭自动挂载并清理当前窗口增强界面 |
| `ag-context-meter upstreams` | 检查 6 个参考上游仓库更新并与基线账本 [`upstreams.json`](upstreams.json) 比对（内置 GitHub API 限流三段式回退） |

> 💡 **想让 AI Agent 帮你检查并安全合入参考项目更新？** 直接对 Agent 说：
> `请运行 ag-context-meter upstreams --json，过滤掉改写 app.asar / 二进制解锁的提交，把安全可吸收的新词条、新模型价格或好用的交互移植进项目并更新 upstreams.json 基线。`

---

## 五、安全性、跨平台与开源致谢

### 为什么这套方案很安全？

1. **绝不修改 `app.asar`**：不解包、不改包、不重签名 `/Applications/Antigravity.app/Contents/Resources/app.asar`，完整保留官方苹果代码签名。
2. **封堵高危底层补丁**：[`live-host.js`](live-host.js) 与 CLI 默认禁用所有二进制解锁与内核改包入口，避免破坏客户端完整性。
3. **本地数据与代码仓库隔离**：翻译缓存、自定义会话标题等保存在 `~/Library/Application Support/AntigravityContextMeter/`；侧边栏文件编辑器严格限制路径白名单，拒绝访问系统目录、`Antigravity.app` 与敏感凭据目录。

### 💻 为什么目前只提供 macOS 一键版？

1. **macOS 系统签名校验更严格**：直接改动客户端 `app.asar` 容易触发“应用已损坏”警告、丢失系统权限或影响官方更新，因此本套件重点针对 Mac 做了「零改包 CDP 热注入 + 自动监听恢复」适配。
2. **一键自启脚本依赖苹果 `launchd`**：[`setup-macos-cdp.sh`](scripts/setup-macos-cdp.sh) 与 [`ag-context-meter`](bin/ag-context-meter) 基于 `~/Library/LaunchAgents/` 监听客户端启动，暂未打包 Windows / Linux 一键守护脚本。
   - **Windows / Linux 也能用全部前端功能**：核心逻辑 [`cli.js`](cli.js)、[`live-host.js`](live-host.js) 及所有界面增强模块本身跨平台兼容；安装 Node.js 22.4+ 并在 Antigravity 开启调试端口后，执行 `node cli.js live` 即可使用（`node cli.js status` 查看状态）。

### 参考与致谢（Credits & Acknowledgements）

本套件吸收并整合了社区多位作者与贡献者的开源成果，谨此致谢：

| 参考项目 | 作者 / 贡献者 | 参考与吸收内容 |
| :--- | :--- | :--- |
| **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** | [@elviscjn-cjn](https://github.com/elviscjn-cjn)、[@Jia131313](https://github.com/Jia131313)、[@Azreal2021](https://github.com/Azreal2021)、[@MoiraToki](https://github.com/MoiraToki)、[@nocoo](https://github.com/nocoo) | 基础框架、顶部上下文圆环看板 (`v0.8.6`)、Token 分类统计与 52 周热力图、API 费用估算、5h+Weekly 双窗口配额与 `0%` 修复、占位符模型兜底与顶栏对齐优化 |
| **[akelabs/antigravity-pulse](https://github.com/akelabs/antigravity-pulse)** | [@akelabs](https://github.com/akelabs) | 输入框底部能量条 (`v1.3.1`)：输出速率、缓存命中与 5 小时窗口倒计时 |
| **[n2ns/antigravity-panel](https://github.com/n2ns/antigravity-panel)** | [@n2ns](https://github.com/n2ns) | 模型额度监控、Auto-Accept 安全自动确认与 Brain 缓存体积监控思路 |
| **[yiheng8023/antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese)** | [@yiheng8023](https://github.com/yiheng8023) | 适配 Antigravity `2.32.1` (`v3.3.48`) 的 **2,282 条** 精确词条与 **239 条** 动态正则规则 |
| **[wycocoyu/agy-context-dashboard](https://github.com/wycocoyu/agy-context-dashboard)** | [@wycocoyu](https://github.com/wycocoyu) | 轻量状态栏排布与指标展示思路（已整合去重） |
| **[oil-oil/agy-fast-io](https://github.com/oil-oil/agy-fast-io)** | [@oil-oil](https://github.com/oil-oil) | 桌面端 Fast IO 提速规则 (`v0.2.1`)：免审白名单命令、同轮并读与回合压缩规范 |

---

基于 [MIT License](LICENSE) 开源，所有参考或引入的第三方组件均完整保留其原始版权与开源协议。

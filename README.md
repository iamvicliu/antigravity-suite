# Antigravity Suite

> **Google Antigravity 桌面端（macOS）免改包全能增强套件**

把上下文用量、模型剩余额度、全界面汉化、防误触红框、下一步建议 `Tab` 补全和常用快捷操作直接挂进 Antigravity 界面里，开箱即用：

- **零修改官方包**：不动 `Antigravity.app` 原文件，不破坏 macOS 系统签名，不影响官方升级
- **无感随软件自启**：打开客户端自动挂载，关掉自动休眠
- **秒级无痕还原**：一条 `ag-context-meter stop` 立刻卸下所有附加界面，恢复纯英文原版

---

## 一、核心功能一览

### 界面增强模块（按屏幕位置）

| 界面位置 | 功能模块 | 能帮你做什么 |
| :--- | :--- | :--- |
| **顶栏右侧** | **上下文圆环看板** | 实时显示上下文占比（如 `179K (70%)`）与生成速度；点开查看提示词 / 思考 / 工具调用分类、**52 周使用热力图**及折算 API 费用，支持分模型设置预算上限 |
| **顶栏右侧** | **模型额度双胶囊 (`G4` / `C`)** | 直接展示 Gemini 4 / Claude 主力模型组的剩余额度百分比，悬停即可看到精确的重置倒计时 |
| **左下角 & 全局** | **全界面汉化 + 自动翻译** | 覆盖菜单、设置页、权限弹窗、报错与 `2.32.1` 新界面；英文 **思考过程 (Thought)** 与左侧英文对话标题自动译为中文并本地缓存复用（**零大模型 Token 消耗**）；**阅读思考过程时新消息到达不自动折叠且保留滚动位置**；**手动重命名对话标题后自动保护不被覆盖**；左下角 **`EN/中`** 随时秒切原版 |
| **右侧预览栏** | **文件行内编辑 (`✏️ 编辑`)** | 打开侧边栏查看 `.md` 或代码文件时，顶栏右侧控制区自动出现 **`✏️ 编辑`**；支持直接修改、**`⌘S` / `Ctrl+S`**（或点 `💾 保存`）写回本地硬盘并稳定保持编辑态不被后台巡检/重渲染跳回预览、**`↩️ 完成`** 退出编辑并刷新预览 |
| **聊天主区** | **危险命令红框预警 (`🛡️`)** | 当操作卡片或命令含 `rm -rf`、`git reset --hard`、`git clean -f`、`git push`、`sudo`、`kill -9`、`DROP/DELETE`、`op item` 等高危指令时，自动套红框与顶部警告条防误放行 |
| **聊天与文档链接** | **`⌘ + 点击` 直达系统浏览器** | 按住 `⌘ Cmd`（或 `Ctrl`）点击普通外链或 `` `https://...` `` 行内代码链接，直接调用系统默认浏览器打开，不再被强制塞进右侧内置小窗 |
| **输入框内部** | **下一步建议 + `Tab` 补全** | 输入框为空且 AI 空闲时，基于最后一条回复语义**零 Token** 智能生成 2～4 条下一步建议，支持 **`Tab`** 一键补全、**`↓` / `↑`** 切换候选、**`Esc`** 收起；开始输入、弹出 `@`/`/` 菜单或发送后 AI 处理中自动隐藏 |
| **输入框右侧外沿** | **长对话电梯** | 紧贴输入框正右侧的极窄图标条（平时仅显图标清晰易点、绝不挡消息，悬停向右展开文字）：`⏫ 顶部`、`🔼 上一轮`、`🔽 下一轮`、`⏬ 底部`、`💡 展开/收起思考` |
| **输入框底部** | **实时能量条 (`Pulse`)** | 紧贴输入框底边，实时滚动显示当前输出速度（`tok/s`）、上下文占比、缓存命中与 5 小时窗口倒计时 |

### 输入框上方快捷胶囊栏

| 按钮 | 点一下做什么 |
| :--- | :--- |
| `🗜️ /compact 压缩` | 自动填入 `/compact`，回车即可压缩历史上下文省额度 |
| `🎯 /plan 规划` | 自动填入 `/plan `，直接开始描述任务规划需求 |
| `🔄 重载规则` | 自动填入 `重新读取 AGENTS`，改完本地规则后一键让 AI 重新加载 |
| `📋 复制会话 ID` | 一键复制当前对话 UUID，方便排查日志或定位上下文目录 |
| `📝 导出 Markdown` | 把完整对话整理成干净的 Markdown，保存到 `~/Downloads` 并复制到剪贴板 |
| `🤖 自动确认: 关/开` | 默认关闭；开启后自动点击常规读写确认按钮，**遇到删除、拒绝、取消或标红高危命令时强制跳过** |
| `📦 缓存 xxxMB` | 只读统计 `~/.gemini/antigravity/brain` 缓存体积，悬停显示 Top 5 占用对话，点击刷新并复制明细（绝不删文件） |

> ⚡ **可选内置 Agent 提速规则**：仓库内附带 [`rules/fast-io-AGENTS.md`](rules/fast-io-AGENTS.md)（源自 `oil-oil/agy-fast-io`），通过只读白名单命令绕过桌面端云端审查、同轮并行读文件及合并必审命令，可显著减少 AI 回合数与等待耗时，可直接并入你的全局 `AGENTS.md` / `CLAUDE.md`。

---

## 二、怎么安装？（二选一）

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
   - 检查 `~/Library/Application Support/Antigravity/DevToolsActivePort` 是否存在：
     - 存在：安装后可**免重启立即热生效**；
     - 不存在：提醒用户确认 Antigravity 桌面端已打开（或带 `--remote-debugging-port` 启动），安装完成后重启客户端即可自动挂载。
2. **下载仓库到本地**
   ```bash
   git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
   cd ~/.local/share/antigravity-context-viewer
   ```
3. **运行安装与随客户端自启脚本**
   ```bash
   ./scripts/setup-macos-cdp.sh
   ```
   > 该脚本零修改官方包，会把管理命令软链到 `~/.local/bin/ag-context-meter`，并配置 `~/Library/LaunchAgents/` 监听 `DevToolsActivePort`（打开软件自动挂载、关闭自动休眠）。
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

> 如仅需命令行手动管理、不想开启“随客户端自动加载”，将最后一行改为 `./scripts/setup-macos-cdp.sh --no-auto`。

---

## 三、日常管理速查表

| 命令 | 作用 |
| :--- | :--- |
| `ag-context-meter status` | 查看全部功能状态与官方安装包签名完整性 |
| `ag-context-meter live` | 立即把增强界面热注入到当前运行的 Antigravity 窗口 |
| `ag-context-meter stop` | **秒级退场**：停止桥接服务并卸载附加界面，立即还原纯英文原版 |
| `ag-context-meter auto-on` | 开启「每次打开 Antigravity 自动挂载」 |
| `ag-context-meter auto-off` | 关闭自动挂载并清理当前窗口增强界面 |
| `ag-context-meter upstreams` | 检查 6 个参考上游仓库的最新更新并与本地基线账本 [`upstreams.json`](upstreams.json) 比对 |

> 💡 **想让 AI Agent 帮你检查并安全合入参考项目更新？** 直接对 Agent 说：
> `请运行 ag-context-meter upstreams --json，过滤掉改写 app.asar / 二进制解锁的提交，把安全可吸收的新词条、新模型价格或好用的交互移植进项目并更新 upstreams.json 基线。`

---

## 四、安全性与致谢

### 为什么这套方案很安全？

1. **绝不修改 `app.asar`**：不解包、不改包、不重签名 `/Applications/Antigravity.app/Contents/Resources/app.asar`，完全保持官方苹果签名完好。
2. **封堵高危底层补丁**：[`live-host.js`](live-host.js) 与 CLI 默认禁用所有二进制解锁与内核改包入口，避免误伤客户端完整性。
3. **本地数据与代码仓库隔离**：翻译缓存、自定义会话标题等均保存在 `~/Library/Application Support/AntigravityContextMeter/`，不写入代码仓库；侧边栏文件编辑器亦严格限制绝对路径访问，拒绝系统目录、`Antigravity.app` 与敏感凭据目录。

### 💻 为什么目前只提供 macOS 一键版？

1. **macOS 系统签名限制更严格**：macOS 的 Gatekeeper 会强校验应用签名，直接修改客户端 `app.asar` 很容易触发“应用已损坏”警告、丢失系统权限或影响官方更新，因此本套件重点针对 Mac 做了「零改包 CDP 热注入 + 自动监听恢复」的完整适配。
2. **自启与一键脚本依赖苹果系统特性**：当前的一键安装脚本 [`setup-macos-cdp.sh`](scripts/setup-macos-cdp.sh) 与 [`ag-context-meter`](bin/ag-context-meter) 基于 macOS 原生的 `launchd`（`~/Library/LaunchAgents/`）监听客户端启动，暂未打包 Windows / Linux 的一键守护脚本。
   - **Windows / Linux 也能用核心功能**：底层的 [`cli.js`](cli.js)、[`live-host.js`](live-host.js) 与所有前端挂件本身跨平台兼容；只要安装了 Node.js 22.4+，在 Antigravity 已开启调试端口的前提下手动执行 `node cli.js live` 即可使用（`status` 查看状态）。

### 参考与致谢（Credits & Acknowledgements）

本套件吸收并整合了社区多位作者的开源成果，谨此致谢：

| 参考项目 | 作者 / 贡献者 | 参考与吸收内容 |
| :--- | :--- | :--- |
| **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** | [@elviscjn-cjn](https://github.com/elviscjn-cjn)、[@Jia131313](https://github.com/Jia131313) | 基础框架、顶部上下文圆环看板 (`v0.8.3`)、Token 分类统计、52 周热力图、API 费用估算与本地桥接机制 |
| **[akelabs/antigravity-pulse](https://github.com/akelabs/antigravity-pulse)** | [@akelabs](https://github.com/akelabs) | 输入框底部能量条 (`v1.3.1`)：输出速率、缓存命中与 5 小时窗口倒计时 |
| **[n2ns/antigravity-panel](https://github.com/n2ns/antigravity-panel)** | [@n2ns](https://github.com/n2ns) | 模型额度监控、Auto-Accept 安全自动确认与 Brain 缓存体积监控思路 |
| **[yiheng8023/antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese)** | [@yiheng8023](https://github.com/yiheng8023) | 适配 Antigravity `2.32.1` (`v3.3.48`) 的 **2,282 条** 精确词条与 **239 条** 动态正则规则 |
| **[wycocoyu/agy-context-dashboard](https://github.com/wycocoyu/agy-context-dashboard)** | [@wycocoyu](https://github.com/wycocoyu) | 轻量状态栏排布与指标展示思路（已整合去重） |
| **[oil-oil/agy-fast-io](https://github.com/oil-oil/agy-fast-io)** | [@oil-oil](https://github.com/oil-oil) | 桌面端 Fast IO 提速规则 (`v0.2.1`)：免审白名单命令、同轮并读与回合压缩规范 |

---

基于 [MIT License](LICENSE) 开源，所有参考或引入的第三方组件均完整保留其原始版权与开源协议。

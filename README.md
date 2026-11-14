# Antigravity Suite — Antigravity 桌面端全能增强套件

> 给 Google Antigravity 桌面客户端用的「外挂级」效率增强工具：**不用修改软件本体、不破坏苹果系统签名、随时一键开关或还原英文原版。**

---

## ✨ 它能帮你做什么？

装好后，你的 Antigravity 界面多出来的所有功能都放在你每天最顺手的位置，不需要学复杂配置：

### 1. 窗口最上面（顶栏右侧）：一眼看清上下文和剩余额度

- **上下文圆环看板**
  - 实时显示当前聊天用了多少上下文（比如 `179K (70%)`）、模型回答有多快。
  - 点开面板能看到：**提示词 / 思考 / 工具调用** 各自占了多少 Token、过去 **52 周的使用热力图**、以及折算成官方 API 大概值多少钱。
  - 支持按不同模型单独保存上下文预算上限。
- **模型额度双胶囊（`G4` / `C`）**
  - 不用等到提示“额度用完”才发现。顶栏直接挂出主力模型组（如 Gemini 4 / Claude）还剩多少百分比，鼠标放上去就能看到精确的重置倒计时。

### 2. 聊天输入框上下：常用操作点一下就行，不用老是手敲

- **输入框底部能量条（Pulse）**
  - 紧贴输入框最下面一行，实时滚动显示**当前生成速度（`tok/s`）**、上下文占用、缓存命中情况和 5 小时窗口重置倒计时，不挡聊天视野。
- **输入框上方快捷胶囊栏**（7 个实用小按钮）：
  - `🗜️ /compact 压缩`：点一下把 `/compact` 填进输入框，回车就能让 AI 压缩上下文省额度。
  - `🎯 /plan 规划`：点一下自动填入 `/plan `，直接开始提规划需求。
  - `🔄 重载规则`：点一下填入 `重新读取 AGENTS`，改完本地规则后一键让 AI 重读。
  - `📋 复制会话 ID`：一键复制当前对话的 UUID，排查问题或找历史日志特别方便。
  - `📝 导出 Markdown`：把当前完整聊天记录整理成干净的 Markdown，保存到 `~/Downloads`（下载文件夹）并顺手复制到剪贴板。
  - `🤖 自动确认: 关 / 开`：默认是关闭的。打开后，如果 AI 运行常规读写步骤要你点 `Proceed` / `Accept`，它每秒会自动帮你点掉；**一旦遇到删除、拒绝、取消或下方标红的危险命令，会强制跳过，绝不乱点**。
  - `📦 缓存 xxxMB`：只读统计 `~/.gemini/antigravity/brain` 历史会话缓存一共占了多大容量，鼠标悬停显示占空间最多的前 5 个对话，点一下刷新并复制明细（绝不会帮你乱删任何文件）。

### 3. 聊天主界面与左侧边栏：全中文 + 防踩坑保护

- **全界面汉化 + 左下角 `EN/中` 秒切**：菜单、设置页、权限弹窗、按钮和报错全汉化（同步覆盖 Antigravity `2.32.1` 新界面）；左下角「设置」按钮旁边多了一个 `EN/中` 小按钮，点一下随时切回纯英文原版。
- **英文思考过程（Thought）自动译成中文**：如果模型输出的折叠“思考过程”是全英文，插件会在后台自动帮你翻译成中文并缓存到本地，读起来不再费劲。
- **左侧历史对话标题自动变中文**：左边历史会话列表里如果出现英文标题，会根据你的首轮提问自动变成好懂的中文标题。
- **🛡️ 危险命令红框提醒**：当界面里出现高危操作卡片或命令（如 `rm -rf`、`git reset --hard`、`git clean -f`、`git push`、`sudo`、`kill -9`、`DROP/DELETE`、`op item` 读取密码等），会自动套上醒目的**红色边框 + 顶部警告条**，防止顺手误放行。
- **🧭 右下角长对话电梯按钮**：对话聊得很长、滚轮翻到手酸时，点击输入框右下角的悬浮按钮，可以直接：**回到顶部 (`⏫`)**、**跳到上一轮 (`🔼`)**、**跳到下一轮 (`🔽`)**、**回到底部 (`⏬`)**，或者一键 **展开 / 收起所有思考过程 (`💡`)**。
- **✏️ 右侧边栏文件直接编辑与保存**：打开右侧查看 `.md` 或代码文件时，顶栏右侧控制区会出现 **「✏️ 编辑」** 按钮；点开即可直接在侧边栏里修改内容，支持 `⌘S` / `Ctrl+S`（或点「💾 保存」）直接写回本地硬盘，点 **「↩️ 完成」** 自动刷新预览。

---

## 🤖 怎么安装？（建议直接发给你的 AI Agent 帮你装）

这是最省心的方式：你不用自己去折腾命令行，只要把下面这段话直接复制发送给你的 AI 助手（Antigravity、Claude Code、Codex 都可以），它就会照着下面的手册帮你检查电脑环境、安装配置并教你使用。

### 第一步：复制下面这段话，直接发给 Agent

```text
请帮我安装并配置 https://github.com/iamvicliu/antigravity-suite 这套 Antigravity 免改包增强套件。
请先把它克隆到 ~/.local/share/antigravity-context-viewer，然后按仓库里 README.md 的 Agent 执行手册帮我完成环境检查、安装和开启「打开 Antigravity 时自动生效」。
装完后运行 ag-context-meter status 告诉我每一项功能是不是都已生效，并简单教我平时怎么开关和卸载。
```

### 第二步：Agent 安装与指导手册（供 AI Agent 严格按序执行）

如果你是正在帮助用户安装本套件的 AI Agent，请按以下步骤执行并用通俗的中文向用户反馈结果：

1. **检查基础环境（只读预检）**
   - 检查 Node.js 版本是否达到 **`22.4.0` 及以上**（`node -v`）。若未安装或版本过低，提示用户或通过 `brew install node@22` 安装。
   - 检查 Antigravity 客户端是否已打开了 CDP 调试端口：查看 `~/Library/Application Support/Antigravity/DevToolsActivePort` 是否存在。
     - 如果存在，说明等下可以**免重启立即热生效**。
     - 如果不存在，先提醒用户确保已启动 Antigravity 桌面端（或带 `--remote-debugging-port` 启动），继续完成安装配置后重启客户端即可自动挂载。
2. **下载项目到本地**
   ```bash
   git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
   cd ~/.local/share/antigravity-context-viewer
   ```
3. **运行一键安装与随客户端自启配置脚本**
   ```bash
   ./scripts/setup-macos-cdp.sh
   ```
   > 该脚本零修改官方安装包，会自动把管理命令软链到 `~/.local/bin/ag-context-meter`，并配置 `~/Library/LaunchAgents/` 监听 `DevToolsActivePort`，实现“打开 Antigravity 自动挂载、关掉软件自动休眠”。
4. **验收状态并向用户讲解用法**
   - 运行 `~/.local/bin/ag-context-meter status`（或 `ag-context-meter status`），核对每一项是否为 `✅`。
   - 告诉用户：日常无需做任何操作，打开客户端就会自动加载；如果哪天想暂时关掉或彻底退回官方原样，只要说一句或运行 `ag-context-meter stop` 即可秒级恢复。

---

## 💻 手动安装与常用命令（如果你想自己敲）

### 手动在终端安装（3 行搞定）

需要 **macOS + Node.js 22.4+**（零 `npm install` 依赖）：

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> 如果你只想要命令行管理，不想开启“打开软件自动加载”，最后一行改为：`./scripts/setup-macos-cdp.sh --no-auto`。

### 日常管理常用命令

| 命令 | 作用 |
| :--- | :--- |
| `ag-context-meter status` | 一眼查看当前所有功能是否正常生效、官方包签名是否完好 |
| `ag-context-meter live` | 立即把全套中文与功能挂件加载到正在运行的 Antigravity 窗口 |
| `ag-context-meter stop` | **秒级无痕退场**：停止后台守护并卸载窗口所有附加界面，立刻恢复原版英文界面 |
| `ag-context-meter auto-on` | 开启「每次打开 Antigravity 自动挂载」 |
| `ag-context-meter auto-off` | 关闭自动挂载并清理当前窗口增强界面 |
| `ag-context-meter check` | 检查 Node.js、Antigravity 安装路径与调试端口环境是否正常 |

---

## 🔒 为什么这样用很安全？

1. **绝不改动软件安装包**：不会去解包、篡改或重签名 `/Applications/Antigravity.app/Contents/Resources/app.asar`，在 `status` 中会明确看到 `官方安装包：✅ 未修改（官方签名完好）`，完全不影响官方客户端更新和苹果系统校验。
2. **默认禁用危险底层补丁**：我们在桥接服务 [`live-host.js`](live-host.js) 和 CLI 中专门封堵了修改官方二进制文件的入口，防止误操作破坏签名。
3. **本地隐私全外置**：你的翻译缓存、个人自定义会话标题等数据都存在系统状态目录 `~/Library/Application Support/AntigravityContextMeter/` 下，与代码仓库完全隔离。

---

## 🙏 致谢与参考项目（Credits & Acknowledgements）

这套整合方案的诸多能力离不开开源社区各位作者的出色工作，在此向以下 5 个参考项目的原作者与贡献者致谢：

| 参考项目 | 作者 / 贡献者 | 参考与吸收内容 |
| :--- | :--- | :--- |
| **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** | [@elviscjn-cjn](https://github.com/elviscjn-cjn)<br>内核增强 [@Jia131313](https://github.com/Jia131313) | 整体底层框架、顶部上下文圆环看板 (`v0.8.3`)、Token 明细统计、52 周热力图、API 费用估算与本地桥接架构。 |
| **[akelabs/antigravity-pulse](https://github.com/akelabs/antigravity-pulse)** | [@akelabs](https://github.com/akelabs) | 输入框底部能量胶囊 (`v1.3.1`)：实时速度、缓存命中、上下文占比与 5 小时窗口倒计时。 |
| **[n2ns/antigravity-panel](https://github.com/n2ns/antigravity-panel)** | [@n2ns](https://github.com/n2ns) | 模型配额倒计时、Auto-Accept 自动确认与 Brain 缓存体积监控的设计思路，移植重构到 Desktop 2.0 界面中。 |
| **[yiheng8023/antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese)** | [@yiheng8023](https://github.com/yiheng8023) | 适配 Antigravity `2.32.1` (`v3.3.48`) 的 **2,282 条** 精确词条与 **239 条** 安全动态正则规则。 |
| **[wycocoyu/agy-context-dashboard](https://github.com/wycocoyu/agy-context-dashboard)** | [@wycocoyu](https://github.com/wycocoyu) | 轻量级状态栏信息排布与指标展示参考（并与顶部/底部看板整合去重，避免界面拥挤）。 |

---

## 📄 开源协议

基于 [MIT License](LICENSE) 开源，所有引入与参考的第三方组件均完整保留其原始版权与开源协议。

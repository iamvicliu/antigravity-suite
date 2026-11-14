# Antigravity Suite — Antigravity Desktop 全功能免改包增强套件

面向 **Google Antigravity Desktop (`v2.32.1+`)** 的一体化实时增强套件：**零修改 `app.asar`、不修改官方二进制、不破坏 macOS 应用签名 (`codesign`)**，通过 Chromium DevTools Protocol (CDP) 热注入与本地只读桥接运行，支持随客户端自动加载与一键无损卸载恢复。

---

## 🙏 致谢与参考项目（Credits & Acknowledgements）

本套件在设计、代码架构、汉化词库与交互灵感上融合并吸收了社区多位优秀开发者的开源成果。在此向以下项目的原作者与贡献者致以诚挚感谢：

| 参考项目 | 原作者 / 贡献者 | 吸收与借鉴的核心部分 |
| :--- | :--- | :--- |
| **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** | [@elviscjn-cjn](https://github.com/elviscjn-cjn)<br>内核增强贡献者 [@Jia131313](https://github.com/Jia131313) | **全套件底座与核心架构 (`v0.8.3`)**：顶栏对话上下文环形看板、TTFT/生成速度统计、按模型独立保存上下文预算、52 周热力图、Token 用量账本、API 等值费用估算及本地桥接服务 (`live-host.js` / `install.js` / `cli.js`)。 |
| **[akelabs/antigravity-pulse](https://github.com/akelabs/antigravity-pulse)** | [@akelabs](https://github.com/akelabs) | **输入框底部能量胶囊 (`v1.3.1`)**：收纳入 [`pulse-capsule-overlay.js`](pulse-capsule-overlay.js)，在输入框底部紧挨 Turbo 渲染实时生成速度 (`tok/s`)、上下文占比、缓存命中率、5 小时重置倒计时与多会话独立统计。 |
| **[n2ns/antigravity-panel](https://github.com/n2ns/antigravity-panel)** | [@n2ns](https://github.com/n2ns) | **配额监控与效率操作理念**：参考其 VS Code 扩展中的模型配额倒计时、Auto-Accept 自动确认与 Brain 缓存空间统计思路，移植并重构为适配 Antigravity Desktop 2.0 界面的原生悬浮胶囊与桥接路由。 |
| **[yiheng8023/antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese)** | [@yiheng8023](https://github.com/yiheng8023) | **2.32.1 增量汉化词库 (`v3.3.48`)**：合并其针对 Antigravity `2.32.1` 新增的 **2,282 条** 精确 UI 词条及 **239 条** 安全的整行锚定动态正则规则到 [`antigravity-hans-overlay.js`](antigravity-hans-overlay.js) 中。 |
| **[wycocoyu/agy-context-dashboard](https://github.com/wycocoyu/agy-context-dashboard)** | [@wycocoyu](https://github.com/wycocoyu) | **轻量状态栏指标与布局参考**：借鉴其核心上下文指标精简呈现方式，并与顶部看板 + 底部 Pulse 胶囊做去重整合，避免状态栏重复堆叠拥挤。 |

- 同时感谢 **[LINUX DO](https://linux.do/)** 社区众多开发者在 Antigravity 工具生态中的探索与分享。

> [!NOTE]
> 本项目仅作为个人自用增强方案的整合与二次开发，完整保留上游 MIT 开源协议（见 [`LICENSE`](LICENSE)）。请尊重并支持原项目仓库。

---

## ✨ 六大核心功能模块

1. **顶部上下文看板 (`Context Viewer v0.8.3`)**
   - 顶栏实时展示当前会话上下文占用（`actual` / `estimate`）、模型预算占比、首字延迟 (TTFT)、生成速度 (`tok/s`)、工具与思考 Token 拆解。
   - 完整历史统计：52 周贡献热力图、按日/周/月曲线、API 等值参考费用与按模型独立的上下文预算配置。
2. **顶部配额双胶囊**
   - 在顶栏右侧实时监控主要模型池（如 `G4` / `C`）的剩余配额百分比，鼠标悬停查看各分组重置倒计时详情。
3. **输入框底部能量胶囊 (`Pulse v1.3.1`)**
   - 紧贴输入框底部交互区，紧凑呈现 `tok/s`、Token 占比、缓存命中与 5 小时窗口重置倒计时，避免遮挡对话主区。
4. **深度中文汉化 (`2.32.1` 词典 + 动态规则 + 会话标题本地化)**
   - **免改盘实时译化**：覆盖菜单、设置、权限弹窗、工具执行卡片、错误提示及 `2.32.1` 新界面（`r21` 指纹）。
   - **左下角 `EN/中` 一键切换**：点击随时在原版英文与简体中文之间无感切换，已针对增强挂件（`#ag-context-meter`、`#ag-quick-capsule-bar`、`#ag-chat-nav-float` 等）设置隔离保护防误译。
   - **侧栏会话标题汉化**：通过 [`live-host.js`](live-host.js) `/localize-conversations` 结合本地 Transcript 首轮提问自动生成可读中文标题（支持 `~/Library/Application Support/AntigravityContextMeter/custom-conversation-titles.json` 外置自定义标题映射）。
5. **输入框快捷胶囊栏 (`Enhancer v1.3.0`)**
   - **🤖 Auto-Accept 自动确认开关**（默认关闭）：开启后每秒扫描白名单安全确认按钮（`Proceed`、`Accept`、`Accept all`、`Accept Changes`、`Accept Step`、`Allow once` 等），**严格跳过所有删除 / 拒绝 / 取消按钮以及标红的高危卡片**。
   - **📦 Brain 缓存只读监控**（`/brain-stats`）：实时统计 `~/.gemini/antigravity/brain` 磁盘总占用及 Top 5 大体积会话（悬停看明细，点击刷新并复制明细，绝不自动删文件）。
   - 支持会话 Markdown 一键导出至 `~/Downloads`（`/export-markdown`）。
6. **高危命令红框预警 & 右下角长对话快捷导航浮标**
   - **🛡️ 高危命令红框预警 (`scanHighRiskCommands`)**：自动扫描代码块与工具调用卡片中的 `rm -r/-rf`、`git reset --hard`、`git clean -f`、`git push`、`sudo`/`mkfs`/`dd`、`kill -9`/`pkill`、`DROP`/`TRUNCATE`/`DELETE`、`op item` 等高危指令，标注红色边框与警告横幅，并联动 `Auto-Accept` 禁止自动确认。
   - **🧭 长对话导航浮标 (`#ag-chat-nav-float`)**：固定在聊天视口右下角，提供 `⏫ 顶部`、`🔼 上一轮`、`🔽 底部` 与 `💡 展开/收起思考` 快捷控制。

---

## 🔒 安全与免改包设计原则

- **零改盘原则**：日常使用时全程通过 CDP (`DevToolsActivePort`) 注入前端与启动本地回环桥接服务 [`live-host.js`](live-host.js)，**绝不修改 `/Applications/Antigravity.app/Contents/Resources/app.asar`**。
- **签名完好**：确保 macOS Gatekeeper / `codesign` 签名保持官方原样（`ag-context-meter status` 验证 `asarPatched: false`），不影响官方更新与账号安全。
- **二进制补丁防护**：在 [`live-host.js`](live-host.js) 与 [`bin/ag-context-meter`](bin/ag-context-meter) 中主动拦截了 `install` / `unlock` / `/enhance-apply` / `/context-unlock-apply` 等改写宿主包或语言服务器二进制的入口。
- **本地隔离与脱敏**：所有桥接请求强制校验随机 32 字节 `X-AG-Context-Token` 与动态 `Origin`；个人会话标题映射、翻译缓存（`zh-translation-cache.json`）与运行时会话文件统一存储在用户状态目录（macOS 下为 `~/Library/Application Support/AntigravityContextMeter/`），不混入代码仓库。

---

## 🚀 快速安装与使用（macOS CDP 免改包模式）

### 前置条件
- **Node.js >= 22.4.0**（使用内置原生 `WebSocket` 与 `fetch`，零 `npm install` 运行依赖）
- **macOS 版 Google Antigravity Desktop**（已开启 `DevToolsActivePort`，Antigravity 默认桌面端已启用或通过调试端口启动）

### 1. 一键安装 CLI 与随客户端自启守护

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

该脚本会自动完成：
1. 校验 Node.js 22.4+ 环境；
2. 将 [`bin/ag-context-meter`](bin/ag-context-meter) 软链至 `~/.local/bin/ag-context-meter`；
3. 创建 `~/Library/LaunchAgents/com.<user>.ag-live-helper.plist`（通过 `WatchPaths` 监听 `~/Library/Application Support/Antigravity/DevToolsActivePort`，每次打开 Antigravity 自动后台挂载，无需人工干预）；
4. 如果 Antigravity 正在运行，立即热注入生效。

> 若仅需安装 CLI 而不开启自启，可加 `--no-auto` 参数：`./scripts/setup-macos-cdp.sh --no-auto`。

### 2. 日常管理命令（`ag-context-meter`）

```bash
# 查看全套件实时状态（签名状态、汉化、上下文看板、配额双胶囊、快捷栏、Pulse、自启）
ag-context-meter status

# 输出完整 JSON 探针数据
ag-context-meter status --json

# 立即对当前运行中的 Antigravity 窗口热挂载全部增强组件
ag-context-meter live

# 停止本地桥接服务并从当前窗口无痕卸载全部叠加 UI（恢复官方原生界面）
ag-context-meter stop

# 开启 / 关闭随 Antigravity 启动自动挂载
ag-context-meter auto-on
ag-context-meter auto-off

# 运行环境与端口健康预检
ag-context-meter check
```

---

## 📁 核心定制与上游模块结构

```text
antigravity-suite/
├── bin/
│   └── ag-context-meter            # macOS 免改包守护管理 CLI（live / stop / status / auto-on / auto-off）
├── scripts/
│   ├── setup-macos-cdp.sh          # 一键配置 ~/.local/bin 软链与 LaunchAgent 随客户端自启
│   └── ...                         # 原版构建、打包与基准脚本
├── live-host.js                    # 本地回环桥接服务 + 3秒断线巡检热注入（含 /brain-stats、/localize-conversations、/export-markdown、/translate-zh 等路由，拦截二进制改写）
├── install.js                      # 热挂载引擎（tryHotInject，串联汉化 + Pulse + 看板 + 增强快捷栏）
├── cli.js                          # 统一探针与命令行控制接口
├── ag-enhancer-overlay.js          # v1.3.0 自研增强层（配额双胶囊 / Auto-Accept / Brain 监控 / 高危红框 / 长对话导航）
├── antigravity-hans-overlay.js     # r21 深度汉化叠加层（合并 yiheng8023 2.32.1 精确词条与动态正则 + EN/中 切换）
├── pulse-capsule-overlay.js        # Pulse v1.3.1 输入框底部能量胶囊
├── meter-core.js                   # Context Viewer v0.8.3 上下文与统计引擎
├── meter-renderer.js               # Context Viewer v0.8.3 前端 UI
├── meter-collector.js              # 本地会话扫描与历史账本收集器
├── meter-enhance.js                # 提示词档位与状态接口（Darwin 下保持只读状态检测）
├── modules-config.js               # 模块配置管理
└── README.en.md / ja / ko / es     # 上游 Context Viewer 多语言文档
```

---

## 🧪 运行上游单元测试

```bash
npm test
```

> [!IMPORTANT]
> 本项目默认采用 **免改包 CDP 运行模式**，请勿在生产客户端上使用禁用掉的底层 `app.asar` / 二进制改盘命令。若要临时体验原生无插件界面，执行 `ag-context-meter stop` 即可秒级无痕退场。

## 📄 License

本项目基于 [MIT License](LICENSE) 开源，所有引入的第三方组件均保留其原始版权与开源协议。

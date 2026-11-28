# Development and installation

## Source changes

- Edit renderer code in `src/renderer/`, then run `npm run build:renderer`.
  `meter-renderer.js` is the generated bundle; include it with renderer changes.
- Run `npm run test:suite` after source changes. Tests use isolated temporary directories for settings and usage data.
- Keep local transcripts, installation manifests, backups and capture output outside the repository.
- The runtime uses Node.js built-ins and the bundled ASAR engine. No `npm install` is needed.

## Zero-Patch Installation & Runtime Control

Use Node.js 22.4 or later. Python is optional for attachment analysis.
This suite uses **100% zero-patch CDP hot-injection** on macOS and never modifies `app.asar`, Apple code signatures, or application binaries during normal installation/usage.

```sh
./scripts/setup-macos-cdp.sh          # or --no-auto to skip LaunchAgent
ag-context-meter live                 # hot-inject into running Antigravity (use --no-remote to disable mobile server)
ag-context-meter status               # verify live components and intact official signature
```

- `node cli.js live` (default command of `cli.js`, optional `--no-remote` or `AG_DISABLE_MOBILE_REMOTE=1`): inject into the running window without touching `app.asar`.
- `ag-context-meter stop` / `ag-context-meter auto-off`: cleanly dispose injected UI and stop background bridge.
- Note: Legacy `install` / `unlock` / `restore` commands in `cli.js` are gated off in normal runs to preserve client integrity (`--allow-asar-patch` / test mode only).

Keep Antigravity running when using CDP hot injection. Do not terminate the host from an agent session inside Antigravity.

## UI translation

Translate visible text in `src/renderer/template.html` and the renderer JavaScript
modules. Keep DOM IDs, selectors, event handlers and data structures intact.
Build the renderer and run tests before reloading via `ag-context-meter live`.

## UI Design System & Consistency Guardrails

1. **Theme Accent Token Contract（严禁硬编码非主题强调色）**：
   - 所有选中态、激活态、焦点边框、主按钮、标签徽章、悬浮提示框和加载旋转指示器，**必须**绑定动态主题变量：
     - 主色文字/图标/边框：`var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))`（Shadow DOM 外部挂载点使用 `var(--ag-effective-accent, #a78bfa)`，浅色回退 `#7c3aed`）
     - 浅底高亮：`var(--ag-accent-bg, rgba(167, 139, 250, 0.14))` / 悬停 `var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24))`
     - 强调边框：`var(--ag-accent-border, rgba(167, 139, 250, 0.34))` / 悬停 `var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56))`
   - **严禁**在组件 CSS 或内联样式中硬编码野生绿色（`#10b981`、`#34d399`、`#059669`、`rgba(16,185,129,...)`）或野生天蓝（`#38bdf8`、`rgba(56,189,248,...)`、`#7dd3fc`）；仅 `colors.js` 的 5 套预设调色板表本身与高危告警语义色（`--ag-ring-warn` / `--ag-ring-danger` / 错误红 `#f87171`）除外。
2. **Surface & Input Tokens**：
   - 外层分组卡片使用 `var(--ag-bg-card)` + `var(--ag-border-card)`；内部子卡片与胶囊选项使用 `var(--ag-bg-subcard)` + `var(--ag-border-subcard)`；所有文本输入框（`.settings-input`、`.qp-label-input`、`.qp-text-input`、`.ag-rp-input`）统一使用 `var(--ag-bg-input)`。
3. **Component Reuse & Layout Discipline**：
   - 同一设置卡片内严禁混搭多种开关控件形态（如大框开关叠原生复选框）；新增设置项必须复用现有基准组件模式：`.term-option-card`（单选卡）、`.qp-pool-chip`（多选开关胶囊）、`.settings-pref-row`（切换开关/下拉）、`.switch-pill-btn`（轻操作按钮）。
4. **Mockup-First with True Theme Palette**：
   - 任何界面布局改动或新组件上线前，须先出设计草图确认；**草图自身也必须遵循项目默认紫色主色调（`#a78bfa`）而非随意选用其他色系**，防止草图配色直接误导后续实现。
5. **Automated Gate**：
   - 每次修改 `src/renderer/` 或 `ag-enhancer-overlay.js` 后，必须确保 `tests/meter-suite-refactor.test.js` 中的 `需求 25`（UI 主题色系一致性静态门禁）全部通过后再构建热刷新。

## Documentation Sync Guardrails

1. **README 与默认行为同步义务**：
   - 凡新增、删除或变更面向用户的核心功能、默认开关状态（如 Cloudflare 隧道默认值、240K 自动压缩默认开关）、设置面板分页布局、快捷指令池或 CLI 安装/控制命令，提交前**必须**同步核查并更新 `README.md`（以及 `docs/README.en.md`、`docs/README.ja.md`、`docs/README.ko.md`、`docs/README.es.md`），严禁文档滞后或出现与默认代码行为相反的描述。
2. **Repository Description 同步**：
   - 重大卖点或核心定位变更时，须同步更新 `package.json` 的 `description`，并提醒或经用户确认后执行 `gh repo edit` 同步 GitHub 仓库 Description。
3. **多语言 README 打包完整性与禁用项约束**：
   - `scripts/package-release.js` 与 `scripts/package-release.py` 依赖根目录 `README.md` 与 `docs/` 下全部 4 份外语文档（`docs/README.en.md`、`docs/README.ja.md`、`docs/README.ko.md`、`docs/README.es.md`），**严禁删除**任意语种 README，且文档中绝不可再写入已禁用的 `node cli.js install` 或“无语言切换”等过时内容。

## Privacy & Desensitization Guardrails（公开仓库隐私与测试数据脱敏红线）

1. **严禁直接照搬或“改皮脱敏”真实个人/工作区数据进源码、测试或文档**：
   - 业务源码中零测试数据；编写单元测试 fixture、回归用例、注释或文档示例时，**严禁**原样复制或仅改几个字来“改皮脱敏”本机真实聊天记录、个人社交账号/短链、真实本机绝对路径（如 `/Users/<真实用户名>/...` 或 `/home/<真实用户名>/...`）、个人邮箱/手机号/令牌/Cookie，以及与本仓库无关的其他私人项目名或本地目录结构。
   - 测试输入必须**从零构造最小化、纯抽象的通用占位符**（如 `proj-a` / `proj-b`、`dir-1` / `dir-2`、`shared-dir`、`/Users/demo/...`、`https://example.com/1`、`sample message`），与真实个人及本地项目零映射。
2. **Automated Gate（提交前隐私静态门禁）**：
   - `tests/meter-suite-refactor.test.js` 包含静态隐私脱敏门禁，自动扫描仓库受控文本文件是否出现非占位符的真实本机用户路径或个人社交短链；每次修改源码、测试或文档后必须确保 `npm run test:suite` 全部通过。
   - 提交 PR 前须复核 `git diff` 与 commit 历史；若在未合入分支发现隐私残留，必须重写分支历史彻底抹除后再推送，禁止仅用追加新 commit 的方式掩盖。

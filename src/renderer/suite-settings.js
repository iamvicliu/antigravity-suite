  // =========================================================================
  // 模块 5: 统一设置面板、配置项无损迁移、终端与 CLI 启动、多语言注册表
  // =========================================================================
  let activeSettingsTab = 'terminal';
  let suiteConfigTransplanted = false;
  let suiteDropdownsEnhanced = false;
  let uiLangDropdown = null;
  let uiCliModelDropdown = null;
  let uiCliMuxHostDropdown = null;

  const SUITE_EN_UI_DICT = {
    'Antigravity Suite 统一设置': 'Antigravity Suite Settings',
    '🖥️ 终端与通用': '🖥️ Terminal & General',
    '🎨 外观与主题': '🎨 Appearance & Theme',
    '💎 套餐与订阅': '💎 Plan & Subscription',
    '🌐 网络与高级': '🌐 Network & Advanced',
    '>_ CLI 启动终端配置': '>_ CLI Launch Terminal',
    '检测中…': 'Detecting…',
    '🔄 重新检测': '🔄 Re-detect',
    '重新检测': 'Re-detect',
    '选择点击顶栏 CLI 按钮时启动的终端程序；支持本机主流终端自动识别与自定义路径。': 'Choose the terminal launched by the topbar CLI button; supports auto-detected terminals and custom paths.',
    '自定义终端程序路径（选择「自定义程序路径」时生效）': 'Custom Terminal Path (active when "Custom Path" is selected)',
    '📂 浏览选择…': '📂 Browse…',
    '浏览选择…': 'Browse…',
    '保存路径': 'Save Path',
    '自定义程序路径': 'Custom Path',
    '自动默认 (Terminal.app)': 'Auto Default (Terminal.app)',
    '自动默认 (原生居中控制台)': 'Auto Default (Native Centered)',
    'Terminal (系统终端)': 'Terminal (System)',
    'CMD (命令提示符)': 'CMD (Command Prompt)',
    'WSL (Linux 子系统)': 'WSL (Linux Subsystem)',
    '已安装': 'Installed',
    '未检测到': 'Not found',
    '已配置': 'Configured',
    '自定义': 'Custom',
    '请填写或浏览选择终端程序路径': 'Enter or browse for terminal executable path',
    '未在本机默认路径找到': 'Not found in default paths',
    '开启 CLI 免审核模式 (--dangerously-skip-permissions)': 'Skip CLI Permissions (--dangerously-skip-permissions)',
    '启动 agy 时自动批准终端内工具调用权限，无需逐次手动确认': 'Auto-approve terminal tool calls when launching agy without manual prompts',
    'CLI 默认启动模型 (--model)': 'CLI Default Launch Model (--model)',
    '选择启动 agy CLI 时传入的模型，或保持「不选择模型」以跟随 agy 默认设置': 'Select the model passed to agy CLI, or keep "No Model" to follow agy defaults',
    '不选择模型 · 跟随 agy 默认设置': 'No Model · Follow agy default',
    '自定义模型 ID…': 'Custom Model ID…',
    '保存模型': 'Save Model',
    '多路复用器目标主机 (Rex / WezTerm / tmux)': 'Multiplexer Target Host (Rex / WezTerm / tmux)',
    '多路复用器启动 agy 时指定目标主机名；选「本机」避免误入远端会话，选远端主机自动执行远端 agy': 'Target host for multiplexer CLI launch; choose Local to stay on this Mac, or a remote host to launch agy remotely',
    '本机 · This Mac (Local)': 'Local · This Mac',
    '自定义主机名 / Domain…': 'Custom Host / Domain…',
    '保存主机': 'Save Host',
    'tmux (多路复用器)': 'tmux (Multiplexer)',
    '输入 Rex 主机名、WezTerm Domain 或 SSH 主机名（留空为本机）': 'Enter Rex host label, WezTerm domain, or SSH host (blank = local)',
    '当前使用：自动默认': 'Active: Auto Default',
    '▶ 测试打开终端': '▶ Test Terminal',
    '测试打开终端': 'Test Terminal',
    '⏳ 正在尝试打开所选终端…': '⏳ Launching selected terminal…',
    '🧩 界面与对话增强偏好': '🧩 UI & Conversation Preferences',
    '界面与对话增强偏好': 'UI & Conversation Preferences',
    '界面深浅主题': 'Appearance Theme',
    '控制状态栏、浮窗面板与调色默认色调': 'Controls default palette for toolbar badges, popovers, and panels',
    '🌗 跟随宿主': '🌗 Auto',
    '跟随宿主': 'Auto',
    '☀️ 浅色': '☀️ Light',
    '浅色': 'Light',
    '🌙 深色': '🌙 Dark',
    '深色': 'Dark',
    '安全自动确认 (Auto-Accept)': 'Safe Auto-Accept',
    '自动点击 Proceed / Accept / 继续 等低风险确认按钮，高危命令自动拦截预警': 'Auto-click low-risk Proceed / Accept buttons while blocking high-risk commands',
    '下一步建议幽灵补全 (Tab / →)': 'Next-Step Ghost Suggestions (Tab / →)',
    '对话空闲且输入框为空时显示高匹配下一步指令提示，按 Tab 一键填入': 'Show context-aware prompt suggestions when composer is idle (press Tab to fill)',
    '界面与提示语言 (Language)': 'Interface Language',
    '统一切换客户端界面汉化、悬浮胶囊与插件多语言展示（可扩展多语言包）': 'Switch client UI localization, context capsule, and suite panels (extensible)',
    '选项名保留英文': 'Keep Option Names in English',
    '中文界面下保留 Default / Auto / Turbo 与 High / Medium / Low 等档位英文原名': 'Keep original English option names (Default / Auto / Turbo / Effort) under Chinese UI',
    '🎨 热力图颜色主题与 5 档色阶自定义': '🎨 Heatmap Theme & 5-Level Color Scale',
    '热力图颜色主题与 5 档色阶自定义': 'Heatmap Theme & 5-Level Color Scale',
    '切换色系预设或单独调色后，顶部标题文字、胶囊边框、按钮高亮及热力图色阶均同步跟随该颜色主题。': 'Topbar titles, accents, highlights, and heatmap palette sync automatically with the selected theme.',
    '🖌️ 面板背景与顶部指标颜色自定义': '🖌️ Panel Background & Badge Colors',
    '面板背景与顶部指标颜色自定义': 'Panel Background & Badge Colors',
    '5 档色阶预设：': '5-Level Presets:',
    '紫色系': 'Purple',
    '黄色系': 'Yellow',
    '绿色系': 'Green',
    '蓝色系': 'Blue',
    '红色系': 'Red',
    '5 档逐格独立自定义（点击任意一格或图例「少 ▢▢▢▢▢ 多」单独调色，可设 5 种不同颜色）：': 'Per-level customization (click any cell or legend swatch):',
    '恢复 5 档预设': 'Reset Levels',
    '1档 · 少/无': 'L1 · None',
    '2档 · 低': 'L2 · Low',
    '3档 · 中': 'L3 · Med',
    '4档 · 高': 'L4 · High',
    '5档 · 多/峰': 'L5 · Peak',
    '预设': 'Preset',
    '跟随主题': 'Follow Theme',
    '色阶「少」端颜色（自动插值）': 'Scale Low Color (Auto-Interpolate)',
    '色阶「多」端颜色（自动插值）': 'Scale High Color (Auto-Interpolate)',
    '面板与菜单统一背景色（0级跟随 / 自定义）': 'Panel & Menu Background (Auto / Custom)',
    '面板与菜单统一背景色': 'Panel & Menu Background',
    '功能显示开关': 'Feature Toggles',
    '全部恢复显示': 'Show All',
    '恢复显示全部顶栏入口与对话区挂件': 'Restore all topbar badges and chat widgets',
    '按需开启或隐藏顶栏入口与对话区挂件，点击立即生效。': 'Show or hide topbar badges and chat widgets; takes effect immediately.',
    '顶部：总用量统计': 'Topbar: Total Usage',
    '顶部：CLI 终端入口': 'Topbar: CLI Button',
    '顶部：模型配额胶囊': 'Topbar: Quota Badge',
    '顶部：手机远程入口': 'Topbar: Remote Badge',
    '输入框快捷操作栏': 'Composer Quick Bar',
    '对话右侧悬浮导航': 'Chat Navigation Float',
    '当前会话上下文': 'Session Context',
    '核心用量速览': 'Core Context Usage',
    '最新生成速度与耗时': 'Output Speed & Latency',
    '底层技术参数与附件审计': 'Technical Details & Attachments',
    'AI 订阅与额度详情': 'AI Subscription & Quota Details',
    '颜色选取器': 'Color Picker',
    '检查更新': 'Check for Updates',
    'CLI 自动批准工具权限（免每次手动确认）': 'Skip CLI Permissions (--dangerously-skip-permissions)',
    '在终端启动 agy 时默认跳过权限询问（附带 --dangerously-skip-permissions）': 'Auto-approve terminal tool calls when launching agy without manual prompts',
    'CLI 默认启动模型': 'CLI Default Launch Model',
    '指定启动 agy 时默认使用的模型；选「不指定」则使用 CLI 默认配置': 'Select the default model when launching agy, or choose Unspecified to follow CLI defaults',
    '不指定 · 跟随 CLI 默认设置': 'Unspecified · Follow CLI default',
    '终端连接目标（本机 / 远程服务器）': 'Terminal Target Host (Local / Remote)',
    '终端连接目标': 'Terminal Target Host',
    '仅在使用 Rex、WezTerm 或 tmux 时生效：可选择在本机或远程服务器上启动 agy': 'Applies to Rex, WezTerm, or tmux: choose Local or a remote server to launch agy',
    '本机（当前电脑）': 'Local (This Mac)',
    '自定义远程主机名…': 'Custom Remote Host…',
    '面板深浅外观': 'Appearance Theme',
    '设置所有插件浮窗与设置面板的明暗配色': 'Configure light/dark appearance for all popovers and settings panels',
    '跟随客户端': 'Follow App',
    '自动确认安全操作 (Auto-Accept)': 'Safe Auto-Accept',
    '自动点击对话中的 Proceed / Accept / 继续 等常规确认按钮，遇到高危命令自动拦截': 'Auto-click safe Proceed / Accept buttons while blocking high-risk commands',
    '输入框智能追问建议 (Tab / →)': 'Smart Follow-up Suggestions (Tab / →)',
    '回答结束后在输入框内提示下一步常用追问，按 Tab 或 → 键一键填入': 'Show follow-up prompt suggestions in composer after responses (Tab or → to fill)',
    '插件与客户端语言': 'Plugin & Client Language',
    '同时切换客户端界面汉化、插件面板及底部状态胶囊的显示语言': 'Switch client UI localization, panels, and context capsule language together',
    '模式与档位名保留英文': 'Keep Mode & Effort Names in English',
    '中文界面下保留 Default / Auto / Turbo 及 High / Medium / Low 等英文原名': 'Keep original English names (Default / Auto / Turbo / Effort) under Chinese UI',
    '主题色系与热力图配色': 'Theme Palette & Heatmap Colors',
    '高级色阶微调 ▼': 'Advanced Scale ▼',
    '收起色阶微调 ▲': 'Hide Advanced ▲',
    '切换下方主题色系后，所有弹窗的高亮色、进度条、按钮激活态及热力图均会自动同步。': 'Switching the theme palette syncs accents, progress bars, active controls, and the heatmap.',
    '全局强调色与顶部栏分项配色': 'Global Accent & Topbar Colors',
    'Ultra 套餐规格：': 'Ultra Tier Spec:',
    '账号归属地区：': 'Account Region:',
    '订阅结算地区：': 'Billing Region:',
    '本地代理网络直连（免开 TUN 模式）': 'Local Proxy Direct Connect (No TUN)',
    '本地代理地址（支持 HTTP / SOCKS5，如 http://127.0.0.1:7897）：': 'Local Proxy URL (HTTP / SOCKS5, e.g. http://127.0.0.1:7897):',
    '不走代理的地址（本地回环默认直连）：': 'Bypass Proxy Addresses (Loopback Direct):',
    '🔍 测试代理连接': '🔍 Test Proxy',
    '开启代理直连': 'Enable Proxy',
    '关闭代理直连': 'Disable Proxy',
    '全局主题强调色': 'Global Theme Accent',
    '浮窗与面板背景色': 'Popover & Panel Background',
    '顶部圆环进度': 'Ring Progress',
    '顶部圆环底轨': 'Ring Track',
    '对话占用百分比': 'Context Usage %',
    '测速徽章文字': 'Speed Badge Text',
    '顶部总 Token 数': 'Topbar Total Tokens',
    '自定义实付金额与订阅备注': 'Custom Paid Amount & Notes',
    '订阅渠道 / 优惠来源': 'Channel / Promo Source',
    '免费获取（0 元实付，如赠送 / 试用）': 'Free Access ($0 paid, e.g. promo / trial)',
    '备注说明（选填）': 'Notes (Optional)',
    '整体主题色系：': 'Theme Color Palette:',
    '热力图 5 档深浅单独调色（点击色块可逐档修改）：': 'Per-level Heatmap Shading (click swatches to customize):',
    '热力图起始色（自动生成渐变）': 'Heatmap Start Color (Auto Gradient)',
    '热力图峰值色（自动生成渐变）': 'Heatmap Peak Color (Auto Gradient)',
    '全局强调与顶部总数色': 'Accent & Total Tokens',
    '累计与强调指标色': 'Total & Accent Colors',
    '圆环已用部分': 'Ring Used',
    '圆环轨道': 'Ring Track',
    '上下文用量文字': 'Context Text',
    '输出速度': 'Output Speed',
    '累计 token 用量': 'Total Tokens',
    '其他 token 指标': 'Token Accent',
    '注：高占用与超限告警色独立保留，不被常态颜色覆盖。': 'Note: High-usage and overflow alert colors remain independent.',
    '全部恢复跟随主题': 'Reset All to Theme',
    '当前套餐：读取中…': 'Current Plan: Loading…',
    '额度池同步中…': 'Syncing quota pools…',
    '按当前套餐配额执行': 'Follows active plan quota',
    'Ultra 套餐子档：': 'Ultra Sub-tier:',
    '套餐子档：': 'Sub-tier:',
    '账号所在地区：': 'Account Country:',
    '订阅国家：': 'Billing Region:',
    '订阅币种：': 'Currency:',
    '计价模式：': 'Pricing Mode:',
    '跟随参考价': 'Reference Price',
    '自定义实付': 'Custom Paid',
    '设置当前账号订阅信息': 'Configure Subscription Details',
    '获取方式 / 活动来源': 'Acquisition / Source',
    '自定义活动 / 合作方名称': 'Custom Promo / Partner',
    '本权益期间无需另付订阅费': 'No extra fee during this promo period',
    '预设订阅国家与汇率 (可选快捷套用)': 'Preset Billing Region & FX',
    '账号所在地区 (仅本地记录)': 'Account Country (local only)',
    '订阅国家 (购买/结算地区)': 'Billing Country / Region',
    '订阅币种与实付金额': 'Currency & Actual Paid',
    '计费周期': 'Billing Cycle',
    '权益到期日': 'Benefit Expiry',
    '补充说明备注': 'Notes',
    '清除自定义': 'Clear Custom',
    '取消': 'Cancel',
    '保存': 'Save',
    '🌐 免 TUN 网络直连（本地代理）': '🌐 Proxy-No-TUN Direct Connect',
    '免 TUN 网络直连（本地代理）': 'Proxy-No-TUN Direct Connect',
    '代理直连配置与状态': 'Proxy Status & Config',
    '正在核对代理设置…': 'Checking proxy settings…',
    '本地代理地址 (例如 http://127.0.0.1:7897 或 socks5://...)：': 'Local Proxy URL (e.g. http://127.0.0.1:7897 or socks5://...):',
    '绕过代理列表 (NO_PROXY)：': 'Bypass List (NO_PROXY):',
    '🔍 测试代理连通性': '🔍 Test Proxy',
    '切换代理直连': 'Toggle Proxy',
    '开启免 TUN 直连': 'Enable Proxy',
    '关闭免 TUN 直连': 'Disable Proxy',
    '⚡ 上下文加长（实验特性说明）': '⚡ Context Window Unlock (Experimental)',
    '上下文加长（实验特性说明）': 'Context Window Unlock (Experimental)',
    '当前后端补丁状态': 'Backend Patch Status',
    '正在分析当前 Antigravity 后端二进制…': 'Analyzing backend binary…',
    '⚠️ 技术边界与重要说明': '⚠️ Technical Notes & Disclaimers',
    '⚡ 立即应用加长补丁': '⚡ Apply Unlock Patch',
    '🔄 恢复官方原版': '🔄 Restore Original',
    '🔄 刷新': '🔄 Refresh',
    '当前目标不受支持': 'Unsupported Target',
    '目标后端': 'Target Binary',
    '目标架构': 'Architecture',
    '文件哈希 (SHA-256)': 'File Hash (SHA-256)',
    '原版备份状态': 'Backup Status',
    '解锁方案来源：': 'Credits:',
    '原作者帖子 (Linux.do @23375) ↗': 'Original Post (Linux.do @23375) ↗',
    '📋 复制链接': '📋 Copy Link',
    '本项目负责 Node.js 原生适配与客户端集成': 'Native Node.js & client integration by Antigravity Suite',
    '当前平台不支持': 'Unsupported Platform',
    '已启用': 'Enabled',
    '未启用': 'Disabled',
    '💬 当前会话上下文': '💬 Session Context',
    '会话用量与生成监控': 'Session Usage & Speed',
    '⭐ 核心用量速览': '⭐ Core Context Usage',
    '读取中': 'Loading',
    '读取中…': 'Loading…',
    '读取中...': 'Loading...',
    '正在计算核心指标…': 'Calculating metrics…',
    '当前已用': 'Used',
    '预算上限': 'Budget',
    '剩余可用': 'Remaining',
    '⚡ 最新生成速度与耗时': '⚡ Output Speed & Latency',
    '待生成': 'Idle',
    '输出速度': 'Speed',
    '生成耗时': 'Duration',
    '首字延迟': 'TTFT',
    '本次输出': 'Tokens',
    '📋 底层技术参数与附件审计': '📋 Technical Details & Attachments',
    '▼ 点击展开明细': '▼ Show Details',
    '▲ 收起明细': '▲ Hide Details',
    '重新扫描整段会话与附件': 'Rescan Session & Attachments',
    '本机已记录用量': 'Recorded Token Usage',
    '来源:': 'Source:',
    '全部': 'All',
    '桌面端': 'Desktop',
    'CLI': 'CLI',
    'Token 统计': 'Token Stats',
    'API 参考金额': 'API Reference Cost',
    '详情 ▼': 'Details ▼',
    '详情收回 ▲': 'Collapse ▲',
    '前往设置修改': 'Edit in Settings',
    '累计处理 Token': 'Total Processed',
    '含缓存读取': 'Incl. cache reads',
    '总计': 'Total',
    '今日使用': "Today's Usage",
    '今日': 'Today',
    '本月使用': 'This Month',
    '本月': 'Month',
    '年度使用': 'This Year',
    '本年': 'Year',
    '全年': 'Year',
    '读取中...': 'Loading...',
    'Token 活动': 'Token Activity',
    '每天': 'Daily',
    '每周': 'Weekly',
    '每月': 'Monthly',
    '今年': 'Yearly',
    '累计总量': 'Cumulative',
    '区间合计:': 'Range Total:',
    '预估费用:': 'Est. Cost:',
    '折合每天:': 'Daily Avg:',
    '活跃日均:': 'Active Day Avg:',
    '订阅性价比:': 'Sub Value:',
    '少': 'Less',
    '多': 'More',
    '注：按日聚合按基础档估算，未拆分长上下文分档，结果偏下限。有逐请求记录时优先精确入账。': 'Note: Daily aggregates use base-tier pricing without long-context splits (lower-bound estimate). Per-request records use exact pricing when available.',
    '点击或悬浮格子查看当日详细 Token 构成': 'Click or hover cells for daily breakdown',
    '启动 CLI 终端': 'Launch CLI Terminal',
    '套件设置': 'Suite Settings',
    '配置': 'Settings',
    '上下文窗口：': 'Context Window:',
    '⬆️ 一键更新': '⬆️ Update Now',
    '立即更新': 'Update Now',
    '⏳ 正在更新…': '⏳ Updating…',
    '当前版本状态': 'Current Version Status',
    '拉取最新提交并免重启热生效': 'Pull latest commits and hot-reload without restart',
    '打开 Antigravity Suite 统一设置面板': 'Open Antigravity Suite Settings',
    '发现新版本，点击打开设置一键更新': 'Update available — click to open Settings and update',
    '📱 远程设置': '📱 Remote',
    '远程通道与隧道': 'Remote Channels & Tunnel',
    '刷新状态': 'Refresh',
    '重置令牌': 'Reset Token',
    'Remote 页面显示内容': 'Remote Page Visibility',
    '恢复默认': 'Reset Default',
    '顶部上下文窗口面板': 'Topbar Context Window Panel',
    '顶部本机已记录用量面板': 'Topbar Local Usage Panel',
    '顶部模型配额胶囊': 'Topbar Model Quota Pill',
    '顶部通道连接状态副标题': 'Topbar Channel Meta Subtitle',
    '左侧会话与窗口抽屉': 'Conversation & Window Drawer',
    'AI 思考过程折叠区': 'Collapsible Thinking Process',
    '底部快捷操作与下一步建议': 'Bottom Quick Chips & Suggestions',
    '输入区工具栏（模型/权限等）': 'Composer Tools (Model / Perms / Upload)',
    '待审批操作提醒横幅': 'Pending Approvals Banner',
    '快捷提示词': 'Quick Prompts',
    '+ 新增': '+ Add',
    '保存快捷提示词': 'Save Quick Prompts',
    '局域网': 'LAN',
    'Cloudflare 隧道': 'Cloudflare Tunnel',
    '固定域名': 'Fixed Domain',
    '公网隧道已停用 · 点击启用公网域名': 'Tunnel disabled · click to enable public access',
    '点击上方复选框或「固定域名」开启公网访问': 'Toggle checkbox or Fixed Domain to enable tunnel',
    '获取 Token 前往 Cloudflare →': 'Get Token on Cloudflare →',
    '前往 Cloudflare 获取 Token →': 'Get Token on Cloudflare →',
    '保存并启用': 'Save & Enable',
    '改用免登录临时隧道': 'Use Quick Tunnel',
    '取消': 'Cancel'
  };

  function translateSuiteDynamicFragmentEn(fragment) {
    return String(fragment || '')
      .replace(/自动默认\s*\(([^)]+)\)/g, 'Auto Default ($1)')
      .replace(/自定义程序路径/g, 'Custom Path')
      .replace(/未设置路径/g, 'No path set')
      .replace(/系统默认/g, 'System Default')
      .replace(/模型:\s*默认/g, 'Model: Default')
      .replace(/模型:/g, 'Model:')
      .replace(/主机:\s*本机/g, 'Host: Local')
      .replace(/主机:/g, 'Host:')
      .replace(/免审核/g, 'Skip Perms')
      .replace(/标准权限/g, 'Standard Perms');
  }

  const SUITE_EN_UI_PATTERNS = [
    [/^当前使用：([\s\S]+)$/, (_, rest) => `Active: ${translateSuiteDynamicFragmentEn(rest)}`],
    [/^当前套餐：([\s\S]+)$/, (_, rest) => `Current Plan: ${rest}`],
    [/^首次使用：([\s\S]+)$/, (_, rest) => `First used: ${rest}`],
    [/^✅ 测试启动成功：([\s\S]+)$/, (_, rest) => `✅ Test launch succeeded: ${rest}`],
    [/^✖ 测试启动失败：([\s\S]+)$/, (_, rest) => `✖ Test launch failed: ${rest}`],
    [/^(\d[\d,]*) 会话实时累加$/, '$1 sessions tracked'],
    [/^日均约 ([\s\S]+)$/, 'Daily avg ~$1'],
    [/^(\d[\d,]*) 天活动记录$/, '$1 active days'],
    [/^(≈ \$[\s\S]+?) · 日均 (\$[\d.,]+)$/, '$1 · Avg $2/day'],
    [/^· 今日 ([\s\S]+)$/, '· Today $1'],
    [/^(\$[\d.,]+)\s*\((\d+)天\)$/, '$1 ($2d)'],
    [/^(\d+)月$/, (_, m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] || `${m}M`],
    [/^周累计 \(折合日均 (\$[\d.,]+)\)$/, 'Weekly Total (Avg $1/day)'],
    [/^截至当日累计 \(折合日均 (\$[\d.,]+)\)$/, 'Cumulative Total (Avg $1/day)'],
    [/^月累计 · 折合日均 (\$[\d.,]+) \(活跃 (\d+) 天\)$/, 'Monthly Total · Avg $1/day ($2 active days)'],
    [/^v([^\s(]+)\s*\(([0-9a-f]+)\s*·\s*已是最新\)$/i, 'v$1 ($2 · Up to date)'],
    [/^v([^\s(]+)\s*·\s*已是最新$/i, 'v$1 · Up to date'],
    [/^🔔 有新更新 \(\+(\d+)\s*·\s*([0-9a-f]+)\)$/i, '🔔 +$1 update(s) ($2)'],
    [/^✅ 已更新至 v([^\s(]+)\s*\(([0-9a-f]+)\)$/i, '✅ Updated to v$1 ($2)'],
    [/^v([^\s(]+)\s*\(非 Git 安装\)$/i, 'v$1 (Non-Git)'],
    [/^✖ 更新失败：([\s\S]+)$/, '✖ Update failed: $1']
  ];

  const SUITE_SUPPORTED_LOCALES = [
    { code: 'zh-CN', hansCode: 'zh', capsuleLang: 'zh', label: '简体中文 · Simplified Chinese', uiDict: null, uiPatterns: null },
    { code: 'en', hansCode: 'en', capsuleLang: 'en', label: 'English · 英文原版', uiDict: SUITE_EN_UI_DICT, uiPatterns: SUITE_EN_UI_PATTERNS }
  ];

  let suiteTerminalState = {
    terminalApp: 'auto',
    customTerminalPath: '',
    cliSkipPermissions: false,
    cliDefaultModel: '',
    cliMuxHost: '',
    muxHosts: [],
    terminals: [],
    platform: (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '')) ? 'win32' : 'darwin'
  };
  let suiteEnhancerPrefs = {
    autoAccept: false,
    ghostSuggest: true,
    locale: 'zh-CN',
    capsuleLang: 'zh',
    englishLabels: false
  };
  const DEFAULT_SUITE_FEATURE_FLAGS = {
    showTopbarTokens: true,
    showTopbarCli: true,
    showTopbarQuota: true,
    showTopbarRemote: true,
    showQuickBar: true,
    showChatNav: true
  };
  let suiteFeatureFlags = { ...DEFAULT_SUITE_FEATURE_FLAGS };

  const DEFAULT_QUICK_PROMPTS = [
    { id: 'compact', label: '/compact 压缩', text: '/compact', title: '快速填入 /compact 压缩上下文命令' },
    { id: 'plan', label: '/plan 规划', text: '/plan ', title: '快速填入 /plan 前缀进入规划模式' },
    { id: 'reload', label: '重载规则', text: '重新读取 AGENTS', title: '快速填入“重新读取 AGENTS”指令' }
  ];

  function sanitizeQuickPromptsList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== 'object') continue;
      const label = String(item.label ?? '').trim();
      const text = String(item.text ?? '');
      if (!label || !text.trim()) continue;
      const rawId = String(item.id || '').trim();
      const id = rawId && /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `custom-${i}`;
      out.push({
        id,
        label: label.slice(0, 40),
        text: text.slice(0, 2000),
        title: String(item.title || '').trim().slice(0, 120)
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  let suiteQuickPrompts = (() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('ag_suite_quick_prompts') : '';
      if (raw) {
        const parsed = sanitizeQuickPromptsList(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch {}
    return null;
  })();

  const DEFAULT_REMOTE_DISPLAY_CONFIG = {
    showContextPanel: true,
    showUsagePanel: true,
    showQuotaPill: true,
    showChannelMeta: true,
    showSidebar: true,
    showThinking: true,
    showQuickChips: true,
    showComposerTools: true,
    showApprovals: true
  };

  function sanitizeRemoteDisplayConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const [k, defVal] of Object.entries(DEFAULT_REMOTE_DISPLAY_CONFIG)) {
      out[k] = typeof src[k] === 'boolean' ? src[k] : defVal;
    }
    return out;
  }

  const REMOTE_DISPLAY_BINDINGS = [
    ['set-remote-ctx-panel', 'showContextPanel'],
    ['set-remote-usage-panel', 'showUsagePanel'],
    ['set-remote-quota-pill', 'showQuotaPill'],
    ['set-remote-channel-meta', 'showChannelMeta'],
    ['set-remote-sidebar', 'showSidebar'],
    ['set-remote-thinking', 'showThinking'],
    ['set-remote-quick-chips', 'showQuickChips'],
    ['set-remote-composer-tools', 'showComposerTools'],
    ['set-remote-approvals', 'showApprovals']
  ];

  const DEFAULT_CLOUDFLARED_INSTALL_COMMANDS = {
    darwin: 'brew install cloudflared',
    win32: 'winget install --id Cloudflare.cloudflared',
    linux: 'mkdir -p ~/.local/bin && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared'
  };

  const remoteSettingsState = {
    loading: false,
    busy: false,
    pendingAction: '',
    data: null,
    error: '',
    tunnelConfigOpen: false,
    draftHost: null,
    draftToken: '',
    installPlatform: '',
    installCopiedAt: 0,
    installCopyTimer: null,
    pollTimer: null
  };

  function detectClientInstallPlatform(data) {
    const serverPlatform = String(data?.cloudflaredInstall?.platform || '').trim();
    if (serverPlatform && DEFAULT_CLOUDFLARED_INSTALL_COMMANDS[serverPlatform]) return serverPlatform;
    try {
      const navPlat = String(navigator?.platform || navigator?.userAgent || '').toLowerCase();
      if (navPlat.includes('mac') || navPlat.includes('darwin')) return 'darwin';
      if (navPlat.includes('win')) return 'win32';
    } catch {}
    return 'linux';
  }

  function resolveCloudflaredInstallGuideForSettings(data) {
    const serverCmds = (data?.cloudflaredInstall?.commands && typeof data.cloudflaredInstall.commands === 'object')
      ? data.cloudflaredInstall.commands
      : {};
    const commands = {
      darwin: String(serverCmds.darwin || DEFAULT_CLOUDFLARED_INSTALL_COMMANDS.darwin),
      win32: String(serverCmds.win32 || DEFAULT_CLOUDFLARED_INSTALL_COMMANDS.win32),
      linux: String(serverCmds.linux || DEFAULT_CLOUDFLARED_INSTALL_COMMANDS.linux)
    };
    const hostPlatform = detectClientInstallPlatform(data);
    const activePlatform = (remoteSettingsState.installPlatform && commands[remoteSettingsState.installPlatform])
      ? remoteSettingsState.installPlatform
      : hostPlatform;
    return {
      hostPlatform,
      activePlatform,
      command: commands[activePlatform] || commands.darwin,
      commands
    };
  }

  async function copyRemoteInstallCommand(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
      if (navigator?.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = Boolean(document.execCommand && document.execCommand('copy'));
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function escapeSuiteHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function suiteTr(zh, en) {
    const entry = findSupportedLocaleEntry(suiteEnhancerPrefs.locale);
    return entry.hansCode === 'en' ? en : zh;
  }

  function onSuiteSettingsClosed() {
    if (remoteSettingsState.pollTimer) {
      clearTimeout(remoteSettingsState.pollTimer);
      remoteSettingsState.pollTimer = null;
    }
    if (remoteSettingsState.installCopyTimer) {
      clearTimeout(remoteSettingsState.installCopyTimer);
      remoteSettingsState.installCopyTimer = null;
    }
    remoteSettingsState.tunnelConfigOpen = false;
    remoteSettingsState.draftHost = null;
    remoteSettingsState.draftToken = '';
  }

  function findSupportedLocaleEntry(codeRaw) {
    const clean = String(codeRaw || '').trim();
    if (!clean) return SUITE_SUPPORTED_LOCALES[0];
    const lower = clean.toLowerCase();
    const exact = SUITE_SUPPORTED_LOCALES.find(item => item.code.toLowerCase() === lower);
    if (exact) return exact;
    if (lower === 'zh' || lower === 'zh-hans' || lower === 'cn') {
      return SUITE_SUPPORTED_LOCALES.find(item => item.code === 'zh-CN') || SUITE_SUPPORTED_LOCALES[0];
    }
    if (lower.startsWith('en')) {
      return SUITE_SUPPORTED_LOCALES.find(item => item.code === 'en') || SUITE_SUPPORTED_LOCALES[0];
    }
    return SUITE_SUPPORTED_LOCALES.find(item => lower.startsWith(item.code.toLowerCase().split('-')[0])) || SUITE_SUPPORTED_LOCALES[0];
  }

  try {
    const lsTerm = localStorage?.getItem?.('ag_suite_terminal_app');
    if (lsTerm) suiteTerminalState.terminalApp = lsTerm;
    const lsTermPath = localStorage?.getItem?.('ag_suite_custom_term_path');
    if (lsTermPath) suiteTerminalState.customTerminalPath = lsTermPath;
    const lsCliSkip = localStorage?.getItem?.('ag_suite_cli_skip_perms');
    if (lsCliSkip === 'true' || lsCliSkip === 'false') suiteTerminalState.cliSkipPermissions = lsCliSkip === 'true';
    const lsCliModel = localStorage?.getItem?.('ag_suite_cli_model');
    if (typeof lsCliModel === 'string') suiteTerminalState.cliDefaultModel = lsCliModel.trim();
    const lsCliMuxHost = localStorage?.getItem?.('ag_suite_cli_mux_host');
    if (typeof lsCliMuxHost === 'string') suiteTerminalState.cliMuxHost = lsCliMuxHost.trim();
    const lsAutoAccept = localStorage?.getItem?.('ag_suite_auto_accept');
    if (lsAutoAccept === 'true' || lsAutoAccept === 'false') suiteEnhancerPrefs.autoAccept = lsAutoAccept === 'true';
    const lsGhost = localStorage?.getItem?.('ag_suite_ghost_suggest');
    if (lsGhost === 'true' || lsGhost === 'false') suiteEnhancerPrefs.ghostSuggest = lsGhost !== 'false';
    const lsLocale = localStorage?.getItem?.('ag_suite_locale')
      || localStorage?.getItem?.('antigravityHansLang')
      || localStorage?.getItem?.('__agy_ctx_lang__');
    if (lsLocale) {
      const entry = findSupportedLocaleEntry(lsLocale);
      suiteEnhancerPrefs.locale = entry.code;
      suiteEnhancerPrefs.capsuleLang = entry.capsuleLang;
    }
    const lsEngLbl = localStorage?.getItem?.('antigravityHansEnglishLabels');
    if (lsEngLbl === '1' || lsEngLbl === '0') {
      suiteEnhancerPrefs.englishLabels = lsEngLbl === '1';
    }
    const lsFeatFlags = localStorage?.getItem?.('ag_suite_feature_flags');
    if (lsFeatFlags) {
      const parsedFeat = JSON.parse(lsFeatFlags);
      if (parsedFeat && typeof parsedFeat === 'object') {
        for (const k of Object.keys(DEFAULT_SUITE_FEATURE_FLAGS)) {
          if (typeof parsedFeat[k] === 'boolean') suiteFeatureFlags[k] = parsedFeat[k];
        }
      }
    }
  } catch {}

  function isRealShadowDomTree() {
    const slot = el('settings-slot-heatmap-colors');
    const qs = typeof shadow.querySelector === 'function' ? shadow.querySelector('#settings-slot-heatmap-colors') : null;
    return Boolean(slot?.parentNode || slot?.parentElement || qs);
  }

  function enhanceSuiteDropdownsOnce() {
    if (suiteDropdownsEnhanced) return;
    if (!isRealShadowDomTree() || typeof enhanceCustomSelect !== 'function') return;
    suiteDropdownsEnhanced = true;
    try { uiCliModelDropdown = enhanceCustomSelect('set-cli-model-select'); } catch {}
    try { uiCliMuxHostDropdown = enhanceCustomSelect('set-cli-mux-host-select'); } catch {}
    try { uiLangDropdown = enhanceCustomSelect('set-ui-language-select'); } catch {}
  }

  function transplantConfigControlsOnce() {
    if (suiteConfigTransplanted) return true;
    if (!isRealShadowDomTree()) return false;
    suiteConfigTransplanted = true;

    const moveTo = (nodeId, slotId) => {
      const node = el(nodeId);
      const slot = el(slotId);
      if (node && slot && typeof slot.appendChild === 'function') {
        slot.appendChild(node);
        return node;
      }
      return node;
    };

    // 1. 外观与主题配置移入「外观与主题」分页，并移除原面板内的调色抽屉
    const tokColorsBody = moveTo('token-color-drawer-body', 'settings-slot-heatmap-colors');
    if (tokColorsBody) tokColorsBody.style.display = 'block';
    const mBg = el('token-drawer-mirror-bg');
    const mAcc = el('token-drawer-mirror-accent');
    if (mBg) mBg.style.display = 'none';
    if (mAcc) mAcc.style.display = 'none';
    el('token-colors-drawer')?.remove?.();

    const meterColorsBody = moveTo('color-drawer-body', 'settings-slot-meter-colors');
    if (meterColorsBody) meterColorsBody.style.display = 'block';
    el('meter-colors-drawer')?.remove?.();

    // 2. 订阅与套餐配置移入「套餐与订阅」分页，原 Token 面板保留只读信息与跳转按钮
    moveTo('plan-save-feedback', 'settings-slot-sub-feedback');
    moveTo('direct-subtier-select', 'settings-slot-subtier');
    moveTo('direct-subtier-wrap', 'settings-slot-subtier');
    moveTo('direct-country-select', 'settings-slot-country');
    moveTo('direct-country-wrap', 'settings-slot-country');
    moveTo('direct-region-wrap', 'settings-slot-region');
    moveTo('direct-currency-select', 'settings-slot-currency');
    moveTo('direct-currency-wrap', 'settings-slot-currency');
    moveTo('price-mode-switch-group', 'settings-slot-pricemode');
    const customForm = moveTo('plan-custom-form', 'settings-slot-custom-plan-form');
    if (customForm) {
      customForm.setAttribute?.('data-in-settings', 'true');
      customForm.style.display = 'none';
    }
    const presetSel = el('select-custom-region-preset');
    if (presetSel?.parentElement) {
      presetSel.parentElement.style.display = 'none';
    }
    const countryCol = el('input-custom-country')?.parentElement;
    if (countryCol) countryCol.style.display = 'none';
    const regionCol = el('input-custom-region')?.parentElement;
    if (regionCol) regionCol.style.display = 'none';
    const paidCol = el('input-custom-paid')?.parentElement?.parentElement;
    if (paidCol) paidCol.style.gridColumn = '1 / -1';

    el('summary-subtier-wrap')?.remove?.();
    el('btn-edit-plan-custom')?.remove?.();
    ['p-det-subtier-readonly', 'p-det-country', 'p-det-region', 'p-det-currency'].forEach(id => {
      const node = el(id);
      if (node) {
        node.style.display = 'inline-block';
      }
    });

    // 3. 网络代理移入「网络与高级」分页，并移除 #panel 内原有抽屉
    moveTo('proxy-badge', 'settings-slot-proxy-badge');
    const proxyBody = moveTo('proxy-drawer-body', 'settings-slot-proxy');
    if (proxyBody) proxyBody.style.display = 'block';
    el('proxy-notun-drawer')?.remove?.();

    enhanceSuiteDropdownsOnce();
    return true;
  }

  function syncSettingsSubPreview() {
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const planEl = el('settings-sub-preview-plan');
    const poolsEl = el('settings-sub-preview-pools');
    const priceEl = el('settings-sub-preview-price');
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const qpd = ps.quotaPoolDisplay || (core?.resolvePlanQuotaPools ? core.resolvePlanQuotaPools(ps) : null);

    if (planEl) {
      planEl.textContent = `当前套餐：${ps.tierName || 'Google AI Pro'}${ps.email ? ` (${ps.email})` : ''}`;
    }
    if (poolsEl) {
      poolsEl.textContent = qpd ? `${qpd.promptPoolText} · ${qpd.flowPoolText}` : '按当前套餐配额执行';
    }
    if (priceEl) {
      const valText = el('plan-summary-price-val')?.textContent || '';
      const cnyText = el('plan-summary-price-cny')?.textContent || '';
      priceEl.textContent = valText ? `${valText} ${cnyText}`.trim() : '--';
    }
    const isUltraPlan = ps.tierKey === 'ultra' || Boolean(ps.ultraSubTier);
    const subDt = el('settings-subtier-dt');
    const subDd = el('settings-subtier-dd');
    if (subDt && subDd) {
      subDt.style.display = isUltraPlan ? 'block' : 'none';
      subDd.style.display = isUltraPlan ? 'flex' : 'none';
    }
    syncCliOptionControls();
  }

  function syncSettingsThemePills() {
    setPillActive(el('set-theme-auto'), currentThemeMode === 'auto');
    setPillActive(el('set-theme-light'), currentThemeMode === 'light');
    setPillActive(el('set-theme-dark'), currentThemeMode === 'dark');
  }

  function dispatchSuitePrefsChanged() {
    const curEntry = findSupportedLocaleEntry(suiteEnhancerPrefs.locale);
    const activeLocale = suiteEnhancerPrefs.locale || 'zh-CN';
    const hansLangVal = curEntry.hansCode === 'en' ? 'en' : 'zh';
    try {
      if (typeof document !== 'undefined' && document.documentElement?.setAttribute) {
        document.documentElement.setAttribute('data-ag-suite-locale', activeLocale);
        document.documentElement.setAttribute('data-ag-hans-lang', hansLangVal);
      }
    } catch {}
    try {
      localStorage?.setItem?.('ag_suite_terminal_app', suiteTerminalState.terminalApp || 'auto');
      localStorage?.setItem?.('ag_suite_custom_term_path', suiteTerminalState.customTerminalPath || '');
      localStorage?.setItem?.('ag_suite_cli_skip_perms', suiteTerminalState.cliSkipPermissions ? 'true' : 'false');
      localStorage?.setItem?.('ag_suite_cli_model', suiteTerminalState.cliDefaultModel || '');
      localStorage?.setItem?.('ag_suite_cli_mux_host', suiteTerminalState.cliMuxHost || '');
      localStorage?.setItem?.('ag_suite_auto_accept', suiteEnhancerPrefs.autoAccept ? 'true' : 'false');
      localStorage?.setItem?.('ag_suite_ghost_suggest', suiteEnhancerPrefs.ghostSuggest ? 'true' : 'false');
      localStorage?.setItem?.('ag_suite_locale', activeLocale);
      localStorage?.setItem?.('__agy_ctx_lang__', curEntry.capsuleLang === 'en' ? 'en' : 'zh');
      localStorage?.setItem?.('antigravityHansLang', hansLangVal);
      localStorage?.setItem?.('antigravityHansEnglishLabels', suiteEnhancerPrefs.englishLabels ? '1' : '0');
      localStorage?.setItem?.('ag_suite_feature_flags', JSON.stringify(suiteFeatureFlags));
      if (suiteQuickPrompts === null) {
        localStorage?.removeItem?.('ag_suite_quick_prompts');
      } else {
        localStorage?.setItem?.('ag_suite_quick_prompts', JSON.stringify(suiteQuickPrompts));
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ag-suite-prefs-changed', {
          detail: {
            terminalApp: suiteTerminalState.terminalApp,
            customTerminalPath: suiteTerminalState.customTerminalPath,
            cliSkipPermissions: Boolean(suiteTerminalState.cliSkipPermissions),
            cliDefaultModel: suiteTerminalState.cliDefaultModel || '',
            cliMuxHost: suiteTerminalState.cliMuxHost || '',
            autoAccept: suiteEnhancerPrefs.autoAccept,
            ghostSuggest: suiteEnhancerPrefs.ghostSuggest,
            locale: activeLocale,
            capsuleLang: curEntry.capsuleLang,
            hansCode: curEntry.hansCode,
            englishLabels: Boolean(suiteEnhancerPrefs.englishLabels),
            featureFlags: { ...suiteFeatureFlags },
            quickPrompts: suiteQuickPrompts ? suiteQuickPrompts.map(item => ({ ...item })) : null
          }
        }));
      }
    } catch {}
  }

  // 非破坏式 Shadow DOM 多语言切换器：基于 WeakMap 记录中文原文，支持切回 zh-CN 精确还原
  const suiteTextOriginals = new WeakMap();
  const suiteLeafOriginals = new WeakMap();
  const suiteAttrOriginals = new WeakMap();
  let suiteShadowObserver = null;
  let suiteTranslateApplying = false;
  let suiteTranslatePending = false;

  function translateSuiteString(raw, dict, patternsList) {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const lead = raw.slice(0, raw.indexOf(trimmed));
    const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
    if (dict && Object.prototype.hasOwnProperty.call(dict, trimmed)) {
      return lead + dict[trimmed] + tail;
    }
    if (Array.isArray(patternsList)) {
      for (const [re, rep] of patternsList) {
        if (re.test(trimmed)) {
          const next = typeof rep === 'function' ? trimmed.replace(re, rep) : trimmed.replace(re, rep);
          if (next !== trimmed) return lead + next + tail;
        }
      }
    }
    return raw;
  }

  function isProtectedSuiteLocaleSubtree(node) {
    let cur = node?.nodeType === 3 ? (node.parentElement || node.parentNode) : node;
    while (cur && cur !== shadow) {
      const tag = String(cur.tagName || '').toUpperCase();
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return true;
      if (cur.id === 'set-ui-language-select') return true;
      if (cur.getAttribute?.('data-target-select') === 'set-ui-language-select') return true;
      cur = cur.parentElement || cur.parentNode;
    }
    return false;
  }

  function restoreShadowNodeLocale(root) {
    const visit = (node) => {
      if (!node || node.nodeType === 8) return;
      if (node.nodeType === 3) {
        const rec = suiteTextOriginals.get(node);
        if (rec) {
          const cur = node.nodeValue !== undefined ? node.nodeValue : node.textContent;
          if (cur === rec.translated) {
            if (node.nodeValue !== undefined) node.nodeValue = rec.orig;
            else node.textContent = rec.orig;
          }
          suiteTextOriginals.delete(node);
        }
        return;
      }
      if (node.nodeType === 1) {
        const leafRec = suiteLeafOriginals.get(node);
        if (leafRec && (!node.childNodes || node.childNodes.length === 0)) {
          if (node.textContent === leafRec.translated) node.textContent = leafRec.orig;
          suiteLeafOriginals.delete(node);
        }
        const attrRecs = suiteAttrOriginals.get(node);
        if (attrRecs) {
          for (const [k, rec] of attrRecs.entries()) {
            if (node.getAttribute?.(k) === rec.translated) node.setAttribute(k, rec.orig);
          }
          suiteAttrOriginals.delete(node);
        }
      }
      for (const ch of (node.childNodes || [])) visit(ch);
    };
    visit(root);
  }

  function translateShadowSubtreeLocale(root, dict, patternsList) {
    const visit = (node) => {
      if (!node || node.nodeType === 8) return;
      if (node.nodeType === 3) {
        if (isProtectedSuiteLocaleSubtree(node)) return;
        const cur = node.nodeValue !== undefined ? node.nodeValue : node.textContent;
        const next = translateSuiteString(cur, dict, patternsList);
        if (next && next !== cur) {
          const prevRec = suiteTextOriginals.get(node);
          const orig = prevRec ? prevRec.orig : cur;
          suiteTextOriginals.set(node, { orig, translated: next });
          if (node.nodeValue !== undefined) node.nodeValue = next;
          else node.textContent = next;
        }
        return;
      }
      if (node.nodeType === 1) {
        if (isProtectedSuiteLocaleSubtree(node)) return;
        const tag = String(node.tagName || '').toUpperCase();
        if ((!node.childNodes || node.childNodes.length === 0) && tag !== 'INPUT' && tag !== 'TEXTAREA' && node.textContent) {
          const curLeaf = node.textContent;
          const nextLeaf = translateSuiteString(curLeaf, dict, patternsList);
          if (nextLeaf && nextLeaf !== curLeaf) {
            const prevLeaf = suiteLeafOriginals.get(node);
            suiteLeafOriginals.set(node, { orig: prevLeaf ? prevLeaf.orig : curLeaf, translated: nextLeaf });
            node.textContent = nextLeaf;
          }
        }
        for (const attrName of ['title', 'placeholder', 'aria-label']) {
          const attrVal = node.getAttribute?.(attrName);
          if (!attrVal) continue;
          const nextAttr = translateSuiteString(attrVal, dict, patternsList);
          if (nextAttr && nextAttr !== attrVal) {
            let map = suiteAttrOriginals.get(node);
            if (!map) suiteAttrOriginals.set(node, (map = new Map()));
            const prevAttr = map.get(attrName);
            map.set(attrName, { orig: prevAttr ? prevAttr.orig : attrVal, translated: nextAttr });
            node.setAttribute(attrName, nextAttr);
          }
        }
      }
      for (const ch of (node.childNodes || [])) visit(ch);
    };
    visit(root);
  }

  function ensureSuiteShadowObserver(active) {
    if (!active) {
      if (suiteShadowObserver) {
        try { suiteShadowObserver.disconnect(); } catch {}
      }
      return;
    }
    if (typeof MutationObserver !== 'function') return;
    if (!suiteShadowObserver) {
      suiteShadowObserver = new MutationObserver(() => {
        if (suiteTranslateApplying || suiteTranslatePending) return;
        suiteTranslatePending = true;
        setTimeout(() => {
          suiteTranslatePending = false;
          applySuiteShadowLocale();
        }, 0);
      });
    }
    try {
      suiteShadowObserver.observe(shadow, { childList: true, subtree: true, characterData: true });
    } catch {}
  }

  function applySuiteShadowLocale() {
    if (!shadow || suiteTranslateApplying) return;
    const entry = findSupportedLocaleEntry(suiteEnhancerPrefs.locale);
    const isZh = /^(?:zh|cn)/i.test(entry.code) && !entry.uiDict;
    suiteTranslateApplying = true;
    try {
      ensureSuiteShadowObserver(false);
      restoreShadowNodeLocale(shadow);
      if (!isZh && entry.uiDict) {
        translateShadowSubtreeLocale(shadow, entry.uiDict, entry.uiPatterns);
      }
      try { uiCliModelDropdown?.refresh?.(); } catch {}
      try { uiCliMuxHostDropdown?.refresh?.(); } catch {}
      try { uiLangDropdown?.refresh?.(); } catch {}
      if (!isZh) ensureSuiteShadowObserver(true);
    } finally {
      suiteTranslateApplying = false;
    }
  }

  function syncLanguageDropdownOptions() {
    const sel = el('set-ui-language-select');
    if (!sel) return;
    const existing = new Map();
    if (sel.options) {
      for (const opt of Array.from(sel.options)) {
        if (opt?.value) existing.set(String(opt.value), opt);
      }
    }
    for (const loc of SUITE_SUPPORTED_LOCALES) {
      const opt = existing.get(loc.code);
      if (opt) {
        if (opt.textContent !== loc.label) opt.textContent = loc.label;
      } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const newOpt = document.createElement('option');
        newOpt.value = loc.code;
        newOpt.textContent = loc.label;
        sel.appendChild?.(newOpt);
      }
    }
    sel.value = suiteEnhancerPrefs.locale || 'zh-CN';
    uiLangDropdown?.refresh?.();
  }

  function syncCliOptionControls() {
    const chkSkip = el('set-cli-skip-permissions');
    if (chkSkip) chkSkip.checked = Boolean(suiteTerminalState.cliSkipPermissions);

    const sel = el('set-cli-model-select');
    const customRow = el('cli-custom-model-row');
    const customInp = el('input-cli-custom-model');
    if (!sel) return;

    // 合并宿主下发的可用模型（例如升级出新模型时无需等手动加字典）
    const hostModels = ANTIGRAVITY_TOKEN_DATA?.planStatus?.cascadeModelConfigs;
    if (Array.isArray(hostModels) && sel.options && typeof document?.createElement === 'function') {
      const existingVals = new Set(Array.from(sel.options).map(o => String(o.value || '')));
      const customOpt = Array.from(sel.options).find(o => o.value === '__custom__') || null;
      for (const m of hostModels) {
        if (!m || m.disabled || m.unavailable || m.isHistorical) continue;
        const mid = String(m.modelId || m.model || '').trim();
        if (!mid || !/^[a-z0-9._-]+$/i.test(mid) || /^MODEL_PLACEHOLDER_/i.test(mid)) continue;
        if (!existingVals.has(mid)) {
          const opt = document.createElement('option');
          opt.value = mid;
          opt.textContent = m.label || mid;
          if (customOpt && typeof sel.insertBefore === 'function') sel.insertBefore(opt, customOpt);
          else sel.appendChild?.(opt);
          existingVals.add(mid);
        }
      }
    }

    const curModel = String(suiteTerminalState.cliDefaultModel || '').trim();
    const optVals = sel.options ? Array.from(sel.options).map(o => String(o.value || '')) : [];
    const isCustomModel = Boolean(curModel) && !optVals.includes(curModel);
    if (isCustomModel) {
      sel.value = '__custom__';
      if (customRow) customRow.style.display = 'flex';
      if (customInp && customInp.value !== curModel) customInp.value = curModel;
    } else {
      sel.value = curModel;
      if (customRow && sel.value !== '__custom__') customRow.style.display = 'none';
    }
    uiCliModelDropdown?.refresh?.();

    const hostPrefRow = el('cli-mux-host-pref-row');
    const hostSel = el('set-cli-mux-host-select');
    const customHostRow = el('cli-custom-mux-host-row');
    const customHostInp = el('input-cli-mux-host');
    const termList = suiteTerminalState.terminals.length ? suiteTerminalState.terminals : getFallbackTerminalCatalog().terminals;
    const curApp = String(suiteTerminalState.terminalApp || 'auto').toLowerCase();
    const curTermObj = termList.find(t => t.id === curApp);
    const supportsMuxHost = Boolean(curTermObj?.supportsMuxHost)
      || ['rex', 'wezterm', 'tmux', 'custom'].includes(curApp)
      || Boolean(suiteTerminalState.cliMuxHost);
    if (hostPrefRow) {
      hostPrefRow.style.display = supportsMuxHost ? '' : 'none';
    }
    if (!supportsMuxHost && customHostRow) {
      customHostRow.style.display = 'none';
    }
    if (hostSel) {
      const detectedHosts = Array.isArray(suiteTerminalState.muxHosts) ? suiteTerminalState.muxHosts : [];
      if (detectedHosts.length && typeof document?.createElement === 'function') {
        const customOpt = hostSel.options
          ? Array.from(hostSel.options).find(o => String(o.value || '') === '__custom__')
          : null;
        // 清理旧的动态选项，保留 '' (本机) 与 '__custom__'
        if (hostSel.options) {
          for (const opt of Array.from(hostSel.options)) {
            const v = String(opt?.value ?? '');
            if (v !== '' && v !== '__custom__') opt.remove?.();
          }
        }
        const seenHostVals = new Set(['', '__custom__']);
        for (const h of detectedHosts) {
          const hid = String(h?.id ?? '').trim();
          if (!hid || seenHostVals.has(hid)) continue;
          seenHostVals.add(hid);
          const opt = document.createElement('option');
          opt.setAttribute?.('value', hid);
          opt.value = hid;
          const srcTag = h?.source === 'rex' ? 'Rex' : (h?.source === 'wezterm' ? 'WezTerm' : 'Detected');
          opt.textContent = `${h?.label || hid} · ${srcTag}`;
          if (customOpt && typeof hostSel.insertBefore === 'function') hostSel.insertBefore(opt, customOpt);
          else hostSel.appendChild?.(opt);
        }
      }
      const curHost = String(suiteTerminalState.cliMuxHost || '').trim();
      const hostOptVals = hostSel.options ? Array.from(hostSel.options).map(o => String(o.value || '')) : [];
      const isCustomHost = Boolean(curHost) && !hostOptVals.includes(curHost);
      if (isCustomHost) {
        hostSel.value = '__custom__';
        if (customHostRow) customHostRow.style.display = supportsMuxHost ? 'flex' : 'none';
        if (customHostInp && customHostInp.value !== curHost) customHostInp.value = curHost;
      } else {
        hostSel.value = curHost;
        if (customHostRow && (!supportsMuxHost || hostSel.value !== '__custom__')) customHostRow.style.display = 'none';
      }
      uiCliMuxHostDropdown?.refresh?.();
    }
  }

  function applySuiteFeatureFlags() {
    if (host?.setAttribute && host?.removeAttribute) {
      const toggleAttr = (attr, visible) => {
        if (visible === false) host.setAttribute(attr, 'true');
        else host.removeAttribute(attr);
      };
      toggleAttr('data-hide-tokens', suiteFeatureFlags.showTopbarTokens);
      toggleAttr('data-hide-cli', suiteFeatureFlags.showTopbarCli);
      toggleAttr('data-hide-quota', suiteFeatureFlags.showTopbarQuota);
      toggleAttr('data-hide-remote', suiteFeatureFlags.showTopbarRemote);
    }
    if (suiteFeatureFlags.showTopbarTokens === false) {
      const pTok = el('panel-tokens');
      if (pTok && !pTok.hidden && typeof showPanel === 'function') showPanel('none');
    }
    try {
      const ge = globalThis.__AGEnhancer || window?.__AGEnhancer;
      if (suiteFeatureFlags.showTopbarQuota === false) ge?.closeQuotaPopover?.();
      if (suiteFeatureFlags.showTopbarRemote === false) ge?.closeRemotePopover?.();
    } catch {}
  }

  function syncFeatureFlagControls() {
    const map = [
      ['set-feat-tokens', 'showTopbarTokens'],
      ['set-feat-cli', 'showTopbarCli'],
      ['set-feat-quota', 'showTopbarQuota'],
      ['set-feat-remote', 'showTopbarRemote'],
      ['set-feat-quickbar', 'showQuickBar'],
      ['set-feat-chatnav', 'showChatNav']
    ];
    for (const [id, key] of map) {
      const chk = el(id);
      if (chk) chk.checked = suiteFeatureFlags[key] !== false;
    }
  }

  function getSuiteFeatureFlags() {
    return { ...suiteFeatureFlags };
  }

  async function setSuiteFeatureFlags(partialFlags = {}, opts = {}) {
    if (partialFlags && typeof partialFlags === 'object') {
      for (const k of Object.keys(DEFAULT_SUITE_FEATURE_FLAGS)) {
        if (typeof partialFlags[k] === 'boolean') {
          suiteFeatureFlags[k] = partialFlags[k];
        }
      }
    }
    syncFeatureFlagControls();
    applySuiteFeatureFlags();
    dispatchSuitePrefsChanged();
    if (opts.syncHost !== false) {
      await saveSuiteUiPrefs({ featureFlags: { ...suiteFeatureFlags } });
    }
    return { ...suiteFeatureFlags };
  }

  function syncEnhancerPrefControls() {
    const chkAuto = el('set-auto-accept');
    const chkGhost = el('set-ghost-suggest');
    const chkEngLbl = el('set-english-labels');
    if (chkAuto) chkAuto.checked = Boolean(suiteEnhancerPrefs.autoAccept);
    if (chkGhost) chkGhost.checked = Boolean(suiteEnhancerPrefs.ghostSuggest);
    if (chkEngLbl) chkEngLbl.checked = Boolean(suiteEnhancerPrefs.englishLabels);
    try {
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('[data-agy-hans-ui]')?.forEach?.(node => node.remove?.());
      }
    } catch {}
    syncFeatureFlagControls();
    applySuiteFeatureFlags();
    syncLanguageDropdownOptions();
    syncCliOptionControls();
    syncSettingsThemePills();
  }

  function getSupportedLocales() {
    return SUITE_SUPPORTED_LOCALES.map(item => ({ ...item }));
  }

  function registerSuiteLocale(def) {
    if (!def || typeof def !== 'object') return false;
    const code = String(def.code || '').trim();
    if (!code) return false;
    const label = String(def.label || code).trim();
    const isZhLike = /^(?:zh|cn)/i.test(code);
    const capsuleLang = def.capsuleLang === 'zh' || def.capsuleLang === 'en' ? def.capsuleLang : (isZhLike ? 'zh' : 'en');
    const hansCode = def.hansCode === 'zh' || def.hansCode === 'en' ? def.hansCode : (isZhLike ? 'zh' : 'en');
    const uiDict = (def.uiDict && typeof def.uiDict === 'object')
      ? def.uiDict
      : (!isZhLike && def.fallbackEn !== false ? SUITE_EN_UI_DICT : null);
    const uiPatterns = Array.isArray(def.uiPatterns)
      ? def.uiPatterns
      : (!isZhLike && def.fallbackEn !== false ? SUITE_EN_UI_PATTERNS : null);
    const idx = SUITE_SUPPORTED_LOCALES.findIndex(item => item.code.toLowerCase() === code.toLowerCase());
    const nextEntry = { code, hansCode, capsuleLang, label, uiDict, uiPatterns };
    if (idx >= 0) SUITE_SUPPORTED_LOCALES[idx] = nextEntry;
    else SUITE_SUPPORTED_LOCALES.push(nextEntry);
    syncLanguageDropdownOptions();
    return true;
  }

  function getSuiteLocale() {
    return suiteEnhancerPrefs.locale || 'zh-CN';
  }

  async function setSuiteLocale(localeCode, opts = {}) {
    const entry = findSupportedLocaleEntry(localeCode);
    suiteEnhancerPrefs.locale = entry.code;
    suiteEnhancerPrefs.capsuleLang = entry.capsuleLang;
    syncEnhancerPrefControls();
    dispatchSuitePrefsChanged();
    applySuiteShadowLocale();
    try {
      if (typeof window !== 'undefined' && typeof window.__antigravityZhSetLang === 'function') {
        window.__antigravityZhSetLang(entry.hansCode, false);
      }
    } catch {}
    if (opts.syncHost !== false) {
      await saveSuiteUiPrefs({
        locale: entry.code,
        panelLanguage: entry.code,
        capsuleLang: entry.capsuleLang
      });
    }
    return getSuiteLocale();
  }

  function getFallbackTerminalCatalog(platformHint) {
    const plat = platformHint || suiteTerminalState.platform || 'darwin';
    const customPath = suiteTerminalState.customTerminalPath || '';
    if (plat === 'win32') {
      return {
        ok: true,
        platform: 'win32',
        terminals: [
          { id: 'auto', name: '自动默认 (原生居中控制台)', installed: true, executablePath: 'cmd.exe' },
          { id: 'powershell', name: 'PowerShell', installed: true, executablePath: 'powershell.exe / pwsh.exe' },
          { id: 'cmd', name: 'CMD (命令提示符)', installed: true, executablePath: 'cmd.exe' },
          { id: 'gitbash', name: 'Git Bash', installed: false, executablePath: 'C:\\Program Files\\Git\\git-bash.exe' },
          { id: 'wsl', name: 'WSL (Linux 子系统)', installed: false, executablePath: 'wsl.exe' },
          { id: 'warp', name: 'Warp', installed: false, executablePath: '%LOCALAPPDATA%\\Programs\\Warp\\warp.exe' },
          { id: 'wt', name: 'Windows Terminal', installed: false, executablePath: 'wt.exe' },
          { id: 'custom', name: '自定义程序路径', installed: Boolean(customPath), executablePath: customPath || null, isCustom: true }
        ]
      };
    }
    return {
      ok: true,
      platform: 'darwin',
      terminals: [
        { id: 'auto', name: '自动默认 (Terminal.app)', installed: true, executablePath: '/System/Applications/Utilities/Terminal.app' },
        { id: 'terminal', name: 'Terminal (系统终端)', installed: true, executablePath: '/System/Applications/Utilities/Terminal.app' },
        { id: 'iterm2', name: 'iTerm2', installed: false, executablePath: '/Applications/iTerm.app' },
        { id: 'ghostty', name: 'Ghostty', installed: false, executablePath: '/Applications/Ghostty.app' },
        { id: 'warp', name: 'Warp', installed: false, executablePath: '/Applications/Warp.app' },
        { id: 'rex', name: 'Rex', installed: false, executablePath: '/Applications/Rex.app', supportsMuxHost: true },
        { id: 'kitty', name: 'Kitty', installed: false, executablePath: '/Applications/kitty.app' },
        { id: 'wezterm', name: 'WezTerm', installed: false, executablePath: '/Applications/WezTerm.app', supportsMuxHost: true },
        { id: 'tmux', name: 'tmux (多路复用器)', installed: false, executablePath: '/opt/homebrew/bin/tmux', supportsMuxHost: true },
        { id: 'alacritty', name: 'Alacritty', installed: false, executablePath: '/Applications/Alacritty.app' },
        { id: 'custom', name: '自定义程序路径', installed: Boolean(customPath), executablePath: customPath || null, isCustom: true, supportsMuxHost: true }
      ]
    };
  }

  async function saveSuiteUiPrefs(partialPrefs) {
    try {
      const payload = { uiPreferences: partialPrefs };
      await invokeHostBridge('/save-settings', payload, 'saveSettings');
    } catch {}
  }

  function renderTerminalGrid() {
    const grid = el('term-app-grid');
    const osBadge = el('term-os-badge');
    const customBox = el('term-custom-box');
    const customInput = el('input-custom-term-path');
    const statusEl = el('term-config-status');
    const platNameMap = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
    if (osBadge) osBadge.textContent = platNameMap[suiteTerminalState.platform] || suiteTerminalState.platform;
    if (customInput && customInput.value !== (suiteTerminalState.customTerminalPath || '')) {
      customInput.value = suiteTerminalState.customTerminalPath || '';
    }
    if (customBox) {
      customBox.setAttribute('data-active', String(suiteTerminalState.terminalApp === 'custom'));
    }

    const list = suiteTerminalState.terminals.length ? suiteTerminalState.terminals : getFallbackTerminalCatalog().terminals;
    const selectedItem = list.find(t => t.id === suiteTerminalState.terminalApp) || list[0];
    if (statusEl && selectedItem) {
      const pathHint = selectedItem.id === 'custom'
        ? (suiteTerminalState.customTerminalPath || '未设置路径')
        : (selectedItem.executablePath || '系统默认');
      const modelHint = suiteTerminalState.cliDefaultModel ? `模型: ${suiteTerminalState.cliDefaultModel}` : '模型: 默认';
      const skipHint = suiteTerminalState.cliSkipPermissions ? '免审核' : '标准权限';
      const hostHint = (selectedItem.supportsMuxHost || suiteTerminalState.cliMuxHost)
        ? ` · 主机: ${suiteTerminalState.cliMuxHost || '本机'}`
        : '';
      statusEl.textContent = `当前使用：${selectedItem.name} (${pathHint}) · ${modelHint}${hostHint} · ${skipHint}`;
    }

    if (!grid) return;
    if (typeof grid.replaceChildren === 'function') grid.replaceChildren();
    else grid.innerHTML = '';

    for (const item of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'term-option-card';
      card.setAttribute('data-terminal-id', item.id);
      card.setAttribute('data-installed', item.installed ? 'true' : 'false');
      card.setAttribute('data-selected', String(item.id === suiteTerminalState.terminalApp));
      card.title = item.description || item.executablePath || item.name;

      const topRow = document.createElement('div');
      topRow.className = 'term-option-top';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'term-option-name';
      nameSpan.textContent = item.name;

      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'term-option-badge';
      badgeSpan.setAttribute('data-installed', item.installed ? 'true' : 'false');
      badgeSpan.textContent = item.isCustom
        ? (item.installed ? '已配置' : '自定义')
        : (item.installed ? '已安装' : '未检测到');

      topRow.appendChild(nameSpan);
      topRow.appendChild(badgeSpan);

      const pathRow = document.createElement('div');
      pathRow.className = 'term-option-path';
      pathRow.textContent = item.executablePath || (item.isCustom ? '请填写或浏览选择终端程序路径' : '未在本机默认路径找到');

      card.appendChild(topRow);
      card.appendChild(pathRow);
      card.addEventListener('click', () => {
        void setSuiteTerminalSettings(item.id, suiteTerminalState.customTerminalPath);
      });
      grid.appendChild(card);
    }
  }

  async function refreshTerminalsList() {
    try {
      const customPath = suiteTerminalState.customTerminalPath || '';
      const res = await invokeHostBridge('/list-terminals', { customTerminalPath: customPath }, 'listTerminals');
      if (res && res.ok && Array.isArray(res.terminals)) {
        suiteTerminalState.platform = res.platform || suiteTerminalState.platform;
        suiteTerminalState.terminals = res.terminals;
        if (Array.isArray(res.muxHosts)) {
          suiteTerminalState.muxHosts = res.muxHosts;
        }
      } else {
        const fb = getFallbackTerminalCatalog();
        suiteTerminalState.platform = fb.platform;
        suiteTerminalState.terminals = fb.terminals;
      }
    } catch {
      const fb = getFallbackTerminalCatalog();
      suiteTerminalState.terminals = fb.terminals;
    }
    syncCliOptionControls();
    renderTerminalGrid();
    return { ...suiteTerminalState, terminals: [...suiteTerminalState.terminals], muxHosts: [...suiteTerminalState.muxHosts] };
  }

  async function setSuiteTerminalSettings(terminalApp, customTerminalPath, muxHost) {
    suiteTerminalState.terminalApp = String(terminalApp || 'auto').trim().toLowerCase() || 'auto';
    if (customTerminalPath !== undefined) {
      suiteTerminalState.customTerminalPath = String(customTerminalPath || '').trim();
    }
    const partial = {
      terminalApp: suiteTerminalState.terminalApp,
      customTerminalPath: suiteTerminalState.customTerminalPath
    };
    if (muxHost !== undefined) {
      const rawHost = String(muxHost ?? '').trim();
      suiteTerminalState.cliMuxHost = ['local', '__local__', '__custom__'].includes(rawHost.toLowerCase()) ? '' : rawHost;
      partial.cliMuxHost = suiteTerminalState.cliMuxHost;
    }
    syncCliOptionControls();
    dispatchSuitePrefsChanged();
    renderTerminalGrid();
    await saveSuiteUiPrefs(partial);
    return { ...suiteTerminalState };
  }

  async function setSuiteCliSettings(opts = {}, saveOpts = {}) {
    const partial = {};
    if (typeof opts.skipPermissions === 'boolean') {
      suiteTerminalState.cliSkipPermissions = opts.skipPermissions;
      partial.cliSkipPermissions = suiteTerminalState.cliSkipPermissions;
    }
    if (opts.model !== undefined) {
      const raw = String(opts.model ?? '').trim();
      const normalized = ['none', 'default', 'auto', '__custom__'].includes(raw.toLowerCase()) ? '' : raw;
      suiteTerminalState.cliDefaultModel = normalized;
      partial.cliDefaultModel = normalized;
    }
    if (opts.muxHost !== undefined) {
      const rawHost = String(opts.muxHost ?? '').trim();
      const normHost = ['local', '__local__', '__custom__'].includes(rawHost.toLowerCase()) ? '' : rawHost;
      suiteTerminalState.cliMuxHost = normHost;
      partial.cliMuxHost = normHost;
    }
    syncCliOptionControls();
    renderTerminalGrid();
    dispatchSuitePrefsChanged();
    if (saveOpts.syncHost !== false && Object.keys(partial).length > 0) {
      await saveSuiteUiPrefs(partial);
    }
    return getSuiteCliSettings();
  }

  function getSuiteCliSettings() {
    const m = String(suiteTerminalState.cliDefaultModel || '').trim();
    return {
      skipPermissions: Boolean(suiteTerminalState.cliSkipPermissions),
      model: m,
      noModel: !m
    };
  }

  function getSuiteTerminalSettings() {
    const cliCfg = getSuiteCliSettings();
    return {
      terminalApp: suiteTerminalState.terminalApp || 'auto',
      customTerminalPath: suiteTerminalState.customTerminalPath || '',
      muxHost: String(suiteTerminalState.cliMuxHost || '').trim(),
      skipPermissions: cliCfg.skipPermissions,
      model: cliCfg.model,
      noModel: cliCfg.noModel
    };
  }

  function applyHostUiPreferences(uiPrefs) {
    if (!uiPrefs || typeof uiPrefs !== 'object') return;
    if (typeof uiPrefs.terminalApp === 'string' && uiPrefs.terminalApp.trim()) {
      suiteTerminalState.terminalApp = uiPrefs.terminalApp.trim().toLowerCase();
    }
    if (typeof uiPrefs.customTerminalPath === 'string') {
      suiteTerminalState.customTerminalPath = uiPrefs.customTerminalPath.trim();
    }
    if (typeof uiPrefs.cliMuxHost === 'string') {
      suiteTerminalState.cliMuxHost = uiPrefs.cliMuxHost.trim();
    }
    if (typeof uiPrefs.cliSkipPermissions === 'boolean') {
      suiteTerminalState.cliSkipPermissions = uiPrefs.cliSkipPermissions;
    }
    if (typeof uiPrefs.cliDefaultModel === 'string') {
      suiteTerminalState.cliDefaultModel = uiPrefs.cliDefaultModel.trim();
    }
    if (typeof uiPrefs.autoAccept === 'boolean') {
      suiteEnhancerPrefs.autoAccept = uiPrefs.autoAccept;
    }
    if (typeof uiPrefs.ghostSuggest === 'boolean') {
      suiteEnhancerPrefs.ghostSuggest = uiPrefs.ghostSuggest;
    }
    const incomingLoc = uiPrefs.locale || uiPrefs.panelLanguage || uiPrefs.capsuleLang;
    if (typeof incomingLoc === 'string' && incomingLoc.trim()) {
      const entry = findSupportedLocaleEntry(incomingLoc);
      suiteEnhancerPrefs.locale = entry.code;
      suiteEnhancerPrefs.capsuleLang = entry.capsuleLang;
      try { window.__antigravityZhSetLang?.(entry.hansCode, false); } catch {}
    }
    if (typeof uiPrefs.englishLabels === 'boolean') {
      suiteEnhancerPrefs.englishLabels = uiPrefs.englishLabels;
      try { window.__antigravityZhSetEnglishLabels?.(suiteEnhancerPrefs.englishLabels, true); } catch {}
    }
    if (uiPrefs.featureFlags && typeof uiPrefs.featureFlags === 'object') {
      for (const k of Object.keys(DEFAULT_SUITE_FEATURE_FLAGS)) {
        if (typeof uiPrefs.featureFlags[k] === 'boolean') {
          suiteFeatureFlags[k] = uiPrefs.featureFlags[k];
        }
      }
    }
    if (typeof applyHostAppearancePreferences === 'function') {
      applyHostAppearancePreferences(uiPrefs);
    }
    if ('quickPrompts' in uiPrefs) {
      suiteQuickPrompts = uiPrefs.quickPrompts === null
        ? null
        : sanitizeQuickPromptsList(uiPrefs.quickPrompts);
    }
    dispatchSuitePrefsChanged();
    syncEnhancerPrefControls();
    applySuiteFeatureFlags();
    renderQuickPromptsEditor();
    renderTerminalGrid();
    applySuiteShadowLocale();
  }

  function getSuiteQuickPrompts() {
    return (suiteQuickPrompts || DEFAULT_QUICK_PROMPTS).map(item => ({ ...item }));
  }

  async function setSuiteQuickPrompts(list, opts = {}) {
    if (list === null) {
      suiteQuickPrompts = null;
    } else {
      const cleaned = sanitizeQuickPromptsList(list);
      suiteQuickPrompts = cleaned === null ? [] : cleaned;
    }
    dispatchSuitePrefsChanged();
    renderQuickPromptsEditor();
    const statusEl = el('quick-prompts-status');
    if (statusEl) {
      statusEl.textContent = suiteQuickPrompts === null
        ? suiteTr('✅ 已恢复默认快捷提示词', '✅ Quick prompts reset to default')
        : suiteTr(`✅ 已保存 ${suiteQuickPrompts.length} 条快捷提示词`, `✅ Saved ${suiteQuickPrompts.length} quick prompt(s)`);
    }
    if (!opts?.skipPersist) {
      await saveSuiteUiPrefs({
        quickPrompts: suiteQuickPrompts === null ? null : suiteQuickPrompts.map(item => ({ ...item }))
      });
    }
    return getSuiteQuickPrompts();
  }

  async function resetSuiteQuickPrompts() {
    return await setSuiteQuickPrompts(null);
  }

  function appendQuickPromptEditorRow(listEl, item, idx) {
    const row = document.createElement('div');
    row.className = 'qp-row';
    row.setAttribute('data-qp-idx', String(idx));

    const labelInp = document.createElement('input');
    labelInp.type = 'text';
    labelInp.className = 'qp-label-input';
    labelInp.placeholder = suiteTr('按钮文案 (如 /plan)', 'Button label');
    labelInp.value = String(item?.label || '');
    labelInp.setAttribute('value', labelInp.value);

    const textInp = document.createElement('input');
    textInp.type = 'text';
    textInp.className = 'qp-text-input';
    textInp.placeholder = suiteTr('填入输入框的完整提示词…', 'Prompt text to insert…');
    textInp.value = String(item?.text || '');
    textInp.setAttribute('value', textInp.value);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'qp-del-btn';
    delBtn.textContent = '×';
    delBtn.title = suiteTr('删除此条', 'Remove');
    delBtn.addEventListener('click', () => {
      row.remove?.();
    });

    row.appendChild(labelInp);
    row.appendChild(textInp);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }

  function renderQuickPromptsEditor() {
    const listEl = el('quick-prompts-editor-list');
    if (!listEl) return;
    listEl.replaceChildren();
    const items = suiteQuickPrompts !== null ? suiteQuickPrompts : DEFAULT_QUICK_PROMPTS;
    for (let i = 0; i < items.length; i++) {
      appendQuickPromptEditorRow(listEl, items[i], i);
    }
  }

  function collectQuickPromptsFromEditor() {
    const listEl = el('quick-prompts-editor-list');
    if (!listEl) return [];
    const rows = Array.from(listEl.querySelectorAll('.qp-row') || []);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const labelInp = row.querySelector('.qp-label-input');
      const textInp = row.querySelector('.qp-text-input');
      const label = String(labelInp?.value || '').trim();
      const text = String(textInp?.value || '');
      if (!label || !text.trim()) continue;
      out.push({
        id: `custom-${i}`,
        label: label.slice(0, 40),
        text: text.slice(0, 2000),
        title: label.slice(0, 120)
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  function broadcastRemoteStateChanged(data) {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ag-remote-state-changed', {
          detail: { data }
        }));
      }
    } catch {}
  }

  function getRemoteDisplayConfig() {
    return sanitizeRemoteDisplayConfig(remoteSettingsState.data?.remoteDisplay);
  }

  function syncRemoteDisplayCheckboxes(displayCfg) {
    const cfg = sanitizeRemoteDisplayConfig(displayCfg || remoteSettingsState.data?.remoteDisplay);
    for (const [elId, key] of REMOTE_DISPLAY_BINDINGS) {
      const box = el(elId);
      if (box) box.checked = Boolean(cfg[key]);
    }
  }

  function collectRemoteDisplayFromUI() {
    const out = {};
    for (const [elId, key] of REMOTE_DISPLAY_BINDINGS) {
      const box = el(elId);
      if (box) out[key] = Boolean(box.checked);
    }
    return sanitizeRemoteDisplayConfig({
      ...(remoteSettingsState.data?.remoteDisplay || DEFAULT_REMOTE_DISPLAY_CONFIG),
      ...out
    });
  }

  function resolveRemoteChannelsForSettings(data) {
    if (!data) return [];
    const tsList = Array.isArray(data.tailscaleUrls) ? data.tailscaleUrls : [];
    const lanList = Array.isArray(data.lanUrls) ? data.lanUrls : [];
    const rawHost = rawUrl => {
      try { return new URL(String(rawUrl || '')).hostname || ''; } catch { return ''; }
    };
    let channels = Array.isArray(data.channels) && data.channels.length
      ? data.channels.map(ch => ({ ...ch }))
      : [
          {
            key: 'lan',
            label: '局域网',
            labelEn: 'LAN',
            enabled: data.enabledChannels?.lan !== false,
            available: (data.enabledChannels?.lan !== false) && lanList.length > 0,
            displayHost: rawHost(lanList[0]?.url)
          },
          {
            key: 'tailscale',
            label: 'Tailscale',
            labelEn: 'Tailscale',
            enabled: data.enabledChannels?.tailscale !== false,
            available: (data.enabledChannels?.tailscale !== false) && tsList.length > 0,
            displayHost: data.tailscaleDnsName || rawHost(tsList[0]?.url)
          },
          {
            key: 'bonjour',
            label: 'Bonjour',
            labelEn: 'Bonjour',
            enabled: data.enabledChannels?.bonjour !== false,
            available: (data.enabledChannels?.bonjour !== false) && Boolean(data.bonjourHost && lanList.length > 0),
            displayHost: data.bonjourHost || ''
          },
          {
            key: 'tunnel',
            label: 'Cloudflare 隧道',
            labelEn: 'Cloudflare Tunnel',
            enabled: Boolean(data.enabledChannels?.tunnel),
            available: Boolean(data.tunnelAvailable),
            state: data.tunnelState || 'stopped',
            mode: data.tunnelMode || 'quick',
            displayHost: data.tunnelPublicUrl ? rawHost(data.tunnelPublicUrl) : '',
            tunnelHostname: data.tunnelHostname || '',
            error: data.tunnelError || ''
          }
        ];

    const switchingTunnelMode = Boolean(
      remoteSettingsState.busy &&
      (remoteSettingsState.pendingAction === 'quick' || remoteSettingsState.pendingAction === 'named')
    );
    if (switchingTunnelMode) {
      channels = channels.map(ch => (ch.key === 'tunnel'
        ? { ...ch, available: false, displayHost: '', rawHost: '' }
        : ch));
    }
    return channels;
  }

  function scheduleRemoteSettingsPoll() {
    if (remoteSettingsState.pollTimer) {
      clearTimeout(remoteSettingsState.pollTimer);
      remoteSettingsState.pollTimer = null;
    }
    if (activeSettingsTab !== 'remote') return;
    const chs = Array.isArray(remoteSettingsState.data?.channels) ? remoteSettingsState.data.channels : [];
    const tch = chs.find(c => c.key === 'tunnel');
    if (tch && tch.state === 'starting') {
      remoteSettingsState.pollTimer = setTimeout(() => {
        remoteSettingsState.pollTimer = null;
        if (activeSettingsTab === 'remote') {
          void loadRemoteSettingsInfo(false);
        }
      }, 1500);
    }
  }

  function renderRemoteSettingsChannels() {
    const root = el('settings-remote-channels-root');
    if (!root) return;
    const data = remoteSettingsState.data;
    const resetBtn = el('ag-remote-reset');
    const refreshBtn = el('btn-settings-remote-refresh');
    if (resetBtn) resetBtn.disabled = Boolean(remoteSettingsState.loading || remoteSettingsState.busy);
    if (refreshBtn) {
      refreshBtn.disabled = Boolean(remoteSettingsState.loading || remoteSettingsState.busy);
      refreshBtn.textContent = (remoteSettingsState.loading || remoteSettingsState.busy)
        ? suiteTr('处理中…', 'Working…')
        : suiteTr('刷新状态', 'Refresh');
    }

    if (remoteSettingsState.loading && !data) {
      root.innerHTML = `<div class="settings-card-desc">${escapeSuiteHtml(suiteTr('⏳ 正在读取远程通道状态…', '⏳ Loading remote channels…'))}</div>`;
      return;
    }
    if (!data) {
      root.innerHTML = `<div class="ag-rp-err">${escapeSuiteHtml(remoteSettingsState.error || suiteTr('未能连接到本地远程桥接服务', 'Failed to connect to local remote bridge'))}</div>`;
      return;
    }

    const channels = resolveRemoteChannelsForSettings(data);
    const availableList = channels.filter(c => (c.enabled !== false) && c.available);
    const activeChannel = availableList.find(c => c.key === 'tunnel')
      || availableList.find(c => c.key === 'tailscale')
      || availableList.find(c => c.key === 'lan')
      || availableList[0]
      || null;
    const activeKey = activeChannel?.key || 'none';
    const tunnelCh = channels.find(c => c.key === 'tunnel') || null;
    const busyAny = Boolean(remoteSettingsState.loading || remoteSettingsState.busy);
    const switchingTunnelMode = Boolean(
      remoteSettingsState.busy &&
      (remoteSettingsState.pendingAction === 'quick' || remoteSettingsState.pendingAction === 'named')
    );

    const channelsHtml = `<div class="ag-rp-channels">${channels.map(ch => {
      const label = suiteTr(ch.label || ch.key, ch.labelEn || ch.label || ch.key);
      if (ch.key === 'tunnel') {
        const isStarting = switchingTunnelMode || ch.state === 'starting';
        const isRunning = !switchingTunnelMode && ch.state === 'running' && ch.available;
        const checked = !switchingTunnelMode && Boolean(ch.enabled || isRunning || ch.state === 'starting');
        const isNamedMode = ch.mode === 'named';
        const modeHint = isNamedMode ? suiteTr('固定域名', 'Fixed Domain') : suiteTr('免登录零配置', 'Quick (Zero-Config)');
        const cfgBtnLabel = isNamedMode ? suiteTr('固定域名 ▾', 'Fixed Domain ▾') : suiteTr('免登录零配置 ▾', 'Zero-Config ▾');
        const statusHint = switchingTunnelMode
          ? (remoteSettingsState.pendingAction === 'quick'
              ? suiteTr('正在切换临时隧道…', 'Switching to quick tunnel…')
              : suiteTr('正在切换固定域名…', 'Switching to fixed domain…'))
          : isStarting
            ? (ch.displayHost || suiteTr('正在分配公网隧道…', 'Provisioning Tunnel…'))
            : (isRunning
                ? (ch.displayHost || modeHint)
                : (ch.binaryAvailable === false
                    ? suiteTr('缺少 cloudflared（见下方一键安装命令）', 'cloudflared not found (see install guide below)')
                    : suiteTr('免登录零配置 · 点击启用', 'Zero-Config · Click to enable')));
        return `
          <div id="ag-rp-tunnel-toggle" class="ag-rp-channel ag-rp-check" role="checkbox" tabindex="0" aria-checked="${checked ? 'true' : 'false'}" data-ch="tunnel" data-active="${activeKey === 'tunnel' ? 'true' : 'false'}" data-disabled="${busyAny ? 'true' : 'false'}">
            <span class="ag-rp-ch-check">
              <span aria-hidden="true">${checked ? '☑' : '☐'}</span>
              <span class="ag-rp-ch-name">${escapeSuiteHtml(label)}</span>
              <span class="ag-rp-ch-addr">${isStarting ? '<span class="ag-rp-spin"></span>' : ''}${escapeSuiteHtml(statusHint)}</span>
            </span>
            <button id="ag-rp-tunnel-cfg-btn" class="ag-rp-ch-cfg" type="button" title="${escapeSuiteHtml(suiteTr('切换免登录零配置或配置 Cloudflare 固定域名', 'Switch Quick Zero-Config or Configure Fixed Domain'))}">${escapeSuiteHtml(cfgBtnLabel)}</button>
          </div>
        `;
      }
      const checked = ch.enabled !== false;
      const addrHint = checked
        ? (ch.displayHost || (ch.available ? '' : suiteTr('当前网络不可用', 'Unavailable')))
        : suiteTr('已停用 · 点击重新启用', 'Disabled · Click to enable');
      return `
        <button id="ag-rp-toggle-${escapeSuiteHtml(ch.key)}" class="ag-rp-channel ag-rp-check" type="button" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" data-ch="${escapeSuiteHtml(ch.key)}" data-active="${activeKey === ch.key ? 'true' : 'false'}" ${busyAny ? 'disabled' : ''}>
          <span class="ag-rp-ch-check">
            <span aria-hidden="true">${checked ? '☑' : '☐'}</span>
            <span class="ag-rp-ch-name">${escapeSuiteHtml(label)}</span>
          </span>
          <span class="ag-rp-ch-addr">${escapeSuiteHtml(addrHint)}</span>
        </button>
      `;
    }).join('')}</div>`;

    const tunnelHostDraft = remoteSettingsState.draftHost !== null
      ? remoteSettingsState.draftHost
      : (tunnelCh?.tunnelHostname || '');
    const tunnelTokenDraft = remoteSettingsState.draftToken || '';
    const hasSavedToken = Boolean(tunnelCh?.hasTunnelToken || tunnelCh?.hasToken || data?.hasTunnelToken);
    const tokenConfiguredHint = hasSavedToken
      ? suiteTr('（已配置 Token，留空保留原值）', '(Token saved — leave blank to keep)')
      : suiteTr('（从 Cloudflare Zero Trust → Tunnels 获取）', '(From Cloudflare Zero Trust → Tunnels)');

    const formHtml = remoteSettingsState.tunnelConfigOpen ? `
      <div id="ag-rp-tunnel-form" class="ag-rp-tunnel-form">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <span>${escapeSuiteHtml(suiteTr('Cloudflare 固定域名（可选高级配置）', 'Cloudflare Fixed Domain (Optional)'))}</span>
          <a id="ag-rp-cf-get-token" href="https://one.dash.cloudflare.com/?to=/:account/networks/tunnels" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:none;font-weight:500;">${escapeSuiteHtml(suiteTr('前往 Cloudflare 获取 Token →', 'Get Token on Cloudflare →'))}</a>
        </div>
        <div class="ag-rp-tunnel-sub">${escapeSuiteHtml(suiteTr('默认已启用免登录临时隧道（零配置开箱可用）；仅当需要绑定自有固定域名时才需填写下方信息。', 'Quick Tunnel (zero-config, no login) is enabled by default. Only fill below if you want a custom fixed domain.'))}</div>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>${escapeSuiteHtml(suiteTr('自定义域名（例: ag.example.com）', 'Custom Hostname (e.g. ag.example.com)'))}</span>
          <input id="ag-rp-cf-host" class="ag-rp-input" type="text" placeholder="ag.example.com" value="${escapeSuiteHtml(tunnelHostDraft)}" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>${escapeSuiteHtml(`Tunnel Token ${tokenConfiguredHint}`)}</span>
          <input id="ag-rp-cf-token" class="ag-rp-input" type="password" placeholder="eyJ..." value="${escapeSuiteHtml(tunnelTokenDraft)}" />
        </label>
        <div class="ag-rp-form-actions">
          <button id="ag-rp-cf-save" class="ag-rp-btn primary" type="button" ${busyAny ? 'disabled' : ''}>${remoteSettingsState.pendingAction === 'named' && remoteSettingsState.busy ? '<span class="ag-rp-spin"></span>' : ''}${escapeSuiteHtml(suiteTr('保存并启用', 'Save & Enable'))}</button>
          <button id="ag-rp-cf-quick" class="ag-rp-btn" type="button" ${busyAny ? 'disabled' : ''}>${remoteSettingsState.pendingAction === 'quick' && remoteSettingsState.busy ? '<span class="ag-rp-spin"></span>' : ''}${escapeSuiteHtml(suiteTr('改用免登录临时隧道', 'Use Quick Tunnel'))}</button>
          <button id="ag-rp-cf-cancel" class="ag-rp-btn" type="button">${escapeSuiteHtml(suiteTr('取消', 'Cancel'))}</button>
        </div>
      </div>
    ` : '';

    const installGuide = resolveCloudflaredInstallGuideForSettings(data);
    const missingCloudflared = tunnelCh?.binaryAvailable === false;
    const copiedInstallRecent = (Date.now() - remoteSettingsState.installCopiedAt) < 2000;
    const platformTabsHtml = [
      ['darwin', 'macOS'],
      ['win32', 'Windows'],
      ['linux', 'Linux']
    ].map(([platKey, platLabel]) => (
      `<button id="ag-rp-install-tab-${platKey}" class="ag-rp-install-tab" type="button" data-install-platform="${platKey}" data-active="${installGuide.activePlatform === platKey ? 'true' : 'false'}">${platLabel}</button>`
    )).join('');
    const installGuideHtml = `
      <div id="ag-rp-cf-install-guide" class="ag-rp-install-guide" data-missing="${missingCloudflared ? 'true' : 'false'}">
        <div class="ag-rp-install-hdr">
          <span class="ag-rp-install-title">
            <span>${escapeSuiteHtml(missingCloudflared
              ? suiteTr('安装 cloudflared（免登录零配置隧道依赖）', 'Install cloudflared (Required for Zero-Config Tunnel)')
              : suiteTr('cloudflared 安装命令引导', 'cloudflared Install Command'))}</span>
            <span class="ag-rp-install-badge">${escapeSuiteHtml(missingCloudflared
              ? suiteTr('未检测到', 'Not Found')
              : suiteTr('✓ 本机已安装', '✓ Installed'))}</span>
          </span>
          <div class="ag-rp-install-tabs" role="tablist" aria-label="${escapeSuiteHtml(suiteTr('选择操作系统', 'Select OS'))}">${platformTabsHtml}</div>
        </div>
        <div class="ag-rp-install-cmd-row">
          <code id="ag-rp-cf-install-cmd" class="ag-rp-install-cmd" title="${escapeSuiteHtml(installGuide.command)}">${escapeSuiteHtml(installGuide.command)}</code>
          <button id="ag-rp-cf-copy-install" class="ag-rp-btn${missingCloudflared ? ' primary' : ''}" type="button" title="${escapeSuiteHtml(suiteTr('一键复制安装命令', 'Copy install command'))}">${escapeSuiteHtml(copiedInstallRecent ? suiteTr('✓ 已复制', '✓ Copied') : suiteTr('📋 复制命令', '📋 Copy'))}</button>
        </div>
        <div class="ag-rp-install-foot">
          <span>${escapeSuiteHtml(missingCloudflared
            ? suiteTr('在终端粘贴运行上方命令完成安装后，点击右侧重新检测即可零配置启用公网隧道。', 'Run the command above in Terminal, then click Re-check to enable zero-config public tunnel.')
            : suiteTr('无需注册或登录 Cloudflare 账号；在新设备部署时可一键复制上方命令安装。', 'No Cloudflare account required; copy the command above when setting up on a new machine.'))}</span>
          ${missingCloudflared
            ? `<button id="ag-rp-cf-recheck" class="ag-rp-btn" type="button" ${busyAny ? 'disabled' : ''}>${escapeSuiteHtml(suiteTr('↻ 重新检测', '↻ Re-check'))}</button>`
            : ''}
        </div>
      </div>
    `;

    const errMsg = tunnelCh?.error || remoteSettingsState.error || '';
    const errHtml = errMsg ? `<div class="ag-rp-err">${escapeSuiteHtml(errMsg)}</div>` : '';

    root.innerHTML = `${channelsHtml}${formHtml}${installGuideHtml}${errHtml}`;

    channels.filter(c => c.key !== 'tunnel').forEach(ch => {
      const btn = root.querySelector(`#ag-rp-toggle-${ch.key}`);
      btn?.addEventListener('click', ev => {
        ev.stopPropagation();
        if (remoteSettingsState.busy) return;
        const nextOn = ch.enabled === false;
        void configureRemoteSettings({ enabledChannels: { [ch.key]: nextOn } });
      });
    });

    const toggleRow = root.querySelector('#ag-rp-tunnel-toggle');
    const cfgBtn = root.querySelector('#ag-rp-tunnel-cfg-btn');
    cfgBtn?.addEventListener('click', ev => {
      ev.stopPropagation();
      remoteSettingsState.tunnelConfigOpen = !remoteSettingsState.tunnelConfigOpen;
      remoteSettingsState.error = '';
      renderRemoteSettingsChannels();
    });
    const onTunnelRowToggle = ev => {
      if (ev.target && cfgBtn && (ev.target === cfgBtn || cfgBtn.contains?.(ev.target))) return;
      ev.stopPropagation();
      if (remoteSettingsState.busy) return;
      const isOn = Boolean(tunnelCh?.enabled || tunnelCh?.state === 'running' || tunnelCh?.state === 'starting');
      void configureRemoteSettings({ enabled: !isOn, enabledChannels: { tunnel: !isOn } });
    };
    toggleRow?.addEventListener('click', onTunnelRowToggle);
    toggleRow?.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onTunnelRowToggle(ev);
      }
    });

    const cfLink = root.querySelector('#ag-rp-cf-get-token');
    cfLink?.addEventListener('click', async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const targetUrl = cfLink.getAttribute('href') || 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels';
      try {
        await invokeHostBridge('/open-external-url', { url: targetUrl, dryRun: false }, 'openExternalUrl');
      } catch {}
    });

    const hostInput = root.querySelector('#ag-rp-cf-host');
    const tokenInput = root.querySelector('#ag-rp-cf-token');
    hostInput?.addEventListener('input', ev => {
      remoteSettingsState.draftHost = String(ev?.target?.value ?? hostInput.value ?? '');
    });
    tokenInput?.addEventListener('input', ev => {
      remoteSettingsState.draftToken = String(ev?.target?.value ?? tokenInput.value ?? '');
    });

    root.querySelector('#ag-rp-cf-save')?.addEventListener('click', ev => {
      ev.stopPropagation();
      const hostname = String(hostInput?.value ?? remoteSettingsState.draftHost ?? '').trim();
      const token = String(tokenInput?.value ?? remoteSettingsState.draftToken ?? '').trim();
      remoteSettingsState.draftHost = hostname;
      remoteSettingsState.draftToken = token;
      if (!hostname) {
        remoteSettingsState.error = suiteTr('请先填写自定义域名（如 ag.example.com）', 'Please enter a custom hostname');
        remoteSettingsState.tunnelConfigOpen = true;
        renderRemoteSettingsChannels();
        return;
      }
      if (!token && !hasSavedToken) {
        remoteSettingsState.error = suiteTr('首次配置固定域名请粘贴 Cloudflare Tunnel Token', 'Paste Cloudflare Tunnel Token for fixed domain');
        remoteSettingsState.tunnelConfigOpen = true;
        renderRemoteSettingsChannels();
        return;
      }
      void configureRemoteSettings({
        enabled: true,
        enabledChannels: { tunnel: true },
        tunnelMode: 'named',
        tunnelHostname: hostname,
        ...(token ? { tunnelToken: token } : {})
      });
    });

    root.querySelector('#ag-rp-cf-quick')?.addEventListener('click', ev => {
      ev.stopPropagation();
      remoteSettingsState.tunnelConfigOpen = true;
      void configureRemoteSettings({
        enabled: true,
        enabledChannels: { tunnel: true },
        tunnelMode: 'quick'
      });
    });

    root.querySelector('#ag-rp-cf-cancel')?.addEventListener('click', ev => {
      ev.stopPropagation();
      remoteSettingsState.tunnelConfigOpen = false;
      remoteSettingsState.draftHost = null;
      remoteSettingsState.draftToken = '';
      remoteSettingsState.error = '';
      renderRemoteSettingsChannels();
    });

    ['darwin', 'win32', 'linux'].forEach(plat => {
      const tabBtn = root.querySelector(`#ag-rp-install-tab-${plat}`);
      tabBtn?.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!DEFAULT_CLOUDFLARED_INSTALL_COMMANDS[plat]) return;
        remoteSettingsState.installPlatform = plat;
        remoteSettingsState.installCopiedAt = 0;
        renderRemoteSettingsChannels();
      });
    });

    root.querySelector('#ag-rp-cf-copy-install')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      const cmd = installGuide.command;
      const ok = await copyRemoteInstallCommand(cmd);
      if (ok) {
        remoteSettingsState.installCopiedAt = Date.now();
        renderRemoteSettingsChannels();
        if (remoteSettingsState.installCopyTimer) clearTimeout(remoteSettingsState.installCopyTimer);
        remoteSettingsState.installCopyTimer = setTimeout(() => {
          remoteSettingsState.installCopyTimer = null;
          renderRemoteSettingsChannels();
        }, 2100);
      }
    });

    root.querySelector('#ag-rp-cf-recheck')?.addEventListener('click', ev => {
      ev.stopPropagation();
      if (remoteSettingsState.busy || remoteSettingsState.loading) return;
      void loadRemoteSettingsInfo(false);
    });
  }

  async function loadRemoteSettingsInfo(resetToken = false) {
    if (remoteSettingsState.loading) return remoteSettingsState.data;
    remoteSettingsState.loading = true;
    remoteSettingsState.error = '';
    renderRemoteSettingsChannels();
    try {
      const res = await invokeHostBridge('/remote-info', { resetToken: Boolean(resetToken) }, 'getRemoteInfo');
      if (res && res.disabled) {
        remoteSettingsState.data = null;
        remoteSettingsState.error = suiteTr(
          '当前已通过 --no-remote / AG_DISABLE_MOBILE_REMOTE=1 禁用远程监听',
          'Remote server disabled via --no-remote / AG_DISABLE_MOBILE_REMOTE=1'
        );
      } else if (res && res.ok && res.data) {
        remoteSettingsState.data = res.data;
        syncRemoteDisplayCheckboxes(res.data.remoteDisplay);
        broadcastRemoteStateChanged(res.data);
      } else {
        remoteSettingsState.error = suiteTr('请确认 Antigravity 桥接服务正在运行', 'Ensure Antigravity local bridge service is running');
      }
    } catch (err) {
      remoteSettingsState.error = err?.message || suiteTr('获取远程设置状态失败', 'Failed to fetch remote settings');
    } finally {
      remoteSettingsState.loading = false;
      renderRemoteSettingsChannels();
      scheduleRemoteSettingsPoll();
    }
    return remoteSettingsState.data;
  }

  async function configureRemoteSettings(payload = {}) {
    if (remoteSettingsState.busy) return remoteSettingsState.data;
    remoteSettingsState.busy = true;
    remoteSettingsState.pendingAction = payload.tunnelMode === 'quick'
      ? 'quick'
      : (payload.tunnelMode === 'named' ? 'named' : (payload.remoteDisplay ? 'display' : 'toggle'));
    remoteSettingsState.error = '';
    renderRemoteSettingsChannels();
    try {
      const res = await invokeHostBridge('/remote-tunnel', payload, 'configureRemoteTunnel');
      if (res && res.ok && res.data) {
        remoteSettingsState.data = res.data;
        syncRemoteDisplayCheckboxes(res.data.remoteDisplay);
        broadcastRemoteStateChanged(res.data);
        const chs = Array.isArray(res.data.channels) ? res.data.channels : [];
        const tch = chs.find(c => c.key === 'tunnel');
        const hasErr = Boolean(tch?.error || tch?.state === 'error');
        if (payload.tunnelMode === 'named' || payload.tunnelMode === 'quick') {
          if (!hasErr) {
            remoteSettingsState.tunnelConfigOpen = false;
            remoteSettingsState.draftHost = null;
            remoteSettingsState.draftToken = '';
          } else {
            remoteSettingsState.tunnelConfigOpen = true;
          }
        }
      } else {
        remoteSettingsState.error = res?.error || suiteTr('更新远程通道配置失败', 'Failed to update remote settings');
        if (payload.tunnelMode === 'named' || payload.tunnelMode === 'quick') {
          remoteSettingsState.tunnelConfigOpen = true;
        }
      }
    } catch (err) {
      remoteSettingsState.error = err?.message || suiteTr('更新远程配置失败', 'Failed to update remote settings');
      if (payload.tunnelMode === 'named' || payload.tunnelMode === 'quick') {
        remoteSettingsState.tunnelConfigOpen = true;
      }
    } finally {
      remoteSettingsState.busy = false;
      remoteSettingsState.pendingAction = '';
      renderRemoteSettingsChannels();
      scheduleRemoteSettingsPoll();
    }
    return remoteSettingsState.data;
  }

  async function setRemoteDisplayConfig(partialCfg) {
    const next = sanitizeRemoteDisplayConfig({
      ...getRemoteDisplayConfig(),
      ...(partialCfg && typeof partialCfg === 'object' ? partialCfg : {})
    });
    syncRemoteDisplayCheckboxes(next);
    return await configureRemoteSettings({ remoteDisplay: next });
  }

  function switchSuiteSettingsTab(tabName = 'terminal') {
    const valid = ['terminal', 'appearance', 'subscription', 'remote', 'system'];
    const target = valid.includes(tabName) ? tabName : 'terminal';
    activeSettingsTab = target;
    for (const key of valid) {
      const btn = el(`settings-tab-btn-${key}`);
      const pane = el(`settings-pane-${key}`);
      const isCur = key === target;
      if (btn) {
        setPillActive(btn, isCur);
        btn.setAttribute('aria-selected', String(isCur));
      }
      if (pane) pane.hidden = !isCur;
    }
    if (target === 'terminal') {
      syncEnhancerPrefControls();
      renderQuickPromptsEditor();
      void refreshTerminalsList();
    } else if (target === 'subscription') {
      syncSettingsSubPreview();
      if (typeof syncPlanCustomFormFields === 'function' && isRealShadowDomTree()) {
        syncPlanCustomFormFields(ANTIGRAVITY_TOKEN_DATA.planStatus, { enhance: true });
      }
    } else if (target === 'remote') {
      renderRemoteSettingsChannels();
      syncRemoteDisplayCheckboxes();
      void loadRemoteSettingsInfo(false);
    } else if (target === 'system') {
      void refreshModulesDisplay();
    }
    positionFloatingPanels();
  }

  const AUTO_UPDATE_CHECK_TTL_MS = 300000;
  let lastSuiteVersionCheckAt = 0;
  let suiteVersionCheckBusy = false;
  let suiteVersionApplyBusy = false;
  let suiteVersionInfo = null;

  function renderSuiteVersionUi(info) {
    const verEl = el('suite-ver-status');
    const applyBtn = el('btn-suite-apply-update');
    const settingsBtn = el('badge-settings');
    const fallbackVer = typeof METER_VERSION === 'string' && METER_VERSION ? METER_VERSION : '0.8.5';

    if (!info || !info.ok) {
      if (verEl && !verEl.textContent) verEl.textContent = `v${fallbackVer}`;
      return;
    }

    const ver = info.version || fallbackVer;
    const sha = info.localShortSha || '';
    if (info.hasUpdate) {
      if (verEl) {
        verEl.setAttribute('data-state', 'update');
        verEl.textContent = `🔔 有新更新 (+${info.behindCount || 1} · ${info.remoteShortSha || 'new'})`;
        verEl.title = `${info.latestSubject || ''}${info.latestRelativeTime ? ` (${info.latestRelativeTime})` : ''}`.trim() || 'GitHub 仓库有新提交';
      }
      if (applyBtn) {
        applyBtn.hidden = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '立即更新';
      }
      if (settingsBtn) {
        settingsBtn.setAttribute('data-has-update', 'true');
        settingsBtn.setAttribute('title', '发现新版本，点击打开设置一键更新');
      }
    } else if (info.isGitRepo === false) {
      if (verEl) {
        verEl.setAttribute('data-state', 'muted');
        verEl.textContent = `v${ver} (非 Git 安装)`;
        verEl.title = '当前目录非 Git 仓库，请通过 git clone 安装以支持一键更新';
      }
      if (applyBtn) applyBtn.hidden = true;
      if (settingsBtn) {
        settingsBtn.removeAttribute('data-has-update');
        settingsBtn.setAttribute('title', '打开 Antigravity Suite 统一设置面板');
      }
    } else {
      if (verEl) {
        verEl.setAttribute('data-state', info.fetchError ? 'muted' : 'ok');
        verEl.textContent = sha ? `v${ver} (${sha} · 已是最新)` : `v${ver} · 已是最新`;
        verEl.title = info.fetchError
          ? `远端检查失败: ${info.fetchError}`
          : (info.localSubject ? `当前提交: ${info.localSubject}` : '当前版本与仓库同步');
      }
      if (applyBtn) applyBtn.hidden = true;
      if (settingsBtn) {
        settingsBtn.removeAttribute('data-has-update');
        settingsBtn.setAttribute('title', '打开 Antigravity Suite 统一设置面板');
      }
    }
    applySuiteShadowLocale();
  }

  async function checkSuiteRepoUpdate(opts = {}) {
    if (suiteVersionCheckBusy || suiteVersionApplyBusy) return suiteVersionInfo;
    if (typeof window === 'undefined' || !window.__AGContextMeterLive?.port) {
      const verEl = el('suite-ver-status');
      const fallbackVer = typeof METER_VERSION === 'string' && METER_VERSION ? METER_VERSION : '0.8.5';
      if (verEl && !verEl.textContent) verEl.textContent = `v${fallbackVer}`;
      return null;
    }
    suiteVersionCheckBusy = true;
    try {
      const res = await invokeHostBridge('/suite-version-check', { fetchRemote: opts?.fetchRemote !== false }, 'suiteVersionCheck');
      if (res && res.ok) {
        lastSuiteVersionCheckAt = Date.now();
        suiteVersionInfo = res;
        renderSuiteVersionUi(res);
      }
      return res || null;
    } catch {
      return null;
    } finally {
      suiteVersionCheckBusy = false;
    }
  }

  async function applySuiteRepoUpdate() {
    if (suiteVersionApplyBusy) return null;
    const applyBtn = el('btn-suite-apply-update');
    const verEl = el('suite-ver-status');
    const settingsBtn = el('badge-settings');
    suiteVersionApplyBusy = true;
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = '⏳ 正在更新…';
      applySuiteShadowLocale();
    }
    try {
      const res = await invokeHostBridge('/suite-apply-update', {}, 'suiteApplyUpdate');
      if (res && res.ok) {
        suiteVersionInfo = {
          ok: true,
          isGitRepo: true,
          version: res.version,
          localShortSha: res.localShortSha,
          localSubject: res.localSubject,
          hasUpdate: false,
          behindCount: 0
        };
        if (verEl) {
          verEl.setAttribute('data-state', 'ok');
          verEl.textContent = `✅ 已更新至 v${res.version} (${res.localShortSha})`;
          verEl.title = res.localSubject ? `最新提交: ${res.localSubject}` : '已完成热更新';
        }
        if (applyBtn) applyBtn.hidden = true;
        if (settingsBtn) {
          settingsBtn.removeAttribute('data-has-update');
          settingsBtn.setAttribute('title', '打开 Antigravity Suite 统一设置面板');
        }
        applySuiteShadowLocale();
        return res;
      }
      const errMsg = res?.error || '未能拉取仓库更新';
      if (verEl) {
        verEl.setAttribute('data-state', 'muted');
        verEl.textContent = `✖ 更新失败：${errMsg}`;
      }
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = '立即更新';
      }
      applySuiteShadowLocale();
      return res || null;
    } catch (e) {
      if (verEl) {
        verEl.setAttribute('data-state', 'muted');
        verEl.textContent = `✖ 更新失败：${e?.message || e}`;
      }
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = '立即更新';
      }
      applySuiteShadowLocale();
      return null;
    } finally {
      suiteVersionApplyBusy = false;
    }
  }

  function openSuiteSettings(tabName = activeSettingsTab) {
    transplantConfigControlsOnce();
    showPanel('settings');
    switchSuiteSettingsTab(tabName || activeSettingsTab);
    if (!lastSuiteVersionCheckAt || Date.now() - lastSuiteVersionCheckAt >= AUTO_UPDATE_CHECK_TTL_MS) {
      void checkSuiteRepoUpdate({ fetchRemote: true });
    }
  }

  function toggleSuiteSettings(tabName) {
    const pSettings = el('panel-settings');
    if (pSettings && !pSettings.hidden && (!tabName || tabName === activeSettingsTab)) {
      showPanel('none');
    } else {
      openSuiteSettings(tabName || activeSettingsTab);
    }
  }

  el('badge-settings')?.addEventListener('click', () => toggleSuiteSettings());
  el('overflow-settings-btn')?.addEventListener('click', () => openSuiteSettings());
  el('close-settings')?.addEventListener('click', () => showPanel('none'));

  ['terminal', 'appearance', 'subscription', 'remote', 'system'].forEach(tab => {
    el(`settings-tab-btn-${tab}`)?.addEventListener('click', () => switchSuiteSettingsTab(tab));
  });

  el('btn-add-quick-prompt')?.addEventListener('click', () => {
    const listEl = el('quick-prompts-editor-list');
    if (!listEl) return;
    const count = listEl.querySelectorAll('.qp-row')?.length || 0;
    if (count >= 12) {
      const statusEl = el('quick-prompts-status');
      if (statusEl) statusEl.textContent = suiteTr('⚠️ 最多支持 12 条自定义快捷提示词', '⚠️ Maximum 12 custom quick prompts');
      return;
    }
    appendQuickPromptEditorRow(listEl, { label: '', text: '' }, count);
  });

  el('btn-save-quick-prompts')?.addEventListener('click', () => {
    const collected = collectQuickPromptsFromEditor();
    void setSuiteQuickPrompts(collected);
  });

  el('btn-reset-quick-prompts')?.addEventListener('click', () => {
    void resetSuiteQuickPrompts();
  });

  el('btn-settings-remote-refresh')?.addEventListener('click', () => {
    void loadRemoteSettingsInfo(false);
  });

  el('ag-remote-reset')?.addEventListener('click', () => {
    void loadRemoteSettingsInfo(true);
  });

  el('btn-reset-remote-display')?.addEventListener('click', () => {
    void setRemoteDisplayConfig({ ...DEFAULT_REMOTE_DISPLAY_CONFIG });
  });

  for (const [elId] of REMOTE_DISPLAY_BINDINGS) {
    el(elId)?.addEventListener('change', () => {
      const nextCfg = collectRemoteDisplayFromUI();
      void configureRemoteSettings({ remoteDisplay: nextCfg });
    });
  }

  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('ag-suite-prefs-changed', ev => {
        if (ev?.detail && ('locale' in ev.detail || 'hansCode' in ev.detail || 'capsuleLang' in ev.detail)) {
          const incoming = findSupportedLocaleEntry(ev.detail.locale || ev.detail.hansCode || ev.detail.capsuleLang);
          if (incoming.code !== suiteEnhancerPrefs.locale) {
            suiteEnhancerPrefs.locale = incoming.code;
            suiteEnhancerPrefs.capsuleLang = incoming.capsuleLang;
          }
          if (activeSettingsTab === 'remote' && remoteSettingsState.data) {
            renderRemoteSettingsChannels();
          }
          applySuiteShadowLocale();
        }
      });
    }
  } catch {}

  el('btn-refresh-terminals')?.addEventListener('click', () => {
    void refreshTerminalsList();
  });

  el('btn-pick-term-path')?.addEventListener('click', async () => {
    const statusEl = el('term-config-status');
    try {
      if (!window?.contextMeterAPI?.pickTerminalPath && !window?.__AGContextMeterLive?.port) {
        if (statusEl) statusEl.textContent = '⚠️ 当前环境不支持文件对话框，请直接粘贴终端路径后保存';
        return;
      }
      const res = await invokeHostBridge('/pick-terminal-path', {}, 'pickTerminalPath');
      if (res?.ok && !res.canceled && res.path) {
        const inp = el('input-custom-term-path');
        if (inp) inp.value = res.path;
        await setSuiteTerminalSettings('custom', res.path);
        await refreshTerminalsList();
      } else if (res && res.ok === false && statusEl) {
        statusEl.textContent = `✖ 选择失败：${res.error || '未知错误'}`;
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = `✖ 打开选择器异常：${e?.message || e}`;
    }
  });

  el('btn-save-term-path')?.addEventListener('click', async () => {
    const raw = el('input-custom-term-path')?.value?.trim() || '';
    await setSuiteTerminalSettings('custom', raw);
    await refreshTerminalsList();
  });

  el('set-cli-skip-permissions')?.addEventListener('change', e => {
    void setSuiteCliSettings({ skipPermissions: Boolean(e?.target?.checked) });
  });

  el('set-cli-model-select')?.addEventListener('change', e => {
    const val = String(e?.target?.value ?? '').trim();
    const customRow = el('cli-custom-model-row');
    if (val === '__custom__') {
      if (customRow) customRow.style.display = 'flex';
      return;
    }
    if (customRow) customRow.style.display = 'none';
    void setSuiteCliSettings({ model: val });
  });

  el('btn-save-cli-model')?.addEventListener('click', () => {
    const raw = el('input-cli-custom-model')?.value?.trim() || '';
    void setSuiteCliSettings({ model: raw });
  });

  el('set-cli-mux-host-select')?.addEventListener('change', e => {
    const val = String(e?.target?.value ?? '').trim();
    const customRow = el('cli-custom-mux-host-row');
    if (val === '__custom__') {
      if (customRow) customRow.style.display = 'flex';
      return;
    }
    if (customRow) customRow.style.display = 'none';
    void setSuiteCliSettings({ muxHost: val });
  });

  el('btn-save-cli-mux-host')?.addEventListener('click', () => {
    const raw = el('input-cli-mux-host')?.value?.trim() || '';
    void setSuiteCliSettings({ muxHost: raw });
  });

  el('btn-test-terminal')?.addEventListener('click', async () => {
    const statusEl = el('term-config-status');
    if (statusEl) statusEl.textContent = '⏳ 正在尝试打开所选终端…';
    const cliCfg = getSuiteCliSettings();
    const res = await triggerLaunchCli({
      terminalApp: suiteTerminalState.terminalApp,
      customTerminalPath: el('input-custom-term-path')?.value?.trim() || suiteTerminalState.customTerminalPath,
      muxHost: suiteTerminalState.cliMuxHost || '',
      skipPermissions: cliCfg.skipPermissions,
      model: cliCfg.model,
      noModel: cliCfg.noModel,
      testOnly: true
    });
    if (statusEl) {
      const hostSuffix = res?.muxHost ? ` · 主机: ${res.muxHost}` : '';
      statusEl.textContent = res?.ok
        ? `✅ 测试启动成功：${res.terminal || suiteTerminalState.terminalApp} (${res.cwd || '默认目录'}${hostSuffix})`
        : `✖ 测试启动失败：${res?.error || '请检查终端安装状态或路径'}`;
    }
  });

  const applyThemeChoice = (mode) => {
    currentThemeMode = mode;
    try { localStorage?.setItem?.('ag_theme_mode', mode); } catch {}
    applyTheme();
    syncSettingsThemePills();
    dispatchSuitePrefsChanged();
    void saveSuiteUiPrefs({ themeMode: mode });
  };
  el('set-theme-auto')?.addEventListener('click', () => applyThemeChoice('auto'));
  el('set-theme-light')?.addEventListener('click', () => applyThemeChoice('light'));
  el('set-theme-dark')?.addEventListener('click', () => applyThemeChoice('dark'));

  el('set-auto-accept')?.addEventListener('change', e => {
    suiteEnhancerPrefs.autoAccept = Boolean(e?.target?.checked);
    dispatchSuitePrefsChanged();
    void saveSuiteUiPrefs({ autoAccept: suiteEnhancerPrefs.autoAccept });
  });

  el('set-ghost-suggest')?.addEventListener('change', e => {
    suiteEnhancerPrefs.ghostSuggest = Boolean(e?.target?.checked);
    dispatchSuitePrefsChanged();
    void saveSuiteUiPrefs({ ghostSuggest: suiteEnhancerPrefs.ghostSuggest });
  });

  el('set-ui-language-select')?.addEventListener('change', e => {
    void setSuiteLocale(e?.target?.value || 'zh-CN');
  });

  el('set-english-labels')?.addEventListener('change', e => {
    suiteEnhancerPrefs.englishLabels = Boolean(e?.target?.checked);
    syncEnhancerPrefControls();
    dispatchSuitePrefsChanged();
    try { window.__antigravityZhSetEnglishLabels?.(suiteEnhancerPrefs.englishLabels, true); } catch {}
    void saveSuiteUiPrefs({ englishLabels: suiteEnhancerPrefs.englishLabels });
  });

  [
    ['set-feat-tokens', 'showTopbarTokens'],
    ['set-feat-cli', 'showTopbarCli'],
    ['set-feat-quota', 'showTopbarQuota'],
    ['set-feat-remote', 'showTopbarRemote'],
    ['set-feat-quickbar', 'showQuickBar'],
    ['set-feat-chatnav', 'showChatNav']
  ].forEach(([id, key]) => {
    el(id)?.addEventListener('change', e => {
      void setSuiteFeatureFlags({ [key]: Boolean(e?.target?.checked) });
    });
  });

  el('btn-reset-feature-toggles')?.addEventListener('click', () => {
    void setSuiteFeatureFlags({ ...DEFAULT_SUITE_FEATURE_FLAGS });
  });

  el('btn-toggle-heat-advanced')?.addEventListener('click', () => {
    const box = el('heat-advanced-colors-box');
    const btn = el('btn-toggle-heat-advanced');
    if (!box) return;
    const isHidden = box.style.display === 'none' || !box.style.display;
    box.style.display = isHidden ? 'block' : 'none';
    if (btn) {
      btn.textContent = isHidden ? '收起色阶微调 ▲' : '高级色阶微调 ▼';
      applySuiteShadowLocale();
    }
  });

  el('suite-ver-status')?.addEventListener('click', () => {
    void checkSuiteRepoUpdate({ fetchRemote: true });
  });

  el('btn-suite-apply-update')?.addEventListener('click', () => {
    void applySuiteRepoUpdate();
  });

  const onSuiteWindowFocusForUpdate = () => {
    if (typeof state !== 'undefined' && state?.disposed) {
      try { window.removeEventListener?.('focus', onSuiteWindowFocusForUpdate); } catch {}
      return;
    }
    if (!lastSuiteVersionCheckAt || Date.now() - lastSuiteVersionCheckAt >= AUTO_UPDATE_CHECK_TTL_MS) {
      void checkSuiteRepoUpdate({ fetchRemote: true });
    }
  };
  try {
    if (isRealShadowDomTree() && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('focus', onSuiteWindowFocusForUpdate);
    }
  } catch {}

  transplantConfigControlsOnce();
  syncEnhancerPrefControls();
  applySuiteFeatureFlags();
  renderQuickPromptsEditor();
  renderTerminalGrid();
  dispatchSuitePrefsChanged();
  applySuiteShadowLocale();
  if (el('suite-ver-status') && typeof METER_VERSION === 'string' && METER_VERSION) {
    el('suite-ver-status').textContent = `v${METER_VERSION}`;
  }
  if (isRealShadowDomTree() && typeof window !== 'undefined' && window.__AGContextMeterLive?.port) {
    void checkSuiteRepoUpdate({ fetchRemote: true });
  }

// Antigravity 界面增强挂件（窗口内配额双胶囊 + 输入框快捷胶囊栏）
// 严格免改盘设计，通过 CDP 运行时注入，可随时通过 dispose() 无痕卸载。
(function () {
  'use strict';

  try {
    if (globalThis.__AGEnhancer && typeof globalThis.__AGEnhancer.dispose === 'function') {
      globalThis.__AGEnhancer.dispose();
    }
  } catch {}

  const METER_HOST_ID = 'ag-context-meter';
  const REMOTE_BADGE_ID = 'badge-remote';
  const REMOTE_POPOVER_ID = 'ag-remote-popover';
  const QUOTA_STYLE_ID = 'ag-enhancer-quota-style';
  const QUOTA_BADGE_ID = 'badge-quota';
  const QUOTA_POPOVER_ID = 'ag-quota-popover';
  const DOC_STYLE_ID = 'ag-enhancer-doc-style';
  const QUICK_BAR_ID = 'ag-quick-capsule-bar';
  const CHAT_NAV_ID = 'ag-chat-nav-float';
  const FILE_EDITOR_CONTROLS_ID = 'ag-file-editor-controls';
  const FILE_EDITOR_WRAP_ID = 'ag-inline-file-editor-wrap';
  const NEXT_STEP_GHOST_ID = 'ag-next-step-ghost';
  const NEXT_STEP_TOOLTIP_ID = 'ag-next-step-tooltip';
  const QUICK_BAR_TOOLTIP_ID = 'ag-quickbar-tooltip';
  const QUICK_RIGHT_SLOT_ID = 'ag-qcap-right-slot';
  const PROMPT_OPT_WRAP_ID = 'ag-prompt-opt-wrap';
  const PROMPT_OPT_BTN_ID = 'ag-prompt-opt-btn';
  const PROMPT_OPT_UNDO_ID = 'ag-prompt-undo-btn';
  const CLOUDFLARE_TUNNEL_DASHBOARD_URL = 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels';
  const PROMPT_OPT_SPARKLE_SVG = '<svg class="ag-opt-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.3a2 2 0 0 0 1.2 1.2L20.4 11.4l-5.3 1.9a2 2 0 0 0-1.2 1.2L12 19.8l-1.9-5.3a2 2 0 0 0-1.2-1.2L3.6 11.4l5.3-1.9a2 2 0 0 0 1.2-1.2Z"></path><path d="M19 3v3"></path><path d="M20.5 4.5h-3"></path></svg>';
  const PROMPT_OPT_UNDO_SVG = '<svg class="ag-opt-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>';
  const CHECKBOX_CHECKED_SVG = '<svg class="ag-rp-icon ag-rp-ok" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4.5" fill="var(--ag-accent-bg, rgba(167, 139, 250, 0.14))" stroke="var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))" stroke-width="2"></rect><polyline points="8.5 12.2 11.2 14.9 15.8 9.4" stroke="var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>';
  const CHECKBOX_UNCHECKED_SVG = '<svg class="ag-rp-icon ag-rp-off" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4.5"></rect></svg>';
  const LOCK_SHIELD_SVG = '<svg class="ag-rp-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
  const makeNavSvg = (paths) => '<svg class="ag-nav-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const CHAT_NAV_ICONS = {
    top: makeNavSvg('<path d="m17 11-5-5-5 5"></path><path d="m17 18-5-5-5 5"></path>'),
    prev: makeNavSvg('<path d="m18 15-6-6-6 6"></path>'),
    next: makeNavSvg('<path d="m6 9 6 6 6-6"></path>'),
    bottom: makeNavSvg('<path d="m7 6 5 5 5-5"></path><path d="m7 13 5 5 5-5"></path>'),
    think: makeNavSvg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path>')
  };

  let disposed = false;
  let remotePopoverOpen = false;
  let remotePollTimer = null;
  let lastRemoteFetchAt = 0;
  let remotePairState = { loading: false, tunnelBusy: false, tunnelPendingAction: '', error: '', data: null, copiedAt: 0, tunnelConfigOpen: false, tunnelPollTimer: null, draftHost: null, draftToken: '' };
  let fileEditorState = {
    active: false,
    fileUri: '',
    filePath: '',
    dirty: false,
    saving: false,
    loading: false,
    savedOnce: false,
    statusText: ''
  };
  let activeEditorWrapEl = null;
  let quotaState = {
    loading: false,
    lastFetchedAt: 0,
    error: '',
    gemini: null,
    claude: null,
    subGroups: [],
    promptCredits: null,
    flowCredits: null,
    activeModelText: '',
    activePoolKey: 'gemini'
  };
  let popoverOpen = false;
  let toastTimer = null;
  let autoAcceptEnabled = false;
  let ghostSuggestEnabled = true;
  let autoCompactEnabled = true;
  let uiLang = 'zh';
  const DEFAULT_FEATURE_FLAGS = {
    showTopbarTokens: true,
    showTopbarCli: true,
    showTopbarQuota: true,
    showTopbarRemote: true,
    showQuickBar: true,
    showChatNav: true
  };
  let featureFlags = { ...DEFAULT_FEATURE_FLAGS };

  const BUILTIN_QUICK_POOL = [
    {
      id: 'compact',
      group: 'daily',
      label: '/compact 压缩',
      labelEn: '/compact',
      slash: 'compact',
      text: '/compact',
      rec: '★必开',
      recEn: '★Must',
      tag: '防卡死',
      tagEn: 'Anti-Stall',
      role: '触发官方本地压缩，将冗长历史浓缩为高密度摘要。',
      roleEn: 'Triggers native compaction to summarize long conversation history.',
      scene: '上下文超过 150K~240K、响应变慢，或切换下一阶段任务前。',
      sceneEn: 'When context exceeds 150K-240K, slows down, or before switching sub-tasks.',
      title: '压缩上下文（执行官方 /compact 命令），防止超 240K~300K 缓存过期卡死',
      titleEn: 'Compact context via native /compact command',
      defaultEnabled: true
    },
    {
      id: 'plan',
      group: 'daily',
      label: '/plan 规划',
      labelEn: '/plan',
      slash: 'plan',
      text: '/plan ',
      rec: '★推荐',
      recEn: '★Rec',
      tag: '先谋后动',
      tagEn: 'Plan First',
      role: '切换规划模式，强制先读代码并给出方案，确认后再动手改文件。',
      roleEn: 'Enter planning mode to inspect code and propose a plan before editing.',
      scene: '涉及多文件改造、架构调整，想先审阅思路再让 AI 动手时。',
      sceneEn: 'Multi-file changes or architectural edits where you want to approve a plan first.',
      title: '进入或切换规划模式，先出方案再动手改代码',
      titleEn: 'Enter plan mode via /plan',
      defaultEnabled: true
    },
    {
      id: 'grill-me',
      group: 'daily',
      label: '/grill-me 追问对齐',
      labelEn: '/grill-me',
      slash: 'grill-me',
      text: '/grill-me ',
      rec: '★推荐',
      recEn: '★Rec',
      tag: '需求澄清',
      tagEn: 'Clarify',
      role: '让 AI 像面试官一样连环追问，逐项确认模糊需求与边界条件。',
      roleEn: 'Have the AI interview you relentlessly to clarify requirements and edge cases.',
      scene: '只有一个大概想法、细节还没想透，怕 AI 自作主张乱写时。',
      sceneEn: 'When your idea is still rough and you want alignment before execution.',
      title: '让 AI 像面试一样主动追问，把模糊需求与边界全部对齐',
      titleEn: 'Interview me to align on requirements and plan',
      defaultEnabled: false
    },
    {
      id: 'btw',
      group: 'daily',
      label: '/btw 插话提问',
      labelEn: '/btw',
      slash: 'btw',
      text: '/btw ',
      rec: '',
      recEn: '',
      tag: '旁路问答',
      tagEn: 'Side Q',
      role: '开启轻量旁路问答，不打断当前主线进度也不污染主上下文。',
      roleEn: 'Ask a quick side question without interrupting the main conversation flow.',
      scene: '主线正在跑任务，你想顺手确认某条语法、报错或无关知识点。',
      sceneEn: 'Quickly checking syntax or concepts without derailing the main task.',
      title: '不打断主线上下文，临时快速旁路提问',
      titleEn: 'Ask a quick side question without interrupting main chat',
      defaultEnabled: false
    },
    {
      id: 'learn',
      group: 'daily',
      label: '/learn 提炼经验',
      labelEn: '/learn',
      slash: 'learn',
      text: '/learn ',
      rec: '',
      recEn: '',
      tag: '规则沉淀',
      tagEn: 'Learn',
      role: '复盘本轮对话中你的纠正或成功路径，沉淀为可复用的规则或 Skill。',
      roleEn: 'Reflect on corrections or setups from this turn into reusable rules or skills.',
      scene: '费了多轮才教会 AI 某件事，希望它下次永远直接做对时。',
      sceneEn: 'After correcting the agent or solving a tricky setup to persist the workflow.',
      title: '复盘本轮纠偏与踩坑，沉淀为长期规则或 Skill',
      titleEn: 'Capture lessons learned as reusable skills or rules',
      defaultEnabled: false
    },
    {
      id: 'goal',
      group: 'heavy',
      label: '/goal 持续到底',
      labelEn: '/goal',
      slash: 'goal',
      text: '/goal ',
      rec: '★推荐',
      recEn: '★Rec',
      tag: '长程死磕',
      tagEn: 'Long Run',
      role: '开启长程目标循环模式，反复校验执行直到目标彻底达成。',
      roleEn: 'Run relentlessly toward the specified goal until every criterion is verified.',
      scene: '全量测试修完所有报错、批量机械重构、夜间挂机跑完长任务。',
      sceneEn: 'Fixing all failing tests, large refactors, or unattended long-horizon runs.',
      title: '启动长程自主目标模式，持续推进直到目标彻底完成',
      titleEn: 'Run until the specified goal is completely finished',
      defaultEnabled: false
    },
    {
      id: 'boost',
      group: 'heavy',
      label: '/boost 深度攻坚',
      labelEn: '/boost',
      slash: 'boost',
      text: '/boost ',
      rec: '★推荐',
      recEn: '★Rec',
      tag: '单点深研',
      tagEn: 'Deep Dive',
      role: '调用 Boost 多智能体编排器，深度推理并从多视角严格校验。',
      roleEn: 'Invoke the Boost multi-agent orchestrator for deep thinking and strict verification.',
      scene: '棘手疑难 Bug 反复修不好、复杂算法或需要严密论证的核心工程。',
      sceneEn: 'Hard bugs, intricate algorithms, or research/code needing rigorous verification.',
      title: '调用 Boost 多模型深度推理与严格验证编排',
      titleEn: 'Invoke Boost multi-agent orchestrator for complex tasks',
      defaultEnabled: false
    },
    {
      id: 'swarm',
      group: 'heavy',
      label: '/swarm 蜂群并发',
      labelEn: '/swarm',
      slash: 'swarm',
      text: '/swarm ',
      rec: '',
      recEn: '',
      tag: '横向分包',
      tagEn: 'Parallel',
      role: '主 Agent 当协调者，在共享消息板上同时派多名工人+复核员并行分工。',
      roleEn: 'Spawn parallel workers collaborating through a shared message board.',
      scene: '可拆成多个互不冲突的子任务并行提速（改多文件/交叉审查，极耗额度）。',
      sceneEn: 'Independent subtasks that can run simultaneously or need peer verification (quota heavy).',
      title: '调度多个子 Agent 并发协作拆分复杂任务',
      titleEn: 'Spawn parallel agents collaborating on one task',
      defaultEnabled: false
    },
    {
      id: 'teamwork',
      group: 'heavy',
      label: '/teamwork 团队协作',
      labelEn: '/teamwork',
      slash: 'teamwork',
      text: '/teamwork ',
      rec: '',
      recEn: '',
      tag: '军团流水',
      tagEn: 'Pipeline',
      role: '拉起探查→拆解→求解→批判审校→修补 5 阶段专业 Agent 团队接管项目。',
      roleEn: 'Invoke an autonomous 5-phase team pipeline to tackle large projects end-to-end.',
      scene: '超大型工程重构或从零搭建完整大项目，希望团队全自动一条龙交付。',
      sceneEn: 'Large projects or greenfield builds best handled by a full autonomous team.',
      title: '调动自治 Agent 团队接管大型复杂项目',
      titleEn: 'Invoke autonomous agent team for large projects',
      defaultEnabled: false
    },
    {
      id: 'browser',
      group: 'heavy',
      label: '/browser 浏览器',
      labelEn: '/browser',
      slash: 'browser',
      text: '/browser ',
      rec: '',
      recEn: '',
      tag: '网页实操',
      tagEn: 'Web UI',
      role: '派遣内置浏览器子 Agent 访问网页、点击填表并截取视觉状态。',
      roleEn: 'Launch the browser subagent to navigate, click, fill forms, and inspect UI.',
      scene: '验证 localhost 前端页面表现、检查 UI 错位或跑通网页端交互流程。',
      sceneEn: 'Testing localhost web apps, verifying rendered UI, or interactive web flows.',
      title: '唤醒浏览器子 Agent 执行网页操作与核验',
      titleEn: 'Invoke browser agent for web tasks',
      defaultEnabled: false
    },
    {
      id: 'schedule',
      group: 'heavy',
      label: '/schedule 定时任务',
      labelEn: '/schedule',
      slash: 'schedule',
      text: '/schedule ',
      rec: '',
      recEn: '',
      tag: '定时巡检',
      tagEn: 'Cron',
      role: '创建后台 Cron 周期巡检或一次性倒计时提醒任务，到点自动唤醒。',
      roleEn: 'Schedule a recurring cron job or a one-time delayed timer notification.',
      scene: '每 N 分钟巡检构建/服务状态，或约定稍后自动触发某项检查。',
      sceneEn: 'Periodic monitoring, polling builds, or setting a delayed reminder.',
      title: '创建定时轮询或一次性定时提醒任务',
      titleEn: 'Schedule a recurring cron or one-shot timer',
      defaultEnabled: false
    },
    {
      id: 'reload',
      group: 'tools',
      label: '重载规则',
      labelEn: 'Reload Rules',
      slash: '',
      text: '重新读取 AGENTS',
      rec: '★默认',
      recEn: '★Default',
      tag: '恢复约束',
      tagEn: 'Rules',
      role: '一键填入「重新读取 AGENTS」，让 AI 立刻重新加载全局行为规则。',
      roleEn: 'Insert "Reload AGENTS" so the agent immediately re-reads ~/.codex/AGENTS.md.',
      scene: '刚改完 AGENTS.md 配置文件，或长对话后觉得 AI 忘了约定规矩时。',
      sceneEn: 'Right after editing AGENTS.md or when guidelines start drifting in long chats.',
      title: '让 AI 重新读取 ~/.codex/AGENTS.md 行为规则',
      titleEn: 'Fill reload AGENTS prompt',
      defaultEnabled: true
    },
    {
      id: 'copyid',
      group: 'tools',
      label: '复制会话 ID',
      labelEn: 'Copy ID',
      slash: '',
      text: '',
      builtinAction: 'copyid',
      rec: '★默认',
      recEn: '★Default',
      tag: '快速取值',
      tagEn: 'Copy ID',
      role: '一键提取并复制当前对话窗口的唯一会话 UUID。',
      roleEn: 'Extract and copy the current conversation UUID to the clipboard.',
      scene: '需要在终端定位当前会话日志，或在另一扇窗口中引用本会话时。',
      sceneEn: 'Checking session transcript logs or referencing this conversation elsewhere.',
      title: '一键复制当前对话窗口的会话 ID',
      titleEn: 'Copy current conversation ID',
      defaultEnabled: true
    },
    {
      id: 'export',
      group: 'tools',
      label: '导出 Markdown',
      labelEn: 'Export MD',
      slash: '',
      text: '',
      builtinAction: 'export',
      rec: '★默认',
      recEn: '★Default',
      tag: '对话归档',
      tagEn: 'Archive',
      role: '将当前完整对话导出为 Markdown 保存到 ~/Downloads 并复制。',
      roleEn: 'Export the full conversation as Markdown to ~/Downloads and copy it.',
      scene: '重要问题排查过程归档留存、发给他人复盘或跨工具交接上下文。',
      sceneEn: 'Archiving troubleshooting records, sharing logs, or migrating context.',
      title: '将完整对话导出为 Markdown 保存到 ~/Downloads 并复制',
      titleEn: 'Export conversation to Markdown in ~/Downloads and copy',
      defaultEnabled: true
    }
  ];
  const DEFAULT_QUICK_POOL_STATE = Object.fromEntries(
    BUILTIN_QUICK_POOL.map((item) => [item.id, Boolean(item.defaultEnabled)])
  );
  let quickPoolState = { ...DEFAULT_QUICK_POOL_STATE };
  let customQuickPrompts = null;

  function sanitizeQuickPoolState(raw, fallbackState = DEFAULT_QUICK_POOL_STATE) {
    const out = { ...DEFAULT_QUICK_POOL_STATE, ...(fallbackState && typeof fallbackState === 'object' ? fallbackState : {}) };
    if (raw && typeof raw === 'object') {
      for (const item of BUILTIN_QUICK_POOL) {
        if (typeof raw[item.id] === 'boolean') {
          out[item.id] = raw[item.id];
        }
      }
    }
    return out;
  }

  function isLegacyDefaultPromptItem(item) {
    if (!item || typeof item !== 'object') return false;
    const id = String(item.id || '').trim();
    if (id !== 'compact' && id !== 'plan' && id !== 'reload') return false;
    const poolDef = BUILTIN_QUICK_POOL.find((p) => p.id === id);
    return Boolean(
      poolDef &&
      String(item.text || '').trim() === String(poolDef.text || '').trim() &&
      String(item.label || '').trim() === String(poolDef.label || '').trim()
    );
  }

  function sanitizeQuickPromptsList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== 'object') continue;
      const label = String(item.label ?? '').trim();
      const text = String(item.text ?? '');
      if (!label || !text.trim()) continue;
      if (isLegacyDefaultPromptItem(item)) continue;
      const rawId = String(item.id || '').trim();
      const id = rawId && /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `custom-${i}`;
      out.push({
        id,
        label: label.slice(0, 40),
        text: text.slice(0, 2000),
        title: String(item.title || '').trim().slice(0, 120)
      });
      if (out.length >= 20) break;
    }
    return out;
  }

  const autoClickedButtons = new WeakMap();

  function tr(zhText, enText) {
    return uiLang === 'en' ? enText : zhText;
  }

  function syncSuitePrefsFromStorage(detail = null) {
    try {
      if (detail && typeof detail.autoAccept === 'boolean') {
        autoAcceptEnabled = detail.autoAccept;
      } else if (typeof localStorage !== 'undefined') {
        autoAcceptEnabled = localStorage.getItem('ag_suite_auto_accept') === 'true';
      }
    } catch {}
    try {
      if (detail && typeof detail.ghostSuggest === 'boolean') {
        ghostSuggestEnabled = detail.ghostSuggest;
      } else if (typeof localStorage !== 'undefined') {
        const rawGhost = localStorage.getItem('ag_suite_ghost_suggest');
        if (rawGhost === 'true' || rawGhost === 'false') {
          ghostSuggestEnabled = rawGhost === 'true';
        }
      }
    } catch {}
    try {
      if (detail && typeof detail.autoCompact === 'boolean') {
        autoCompactEnabled = detail.autoCompact;
      } else if (typeof localStorage !== 'undefined') {
        const rawCompact = localStorage.getItem('ag_suite_auto_compact');
        if (rawCompact === 'true' || rawCompact === 'false') {
          autoCompactEnabled = rawCompact !== 'false';
        }
      }
    } catch {}
    try {
      if (detail && detail.featureFlags && typeof detail.featureFlags === 'object') {
        for (const k of Object.keys(DEFAULT_FEATURE_FLAGS)) {
          if (typeof detail.featureFlags[k] === 'boolean') {
            featureFlags[k] = detail.featureFlags[k];
          }
        }
      } else if (typeof localStorage !== 'undefined') {
        const rawFeat = localStorage.getItem('ag_suite_feature_flags');
        if (rawFeat) {
          const parsedFeat = JSON.parse(rawFeat);
          if (parsedFeat && typeof parsedFeat === 'object') {
            for (const k of Object.keys(DEFAULT_FEATURE_FLAGS)) {
              if (typeof parsedFeat[k] === 'boolean') {
                featureFlags[k] = parsedFeat[k];
              }
            }
          }
        }
      }
    } catch {}
    try {
      let rawLang = '';
      if (detail && typeof detail === 'object') {
        rawLang = String(detail.hansCode || detail.capsuleLang || detail.locale || '').trim();
      }
      if (!rawLang && typeof document !== 'undefined' && document.documentElement?.getAttribute) {
        rawLang = String(
          document.documentElement.getAttribute('data-ag-hans-lang')
          || document.documentElement.getAttribute('data-ag-suite-locale')
          || ''
        ).trim();
      }
      if (!rawLang && typeof localStorage !== 'undefined') {
        rawLang = String(
          localStorage.getItem('ag_suite_locale')
          || localStorage.getItem('antigravityHansLang')
          || ''
        ).trim();
      }
      uiLang = (rawLang && !/^(?:zh|cn)/i.test(rawLang)) ? 'en' : 'zh';
    } catch {
      uiLang = 'zh';
    }
    try {
      let hasExplicitPool = false;
      if (detail && detail.quickPool && typeof detail.quickPool === 'object') {
        quickPoolState = sanitizeQuickPoolState(detail.quickPool);
        hasExplicitPool = true;
      } else if (typeof localStorage !== 'undefined') {
        const rawPool = localStorage.getItem('ag_suite_quick_pool');
        if (rawPool) {
          quickPoolState = sanitizeQuickPoolState(JSON.parse(rawPool));
          hasExplicitPool = true;
        }
      }
      if (!hasExplicitPool) {
        const flagSrc = (detail && detail.featureFlags && typeof detail.featureFlags === 'object')
          ? detail.featureFlags
          : (typeof localStorage !== 'undefined' && localStorage.getItem('ag_suite_feature_flags')
              ? JSON.parse(localStorage.getItem('ag_suite_feature_flags'))
              : null);
        if (flagSrc && typeof flagSrc === 'object') {
          if (typeof flagSrc.showQuickCopyId === 'boolean') quickPoolState.copyid = flagSrc.showQuickCopyId;
          if (typeof flagSrc.showQuickExport === 'boolean') quickPoolState.export = flagSrc.showQuickExport;
        }
      }
    } catch {}
    try {
      if (detail && 'quickPrompts' in detail) {
        if (detail.quickPrompts === null) {
          customQuickPrompts = null;
        } else {
          if (Array.isArray(detail.quickPrompts) && !detail.quickPool) {
            for (const item of detail.quickPrompts) {
              if (isLegacyDefaultPromptItem(item) && item.enabled === false) {
                quickPoolState[item.id] = false;
              }
            }
          }
          customQuickPrompts = sanitizeQuickPromptsList(detail.quickPrompts);
        }
      } else if (typeof localStorage !== 'undefined') {
        const rawQp = localStorage.getItem('ag_suite_quick_prompts');
        if (rawQp) {
          const parsedArr = JSON.parse(rawQp);
          if (Array.isArray(parsedArr) && !localStorage.getItem('ag_suite_quick_pool')) {
            for (const item of parsedArr) {
              if (isLegacyDefaultPromptItem(item) && item.enabled === false) {
                quickPoolState[item.id] = false;
              }
            }
          }
          customQuickPrompts = sanitizeQuickPromptsList(parsedArr);
        } else {
          customQuickPrompts = null;
        }
      }
    } catch {}
  }
  syncSuitePrefsFromStorage();
  let latestBrainStats = null;
  let nextStepState = {
    candidates: [],
    index: 0,
    replySig: '',
    dismissedSig: '',
    visible: false
  };
  let promptOptState = {
    loading: false,
    abortCtrl: null,
    userCancelled: false,
    backupText: '',
    optimizedText: '',
    undoHintActive: false,
    canUndo: false,
    lastError: null,
    cacheModel: {
      primary: '',
      fallback: '',
      candidates: [],
      fetchedAt: 0
    }
  };
  let isComposerComposing = false;
  let lastUserSubmitAt = 0;
  let autoCompactState = {
    lastSessionId: '',
    armedForSession: false,
    inFlightSession: '',
    idleSince: 0,
    lastFiredMap: new Map()
  };

  function scoreOptimizeModelCandidate(entry, isDefaultOverride = false) {
    const mid = String(entry?.modelId || '').toLowerCase();
    const label = String(entry?.label || '').toLowerCase();
    const model = String(entry?.model || '').toLowerCase();
    const text = `${mid} ${label} ${model}`;
    const remaining = entry?.remainingFraction;
    const exhaustedPenalty = (typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0) ? 200 : 0;

    let baseScore = 50;
    if (text.includes('orchestrator')) {
      baseScore = 90;
    } else if (text.includes('flash')) {
      if (text.includes('low')) baseScore = 10;
      else if (text.includes('medium')) baseScore = 15;
      else if (text.includes('high') || text.includes('xhigh')) baseScore = 24;
      else baseScore = 18;
    } else if (text.includes('sonnet') && text.includes('low')) {
      baseScore = 20;
    } else if (/\b(?:haiku|mini|lite)\b|gpt[-_]oss/i.test(text)) {
      baseScore = 22;
    } else if (/\blow\b|\(low\)|-low\b|_low\b/.test(text)) {
      baseScore = 26;
    } else if (/\bmedium\b|\(medium\)|-medium\b|_medium\b/.test(text)) {
      baseScore = 36;
    } else if (/\bxhigh\b|\(xhigh\)|-xhigh\b|_xhigh\b/.test(text)) {
      baseScore = 72;
    } else if (/\bhigh\b|\(high\)|-high\b|_high\b/.test(text)) {
      baseScore = 62;
    } else if (isDefaultOverride) {
      baseScore = 44;
    }

    return baseScore + exhaustedPenalty;
  }

  function detectOptimizeModelFamily(entry) {
    const text = `${entry?.modelId || ''} ${entry?.label || ''} ${entry?.model || ''}`.toLowerCase();
    if (text.includes('orchestrator')) return 'orchestrator';
    if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) return 'claude';
    if (text.includes('gpt') || text.includes('openai')) return 'openai';
    if (text.includes('flash')) return 'gemini-flash';
    if (text.includes('gemini')) return 'gemini';
    return 'other';
  }

  function buildOptimizeModelCandidates(cfgData) {
    if (!cfgData || typeof cfgData !== 'object') return [];
    const configs = Array.isArray(cfgData.clientModelConfigs) ? cfgData.clientModelConfigs : [];
    const primaryOverride = String(cfgData.defaultOverrideModelConfig?.modelOrAlias?.model || '').trim();
    const byModel = new Map();

    configs.forEach((c, idx) => {
      const model = String(c?.modelOrAlias?.model || '').trim();
      if (!model || byModel.has(model)) return;
      const item = {
        model,
        modelId: String(c?.modelId || '').trim(),
        label: String(c?.label || c?.modelId || model).trim(),
        remainingFraction: typeof c?.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
        isDefaultOverride: model === primaryOverride,
        idx
      };
      item.score = scoreOptimizeModelCandidate(item, item.isDefaultOverride);
      item.family = detectOptimizeModelFamily(item);
      byModel.set(model, item);
    });

    if (primaryOverride && !byModel.has(primaryOverride)) {
      const item = {
        model: primaryOverride,
        modelId: '',
        label: primaryOverride,
        remainingFraction: null,
        isDefaultOverride: true,
        idx: configs.length
      };
      item.score = scoreOptimizeModelCandidate(item, true);
      item.family = detectOptimizeModelFamily(item);
      byModel.set(primaryOverride, item);
    }

    const sorted = Array.from(byModel.values()).sort((a, b) => (a.score - b.score) || (a.idx - b.idx));
    if (sorted.length <= 4) {
      return sorted.map(({ model, modelId, label, family, score }) => ({ model, modelId, label, family, score }));
    }

    const picked = [];
    const pickedModels = new Set();
    const pushItem = (item) => {
      if (!item || pickedModels.has(item.model)) return;
      pickedModels.add(item.model);
      picked.push(item);
    };

    // 1. 优先选择评分最优的轻量快速模型
    pushItem(sorted[0]);
    // 2. 第二候选优先挑选跨模型族的轻量备选（防止单一族限流/不可用）
    const crossFamily = sorted.find((it) => !pickedModels.has(it.model) && it.family !== sorted[0].family && it.score < 200);
    if (crossFamily) pushItem(crossFamily);
    // 3. 加入同族或次优快速备选
    for (const it of sorted) {
      if (picked.length >= 3) break;
      pushItem(it);
    }
    // 4. 若默认覆盖模型尚未进入前 3，作为兜底纳入第 4 候选；否则顺延补足至 4 个
    if (primaryOverride && !pickedModels.has(primaryOverride) && byModel.has(primaryOverride)) {
      pushItem(byModel.get(primaryOverride));
    }
    for (const it of sorted) {
      if (picked.length >= 4) break;
      pushItem(it);
    }
    return picked.map(({ model, modelId, label, family, score }) => ({ model, modelId, label, family, score }));
  }

  function cacheDefaultModelFromConfigData(cfgData) {
    const candidates = buildOptimizeModelCandidates(cfgData);
    if (!candidates.length) return;
    const primary = candidates[0]?.model || '';
    const fallback = candidates.find((c) => c.model !== primary)?.model || '';
    promptOptState.cacheModel = {
      primary,
      fallback,
      candidates,
      fetchedAt: Date.now()
    };
  }

  function safeRemove(node) {
    try {
      if (node && typeof node.remove === 'function') node.remove();
    } catch {}
  }

  function getMeterHostAndShadow() {
    const host = document.getElementById(METER_HOST_ID);
    const sr = host && host.shadowRoot ? host.shadowRoot : null;
    return { host, sr };
  }

  function resolveHostTheme(host) {
    try {
      const attr = host?.getAttribute?.('data-theme');
      if (attr === 'light' || attr === 'dark') return attr;
      const docAttr = document.documentElement?.getAttribute?.('data-theme');
      if (docAttr === 'light' || docAttr === 'dark') return docAttr;
      if (document.documentElement?.classList?.contains('light')) return 'light';
      if (document.documentElement?.classList?.contains('dark')) return 'dark';
      if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) return 'light';
    } catch {}
    return 'dark';
  }

  // 解析剩余百分比对应的视觉颜色：>=50% 跟随当前主题色，20%~50% 琥珀黄，<20% 红
  function getQuotaColor(frac) {
    if (typeof frac !== 'number' || !Number.isFinite(frac)) return '#9ca3af';
    const pct = frac * 100;
    if (pct >= 50) return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))';
    if (pct >= 20) return '#fbbf24';
    return '#f87171';
  }

  function formatPctInt(frac) {
    if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--%';
    return `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  function formatPctOne(frac) {
    if (typeof frac !== 'number' || !Number.isFinite(frac)) return '--%';
    return `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`;
  }

  function formatResetCountdownZh(isoStr) {
    if (!isoStr) return '重置时间未知';
    const target = new Date(isoStr);
    if (Number.isNaN(target.getTime())) return String(isoStr);
    const diffMs = target.getTime() - Date.now();
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    const month = target.getMonth() + 1;
    const day = target.getDate();
    const now = new Date();
    const sameDay = now.getFullYear() === target.getFullYear() && now.getMonth() === target.getMonth() && now.getDate() === target.getDate();
    const timeLabel = sameDay ? `${hh}:${mm}` : `${month}月${day}日 ${hh}:${mm}`;

    if (diffMs <= 0) return `即将重置 · ${timeLabel}`;
    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    let countdown = '';
    if (days > 0) countdown = `${days}天${hours}小时`;
    else if (hours > 0) countdown = `${hours}小时${mins}分`;
    else countdown = `${Math.max(1, mins)}分钟`;
    return `${countdown}后重置 · ${timeLabel}`;
  }

  function detectCurrentModelText() {
    try {
      const btn = document.querySelector('[data-testid="model-selector-trigger"]');
      const txt = btn?.textContent?.trim();
      if (txt) return txt;
    } catch {}
    try {
      const snapModel = window.__AGContextMeter?.snapshot?.()?.latest?.model;
      if (snapModel) return String(snapModel);
    } catch {}
    return '';
  }

  function classifyModelPoolKey(modelText) {
    const s = String(modelText || '').toLowerCase();
    if (s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('gpt')) {
      return 'claude';
    }
    return 'gemini';
  }

  function resolveProtoFraction(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.remainingFraction === 'number' && Number.isFinite(obj.remainingFraction)) {
      return Math.max(0, Math.min(1, obj.remainingFraction));
    }
    // Protobuf3 JSON 序列化会省略默认零值 0，若存在 resetTime/window/bucketId 说明配额桶存在且已耗尽 (0%)
    if (obj.resetTime || obj.window || obj.bucketId) {
      return 0;
    }
    return null;
  }

  function aggregatePoolsFromConfigs(configs) {
    if (!Array.isArray(configs) || !configs.length) return { gemini: null, claude: null };
    let gemini = null;
    let claude = null;

    for (const c of configs) {
      if (!c || typeof c !== 'object') continue;
      // 拼接 modelId / modelOrAlias.model / label，避免 MODEL_PLACEHOLDER_* 遮蔽真实模型名称
      const id = `${c.modelId || ''} ${c.modelOrAlias?.model || ''} ${c.label || ''}`.toLowerCase();
      const qi = c.quotaInfo || {};
      const frac = resolveProtoFraction(qi);
      const resetTime = qi.resetTime || null;
      if (frac === null && !resetTime) continue;

      if (id.includes('gemini-4') || id.includes('gemini-pro-orchestrator') || id.includes('gemini-3.8-flash')) {
        if (!gemini || (frac !== null && (gemini.remainingFraction === null || frac < gemini.remainingFraction))) {
          gemini = { remainingFraction: frac, resetTime, sampleLabel: c.label || c.modelId || 'Gemini' };
        }
      } else if (id.includes('claude') || id.includes('gpt-oss')) {
        if (!claude || (frac !== null && (claude.remainingFraction === null || frac < claude.remainingFraction))) {
          claude = { remainingFraction: frac, resetTime, sampleLabel: c.label || c.modelId || 'Claude / GPT' };
        }
      }
    }
    return { gemini, claude };
  }

  function parseQuotaSummaryGroups(summaryPayload) {
    const groups = summaryPayload?.response?.groups || summaryPayload?.groups || [];
    const result = {
      gemini: { fiveHour: null, weekly: null },
      claude: { fiveHour: null, weekly: null },
      subGroups: []
    };
    if (!Array.isArray(groups) || !groups.length) return result;

    const pickTighter = (existing, incoming) => {
      if (!existing) return incoming;
      if (!incoming) return existing;
      if (typeof incoming.remainingFraction === 'number') {
        if (existing.remainingFraction === null || existing.remainingFraction === undefined || incoming.remainingFraction < existing.remainingFraction) {
          return incoming;
        }
      }
      return existing;
    };

    for (const grp of groups) {
      if (!grp || typeof grp !== 'object') continue;
      const nameLower = String(grp.displayName || '').toLowerCase();
      const buckets = Array.isArray(grp.buckets) ? grp.buckets : [];
      let targetKey = null;
      if (nameLower.includes('gemini')) {
        targetKey = 'gemini';
      } else if (nameLower.includes('claude') || nameLower.includes('gpt') || nameLower.includes('3p')) {
        targetKey = 'claude';
      } else if (buckets.some((b) => String(b?.bucketId || '').toLowerCase().includes('gemini'))) {
        targetKey = 'gemini';
      } else if (buckets.some((b) => /3p|claude|gpt/i.test(String(b?.bucketId || '')))) {
        targetKey = 'claude';
      }
      if (!targetKey) continue;

      let grpFiveHour = null;
      let grpWeekly = null;
      let grpTightest = null;
      for (const b of buckets) {
        if (!b || typeof b !== 'object') continue;
        const win = String(b.window || '').toLowerCase();
        const bid = String(b.bucketId || '').toLowerCase();
        const frac = resolveProtoFraction(b);
        const resetTime = b.resetTime || null;
        if (frac === null && !resetTime) continue;

        const bucketInfo = { remainingFraction: frac, resetTime };
        grpTightest = pickTighter(grpTightest, bucketInfo);
        if (win === '5h' || bid.includes('5h')) {
          grpFiveHour = pickTighter(grpFiveHour, bucketInfo);
          result[targetKey].fiveHour = pickTighter(result[targetKey].fiveHour, bucketInfo);
        } else if (win === 'weekly' || bid.includes('weekly')) {
          grpWeekly = pickTighter(grpWeekly, bucketInfo);
          result[targetKey].weekly = pickTighter(result[targetKey].weekly, bucketInfo);
        }
      }
      if (grpFiveHour || grpWeekly || grpTightest) {
        result.subGroups.push({
          id: grp.groupId || grp.id || grp.displayName || `${targetKey}-${result.subGroups.length}`,
          displayName: grp.displayName || (targetKey === 'claude' ? 'Claude 5.5 / GPT' : 'Gemini 4 / 3.8'),
          poolKey: targetKey,
          fiveHour: grpFiveHour,
          weekly: grpWeekly,
          remainingFraction: grpTightest ? grpTightest.remainingFraction : null,
          resetTime: grpTightest?.resetTime || grpFiveHour?.resetTime || grpWeekly?.resetTime || null
        });
      }
    }
    return result;
  }

  function mergePoolWithSummary(configPool, summaryItem, fallbackLabel) {
    const fiveHour = summaryItem?.fiveHour || null;
    const weekly = summaryItem?.weekly || null;
    if (!configPool && !fiveHour && !weekly) return null;

    // 顶栏胶囊与池主指标取各有效窗口中剩余比例最低（最紧）的值
    const candidates = [fiveHour, weekly, configPool].filter(
      (item) => item && typeof item.remainingFraction === 'number' && Number.isFinite(item.remainingFraction)
    );
    let tightest = null;
    for (const c of candidates) {
      if (!tightest || c.remainingFraction < tightest.remainingFraction) {
        tightest = c;
      }
    }

    const remainingFraction = tightest
      ? tightest.remainingFraction
      : (configPool?.remainingFraction ?? null);
    const resetTime = tightest?.resetTime || fiveHour?.resetTime || weekly?.resetTime || configPool?.resetTime || null;
    const sampleLabel = configPool?.sampleLabel || fallbackLabel;

    return {
      remainingFraction,
      resetTime,
      sampleLabel,
      fiveHour,
      weekly
    };
  }

  function normalizeCredits(userStatus, historyPlan) {
    let promptCredits = null;
    let flowCredits = null;
    const ps = userStatus?.planStatus;
    if (ps) {
      const availPrompt = ps.availablePromptCredits;
      const monthlyPrompt = ps.planInfo?.monthlyPromptCredits ?? historyPlan?.promptCredits?.monthly ?? null;
      if (typeof availPrompt === 'number') {
        promptCredits = { available: availPrompt, monthly: monthlyPrompt };
      }
      const availFlow = ps.availableFlowCredits;
      const monthlyFlow = ps.planInfo?.monthlyFlowCredits ?? historyPlan?.flowCredits?.monthly ?? null;
      if (typeof availFlow === 'number') {
        flowCredits = { available: availFlow, monthly: monthlyFlow };
      }
    }
    if (!promptCredits && historyPlan?.promptCredits && typeof historyPlan.promptCredits.available === 'number') {
      promptCredits = historyPlan.promptCredits;
    }
    if (!flowCredits && historyPlan?.flowCredits && typeof historyPlan.flowCredits.available === 'number') {
      flowCredits = historyPlan.flowCredits;
    }
    return { promptCredits, flowCredits };
  }

  async function refreshQuota() {
    if (disposed || quotaState.loading) return quotaState;
    quotaState.loading = true;
    renderQuotaUI();

    try {
      const csrf = window.__APP_CONFIG__?.csrfToken;
      let configs = null;
      let userStatus = null;
      let summaryData = null;

      if (csrf) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const headers = {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        };
        try {
          const [statusRes, summaryRes] = await Promise.allSettled([
            fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
              method: 'POST',
              headers,
              body: '{}',
              signal: controller.signal
            }),
            fetch('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', {
              method: 'POST',
              headers,
              body: '{}',
              signal: controller.signal
            })
          ]);
          if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
            const payload = await statusRes.value.json();
            userStatus = payload?.userStatus || null;
            if (userStatus?.cascadeModelConfigData) {
              cacheDefaultModelFromConfigData(userStatus.cascadeModelConfigData);
            }
            configs = userStatus?.cascadeModelConfigData?.clientModelConfigs || null;
          }
          if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
            summaryData = await summaryRes.value.json();
          }
        } finally {
          clearTimeout(timer);
        }
      }

      const historyRaw = window.__AGContextMeterHistory?.rawPlanStatus || window.__AGContextMeterHistory?.planStatus || null;
      if (!configs || !configs.length) {
        configs = historyRaw?.cascadeModelConfigs || [];
      }

      const configPools = aggregatePoolsFromConfigs(configs);
      const summaryPools = parseQuotaSummaryGroups(summaryData);
      const mergedGemini = mergePoolWithSummary(configPools.gemini, summaryPools.gemini, 'Gemini');
      const mergedClaude = mergePoolWithSummary(configPools.claude, summaryPools.claude, 'Claude / GPT');
      const credits = normalizeCredits(userStatus, historyRaw);

      if (mergedGemini || mergedClaude) {
        quotaState.gemini = mergedGemini;
        quotaState.claude = mergedClaude;
        quotaState.subGroups = Array.isArray(summaryPools.subGroups) ? summaryPools.subGroups : [];
        quotaState.lastFetchedAt = Date.now();
        quotaState.error = '';
      } else if (!quotaState.gemini && !quotaState.claude) {
        quotaState.subGroups = [];
        quotaState.error = '暂无可用配额数据';
      }
      quotaState.promptCredits = credits.promptCredits;
      quotaState.flowCredits = credits.flowCredits;
    } catch (err) {
      // 接口失败时回退本地缓存数据
      const historyRaw = window.__AGContextMeterHistory?.rawPlanStatus || window.__AGContextMeterHistory?.planStatus || null;
      if (!quotaState.gemini && !quotaState.claude && historyRaw?.cascadeModelConfigs?.length) {
        const pools = aggregatePoolsFromConfigs(historyRaw.cascadeModelConfigs);
        quotaState.gemini = pools.gemini;
        quotaState.claude = pools.claude;
        const credits = normalizeCredits(null, historyRaw);
        quotaState.promptCredits = credits.promptCredits;
        quotaState.flowCredits = credits.flowCredits;
      }
      quotaState.error = err?.name === 'AbortError' ? '配额查询超时' : (err?.message || '配额刷新失败');
    } finally {
      quotaState.loading = false;
      quotaState.activeModelText = detectCurrentModelText();
      quotaState.activePoolKey = classifyModelPoolKey(quotaState.activeModelText);
      renderQuotaUI();
    }
    return quotaState;
  }

  function ensureQuotaStylesAndNodes() {
    const { host, sr } = getMeterHostAndShadow();
    if (!host || !sr) return null;

    let styleEl = sr.getElementById(QUOTA_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = QUOTA_STYLE_ID;
      styleEl.textContent = `
        #badge-quota {
          gap: 5px;
          padding: 0 7px;
          font-variant-numeric: tabular-nums;
          color: var(--ag-toolbar-fg, #d4d4d8);
        }
        #badge-quota:hover,
        #badge-quota:focus-visible,
        #badge-quota[aria-expanded="true"] {
          color: var(--ag-toolbar-fg-hover, #ffffff);
        }
        .ag-quota-dot {
          width: 7px;
          height: 7px;
          border-radius: 9999px;
          flex-shrink: 0;
          background: #9ca3af;
          transition: background-color 0.2s ease;
        }
        :host([data-layout="compact"]) #badge-quota {
          padding: 0 5px;
          font-size: 11.5px;
          gap: 4px;
        }
        :host([data-layout="minimal"]) #badge-quota,
        :host([data-layout="ring-only"]) #badge-quota {
          display: none !important;
        }
        #ag-quota-popover {
          position: fixed;
          z-index: 2147483645;
          width: 340px;
          max-width: calc(100vw - 24px);
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid var(--ag-border-panel, var(--ag-float-border, rgba(255, 255, 255, 0.11)));
          background: var(--ag-bg-panel, var(--ag-float-bg, #18181b));
          color: var(--ag-text-primary, #ececef);
          box-shadow: var(--ag-shadow-panel, var(--ag-float-shadow, 0 16px 40px rgba(0, 0, 0, 0.58)));
          font-size: 13px;
          line-height: 1.45;
        }
        #ag-quota-popover[hidden] {
          display: none !important;
        }
        .ag-qp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
        }
        .ag-qp-title {
          font-size: 13.5px;
          font-weight: 600;
          color: var(--ag-text-primary, #f4f4f5);
        }
        .ag-qp-refresh {
          height: 26px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid var(--ag-btn-border, var(--ag-border-subcard, rgba(255, 255, 255, 0.12)));
          background: var(--ag-btn-bg, var(--ag-bg-subcard, rgba(255, 255, 255, 0.04)));
          color: var(--ag-text-primary, #e4e4e7);
          font-size: 12px;
          white-space: nowrap;
          flex-shrink: 0;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .ag-qp-refresh:hover {
          background: var(--ag-btn-hover, var(--ag-toolbar-bg-hover, rgba(255, 255, 255, 0.08)));
        }
        .ag-qp-model {
          font-size: 12px;
          color: var(--ag-text-muted, #a1a1aa);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .ag-qp-model strong {
          color: var(--ag-text-primary, #f4f4f5);
          font-weight: 500;
        }
        .ag-qp-card {
          padding: 8px 10px;
          border-radius: 8px;
          background: var(--ag-bg-card, var(--ag-bg-subcard, rgba(255, 255, 255, 0.025)));
          border: 1px solid var(--ag-border-card, var(--ag-border-subcard, rgba(255, 255, 255, 0.09)));
          margin-bottom: 8px;
        }
        .ag-qp-card.is-active {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
        }
        .ag-qp-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 5px;
        }
        .ag-qp-pool-name {
          font-size: 12.5px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .ag-qp-active-tag {
          font-size: 11.5px;
          font-weight: 500;
          padding: 1px 5px;
          border-radius: 4px;
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          border: 1px solid var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        .ag-qp-pct {
          font-size: 13px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .ag-qp-bar {
          width: 100%;
          height: 5px;
          border-radius: 9999px;
          background: rgba(127, 127, 127, 0.22);
          overflow: hidden;
          margin-bottom: 5px;
        }
        .ag-qp-bar-fill {
          height: 100%;
          border-radius: 9999px;
          transition: width 0.25s ease, background-color 0.2s ease;
        }
        .ag-qp-reset {
          font-size: 11.5px;
          color: var(--ag-text-muted, #a1a1aa);
        }
        .ag-qp-subrows {
          display: flex;
          flex-direction: column;
          gap: 7px;
          margin-top: 2px;
        }
        .ag-qp-subrow {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .ag-qp-subhead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
        }
        .ag-qp-sublabel {
          color: var(--ag-text-primary, #e4e4e7);
          font-weight: 500;
        }
        .ag-qp-subpct {
          font-size: 12.5px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .ag-qp-subrow .ag-qp-bar {
          margin-bottom: 1px;
        }
        .ag-qp-footer {
          margin-top: 6px;
          padding-top: 8px;
          border-top: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 12px;
          color: var(--ag-text-muted, #a1a1aa);
        }
        .ag-qp-credit-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        #badge-remote {
          gap: 4px;
          padding: 0 7px;
          color: var(--ag-toolbar-fg, #d4d4d8);
        }
        #badge-remote[data-online="true"] {
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        :host([data-theme="light"]) #badge-remote[data-online="true"] {
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        #badge-remote .ag-remote-dot {
          display: none;
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
          flex-shrink: 0;
        }
        :host([data-theme="light"]) #badge-remote .ag-remote-dot {
          background: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        #badge-remote[data-online="true"] .ag-remote-dot {
          display: inline-block;
        }
        #badge-remote:hover,
        #badge-remote:focus-visible,
        #badge-remote[aria-expanded="true"] {
          color: var(--ag-toolbar-fg-hover, #ececef);
        }
        :host([data-theme="light"]) #badge-remote:hover,
        :host([data-theme="light"]) #badge-remote:focus-visible,
        :host([data-theme="light"]) #badge-remote[aria-expanded="true"] {
          color: var(--ag-toolbar-fg-hover, #18181b);
        }
        :host([data-layout="compact"]) #badge-remote {
          padding: 0 5px;
          font-size: 11.5px;
          gap: 3px;
        }
        :host([data-layout="ring-only"]) #badge-remote {
          padding: 0 5px;
        }
        :host([data-layout="ring-only"]) #badge-remote .ag-remote-text {
          display: none;
        }
        #ag-remote-popover {
          position: fixed;
          z-index: 2147483645;
          width: 340px;
          max-width: calc(100vw - 24px);
          box-sizing: border-box;
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid var(--ag-border-panel, var(--ag-float-border, rgba(255, 255, 255, 0.11)));
          background: var(--ag-bg-panel, var(--ag-float-bg, #18181b));
          color: var(--ag-text-primary, #ececef);
          box-shadow: var(--ag-shadow-panel, var(--ag-float-shadow, 0 16px 40px rgba(0, 0, 0, 0.58)));
          font-size: 13px;
          line-height: 1.45;
        }
        #ag-remote-popover[hidden] {
          display: none !important;
        }
        .ag-rp-icon {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          display: inline-block;
        }
        .ag-rp-status {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.4;
          color: var(--ag-text-primary, #e4e4e7);
          text-align: center;
          margin: 2px 0 8px;
        }
        .ag-rp-qr {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 12px;
          border-radius: 10px;
          background: #ffffff;
          margin: 4px auto 12px;
          width: fit-content;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
        }
        .ag-rp-qr svg {
          display: block;
          width: 196px;
          height: 196px;
        }
        .ag-rp-channels {
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin: 0 0 10px;
        }
        .ag-rp-channel {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          width: 100%;
          box-sizing: border-box;
          padding: 6px 8px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          color: var(--ag-text-primary, #e4e4e7);
          font-size: 12.5px;
          line-height: 1.3;
          text-align: left;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease, opacity 0.14s ease;
        }
        .ag-rp-channel[aria-checked="false"] {
          opacity: 0.68;
        }
        .ag-rp-channel[disabled] {
          opacity: 0.45;
          cursor: default;
        }
        .ag-rp-channel:not([disabled]):hover {
          background: var(--ag-btn-hover, rgba(255, 255, 255, 0.08));
          opacity: 1;
        }
        .ag-rp-channel[data-selected="true"] {
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
          font-weight: 500;
        }
        :host([data-theme="light"]) .ag-rp-channel:not([disabled]):hover {
          background: var(--ag-btn-hover, rgba(0, 0, 0, 0.06));
        }
        :host([data-theme="light"]) .ag-rp-channel[data-selected="true"] {
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-ch-left {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-weight: 500;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .ag-rp-check-box {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--ag-text-muted, #a1a1aa);
          flex-shrink: 0;
        }
        .ag-rp-ch-host {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11.5px;
          color: var(--ag-text-muted, #a1a1aa);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .ag-rp-channel-wrap {
          display: flex;
          align-items: center;
          gap: 4px;
          border-radius: 7px;
          transition: background-color 0.14s ease;
        }
        .ag-rp-channel-wrap .ag-rp-channel {
          flex: 1 1 auto;
          min-width: 0;
        }
        .ag-rp-channel-tools {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding-right: 4px;
          flex-shrink: 0;
        }
        .ag-rp-mini-btn {
          padding: 3px 7px;
          border-radius: 5px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.14));
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.06));
          color: var(--ag-text-primary, #e4e4e7);
          font-size: 10.5px;
          font-weight: 500;
          line-height: 1.2;
          white-space: nowrap;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease;
        }
        .ag-rp-mini-btn:hover:not([disabled]) {
          background: rgba(255, 255, 255, 0.14);
        }
        .ag-rp-mini-btn[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        :host([data-theme="light"]) .ag-rp-mini-btn[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-mini-btn[disabled] {
          opacity: 0.5;
          cursor: default;
        }
        @keyframes ag-rp-spin {
          to { transform: rotate(360deg); }
        }
        .ag-rp-spin {
          display: inline-block;
          width: 11px;
          height: 11px;
          border: 1.8px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: ag-rp-spin 0.65s linear infinite;
          vertical-align: -1.5px;
          margin-right: 4px;
          flex-shrink: 0;
        }
        .ag-rp-tunnel-form {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 10px;
          margin: 2px 0 8px;
          border-radius: 8px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.1));
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.04));
        }
        .ag-rp-tunnel-head {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .ag-rp-tunnel-note {
          font-size: 10.5px;
          color: var(--ag-text-muted, #a1a1aa);
          line-height: 1.35;
        }
        .ag-rp-cf-link {
          display: inline-flex;
          align-items: center;
          align-self: flex-start;
          gap: 4px;
          padding: 3px 8px;
          border-radius: 5px;
          border: 1px solid var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
          font-size: 10.5px;
          font-weight: 500;
          line-height: 1.3;
          text-decoration: none;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease;
        }
        .ag-rp-cf-link:hover {
          background: var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24));
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
        }
        :host([data-theme="light"]) .ag-rp-cf-link {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        :host([data-theme="light"]) .ag-rp-cf-link:hover {
          background: var(--ag-accent-bg-hover, rgba(124, 58, 237, 0.18));
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
        }
        .ag-rp-input {
          width: 100%;
          box-sizing: border-box;
          padding: 5px 8px;
          border-radius: 6px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.14));
          background: var(--ag-bg-input, rgba(0, 0, 0, 0.28));
          color: var(--ag-text-primary, #f4f4f5);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          outline: none;
        }
        :host([data-theme="light"]) .ag-rp-input {
          background: rgba(255, 255, 255, 0.9);
          border-color: rgba(0, 0, 0, 0.16);
          color: #18181b;
        }
        .ag-rp-input:focus {
          border-color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        :host([data-theme="light"]) .ag-rp-input:focus {
          border-color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-err {
          font-size: 10.5px;
          color: #f87171;
          line-height: 1.35;
          margin: 0 0 6px;
        }
        .ag-rp-sec {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 11.5px;
          color: var(--ag-text-muted, #a1a1aa);
          margin: 0 0 10px;
          text-align: center;
        }
        .ag-rp-sec[data-active="true"] {
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
          font-weight: 600;
        }
        :host([data-theme="light"]) .ag-rp-sec[data-active="true"] {
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-devices {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 5px;
          margin: -4px 0 10px;
        }
        .ag-rp-dev-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 6px;
          font-size: 11.5px;
          line-height: 1.35;
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.04));
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
          color: var(--ag-text-primary, #e4e4e7);
        }
        .ag-rp-dev-dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: var(--ag-text-muted, #a1a1aa);
          flex-shrink: 0;
        }
        .ag-rp-dev-chip[data-online="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
        }
        .ag-rp-dev-chip[data-online="true"] .ag-rp-dev-dot {
          background: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        :host([data-theme="light"]) .ag-rp-dev-chip {
          background: var(--ag-bg-subcard, rgba(0, 0, 0, 0.035));
          border-color: var(--ag-border-subcard, rgba(0, 0, 0, 0.09));
        }
        :host([data-theme="light"]) .ag-rp-dev-chip[data-online="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
        }
        :host([data-theme="light"]) .ag-rp-dev-chip[data-online="true"] .ag-rp-dev-dot {
          background: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-actions {
          display: flex;
          gap: 8px;
        }
        .ag-rp-btn {
          flex: 1 1 0;
          min-width: 0;
          min-height: 32px;
          height: auto;
          padding: 5px 10px;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          white-space: nowrap;
          border-radius: 7px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.12));
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.04));
          color: var(--ag-text-primary, #f4f4f5);
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .ag-rp-btn:hover {
          background: var(--ag-toolbar-bg-hover, rgba(255, 255, 255, 0.08));
        }
        .ag-rp-btn[data-primary="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
        }
        :host([data-theme="light"]) .ag-rp-btn[data-primary="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-readonly-summary {
          display: flex;
          flex-direction: column;
          gap: 5px;
          margin: 0 0 10px;
        }
        .ag-rp-ch-pill {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 5px 9px;
          border-radius: 7px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.035));
          font-size: 12px;
          color: var(--ag-text-primary, #e4e4e7);
        }
        .ag-rp-ch-pill[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
          font-weight: 500;
        }
        :host([data-theme="light"]) .ag-rp-ch-pill[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #7c3aed));
        }
        .ag-rp-ch-pill-host {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          color: var(--ag-text-muted, #a1a1aa);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .ag-rp-tip {
          margin-top: 8px;
          font-size: 11.5px;
          color: var(--ag-text-muted, #a1a1aa);
          line-height: 1.4;
        }
      `;
      sr.appendChild(styleEl);
    }

    const contextBadge = sr.getElementById('badge');
    let remoteBtn = sr.getElementById(REMOTE_BADGE_ID);
    if (!remoteBtn && contextBadge) {
      remoteBtn = document.createElement('button');
      remoteBtn.id = REMOTE_BADGE_ID;
      remoteBtn.className = 'ag-unit';
      remoteBtn.type = 'button';
      remoteBtn.setAttribute('aria-label', tr('手机远程操作配对', 'Mobile Remote Pairing'));
      remoteBtn.setAttribute('aria-expanded', 'false');
      remoteBtn.title = tr('手机远程操作配对（局域网 / Tailscale / Cloudflare）', 'Mobile Remote Pairing (LAN / Tailscale / Cloudflare)');
      remoteBtn.innerHTML = `<span class="ag-remote-icon">📱</span><span class="ag-remote-dot"></span><span class="ag-remote-text">${escapeHtml(tr('远程', 'Remote'))}</span>`;
      contextBadge.insertAdjacentElement('beforebegin', remoteBtn);

      remoteBtn.addEventListener('click', onRemoteBtnClick);
    }
    if (remoteBtn) remoteBtn.hidden = featureFlags.showTopbarRemote === false;

    let quotaBtn = sr.getElementById(QUOTA_BADGE_ID);
    const anchorBadge = contextBadge;
    if (!quotaBtn && anchorBadge) {
      quotaBtn = document.createElement('button');
      quotaBtn.id = QUOTA_BADGE_ID;
      quotaBtn.className = 'ag-unit';
      quotaBtn.type = 'button';
      quotaBtn.setAttribute('aria-label', '模型剩余配额');
      quotaBtn.setAttribute('aria-expanded', 'false');
      quotaBtn.title = '查看 Gemini / Claude 模型剩余配额与重置倒计时';
      quotaBtn.innerHTML = '<span id="ag-quota-dot" class="ag-quota-dot"></span><span id="ag-quota-text">配额 --%</span>';
      anchorBadge.insertAdjacentElement('afterend', quotaBtn);

      quotaBtn.addEventListener('click', onQuotaBtnClick);
    } else if (
      quotaBtn &&
      contextBadge &&
      typeof quotaBtn.previousElementSibling !== 'undefined' &&
      quotaBtn.previousElementSibling !== contextBadge &&
      typeof contextBadge.insertAdjacentElement === 'function'
    ) {
      contextBadge.insertAdjacentElement('afterend', quotaBtn);
    }
    if (quotaBtn) quotaBtn.hidden = featureFlags.showTopbarQuota === false;

    let popover = sr.getElementById(QUOTA_POPOVER_ID);
    if (!popover) {
      popover = document.createElement('div');
      popover.id = QUOTA_POPOVER_ID;
      popover.hidden = true;
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', '模型剩余配额详情');
      popover.addEventListener('click', (e) => e.stopPropagation());
      sr.appendChild(popover);
    }

    let remotePopover = sr.getElementById(REMOTE_POPOVER_ID);
    if (!remotePopover) {
      remotePopover = document.createElement('div');
      remotePopover.id = REMOTE_POPOVER_ID;
      remotePopover.hidden = true;
      remotePopover.setAttribute('role', 'dialog');
      remotePopover.setAttribute('aria-label', tr('手机远程操作配对', 'Mobile Remote Pairing'));
      remotePopover.addEventListener('click', (e) => e.stopPropagation());
      sr.appendChild(remotePopover);
    }

    return { host, sr, remoteBtn, quotaBtn, popover, remotePopover };
  }

  function updateRemoteBtnLanguage(opts = {}) {
    const { sr } = getMeterHostAndShadow();
    if (!sr) return;
    const pairedCount = Math.max(0, Number(remotePairState.data?.pairedCount || 0));
    const onlineCount = Math.max(0, Number(remotePairState.data?.onlineCount || 0));
    const remoteBtn = sr.getElementById(REMOTE_BADGE_ID);
    if (remoteBtn) {
      remoteBtn.setAttribute('aria-label', tr('手机远程操作配对', 'Mobile Remote Pairing'));
      const baseTitle = tr('手机远程操作配对（局域网 / Tailscale / Cloudflare）', 'Mobile Remote Pairing (LAN / Tailscale / Cloudflare)');
      const countTitle = pairedCount > 0
        ? tr(`\n已关联 ${pairedCount} 台设备（${onlineCount} 台在线）`, `\n${pairedCount} paired (${onlineCount} online)`)
        : '';
      remoteBtn.title = `${baseTitle}${countTitle}`;
      if (pairedCount > 0) {
        remoteBtn.setAttribute('data-paired', String(pairedCount));
        remoteBtn.setAttribute('data-online', onlineCount > 0 ? 'true' : 'false');
      } else {
        remoteBtn.removeAttribute('data-paired');
        remoteBtn.removeAttribute('data-online');
      }
      const textSpan = remoteBtn.querySelector?.('.ag-remote-text');
      if (textSpan) {
        textSpan.textContent = pairedCount > 0
          ? tr(`远程 · ${pairedCount}`, `Remote · ${pairedCount}`)
          : tr('远程', 'Remote');
      }
    }
    const remotePopover = sr.getElementById(REMOTE_POPOVER_ID);
    if (remotePopover) {
      remotePopover.setAttribute('aria-label', tr('手机远程操作配对', 'Mobile Remote Pairing'));
      if (!opts?.skipRender && remotePopoverOpen) renderRemotePopoverContent(remotePopover);
    }
  }

  function positionQuotaPopover() {
    const { sr } = getMeterHostAndShadow();
    if (!sr) return;
    const btn = sr.getElementById(QUOTA_BADGE_ID);
    const popover = sr.getElementById(QUOTA_POPOVER_ID);
    if (!btn || !popover || popover.hidden) return;

    try {
      const bRect = btn.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const popW = Math.min(320, vw - 24);
      const popH = Math.max(240, Math.round(popover.offsetHeight || 300));
      const top = Math.max(36, Math.min(vh - popH - 12, Math.round(bRect.bottom + 6)));
      // 右边缘优先对齐触发按钮，与顶栏其他面板对齐行为保持一致
      let left = Math.round(bRect.right - popW);
      left = Math.max(12, Math.min(vw - popW - 12, left));
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
      popover.style.width = `${popW}px`;
    } catch {}
  }

  function positionRemotePopover() {
    const { sr } = getMeterHostAndShadow();
    if (!sr) return;
    const btn = sr.getElementById(REMOTE_BADGE_ID);
    const popover = sr.getElementById(REMOTE_POPOVER_ID);
    if (!btn || !popover || popover.hidden) return;

    try {
      const bRect = btn.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const popW = Math.min(340, vw - 24);
      const popH = Math.max(260, Math.round(popover.offsetHeight || 360));
      const top = Math.max(36, Math.min(vh - popH - 12, Math.round(bRect.bottom + 6)));
      let left = Math.round(bRect.right - popW);
      left = Math.max(12, Math.min(vw - popW - 12, left));
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
      popover.style.width = `${popW}px`;
    } catch {}
  }

  function extractUrlHostSafe(rawUrl) {
    try {
      return new URL(String(rawUrl || '')).hostname || '';
    } catch {
      return '';
    }
  }

  function resolveRemoteEndpoint(data) {
    if (!data) return null;
    const tsList = Array.isArray(data.tailscaleUrls) ? data.tailscaleUrls : [];
    const lanList = Array.isArray(data.lanUrls) ? data.lanUrls : [];

    let channels = Array.isArray(data.channels) && data.channels.length
      ? data.channels.map((ch) => ({ ...ch }))
      : [
          {
            key: 'lan',
            label: '局域网',
            labelEn: 'LAN',
            enabled: data.enabledChannels?.lan !== false,
            available: (data.enabledChannels?.lan !== false) && lanList.length > 0,
            rawHost: extractUrlHostSafe(lanList[0]?.url),
            displayHost: extractUrlHostSafe(lanList[0]?.url),
            url: lanList[0]?.url || '',
            qrSvg: lanList[0]?.qrSvg || ''
          },
          {
            key: 'tailscale',
            label: 'Tailscale',
            labelEn: 'Tailscale',
            enabled: data.enabledChannels?.tailscale !== false,
            available: (data.enabledChannels?.tailscale !== false) && tsList.length > 0,
            rawHost: data.tailscaleDnsName || extractUrlHostSafe(tsList[0]?.url),
            displayHost: data.tailscaleDnsName || extractUrlHostSafe(tsList[0]?.url),
            url: tsList[0]?.url || '',
            qrSvg: tsList[0]?.qrSvg || ''
          },
          {
            key: 'bonjour',
            label: 'Bonjour',
            labelEn: 'Bonjour',
            enabled: data.enabledChannels?.bonjour !== false,
            available: (data.enabledChannels?.bonjour !== false) && Boolean(data.bonjourHost && lanList.length > 0),
            rawHost: data.bonjourHost || '',
            displayHost: data.bonjourHost || '',
            url: data.fusedUrl || data.primaryUrl || lanList[0]?.url || '',
            qrSvg: data.qrSvg || lanList[0]?.qrSvg || ''
          }
        ];

    const switchingTunnelMode = Boolean(
      remotePairState.tunnelBusy
      && (remotePairState.tunnelPendingAction === 'quick' || remotePairState.tunnelPendingAction === 'named')
    );
    if (switchingTunnelMode) {
      channels = channels.map((ch) => (ch.key === 'tunnel'
        ? { ...ch, available: false, url: '', qrSvg: '', rawHost: '', entryHost: '', entryBaseUrl: '' }
        : ch));
    }

    const availableList = channels.filter((c) => (c.enabled !== false) && c.available && c.url);
    const activeChannel = availableList.find((c) => c.key === 'tunnel')
      || availableList.find((c) => c.key === 'tailscale')
      || availableList.find((c) => c.key === 'lan')
      || availableList[0]
      || null;

    const activeUrl = availableList.length > 0
      ? (activeChannel?.url || (!switchingTunnelMode ? (data.fusedUrl || data.primaryUrl || '') : ''))
      : '';
    const activeQr = availableList.length > 0
      ? (activeChannel?.qrSvg || (!switchingTunnelMode ? (data.qrSvg || '') : ''))
      : '';

    return {
      channels,
      activeChannel,
      activeKey: activeChannel?.key || 'none',
      activeUrl,
      activeQr
    };
  }

  function formatRemoteDeviceChannel(ch) {
    if (ch === 'tunnel') return 'Cloudflare';
    if (ch === 'tailscale') return 'Tailscale';
    if (ch === 'bonjour') return 'Bonjour';
    if (ch === 'loopback') return tr('本机', 'Local');
    return tr('局域网', 'LAN');
  }

  function formatRemoteDeviceTime(dev) {
    if (dev?.online) return tr('在线', 'Online');
    const sec = Math.max(1, Math.round((Date.now() - Number(dev?.lastSeenAt || 0)) / 1000));
    if (sec < 60) return tr('刚刚', 'Just now');
    const mins = Math.round(sec / 60);
    if (mins < 60) return tr(`${mins}分钟前`, `${mins}m ago`);
    const hrs = Math.round(mins / 60);
    return tr(`${hrs}小时前`, `${hrs}h ago`);
  }

  function scheduleTunnelStartingPoll() {
    if (remotePairState.tunnelPollTimer) {
      clearTimeout(remotePairState.tunnelPollTimer);
      remotePairState.tunnelPollTimer = null;
    }
    if (!remotePopoverOpen || disposed) return;
    const chs = remotePairState.data?.channels;
    const tunnelCh = Array.isArray(chs) ? chs.find((c) => c.key === 'tunnel') : null;
    if (tunnelCh?.state === 'starting') {
      remotePairState.tunnelPollTimer = setTimeout(() => {
        remotePairState.tunnelPollTimer = null;
        if (remotePopoverOpen && !disposed) void refreshRemotePairInfo(false);
      }, 1500);
    }
  }

  async function configureRemoteTunnel(payload = {}) {
    if (disposed || remotePairState.tunnelBusy) return remotePairState;
    remotePairState.tunnelBusy = true;
    remotePairState.tunnelPendingAction = payload.tunnelMode === 'quick'
      ? 'quick'
      : (payload.tunnelMode === 'named' ? 'named' : 'toggle');
    remotePairState.error = '';
    const nodes = ensureQuotaStylesAndNodes();
    if (remotePopoverOpen && nodes?.remotePopover) {
      renderRemotePopoverContent(nodes.remotePopover);
      positionRemotePopover();
    }
    try {
      const res = await postToLiveHost('/remote-tunnel', payload);
      if (res && res.ok && res.data) {
        remotePairState.data = res.data;
        const chs = Array.isArray(res.data.channels) ? res.data.channels : [];
        const tch = chs.find((c) => c.key === 'tunnel');
        const hasErr = Boolean(tch?.error || tch?.state === 'error');
        if (payload.tunnelMode === 'named') {
          if (!hasErr) {
            remotePairState.tunnelConfigOpen = false;
            remotePairState.draftHost = null;
            remotePairState.draftToken = '';
          } else {
            remotePairState.tunnelConfigOpen = true;
          }
        } else if (payload.tunnelMode === 'quick') {
          if (!hasErr) {
            remotePairState.tunnelConfigOpen = false;
            remotePairState.draftHost = null;
            remotePairState.draftToken = '';
          }
        }
        const toggledNonTunnel = payload.enabledChannels && typeof payload.enabledChannels === 'object'
          ? Object.entries(payload.enabledChannels).find(([k]) => k !== 'tunnel')
          : null;
        if (toggledNonTunnel) {
          const [chKey, chOn] = toggledNonTunnel;
          const chMeta = chs.find((c) => c.key === chKey);
          const chLabel = chMeta ? tr(chMeta.label || chKey, chMeta.labelEn || chKey) : chKey;
          showQuickToast(chOn
            ? tr(`✅ 已启用 ${chLabel}（后端允许调用）`, `✅ Enabled ${chLabel}`)
            : tr(`🚫 已停用 ${chLabel}（后端拒绝该方式调用）`, `🚫 Disabled ${chLabel}`));
        } else if (payload.tunnelMode === 'quick' && tch?.available) {
          showQuickToast(tr('☁️ 已切换至免登录临时隧道，4G/5G 可直接扫码', '☁️ Switched to Quick Tunnel'));
        } else if (tch?.available) {
          showQuickToast(tr('☁️ Cloudflare 隧道已就绪，4G/5G 可直接扫码', '☁️ Cloudflare Tunnel ready for any network'));
        } else if (payload.enabled === false || payload.enabledChannels?.tunnel === false) {
          showQuickToast(tr('⭕ Cloudflare 隧道已停用（后端已阻断）', '⭕ Cloudflare Tunnel disabled'));
        } else if (tch?.state === 'starting') {
          showQuickToast(tr('⏳ 公网隧道正在分配中，请稍候数秒…', '⏳ Provisioning Cloudflare Tunnel…'));
        } else if (tch?.error) {
          showQuickToast(tch.error);
        }
      } else {
        remotePairState.error = res?.error || tr('更新远程通道配置失败', 'Failed to update remote channels');
        if (payload.tunnelMode === 'named') remotePairState.tunnelConfigOpen = true;
      }
    } catch (err) {
      remotePairState.error = err?.message || tr('配置 Cloudflare 隧道失败', 'Failed to configure Cloudflare Tunnel');
      if (payload.tunnelMode === 'named') remotePairState.tunnelConfigOpen = true;
    } finally {
      remotePairState.tunnelBusy = false;
      remotePairState.tunnelPendingAction = '';
      updateRemoteBtnLanguage({ skipRender: true });
      const curNodes = ensureQuotaStylesAndNodes();
      if (remotePopoverOpen && curNodes?.remotePopover) {
        renderRemotePopoverContent(curNodes.remotePopover);
        positionRemotePopover();
      }
      scheduleTunnelStartingPoll();
    }
    return remotePairState;
  }

  function renderRemotePopoverContent(popover) {
    if (!popover) return;
    const ep = resolveRemoteEndpoint(remotePairState.data);
    const copiedRecent = Date.now() - remotePairState.copiedAt < 2000;
    const pairedDevices = Array.isArray(remotePairState.data?.pairedDevices) ? remotePairState.data.pairedDevices : [];
    const pairedCount = Math.max(pairedDevices.length, Number(remotePairState.data?.pairedCount || 0));
    const onlineCount = Math.max(0, Number(remotePairState.data?.onlineCount || 0));
    const busyAny = remotePairState.loading || remotePairState.tunnelBusy;
    let bodyHtml = '';

    if (remotePairState.loading && !remotePairState.data) {
      bodyHtml = `<div class="ag-rp-status">${escapeHtml(tr('⏳ 正在生成融合配对二维码…', '⏳ Generating unified pairing QR…'))}</div>`;
    } else if (!remotePairState.data) {
      bodyHtml = `<div class="ag-rp-status" style="color:#f87171">${escapeHtml(remotePairState.error || tr('未能连接到本地远程桥接服务', 'Failed to connect to local remote bridge'))}</div>`;
    } else {
      const safeQr = (ep.activeQr && ep.activeQr.startsWith('<svg') && !/<script/i.test(ep.activeQr))
        ? ep.activeQr
        : '';
      const tunnelCh = ep.channels.find((c) => c.key === 'tunnel') || null;
      const enabledChannels = ep.channels.filter((ch) => (
        ch.key === 'tunnel'
          ? Boolean(ch.enabled || ch.state === 'running' || ch.state === 'starting')
          : (ch.enabled !== false)
      ));
      const activeSummaryHtml = enabledChannels.length > 0
        ? `<div class="ag-rp-readonly-summary">${enabledChannels.map((ch) => {
            const label = tr(ch.label || ch.key, ch.labelEn || ch.label || ch.key);
            const hostVal = (ch.key === 'tunnel' && !ch.available && ch.state === 'starting')
              ? (ch.displayHost || tr('正在分配公网隧道…', 'Provisioning Tunnel…'))
              : (ch.displayHost || (ch.available ? '' : tr('未连接', 'Offline')));
            return `<span class="ag-rp-ch-pill" data-active="${ep.activeKey === ch.key ? 'true' : 'false'}"><span>${escapeHtml(label)}</span>${hostVal ? `<span class="ag-rp-ch-pill-host">${escapeHtml(hostVal)}</span>` : ''}</span>`;
          }).join('')}</div>`
        : '';

      const errHtml = (tunnelCh?.error || remotePairState.error)
        ? `<div class="ag-rp-err">${escapeHtml(tunnelCh?.error || remotePairState.error)}</div>`
        : '';

      const statusText = pairedCount > 0
        ? tr(`已关联 ${pairedCount} 台设备（${onlineCount} 台在线）`, `${pairedCount} paired (${onlineCount} online)`)
        : (ep.activeKey === 'tunnel'
            ? tr('口令保护 · 已启用公网 HTTPS 隧道 · 暂未关联设备', 'Token protected · Public HTTPS tunnel · No paired devices yet')
            : tr('内网口令保护 · 暂未关联设备', 'Token protected · No paired devices yet'));
      const devicesHtml = pairedDevices.length > 0
        ? `<div class="ag-rp-devices">${pairedDevices.slice(0, 6).map((d) => {
            const devLabel = escapeHtml(d?.label || tr('移动设备', 'Mobile'));
            const devCh = escapeHtml(formatRemoteDeviceChannel(d?.channel));
            const devTime = escapeHtml(formatRemoteDeviceTime(d));
            return `<span class="ag-rp-dev-chip" data-online="${d?.online ? 'true' : 'false'}"><span class="ag-rp-dev-dot"></span><span>${devLabel} (${devCh} · ${devTime})</span></span>`;
          }).join('')}${pairedDevices.length > 6 ? `<span class="ag-rp-dev-chip">+${pairedDevices.length - 6}</span>` : ''}</div>`
        : '';

      const qrOrEmptyHtml = safeQr
        ? `<div class="ag-rp-qr">${safeQr}</div>`
        : `<div class="ag-rp-status">${escapeHtml(tr('未启用任何连接方式，请在统一设置中开启', 'No active channels — enable one in Suite Settings'))}</div>`;

      bodyHtml = `
        ${qrOrEmptyHtml}
        ${activeSummaryHtml}
        ${errHtml}
        <div class="ag-rp-sec" data-active="${onlineCount > 0 ? 'true' : 'false'}">${LOCK_SHIELD_SVG}<span>${escapeHtml(statusText)}</span></div>
        ${devicesHtml}
        <div class="ag-rp-actions">
          <button id="ag-remote-copy" class="ag-rp-btn" data-primary="true" type="button" ${ep.activeUrl ? '' : 'disabled'}>${escapeHtml(copiedRecent ? tr('已复制链接', 'Copied') : tr('复制链接', 'Copy Link'))}</button>
        </div>
        <div class="ag-rp-tip">${escapeHtml(tr('通道、隧道与重置密钥请在顶栏设置面板的「远程设置」中管理。', 'Manage channels, tunnel, and token reset in Suite Settings → Remote.'))}</div>
      `;
    }

    popover.innerHTML = `
      <div class="ag-qp-header">
        <span class="ag-qp-title">${escapeHtml(tr('手机远程操作配对', 'Mobile Remote Pairing'))}</span>
        <button id="ag-remote-refresh" class="ag-qp-refresh" type="button">${escapeHtml(busyAny ? tr('处理中…', 'Working…') : tr('↻ 刷新', '↻ Refresh'))}</button>
      </div>
      ${bodyHtml}
    `;

    popover.querySelector('#ag-remote-refresh')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void refreshRemotePairInfo(false);
    });
    popover.querySelector('#ag-remote-copy')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const url = ep?.activeUrl;
      if (!url) return;
      const ok = await copyToClipboard(url);
      if (ok) {
        remotePairState.copiedAt = Date.now();
        renderRemotePopoverContent(popover);
        setTimeout(() => {
          if (remotePopoverOpen) renderRemotePopoverContent(popover);
        }, 2100);
      }
    });
  }

  async function refreshRemotePairInfo(resetToken = false) {
    if (disposed || remotePairState.loading) return remotePairState;
    remotePairState.loading = true;
    remotePairState.error = '';
    const nodes = ensureQuotaStylesAndNodes();
    if (remotePopoverOpen && nodes?.remotePopover) {
      renderRemotePopoverContent(nodes.remotePopover);
      positionRemotePopover();
    }
    try {
      const res = await postToLiveHost('/remote-info', { resetToken: Boolean(resetToken) });
      if (res && res.disabled) {
        remotePairState.data = null;
        remotePairState.error = tr(
          '当前已通过 --no-remote / AG_DISABLE_MOBILE_REMOTE=1 禁用手机远程监听',
          'Mobile remote server disabled via --no-remote / AG_DISABLE_MOBILE_REMOTE=1'
        );
      } else if (res && res.ok && res.data) {
        remotePairState.data = res.data;
        if (resetToken) showQuickToast(tr('已生成新配对密钥，旧链接已失效', 'New pair token generated; old links revoked'));
      } else {
        remotePairState.error = tr('请确认 Antigravity 桥接服务正在运行', 'Ensure Antigravity local bridge service is running');
      }
    } catch (err) {
      remotePairState.error = err?.message || tr('获取配对二维码失败', 'Failed to fetch pairing QR code');
    } finally {
      remotePairState.loading = false;
      updateRemoteBtnLanguage({ skipRender: true });
      const curNodes = ensureQuotaStylesAndNodes();
      if (remotePopoverOpen && curNodes?.remotePopover) {
        renderRemotePopoverContent(curNodes.remotePopover);
        positionRemotePopover();
      }
      scheduleTunnelStartingPoll();
    }
    return remotePairState;
  }

  function clearRemotePollTimer() {
    if (remotePollTimer) {
      clearInterval(remotePollTimer);
      remotePollTimer = null;
    }
  }

  function toggleRemotePopover(forceOpen) {
    const nodes = ensureQuotaStylesAndNodes();
    if (!nodes || !nodes.remotePopover) return;
    const isActuallyOpen = remotePopoverOpen && !nodes.remotePopover.hidden;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !isActuallyOpen;
    remotePopoverOpen = nextOpen;
    nodes.remotePopover.hidden = !nextOpen;
    nodes.remoteBtn?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    clearRemotePollTimer();

    if (nextOpen) {
      if (popoverOpen) {
        popoverOpen = false;
        nodes.popover.hidden = true;
        nodes.quotaBtn?.setAttribute('aria-expanded', 'false');
      }
      try {
        const pCtx = nodes.sr.getElementById('panel');
        const pTok = nodes.sr.getElementById('panel-tokens');
        const pSet = nodes.sr.getElementById('panel-settings');
        if (pCtx && !pCtx.hidden) pCtx.hidden = true;
        if (pTok && !pTok.hidden) pTok.hidden = true;
        if (pSet && !pSet.hidden) pSet.hidden = true;
        nodes.sr.getElementById('badge')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-speed')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-tokens')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-settings')?.setAttribute('aria-expanded', 'false');
      } catch {}
      renderRemotePopoverContent(nodes.remotePopover);
      positionRemotePopover();
      try { (globalThis.__AGContextMeter || window.__AGContextMeter)?.setHostElevated?.(true); } catch {}
      void refreshRemotePairInfo(false);
      remotePollTimer = setInterval(() => {
        if (!disposed && remotePopoverOpen && !remotePairState.loading && !remotePairState.tunnelBusy && !remotePairState.tunnelConfigOpen) {
          void refreshRemotePairInfo(false);
        }
      }, 4000);
    } else {
      remotePairState.tunnelConfigOpen = false;
      remotePairState.draftHost = null;
      remotePairState.draftToken = '';
      if (remotePairState.tunnelPollTimer) {
        clearTimeout(remotePairState.tunnelPollTimer);
        remotePairState.tunnelPollTimer = null;
      }
      try { (globalThis.__AGContextMeter || window.__AGContextMeter)?.setHostElevated?.(Boolean(popoverOpen || remotePopoverOpen)); } catch {}
    }
  }

  function onRemoteBtnClick(e) {
    e.stopPropagation();
    toggleRemotePopover();
  }

  function toggleQuotaPopover(forceOpen) {
    const nodes = ensureQuotaStylesAndNodes();
    if (!nodes) return;
    const isActuallyOpen = popoverOpen && !nodes.popover.hidden;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !isActuallyOpen;
    popoverOpen = nextOpen;
    nodes.popover.hidden = !nextOpen;
    nodes.quotaBtn?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');

    if (nextOpen) {
      if (remotePopoverOpen && nodes.remotePopover) {
        clearRemotePollTimer();
        if (remotePairState.tunnelPollTimer) {
          clearTimeout(remotePairState.tunnelPollTimer);
          remotePairState.tunnelPollTimer = null;
        }
        remotePopoverOpen = false;
        remotePairState.tunnelConfigOpen = false;
        remotePairState.draftHost = null;
        remotePairState.draftToken = '';
        nodes.remotePopover.hidden = true;
        nodes.remoteBtn?.setAttribute('aria-expanded', 'false');
      }
      // 避免与原有上下文面板重叠
      try {
        const pCtx = nodes.sr.getElementById('panel');
        const pTok = nodes.sr.getElementById('panel-tokens');
        const pSet = nodes.sr.getElementById('panel-settings');
        if (pCtx && !pCtx.hidden) pCtx.hidden = true;
        if (pTok && !pTok.hidden) pTok.hidden = true;
        if (pSet && !pSet.hidden) pSet.hidden = true;
        nodes.sr.getElementById('badge')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-speed')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-tokens')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-settings')?.setAttribute('aria-expanded', 'false');
      } catch {}
      renderQuotaPopoverContent(nodes.popover);
      positionQuotaPopover();
      try { (globalThis.__AGContextMeter || window.__AGContextMeter)?.setHostElevated?.(true); } catch {}
      void refreshQuota();
    } else {
      if (remotePairState.tunnelPollTimer) {
        clearTimeout(remotePairState.tunnelPollTimer);
        remotePairState.tunnelPollTimer = null;
      }
      try { (globalThis.__AGContextMeter || window.__AGContextMeter)?.setHostElevated?.(Boolean(popoverOpen || remotePopoverOpen)); } catch {}
    }
  }

  function onQuotaBtnClick(e) {
    e.stopPropagation();
    toggleQuotaPopover();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderQuotaPopoverContent(popover) {
    if (!popover) return;
    const g = quotaState.gemini;
    const c = quotaState.claude;
    const activeKey = quotaState.activePoolKey;
    const modelName = quotaState.activeModelText || tr('未检测到模型', 'No model detected');

    const renderWindowRow = (label, bucket) => {
      if (!bucket) return '';
      const bFrac = bucket.remainingFraction;
      const bPctInt = typeof bFrac === 'number' ? Math.max(0, Math.min(100, bFrac * 100)) : 0;
      const bColor = getQuotaColor(bFrac);
      const bPctText = formatPctOne(bFrac);
      const bResetText = bucket.resetTime ? formatResetCountdownZh(bucket.resetTime) : tr('暂无重置时间信息', 'Reset time unknown');
      return `
        <div class="ag-qp-subrow">
          <div class="ag-qp-subhead">
            <span class="ag-qp-sublabel">${escapeHtml(label)}</span>
            <span class="ag-qp-subpct" style="color:${bColor}">${escapeHtml(bPctText)}</span>
          </div>
          <div class="ag-qp-bar">
            <div class="ag-qp-bar-fill" style="width:${bPctInt.toFixed(1)}%;background:${bColor}"></div>
          </div>
          <div class="ag-qp-reset">${escapeHtml(bResetText)}</div>
        </div>
      `;
    };

    const renderPoolCard = (title, pool, isActive) => {
      const frac = pool?.remainingFraction;
      const pctInt = typeof frac === 'number' ? Math.max(0, Math.min(100, frac * 100)) : 0;
      const color = getQuotaColor(frac);
      const pctText = formatPctOne(frac);
      const resetText = pool?.resetTime ? formatResetCountdownZh(pool.resetTime) : tr('暂无重置时间信息', 'Reset time unknown');
      const hasDualWindows = Boolean(pool?.fiveHour || pool?.weekly);
      const bodyHtml = hasDualWindows
        ? `
          <div class="ag-qp-subrows">
            ${pool?.fiveHour ? renderWindowRow(tr('5 小时限额', '5h Limit'), pool.fiveHour) : ''}
            ${pool?.weekly ? renderWindowRow(tr('每周限额', 'Weekly Limit'), pool.weekly) : ''}
          </div>
        `
        : `
          <div class="ag-qp-bar">
            <div class="ag-qp-bar-fill" style="width:${pctInt.toFixed(1)}%;background:${color}"></div>
          </div>
          <div class="ag-qp-reset">${escapeHtml(resetText)}</div>
        `;
      return `
        <div class="ag-qp-card${isActive ? ' is-active' : ''}">
          <div class="ag-qp-row">
            <span class="ag-qp-pool-name">
              <span>${escapeHtml(title)}</span>
              ${isActive ? `<span class="ag-qp-active-tag">${tr('当前', 'Active')}</span>` : ''}
            </span>
            <span class="ag-qp-pct" style="color:${color}">${escapeHtml(hasDualWindows ? `${tr('最紧', 'Min')} ${pctText}` : pctText)}</span>
          </div>
          ${bodyHtml}
        </div>
      `;
    };

    function resolvePopoverPlanPools() {
      const histPlan = window.__AGContextMeterHistory?.planStatus || {};
      const liveSettings = window.__AGContextMeter?.getPlanSettings?.() || {};
      const mergedPlan = {
        tierKey: histPlan.tierKey || (liveSettings.ultraSubTier ? 'ultra' : ''),
        tierName: (liveSettings.tierName && liveSettings.tierName !== '未知') ? liveSettings.tierName : (histPlan.tierName || ''),
        ultraSubTier: liveSettings.ultraSubTier || histPlan.ultraSubTier || null,
        ultraSubTierSpec: histPlan.ultraSubTierSpec || null,
        promptCredits: quotaState.promptCredits || histPlan.promptCredits || null,
        flowCredits: quotaState.flowCredits || histPlan.flowCredits || null
      };
      const coreRef = (typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null) || window.__AGContextMeterCore;
      if (coreRef && typeof coreRef.resolvePlanQuotaPools === 'function') {
        return coreRef.resolvePlanQuotaPools(mergedPlan);
      }
      const tk = String(mergedPlan.tierKey || '').toLowerCase();
      const st = String(mergedPlan.ultraSubTier || '').toLowerCase();
      if (tk === 'ultra' && st === '20x') {
        return { subGroupLabel: 'Google AI Ultra · 20x 子组', promptPoolText: '20× Pro 配额（5h 滚动窗口 + 周限额）', flowPoolText: '25,000 套餐月积分 / 月' };
      }
      if (tk === 'ultra' && st === '5x') {
        return { subGroupLabel: 'Google AI Ultra · 5x 子组', promptPoolText: '5× Pro 配额（5h 滚动窗口 + 周限额）', flowPoolText: '10,000 套餐月积分 / 月' };
      }
      if (tk === 'ultra') {
        return { subGroupLabel: 'Google AI Ultra · 待选子档', promptPoolText: '5× ~ 20× Pro 配额（请选 5x / 20x）', flowPoolText: '10,000 ~ 25,000 套餐月积分 / 月' };
      }
      if (tk === 'pro') {
        return { subGroupLabel: 'Google AI Pro · 1x 标准组', promptPoolText: '1× Pro 基准配额（5h 滚动窗口 + 周限额）', flowPoolText: '1,000 套餐月积分 / 月' };
      }
      if (tk === 'plus') {
        return { subGroupLabel: 'Google AI Plus · 基础组', promptPoolText: 'Plus 基础配额', flowPoolText: '200 套餐月积分 / 月' };
      }
      if (tk === 'free') {
        return { subGroupLabel: 'Google AI Free · 免费组', promptPoolText: '免费基础配额', flowPoolText: '100 体验积分 / 月' };
      }
      return null;
    }

    const qpd = resolvePopoverPlanPools();
    const creditsRows = [];
    if (qpd) {
      creditsRows.push(`
        <div class="ag-qp-credit-row">
          <span>${tr('当前套餐子组', 'Plan Subgroup')}</span>
          <strong>${escapeHtml(qpd.subGroupLabel)}</strong>
        </div>
        <div class="ag-qp-credit-row">
          <span>${tr('Prompt 额度池', 'Prompt Pool')}</span>
          <strong>${escapeHtml(qpd.promptPoolText)}</strong>
        </div>
        <div class="ag-qp-credit-row">
          <span>${tr('Flow 额度池', 'Flow Pool')}</span>
          <strong>${escapeHtml(qpd.flowPoolText)}</strong>
        </div>
      `);
    } else {
      if (quotaState.promptCredits) {
        const pc = quotaState.promptCredits;
        creditsRows.push(`
          <div class="ag-qp-credit-row">
            <span>${tr('Prompt 额度池', 'Prompt Pool')}</span>
            <strong>${pc.available}${pc.monthly ? ` / ${pc.monthly}` : ''}</strong>
          </div>
        `);
      }
      if (quotaState.flowCredits) {
        const fc = quotaState.flowCredits;
        creditsRows.push(`
          <div class="ag-qp-credit-row">
            <span>${tr('Flow 额度池', 'Flow Pool')}</span>
            <strong>${fc.available}${fc.monthly ? ` / ${fc.monthly}` : ''}</strong>
          </div>
        `);
      }
    }

    const subGroups = Array.isArray(quotaState.subGroups) ? quotaState.subGroups : [];
    const modelLower = String(modelName || '').toLowerCase();
    const poolCardsHtml = subGroups.length > 0
      ? subGroups.map((sg) => {
          const dispLower = String(sg.displayName || '').toLowerCase();
          const isMatch = (dispLower.includes('flash') && modelLower.includes('flash'))
            || (dispLower.includes('pro') && (modelLower.includes('pro') || modelLower.includes('argon') || modelLower.includes('gemini 4')))
            || (sg.poolKey === activeKey && !subGroups.some((o) => o !== sg && o.poolKey === sg.poolKey));
          return renderPoolCard(sg.displayName, sg, isMatch);
        }).join('')
      : `${renderPoolCard(tr('Gemini 4 / 3.8 配额池', 'Gemini 4 / 3.8 Pool'), g, activeKey === 'gemini')}${renderPoolCard(tr('Claude 5.5 / GPT 配额池', 'Claude 5.5 / GPT Pool'), c, activeKey === 'claude')}`;

    const updatedStr = quotaState.lastFetchedAt
      ? `${tr('上次刷新：', 'Updated: ')}${new Date(quotaState.lastFetchedAt).toLocaleTimeString(uiLang === 'en' ? 'en-US' : 'zh-CN', { hour12: false })}`
      : (quotaState.error || tr('等待数据…', 'Waiting for data…'));

    popover.innerHTML = `
      <div class="ag-qp-header">
        <span class="ag-qp-title">${tr('模型剩余配额实时看板', 'Model Quota Live')}</span>
        <button id="ag-quota-refresh" class="ag-qp-refresh" type="button">${quotaState.loading ? tr('刷新中…', 'Refreshing…') : tr('↻ 刷新', '↻ Refresh')}</button>
      </div>
      <div class="ag-qp-model">
        <span>${tr('当前选中模型', 'Active Model')}</span>
        <strong>${escapeHtml(modelName)}</strong>
      </div>
      ${poolCardsHtml}
      <div class="ag-qp-footer">
        ${creditsRows.join('')}
        <div>${escapeHtml(updatedStr)}</div>
      </div>
    `;

    const refreshBtn = popover.querySelector('#ag-quota-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void refreshQuota();
      });
    }
  }

  function renderQuotaUI() {
    if (disposed) return;
    const nodes = ensureQuotaStylesAndNodes();
    if (!nodes) return;
    const { host, sr, quotaBtn, popover } = nodes;
    if (!quotaBtn) return;

    quotaState.activeModelText = detectCurrentModelText();
    quotaState.activePoolKey = classifyModelPoolKey(quotaState.activeModelText);

    const gFrac = quotaState.gemini?.remainingFraction;
    const cFrac = quotaState.claude?.remainingFraction;
    const activeFrac = quotaState.activePoolKey === 'claude' ? cFrac : gFrac;
    const dotColor = getQuotaColor(activeFrac);

    const dotEl = sr.getElementById('ag-quota-dot');
    const textEl = sr.getElementById('ag-quota-text');
    if (dotEl) {
      dotEl.style.background = dotColor;
      dotEl.style.boxShadow = '';
    }

    const layoutMode = host.getAttribute('data-layout') || 'wide';
    const gStr = formatPctInt(gFrac);
    const cStr = formatPctInt(cFrac);
    let badgeText = '';
    if (layoutMode === 'wide') {
      badgeText = quotaState.activePoolKey === 'claude'
        ? `C ${cStr} · G4 ${gStr}`
        : `G4 ${gStr} · C ${cStr}`;
    } else {
      badgeText = `${tr('配额', 'Quota')} ${formatPctInt(activeFrac)}`;
    }
    if (textEl && textEl.textContent !== badgeText) {
      textEl.textContent = badgeText;
    }

    const formatPoolTooltip = (label, pool, fallbackFrac) => {
      const hasDual = Boolean(pool?.fiveHour || pool?.weekly);
      if (hasDual) {
        const s5 = pool?.fiveHour ? `5h ${formatPctOne(pool.fiveHour.remainingFraction)}` : '';
        const sw = pool?.weekly ? `${tr('周', 'Wk')} ${formatPctOne(pool.weekly.remainingFraction)}` : '';
        const detail = [s5, sw].filter(Boolean).join(' · ');
        const tightReset = pool?.resetTime ? formatResetCountdownZh(pool.resetTime) : tr('未知', 'Unknown');
        return `${label}: ${detail}（${tightReset}）`;
      }
      const tip = pool?.resetTime ? formatResetCountdownZh(pool.resetTime) : tr('未知', 'Unknown');
      return `${label}: ${formatPctOne(fallbackFrac)} (${tip})`;
    };
    quotaBtn.title = `${formatPoolTooltip('Gemini 4/3.8', quotaState.gemini, gFrac)}\n${formatPoolTooltip('Claude/GPT', quotaState.claude, cFrac)}\n${tr('点击查看完整配额面板', 'Click to view full quota details')}`;

    if (popoverOpen && popover && !popover.hidden) {
      renderQuotaPopoverContent(popover);
      positionQuotaPopover();
    }
  }

  // ==================== 输入框快捷胶囊栏 ====================

  function ensureDocStyle() {
    if (!document.head) return;
    let styleEl = document.getElementById(DOC_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = DOC_STYLE_ID;
      styleEl.textContent = `
        #${QUICK_BAR_ID} {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
          padding: 0 2px 6px 2px;
          width: 100%;
          box-sizing: border-box;
          user-select: none;
          -webkit-user-select: none;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 26px;
          padding: 0 9px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(244, 244, 245, 0.88);
          transition: background-color 0.14s ease, border-color 0.14s ease;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn:hover {
          background: rgba(255, 255, 255, 0.13);
          border-color: rgba(255, 255, 255, 0.24);
          color: #ffffff;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn:active {
          opacity: 0.85;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-effective-accent, #a78bfa);
        }
        #${QUICK_BAR_ID} .ag-qcap-btn[data-active="true"]:hover {
          background: var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24));
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
          color: var(--ag-effective-accent, #a78bfa);
        }
        #${QUICK_BAR_ID} .ag-qcap-btn[data-risk="warn"] {
          border-color: rgba(245, 158, 11, 0.55);
          background: rgba(245, 158, 11, 0.14);
          color: #fbbf24;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn[data-risk="danger"] {
          border-color: rgba(239, 68, 68, 0.65);
          background: rgba(239, 68, 68, 0.16);
          color: #f87171;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn {
          border-color: rgba(0, 0, 0, 0.11);
          background: rgba(0, 0, 0, 0.045);
          color: rgba(24, 24, 27, 0.86);
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn:hover {
          background: rgba(0, 0, 0, 0.09);
          border-color: rgba(0, 0, 0, 0.2);
          color: #09090b;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn[data-active="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn[data-active="true"]:hover {
          background: var(--ag-accent-bg-hover, rgba(124, 58, 237, 0.18));
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn[data-risk="warn"] {
          border-color: rgba(217, 119, 6, 0.55);
          background: rgba(245, 158, 11, 0.12);
          color: #b45309;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn[data-risk="danger"] {
          border-color: rgba(220, 38, 38, 0.6);
          background: rgba(239, 68, 68, 0.12);
          color: #dc2626;
        }
        #${QUICK_BAR_ID} .ag-qcap-right-slot {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          min-width: 0;
          max-width: 100%;
          flex: 0 1 auto;
        }
        #${QUICK_BAR_ID} .ag-qcap-right-slot[data-toast-active="true"] #${NEXT_STEP_GHOST_ID} {
          display: none !important;
        }
        #${QUICK_BAR_ID} .ag-qcap-toast {
          display: none;
          font-size: 12px;
          color: var(--ag-effective-accent, #a78bfa);
          opacity: 0;
          transition: opacity 0.18s ease;
          pointer-events: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: min(520px, 60vw);
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-toast {
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${QUICK_BAR_ID} .ag-qcap-toast[data-tone="error"] {
          color: #f87171;
          pointer-events: auto;
          user-select: text;
          cursor: text;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-toast[data-tone="error"] {
          color: #dc2626;
        }
        #${QUICK_BAR_ID} .ag-qcap-toast[data-visible="true"] {
          display: inline-block;
          opacity: 1;
        }
        [data-ag-risk-card="high"] {
          border: 1.5px solid rgba(239, 68, 68, 0.78) !important;
          background: rgba(239, 68, 68, 0.06) !important;
          border-radius: 8px !important;
        }
        .ag-risk-banner {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          margin-bottom: 6px;
          border-radius: 6px;
          background: rgba(239, 68, 68, 0.16);
          border: 1px solid rgba(239, 68, 68, 0.45);
          color: #fca5a5;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.35;
        }
        .ag-risk-banner[data-ag-theme="light"] {
          background: rgba(220, 38, 38, 0.1);
          border-color: rgba(220, 38, 38, 0.4);
          color: #b91c1c;
        }
        #${CHAT_NAV_ID} {
          position: fixed;
          z-index: 8;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 2px;
          padding: 4px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(18, 18, 22, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
          opacity: 0.84;
          transition: opacity 0.15s ease, border-color 0.15s ease;
        }
        #${CHAT_NAV_ID}:hover {
          opacity: 1;
          border-color: rgba(255, 255, 255, 0.13);
        }
        #${CHAT_NAV_ID}[hidden] {
          display: none !important;
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] {
          border-color: rgba(0, 0, 0, 0.08);
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.04);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"]:hover {
          border-color: rgba(0, 0, 0, 0.13);
        }
        #${CHAT_NAV_ID} .ag-nav-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          width: 28px;
          height: 28px;
          padding: 0;
          border-radius: 6px;
          border: none;
          outline: none;
          box-shadow: none;
          background: transparent;
          color: rgba(228, 228, 231, 0.82);
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          transition: background-color 0.12s ease, color 0.12s ease;
        }
        #${CHAT_NAV_ID}:hover .ag-nav-btn {
          width: auto;
          padding: 0 8px;
          justify-content: flex-start;
        }
        #${CHAT_NAV_ID} .ag-nav-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 15px;
          height: 15px;
          flex-shrink: 0;
          color: rgba(161, 161, 170, 0.92);
          transition: color 0.12s ease;
        }
        #${CHAT_NAV_ID} .ag-nav-svg {
          width: 14px;
          height: 14px;
          display: block;
          flex-shrink: 0;
        }
        #${CHAT_NAV_ID} .ag-nav-label {
          display: none;
        }
        #${CHAT_NAV_ID}:hover .ag-nav-label {
          display: inline;
        }
        #${CHAT_NAV_ID} .ag-nav-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #fafafa;
        }
        #${CHAT_NAV_ID} .ag-nav-btn:hover .ag-nav-icon {
          color: #fafafa;
        }
        #${CHAT_NAV_ID} .ag-nav-btn:active {
          background: rgba(255, 255, 255, 0.13);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn {
          background: transparent;
          color: rgba(39, 39, 42, 0.86);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-icon {
          color: rgba(113, 113, 122, 0.95);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn:hover {
          background: rgba(0, 0, 0, 0.06);
          color: #09090b;
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn:hover .ag-nav-icon {
          color: #09090b;
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn:active {
          background: rgba(0, 0, 0, 0.1);
        }
        #${FILE_EDITOR_CONTROLS_ID} {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-right: 4px;
          app-region: no-drag;
          -webkit-app-region: no-drag;
        }
        #${FILE_EDITOR_CONTROLS_ID} .ag-fedit-btn {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          height: 26px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.07);
          color: rgba(244, 244, 245, 0.92);
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease;
        }
        #${FILE_EDITOR_CONTROLS_ID} .ag-fedit-btn:hover {
          background: rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.28);
          color: #ffffff;
        }
        #${FILE_EDITOR_CONTROLS_ID} .ag-fedit-btn[data-primary="true"] {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-effective-accent, #a78bfa);
        }
        #${FILE_EDITOR_CONTROLS_ID} .ag-fedit-btn[data-primary="true"]:hover {
          background: var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24));
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
        }
        #${FILE_EDITOR_CONTROLS_ID}[data-ag-theme="light"] .ag-fedit-btn {
          border-color: rgba(0, 0, 0, 0.12);
          background: rgba(0, 0, 0, 0.05);
          color: rgba(24, 24, 27, 0.9);
        }
        #${FILE_EDITOR_CONTROLS_ID}[data-ag-theme="light"] .ag-fedit-btn:hover {
          background: rgba(0, 0, 0, 0.1);
          color: #09090b;
        }
        #${FILE_EDITOR_CONTROLS_ID}[data-ag-theme="light"] .ag-fedit-btn[data-primary="true"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${FILE_EDITOR_CONTROLS_ID}[data-ag-theme="light"] .ag-fedit-btn[data-primary="true"]:hover {
          background: var(--ag-accent-bg-hover, rgba(124, 58, 237, 0.18));
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
        }
        [data-ag-editor-host="1"] {
          display: flex !important;
          flex-direction: column !important;
          height: 100% !important;
          min-height: 0 !important;
        }
        #${FILE_EDITOR_WRAP_ID} {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          width: 100%;
          height: 100%;
          min-height: 0;
          background: rgba(24, 24, 27, 0.96);
          color: #e4e4e7;
        }
        #${FILE_EDITOR_WRAP_ID}[data-ag-theme="light"] {
          background: #ffffff;
          color: #18181b;
        }
        #${FILE_EDITOR_WRAP_ID} .ag-fedit-statusbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 6px 12px;
          font-size: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
          background: rgba(255, 255, 255, 0.03);
          color: #a1a1aa;
          flex-shrink: 0;
        }
        #${FILE_EDITOR_WRAP_ID}[data-ag-theme="light"] .ag-fedit-statusbar {
          border-bottom-color: rgba(0, 0, 0, 0.08);
          background: rgba(0, 0, 0, 0.025);
          color: #52525b;
        }
        #${FILE_EDITOR_WRAP_ID} #ag-inline-file-textarea {
          flex: 1 1 auto;
          width: 100%;
          min-height: 0;
          padding: 14px 16px;
          border: none;
          outline: none;
          resize: none;
          box-sizing: border-box;
          background: transparent;
          color: inherit;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 13px;
          line-height: 1.65;
          tab-size: 2;
        }
        html[data-ag-cmd-down="1"] a[href^="http://"],
        html[data-ag-cmd-down="1"] a[href^="https://"],
        html[data-ag-cmd-down="1"] a[href^="mailto:"],
        html[data-ag-cmd-down="1"] code {
          cursor: pointer !important;
        }
        html[data-ag-cmd-down="1"] a[href^="http://"]:hover,
        html[data-ag-cmd-down="1"] a[href^="https://"]:hover {
          text-decoration: underline !important;
        }
        [data-testid="conversation-row-sidebar"][data-ag-shortcut] {
          position: relative !important;
        }
        html[data-ag-cmd-down="1"] [data-testid="conversation-row-sidebar"][data-ag-shortcut]::after {
          content: attr(data-ag-shortcut);
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          padding: 1px 5px;
          border-radius: 4px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          font-weight: 600;
          line-height: 15px;
          letter-spacing: 0.2px;
          color: #e4e4e7;
          background: rgba(24, 24, 27, 0.88);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
          pointer-events: none;
          z-index: 6;
        }
        html.light[data-ag-cmd-down="1"] [data-testid="conversation-row-sidebar"][data-ag-shortcut]::after,
        html[data-theme="light"][data-ag-cmd-down="1"] [data-testid="conversation-row-sidebar"][data-ag-shortcut]::after {
          color: #18181b;
          background: rgba(255, 255, 255, 0.94);
          border-color: rgba(24, 24, 27, 0.16);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }
        @keyframes ag-enh-spin {
          to { transform: rotate(360deg); }
        }
        #${NEXT_STEP_GHOST_ID} {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 5px;
          min-width: 0;
          max-width: 100%;
        }
        #${NEXT_STEP_GHOST_ID}[hidden] {
          display: none !important;
        }
        #${QUICK_BAR_ID} #${NEXT_STEP_GHOST_ID} .ag-ns-accept {
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-effective-accent, #a78bfa);
          max-width: 100%;
          min-width: 0;
        }
        #${QUICK_BAR_ID} #${NEXT_STEP_GHOST_ID} .ag-ns-accept:hover {
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
          background: var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24));
          color: #ffffff;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] #${NEXT_STEP_GHOST_ID} .ag-ns-accept {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] #${NEXT_STEP_GHOST_ID} .ag-ns-accept:hover {
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
          background: var(--ag-accent-bg-hover, rgba(124, 58, 237, 0.18));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 210px;
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-kbd-tag {
          font-size: 10.5px;
          line-height: 1;
          padding: 2px 5px;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.1);
          color: rgba(228, 228, 231, 0.85);
          flex-shrink: 0;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] #${NEXT_STEP_GHOST_ID} .ag-ns-kbd-tag {
          background: rgba(0, 0, 0, 0.08);
          color: rgba(24, 24, 27, 0.78);
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-cycle[hidden] {
          display: none !important;
        }
        #${NEXT_STEP_TOOLTIP_ID} {
          position: fixed;
          z-index: 2147483645;
          max-width: min(360px, calc(100vw - 24px));
          padding: 6px 10px;
          border-radius: 7px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(24, 24, 27, 0.96);
          color: #f4f4f5;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
          font-size: 12px;
          line-height: 1.45;
          white-space: normal;
          word-break: break-word;
          pointer-events: none;
        }
        #${NEXT_STEP_TOOLTIP_ID}[hidden] {
          display: none !important;
        }
        #${NEXT_STEP_TOOLTIP_ID}[data-ag-theme="light"] {
          border-color: rgba(0, 0, 0, 0.12);
          background: rgba(255, 255, 255, 0.98);
          color: #18181b;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        }
        #${QUICK_BAR_TOOLTIP_ID} {
          position: fixed;
          z-index: 2147483646;
          width: min(380px, calc(100vw - 24px));
          padding: 8px 11px;
          border-radius: 8px;
          border: 1px solid var(--ag-accent-border, rgba(167, 139, 250, 0.38));
          background: rgba(20, 20, 23, 0.97);
          color: #f4f4f5;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
          font-size: 12px;
          line-height: 1.45;
          white-space: normal;
          word-break: break-word;
          pointer-events: none;
        }
        #${QUICK_BAR_TOOLTIP_ID}[hidden] {
          display: none !important;
        }
        #${QUICK_BAR_TOOLTIP_ID}[data-ag-theme="light"] {
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.32));
          background: rgba(255, 255, 255, 0.98);
          color: #18181b;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 3px;
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-title-wrap {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-title {
          font-size: 12px;
          font-weight: 600;
          color: inherit;
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-rec {
          font-size: 11px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 4px;
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          border: 1px solid var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          color: var(--ag-effective-accent, #a78bfa);
          flex-shrink: 0;
        }
        #${QUICK_BAR_TOOLTIP_ID}[data-ag-theme="light"] .ag-qtip-rec {
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-rec[hidden] {
          display: none !important;
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-tag {
          font-size: 11px;
          color: rgba(212, 212, 216, 0.78);
          flex-shrink: 0;
        }
        #${QUICK_BAR_TOOLTIP_ID}[data-ag-theme="light"] .ag-qtip-tag {
          color: rgba(63, 63, 70, 0.75);
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-role {
          font-size: 12px;
          color: inherit;
          line-height: 1.42;
        }
        #${QUICK_BAR_TOOLTIP_ID} .ag-qtip-scene {
          font-size: 11.5px;
          color: rgba(212, 212, 216, 0.78);
          line-height: 1.42;
          margin-top: 2px;
        }
        #${QUICK_BAR_TOOLTIP_ID}[data-ag-theme="light"] .ag-qtip-scene {
          color: rgba(63, 63, 70, 0.78);
        }
        #${PROMPT_OPT_WRAP_ID} {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 5px;
          width: 100%;
          box-sizing: border-box;
          padding: 0 12px 4px 12px;
          margin: 0;
          flex-shrink: 0;
          pointer-events: none;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-opt-btn,
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-undo-btn {
          pointer-events: auto;
          appearance: none;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 24px;
          padding: 0 8px;
          border-radius: 999px;
          font-size: 11.5px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(244, 244, 245, 0.88);
          transition: background-color 0.14s ease, border-color 0.14s ease, opacity 0.14s ease, color 0.14s ease;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-opt-icon {
          display: inline-block;
          flex-shrink: 0;
          color: currentColor;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-opt-spin {
          display: inline-block;
          width: 11px;
          height: 11px;
          border-radius: 999px;
          border: 1.5px solid var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          border-top-color: currentColor;
          animation: ag-enh-spin 0.7s linear infinite;
          flex-shrink: 0;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-opt-btn:hover:not(:disabled),
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-undo-btn:hover:not(:disabled) {
          background: var(--ag-accent-bg-hover, rgba(167, 139, 250, 0.24));
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
          color: #ffffff;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-opt-btn:disabled {
          opacity: 0.42;
          cursor: not-allowed;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-opt-btn[data-loading="true"] {
          border-color: var(--ag-accent-border-hover, rgba(167, 139, 250, 0.56));
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          color: var(--ag-effective-accent, #a78bfa);
          cursor: pointer;
          opacity: 1;
        }
        #${PROMPT_OPT_WRAP_ID} .ag-prompt-undo-btn[hidden] {
          display: none !important;
        }
        #${PROMPT_OPT_WRAP_ID}[data-ag-theme="light"] .ag-prompt-opt-btn,
        #${PROMPT_OPT_WRAP_ID}[data-ag-theme="light"] .ag-prompt-undo-btn {
          border-color: rgba(0, 0, 0, 0.12);
          background: rgba(0, 0, 0, 0.045);
          color: rgba(24, 24, 27, 0.86);
        }
        #${PROMPT_OPT_WRAP_ID}[data-ag-theme="light"] .ag-prompt-opt-btn:hover:not(:disabled),
        #${PROMPT_OPT_WRAP_ID}[data-ag-theme="light"] .ag-prompt-undo-btn:hover:not(:disabled) {
          background: var(--ag-accent-bg-hover, rgba(124, 58, 237, 0.18));
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${PROMPT_OPT_WRAP_ID}[data-ag-theme="light"] .ag-prompt-opt-btn[data-loading="true"] {
          border-color: var(--ag-accent-border-hover, rgba(124, 58, 237, 0.48));
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          color: var(--ag-effective-accent, #7c3aed);
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-kbd:hover {
          background: var(--ag-accent-bg, rgba(167, 139, 250, 0.14));
          border-color: var(--ag-accent-border, rgba(167, 139, 250, 0.34));
          color: #e4e4e7;
        }
        #${NEXT_STEP_GHOST_ID}[data-ag-theme="light"] .ag-ns-kbd:hover {
          background: var(--ag-accent-bg, rgba(124, 58, 237, 0.10));
          border-color: var(--ag-accent-border, rgba(124, 58, 237, 0.28));
          color: #18181b;
        }
      `;
      document.head.appendChild(styleEl);
    }
  }

  function hideQuickToast(expectedTag = '') {
    const bar = document.getElementById(QUICK_BAR_ID);
    const rightSlot = bar?.querySelector(`#${QUICK_RIGHT_SLOT_ID}`);
    const toast = bar?.querySelector('.ag-qcap-toast');
    if (!toast) return;
    if (expectedTag && toast.getAttribute('data-tag') !== expectedTag) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.setAttribute('data-visible', 'false');
    toast.removeAttribute('data-persistent');
    toast.removeAttribute('data-tag');
    if (rightSlot) rightSlot.removeAttribute('data-toast-active');
  }

  function showQuickToast(text, options = {}) {
    const bar = document.getElementById(QUICK_BAR_ID);
    const rightSlot = bar?.querySelector(`#${QUICK_RIGHT_SLOT_ID}`);
    const toast = bar?.querySelector('.ag-qcap-toast');
    if (!toast) return;
    const opts = typeof options === 'number'
      ? { durationMs: options }
      : ((options && typeof options === 'object') ? options : {});
    const isError = Boolean(opts.isError);
    const persistent = Boolean(opts.persistent);
    const tag = String(opts.tag || '');
    const rawDuration = Number(opts.durationMs);
    const durationMs = (Number.isFinite(rawDuration) && rawDuration > 0)
      ? Math.max(1000, rawDuration)
      : (isError ? 7000 : 2800);
    toast.textContent = text;
    toast.title = String(opts.title || text || '');
    toast.setAttribute('data-tone', isError ? 'error' : 'info');
    if (tag) toast.setAttribute('data-tag', tag);
    else toast.removeAttribute('data-tag');
    if (persistent) toast.setAttribute('data-persistent', 'true');
    else toast.removeAttribute('data-persistent');
    toast.setAttribute('data-visible', 'true');
    if (rightSlot) rightSlot.setAttribute('data-toast-active', 'true');
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!persistent) {
      toastTimer = setTimeout(() => {
        toastTimer = null;
        toast.setAttribute('data-visible', 'false');
        toast.removeAttribute('data-tag');
        if (rightSlot) rightSlot.removeAttribute('data-toast-active');
      }, durationMs);
    }
  }

  const BUILTIN_SLASH_COMMAND_RE = /^\/(compact|plan|goal|swarm|boost|teamwork|grill-me|btw|learn|browser|schedule)\s*$/i;

  function findMatchingSlashOption(cmdName) {
    const lower = String(cmdName || '').trim().toLowerCase();
    if (!lower) return null;
    const opts = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]') || []);
    for (const opt of opts) {
      const hasExactNode = Array.from(opt.querySelectorAll?.('span, div') || []).some(
        (el) => (!el.children || el.children.length === 0) && String(el.textContent || '').trim().toLowerCase() === lower
      );
      if (hasExactNode) return opt;
      const full = String(opt.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (full === lower || full.startsWith(`${lower} `) || full.startsWith(lower)) {
        return opt;
      }
    }
    return null;
  }

  async function fillComposerText(text, opts = {}) {
    const ed = getComposerEditor() || document.querySelector('[contenteditable="true"]');
    if (!ed) {
      showQuickToast('未找到聊天输入框');
      return false;
    }

    const insertTextWithFallback = async (val, lex) => {
      const str = String(val ?? '');
      const trimmedExpected = str.replace(/[\u200B-\u200D\uFEFF\s]+/g, '');
      const execOk = str ? document.execCommand('insertText', false, str) : true;
      await new Promise((r) => setTimeout(r, 25));
      const actualClean = String(ed.textContent || '').replace(/[\u200B-\u200D\uFEFF\s]+/g, '');
      const insertedByExec = Boolean(execOk && (!trimmedExpected || actualClean.includes(trimmedExpected.slice(0, 12))));
      if (str && !insertedByExec) {
        const PNode = lex?._nodes?.get?.('paragraph')?.klass;
        const TNode = lex?._nodes?.get?.('text')?.klass;
        const LBNode = lex?._nodes?.get?.('linebreak')?.klass;
        if (lex && typeof lex.update === 'function' && PNode && TNode) {
          lex.update(() => {
            const root = lex.getEditorState()?._nodeMap?.get('root');
            const wRoot = root?.getWritable ? root.getWritable() : root;
            if (!wRoot || typeof wRoot.append !== 'function') return;
            if (typeof wRoot.clear === 'function') wRoot.clear();
            const p = new PNode();
            str.split(/\r?\n/).forEach((ln, idx) => {
              if (idx > 0 && LBNode) p.append(new LBNode());
              if (ln) p.append(new TNode(ln));
            });
            wRoot.append(p);
            if (typeof p.selectEnd === 'function') p.selectEnd();
          });
        } else {
          try {
            const ev = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: str
            });
            ed.dispatchEvent(ev);
          } catch {}
        }
      } else if (!str && lex && typeof lex.update === 'function') {
        const PNode = lex?._nodes?.get?.('paragraph')?.klass;
        if (PNode) {
          lex.update(() => {
            const root = lex.getEditorState()?._nodeMap?.get('root');
            const wRoot = root?.getWritable ? root.getWritable() : root;
            if (wRoot && typeof wRoot.clear === 'function') {
              wRoot.clear();
              wRoot.append(new PNode());
            }
          });
        }
      }
    };

    try {
      const lex = ed.__lexicalEditor;
      if (lex && typeof lex.update === 'function') {
        try {
          lex.update(() => {
            const edState = lex._pendingEditorState || lex.getEditorState?.();
            const root = edState?._nodeMap?.get('root');
            if (root && typeof root.clear === 'function') {
              root.clear();
            }
          }, { discrete: true });
          await new Promise((r) => setTimeout(r, 20));
        } catch {}
      }
      if (!lex || (ed.textContent || '').trim() || ed.querySelector?.('[data-uri]')) {
        ed.focus?.();
        document.execCommand?.('selectAll', false, null);
        document.execCommand?.('delete', false, null);
        if (lex) await new Promise((r) => setTimeout(r, 15));
      }

      ed.focus?.();
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      const rawStr = String(text ?? '');
      const slashCmd = opts?.slashCommand
        ? String(opts.slashCommand).trim().toLowerCase()
        : (rawStr.match(BUILTIN_SLASH_COMMAND_RE)?.[1]?.toLowerCase() || '');
      const initialInsert = slashCmd ? `/${slashCmd}` : rawStr;

      await insertTextWithFallback(initialInsert, lex);

      let convertedSlashPill = false;
      if (slashCmd) {
        let matchedOpt = findMatchingSlashOption(slashCmd);
        if (!matchedOpt && lex) {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 25));
            matchedOpt = findMatchingSlashOption(slashCmd);
            if (matchedOpt) break;
          }
        }
        if (matchedOpt) {
          const clickTarget = matchedOpt.querySelector?.('div.cursor-pointer') || matchedOpt;
          try {
            if (typeof MouseEvent === 'function') {
              clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            }
          } catch {}
          clickTarget.click?.();
          await new Promise((r) => setTimeout(r, 35));
          convertedSlashPill = true;
        } else if (rawStr !== initialInsert) {
          ed.focus?.();
          document.execCommand?.('selectAll', false, null);
          document.execCommand?.('delete', false, null);
          await insertTextWithFallback(rawStr, lex);
        }
      }

      // 确保光标位于内容末尾
      try {
        const endRange = document.createRange();
        endRange.selectNodeContents(ed);
        endRange.collapse(false);
        const s2 = window.getSelection();
        if (s2) {
          s2.removeAllRanges();
          s2.addRange(endRange);
        }
      } catch {}
      syncPromptOptimizerUI();
      return convertedSlashPill ? 'slash_pill' : true;
    } catch {
      showQuickToast('填入输入框失败');
      return false;
    }
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function getSessionIdFromLocation() {
    const pathname = String(location?.pathname || '');
    const m = pathname.match(/\/c\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }

  function parseProjectIdFromHref(href) {
    const s = String(href || '');
    const m = s.match(/[?&]project=([^&#]+)/);
    if (!m || !m[1]) return '';
    try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
  }

  function getProjectIdFromLocation() {
    try {
      const rawSearch = String(location?.search || '').trim();
      if (!rawSearch) return '';
      const q = rawSearch.startsWith('?') ? rawSearch : `?${rawSearch}`;
      return parseProjectIdFromHref(q);
    } catch {
      return '';
    }
  }

  function extractDomFallbackMarkdown(sessionId) {
    const blocks = [];
    const header = [
      '# Antigravity 会话记录（页面回退导出）',
      '',
      `- 会话 ID: \`${sessionId || 'unknown'}\``,
      `- 导出时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      '---',
      ''
    ].join('\n');
    const main = document.querySelector('main') || document.body;
    const text = (main?.innerText || '').trim();
    blocks.push(text);
    return header + blocks.join('\n\n') + '\n';
  }

  function triggerBrowserDownload(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function exportMarkdown() {
    const id = getSessionIdFromLocation();
    if (!id) {
      showQuickToast('当前页面未包含会话 ID');
      return { ok: false, error: '当前页面未包含会话 ID' };
    }

    const live = window.__AGContextMeterLive;
    if (live?.port && live?.token) {
      try {
        showQuickToast('正在导出会话 Markdown…');
        const resp = await fetch(`http://127.0.0.1:${live.port}/export-markdown`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AG-Context-Token': live.token
          },
          body: JSON.stringify({ id })
        });
        const data = await resp.json();
        if (data && data.ok && typeof data.markdown === 'string') {
          const copied = await copyToClipboard(data.markdown);
          showQuickToast(copied ? '✅ 已导出至 ~/Downloads 并复制 Markdown' : `✅ 已导出至 ${data.savedPath}`);
          return data;
        }
        throw new Error(data?.error || '导出失败');
      } catch (err) {
        // 若桥接异常，回退 DOM 导出
        const md = extractDomFallbackMarkdown(id);
        await copyToClipboard(md);
        triggerBrowserDownload(`antigravity-session-${id.slice(0, 8)}.md`, md);
        showQuickToast(`已回退下载 Markdown（${err?.message || '桥接不可用'}）`);
        return { ok: true, fallback: true, markdown: md };
      }
    }

    const md = extractDomFallbackMarkdown(id);
    await copyToClipboard(md);
    triggerBrowserDownload(`antigravity-session-${id.slice(0, 8)}.md`, md);
    showQuickToast('✅ 已通过页面提取并下载 Markdown');
    return { ok: true, fallback: true, markdown: md };
  }

  const HIGH_RISK_RULES = [
    { label: 'rm -r / rm -rf', re: /(?:^|[\s;|&`(])rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/ },
    { label: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/ },
    { label: 'git clean -f', re: /\bgit\s+clean\s+-[a-zA-Z]*f/ },
    { label: 'git push', re: /\bgit\s+push\b/ },
    { label: 'git checkout -- / restore', re: /\bgit\s+(?:checkout\s+--|restore)\b/ },
    { label: 'sudo / mkfs / dd', re: /(?:^|[\s;|&`(])(?:sudo|mkfs(?:\.\w+)?)\b|\bdd\s+if=/ },
    { label: 'kill -9 / pkill / killall', re: /(?:^|[\s;|&`(])(?:kill\s+-9|pkill|killall)\b/ },
    { label: 'SQL DROP / TRUNCATE / DELETE', re: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i },
    { label: '1Password op item 变更', re: /\bop\s+item\s+(?:delete|edit|create)\b/ }
  ];

  function detectHighRiskLabels(text) {
    if (!text || text.length < 4) return [];
    const hits = [];
    for (const rule of HIGH_RISK_RULES) {
      if (rule.re.test(text)) hits.push(rule.label);
    }
    return hits;
  }

  function scanHighRiskCommands() {
    if (disposed) return 0;
    const viewport = document.querySelector('[data-testid="autoscroll-viewport"]');
    if (!viewport) return 0;
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    const targets = viewport.querySelectorAll('pre, code, [data-testid="tool-group-collapsible"]');
    let markedCount = 0;

    for (const el of targets) {
      if (el.closest('[data-testid="user-message"], .ag-risk-banner')) continue;
      if (el.tagName === 'CODE' && el.closest('pre, [data-testid="tool-group-collapsible"]')) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (el.tagName === 'CODE' && text.length > 220) continue;

      const hits = detectHighRiskLabels(text);
      if (!hits.length) continue;

      const isInlineCode = el.tagName === 'CODE';
      const card = isInlineCode ? el : (el.closest('[data-testid="turn-cards-container"]') || el);
      const summary = hits.slice(0, 3).join('、');

      if (card.getAttribute('data-ag-risk-card') !== 'high') {
        card.setAttribute('data-ag-risk-card', 'high');
      }
      if (isInlineCode) {
        card.setAttribute('title', `🛡️ 高危命令预警：检测到 ${summary}，请人工核对`);
      } else {
        let banner = card.querySelector(':scope > .ag-risk-banner');
        if (!banner && card.parentElement && card.previousElementSibling?.classList?.contains('ag-risk-banner')) {
          banner = card.previousElementSibling;
        }
        const expectedText = `🛡️ 高危命令预警：检测到 ${summary}，请人工核对`;
        if (!banner) {
          banner = document.createElement('div');
          banner.className = 'ag-risk-banner';
          banner.textContent = expectedText;
          if (card.tagName === 'BUTTON' || card.tagName === 'PRE') {
            card.parentElement?.insertBefore(banner, card);
          } else {
            card.insertBefore(banner, card.firstChild);
          }
        } else if (banner.textContent !== expectedText) {
          banner.textContent = expectedText;
        }
        if (banner.getAttribute('data-ag-theme') !== theme) {
          banner.setAttribute('data-ag-theme', theme);
        }
      }
      markedCount++;
    }
    return markedCount;
  }

  function getScrollViewport() {
    return document.querySelector('[data-testid="autoscroll-viewport"]');
  }

  function scrollToTop() {
    const vp = getScrollViewport();
    if (vp) vp.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function scrollToPrevTurn() {
    const vp = getScrollViewport();
    if (!vp) return;
    const vpRect = vp.getBoundingClientRect();
    const msgs = Array.from(vp.querySelectorAll('[data-testid="user-message"]'));
    let targetTop = 0;
    for (const msg of msgs) {
      const r = msg.getBoundingClientRect();
      const relTop = r.top - vpRect.top + vp.scrollTop;
      if (relTop < vp.scrollTop - 16) {
        targetTop = Math.max(0, relTop - 12);
      }
    }
    vp.scrollTo({ top: targetTop, behavior: 'smooth' });
  }

  function scrollToNextTurn() {
    const vp = getScrollViewport();
    if (!vp) return;
    const vpRect = vp.getBoundingClientRect();
    const msgs = Array.from(vp.querySelectorAll('[data-testid="user-message"]'));
    for (const msg of msgs) {
      const r = msg.getBoundingClientRect();
      const relTop = r.top - vpRect.top + vp.scrollTop;
      if (relTop > vp.scrollTop + 24) {
        vp.scrollTo({ top: Math.max(0, relTop - 12), behavior: 'smooth' });
        return;
      }
    }
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  }

  function scrollToNextOrBottom() {
    const vp = getScrollViewport();
    if (!vp) return;
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
  }

  function setNavBtnContent(btn, iconSvg, text) {
    if (!btn) return;
    if (btn._navIconSvg === iconSvg && btn._navLabelText === text && btn.children?.length >= 2) return;
    btn._navIconSvg = iconSvg;
    btn._navLabelText = text;
    btn.textContent = '';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ag-nav-icon';
    iconSpan.innerHTML = iconSvg;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ag-nav-label';
    labelSpan.textContent = text;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
  }

  function updateThinkToggleLabel() {
    const btn = document.getElementById('ag-nav-think');
    if (!btn) return;
    const triggers = Array.from(document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
    const hasCollapsed = triggers.some((t) => t.getAttribute('aria-expanded') !== 'true');
    setNavBtnContent(
      btn,
      CHAT_NAV_ICONS.think,
      hasCollapsed || triggers.length === 0
        ? tr('展开思考', 'Expand Thoughts')
        : tr('收起思考', 'Collapse Thoughts')
    );
  }

  function toggleAllThinking() {
    const triggers = Array.from(document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
    if (!triggers.length) {
      showQuickToast('当前对话暂无可展开的思考块');
      return 0;
    }
    const hasCollapsed = triggers.some((t) => t.getAttribute('aria-expanded') !== 'true');
    let toggled = 0;
    for (const trg of triggers) {
      const key = getThinkingTriggerKey(trg);
      if (hasCollapsed) {
        if (key) {
          userCollapsedThinkingKeys.delete(key);
          keepExpandedThinkingKeys.add(key);
        }
      } else if (key) {
        keepExpandedThinkingKeys.delete(key);
        userCollapsedThinkingKeys.add(key);
      }
      const expanded = trg.getAttribute('aria-expanded') === 'true';
      if ((hasCollapsed && !expanded) || (!hasCollapsed && expanded)) {
        trg.click();
        toggled++;
      }
      if (hasCollapsed) disarmThinkingAutoCollapse(trg);
    }
    updateThinkToggleLabel();
    if (hasCollapsed) {
      setTimeout(() => {
        if (!disposed) {
          localizeThinkingShells();
          void translateExpandedThoughts();
        }
      }, 80);
    }
    return toggled;
  }

  function positionChatNavFloat(nav) {
    if (!nav) return;
    const openModal = typeof document.querySelector === 'function'
      ? document.querySelector('[aria-modal="true"]:not([hidden])')
      : null;
    if (openModal && openModal.offsetWidth > 0 && openModal.offsetHeight > 0) {
      nav.hidden = true;
      return;
    }
    const vp = getScrollViewport();
    if (!vp) {
      nav.hidden = true;
      return;
    }
    const vpRect = vp.getBoundingClientRect();
    if (vpRect.width < 120 || vpRect.height < 120) {
      nav.hidden = true;
      return;
    }
    nav.hidden = false;
    const composer = document.querySelector('.surface-composer');
    const composerRect = composer?.getBoundingClientRect();
    const quickBar = document.getElementById(QUICK_BAR_ID);
    const quickBarRect = quickBar?.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const hasRightMargin = composerRect && composerRect.width > 0 && (vpRect.right - composerRect.right >= 42);
    const composerTop = (composerRect && composerRect.height > 0) ? composerRect.top : null;
    const upperTop = (composerTop !== null && quickBarRect && quickBarRect.height > 0)
      ? Math.min(composerTop, quickBarRect.top)
      : composerTop;
    const bottomAnchor = upperTop !== null ? (upperTop - 8) : vpRect.bottom;
    const top = Math.min(window.innerHeight - navRect.height - 8, Math.max(vpRect.top + 12, bottomAnchor - navRect.height));
    if (hasRightMargin) {
      nav.style.right = 'auto';
      nav.style.left = `${Math.round(composerRect.right + 10)}px`;
    } else {
      const right = Math.max(6, window.innerWidth - vpRect.right + 6);
      nav.style.left = 'auto';
      nav.style.right = `${Math.round(right)}px`;
    }
    nav.style.top = `${Math.round(top)}px`;
  }

  function getChatNavDefinitions() {
    return [
      { id: 'ag-nav-top', icon: CHAT_NAV_ICONS.top, text: tr('顶部', 'Top'), title: tr('跳回当前对话最顶部', 'Scroll to top'), onClick: scrollToTop },
      { id: 'ag-nav-prev', icon: CHAT_NAV_ICONS.prev, text: tr('上一轮', 'Prev'), title: tr('跳到上一条用户提问', 'Previous turn'), onClick: scrollToPrevTurn },
      { id: 'ag-nav-next', icon: CHAT_NAV_ICONS.next, text: tr('下一轮', 'Next'), title: tr('跳到下一条用户提问', 'Next turn'), onClick: scrollToNextTurn },
      { id: 'ag-nav-bottom', icon: CHAT_NAV_ICONS.bottom, text: tr('底部', 'Bottom'), title: tr('直达最新回复底部', 'Scroll to bottom'), onClick: scrollToNextOrBottom },
      { id: 'ag-nav-think', icon: CHAT_NAV_ICONS.think, text: tr('展开思考', 'Expand Thoughts'), title: tr('一键展开或收起当前对话全部思考过程', 'Toggle all thought blocks'), onClick: () => { toggleAllThinking(); } }
    ];
  }

  function updateChatNavLanguage() {
    const nav = document.getElementById(CHAT_NAV_ID);
    if (!nav) return;
    nav.setAttribute('aria-label', tr('长对话快捷导航', 'Chat Quick Navigation'));
    for (const item of getChatNavDefinitions()) {
      const btn = document.getElementById(item.id);
      if (!btn) continue;
      if (item.id !== 'ag-nav-think') setNavBtnContent(btn, item.icon, item.text);
      btn.title = item.title;
    }
    updateThinkToggleLabel();
  }

  function ensureChatNavFloat() {
    if (disposed || featureFlags.showChatNav === false) return;
    ensureDocStyle();
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    const vp = getScrollViewport();
    const mountRoot = vp?.closest?.('.agy-sheet')
      || (typeof document.querySelector === 'function' ? document.querySelector('.agy-sheet') : null)
      || document.body;
    let nav = document.getElementById(CHAT_NAV_ID);
    if (!nav) {
      nav = document.createElement('div');
      nav.id = CHAT_NAV_ID;
      nav.setAttribute('aria-label', tr('长对话快捷导航', 'Chat Quick Navigation'));
      for (const item of getChatNavDefinitions()) {
        const btn = document.createElement('button');
        btn.id = item.id;
        btn.type = 'button';
        btn.className = 'ag-nav-btn';
        setNavBtnContent(btn, item.icon, item.text);
        btn.title = item.title;
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', item.onClick);
        nav.appendChild(btn);
      }
      mountRoot.appendChild(nav);
    } else if (mountRoot && nav.parentElement !== mountRoot) {
      mountRoot.appendChild(nav);
    }
    if (nav.getAttribute('data-ag-theme') !== theme) {
      nav.setAttribute('data-ag-theme', theme);
    }
    updateThinkToggleLabel();
    positionChatNavFloat(nav);
  }

  const AUTO_ACCEPT_WHITELIST = new Set([
    'proceed', 'accept', 'accept all', 'accept changes', 'accept step', 'allow once',
    '继续', '接受', '全部接受', '接受更改', '接受此步骤', '允许一次'
  ]);
  const AUTO_ACCEPT_BLACKLIST = /\b(delete|remove|reject|deny|cancel|stop|abort|discard|reset|uninstall|kill|terminate|revoke)\b|删除|移除|拒绝|取消|停止|中止|丢弃|重置|卸载|终止|撤销/i;

  function runAutoAcceptTick() {
    if (!autoAcceptEnabled || disposed) return;
    scanHighRiskCommands();
    const container = document.querySelector('main') || document.body;
    if (!container) return;
    const now = Date.now();
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.closest(`#${QUICK_BAR_ID}, #${CHAT_NAV_ID}, #${METER_HOST_ID}, [data-agy-hans-ui], [data-agy-context-capsule]`)) continue;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      if (btn.offsetWidth <= 0 || btn.offsetHeight <= 0) continue;
      const rawText = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rawText || rawText.length > 32) continue;
      if (AUTO_ACCEPT_BLACKLIST.test(rawText)) continue;
      if (!AUTO_ACCEPT_WHITELIST.has(rawText.toLowerCase())) continue;
      const cardScope = btn.closest('[data-testid="agent-response"], [data-testid="turn-cards-container"], [role="dialog"]');
      if (cardScope && cardScope.querySelector('[data-ag-risk-card="high"]')) {
        const lastWarn = autoClickedButtons.get(btn) || 0;
        if (now - lastWarn >= 5000) {
          autoClickedButtons.set(btn, now);
          showQuickToast('⚠️ 检测到高危命令，已跳过自动确认');
        }
        continue;
      }
      const lastClicked = autoClickedButtons.get(btn) || 0;
      if (now - lastClicked < 3000) continue;
      autoClickedButtons.set(btn, now);
      try {
        btn.click();
        showQuickToast(`已自动确认: ${rawText}`);
      } catch {}
    }
  }

  function updateAutoAcceptBtn() {
    const btn = document.getElementById('ag-qcap-autoaccept');
    if (!btn) return;
    btn.textContent = autoAcceptEnabled ? tr('自动确认: 开', 'Auto-Accept: ON') : tr('自动确认: 关', 'Auto-Accept: OFF');
    btn.setAttribute('data-active', autoAcceptEnabled ? 'true' : 'false');
    btn.title = autoAcceptEnabled
      ? tr('自动确认已开启（仅点击 Proceed / Accept / 继续 等安全步骤按钮）；点击关闭', 'Auto-Accept enabled for safe Proceed / Accept buttons; click to disable')
      : tr('开启后自动点击对话中的 Proceed / Accept / 继续 等确认按钮（默认关闭）', 'Enable auto-clicking Proceed / Accept confirmation buttons (off by default)');
  }

  function formatBrainTooltip(stats) {
    if (!stats || !stats.ok) return tr('点击查询 Brain 历史会话缓存占用', 'Click to check Brain session cache usage');
    const lines = [tr(`Brain 历史缓存：共 ${stats.count} 个会话，合计 ${stats.totalMB} MB`, `Brain cache: ${stats.count} sessions, ${stats.totalMB} MB total`)];
    if (Array.isArray(stats.topSessions) && stats.topSessions.length) {
      lines.push('', tr('占用 Top 5：', 'Top 5 sessions:'));
      stats.topSessions.forEach((s, idx) => {
        lines.push(`${idx + 1}. ${s.title || s.shortId} (${s.shortId}) — ${s.mb} MB`);
      });
    }
    lines.push('', tr('目录：~/.gemini/antigravity/brain（只读统计，点击刷新并复制明细）', 'Path: ~/.gemini/antigravity/brain (read-only, click to refresh & copy)'));
    return lines.join('\n');
  }

  async function refreshBrainStats(showDetailToast = false) {
    const res = await postToLiveHost('/brain-stats', {});
    if (!res || !res.ok) {
      if (showDetailToast) showQuickToast(tr('缓存统计获取失败（桥接服务未连接）', 'Failed to fetch cache stats (bridge offline)'));
      return null;
    }
    latestBrainStats = res;
    const btn = document.getElementById('ag-qcap-brain');
    if (btn) {
      btn.textContent = tr(`缓存 ${res.totalMB}MB`, `Cache ${res.totalMB}MB`);
      btn.title = formatBrainTooltip(res);
    }
    if (showDetailToast) {
      const summary = formatBrainTooltip(res);
      await copyToClipboard(summary);
      const top1 = res.topSessions && res.topSessions[0];
      showQuickToast(
        top1
          ? tr(`共 ${res.count} 个会话 (${res.totalMB}MB)，最大: ${top1.title} (${top1.mb}MB)，明细已复制`, `${res.count} sessions (${res.totalMB}MB), largest: ${top1.title} (${top1.mb}MB), copied`)
          : tr(`共 ${res.count} 个会话 (${res.totalMB}MB)，明细已复制`, `${res.count} sessions (${res.totalMB}MB), copied`)
      );
    }
    return res;
  }

  function buildCompactBtnTitle(risk = null) {
    const autoTag = autoCompactEnabled
      ? tr('（已开启 240K 自动压缩，可在套件设置关闭）', ' (240K Auto-Compact ON)')
      : tr('（240K 自动压缩已关闭，可在套件设置开启）', ' (240K Auto-Compact OFF)');
    if (risk?.cacheDropDetected) {
      return tr(
        '⚠ 检测到缓存脱落（命中率归零），每步将全量重算约 4~5 分钟并狂耗配额，建议立即执行 /compact',
        '⚠ Cache dropped (0% hit), causing 4-5m stalls & heavy quota drain. Run /compact now'
      ) + autoTag;
    }
    if ((risk?.contextUsed || 0) >= 328000) {
      return tr(
        '⚠ 已跨过 328K 缓存雪崩线（官方要到 512K 才压缩，此时一旦缓存过期就会步步重算 4~5 分钟），建议尽快 /compact',
        '⚠ Past 328K cache cliff (client waits until 512K; >3m idle stalls 4-5m). Run /compact soon'
      ) + autoTag;
    }
    if ((risk?.contextUsed || 0) >= 240000 || (risk?.percent || 0) >= 70) {
      return tr(
        '⚡ 已进入 240K+ 长上下文区间（官方默认 512K 才压缩），现在压缩可避开 300K+ 缓存过期卡死',
        '⚡ In 240K+ zone (official threshold is 512K); compacting now prevents 300K+ stalls'
      ) + autoTag;
    }
    return tr(
      '快速填入 /compact 压缩上下文（官方默认 512K 才自动压缩，超过 250K 后一旦缓存过期会每步卡顿 4~5 分钟；可在套件设置开关 240K 自动压缩）',
      'Fill /compact command (official auto-compact waits until 512K; compacting around 240K prevents 4-5m 0-cache stalls)'
    ) + autoTag;
  }

  function hideQuickBarTooltip() {
    const tip = document.getElementById(QUICK_BAR_TOOLTIP_ID);
    if (tip) tip.hidden = true;
  }

  function showQuickBarTooltip(anchorBtn, act) {
    if (disposed || !anchorBtn || !act) return;
    ensureDocStyle();
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    let tip = document.getElementById(QUICK_BAR_TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = QUICK_BAR_TOOLTIP_ID;
      tip.setAttribute('role', 'tooltip');

      const topRow = document.createElement('div');
      topRow.className = 'ag-qtip-top';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'ag-qtip-title-wrap';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'ag-qtip-title';

      const recSpan = document.createElement('span');
      recSpan.className = 'ag-qtip-rec';

      titleWrap.appendChild(titleSpan);
      titleWrap.appendChild(recSpan);

      const tagSpan = document.createElement('span');
      tagSpan.className = 'ag-qtip-tag';

      topRow.appendChild(titleWrap);
      topRow.appendChild(tagSpan);

      const roleDiv = document.createElement('div');
      roleDiv.className = 'ag-qtip-role';

      const sceneDiv = document.createElement('div');
      sceneDiv.className = 'ag-qtip-scene';

      tip.appendChild(topRow);
      tip.appendChild(roleDiv);
      tip.appendChild(sceneDiv);
      (document.body || document.documentElement)?.appendChild(tip);
    }

    const titleEl = tip.querySelector('.ag-qtip-title');
    const recEl = tip.querySelector('.ag-qtip-rec');
    const tagEl = tip.querySelector('.ag-qtip-tag');
    const roleEl = tip.querySelector('.ag-qtip-role');
    const sceneEl = tip.querySelector('.ag-qtip-scene');

    if (titleEl) titleEl.textContent = act.label || '';
    if (recEl) {
      if (act.rec) {
        recEl.textContent = act.rec;
        recEl.hidden = false;
      } else {
        recEl.textContent = '';
        recEl.hidden = true;
      }
    }
    if (tagEl) {
      tagEl.textContent = act.tag
        ? (act.isCustom ? act.tag : `${tr('推荐用途：', 'Use case: ')}${act.tag}`)
        : '';
    }
    if (roleEl) {
      roleEl.textContent = act.role ? `${tr('作用：', 'Role: ')}${act.role}` : (act.title || '');
    }
    if (sceneEl) {
      let sceneText = act.scene || '';
      if (act.poolId === 'compact') {
        const risk = extractContextRiskState();
        const autoStr = autoCompactEnabled
          ? tr('240K 自动压缩: 已开启', '240K Auto-Compact: ON')
          : tr('240K 自动压缩: 已关闭', '240K Auto-Compact: OFF');
        if (risk.cacheDropDetected) {
          sceneText = tr('⚠️ 当前检测到缓存脱落，建议立刻执行 /compact 压缩！', '⚠️ Cache drop detected — run /compact immediately!');
        } else if (risk.contextUsed >= 240000) {
          sceneText = tr(`当前已达 ${Math.round(risk.contextUsed / 1000)}K，建议尽快压缩 · ${autoStr}`, `At ${Math.round(risk.contextUsed / 1000)}K — compact soon · ${autoStr}`);
        } else {
          sceneText = `${sceneText}（${autoStr}）`;
        }
      }
      if (sceneText) {
        sceneEl.textContent = act.isCustom
          ? `${tr('内容：', 'Prompt: ')}${sceneText}`
          : `${tr('场景：', 'When to use: ')}${sceneText}`;
        sceneEl.hidden = false;
      } else {
        sceneEl.textContent = '';
        sceneEl.hidden = true;
      }
    }

    tip.setAttribute('data-ag-theme', theme);
    tip.hidden = false;

    try {
      if (typeof anchorBtn.getBoundingClientRect === 'function') {
        const rect = anchorBtn.getBoundingClientRect();
        const vw = window.innerWidth || 1280;
        const tipW = tip.offsetWidth || 360;
        const tipH = tip.offsetHeight || 68;
        const left = Math.max(12, Math.min(vw - tipW - 12, Math.round(rect.left || 12)));
        const top = Math.max(8, Math.round((rect.top || 76) - tipH - 7));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
      }
    } catch {}
  }

  function getQuickBarActions() {
    const actions = [];
    for (const item of BUILTIN_QUICK_POOL) {
      if (quickPoolState[item.id] === false) continue;
      const btnId = `ag-qcap-${item.id}`;
      const label = item.labelEn ? tr(item.label, item.labelEn) : item.label;
      const rec = item.recEn !== undefined ? tr(item.rec || '', item.recEn || '') : (item.rec || '');
      const tag = item.tagEn !== undefined ? tr(item.tag || '', item.tagEn || '') : (item.tag || '');
      const role = item.roleEn ? tr(item.role || item.title, item.roleEn) : (item.role || item.title);
      const scene = item.sceneEn ? tr(item.scene || '', item.sceneEn) : (item.scene || '');
      const title = item.id === 'compact'
        ? buildCompactBtnTitle(extractContextRiskState())
        : (item.titleEn ? tr(item.title, item.titleEn) : item.title);

      if (item.builtinAction === 'copyid') {
        actions.push({
          id: btnId,
          poolId: item.id,
          label,
          rec,
          tag,
          role,
          scene,
          title,
          onClick: async () => {
            const id = getSessionIdFromLocation();
            if (!id) {
              showQuickToast(tr('当前页面未包含会话 ID', 'No conversation ID in current URL'));
              return;
            }
            const ok = await copyToClipboard(id);
            showQuickToast(ok ? tr(`已复制会话 ID (${id.slice(0, 8)})`, `Copied ID (${id.slice(0, 8)})`) : tr('复制失败，请检查剪贴板权限', 'Copy failed'));
          }
        });
        continue;
      }

      if (item.builtinAction === 'export') {
        actions.push({
          id: btnId,
          poolId: item.id,
          label,
          rec,
          tag,
          role,
          scene,
          title,
          onClick: () => { void exportMarkdown(); }
        });
        continue;
      }

      const fillText = String(item.text || '');
      actions.push({
        id: btnId,
        poolId: item.id,
        label,
        rec,
        tag,
        role,
        scene,
        title,
        fillText,
        onClick: async () => {
          const fillRes = await fillComposerText(fillText, item.slash ? { slashCommand: item.slash } : {});
          if (!fillRes) return;
          if (item.id === 'compact') {
            showQuickToast(
              fillRes === 'slash_pill'
                ? tr('已生成 /compact 命令胶囊，按回车即可执行', 'Ready: /compact command pill, press Enter to run')
                : tr('已填入 /compact，按回车即可执行', 'Inserted /compact, press Enter to run')
            );
          } else if (item.slash) {
            showQuickToast(
              fillRes === 'slash_pill'
                ? tr(`已生成 /${item.slash} 命令胶囊，输入需求后发送`, `Ready: /${item.slash} command pill, enter your prompt`)
                : tr(`已填入 /${item.slash} ，请输入需求后发送`, `Inserted /${item.slash} , enter your prompt`)
            );
          } else if (item.id === 'reload') {
            showQuickToast(tr('已填入重载规则指令，按回车即可发送', 'Inserted reload rules prompt, press Enter'));
          } else {
            showQuickToast(tr(`已填入「${label}」`, `Inserted "${label}"`));
          }
        }
      });
    }

    const customList = Array.isArray(customQuickPrompts) ? customQuickPrompts : [];
    customList.forEach((item, idx) => {
      if (!item) return;
      const fillText = String(item.text || '');
      const label = item.label;
      actions.push({
        id: `ag-qcap-prompt-${idx}`,
        isCustom: true,
        label,
        rec: '',
        tag: tr('自定义快捷提示词', 'Custom Prompt'),
        role: tr('点击一键填入预设提示词到输入框', 'Click to insert preset prompt into composer'),
        scene: truncateNextStepText(fillText, 64),
        title: item.title || tr(`点击填入：${fillText}`, `Insert: ${fillText}`),
        fillText,
        onClick: async () => {
          if (await fillComposerText(fillText)) {
            showQuickToast(tr(`已填入「${label}」`, `Inserted "${label}"`));
          }
        }
      });
    });

    return actions;
  }

  function applyQuickButtonMetadata(btn, act) {
    btn.__agQuickAct = act;
    btn.setAttribute('data-ag-tooltip', act.title || '');
    btn.setAttribute('aria-label', act.title ? `${act.label} - ${act.title}` : act.label);
    if (btn.hasAttribute?.('title')) btn.removeAttribute('title');
  }

  function syncQuickBarActionButtons(bar) {
    if (!bar) return;
    const actions = getQuickBarActions();
    const sig = JSON.stringify({
      lang: uiLang,
      items: actions.map((a) => [a.id, a.label, a.title, a.fillText || '', a.rec || '', a.tag || '', a.role || '', a.scene || ''])
    });
    const rightSlot = bar.querySelector(`#${QUICK_RIGHT_SLOT_ID}`);
    if (bar.dataset.promptsSig === sig) {
      for (const act of actions) {
        const btn = bar.querySelector(`#${act.id}`);
        if (!btn) continue;
        if (btn.textContent !== act.label) btn.textContent = act.label;
        applyQuickButtonMetadata(btn, act);
      }
      return;
    }
    bar.dataset.promptsSig = sig;
    const oldBtns = Array.from(bar.children || []).filter((ch) => ch !== rightSlot && ch.id !== QUICK_RIGHT_SLOT_ID);
    for (const oldBtn of oldBtns) {
      safeRemove(oldBtn);
    }
    for (const act of actions) {
      const btn = document.createElement('button');
      btn.id = act.id;
      btn.className = 'ag-qcap-btn';
      btn.type = 'button';
      btn.textContent = act.label;
      applyQuickButtonMetadata(btn, act);
      if (act.active) btn.setAttribute('data-active', 'true');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('mouseenter', () => {
        showQuickBarTooltip(btn, btn.__agQuickAct);
      });
      btn.addEventListener('focus', () => {
        showQuickBarTooltip(btn, btn.__agQuickAct);
      });
      btn.addEventListener('mouseleave', () => {
        hideQuickBarTooltip();
      });
      btn.addEventListener('blur', () => {
        hideQuickBarTooltip();
      });
      btn.addEventListener('click', () => {
        hideQuickBarTooltip();
        return btn.__agQuickAct?.onClick?.();
      });
      if (rightSlot && rightSlot.parentElement === bar) {
        bar.insertBefore(btn, rightSlot);
      } else {
        bar.appendChild(btn);
      }
    }
  }

  function updateQuickBarLanguage() {
    const bar = document.getElementById(QUICK_BAR_ID);
    if (bar) {
      bar.setAttribute('aria-label', tr('输入框快捷操作栏', 'Composer Quick Actions'));
      syncQuickBarActionButtons(bar);
      const tabBtn = document.querySelector(`#${NEXT_STEP_GHOST_ID} .ag-ns-tab`);
      if (tabBtn) {
        const kbdTag = tabBtn.querySelector('.ag-ns-kbd-tag');
        if (kbdTag) kbdTag.textContent = tr('Tab / → 补全', 'Tab / →');
      }
    }
    syncPromptOptimizerUI();
  }

  function ensureQuickCapsuleBar() {
    if (disposed || featureFlags.showQuickBar === false) return;
    ensureDocStyle();
    const composer = document.querySelector('.surface-composer');
    if (!composer || !composer.parentElement) return;

    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);

    let bar = document.getElementById(QUICK_BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = QUICK_BAR_ID;
      bar.setAttribute('aria-label', tr('输入框快捷操作栏', 'Composer Quick Actions'));

      const rightSlot = document.createElement('div');
      rightSlot.id = QUICK_RIGHT_SLOT_ID;
      rightSlot.className = 'ag-qcap-right-slot';

      const toast = document.createElement('span');
      toast.className = 'ag-qcap-toast';
      toast.setAttribute('data-visible', 'false');
      rightSlot.appendChild(toast);
      bar.appendChild(rightSlot);
    }

    syncQuickBarActionButtons(bar);

    if (bar.getAttribute('data-ag-theme') !== theme) {
      bar.setAttribute('data-ag-theme', theme);
    }

    const compactBtn = document.getElementById('ag-qcap-compact');
    if (compactBtn) {
      const risk = extractContextRiskState();
      if (risk.cacheDropDetected) {
        compactBtn.setAttribute('data-risk', 'danger');
      } else if (risk.contextUsed >= 328000) {
        compactBtn.setAttribute('data-risk', 'danger');
      } else if (risk.contextUsed >= 240000 || risk.percent >= 70) {
        compactBtn.setAttribute('data-risk', 'warn');
      } else {
        compactBtn.removeAttribute('data-risk');
      }
      const compactSummary = buildCompactBtnTitle(risk);
      compactBtn.setAttribute('data-ag-tooltip', compactSummary);
      compactBtn.setAttribute('aria-label', `${compactBtn.textContent || '/compact'} - ${compactSummary}`);
      if (compactBtn.hasAttribute?.('title')) compactBtn.removeAttribute('title');
    }

    // 始终保证快捷胶囊栏位于 .surface-composer 的紧邻正上方
    if (bar.parentElement !== composer.parentElement || bar.nextElementSibling !== composer) {
      composer.parentElement.insertBefore(bar, composer);
    }
  }

  // ==================== 输入框“下一步建议”幽灵提示与 Tab 补全 ====================

  function getComposerEditor() {
    return (
      document.querySelector('.surface-composer [data-lexical-editor="true"]') ||
      document.querySelector('.surface-composer [contenteditable="true"]') ||
      document.querySelector('[data-testid="agent-input-box"] [data-lexical-editor="true"]') ||
      document.querySelector('[data-testid="agent-input-box"] [contenteditable="true"]') ||
      document.querySelector('[aria-label="Message input"][contenteditable="true"]') ||
      document.querySelector('[aria-label="消息输入"][contenteditable="true"]')
    );
  }

  function getComposerText(ed) {
    if (!ed) return '';
    const raw = typeof ed.__lexicalTextContent === 'string'
      ? ed.__lexicalTextContent
      : (typeof ed.innerText === 'string' && ed.innerText.length ? ed.innerText : (ed.textContent || ''));
    return String(raw).replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function isComposerEmpty(ed) {
    if (!ed) return false;
    return getComposerText(ed).trim().length === 0;
  }

  function extractContextPercent() {
    const cap = document.querySelector('[data-agy-context-capsule="1"]');
    const capMatch = (cap?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
    if (capMatch) return Number(capMatch[1]);
    const { sr } = getMeterHostAndShadow();
    const meterMatch = (sr?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
    return meterMatch ? Number(meterMatch[1]) : 0;
  }

  function extractContextRiskState() {
    const percent = extractContextPercent();
    let contextUsed = 0;
    let cacheDropDetected = false;
    try {
      const capData = document.querySelector('[data-agy-context-capsule="1"]')?.__ctxUsageData;
      const meterLatest = window.__AGContextMeter?.snapshot?.()?.latest;
      contextUsed = Math.max(Number(capData?.contextUsed || 0), Number(meterLatest?.actual || meterLatest?.used || 0));
      cacheDropDetected = Boolean(capData?.cacheDropDetected || meterLatest?.cacheDropDetected);
      if (
        !cacheDropDetected &&
        capData?.hasPreciseSnapshot &&
        contextUsed >= 240000 &&
        Number(capData?.inputTokens || 0) >= 200000 &&
        Number(capData?.cacheHitRate || 0) < 25
      ) {
        cacheDropDetected = true;
      }
    } catch {}
    return { percent, contextUsed, cacheDropDetected };
  }

  function runAutoCompactTick(opts = {}) {
    if (!autoCompactEnabled || disposed) {
      return { triggered: false, reason: 'disabled' };
    }
    const sessionId = getSessionIdFromLocation();
    if (!sessionId) {
      return { triggered: false, reason: 'no_session' };
    }
    if (sessionId !== autoCompactState.lastSessionId) {
      autoCompactState.lastSessionId = sessionId;
      autoCompactState.armedForSession = false;
      autoCompactState.idleSince = 0;
    }

    const busy = isAssistantBusy();
    if (busy) {
      if (autoCompactState.inFlightSession !== sessionId) {
        autoCompactState.armedForSession = true;
      }
      autoCompactState.idleSince = 0;
      return { triggered: false, reason: 'assistant_busy' };
    }
    if (autoCompactState.inFlightSession === sessionId) {
      autoCompactState.inFlightSession = '';
      autoCompactState.armedForSession = false;
      autoCompactState.idleSince = 0;
      return { triggered: false, reason: 'compact_finished' };
    }

    if (!opts.immediate && !autoCompactState.armedForSession) {
      return { triggered: false, reason: 'not_armed_after_turn' };
    }

    const risk = extractContextRiskState();
    if (!risk.cacheDropDetected && risk.contextUsed < 240000) {
      autoCompactState.idleSince = 0;
      return { triggered: false, reason: 'below_threshold' };
    }

    const ed = getComposerEditor();
    if (!ed || isComposerComposing || !isComposerEmpty(ed)) {
      autoCompactState.idleSince = 0;
      return { triggered: false, reason: 'composer_not_empty' };
    }

    const now = Date.now();
    const prevFired = autoCompactState.lastFiredMap.get(sessionId);
    if (prevFired && (now - prevFired.at < 90000)) {
      return { triggered: false, reason: 'cooldown' };
    }
    if (!opts.immediate) {
      const userMsgs = document.querySelectorAll('[data-testid="user-message"]');
      const lastUserMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;
      const lastUserText = (lastUserMsg?.textContent || '').trim();
      if (lastUserText === '/compact') {
        const assistantMds = getAssistantMarkdownRoots();
        const lastAsst = assistantMds[assistantMds.length - 1];
        if (!lastAsst || (lastAsst.compareDocumentPosition(lastUserMsg) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          return { triggered: false, reason: 'cooldown' };
        }
      }
      if (!autoCompactState.idleSince) {
        autoCompactState.idleSince = now;
        return { triggered: false, reason: 'waiting_idle_stability' };
      }
      if (now - autoCompactState.idleSince < 1800) {
        return { triggered: false, reason: 'waiting_idle_stability' };
      }
    }

    autoCompactState.armedForSession = false;
    autoCompactState.inFlightSession = sessionId;
    autoCompactState.idleSince = 0;
    autoCompactState.lastFiredMap.set(sessionId, {
      at: now,
      contextUsed: risk.contextUsed,
      assistantCount: getAssistantMarkdownRoots().length
    });
    void performMobileAction({ action: 'send', text: '/compact' });
    const kVal = Math.round(risk.contextUsed / 1000);
    const noticeText = risk.cacheDropDetected
      ? tr(`⚡ 检测到缓存脱落 (${kVal}K)，已自动发送 /compact 压缩防卡死（可在设置关闭）`, `⚡ Cache drop (${kVal}K): auto-sent /compact to prevent stall (toggle in Settings)`)
      : tr(`⚡ 上下文已达 ${kVal}K（超 240K 安全线），已自动发送 /compact 提前压缩（可在设置关闭）`, `⚡ Context reached ${kVal}K (>240K): auto-sent /compact early (toggle in Settings)`);
    showQuickToast(noticeText, 6000);
    return {
      triggered: true,
      reason: risk.cacheDropDetected ? 'cache_drop' : 'threshold_240k',
      contextUsed: risk.contextUsed
    };
  }

  function getAssistantMarkdownRoots() {
    return Array.from(document.querySelectorAll('[data-markdown-root]')).filter((m) => (
      !m.closest('[data-testid="user-message"]') &&
      !m.closest('[data-testid="thinking-collapsible-trigger"]') &&
      !m.parentElement?.previousElementSibling?.matches?.('[data-testid="thinking-collapsible-trigger"]')
    ));
  }

  function isAssistantBusy() {
    if (Date.now() - lastUserSubmitAt < 2500) return true;
    const cancelBtn =
      document.querySelector('.surface-composer [data-testid="input-cancel-button"]') ||
      document.querySelector('[data-testid="input-cancel-button"]');
    if (cancelBtn && cancelBtn.offsetWidth > 0 && !cancelBtn.disabled) {
      return true;
    }
    const thinkingTriggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
    for (const trigger of thinkingTriggers) {
      const text = (trigger.textContent || '').trim();
      if (/^(?:Thinking|思考中)/i.test(text)) return true;
    }
    const userMsgs = document.querySelectorAll('[data-testid="user-message"]');
    if (userMsgs.length > 0) {
      const lastUser = userMsgs[userMsgs.length - 1];
      const assistantMds = getAssistantMarkdownRoots();
      const lastAsst = assistantMds[assistantMds.length - 1];
      if (!lastAsst || (lastAsst.compareDocumentPosition(lastUser) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return true;
      }
    }
    return false;
  }

  function truncateNextStepText(text, maxChars = 8) {
    const str = String(text || '');
    const chars = Array.from(str);
    if (chars.length <= maxChars) return str;
    return `${chars.slice(0, maxChars).join('')}..`;
  }

  function hideNextStepTooltip() {
    const tip = document.getElementById(NEXT_STEP_TOOLTIP_ID);
    if (tip) tip.hidden = true;
  }

  function showNextStepTooltip(anchorBtn) {
    if (disposed || !anchorBtn) return;
    const fullText = anchorBtn.getAttribute('data-full-text') || '';
    if (!fullText) {
      hideNextStepTooltip();
      return;
    }
    ensureDocStyle();
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    let tip = document.getElementById(NEXT_STEP_TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = NEXT_STEP_TOOLTIP_ID;
      tip.setAttribute('role', 'tooltip');
      (document.body || document.documentElement)?.appendChild(tip);
    }
    tip.setAttribute('data-ag-theme', theme);
    tip.textContent = fullText;
    tip.hidden = false;

    try {
      if (typeof anchorBtn.getBoundingClientRect === 'function') {
        const rect = anchorBtn.getBoundingClientRect();
        const vw = window.innerWidth || 1280;
        const tipW = Math.min(360, vw - 24);
        const tipH = tip.offsetHeight || 32;
        const left = Math.max(12, Math.min(vw - tipW - 12, Math.round(rect.left || 12)));
        const top = Math.max(8, Math.round((rect.top || 48) - tipH - 6));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
      }
    } catch {}
  }

  function computeNextStepCandidatesFromText(sessionId, rawText, contextPercent = 0, stepCount = 0) {
    const fullText = String(rawText || '').trim();
    const sig = `${sessionId}|${stepCount}|${fullText.length}|${fullText.slice(-80)}`;
    const recent = fullText.slice(-700);
    const tail = fullText.slice(-180);
    const list = [];
    const addCandidate = (txt) => {
      if (txt && !list.includes(txt)) list.push(txt);
    };

    if (!fullText) {
      addCandidate('先帮我梳理下当前任务并给出方案');
      addCandidate('/plan ');
      addCandidate('重新读取 AGENTS');
      return { sig, candidates: list };
    }

    const asksConfirm = /(?:请确认|是否确认|是否合适|确认后|是否继续|你倾向于|请选择|方案\s*[A-Z1-9]|选项\s*[A-Z1-9])/i.test(recent);
    const hasRecommend = /(?:推荐|方案\s*[A1](?!\d))/.test(recent);
    const asksQuestion = /[？?]\s*$/.test(tail);
    const hasUnnegatedError = (txt) => {
      if (!txt || /(?:已修复|验证通过|PASSED|0\s*failed)/i.test(tail)) return false;
      const re = /(?:报错|失败|异常|未通过|Error:|Exception|exited with code [1-9])/gi;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const before = txt.slice(Math.max(0, m.index - 4), m.index);
        if (/(?:不|无|没有|未见|未发现|未|零|0\s*|避免|防止|防|非)$/.test(before)) continue;
        return true;
      }
      return false;
    };
    const hasError = hasUnnegatedError(recent);
    const hasDoneOrPushed = /(?:已提交|已推送|origin\/main|commit\s+[0-9a-f]{6,}|验证通过|全部组件显示\s*✅|PASSED)/i.test(recent);
    const mentionsCodeChange = /(?:已修改|已新增|已修复|文件修改|函数|补丁|\.(?:js|ts|tsx|py|sh|md|json)\b)/i.test(recent);

    if (asksConfirm) {
      if (hasRecommend) addCandidate('确认，按推荐方案执行');
      addCandidate('确认，直接按这个方案落地');
      addCandidate('先微调一下方案细节：');
    } else if (asksQuestion) {
      addCandidate('好，就按你说的执行');
    }

    if (hasError) {
      addCandidate('分析报错原因并直接修复');
      addCandidate('贴一下关键报错原因并给出修复方案');
    }

    if (mentionsCodeChange && !hasDoneOrPushed) {
      addCandidate('运行测试验证，通过后提交并推送');
      addCandidate('先跑一遍实测看看效果');
    }

    if (hasDoneOrPushed) {
      addCandidate('检查还有没有遗漏的边界情况');
      addCandidate('继续处理下一个问题');
    }

    const risk = extractContextRiskState();
    if (risk.cacheDropDetected || risk.contextUsed >= 328000) {
      const existingIdx = list.indexOf('/compact');
      if (existingIdx >= 0) list.splice(existingIdx, 1);
      list.unshift('/compact');
    } else if (risk.contextUsed >= 240000 || Math.max(Number(contextPercent) || 0, risk.percent || 0) >= 65) {
      addCandidate('/compact');
    }

    addCandidate('继续下一步');
    addCandidate('展开说说具体细节');

    return { sig, candidates: list.slice(0, 4) };
  }

  function computeNextStepCandidates() {
    const sessionId = getSessionIdFromLocation() || '';
    const assistantMds = getAssistantMarkdownRoots();
    const lastMd = assistantMds[assistantMds.length - 1];
    const fullText = (lastMd?.innerText || '').trim();
    return computeNextStepCandidatesFromText(sessionId, fullText, extractContextPercent(), assistantMds.length);
  }

  function hideNextStepGhost() {
    nextStepState.visible = false;
    hideNextStepTooltip();
    const ghost = document.getElementById(NEXT_STEP_GHOST_ID);
    if (ghost) ghost.hidden = true;
    document.querySelectorAll('[data-ag-has-ghost="1"]').forEach((el) => {
      el.removeAttribute('data-ag-has-ghost');
    });
  }

  function ensureNextStepGhost() {
    if (disposed || !ghostSuggestEnabled || featureFlags.showQuickBar === false) {
      hideNextStepGhost();
      return;
    }
    const ed = getComposerEditor();
    if (!ed || isAssistantBusy()) {
      hideNextStepGhost();
      return;
    }

    ensureQuickCapsuleBar();
    const rightSlot = document.getElementById(QUICK_RIGHT_SLOT_ID);
    if (!rightSlot) {
      hideNextStepGhost();
      return;
    }

    const { sig, candidates } = computeNextStepCandidates();
    if (sig !== nextStepState.replySig) {
      nextStepState.replySig = sig;
      nextStepState.candidates = candidates;
      nextStepState.index = 0;
      nextStepState.dismissedSig = '';
    } else {
      nextStepState.candidates = candidates;
      if (nextStepState.index >= candidates.length) nextStepState.index = 0;
    }

    const shouldShow = (
      !isComposerComposing &&
      !isAssistantBusy() &&
      candidates.length > 0 &&
      nextStepState.dismissedSig !== sig &&
      ed.getAttribute('aria-expanded') !== 'true' &&
      isComposerEmpty(ed)
    );

    if (!shouldShow) {
      hideNextStepGhost();
      return;
    }

    ensureDocStyle();
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    let ghost = document.getElementById(NEXT_STEP_GHOST_ID);
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.id = NEXT_STEP_GHOST_ID;

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'ag-qcap-btn ag-ns-accept ag-ns-tab';

      const textSpan = document.createElement('span');
      textSpan.className = 'ag-ns-text';

      const kbdSpan = document.createElement('span');
      kbdSpan.className = 'ag-ns-kbd-tag';
      kbdSpan.textContent = tr('Tab / → 补全', 'Tab / →');

      tabBtn.appendChild(textSpan);
      tabBtn.appendChild(kbdSpan);
      tabBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      tabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void acceptNextStepSuggestion();
      });
      tabBtn.addEventListener('mouseenter', () => {
        showNextStepTooltip(tabBtn);
      });
      tabBtn.addEventListener('focus', () => {
        showNextStepTooltip(tabBtn);
      });
      tabBtn.addEventListener('mouseleave', () => {
        hideNextStepTooltip();
      });
      tabBtn.addEventListener('blur', () => {
        hideNextStepTooltip();
      });

      const cycleBtn = document.createElement('button');
      cycleBtn.type = 'button';
      cycleBtn.className = 'ag-qcap-btn ag-ns-cycle';
      cycleBtn.title = tr('按 ↓ 切换下一条建议', 'Press ↓ to cycle suggestion');
      cycleBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      cycleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cycleNextStepSuggestion(1);
      });

      ghost.appendChild(tabBtn);
      ghost.appendChild(cycleBtn);
    }

    const toastEl = rightSlot.querySelector('.ag-qcap-toast');
    if (ghost.parentElement !== rightSlot) {
      if (toastEl) rightSlot.insertBefore(ghost, toastEl);
      else rightSlot.appendChild(ghost);
    }
    if (ghost.getAttribute('data-ag-theme') !== theme) {
      ghost.setAttribute('data-ag-theme', theme);
    }
    ghost.hidden = false;

    const currentText = candidates[nextStepState.index] || '';
    const displayShort = truncateNextStepText(currentText, 8);
    const tabBtn = ghost.querySelector('.ag-ns-tab');
    const textSpan = ghost.querySelector('.ag-ns-text');
    const cycleBtn = ghost.querySelector('.ag-ns-cycle');
    if (textSpan) {
      const nextDisplay = `💡 ${displayShort}`;
      if (textSpan.textContent !== nextDisplay) textSpan.textContent = nextDisplay;
    }
    if (tabBtn) {
      tabBtn.setAttribute('data-full-text', currentText);
      tabBtn.setAttribute('data-truncated', displayShort !== currentText ? 'true' : 'false');
      tabBtn.title = `${currentText}（${tr('点击或按 Tab / → 填入输入框', 'Click or press Tab / → to insert')}）`;
    }
    if (cycleBtn) {
      if (candidates.length > 1) {
        cycleBtn.hidden = false;
        cycleBtn.textContent = `↓ ${nextStepState.index + 1}/${candidates.length}`;
      } else {
        cycleBtn.hidden = true;
      }
    }

    nextStepState.visible = true;
  }

  function cycleNextStepSuggestion(step = 1) {
    const len = nextStepState.candidates.length;
    if (len <= 1) return false;
    nextStepState.index = (nextStepState.index + step + len) % len;
    ensureNextStepGhost();
    return true;
  }

  async function acceptNextStepSuggestion() {
    const text = nextStepState.candidates[nextStepState.index];
    if (!text) return false;
    hideNextStepGhost();
    const ok = await fillComposerText(text);
    if (ok) {
      showQuickToast(tr('✨ 已补全建议，按回车即可发送', '✨ Suggestion inserted'));
    }
    ensureNextStepGhost();
    return ok;
  }

  // ==================== 输入框免 CLI 提示词优化 ====================

  function buildPromptOptimizeInstruction(draftText) {
    return [
      '你是一位精通 Google Cloud 提示工程（Prompt Engineering）原则的提示词优化专家。',
      '你的唯一任务是将 <draft> 标签内的用户原始提示词草稿，改写并优化为更清晰、具体、高质量的提示词，供软件工程与通用 AI 助手直接执行。',
      '',
      '请严格遵循以下提示工程准则：',
      '1. 明确任务与具体性（Clarity & Specificity）：消除口语化模糊表达与指代不明，使用清晰的动作动词界定核心目标。',
      '2. 语境与角色定位（Context & Persona）：根据任务性质自然提炼所需专业视角与作用范围；严禁编造草稿中未提及的业务事实、文件路径、接口名或参数。',
      '3. 复杂任务分步拆解（Step-by-Step Breakdown）：若原草稿包含多个需求或复杂目标，拆解为逻辑清晰的有序步骤；若原草稿只是简单直接的单步指令，则保持精炼紧凑，不要强行扩写成冗长模板。',
      '4. 明确边界与输出格式（Constraints & Output Format）：按需补充合理的边界约束、验收标准或期望的输出结构。',
      '5. 格式与标识符保真（Strict Preservation）：',
      '   - 保持与原草稿一致的自然语言（中文输入则输出中文，英文输入则输出英文）；',
      '   - 原样保留草稿中的所有文件路径、代码片段、变量/函数名、URL 与 @ 引用。',
      '',
      '重要限制：不要回答、执行或解释 <draft> 中的问题！只直接输出优化后的提示词正文，不要包含任何开场白、解释说明、引号或外层代码块包裹。',
      '',
      '<draft>',
      String(draftText || '').trim(),
      '</draft>'
    ].join('\n');
  }

  function cleanOptimizedPromptOutput(raw, slashPrefix = '') {
    let out = String(raw || '').trim();
    out = out.replace(/^<draft>\s*/i, '').replace(/\s*<\/draft>$/i, '').trim();
    const fenceMatch = out.match(/^```(?:markdown|md|text|txt|prompt)?\r?\n([\s\S]*?)\r?\n```$/i);
    if (fenceMatch) {
      out = fenceMatch[1].trim();
    }
    if (slashPrefix && out) {
      const cleanPrefix = slashPrefix.trim();
      const escapedPrefix = cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`^${escapedPrefix}\\s*`), '').trim();
      return `${cleanPrefix} ${out}`;
    }
    return out;
  }

  function resolveLanguageServerCsrfToken() {
    const direct = String(window.__APP_CONFIG__?.csrfToken || '').trim();
    if (direct) return direct;
    try {
      const scripts = document.querySelectorAll?.('script') || [];
      for (const s of scripts) {
        const txt = String(s?.textContent || '');
        if (!txt.includes('__APP_CONFIG__')) continue;
        const m = txt.match(/__APP_CONFIG__\s*=\s*(\{[\s\S]*?\});/);
        if (m) {
          const parsed = JSON.parse(m[1]);
          if (parsed?.csrfToken) return String(parsed.csrfToken).trim();
        }
      }
    } catch {}
    return '';
  }

  async function parseLanguageServerError(resp) {
    const status = Number(resp?.status || 0);
    let rawText = '';
    let parsed = null;
    try {
      if (typeof resp?.text === 'function') {
        rawText = String(await resp.text() || '').trim();
        if (rawText) {
          try { parsed = JSON.parse(rawText); } catch {}
        }
      } else if (typeof resp?.json === 'function') {
        parsed = await resp.json().catch(() => null);
        if (parsed && typeof parsed === 'object') {
          rawText = JSON.stringify(parsed);
        }
      }
    } catch {}
    const code = String(parsed?.code || parsed?.error?.code || '').trim();
    const msg = String(
      parsed?.message
      || parsed?.error?.message
      || (typeof parsed?.error === 'string' ? parsed.error : '')
      || parsed?.detail
      || ''
    ).trim();
    const parts = [`HTTP ${status || 'ERR'}`];
    if (code) parts.push(`(${code})`);
    const detail = msg || (rawText && !rawText.startsWith('<') ? rawText.slice(0, 240) : '');
    const message = detail ? `${parts.join(' ')}: ${detail}` : parts.join(' ');
    return { status, code, detail, rawText: rawText.slice(0, 400), message };
  }

  async function resolveDefaultModelForOptimize(signal) {
    if (
      promptOptState.cacheModel.primary
      && Array.isArray(promptOptState.cacheModel.candidates)
      && promptOptState.cacheModel.candidates.length > 0
      && (Date.now() - promptOptState.cacheModel.fetchedAt) < 60000
    ) {
      return promptOptState.cacheModel;
    }
    const csrf = resolveLanguageServerCsrfToken();
    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    };
    if (csrf) headers['x-codeium-csrf-token'] = csrf;
    const resp = await fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
      method: 'POST',
      headers,
      body: '{}',
      signal
    });
    if (!resp.ok) {
      const parsedErr = await parseLanguageServerError(resp);
      const err = new Error(parsedErr.message);
      err.status = parsedErr.status;
      err.rawBody = parsedErr.rawText;
      throw err;
    }
    const payload = await resp.json();
    const cfgData = payload?.userStatus?.cascadeModelConfigData;
    if (cfgData) cacheDefaultModelFromConfigData(cfgData);
    return promptOptState.cacheModel;
  }

  function clearPromptOptUndoState({ clearHint = true } = {}) {
    promptOptState.canUndo = false;
    promptOptState.backupText = '';
    promptOptState.optimizedText = '';
    promptOptState.undoHintActive = false;
    if (clearHint) hideQuickToast('prompt-opt-undo');
  }

  function syncPromptOptimizerUI() {
    const btn = document.getElementById(PROMPT_OPT_BTN_ID);
    const undoBtn = document.getElementById(PROMPT_OPT_UNDO_ID);
    const wrap = document.getElementById(PROMPT_OPT_WRAP_ID);
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    if (wrap && wrap.getAttribute('data-ag-theme') !== theme) {
      wrap.setAttribute('data-ag-theme', theme);
    }

    const ed = getComposerEditor();
    const curText = ed ? getComposerText(ed) : '';
    const hasText = curText.trim().length > 0;
    if (!hasText && !promptOptState.loading) {
      clearPromptOptUndoState();
    } else if (promptOptState.undoHintActive && !promptOptState.loading && curText !== promptOptState.optimizedText) {
      promptOptState.undoHintActive = false;
      promptOptState.optimizedText = '';
      hideQuickToast('prompt-opt-undo');
    }

    if (btn) {
      if (promptOptState.loading) {
        btn.disabled = false;
        btn.setAttribute('data-loading', 'true');
        btn.innerHTML = `<span class="ag-opt-spin"></span><span>${tr('优化中…', 'Optimizing…')}</span>`;
        btn.title = tr('正在优化提示词，点击可立即取消', 'Optimizing prompt, click to cancel');
      } else {
        btn.removeAttribute('data-loading');
        btn.disabled = !hasText;
        btn.innerHTML = `${PROMPT_OPT_SPARKLE_SVG}<span>${tr('优化', 'Optimize')}</span>`;
        btn.title = hasText
          ? tr('优先使用轻量快速模型优化输入框内的提示词（支持多模型自动回退）', 'Optimize prompt using a fast lightweight model with automatic fallback')
          : tr('先输入提示词草稿，点击快速优化', 'Enter a prompt draft first');
      }
    }

    if (undoBtn) {
      undoBtn.hidden = !(promptOptState.canUndo && !promptOptState.loading && hasText && promptOptState.backupText);
      undoBtn.innerHTML = `${PROMPT_OPT_UNDO_SVG}<span>${tr('撤回', 'Undo')}</span>`;
      undoBtn.title = tr('撤回优化，恢复原始草稿', 'Undo optimization and restore original draft');
    }
  }

  function ensurePromptOptimizerControls() {
    if (disposed) return;
    ensureDocStyle();
    const composer = document.querySelector('.surface-composer');
    if (!composer) return;
    const footer = composer.querySelector('.agy-composer-footer') || document.querySelector('.agy-composer-footer');
    if (!footer) return;

    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    const mountParent = footer.parentElement || composer;

    let wrap = document.getElementById(PROMPT_OPT_WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = PROMPT_OPT_WRAP_ID;
      wrap.className = 'ag-prompt-opt-wrap';

      const optBtn = document.createElement('button');
      optBtn.id = PROMPT_OPT_BTN_ID;
      optBtn.type = 'button';
      optBtn.className = 'ag-prompt-opt-btn';
      optBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      optBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void optimizeComposerPrompt();
      });

      const undoBtn = document.createElement('button');
      undoBtn.id = PROMPT_OPT_UNDO_ID;
      undoBtn.type = 'button';
      undoBtn.className = 'ag-prompt-undo-btn';
      undoBtn.hidden = true;
      undoBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      undoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void undoPromptOptimize();
      });

      wrap.appendChild(optBtn);
      wrap.appendChild(undoBtn);
    }

    if (wrap.getAttribute('data-ag-theme') !== theme) {
      wrap.setAttribute('data-ag-theme', theme);
    }
    if (wrap.getAttribute('data-position') !== 'above-send') {
      wrap.setAttribute('data-position', 'above-send');
    }

    if (wrap.parentElement !== mountParent || wrap.nextElementSibling !== footer) {
      mountParent.insertBefore(wrap, footer);
    }

    try {
      const sendBtn = footer.querySelector(
        '[data-testid="input-send-button"], [data-testid="send-button"], .agy-send-button, button[aria-label*="Send"], button[aria-label*="发送"], [data-testid="input-cancel-button"]'
      ) || footer.querySelector('button:last-of-type');
      if (sendBtn && typeof mountParent.getBoundingClientRect === 'function' && typeof sendBtn.getBoundingClientRect === 'function') {
        const pRect = mountParent.getBoundingClientRect();
        const sRect = sendBtn.getBoundingClientRect();
        if (pRect && sRect && pRect.width > 0 && sRect.width > 0 && pRect.right >= sRect.right) {
          const rightOffset = Math.max(8, Math.min(48, Math.round(pRect.right - sRect.right)));
          wrap.style.paddingRight = `${rightOffset}px`;
        }
      }
    } catch {}

    syncPromptOptimizerUI();
  }

  async function undoPromptOptimize() {
    if (!promptOptState.canUndo || !promptOptState.backupText || promptOptState.loading) return false;
    const orig = promptOptState.backupText;
    clearPromptOptUndoState();
    const ok = await fillComposerText(orig);
    syncPromptOptimizerUI();
    if (ok) showQuickToast(tr('↩ 已恢复原始提示词', '↩ Restored original draft'));
    return ok;
  }

  async function optimizeComposerPrompt() {
    if (promptOptState.loading) {
      promptOptState.userCancelled = true;
      if (promptOptState.abortCtrl) {
        try { promptOptState.abortCtrl.abort(); } catch {}
      }
      promptOptState.loading = false;
      promptOptState.abortCtrl = null;
      syncPromptOptimizerUI();
      showQuickToast(tr('已取消提示词优化', 'Prompt optimization cancelled'));
      return { ok: false, cancelled: true };
    }

    const ed = getComposerEditor();
    const rawText = getComposerText(ed);
    const trimmed = rawText.trim();
    if (!trimmed) {
      showQuickToast(tr('先输入提示词草稿，再点击优化', 'Enter a prompt draft first'));
      syncPromptOptimizerUI();
      return { ok: false, error: 'empty' };
    }

    let slashPrefix = '';
    let draftBody = trimmed;
    const slashMatch = trimmed.match(/^(\/[a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      slashPrefix = slashMatch[1];
      draftBody = (slashMatch[2] || '').trim();
      if (!draftBody) {
        showQuickToast(tr('当前仅包含斜杠命令，无需优化', 'Only slash command present'));
        return { ok: false, error: 'slash-only' };
      }
    }

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let overallTimedOut = false;
    const timeoutId = ctrl ? setTimeout(() => {
      overallTimedOut = true;
      try { ctrl.abort(); } catch {}
    }, 45000) : null;
    promptOptState.loading = true;
    promptOptState.abortCtrl = ctrl;
    promptOptState.userCancelled = false;
    promptOptState.undoHintActive = false;
    promptOptState.optimizedText = '';
    hideQuickToast('prompt-opt-undo');
    syncPromptOptimizerUI();

    const attempts = [];
    const csrf = resolveLanguageServerCsrfToken();

    try {
      const modelInfo = await resolveDefaultModelForOptimize(ctrl ? ctrl.signal : undefined);
      const rawCandidates = Array.isArray(modelInfo?.candidates) && modelInfo.candidates.length > 0
        ? modelInfo.candidates
        : [modelInfo?.primary, modelInfo?.fallback]
            .filter(Boolean)
            .map((m) => ({ model: m, label: m, modelId: '' }));
      const candidates = [];
      const seenModels = new Set();
      for (const c of rawCandidates) {
        const modelEnum = String(c?.model || '').trim();
        if (!modelEnum || seenModels.has(modelEnum)) continue;
        seenModels.add(modelEnum);
        candidates.push({
          model: modelEnum,
          label: String(c?.label || c?.modelId || modelEnum),
          modelId: String(c?.modelId || '')
        });
      }
      if (!candidates.length) {
        throw new Error(tr('未能读取可用模型列表', 'Failed to resolve available models'));
      }

      const effCsrf = resolveLanguageServerCsrfToken() || csrf;
      const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      };
      if (effCsrf) headers['x-codeium-csrf-token'] = effCsrf;
      const prompt = buildPromptOptimizeInstruction(draftBody);

      const callGenerate = async (modelEnum, hasMoreFallbacks) => {
        const canSubAbort = typeof AbortController === 'function' && hasMoreFallbacks;
        const attemptCtrl = canSubAbort ? new AbortController() : null;
        let attemptTimedOut = false;
        let onOverallAbort = null;
        let attemptTimer = null;
        if (attemptCtrl) {
          if (ctrl?.signal) {
            if (ctrl.signal.aborted) {
              attemptCtrl.abort();
            } else {
              onOverallAbort = () => { try { attemptCtrl.abort(); } catch {} };
              ctrl.signal.addEventListener('abort', onOverallAbort, { once: true });
            }
          }
          attemptTimer = setTimeout(() => {
            attemptTimedOut = true;
            try { attemptCtrl.abort(); } catch {}
          }, 18000);
        }
        try {
          const resp = await fetch('/exa.language_server_pb.LanguageServerService/GetModelResponse', {
            method: 'POST',
            headers,
            body: JSON.stringify({ prompt, model: modelEnum }),
            signal: attemptCtrl ? attemptCtrl.signal : (ctrl ? ctrl.signal : undefined)
          });
          if (!resp.ok) {
            const parsedErr = await parseLanguageServerError(resp);
            const err = new Error(parsedErr.message);
            err.status = parsedErr.status;
            err.code = parsedErr.code;
            err.rawBody = parsedErr.rawText;
            throw err;
          }
          return await resp.json();
        } catch (err) {
          if (attemptTimedOut && !promptOptState.userCancelled && !overallTimedOut) {
            const te = new Error(tr('单次响应超时 (18s)', 'Model timed out (18s)'));
            te.status = 408;
            te.isAttemptTimeout = true;
            throw te;
          }
          throw err;
        } finally {
          if (attemptTimer) clearTimeout(attemptTimer);
          if (onOverallAbort && ctrl?.signal) {
            try { ctrl.signal.removeEventListener('abort', onOverallAbort); } catch {}
          }
        }
      };

      let optimized = '';
      let usedCandidate = null;

      for (let i = 0; i < candidates.length; i++) {
        if (promptOptState.userCancelled || promptOptState.abortCtrl !== ctrl || overallTimedOut) break;
        const cand = candidates[i];
        const hasMoreFallbacks = i < candidates.length - 1;
        try {
          const resPayload = await callGenerate(cand.model, hasMoreFallbacks);
          if (promptOptState.userCancelled || promptOptState.abortCtrl !== ctrl) {
            return { ok: false, cancelled: true };
          }
          const cleaned = cleanOptimizedPromptOutput(resPayload?.response || '', slashPrefix);
          if (!cleaned) {
            const emptyErr = new Error(tr('模型未返回有效优化文本', 'Empty model response'));
            emptyErr.status = 200;
            throw emptyErr;
          }
          optimized = cleaned;
          usedCandidate = cand;
          break;
        } catch (err) {
          const isUserAbort = promptOptState.userCancelled || promptOptState.abortCtrl !== ctrl;
          if (isUserAbort) return { ok: false, cancelled: true };
          const isOverallAbort = overallTimedOut && (err?.name === 'AbortError' || ctrl?.signal?.aborted);
          attempts.push({
            model: cand.model,
            label: cand.label,
            status: Number(err?.status || 0),
            error: isOverallAbort ? tr('请求超时 (45s)', 'Request timed out (45s)') : String(err?.message || 'failed'),
            rawBody: String(err?.rawBody || '')
          });
          if (isOverallAbort) break;
          if (err?.status === 401 || err?.status === 403) break;
        }
      }

      if (promptOptState.userCancelled || promptOptState.abortCtrl !== ctrl) {
        return { ok: false, cancelled: true };
      }

      if (!optimized || !usedCandidate) {
        const lastAttempt = attempts[attempts.length - 1];
        const summary = lastAttempt
          ? `${lastAttempt.error}${attempts.length > 1 ? tr(`（已尝试 ${attempts.length} 个模型）`, ` (${attempts.length} models tried)`) : ''}`
          : (overallTimedOut ? tr('请求超时 (45s)', 'Request timed out (45s)') : tr('请稍后重试', 'Please retry'));
        const detail = attempts.length > 0
          ? attempts.map((a) => `${a.label || a.model}: ${a.error}`).join(' | ')
          : summary;
        const failErr = new Error(summary);
        failErr.detail = detail;
        throw failErr;
      }

      promptOptState.lastError = null;
      promptOptState.backupText = rawText;
      promptOptState.canUndo = true;
      promptOptState.loading = false;
      promptOptState.abortCtrl = null;

      const filled = await fillComposerText(optimized);
      if (filled) {
        const curEd = getComposerEditor();
        promptOptState.optimizedText = curEd ? getComposerText(curEd) : optimized;
        promptOptState.undoHintActive = true;
      } else {
        promptOptState.optimizedText = '';
        promptOptState.undoHintActive = false;
      }
      syncPromptOptimizerUI();
      if (filled) {
        showQuickToast(
          tr('✨ 提示词已优化（可点击 ↩ 撤回）', '✨ Prompt optimized (click ↩ Undo to revert)'),
          { persistent: true, tag: 'prompt-opt-undo' }
        );
      }
      return { ok: filled, text: optimized, model: usedCandidate.model, attempts };
    } catch (err) {
      const isUserCancel = Boolean(promptOptState.userCancelled);
      const isTimeoutAbort = !isUserCancel && overallTimedOut;
      const isSilentAbort = isUserCancel || (!isTimeoutAbort && (err?.name === 'AbortError' || ctrl?.signal?.aborted));
      const errMsg = isTimeoutAbort
        ? tr('请求超时 (45s)，请稍后重试', 'Request timed out (45s)')
        : String(err?.message || tr('请稍后重试', 'Please retry'));
      const fullDetail = String(err?.detail || errMsg);

      promptOptState.loading = false;
      promptOptState.abortCtrl = null;
      syncPromptOptimizerUI();

      if (!isSilentAbort) {
        promptOptState.lastError = {
          at: Date.now(),
          pathname: String(globalThis.location?.pathname || ''),
          hasCsrf: Boolean(resolveLanguageServerCsrfToken() || csrf),
          message: errMsg,
          detail: fullDetail,
          attempts
        };
        try { console.warn('[AG-Enhancer] 提示词优化失败:', promptOptState.lastError); } catch {}
        const toastMsg = tr(`优化失败：${errMsg}`, `Optimize failed: ${errMsg}`);
        showQuickToast(toastMsg, {
          isError: true,
          durationMs: 7000,
          title: tr(`优化失败详情：${fullDetail}`, `Optimize error details: ${fullDetail}`)
        });
      }
      return {
        ok: false,
        cancelled: isSilentAbort,
        error: errMsg,
        detail: fullDetail,
        attempts
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (promptOptState.abortCtrl === ctrl) {
        promptOptState.loading = false;
        promptOptState.abortCtrl = null;
        syncPromptOptimizerUI();
      }
    }
  }

  // ==================== 思考过程与侧边栏中文化 ====================

  const thoughtZhCache = new Map();
  const sidebarZhCache = new Map();
  const sidebarPendingIds = new Set();
  const sidebarRawTitleMap = new Map();
  const sidebarUserRenamedIds = new Set();
  let localizeTimer = null;
  let localizeMutationObserver = null;
  let thinkingShellTimerRunning = false;
  let thinkingReRunNeeded = false;
  let lastThinkingCascadeId = '';
  const keepExpandedThinkingKeys = new Set();
  const userCollapsedThinkingKeys = new Set();
  const thinkingScrollTopMap = new Map();
  const thinkingReexpandCooldown = new Map();
  let guardingThinking = false;

  function findThinkingFiberNode(trigger) {
    if (!trigger) return null;
    try {
      const fiberKey = Object.keys(trigger).find((k) => k.startsWith('__reactFiber$'));
      let f = fiberKey ? trigger[fiberKey] : null;
      for (let i = 0; i < 8 && f; i++) {
        const p = f.memoizedProps;
        if (p && 'isActive' in p && 'autoScroll' in p && 'trigger' in p) {
          return f;
        }
        f = f.return;
      }
    } catch {}
    return null;
  }

  function getThinkingTriggerKey(trigger) {
    if (!trigger) return '';
    try {
      const fiberKey = Object.keys(trigger).find((k) => k.startsWith('__reactFiber$'));
      let f = fiberKey ? trigger[fiberKey] : null;
      for (let i = 0; i < 14 && f; i++) {
        const p = f.memoizedProps;
        if (p) {
          const metaIdx = p.metadata?.sourceTrajectoryStepInfo?.stepIndex;
          if (metaIdx !== undefined && metaIdx !== null) return `step:${metaIdx}`;
          if (p.stepIndex !== undefined && p.stepIndex !== null) return `step:${p.stepIndex}`;
        }
        f = f.return;
      }
    } catch {}
    return trigger.id ? `id:${trigger.id}` : '';
  }

  function resetThinkingPrevActiveHook(fiber) {
    if (!fiber) return false;
    try {
      const h0 = fiber.memoizedState;
      const h1 = h0?.next;
      const h2 = h1?.next;
      if (!h0 || !h2 || !h2.queue) return false;
      if (h0.memoizedState === true && h2.memoizedState === true) {
        h2.memoizedState = false;
        h2.baseState = false;
        return true;
      }
    } catch {}
    return false;
  }

  function disarmThinkingAutoCollapse(trigger) {
    const f = findThinkingFiberNode(trigger);
    if (!f) return false;
    let changed = resetThinkingPrevActiveHook(f);
    if (f.alternate) {
      changed = resetThinkingPrevActiveHook(f.alternate) || changed;
    }
    return changed;
  }

  function applyCachedThoughtsSync(container) {
    if (!container) return 0;
    let restored = 0;
    const roots = container.querySelectorAll('[data-markdown-root]');
    for (const root of roots) {
      const blocks = root.querySelectorAll('p, li');
      for (const el of blocks) {
        if (el.querySelector('p, li, ul, ol')) continue;
        const curText = (el.textContent || '').trim();
        if (!curText) continue;
        const cached = thoughtZhCache.get(curText);
        if (cached) {
          applyThoughtTranslation(el, curText, cached);
          restored++;
        }
      }
    }
    return restored;
  }

  function bindThinkingScrollRecorder(trigger, key) {
    if (!trigger || !key) return;
    const scrollBox = trigger.nextElementSibling;
    if (!scrollBox || scrollBox.dataset.agScrollBound === key) return;
    scrollBox.dataset.agScrollBound = key;
    scrollBox.addEventListener('scroll', () => {
      if (disposed) return;
      thinkingScrollTopMap.set(key, scrollBox.scrollTop);
    }, { passive: true });
  }

  function guardExpandedThinkingBlocks() {
    if (disposed || guardingThinking) return 0;
    guardingThinking = true;
    try {
      const curCascadeId = getSessionIdFromLocation() || '';
      if (curCascadeId !== lastThinkingCascadeId) {
        lastThinkingCascadeId = curCascadeId;
        keepExpandedThinkingKeys.clear();
        userCollapsedThinkingKeys.clear();
        thinkingScrollTopMap.clear();
        thinkingReexpandCooldown.clear();
      }
      const triggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
      const now = Date.now();
      let restoredCount = 0;
      for (const trigger of triggers) {
        const key = getThinkingTriggerKey(trigger);
        if (!key) continue;
        const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
          if (!userCollapsedThinkingKeys.has(key)) {
            keepExpandedThinkingKeys.add(key);
            disarmThinkingAutoCollapse(trigger);
            bindThinkingScrollRecorder(trigger, key);
          }
          continue;
        }
        if (keepExpandedThinkingKeys.has(key) && !userCollapsedThinkingKeys.has(key)) {
          const lastAttempt = thinkingReexpandCooldown.get(key) || 0;
          if (now - lastAttempt < 120) continue;
          thinkingReexpandCooldown.set(key, now);
          trigger.click();
          restoredCount++;
          requestAnimationFrame(() => {
            if (disposed) return;
            disarmThinkingAutoCollapse(trigger);
            bindThinkingScrollRecorder(trigger, key);
            if (trigger.parentElement) applyCachedThoughtsSync(trigger.parentElement);
            const savedTop = thinkingScrollTopMap.get(key);
            const scrollBox = trigger.nextElementSibling;
            if (scrollBox && typeof savedTop === 'number' && savedTop > 0) {
              scrollBox.scrollTop = savedTop;
            }
            localizeThinkingShells();
            void translateExpandedThoughts();
          });
        }
      }
      if (restoredCount > 0) updateThinkToggleLabel();
      return restoredCount;
    } finally {
      guardingThinking = false;
    }
  }

  async function postToLiveHost(route, payload) {
    const live = window.__AGContextMeterLive;
    if (!live?.port || !live?.token) return null;
    try {
      const resp = await fetch(`http://127.0.0.1:${live.port}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AG-Context-Token': live.token
        },
        body: JSON.stringify(payload || {})
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (route === '/remote-info' && data && data.disabled) return data;
      return (data && typeof data === 'object') ? data : null;
    } catch {
      return null;
    }
  }

  function translateThinkingShellText(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    let m;
    if ((m = trimmed.match(/^Thought for (\d+(?:\.\d+)?)s$/))) {
      return raw.replace(trimmed, `已思考 ${m[1]} 秒`);
    }
    if ((m = trimmed.match(/^Thinking for (\d+(?:\.\d+)?)s$/))) {
      return raw.replace(trimmed, `思考中 (${m[1]} 秒)`);
    }
    if ((m = trimmed.match(/^Thinking(\.{0,3})$/))) {
      return raw.replace(trimmed, `思考中${m[1]}`);
    }
    if (trimmed === 'Thought Process') {
      return raw.replace(trimmed, '思考过程');
    }
    return null;
  }

  function revertThinkingShellText(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    let m;
    if ((m = trimmed.match(/^已思考\s*(\d+(?:\.\d+)?)\s*秒$/))) {
      return raw.replace(trimmed, `Thought for ${m[1]}s`);
    }
    if ((m = trimmed.match(/^思考中\s*\(\s*(\d+(?:\.\d+)?)\s*秒\s*\)$/))) {
      return raw.replace(trimmed, `Thinking for ${m[1]}s`);
    }
    if ((m = trimmed.match(/^思考中(\.{0,3})$/))) {
      return raw.replace(trimmed, `Thinking${m[1]}`);
    }
    if (trimmed === '思考过程') {
      return raw.replace(trimmed, 'Thought Process');
    }
    return null;
  }

  function revertEnhancerTranslations() {
    let reverted = 0;
    const triggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
    for (const btn of triggers) {
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const rev = revertThinkingShellText(node.nodeValue);
        if (rev && rev !== node.nodeValue) {
          node.nodeValue = rev;
          reverted++;
        }
      }
    }
    const translatedBlocks = document.querySelectorAll('[data-ag-zh-done="1"]');
    for (const elNode of translatedBlocks) {
      const origSrc = elNode.dataset?.agZhSrc;
      if (origSrc) {
        if (elNode.children?.length > 0) {
          for (const childEl of elNode.children) {
            if (childEl.style?.display === 'none') childEl.style.display = '';
          }
        }
        updateSingleTextSafely(elNode, origSrc);
        reverted++;
      }
      elNode.removeAttribute('data-ag-zh-done');
      elNode.removeAttribute('data-ag-zh-pending');
    }
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    for (const row of rows) {
      const span = row.querySelector('span.truncate');
      if (!span) continue;
      const reactTitle = getSidebarReactTitle(span);
      if (reactTitle && (span.textContent || '').trim() !== reactTitle) {
        updateSingleTextSafely(span, reactTitle);
        if (span.getAttribute('title') === reactTitle) span.removeAttribute('title');
        reverted++;
      }
    }
    return reverted;
  }

  function localizeThinkingShells() {
    if (disposed || uiLang !== 'zh') return 0;
    let changedCount = 0;
    const triggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
    for (const btn of triggers) {
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const translated = translateThinkingShellText(node.nodeValue);
        if (translated && translated !== node.nodeValue) {
          node.nodeValue = translated;
          changedCount++;
        }
      }
    }
    return changedCount;
  }

  function updateSingleTextSafely(el, nextText) {
    // 优先复用原有 Text 节点而不增删子节点，防止影响 React 的 DOM diff 引用
    const directTexts = [];
    for (const ch of el.childNodes) {
      if (ch.nodeType === Node.TEXT_NODE) directTexts.push(ch);
    }
    if (el.children.length === 0) {
      if (directTexts.length > 0) {
        directTexts[0].nodeValue = nextText;
        for (let i = 1; i < directTexts.length; i++) {
          directTexts[i].nodeValue = '';
        }
      } else {
        el.textContent = nextText;
      }
      return;
    }

    // 含内联元素（如 code/strong）的段落，先隐藏元素子节点并在保留首个文本节点中写入译文
    if (directTexts.length > 0) {
      for (const childEl of el.children) {
        childEl.style.display = 'none';
      }
      directTexts[0].nodeValue = nextText;
      for (let i = 1; i < directTexts.length; i++) {
        directTexts[i].nodeValue = '';
      }
      return;
    }

    // 若完全无直属文本节点（例如 <li><strong>...</strong></li>），找首个后代文本节点写入并隐藏其余兄弟分支
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const firstDescText = walker.nextNode();
    if (firstDescText) {
      firstDescText.nodeValue = nextText;
      let extra;
      while ((extra = walker.nextNode())) {
        extra.nodeValue = '';
      }
    } else {
      el.textContent = nextText;
    }
  }

  function applyThoughtTranslation(el, rawSrc, zhText) {
    if (!el || !zhText) return;
    el.setAttribute('data-ag-zh-done', '1');
    el.dataset.agZhSrc = rawSrc;
    el.dataset.agZhText = zhText;
    if (!el.title) el.title = rawSrc;
    updateSingleTextSafely(el, zhText);
  }

  function shouldTranslateThoughtElement(text) {
    if (!text || text.length < 8) return false;
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enWords = (text.match(/\b[a-zA-Z]{2,}\b/g) || []).length;
    return zhCount < 2 && enWords >= 3;
  }

  async function translateExpandedThoughts() {
    if (disposed || uiLang !== 'zh') return 0;
    if (thinkingShellTimerRunning) {
      thinkingReRunNeeded = true;
      return 0;
    }
    thinkingShellTimerRunning = true;
    try {
      const triggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
      const candidates = [];
      for (const trigger of triggers) {
        const triggerText = (trigger.textContent || '').trim();
        const isStreaming = /^(Thinking|思考中)/.test(triggerText);
        const container = trigger.parentElement;
        if (!container) continue;
        const roots = container.querySelectorAll('[data-markdown-root]');
        for (const root of roots) {
          const blocks = Array.from(root.querySelectorAll('p, li'));
          for (let idx = 0; idx < blocks.length; idx++) {
            const el = blocks[idx];
            // 仅处理叶子文本块，避免同时覆盖包含子段落的 li
            if (el.querySelector('p, li, ul, ol')) continue;
            if (el.getAttribute('data-ag-zh-pending') === '1') continue;
            // 流式输出中的最后一个含子元素的段落暂缓，防止与流式 Markdown 渲染竞争
            if (isStreaming && idx === blocks.length - 1 && el.children.length > 0) continue;

            const curText = (el.textContent || '').trim();
            if (el.getAttribute('data-ag-zh-done') === '1') {
              const cachedDone = el.dataset.agZhSrc ? thoughtZhCache.get(el.dataset.agZhSrc) : null;
              if (cachedDone && curText === el.dataset.agZhSrc) {
                applyThoughtTranslation(el, el.dataset.agZhSrc, cachedDone);
              }
              continue;
            }

            if (!shouldTranslateThoughtElement(curText)) continue;
            const cached = thoughtZhCache.get(curText);
            if (cached) {
              applyThoughtTranslation(el, curText, cached);
              continue;
            }
            candidates.push({ el, raw: curText });
          }
        }
      }

      if (!candidates.length) return 0;

      const batch = [];
      const uniqueTexts = [];
      const seenTexts = new Set();
      for (const item of candidates) {
        if (!seenTexts.has(item.raw)) {
          if (uniqueTexts.length >= 25) continue;
          seenTexts.add(item.raw);
          uniqueTexts.push(item.raw);
        }
        item.el.setAttribute('data-ag-zh-pending', '1');
        batch.push(item);
      }

      const res = await postToLiveHost('/translate-zh', { texts: uniqueTexts });
      const map = res?.translations || {};
      let updated = 0;
      for (const item of batch) {
        item.el.removeAttribute('data-ag-zh-pending');
        const zh = map[item.raw];
        if (zh) {
          thoughtZhCache.set(item.raw, zh);
          applyThoughtTranslation(item.el, item.raw, zh);
          updated++;
        }
      }

      // 若还有剩余未翻译段落，调度继续翻译
      if (candidates.length > batch.length) {
        scheduleLocalization();
      }
      return updated;
    } finally {
      thinkingShellTimerRunning = false;
      if (thinkingReRunNeeded && !disposed) {
        thinkingReRunNeeded = false;
        setTimeout(() => {
          if (!disposed) void translateExpandedThoughts();
        }, 30);
      }
    }
  }

  function getSidebarReactTitle(span) {
    if (!span) return '';
    try {
      const propKey = Object.keys(span).find((k) => k.startsWith('__reactProps$'));
      if (propKey && typeof span[propKey]?.children === 'string') {
        const raw = span[propKey].children.trim();
        if (raw) return raw;
      }
    } catch {}
    return (span.textContent || '').trim();
  }

  function shouldAutoTranslateSidebarTitle(title) {
    if (!title) return false;
    if (/[\u4e00-\u9fff]/.test(title)) return false;
    const enWords = (title.match(/\b[a-zA-Z]{2,}\b/g) || []).length;
    return enWords >= 3;
  }

  function applySidebarTitleDom(row, rawTitle, zhTitle) {
    const span = row?.querySelector('span.truncate');
    if (!span || !zhTitle) return false;
    const cur = (span.textContent || '').trim();
    if (cur === zhTitle) return false;
    if (!span.title && rawTitle) span.title = rawTitle;
    updateSingleTextSafely(span, zhTitle);
    return true;
  }

  function extractSidebarRowId(row) {
    if (!row) return '';
    const attrId = (row.getAttribute('data-cascade-id') || '').trim();
    if (attrId) return attrId;
    const href = row.querySelector?.('a[href*="/c/"]')?.getAttribute('href') || '';
    const m = href.match(/\/c\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function escapeCssIdent(v) {
    return (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
      ? CSS.escape(v)
      : String(v).replace(/["\\]/g, '\\$&');
  }

  function findSidebarRowById(id) {
    if (!id) return null;
    const direct = document.querySelector(`[data-testid="conversation-row-sidebar"][data-cascade-id="${escapeCssIdent(id)}"]`);
    if (direct) return direct;
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    for (const row of rows) {
      if (extractSidebarRowId(row) === id) return row;
    }
    return null;
  }

  async function localizeSidebarConversations() {
    if (disposed || uiLang !== 'zh') return 0;
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    const needLocalize = [];
    const seenNeed = new Set();
    let appliedCount = 0;

    for (const row of rows) {
      const id = extractSidebarRowId(row);
      if (!id) continue;
      if (row.querySelector('input, textarea, [contenteditable="true"]')) continue;
      const span = row.querySelector('span.truncate');
      if (!span) continue;
      const reactTitle = getSidebarReactTitle(span);
      if (!reactTitle) continue;
      const domTitle = (span.textContent || '').trim();

      const prevRaw = sidebarRawTitleMap.get(id);
      if (prevRaw !== undefined && prevRaw !== reactTitle) {
        sidebarUserRenamedIds.add(id);
        sidebarZhCache.delete(id);
        sidebarRawTitleMap.set(id, reactTitle);
      } else if (prevRaw === undefined) {
        sidebarRawTitleMap.set(id, reactTitle);
      }

      if (sidebarUserRenamedIds.has(id) || !shouldAutoTranslateSidebarTitle(reactTitle)) {
        if (domTitle !== reactTitle) {
          updateSingleTextSafely(span, reactTitle);
          appliedCount++;
        }
        if (span.hasAttribute('title')) {
          span.removeAttribute('title');
        }
        continue;
      }

      const cached = sidebarZhCache.get(id);
      if (cached) {
        if (applySidebarTitleDom(row, reactTitle, cached)) appliedCount++;
        continue;
      }

      if (sidebarPendingIds.has(id) || seenNeed.has(id)) continue;
      seenNeed.add(id);
      needLocalize.push({ id, title: reactTitle });
    }

    if (!needLocalize.length) return appliedCount;

    for (const it of needLocalize) sidebarPendingIds.add(it.id);
    try {
      const res = await postToLiveHost('/localize-conversations', { items: needLocalize });
      const titles = res?.titles || {};
      for (const [id, zhTitle] of Object.entries(titles)) {
        if (!zhTitle || sidebarUserRenamedIds.has(id)) continue;
        sidebarZhCache.set(id, zhTitle);
        const row = findSidebarRowById(id);
        if (row) {
          const rawTitle = needLocalize.find((x) => x.id === id)?.title || '';
          if (applySidebarTitleDom(row, rawTitle, zhTitle)) appliedCount++;
        }
      }
      return appliedCount;
    } finally {
      for (const it of needLocalize) sidebarPendingIds.delete(it.id);
    }
  }

  function scheduleLocalization() {
    if (disposed || uiLang !== 'zh' || localizeTimer) return;
    localizeTimer = setTimeout(() => {
      localizeTimer = null;
      if (disposed) return;
      localizeThinkingShells();
      void translateExpandedThoughts();
      void localizeSidebarConversations();
    }, 250);
  }

  function startLocalizationObserver() {
    if (localizeMutationObserver || !document.body) return;
    localizeMutationObserver = new MutationObserver((mutations) => {
      if (disposed) return;
      let fastExpand = false;
      let needGuardThinking = false;
      let needSchedule = false;
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (m.attributeName !== 'aria-expanded') continue;
          const target = m.target;
          if (target?.getAttribute?.('data-testid') === 'thinking-collapsible-trigger') {
            if (target.getAttribute('aria-expanded') === 'true') {
              fastExpand = true;
            } else {
              needGuardThinking = true;
            }
          }
          needSchedule = true;
        } else {
          needGuardThinking = true;
          needSchedule = true;
        }
      }
      if (needGuardThinking) {
        guardExpandedThinkingBlocks();
      }
      if (fastExpand) {
        setTimeout(() => {
          if (disposed) return;
          localizeThinkingShells();
          void translateExpandedThoughts();
        }, 30);
      } else if (needSchedule) {
        scheduleLocalization();
      }
    });
    localizeMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-expanded']
    });
  }

  // ==================== 右侧边栏文件内联编辑器 ====================

  function getFileViewerContext() {
    const header =
      document.querySelector('[aria-label="File Viewer header"], [aria-label="文件查看器标题栏"]') ||
      Array.from(document.querySelectorAll('.group\\/file-row')).find((el) => el.querySelector('[data-uri]')) ||
      null;
    if (!header) return null;
    const uriNodes = header.querySelectorAll('[data-uri]');
    const lastUriNode = uriNodes[uriNodes.length - 1];
    const fileUri = lastUriNode?.getAttribute('data-uri') || '';
    const actionRow = header.querySelector('.flex.items-center.gap-1.shrink') || header.lastElementChild;
    const bodyContainer = header.nextElementSibling;
    return { header, fileUri, actionRow, bodyContainer };
  }

  function updateFileEditorStatusBar(text) {
    if (text !== undefined) fileEditorState.statusText = text;
    const wrap = document.getElementById(FILE_EDITOR_WRAP_ID);
    const leftEl = wrap?.querySelector('.ag-fedit-status-left');
    if (leftEl) {
      const prefix = fileEditorState.dirty ? '● 未保存' : '已同步';
      const detail = fileEditorState.statusText || (fileEditorState.filePath || '');
      leftEl.textContent = `${prefix} · ${detail}`;
      leftEl.title = fileEditorState.filePath || '';
    }
  }

  function restoreHiddenViewerChildren() {
    document.querySelectorAll('[data-ag-editor-host="1"]').forEach((hostEl) => {
      hostEl.removeAttribute('data-ag-editor-host');
    });
    document.querySelectorAll('[data-ag-hidden-by-editor="1"]').forEach((el) => {
      el.style.display = el.dataset.agPrevDisplay || '';
      delete el.dataset.agPrevDisplay;
      el.removeAttribute('data-ag-hidden-by-editor');
    });
  }

  /** 隐藏文件查看器原有的预览子节点，保留内联编辑器容器 */
  function hideNativeViewerChildren(bodyContainer) {
    if (!bodyContainer) return;
    if (bodyContainer.getAttribute('data-ag-editor-host') !== '1') {
      bodyContainer.setAttribute('data-ag-editor-host', '1');
    }
    for (const child of Array.from(bodyContainer.children)) {
      if (child.id === FILE_EDITOR_WRAP_ID) continue;
      if (child.getAttribute('data-ag-hidden-by-editor') !== '1' || child.style.display !== 'none') {
        if (!('agPrevDisplay' in child.dataset)) {
          child.dataset.agPrevDisplay = child.style.display || '';
        }
        child.setAttribute('data-ag-hidden-by-editor', '1');
        child.style.display = 'none';
      }
    }
  }

  /** 在编辑态持续保护编辑器 DOM 不被 React 重渲染覆盖或脱离宿主 */
  function syncFileEditorHostDom(ctx) {
    if (!fileEditorState.active || !ctx?.bodyContainer) return;
    hideNativeViewerChildren(ctx.bodyContainer);
    if (activeEditorWrapEl && activeEditorWrapEl.parentElement !== ctx.bodyContainer) {
      ctx.bodyContainer.appendChild(activeEditorWrapEl);
    }
  }

  function exitFileEditor(shouldRefresh = true) {
    if (activeEditorWrapEl) {
      safeRemove(activeEditorWrapEl);
      activeEditorWrapEl = null;
    }
    safeRemove(document.getElementById(FILE_EDITOR_WRAP_ID));
    restoreHiddenViewerChildren();
    const ctx = getFileViewerContext();
    fileEditorState.active = false;
    fileEditorState.filePath = '';
    fileEditorState.dirty = false;
    fileEditorState.saving = false;
    fileEditorState.loading = false;
    fileEditorState.savedOnce = false;
    fileEditorState.statusText = '';
    renderFileEditorControls(ctx);
    if (shouldRefresh && ctx?.header) {
      const refreshBtn = ctx.header.querySelector('[data-testid="file-view-refresh"]');
      if (refreshBtn) {
        try { refreshBtn.click(); } catch {}
      }
    }
  }

  async function saveFileEditor() {
    if (!fileEditorState.active || fileEditorState.saving) return false;
    const textarea = document.getElementById('ag-inline-file-textarea');
    if (!textarea || !fileEditorState.fileUri) return false;
    fileEditorState.saving = true;
    renderFileEditorControls(getFileViewerContext());
    updateFileEditorStatusBar('正在保存...');
    try {
      const res = await postToLiveHost('/write-local-file', {
        path: fileEditorState.fileUri,
        content: textarea.value
      });
      if (!res || !res.ok) {
        updateFileEditorStatusBar(`❌ 保存失败: ${res?.error || '桥接未连接'}`);
        showQuickToast(`❌ 保存失败: ${res?.error || '桥接未连接'}`);
        return false;
      }
      fileEditorState.dirty = false;
      fileEditorState.savedOnce = true;
      updateFileEditorStatusBar(`✅ 已保存 (${res.bytes} 字节)`);
      showQuickToast('✅ 文件已保存');
      return true;
    } finally {
      fileEditorState.saving = false;
      renderFileEditorControls(getFileViewerContext());
    }
  }

  async function enterFileEditor() {
    const ctx = getFileViewerContext();
    if (!ctx || !ctx.fileUri || !ctx.bodyContainer) {
      showQuickToast('未检测到当前打开的本地文件');
      return;
    }
    if (fileEditorState.loading) return;
    fileEditorState.loading = true;
    renderFileEditorControls(ctx);
    try {
      const res = await postToLiveHost('/read-local-file', { path: ctx.fileUri });
      if (!res || !res.ok) {
        showQuickToast(`无法编辑: ${res?.error || '读取文件失败'}`);
        return;
      }
      // 再次确认用户未在等待期间关闭面板
      const curCtx = getFileViewerContext();
      if (!curCtx || curCtx.fileUri !== ctx.fileUri || !curCtx.bodyContainer) return;

      const { host } = getMeterHostAndShadow();
      const theme = resolveHostTheme(host);

      hideNativeViewerChildren(curCtx.bodyContainer);

      let wrap = document.getElementById(FILE_EDITOR_WRAP_ID);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = FILE_EDITOR_WRAP_ID;
        wrap.setAttribute('data-ag-theme', theme);

        const statusbar = document.createElement('div');
        statusbar.className = 'ag-fedit-statusbar';
        const statusLeft = document.createElement('span');
        statusLeft.className = 'ag-fedit-status-left';
        statusLeft.style.overflow = 'hidden';
        statusLeft.style.textOverflow = 'ellipsis';
        statusLeft.style.whiteSpace = 'nowrap';
        const statusRight = document.createElement('span');
        statusRight.textContent = '⌘S / Ctrl+S 保存 · Tab 缩进';
        statusRight.style.flexShrink = '0';
        statusbar.appendChild(statusLeft);
        statusbar.appendChild(statusRight);

        const textarea = document.createElement('textarea');
        textarea.id = 'ag-inline-file-textarea';
        textarea.spellcheck = false;
        textarea.value = res.content;
        textarea.addEventListener('input', () => {
          if (!fileEditorState.dirty) {
            fileEditorState.dirty = true;
            renderFileEditorControls(getFileViewerContext());
          }
          updateFileEditorStatusBar('有未保存修改');
        });
        textarea.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            void saveFileEditor();
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const val = textarea.value;
            textarea.value = val.slice(0, start) + '  ' + val.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
            if (!fileEditorState.dirty) {
              fileEditorState.dirty = true;
              renderFileEditorControls(getFileViewerContext());
            }
            updateFileEditorStatusBar('有未保存修改');
          }
        });

        wrap.appendChild(statusbar);
        wrap.appendChild(textarea);
        curCtx.bodyContainer.appendChild(wrap);
      } else {
        wrap.setAttribute('data-ag-theme', theme);
        const textarea = wrap.querySelector('#ag-inline-file-textarea');
        if (textarea) textarea.value = res.content;
      }

      activeEditorWrapEl = wrap;
      fileEditorState.active = true;
      fileEditorState.fileUri = ctx.fileUri;
      fileEditorState.filePath = res.filePath || '';
      fileEditorState.dirty = false;
      fileEditorState.savedOnce = false;
      fileEditorState.statusText = res.filePath || '';
      updateFileEditorStatusBar(res.filePath || '');

      const textareaEl = document.getElementById('ag-inline-file-textarea');
      if (textareaEl) textareaEl.focus();
    } finally {
      fileEditorState.loading = false;
      renderFileEditorControls(getFileViewerContext());
    }
  }

  function renderFileEditorControls(ctx) {
    if (!ctx || !ctx.actionRow || !ctx.fileUri || !/^file:\/\//i.test(ctx.fileUri)) {
      safeRemove(document.getElementById(FILE_EDITOR_CONTROLS_ID));
      return;
    }
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    let controls = document.getElementById(FILE_EDITOR_CONTROLS_ID);
    if (!controls) {
      controls = document.createElement('div');
      controls.id = FILE_EDITOR_CONTROLS_ID;
    }
    if (controls.getAttribute('data-ag-theme') !== theme) {
      controls.setAttribute('data-ag-theme', theme);
    }
    if (controls.parentElement !== ctx.actionRow || controls !== ctx.actionRow.firstElementChild) {
      ctx.actionRow.insertBefore(controls, ctx.actionRow.firstChild);
    }

    const modeKey = [
      fileEditorState.active ? 'edit' : 'view',
      fileEditorState.loading ? 'loading' : '',
      fileEditorState.saving ? 'saving' : '',
      fileEditorState.dirty ? 'dirty' : ''
    ].join(':');
    if (controls.getAttribute('data-ag-mode-key') === modeKey) {
      const wrap = document.getElementById(FILE_EDITOR_WRAP_ID);
      if (wrap && wrap.getAttribute('data-ag-theme') !== theme) {
        wrap.setAttribute('data-ag-theme', theme);
      }
      return;
    }
    controls.setAttribute('data-ag-mode-key', modeKey);
    controls.textContent = '';

    if (!fileEditorState.active) {
      const editBtn = document.createElement('button');
      editBtn.id = 'ag-fedit-toggle';
      editBtn.type = 'button';
      editBtn.className = 'ag-fedit-btn';
      editBtn.textContent = fileEditorState.loading ? '读取中…' : '编辑';
      editBtn.title = '在侧边栏直接编辑当前文件';
      editBtn.addEventListener('mousedown', (e) => e.preventDefault());
      editBtn.addEventListener('click', () => { void enterFileEditor(); });
      controls.appendChild(editBtn);
    } else {
      const saveBtn = document.createElement('button');
      saveBtn.id = 'ag-fedit-save';
      saveBtn.type = 'button';
      saveBtn.className = 'ag-fedit-btn';
      saveBtn.setAttribute('data-primary', 'true');
      saveBtn.textContent = fileEditorState.saving ? '保存中…' : (fileEditorState.dirty ? '保存*' : '保存');
      saveBtn.title = '保存更改到硬盘 (⌘S / Ctrl+S)';
      saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
      saveBtn.addEventListener('click', () => { void saveFileEditor(); });

      const doneBtn = document.createElement('button');
      doneBtn.id = 'ag-fedit-done';
      doneBtn.type = 'button';
      doneBtn.className = 'ag-fedit-btn';
      doneBtn.textContent = '完成';
      doneBtn.title = '退出编辑并返回预览（自动刷新最新内容）';
      doneBtn.addEventListener('mousedown', (e) => e.preventDefault());
      doneBtn.addEventListener('click', () => { exitFileEditor(true); });

      controls.appendChild(saveBtn);
      controls.appendChild(doneBtn);
    }
  }

  function ensureFileViewerEditor() {
    if (disposed) return;
    ensureDocStyle();
    const ctx = getFileViewerContext();
    if (!ctx) {
      if (fileEditorState.active) exitFileEditor(false);
      else safeRemove(document.getElementById(FILE_EDITOR_CONTROLS_ID));
      return;
    }
    if (fileEditorState.active && fileEditorState.fileUri && ctx.fileUri !== fileEditorState.fileUri) {
      exitFileEditor(false);
    }
    if (fileEditorState.active) {
      syncFileEditorHostDom(ctx);
    }
    renderFileEditorControls(ctx);
  }

  // ==================== Cmd+点击使用系统浏览器打开链接 ====================

  function normalizeExternalUrlCandidate(raw) {
    const trimmed = String(raw || '').trim().replace(/[.,;:!?'"`）)\]}]+$/g, '');
    if (!/^(?:https?:\/\/|mailto:)/i.test(trimmed)) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
        return parsed.href;
      }
    } catch {
      return null;
    }
    return null;
  }

  function extractExternalUrlFromTarget(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    if (!el) return null;
    if (el.closest(`textarea, input, [contenteditable="true"], #${QUICK_BAR_ID}, #${CHAT_NAV_ID}, #${FILE_EDITOR_CONTROLS_ID}, #${FILE_EDITOR_WRAP_ID}`)) {
      return null;
    }
    const anchor = el.closest('a[href]');
    if (anchor) {
      const rawHref = (anchor.getAttribute('href') || '').trim();
      return normalizeExternalUrlCandidate(rawHref);
    }
    // 跳过文件引用胶囊或普通按钮（避免劫持内部操作）
    if (el.closest('button, [data-uri]')) return null;
    const codeEl = el.closest('code');
    if (codeEl) {
      const match = (codeEl.textContent || '').match(/(https?:\/\/[^\s<>"'`)\]]+)/i);
      return match ? normalizeExternalUrlCandidate(match[1]) : null;
    }
    const textHost = el.closest('span, p, li, td');
    if (textHost && (textHost.textContent || '').length <= 500) {
      const match = (textHost.textContent || '').match(/(https?:\/\/[^\s<>"'`)\]]+)/i);
      if (match) return normalizeExternalUrlCandidate(match[1]);
    }
    return null;
  }

  async function openExternalUrlInSystemBrowser(url, opts) {
    const safeUrl = normalizeExternalUrlCandidate(url);
    if (!safeUrl) return { ok: false, error: '无效的外部链接' };
    const dryRun = Boolean(opts && opts.dryRun);
    const res = await postToLiveHost('/open-external-url', { url: safeUrl, dryRun });
    if (res && res.ok) {
      if (!dryRun) showQuickToast(tr('🌐 已用系统浏览器打开链接', '🌐 Opened in system browser'));
      return res;
    }
    if (!dryRun && typeof window.contextMeterAPI?.openBrowserUrl === 'function') {
      try {
        const ipcRes = await window.contextMeterAPI.openBrowserUrl(safeUrl);
        if (ipcRes && ipcRes.ok) {
          showQuickToast(tr('🌐 已用系统浏览器打开链接', '🌐 Opened in system browser'));
          return { ...ipcRes, fallback: 'contextMeterAPI' };
        }
      } catch {
        // ignore fallback error
      }
    }
    if (!dryRun && typeof window.electronNative?.openExternal === 'function') {
      try {
        window.electronNative.openExternal(safeUrl);
        showQuickToast(tr('🌐 已用系统浏览器打开链接', '🌐 Opened in system browser'));
        return { ok: true, url: safeUrl, fallback: 'electronNative' };
      } catch {
        // ignore fallback error
      }
    }
    if (!dryRun && typeof window.open === 'function') {
      try {
        const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
        if (opened) {
          showQuickToast(tr('🌐 已用系统浏览器打开链接', '🌐 Opened in system browser'));
          return { ok: true, url: safeUrl, fallback: 'windowOpen' };
        }
      } catch {
        // ignore fallback error
      }
    }
    if (!dryRun) showQuickToast(tr('⚠️ 未能打开外部链接', '⚠️ Failed to open external link'));
    return { ok: false, error: '打开失败' };
  }

  function getOrderedSidebarConversationRows() {
    return Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'))
      .filter((row) => Boolean(extractSidebarRowId(row)));
  }

  function isSidebarRowActive(row, currentId = getSessionIdFromLocation() || '') {
    if (!row) return false;
    const id = extractSidebarRowId(row);
    const cls = String(row.className || '');
    return Boolean(
      (currentId && id === currentId) ||
      row.getAttribute('data-selected') === 'true' ||
      row.getAttribute('aria-current') === 'true' ||
      row.getAttribute('data-active') === 'true' ||
      /\bbg-accent\b|\bbg-secondary\b/.test(cls)
    );
  }

  function getSidebarRowDisplayTitle(row) {
    if (!row) return '';
    const span = row.querySelector('span.truncate');
    const id = extractSidebarRowId(row);
    return (span?.textContent || row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim() || id.slice(0, 8);
  }

  function syncSidebarShortcutBadges() {
    if (disposed) return 0;
    ensureDocStyle();
    const allRows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    let idx = 0;
    for (const row of allRows) {
      const hasId = Boolean(extractSidebarRowId(row));
      if (hasId && idx < 9) {
        const label = `⌘${idx + 1}`;
        if (row.getAttribute('data-ag-shortcut') !== label) {
          row.setAttribute('data-ag-shortcut', label);
        }
        idx += 1;
      } else if (row.hasAttribute('data-ag-shortcut')) {
        row.removeAttribute('data-ag-shortcut');
      }
    }
    return idx;
  }

  function switchSidebarConversationByIndex(targetIndex) {
    const rows = getOrderedSidebarConversationRows();
    if (!rows.length) {
      return { ok: false, reason: 'empty' };
    }
    if (targetIndex < 0 || targetIndex >= rows.length) {
      showQuickToast(tr(`当前仅有 ${rows.length} 个对话`, `Only ${rows.length} conversation(s)`));
      return { ok: false, reason: 'out-of-range', total: rows.length };
    }
    const row = rows[targetIndex];
    const id = extractSidebarRowId(row);
    const title = getSidebarRowDisplayTitle(row).slice(0, 36);
    if (isSidebarRowActive(row, getSessionIdFromLocation() || '')) {
      showQuickToast(tr(`已在对话 #${targetIndex + 1}：${title}`, `Already in #${targetIndex + 1}: ${title}`));
      return { ok: true, alreadyActive: true, index: targetIndex, id, title };
    }
    const clickTarget = row.querySelector('a[href]') || row;
    clickTarget.click();
    showQuickToast(tr(`💬 已切换至 #${targetIndex + 1}：${title}`, `💬 Switched to #${targetIndex + 1}: ${title}`));
    return { ok: true, alreadyActive: false, index: targetIndex, id, title };
  }

  function cycleSidebarConversation(delta) {
    const rows = getOrderedSidebarConversationRows();
    if (!rows.length) {
      return { ok: false, reason: 'empty' };
    }
    if (rows.length === 1) {
      return switchSidebarConversationByIndex(0);
    }
    const currentId = getSessionIdFromLocation() || '';
    const curIdx = rows.findIndex((r) => isSidebarRowActive(r, currentId));
    const step = delta < 0 ? -1 : 1;
    const nextIdx = curIdx >= 0
      ? (curIdx + step + rows.length) % rows.length
      : (step > 0 ? 0 : rows.length - 1);
    return switchSidebarConversationByIndex(nextIdx);
  }

  function syncCmdModifierState(active) {
    if (active) {
      syncSidebarShortcutBadges();
      document.documentElement.setAttribute('data-ag-cmd-down', '1');
    } else {
      document.documentElement.removeAttribute('data-ag-cmd-down');
    }
  }

  // ==================== 全局事件与定时巡检 ====================

  function onDocClick(e) {
    if (!popoverOpen && !remotePopoverOpen) return;
    const { sr } = getMeterHostAndShadow();
    if (!sr) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (popoverOpen) {
      const btn = sr.getElementById(QUOTA_BADGE_ID);
      const pop = sr.getElementById(QUOTA_POPOVER_ID);
      if (!(btn && path.includes(btn)) && !(pop && path.includes(pop))) {
        toggleQuotaPopover(false);
      }
    }
    if (remotePopoverOpen) {
      const rBtn = sr.getElementById(REMOTE_BADGE_ID);
      const rPop = sr.getElementById(REMOTE_POPOVER_ID);
      if (!(rBtn && path.includes(rBtn)) && !(rPop && path.includes(rPop))) {
        toggleRemotePopover(false);
      }
    }
  }

  function onWindowClickCapture(e) {
    if (e.isTrusted && !e.metaKey && !e.ctrlKey && !e.altKey && e.button === 0) {
      if (e.target?.closest?.('[data-testid="input-send-button"], [aria-label="Send"], [aria-label="发送"]')) {
        lastUserSubmitAt = Date.now();
        clearPromptOptUndoState();
        hideNextStepGhost();
        syncPromptOptimizerUI();
      }
      const thinkTrigger = e.target?.closest?.('[data-testid="thinking-collapsible-trigger"]');
      if (thinkTrigger) {
        const key = getThinkingTriggerKey(thinkTrigger);
        if (key) {
          const curExpanded = thinkTrigger.getAttribute('aria-expanded') === 'true';
          if (curExpanded) {
            userCollapsedThinkingKeys.add(key);
            keepExpandedThinkingKeys.delete(key);
          } else {
            userCollapsedThinkingKeys.delete(key);
            keepExpandedThinkingKeys.add(key);
          }
        }
      }
    }
    if (!(e.metaKey || e.ctrlKey) || e.button !== 0 || e.altKey) return;
    const url = extractExternalUrlFromTarget(e.target);
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    void openExternalUrlInSystemBrowser(url);
  }

  function onDocKeydown(e) {
    syncCmdModifierState(Boolean(e.metaKey || e.ctrlKey));
    if (e.key === 'Escape' && (popoverOpen || remotePopoverOpen)) {
      if (popoverOpen) toggleQuotaPopover(false);
      if (remotePopoverOpen) toggleRemotePopover(false);
      return;
    }
    if (disposed || e.isComposing || isComposerComposing) return;
    const target = (e.target && e.target.nodeType === 1) ? e.target : e.target?.parentElement;
    const inShortcutSafeField = Boolean(
      target?.closest?.('[data-testid="conversation-row-sidebar"] input, [data-testid="conversation-row-sidebar"] textarea, #ag-inline-file-textarea')
    );
    if (!inShortcutSafeField) {
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const codeMatch = /^Digit([1-9])$/.exec(String(e.code || ''));
        const digit = /^[1-9]$/.test(String(e.key || ''))
          ? Number(e.key)
          : (codeMatch ? Number(codeMatch[1]) : 0);
        if (digit >= 1 && digit <= 9) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          switchSidebarConversationByIndex(digit - 1);
          return;
        }
      }
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '[' || e.key === '{' || e.code === 'BracketLeft') {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          cycleSidebarConversation(-1);
          return;
        }
        if (e.key === ']' || e.key === '}' || e.code === 'BracketRight') {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          cycleSidebarConversation(1);
          return;
        }
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        cycleSidebarConversation(e.shiftKey ? -1 : 1);
        return;
      }
    }
    const ed = getComposerEditor();
    if (!ed || !target || !ed.contains(target)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !isComposerEmpty(ed) && ed.getAttribute('aria-expanded') !== 'true') {
      lastUserSubmitAt = Date.now();
      clearPromptOptUndoState();
      hideNextStepGhost();
      syncPromptOptimizerUI();
      return;
    }
    if (!nextStepState.visible || isAssistantBusy() || !isComposerEmpty(ed) || ed.getAttribute('aria-expanded') === 'true') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

    if (e.key === 'Tab' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      void acceptNextStepSuggestion();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (nextStepState.candidates.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        cycleNextStepSuggestion(e.key === 'ArrowDown' ? 1 : -1);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      nextStepState.dismissedSig = nextStepState.replySig;
      hideNextStepGhost();
    }
  }

  function onDocCompositionStart(e) {
    const ed = getComposerEditor();
    const target = (e.target && e.target.nodeType === 1) ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
    isComposerComposing = true;
    hideNextStepGhost();
  }

  function onDocCompositionEnd(e) {
    const ed = getComposerEditor();
    const target = (e.target && e.target.nodeType === 1) ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
    isComposerComposing = false;
    setTimeout(() => {
      if (!disposed) ensureNextStepGhost();
    }, 0);
  }

  function onDocInput(e) {
    if (disposed) return;
    const ed = getComposerEditor();
    const target = (e.target && e.target.nodeType === 1) ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
    syncPromptOptimizerUI();
    if (isComposerComposing || !isComposerEmpty(ed)) {
      hideNextStepGhost();
    } else {
      setTimeout(() => {
        if (!disposed) ensureNextStepGhost();
      }, 0);
    }
  }

  function onDocKeyup(e) {
    syncCmdModifierState(Boolean(e.metaKey || e.ctrlKey));
  }

  function onWindowBlur() {
    syncCmdModifierState(false);
  }

  function onWindowResize() {
    positionChatNavFloat(document.getElementById(CHAT_NAV_ID));
  }

  function applyEnhancerFeatureVisibility() {
    if (disposed) return;
    if (!featureFlags.showQuickBar) {
      hideQuickBarTooltip();
      safeRemove(document.getElementById(QUICK_BAR_ID));
    } else {
      ensureQuickCapsuleBar();
    }
    if (!featureFlags.showChatNav) {
      safeRemove(document.getElementById(CHAT_NAV_ID));
    } else {
      ensureChatNavFloat();
    }
    const { sr } = getMeterHostAndShadow();
    if (sr) {
      const qBtn = sr.getElementById(QUOTA_BADGE_ID);
      if (qBtn) qBtn.hidden = featureFlags.showTopbarQuota === false;
      if (featureFlags.showTopbarQuota === false) toggleQuotaPopover(false);
      const rBtn = sr.getElementById(REMOTE_BADGE_ID);
      if (rBtn) rBtn.hidden = featureFlags.showTopbarRemote === false;
      if (featureFlags.showTopbarRemote === false) toggleRemotePopover(false);
    }
  }

  function syncRemotePairData(data) {
    if (disposed || !data || typeof data !== 'object') return remotePairState;
    remotePairState.data = data;
    remotePairState.error = '';
    updateRemoteBtnLanguage({ skipRender: true });
    const nodes = ensureQuotaStylesAndNodes();
    if (remotePopoverOpen && nodes?.remotePopover) {
      renderRemotePopoverContent(nodes.remotePopover);
      positionRemotePopover();
    }
    scheduleTunnelStartingPoll();
    return remotePairState;
  }

  function onRemoteStateChanged(ev) {
    if (disposed) return;
    const data = ev?.detail?.data;
    if (data && typeof data === 'object') {
      syncRemotePairData(data);
    }
  }

  function onSuitePrefsChanged(ev) {
    const prevLang = uiLang;
    syncSuitePrefsFromStorage(ev?.detail || null);
    if (!autoCompactEnabled) autoCompactState.idleSince = 0;
    applyEnhancerFeatureVisibility();
    if (!ghostSuggestEnabled) hideNextStepGhost();
    else ensureNextStepGhost();
    if (featureFlags.showQuickActions !== false) {
      ensureQuickCapsuleBar();
      const quickBar = document.getElementById(QUICK_BAR_ID);
      if (quickBar) syncQuickBarActionButtons(quickBar);
    }
    updateQuickBarLanguage();
    updateChatNavLanguage();
    updateAutoAcceptBtn();
    updateRemoteBtnLanguage();
    renderQuotaUI();
    if (uiLang !== 'zh') {
      revertEnhancerTranslations();
    } else if (prevLang !== 'zh') {
      localizeThinkingShells();
      scheduleLocalization();
    }
  }

  window.addEventListener('ag-suite-prefs-changed', onSuitePrefsChanged);
  window.addEventListener('ag-remote-state-changed', onRemoteStateChanged);
  window.addEventListener('click', onWindowClickCapture, true);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown, true);
  document.addEventListener('keyup', onDocKeyup, true);
  document.addEventListener('input', onDocInput, true);
  document.addEventListener('compositionstart', onDocCompositionStart, true);
  document.addEventListener('compositionend', onDocCompositionEnd, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowResize);

  let lastQuotaFetchAt = 0;
  function tickEnhancer() {
    if (disposed) return;
    applyEnhancerFeatureVisibility();
    ensurePromptOptimizerControls();
    ensureNextStepGhost();
    ensureFileViewerEditor();
    scanHighRiskCommands();
    renderQuotaUI();
    guardExpandedThinkingBlocks();
    localizeThinkingShells();
    scheduleLocalization();
    syncSidebarShortcutBadges();
    runAutoAcceptTick();
    runAutoCompactTick();
    if (featureFlags.showTopbarQuota !== false && Date.now() - lastQuotaFetchAt >= 30000) {
      lastQuotaFetchAt = Date.now();
      void refreshQuota();
    }
    if (featureFlags.showTopbarRemote !== false && !remotePopoverOpen && Date.now() - lastRemoteFetchAt >= 10000) {
      lastRemoteFetchAt = Date.now();
      void refreshRemotePairInfo(false);
    }
  }

  const enhancerTimer = setInterval(tickEnhancer, 1000);

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(enhancerTimer);
    clearRemotePollTimer();
    if (toastTimer) clearTimeout(toastTimer);
    if (promptOptState.abortCtrl) {
      try { promptOptState.abortCtrl.abort(); } catch {}
      promptOptState.abortCtrl = null;
    }
    promptOptState.loading = false;
    if (remotePairState.tunnelPollTimer) {
      clearTimeout(remotePairState.tunnelPollTimer);
      remotePairState.tunnelPollTimer = null;
    }
    if (localizeTimer) {
      clearTimeout(localizeTimer);
      localizeTimer = null;
    }
    if (localizeMutationObserver) {
      localizeMutationObserver.disconnect();
      localizeMutationObserver = null;
    }
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('ag-suite-prefs-changed', onSuitePrefsChanged);
    window.removeEventListener('ag-remote-state-changed', onRemoteStateChanged);
    window.removeEventListener('click', onWindowClickCapture, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    document.removeEventListener('keyup', onDocKeyup, true);
    document.removeEventListener('input', onDocInput, true);
    document.removeEventListener('compositionstart', onDocCompositionStart, true);
    document.removeEventListener('compositionend', onDocCompositionEnd, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', onWindowResize);
    syncCmdModifierState(false);
    hideNextStepGhost();
    hideQuickBarTooltip();
    safeRemove(document.getElementById(NEXT_STEP_TOOLTIP_ID));
    safeRemove(document.getElementById(QUICK_BAR_TOOLTIP_ID));
    safeRemove(document.getElementById(NEXT_STEP_GHOST_ID));
    safeRemove(document.getElementById(PROMPT_OPT_WRAP_ID));
    if (fileEditorState.active) exitFileEditor(false);
    safeRemove(document.getElementById(FILE_EDITOR_CONTROLS_ID));
    safeRemove(document.getElementById(FILE_EDITOR_WRAP_ID));
    restoreHiddenViewerChildren();
    try { (globalThis.__AGContextMeter || window.__AGContextMeter)?.setHostElevated?.(false); } catch {}
    const { sr } = getMeterHostAndShadow();
    if (sr) {
      safeRemove(sr.getElementById(REMOTE_BADGE_ID));
      safeRemove(sr.getElementById(REMOTE_POPOVER_ID));
      safeRemove(sr.getElementById(QUOTA_BADGE_ID));
      safeRemove(sr.getElementById(QUOTA_POPOVER_ID));
      safeRemove(sr.getElementById(QUOTA_STYLE_ID));
    }
    safeRemove(document.getElementById(QUICK_BAR_ID));
    safeRemove(document.getElementById(CHAT_NAV_ID));
    document.querySelectorAll('.ag-risk-banner').forEach(safeRemove);
    document.querySelectorAll('[data-ag-risk-card]').forEach((el) => el.removeAttribute('data-ag-risk-card'));
    document.querySelectorAll('[data-ag-shortcut]').forEach((el) => el.removeAttribute('data-ag-shortcut'));
    safeRemove(document.getElementById(DOC_STYLE_ID));
  }

  // ==================== 手机端极速遥控面板数据桥接 (v1.6.9) ====================

  const MOBILE_APPROVE_RE = /^(?:proceed|accept(?:\s+all|\s+changes|\s+step)?|allow(?:\s+once)?|run(?:\s+command)?|approve|continue|继续|接受|全部接受|接受更改|接受此步骤|允许|允许一次|运行|批准)(?:\s+\([^)]+\))?$/i;
  const MOBILE_REJECT_RE = /^(?:reject|deny|cancel|discard|decline|abort|拒绝|取消|丢弃|中止)(?:\s+\([^)]+\))?$/i;

  function findApprovalCandidateButtons() {
    const container = document.querySelector('main') || document.body;
    if (!container) return [];
    const results = [];
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.closest(`#${QUICK_BAR_ID}, #${CHAT_NAV_ID}, #${METER_HOST_ID}, .surface-composer, [data-agy-hans-ui], [data-agy-context-capsule], [data-testid="thinking-collapsible-trigger"], [data-testid="conversation-row-sidebar"]`)) {
        continue;
      }
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      if (btn.offsetWidth <= 0 || btn.offsetHeight <= 0) continue;
      const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 32) continue;

      let kind = '';
      if (MOBILE_REJECT_RE.test(label)) {
        kind = 'reject';
      } else if (MOBILE_APPROVE_RE.test(label)) {
        kind = 'approve';
      }
      if (!kind) continue;

      const cardScope = btn.closest('[data-testid="turn-cards-container"], [data-testid="agent-response"], [role="dialog"], [data-testid="tool-group-collapsible"]') || btn.parentElement?.parentElement;
      const riskEl = cardScope ? (cardScope.matches('[data-ag-risk-card="high"]') ? cardScope : cardScope.querySelector('[data-ag-risk-card="high"]')) : null;
      const riskBanner = cardScope?.querySelector('.ag-risk-banner');
      const highRisk = Boolean(riskEl || riskBanner);
      const riskText = (riskBanner?.textContent || '').trim();

      let contextText = '';
      if (cardScope) {
        const codeNode = cardScope.querySelector('pre, code');
        const rawCtx = (codeNode?.textContent || cardScope.innerText || '').replace(/\s+/g, ' ').trim();
        contextText = rawCtx.slice(0, 240);
      }

      results.push({ btn, label, kind, highRisk, riskText, contextText });
    }
    return results;
  }

  function collectPendingApprovals() {
    return findApprovalCandidateButtons().map((item, index) => ({
      index,
      label: item.label,
      kind: item.kind,
      highRisk: item.highRisk,
      riskText: item.riskText,
      contextText: item.contextText
    }));
  }

  function cleanUserMessageText(raw) {
    let s = String(raw || '').replace(/\r\n/g, '\n').trim();
    s = s.replace(/^(?:You said|你说)\s*/i, '');
    s = s.replace(/\n+(?:just\s+now|刚刚|\d+\s*(?:second|minute|hour|day|sec|min|hr)s?\s*ago|\d+\s*[smhd]\s*ago|\d+\s*(?:秒|分钟|小时|天)前)\s*$/i, '');
    return s.trim();
  }

  const MD_ALLOWED_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'DEL',
    'CODE', 'PRE', 'BLOCKQUOTE', 'HR', 'BR',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD'
  ]);
  const MD_SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'SVG', 'MATH', 'ANNOTATION']);

  function sanitizeMarkdownNodeToHtml(node, depth = 0) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtml(node.nodeValue || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (MD_SKIP_TAGS.has(tag)) return '';
    if (depth > 24) return escapeHtml(node.textContent || '');

    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls.includes('katex-mathml') || (cls.includes('pointer-events-none') && cls.includes('sticky'))) {
      return '';
    }
    if (tag === 'BDI' && cls.includes('context-scope-mention')) {
      const txt = (node.textContent || '').trim();
      return txt ? `<code class="md-pill">${escapeHtml(txt)}</code>` : '';
    }
    if (tag === 'BUTTON') {
      if (cls.includes('inline-pill')) {
        const txt = (node.textContent || '').trim();
        return txt ? `<code class="md-pill">${escapeHtml(txt)}</code>` : '';
      }
      return '';
    }

    if (tag === 'HR') return '<hr>';
    if (tag === 'BR') return '<br>';

    let inner = '';
    for (const child of node.childNodes) {
      inner += sanitizeMarkdownNodeToHtml(child, depth + 1);
    }

    if (tag === 'A') {
      const rawHref = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(rawHref)) {
        return `<a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener">${inner}</a>`;
      }
      return inner;
    }

    if (tag === 'DIV' && cls.includes('markdown-alert')) {
      return `<blockquote class="md-alert">${inner}</blockquote>`;
    }
    if (tag === 'TABLE') {
      return `<div class="md-table-wrap"><table>${inner}</table></div>`;
    }
    if (MD_ALLOWED_TAGS.has(tag)) {
      const lower = tag.toLowerCase();
      return `<${lower}>${inner}</${lower}>`;
    }
    return inner;
  }

  function extractSanitizedMarkdownHtml(mdRoots) {
    if (!Array.isArray(mdRoots) || !mdRoots.length) return '';
    let out = '';
    for (const root of mdRoots) {
      const piece = sanitizeMarkdownNodeToHtml(root, 0).trim();
      if (!piece) continue;
      out += piece;
    }
    return out;
  }

  function collectRecentMessages(limit = 60) {
    const viewport = getScrollViewport() || document.querySelector('main') || document.body;
    if (!viewport) return [];
    const MAX_DOM_MSG_CHARS = 200000;
    const MAX_DOM_THOUGHT_CHARS = 32000;
    const MAX_DOM_HTML_CHARS = 260000;
    const capText = (s, maxLen) => (s && s.length > maxLen ? `${s.slice(0, maxLen)}…` : s);
    const nodes = Array.from(viewport.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]'));
    const slice = nodes.slice(-Math.max(1, limit));
    const out = [];

    for (let i = 0; i < slice.length; i++) {
      const node = slice[i];
      const testId = node.getAttribute('data-testid');
      if (testId === 'user-message') {
        const contentNode = node.querySelector('[data-testid="user-message-content"]') || node;
        const rawUserText = String(contentNode.textContent || contentNode.innerText || '');
        const text = capText(cleanUserMessageText(rawUserText.slice(0, MAX_DOM_MSG_CHARS + 512)), MAX_DOM_MSG_CHARS);
        if (!text) continue;
        out.push({ id: `u-${i}`, role: 'user', text });
        continue;
      }

      const triggers = Array.from(node.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
      const thoughtLabel = triggers.map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
      const thoughtChunks = [];
      for (const trg of triggers) {
        if (trg.getAttribute('aria-expanded') === 'true') {
          const panel = trg.parentElement?.nextElementSibling;
          const zhNode = panel?.querySelector?.('[data-ag-thought-zh]') || trg.nextElementSibling;
          const txt = capText((zhNode?.innerText || panel?.innerText || '').trim(), MAX_DOM_THOUGHT_CHARS);
          if (txt) thoughtChunks.push(txt);
        }
      }
      const mdRoots = Array.from(node.querySelectorAll('[data-markdown-root]')).filter((m) => (
        !m.closest('[data-testid="user-message"]') &&
        !m.closest('[data-testid="thinking-collapsible-trigger"]') &&
        !m.parentElement?.previousElementSibling?.matches?.('[data-testid="thinking-collapsible-trigger"]')
      ));
      const rawMdReply = mdRoots.map((m) => (m.textContent || m.innerText || '').trim()).filter(Boolean).join('\n\n').trim();
      const overTextCap = rawMdReply.length > MAX_DOM_MSG_CHARS;
      let replyText = capText(rawMdReply, MAX_DOM_MSG_CHARS);
      // 超过热路径字符上限时直接跳过整段 HTML 序列化（完整长文由服务端轨迹通道渲染）
      const rawHtml = overTextCap ? '' : extractSanitizedMarkdownHtml(mdRoots);
      const replyHtml = rawHtml && rawHtml.length > MAX_DOM_HTML_CHARS ? '' : rawHtml;
      if (!replyText) {
        const cloneText = capText((node.innerText || '')
          .replace(/^(?:Agent\s+(?:said|working)|智能体(?:回复|正在处理))\s*\n*/i, '')
          .replace(/^Worked\s+for\s+\S+(?:\s+in\s+this\s+step)?\s*\n*/i, '')
          .trim(), MAX_DOM_MSG_CHARS);
        if (cloneText && !/^(?:Agent\s+working|Worked\s+for|Running\s+)/i.test(cloneText)) {
          replyText = cloneText;
        }
      }
      const riskBanner = node.querySelector('.ag-risk-banner');
      const highRisk = Boolean(node.querySelector('[data-ag-risk-card="high"]') || riskBanner);

      if (!replyText && !replyHtml && !thoughtLabel && !highRisk) {
        continue;
      }

      out.push({
        id: `a-${i}`,
        role: 'assistant',
        text: replyText,
        html: replyHtml,
        thoughtLabel: thoughtLabel.slice(0, 120),
        thoughtText: thoughtChunks.join('\n\n'),
        highRisk,
        riskText: (riskBanner?.textContent || '').trim()
      });
    }
    return out;
  }

  function toSafeNumber(v) {
    if (typeof v === 'bigint') return Number(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function findTanStackRouter() {
    try {
      const anchors = [
        document.querySelector('[data-testid="new-conversation-button"]'),
        document.querySelector('[data-testid="conversation-list-sidebar"]'),
        document.querySelector('a[href^="/c/"]')
      ].filter(Boolean);
      for (const el of anchors) {
        const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let f = fk ? el[fk] : null;
        for (let d = 0; d < 45 && f; d++) {
          let ctx = f.dependencies?.firstContext;
          let guard = 0;
          while (ctx && guard++ < 20) {
            const v = ctx.memoizedValue;
            if (v && typeof v === 'object' && (typeof v.history?.push === 'function' || (typeof v.navigate === 'function' && typeof v.parseLocation === 'function'))) {
              return v;
            }
            ctx = ctx.next;
          }
          f = f.return;
        }
      }
    } catch {}
    return null;
  }

  function triggerNativeProjectNewChat(projectId) {
    try {
      const listEl = document.querySelector('[data-testid="conversation-list-sidebar"]');
      if (!listEl) return null;
      const fk = Object.keys(listEl).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? listEl[fk] : null;
      for (let d = 0; d < 6 && f; d++) {
        const renderer = f.memoizedProps?.customHeaderRenderer;
        if (typeof renderer === 'function') {
          const el = renderer({ id: `header-${projectId}`, type: 'header' });
          if (typeof el?.props?.onAddClick === 'function') {
            el.props.onAddClick({ stopPropagation() {}, preventDefault() {} });
            return { triggered: true, method: 'sidebar-header-action' };
          }
        }
        f = f.return;
      }
    } catch {}
    return null;
  }

  const cascadeSummaryMap = new Map();
  let lastCascadeSummaryFetchAt = 0;
  let cascadeSummaryInflight = false;

  function extractProjectNameFromUri(rawUri) {
    if (!rawUri || typeof rawUri !== 'string') return '';
    let clean = rawUri.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
    try { clean = decodeURIComponent(clean); } catch {}
    const parts = clean.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  async function refreshCascadeTrajectorySummaries() {
    if (disposed || cascadeSummaryInflight) return;
    const csrf = window.__APP_CONFIG__?.csrfToken;
    if (!csrf) return;
    cascadeSummaryInflight = true;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, 4000) : null;
      try {
        const resp = await fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf
          },
          body: '{}',
          signal: controller ? controller.signal : undefined
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const summaries = data?.trajectorySummaries;
        if (!summaries || typeof summaries !== 'object') return;
        for (const [cid, meta] of Object.entries(summaries)) {
          if (!cid || !meta || typeof meta !== 'object') continue;
          const title = String(meta.summary || '').trim();
          const ws0 = Array.isArray(meta.workspaces) ? meta.workspaces[0] : null;
          const proj = extractProjectNameFromUri(ws0?.workspaceFolderAbsoluteUri || ws0?.gitRootAbsoluteUri || '');
          const mtime = meta.lastModifiedTime ? (Date.parse(meta.lastModifiedTime) || 0) : 0;
          cascadeSummaryMap.set(cid, { id: cid, title, project: proj, mtime });
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // 忽略后台摘要拉取失败
    } finally {
      cascadeSummaryInflight = false;
    }
  }

  function findSidebarFiberProps() {
    const list = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!list) return null;
    try {
      const fk = Object.keys(list).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? list[fk] : null;
      for (let d = 0; d < 12 && f; d++) {
        if (Array.isArray(f.memoizedProps?.items)) return f.memoizedProps;
        f = f.return;
      }
    } catch {}
    return null;
  }

  function resolvePermissionStateFromDom(permBtn) {
    const rawText = (permBtn?.textContent || '').replace(/\s+/g, ' ').trim();
    const presetAttr = String(permBtn?.getAttribute?.('data-perm-preset') || '').trim().toLowerCase();
    const aria = String(permBtn?.getAttribute?.('aria-label') || '').trim();
    const svgEl = permBtn?.querySelector?.('svg');
    const svgSig = String(svgEl?.innerHTML || svgEl?.querySelector?.('path')?.getAttribute?.('d') || '');

    let key = '';
    if (presetAttr === 'turbo' || presetAttr === 'auto' || presetAttr === 'default' || presetAttr === 'request_review') {
      key = presetAttr;
    } else {
      const combined = `${rawText} ${aria}`.toLowerCase();
      if (/(?:turbo|无限|unrestricted)/i.test(combined)) key = 'turbo';
      else if (/(?:request_review|review|请求审核|请求审查|审核|审查)/i.test(combined)) key = 'request_review';
      else if (/(?:\bauto\b|自动)/i.test(combined)) key = 'auto';
      else if (/(?:\bdefault\b|默认)/i.test(combined)) key = 'default';
      else if (svgSig.includes('502.92-344.77')) key = 'turbo';
      else if (svgSig.includes('595.58-384.51')) key = 'request_review';
      else if (svgSig.includes('252.31-100')) key = 'default';
      else if (svgSig.includes('480-100.77')) key = 'auto';
      else key = 'unknown';
    }
    const label = rawText || PERMISSION_DEFAULT_LABELS[key] || '未知';
    return { permissionKey: key, permissionLabel: label };
  }

  function readDesktopAppNavigationState() {
    const router = findTanStackRouter();
    const hasRouter = Boolean(router && router.state);
    const routerReady = Boolean(hasRouter && !router.state.isLoading && router.state.status !== 'pending');
    const routePath = String(router?.state?.location?.pathname || location?.pathname || '');
    const searchVal = router?.state?.location?.search;
    const routeProjectId = (searchVal && typeof searchVal === 'object' && searchVal.project)
      ? String(searchVal.project).trim()
      : getProjectIdFromLocation();

    let matchedCascadeId = '';
    if (Array.isArray(router?.state?.matches)) {
      for (let i = router.state.matches.length - 1; i >= 0; i--) {
        const cid = router.state.matches[i]?.params?.cascadeId;
        if (cid) {
          matchedCascadeId = String(cid);
          break;
        }
      }
    }

    let hasInputProps = false;
    let inExistingConversation = false;
    let inputCascadeId = '';
    let isConvoLoading = false;
    try {
      const compHost = document.querySelector('.surface-composer') || getComposerEditor();
      if (compHost) {
        const fk = Object.keys(compHost).find((k) => k.startsWith('__reactFiber$'));
        let f = fk ? compHost[fk] : null;
        for (let i = 0; i < 16 && f; i++) {
          const p = f.memoizedProps;
          if (p && typeof p === 'object' && ('inExistingConversation' in p || 'handleSubmit' in p)) {
            hasInputProps = true;
            inExistingConversation = Boolean(p.inExistingConversation);
            inputCascadeId = String(p.cascadeId || '');
            isConvoLoading = Boolean(p.isConvoLoading);
            break;
          }
          f = f.return;
        }
      }
    } catch {}

    let domSelectedProjectId = '';
    try {
      const selProj = document.querySelector('[data-active-project-id]')
        || document.querySelector('[data-testid="new-convo-project-trigger"][data-project-id]')
        || Array.from(document.querySelectorAll('[data-project-id]')).find((n) => n.getAttribute('data-selected') === 'true' || n.getAttribute('aria-pressed') === 'true');
      if (selProj) {
        domSelectedProjectId = String(selProj.getAttribute('data-active-project-id') || selProj.getAttribute('data-project-id') || '').trim();
      }
    } catch {}

    let activeDomRowId = '';
    try {
      const rows = getOrderedSidebarConversationRows();
      const activeRow = rows.find((r) => isSidebarRowActive(r, ''));
      if (activeRow) activeDomRowId = extractSidebarRowId(activeRow);
    } catch {}

    return {
      hasRouter,
      routerReady,
      routePath,
      routeProjectId,
      matchedCascadeId,
      hasComposer: Boolean(getComposerEditor()),
      hasInputProps,
      inExistingConversation,
      inputCascadeId,
      isConvoLoading,
      domSelectedProjectId,
      activeDomRowId
    };
  }

  async function waitForVerifiedNavigationState(kind, targetValue, timeoutMs = 1200) {
    const start = Date.now();
    let lastState = readDesktopAppNavigationState();
    const isMatched = (st) => {
      if (kind === 'new') {
        const pid = String(targetValue || '').trim();
        if (st.hasRouter || st.hasInputProps) {
          const inputLandingOk = st.hasInputProps && st.inExistingConversation === false && !st.isConvoLoading && !st.inputCascadeId;
          const routerLandingOk = st.hasRouter && st.routerReady && st.routePath === '/' && !st.matchedCascadeId;
          const projectOk = !pid || st.routeProjectId === pid || st.domSelectedProjectId === pid;
          return st.hasComposer && (inputLandingOk || routerLandingOk) && projectOk;
        }
        return st.hasComposer && !st.activeDomRowId && (!pid || st.domSelectedProjectId === pid);
      }
      if (kind === 'switch') {
        const cid = String(targetValue || '').trim();
        if (!cid) return false;
        if (st.hasRouter || st.hasInputProps) {
          const routerSwitched = st.hasRouter && st.routerReady && st.matchedCascadeId === cid;
          const inputSwitched = st.hasInputProps && st.inExistingConversation === true && st.inputCascadeId === cid && !st.isConvoLoading;
          return routerSwitched || inputSwitched;
        }
        return st.activeDomRowId === cid;
      }
      return false;
    };

    while (Date.now() - start <= timeoutMs) {
      lastState = readDesktopAppNavigationState();
      if (isMatched(lastState)) return { ok: true, state: lastState };
      await new Promise((r) => setTimeout(r, 40));
    }
    return { ok: false, state: lastState };
  }

  async function navigateSpaRoute(targetHref, options = {}) {
    const href = String(targetHref || '/').trim() || '/';
    const cMatch = href.match(/^\/c\/([^/?#]+)/);
    const pId = parseProjectIdFromHref(href);
    let method = '';

    if (cMatch) {
      const cid = cMatch[1];
      const row = findSidebarRowById(cid);
      const link = row?.querySelector('a[href]')
        || document.querySelector(`a[href="/c/${escapeCssIdent(cid)}"]`)
        || document.querySelector(`a[href*="/c/${escapeCssIdent(cid)}"]`)
        || row;
      if (link && typeof link.click === 'function') {
        link.click();
        method = 'dom-link';
      }
    } else if (pId) {
      if (options.preferNativeProjectAction) {
        const nativeRes = triggerNativeProjectNewChat(pId);
        if (nativeRes?.triggered) method = nativeRes.method;
      }
      if (!method) {
        const projLink = document.querySelector(`a[href="/?project=${escapeCssIdent(pId)}"]`)
          || Array.from(document.querySelectorAll('a[href*="project="]')).find((a) => parseProjectIdFromHref(a.getAttribute('href')) === pId);
        if (projLink && typeof projLink.click === 'function') {
          projLink.click();
          method = 'dom-link';
        }
      }
    } else if (href === '/') {
      const newBtn = document.querySelector('a[data-testid="new-conversation-button"], [data-testid="new-conversation-button"] a, [data-testid="new-conversation-button"]');
      if (newBtn && typeof newBtn.click === 'function') {
        newBtn.click();
        method = 'dom-link';
      }
    }

    if (!method) {
      const router = findTanStackRouter();
      if (router) {
        try {
          if (typeof router.history?.push === 'function') {
            router.history.push(href);
            method = 'router-history';
          } else if (typeof router.navigate === 'function') {
            if (pId) await router.navigate({ to: '/', search: { project: pId } });
            else await router.navigate({ to: href, search: {} });
            method = 'router-navigate';
          }
        } catch {}
      }
    }

    if (!method && typeof window !== 'undefined' && typeof window.history?.pushState === 'function') {
      try {
        window.history.pushState({}, '', href);
        const ev = typeof PopStateEvent === 'function' ? new PopStateEvent('popstate') : new Event('popstate');
        window.dispatchEvent(ev);
        method = 'popstate-dispatch';
      } catch {}
    }

    if (!method) {
      return { ok: false, error: '未找到可用的桌面端导航控制接口' };
    }
    return { ok: true, method };
  }

  function extractSidebarStoreCatalog() {
    const projectMap = new Map();
    const convs = [];
    const seenConv = new Set();

    const addProject = (raw) => {
      const id = String(raw?.id || '').trim();
      const name = String(raw?.name || raw?.label || '').trim();
      if (!id || !name) return;
      if (name === 'swarm/swarm_board') return;
      const prev = projectMap.get(id);
      if (!prev) {
        projectMap.set(id, {
          id,
          name,
          kind: String(raw?.kind || 'project'),
          isCollapsed: Boolean(raw?.isCollapsed)
        });
      } else if (raw?.isCollapsed !== undefined) {
        prev.isCollapsed = Boolean(raw.isCollapsed);
      }
    };

    try {
      const listEl = document.querySelector('[data-testid="conversation-list-sidebar"]');
      if (listEl) {
        const fk = Object.keys(listEl).find((k) => k.startsWith('__reactFiber$'));
        let f = fk ? listEl[fk] : null;
        const collapsedById = new Map();
        const convGroupMap = new Map();

        // 从虚拟列表 items 读取当前折叠态与会话归属映射
        const uMc = f?.return;
        if (Array.isArray(uMc?.memoizedProps?.items)) {
          for (const it of uMc.memoizedProps.items) {
            if (!it || typeof it !== 'object') continue;
            if (it.type === 'header' && typeof it.id === 'string' && it.id.startsWith('header-')) {
              collapsedById.set(it.id.slice(7), Boolean(it.isCollapsed));
            } else if (it.type === 'row' && it.cascadeId && it.groupId) {
              convGroupMap.set(String(it.cascadeId), String(it.groupId));
            }
          }
        }

        // 向上查找包含完整项目分组（含折叠组内全量会话）的 Hook 状态
        let groups = null;
        for (let d = 0; d < 16 && f; d++) {
          let st = f.memoizedState;
          let guard = 0;
          while (st && guard++ < 30) {
            const val = st.memoizedState;
            if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object'
              && typeof val[0].id === 'string' && (Array.isArray(val[0].entries) || Array.isArray(val[0].conversationIds))) {
              groups = val;
              break;
            }
            st = st.next;
          }
          if (groups) break;
          f = f.return;
        }

        if (Array.isArray(groups)) {
          for (const g of groups) {
            if (!g || typeof g !== 'object') continue;
            const gId = String(g.id || '').trim();
            const gName = String(g.label || '').trim();
            if (!gId || gName === 'swarm/swarm_board') continue;
            const entries = Array.isArray(g.entries) ? g.entries : [];
            if ((gId === 'outside-of-project' || gId === 'standalone') && entries.length === 0) continue;
            addProject({
              id: gId,
              name: gName || gId,
              kind: g.kind || 'project',
              isCollapsed: collapsedById.get(gId)
            });
            for (const entry of entries) {
              const cid = String(entry?.cascadeId || entry?.conversation?.conversationId || '').trim();
              if (!cid || seenConv.has(cid)) continue;
              seenConv.add(cid);
              const rawSummary = String(entry?.conversation?.summary || '').replace(/\s+/g, ' ').trim();
              const cachedZh = (uiLang === 'zh' && !sidebarUserRenamedIds.has(cid)) ? sidebarZhCache.get(cid) : '';
              const pid = String(entry?.projectId || convGroupMap.get(cid) || gId).trim();
              convs.push({
                id: cid,
                projectId: pid,
                projectName: gName || '',
                title: (cachedZh || rawSummary || cid.slice(0, 8)).slice(0, 80),
                timeKey: toSafeNumber(entry?.timeKey),
                workspaceUri: String(entry?.workspaceUriStr || '')
              });
            }
          }
        }
      }
    } catch {}

    // DOM 项目标题栏回退与补充（兼容无 React Fiber 的环境及测试 DOM）
    try {
      const headers = document.querySelectorAll('[data-testid="project-header"]');
      for (const btn of headers) {
        const name = String(btn.getAttribute('data-project-label') || btn.textContent || '').replace(/\s+/g, ' ').trim();
        const wrap = btn.parentElement?.parentElement || btn.parentElement;
        const projLink = wrap?.querySelector?.('a[href*="project="]');
        const pid = parseProjectIdFromHref(projLink?.getAttribute?.('href')) || btn.getAttribute('data-project-id') || '';
        if (!pid || !name) continue;
        addProject({
          id: pid,
          name,
          kind: 'project',
          isCollapsed: btn.getAttribute('aria-expanded') === 'false'
        });
      }
    } catch {}

    return {
      projects: Array.from(projectMap.values()),
      conversations: convs
    };
  }

  function collectSidebarConversations(limit = 0, preloadedStoreCatalog = null) {
    const maxItems = Number(limit) > 0 ? Number(limit) : Infinity;
    const currentId = getSessionIdFromLocation() || '';
    const rows = getOrderedSidebarConversationRows();
    const list = [];
    const byId = new Map();
    const domProjectMap = new Map();

    // 从当前渲染序列追踪 DOM 行所属的项目头（用于无 Fiber 时的 DOM 分组推断）
    try {
      const nodes = document.querySelectorAll('[data-testid="project-header"], [data-testid="conversation-row-sidebar"]');
      let activeHeaderPid = '';
      for (const n of nodes) {
        if (n.getAttribute('data-testid') === 'project-header') {
          const wrap = n.parentElement?.parentElement || n.parentElement;
          const pLink = wrap?.querySelector?.('a[href*="project="]');
          activeHeaderPid = parseProjectIdFromHref(pLink?.getAttribute?.('href')) || n.getAttribute('data-project-id') || '';
        } else {
          const cid = extractSidebarRowId(n);
          if (cid && activeHeaderPid) domProjectMap.set(cid, activeHeaderPid);
        }
      }
    } catch {}

    const storeCatalog = preloadedStoreCatalog || extractSidebarStoreCatalog();
    const storeById = new Map(storeCatalog.conversations.map((c) => [c.id, c]));

    for (const row of rows) {
      const id = extractSidebarRowId(row);
      if (!id || byId.has(id)) continue;
      const storeMeta = storeById.get(id);
      const title = getSidebarRowDisplayTitle(row);
      const active = isSidebarRowActive(row, currentId);
      const domBusy = Boolean(row.querySelector('[data-testid="status-loading-spinner"], button[aria-label*="停止"], button[aria-label*="Stop"]'));
      const pinned = row.getAttribute('data-pinned') === 'true';
      const item = {
        id,
        title: title.slice(0, 80),
        active,
        projectId: storeMeta?.projectId || domProjectMap.get(id) || '',
        projectName: storeMeta?.projectName || '',
        domBusy,
        pinned,
        timeKey: toSafeNumber(storeMeta?.timeKey)
      };
      byId.set(id, item);
      list.push(item);
      if (list.length >= maxItems) break;
    }

    for (const sc of storeCatalog.conversations) {
      if (list.length >= maxItems) break;
      if (byId.has(sc.id)) continue;
      const item = {
        id: sc.id,
        title: sc.title,
        active: Boolean(currentId && sc.id === currentId),
        projectId: sc.projectId || '',
        projectName: sc.projectName || '',
        domBusy: false,
        pinned: false,
        timeKey: toSafeNumber(sc.timeKey)
      };
      byId.set(sc.id, item);
      list.push(item);
    }

    return list;
  }

  function collectSidebarProjectGroups(limit = 60) {
    const currentId = getSessionIdFromLocation() || '';
    const domRows = getOrderedSidebarConversationRows();
    const domRowMap = new Map();
    for (const row of domRows) {
      const id = extractSidebarRowId(row);
      if (!id) continue;
      domRowMap.set(id, {
        title: getSidebarRowDisplayTitle(row),
        active: isSidebarRowActive(row, currentId)
      });
    }

    const resolveConvTitle = (cid) => (
      domRowMap.get(cid)?.title
      || sidebarZhCache.get(cid)
      || sidebarRawTitleMap.get(cid)
      || cascadeSummaryMap.get(cid)?.title
      || `对话 ${cid.slice(0, 8)}`
    );

    const groups = [];
    const groupById = new Map();
    const ensureGroup = (gid, name, count = 0, isCollapsed = false) => {
      const key = String(gid || `name:${name}`).trim();
      if (groupById.has(key)) return groupById.get(key);
      const grp = {
        id: String(gid || ''),
        key,
        name: String(name || '未命名项目').trim() || '未命名项目',
        count: Number(count) || 0,
        isCollapsed: Boolean(isCollapsed),
        active: false,
        conversations: []
      };
      groups.push(grp);
      groupById.set(key, grp);
      return grp;
    };

    const fiberProps = findSidebarFiberProps();
    const fiberItems = Array.isArray(fiberProps?.items) ? fiberProps.items : null;
    if (fiberItems && fiberItems.some((x) => x && (x.type === 'header' || x.type === 'row'))) {
      let curGrp = null;
      for (const it of fiberItems) {
        if (!it || typeof it !== 'object') continue;
        if (it.type === 'header') {
          const gid = String(it.id || '').replace(/^header-/, '') || String(it.label || '未命名项目');
          curGrp = ensureGroup(gid, it.label || '未命名项目', it.count || 0, Boolean(it.isCollapsed));
        } else if (it.type === 'row') {
          const cid = String(it.cascadeId || it.id || '').trim();
          if (!cid) continue;
          const targetGrp = (it.groupId && groupById.get(String(it.groupId))) || curGrp || ensureGroup('default', '默认项目');
          if (targetGrp.conversations.some((c) => c.id === cid)) continue;
          const domMeta = domRowMap.get(cid);
          const active = Boolean(domMeta?.active || (currentId && cid === currentId));
          targetGrp.conversations.push({
            id: cid,
            title: resolveConvTitle(cid).slice(0, 80),
            active,
            project: targetGrp.name
          });
        }
      }
      if (cascadeSummaryMap.size > 0) {
        const summariesSorted = Array.from(cascadeSummaryMap.values()).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        for (const grp of groups) {
          if (grp.conversations.length > 0 && grp.conversations.length >= grp.count) continue;
          for (const meta of summariesSorted) {
            if (!meta || meta.project !== grp.name) continue;
            if (grp.conversations.some((c) => c.id === meta.id)) continue;
            grp.conversations.push({
              id: meta.id,
              title: resolveConvTitle(meta.id).slice(0, 80),
              active: Boolean(domRowMap.get(meta.id)?.active || (currentId && meta.id === currentId)),
              project: grp.name
            });
          }
        }
      }
    } else {
      const container = document.querySelector('[data-testid="conversation-list-sidebar"]') || document;
      const nodes = container.querySelectorAll('[data-testid="project-header"], [data-testid="conversation-row-sidebar"]');
      let curGrp = null;
      for (const node of nodes) {
        const tid = node.getAttribute?.('data-testid');
        if (tid === 'project-header') {
          const pname = (node.textContent || '').replace(/\s+/g, ' ').trim() || '未命名项目';
          curGrp = ensureGroup(`dom:${pname}`, pname);
        } else if (tid === 'conversation-row-sidebar') {
          const cid = extractSidebarRowId(node);
          if (!cid) continue;
          const targetGrp = curGrp || ensureGroup('dom:默认项目', '默认项目');
          if (targetGrp.conversations.some((c) => c.id === cid)) continue;
          const active = isSidebarRowActive(node, currentId);
          targetGrp.conversations.push({
            id: cid,
            title: getSidebarRowDisplayTitle(node).slice(0, 80),
            active,
            project: targetGrp.name
          });
        }
      }
    }

    let projectGroups = groups.filter((g) => g.conversations.length > 0 || g.count > 0);
    if (!projectGroups.length && groups.length) projectGroups = groups;

    const flatConversations = [];
    for (const grp of projectGroups) {
      grp.count = Math.max(grp.count || 0, grp.conversations.length);
      grp.active = grp.conversations.some((c) => c.active);
      for (const conv of grp.conversations) {
        if (flatConversations.length < limit || conv.active) {
          if (!flatConversations.some((c) => c.id === conv.id)) {
            flatConversations.push(conv);
          }
        }
      }
    }
    return { projectGroups, conversations: flatConversations.slice(0, limit) };
  }

  function getModelSelectorContext() {
    try {
      const btn = document.querySelector('[data-testid="model-selector-trigger"]');
      if (!btn) return null;
      const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? btn[fk] : null;
      for (let i = 0; i < 28 && f; i++) {
        const v = f.memoizedProps?.value;
        if (v && typeof v.setSelectedModel === 'function' && Array.isArray(v.modelOptions)) {
          return v;
        }
        f = f.return;
      }
    } catch {}
    return null;
  }

  function getPermissionPresetsMeta() {
    return [
      { key: 'turbo', label: '⚡ 无限 (Turbo)' },
      { key: 'auto', label: '🛡️ 自动 (Auto)' },
      { key: 'default', label: '🔒 默认 (Default)' },
      { key: 'request_review', label: '👁️ 请求审核 (Review)' }
    ];
  }

  const PERMISSION_DEFAULT_LABELS = {
    turbo: '无限',
    auto: '自动',
    default: '默认',
    request_review: '请求审核'
  };

  function resolvePermissionStateFromDom(permBtn) {
    const rawText = (permBtn?.textContent || '').replace(/\s+/g, ' ').trim();
    const presetAttr = String(permBtn?.getAttribute?.('data-perm-preset') || '').trim().toLowerCase();
    const aria = String(permBtn?.getAttribute?.('aria-label') || '').trim();
    const svgEl = permBtn?.querySelector?.('svg');
    const svgSig = String(svgEl?.innerHTML || svgEl?.querySelector?.('path')?.getAttribute?.('d') || '');

    let key = '';
    if (presetAttr === 'turbo' || presetAttr === 'auto' || presetAttr === 'default' || presetAttr === 'request_review') {
      key = presetAttr;
    } else {
      const combined = `${rawText} ${aria}`.toLowerCase();
      if (/(?:turbo|无限|unrestricted)/i.test(combined)) key = 'turbo';
      else if (/(?:request_review|review|请求审核|请求审查|审核|审查)/i.test(combined)) key = 'request_review';
      else if (/(?:\bauto\b|自动)/i.test(combined)) key = 'auto';
      else if (/(?:\bdefault\b|默认)/i.test(combined)) key = 'default';
      else if (svgSig.includes('502.92-344.77')) key = 'turbo';
      else if (svgSig.includes('595.58-384.51')) key = 'request_review';
      else if (svgSig.includes('252.31-100')) key = 'default';
      else if (svgSig.includes('480-100.77')) key = 'auto';
      else key = 'unknown';
    }
    const label = rawText || PERMISSION_DEFAULT_LABELS[key] || '未知';
    return { permissionKey: key, permissionLabel: label };
  }

  function collectDesktopContextPanelData(sr, pulseEl, contextBadge, model) {
    const ctxData = pulseEl?.__ctxUsageData || null;
    const readText = (id) => (sr?.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
    const usedText = readText('key-used');
    const limitText = readText('key-limit');
    const remainingText = readText('key-remaining');
    const keyBadge = readText('key-badge');
    const speedVal = readText('speed-val');
    const durationText = readText('speed-duration');
    const ttftText = readText('speed-ttft');
    const outputTokensText = readText('speed-tokens');
    const roundCostText = readText('round-cost-text');
    const sessionCostText = readText('session-cost-text');
    const pctText = readText('badge-pct-val') || contextBadge || '';
    const pctMatch = pctText.match(/(\d+(?:\.\d+)?)\s*%/);
    const usagePercent = ctxData && typeof ctxData.usagePercent === 'number'
      ? Number(ctxData.usagePercent)
      : (pctMatch ? Number(pctMatch[1]) : null);
    const speedMatch = speedVal.match(/(\d+(?:\.\d+)?)/);
    const durMatch = durationText.match(/(\d+(?:\.\d+)?)/);
    return {
      usedTokens: ctxData && typeof ctxData.contextUsed === 'number' ? ctxData.contextUsed : null,
      limitTokens: ctxData && typeof ctxData.contextLimit === 'number' ? ctxData.contextLimit : null,
      usagePercent,
      cacheHitRate: ctxData && typeof ctxData.cacheHitRate === 'number' ? ctxData.cacheHitRate : null,
      tokPerSec: ctxData && typeof ctxData.tokPerSec === 'number'
        ? ctxData.tokPerSec
        : (speedMatch ? Number(speedMatch[1]) : null),
      lastDurationSec: ctxData && typeof ctxData.lastDurationSec === 'number'
        ? ctxData.lastDurationSec
        : (durMatch ? Number(durMatch[1]) : null),
      outputTokens: ctxData && typeof ctxData.outputTokens === 'number' ? ctxData.outputTokens : null,
      modelDisplayName: ctxData?.modelDisplayName || model || '',
      contextBadge: contextBadge || '',
      usedText,
      limitText,
      remainingText,
      keyBadge,
      speedText: speedVal,
      durationText,
      ttftText,
      outputTokensText,
      roundCostText,
      sessionCostText
    };
  }

  function collectDesktopUsageSummary(sr) {
    const hist = window.__AGContextMeterHistory || null;
    const sum = hist?.summary || null;
    const badgeText = (sr?.getElementById('badge-tokens')?.textContent || '').replace(/\s+/g, ' ').trim();
    const refCost = hist?.referenceCost || hist?.costEstimate || null;
    return {
      todayTokens: Number(sum?.todayTokens || 0) || 0,
      sevenDayTokens: Number(sum?.sevenDayTokens || 0) || 0,
      thirtyDayTokens: Number(sum?.thirtyDayTokens || 0) || 0,
      totalTokens: Number(sum?.totalTokens || 0) || 0,
      sessionCount: Number(sum?.sessionCount || 0) || 0,
      totalCostUsd: Number(refCost?.totalUsd ?? sum?.totalCostUsd ?? 0) || 0,
      badgeText
    };
  }

  function parseRpcDurationSec(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (!raw || typeof raw !== 'string') return null;
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s)?$/i);
    if (!m) return null;
    const val = Number(m[1]);
    if (!Number.isFinite(val)) return null;
    return String(m[2] || '').toLowerCase() === 'ms' ? val / 1000 : val;
  }

  function formatRpcTokensShort(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1000000) return `${(v / 1000000).toFixed(v >= 10000000 ? 1 : 2).replace(/\.0+$/, '')}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(v));
  }

  async function callLanguageServerRpc(method, body = {}, timeoutMs = 4500) {
    const csrf = window.__APP_CONFIG__?.csrfToken;
    if (!csrf) throw new Error('缺少语言服务凭证 (csrfToken)');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
    try {
      const resp = await fetch(`/exa.language_server_pb.LanguageServerService/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        },
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined
      });
      if (!resp.ok) throw new Error(`RPC ${method} HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function extractMessagesFromTrajectorySteps(steps, limit = 20) {
    const list = Array.isArray(steps) ? steps : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || typeof s !== 'object') continue;
      if (s.userInput) {
        const u = s.userInput;
        const text = String(
          u.userResponse ||
          (Array.isArray(u.items) ? u.items.map((item) => item?.text || '').filter(Boolean).join('\n') : '') ||
          ''
        ).trim();
        if (text) {
          out.push({ id: `rpc-u-${i}`, role: 'user', text: text.slice(0, 4000), html: '' });
        }
      } else if (s.plannerResponse) {
        const pr = s.plannerResponse;
        const text = String(pr.modifiedResponse || pr.response || '').trim();
        const thoughtText = String(pr.thinking || '').trim();
        if (text || thoughtText) {
          out.push({
            id: `rpc-a-${i}`,
            role: 'assistant',
            text: text.slice(0, 4000),
            html: '',
            thoughtLabel: thoughtText ? tr('已思考', 'Thought') : '',
            thoughtText: thoughtText.slice(0, 1200),
            highRisk: false,
            riskText: ''
          });
        }
      } else if (s.errorMessage) {
        const errObj = s.errorMessage.error || s.errorMessage || {};
        const errText = String(errObj.modelErrorMessage || errObj.shortError || errObj.fullError || '').trim();
        if (errText) {
          out.push({
            id: `rpc-e-${i}`,
            role: 'assistant',
            text: errText.slice(0, 2000),
            html: '',
            thoughtLabel: '',
            thoughtText: '',
            highRisk: true,
            riskText: tr('步骤异常', 'Step Error')
          });
        }
      }
    }
    return out.slice(-limit);
  }

  function cloneSidebarWithActiveConversation(conversations, projectGroups, activeId) {
    const nextConvs = (Array.isArray(conversations) ? conversations : []).map((c) => ({
      ...c,
      active: Boolean(activeId && c.id === activeId)
    }));
    const nextGroups = (Array.isArray(projectGroups) ? projectGroups : []).map((g) => ({
      ...g,
      conversations: (Array.isArray(g.conversations) ? g.conversations : []).map((c) => ({
        ...c,
        active: Boolean(activeId && c.id === activeId)
      }))
    }));
    return { conversations: nextConvs, projectGroups: nextGroups };
  }

  function getMobileSnapshot() {
    const sessionId = getSessionIdFromLocation() || '';
    if (window.__APP_CONFIG__?.csrfToken && (Date.now() - lastCascadeSummaryFetchAt) >= 20000) {
      lastCascadeSummaryFetchAt = Date.now();
      void refreshCascadeTrajectorySummaries();
    }
    const storeCatalog = extractSidebarStoreCatalog();
    const conversations = collectSidebarConversations(0, storeCatalog);
    const { projectGroups } = collectSidebarProjectGroups(60);
    const activeConv = conversations.find((c) => c.active);
    const busy = isAssistantBusy();
    const locProjectId = getProjectIdFromLocation();
    const currentProjectId = locProjectId || activeConv?.projectId || '';
    const matchedProj = storeCatalog.projects.find((p) => p.id === currentProjectId);
    const currentProjectName = activeConv?.projectName || matchedProj?.name || '';
    const isNewConversation = !sessionId;
    const { sr } = getMeterHostAndShadow();
    const contextBadge = (
      sr?.getElementById('amount')?.textContent ||
      sr?.getElementById('badge-pct-val')?.textContent ||
      sr?.getElementById('badge')?.textContent ||
      ''
    ).replace(/\s+/g, ' ').trim();
    const speedBadge = (sr?.getElementById('badge-speed')?.textContent || '').replace(/\s+/g, ' ').trim();
    const pulseEl = document.querySelector('[data-agy-context-capsule="1"]');
    const rawPulse = (pulseEl?.textContent || speedBadge || '').replace(/\s+/g, ' ').trim();
    const speedMatch = rawPulse.match(/(\d+(?:\.\d+)?\s*tok\/s)/i);
    const ratioMatch = contextBadge.match(/(\d+(?:\.\d+)?[KM]?\s*\(\d+(?:\.\d+)?%\))/);
    const pulseText = [speedMatch ? speedMatch[1] : '', ratioMatch ? ratioMatch[1] : contextBadge].filter(Boolean).join(' · ') || rawPulse;
    const modelCtx = getModelSelectorContext();
    const model = modelCtx?.selectedModel?.label || detectCurrentModelText();
    const EFFORT_ORDER = { xhigh: 1, high: 2, medium: 3, low: 4 };
    const rawModels = Array.isArray(modelCtx?.modelOptions)
      ? modelCtx.modelOptions.filter((o) => o && !o.disabled && o.label)
      : [];
    const familyOrder = new Map();
    const parsedModels = rawModels.map((o, idx) => {
      const label = String(o.label);
      const m = label.match(/^(.*?)\s*\((XHigh|High|Medium|Low)\)\s*$/i);
      const family = m ? m[1].trim().toLowerCase() : label.trim().toLowerCase();
      const effort = m ? (EFFORT_ORDER[m[2].toLowerCase()] || 9) : 0;
      if (!familyOrder.has(family)) familyOrder.set(family, idx);
      return {
        label,
        modelId: String(o.modelId || ''),
        selected: Boolean(o.label === modelCtx?.selectedModel?.label),
        familyRank: familyOrder.get(family),
        effortRank: effort,
        origIdx: idx
      };
    });
    parsedModels.sort((a, b) => (a.familyRank - b.familyRank) || (a.effortRank - b.effortRank) || (a.origIdx - b.origIdx));
    const modelOptions = parsedModels.map(({ label, modelId, selected }) => ({ label, modelId, selected }));
    const permBtn = document.querySelector('[data-testid="permissions-selector-trigger"]');
    const { permissionKey, permissionLabel } = resolvePermissionStateFromDom(permBtn);
    const pendingApprovals = collectPendingApprovals();
    const messages = collectRecentMessages(60);
    const suggestions = !busy ? computeNextStepCandidates().candidates : [];
    const contextPanel = collectDesktopContextPanelData(sr, pulseEl, contextBadge, model);
    const usageSummary = collectDesktopUsageSummary(sr);

    if (activeConv) {
      if (pendingApprovals.length > 0) activeConv.status = 'waiting';
      else if (busy) activeConv.status = 'running';
    }

    const title = activeConv?.title
      || (isNewConversation ? (currentProjectName ? `新建对话 · ${currentProjectName}` : '新建对话') : (document.title || 'Antigravity'));

    return {
      ok: true,
      version: '1.8.0',
      timestamp: Date.now(),
      sessionId,
      activeConversationId: sessionId,
      desktopSessionId: sessionId,
      isolated: false,
      isNewConversation,
      currentProjectId,
      currentProjectName,
      title,
      busy,
      autoAccept: autoAcceptEnabled,
      model,
      modelOptions,
      permissionKey,
      permissionLabel,
      permissionOptions: getPermissionPresetsMeta(),
      contextBadge,
      pulseText,
      contextPanel,
      usageSummary,
      quota: {
        activePoolKey: quotaState.activePoolKey,
        gemini: quotaState.gemini,
        claude: quotaState.claude,
        lastFetchedAt: quotaState.lastFetchedAt
      },
      pendingApprovals,
      suggestions,
      messages,
      projects: storeCatalog.projects,
      conversations,
      projectGroups
    };
  }

  async function fetchIsolatedConversationSnapshot(baseSnap, reqConvId) {
    try {
      const full = await callLanguageServerRpc('GetCascadeTrajectory', {
        cascadeId: reqConvId,
        trajectoryVerbosity: 3
      }, 4500);
      const trajectory = full?.trajectory;
      if (!trajectory || typeof trajectory !== 'object') {
        throw new Error('未取得目标会话历史');
      }
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps.slice() : [];
      const expected = Number(full?.numTotalSteps ?? steps.length);
      if (expected > steps.length) {
        let offset = Math.max(steps.length, expected - 80);
        for (let n = 0; n < 4 && offset < expected; n++) {
          const page = await callLanguageServerRpc('GetCascadeTrajectorySteps', {
            cascadeId: reqConvId,
            stepOffset: offset,
            trajectoryVerbosity: 3
          }, 3500).catch(() => null);
          const chunk = Array.isArray(page?.steps) ? page.steps : [];
          if (!chunk.length) break;
          steps.push(...chunk);
          offset += chunk.length;
        }
      }

      const genCount = Number(full?.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
      let genList = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
      if (genCount > 0) {
        const tail = await callLanguageServerRpc('GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: reqConvId,
          generatorMetadataOffset: Math.max(0, genCount - 3),
          includeMessages: false
        }, 3000).catch(() => null);
        if (Array.isArray(tail?.generatorMetadata) && tail.generatorMetadata.length) {
          genList = tail.generatorMetadata;
        }
      }

      let validMeta = null;
      for (let i = genList.length - 1; i >= 0; i--) {
        const cand = genList[i];
        if (cand && (cand.chatModel || cand.usage)) {
          validMeta = cand;
          break;
        }
      }

      const cm = validMeta?.chatModel || null;
      const u = cm?.usage || validMeta?.usage || {};
      const input = Number(u.inputTokens || 0) || 0;
      const cached = Number(u.cacheReadTokens || 0) || 0;
      const output = Number(u.outputTokens || 0) || 0;
      const ctxMeta = cm?.chatStartMetadata?.contextWindowMetadata || {};
      const usedTokens = (input + cached + output) || Number(ctxMeta.estimatedTokensUsed || 0) || 0;
      const limitTokens = Number(ctxMeta.maxContextTokens || 0) || 0;
      const usagePercent = limitTokens > 0
        ? Number(((usedTokens / limitTokens) * 100).toFixed(1))
        : null;
      const cacheHitRate = (input + cached) > 0
        ? Number(((cached / (input + cached)) * 100).toFixed(1))
        : null;
      const ttft = parseRpcDurationSec(cm?.timeToFirstToken);
      const streaming = parseRpcDurationSec(cm?.streamingDuration);
      const dur = (ttft != null && streaming != null)
        ? Number((ttft + streaming).toFixed(2))
        : (streaming != null ? Number(streaming.toFixed(2)) : (ttft != null ? Number(ttft.toFixed(2)) : null));
      const tokPerSec = (output > 0 && dur && dur > 0)
        ? Number((output / dur).toFixed(1))
        : null;
      const isolatedModel = cm?.modelDisplayName || cm?.responseModel || cm?.model || baseSnap.model || '';
      const isolatedContextBadge = limitTokens > 0
        ? `${formatRpcTokensShort(usedTokens)}/${formatRpcTokensShort(limitTokens)} (${usagePercent ?? 0}%)`
        : (usedTokens > 0 ? formatRpcTokensShort(usedTokens) : '独立视图');
      const isolatedPulseText = [
        tokPerSec ? `${tokPerSec} tok/s` : '',
        isolatedContextBadge
      ].filter(Boolean).join(' · ');

      const messages = extractMessagesFromTrajectorySteps(steps, 20);
      const lastStep = steps.length ? steps[steps.length - 1] : null;
      const busy = /RUNNING|IN_PROGRESS|ACTIVE|EXECUTING/i.test(String(trajectory.status || '')) ||
        /RUNNING|PENDING|GENERATING/i.test(String(lastStep?.status || ''));

      let lastAssistantText = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].text) {
          lastAssistantText = messages[i].text;
          break;
        }
      }
      const suggestions = !busy
        ? computeNextStepCandidatesFromText(reqConvId, lastAssistantText, usagePercent || 0, steps.length).candidates
        : [];
      const cloned = cloneSidebarWithActiveConversation(baseSnap.conversations, baseSnap.projectGroups, reqConvId);
      const matchedConv = cloned.conversations.find((c) => c.id === reqConvId);
      const matchedGroup = (cloned.projectGroups || []).find((g) => (g.conversations || []).some((c) => c.id === reqConvId)) || null;
      const targetProjectId = String(matchedConv?.projectId || matchedGroup?.id || trajectory?.trajectoryMetadata?.projectId || '').trim();
      const targetProjectName = String(matchedConv?.projectName || matchedGroup?.name || '').trim();
      const title = matchedConv?.title || cascadeSummaryMap.get(reqConvId)?.title || String(trajectory.summary || '').trim() || `会话 ${reqConvId.slice(0, 8)}`;

      return {
        ...baseSnap,
        sessionId: reqConvId,
        activeConversationId: reqConvId,
        desktopSessionId: baseSnap.sessionId || '',
        isolated: true,
        isNewConversation: false,
        currentProjectId: targetProjectId,
        currentProjectName: targetProjectName,
        title,
        busy,
        model: isolatedModel,
        contextBadge: isolatedContextBadge,
        pulseText: isolatedPulseText,
        contextPanel: {
          usedTokens: usedTokens || null,
          limitTokens: limitTokens || null,
          usagePercent,
          cacheHitRate,
          tokPerSec,
          lastDurationSec: dur,
          outputTokens: output || null,
          modelDisplayName: isolatedModel,
          contextBadge: isolatedContextBadge,
          usedText: usedTokens > 0 ? formatRpcTokensShort(usedTokens) : '—',
          limitText: limitTokens > 0 ? formatRpcTokensShort(limitTokens) : '—',
          remainingText: limitTokens > usedTokens ? formatRpcTokensShort(limitTokens - usedTokens) : (limitTokens > 0 ? '0' : '—'),
          keyBadge: `${usagePercent ?? '--'}%`,
          speedText: tokPerSec ? `${tokPerSec} tok/s` : '—',
          durationText: dur != null ? `${dur}s` : '—',
          ttftText: ttft != null ? `${ttft}s` : '—',
          outputTokensText: output > 0 ? `${output}` : '—',
          roundCostText: '',
          sessionCostText: ''
        },
        pendingApprovals: [],
        suggestions,
        messages,
        conversations: cloned.conversations,
        projectGroups: cloned.projectGroups
      };
    } catch (err) {
      const cloned = cloneSidebarWithActiveConversation(baseSnap.conversations, baseSnap.projectGroups, reqConvId);
      const matchedConv = cloned.conversations.find((c) => c.id === reqConvId);
      const matchedGroup = (cloned.projectGroups || []).find((g) => (g.conversations || []).some((c) => c.id === reqConvId)) || null;
      const targetProjectId = String(matchedConv?.projectId || matchedGroup?.id || '').trim();
      const targetProjectName = String(matchedConv?.projectName || matchedGroup?.name || '').trim();
      return {
        ...baseSnap,
        sessionId: reqConvId,
        activeConversationId: reqConvId,
        desktopSessionId: baseSnap.sessionId || '',
        isolated: true,
        isNewConversation: false,
        currentProjectId: targetProjectId,
        currentProjectName: targetProjectName,
        conversations: cloned.conversations,
        projectGroups: cloned.projectGroups,
        isolationWarning: err?.message || '无法独立读取该会话'
      };
    }
  }

  async function getMobileSnapshotAsync(opts = {}) {
    const baseSnap = getMobileSnapshot();
    const reqConvId = String(opts?.conversationId || '').trim();
    if (!reqConvId || reqConvId === (baseSnap.sessionId || '') || reqConvId === '__new__') {
      return {
        ...baseSnap,
        activeConversationId: baseSnap.sessionId || '',
        desktopSessionId: baseSnap.sessionId || '',
        isolated: false
      };
    }
    return await fetchIsolatedConversationSnapshot(baseSnap, reqConvId);
  }

  async function switchToConversationInternal(rawTargetId) {
    const targetId = String(rawTargetId || '').trim();
    if (!targetId) return { ok: false, error: '缺少会话 ID' };
    if (targetId === 'new') {
      const newBtn = document.querySelector('a[data-testid="new-conversation-button"], [data-testid="new-conversation-button"] a, [data-testid="new-conversation-button"]');
      if (!newBtn) return { ok: false, error: '未找到新建对话按钮' };
      newBtn.click();
      await new Promise((r) => setTimeout(r, 180));
      return { ok: true, id: 'new' };
    }
    let row = findSidebarRowById(targetId);
    let link = row?.querySelector('a[href]') || document.querySelector(`a[href*="/c/${escapeCssIdent(targetId)}"]`);
    let clickTarget = link || row;
    if (!clickTarget) {
      const props = findSidebarFiberProps();
      const rowItem = props?.items?.find((x) => x && x.type === 'row' && (x.cascadeId === targetId || x.id === targetId));
      if (rowItem?.groupId) {
        const hdrItem = props.items.find((x) => x && x.type === 'header' && (x.id === `header-${rowItem.groupId}` || x.id === rowItem.groupId));
        if (hdrItem?.isCollapsed) {
          const domHdr = Array.from(document.querySelectorAll('[data-testid="project-header"]'))
            .find((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === String(hdrItem.label || '').trim());
          if (domHdr) domHdr.click();
          else if (typeof props.onToggleCollapseSection === 'function') props.onToggleCollapseSection(hdrItem.collapseId || hdrItem.id);
          await new Promise((r) => setTimeout(r, 140));
          row = findSidebarRowById(targetId);
          link = row?.querySelector('a[href]') || document.querySelector(`a[href*="/c/${escapeCssIdent(targetId)}"]`);
          clickTarget = link || row;
        }
      }
    }
    if (clickTarget) {
      clickTarget.click();
      await new Promise((r) => setTimeout(r, 180));
      return { ok: true, id: targetId, pathname: location.pathname };
    }
    if (typeof window.history?.pushState === 'function') {
      window.history.pushState(null, '', `/c/${encodeURIComponent(targetId)}`);
      if (typeof PopStateEvent === 'function') {
        window.dispatchEvent(new PopStateEvent('popstate'));
      } else {
        window.dispatchEvent(new Event('popstate'));
      }
      await new Promise((r) => setTimeout(r, 180));
      return { ok: true, id: targetId, pathname: location.pathname, method: 'history' };
    }
    return { ok: false, error: '未在侧边栏找到该会话' };
  }

  async function executeMobileActionCore(action, payload) {
    if (action === 'send') {
      const text = String(payload?.text || '').trim();
      if (!text) return { ok: false, error: '发送内容不能为空' };
      const filled = await fillComposerText(text);
      if (!filled) return { ok: false, error: '未能填入输入框' };
      let sendBtn = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 35));
        sendBtn =
          document.querySelector('.surface-composer [data-testid="send-button"]') ||
          document.querySelector('.surface-composer .agy-send-button') ||
          document.querySelector('.surface-composer button[aria-label*="Send"], .surface-composer button[aria-label*="发送"]');
        if (sendBtn && !sendBtn.disabled) break;
      }
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        lastUserSubmitAt = Date.now();
        hideNextStepGhost();
        return { ok: true, method: 'button' };
      }
      const ed = getComposerEditor();
      if (ed) {
        ed.focus();
        const evOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        ed.dispatchEvent(new KeyboardEvent('keydown', evOpts));
        ed.dispatchEvent(new KeyboardEvent('keyup', evOpts));
        lastUserSubmitAt = Date.now();
        hideNextStepGhost();
        return { ok: true, method: 'enter' };
      }
      return { ok: false, error: '未找到发送按钮或输入框' };
    }

    if (action === 'fill') {
      const ok = await fillComposerText(String(payload?.text || ''));
      return { ok };
    }

    if (action === 'stop') {
      const cancelBtn =
        document.querySelector('.surface-composer [data-testid="input-cancel-button"]') ||
        document.querySelector('[data-testid="input-cancel-button"]');
      if (!cancelBtn || cancelBtn.disabled) return { ok: false, error: '当前未在执行中' };
      cancelBtn.click();
      return { ok: true };
    }

    if (action === 'toggle-auto-accept') {
      autoAcceptEnabled = !autoAcceptEnabled;
      updateAutoAcceptBtn();
      showQuickToast(autoAcceptEnabled ? '🤖 自动确认已开启（仅限安全确认按钮）' : '🤖 自动确认已关闭');
      if (autoAcceptEnabled) runAutoAcceptTick();
      return { ok: true, autoAccept: autoAcceptEnabled };
    }

    if (action === 'click-approval') {
      const candidates = findApprovalCandidateButtons();
      if (!candidates.length) return { ok: false, error: '当前没有待审批操作' };
      const reqLabel = String(payload?.label || '').trim();
      const reqIndex = Number.isInteger(payload?.index) ? payload.index : -1;
      let picked = null;
      if (reqLabel) {
        picked = candidates.find((c) => c.label === reqLabel) || null;
      }
      if (!picked && reqIndex >= 0 && reqIndex < candidates.length) {
        picked = candidates[reqIndex];
      }
      if (!picked) return { ok: false, error: '目标审批按钮已消失或已处理' };
      picked.btn.click();
      return { ok: true, label: picked.label, kind: picked.kind };
    }

    if (action === 'expand-project') {
      const groupId = String(payload?.groupId || '').trim();
      const groupName = String(payload?.name || '').trim();
      const headers = Array.from(document.querySelectorAll('[data-testid="project-header"]'));
      const domHdr = groupName ? headers.find((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === groupName) : null;
      const props = findSidebarFiberProps();
      const hdrItem = props?.items?.find((x) =>
        x && x.type === 'header' && (
          (groupId && (String(x.id || '') === groupId || String(x.id || '') === `header-${groupId}`))
          || (groupName && String(x.label || '').trim() === groupName)
        )
      );
      if (hdrItem?.isCollapsed) {
        if (domHdr) {
          domHdr.click();
        } else if (typeof props?.onToggleCollapseSection === 'function') {
          props.onToggleCollapseSection(hdrItem.collapseId || hdrItem.id || groupId);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { ok: true, groupId, name: groupName };
    }

    if (action === 'new-conversation' || (action === 'switch-conversation' && String(payload?.id || '').trim() === 'new')) {
      const projectId = String(payload?.projectId || '').trim();
      const skipProject = !projectId || projectId === 'ungrouped' || projectId === 'outside-of-project' || projectId === 'standalone';
      const expectedPid = skipProject ? '' : projectId;
      const targetHref = skipProject ? '/' : `/?project=${encodeURIComponent(projectId)}`;
      const nav = await navigateSpaRoute(targetHref, { preferNativeProjectAction: Boolean(expectedPid) });
      if (!nav.ok) return { ok: false, error: nav.error || '新建对话导航失败' };
      const verified = await waitForVerifiedNavigationState('new', expectedPid, 1200);
      if (!verified.ok) {
        return {
          ok: false,
          error: expectedPid ? `桌面端未进入目标项目新建对话状态: ${expectedPid}` : '桌面端未进入新建对话状态',
          method: nav.method,
          verifiedState: verified.state
        };
      }
      return {
        ok: true,
        id: 'new',
        projectId: expectedPid,
        method: nav.method,
        pathname: location?.pathname || '/',
        search: location?.search || '',
        verifiedState: verified.state
      };
    }

    if (action === 'switch-conversation') {
      const targetId = String(payload?.id || '').trim();
      if (!targetId) return { ok: false, error: '缺少会话 ID' };
      const nav = await navigateSpaRoute(`/c/${targetId}`);
      if (!nav.ok) return { ok: false, error: nav.error || '未找到该会话的跳转入口' };
      const verified = await waitForVerifiedNavigationState('switch', targetId, 1200);
      if (!verified.ok) {
        return {
          ok: false,
          error: `桌面端未切换至目标会话状态: ${targetId}`,
          method: nav.method,
          verifiedState: verified.state
        };
      }
      return {
        ok: true,
        id: targetId,
        method: nav.method,
        pathname: location?.pathname || `/c/${targetId}`,
        verifiedState: verified.state
      };
    }

    if (action === 'toggle-thinking') {
      const toggled = toggleAllThinking();
      return { ok: true, toggled };
    }

    if (action === 'refresh-quota') {
      await refreshQuota();
      return {
        ok: true,
        quota: {
          activePoolKey: quotaState.activePoolKey,
          gemini: quotaState.gemini,
          claude: quotaState.claude,
          lastFetchedAt: quotaState.lastFetchedAt
        }
      };
    }

    if (action === 'select-model') {
      const targetLabel = String(payload?.label || '').trim();
      const targetModelId = String(payload?.modelId || '').trim();
      const modelCtx = getModelSelectorContext();
      if (!modelCtx || !Array.isArray(modelCtx.modelOptions)) {
        return { ok: false, error: '未找到桌面端模型选择器' };
      }
      const picked = modelCtx.modelOptions.find((o) =>
        o && !o.disabled && (
          (targetLabel && o.label === targetLabel) ||
          (targetModelId && o.modelId === targetModelId)
        )
      );
      if (!picked) {
        return { ok: false, error: `未找到目标模型: ${targetLabel || targetModelId}` };
      }
      modelCtx.setSelectedModel(picked);
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, model: picked.label };
    }

    if (action === 'select-permission') {
      const preset = String(payload?.preset || '').trim();
      if (!preset) return { ok: false, error: '缺少权限预设名称' };
      const permBtn = document.querySelector('[data-testid="permissions-selector-trigger"]');
      if (!permBtn) return { ok: false, error: '未找到桌面端权限选择器' };
      if (permBtn.getAttribute('aria-disabled') === 'true' || permBtn.disabled) {
        return { ok: false, error: '当前会话不允许切换权限预设' };
      }

      let menuCtx = null;
      try {
        const fk = Object.keys(permBtn).find((k) => k.startsWith('__reactFiber$'));
        let f = fk ? permBtn[fk] : null;
        for (let i = 0; i < 20 && f; i++) {
          const v = f.memoizedProps?.value;
          if (v && typeof v.setIsOpen === 'function' && 'open' in v) {
            menuCtx = v;
            break;
          }
          f = f.return;
        }
      } catch {}

      if (menuCtx) menuCtx.setIsOpen(true);
      else permBtn.click();

      let opt = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 40));
        opt = document.querySelector(`[data-testid="permissions-preset-option-${CSS.escape(preset)}"]`);
        if (opt) break;
      }
      if (!opt) {
        if (menuCtx) menuCtx.setIsOpen(false);
        return { ok: false, error: `权限选项不可用: ${preset}` };
      }
      if (opt.getAttribute('aria-disabled') === 'true' || opt.hasAttribute('disabled')) {
        if (menuCtx) menuCtx.setIsOpen(false);
        return { ok: false, error: `该权限预设当前被锁定: ${preset}` };
      }
      opt.click();
      await new Promise((r) => setTimeout(r, 90));
      if (menuCtx && menuCtx.open) {
        menuCtx.setIsOpen(false);
      }
      const resolved = resolvePermissionStateFromDom(permBtn);
      const nextKey = resolved.permissionKey !== 'unknown' ? resolved.permissionKey : preset;
      return { ok: true, preset, permissionKey: nextKey, permissionLabel: resolved.permissionLabel };
    }

    if (action === 'upload-image') {
      const rawB64 = String(payload?.base64 || '').trim();
      if (!rawB64) return { ok: false, error: '缺少图片数据' };
      const cleanB64 = rawB64.replace(/^data:[^;]+;base64,/, '');
      const mimeType = String(payload?.mimeType || 'image/jpeg').trim() || 'image/jpeg';
      const fileName = String(payload?.name || `mobile-${Date.now()}.jpg`).trim();

      let bytes;
      try {
        const binStr = atob(cleanB64);
        bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      } catch {
        return { ok: false, error: '图片 Base64 解码失败' };
      }

      const inp =
        document.querySelector('.surface-composer input[type="file"]') ||
        document.querySelector('input[type="file"][multiple]') ||
        document.querySelector('input[type="file"]');
      if (!inp) return { ok: false, error: '未找到桌面端文件上传控件' };

      const file = new File([bytes], fileName, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      try {
        Object.defineProperty(inp, 'files', { configurable: true, writable: true, value: dt.files });
      } catch {
        inp.files = dt.files;
      }

      const pk = Object.keys(inp).find((k) => k.startsWith('__reactProps$'));
      if (pk && typeof inp[pk]?.onChange === 'function') {
        inp[pk].onChange({ target: inp, currentTarget: inp });
      } else {
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 90));
      return { ok: true, name: file.name, size: file.size };
    }

    return { ok: false, error: `未知操作: ${action}` };
  }

  async function performMobileAction(payload) {
    const action = String(payload?.action || '').trim();
    if (!action) return { ok: false, error: '缺少 action 参数' };

    const scopedActions = ['send', 'fill', 'stop', 'click-approval', 'select-model', 'select-permission', 'upload-image'];
    const reqConvId = String(payload?.conversationId || '').trim();
    const prevConvId = getSessionIdFromLocation() || '';
    const needsSwitch = Boolean(
      scopedActions.includes(action) &&
      reqConvId &&
      reqConvId !== '__new__' &&
      reqConvId !== prevConvId
    );

    if (!needsSwitch) {
      return await executeMobileActionCore(action, payload);
    }

    const sw = await switchToConversationInternal(reqConvId);
    if (!sw?.ok) return sw;
    await new Promise((r) => setTimeout(r, 150));

    try {
      return await executeMobileActionCore(action, payload);
    } finally {
      if (prevConvId && prevConvId !== reqConvId && payload?.restoreDesktop !== false) {
        await new Promise((r) => setTimeout(r, 120));
        await switchToConversationInternal(prevConvId).catch(() => {});
      }
    }
  }

    globalThis.__AGEnhancer = {
    version: '1.7.4',
    isAlive: () => {
      if (disposed) return false;
      const { sr } = getMeterHostAndShadow();
      return Boolean(sr && sr.getElementById(QUOTA_BADGE_ID) && sr.getElementById(REMOTE_BADGE_ID));
    },
    refreshQuota,
    toggleQuotaPopover,
    closeQuotaPopover: () => toggleQuotaPopover(false),
    toggleRemotePopover,
    closeRemotePopover: () => toggleRemotePopover(false),
    configureRemoteTunnel,
    refreshBrainStats,
    scanHighRiskCommands,
    toggleAllThinking,
    guardExpandedThinkingBlocks,
    enterFileEditor,
    saveFileEditor,
    exitFileEditor,
    isAssistantBusy,
    truncateNextStepText,
    ensureNextStepGhost,
    acceptNextStepSuggestion,
    cycleNextStepSuggestion,
    getNextStepState: () => ({ ...nextStepState, candidates: [...nextStepState.candidates] }),
    ensurePromptOptimizerControls,
    optimizeComposerPrompt,
    undoPromptOptimize,
    getLastPromptOptError: () => (promptOptState.lastError
      ? { ...promptOptState.lastError, attempts: [...(promptOptState.lastError.attempts || [])] }
      : null),
    getPromptOptModels: () => ({
      ...promptOptState.cacheModel,
      candidates: [...(promptOptState.cacheModel.candidates || [])]
    }),
    syncRemotePairData,
    getMobileSnapshot,
    getMobileSnapshotAsync,
    performMobileAction,
    extractExternalUrlFromTarget,
    openExternalUrlInSystemBrowser,
    getBrainStats: () => latestBrainStats,
    getAutoAccept: () => autoAcceptEnabled,
    setAutoAccept: (val) => {
      autoAcceptEnabled = Boolean(val);
      try { localStorage.setItem('ag_suite_auto_accept', autoAcceptEnabled ? 'true' : 'false'); } catch {}
      if (autoAcceptEnabled) runAutoAcceptTick();
    },
    getGhostSuggest: () => ghostSuggestEnabled,
    setGhostSuggest: (val) => {
      ghostSuggestEnabled = Boolean(val);
      try { localStorage.setItem('ag_suite_ghost_suggest', ghostSuggestEnabled ? 'true' : 'false'); } catch {}
      if (!ghostSuggestEnabled) hideNextStepGhost();
      else ensureNextStepGhost();
    },
    getAutoCompact: () => autoCompactEnabled,
    setAutoCompact: (val) => {
      autoCompactEnabled = Boolean(val);
      try { localStorage.setItem('ag_suite_auto_compact', autoCompactEnabled ? 'true' : 'false'); } catch {}
      if (!autoCompactEnabled) autoCompactState.idleSince = 0;
    },
    runAutoCompactTick,
    getFeatureFlags: () => ({ ...featureFlags }),
    getQuickPool: () => ({ ...quickPoolState }),
    fillComposerText,
    parseQuotaSummaryGroups,
    exportMarkdown,
    localizeSidebarConversations,
    localizeThinkingShells,
    translateExpandedThoughts,
    syncSidebarShortcutBadges,
    switchConversationByIndex: switchSidebarConversationByIndex,
    cycleConversation: cycleSidebarConversation,
    dispose
  };

  applyEnhancerFeatureVisibility();
  ensurePromptOptimizerControls();
  ensureNextStepGhost();
  ensureFileViewerEditor();
  syncSidebarShortcutBadges();
  scanHighRiskCommands();
  renderQuotaUI();
  guardExpandedThinkingBlocks();
  startLocalizationObserver();
  if (uiLang === 'zh') {
    localizeThinkingShells();
    void translateExpandedThoughts();
    void localizeSidebarConversations();
  } else {
    revertEnhancerTranslations();
  }
  lastQuotaFetchAt = Date.now();
  lastRemoteFetchAt = Date.now();
  if (featureFlags.showTopbarQuota !== false) void refreshQuota();
  if (featureFlags.showTopbarRemote !== false) void refreshRemotePairInfo(false);
})();

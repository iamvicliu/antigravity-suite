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
  const CLOUDFLARE_TUNNEL_DASHBOARD_URL = 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels';
  const CHECKBOX_CHECKED_SVG = '<svg class="ag-rp-icon ag-rp-ok" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4.5" fill="rgba(52, 211, 153, 0.16)" stroke="#34d399" stroke-width="2"></rect><polyline points="8.5 12.2 11.2 14.9 15.8 9.4" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>';
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
  }
  syncSuitePrefsFromStorage();
  let latestBrainStats = null;
  let lastBrainFetchAt = 0;
  let nextStepState = {
    candidates: [],
    index: 0,
    replySig: '',
    dismissedSig: '',
    visible: false
  };
  let isComposerComposing = false;
  let lastUserSubmitAt = 0;

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
      if (document.documentElement?.classList?.contains('light')) return 'light';
      if (document.documentElement?.classList?.contains('dark')) return 'dark';
      if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) return 'light';
    } catch {}
    return 'dark';
  }

  // 解析剩余百分比对应的视觉颜色：>=50% 绿，20%~50% 黄，<20% 红
  function getQuotaColor(frac) {
    if (typeof frac !== 'number' || !Number.isFinite(frac)) return '#9ca3af';
    const pct = frac * 100;
    if (pct >= 50) return '#34d399';
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
          color: #34d399;
        }
        :host([data-theme="light"]) #badge-remote[data-online="true"] {
          color: #059669;
        }
        #badge-remote .ag-remote-dot {
          display: none;
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: #34d399;
          flex-shrink: 0;
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
          border-color: rgba(52, 211, 153, 0.5);
          background: rgba(52, 211, 153, 0.16);
          color: #34d399;
        }
        :host([data-theme="light"]) .ag-rp-mini-btn[data-active="true"] {
          border-color: rgba(5, 150, 105, 0.45);
          background: rgba(5, 150, 105, 0.12);
          color: #059669;
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
          border: 1px solid rgba(249, 115, 22, 0.42);
          background: rgba(249, 115, 22, 0.12);
          color: #fb923c;
          font-size: 10.5px;
          font-weight: 500;
          line-height: 1.3;
          text-decoration: none;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease;
        }
        .ag-rp-cf-link:hover {
          background: rgba(249, 115, 22, 0.22);
          border-color: rgba(249, 115, 22, 0.62);
        }
        :host([data-theme="light"]) .ag-rp-cf-link {
          border-color: rgba(234, 88, 12, 0.36);
          background: rgba(234, 88, 12, 0.08);
          color: #c2410c;
        }
        :host([data-theme="light"]) .ag-rp-cf-link:hover {
          background: rgba(234, 88, 12, 0.15);
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
          border-color: rgba(56, 189, 248, 0.65);
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
          color: #34d399;
          font-weight: 600;
        }
        :host([data-theme="light"]) .ag-rp-sec[data-active="true"] {
          color: #059669;
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
          border-color: rgba(52, 211, 153, 0.34);
          background: rgba(52, 211, 153, 0.14);
        }
        .ag-rp-dev-chip[data-online="true"] .ag-rp-dev-dot {
          background: #34d399;
        }
        :host([data-theme="light"]) .ag-rp-dev-chip {
          background: var(--ag-bg-subcard, rgba(0, 0, 0, 0.035));
          border-color: var(--ag-border-subcard, rgba(0, 0, 0, 0.09));
        }
        :host([data-theme="light"]) .ag-rp-dev-chip[data-online="true"] {
          border-color: rgba(5, 150, 105, 0.28);
          background: rgba(5, 150, 105, 0.10);
        }
        :host([data-theme="light"]) .ag-rp-dev-chip[data-online="true"] .ag-rp-dev-dot {
          background: #059669;
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
    const pendingAct = remotePairState.tunnelBusy ? remotePairState.tunnelPendingAction : '';
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
      const channelsHtml = ep.channels.map((ch) => {
        const label = tr(ch.label || ch.key, ch.labelEn || ch.label || ch.key);
        const isEnabled = ch.key === 'tunnel'
          ? Boolean(ch.enabled || ch.state === 'running' || ch.state === 'starting' || pendingAct === 'quick' || pendingAct === 'named')
          : (ch.enabled !== false);
        let hostHtml = '';
        if (ch.key === 'tunnel' && pendingAct === 'quick') {
          hostHtml = `<span class="ag-rp-spin"></span>${escapeHtml(tr('正在切换临时隧道…', 'Switching to Quick Tunnel…'))}`;
        } else if (ch.key === 'tunnel' && pendingAct === 'named') {
          hostHtml = `<span class="ag-rp-spin"></span>${escapeHtml(tr('正在连接固定隧道…', 'Connecting Named Tunnel…'))}`;
        } else if (!isEnabled) {
          hostHtml = escapeHtml(ch.rawHost ? `${tr('已停用', 'Disabled')} · ${ch.rawHost}` : tr('已停用', 'Disabled'));
        } else if (ch.key === 'tunnel' && !ch.available && ch.state === 'starting') {
          hostHtml = `<span class="ag-rp-spin"></span>${escapeHtml(ch.displayHost || tr('正在分配公网隧道…', 'Provisioning Tunnel…'))}`;
        } else {
          hostHtml = escapeHtml(ch.displayHost || (ch.available ? '' : tr('未连接', 'Offline')));
        }
        const checkId = ch.key === 'tunnel' ? 'ag-rp-tunnel-toggle' : `ag-rp-toggle-${escapeHtml(ch.key)}`;
        const cfgLabel = remotePairState.tunnelConfigOpen
          ? tr('收起 ▴', 'Hide ▴')
          : tr('固定域名 ▾', 'Domain ▾');
        const toolsHtml = ch.key === 'tunnel'
          ? `<div class="ag-rp-channel-tools"><button id="ag-rp-tunnel-cfg-btn" class="ag-rp-mini-btn" type="button" ${busyAny ? 'disabled' : ''}>${escapeHtml(cfgLabel)}</button></div>`
          : '';
        return `<div class="ag-rp-channel-wrap">`
          + `<button id="${checkId}" class="ag-rp-channel ag-rp-check" data-channel="${escapeHtml(ch.key)}" data-channel-toggle="${escapeHtml(ch.key)}" role="checkbox" aria-checked="${isEnabled ? 'true' : 'false'}" title="${escapeHtml(isEnabled ? tr(`点击停用 ${label}`, `Click to disable ${label}`) : tr(`点击启用 ${label}`, `Click to enable ${label}`))}" type="button" ${remotePairState.tunnelBusy ? 'disabled' : ''}>`
          + `<span class="ag-rp-ch-left"><span class="ag-rp-check-box">${isEnabled ? CHECKBOX_CHECKED_SVG : CHECKBOX_UNCHECKED_SVG}</span><span>${escapeHtml(label)}</span></span>`
          + `<span class="ag-rp-ch-host">${hostHtml}</span>`
          + `</button>`
          + toolsHtml
          + `</div>`;
      }).join('');

      const saveBtnHtml = pendingAct === 'named'
        ? `<span class="ag-rp-spin"></span>${escapeHtml(tr('正在连接固定隧道…', 'Connecting…'))}`
        : escapeHtml(tr('保存并启用固定隧道', 'Save Named Tunnel'));
      const quickBtnHtml = pendingAct === 'quick'
        ? `<span class="ag-rp-spin"></span>${escapeHtml(tr('正在切换临时隧道…', 'Switching…'))}`
        : escapeHtml(tr('改用免登录临时隧道', 'Use Quick Tunnel'));

      const tunnelFormHtml = (tunnelCh && remotePairState.tunnelConfigOpen)
        ? `<div id="ag-rp-tunnel-form" class="ag-rp-tunnel-form">
            <div class="ag-rp-tunnel-head">
              <div class="ag-rp-tunnel-note">${escapeHtml(tr('默认免登录使用临时隧道 (*.trycloudflare.com)；如需固定域名，需自有域名并在隧道 Public Hostname 指向 http://127.0.0.1:18765（勿填 *.cloudflareaccess.com）：', 'Quick Tunnel needs no login (*.trycloudflare.com). For a fixed domain, bind your own domain in Tunnel Public Hostname -> http://127.0.0.1:18765 (do not enter *.cloudflareaccess.com):'))}</div>
              <a id="ag-rp-cf-get-token" class="ag-rp-cf-link" href="${CLOUDFLARE_TUNNEL_DASHBOARD_URL}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tr('在系统默认浏览器中打开 Cloudflare Zero Trust 隧道控制台创建并获取 Token', 'Open Cloudflare Zero Trust Tunnels in default browser to create & copy Token'))}">${escapeHtml(tr('☁️ 前往 Cloudflare 获取 Token ↗', '☁️ Get Token on Cloudflare ↗'))}</a>
            </div>
            <input id="ag-rp-cf-host" class="ag-rp-input" type="text" placeholder="https://ag.example.com" value="${escapeHtml(remotePairState.draftHost !== null ? remotePairState.draftHost : (tunnelCh.tunnelHostname || ''))}">
            <input id="ag-rp-cf-token" class="ag-rp-input" type="password" value="${escapeHtml(remotePairState.draftToken || '')}" placeholder="${escapeHtml(tunnelCh.hasTunnelToken ? tr('已保存 Token（留空保持不变，或粘贴新 eyJ...）', 'Token saved (leave blank to keep, or paste new eyJ...)') : tr('粘贴 eyJ... 或 cloudflared service install 命令', 'Paste eyJ... or cloudflared service install command'))}">
            <div class="ag-rp-actions">
              <button id="ag-rp-cf-save" class="ag-rp-mini-btn" data-active="true" style="flex:1" type="button" ${remotePairState.tunnelBusy ? 'disabled' : ''}>${saveBtnHtml}</button>
              <button id="ag-rp-cf-quick" class="ag-rp-mini-btn" type="button" ${remotePairState.tunnelBusy ? 'disabled' : ''}>${quickBtnHtml}</button>
            </div>
          </div>`
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
        : `<div class="ag-rp-status">${escapeHtml(tr('请至少勾选启用一种连接方式', 'Enable at least one connection mode'))}</div>`;

      bodyHtml = `
        ${qrOrEmptyHtml}
        <div class="ag-rp-channels">${channelsHtml}</div>
        ${tunnelFormHtml}
        ${errHtml}
        <div class="ag-rp-sec" data-active="${onlineCount > 0 ? 'true' : 'false'}">${LOCK_SHIELD_SVG}<span>${escapeHtml(statusText)}</span></div>
        ${devicesHtml}
        <div class="ag-rp-actions">
          <button id="ag-remote-copy" class="ag-rp-btn" data-primary="true" type="button" ${ep.activeUrl ? '' : 'disabled'}>${escapeHtml(copiedRecent ? tr('已复制链接', 'Copied') : tr('复制链接', 'Copy Link'))}</button>
          <button id="ag-remote-reset" class="ag-rp-btn" type="button" ${busyAny ? 'disabled' : ''}>${escapeHtml(tr('重置密钥', 'Reset Token'))}</button>
        </div>
        <div class="ag-rp-tip">${escapeHtml(tr('整行点击启用或停用对应连接方式，未勾选的方式后端将拒绝调用；客户端支持手动直选已启用入口。', 'Click any row to enable or disable it; unchecked modes are blocked by the server and enabled ones are selectable on the client.'))}</div>
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
    popover.querySelectorAll('.ag-rp-channel').forEach((row) => {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = row.getAttribute('data-channel-toggle') || row.getAttribute('data-channel');
        if (!key || row.hasAttribute('disabled')) return;
        const targetCh = ep?.channels?.find((c) => c.key === key);
        const curOn = key === 'tunnel'
          ? Boolean(targetCh && (targetCh.enabled || targetCh.state === 'running' || targetCh.state === 'starting'))
          : (targetCh?.enabled !== false);
        const nextOn = !curOn;
        if (key === 'tunnel') {
          void configureRemoteTunnel({ enabled: nextOn, enabledChannels: { tunnel: nextOn } });
        } else {
          void configureRemoteTunnel({ enabledChannels: { [key]: nextOn } });
        }
      });
    });
    popover.querySelector('#ag-rp-tunnel-cfg-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      remotePairState.tunnelConfigOpen = !remotePairState.tunnelConfigOpen;
      renderRemotePopoverContent(popover);
      positionRemotePopover();
    });
    popover.querySelector('#ag-rp-cf-get-token')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openExternalUrlInSystemBrowser(CLOUDFLARE_TUNNEL_DASHBOARD_URL);
    });
    popover.querySelector('#ag-rp-cf-host')?.addEventListener('input', (ev) => {
      remotePairState.draftHost = String(ev.target?.value ?? '');
    });
    popover.querySelector('#ag-rp-cf-token')?.addEventListener('input', (ev) => {
      remotePairState.draftToken = String(ev.target?.value ?? '');
    });
    popover.querySelector('#ag-rp-cf-save')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const hostVal = String(popover.querySelector('#ag-rp-cf-host')?.value || '').trim();
      const tokVal = String(popover.querySelector('#ag-rp-cf-token')?.value || '').trim();
      remotePairState.draftHost = hostVal;
      remotePairState.draftToken = tokVal;
      const req = { enabled: true, tunnelMode: 'named', tunnelHostname: hostVal };
      if (tokVal) req.tunnelToken = tokVal;
      showQuickToast(tr('⏳ 正在校验并连接固定域名隧道…', '⏳ Validating & connecting Named Tunnel…'));
      void configureRemoteTunnel(req);
    });
    popover.querySelector('#ag-rp-cf-quick')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      remotePairState.draftHost = null;
      remotePairState.draftToken = '';
      showQuickToast(tr('⏳ 正在申请免登录临时隧道 (*.trycloudflare.com)，约需 3~8 秒…', '⏳ Provisioning Quick Tunnel (*.trycloudflare.com)…'));
      void configureRemoteTunnel({ enabled: true, tunnelMode: 'quick' });
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
    popover.querySelector('#ag-remote-reset')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void refreshRemotePairInfo(true);
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
        <div style="display:flex;align-items:center;gap:4px">
          <button id="ag-quota-open-settings" class="ag-qp-refresh" type="button" title="${tr('前往统一设置调整套餐子档', 'Open Suite Settings')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.82 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.69 0-1.25.4-1.51 1z"/></svg></button>
          <button id="ag-quota-refresh" class="ag-qp-refresh" type="button">${quotaState.loading ? tr('刷新中…', 'Refreshing…') : tr('↻ 刷新', '↻ Refresh')}</button>
        </div>
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

    const openSettingsBtn = popover.querySelector('#ag-quota-open-settings');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleQuotaPopover(false);
        (globalThis.__AGContextMeter || window.__AGContextMeter)?.openSettings?.('subscription');
      });
    }
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
          border-color: rgba(16, 185, 129, 0.55);
          background: rgba(16, 185, 129, 0.16);
          color: #34d399;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn[data-active="true"]:hover {
          background: rgba(16, 185, 129, 0.24);
          border-color: rgba(16, 185, 129, 0.75);
          color: #6ee7b7;
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
          border-color: rgba(5, 150, 105, 0.45);
          background: rgba(16, 185, 129, 0.14);
          color: #047857;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-btn[data-active="true"]:hover {
          background: rgba(16, 185, 129, 0.22);
          border-color: rgba(5, 150, 105, 0.65);
          color: #065f46;
        }
        #${QUICK_BAR_ID} .ag-qcap-toast {
          margin-left: auto;
          font-size: 12px;
          color: #38bdf8;
          opacity: 0;
          transition: opacity 0.18s ease;
          pointer-events: none;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 260px;
        }
        #${QUICK_BAR_ID}[data-ag-theme="light"] .ag-qcap-toast {
          color: #0284c7;
        }
        #${QUICK_BAR_ID} .ag-qcap-toast[data-visible="true"] {
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
          border-color: rgba(56, 189, 248, 0.5);
          background: rgba(56, 189, 248, 0.16);
          color: #7dd3fc;
        }
        #${FILE_EDITOR_CONTROLS_ID} .ag-fedit-btn[data-primary="true"]:hover {
          background: rgba(56, 189, 248, 0.26);
          border-color: rgba(56, 189, 248, 0.75);
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
          border-color: rgba(2, 132, 199, 0.45);
          background: rgba(2, 132, 199, 0.12);
          color: #0369a1;
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
        [data-ag-has-ghost="1"] > p.pointer-events-none,
        [data-ag-has-ghost="1"] > div.pointer-events-none {
          opacity: 0 !important;
          visibility: hidden !important;
        }
        #${NEXT_STEP_GHOST_ID} {
          position: absolute;
          left: 8px;
          right: 8px;
          top: 8px;
          min-height: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          pointer-events: none;
          z-index: 2;
          user-select: none;
          font-size: 13.5px;
          line-height: 24px;
          color: rgba(228, 228, 231, 0.46);
        }
        #${NEXT_STEP_GHOST_ID}[data-ag-theme="light"] {
          color: rgba(63, 63, 70, 0.52);
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-text {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-badges {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          pointer-events: auto;
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-kbd {
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(228, 228, 231, 0.68);
          border-radius: 5px;
          padding: 1px 6px;
          font-size: 11.5px;
          line-height: 16px;
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        #${NEXT_STEP_GHOST_ID} .ag-ns-kbd:hover {
          background: rgba(56, 189, 248, 0.16);
          border-color: rgba(56, 189, 248, 0.42);
          color: #e4e4e7;
        }
        #${NEXT_STEP_GHOST_ID}[data-ag-theme="light"] .ag-ns-kbd {
          border-color: rgba(0, 0, 0, 0.14);
          background: rgba(0, 0, 0, 0.045);
          color: rgba(63, 63, 70, 0.78);
        }
        #${NEXT_STEP_GHOST_ID}[data-ag-theme="light"] .ag-ns-kbd:hover {
          background: rgba(2, 132, 199, 0.12);
          border-color: rgba(2, 132, 199, 0.36);
          color: #18181b;
        }
      `;
      document.head.appendChild(styleEl);
    }
  }

  function showQuickToast(text) {
    const bar = document.getElementById(QUICK_BAR_ID);
    const toast = bar?.querySelector('.ag-qcap-toast');
    if (!toast) return;
    toast.textContent = text;
    toast.setAttribute('data-visible', 'true');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.setAttribute('data-visible', 'false');
    }, 2800);
  }

  async function fillComposerText(text) {
    const ed = getComposerEditor() || document.querySelector('[contenteditable="true"]');
    if (!ed) {
      showQuickToast('未找到聊天输入框');
      return false;
    }

    try {
      const lex = ed.__lexicalEditor;
      if (lex && typeof lex.update === 'function') {
        lex.update(() => {
          const root = lex.getEditorState()?._nodeMap?.get('root');
          if (root && typeof root.clear === 'function') {
            root.clear();
          }
        });
        await new Promise((r) => setTimeout(r, 20));
      } else {
        ed.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }

      ed.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        try {
          const ev = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          });
          ed.dispatchEvent(ev);
        } catch {}
      }

      await new Promise((r) => setTimeout(r, 20));

      // 确保光标位于文本末尾
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
      return true;
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
    const m = location.pathname.match(/\/c\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
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

  function getQuickBarActions() {
    return [
      {
        id: 'ag-qcap-compact',
        label: tr('/compact 压缩', '/compact'),
        title: tr('快速填入 /compact 压缩上下文命令', 'Fill /compact command'),
        onClick: async () => {
          if (await fillComposerText('/compact')) showQuickToast(tr('已填入 /compact，按回车即可执行', 'Inserted /compact, press Enter to run'));
        }
      },
      {
        id: 'ag-qcap-plan',
        label: tr('/plan 规划', '/plan'),
        title: tr('快速填入 /plan 前缀进入规划模式', 'Fill /plan prefix to enter plan mode'),
        onClick: async () => {
          if (await fillComposerText('/plan ')) showQuickToast(tr('已填入 /plan ，请输入规划需求', 'Inserted /plan , enter your goal'));
        }
      },
      {
        id: 'ag-qcap-reload',
        label: tr('重载规则', 'Reload Rules'),
        title: tr('快速填入“重新读取 AGENTS”指令', 'Fill reload AGENTS prompt'),
        onClick: async () => {
          if (await fillComposerText('重新读取 AGENTS')) showQuickToast(tr('已填入重载规则指令，按回车即可发送', 'Inserted reload rules prompt, press Enter'));
        }
      },
      {
        id: 'ag-qcap-copyid',
        label: tr('复制会话 ID', 'Copy ID'),
        title: tr('复制当前对话窗口的会话 ID', 'Copy current conversation ID'),
        onClick: async () => {
          const id = getSessionIdFromLocation();
          if (!id) {
            showQuickToast(tr('当前页面未包含会话 ID', 'No conversation ID in current URL'));
            return;
          }
          const ok = await copyToClipboard(id);
          showQuickToast(ok ? tr(`已复制会话 ID (${id.slice(0, 8)})`, `Copied ID (${id.slice(0, 8)})`) : tr('复制失败，请检查剪贴板权限', 'Copy failed'));
        }
      },
      {
        id: 'ag-qcap-export',
        label: tr('导出 Markdown', 'Export MD'),
        title: tr('将完整对话导出为 Markdown 保存到 ~/Downloads 并复制', 'Export conversation to Markdown in ~/Downloads and copy'),
        onClick: () => { void exportMarkdown(); }
      },
      {
        id: 'ag-qcap-brain',
        label: latestBrainStats ? tr(`缓存 ${latestBrainStats.totalMB}MB`, `Cache ${latestBrainStats.totalMB}MB`) : tr('缓存统计', 'Brain Cache'),
        title: latestBrainStats ? formatBrainTooltip(latestBrainStats) : tr('查看 ~/.gemini/antigravity/brain 历史会话占用（只读）', 'View ~/.gemini/antigravity/brain cache size (read-only)'),
        onClick: () => { void refreshBrainStats(true); }
      }
    ];
  }

  function updateQuickBarLanguage() {
    const bar = document.getElementById(QUICK_BAR_ID);
    if (!bar) return;
    bar.setAttribute('aria-label', tr('输入框快捷操作栏', 'Composer Quick Actions'));
    for (const act of getQuickBarActions()) {
      const btn = document.getElementById(act.id);
      if (!btn) continue;
      btn.textContent = act.label;
      btn.title = act.title;
    }
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

      const actions = getQuickBarActions();

      for (const act of actions) {
        const btn = document.createElement('button');
        btn.id = act.id;
        btn.className = 'ag-qcap-btn';
        btn.type = 'button';
        btn.textContent = act.label;
        btn.title = act.title;
        if (act.active) btn.setAttribute('data-active', 'true');
        // 阻止点击按钮时抢走输入框焦点
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', act.onClick);
        bar.appendChild(btn);
      }

      const toast = document.createElement('span');
      toast.className = 'ag-qcap-toast';
      toast.setAttribute('data-visible', 'false');
      bar.appendChild(toast);
    }

    if (bar.getAttribute('data-ag-theme') !== theme) {
      bar.setAttribute('data-ag-theme', theme);
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

  function isComposerEmpty(ed) {
    if (!ed) return false;
    const raw = typeof ed.__lexicalTextContent === 'string'
      ? ed.__lexicalTextContent
      : (ed.textContent || '');
    return raw.replace(/[\u200B-\u200D\uFEFF\s]/g, '').length === 0;
  }

  function extractContextPercent() {
    const cap = document.querySelector('[data-agy-context-capsule="1"]');
    const capMatch = (cap?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
    if (capMatch) return Number(capMatch[1]);
    const { sr } = getMeterHostAndShadow();
    const meterMatch = (sr?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
    return meterMatch ? Number(meterMatch[1]) : 0;
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

  function computeNextStepCandidates() {
    const sessionId = getSessionIdFromLocation() || '';
    const assistantMds = getAssistantMarkdownRoots();
    const lastMd = assistantMds[assistantMds.length - 1];
    const fullText = (lastMd?.innerText || '').trim();
    const sig = `${sessionId}|${assistantMds.length}|${fullText.length}|${fullText.slice(-80)}`;
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

    if (extractContextPercent() >= 70) {
      addCandidate('/compact');
    }

    addCandidate('继续下一步');
    addCandidate('展开说说具体细节');

    return { sig, candidates: list.slice(0, 4) };
  }

  function hideNextStepGhost() {
    nextStepState.visible = false;
    const ghost = document.getElementById(NEXT_STEP_GHOST_ID);
    if (ghost) ghost.hidden = true;
    document.querySelectorAll('[data-ag-has-ghost="1"]').forEach((el) => {
      el.removeAttribute('data-ag-has-ghost');
    });
  }

  function ensureNextStepGhost() {
    if (disposed || !ghostSuggestEnabled) {
      hideNextStepGhost();
      return;
    }
    const ed = getComposerEditor();
    const hostParent = ed?.parentElement;
    if (!ed || !hostParent || isAssistantBusy()) {
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
      ghost.setAttribute('aria-hidden', 'true');

      const textSpan = document.createElement('span');
      textSpan.className = 'ag-ns-text';

      const badges = document.createElement('span');
      badges.className = 'ag-ns-badges';

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'ag-ns-kbd ag-ns-tab';
      tabBtn.textContent = 'Tab / → 补全';
      tabBtn.title = '按 Tab 或 → 右箭头将建议填入输入框';
      tabBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      tabBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void acceptNextStepSuggestion();
      });

      const cycleBtn = document.createElement('button');
      cycleBtn.type = 'button';
      cycleBtn.className = 'ag-ns-kbd ag-ns-cycle';
      cycleBtn.title = '按 ↓ 切换下一条建议';
      cycleBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      cycleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cycleNextStepSuggestion(1);
      });

      badges.appendChild(tabBtn);
      badges.appendChild(cycleBtn);
      ghost.appendChild(textSpan);
      ghost.appendChild(badges);
    }

    if (ghost.parentElement !== hostParent) {
      hostParent.appendChild(ghost);
    }
    if (ghost.getAttribute('data-ag-theme') !== theme) {
      ghost.setAttribute('data-ag-theme', theme);
    }
    ghost.hidden = false;

    const currentText = candidates[nextStepState.index] || '';
    const textSpan = ghost.querySelector('.ag-ns-text');
    const cycleBtn = ghost.querySelector('.ag-ns-cycle');
    if (textSpan) {
      const nextDisplay = `💡 ${currentText}`;
      if (textSpan.textContent !== nextDisplay) textSpan.textContent = nextDisplay;
      textSpan.title = currentText;
    }
    if (cycleBtn) {
      if (candidates.length > 1) {
        cycleBtn.hidden = false;
        cycleBtn.textContent = `↓ ${nextStepState.index + 1}/${candidates.length}`;
      } else {
        cycleBtn.hidden = true;
      }
    }

    if (hostParent.getAttribute('data-ag-has-ghost') !== '1') {
      hostParent.setAttribute('data-ag-has-ghost', '1');
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
      showQuickToast('✨ 已补全建议，按回车即可发送');
    }
    ensureNextStepGhost();
    return ok;
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
        hideNextStepGhost();
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
      hideNextStepGhost();
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
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
    isComposerComposing = true;
    hideNextStepGhost();
  }

  function onDocCompositionEnd(e) {
    const ed = getComposerEditor();
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
    isComposerComposing = false;
    setTimeout(() => {
      if (!disposed) ensureNextStepGhost();
    }, 0);
  }

  function onDocInput(e) {
    if (disposed) return;
    const ed = getComposerEditor();
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!ed || !target || !ed.contains(target)) return;
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

  function onSuitePrefsChanged(ev) {
    const prevLang = uiLang;
    syncSuitePrefsFromStorage(ev?.detail || null);
    applyEnhancerFeatureVisibility();
    if (!ghostSuggestEnabled) hideNextStepGhost();
    else ensureNextStepGhost();
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
    ensureNextStepGhost();
    ensureFileViewerEditor();
    scanHighRiskCommands();
    renderQuotaUI();
    guardExpandedThinkingBlocks();
    localizeThinkingShells();
    scheduleLocalization();
    syncSidebarShortcutBadges();
    runAutoAcceptTick();
    if (featureFlags.showTopbarQuota !== false && Date.now() - lastQuotaFetchAt >= 30000) {
      lastQuotaFetchAt = Date.now();
      void refreshQuota();
    }
    if (featureFlags.showQuickBar !== false && Date.now() - lastBrainFetchAt >= 60000) {
      lastBrainFetchAt = Date.now();
      void refreshBrainStats(false);
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
    safeRemove(document.getElementById(NEXT_STEP_GHOST_ID));
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
    return s.trim().slice(0, 3000);
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
      if (inner.length > 15800) break;
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
      if (out && out.length + piece.length > 16000) break;
      out += piece;
    }
    return out;
  }

  function collectRecentMessages(limit = 20) {
    const viewport = getScrollViewport() || document.querySelector('main') || document.body;
    if (!viewport) return [];
    const nodes = Array.from(viewport.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]'));
    const slice = nodes.slice(-Math.max(1, limit));
    const out = [];

    for (let i = 0; i < slice.length; i++) {
      const node = slice[i];
      const testId = node.getAttribute('data-testid');
      if (testId === 'user-message') {
        const contentNode = node.querySelector('[data-testid="user-message-content"]') || node;
        const text = cleanUserMessageText(contentNode.innerText || contentNode.textContent || '');
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
          const txt = (zhNode?.innerText || panel?.innerText || '').trim();
          if (txt) thoughtChunks.push(txt);
        }
      }
      const mdRoots = Array.from(node.querySelectorAll('[data-markdown-root]')).filter((m) => (
        !m.closest('[data-testid="user-message"]') &&
        !m.closest('[data-testid="thinking-collapsible-trigger"]') &&
        !m.parentElement?.previousElementSibling?.matches?.('[data-testid="thinking-collapsible-trigger"]')
      ));
      let replyText = mdRoots.map((m) => (m.innerText || '').trim()).filter(Boolean).join('\n\n').trim();
      const replyHtml = extractSanitizedMarkdownHtml(mdRoots);
      if (!replyText) {
        const cloneText = (node.innerText || '')
          .replace(/^(?:Agent\s+(?:said|working)|智能体(?:回复|正在处理))\s*\n*/i, '')
          .replace(/^Worked\s+for\s+\S+(?:\s+in\s+this\s+step)?\s*\n*/i, '')
          .trim();
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
        text: replyText.slice(0, 4000),
        html: replyHtml,
        thoughtLabel: thoughtLabel.slice(0, 120),
        thoughtText: thoughtChunks.join('\n\n').slice(0, 1200),
        highRisk,
        riskText: (riskBanner?.textContent || '').trim()
      });
    }
    return out;
  }

  function collectSidebarConversations(limit = 25) {
    const currentId = getSessionIdFromLocation() || '';
    const rows = getOrderedSidebarConversationRows();
    const list = [];
    for (const row of rows) {
      const id = extractSidebarRowId(row);
      if (!id) continue;
      const title = getSidebarRowDisplayTitle(row);
      const active = isSidebarRowActive(row, currentId);
      list.push({ id, title: title.slice(0, 80), active });
      if (list.length >= limit) break;
    }
    return list;
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
      { key: 'request_review', label: '👁️ 请求审查 (Review)' }
    ];
  }

  function getMobileSnapshot() {
    const sessionId = getSessionIdFromLocation() || '';
    const conversations = collectSidebarConversations(25);
    const activeConv = conversations.find((c) => c.active);
    const busy = isAssistantBusy();
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
    const permissionLabel = (permBtn?.textContent || '').replace(/\s+/g, ' ').trim() || '未知';
    const pendingApprovals = collectPendingApprovals();
    const messages = collectRecentMessages(20);
    const suggestions = !busy ? computeNextStepCandidates().candidates : [];

    return {
      ok: true,
      version: '1.6.9',
      timestamp: Date.now(),
      sessionId,
      title: activeConv?.title || document.title || 'Antigravity',
      busy,
      autoAccept: autoAcceptEnabled,
      model,
      modelOptions,
      permissionLabel,
      permissionOptions: getPermissionPresetsMeta(),
      contextBadge,
      pulseText,
      quota: {
        activePoolKey: quotaState.activePoolKey,
        gemini: quotaState.gemini,
        claude: quotaState.claude,
        lastFetchedAt: quotaState.lastFetchedAt
      },
      pendingApprovals,
      suggestions,
      messages,
      conversations
    };
  }

  async function performMobileAction(payload) {
    const action = String(payload?.action || '').trim();
    if (!action) return { ok: false, error: '缺少 action 参数' };

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

    if (action === 'switch-conversation') {
      const targetId = String(payload?.id || '').trim();
      if (!targetId) return { ok: false, error: '缺少会话 ID' };
      if (targetId === 'new') {
        const newBtn = document.querySelector('a[data-testid="new-conversation-button"], [data-testid="new-conversation-button"] a, [data-testid="new-conversation-button"]');
        if (!newBtn) return { ok: false, error: '未找到新建对话按钮' };
        newBtn.click();
        await new Promise((r) => setTimeout(r, 180));
        return { ok: true, id: 'new' };
      }
      const row = findSidebarRowById(targetId);
      const link = row?.querySelector('a[href]') || document.querySelector(`a[href*="/c/${escapeCssIdent(targetId)}"]`);
      const clickTarget = link || row;
      if (!clickTarget) return { ok: false, error: '未在侧边栏找到该会话' };
      clickTarget.click();
      await new Promise((r) => setTimeout(r, 180));
      return { ok: true, id: targetId, pathname: location.pathname };
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
      const nextLabel = (permBtn.textContent || '').replace(/\s+/g, ' ').trim();
      return { ok: true, preset, permissionLabel: nextLabel };
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

    globalThis.__AGEnhancer = {
    version: '1.7.3',
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
    ensureNextStepGhost,
    acceptNextStepSuggestion,
    cycleNextStepSuggestion,
    getNextStepState: () => ({ ...nextStepState, candidates: [...nextStepState.candidates] }),
    getMobileSnapshot,
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
    getFeatureFlags: () => ({ ...featureFlags }),
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
  lastBrainFetchAt = Date.now();
  lastRemoteFetchAt = Date.now();
  if (featureFlags.showTopbarQuota !== false) void refreshQuota();
  if (featureFlags.showQuickBar !== false) void refreshBrainStats(false);
  if (featureFlags.showTopbarRemote !== false) void refreshRemotePairInfo(false);
})();

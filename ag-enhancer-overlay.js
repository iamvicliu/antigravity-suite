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
  const QUOTA_STYLE_ID = 'ag-enhancer-quota-style';
  const QUOTA_BADGE_ID = 'badge-quota';
  const QUOTA_POPOVER_ID = 'ag-quota-popover';
  const DOC_STYLE_ID = 'ag-enhancer-doc-style';
  const QUICK_BAR_ID = 'ag-quick-capsule-bar';
  const CHAT_NAV_ID = 'ag-chat-nav-float';
  const FILE_EDITOR_CONTROLS_ID = 'ag-file-editor-controls';
  const FILE_EDITOR_WRAP_ID = 'ag-inline-file-editor-wrap';

  let disposed = false;
  let fileEditorState = {
    active: false,
    fileUri: '',
    filePath: '',
    dirty: false,
    saving: false,
    loading: false,
    statusText: ''
  };
  let quotaState = {
    loading: false,
    lastFetchedAt: 0,
    error: '',
    gemini: null,
    claude: null,
    promptCredits: null,
    flowCredits: null,
    activeModelText: '',
    activePoolKey: 'gemini'
  };
  let popoverOpen = false;
  let toastTimer = null;
  let autoAcceptEnabled = false;
  const autoClickedButtons = new WeakMap();
  let latestBrainStats = null;
  let lastBrainFetchAt = 0;

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

  function aggregatePoolsFromConfigs(configs) {
    if (!Array.isArray(configs) || !configs.length) return { gemini: null, claude: null };
    let gemini = null;
    let claude = null;

    for (const c of configs) {
      if (!c || typeof c !== 'object') continue;
      const id = String(c.modelId || c.label || '').toLowerCase();
      const qi = c.quotaInfo || {};
      const frac = typeof qi.remainingFraction === 'number' && Number.isFinite(qi.remainingFraction)
        ? qi.remainingFraction
        : null;
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

      if (csrf) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch('/exa.language_server_pb.LanguageServerService/GetUserStatus', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': csrf
            },
            body: '{}',
            signal: controller.signal
          });
          if (resp.ok) {
            const payload = await resp.json();
            userStatus = payload?.userStatus || null;
            configs = userStatus?.cascadeModelConfigData?.clientModelConfigs || null;
          }
        } finally {
          clearTimeout(timer);
        }
      }

      const historyRaw = window.__AGContextMeterHistory?.rawPlanStatus || window.__AGContextMeterHistory?.planStatus || null;
      if (!configs || !configs.length) {
        configs = historyRaw?.cascadeModelConfigs || [];
      }

      const pools = aggregatePoolsFromConfigs(configs);
      const credits = normalizeCredits(userStatus, historyRaw);

      if (pools.gemini || pools.claude) {
        quotaState.gemini = pools.gemini;
        quotaState.claude = pools.claude;
        quotaState.lastFetchedAt = Date.now();
        quotaState.error = '';
      } else if (!quotaState.gemini && !quotaState.claude) {
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
          box-shadow: 0 0 6px rgba(156, 163, 175, 0.45);
          transition: background-color 0.2s ease, box-shadow 0.2s ease;
        }
        :host([data-layout="compact"]) #badge-quota {
          padding: 0 5px;
          font-size: 11.5px;
          gap: 4px;
        }
        :host([data-layout="ring-only"]) #badge-quota {
          display: none !important;
        }
        #ag-quota-popover {
          position: fixed;
          z-index: 2147483610;
          width: 320px;
          max-width: calc(100vw - 24px);
          padding: 12px 14px;
          border-radius: 12px;
          border: 1px solid var(--ag-float-border, rgba(255, 255, 255, 0.12));
          background: var(--ag-float-bg, rgba(24, 24, 27, 0.96));
          color: var(--ag-text-primary, #f4f4f5);
          box-shadow: var(--ag-float-shadow, 0 12px 32px rgba(0, 0, 0, 0.45));
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          font-size: 12px;
          line-height: 1.45;
        }
        #ag-quota-popover[hidden] {
          display: none !important;
        }
        .ag-qp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
        }
        .ag-qp-title {
          font-size: 12.5px;
          font-weight: 600;
          color: var(--ag-text-primary, #f4f4f5);
        }
        .ag-qp-refresh {
          height: 22px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.12));
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.05));
          color: var(--ag-text-primary, #e4e4e7);
          font-size: 11px;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .ag-qp-refresh:hover {
          background: var(--ag-toolbar-bg-hover, rgba(255, 255, 255, 0.12));
        }
        .ag-qp-model {
          font-size: 11px;
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
          background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.04));
          border: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
          margin-bottom: 8px;
        }
        .ag-qp-card.is-active {
          border-color: rgba(56, 189, 248, 0.45);
        }
        .ag-qp-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 5px;
        }
        .ag-qp-pool-name {
          font-size: 11.5px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .ag-qp-active-tag {
          font-size: 10px;
          font-weight: 500;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(56, 189, 248, 0.18);
          color: #38bdf8;
        }
        .ag-qp-pct {
          font-size: 12px;
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
          font-size: 10.5px;
          color: var(--ag-text-muted, #a1a1aa);
        }
        .ag-qp-footer {
          margin-top: 6px;
          padding-top: 8px;
          border-top: 1px solid var(--ag-border-subcard, rgba(255, 255, 255, 0.08));
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 11px;
          color: var(--ag-text-muted, #a1a1aa);
        }
        .ag-qp-credit-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
      `;
      sr.appendChild(styleEl);
    }

    let quotaBtn = sr.getElementById(QUOTA_BADGE_ID);
    const contextBadge = sr.getElementById('badge');
    if (!quotaBtn && contextBadge) {
      quotaBtn = document.createElement('button');
      quotaBtn.id = QUOTA_BADGE_ID;
      quotaBtn.className = 'ag-unit';
      quotaBtn.type = 'button';
      quotaBtn.setAttribute('aria-label', '模型剩余配额');
      quotaBtn.setAttribute('aria-expanded', 'false');
      quotaBtn.title = '查看 Gemini / Claude 模型剩余配额与重置倒计时';
      quotaBtn.innerHTML = '<span id="ag-quota-dot" class="ag-quota-dot"></span><span id="ag-quota-text">配额 --%</span>';
      contextBadge.insertAdjacentElement('afterend', quotaBtn);

      quotaBtn.addEventListener('click', onQuotaBtnClick);
    }

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

    return { host, sr, quotaBtn, popover };
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
      const top = Math.max(36, Math.min(vh - 220, Math.round(bRect.bottom + 6)));
      let left = Math.round(bRect.left + bRect.width / 2 - popW / 2);
      left = Math.max(12, Math.min(vw - popW - 12, left));
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
      popover.style.width = `${popW}px`;
    } catch {}
  }

  function toggleQuotaPopover(forceOpen) {
    const nodes = ensureQuotaStylesAndNodes();
    if (!nodes) return;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !popoverOpen;
    popoverOpen = nextOpen;
    nodes.popover.hidden = !nextOpen;
    nodes.quotaBtn?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');

    if (nextOpen) {
      // 避免与原有上下文面板重叠
      try {
        const pCtx = nodes.sr.getElementById('panel');
        const pTok = nodes.sr.getElementById('panel-tokens');
        if (pCtx && !pCtx.hidden) pCtx.hidden = true;
        if (pTok && !pTok.hidden) pTok.hidden = true;
        nodes.sr.getElementById('badge')?.setAttribute('aria-expanded', 'false');
        nodes.sr.getElementById('badge-tokens')?.setAttribute('aria-expanded', 'false');
      } catch {}
      renderQuotaPopoverContent(nodes.popover);
      positionQuotaPopover();
      void refreshQuota();
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
    const modelName = quotaState.activeModelText || '未检测到模型';

    const renderPoolCard = (title, pool, isActive) => {
      const frac = pool?.remainingFraction;
      const pctInt = typeof frac === 'number' ? Math.max(0, Math.min(100, frac * 100)) : 0;
      const color = getQuotaColor(frac);
      const pctText = formatPctOne(frac);
      const resetText = pool?.resetTime ? formatResetCountdownZh(pool.resetTime) : '暂无重置时间信息';
      return `
        <div class="ag-qp-card${isActive ? ' is-active' : ''}">
          <div class="ag-qp-row">
            <span class="ag-qp-pool-name">
              <span>${escapeHtml(title)}</span>
              ${isActive ? '<span class="ag-qp-active-tag">当前</span>' : ''}
            </span>
            <span class="ag-qp-pct" style="color:${color}">${escapeHtml(pctText)}</span>
          </div>
          <div class="ag-qp-bar">
            <div class="ag-qp-bar-fill" style="width:${pctInt.toFixed(1)}%;background:${color}"></div>
          </div>
          <div class="ag-qp-reset">${escapeHtml(resetText)}</div>
        </div>
      `;
    };

    const creditsRows = [];
    if (quotaState.promptCredits) {
      const pc = quotaState.promptCredits;
      creditsRows.push(`
        <div class="ag-qp-credit-row">
          <span>Prompt Credits</span>
          <strong>${pc.available}${pc.monthly ? ` / ${pc.monthly}` : ''}</strong>
        </div>
      `);
    }
    if (quotaState.flowCredits) {
      const fc = quotaState.flowCredits;
      creditsRows.push(`
        <div class="ag-qp-credit-row">
          <span>Flow Credits</span>
          <strong>${fc.available}${fc.monthly ? ` / ${fc.monthly}` : ''}</strong>
        </div>
      `);
    }
    const updatedStr = quotaState.lastFetchedAt
      ? `上次刷新：${new Date(quotaState.lastFetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
      : (quotaState.error || '等待数据…');

    popover.innerHTML = `
      <div class="ag-qp-header">
        <span class="ag-qp-title">模型剩余配额实时看板</span>
        <button id="ag-quota-refresh" class="ag-qp-refresh" type="button">${quotaState.loading ? '刷新中…' : '↻ 刷新'}</button>
      </div>
      <div class="ag-qp-model">
        <span>当前选中模型</span>
        <strong>${escapeHtml(modelName)}</strong>
      </div>
      ${renderPoolCard('Gemini 4 / 3.8 配额池', g, activeKey === 'gemini')}
      ${renderPoolCard('Claude 5.5 / GPT 配额池', c, activeKey === 'claude')}
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
      dotEl.style.boxShadow = `0 0 6px ${dotColor}80`;
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
      badgeText = `配额 ${formatPctInt(activeFrac)}`;
    }
    if (textEl && textEl.textContent !== badgeText) {
      textEl.textContent = badgeText;
    }

    const gTip = quotaState.gemini?.resetTime ? formatResetCountdownZh(quotaState.gemini.resetTime) : '未知';
    const cTip = quotaState.claude?.resetTime ? formatResetCountdownZh(quotaState.claude.resetTime) : '未知';
    quotaBtn.title = `Gemini 4/3.8: ${formatPctOne(gFrac)} (${gTip})\nClaude/GPT: ${formatPctOne(cFrac)} (${cTip})\n点击查看完整配额面板`;

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
          height: 24px;
          padding: 0 9px;
          border-radius: 9999px;
          font-size: 11.5px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(244, 244, 245, 0.88);
          transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.08s ease;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn:hover {
          background: rgba(255, 255, 255, 0.13);
          border-color: rgba(255, 255, 255, 0.24);
          color: #ffffff;
        }
        #${QUICK_BAR_ID} .ag-qcap-btn:active {
          transform: scale(0.96);
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
          font-size: 11px;
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
          box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.2) !important;
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
          font-size: 11.5px;
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
          z-index: 2147483580;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 3px;
          padding: 3px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(24, 24, 27, 0.78);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          opacity: 0.35;
          transform: translateX(4px);
          transition: opacity 0.16s ease, transform 0.16s ease, padding 0.16s ease;
        }
        #${CHAT_NAV_ID}:hover {
          opacity: 0.98;
          transform: translateX(0);
          padding: 5px;
        }
        #${CHAT_NAV_ID}[hidden] {
          display: none !important;
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] {
          border-color: rgba(0, 0, 0, 0.12);
          background: rgba(255, 255, 255, 0.86);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        }
        #${CHAT_NAV_ID} .ag-nav-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          width: 24px;
          height: 24px;
          padding: 0;
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(244, 244, 245, 0.9);
          font-size: 11px;
          font-weight: 500;
          line-height: 1;
          white-space: nowrap;
          cursor: pointer;
          transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.08s ease;
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
          flex-shrink: 0;
        }
        #${CHAT_NAV_ID} .ag-nav-label {
          display: none;
        }
        #${CHAT_NAV_ID}:hover .ag-nav-label {
          display: inline;
        }
        #${CHAT_NAV_ID} .ag-nav-btn:hover {
          background: rgba(255, 255, 255, 0.14);
          border-color: rgba(255, 255, 255, 0.24);
          color: #ffffff;
        }
        #${CHAT_NAV_ID} .ag-nav-btn:active {
          transform: scale(0.96);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn {
          border-color: rgba(0, 0, 0, 0.1);
          background: rgba(0, 0, 0, 0.04);
          color: rgba(24, 24, 27, 0.88);
        }
        #${CHAT_NAV_ID}[data-ag-theme="light"] .ag-nav-btn:hover {
          background: rgba(0, 0, 0, 0.09);
          border-color: rgba(0, 0, 0, 0.2);
          color: #09090b;
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
          height: 24px;
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
          font-size: 11.5px;
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
    const ed = document.querySelector('.surface-composer [contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
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

  function setNavBtnContent(btn, icon, text) {
    if (!btn) return;
    btn.textContent = '';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ag-nav-icon';
    iconSpan.textContent = icon;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ag-nav-label';
    labelSpan.textContent = ` ${text}`;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
  }

  function updateThinkToggleLabel() {
    const btn = document.getElementById('ag-nav-think');
    if (!btn) return;
    const triggers = Array.from(document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
    const hasCollapsed = triggers.some((t) => t.getAttribute('aria-expanded') !== 'true');
    setNavBtnContent(btn, '💡', hasCollapsed || triggers.length === 0 ? '展开思考' : '收起思考');
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
      const expanded = trg.getAttribute('aria-expanded') === 'true';
      if ((hasCollapsed && !expanded) || (!hasCollapsed && expanded)) {
        trg.click();
        toggled++;
      }
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
    const bar = document.getElementById(QUICK_BAR_ID);
    const composer = document.querySelector('.surface-composer');
    const barRect = bar?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const anchorTop = (barRect && barRect.height > 0)
      ? barRect.top
      : ((composerRect && composerRect.height > 0) ? composerRect.top : vpRect.bottom);
    const navRect = nav.getBoundingClientRect();
    const rightOffset = Math.max(4, Math.round(window.innerWidth - vpRect.right + 4));
    const top = Math.max(vpRect.top + 12, anchorTop - navRect.height - 12);
    nav.style.left = 'auto';
    nav.style.right = `${rightOffset}px`;
    nav.style.top = `${Math.round(top)}px`;
  }

  function ensureChatNavFloat() {
    if (disposed) return;
    ensureDocStyle();
    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);
    let nav = document.getElementById(CHAT_NAV_ID);
    if (!nav) {
      nav = document.createElement('div');
      nav.id = CHAT_NAV_ID;
      nav.setAttribute('aria-label', '长对话快捷导航');
      const items = [
        { id: 'ag-nav-top', icon: '⏫', text: '顶部', title: '跳回当前对话最顶部', onClick: scrollToTop },
        { id: 'ag-nav-prev', icon: '🔼', text: '上一轮', title: '跳到上一条用户提问', onClick: scrollToPrevTurn },
        { id: 'ag-nav-next', icon: '🔽', text: '下一轮', title: '跳到下一条用户提问', onClick: scrollToNextTurn },
        { id: 'ag-nav-bottom', icon: '⏬', text: '底部', title: '直达最新回复底部', onClick: scrollToNextOrBottom },
        { id: 'ag-nav-think', icon: '💡', text: '展开思考', title: '一键展开或收起当前对话全部思考过程', onClick: () => { toggleAllThinking(); } }
      ];
      for (const item of items) {
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
      document.body.appendChild(nav);
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
        showQuickToast(`🤖 已自动确认: ${rawText}`);
      } catch {}
    }
  }

  function updateAutoAcceptBtn() {
    const btn = document.getElementById('ag-qcap-autoaccept');
    if (!btn) return;
    btn.textContent = autoAcceptEnabled ? '🤖 自动确认: 开' : '🤖 自动确认: 关';
    btn.setAttribute('data-active', autoAcceptEnabled ? 'true' : 'false');
    btn.title = autoAcceptEnabled
      ? '自动确认已开启（仅点击 Proceed / Accept / 继续 等安全步骤按钮）；点击关闭'
      : '开启后自动点击对话中的 Proceed / Accept / 继续 等确认按钮（默认关闭）';
  }

  function formatBrainTooltip(stats) {
    if (!stats || !stats.ok) return '点击查询 Brain 历史会话缓存占用';
    const lines = [`Brain 历史缓存：共 ${stats.count} 个会话，合计 ${stats.totalMB} MB`];
    if (Array.isArray(stats.topSessions) && stats.topSessions.length) {
      lines.push('', '占用 Top 5：');
      stats.topSessions.forEach((s, idx) => {
        lines.push(`${idx + 1}. ${s.title || s.shortId} (${s.shortId}) — ${s.mb} MB`);
      });
    }
    lines.push('', '目录：~/.gemini/antigravity/brain（只读统计，点击刷新并复制明细）');
    return lines.join('\n');
  }

  async function refreshBrainStats(showDetailToast = false) {
    const res = await postToLiveHost('/brain-stats', {});
    if (!res || !res.ok) {
      if (showDetailToast) showQuickToast('缓存统计获取失败（桥接服务未连接）');
      return null;
    }
    latestBrainStats = res;
    const btn = document.getElementById('ag-qcap-brain');
    if (btn) {
      btn.textContent = `📦 缓存 ${res.totalMB}MB`;
      btn.title = formatBrainTooltip(res);
    }
    if (showDetailToast) {
      const summary = formatBrainTooltip(res);
      await copyToClipboard(summary);
      const top1 = res.topSessions && res.topSessions[0];
      showQuickToast(
        top1
          ? `📦 共 ${res.count} 个会话 (${res.totalMB}MB)，最大: ${top1.title} (${top1.mb}MB)，明细已复制`
          : `📦 共 ${res.count} 个会话 (${res.totalMB}MB)，明细已复制`
      );
    }
    return res;
  }

  function ensureQuickCapsuleBar() {
    if (disposed) return;
    ensureDocStyle();
    const composer = document.querySelector('.surface-composer');
    if (!composer || !composer.parentElement) return;

    const { host } = getMeterHostAndShadow();
    const theme = resolveHostTheme(host);

    let bar = document.getElementById(QUICK_BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = QUICK_BAR_ID;
      bar.setAttribute('aria-label', '输入框快捷操作栏');

      const actions = [
        {
          id: 'ag-qcap-compact',
          label: '🗜️ /compact 压缩',
          title: '快速填入 /compact 压缩上下文命令',
          onClick: async () => {
            if (await fillComposerText('/compact')) showQuickToast('已填入 /compact，按回车即可执行');
          }
        },
        {
          id: 'ag-qcap-plan',
          label: '🎯 /plan 规划',
          title: '快速填入 /plan 前缀进入规划模式',
          onClick: async () => {
            if (await fillComposerText('/plan ')) showQuickToast('已填入 /plan ，请输入规划需求');
          }
        },
        {
          id: 'ag-qcap-reload',
          label: '🔄 重载规则',
          title: '快速填入“重新读取 AGENTS”指令',
          onClick: async () => {
            if (await fillComposerText('重新读取 AGENTS')) showQuickToast('已填入重载规则指令，按回车即可发送');
          }
        },
        {
          id: 'ag-qcap-copyid',
          label: '📋 复制会话 ID',
          title: '复制当前对话窗口的会话 ID',
          onClick: async () => {
            const id = getSessionIdFromLocation();
            if (!id) {
              showQuickToast('当前页面未包含会话 ID');
              return;
            }
            const ok = await copyToClipboard(id);
            showQuickToast(ok ? `✅ 已复制会话 ID (${id.slice(0, 8)})` : '复制失败，请检查剪贴板权限');
          }
        },
        {
          id: 'ag-qcap-export',
          label: '📝 导出 Markdown',
          title: '将完整对话导出为 Markdown 保存到 ~/Downloads 并复制',
          onClick: () => { void exportMarkdown(); }
        },
        {
          id: 'ag-qcap-autoaccept',
          label: autoAcceptEnabled ? '🤖 自动确认: 开' : '🤖 自动确认: 关',
          title: '开启后自动点击对话中的 Proceed / Accept / 继续 等确认按钮（默认关闭）',
          active: autoAcceptEnabled,
          onClick: () => {
            autoAcceptEnabled = !autoAcceptEnabled;
            updateAutoAcceptBtn();
            showQuickToast(autoAcceptEnabled ? '🤖 自动确认已开启（仅限安全确认按钮）' : '🤖 自动确认已关闭');
            if (autoAcceptEnabled) runAutoAcceptTick();
          }
        },
        {
          id: 'ag-qcap-brain',
          label: latestBrainStats ? `📦 缓存 ${latestBrainStats.totalMB}MB` : '📦 缓存统计',
          title: latestBrainStats ? formatBrainTooltip(latestBrainStats) : '查看 ~/.gemini/antigravity/brain 历史会话占用（只读）',
          onClick: () => { void refreshBrainStats(true); }
        }
      ];

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

  // ==================== 思考过程与侧边栏中文化 ====================

  const thoughtZhCache = new Map();
  const sidebarZhCache = new Map();
  const sidebarPendingIds = new Set();
  const sidebarPersistedIds = new Set();
  const sidebarRpcFailedIds = new Set();
  let localizeTimer = null;
  let localizeMutationObserver = null;
  let thinkingShellTimerRunning = false;
  let thinkingReRunNeeded = false;

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
      return data && data.ok ? data : null;
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

  function localizeThinkingShells() {
    if (disposed) return 0;
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
    if (disposed) return 0;
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

  async function persistConversationTitle(cascadeId, zhTitle) {
    if (!cascadeId || !zhTitle) return false;
    if (sidebarPersistedIds.has(cascadeId) || sidebarRpcFailedIds.has(cascadeId)) return false;
    const csrf = window.__APP_CONFIG__?.csrfToken;
    if (!csrf) return false;
    try {
      const resp = await fetch('/exa.language_server_pb.LanguageServerService/UpdateConversationAnnotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        },
        body: JSON.stringify({
          cascadeIds: [cascadeId],
          annotations: { title: zhTitle },
          mergeAnnotations: true
        })
      });
      if (resp.ok) {
        sidebarPersistedIds.add(cascadeId);
        return true;
      }
      sidebarRpcFailedIds.add(cascadeId);
      return false;
    } catch {
      return false;
    }
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

  async function localizeSidebarConversations() {
    if (disposed) return 0;
    const rows = document.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    const needLocalize = [];
    const seenNeed = new Set();
    let appliedCount = 0;

    for (const row of rows) {
      const id = row.getAttribute('data-cascade-id');
      const span = row.querySelector('span.truncate');
      if (!id || !span) continue;
      const curTitle = (span.textContent || '').trim();
      if (!curTitle) continue;

      if (/[\u4e00-\u9fff]/.test(curTitle) || !/[a-zA-Z]/.test(curTitle)) {
        continue;
      }

      const cached = sidebarZhCache.get(id);
      if (cached) {
        if (applySidebarTitleDom(row, curTitle, cached)) appliedCount++;
        if (!sidebarPersistedIds.has(id) && !sidebarRpcFailedIds.has(id)) {
          void persistConversationTitle(id, cached);
        }
        continue;
      }

      if (sidebarPendingIds.has(id) || seenNeed.has(id)) continue;
      seenNeed.add(id);
      needLocalize.push({ id, title: curTitle });
    }

    if (!needLocalize.length) return appliedCount;

    for (const it of needLocalize) sidebarPendingIds.add(it.id);
    try {
      const res = await postToLiveHost('/localize-conversations', { items: needLocalize });
      const titles = res?.titles || {};
      for (const [id, zhTitle] of Object.entries(titles)) {
        if (!zhTitle) continue;
        sidebarZhCache.set(id, zhTitle);
        const row = document.querySelector(`[data-testid="conversation-row-sidebar"][data-cascade-id="${CSS.escape(id)}"]`);
        if (row) {
          const rawTitle = needLocalize.find((x) => x.id === id)?.title || '';
          if (applySidebarTitleDom(row, rawTitle, zhTitle)) appliedCount++;
        }
        void persistConversationTitle(id, zhTitle);
      }
      return appliedCount;
    } finally {
      for (const it of needLocalize) sidebarPendingIds.delete(it.id);
    }
  }

  function scheduleLocalization() {
    if (disposed || localizeTimer) return;
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
      let needSchedule = false;
      for (const m of mutations) {
        if (m.type === 'attributes') {
          if (m.attributeName !== 'aria-expanded') continue;
          const target = m.target;
          if (target?.getAttribute?.('data-testid') === 'thinking-collapsible-trigger' && target.getAttribute('aria-expanded') === 'true') {
            fastExpand = true;
          }
          needSchedule = true;
        } else {
          needSchedule = true;
        }
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
    const header = document.querySelector('[aria-label="File Viewer header"], [aria-label="文件查看器标题栏"], .group\\/file-row');
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

  function exitFileEditor(shouldRefresh = true) {
    safeRemove(document.getElementById(FILE_EDITOR_WRAP_ID));
    restoreHiddenViewerChildren();
    const ctx = getFileViewerContext();
    fileEditorState.active = false;
    fileEditorState.filePath = '';
    fileEditorState.dirty = false;
    fileEditorState.saving = false;
    fileEditorState.loading = false;
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
      updateFileEditorStatusBar(`✅ 已保存 (${res.bytes} 字节)`);
      showQuickToast('✅ 文件已保存');
      const ctx = getFileViewerContext();
      const refreshBtn = ctx?.header?.querySelector('[data-testid="file-view-refresh"]');
      if (refreshBtn) {
        try { refreshBtn.click(); } catch {}
      }
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

      curCtx.bodyContainer.setAttribute('data-ag-editor-host', '1');
      for (const child of Array.from(curCtx.bodyContainer.children)) {
        if (child.id === FILE_EDITOR_WRAP_ID) continue;
        if (child.getAttribute('data-ag-hidden-by-editor') !== '1') {
          child.dataset.agPrevDisplay = child.style.display || '';
          child.setAttribute('data-ag-hidden-by-editor', '1');
          child.style.display = 'none';
        }
      }

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

      fileEditorState.active = true;
      fileEditorState.fileUri = ctx.fileUri;
      fileEditorState.filePath = res.filePath || '';
      fileEditorState.dirty = false;
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
      editBtn.textContent = fileEditorState.loading ? '⏳ 读取中' : '✏️ 编辑';
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
      saveBtn.textContent = fileEditorState.saving ? '⏳ 保存中' : (fileEditorState.dirty ? '💾 保存*' : '💾 保存');
      saveBtn.title = '保存更改到硬盘 (⌘S / Ctrl+S)';
      saveBtn.addEventListener('mousedown', (e) => e.preventDefault());
      saveBtn.addEventListener('click', () => { void saveFileEditor(); });

      const doneBtn = document.createElement('button');
      doneBtn.id = 'ag-fedit-done';
      doneBtn.type = 'button';
      doneBtn.className = 'ag-fedit-btn';
      doneBtn.textContent = '↩️ 完成';
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
      if (!dryRun) showQuickToast('🌐 已用系统浏览器打开链接');
      return res;
    }
    if (!dryRun && typeof window.electronNative?.openExternal === 'function') {
      try {
        window.electronNative.openExternal(safeUrl);
        showQuickToast('🌐 已用系统浏览器打开链接');
        return { ok: true, url: safeUrl, fallback: 'electronNative' };
      } catch {
        // ignore fallback error
      }
    }
    if (!dryRun) showQuickToast('⚠️ 未能打开外部链接');
    return { ok: false, error: '打开失败' };
  }

  function syncCmdModifierState(active) {
    if (active) document.documentElement.setAttribute('data-ag-cmd-down', '1');
    else document.documentElement.removeAttribute('data-ag-cmd-down');
  }

  // ==================== 全局事件与定时巡检 ====================

  function onDocClick(e) {
    if (!popoverOpen) return;
    const { host, sr } = getMeterHostAndShadow();
    if (!sr) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const btn = sr.getElementById(QUOTA_BADGE_ID);
    const pop = sr.getElementById(QUOTA_POPOVER_ID);
    if ((btn && path.includes(btn)) || (pop && path.includes(pop))) return;
    toggleQuotaPopover(false);
  }

  function onWindowClickCapture(e) {
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
    if (e.key === 'Escape' && popoverOpen) {
      toggleQuotaPopover(false);
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

  window.addEventListener('click', onWindowClickCapture, true);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown, true);
  document.addEventListener('keyup', onDocKeyup, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowResize);

  let lastQuotaFetchAt = 0;
  function tickEnhancer() {
    if (disposed) return;
    ensureQuickCapsuleBar();
    ensureChatNavFloat();
    ensureFileViewerEditor();
    scanHighRiskCommands();
    renderQuotaUI();
    localizeThinkingShells();
    scheduleLocalization();
    runAutoAcceptTick();
    if (Date.now() - lastQuotaFetchAt >= 30000) {
      lastQuotaFetchAt = Date.now();
      void refreshQuota();
    }
    if (Date.now() - lastBrainFetchAt >= 60000) {
      lastBrainFetchAt = Date.now();
      void refreshBrainStats(false);
    }
  }

  const enhancerTimer = setInterval(tickEnhancer, 1000);

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(enhancerTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (localizeTimer) {
      clearTimeout(localizeTimer);
      localizeTimer = null;
    }
    if (localizeMutationObserver) {
      localizeMutationObserver.disconnect();
      localizeMutationObserver = null;
    }
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('click', onWindowClickCapture, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    document.removeEventListener('keyup', onDocKeyup, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', onWindowResize);
    syncCmdModifierState(false);
    if (fileEditorState.active) exitFileEditor(false);
    safeRemove(document.getElementById(FILE_EDITOR_CONTROLS_ID));
    safeRemove(document.getElementById(FILE_EDITOR_WRAP_ID));
    restoreHiddenViewerChildren();
    const { sr } = getMeterHostAndShadow();
    if (sr) {
      safeRemove(sr.getElementById(QUOTA_BADGE_ID));
      safeRemove(sr.getElementById(QUOTA_POPOVER_ID));
      safeRemove(sr.getElementById(QUOTA_STYLE_ID));
    }
    safeRemove(document.getElementById(QUICK_BAR_ID));
    safeRemove(document.getElementById(CHAT_NAV_ID));
    document.querySelectorAll('.ag-risk-banner').forEach(safeRemove);
    document.querySelectorAll('[data-ag-risk-card]').forEach((el) => el.removeAttribute('data-ag-risk-card'));
    safeRemove(document.getElementById(DOC_STYLE_ID));
  }

  globalThis.__AGEnhancer = {
    version: '1.5.1',
    isAlive: () => {
      if (disposed) return false;
      const { sr } = getMeterHostAndShadow();
      return Boolean(sr && sr.getElementById(QUOTA_BADGE_ID));
    },
    refreshQuota,
    refreshBrainStats,
    scanHighRiskCommands,
    toggleAllThinking,
    enterFileEditor,
    saveFileEditor,
    exitFileEditor,
    extractExternalUrlFromTarget,
    openExternalUrlInSystemBrowser,
    getBrainStats: () => latestBrainStats,
    getAutoAccept: () => autoAcceptEnabled,
    exportMarkdown,
    localizeSidebarConversations,
    localizeThinkingShells,
    translateExpandedThoughts,
    dispose
  };

  ensureQuickCapsuleBar();
  ensureChatNavFloat();
  ensureFileViewerEditor();
  scanHighRiskCommands();
  renderQuotaUI();
  localizeThinkingShells();
  startLocalizationObserver();
  void translateExpandedThoughts();
  void localizeSidebarConversations();
  lastQuotaFetchAt = Date.now();
  lastBrainFetchAt = Date.now();
  void refreshQuota();
  void refreshBrainStats(false);
})();

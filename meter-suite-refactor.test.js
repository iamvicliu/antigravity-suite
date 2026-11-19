const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const core = require('./meter-core');
const terminals = require('./meter-terminals');
const collector = require('./meter-collector');
const modularInstaller = require('./modular-installer');

const ROOT = __dirname;
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
const ENHANCER_SRC = fs.readFileSync(path.join(ROOT, 'ag-enhancer-overlay.js'), 'utf8');
const CAPSULE_SRC = fs.readFileSync(path.join(ROOT, 'pulse-capsule-overlay.js'), 'utf8');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

function parseTagAttributes(raw) {
  const attrs = new Map();
  const re = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs.set(key, val);
  }
  return attrs;
}

function matchesSimpleSelector(node, sel) {
  if (!node || !node.tagName || node.tagName === '#text' || node.tagName === '#root') return false;
  const trimmed = sel.trim();
  if (!trimmed) return false;
  if (trimmed.includes(',')) {
    return trimmed.split(',').some(part => matchesSimpleSelector(node, part));
  }
  if (trimmed.includes(' ')) {
    const segs = trimmed.split(/\s+/);
    if (!matchesSimpleSelector(node, segs[segs.length - 1])) return false;
    let anc = node.parentElement;
    let idx = segs.length - 2;
    while (anc && idx >= 0) {
      if (matchesSimpleSelector(anc, segs[idx])) idx--;
      anc = anc.parentElement;
    }
    return idx < 0;
  }
  if (trimmed.startsWith('#')) {
    const rest = trimmed.slice(1).split(/[\s.\[:]/)[0];
    return node.id === rest;
  }
  if (trimmed.startsWith('.')) {
    const rest = trimmed.slice(1).split(/[\s.\[:]/)[0];
    return node.classList.contains(rest);
  }
  const attrMatch = trimmed.match(/^([a-zA-Z0-9_-]+)?\[([^\]]+)\]$/);
  if (attrMatch) {
    if (attrMatch[1] && node.tagName.toLowerCase() !== attrMatch[1].toLowerCase()) return false;
    const inner = attrMatch[2];
    const starIdx = inner.indexOf('*=');
    if (starIdx >= 0) {
      const k = inner.slice(0, starIdx).trim();
      const vExpected = inner.slice(starIdx + 2).trim().replace(/^["']|["']$/g, '');
      const actual = k === 'class' ? node.className : (node.getAttribute(k) ?? '');
      return String(actual).includes(vExpected);
    }
    const [k, vRaw] = inner.split('=');
    const actual = k.trim() === 'class' ? (node.className || null) : node.getAttribute(k.trim());
    if (actual === null) return false;
    if (vRaw === undefined) return true;
    return actual === vRaw.trim().replace(/^["']|["']$/g, '');
  }
  const tag = trimmed.split(/[\s.#\[:]/)[0];
  return node.tagName.toLowerCase() === tag.toLowerCase();
}

function createDomEnv(options = {}) {
  const timers = [];
  const storageMap = new Map(Object.entries(options.initialStorage || {}));
  const docListeners = new Map();
  const winListeners = new Map();
  const pendingFetches = [];
  const postedSettings = [];
  const cliRequests = [];

  function makeStyle() {
    const props = new Map();
    const styleObj = {
      display: '',
      opacity: '',
      visibility: '',
      color: '',
      background: '',
      borderColor: '',
      boxShadow: '',
      transform: '',
      left: '',
      top: '',
      right: '',
      bottom: '',
      width: '',
      height: '',
      pointerEvents: '',
      cssText: '',
      setProperty(k, v) { props.set(String(k), String(v)); },
      removeProperty(k) { props.delete(String(k)); },
      getPropertyValue(k) {
        const val = props.get(String(k));
        if (val !== undefined) return val;
        if (k === 'display') return styleObj.display || '';
        return '';
      },
      _props: props
    };
    return styleObj;
  }

  function makeNode(tagName = 'div') {
    const attrs = new Map();
    const listeners = new Map();
    const style = makeStyle();
    let ownText = '';
    let ownValue = '';
    const node = {
      tagName: String(tagName).toUpperCase(),
      nodeType: tagName === '#text' ? 3 : 1,
      children: [],
      childNodes: [],
      parentNode: null,
      parentElement: null,
      style,
      hidden: false,
      checked: false,
      disabled: false,
      dataset: {},
      scrollWidth: 0,
      clientWidth: 100,
      scrollHeight: 0,
      clientHeight: 100,
      offsetWidth: 400,
      offsetHeight: 300,
      shadowRoot: null,
      get value() {
        if (node.tagName === 'OPTION') return attrs.has('value') ? attrs.get('value') : node.textContent.trim();
        if (node.tagName === 'SELECT') {
          if (ownValue) return ownValue;
          const opts = node.options;
          const sel = opts.find(o => o.selected) || opts[0];
          return sel ? sel.value : '';
        }
        return ownValue;
      },
      set value(v) {
        ownValue = String(v ?? '');
        if (node.tagName === 'SELECT') {
          for (const opt of node.options) {
            opt.selected = (opt.value === ownValue);
          }
        }
      },
      get options() {
        return node.tagName === 'SELECT' ? node.children.filter(c => c.tagName === 'OPTION') : [];
      },
      get text() { return node.textContent; },
      set text(v) { node.textContent = v; },
      get selectedOptions() {
        return node.options.filter(o => o.selected);
      },
      get selectedIndex() {
        if (node.tagName !== 'SELECT') return -1;
        const opts = node.options;
        const idx = opts.findIndex(o => o.selected);
        return idx >= 0 ? idx : (opts.length ? 0 : -1);
      },
      set selectedIndex(idx) {
        const opts = node.options;
        opts.forEach((o, i) => { o.selected = (i === Number(idx)); });
        if (opts[Number(idx)]) ownValue = opts[Number(idx)].value;
      },
      get selected() {
        return node._selected !== undefined ? Boolean(node._selected) : attrs.has('selected');
      },
      set selected(v) { node._selected = Boolean(v); },
      get id() { return attrs.get('id') || ''; },
      set id(v) { attrs.set('id', String(v || '')); },
      get className() { return attrs.get('class') || ''; },
      set className(v) { attrs.set('class', String(v || '')); },
      get textContent() {
        if (node.tagName === '#text') return ownText;
        if (node.children.length === 0 && node.childNodes.length === 0) return ownText;
        if (ownText && node.children.length === 0) return ownText;
        const parts = [];
        for (const ch of node.childNodes) {
          parts.push(ch.textContent || '');
        }
        return (parts.join('') || ownText);
      },
      set textContent(v) {
        ownText = String(v ?? '');
        node.children = [];
        node.childNodes = [];
      },
      get innerText() { return node.textContent; },
      set innerText(v) { node.textContent = v; },
      get innerHTML() { return ownText; },
      set innerHTML(htmlStr) {
        ownText = String(htmlStr || '');
        node.children = [];
        node.childNodes = [];
        parseHtmlInto(node, ownText);
      },
      classList: {
        add(...clsList) {
          const cur = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
          for (const c of clsList) {
            if (c && !cur.includes(c)) cur.push(c);
          }
          attrs.set('class', cur.join(' '));
        },
        remove(...clsList) {
          const rm = new Set(clsList);
          const cur = (attrs.get('class') || '').split(/\s+/).filter(c => c && !rm.has(c));
          attrs.set('class', cur.join(' '));
        },
        toggle(c, force) {
          if (force === true) { node.classList.add(c); return true; }
          if (force === false) { node.classList.remove(c); return false; }
          if (node.classList.contains(c)) { node.classList.remove(c); return false; }
          node.classList.add(c); return true;
        },
        contains(c) {
          return (attrs.get('class') || '').split(/\s+/).includes(c);
        }
      },
      setAttribute(k, v) {
        const key = String(k);
        const val = String(v ?? '');
        attrs.set(key, val);
        if (key === 'hidden') node.hidden = true;
        if (key === 'selected') node._selected = true;
        if (key === 'data-value') node.dataset.value = val;
        if (key === 'data-tab') node.dataset.tab = val;
        if (key === 'data-range') node.dataset.range = val;
        if (key === 'data-mode') node.dataset.mode = val;
        if (key === 'data-source') node.dataset.source = val;
        if (key === 'data-metric') node.dataset.metric = val;
        if (key === 'data-preset') node.dataset.preset = val;
        if (key === 'data-slot') node.dataset.slot = val;
        if (key === 'data-level') node.dataset.level = val;
        if (key === 'value') ownValue = val;
      },
      getAttribute(k) { return attrs.has(String(k)) ? attrs.get(String(k)) : null; },
      hasAttribute(k) { return attrs.has(String(k)); },
      removeAttribute(k) {
        const key = String(k);
        if (key === 'hidden') node.hidden = false;
        if (key === 'selected') node._selected = false;
        attrs.delete(key);
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode && typeof child.remove === 'function') child.remove();
        child.parentNode = node;
        child.parentElement = node.nodeType === 11 ? null : node;
        node.childNodes.push(child);
        if (child.nodeType !== 3) node.children.push(child);
        return child;
      },
      insertBefore(newNode, refNode) {
        if (!refNode) return node.appendChild(newNode);
        if (newNode.parentNode && typeof newNode.remove === 'function') newNode.remove();
        newNode.parentNode = node;
        newNode.parentElement = node.nodeType === 11 ? null : node;
        const cIdx = node.children.indexOf(refNode);
        if (cIdx >= 0) node.children.splice(cIdx, 0, newNode);
        else node.children.push(newNode);
        const cnIdx = node.childNodes.indexOf(refNode);
        if (cnIdx >= 0) node.childNodes.splice(cnIdx, 0, newNode);
        else node.childNodes.push(newNode);
        return newNode;
      },
      insertAdjacentElement(position, targetEl) {
        if (!targetEl) return null;
        const pos = String(position || '').toLowerCase();
        if (pos === 'beforebegin') return node.parentNode ? node.parentNode.insertBefore(targetEl, node) : null;
        if (pos === 'afterbegin') return node.insertBefore(targetEl, node.childNodes[0] || null);
        if (pos === 'beforeend') return node.appendChild(targetEl);
        if (pos === 'afterend') return node.parentNode ? node.parentNode.insertBefore(targetEl, node.nextSibling) : null;
        return null;
      },
      get firstChild() { return node.childNodes[0] || null; },
      get firstElementChild() { return node.children[0] || null; },
      get nextSibling() {
        if (!node.parentNode) return null;
        const siblings = node.parentNode.childNodes;
        const idx = siblings.indexOf(node);
        return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
      },
      get nextElementSibling() {
        if (!node.parentNode) return null;
        const siblings = node.parentNode.children;
        const idx = siblings.indexOf(node);
        return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
      },
      remove() {
        if (node.parentNode) {
          const p = node.parentNode;
          const ci = p.children.indexOf(node);
          if (ci >= 0) p.children.splice(ci, 1);
          const cni = p.childNodes.indexOf(node);
          if (cni >= 0) p.childNodes.splice(cni, 1);
          node.parentNode = null;
          node.parentElement = null;
        }
      },
      replaceChildren(...items) {
        for (const ch of [...node.childNodes]) {
          ch.parentNode = null;
          ch.parentElement = null;
        }
        node.children = [];
        node.childNodes = [];
        for (const item of items) {
          if (typeof item === 'string') {
            const t = makeNode('#text');
            t.textContent = item;
            node.appendChild(t);
          } else if (item) {
            node.appendChild(item);
          }
        }
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === node) return true;
          cur = cur.parentNode || cur.parentElement;
        }
        return false;
      },
      closest(sel) {
        let cur = node;
        while (cur) {
          if (matchesSimpleSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const results = [];
        const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
        const walk = cur => {
          for (const ch of cur.children) {
            for (const p of parts) {
              if (p.includes(' ')) {
                const segs = p.split(/\s+/);
                if (matchesSimpleSelector(ch, segs[segs.length - 1])) {
                  let anc = ch.parentElement;
                  let idx = segs.length - 2;
                  while (anc && idx >= 0) {
                    if (matchesSimpleSelector(anc, segs[idx])) idx--;
                    anc = anc.parentElement;
                  }
                  if (idx < 0) { results.push(ch); break; }
                }
              } else if (matchesSimpleSelector(ch, p)) {
                results.push(ch);
                break;
              }
            }
            walk(ch);
          }
        };
        walk(node);
        return results;
      },
      querySelector(sel) {
        return node.querySelectorAll(sel)[0] || null;
      },
      getElementById(id) {
        const walk = cur => {
          for (const ch of cur.children) {
            if (ch.id === id) return ch;
            const found = walk(ch);
            if (found) return found;
          }
          return null;
        };
        return walk(node);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatchEvent(ev = {}) {
        ev.target = ev.target || node;
        ev.currentTarget = node;
        ev.stopPropagation = ev.stopPropagation || (() => { ev._stopped = true; });
        ev.preventDefault = ev.preventDefault || (() => { ev._prevented = true; });
        const arr = listeners.get(ev.type) || [];
        for (const fn of [...arr]) fn.call(node, ev);
        return !ev._prevented;
      },
      click() {
        const ev = {
          type: 'click',
          target: node,
          currentTarget: node,
          _stopped: false,
          stopPropagation() { this._stopped = true; },
          preventDefault() { this._prevented = true; }
        };
        let cur = node;
        while (cur && !ev._stopped) {
          ev.currentTarget = cur;
          const fnList = listeners.get?.('click') || [];
          if (cur === node) {
            for (const fn of [...fnList]) fn.call(cur, ev);
          } else if (typeof cur._dispatchDirect === 'function') {
            cur._dispatchDirect('click', ev);
          }
          cur = cur.parentElement;
        }
      },
      _dispatchDirect(type, ev) {
        const fnList = listeners.get(type) || [];
        for (const fn of [...fnList]) fn.call(node, ev);
      },
      focus() {},
      scrollIntoView() {},
      getBoundingClientRect() {
        return { left: 120, top: 4, width: 120, height: 24, right: 240, bottom: 28 };
      }
    };
    return node;
  }

  function parseHtmlInto(rootNode, html) {
    const cleaned = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
    const stack = [rootNode];
    let match;
    while ((match = tokenRe.exec(cleaned)) !== null) {
      if (match[0].startsWith('<!--')) continue;
      if (match[1]) {
        const closeTag = match[1].toUpperCase();
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName === closeTag) {
            stack.length = i;
            break;
          }
        }
      } else if (match[2]) {
        const tag = match[2].toLowerCase();
        const attrRaw = match[3] || '';
        const selfClosing = Boolean(match[4]) || VOID_TAGS.has(tag);
        const elNode = makeNode(tag);
        const attrMap = parseTagAttributes(attrRaw);
        for (const [k, v] of attrMap.entries()) {
          elNode.setAttribute(k, v);
        }
        stack[stack.length - 1].appendChild(elNode);
        if (!selfClosing) stack.push(elNode);
      } else if (match[5]) {
        const text = match[5];
        if (text.trim()) {
          const t = makeNode('#text');
          t.textContent = text;
          stack[stack.length - 1].appendChild(t);
        }
      }
    }
  }

  const documentElement = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  // Build simulated VS Code / Antigravity topbar and composer shell
  const topbarHost = makeNode('div');
  topbarHost.className = 'monaco-workbench';
  const titlebar = makeNode('div');
  titlebar.className = 'part titlebar';
  const rightControls = makeNode('div');
  rightControls.className = 'titlebar-right';
  const convPane = makeNode('div');
  convPane.className = 'antigravity-agent-side-panel';
  titlebar.appendChild(rightControls);
  topbarHost.appendChild(titlebar);
  topbarHost.appendChild(convPane);
  body.appendChild(topbarHost);

  let shadowRef = null;
  let hostRef = null;

  const doc = {
    nodeType: 9,
    childNodes: [documentElement],
    children: [documentElement],
    documentElement,
    head,
    body,
    hidden: false,
    createElement(tag) {
      const node = makeNode(tag);
      node.attachShadow = () => {
        hostRef = node;
        const shadow = makeNode('#shadow');
        shadow.nodeType = 11;
        shadow.host = node;
        shadowRef = shadow;
        node.shadowRoot = shadow;
        return shadow;
      };
      return node;
    },
    createElementNS(_ns, tag) {
      return doc.createElement(tag);
    },
    getElementById(id) {
      return documentElement.getElementById(id);
    },
    querySelectorAll(sel) {
      const topHits = documentElement.querySelectorAll(sel);
      return topHits;
    },
    querySelector(sel) {
      return documentElement.querySelector(sel);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(ev = {}) {
      const arr = docListeners.get(ev.type) || [];
      for (const fn of [...arr]) fn(ev);
    }
  };

  class CustomEventPoly {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const localStorageObj = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); }
  };

  const apiMocks = {
    scan: () => Promise.resolve({ ok: true, groups: {}, total: { chars: 100, low: 10, high: 50 }, attachmentTotal: core.empty(), attachments: [], unknownFiles: 0 }),
    getSettings: () => Promise.resolve(options.hostSettings || {
      country: 'TW',
      subscriptionRegion: 'TW',
      currency: 'CNY',
      uiPreferences: {
        terminalApp: options.savedTerminalApp || 'iterm2',
        customTerminalPath: options.savedCustomTermPath || '/Applications/iTerm.app',
        autoAccept: false,
        ghostSuggest: true,
        capsuleLang: 'zh'
      }
    }),
    saveSettings: payload => {
      postedSettings.push(payload);
      return Promise.resolve({ ok: true, settings: payload });
    },
    listTerminals: () => Promise.resolve({
      ok: true,
      platform: options.platform || 'darwin',
      terminals: options.mockTerminals || [
        { id: 'auto', name: '自动检测 (推荐)', installed: true, executablePath: '' },
        { id: 'terminal', name: 'macOS 终端 (Terminal.app)', installed: true, executablePath: '/System/Applications/Utilities/Terminal.app' },
        { id: 'iterm2', name: 'iTerm2', installed: true, executablePath: '/Applications/iTerm.app' },
        { id: 'ghostty', name: 'Ghostty', installed: true, executablePath: '/Applications/Ghostty.app' },
        { id: 'warp', name: 'Warp', installed: true, executablePath: '/Applications/Warp.app' },
        { id: 'rex', name: 'Rex', installed: true, executablePath: '/Applications/Rex Beta.app', supportsMuxHost: true },
        { id: 'wezterm', name: 'WezTerm', installed: true, executablePath: '/Applications/WezTerm.app', supportsMuxHost: true },
        { id: 'tmux', name: 'tmux (多路复用器)', installed: true, executablePath: '/opt/homebrew/bin/tmux', supportsMuxHost: true },
        { id: 'custom', name: '自定义终端路径…', installed: false, executablePath: '', isCustom: true, supportsMuxHost: true }
      ],
      muxHosts: options.mockMuxHosts || [
        { id: '', label: '本机 (Local)', labelEn: 'This Mac (Local)', source: 'local', isLocal: true }
      ]
    }),
    pickTerminalPath: () => Promise.resolve({ ok: true, canceled: false, path: '/Applications/WezTerm.app' }),
    launchCli: opts => {
      cliRequests.push(opts);
      return Promise.resolve({ ok: true, terminalId: opts?.terminalApp || 'auto' });
    },
    getTokenHistory: () => Promise.resolve(options.tokenHistory || {
      planStatus: {
        tierKey: 'ultra',
        tierName: 'Google AI Ultra (20x)',
        ultraSubTier: '20x',
        promptCredits: { available: 500, monthly: 50000 },
        flowCredits: { available: 100, monthly: 150000 }
      },
      summary: { total: 1000, today: 200, month: 800, year: 1000, firstUseDate: '2026-05-20' },
      days: { '2026-11-17': { total: 200, desktop: 200, cli: 0 } }
    }),
    getProxyStatus: () => Promise.resolve({ ok: true, effectiveMode: 'system', tun: false }),
    getContextUnlockStatus: () => Promise.resolve({ ok: true, patched: true, unlocked: true }),
    getQuotaSummary: () => Promise.resolve(options.quotaSummary || {
      groups: [
        { id: 'gemini_pro', label: 'Gemini 3.1 Pro (High)', remainingPercent: 85, resetAt: new Date(Date.now() + 3600000).toISOString() },
        { id: 'gemini_flash', label: 'Gemini 3.8 Flash', remainingPercent: 45, resetAt: new Date(Date.now() + 7200000).toISOString() },
        { id: 'claude_sonnet', label: 'Claude 4.7 Sonnet', remainingPercent: 60, resetAt: new Date(Date.now() + 14400000).toISOString() }
      ],
      planStatus: {
        tierKey: 'ultra',
        tierName: 'Google AI Ultra (20x)',
        ultraSubTier: '20x',
        promptCredits: { available: 500, monthly: 50000 },
        flowCredits: { available: 100, monthly: 150000 }
      }
    })
  };

  const winObj = {
    __APP_CONFIG__: { csrfToken: 'test-token' },
    contextMeterAPI: apiMocks,
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { platform: options.platform === 'win32' ? 'Win32' : 'MacIntel', userAgent: options.platform === 'win32' ? 'Windows' : 'Macintosh' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: target => target?.style || makeStyle(),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = winListeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(ev = {}) {
      const arr = winListeners.get(ev.type) || [];
      for (const fn of [...arr]) fn(ev);
    },
    localStorage: localStorageObj,
    CustomEvent: CustomEventPoly,
    Event: CustomEventPoly
  };

  const sandbox = {
    window: winObj,
    self: winObj,
    document: doc,
    location: { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/11111111-1111-1111-1111-111111111111' },
    navigator: winObj.navigator,
    localStorage: localStorageObj,
    CustomEvent: CustomEventPoly,
    Event: CustomEventPoly,
    MutationObserver: class { observe() {} disconnect() {} },
    Node: function Node() {},
    HTMLElement: function HTMLElement() {},
    Element: function Element() {},
    getComputedStyle: winObj.getComputedStyle,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    __AGContextMeterCore: core,
    AbortController,
    Date,
    URL,
    performance: { now: () => Date.now() },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval(cb) { timers.push(cb); return timers.length; },
    clearInterval() {},
    fetch(url, opts) {
      return new Promise(resolve => pendingFetches.push({ url, opts, resolve }));
    },
    console
  };
  sandbox.globalThis = sandbox;
  Object.assign(winObj, { globalThis: sandbox });

  vm.createContext(sandbox);
  return {
    sandbox,
    doc,
    win: winObj,
    localStorage: localStorageObj,
    getShadow: () => shadowRef,
    getHost: () => hostRef,
    postedSettings,
    cliRequests,
    pendingFetches,
    apiMocks,
    winListeners,
    docListeners
  };
}

// =========================================================================
// 需求 1: 顶部紫色文字与强调元素随下方热力图/颜色主题动态联动
// =========================================================================
test('需求 1: 顶部标题与强调样式在深色/浅色下随预设主题及自定义强调色联动', async () => {
  const env = createDomEnv();
  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const host = env.getHost();
  assert.ok(api && host, 'renderer api 和 shadow host 应初始化');

  // 默认未自定义 tokenAccent 时，--ag-custom-token-accent 应为空，不阻塞主题预设切换
  assert.equal(host.style.getPropertyValue('--ag-custom-token-accent'), '');

  // 切换到蓝色系预设
  api.setHeatPreset('blue');
  assert.equal(api.getHeatPreset(), 'blue');
  const blueDefault = host.style.getPropertyValue('--ag-token-accent-default');
  assert.ok(blueDefault && !blueDefault.toLowerCase().includes('9333ea') && !blueDefault.toLowerCase().includes('c084fc'),
    `蓝色预设下 --ag-token-accent-default 不应停留在紫色: ${blueDefault}`);
  assert.ok(host.style.getPropertyValue('--ag-accent-bg').includes('rgba('), '应派生半透明胶囊背景 --ag-accent-bg');
  assert.ok(host.style.getPropertyValue('--ag-accent-border').includes('rgba('), '应派生胶囊边框 --ag-accent-border');

  // 切换到绿色系与黄色系并在深色模式重算
  api.setHeatPreset('green');
  const greenLight = host.style.getPropertyValue('--ag-token-accent-default');
  api.setTheme('dark');
  const greenDark = host.style.getPropertyValue('--ag-token-accent-default');
  assert.notEqual(greenLight, blueDefault);
  assert.ok(greenDark, '深色模式下应写入 --ag-token-accent-default');

  // 显式自定义 tokenAccent 后应写入 --ag-custom-token-accent 并同步 --ag-accent-*
  api.setCustomColor('tokenAccent', '#ff5722');
  assert.equal(host.style.getPropertyValue('--ag-custom-token-accent'), '#ff5722');
  assert.ok(host.style.getPropertyValue('--ag-accent-bg').includes('255, 87, 34'), '自定义强调色应驱动 --ag-accent-bg');

  // 清除自定义后应恢复跟随主题预设
  api.resetCustomColors();
  assert.equal(host.style.getPropertyValue('--ag-custom-token-accent'), '');

  // 验证打包后 CSS/HTML 使用动态强调色变量而非硬编码紫字
  assert.ok(RENDERER_SRC.includes('--ag-token-accent-default'), '打包产物必须包含 --ag-token-accent-default');
  assert.ok(RENDERER_SRC.includes('var(--ag-custom-token-accent,var(--ag-token-accent-default))') || RENDERER_SRC.includes('var(--ag-custom-token-accent, var(--ag-token-accent-default))'),
    'HTML/CSS 标题与强调文字应引用 --ag-custom-token-accent 与 --ag-token-accent-default');

  api.dispose?.();
});

// =========================================================================
// 需求 2: Prompt/Flow 额度池与套餐子组保持一致，且多组配额不被覆盖
// =========================================================================
test('需求 2: resolvePlanQuotaPools 与渲染/配额浮窗保持套餐子组一致并保留多组 Gemini 配额', async () => {
  // 1. Core 计算各档套餐额度池
  const ultra20 = core.resolvePlanQuotaPools({
    tierKey: 'ultra',
    ultraSubTier: '20x',
    promptCredits: { available: 500, monthly: 50000 },
    flowCredits: { available: 100, monthly: 150000 }
  });
  assert.equal(ultra20.subTier, '20x');
  assert.ok(/20[x×]/i.test(ultra20.promptPoolText), `Ultra 20x Prompt 额度池应体现 20x 规格: ${ultra20.promptPoolText}`);
  assert.ok(!ultra20.promptPoolText.includes('500 / 50000') && !ultra20.flowPoolText.includes('100 / 150000'),
    '不得再透出旧版客户端内部存根 500 / 50000 或 100 / 150000');

  const ultra5 = core.resolvePlanQuotaPools({ tierKey: 'ultra', ultraSubTier: '5x' });
  assert.ok(/5[x×]/i.test(ultra5.promptPoolText) && ultra5.flowPoolText.includes('10,000'),
    `Ultra 5x 额度池应体现 5× 与 10,000 积分: prompt="${ultra5.promptPoolText}", flow="${ultra5.flowPoolText}"`);

  const ultraUnset = core.resolvePlanQuotaPools({ tierKey: 'ultra', ultraSubTier: '' });
  assert.ok(ultraUnset.promptPoolText.includes('Pro') || ultraUnset.promptPoolText.includes('5×'), 'Ultra 未指定倍率时应提示待选档位范围');

  const proPool = core.resolvePlanQuotaPools({ tierKey: 'pro' });
  const plusPool = core.resolvePlanQuotaPools({ tierKey: 'plus' });
  const freePool = core.resolvePlanQuotaPools({ tierKey: 'free' });
  assert.ok(proPool.promptPoolText.includes('Pro') && proPool.flowPoolText.includes('1,000'));
  assert.ok(plusPool.promptPoolText.includes('Plus') && plusPool.flowPoolText.includes('200'));
  assert.ok(freePool.promptPoolText.includes('免费') && freePool.flowPoolText.includes('100'));

  // 2. 渲染器详情卡与只读子档标签同步
  const env = createDomEnv();
  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const shadow = env.getShadow();

  api.setTokenHistoryForTest({
    planStatus: {
      status: 'identified',
      email: 'ultra_test@example.invalid',
      tierKey: 'ultra',
      tierName: 'Google AI Ultra (20x)',
      ultraSubTier: '20x',
      promptCredits: { available: 500, monthly: 50000 },
      flowCredits: { available: 100, monthly: 150000 },
      country: 'TR',
      subscriptionRegion: 'TR',
      currency: 'CNY'
    },
    summary: { grandTotalTokens: 5000, todayTokens: 500, total: 5000, today: 500, month: 2000, year: 5000, firstUseDate: '2026-10-01' },
    days: { '2026-11-17': { total: 500, desktop: 500, cli: 0 } }
  });

  const promptElText = shadow.getElementById('p-det-prompt-credits')?.textContent || '';
  const flowElText = shadow.getElementById('p-det-flow-credits')?.textContent || '';
  assert.ok(!promptElText.includes('500 可用 / 50000') && !flowElText.includes('100 / 150000'),
    `详情卡不得残留 500/50000 或 100/150000: prompt="${promptElText}", flow="${flowElText}"`);
  assert.ok(/20[x×]/i.test(promptElText) && flowElText.includes('25,000'),
    `Ultra 20x 详情卡应显示 20× 与 25,000 积分池: prompt="${promptElText}", flow="${flowElText}"`);
  assert.ok((shadow.getElementById('p-det-subtier-readonly')?.textContent || '').includes('20x') ||
    (shadow.getElementById('summary-subtier-readonly')?.textContent || '').includes('20x'),
    '详情卡只读子档标签应显示 20x');

  // 3. ag-enhancer-overlay.js 多子组保留与配额浮窗额度池展示
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;
  assert.ok(enhancer, 'ag-enhancer-overlay 应挂载 window.__AGEnhancer');
  assert.equal(typeof enhancer.parseQuotaSummaryGroups, 'function', '应导出 parseQuotaSummaryGroups');

  const reset1 = new Date(Date.now() + 3600000).toISOString();
  const reset2 = new Date(Date.now() + 7200000).toISOString();
  const reset3 = new Date(Date.now() + 14400000).toISOString();
  const parsed = enhancer.parseQuotaSummaryGroups({
    response: {
      groups: [
        {
          displayName: 'Gemini 3.1 Pro',
          buckets: [
            { window: '5h', bucketId: 'gemini_pro_5h', remainingFraction: 0.9, resetTime: reset1 },
            { window: 'weekly', bucketId: 'gemini_pro_weekly', remainingFraction: 0.8, resetTime: reset2 }
          ]
        },
        {
          displayName: 'Gemini 3.8 Flash',
          buckets: [
            { window: '5h', bucketId: 'gemini_flash_5h', remainingFraction: 0.35, resetTime: reset2 }
          ]
        },
        {
          displayName: 'Claude 4.7 Sonnet',
          buckets: [
            { window: '5h', bucketId: '3p_claude_5h', remainingFraction: 0.7, resetTime: reset3 }
          ]
        }
      ]
    }
  });
  const geminiGroup = parsed.gemini;
  assert.ok(geminiGroup?.fiveHour, '应聚合得到 Gemini 5h 配额组');
  assert.equal(parsed.subGroups?.length, 3, '所有分组（含多条 Gemini 子组与 Claude 组）必须完整保留而不被覆盖');
  assert.equal(parsed.subGroups.filter(g => g.poolKey === 'gemini').length, 2, '多条 Gemini 子组应分别保留');
  assert.equal(Math.round(geminiGroup.fiveHour.remainingFraction * 100), 35, 'Gemini 主组剩余比例应取更紧约束 35%');

  if (typeof enhancer.toggleQuotaPopover === 'function') {
    await enhancer.toggleQuotaPopover(true);
    const pop = env.doc.getElementById('ag-quota-popover') || shadow.getElementById('ag-quota-popover');
    if (pop) {
      const popText = pop.textContent || '';
      assert.ok(!popText.includes('500 / 50000') && !popText.includes('100 / 150000'),
        `配额浮窗不得透出旧存根 500 / 50000 或 100 / 150000: ${popText}`);
      const openSettingsBtn = env.doc.getElementById('ag-quota-open-settings') || shadow.getElementById('ag-quota-open-settings');
      assert.ok(openSettingsBtn, '配额浮窗应包含跳转统一设置的 ⚙️ 按钮 (#ag-quota-open-settings)');
    }
  }

  api.dispose?.();
  enhancer.dispose?.();
});

// =========================================================================
// 需求 3: 顶部上下文用量与输出速度两个按钮合并为同一个按钮
// =========================================================================
test('需求 3: 顶部 #badge-speed 合并进 #badge 内，点击均打开上下文窗口面板，#badge-quota 独立外置', async () => {
  const env = createDomEnv();
  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const shadow = env.getShadow();

  const badgeBtn = shadow.getElementById('badge');
  const speedSpan = shadow.getElementById('badge-speed');
  const settingsBtn = shadow.getElementById('badge-settings');
  const panel = shadow.getElementById('panel');
  const panelTokens = shadow.getElementById('panel-tokens');

  assert.ok(badgeBtn && speedSpan && settingsBtn, '顶部 #badge, #badge-speed, #badge-settings 均应存在');
  assert.equal(badgeBtn.tagName, 'BUTTON');
  assert.equal(speedSpan.tagName, 'SPAN');
  assert.ok(badgeBtn.contains(speedSpan), '#badge-speed 应嵌套在合并后的 #badge 按钮内');
  assert.ok(!badgeBtn.contains(settingsBtn), '#badge-settings 应是独立顶栏设置入口');
  assert.equal(panel.hidden, true, '初始状态 #panel 应隐藏');

  // 点击内层 #badge-speed 也应只打开上下文窗口面板，不打开用量面板
  speedSpan.click();
  assert.equal(panel.hidden, false, '点击速度区域应打开上下文窗口 #panel');
  assert.equal(panelTokens.hidden, true, '不得错开 #panel-tokens');

  // 再次点击合并按钮应切换关闭
  badgeBtn.click();
  assert.equal(panel.hidden, true, '再次点击合并按钮应关闭上下文面板');

  // Enhancer 注入 #badge-quota 时应挂载在 #badge 之后而非内部
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;
  const quotaBadge = shadow.getElementById('badge-quota');
  assert.ok(quotaBadge, 'Enhancer 应挂载 #badge-quota');
  assert.ok(!badgeBtn.contains(quotaBadge), '#badge-quota 不应被放进 #badge 内部');
  assert.equal(badgeBtn.nextElementSibling, quotaBadge, '#badge-quota 应紧跟在 #badge 之后');

  api.dispose?.();
  enhancer.dispose?.();
});

// =========================================================================
// 需求 4a: 统一设置面板无损迁移所有原配置项，并精简悬浮胶囊/增强栏
// =========================================================================
test('需求 4a: 真实 DOM 树下所有配置项迁入 #panel-settings，原面板与悬浮胶囊移除内联配置', async () => {
  const env = createDomEnv();
  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const shadow = env.getShadow();

  const settingsPanel = shadow.getElementById('panel-settings');
  const contextPanel = shadow.getElementById('panel');
  const tokensPanel = shadow.getElementById('panel-tokens');
  assert.ok(settingsPanel && contextPanel && tokensPanel, '三主面板应同时存在');

  // 1. 验证原配置抽屉和原编辑按钮已从 #panel / #panel-tokens 移除
  for (const removedId of [
    'meter-colors-drawer',
    'token-colors-drawer',
    'proxy-notun-drawer',
    'context-unlock-drawer',
    'summary-subtier-wrap',
    'btn-edit-plan-custom'
  ]) {
    assert.equal(shadow.getElementById(removedId), null, `迁移后应彻底移除原配置容器: #${removedId}`);
  }

  // 2. 验证所有原配置主体已无损迁移进 #panel-settings 内部
  for (const movedId of [
    'color-drawer-body',
    'token-color-drawer-body',
    'proxy-drawer-body',
    'unlock-drawer-body',
    'direct-subtier-wrap',
    'direct-country-wrap',
    'direct-region-wrap',
    'direct-currency-wrap',
    'price-mode-switch-group',
    'plan-custom-form'
  ]) {
    const movedNode = shadow.getElementById(movedId);
    assert.ok(movedNode, `原配置控件 #${movedId} 迁移后必须仍可通过 ID 找到`);
    assert.ok(settingsPanel.contains(movedNode), `#${movedId} 必须已被搬入 #panel-settings`);
    assert.ok(!contextPanel.contains(movedNode) && !tokensPanel.contains(movedNode),
      `#${movedId} 不应再残留于 #panel 或 #panel-tokens`);
  }
  assert.equal(shadow.getElementById('plan-custom-form')?.getAttribute('data-in-settings'), 'true');

  // 3. 验证打开设置面板与 4 分页切换
  api.openSettings('appearance');
  assert.equal(settingsPanel.hidden, false, 'openSettings 应打开 #panel-settings');
  assert.equal(shadow.getElementById('settings-tab-btn-appearance')?.getAttribute('aria-selected'), 'true');
  assert.equal(shadow.getElementById('settings-pane-appearance')?.hidden, false);
  assert.equal(shadow.getElementById('settings-pane-terminal')?.hidden, true);

  api.openSettings('subscription');
  assert.equal(shadow.getElementById('settings-tab-btn-subscription')?.getAttribute('aria-selected'), 'true');
  assert.equal(shadow.getElementById('settings-pane-subscription')?.hidden, false);

  // 4. 验证在设置面板内修改增强开关与胶囊语言会同步 localStorage 并广播 ag-suite-prefs-changed
  let lastEventDetail = null;
  env.win.addEventListener('ag-suite-prefs-changed', ev => { lastEventDetail = ev.detail; });

  const autoAcceptChk = shadow.getElementById('set-auto-accept');
  assert.ok(autoAcceptChk, '设置面板中应包含 #set-auto-accept 开关');
  autoAcceptChk.checked = true;
  autoAcceptChk.dispatchEvent({ type: 'change' });
  assert.equal(env.localStorage.getItem('ag_suite_auto_accept'), 'true');
  assert.equal(lastEventDetail?.autoAccept, true);

  const langSel = shadow.getElementById('set-ui-language-select');
  assert.ok(langSel, '设置面板中应包含 #set-ui-language-select 语言下拉框');
  langSel.value = 'en';
  langSel.dispatchEvent({ type: 'change' });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(env.localStorage.getItem('ag_suite_locale'), 'en');
  assert.equal(env.localStorage.getItem('antigravityHansLang'), 'en');
  assert.equal(env.localStorage.getItem('__agy_ctx_lang__'), 'en');
  assert.equal(lastEventDetail?.locale, 'en');
  assert.equal(lastEventDetail?.capsuleLang, 'en');

  const engLblChk = shadow.getElementById('set-english-labels');
  assert.ok(engLblChk, '设置面板中应包含 #set-english-labels 选项');
  engLblChk.checked = true;
  engLblChk.dispatchEvent({ type: 'change' });
  assert.equal(env.localStorage.getItem('antigravityHansEnglishLabels'), '1');
  assert.equal(lastEventDetail?.englishLabels, true);

  // 5. 验证设置面板的终端选择、文件选择与测试打开按钮
  shadow.getElementById('btn-pick-term-path')?.click();
  await new Promise(r => setTimeout(r, 15));
  assert.equal(api.getTerminalSettings().terminalApp, 'custom');
  assert.equal(api.getTerminalSettings().customTerminalPath, '/Applications/WezTerm.app');

  shadow.getElementById('btn-test-terminal')?.click();
  await new Promise(r => setTimeout(r, 15));
  assert.ok(env.cliRequests.some(req => req.testOnly === true && req.terminalApp === 'custom'));

  // 6. 验证 Enhancer 与 Bottom Capsule 已去除内联配置项
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;
  assert.equal(env.doc.getElementById('ag-qcap-autoaccept'), null, '快捷胶囊栏不应再保留 ag-qcap-autoaccept 开关');
  assert.equal(enhancer.getAutoAccept(), true, 'enhancer 应能从统一存储/事件同步 autoAccept 状态');

  enhancer.setGhostSuggest(false);
  assert.equal(enhancer.getGhostSuggest(), false);

  vm.runInContext(CAPSULE_SRC, env.sandbox);
  assert.ok(!CAPSULE_SRC.includes('点击切换: English'), '底部胶囊浮层提示不得残留内联语言切换指引');
  assert.ok(typeof env.win.__AGY_CTX_CAPSULE_DISPOSE__ === 'function', '底部胶囊应导出 dispose 清理器');

  env.win.__AGY_CTX_CAPSULE_DISPOSE__();
  api.dispose?.();
  enhancer.dispose?.();
});

// =========================================================================
// 需求 4b: 终端程序配置跨平台探测、启动器 dryRun、Collector 自动读取与 Preload 校验
// =========================================================================
test('需求 4b: macOS 与 Windows 主流终端探测、dryRun 启动参数构造、Collector 透传与 Preload 校验', async () => {
  // 1. Preload 语法校验与新增 API 暴露
  const preloadCode = modularInstaller.generateMeterPreloadCode();
  assert.equal(modularInstaller.validateSyntax(preloadCode), true, 'preload 脚本必须通过语法校验');
  assert.ok(preloadCode.includes('listTerminals') && preloadCode.includes('pickTerminalPath'),
    'preload contextMeterAPI 必须暴露 listTerminals 和 pickTerminalPath');

  // 2. macOS 终端探测（iTerm2, Ghostty, Warp, Rex, Terminal, Custom）
  const macInstalledPaths = new Set([
    '/System/Applications/Utilities/Terminal.app',
    '/Applications/iTerm.app',
    '/Applications/Ghostty.app',
    '/Applications/Warp.app',
    '/Applications/Rex Beta.app'
  ]);
  const macList = terminals.detectAvailableTerminals({
    platform: 'darwin',
    existsSync: p => macInstalledPaths.has(p),
    customPath: '/usr/local/bin/my-term'
  });
  assert.equal(macList.ok, true);
  assert.equal(macList.platform, 'darwin');
  const byId = Object.fromEntries(macList.terminals.map(t => [t.id, t]));
  for (const reqId of ['auto', 'terminal', 'iterm2', 'ghostty', 'warp', 'rex', 'custom']) {
    assert.ok(byId[reqId], `macOS 终端列表必须包含 ${reqId}`);
  }
  assert.equal(byId.iterm2.installed, true);
  assert.equal(byId.ghostty.installed, true);
  assert.equal(byId.warp.installed, true);
  assert.equal(byId.rex.installed, true);
  assert.equal(byId.rex.executablePath, '/Applications/Rex Beta.app');

  // 3. Windows 终端探测（PowerShell, CMD, Git Bash, WSL, Warp, Windows Terminal, Custom）
  const winInstalledPaths = new Set([
    'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
    'c:\\windows\\system32\\cmd.exe',
    'c:\\program files\\git\\git-bash.exe',
    'c:\\windows\\system32\\wsl.exe',
    'c:\\users\\demo\\appdata\\local\\programs\\warp\\warp.exe'
  ]);
  const winList = terminals.detectAvailableTerminals({
    platform: 'win32',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local'
    },
    existsSync: p => winInstalledPaths.has(String(p).toLowerCase())
  });
  const winById = Object.fromEntries(winList.terminals.map(t => [t.id, t]));
  for (const reqId of ['auto', 'powershell', 'cmd', 'gitbash', 'wsl', 'warp', 'custom']) {
    assert.ok(winById[reqId], `Windows 终端列表必须包含 ${reqId}`);
  }
  assert.equal(winById.powershell.installed, true);
  assert.equal(winById.cmd.installed, true);
  assert.equal(winById.gitbash.installed, true);
  assert.equal(winById.wsl.installed, true);
  assert.equal(winById.warp.installed, true);

  // 4. dryRun & testOnly 启动指令构建验证
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-term-test-'));
  try {
    const cliInfo = { command: 'claude', cliArgs: ['--dangerously-skip-permissions'], cwd: tempHome };

    const macRex = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'rex',
      cwd: tempHome,
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      testOnly: true,
      existsSync: p => p === '/Applications/Rex Beta.app' || p === tempHome
    });
    assert.equal(macRex.ok, true);
    assert.equal(macRex.terminalId, 'rex');
    assert.equal(macRex.spawnSpec.file, 'osascript');
    assert.ok(macRex.spawnSpec.args.join('\n').includes('com.superlogical.rex'), 'Rex 启动脚本应通过 com.superlogical.rex 驱动');

    const macIterm = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'iterm2',
      cwd: tempHome,
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => p === '/Applications/iTerm.app' || p === tempHome
    });
    assert.equal(macIterm.ok, true);
    assert.equal(macIterm.spawnSpec.file, 'osascript');
    assert.ok(macIterm.spawnSpec.args.join('\n').includes('iTerm'), 'iTerm2 启动脚本应调用 iTerm');

    const macGhostty = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'ghostty',
      cwd: tempHome,
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => p === '/Applications/Ghostty.app' || p === '/Applications/Ghostty.app/Contents/MacOS/ghostty' || p === tempHome
    });
    assert.equal(macGhostty.ok, true);
    assert.ok(macGhostty.spawnSpec.file.includes('ghostty') || macGhostty.spawnSpec.file.endsWith('open'));

    const macWarp = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'warp',
      cwd: tempHome,
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => p === '/Applications/Warp.app' || p === tempHome
    });
    assert.equal(macWarp.ok, true);
    assert.ok(macWarp.spawnSpec.file.endsWith('open'));
    assert.ok(macWarp.spawnSpec.args.includes('warp://launch/antigravity_cli'));
    assert.ok(macWarp.extraArtifacts?.configPath?.endsWith('antigravity_cli.yaml'));

    const winPs = terminals.launchInConfiguredTerminal({
      platform: 'win32',
      terminalApp: 'powershell',
      cwd: 'C:\\proj',
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' || p === 'C:\\proj'
    });
    assert.equal(winPs.ok, true);
    assert.equal(winPs.terminalId, 'powershell');
    assert.ok(winPs.spawnSpec.file.toLowerCase().includes('powershell'));

    const winEnv = {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local'
    };
    const winCmd = terminals.launchInConfiguredTerminal({
      platform: 'win32',
      terminalApp: 'cmd',
      cwd: 'C:\\proj',
      cliInfo,
      env: winEnv,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => winInstalledPaths.has(String(p).toLowerCase()) || p === 'C:\\proj'
    });
    assert.equal(winCmd.ok, true);
    assert.equal(winCmd.terminalId, 'cmd');

    const winGitBash = terminals.launchInConfiguredTerminal({
      platform: 'win32',
      terminalApp: 'gitbash',
      cwd: 'C:\\proj',
      cliInfo,
      env: winEnv,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => winInstalledPaths.has(String(p).toLowerCase()) || p === 'C:\\proj'
    });
    assert.equal(winGitBash.ok, true);
    assert.equal(winGitBash.terminalId, 'gitbash');

    const winWsl = terminals.launchInConfiguredTerminal({
      platform: 'win32',
      terminalApp: 'wsl',
      cwd: 'C:\\proj',
      cliInfo,
      env: winEnv,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => winInstalledPaths.has(String(p).toLowerCase()) || p === 'C:\\proj'
    });
    assert.equal(winWsl.ok, true);
    assert.equal(winWsl.terminalId, 'wsl');

    const winWarp = terminals.launchInConfiguredTerminal({
      platform: 'win32',
      terminalApp: 'warp',
      cwd: 'C:\\proj',
      cliInfo,
      env: winEnv,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => winInstalledPaths.has(String(p).toLowerCase()) || p === 'C:\\proj'
    });
    assert.equal(winWarp.ok, true);
    assert.equal(winWarp.terminalId, 'warp');

    const winCustomBad = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'custom',
      customTerminalPath: '/no/such/terminal/bin',
      cwd: tempHome,
      cliInfo,
      homedir: tempHome,
      dryRun: true,
      existsSync: p => p === tempHome
    });
    assert.equal(winCustomBad.ok, false, '自定义终端路径不存在时应返回明确错误');

    // 5. Collector 保存配置与自动注入 uiPreferences.terminalApp
    const agDir = path.join(tempHome, '.antigravity-agent');
    fs.mkdirSync(agDir, { recursive: true });
    collector.savePluginSettings({
      country: 'TW',
      subscriptionRegion: 'TW',
      currency: 'CNY',
      uiPreferences: {
        terminalApp: 'ghostty',
        customTerminalPath: '/Applications/Ghostty.app'
      }
    }, { agDir });

    const saved = collector.getPluginSettings({ agDir });
    assert.equal(saved.uiPreferences.terminalApp, 'ghostty');

    // 触发渲染器点击 CLI 启动并校验传入终端设置
    const env = createDomEnv({ savedTerminalApp: 'rex', savedCustomTermPath: '/Applications/Rex Beta.app' });
    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    await new Promise(r => setTimeout(r, 10));
    api.setTerminalSettings('ghostty', '/Applications/Ghostty.app');
    const curTerm = api.getTerminalSettings();
    assert.equal(curTerm.terminalApp, 'ghostty');
    assert.equal(curTerm.customTerminalPath, '/Applications/Ghostty.app');
    await api.launchCli({ workspacePath: tempHome });
    assert.equal(env.cliRequests.length, 1);
    assert.equal(env.cliRequests[0].terminalApp, 'ghostty');
    assert.equal(env.cliRequests[0].customTerminalPath, '/Applications/Ghostty.app');

    api.dispose?.();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});


// =========================================================================
// 需求 5a: CLI 启动支持免审核 (--dangerously-skip-permissions) 与默认模型 / 不选模型
// =========================================================================
test('需求 5a: CLI 启动支持开启免审核参数与配置默认模型/不选择模型', async () => {
  const launcher = require('./meter-cli-launcher');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-opts-'));
  try {
    const fakeCli = path.join(tmpDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(fakeCli, '#!/bin/sh\necho ok\n', 'utf8');

    // 1. 不选择模型 + 开启免审核：绝不传 --model，必须传入 --dangerously-skip-permissions
    const noModelSkip = await launcher.launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      noModel: true,
      model: '',
      skipPermissions: true,
      dryRun: true
    });
    assert.equal(noModelSkip.ok, true);
    assert.equal(noModelSkip.model, null);
    assert.equal(noModelSkip.skipPermissions, true);
    assert.deepEqual(noModelSkip.args, ['--dangerously-skip-permissions']);

    // 2. 不选择模型 + 不开启免审核：args 为空
    const bareCli = await launcher.launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      model: '',
      skipPermissions: false,
      dryRun: true
    });
    assert.equal(bareCli.ok, true);
    assert.equal(bareCli.model, null);
    assert.deepEqual(bareCli.args, []);

    // 3. 指定模型 + 开启免审核：传入 --model <id> 与 --dangerously-skip-permissions
    const modelAndSkip = await launcher.launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      model: 'claude-opus-5-5-high',
      skipPermissions: true,
      dryRun: true
    });
    assert.equal(modelAndSkip.ok, true);
    assert.equal(modelAndSkip.model, 'claude-opus-5-5-high');
    assert.deepEqual(modelAndSkip.args, ['--model', 'claude-opus-5-5-high', '--dangerously-skip-permissions']);

    // 4. Collector 从保存的 uiPreferences 自动读取 cliSkipPermissions 与 cliDefaultModel
    const agDir = path.join(tmpDir, '.antigravity-agent');
    fs.mkdirSync(agDir, { recursive: true });
    collector.savePluginSettings({
      country: 'TW',
      subscriptionRegion: 'TW',
      currency: 'CNY',
      uiPreferences: {
        terminalApp: 'auto',
        cliSkipPermissions: true,
        cliDefaultModel: ''
      }
    }, { agDir });

    const fromCollector = await collector.launchCliSession({
      cliPath: fakeCli,
      cwd: tmpDir,
      agDir,
      dryRun: true
    });
    assert.equal(fromCollector.ok, true);
    assert.equal(fromCollector.model, null);
    assert.equal(fromCollector.skipPermissions, true);
    assert.deepEqual(fromCollector.args, ['--dangerously-skip-permissions']);

    // 5. 渲染器统一设置面板勾选免审核与切换模型联动 launchCli
    const env = createDomEnv();
    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    const shadow = env.getShadow();

    const chkSkip = shadow.getElementById('set-cli-skip-permissions');
    const selModel = shadow.getElementById('set-cli-model-select');
    const customRow = shadow.getElementById('cli-custom-model-row');
    const customInp = shadow.getElementById('input-cli-custom-model');
    const btnSaveCustomModel = shadow.getElementById('btn-save-cli-model');
    assert.ok(chkSkip && selModel && customRow && customInp && btnSaveCustomModel, 'CLI 模型与免审核控件应全部挂载在设置面板');

    chkSkip.checked = true;
    chkSkip.dispatchEvent({ type: 'change' });
    selModel.value = 'claude-opus-5-5-high';
    selModel.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 10));

    assert.deepEqual(JSON.parse(JSON.stringify(api.getCliSettings())), {
      skipPermissions: true,
      model: 'claude-opus-5-5-high',
      noModel: false
    });

    await api.launchCli({ workspacePath: tmpDir });
    const req1 = env.cliRequests.at(-1);
    assert.equal(req1.skipPermissions, true);
    assert.equal(req1.model, 'claude-opus-5-5-high');
    assert.equal(req1.noModel, false);

    // 切回自定义模型并保存，再切回不选模型
    selModel.value = '__custom__';
    selModel.dispatchEvent({ type: 'change' });
    assert.equal(customRow.style.display, 'flex');
    customInp.value = 'gemini-4-hydrogen-xhigh';
    btnSaveCustomModel.click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(api.getCliSettings().model, 'gemini-4-hydrogen-xhigh');

    selModel.value = '';
    selModel.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(api.getCliSettings().noModel, true);
    assert.equal(api.getCliSettings().model, '');

    await api.launchCli({ workspacePath: tmpDir });
    const req2 = env.cliRequests.at(-1);
    assert.equal(req2.skipPermissions, true);
    assert.equal(req2.noModel, true);
    assert.equal(req2.model, '');

    // 6. 热注入桥接共存优先级：__AGContextMeterLive 存在时优先走实时 HTTP 桥接，避免误落入旧版 Electron IPC；不可达时回退 IPC
    const prevFetch = env.sandbox.fetch;
    const prevLaunchIpc = env.win.contextMeterAPI.launchCli;
    const liveCalls = [];
    const ipcFallbackCalls = [];
    let liveBridgeUp = true;
    env.win.__AGContextMeterLive = { port: 59876, token: 't1' };
    env.win.contextMeterAPI.launchCli = async (opts) => {
      ipcFallbackCalls.push(opts);
      return { ok: true, from: 'ipc', cwd: tmpDir };
    };
    env.sandbox.fetch = async (url, init = {}) => {
      if (String(url).startsWith('http://127.0.0.1:59876/')) {
        if (!liveBridgeUp) throw new Error('ECONNREFUSED');
        const body = JSON.parse(init.body || '{}');
        liveCalls.push({ url, headers: init.headers, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, from: 'live-host', cwd: tmpDir })
        };
      }
      return prevFetch(url, init);
    };

    const viaLive = await api.launchCli({ workspacePath: tmpDir });
    assert.equal(viaLive.ok, true);
    assert.equal(viaLive.from, 'live-host');
    assert.equal(liveCalls.length, 1);
    assert.equal(ipcFallbackCalls.length, 0, '存在可用 __AGContextMeterLive 时不得误走旧版 IPC');
    assert.equal(liveCalls[0].url, 'http://127.0.0.1:59876/launch-cli');
    assert.equal(liveCalls[0].headers['X-AG-Context-Token'], 't1');
    assert.equal(liveCalls[0].body.skipPermissions, true);
    assert.equal(liveCalls[0].body.model, '');
    assert.equal(liveCalls[0].body.noModel, true);

    liveBridgeUp = false;
    const viaFallback = await api.launchCli({ workspacePath: tmpDir });
    assert.equal(viaFallback.ok, true);
    assert.equal(viaFallback.from, 'ipc');
    assert.equal(ipcFallbackCalls.length, 1, 'live-host 不可达时应自动回退 Electron IPC');

    delete env.win.__AGContextMeterLive;
    env.sandbox.fetch = prevFetch;
    env.win.contextMeterAPI.launchCli = prevLaunchIpc;

    api.dispose?.();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 5b: 输入框增强胶囊上下文窗口上限按模型实际上限动态显示
// =========================================================================
test('需求 5b: pulse-capsule-overlay 按 GetAvailableModels 与会话实测上限动态解析，切模型实时刷新分母', async () => {
  const env = createDomEnv();
  env.sandbox.location.href = 'https://127.0.0.1:12345/';
  env.win.location = env.sandbox.location;
  vm.runInContext(CAPSULE_SRC, env.sandbox);

  const capsApi = env.win.__AGY_CTX_CAPSULE_API__;
  assert.ok(capsApi && typeof capsApi.getContextLimitForModel === 'function', '应导出 __AGY_CTX_CAPSULE_API__');

  // 1. 离线未拉取到服务端配置时，按模型家族区分真实上限而非一律 256k
  capsApi.clearCaches();
  assert.equal(capsApi.getContextLimitForModel('claude-opus-5-5-high', 'Claude Opus 5.5 (High)'), 1000000);
  assert.equal(capsApi.getContextLimitForModel('gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'), 1048576);
  assert.equal(capsApi.getContextLimitForModel('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'), 131072);

  // 2. 注入 GetAvailableModels 与会话实测预算 (512000)
  capsApi.ingestAvailableModels({
    models: {
      MODEL_PLACEHOLDER_M402: { model: 'MODEL_PLACEHOLDER_M402', displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000 },
      MODEL_PLACEHOLDER_M525: { model: 'MODEL_PLACEHOLDER_M525', displayName: 'Gemini 4 Hydrogen (High)', maxTokens: 1048576 },
      MODEL_OPENAI_GPT_OSS_120B_MEDIUM: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', displayName: 'GPT-OSS 120B (Medium)', maxTokens: 131072 },
      'custom-model-2m': { model: 'custom-model-2m', displayName: 'Custom Model 2M', maxTokens: 2097152 }
    }
  });
  capsApi.ingestGeneratorMetadata([
    {
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M667',
        modelDisplayName: 'Orchestrator (Carbon)',
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    }
  ], 'cid-live-1');

  // 当选中模型仍为当前会话的 M667 时，采用会话实测上限 512000
  assert.equal(
    capsApi.getContextLimitForModel('MODEL_PLACEHOLDER_M667', 'Orchestrator (Carbon)', {
      runtimeBudget: 512000,
      runtimeModelKey: 'model_placeholder_m667'
    }),
    512000
  );

  // 当用户在输入框切换为另一个模型（如 Custom 2M 或 Claude 5.5）时，绝不沿用上一轮 512k
  assert.equal(
    capsApi.getContextLimitForModel('custom-model-2m', 'Custom Model 2M', {
      runtimeBudget: 512000,
      runtimeModelKey: 'model_placeholder_m667'
    }),
    2097152
  );
  assert.equal(
    capsApi.getContextLimitForModel('MODEL_PLACEHOLDER_M402', 'Claude Opus 5.5 (High)', {
      runtimeBudget: 512000,
      runtimeModelKey: 'model_placeholder_m667'
    }),
    1000000
  );
  assert.equal(capsApi.resolveModelDisplayName('MODEL_PLACEHOLDER_M667', ''), 'Orchestrator (Carbon)');

  env.win.__AGY_CTX_CAPSULE_DISPOSE__();
  assert.equal(env.win.__AGY_CTX_CAPSULE_API__, undefined);
});

// =========================================================================
// 需求 5c: 本地权限翻译 “极速” 修改为 “无限”（不影响测速徽章 “极速”）
// =========================================================================
test('需求 5c: 本地权限 Turbo 译文统一为 “无限” / “无限模式”，保留速率徽章 “极速”', () => {
  const hansSrc = fs.readFileSync(path.join(ROOT, 'antigravity-hans-overlay.js'), 'utf8');
  assert.ok(hansSrc.includes('["Turbo", "无限"]'), 'antigravity-hans-overlay 必须将 Turbo 译为 无限');
  assert.ok(hansSrc.includes('["Turbo mode", "无限模式"]'), 'antigravity-hans-overlay 必须将 Turbo mode 译为 无限模式');
  assert.ok(hansSrc.includes('智能体权限预设选择器，当前：无限'), '权限 aria 提示必须译为 当前：无限');
  assert.ok(!hansSrc.includes('["Turbo", "极速"]') && !hansSrc.includes('["Turbo mode", "极速模式"]'),
    'antigravity-hans-overlay 不得残留 Turbo->极速 映射');

  for (const rel of ['i18n/zh-CN.json', 'src/i18n/zh-CN.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(data.exact['Turbo'], '无限', `${rel} exact["Turbo"] 必须为 无限`);
    assert.equal(data.exact['Turbo mode'], '无限模式', `${rel} exact["Turbo mode"] 必须为 无限模式`);
    assert.equal(data.exact['Agent permissions preset selector, current: Turbo'], '智能体权限预设选择器，当前：无限');
    assert.match(
      data.exact["When Turbo mode is on, the agent will automatically capture screenshots in the Browser without explicit user input. You can toggle this setting in Antigravity's settings."] || '',
      /开启无限模式 \(Turbo\)/
    );
  }

  // 验证模型列表徽章 "New" 统一译为 "新增"，同时保留 "+ New" / "New Conversation" 等新建词条
  assert.ok(hansSrc.includes('["New", "新增"]'), 'antigravity-hans-overlay 必须将 New 译为 新增');
  for (const rel of ['i18n/zh-CN.json', 'src/i18n/zh-CN.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(data.exact['New'], '新增', `${rel} exact["New"] 必须为 新增`);
    assert.equal(data.exact['+ New'], '+ 新建', `${rel} exact["+ New"] 应保持 + 新建`);
    assert.equal(data.exact['New Conversation'], '新建会话', `${rel} exact["New Conversation"] 应保持 新建会话`);
  }

  // 验证生成速度 pill 依然使用 >= 80 tok/s 的 '极速'
  assert.ok(RENDERER_SRC.includes("spBadge.textContent = '极速'"), '生成速度 pill 文案应保持原样');
});

// =========================================================================
// 需求 5d: 中英文切换迁入设置面板下拉框、移除独立圆圈按钮、可扩展多语言
// =========================================================================
test('需求 5d: 移除独立汉化悬浮图标，设置下拉框同步切换 antigravity-hans 与扩展语言包', () => {
  const hansSrc = fs.readFileSync(path.join(ROOT, 'antigravity-hans-overlay.js'), 'utf8');
  const env = createDomEnv();
  env.sandbox.location.pathname = '/workbench.html';
  env.win.location = env.sandbox.location;
  env.win.top = env.win;

  // 注入一个遗留的浮动按钮 + 待翻译文本节点，模拟升级清理场景
  const legacyBtn = env.doc.createElement('button');
  legacyBtn.setAttribute('data-agy-hans-ui', '');
  env.doc.body.appendChild(legacyBtn);

  const labelEl = env.doc.createElement('span');
  const textNode = {
    nodeType: 3,
    nodeValue: 'Turbo',
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    parentElement: labelEl
  };
  labelEl.childNodes.push(textNode);
  const agentPane = env.doc.querySelector('.antigravity-agent-side-panel');
  assert.ok(agentPane, '模拟 DOM 应包含 .antigravity-agent-side-panel');
  agentPane.appendChild(labelEl);

  const staleNewEl = env.doc.createElement('span');
  const staleNewNode = {
    nodeType: 3,
    nodeValue: '新建',
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    parentElement: staleNewEl
  };
  staleNewNode.__zh_patched = true;
  staleNewEl.childNodes.push(staleNewNode);
  agentPane.appendChild(staleNewEl);
  env.win.__antigravityZhOriginals = {
    texts: new WeakMap([[staleNewNode, { orig: 'New', zh: '新建' }]]),
    attrs: new WeakMap()
  };

  env.sandbox.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
  env.sandbox.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 };
  env.doc.createTreeWalker = (rootNode, whatToShow) => {
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      const children = n.childNodes || n.children || [];
      for (const ch of children) {
        if ((ch.nodeType === 1 && (whatToShow & 1)) || (ch.nodeType === 3 && (whatToShow & 4))) {
          flat.push(ch);
        }
        walk(ch);
      }
    };
    walk(rootNode);
    let idx = 0;
    return { nextNode: () => (idx < flat.length ? flat[idx++] : null) };
  };
  env.doc.documentElement.lang = 'en';

  vm.runInContext(hansSrc, env.sandbox);

  assert.equal(env.doc.querySelectorAll('[data-agy-hans-ui]').length, 0, '不得渲染或保留独立中英文悬浮圆圈图标');
  assert.equal(env.win.__antigravityZhGetLang?.(), 'zh');
  assert.equal(textNode.nodeValue, '无限', '初始化中文状态应将 Turbo 翻译为 无限');
  assert.equal(staleNewNode.nodeValue, '新增', '新版脚本加载应升级旧实例遗留的 新建 -> 新增 译文');

  // 通过统一设置面板加载并切换到英文 + 注册扩展语言
  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const shadow = env.getShadow();
  const settingsPanel = shadow.getElementById('panel-settings');
  const termTabBtn = shadow.getElementById('settings-tab-btn-terminal');
  assert.ok(settingsPanel && termTabBtn, '应渲染统一设置面板与分页按钮');

  const getTokenCardPairs = () => shadow.querySelectorAll('#token-stat-cards .t-card-lbl')
    .map(lbl => lbl.querySelectorAll('span').map(sp => sp.textContent.trim()));
  assert.deepEqual(getTokenCardPairs(), [
    ['累计处理 Token', '总计'],
    ['今日使用', '今日'],
    ['本月使用', '本月'],
    ['年度使用', '本年']
  ], 'zh-CN 下 Token 概览卡片右上角标签应显示中文');

  api.setLocale('en');
  assert.equal(env.win.__antigravityZhGetLang?.(), 'en');
  assert.equal(env.doc.documentElement.getAttribute('data-ag-hans-lang'), 'en');
  assert.equal(textNode.nodeValue, 'Turbo', '设置面板切换到 English 应立即还原原文');
  assert.ok(settingsPanel.querySelector('.panel-title')?.textContent?.includes('Antigravity Suite Settings'), '#panel-settings 标题应实时切换为英文');
  assert.equal(termTabBtn.textContent.trim(), '🖥️ Terminal & General', '分页按钮应实时切换为英文');
  assert.deepEqual(getTokenCardPairs(), [
    ['Total Processed', 'Total'],
    ["Today's Usage", 'Today'],
    ['This Month', 'Month'],
    ['This Year', 'Year']
  ], 'English 模式下 Token 概览卡片标签与右上角标记应实时切换为英文');

  api.setLocale('zh-CN');
  assert.equal(env.win.__antigravityZhGetLang?.(), 'zh');
  assert.equal(env.doc.documentElement.getAttribute('data-ag-hans-lang'), 'zh');
  assert.equal(textNode.nodeValue, '无限', '切回 zh-CN 应重新应用中文译文');
  assert.ok(settingsPanel.querySelector('.panel-title')?.textContent?.includes('Antigravity Suite 统一设置'), '#panel-settings 标题应实时恢复为中文');
  assert.equal(termTabBtn.textContent.trim(), '🖥️ 终端与通用', '分页按钮应实时恢复为中文');
  assert.deepEqual(getTokenCardPairs(), [
    ['累计处理 Token', '总计'],
    ['今日使用', '今日'],
    ['本月使用', '本月'],
    ['年度使用', '本年']
  ], '切回 zh-CN 应还原 Token 概览卡片中文标签');

  // 多语言注册扩展能力校验
  assert.equal(api.registerLocale({ code: 'ja', label: '日本語 · Japanese', capsuleLang: 'en', hansCode: 'en' }), true);
  assert.ok(api.getSupportedLocales().some(l => l.code === 'ja'));
  api.setLocale('ja');
  assert.equal(api.getLocale(), 'ja');
  assert.equal(env.localStorage.getItem('ag_suite_locale'), 'ja');
  assert.equal(env.win.__antigravityZhGetLang?.(), 'en', '未内置该语种词典时回退原文并保持胶囊语言状态');

  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'i18n/i18n-runtime.js'), 'utf8');
  assert.ok(runtimeSrc.includes("localStorage.getItem('ag_suite_locale')"), 'i18n/i18n-runtime.js 应检查 ag_suite_locale 语言门控');

  env.win.__antigravityZhPatchCleanup?.();
  api.dispose?.();
});

// =========================================================================
// 需求 5e: 面板与气泡浮层置于最顶层，不被宿主 z-50 菜单或底部导航遮挡
// =========================================================================
test('需求 5e: 打开面板/浮层时提升全部定位祖先堆叠至 2147483646 且高于 z-50 与导航条，关闭后复原', () => {
  const env = createDomEnv();

  // 构造模拟宿主嵌套层：div.relative.z-0 -> div.topbar.z-50 -> titlebar-right
  const z0Wrap = env.doc.createElement('div');
  z0Wrap.className = 'relative z-0';
  const topbarZ50 = env.doc.createElement('div');
  topbarZ50.className = 'absolute right-0 z-50';
  const rightSlot = env.doc.createElement('div');
  rightSlot.className = 'titlebar-right';
  topbarZ50.appendChild(rightSlot);
  z0Wrap.appendChild(topbarZ50);
  env.doc.body.appendChild(z0Wrap);

  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const host = env.getHost();
  rightSlot.appendChild(host);

  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;

  // CSS 层级基线断言
  assert.ok(RENDERER_SRC.includes(':host([data-elevated="true"])') && RENDERER_SRC.includes('z-index:2147483646 !important'),
    'host 提升态必须在 CSS 中强制置顶至 2147483646');
  assert.ok(RENDERER_SRC.includes('z-index:2147483645'), '.ag-panel 与 #overflow-menu 应使用 2147483645');
  assert.ok(ENHANCER_SRC.includes('z-index: 8;'), '右下角对话导航条 z-index 必须低于 2147483645 且低于所有弹窗');
  assert.ok(ENHANCER_SRC.includes('#ag-quota-popover') && ENHANCER_SRC.includes('z-index: 2147483645;'),
    '配额浮窗应使用 2147483645');

  // 打开统一设置面板时提升 host 与所有祖先层叠上下文
  api.openSettings('terminal');
  assert.equal(host.getAttribute('data-elevated'), 'true');
  assert.equal(topbarZ50.style.zIndex, '2147483646');
  assert.equal(z0Wrap.style.zIndex, '2147483646');

  // 当主面板仍开启时误调用 setHostElevated(false) 不应取消置顶
  api.setHostElevated(false);
  assert.equal(host.getAttribute('data-elevated'), 'true');

  // 关闭设置面板后应复原宿主祖先 z-index
  env.getShadow().getElementById('close-settings')?.click();
  assert.equal(host.getAttribute('data-elevated'), null);
  assert.equal(topbarZ50.style.zIndex, '');
  assert.equal(z0Wrap.style.zIndex, '');

  // 打开配额浮窗时也应同步置顶，关闭时复原
  enhancer.toggleQuotaPopover(true);
  assert.equal(host.getAttribute('data-elevated'), 'true');
  enhancer.toggleQuotaPopover(false);
  assert.equal(host.getAttribute('data-elevated'), null);

  api.dispose?.();
  enhancer.dispose?.();
});

// =========================================================================
// 需求 6: 一码三用多通道融合二维码与配对链接（Wi-Fi / Tailscale / Bonjour）
// =========================================================================
test('需求 6: #badge-remote 与 #ag-remote-popover 挂载、一码三用融合链接与通道切换验证', async () => {
  const os = require('node:os');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-test-'));
  const prevAppData = process.env.APPDATA;
  const prevMeterStateDir = process.env.AG_METER_STATE_DIR;
  const prevContextStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    process.env.AG_CONTEXT_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      buildRemoteInfo,
      decodeEndpointsParam,
      encodeQrCodeMatrix,
      buildFusedPairingUrl,
      buildMobileAppHtml,
      readJsonBody,
      createRemoteHttpHandler,
      recordPairedDeviceAccess,
      getPairedDevicesSummary
    } = require('./mobile-remote.js');
    const info = buildRemoteInfo({ resetToken: true });
    assert.ok(info.port > 0, 'mobile-remote 应返回有效端口');
    assert.equal(info.primaryUrl, info.fusedUrl, 'primaryUrl 应等于融合配对链接 fusedUrl');
    assert.ok(typeof info.primaryUrl === 'string' && info.primaryUrl.includes('?token='), '应生成携带配对 token 的 URL');
    assert.ok(info.primaryUrl.includes('&address=') && info.primaryUrl.includes('&name=') && info.primaryUrl.includes('&hosts=') && info.primaryUrl.includes('&endpoints='),
      'fusedUrl 应携带 address、name、hosts 与 base64url endpoints');
    assert.ok(typeof info.qrSvg === 'string' && info.qrSvg.startsWith('<svg'), '应生成合法 <svg 二维码');

    const parsedFused = new URL(info.fusedUrl);
    const decodedEps = decodeEndpointsParam(parsedFused.searchParams.get('endpoints'));
    assert.ok(Array.isArray(decodedEps) && decodedEps.length >= 1, 'decodeEndpointsParam 应解析出至少 1 个有效端点');
    for (const ep of decodedEps) {
      assert.match(ep.url, /^https?:\/\//);
      assert.ok(typeof ep.kind === 'string' && Number.isFinite(ep.priority));
    }

    // 验证 550+ 字节融合 URL 可被扩展至 v11~v20 的 QR 生成器正常编码
    const longSampleEps = [
      { url: 'http://10.0.1.25:18765', kind: 'lan', priority: 0 },
      { url: 'http://192.168.64.1:18765', kind: 'lan', priority: 50 },
      { url: 'http://100.64.0.2:18765', kind: 'tailscale', priority: 100 },
      { url: 'http://dev-mac.tailnet-demo.ts.net:18765', kind: 'tailscale', priority: 150 },
      { url: 'http://dev-macbook-pro.local:18765', kind: 'bonjour', priority: 200 }
    ];
    const longFusedUrl = buildFusedPairingUrl({
      entryHost: '100.64.0.2',
      port: 18765,
      token: 'abcdef0123456789abcdef0123456789abcdef0123456789',
      name: 'dev-mac',
      hosts: ['10.0.1.25', '192.168.64.1', '100.64.0.2', 'dev-mac.tailnet-demo.ts.net', 'dev-macbook-pro.local'],
      endpoints: longSampleEps
    });
    assert.ok(Buffer.byteLength(longFusedUrl, 'utf8') > 550, '多端点融合配对 URL 长度应大于 550 字节');
    const longMatrix = encodeQrCodeMatrix(longFusedUrl);
    assert.ok(Array.isArray(longMatrix) && longMatrix.length >= 61, '550+ 字节 URL 应成功编码为 v11+ QR 矩阵');

    const remoteSrc = fs.readFileSync(path.join(ROOT, 'mobile-remote.js'), 'utf8');
    assert.ok(remoteSrc.includes("label: '⚡ 无限 (Turbo)'"), 'mobile-remote 权限元数据应使用 无限');

    const mockLanUrl = buildFusedPairingUrl({
      entryHost: '192.168.1.2',
      port: 18765,
      token: 'tok-test',
      name: 'dev-mac',
      hosts: ['192.168.1.2', 'dev-mac.tailnet-demo.ts.net', 'dev-macbook-pro.local'],
      endpoints: [
        { url: 'http://192.168.1.2:18765', kind: 'lan', priority: 0 },
        { url: 'http://dev-mac.tailnet-demo.ts.net:18765', kind: 'tailscale', priority: 150 },
        { url: 'http://dev-macbook-pro.local:18765', kind: 'bonjour', priority: 200 }
      ]
    });
    const mockTsUrl = buildFusedPairingUrl({
      entryHost: '100.64.0.2',
      port: 18765,
      token: 'tok-test',
      name: 'dev-mac',
      hosts: ['192.168.1.2', '100.64.0.2', 'dev-mac.tailnet-demo.ts.net', 'dev-macbook-pro.local'],
      endpoints: [
        { url: 'http://192.168.1.2:18765', kind: 'lan', priority: 0 },
        { url: 'http://100.64.0.2:18765', kind: 'tailscale', priority: 100 },
        { url: 'http://dev-macbook-pro.local:18765', kind: 'bonjour', priority: 200 }
      ]
    });
    const mockBonjourUrl = buildFusedPairingUrl({
      entryHost: 'dev-macbook-pro.local',
      port: 18765,
      token: 'tok-test',
      name: 'dev-mac',
      hosts: ['192.168.1.2', 'dev-macbook-pro.local'],
      endpoints: [
        { url: 'http://192.168.1.2:18765', kind: 'lan', priority: 0 },
        { url: 'http://dev-macbook-pro.local:18765', kind: 'bonjour', priority: 200 }
      ]
    });

    let copiedUrl = '';
    let mockPairSummary = { pairedCount: 0, onlineCount: 0, pairedDevices: [] };
    const env = createDomEnv();
    env.sandbox.navigator.clipboard = { writeText: async (t) => { copiedUrl = String(t); } };
    env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };
    env.sandbox.fetch = async (url, init) => {
      if (String(url).includes('/remote-info')) {
        let reqBody = {};
        try { reqBody = JSON.parse(init?.body || '{}'); } catch {}
        if (reqBody.resetToken) {
          mockPairSummary = { pairedCount: 0, onlineCount: 0, pairedDevices: [] };
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              ...info,
              deviceName: 'dev-mac',
              bonjourHost: 'dev-macbook-pro.local',
              tailscaleDnsName: 'dev-mac.tailnet-demo.ts.net',
              fusedUrl: mockTsUrl,
              primaryUrl: mockTsUrl,
              ...mockPairSummary,
              channels: [
                { key: 'lan', label: '局域网', labelEn: 'LAN', available: true, enabled: true, displayHost: '192.168.1.2', rawHost: '192.168.1.2', entryHost: '192.168.1.2', iface: 'en0', url: mockLanUrl, qrSvg: '<svg id="qr-lan"><rect/></svg>' },
                { key: 'tailscale', label: 'Tailscale', labelEn: 'Tailscale', available: true, enabled: true, displayHost: 'dev-mac.tailnet-demo.ts.net', rawHost: 'dev-mac.tailnet-demo.ts.net', entryHost: '100.64.0.2', iface: 'utun0', url: mockTsUrl, qrSvg: '<svg id="qr-ts"><rect/></svg>' },
                { key: 'bonjour', label: 'Bonjour', labelEn: 'Bonjour', available: true, enabled: true, displayHost: 'dev-macbook-pro.local', rawHost: 'dev-macbook-pro.local', entryHost: 'dev-macbook-pro.local', iface: 'en0', url: mockBonjourUrl, qrSvg: '<svg id="qr-bonjour"><rect/></svg>' }
              ]
            }
          })
        };
      }
      return { ok: false, json: async () => ({}) };
    };
    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    const enhancer = env.sandbox.__AGEnhancer;
    const shadow = env.getShadow();
    const host = env.getHost();

    const remoteBtn = shadow.getElementById('badge-remote');
    const remotePop = shadow.getElementById('ag-remote-popover');
    assert.ok(remoteBtn && remotePop, '应注入 #badge-remote 按钮与 #ag-remote-popover 浮窗');
    assert.equal(enhancer.isAlive(), true);
    assert.equal(remoteBtn.textContent.trim(), '📱远程', '#badge-remote 中文文本应为 📱远程');

    api.setLocale('en');
    assert.equal(remoteBtn.textContent.trim(), '📱Remote', '#badge-remote 英文文本应为 📱Remote');
    api.setLocale('zh-CN');
    assert.equal(remoteBtn.textContent.trim(), '📱远程', '#badge-remote 切回中文应恢复 📱远程');

    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(remotePop.hidden, false, '打开遥控浮窗后应可见');
    assert.equal(host.getAttribute('data-elevated'), 'true', '遥控浮窗打开时应置顶宿主');
    assert.ok(remotePop.innerHTML.includes('手机远程操作配对'), '浮窗标题应为 手机远程操作配对');
    assert.equal(remotePop.querySelectorAll('.ag-rp-tab').length, 0, '一码三用布局不得再拆分 .ag-rp-tab 选项卡');
    assert.equal(remotePop.querySelectorAll('.ag-rp-url').length, 0, '一码三用布局不得再铺开多行 .ag-rp-url 文本框');
    assert.equal(remotePop.querySelectorAll('.ag-rp-qr').length, 1, '应只展示唯一融合二维码卡片 .ag-rp-qr');

    const rows = remotePop.querySelectorAll('.ag-rp-channel');
    assert.equal(rows.length, 3, '应展示 局域网 / Tailscale / Bonjour 三行通道清单');
    assert.ok(rows[0].textContent.includes('局域网') && rows[0].textContent.includes('192.168.1.2'));
    assert.ok(rows[1].textContent.includes('Tailscale') && rows[1].textContent.includes('dev-mac.tailnet-demo.ts.net'));
    assert.ok(rows[2].textContent.includes('Bonjour') && rows[2].textContent.includes('dev-macbook-pro.local'));
    assert.equal(rows.every(r => r.getAttribute('role') === 'checkbox' && r.getAttribute('aria-checked') === 'true'), true, '每行通道应统一作为整行复选框');
    assert.equal(remotePop.querySelectorAll('.ag-rp-check-box').length, 3, '每行仅保留左侧 1 个复选框视觉');
    assert.equal(remotePop.querySelectorAll('.ag-rp-ok').length, 3, '不得在右侧额外重复渲染对号图标');

    remotePop.querySelector('#ag-remote-copy')?.click();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(copiedUrl.includes('100.64.0.2:18765') && copiedUrl.includes('&endpoints='), '复制链接应使用优先级最高通道作引导地址并保留多端点融合参数');

    api.openSettings('terminal');
    assert.equal(remotePop.hidden, true, '打开设置面板时应互斥关闭遥控浮窗');

    enhancer.toggleRemotePopover(true);
    enhancer.toggleRemotePopover(false);
    assert.equal(host.getAttribute('data-elevated'), null, '关闭所有浮窗后应恢复宿主层叠上下文');

    // 验证已关联设备追踪、去重与密钥重置清空
    const curToken = buildRemoteInfo().token;
    assert.equal(recordPairedDeviceAccess({ headers: { 'user-agent': 'curl/8.0' }, socket: { remoteAddress: '127.0.0.1' } }, curToken), null,
      '本机 CLI/脚本健康探测不应计为关联设备');
    recordPairedDeviceAccess({
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', host: '100.64.0.2:18765' },
      socket: { remoteAddress: '100.64.0.99' }
    }, curToken);
    recordPairedDeviceAccess({
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148',
        'x-ag-device-id': 'dev-iphone-1',
        host: '100.64.0.2:18765'
      },
      socket: { remoteAddress: '100.64.0.99' }
    }, curToken);
    const devSnap1 = getPairedDevicesSummary(curToken);
    assert.equal(devSnap1.pairedCount, 1, '同一台 iPhone 从首屏加载升级上报 X-AG-Device-Id 应合并去重为 1 台');
    assert.equal(devSnap1.onlineCount, 1);
    assert.equal(devSnap1.devices[0].label, 'iPhone');
    assert.equal(devSnap1.devices[0].channel, 'tailscale');

    // 浮窗与顶栏实时渲染关联设备数及在线设备芯片
    mockPairSummary = {
      pairedCount: devSnap1.pairedCount,
      onlineCount: devSnap1.onlineCount,
      pairedDevices: devSnap1.devices
    };
    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    assert.ok(remotePop.innerHTML.includes('已关联 1 台设备（1 台在线）'), '浮窗应显示已关联设备数与在线数');
    assert.ok(remotePop.innerHTML.includes('iPhone (Tailscale · 在线)'), '浮窗应展示设备小标签');
    assert.equal(remoteBtn.textContent.trim(), '📱远程 · 1', '顶栏按钮应同步显示关联设备角标');
    assert.equal(remoteBtn.getAttribute('data-online'), 'true');

    api.setLocale('en');
    assert.equal(remoteBtn.textContent.trim(), '📱Remote · 1', '英文模式下顶栏按钮应显示 Remote · 1');
    assert.ok(remotePop.innerHTML.includes('1 paired (1 online)'), '英文模式下浮窗应显示英文设备统计');
    api.setLocale('zh-CN');

    // 点击重置密钥后应清空已关联设备计数
    remotePop.querySelector('#ag-remote-reset')?.click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(remotePop.innerHTML.includes('内网口令保护 · 暂未关联设备'), '重置密钥后浮窗应恢复暂未关联设备提示');
    assert.equal(remoteBtn.textContent.trim(), '📱远程', '重置密钥后顶栏角标应清零恢复 📱远程');
    const resetInfo = buildRemoteInfo({ resetToken: true });
    assert.equal(resetInfo.pairedCount, 0, '服务端重置密钥后 pairedCount 应归零');
    enhancer.toggleRemotePopover(false);

    const mobileHtml = buildMobileAppHtml();
    assert.ok(mobileHtml.includes('height:100%;position:fixed;top:0;left:0;right:0;bottom:0'), '手机端页面应使用 bottom:0 贴底全高布局');
    assert.ok(!/window\.screen\?\.(height|width)/.test(mobileHtml), '手机端不应使用 window.screen 高度放大视口，避免截断底部工具栏');
    assert.ok(mobileHtml.includes('X-AG-Device-Id'), '手机端应上报 X-AG-Device-Id 以精确追踪关联设备');
    const inlineScriptMatch = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(inlineScriptMatch, '手机端 HTML 应包含内联 <script>');
    assert.doesNotThrow(() => new (require('node:vm').Script)(inlineScriptMatch[1]), '手机端内联 <script> 必须通过语法校验');

    // 桌面宽屏双栏适配与 Opus 审计安全/A11y/UTF-8 修复验证
    assert.ok(
      mobileHtml.includes('@media (min-width:860px) and (min-height:521px) and (hover:hover) and (pointer:fine)'),
      '应包含仅桌面精细指针与非横屏矮屏生效的双栏媒体查询'
    );
    assert.ok(
      mobileHtml.includes('.drawer-brand') && mobileHtml.includes('sidebar-collapsed') && mobileHtml.includes('.composer-card.drag-over'),
      '桌面端应包含侧边栏品牌区、折叠态样式及拖拽上传高亮样式'
    );
    assert.ok(
      !mobileHtml.includes('user-scalable=no') && mobileHtml.includes('touch-action:manipulation'),
      '应遵循无障碍缩放规范并通过 touch-action:manipulation 抑制双击缩放'
    );
    assert.ok(
      mobileHtml.includes('syncSidebarA11y') && mobileHtml.includes('aria-expanded') && mobileHtml.includes('dragDepth') && mobileHtml.includes('snapshotInflight'),
      '客户端脚本应包含侧边栏无障碍同步、拖拽防抖计数与 snapshot 并发去重'
    );
    const escFnMatch = inlineScriptMatch[1].match(/function esc\(s\)\s*\{[\s\S]*?\n\s*\}/);
    assert.ok(escFnMatch, '应可提取客户端 esc() 函数进行直接行为校验');
    const escFn = new Function(`${escFnMatch[0]}; return esc;`)();
    assert.equal(escFn(0), '0', 'esc(0) 应保留数字 0');
    assert.equal(
      escFn(`<a "b" 'c' &>`),
      '&lt;a &quot;b&quot; &#39;c&#39; &amp;&gt;',
      'esc() 必须完整转义 < > " \' &'
    );

    // iPadOS 桌面模式 UA + 客户端 X-AG-Device-Hint 识别为 iPad
    recordPairedDeviceAccess({
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        'x-ag-device-id': 'dev-ipad-1',
        'x-ag-device-hint': 'iPad',
        host: '100.64.0.2:18765'
      },
      socket: { remoteAddress: '100.64.0.88' }
    }, resetInfo.token);
    const ipadSnap = getPairedDevicesSummary(resetInfo.token);
    assert.equal(ipadSnap.devices[0]?.label, 'iPad', '携带 X-AG-Device-Hint: iPad 时即使为 Mac 桌面 UA 也应识别为 iPad');

    // readJsonBody UTF-8 多字节汉字跨 chunk 拼接与 413 上限拦截
    const { EventEmitter } = require('node:events');
    const utf8Buf = Buffer.from(JSON.stringify({ msg: '桌面宽屏适配中文分片测试' }), 'utf8');
    const splitAt = utf8Buf.indexOf(0xe4) + 1; // 刻意在汉字 UTF-8 首字节后劈开
    const chunkReq = new EventEmitter();
    chunkReq.complete = true;
    chunkReq.pause = () => {};
    const bodyPromise = readJsonBody(chunkReq);
    chunkReq.emit('data', utf8Buf.subarray(0, splitAt));
    chunkReq.emit('data', utf8Buf.subarray(splitAt));
    chunkReq.emit('end');
    const parsedUtf8 = await bodyPromise;
    assert.equal(parsedUtf8.msg, '桌面宽屏适配中文分片测试', 'readJsonBody 跨多字节 UTF-8 分片拼接应无乱码');

    const overReq = new EventEmitter();
    overReq.complete = false;
    overReq.pause = () => { overReq.paused = true; };
    const overPromise = readJsonBody(overReq);
    const bigChunk = Buffer.alloc(8 * 1024 * 1024, 0x61);
    overReq.emit('data', bigChunk);
    overReq.emit('data', bigChunk); // 16MB > 15MB (MAX_ACTION_BODY_BYTES)
    await assert.rejects(overPromise, (err) => err?.status === 413, '超过请求体上限时应返回 413');
    assert.equal(overReq.paused, true, '触发 413 时应暂停流而非粗暴 destroy 导致客户端收不到 JSON');

    // HTTP 安全响应头 (CSP / nosniff / CORS X-AG-Device-Hint)
    const remoteHandler = createRemoteHttpHandler({ port: resetInfo.port, token: resetInfo.token });
    const runMockReq = async ({ method = 'GET', reqUrl = '/', headers = {} }) => {
      const resHeaders = {};
      let statusCode = 0;
      let body = '';
      const mockRes = {
        setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
        writeHead(code, hdrs = {}) {
          statusCode = code;
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[String(k).toLowerCase()] = v;
          }
        },
        end(chunk) { if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); }
      };
      await remoteHandler({ method, url: reqUrl, headers, socket: { remoteAddress: '127.0.0.1' } }, mockRes);
      return { statusCode, headers: resHeaders, body };
    };
    const r401 = await runMockReq({ reqUrl: '/' });
    assert.equal(r401.statusCode, 401);
    assert.equal(r401.headers['x-content-type-options'], 'nosniff');
    assert.ok(String(r401.headers['content-security-policy'] || '').includes("frame-ancestors 'none'"));

    const r200 = await runMockReq({ reqUrl: '/?token=' + encodeURIComponent(resetInfo.token), headers: { 'user-agent': 'curl/8.0' } });
    assert.equal(r200.statusCode, 200);
    assert.equal(r200.headers['x-content-type-options'], 'nosniff');
    assert.ok(String(r200.headers['content-security-policy'] || '').includes("base-uri 'none'"));

    const rOpt = await runMockReq({
      method: 'OPTIONS',
      reqUrl: '/api/snapshot',
      headers: { origin: 'http://localhost:18765' }
    });
    assert.equal(rOpt.statusCode, 204);
    assert.ok(String(rOpt.headers['access-control-allow-headers'] || '').includes('X-AG-Device-Hint'));

    api.dispose?.();
    enhancer.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevMeterStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevMeterStateDir;
    if (prevContextStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevContextStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 7: #ag-chat-nav-float 对话导航胶囊移除内圈边框并改用 shadcn/ui 风格 Lucide SVG 图标
// =========================================================================
test('需求 7: #ag-chat-nav-float 移除按钮内圈边框并使用 Lucide SVG 图标，中英切换正常', () => {
  const navCssMatch = ENHANCER_SRC.match(/#\$\{CHAT_NAV_ID\}\s+\.ag-nav-btn\s*\{[\s\S]*?\}/);
  assert.ok(navCssMatch, 'ag-enhancer-overlay.js 应包含 .ag-nav-btn 样式规则');
  assert.ok(navCssMatch[0].includes('border: none;'), '.ag-nav-btn 必须移除内圈边框 (border: none)');
  assert.ok(navCssMatch[0].includes('background: transparent;'), '.ag-nav-btn 默认态必须透明无嵌套底色');
  const navContainerCss = ENHANCER_SRC.match(/#\$\{CHAT_NAV_ID\}\s*\{[\s\S]*?\}/);
  assert.ok(navContainerCss && navContainerCss[0].includes('z-index: 8;'), '#ag-chat-nav-float 必须使用 z-index: 8; 处于所有弹窗下方');
  assert.ok(!ENHANCER_SRC.includes('z-index: 99990;'), '不得再使用过高 z-index: 99990;');

  const env = createDomEnv();
  const sheetEl = env.doc.createElement('div');
  sheetEl.className = 'agy-sheet';
  env.doc.body.appendChild(sheetEl);
  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(ENHANCER_SRC, env.sandbox);

  const api = env.sandbox.__AGContextMeter;
  const enhancer = env.sandbox.__AGEnhancer;
  const nav = env.doc.getElementById('ag-chat-nav-float');
  assert.ok(nav, '应挂载 #ag-chat-nav-float 浮层');
  assert.equal(nav.parentElement, sheetEl, '存在 .agy-sheet 时应挂载于其堆叠上下文内部，避免盖住弹窗');

  const expectedIds = ['ag-nav-top', 'ag-nav-prev', 'ag-nav-next', 'ag-nav-bottom', 'ag-nav-think'];
  const btns = expectedIds.map(id => env.doc.getElementById(id));
  assert.ok(btns.every(Boolean), '应渲染全部 5 个对话导航按钮');

  for (const btn of btns) {
    const iconEl = btn.querySelector('.ag-nav-icon');
    assert.ok(iconEl, `${btn.id} 应包含 .ag-nav-icon`);
    assert.ok(iconEl.innerHTML.includes('<svg class="ag-nav-svg"'), `${btn.id} 应使用 .ag-nav-svg Lucide 矢量图标`);
    assert.ok(iconEl.innerHTML.includes('stroke="currentColor"') && iconEl.innerHTML.includes('stroke-width="1.75"'), `${btn.id} SVG 应使用统一 currentColor 与 1.75 描边`);
    for (const emoji of ['⏫', '🔼', '🔽', '⏬', '💡']) {
      assert.ok(!iconEl.innerHTML.includes(emoji) && !btn.textContent.includes(emoji), `${btn.id} 不得再包含旧版 emoji (${emoji})`);
    }
  }

  const getLabels = () => btns.map(b => b.querySelector('.ag-nav-label')?.textContent?.trim());
  assert.deepEqual(getLabels(), ['顶部', '上一轮', '下一轮', '底部', '展开思考'], 'zh-CN 下应显示中文标签');

  api.setLocale('en');
  assert.deepEqual(getLabels(), ['Top', 'Prev', 'Next', 'Bottom', 'Expand Thoughts'], 'English 下应切换为英文标签');

  api.setLocale('zh-CN');
  assert.deepEqual(getLabels(), ['顶部', '上一轮', '下一轮', '底部', '展开思考'], '切回 zh-CN 应恢复中文标签');

  enhancer.dispose?.();
  api.dispose?.();
});

// =========================================================================
// 需求 8: #panel-settings 顶部版本检测、#badge-settings 更新红点与一键热更新
// =========================================================================
test('需求 8: #panel-settings 顶部版本检测、#badge-settings 更新红点与一键热更新', async () => {
  const env = createDomEnv();
  env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };
  let checkPayload = {
    ok: true,
    isGitRepo: true,
    version: '0.8.5',
    branch: 'main',
    localShortSha: '7c2bc39',
    localSubject: 'feat(remote): prev commit',
    remoteShortSha: 'abc1234',
    behindCount: 2,
    hasUpdate: true,
    latestSubject: 'feat: new release',
    latestRelativeTime: '1 minute ago',
    fetchError: ''
  };
  env.sandbox.fetch = async (url) => {
    if (String(url).includes('/suite-version-check')) {
      return { ok: true, json: async () => checkPayload };
    }
    if (String(url).includes('/suite-apply-update')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          updated: true,
          alreadyUpToDate: false,
          version: '0.8.5',
          beforeSha: '7c2bc39',
          localShortSha: 'abc1234',
          localSubject: 'feat: new release'
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  vm.runInContext(RENDERER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const shadow = env.getShadow();
  const settingsBtn = shadow.getElementById('badge-settings');
  const verEl = shadow.getElementById('suite-ver-status');
  const checkBtn = shadow.getElementById('btn-suite-check-update');
  const applyBtn = shadow.getElementById('btn-suite-apply-update');
  assert.ok(settingsBtn && verEl && applyBtn, '应渲染设置版本状态与一键更新按钮');
  assert.equal(checkBtn, null, '已移除手动检查更新按钮，全自动静默检查提醒');

  await new Promise(r => setTimeout(r, 25));
  assert.equal(settingsBtn.getAttribute('data-has-update'), 'true', '发现更新时右上角 ⚙️ 应亮起提示圆点');
  assert.ok(verEl.textContent.includes('有新更新 (+2 · abc1234)'), '状态胶囊应展示落后提交数与远端短哈希');
  assert.equal(applyBtn.hidden, false, '有更新时应显示一键更新按钮');

  api.setLocale('en');
  assert.ok(verEl.textContent.includes('+2 update(s) (abc1234)'), '英文模式下应同步翻译更新状态');
  assert.ok(applyBtn.textContent.includes('Update Now'));
  api.setLocale('zh-CN');

  applyBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.ok(verEl.textContent.includes('已更新至 v0.8.5 (abc1234)'), '点击一键更新后应展示已更新状态');
  assert.equal(applyBtn.hidden, true, '更新完成后应隐藏一键更新按钮');
  assert.equal(settingsBtn.getAttribute('data-has-update'), null, '更新完成后应消除右上角提示圆点');

  checkPayload = {
    ok: true,
    isGitRepo: true,
    version: '0.8.5',
    branch: 'main',
    localShortSha: 'abc1234',
    localSubject: 'feat: new release',
    remoteShortSha: 'abc1234',
    behindCount: 0,
    hasUpdate: false,
    latestSubject: 'feat: new release',
    latestRelativeTime: '',
    fetchError: ''
  };
  verEl.click();
  await new Promise(r => setTimeout(r, 25));
  assert.ok(verEl.textContent.includes('v0.8.5 (abc1234 · 已是最新)'), '已是最新时应显示短哈希与最新提示');
  assert.equal(applyBtn.hidden, true);
  assert.equal(settingsBtn.getAttribute('data-has-update'), null);

  api.dispose?.();
});

// =========================================================================
// 需求 9: ⌘1~⌘9 快速切换对话、按住 ⌘ 浮现序号角标与 ⌘⇧[/] 循环切会话
// =========================================================================
test('需求 9: ⌘1~⌘9 快速切换对话、按住 ⌘ 浮现序号角标与 ⌘⇧[/] 循环切会话', async () => {
  const env = createDomEnv();
  const rows = [];
  const clickedIds = [];
  for (let i = 1; i <= 10; i++) {
    const row = env.doc.createElement('div');
    row.setAttribute('data-testid', 'conversation-row-sidebar');
    row.setAttribute('data-cascade-id', `conv-${i}`);
    if (i === 1) row.setAttribute('data-selected', 'true');
    const link = env.doc.createElement('a');
    link.setAttribute('href', `/c/conv-${i}`);
    const span = env.doc.createElement('span');
    span.className = 'truncate';
    span.textContent = `会话 ${i}`;
    link.appendChild(span);
    link.addEventListener('click', () => {
      for (const r of rows) r.removeAttribute('data-selected');
      row.setAttribute('data-selected', 'true');
      clickedIds.push(`conv-${i}`);
    });
    row.appendChild(link);
    env.doc.body.appendChild(row);
    rows.push(row);
  }

  // 内联重命名输入框（测试在其聚焦时不误触发快捷键）
  const renameInput = env.doc.createElement('input');
  rows[0].appendChild(renameInput);

  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const enhancer = env.sandbox.__AGEnhancer;

  const docStyleEl = env.doc.getElementById('ag-enhancer-doc-style');
  assert.ok(docStyleEl, '应挂载 #ag-enhancer-doc-style 全局样式');
  assert.ok(
    docStyleEl.textContent.includes('html[data-ag-cmd-down="1"] [data-testid="conversation-row-sidebar"][data-ag-shortcut]::after'),
    '样式表应包含按住 ⌘ 时浮现 ::after 序号角标的规则'
  );

  // 初始化即同步前 9 个对话的 data-ag-shortcut，第 10 个不标注
  for (let i = 0; i < 9; i++) {
    assert.equal(rows[i].getAttribute('data-ag-shortcut'), `⌘${i + 1}`, `第 ${i + 1} 个对话应标记 ⌘${i + 1}`);
  }
  assert.equal(rows[9].getAttribute('data-ag-shortcut'), null, '第 10 个对话不应标记序号角标');

  const mkKeyEv = (type, extra = {}) => {
    const ev = {
      type,
      key: '',
      code: '',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: env.doc.body,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...extra
    };
    env.doc.dispatchEvent(ev);
    return ev;
  };

  // 1. 按住 Command 键 -> html[data-ag-cmd-down="1"] 激活；松开 -> 移除
  mkKeyEv('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
  assert.equal(env.doc.documentElement.getAttribute('data-ag-cmd-down'), '1', '按下 ⌘ 时应激活 data-ag-cmd-down');
  mkKeyEv('keyup', { key: 'Meta', code: 'MetaLeft', metaKey: false });
  assert.equal(env.doc.documentElement.getAttribute('data-ag-cmd-down'), null, '松开 ⌘ 时应关闭 data-ag-cmd-down');

  // 2. ⌘2 切换到第 2 个对话
  const ev2 = mkKeyEv('keydown', { key: '2', code: 'Digit2', metaKey: true });
  assert.equal(ev2.prevented, true, '⌘2 应阻止默认事件并接管切换');
  assert.equal(clickedIds[0], 'conv-2', '⌘2 应触发点击第 2 个对话');

  // 3. ⌘⇧3（Mac 系统截图）绝对不能拦截或切换对话
  const evShot = mkKeyEv('keydown', { key: '3', code: 'Digit3', metaKey: true, shiftKey: true });
  assert.equal(evShot.prevented, false, '⌘⇧3 不应被拦截，需放行系统截图');
  assert.equal(clickedIds.length, 1, '⌘⇧3 不得触发对话切换');

  // 4. 在重命名 input 内按 ⌘1 不得误触发切换
  const evRename = mkKeyEv('keydown', { key: '1', code: 'Digit1', metaKey: true, target: renameInput });
  assert.equal(evRename.prevented, false, '侧边栏重命名输入框内应放行原生快捷键');
  assert.equal(clickedIds.length, 1);

  // 5. ⌘⇧] 切到下一个（#3）、⌘⇧[ 切回上一个（#2）、⌃Tab 再切到下一个（#3）
  const evNext = mkKeyEv('keydown', { key: ']', code: 'BracketRight', metaKey: true, shiftKey: true });
  assert.equal(evNext.prevented, true);
  assert.equal(clickedIds[1], 'conv-3', '⌘⇧] 应切换至下一个对话 conv-3');

  const evPrev = mkKeyEv('keydown', { key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true });
  assert.equal(evPrev.prevented, true);
  assert.equal(clickedIds[2], 'conv-2', '⌘⇧[ 应切换回上一个对话 conv-2');

  const evCtrlTab = mkKeyEv('keydown', { key: 'Tab', code: 'Tab', ctrlKey: true });
  assert.equal(evCtrlTab.prevented, true);
  assert.equal(clickedIds[3], 'conv-3', '⌃Tab 应切换至下一个对话 conv-3');

  // 6. 第 10 个循环回到第 1 个（验证环绕）
  enhancer.switchConversationByIndex(9);
  assert.equal(clickedIds[4], 'conv-10');
  enhancer.cycleConversation(1);
  assert.equal(clickedIds[5], 'conv-1', '最后一个对话按下一个应循环回到第一个对话');

  // 7. dispose 后清理 data-ag-shortcut 与 data-ag-cmd-down
  enhancer.dispose?.();
  api.dispose?.();
  assert.equal(env.doc.documentElement.getAttribute('data-ag-cmd-down'), null);
  for (const r of rows) {
    assert.equal(r.getAttribute('data-ag-shortcut'), null, 'dispose 后应移除所有 data-ag-shortcut 属性');
  }
});

// =========================================================================
// 需求 10: 统一设置面板内的「功能显示开关」实时控制顶栏与对话挂件显隐并持久化
// =========================================================================
test('需求 10: 功能显示开关实时隐藏/显示顶栏入口与对话区挂件并持久化同步', async () => {
  const env = createDomEnv();
  const composerWrap = env.doc.createElement('div');
  const composer = env.doc.createElement('div');
  composer.className = 'surface-composer';
  composerWrap.appendChild(composer);
  env.doc.body.appendChild(composerWrap);

  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const enhancer = env.sandbox.__AGEnhancer;
  const host = env.getHost();
  const shadow = env.getShadow();

  // 1. 默认开启全部 6 项功能
  assert.ok(shadow.getElementById('settings-card-features'), '设置面板首页应包含功能显示开关卡片');
  const toggleIds = [
    ['set-feat-tokens', 'showTopbarTokens'],
    ['set-feat-cli', 'showTopbarCli'],
    ['set-feat-quota', 'showTopbarQuota'],
    ['set-feat-remote', 'showTopbarRemote'],
    ['set-feat-quickbar', 'showQuickBar'],
    ['set-feat-chatnav', 'showChatNav']
  ];
  for (const [id] of toggleIds) {
    const chk = shadow.getElementById(id);
    assert.ok(chk, `应存在开关 #${id}`);
    assert.equal(chk.checked, true, `#${id} 默认应为开启状态`);
  }
  assert.ok(env.doc.getElementById('ag-quick-capsule-bar'), '默认应挂载输入框快捷操作栏');
  assert.ok(env.doc.getElementById('ag-chat-nav-float'), '默认应挂载对话右侧悬浮导航');
  assert.equal(shadow.getElementById('badge-quota')?.hidden, false, '默认应显示配额胶囊');
  assert.equal(shadow.getElementById('badge-remote')?.hidden, false, '默认应显示远程入口');

  // 2. 通过设置面板关闭顶部 CLI 入口与总用量统计（模拟用户典型精简需求）
  let lastPrefDetail = null;
  env.win.addEventListener('ag-suite-prefs-changed', ev => { lastPrefDetail = ev.detail; });

  const chkTokens = shadow.getElementById('set-feat-tokens');
  chkTokens.checked = false;
  chkTokens.dispatchEvent({ type: 'change', target: chkTokens });
  assert.equal(host.getAttribute('data-hide-tokens'), 'true', '关闭总用量开关后应标记 data-hide-tokens="true"');

  const chkCli = shadow.getElementById('set-feat-cli');
  chkCli.checked = false;
  chkCli.dispatchEvent({ type: 'change', target: chkCli });
  assert.equal(host.getAttribute('data-hide-cli'), 'true', '关闭 CLI 开关后应标记 data-hide-cli="true"');

  // 3. 关闭配额胶囊、手机远程、快捷操作栏与悬浮导航
  for (const id of ['set-feat-quota', 'set-feat-remote', 'set-feat-quickbar', 'set-feat-chatnav']) {
    const chk = shadow.getElementById(id);
    chk.checked = false;
    chk.dispatchEvent({ type: 'change', target: chk });
  }
  await new Promise(r => setTimeout(r, 15));

  assert.equal(host.getAttribute('data-hide-quota'), 'true');
  assert.equal(host.getAttribute('data-hide-remote'), 'true');
  assert.equal(shadow.getElementById('badge-quota')?.hidden, true, '关闭配额开关后应隐藏 #badge-quota');
  assert.equal(shadow.getElementById('badge-remote')?.hidden, true, '关闭远程开关后应隐藏 #badge-remote');
  assert.equal(env.doc.getElementById('ag-quick-capsule-bar'), null, '关闭快捷栏开关后应移除 #ag-quick-capsule-bar');
  assert.equal(env.doc.getElementById('ag-chat-nav-float'), null, '关闭悬浮导航开关后应移除 #ag-chat-nav-float');

  const savedJson = JSON.parse(env.localStorage.getItem('ag_suite_feature_flags') || '{}');
  assert.equal(savedJson.showTopbarTokens, false);
  assert.equal(savedJson.showTopbarCli, false);
  assert.equal(savedJson.showQuickBar, false);
  assert.equal(lastPrefDetail?.featureFlags?.showChatNav, false);
  assert.equal(enhancer.getFeatureFlags().showQuickBar, false);

  // 验证 saveSettings 请求写入 uiPreferences.featureFlags
  assert.ok(
    env.postedSettings.some(p => p?.uiPreferences?.featureFlags?.showTopbarCli === false),
    '关闭功能开关后应透传 uiPreferences.featureFlags 到宿主保存'
  );

  // 4. 一键全部恢复显示
  shadow.getElementById('btn-reset-feature-toggles')?.click();
  await new Promise(r => setTimeout(r, 15));
  for (const [id] of toggleIds) {
    assert.equal(shadow.getElementById(id)?.checked, true, `恢复全部后 #${id} 应重新勾选`);
  }
  assert.equal(host.getAttribute('data-hide-tokens'), null);
  assert.equal(host.getAttribute('data-hide-cli'), null);
  assert.equal(host.getAttribute('data-hide-quota'), null);
  assert.equal(host.getAttribute('data-hide-remote'), null);
  assert.equal(shadow.getElementById('badge-quota')?.hidden, false);
  assert.equal(shadow.getElementById('badge-remote')?.hidden, false);
  assert.ok(env.doc.getElementById('ag-quick-capsule-bar'), '恢复全部后应重新挂载快捷操作栏');
  assert.ok(env.doc.getElementById('ag-chat-nav-float'), '恢复全部后应重新挂载悬浮导航');

  enhancer.dispose?.();
  api.dispose?.();
});

// =========================================================================
// 需求 11: Cloudflare 远程公网隧道（免登录 Quick Tunnel + 自有账号固定域名）与安全防护
// =========================================================================
test('需求 11: Cloudflare 隧道 Token 提取、公网融合 URL、弹窗开关切换与安全拦截', async () => {
  const os = require('node:os');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cf-tunnel-test-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      extractCloudflareTunnelToken,
      normalizeTunnelHostname,
      saveRemoteTunnelConfig,
      buildFusedPairingUrl,
      buildRemoteInfo,
      isAllowedPrivateOrigin
    } = require('./mobile-remote.js');

    // 1. Token 与域名规范化提取
    assert.equal(
      extractCloudflareTunnelToken('sudo cloudflared service install eyJhIjoiMTIzIiwidCI6IjQ1NiIsInMiOiI3ODkifQ=='),
      'eyJhIjoiMTIzIiwidCI6IjQ1NiIsInMiOiI3ODkifQ==',
      '应从完整的 service install 命令中提取完整带填充的 Tunnel Token'
    );
    assert.equal(
      normalizeTunnelHostname('ag.example.com/path'),
      'https://ag.example.com',
      '缺少 https:// 前缀的公网域名应自动补齐并规范为 origin'
    );
    assert.equal(normalizeTunnelHostname('http://insecure.example.com'), '', '公网固定域名必须使用 https://');

    // 2. HTTPS 公网引导链接应省略 :18765 端口并保持 ?token= 首参数与 &endpoints=
    const tunnelUrl = buildFusedPairingUrl({
      entryBaseUrl: 'https://demo-words.trycloudflare.com',
      port: 18765,
      token: 'tok-cf-123456',
      name: 'dev-mac',
      hosts: ['10.0.1.25', 'demo-words.trycloudflare.com'],
      endpoints: [
        { url: 'http://10.0.1.25:18765', kind: 'lan', priority: 0 },
        { url: 'https://demo-words.trycloudflare.com', kind: 'tunnel', priority: 250 }
      ]
    });
    assert.ok(tunnelUrl.startsWith('https://demo-words.trycloudflare.com/?token=tok-cf-123456'), '公网隧道链接应使用 https:// 无端口前缀并保留 ?token=');
    assert.ok(!tunnelUrl.includes(':18765/?token='), 'HTTPS 公网入口不得拼接本地 :18765 端口');
    assert.ok(tunnelUrl.includes('&endpoints='), '公网隧道融合链接应保留 &endpoints= 多端点列表');

    // 3. 保存固定域名与 Token 后 buildRemoteInfo 不得泄露明文 tunnelToken
    saveRemoteTunnelConfig({
      enabled: false,
      tunnelMode: 'named',
      tunnelHostname: 'ag.example.com',
      tunnelToken: 'eyJhIjoiMTIzIiwidCI6IjQ1NiIsInMiOiI3ODkifQ'
    });
    const baseInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: { enabled: false, state: 'stopped', mode: 'named', binaryAvailable: true }
    });
    assert.equal(baseInfo.hasTunnelToken, true);
    assert.equal(baseInfo.tunnelHostname, 'https://ag.example.com');
    assert.ok(!JSON.stringify(baseInfo).includes('eyJhIjoi'), 'buildRemoteInfo 输出中绝不得回显明文 tunnelToken');
    assert.equal(baseInfo.channels.length, 4, '默认 buildRemoteInfo 应包含 Wi-Fi / Tailscale / Bonjour / Cloudflare 四通道');

    // 4. 运行态 activeTunnelOrigin CORS 放行校验
    assert.equal(isAllowedPrivateOrigin('https://demo-words.trycloudflare.com', 'https://demo-words.trycloudflare.com'), true);
    assert.equal(isAllowedPrivateOrigin('https://evil.com', 'https://demo-words.trycloudflare.com'), false);

    // 4b. cloudflared 启动参数强制 IPv4 + HTTP/2，移动端不硬编码“内网直连”并启用超时切换
    const remoteSrc = fs.readFileSync(path.join(ROOT, 'mobile-remote.js'), 'utf8');
    assert.ok(
      remoteSrc.includes("'--edge-ip-version', '4'") && remoteSrc.includes("'--protocol', 'http2'"),
      'cloudflared 应固定传入 --edge-ip-version 4 与 --protocol http2'
    );
    assert.ok(
      !remoteSrc.includes('<div id="sub-meta" class="sub-meta">内网直连</div>'),
      'mobile-remote PWA 不得硬编码静态“内网直连”文本'
    );
    assert.ok(
      remoteSrc.includes('function getActiveChannelLabel()') && remoteSrc.includes('function fetchWithTimeout(') && remoteSrc.includes('AbortController'),
      'mobile-remote PWA 应具备通道标签识别与 AbortController 超时故障切换'
    );

    // 5. #ag-remote-popover 开关启用 / 固定域名表单交互验证
    let tunnelPosts = [];
    const env = createDomEnv();
    env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };
    env.sandbox.fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: baseInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        tunnelPosts.push(body);
        saveRemoteTunnelConfig(body);
        const runningInfo = buildRemoteInfo({
          resetToken: false,
          tunnelStatus: {
            enabled: Boolean(body.enabled),
            state: body.enabled ? 'running' : 'stopped',
            mode: body.tunnelMode || 'quick',
            publicUrl: body.enabled ? 'https://live-demo.trycloudflare.com' : '',
            binaryAvailable: true
          }
        });
        return { ok: true, json: async () => ({ ok: true, data: runningInfo }) };
      }
      return { ok: false, json: async () => ({}) };
    };
    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    const enhancer = env.sandbox.__AGEnhancer;
    const shadow = env.getShadow();
    const remotePop = shadow.getElementById('ag-remote-popover');

    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    const toggleBtn = remotePop.querySelector('#ag-rp-tunnel-toggle');
    const cfgBtn = remotePop.querySelector('#ag-rp-tunnel-cfg-btn');
    assert.ok(toggleBtn && cfgBtn, '弹窗应渲染 #ag-rp-tunnel-toggle 与 #ag-rp-tunnel-cfg-btn');

    // 点击展开固定域名配置表单
    cfgBtn.click();
    assert.ok(remotePop.querySelector('#ag-rp-tunnel-form'), '点击 固定域名 应展开固定域名与 Token 配置表单');

    // Re-query fresh button after cfgBtn.click() re-rendered popover
    remotePop.querySelector('#ag-rp-tunnel-toggle')?.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(tunnelPosts[0]?.enabled, true, '点击开启应请求 /remote-tunnel enabled=true');
    const tunnelRow = remotePop.querySelector('#ag-rp-tunnel-toggle');
    assert.equal(tunnelRow?.getAttribute('aria-checked'), 'true', '隧道就绪后行复选框应呈勾选状态');
    assert.ok(remotePop.querySelector('.ag-rp-qr svg'), '隧道就绪后应刷新融合公网二维码');

    enhancer.dispose?.();
    api.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 12: “局域网”命名、四通道复选框启停门禁（停用返回 403）及客户页直选入口
// =========================================================================
test('需求 12: 局域网命名、通道复选框启停与后端 403 拦截、客户端直选模式入口验证', async () => {
  const os = require('node:os');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-channel-gate-test-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      saveRemoteTunnelConfig,
      buildRemoteInfo,
      createRemoteHttpHandler,
      detectRequestChannel
    } = require('./mobile-remote.js');

    const remoteSrc = fs.readFileSync(path.join(ROOT, 'mobile-remote.js'), 'utf8');
    assert.ok(!remoteSrc.includes('此 Wi-Fi') && !ENHANCER_SRC.includes('此 Wi-Fi'), '应统一将“此 Wi-Fi”替换为“局域网”');

    // 1. 通道命名 & 按复选框过滤端点
    const defaultInfo = buildRemoteInfo({
      tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true }
    });
    const lanChDefault = defaultInfo.channels.find(c => c.key === 'lan');
    assert.equal(lanChDefault?.label, '局域网');
    assert.equal(lanChDefault?.labelEn, 'LAN');

    const cfg = saveRemoteTunnelConfig({
      enabledChannels: { lan: false, bonjour: false, tailscale: true, tunnel: false }
    });
    const gatedInfo = buildRemoteInfo({
      tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true }
    });
    assert.equal(gatedInfo.channels.find(c => c.key === 'lan')?.enabled, false);
    assert.equal(gatedInfo.channels.find(c => c.key === 'lan')?.available, false);
    assert.equal(gatedInfo.channels.find(c => c.key === 'bonjour')?.enabled, false);
    assert.ok(!gatedInfo.endpoints.some(ep => ep.kind === 'lan' || ep.kind === 'bonjour'), '已停用的通道不得出现在融合 endpoints 中');

    // 2. 后端 HTTP 处理器严格按启停状态拦截停用通道（403）并放行已启用通道（200）
    const handler = createRemoteHttpHandler(cfg, { getTunnelOrigin: () => '' });
    const invokeMockReq = async ({ url, headers = {}, remoteAddress = '127.0.0.1' }) => {
      let status = 0;
      const resHeaders = {};
      let body = '';
      const req = { method: 'GET', url, headers, socket: { remoteAddress } };
      const res = {
        setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
        writeHead(code, h = {}) {
          status = code;
          for (const [k, v] of Object.entries(h)) resHeaders[String(k).toLowerCase()] = v;
        },
        end(chunk = '') { body += String(chunk); }
      };
      await handler(req, res);
      return { status, body, resHeaders };
    };

    assert.equal(detectRequestChannel({ headers: { host: '192.168.1.25:18765' }, socket: { remoteAddress: '192.168.1.50' } }), 'lan');
    const lanBlocked = await invokeMockReq({
      url: `/api/snapshot?token=${cfg.token}`,
      headers: { host: '192.168.1.25:18765' },
      remoteAddress: '192.168.1.50'
    });
    assert.equal(lanBlocked.status, 403, '停用局域网后来自局域网链接的请求必须返回 403');
    assert.equal(JSON.parse(lanBlocked.body).channelDisabled, 'lan');

    const bonjourBlocked = await invokeMockReq({
      url: `/api/ping?token=${cfg.token}`,
      headers: { host: 'dev-mac.local:18765' },
      remoteAddress: '192.168.1.50'
    });
    assert.equal(bonjourBlocked.status, 403, '停用 Bonjour 后 .local 链接请求必须返回 403');
    assert.equal(JSON.parse(bonjourBlocked.body).channelDisabled, 'bonjour');

    const tunnelBlocked = await invokeMockReq({
      url: `/api/ping?token=${cfg.token}`,
      headers: { host: 'demo-words.trycloudflare.com', 'cf-ray': 'abc123' },
      remoteAddress: '127.0.0.1'
    });
    assert.equal(tunnelBlocked.status, 403, '停用 Cloudflare 隧道后代理请求必须返回 403');
    assert.equal(JSON.parse(tunnelBlocked.body).channelDisabled, 'tunnel');

    const tsAllowed = await invokeMockReq({
      url: `/api/ping?token=${cfg.token}`,
      headers: { host: '100.64.0.2:18765' },
      remoteAddress: '100.64.0.9'
    });
    assert.equal(tsAllowed.status, 200, '保持启用的 Tailscale 通道应允许调用并返回 200');
    assert.equal(JSON.parse(tsAllowed.body).ok, true);

    // 3. 验证客户端页面 HTML 脚本语法完全有效且包含自动进入前直选入口控件
    const pageResp = await invokeMockReq({
      url: `/?token=${cfg.token}`,
      headers: { host: `127.0.0.1:${cfg.port}` },
      remoteAddress: '127.0.0.1'
    });
    assert.equal(pageResp.status, 200);
    assert.ok(pageResp.body.includes('mode-entry-panel') && pageResp.body.includes('mode-entry-btn'), '客户端页面应渲染直选模式入口面板');
    assert.ok(pageResp.body.includes('enterConnectionMode') && pageResp.body.includes('buildClientEntryUrl'), '客户端页面应包含手动直切连接方式逻辑');
    const scriptMatch = pageResp.body.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], '客户端 HTML 应包含内联脚本');
    assert.doesNotThrow(() => new Function(scriptMatch[1]), '客户端页面内联 <script> 不得存在模板字符串转义语法错误');

    // 4. 验证桌面弹窗 4 通道统一复选框及点击交互
    saveRemoteTunnelConfig({ enabled: false, enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: false } });
    const allOnInfo = buildRemoteInfo({ tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true } });
    let postedPatches = [];
    const env = createDomEnv();
    env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };
    env.sandbox.fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: allOnInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        postedPatches.push(body);
        saveRemoteTunnelConfig(body);
        const updated = buildRemoteInfo({ tunnelStatus: { enabled: Boolean(body.enabled), state: 'stopped', binaryAvailable: true } });
        return { ok: true, json: async () => ({ ok: true, data: updated }) };
      }
      return { ok: false, json: async () => ({}) };
    };
    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    const enhancer = env.sandbox.__AGEnhancer;
    const shadow = env.getShadow();
    const remotePop = shadow.getElementById('ag-remote-popover');

    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    const checkBtns = remotePop.querySelectorAll('.ag-rp-check');
    assert.equal(checkBtns.length, 4, '4 个连接通道应统一渲染 4 个复选框控件');
    assert.equal(checkBtns.every(b => b.getAttribute('role') === 'checkbox'), true);

    const lanChk = remotePop.querySelector('#ag-rp-toggle-lan');
    assert.equal(lanChk?.getAttribute('aria-checked'), 'true');
    lanChk.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(postedPatches[0]?.enabledChannels, { lan: false }, '取消勾选局域网应提交 enabledChannels.lan=false');
    assert.equal(remotePop.querySelector('#ag-rp-toggle-lan')?.getAttribute('aria-checked'), 'false');

    enhancer.dispose?.();
    api.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 13: 整行复选远程通道 + CLI 多路复用器主机名 + 胶囊缓存命中率双图标
// =========================================================================
test('需求 13: 远程浮窗整行热区勾选、CLI 多路复用器指定主机名、输入胶囊双比例图标与缓存命中率', async () => {
  // 1. #ag-remote-popover 整行点击热区勾选启用/停用 + 独立固定域名按钮不误触
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req10-remote-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const { saveRemoteTunnelConfig, buildRemoteInfo } = require('./mobile-remote.js');
    saveRemoteTunnelConfig({ enabled: false, enabledChannels: { lan: true, tailscale: false, bonjour: true, tunnel: false } });
    const initInfo = buildRemoteInfo({ tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true } });

    const remotePosts = [];
    const envR = createDomEnv();
    envR.win.__AGContextMeterLive = { port: 61221, token: 'tok-req10' };
    envR.sandbox.fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        remotePosts.push(body);
        saveRemoteTunnelConfig(body);
        const updated = buildRemoteInfo({
          tunnelStatus: {
            enabled: Boolean(body.enabled ?? body.enabledChannels?.tunnel),
            state: (body.enabled ?? body.enabledChannels?.tunnel) ? 'running' : 'stopped',
            binaryAvailable: true
          }
        });
        return { ok: true, json: async () => ({ ok: true, data: updated }) };
      }
      return { ok: false, json: async () => ({}) };
    };

    vm.runInContext(RENDERER_SRC, envR.sandbox);
    const apiR = envR.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, envR.sandbox);
    const enhR = envR.sandbox.__AGEnhancer;
    const remotePop = envR.getShadow().getElementById('ag-remote-popover');

    enhR.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));

    const tsRow = remotePop.querySelector('#ag-rp-toggle-tailscale');
    assert.ok(tsRow && tsRow.classList.contains('ag-rp-channel'), 'Tailscale 行自身即为 .ag-rp-channel 整行复选框热区');
    assert.equal(tsRow.getAttribute('aria-checked'), 'false', '未启用的通道应展示为未勾选，但允许整行点击重新启用');
    assert.equal(tsRow.hasAttribute('disabled'), false);

    // 整行点击未启用的 Tailscale 行应提交启用请求
    tsRow.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(remotePosts[0]?.enabledChannels, { tailscale: true }, '点击未勾选整行应启用对应通道');
    assert.equal(remotePop.querySelector('#ag-rp-toggle-tailscale')?.getAttribute('aria-checked'), 'true');

    // 点击 固定域名 按钮只展开表单，不额外触发 /remote-tunnel 请求
    const postCountBeforeCfg = remotePosts.length;
    remotePop.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(remotePop.querySelector('#ag-rp-tunnel-form'), '点击固定域名按钮应展开表单');
    assert.equal(remotePosts.length, postCountBeforeCfg, '点击固定域名不得误触隧道勾选请求');

    enhR.dispose?.();
    apiR.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }

  // 2. CLI 多路复用器主机名校验、探测、各复用器启动命令生成与设置界面联动
  assert.equal(terminals.sanitizeMuxHost(''), '');
  assert.equal(terminals.sanitizeMuxHost('local'), '');
  assert.equal(terminals.sanitizeMuxHost('unix:///tmp/rex.sock'), '');
  assert.equal(terminals.sanitizeMuxHost('dev-remote-box'), 'dev-remote-box');
  assert.equal(terminals.sanitizeMuxHost('alice@build-01.internal'), 'alice@build-01.internal');
  assert.equal(terminals.sanitizeMuxHost('-oProxyCommand=id'), null, '前导连字符选项注入必须拒绝');
  assert.equal(terminals.sanitizeMuxHost('bad;rm -rf'), null, '含空白与分号的 shell 注入必须拒绝');

  const muxMacPaths = new Set([
    '/Applications/Rex Beta.app',
    '/Applications/WezTerm.app',
    '/opt/homebrew/bin/tmux'
  ]);
  const detectedMux = terminals.detectAvailableTerminals({
    platform: 'darwin',
    existsSync: p => muxMacPaths.has(p),
    muxHosts: [
      { id: 'dev-mux-a', label: 'dev-mux-a', source: 'rex' },
      { id: 'dev-mux-b', label: 'dev-mux-b', source: 'wezterm' }
    ]
  });
  const termById = Object.fromEntries(detectedMux.terminals.map(t => [t.id, t]));
  assert.equal(termById.rex.supportsMuxHost, true);
  assert.equal(termById.wezterm.supportsMuxHost, true);
  assert.equal(termById.tmux.installed, true);
  assert.equal(termById.tmux.supportsMuxHost, true);
  assert.deepEqual(
    detectedMux.muxHosts.map(h => h.id),
    ['', 'dev-mux-a', 'dev-mux-b'],
    'muxHosts 应始终包含本机空值及探测到的远端主机'
  );

  const tmpCli = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req10-cli-'));
  try {
    const cliInfo = { command: 'agy', cliPath: 'agy', exePath: '/usr/local/bin/agy' };
    // Rex 本机：强制限定 remote is false / new session at，防止误入远端聚焦标签
    const rexLocal = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'rex',
      muxHost: '',
      cwd: tmpCli,
      cliInfo,
      cliArgs: ['--dangerously-skip-permissions'],
      dryRun: true,
      existsSync: p => p === '/Applications/Rex Beta.app' || p === tmpCli
    });
    assert.equal(rexLocal.ok, true);
    assert.equal(rexLocal.muxHost, '');
    const rexLocalScript = rexLocal.spawnSpec.args.join('\n');
    assert.ok(rexLocalScript.includes('every session whose remote is false'), 'Rex 本机模式应筛选 local session');
    assert.ok(rexLocalScript.includes('new session at'), 'Rex 无本机会话时应在本机创建新会话');

    // Rex 远端主机：指定 host name 并安全尝试切换存在目录后启动远端 agy
    const rexRemote = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'rex',
      muxHost: 'dev-mux-a',
      cwd: tmpCli,
      cliInfo,
      cliArgs: ['--model', 'gemini-4-carbon-high'],
      dryRun: true,
      existsSync: p => p === '/Applications/Rex Beta.app' || p === tmpCli
    });
    assert.equal(rexRemote.ok, true);
    assert.equal(rexRemote.muxHost, 'dev-mux-a');
    const rexRemoteScript = rexRemote.spawnSpec.args.join('\n');
    assert.ok(rexRemoteScript.includes('every session whose host name is \\"dev-mux-a\\"') || rexRemoteScript.includes('host name is "dev-mux-a"'));
    assert.ok(rexRemoteScript.includes('new session on "dev-mux-a" running'));
    assert.ok(rexRemoteScript.includes('command -v agy') && rexRemoteScript.includes('[ -d'));

    // WezTerm 远端 domain
    const wezRemote = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'wezterm',
      muxHost: 'dev-mux-b',
      cwd: tmpCli,
      cliInfo,
      dryRun: true,
      existsSync: p => p === '/Applications/WezTerm.app' || p === '/Applications/WezTerm.app/Contents/MacOS/wezterm' || p === tmpCli
    });
    assert.equal(wezRemote.ok, true);
    assert.deepEqual(wezRemote.spawnSpec.args.slice(0, 4), ['start', '--domain', 'dev-mux-b', '--']);

    // tmux 远端主机
    const tmuxRemote = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'tmux',
      muxHost: 'dev-mux-a',
      cwd: tmpCli,
      cliInfo,
      dryRun: true,
      existsSync: p => p === '/opt/homebrew/bin/tmux' || p === tmpCli
    });
    assert.equal(tmuxRemote.ok, true);
    assert.ok(tmuxRemote.spawnSpec.args.join('\n').includes("ssh -t 'dev-mux-a'"));

    // 非法主机名阻断
    const badHostRes = terminals.launchInConfiguredTerminal({
      platform: 'darwin',
      terminalApp: 'rex',
      muxHost: '-oProxyCommand=evil',
      cwd: tmpCli,
      cliInfo,
      dryRun: true,
      existsSync: p => p === '/Applications/Rex Beta.app' || p === tmpCli
    });
    assert.equal(badHostRes.ok, false);
    assert.equal(badHostRes.code, 'INVALID_MUX_HOST');

    // 设置面板下拉渲染探测主机并透传到 api.launchCli
    const envCli = createDomEnv({
      savedTerminalApp: 'rex',
      mockMuxHosts: [
        { id: '', label: '本机 (Local)', isLocal: true },
        { id: 'dev-mux-a', label: 'dev-mux-a', source: 'rex', isLocal: false }
      ]
    });
    vm.runInContext(RENDERER_SRC, envCli.sandbox);
    const apiCli = envCli.sandbox.__AGContextMeter;
    const shadowCli = envCli.getShadow();
    apiCli.openSettings('terminal');
    await new Promise(r => setTimeout(r, 20));

    const hostSel = shadowCli.getElementById('set-cli-mux-host-select');
    assert.ok(hostSel, '设置面板应渲染 #set-cli-mux-host-select 主机选择器');
    assert.ok(hostSel.options.some(o => o.value === 'dev-mux-a'), '主机选择器应包含自动探测到的远端主机');

    hostSel.value = 'dev-mux-a';
    hostSel.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(apiCli.getTerminalSettings().muxHost, 'dev-mux-a');
    assert.equal(envCli.localStorage.getItem('ag_suite_cli_mux_host'), 'dev-mux-a');

    await apiCli.launchCli({ workspacePath: tmpCli });
    assert.equal(envCli.cliRequests.at(-1)?.muxHost, 'dev-mux-a', 'launchCli 应透传选定的多路复用器主机名');

    apiCli.dispose?.();
  } finally {
    fs.rmSync(tmpCli, { recursive: true, force: true });
  }

  // 3. 输入框底部胶囊显示上下文占用率与缓存命中率双比例及对应图标
  const envCap = createDomEnv();
  envCap.sandbox.location.href = 'https://127.0.0.1:12345/';
  envCap.win.location = envCap.sandbox.location;
  const footerEl = envCap.doc.createElement('div');
  footerEl.className = 'agy-composer-footer';
  const permBtn = envCap.doc.createElement('button');
  permBtn.setAttribute('data-testid', 'permissions-selector-trigger');
  footerEl.appendChild(permBtn);
  envCap.doc.body.appendChild(footerEl);

  vm.runInContext(CAPSULE_SRC, envCap.sandbox);
  const capsApi = envCap.win.__AGY_CTX_CAPSULE_API__;
  assert.equal(capsApi.version, '1.5.0');

  capsApi.renderFooterCapsule(footerEl, {
    contextUsed: 181000,
    contextLimit: 512000,
    usagePercent: 35.35,
    cacheHitRate: 91.24,
    hasPreciseSnapshot: true,
    tokPerSec: 84,
    cacheReadTokens: 165000,
    inputTokens: 16000
  });

  const capBtn = footerEl.querySelector('[data-agy-context-capsule="1"]');
  assert.ok(capBtn, '底部输入框应渲染上下文胶囊按钮');
  assert.equal(capBtn.querySelector('.agy-ctx-label')?.textContent, '181k/512k');
  assert.ok(capBtn.querySelector('.agy-ctx-occ .agy-ctx-occ-icon'), '上下文占用率应附带对应 SVG 图标');
  assert.equal(capBtn.querySelector('.agy-ctx-occ .agy-ctx-occ-val')?.textContent, '35.4%');
  assert.ok(capBtn.querySelector('.agy-ctx-cache .agy-ctx-cache-icon'), '缓存命中率应附带对应 SVG 图标');
  assert.equal(capBtn.querySelector('.agy-ctx-cache .agy-ctx-cache-val')?.textContent, '91.2%');

  const occNode = capBtn.querySelector('.agy-ctx-occ');
  const cacheNode = capBtn.querySelector('.agy-ctx-cache');
  const childIdxOcc = capBtn.children.indexOf(occNode);
  const childIdxCache = capBtn.children.indexOf(cacheNode);
  assert.ok(childIdxOcc >= 0 && childIdxCache === childIdxOcc + 1, '缓存命中率必须位于上下文窗口占用率紧邻右侧');

  // 未产生首轮快照时显示 --%
  capsApi.renderFooterCapsule(footerEl, {
    contextUsed: 0,
    contextLimit: 256000,
    usagePercent: 0,
    cacheHitRate: 0,
    hasPreciseSnapshot: false,
    tokPerSec: 0,
    cacheReadTokens: 0,
    inputTokens: 0
  });
  assert.equal(capBtn.querySelector('.agy-ctx-cache .agy-ctx-cache-val')?.textContent, '--%');

  envCap.win.__AGY_CTX_CAPSULE_DISPOSE__();
});

// =========================================================================
// 需求 14: Cloudflare Token 直达入口 + ASAR 全组件随宿主自启 + 2.32.1 DOM 兼容
// =========================================================================
test('需求 14: Cloudflare Token 入口、ASAR 全组件打包自注与 Antigravity 2.32.1 DOM 兼容', async () => {
  // 1. #ag-remote-popover 固定域名表单渲染 #ag-rp-cf-get-token 并跳转 Cloudflare
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req11-cf-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const { saveRemoteTunnelConfig, buildRemoteInfo } = require('./mobile-remote.js');
    saveRemoteTunnelConfig({ enabled: false, enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: false } });
    const initInfo = buildRemoteInfo({ tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true } });

    const openedExternal = [];
    const tunnelPosts = [];
    const env = createDomEnv();
    env.win.__AGContextMeterLive = { port: 61231, token: 'tok-req11' };
    env.sandbox.fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        tunnelPosts.push(body);
        return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
      }
      if (String(url).includes('/open-external-url')) {
        openedExternal.push(body);
        return { ok: true, json: async () => ({ ok: true, url: body.url }) };
      }
      if (String(url).includes('/localize-conversations')) {
        const titles = {};
        for (const it of (body.items || [])) {
          titles[it.id] = `已翻译: ${it.title}`;
        }
        return { ok: true, json: async () => ({ ok: true, titles }) };
      }
      return { ok: false, json: async () => ({}) };
    };

    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    const enhancer = env.sandbox.__AGEnhancer;
    const remotePop = env.getShadow().getElementById('ag-remote-popover');

    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    remotePop.querySelector('#ag-rp-tunnel-cfg-btn')?.click();

    const cfLink = remotePop.querySelector('#ag-rp-cf-get-token');
    assert.ok(cfLink, '固定域名表单应渲染 #ag-rp-cf-get-token 入口');
    assert.equal(
      cfLink.getAttribute('href'),
      'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels',
      'Cloudflare Token 链接应指向 Zero Trust 隧道控制台'
    );
    assert.match(cfLink.textContent || '', /Cloudflare.*Token/);

    cfLink.click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(openedExternal.length, 1, '点击入口应通过 /open-external-url 打开系统浏览器');
    assert.equal(openedExternal[0]?.url, 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels');
    assert.equal(remotePop.hidden, false, '点击获取 Token 不应关闭远程配对浮窗');
    assert.equal(tunnelPosts.length, 0, '点击获取 Token 不得误发 /remote-tunnel 请求');

    // 切换英文界面文案校验
    env.win.dispatchEvent({ type: 'ag-suite-prefs-changed', detail: { locale: 'en', hansCode: 'en', capsuleLang: 'en' } });
    assert.match(remotePop.querySelector('#ag-rp-cf-get-token')?.textContent || '', /Get Token on Cloudflare/);
    env.win.dispatchEvent({ type: 'ag-suite-prefs-changed', detail: { locale: 'zh-CN', hansCode: 'zh', capsuleLang: 'zh' } });

    // 2. 2.32.1 DOM 兼容：无 data-cascade-id 仅含 <a href="/c/..."> 的侧边栏行 + <h5 class="sr-only">You said</h5> 用户消息
    const row = env.doc.createElement('div');
    row.setAttribute('data-testid', 'conversation-row-sidebar');
    const rowLink = env.doc.createElement('a');
    rowLink.setAttribute('href', '/c/12345678-1111-2222-3333-444455556666');
    const rowSpan = env.doc.createElement('span');
    rowSpan.className = 'truncate inline-block w-full';
    rowSpan.textContent = 'Refactor Authentication Flow Quickly';
    row.appendChild(rowLink);
    row.appendChild(rowSpan);
    env.doc.body.appendChild(row);

    const locCount = await enhancer.localizeSidebarConversations();
    assert.equal(locCount, 1, '无 data-cascade-id 时应从 a[href="/c/..."] 提取 ID 并完成侧边栏汉化');
    assert.equal(rowSpan.textContent, '已翻译: Refactor Authentication Flow Quickly');

    const viewport = env.doc.createElement('div');
    viewport.setAttribute('data-testid', 'autoscroll-viewport');
    const userMsg = env.doc.createElement('div');
    userMsg.setAttribute('data-testid', 'user-message');
    const srOnly = env.doc.createElement('h5');
    srOnly.className = 'sr-only';
    srOnly.textContent = 'You said';
    const userBody = env.doc.createElement('div');
    userBody.setAttribute('data-testid', 'user-message-content');
    userBody.textContent = 'Check build status';
    userMsg.appendChild(srOnly);
    userMsg.appendChild(userBody);
    viewport.appendChild(userMsg);
    env.doc.body.appendChild(viewport);

    const snap = enhancer.getMobileSnapshot();
    assert.equal(snap.conversations[0]?.id, '12345678-1111-2222-3333-444455556666');
    assert.equal(snap.messages[0]?.text, 'Check build status', '2.32.1 user-message 应只提取 user-message-content 不拼接 You said');

    enhancer.dispose?.();
    api.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }

  // 3. 验证 install() 将全量挂件与桥接脚本打包进目标 ASAR，且 meter-main.ensureMeterInjected 全量注入
  const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req11-asar-'));
  const prevAppData2 = process.env.APPDATA;
  const prevStateDir2 = process.env.AG_METER_STATE_DIR;
  const prevTestMode = process.env.AG_METER_TEST_MODE;
  try {
    process.env.APPDATA = tmpInstall;
    process.env.AG_METER_STATE_DIR = tmpInstall;
    process.env.AG_METER_TEST_MODE = '1';

    const { builtinAsar } = require('./asar-engine');
    const { install } = require('./install');
    const { ensureMeterInjected } = require('./meter-main');

    const mockSrc = path.join(tmpInstall, 'mock-app');
    fs.mkdirSync(path.join(mockSrc, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mockSrc, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.1' }));
    fs.writeFileSync(path.join(mockSrc, 'dist', 'utils.js'), '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager, options) {\n    void win.loadURL(url);\n}\n');
    fs.writeFileSync(path.join(mockSrc, 'dist', 'preload.js'), '"use strict";\n');
    const mockAsar = path.join(tmpInstall, 'app.asar');
    await builtinAsar.createPackageWithOptions(mockSrc, mockAsar, {});

    const manifest = await install({ path: mockAsar });
    for (const file of [
      'dist/ag-enhancer-overlay.js',
      'dist/pulse-capsule-overlay.js',
      'dist/antigravity-hans-overlay.js',
      'dist/live-host.js',
      'dist/mobile-remote.js',
      'dist/meter-enhance.js'
    ]) {
      assert.ok(manifest.added.includes(file), `manifest.added 应包含 ${file}`);
      const buf = builtinAsar.extractFile(mockAsar, file.replace(/^dist\//, 'dist/'));
      assert.ok(buf && buf.length > 0, `ASAR 内应存在非空文件 ${file}`);
    }

    const injectedScripts = [];
    const mockWc = {
      isDestroyed: () => false,
      getURL: () => 'https://127.0.0.1:54321/c/test',
      executeJavaScript: async (expr) => {
        injectedScripts.push(String(expr));
        if (String(expr).includes('meterAlive:')) {
          return { meterAlive: false, liveAlive: true, hansAlive: false, pulseAlive: false, enhancerAlive: false };
        }
        return true;
      }
    };
    const mockWin = {
      isDestroyed: () => false,
      webContents: mockWc
    };
    const ok = await ensureMeterInjected(mockWin, { force: false });
    assert.equal(ok, true, 'ensureMeterInjected 应成功完成全组件注入');
    assert.ok(injectedScripts.some(s => s.includes('__AGContextMeter')), '应注入主监控脚本');
    assert.ok(injectedScripts.some(s => s.includes('__antigravityZhPatchInstalled')), '应注入全量汉化脚本');
    assert.ok(injectedScripts.some(s => s.includes('__AGY_CTX_CAPSULE_ACTIVE__')), '应注入底部胶囊脚本');
    assert.ok(injectedScripts.some(s => s.includes('__AGEnhancer')), '应注入增强挂件脚本');
  } finally {
    if (prevAppData2 === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData2;
    if (prevStateDir2 === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir2;
    if (prevTestMode === undefined) delete process.env.AG_METER_TEST_MODE;
    else process.env.AG_METER_TEST_MODE = prevTestMode;
    fs.rmSync(tmpInstall, { recursive: true, force: true });
  }

  // 4. antigravity-hans-overlay 在 2.32.1 agent-response 下保护 Markdown 正文、翻译步骤按钮
  const hansSrc = fs.readFileSync(path.join(ROOT, 'antigravity-hans-overlay.js'), 'utf8');
  const envH = createDomEnv();
  envH.sandbox.location.pathname = '/c/test-hans';
  envH.sandbox.location.href = 'https://127.0.0.1:12345/c/test-hans';
  envH.win.location = envH.sandbox.location;
  envH.win.top = envH.win;
  envH.sandbox.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
  envH.sandbox.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 };
  envH.doc.createTreeWalker = (rootNode, whatToShow) => {
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      const children = n.childNodes || n.children || [];
      for (const ch of children) {
        if ((ch.nodeType === 1 && (whatToShow & 1)) || (ch.nodeType === 3 && (whatToShow & 4))) {
          flat.push(ch);
        }
        walk(ch);
      }
    };
    walk(rootNode);
    let idx = 0;
    return { nextNode: () => (idx < flat.length ? flat[idx++] : null) };
  };
  const agentResp = envH.doc.createElement('div');
  agentResp.setAttribute('data-testid', 'agent-response');
  const thinkBtn = envH.doc.createElement('button');
  thinkBtn.setAttribute('data-testid', 'thinking-collapsible-trigger');
  const thinkText = {
    nodeType: 3,
    nodeValue: 'Thought Process',
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    parentElement: thinkBtn
  };
  thinkBtn.childNodes.push(thinkText);
  const mdRoot = envH.doc.createElement('div');
  mdRoot.setAttribute('data-markdown-root', '');
  const mdP = envH.doc.createElement('p');
  const mdText = {
    nodeType: 3,
    nodeValue: 'Settings',
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    parentElement: mdP
  };
  mdP.childNodes.push(mdText);
  mdRoot.appendChild(mdP);
  agentResp.appendChild(thinkBtn);
  agentResp.appendChild(mdRoot);
  envH.doc.body.appendChild(agentResp);

  vm.runInContext(hansSrc, envH.sandbox);
  assert.equal(thinkText.nodeValue, '思考过程', '2.32.1 agent-response 内的思考折叠按钮应正常汉化');
  assert.equal(mdText.nodeValue, 'Settings', '2.32.1 agent-response 内的 data-markdown-root 正文应受保护不被汉化改写');

  // 5. 表单输入框与下拉框高度/圆角统一规范为 28px / 5px，且紧凑徽章保持 height:auto
  const builtRenderer = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
  assert.match(builtRenderer, /\.ag-dropdown-trigger\{[^}]*height:28px;min-height:28px;/);
  assert.match(builtRenderer, /#plan-custom-form input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\s*#plan-custom-form select,\s*\.unlock-input\{[^}]*height:28px;\s*min-height:28px;/);
  assert.match(builtRenderer, /\.settings-input\{[^}]*height:28px;\s*min-height:28px;/);
  assert.match(builtRenderer, /\.ag-subtier-compact-trigger\{[^}]*height:auto;\s*min-height:0;/);
  for (const inputId of [
    'input-custom-acq-name',
    'input-custom-country',
    'input-custom-region',
    'input-custom-paid',
    'input-valid-end',
    'input-custom-note',
    'input-proxy-url',
    'input-proxy-bypass'
  ]) {
    const tagMatch = builtRenderer.match(new RegExp(`<input[^>]*id="${inputId}"[^>]*>`));
    assert.ok(tagMatch, `RENDERER_SRC 应包含 #${inputId}`);
    assert.ok(tagMatch[0].includes('height:28px'), `#${inputId} 应设置 height:28px`);
    assert.ok(tagMatch[0].includes('border-radius:5px'), `#${inputId} 应设置 border-radius:5px`);
  }

  // 6. tryHotInject({ onlyMissing: true }) 当主监控 __AGContextMeter 已存活时绝不重绘主看板导致浮窗关闭
  const installSrc = fs.readFileSync(path.join(ROOT, 'install.js'), 'utf8');
  const baseOkIdx = installSrc.indexOf('if (baseOk?.result?.result?.value === true)');
  assert.ok(baseOkIdx > 0, 'install.js tryHotInject 应校验 baseOk');
  const baseOkSlice = installSrc.slice(baseOkIdx, baseOkIdx + 420);
  assert.match(baseOkSlice, /\n\s*continue;\s*\n\s*\}/, 'baseOk 为 true 时无论 enhancer 注入结果都应直接 continue，禁止重跑 bundle 关闭浮窗');
});

// =========================================================================
// 需求 15: Cloudflare Tunnel Token/Hostname 预校验、表单错误保留与免登录快速切换加载验证
// =========================================================================
test('需求 15: Cloudflare Tunnel Token/Hostname 预校验、表单错误保留与免登录快速切换加载验证', async () => {
  const os = require('node:os');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-token-fix-test-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      extractCloudflareTunnelToken,
      validateCloudflareTunnelToken,
      validateTunnelHostname,
      normalizeTunnelHostname,
      saveRemoteTunnelConfig,
      loadOrCreateRemoteConfig,
      createCloudflareTunnelController,
      buildRemoteInfo
    } = require('./mobile-remote.js');

    // 1. 标准 Base64 (+ / =) 与 URL-safe (- _) Token 提取和预校验
    const stdToken = Buffer.from(
      JSON.stringify({ a: 'acct?>~', t: 'tun?>1', s: 'sec+/' }),
      'utf8'
    ).toString('base64');
    assert.ok(stdToken.includes('+') || stdToken.includes('/'), '构造的测试 Token 应包含标准 Base64 字符 + 或 /');
    assert.equal(
      extractCloudflareTunnelToken(`cloudflared.exe service install ${stdToken}`),
      stdToken,
      'extractCloudflareTunnelToken 应完整保留 + / = 而不截断'
    );
    assert.equal(validateCloudflareTunnelToken(`sudo cloudflared service install ${stdToken}`).ok, true);

    const urlSafeToken = stdToken.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const urlSafeExtracted = extractCloudflareTunnelToken(urlSafeToken);
    assert.equal(urlSafeExtracted, stdToken, '单段 URL-safe Token 应规范化为带 = 填充的标准 Base64');
    assert.equal(validateCloudflareTunnelToken(urlSafeToken).ok, true);

    const validJwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ a: '1', t: '2', s: '3' })).toString('base64url'),
      'sigPart1234'
    ].join('.');
    assert.equal(validateCloudflareTunnelToken(validJwt).ok, true, '2/3 段合法 JWT 应通过预校验');

    // 异常 Token 校验
    assert.equal(validateCloudflareTunnelToken('').ok, false);
    assert.equal(validateCloudflareTunnelToken('not-a-token').ok, false);
    assert.equal(validateCloudflareTunnelToken('eyJ1234567890').ok, false, 'len%4===1 的截断 Token 应被拒绝');
    const missingFieldsToken = Buffer.from(JSON.stringify({ a: 'only-account' }), 'utf8').toString('base64');
    const missingRes = validateCloudflareTunnelToken(missingFieldsToken);
    assert.equal(missingRes.ok, false);
    assert.match(missingRes.error, /a\/t\/s/);

    // 2. configure() 在校验失败时不覆盖已保存的合法 Token / Hostname
    saveRemoteTunnelConfig({
      enabled: false,
      tunnelMode: 'named',
      tunnelHostname: 'https://ag.example.com',
      tunnelToken: stdToken
    });
    const ctrl = createCloudflareTunnelController(() => 18765);
    const badTokStatus = await ctrl.configure({
      enabled: true,
      tunnelMode: 'named',
      tunnelHostname: 'https://ag.example.com',
      tunnelToken: 'eyJbroken_truncated'
    });
    assert.equal(badTokStatus.state, 'error', '非法 Token 应同步返回 error 状态');
    assert.match(badTokStatus.error, /Base64 JSON|未能识别|缺少必要字段/);
    assert.equal(loadOrCreateRemoteConfig().tunnelToken, stdToken, '校验失败时不得覆盖已保存的合法 Token');
    assert.equal(loadOrCreateRemoteConfig().tunnelHostname, 'https://ag.example.com');

    const badHostStatus = await ctrl.configure({
      enabled: true,
      tunnelMode: 'named',
      tunnelHostname: 'http://insecure.example.com'
    });
    assert.equal(badHostStatus.state, 'error');
    assert.match(badHostStatus.error, /HTTPS|固定域名/);
    assert.equal(loadOrCreateRemoteConfig().tunnelHostname, 'https://ag.example.com', '非法域名不得覆盖已保存的域名');

    // *.cloudflareaccess.com / dash.cloudflare.com / *.trycloudflare.com 误填防护
    const accessCheck = validateTunnelHostname('https://hubo1989.cloudflareaccess.com');
    assert.equal(accessCheck.ok, false);
    assert.match(accessCheck.error, /cloudflareaccess\.com/);
    assert.match(accessCheck.error, /NoAuth/);
    assert.equal(normalizeTunnelHostname('https://hubo1989.cloudflareaccess.com'), '');
    assert.equal(validateTunnelHostname('https://one.dash.cloudflare.com').ok, false);
    assert.equal(validateTunnelHostname('https://abc.trycloudflare.com').ok, false);

    const accessStatus = await ctrl.configure({
      enabled: true,
      tunnelMode: 'named',
      tunnelHostname: 'https://hubo1989.cloudflareaccess.com',
      tunnelToken: stdToken
    });
    assert.equal(accessStatus.state, 'error');
    assert.match(accessStatus.error, /cloudflareaccess\.com/);
    assert.match(accessStatus.error, /NoAuth/);
    assert.equal(loadOrCreateRemoteConfig().tunnelHostname, 'https://ag.example.com', '误填 cloudflareaccess.com 不得覆盖已保存域名');

    // 3. UI 表单保存失败时保持展开并保留草稿、显示错误；成功后收起并清空草稿
    const env = createDomEnv();
    env.win.__AGContextMeterLive = { port: 61220, token: 'tok-ui-test' };
    const initInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: { enabled: false, state: 'stopped', mode: 'quick', binaryAvailable: true }
    });
    env.sandbox.fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        if (body.tunnelMode === 'named') {
          const check = validateCloudflareTunnelToken(body.tunnelToken || '');
          if (!check.ok) {
            return {
              ok: true,
              json: async () => ({
                ok: true,
                data: buildRemoteInfo({
                  resetToken: false,
                  tunnelStatus: {
                    enabled: true,
                    mode: 'named',
                    state: 'error',
                    error: check.error,
                    binaryAvailable: true
                  }
                })
              })
            };
          }
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: buildRemoteInfo({
                resetToken: false,
                tunnelStatus: {
                  enabled: true,
                  mode: 'named',
                  state: 'running',
                  publicUrl: body.tunnelHostname || 'https://ag.example.com',
                  error: '',
                  binaryAvailable: true
                }
              })
            })
          };
        }
        return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
      }
      return { ok: false, json: async () => ({}) };
    };

    vm.runInContext(RENDERER_SRC, env.sandbox);
    const api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    const enhancer = env.sandbox.__AGEnhancer;
    const shadow = env.getShadow();
    const remotePop = shadow.getElementById('ag-remote-popover');

    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    remotePop.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(remotePop.querySelector('#ag-rp-tunnel-form'), '应展开固定域名表单');

    remotePop.querySelector('#ag-rp-cf-host').value = 'https://draft.example.com';
    remotePop.querySelector('#ag-rp-cf-token').value = 'eyJbad_token_draft';
    remotePop.querySelector('#ag-rp-cf-save')?.click();
    await new Promise(r => setTimeout(r, 30));

    assert.ok(remotePop.querySelector('#ag-rp-tunnel-form'), '保存报错时表单必须保持展开，不得自动折叠');
    assert.equal(remotePop.querySelector('#ag-rp-cf-host')?.value, 'https://draft.example.com', '保存报错后应保留域名草稿');
    assert.equal(remotePop.querySelector('#ag-rp-cf-token')?.value, 'eyJbad_token_draft', '保存报错后应保留 Token 草稿');
    assert.ok(remotePop.querySelector('.ag-rp-err')?.textContent, '保存报错后应在表单下方显示错误提示');

    // 修正为合法 Token 后重试保存应成功并自动收起、清空草稿
    remotePop.querySelector('#ag-rp-cf-token').value = stdToken;
    remotePop.querySelector('#ag-rp-cf-save')?.click();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(remotePop.querySelector('#ag-rp-tunnel-form'), null, '保存成功后应自动收起配置表单');
    remotePop.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.equal(remotePop.querySelector('#ag-rp-cf-token')?.value, '', '保存成功后重新展开不应残留明文 Token 草稿');

    // 验证弹窗关闭会清理草稿
    remotePop.querySelector('#ag-rp-cf-token').value = 'temp-draft-tok';
    remotePop.querySelector('#ag-rp-cf-token')?.dispatchEvent({ type: 'input', target: { value: 'temp-draft-tok' } });
    enhancer.toggleRemotePopover(false);
    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 20));
    remotePop.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.equal(remotePop.querySelector('#ag-rp-cf-token')?.value, '', '关闭弹窗应清空未提交的 Token 草稿');

    enhancer.dispose?.();
    api.dispose?.();

    // 4. 验证从误填 cloudflareaccess.com 点击「改用免登录临时隧道」时的慢请求加载状态与旧地址屏蔽
    const envQ = createDomEnv();
    envQ.win.__AGContextMeterLive = { port: 61221, token: 'tok-quick-switch' };
    const staleNamedInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: {
        enabled: true,
        mode: 'named',
        state: 'running',
        publicUrl: 'https://hubo1989.cloudflareaccess.com',
        error: '',
        binaryAvailable: true
      }
    });
    staleNamedInfo.tunnelHostname = 'https://hubo1989.cloudflareaccess.com';
    const staleTunnelCh = staleNamedInfo.channels.find((c) => c.key === 'tunnel');
    if (staleTunnelCh) {
      staleTunnelCh.enabled = true;
      staleTunnelCh.available = true;
      staleTunnelCh.displayHost = 'hubo1989.cloudflareaccess.com';
      staleTunnelCh.tunnelHostname = 'https://hubo1989.cloudflareaccess.com';
    }
    saveRemoteTunnelConfig({ enabled: true, tunnelMode: 'quick' });
    const quickReadyInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: {
        enabled: true,
        mode: 'quick',
        state: 'running',
        publicUrl: 'https://demo-quick.trycloudflare.com',
        error: '',
        binaryAvailable: true
      }
    });
    let resolveQuickReq = null;
    envQ.sandbox.fetch = async (url, init) => {
      if (String(url).includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: staleNamedInfo }) };
      }
      if (String(url).includes('/remote-tunnel')) {
        return await new Promise((resolve) => {
          resolveQuickReq = resolve;
        });
      }
      return { ok: false, json: async () => ({}) };
    };
    vm.runInContext(RENDERER_SRC, envQ.sandbox);
    const apiQ = envQ.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, envQ.sandbox);
    const enhQ = envQ.sandbox.__AGEnhancer;
    const popQ = envQ.getShadow().getElementById('ag-remote-popover');

    enhQ.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 30));
    popQ.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(popQ.querySelector('#ag-rp-tunnel-form'));

    popQ.querySelector('#ag-rp-cf-quick')?.click();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(popQ.querySelector('#ag-rp-tunnel-form'), '临时隧道协商期间应保持表单展开以展示加载动画');
    assert.ok(popQ.querySelector('#ag-rp-cf-quick .ag-rp-spin'), '切换按钮应渲染 .ag-rp-spin 加载动画');
    const toggleHostText = popQ.querySelector('#ag-rp-tunnel-toggle')?.textContent || '';
    assert.ok(toggleHostText.includes('正在切换临时隧道'), '通道行应显示正在切换临时隧道');
    assert.ok(!toggleHostText.includes('hubo1989.cloudflareaccess.com'), '切换期间通道行不得继续显示旧的 cloudflareaccess.com');

    resolveQuickReq({ ok: true, json: async () => ({ ok: true, data: quickReadyInfo }) });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(popQ.querySelector('#ag-rp-tunnel-form'), null, '临时隧道就绪后应自动收起表单');
    assert.ok(
      (popQ.querySelector('#ag-rp-tunnel-toggle')?.textContent || '').includes('demo-quick.trycloudflare.com'),
      '临时隧道就绪后通道行应更新为 *.trycloudflare.com 地址'
    );

    enhQ.dispose?.();
    apiQ.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 16: 远程网页端支持跟随系统、固定浅色、固定深色三态外观切换与实时同步
// =========================================================================
test('需求 16: 远程网页端支持跟随系统、固定浅色、固定深色三态外观切换与实时同步', async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-theme-'));
  const prevAppData = process.env.APPDATA;
  const prevMeterStateDir = process.env.AG_METER_STATE_DIR;
  const prevContextStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    process.env.AG_CONTEXT_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      buildMobileAppHtml,
      createRemoteHttpHandler,
      loadOrCreateRemoteConfig
    } = require('./mobile-remote.js');

    const html = buildMobileAppHtml();
    assert.ok(html.includes('id="ag-theme-boot"'), '应包含防首屏闪烁主题引导脚本 #ag-theme-boot');
    assert.ok(html.includes('id="meta-theme-color"'), '应包含可动态更新的 #meta-theme-color');
    assert.equal(html.includes('id="btn-theme"'), false, '顶栏右上角应移除 #btn-theme，统一收口到侧边栏');
    assert.equal(html.includes('id="theme-mode-hint"'), false, '侧边栏应去除多余的外观文字提示 #theme-mode-hint');
    assert.ok(html.includes('id="theme-seg"'), '侧边栏/抽屉底部应包含三段式纯图标外观切换器 #theme-seg');
    assert.ok(html.includes('data-theme-mode="system"') && html.includes('data-theme-mode="light"') && html.includes('data-theme-mode="dark"'),
      '应同时提供跟随系统、固定浅色、固定深色三个选项');
    assert.ok(html.includes('html[data-theme="light"]') && html.includes('@media (prefers-color-scheme:light)'),
      '样式表应同时支持 prefers-color-scheme 自动适配与 html[data-theme="light"] 强制覆盖');
    assert.ok(/\.mode-entry-card\{[^}]*background:var\(--card\)/.test(html),
      '连接通道引导卡片 .mode-entry-card 应使用主题变量 background:var(--card) 兼容浅色模式');

    const bootMatch = html.match(/<script id="ag-theme-boot">([\s\S]*?)<\/script>/);
    const bodyMatch = html.match(/<body>([\s\S]*?)<script>/);
    const mainMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(bootMatch && bodyMatch && mainMatch, '应可提取主题引导脚本、Body HTML 与主脚本');
    for (const hex of ['#fca5a5', '#bae6fd', '#fbbf24']) {
      assert.ok(!bodyMatch[1].includes(hex) && !mainMatch[1].includes(hex),
        `HTML 正文与交互脚本不应残留硬编码颜色 ${hex}`);
    }
    assert.doesNotThrow(() => new vm.Script(bootMatch[1]), '#ag-theme-boot 必须通过语法校验');
    assert.doesNotThrow(() => new vm.Script(mainMatch[1]), '远程端主 <script> 必须通过语法校验');

    // 验证 401 未授权页同样支持系统浅色模式
    const cfg = loadOrCreateRemoteConfig({ resetToken: true });
    const handler = createRemoteHttpHandler({ port: cfg.port, token: cfg.token });
    let html401 = '';
    await handler(
      { method: 'GET', url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      {
        setHeader() {},
        writeHead() {},
        end(chunk) { if (chunk) html401 += String(chunk); }
      }
    );
    assert.ok(html401.includes('@media (prefers-color-scheme:light)'), '401 引导页应适配系统浅色模式');

    // 在 VM DOM 环境验证首屏引导、系统联动、三态切换与弹窗选择
    const env = createDomEnv();
    const metaTheme = env.doc.createElement('meta');
    metaTheme.id = 'meta-theme-color';
    metaTheme.setAttribute('name', 'theme-color');
    metaTheme.setAttribute('content', '#09090b');
    env.doc.head.appendChild(metaTheme);
    env.doc.body.innerHTML = bodyMatch[1];

    let isSystemLight = false;
    const schemeListeners = [];
    const mockMatchMedia = (query) => {
      if (String(query).includes('prefers-color-scheme: light')) {
        return {
          get matches() { return isSystemLight; },
          addEventListener(type, fn) { if (type === 'change') schemeListeners.push(fn); },
          removeEventListener(type, fn) {
            const idx = schemeListeners.indexOf(fn);
            if (idx >= 0) schemeListeners.splice(idx, 1);
          }
        };
      }
      return { matches: true, addEventListener() {} };
    };
    const setSystemLight = (nextVal) => {
      isSystemLight = Boolean(nextVal);
      for (const fn of [...schemeListeners]) fn({ matches: isSystemLight });
    };

    env.win.matchMedia = mockMatchMedia;
    env.sandbox.matchMedia = mockMatchMedia;
    env.sandbox.URLSearchParams = URLSearchParams;
    env.sandbox.history = { replaceState() {} };
    env.sandbox.location = {
      search: '',
      origin: 'http://127.0.0.1:18765',
      pathname: '/',
      port: '18765',
      protocol: 'http:',
      reload() {}
    };
    env.sandbox.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, title: 'Theme Test', messages: [], conversations: [], quota: {} })
    });

    vm.runInContext(bootMatch[1], env.sandbox);
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(env.doc.documentElement.getAttribute('data-theme-pref'), 'system');
    assert.equal(metaTheme.getAttribute('content'), '#09090b');

    vm.runInContext(mainMatch[1], env.sandbox);
    await new Promise((r) => setTimeout(r, 10));

    const segSystem = env.doc.querySelector('button[data-theme-mode="system"]');
    const segLight = env.doc.querySelector('button[data-theme-mode="light"]');
    const segDark = env.doc.querySelector('button[data-theme-mode="dark"]');
    assert.equal(env.doc.getElementById('btn-theme'), null, '对话顶栏不应再包含外观按钮');
    assert.equal(env.doc.getElementById('theme-mode-hint'), null, '侧边栏底部不应包含状态文字');
    assert.equal(env.doc.querySelector('.drawer-footer-head'), null, '侧边栏底部不应包含标题文字行');
    assert.ok(segSystem && segLight && segDark, '侧边栏三态外观纯图标切换控件应完整渲染');
    for (const btn of [segSystem, segLight, segDark]) {
      assert.ok(btn.querySelector('svg'), '外观按钮应包含 SVG 图标');
      assert.equal((btn.textContent || '').trim(), '', '外观按钮应仅保留图标，不附带文字');
      assert.ok((btn.getAttribute('aria-label') || '').length > 0, '纯图标外观按钮应保留无障碍标签');
    }
    assert.equal(segSystem.classList.contains('active'), true);
    assert.equal(segSystem.getAttribute('aria-checked'), 'true');

    // 1. 跟随系统状态下 OS 切到浅色与深色应实时同步
    setSystemLight(true);
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(metaTheme.getAttribute('content'), '#f8fafc');

    setSystemLight(false);
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(metaTheme.getAttribute('content'), '#09090b');

    // 2. 在系统深色下切到「固定浅色」应持久化并无视系统变化
    segLight.click();
    assert.equal(env.localStorage.getItem('ag_remote_theme_v1'), 'light');
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(env.doc.documentElement.getAttribute('data-theme-pref'), 'light');
    assert.equal(segLight.getAttribute('aria-checked'), 'true');
    assert.equal(segSystem.getAttribute('aria-checked'), 'false');
    assert.equal(metaTheme.getAttribute('content'), '#f8fafc');
    setSystemLight(true);
    setSystemLight(false);
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'light', '固定浅色时不应受系统变化影响');

    // 3. 在系统浅色下切到「固定深色」应持久化并无视系统变化
    setSystemLight(true);
    segDark.click();
    assert.equal(env.localStorage.getItem('ag_remote_theme_v1'), 'dark');
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(env.doc.documentElement.getAttribute('data-theme-pref'), 'dark');
    assert.equal(segDark.getAttribute('aria-checked'), 'true');
    assert.equal(metaTheme.getAttribute('content'), '#09090b');

    // 4. 在系统浅色下点击「跟随系统」图标切回系统联动，应立即呈现浅色
    segSystem.click();
    assert.equal(env.localStorage.getItem('ag_remote_theme_v1'), 'system');
    assert.equal(env.doc.documentElement.getAttribute('data-theme-pref'), 'system');
    assert.equal(segSystem.getAttribute('aria-checked'), 'true');
    assert.equal(env.doc.documentElement.getAttribute('data-theme'), 'light', '当前系统为浅色时恢复跟随应立即呈现浅色');
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevMeterStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevMeterStateDir;
    if (prevContextStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevContextStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 17: Antigravity v2.33.0+ 裸进程识别、运行时长解析与调试参数探测
// =========================================================================
test('需求 17: parsePsElapsedSeconds 与 inspectAntigravityHostProcess 准确识别裸进程与调试端口参数', () => {
  const { parsePsElapsedSeconds, inspectAntigravityHostProcess } = require('./asar-engine');

  assert.equal(parsePsElapsedSeconds('00:08'), 8);
  assert.equal(parsePsElapsedSeconds('15:55'), 15 * 60 + 55);
  assert.equal(parsePsElapsedSeconds('01:02:03'), 3723);
  assert.equal(parsePsElapsedSeconds('2-00:01:05'), 2 * 86400 + 65);
  assert.equal(parsePsElapsedSeconds('invalid'), null);

  const barePs = [
    '81197 15:40 /Applications/Antigravity.app/Contents/Resources/bin/language_server',
    '81368 15:42 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer)',
    '81122 00:07 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  ].join('\n');
  const bareRes = inspectAntigravityHostProcess({ psOutput: barePs });
  assert.equal(bareRes.running, true);
  assert.equal(bareRes.pid, 81122);
  assert.equal(bareRes.hasDebugSwitch, false);
  assert.equal(bareRes.elapsedSec, 7);

  const cdpPs = [
    '90012 01:12 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0'
  ].join('\n');
  const cdpRes = inspectAntigravityHostProcess({ psOutput: cdpPs });
  assert.equal(cdpRes.running, true);
  assert.equal(cdpRes.pid, 90012);
  assert.equal(cdpRes.hasDebugSwitch, true);
  assert.equal(cdpRes.elapsedSec, 72);

  const helperOnly = '81368 00:05 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper';
  assert.deepEqual(inspectAntigravityHostProcess({ psOutput: helperOnly }), {
    running: false,
    pid: null,
    hasDebugSwitch: false,
    elapsedSec: null,
    command: ''
  });
});

// =========================================================================
// 需求 18: 长上下文 Prompt Cache 脱落 (cache=0) 归零修真与 328K 雪崩预警联动
// =========================================================================
test('需求 18: meter-core 修复 cache=0 掩盖，pulse-capsule 与 renderer 识别缓存脱落及 328K 雪崩线', async () => {
  // 1. meter-core summarize: 当新请求返回真实输入且 cacheReadTokens=0 时，严禁沿用 prevContext.cached
  const dropSummary = core.summarize({
    chatModel: {
      model: 'gemini-4-carbon-medium',
      usage: { inputTokens: 334262, cacheReadTokens: 0, outputTokens: 800 },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
    }
  }, {
    previousValidContext: { used: 330000, actual: 330000, cached: 327727, budget: 512000 }
  });
  assert.equal(dropSummary.cached, 0, 'hasInput 且 cacheReadTokens=0 时 cached 必须真实归零，禁止沿用 prevContext.cached');
  assert.equal(dropSummary.uncachedInput, 334262);
  assert.equal(dropSummary.cacheHitRate, 0);
  assert.equal(dropSummary.input, 334262);

  // 2. pulse-capsule-overlay: analyzeSteps 与 renderFooterCapsule / tooltip 缓存脱落及 328K 雪崩线联动
  const envCap = createDomEnv();
  envCap.sandbox.location.href = 'https://127.0.0.1:12345/';
  envCap.win.location = envCap.sandbox.location;
  const footerEl = envCap.doc.createElement('div');
  footerEl.className = 'agy-composer-footer';
  const permBtn = envCap.doc.createElement('button');
  permBtn.setAttribute('data-testid', 'permissions-selector-trigger');
  footerEl.appendChild(permBtn);
  envCap.doc.body.appendChild(footerEl);

  vm.runInContext(CAPSULE_SRC, envCap.sandbox);
  const capsApi = envCap.win.__AGY_CTX_CAPSULE_API__;
  assert.equal(typeof capsApi.analyzeSteps, 'function');

  const uDrop = capsApi.analyzeSteps([
    {
      metadata: {
        modelUsage: { model: 'gemini-4-carbon-medium', inputTokens: '2163', cacheReadTokens: '327727', outputTokens: '500' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    },
    {
      metadata: {
        modelUsage: { model: 'gemini-4-carbon-medium', inputTokens: '334262', cacheReadTokens: '0', outputTokens: '400' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    }
  ], 'gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)', 2);
  assert.equal(uDrop.cacheDropDetected, true);
  assert.equal(uDrop.cacheCliffRisk, 'critical');
  assert.equal(uDrop.cacheHitRate, 0);

  capsApi.renderFooterCapsule(footerEl, uDrop);
  const capBtn = footerEl.querySelector('[data-agy-context-capsule="1"]');
  assert.equal(capBtn.querySelector('.agy-ctx-cache')?.getAttribute('data-cache-alert'), 'drop');
  assert.equal(capBtn.querySelector('.agy-ctx-fill')?.getAttribute('fill'), '#ef4444');
  assert.equal(capBtn.querySelector('.agy-ctx-cache-val')?.textContent, '0%');

  const uCliff = capsApi.analyzeSteps([
    {
      metadata: {
        modelUsage: { model: 'gemini-4-carbon-medium', inputTokens: '5000', cacheReadTokens: '335000', outputTokens: '500' },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
      }
    }
  ], 'gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)', 1);
  assert.equal(uCliff.cacheDropDetected, false);
  assert.equal(uCliff.cacheCliffRisk, 'critical');

  capsApi.renderFooterCapsule(footerEl, uCliff);
  assert.equal(capBtn.querySelector('.agy-ctx-cache')?.getAttribute('data-cache-alert'), 'cliff');
  assert.equal(capBtn.querySelector('.agy-ctx-fill')?.getAttribute('fill'), '#f59e0b');
  envCap.win.__AGY_CTX_CAPSULE_DISPOSE__();

  // 3. meter-renderer: #key-badge 在 334K (cache=0) 显示 “缓存脱落”，在 340K / 512K (高缓存) 显示 “建议压缩”
  const envDrop = createDomEnv();
  vm.runInContext(RENDERER_SRC, envDrop.sandbox);
  const pollDrop = envDrop.pendingFetches.find(f => String(f.url).includes('GetCascadeTrajectoryGeneratorMetadata'));
  assert.ok(pollDrop, '应触发 GetCascadeTrajectoryGeneratorMetadata 请求');
  pollDrop.resolve({
    ok: true,
    json: async () => ({
      generatorMetadata: [
        {
          chatModel: {
            modelDisplayName: 'Gemini 4 Carbon (Medium)',
            usage: { inputTokens: 2163, cacheReadTokens: 327727, outputTokens: 500 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
          }
        },
        {
          chatModel: {
            modelDisplayName: 'Gemini 4 Carbon (Medium)',
            usage: { inputTokens: 334262, cacheReadTokens: 0, outputTokens: 400 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
          }
        }
      ]
    })
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const sdDrop = envDrop.getShadow();
  assert.equal(sdDrop.getElementById('key-badge').textContent, '缓存脱落');
  assert.match(sdDrop.getElementById('key-takeaway').textContent, /缓存已脱落.*\/compact/);
  envDrop.sandbox.__AGContextMeter.dispose();

  const envCliff = createDomEnv();
  vm.runInContext(RENDERER_SRC, envCliff.sandbox);
  const pollCliff = envCliff.pendingFetches.find(f => String(f.url).includes('GetCascadeTrajectoryGeneratorMetadata'));
  assert.ok(pollCliff);
  pollCliff.resolve({
    ok: true,
    json: async () => ({
      generatorMetadata: [
        {
          chatModel: {
            modelDisplayName: 'Gemini 4 Carbon (Medium)',
            usage: { inputTokens: 5000, cacheReadTokens: 335000, outputTokens: 500 },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
          }
        }
      ]
    })
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const sdCliff = envCliff.getShadow();
  assert.equal(sdCliff.getElementById('key-badge').textContent, '建议压缩');
  assert.match(sdCliff.getElementById('key-takeaway').textContent, /328K.*\/compact/);
  envCliff.sandbox.__AGContextMeter.dispose();
});

// =========================================================================
// 需求 19: 远程面板多项目分组浏览、按项目新建对话、全会话状态与防缩水持久列表
// =========================================================================
test('需求 19: 远程面板支持多项目分组浏览、按项目新建对话、全会话状态汇总与防缩水持久列表', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req17-remote-'));
  const stateDir = path.join(tmpRoot, 'state');
  const configDir = path.join(tmpRoot, 'config');
  const projDir = path.join(configDir, 'projects');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevCtxStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  const prevConfigDir = process.env.AG_CONFIG_DIR;

  try {
    process.env.APPDATA = stateDir;
    process.env.AG_METER_STATE_DIR = stateDir;
    process.env.AG_CONTEXT_METER_STATE_DIR = stateDir;
    process.env.AG_CONFIG_DIR = configDir;

    fs.writeFileSync(path.join(projDir, 'proj-a.json'), JSON.stringify({
      id: 'proj-a',
      name: 'Alpha App',
      projectResources: { resources: [{ folderUri: 'file:///tmp/ws-alpha' }] }
    }));
    fs.writeFileSync(path.join(projDir, 'proj-b.json'), JSON.stringify({
      id: 'proj-b',
      name: 'Beta Service',
      projectResources: { resources: [{ folderUri: 'file:///tmp/ws-beta' }] }
    }));
    fs.writeFileSync(path.join(projDir, 'proj-empty.json'), JSON.stringify({
      id: 'proj-empty',
      name: 'EmptyProj',
      projectResources: { resources: [{ folderUri: 'file:///tmp/ws-empty' }] }
    }));
    fs.writeFileSync(path.join(projDir, 'default-cli-project.json'), JSON.stringify({
      id: 'default-cli-project',
      name: 'CLI Project',
      projectResources: {}
    }));
    fs.writeFileSync(path.join(projDir, 'proj-sidecar.json'), JSON.stringify({
      id: 'proj-sidecar',
      name: 'swarm/swarm_board',
      sidecar: true
    }));

    // 预埋污染的 Subagent 到持久化缓存文件，验证三源统一排除与清库能力
    const catalogFile = path.join(stateDir, 'remote-session-catalog.json');
    fs.writeFileSync(catalogFile, JSON.stringify({
      version: 1,
      updatedAt: Date.now() - 60000,
      conversations: [
        { id: 'subagent-child-1', title: 'Stale Cached Subagent', projectId: 'proj-b', projectName: 'Beta Service', archived: false, updatedAt: Date.now() - 1000 }
      ]
    }));

    delete require.cache[require.resolve('./mobile-remote.js')];
    let remoteMod = require('./mobile-remote.js');

    // 1. 构建 245 条非归档根会话（proj-a: 120, proj-b: 125）+ 1 条已归档 + 1 条三源同现 Subagent
    const baseMs = Date.now() - 300 * 60000;
    const traj245 = {};
    for (let i = 1; i <= 245; i++) {
      const cid = `conv-root-${String(i).padStart(3, '0')}`;
      const pid = i <= 120 ? 'proj-a' : 'proj-b';
      let status = 'CASCADE_RUN_STATUS_IDLE';
      let termReason = 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL';
      if (i === 1) status = 'CASCADE_RUN_STATUS_RUNNING';
      if (i === 2) status = 'CASCADE_RUN_STATUS_WAITING_FOR_USER';
      if (i === 3) termReason = 'EXECUTOR_TERMINATION_REASON_ERROR';
      if (i === 240) status = 'CASCADE_RUN_STATUS_RUNNING';
      traj245[cid] = {
        summary: `Task ${i}`,
        status,
        latestExecutorTerminationReason: termReason,
        lastModifiedTime: new Date(baseMs + (246 - i) * 60000).toISOString(),
        trajectoryMetadata: { projectId: pid, rootConversationId: cid },
        annotations: {
          title: `任务 ${String(i).padStart(3, '0')}`,
          lastUserViewTime: new Date(baseMs + 5000).toISOString()
        }
      };
    }
    traj245['conv-archived-1'] = {
      summary: 'Archived Conversation',
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedTime: new Date(baseMs + 1000).toISOString(),
      trajectoryMetadata: { projectId: 'proj-a', rootConversationId: 'conv-archived-1' },
      annotations: { title: '已归档会话', archived: true }
    };
    traj245['subagent-child-1'] = {
      summary: 'Subagent Worker',
      status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER',
      lastModifiedTime: new Date(baseMs + 250 * 60000).toISOString(),
      trajectoryMetadata: {
        projectId: 'proj-b',
        rootConversationId: 'conv-root-004',
        parentConversationId: 'conv-root-004'
      }
    };

    const snap1 = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: 'conv-root-001',
      busy: true,
      pendingApprovals: [],
      conversations: [
        { id: 'conv-root-001', title: '任务 001', active: true, projectId: 'proj-a' },
        { id: 'subagent-child-1', title: 'Subagent Worker', domBusy: true, projectId: 'proj-b', parentConversationId: 'conv-root-004' }
      ],
      projects: []
    }, {
      stateDir,
      configDir,
      convLimit: 100,
      bypassCache: true,
      localApiConnect: async () => ({
        call: async (method) => {
          if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: traj245 };
          if (method === 'ListProjects') return { projectIds: ['proj-a', 'proj-b', 'proj-empty', 'default-cli-project', 'outside-of-project', 'proj-sidecar'] };
          return {};
        }
      })
    });

    assert.equal(snap1.totalConversations, 245, '超过 200 条的非归档根会话应全量统计且不被截断');
    assert.equal(snap1.hasMoreConversations, true, '首屏仅下发分窗时应标明 hasMoreConversations=true');
    assert.equal(snap1.conversations.some((c) => c.id === 'subagent-child-1'), false, '三源同现的 Subagent 不得出现在会话列表');
    assert.equal(snap1.conversations.some((c) => c.id === 'conv-archived-1'), false, '已归档会话不得出现在活跃列表');

    const persistedCatalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    assert.equal(persistedCatalog.conversations.filter((c) => !c.archived).length, 245, '磁盘持久化目录应保留全部 245 条非归档对话');
    assert.equal(persistedCatalog.conversations.some((c) => c.id === 'subagent-child-1'), false, '已有缓存中的 Subagent 条目应被彻底清理');
    assert.ok(persistedCatalog.subagentIds.includes('subagent-child-1'), '已识别的 Subagent ID 应记录以防复现');

    const c4 = snap1.conversations.find((c) => c.id === 'conv-root-004');
    assert.equal(c4?.status, 'waiting', 'IDLE 根会话旗下 Subagent 处于待确认时应向上汇总为 waiting');
    assert.equal(snap1.projects.some((p) => p.id === 'proj-sidecar' || p.name === 'swarm/swarm_board'), false);
    assert.equal(snap1.projects.find((p) => p.id === 'proj-a')?.conversationCount, 120);
    assert.equal(snap1.projects.find((p) => p.id === 'proj-b')?.conversationCount, 125);
    assert.ok(snap1.projects.find((p) => p.id === 'proj-empty')?.isEmpty);
    assert.ok(snap1.projects.find((p) => p.id === 'default-cli-project')?.isEmpty, '有效的空 default-cli-project 应保留');
    assert.equal(snap1.projects.some((p) => p.id === 'outside-of-project'), false, '空 virtual bucket outside-of-project 应排除');

    // 2. 模拟桌面端折叠、滚动至仅剩 1 行 + 服务重启（清除模块缓存并重建 store），验证 245 条完整保留、Subagent 持续被过滤及 /api/conversations 分页
    delete require.cache[require.resolve('./mobile-remote.js')];
    remoteMod = require('./mobile-remote.js');

    const snapRestart = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: 'conv-root-001',
      busy: false,
      conversations: [
        { id: 'conv-root-001', title: '任务 001', active: true, projectId: 'proj-a' },
        { id: 'subagent-child-1', title: 'Injected Subagent From Snapshot', domBusy: true, projectId: 'proj-b' }
      ],
      projects: []
    }, {
      stateDir,
      configDir,
      convLimit: 100,
      bypassCache: true,
      localApiConnect: async () => ({
        call: async (method) => {
          if (method === 'GetAllCascadeTrajectories') {
            return { trajectorySummaries: { 'conv-root-001': traj245['conv-root-001'] } };
          }
          return {};
        }
      })
    });
    assert.equal(snapRestart.totalConversations, 245, '服务重启且桌面端折叠仅余 1 条后，全量 245 条对话仍完好保留');
    assert.equal(snapRestart.conversations.some((c) => c.id === 'subagent-child-1'), false, '重启后仅由快照回流的已知 Subagent 仍被过滤');
    assert.ok(snapRestart.projects.find((p) => p.id === 'default-cli-project')?.isEmpty, '重启后空的 default-cli-project 仍保留');

    const page1 = remoteMod.listCatalogConversations({ stateDir, offset: 0, limit: 150 });
    const page2 = remoteMod.listCatalogConversations({ stateDir, offset: 150, limit: 150 });
    assert.equal(page1.total, 245);
    assert.equal(page1.conversations.length, 150);
    assert.equal(page1.hasMore, true);
    assert.equal(page2.conversations.length, 95);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.conversations[page2.conversations.length - 1]?.id, 'conv-root-245', '第 245 条历史对话应可通过分页准确读出');
    assert.equal(page1.conversations.find((c) => c.id === 'conv-root-002')?.status, 'waiting', '重启+轨迹缺项后后台 waiting 状态不得被抹成 idle');
    assert.equal(page1.conversations.find((c) => c.id === 'conv-root-003')?.status, 'error', '重启+轨迹缺项后后台 error 状态不得被抹成 idle');
    assert.equal(page1.conversations.find((c) => c.id === 'conv-root-004')?.status, 'running', '重启后快照回流 Subagent domBusy=true 应汇总为 running 而非 idle');
    assert.equal(page1.conversations.find((c) => c.id === 'conv-root-005')?.status, 'idle', '明确 IDLE 会话保持 idle');
    assert.equal(page2.conversations.find((c) => c.id === 'conv-root-240')?.status, 'running', '重启+轨迹缺项后后台 running 状态不得被抹成 idle');

    // 2b. 回归验证：区分「缺少状态数据」与「明确空闲」（无状态返回 unknown；轨迹缺项、请求失败及重启后保留后台与 Subagent 汇总态）
    assert.equal(remoteMod.normalizeTrajectoryStatus(undefined, undefined, {}), 'unknown');
    assert.equal(remoteMod.normalizeTrajectoryStatus('CASCADE_RUN_STATUS_IDLE', '', {}), 'idle');
    const statusDir = path.join(tmpRoot, 'status-state');
    fs.mkdirSync(statusDir, { recursive: true });
    const baseStTraj = {
      'bg-wait': { status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER', trajectoryMetadata: { projectId: 'proj-a' } },
      'bg-err': { status: 'CASCADE_RUN_STATUS_IDLE', latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR', trajectoryMetadata: { projectId: 'proj-a' } },
      'bg-run': { status: 'CASCADE_RUN_STATUS_RUNNING', trajectoryMetadata: { projectId: 'proj-a' } },
      'root-sub': { status: 'CASCADE_RUN_STATUS_IDLE', trajectoryMetadata: { projectId: 'proj-a', rootConversationId: 'root-sub' } },
      'child-wait': { status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER', trajectoryMetadata: { projectId: 'proj-a', parentConversationId: 'root-sub', rootConversationId: 'root-sub' } }
    };
    const stInit = await remoteMod.enrichSnapshotWithCatalog({ ok: true, sessionId: 'bg-run', busy: false, conversations: [], projects: [] }, {
      stateDir: statusDir, configDir, bypassCache: true,
      localApiConnect: async () => ({ call: async (m) => m === 'GetAllCascadeTrajectories' ? { trajectorySummaries: baseStTraj } : {} })
    });
    assert.equal(stInit.conversations.find((c) => c.id === 'root-sub')?.status, 'waiting');

    delete require.cache[require.resolve('./mobile-remote.js')];
    remoteMod = require('./mobile-remote.js');
    const stFail = await remoteMod.enrichSnapshotWithCatalog({
      ok: true, sessionId: '', busy: false,
      conversations: [{ id: 'dom-unknown', title: 'No Traj Status', domBusy: false, projectId: 'proj-a' }],
      projects: []
    }, {
      stateDir: statusDir, configDir, bypassCache: true,
      localApiConnect: async () => { throw new Error('LS unavailable'); }
    });
    assert.equal(stFail.conversations.find((c) => c.id === 'bg-wait')?.status, 'waiting', '请求失败时应保留最近可信 waiting');
    assert.equal(stFail.conversations.find((c) => c.id === 'bg-err')?.status, 'error', '请求失败时应保留最近可信 error');
    assert.equal(stFail.conversations.find((c) => c.id === 'bg-run')?.status, 'running', '请求失败时应保留最近可信 running');
    assert.equal(stFail.conversations.find((c) => c.id === 'root-sub')?.status, 'waiting', '请求失败时应保留 Subagent 汇总 waiting');
    assert.equal(stFail.conversations.find((c) => c.id === 'dom-unknown')?.status, 'unknown', '无历史状态且缺少轨迹数据时必须标记 unknown 而非 idle');

    delete require.cache[require.resolve('./mobile-remote.js')];
    remoteMod = require('./mobile-remote.js');
    const stPartial = await remoteMod.enrichSnapshotWithCatalog({ ok: true, sessionId: '', busy: false, conversations: [], projects: [] }, {
      stateDir: statusDir, configDir, bypassCache: true,
      localApiConnect: async () => ({
        call: async (m) => m === 'GetAllCascadeTrajectories'
          ? { trajectorySummaries: { 'root-sub': baseStTraj['root-sub'] } }
          : {}
      })
    });
    assert.equal(stPartial.conversations.find((c) => c.id === 'bg-wait')?.status, 'waiting');
    assert.equal(stPartial.conversations.find((c) => c.id === 'bg-err')?.status, 'error');
    assert.equal(stPartial.conversations.find((c) => c.id === 'root-sub')?.status, 'waiting', '子代理缺项时即使根轨迹报 IDLE 仍应保留持久化的 Subagent 汇总 waiting');
    assert.equal(stPartial.conversations.find((c) => c.id === 'dom-unknown')?.status, 'unknown');

    const stRecovered = await remoteMod.enrichSnapshotWithCatalog({ ok: true, sessionId: '', busy: false, conversations: [], projects: [] }, {
      stateDir: statusDir, configDir, bypassCache: true,
      localApiConnect: async () => ({
        call: async (m) => m === 'GetAllCascadeTrajectories' ? {
          trajectorySummaries: {
            'root-sub': baseStTraj['root-sub'],
            'child-wait': { ...baseStTraj['child-wait'], status: 'CASCADE_RUN_STATUS_IDLE' },
            'dom-unknown': { status: 'CASCADE_RUN_STATUS_IDLE', trajectoryMetadata: { projectId: 'proj-a' } }
          }
        } : {}
      })
    });
    assert.equal(stRecovered.conversations.find((c) => c.id === 'root-sub')?.status, 'idle', '子代理明确返回 IDLE 后根会话应恢复 idle');
    assert.equal(stRecovered.conversations.find((c) => c.id === 'dom-unknown')?.status, 'idle', '轨迹明确返回 IDLE 后应从 unknown 转为 idle');

    // 验证 HTTP GET /api/conversations 端点可用性
    const httpCfg = remoteMod.loadOrCreateRemoteConfig();
    const httpHandler = remoteMod.createRemoteHttpHandler(httpCfg);
    const apiConvRes = await new Promise((resolve) => {
      const chunks = [];
      httpHandler({
        method: 'GET',
        url: `/api/conversations?offset=150&limit=100&token=${encodeURIComponent(httpCfg.token)}`,
        headers: { host: `127.0.0.1:${httpCfg.port}` },
        socket: { remoteAddress: '127.0.0.1' }
      }, {
        setHeader() {},
        writeHead(status) { this.status = status; },
        end(body) { resolve({ status: this.status, json: JSON.parse(String(body || '{}')) }); }
      });
    });
    assert.equal(apiConvRes.status, 200);
    assert.equal(apiConvRes.json.conversations.length, 95);

    // 3. 验证 ag-enhancer-overlay.js：仅改 URL 而应用状态未切换必须失败；真实 Router + AgentInputBox 状态与首条消息归属项目验证
    const envFake = createDomEnv();
    envFake.sandbox.setTimeout = setTimeout;
    envFake.sandbox.clearTimeout = clearTimeout;
    envFake.win.location = { pathname: '/c/conv-root-001', search: '' };
    envFake.win.history = {
      pushState(_st, _t, url) {
        const u = new URL(String(url), 'https://127.0.0.1');
        envFake.win.location.pathname = u.pathname;
        envFake.win.location.search = u.search;
      }
    };
    envFake.sandbox.location = envFake.win.location;
    envFake.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, uiPreferences: {} }) });
    vm.runInContext(RENDERER_SRC, envFake.sandbox);
    vm.runInContext(ENHANCER_SRC, envFake.sandbox);
    const enhFake = envFake.sandbox.__AGEnhancer;

    const fakeNew = await enhFake.performMobileAction({ action: 'new-conversation', projectId: 'proj-b' });
    const fakeSwitch = await enhFake.performMobileAction({ action: 'switch-conversation', id: 'conv-root-245' });
    assert.equal(fakeNew.ok, false, '仅改动 URL 而无桌面端应用状态切换时 new-conversation 必须返回失败');
    assert.equal(fakeSwitch.ok, false, '仅改动 URL 而无桌面端应用状态切换时 switch-conversation 必须返回失败');
    enhFake.dispose?.();
    envFake.sandbox.__AGContextMeter?.dispose?.();

    // 构建真实 Antigravity TanStack Router + sidebar customHeaderRenderer + AgentInputBox 集成环境
    const createdByFirstMsg = [];
    const envReal = createDomEnv();
    envReal.sandbox.setTimeout = setTimeout;
    envReal.sandbox.clearTimeout = clearTimeout;
    envReal.win.location = { pathname: '/c/conv-root-001', search: '?project=proj-a' };
    envReal.sandbox.location = envReal.win.location;
    envReal.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, uiPreferences: {} }) });
    envReal.doc.execCommand = () => false;
    envReal.win.getSelection = () => null;
    envReal.sandbox.getSelection = envReal.win.getSelection;

    const routerState = {
      status: 'idle',
      isLoading: false,
      location: { pathname: '/c/conv-root-001', search: { project: 'proj-a' } },
      matches: [{ routeId: '/manager-layout/manager-landing-layout/c/$cascadeId', params: { cascadeId: 'conv-root-001' }, status: 'success' }]
    };
    const composerProps = {
      inExistingConversation: true,
      cascadeId: 'conv-root-001',
      isConvoLoading: false,
      handleSubmit: () => {}
    };
    function applyRouterUrl(nextHref) {
      const u = new URL(String(nextHref), 'https://127.0.0.1');
      const pid = u.searchParams.get('project') || '';
      envReal.win.location.pathname = u.pathname;
      envReal.win.location.search = u.search;
      routerState.location = { pathname: u.pathname, search: pid ? { project: pid } : {} };
      const cm = u.pathname.match(/^\/c\/([^/?#]+)/);
      if (cm) {
        routerState.matches = [{ routeId: '/manager-layout/manager-landing-layout/c/$cascadeId', params: { cascadeId: cm[1] }, status: 'success' }];
        composerProps.inExistingConversation = true;
        composerProps.cascadeId = cm[1];
      } else {
        routerState.matches = [{ routeId: '/manager-layout/manager-landing-layout/', params: {}, status: 'success' }];
        composerProps.inExistingConversation = false;
        composerProps.cascadeId = '';
      }
      if (pid) projBadge.setAttribute('data-active-project-id', pid);
      else projBadge.removeAttribute('data-active-project-id');
    }

    const fakeRouter = {
      state: routerState,
      history: { push: (href) => applyRouterUrl(href) },
      parseLocation: () => routerState.location,
      navigate: async ({ to, search }) => applyRouterUrl(search?.project ? `${to}?project=${encodeURIComponent(search.project)}` : to)
    };

    const projBadge = envReal.doc.createElement('div');
    projBadge.setAttribute('data-active-project-id', 'proj-a');
    envReal.doc.body.appendChild(projBadge);

    const newConvoBtn = envReal.doc.createElement('a');
    newConvoBtn.setAttribute('data-testid', 'new-conversation-button');
    newConvoBtn.setAttribute('href', '/');
    newConvoBtn.__reactFiber$test = {
      dependencies: { firstContext: { memoizedValue: fakeRouter, next: null } },
      return: null
    };
    envReal.doc.body.appendChild(newConvoBtn);

    const sidebarList = envReal.doc.createElement('div');
    sidebarList.setAttribute('data-testid', 'conversation-list-sidebar');
    sidebarList.__reactFiber$test = {
      return: {
        memoizedProps: {
          customHeaderRenderer: (item) => {
            const pid = String(item?.id || '').replace(/^header-/, '');
            if (!['proj-a', 'proj-b', 'proj-empty', 'default-cli-project'].includes(pid)) return null;
            return {
              props: {
                onAddClick: () => applyRouterUrl(`/?project=${encodeURIComponent(pid)}`)
              }
            };
          }
        },
        return: null
      }
    };
    envReal.doc.body.appendChild(sidebarList);

    const compSurface = envReal.doc.createElement('div');
    compSurface.className = 'surface-composer';
    compSurface.__reactFiber$test = { memoizedProps: composerProps, return: null };
    const editorEl = envReal.doc.createElement('div');
    editorEl.setAttribute('data-lexical-editor', 'true');
    const lexRootChildren = [];
    const fakeLexRoot = {
      clear() { lexRootChildren.length = 0; editorEl.textContent = ''; },
      append(node) { lexRootChildren.push(node); editorEl.textContent = node._txt || ''; }
    };
    editorEl.__lexicalEditor = {
      _nodes: new Map([
        ['paragraph', { klass: class { constructor() { this._txt = ''; } append(ch) { this._txt += ch?._v || ''; } } }],
        ['text', { klass: class { constructor(v) { this._v = v; } } }]
      ]),
      update(fn) { fn(); },
      getEditorState() { return { _nodeMap: new Map([['root', fakeLexRoot]]) }; }
    };
    const sendBtn = envReal.doc.createElement('button');
    sendBtn.setAttribute('data-testid', 'send-button');
    sendBtn.addEventListener('click', () => {
      const targetProj = routerState.location.search?.project || projBadge.getAttribute('data-active-project-id') || '';
      const newCid = `created-${targetProj}-${createdByFirstMsg.length + 1}`;
      createdByFirstMsg.push({ id: newCid, projectId: targetProj, text: editorEl.textContent || '' });
      applyRouterUrl(`/c/${newCid}?project=${encodeURIComponent(targetProj)}`);
    });
    compSurface.appendChild(editorEl);
    compSurface.appendChild(sendBtn);
    envReal.doc.body.appendChild(compSurface);

    vm.runInContext(RENDERER_SRC, envReal.sandbox);
    vm.runInContext(ENHANCER_SRC, envReal.sandbox);
    const enhReal = envReal.sandbox.__AGEnhancer;

    // 场景 A: 当前项目快速新建 + 发首条消息确认归属 proj-a
    const resNewA = await enhReal.performMobileAction({ action: 'new-conversation', projectId: 'proj-a' });
    assert.equal(resNewA.ok, true);
    assert.equal(resNewA.verifiedState.inExistingConversation, false);
    assert.equal(resNewA.verifiedState.routeProjectId, 'proj-a');
    await enhReal.performMobileAction({ action: 'send', text: 'Alpha first prompt' });
    assert.equal(createdByFirstMsg[0]?.text, 'Alpha first prompt', 'execCommand 返回 false 时应通过 Lexical _nodes 回退写入编辑器正文');
    assert.equal(createdByFirstMsg[0]?.projectId, 'proj-a');
    assert.equal(composerProps.inExistingConversation, true);

    // 场景 B: 指定项目新建 (proj-b) + 发首条消息确认归属 proj-b
    const resNewB = await enhReal.performMobileAction({ action: 'new-conversation', projectId: 'proj-b' });
    assert.equal(resNewB.ok, true);
    assert.equal(resNewB.method, 'sidebar-header-action');
    assert.equal(resNewB.verifiedState.routeProjectId, 'proj-b');
    await enhReal.performMobileAction({ action: 'send', text: 'Beta first prompt' });
    assert.equal(createdByFirstMsg[1]?.projectId, 'proj-b');

    // 场景 C: 空项目新建 (proj-empty) + 发首条消息确认归属 proj-empty
    const resNewEmpty = await enhReal.performMobileAction({ action: 'new-conversation', projectId: 'proj-empty' });
    assert.equal(resNewEmpty.ok, true);
    assert.equal(resNewEmpty.method, 'sidebar-header-action');
    assert.equal(resNewEmpty.verifiedState.routeProjectId, 'proj-empty');
    await enhReal.performMobileAction({ action: 'send', text: 'Empty project prompt' });
    assert.equal(createdByFirstMsg[2]?.projectId, 'proj-empty');

    // 场景 D: 切换至被折叠/滚出视口的第 245 条旧对话并校验真实 Router + AgentInputBox 应用状态
    const resSwitch245 = await enhReal.performMobileAction({ action: 'switch-conversation', id: 'conv-root-245' });
    assert.equal(resSwitch245.ok, true);
    assert.equal(resSwitch245.method, 'router-history');
    assert.equal(resSwitch245.verifiedState.matchedCascadeId, 'conv-root-245');
    assert.equal(resSwitch245.verifiedState.inExistingConversation, true);
    assert.equal(resSwitch245.verifiedState.inputCascadeId, 'conv-root-245');

    // 4. 验证远程网页 UI：空 default-cli-project 双入口进入真实桌面归属、全量分页及分页缓存持续更新/移除
    const refreshLiveTestSnap = async () => remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: composerProps.inExistingConversation ? (composerProps.cascadeId || '') : '',
      currentProjectId: routerState.location.search?.project || '',
      isNewConversation: !composerProps.inExistingConversation,
      busy: false,
      conversations: [],
      projects: []
    }, {
      stateDir,
      configDir,
      convLimit: 100,
      bypassCache: true,
      localApiConnect: async () => ({
        call: async (method) => {
          if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: traj245 };
          if (method === 'ListProjects') return { projectIds: ['proj-a', 'proj-b', 'proj-empty', 'default-cli-project', 'outside-of-project', 'proj-sidecar'] };
          return {};
        }
      })
    });

    const mobileHtml = remoteMod.buildMobileAppHtml();
    const inlineScriptMatch = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(inlineScriptMatch, 'buildMobileAppHtml 应包含内联 <script>');
    assert.doesNotThrow(() => new vm.Script(inlineScriptMatch[1]), '内联 <script> 必须通过语法校验');

    const envUi = createDomEnv();
    const bodyMatch = mobileHtml.match(/<body>([\s\S]*?)<script>/);
    envUi.doc.body.innerHTML = bodyMatch[1];

    const dispatchedActions = [];
    let currentUiSnap = snapRestart;
    envUi.win.innerWidth = 1200;
    envUi.win.innerHeight = 800;
    envUi.win.AbortController = AbortController;
    envUi.win.location = { pathname: '/', search: '?token=testtok', protocol: 'http:', reload() {} };
    envUi.win.history = { replaceState() {} };
    envUi.sandbox.location = envUi.win.location;
    envUi.sandbox.history = envUi.win.history;
    envUi.sandbox.AbortController = AbortController;
    envUi.sandbox.URLSearchParams = URLSearchParams;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      const jsonHeaders = { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') };
      if (u.pathname === '/api/conversations') {
        const pid = u.searchParams.get('projectId') || '';
        const offset = Number(u.searchParams.get('offset') || '0');
        const limit = Number(u.searchParams.get('limit') || '150');
        return {
          ok: true,
          status: 200,
          headers: jsonHeaders,
          json: async () => remoteMod.listCatalogConversations({ stateDir, projectId: pid, offset, limit })
        };
      }
      if (u.pathname === '/api/action') {
        const body = JSON.parse(String(init?.body || '{}'));
        dispatchedActions.push(body);
        const actionResult = await enhReal.performMobileAction(body);
        currentUiSnap = await refreshLiveTestSnap();
        return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: Boolean(actionResult?.ok), actionResult, snapshot: currentUiSnap }) };
      }
      if (u.pathname === '/api/snapshot') {
        return { ok: true, status: 200, headers: jsonHeaders, json: async () => currentUiSnap };
      }
      return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: true }) };
    };

    vm.runInContext(inlineScriptMatch[1], envUi.sandbox);
    await new Promise((r) => setTimeout(r, 40));

    const convListEl = envUi.doc.getElementById('conv-list');
    // 4a. 验证无「空项目」折叠栏、所有空项目直接平铺展示、点击空项目选中后联动顶部 #new-chat-sub 与 #btn-new-chat
    assert.equal(convListEl.querySelector('.proj-empty-toggle'), null, '侧边栏不应存在空项目折叠开关');
    assert.equal(convListEl.querySelector('.proj-empty-sec'), null, '侧边栏不应单独隔离空项目区块');
    const emptyProjToggle = convListEl.querySelector('button[data-proj-toggle="proj-empty"]');
    assert.ok(emptyProjToggle, '空项目 EmptyProj 应直接作为普通项目头展示在列表中');
    const cliProjToggle = convListEl.querySelector('button[data-proj-toggle="default-cli-project"]');
    assert.ok(cliProjToggle, '空 CLI Project 应无需展开折叠即可直接点中');

    // 先点选 EmptyProj 验证同步，再点选 CLI Project 并点击顶部「新建对话」确认不会串到别的项目
    emptyProjToggle.click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'EmptyProj', '点中空项目后顶部新建对话副标题应即时切换为该项目名');
    cliProjToggle.click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'CLI Project', '点中 CLI Project 后顶部新建对话副标题应联动为 CLI Project');
    const curGroupsAfterClick = convListEl.querySelectorAll('.is-current');
    assert.equal(curGroupsAfterClick.length, 1, '侧边栏同时只应有一个高亮项目');
    assert.equal((curGroupsAfterClick[0].querySelector('.proj-name')?.textContent || '').trim(), 'CLI Project', '点中的空项目应获得 is-current 高亮');

    // 点击顶部 #btn-new-chat，确认严格向刚点中的 CLI Project 发起新建会话而不串项目
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(composerProps.inExistingConversation, false);
    assert.equal(routerState.location.search?.project, 'default-cli-project', '点击空项目后再点顶部新建对话必须进入该项目路由');
    assert.equal(projBadge.getAttribute('data-active-project-id'), 'default-cli-project');
    await enhReal.performMobileAction({ action: 'send', text: 'CLI web sidebar prompt' });
    assert.equal(createdByFirstMsg[createdByFirstMsg.length - 1]?.projectId, 'default-cli-project', '从侧边栏选中 CLI 项目新建后首条消息应归属 default-cli-project');

    envUi.doc.getElementById('btn-new-chat-project').click();
    const cliSheetOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt').find((b) => (b.textContent || '').includes('CLI Project'));
    assert.ok(cliSheetOpt, '顶部新建项目下拉选择器应包含 CLI Project');
    cliSheetOpt.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(composerProps.inExistingConversation, false);
    assert.equal(routerState.location.search?.project, 'default-cli-project', '通过下拉选择器应进入 default-cli-project 新建状态');
    await enhReal.performMobileAction({ action: 'send', text: 'CLI dropdown prompt' });
    assert.equal(createdByFirstMsg[createdByFirstMsg.length - 1]?.projectId, 'default-cli-project');

    assert.ok(convListEl.innerHTML.includes('加载该项目更多对话'), '当单项目历史超过首屏预览时应显示项目分页按钮');
    const projAMore = convListEl.querySelector('button[data-proj-more="proj-a"]');
    assert.ok(projAMore);
    projAMore.click();
    await new Promise((r) => setTimeout(r, 40));
    const projAToggle = convListEl.querySelector('button[data-proj-toggle="proj-a"]');
    assert.ok((projAToggle.textContent || '').includes('120'), '分页加载后 Alpha App 应显示 120 条对话');

    // 4b. 切换到「最近活跃」并通过分页加载全部 245 条历史后点击最老一条
    const recentTab = envUi.doc.getElementById('conv-view-tabs').querySelector('button[data-conv-view="recent"]');
    recentTab.click();
    await new Promise((r) => setTimeout(r, 20));
    for (let step = 0; step < 3; step++) {
      const moreBtn = convListEl.querySelector('button[data-conv-more="1"]');
      if (!moreBtn) break;
      moreBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(convListEl.querySelectorAll('.conv-item').length, 245, '通过分页应能在「最近活跃」中完整呈现全部 245 条非归档对话');
    const oldestBtn = convListEl.querySelector('button[data-cid="conv-root-245"]');
    assert.ok(oldestBtn, '应能访问最末尾的第 245 条历史对话');
    oldestBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(dispatchedActions[dispatchedActions.length - 1], { action: 'switch-conversation', id: 'conv-root-245' });

    // 4c. 回归验证分页缓存 extraConvMap 持续同步与清理：状态变化、查看清未读、归档与晚识别 Subagent 移除
    const btn240Init = convListEl.querySelector('button[data-cid="conv-root-240"]');
    assert.ok(btn240Init?.classList.contains('is-unread'), '分页项 #240 初始应带未读标记');
    assert.ok((btn240Init?.textContent || '').includes('运行中'), '分页项 #240 初始应显示运行中状态');
    btn240Init.click();
    await new Promise((r) => setTimeout(r, 40));
    convListEl.querySelector('button[data-cid="conv-root-001"]').click();
    await new Promise((r) => setTimeout(r, 40));
    const btn240AfterView = convListEl.querySelector('button[data-cid="conv-root-240"]');
    assert.equal(btn240AfterView?.classList.contains('is-unread'), false, '查看分页项 #240 并切走后，未读标记应持续保持清除');

    traj245['conv-root-240'].status = 'CASCADE_RUN_STATUS_IDLE';
    traj245['conv-root-241'].annotations.archived = true;
    traj245['conv-root-242'].trajectoryMetadata = {
      projectId: 'proj-b',
      rootConversationId: 'conv-root-004',
      parentConversationId: 'conv-root-004'
    };
    currentUiSnap = await refreshLiveTestSnap();
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 60));

    const btn240Synced = convListEl.querySelector('button[data-cid="conv-root-240"]');
    assert.ok(btn240Synced);
    assert.equal((btn240Synced.textContent || '').includes('运行中'), false, '分页项 #240 后台完成后状态应同步更新');
    assert.equal(btn240Synced.classList.contains('is-unread'), false, '分页项 #240 未读标记应保持已读');
    assert.equal(convListEl.querySelector('button[data-cid="conv-root-241"]'), null, '已归档的分页项 #241 应从前端缓存与列表移除');
    assert.equal(convListEl.querySelector('button[data-cid="conv-root-242"]'), null, '后续识别出的 Subagent #242 应从前端缓存与列表移除');
    assert.equal(convListEl.querySelectorAll('.conv-item').length, 243, '清理归档与 Subagent 后总数应精确缩减至 243 条');

    // 4d. 回归验证：从项目 A 下拉选「默认工作区」以及切到无项目/ungrouped 会话后，均应清除旧项目高亮与顶部项目名，轮询不回跳且新建对话不携带旧项目 ID
    const projTab = envUi.doc.getElementById('conv-view-tabs').querySelector('button[data-conv-view="projects"]');
    projTab.click();
    await new Promise((r) => setTimeout(r, 20));
    convListEl.querySelector('button[data-proj-toggle="proj-a"]').click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'Alpha App');
    assert.equal(convListEl.querySelectorAll('.is-current').length, 1);

    // 1) 通过下拉选择器选择「默认工作区（不指定项目）」
    envUi.doc.getElementById('btn-new-chat-project').click();
    const defaultWsOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt')
      .find((b) => (b.textContent || '').includes('默认工作区'));
    assert.ok(defaultWsOpt, '项目选择器应包含默认工作区选项');
    defaultWsOpt.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, true, '选择默认工作区后顶部项目副标题应隐藏');
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), '');
    assert.equal(convListEl.querySelectorAll('.is-current').length, 0, '选择默认工作区后不得高亮任何具体项目');
    // 模拟滞后轮询仍返回旧宿主上下文或当前无项目快照
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, true, '后台轮询后默认工作区状态不得回退至旧项目');
    assert.equal(convListEl.querySelectorAll('.is-current').length, 0);
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 40));
    const actDefaultNew = dispatchedActions[dispatchedActions.length - 1];
    assert.equal(actDefaultNew?.action, 'new-conversation');
    assert.equal(actDefaultNew?.projectId, undefined, '选中默认工作区后点击顶部新建对话不得携带旧项目 ID');

    // 2) 方案 A：从已选中项目 A 时，电脑端切至 ungrouped/其他项目不反向覆盖手机选中的 A；手机主动点选 ungrouped 会话后立即清零并保持
    convListEl.querySelector('button[data-proj-toggle="proj-a"]').click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'Alpha App');
    assert.equal(convListEl.querySelectorAll('.is-current').length, 1);
    const ungroupedConv = { id: 'conv-ungrouped-test', projectId: 'ungrouped', projectName: '未归属项目', title: '无项目历史对话', active: true, status: 'idle', updatedAt: Date.now() };
    currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: 'conv-ungrouped-test', isNewConversation: false, currentProjectId: 'ungrouped', currentProjectName: '', conversations: [ungroupedConv, ...(currentUiSnap.conversations || [])] };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(convListEl.querySelectorAll('.is-current').length, 1, '方案 A：电脑端后台切至 ungrouped 时不得反向覆盖手机已选中的项目 A');
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'Alpha App');
    const ungroupedBtn = convListEl.querySelector('button[data-cid="conv-ungrouped-test"]');
    assert.ok(ungroupedBtn, '应在未归属项目组下渲染无项目历史对话');
    ungroupedBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: 'conv-root-001', currentProjectId: 'proj-a', currentProjectName: 'Alpha App' };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(convListEl.querySelectorAll('.is-current').length, 0, '手机主动点击 ungrouped 会话后必须清零，且电脑切回 A 不得反向覆写');
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, true);
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 40));
    const actAfterUngrouped = dispatchedActions[dispatchedActions.length - 1];
    assert.equal(actAfterUngrouped?.action, 'new-conversation');
    assert.equal(actAfterUngrouped?.projectId, undefined, '切换到 ungrouped 会话后点击顶部新建对话不得携带旧项目 ID');

    // 3) 从已选中项目 A 切换到 outside-of-project 独立对话后，同样必须清除旧项目选中态且新建对话不携带 projectId
    convListEl.querySelector('button[data-proj-toggle="proj-a"]').click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'Alpha App');
    assert.equal(convListEl.querySelectorAll('.is-current').length, 1);
    const standaloneConv = { id: 'conv-outside-test', projectId: 'outside-of-project', projectName: '独立对话', title: '独立工作区对话', active: false, status: 'idle', updatedAt: Date.now() };
    currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: 'conv-root-001', isNewConversation: false, currentProjectId: 'proj-a', currentProjectName: 'Alpha App', conversations: [standaloneConv, ...(currentUiSnap.conversations || [])] };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 50));
    const standaloneBtn = convListEl.querySelector('button[data-cid="conv-outside-test"]');
    assert.ok(standaloneBtn, '应在独立对话分组下渲染 outside-of-project 会话');
    standaloneBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(convListEl.querySelectorAll('.is-current').length, 0, '点击 outside-of-project 独立对话并轮询后应清除旧项目高亮');
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, true, '点击 outside-of-project 独立对话后顶部副标题应清空隐藏');
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 40));
    const actAfterStandalone = dispatchedActions[dispatchedActions.length - 1];
    assert.equal(actAfterStandalone?.action, 'new-conversation');
    assert.equal(actAfterStandalone?.projectId, undefined, '切换到 outside-of-project 会话后点击顶部新建对话不得携带旧项目 ID');

    // 4e. 方案 A 并发与边界回归：手机点选 C 后，无论延迟 B 回包、旧轮询、电脑端自行 A/B/ungrouped 往返均保持 C；仅该项目消失时兜底清零
    const assertProjectHeldC = async (expectedId, expectedName) => {
      const cur = convListEl.querySelectorAll('.is-current');
      assert.equal(cur.length, 1);
      assert.equal((cur[0].querySelector('.proj-name')?.textContent || '').trim(), expectedName);
      assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, false);
      assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), expectedName);
      envUi.doc.getElementById('btn-new-chat-project').click();
      const activeOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt').find((o) => o.classList.contains('active'));
      assert.ok(activeOpt && (activeOpt.textContent || '').includes(expectedName), `下拉高亮应保持 ${expectedName}`);
      envUi.doc.getElementById('sheet-close').click();
      envUi.doc.getElementById('btn-new-chat').click();
      await new Promise((r) => setTimeout(r, 40));
      const act = dispatchedActions[dispatchedActions.length - 1];
      assert.equal(act?.action, 'new-conversation');
      assert.equal(act?.projectId, expectedId, `新建请求必须保持目标项目 ${expectedId}`);
    };
    let deferredGate = null;
    let deferredSnapGate = null;
    let gateInlineSnap = true;
    const baseUiFetch = envUi.sandbox.fetch;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      if (u.pathname === '/api/snapshot' && deferredSnapGate) {
        const g = deferredSnapGate; deferredSnapGate = null;
        const res = await baseUiFetch(url, init);
        const captured = await res.json();
        await g.promise;
        return { ...res, json: async () => captured };
      }
      if (u.pathname === '/api/action' && deferredGate) {
        const g = deferredGate; const inline = gateInlineSnap; deferredGate = null;
        const res = await baseUiFetch(url, init);
        await g.promise;
        if (!inline) { const body = await res.json(); return { ...res, json: async () => ({ ok: body.ok, actionResult: body.actionResult }) }; }
        return res;
      }
      return baseUiFetch(url, init);
    };
    const mkGate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

    // Case 1: A 旧轮询在途 -> 发起切换 B -> 点选 C -> B 内联返回 -> A 旧轮询迟到 -> 电脑端依次切 A -> B -> ungrouped -> B，手机始终保持 C
    const projBConv = (currentUiSnap.conversations || []).find((c) => c && c.projectId === 'proj-b');
    assert.ok(projBConv);
    convListEl.querySelector('button[data-cid="conv-root-001"]').click();
    await new Promise((r) => setTimeout(r, 40));
    deferredSnapGate = mkGate(); const snapGateA = deferredSnapGate;
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 15));
    gateInlineSnap = true; deferredGate = mkGate(); const gate1 = deferredGate;
    convListEl.querySelector(`button[data-cid="${projBConv.id}"]`).click();
    await new Promise((r) => setTimeout(r, 15));
    convListEl.querySelector('button[data-proj-toggle="default-cli-project"]').click();
    gate1.resolve();
    await new Promise((r) => setTimeout(r, 50));
    snapGateA.resolve();
    await new Promise((r) => setTimeout(r, 30));
    for (const [sid, pid, pname] of [['conv-root-001', 'proj-a', 'Alpha App'], [projBConv.id, 'proj-b', 'Beta Core'], ['conv-ungrouped-test', 'ungrouped', ''], [projBConv.id, 'proj-b', 'Beta Core']]) {
      currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: sid, isNewConversation: false, currentProjectId: pid, currentProjectName: pname };
      envUi.win.dispatchEvent({ type: 'pageshow' });
      await new Promise((r) => setTimeout(r, 30));
    }
    await assertProjectHeldC('default-cli-project', 'CLI Project');

    // Case 2: 宿主在 B -> 重复发起无内联快照的新建 B -> 手机改点选 EmptyProj -> 电脑切 A 再切 B，仍保持 EmptyProj；当 EmptyProj 被删除/归档时兜底清零
    gateInlineSnap = false; deferredGate = mkGate(); const gate2 = deferredGate;
    convListEl.querySelector('button[data-new-proj="proj-b"]').click();
    await new Promise((r) => setTimeout(r, 15));
    convListEl.querySelector('button[data-proj-toggle="proj-empty"]').click();
    gate2.resolve();
    await new Promise((r) => setTimeout(r, 40));
    currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: 'conv-root-001', isNewConversation: false, currentProjectId: 'proj-a', currentProjectName: 'Alpha App' };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    currentUiSnap = { ...currentUiSnap, snapSeq: undefined, sessionId: '', isNewConversation: true, currentProjectId: 'proj-b', currentProjectName: 'Beta Core' };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    await assertProjectHeldC('proj-empty', 'EmptyProj');

    // 当当前选中的 proj-empty 从 projects 中消失（删除/归档）时，自动清零而非悬空指向不存在项目
    currentUiSnap = {
      ...currentUiSnap,
      snapSeq: undefined,
      sessionId: '',
      isNewConversation: true,
      currentProjectId: 'proj-b',
      currentProjectName: 'Beta Core',
      projects: (currentUiSnap.projects || []).filter((p) => p && p.id !== 'proj-empty')
    };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(convListEl.querySelectorAll('.is-current').length, 0, '选中项目从宿主删除/归档后应自动清零高亮');
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, true, '选中项目失效后顶部项目副标题应清空隐藏');
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(dispatchedActions[dispatchedActions.length - 1]?.projectId, undefined);

    // Case 3: 旧实例导航在途 -> 新实例快照已渲染 -> 旧实例导航回包迟到 + 晚起飞旧实例非导航回包 + 未见过更老实例回包，均不得污染视图或选中态
    const baseBootAt = Math.max(Number(currentUiSnap.serverBootAt) || 0, Date.now() * 1000);
    const oldProjectsC3 = [
      { id: 'proj-a', name: 'Alpha App', conversationCount: 120 },
      { id: 'proj-b', name: 'Beta Core', conversationCount: 125 },
      { id: 'default-cli-project', name: 'CLI Project', conversationCount: 0 }
    ];
    const oldProjectsMissingCliC3 = oldProjectsC3.filter((p) => p.id !== 'default-cli-project');
    currentUiSnap = {
      ...currentUiSnap,
      serverBootId: 'boot-old-case3',
      serverBootAt: baseBootAt + 1000,
      snapSeq: 50,
      sessionId: 'conv-root-001',
      isNewConversation: false,
      title: '旧实例初始标题',
      messages: [{ role: 'assistant', text: '旧实例初始内容' }],
      totalMessages: 1,
      currentProjectId: 'proj-a',
      currentProjectName: 'Alpha App',
      projects: oldProjectsC3
    };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, '旧实例初始标题');

    let nextNavOverrideSnap = null;
    let nextNonNavOverrideResp = null;
    const prevCase3Fetch = envUi.sandbox.fetch;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      if (u.pathname === '/api/action' && nextNonNavOverrideResp) {
        const respBody = nextNonNavOverrideResp;
        nextNonNavOverrideResp = null;
        const body = JSON.parse(String(init?.body || '{}'));
        dispatchedActions.push(body);
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') },
          json: async () => respBody
        };
      }
      const res = await prevCase3Fetch(url, init);
      if (u.pathname === '/api/action' && nextNavOverrideSnap) {
        const staleSnap = nextNavOverrideSnap;
        nextNavOverrideSnap = null;
        const origJson = await res.json();
        return { ...res, json: async () => ({ ...origJson, snapshot: staleSnap }) };
      }
      return res;
    };

    convListEl.querySelector('button[data-proj-toggle="default-cli-project"]').click();
    gateInlineSnap = true;
    deferredGate = mkGate();
    const gateOldNav = deferredGate;
    nextNavOverrideSnap = {
      ...currentUiSnap,
      serverBootId: 'boot-old-case3',
      serverBootAt: baseBootAt + 1000,
      snapSeq: 51,
      sessionId: projBConv.id,
      isNewConversation: false,
      title: '旧实例迟到脏标题',
      messages: [{ role: 'assistant', text: '旧实例迟到脏消息' }],
      totalMessages: 1,
      currentProjectId: 'proj-b',
      currentProjectName: 'Beta Core',
      projects: oldProjectsMissingCliC3
    };
    convListEl.querySelector(`button[data-cid="${projBConv.id}"]`).click();
    await new Promise((r) => setTimeout(r, 15));

    // 在旧实例导航在途期间，手机再次点选 CLI Project，随后新实例上线并下发 snapSeq: 1 的快照
    convListEl.querySelector('button[data-proj-toggle="default-cli-project"]').click();
    currentUiSnap = {
      ...currentUiSnap,
      serverBootId: 'boot-new-case3',
      serverBootAt: baseBootAt + 2000,
      snapSeq: 1,
      sessionId: 'conv-root-001',
      isNewConversation: false,
      title: '新实例最新标题',
      messages: [{ role: 'assistant', text: '新实例最新回复' }],
      totalMessages: 1,
      currentProjectId: 'proj-b',
      currentProjectName: 'Beta Core',
      projects: oldProjectsC3
    };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, '新实例最新标题', '新实例重启后的 snapSeq:1 快照应成功渲染');
    assert.ok((envUi.doc.getElementById('messages')?.textContent || '').includes('新实例最新回复'));

    // 放行旧实例在途导航回包（同一旧 bootId 的 snapSeq: 51）
    gateOldNav.resolve();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, '新实例最新标题', '旧实例迟到导航回包不得覆盖新实例标题');
    const msgsAfterLateNav = envUi.doc.getElementById('messages')?.textContent || '';
    assert.ok(msgsAfterLateNav.includes('新实例最新回复'), '旧实例迟到导航回包后应保持新实例消息');
    assert.equal(msgsAfterLateNav.includes('旧实例迟到脏消息'), false, '旧实例迟到导航回包消息不得污染视图');

    // 再发一个晚起飞的非导航动作（拥有更新的 reqStartEpoch），但错误路由回已淘汰旧实例 boot-old-case3 的更高 snapSeq:52
    nextNonNavOverrideResp = {
      ok: true,
      actionResult: { ok: true },
      snapshot: {
        ...currentUiSnap,
        serverBootId: 'boot-old-case3',
        serverBootAt: baseBootAt + 1000,
        snapSeq: 52,
        sessionId: projBConv.id,
        isNewConversation: false,
        title: '旧实例晚起飞脏标题',
        messages: [{ role: 'assistant', text: '旧实例晚起飞脏消息' }],
        totalMessages: 1,
        currentProjectId: 'proj-b',
        currentProjectName: 'Beta Core',
        projects: oldProjectsMissingCliC3
      }
    };
    const toggleThinkingChip = envUi.doc.getElementById('chips').querySelectorAll('.chip').find((b) => (b.textContent || '').includes('展开/收起思考'));
    assert.ok(toggleThinkingChip, '快捷操作条应包含「展开/收起思考」按钮');
    toggleThinkingChip.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, '新实例最新标题', '已淘汰旧实例即使带有更高 reqStartEpoch 也不得回退标题');
    assert.equal((envUi.doc.getElementById('messages')?.textContent || '').includes('旧实例晚起飞脏消息'), false);

    // 未曾渲染过的更早实例 boot-ancient-0（serverBootAt 更早）轮询回包同样必须被拒绝
    currentUiSnap = {
      ...currentUiSnap,
      serverBootId: 'boot-ancient-0',
      serverBootAt: baseBootAt + 500,
      snapSeq: 999,
      sessionId: projBConv.id,
      isNewConversation: false,
      title: '未见过老实例脏标题',
      messages: [{ role: 'assistant', text: '未见过老实例脏消息' }],
      totalMessages: 1,
      projects: oldProjectsMissingCliC3
    };
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, '新实例最新标题', 'serverBootAt 更早的未知旧实例轮询不得回退视图');
    assert.equal((envUi.doc.getElementById('messages')?.textContent || '').includes('未见过老实例脏消息'), false);

    await assertProjectHeldC('default-cli-project', 'CLI Project');

    enhReal.dispose?.();
    envReal.sandbox.__AGContextMeter?.dispose?.();
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    if (prevCtxStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevCtxStateDir;
    if (prevConfigDir === undefined) delete process.env.AG_CONFIG_DIR;
    else process.env.AG_CONFIG_DIR = prevConfigDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 20: 远程会话全量历史消息上翻加载、长回复防截断与授权模式图标动态联动
// =========================================================================
test('需求 20: 远程会话全量历史消息上翻加载、长回复防截断与授权模式图标动态联动', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req18-'));
  const stateDir = path.join(tmpRoot, 'state');
  const configDir = path.join(tmpRoot, 'config');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });

  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevCtxStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  const prevConfigDir = process.env.AG_CONFIG_DIR;

  try {
    process.env.APPDATA = stateDir;
    process.env.AG_METER_STATE_DIR = stateDir;
    process.env.AG_CONTEXT_METER_STATE_DIR = stateDir;
    process.env.AG_CONFIG_DIR = configDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const remoteMod = require('./mobile-remote.js');

    // 1. 服务端 Markdown 安全渲染（表格、代码块、外链/文件胶囊与 XSS 过滤）
    const mdHtml = remoteMod.renderSafeMarkdownToHtml(
      '## 架构汇总\n\n| 模块 | 状态 |\n| --- | --- |\n| history | OK |\n\n```js\nconst x = "<script>alert(1)</script>";\n```\n\n参考 [doc](file:///tmp/a.md)、[官网](https://example.com) 与 [xss](javascript:alert(1)) <script>evil()</script>'
    );
    assert.ok(mdHtml.includes('<h2>架构汇总</h2>'));
    assert.ok(mdHtml.includes('<div class="md-table-wrap"><table>'));
    assert.ok(mdHtml.includes('<pre><code>const x = &quot;&lt;script&gt;'));
    assert.ok(mdHtml.includes('<code class="md-pill">doc</code>'));
    assert.ok(mdHtml.includes('href="https://example.com"'));
    assert.equal(mdHtml.includes('javascript:'), false, '禁止渲染 javascript: 危险协议');
    assert.equal(mdHtml.includes('<script>evil'), false, '原始 script 标签必须转义不得透传');

    // 2. 75 轮 (150 条消息 / >500 步含工具调用、@文件、思考与 12000 字长回复) 轨迹完整提取 + 桌面 DOM 虚拟化仅剩 3 条 + 失败保底
    const steps150 = [];
    const longBody = '长文报告头部。' + '详细分析内容段落。'.repeat(1200) + '长文结尾标记_END';
    for (let t = 0; t < 75; t++) {
      steps150.push({
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: {
          items: t === 0
            ? [{ text: '首轮原始指令' }, { item: { file: { absoluteUri: 'file:///tmp/spec.md' } } }]
            : [{ text: `用户问题 #${t}` }]
        }
      });
      steps150.push({ type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { command: 'ls' } });
      steps150.push({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: { thinking: `思考步骤 #${t}`, response: '' }
      });
      steps150.push({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: {
          response: t === 74 ? longBody : `助手回复 #${t}`
        }
      });
    }
    const sid = 'sess-long-150';
    let failTraj = false;
    const mockConnect = async () => ({
      call: async (method) => {
        if (method === 'GetCascadeTrajectory') {
          if (failTraj) throw new Error('LS busy');
          return { trajectory: { steps: steps150 } };
        }
        if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
        return {};
      }
    });

    const tail3DomMsgs = [
      { id: 'u-dom-1', role: 'user', text: '用户问题 #73' },
      { id: 'a-dom-1', role: 'assistant', text: '助手回复 #73', highRisk: true, riskText: '🛡️ 含高危命令' },
      { id: 'u-dom-2', role: 'user', text: '用户问题 #74' },
      { id: 'a-dom-2', role: 'assistant', text: longBody }
    ];

    const snapFull = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: sid,
      busy: false,
      messages: tail3DomMsgs,
      conversations: [],
      projects: []
    }, { stateDir, configDir, msgLimit: 30, bypassCache: true, localApiConnect: mockConnect });

    assert.equal(snapFull.totalMessages, 150, '桌面 DOM 仅剩 3~4 条时应从轨迹恢复全部 150 条消息');
    assert.equal(snapFull.messagesStartIndex, 120);
    assert.equal(snapFull.hasEarlierMessages, true);
    assert.equal(snapFull.messages.length, 30);
    const lastMsg = snapFull.messages[snapFull.messages.length - 1];
    assert.ok(lastMsg.text.includes('长文结尾标记_END') && lastMsg.text.length > 10000, '长回复不得被 4000 字截断');
    assert.equal(snapFull.messages.find((m) => m.text === '助手回复 #73')?.highRisk, true, 'DOM 高危标记应无损并入轨迹消息');

    // 轨迹接口临时失败时保留缓存的 150 条全量历史，不得缩水成 4 条 DOM 消息
    failTraj = true;
    const snapOnFail = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: sid,
      busy: false,
      messages: tail3DomMsgs,
      conversations: [],
      projects: []
    }, { stateDir, configDir, msgLimit: 30, bypassCache: true, localApiConnect: mockConnect });
    assert.equal(snapOnFail.totalMessages, 150, '轨迹请求失败时应保留已缓存的 150 条消息不缩水');
    failTraj = false;

    // HTTP /api/messages 缺 sessionId 校验返回 400
    const httpCfg = remoteMod.loadOrCreateRemoteConfig();
    const httpHandler = remoteMod.createRemoteHttpHandler(httpCfg);
    const missingSidRes = await new Promise((resolve) => {
      httpHandler({
        method: 'GET',
        url: `/api/messages?token=${encodeURIComponent(httpCfg.token)}`,
        headers: { host: `127.0.0.1:${httpCfg.port}` },
        socket: { remoteAddress: '127.0.0.1' }
      }, {
        setHeader() {},
        writeHead(status) { this.status = status; },
        end(body) { resolve({ status: this.status, json: JSON.parse(String(body || '{}')) }); }
      });
    });
    assert.equal(missingSidRes.status, 400);

    // 3. 验证 ag-enhancer-overlay.js：>120000 字长用户消息/回复 DOM 不截断 + 轨迹与 DOM 回退双路径全文保留 + 授权模式（含窄侧栏纯图标 SVG）精准识别
    const ultraUserDom = '超长用户DOM消息_' + 'U'.repeat(135000) + '_DOM_USER_135K_END';
    const ultraReplyDom = '超长助手DOM回复_' + 'A'.repeat(135000) + '_DOM_REPLY_135K_END';
    const ultraUserTraj = '超长用户轨迹消息_' + 'Q'.repeat(135000) + '_TRAJ_USER_135K_END';
    const ultraReplyTraj = '超长助手轨迹回复_' + 'R'.repeat(135000) + '_TRAJ_REPLY_135K_END';

    const trajUltraSnap = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: 'sess-ultra-traj-135k',
      busy: false,
      messages: [],
      conversations: [],
      projects: []
    }, {
      stateDir,
      configDir,
      msgLimit: 10,
      bypassCache: true,
      localApiConnect: async () => ({
        call: async (method) => method === 'GetCascadeTrajectory'
          ? {
              trajectory: {
                steps: [
                  { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: ultraUserTraj }] } },
                  { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: ultraReplyTraj } }
                ]
              }
            }
          : {}
      })
    });
    assert.equal(trajUltraSnap.messages.length, 2);
    assert.ok(trajUltraSnap.messages[0].text.length > 135000 && trajUltraSnap.messages[0].text.endsWith('TRAJ_USER_135K_END'), '轨迹路径用户消息 >120000 字不得截断');
    assert.ok(trajUltraSnap.messages[1].text.length > 135000 && trajUltraSnap.messages[1].text.endsWith('TRAJ_REPLY_135K_END'), '轨迹路径助手回复 >120000 字不得截断');
    assert.ok(trajUltraSnap.messages[1].html.includes('TRAJ_REPLY_135K_END'), '轨迹路径助手 HTML >120000 字不得截断');
    const ultraPage = await remoteMod.getConversationMessagesPage({
      sessionId: 'sess-ultra-traj-135k',
      before: 2,
      limit: 10
    });
    assert.ok(ultraPage.messages[0].text.endsWith('TRAJ_USER_135K_END'));
    assert.ok(ultraPage.messages[1].text.endsWith('TRAJ_REPLY_135K_END'));

    const envEnh = createDomEnv();
    envEnh.sandbox.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_POSITION_FOLLOWING: 4 };
    envEnh.win.location = { pathname: '/c/enh-perm-test', search: '' };
    envEnh.sandbox.location = envEnh.win.location;
    envEnh.sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, uiPreferences: {} }) });

    const scrollVp = envEnh.doc.createElement('div');
    scrollVp.setAttribute('data-testid', 'chat-scroll-container');
    const longUserEl = envEnh.doc.createElement('div');
    longUserEl.setAttribute('data-testid', 'user-message');
    const longUserContent = envEnh.doc.createElement('div');
    longUserContent.setAttribute('data-testid', 'user-message-content');
    longUserContent.textContent = ultraUserDom;
    longUserEl.appendChild(longUserContent);
    scrollVp.appendChild(longUserEl);

    const longAgentEl = envEnh.doc.createElement('div');
    longAgentEl.setAttribute('data-testid', 'agent-response');
    const longMdEl = envEnh.doc.createElement('div');
    longMdEl.setAttribute('data-markdown-root', '');
    longMdEl.compareDocumentPosition = () => 2;
    longMdEl.innerHTML = `<p>${ultraReplyDom}</p>`;
    if (longMdEl.children[0]?.childNodes?.[0]) {
      longMdEl.children[0].childNodes[0].nodeValue = ultraReplyDom;
    }
    longAgentEl.appendChild(longMdEl);
    scrollVp.appendChild(longAgentEl);
    envEnh.doc.body.appendChild(scrollVp);

    const permTrigger = envEnh.doc.createElement('button');
    permTrigger.setAttribute('data-testid', 'permissions-selector-trigger');
    permTrigger.textContent = '请求审核';
    envEnh.doc.body.appendChild(permTrigger);

    vm.runInContext(RENDERER_SRC, envEnh.sandbox);
    vm.runInContext(ENHANCER_SRC, envEnh.sandbox);
    const enhApi = envEnh.sandbox.__AGEnhancer;

    const snapEnhReview = enhApi.getMobileSnapshot();
    assert.equal(snapEnhReview.permissionKey, 'request_review');
    assert.equal(snapEnhReview.messages.length, 2);
    assert.ok(snapEnhReview.messages[0]?.text?.endsWith('DOM_USER_135K_END') && snapEnhReview.messages[0].text.length > 135000, 'DOM 用户消息超过 120000 字时不应截断');
    assert.ok(snapEnhReview.messages[1]?.text?.endsWith('DOM_REPLY_135K_END') && snapEnhReview.messages[1].text.length > 135000, 'DOM 回复超过 120000 字时不应截断');
    assert.ok(snapEnhReview.messages[1]?.html?.includes('DOM_REPLY_135K_END'), 'DOM 回复 HTML 超过 120000 字时不应截断');

    const domFallbackUltraSnap = await remoteMod.enrichSnapshotWithCatalog({
      ok: true,
      sessionId: 'sess-dom-fallback-135k',
      busy: false,
      messages: snapEnhReview.messages,
      conversations: [],
      projects: []
    }, {
      stateDir,
      configDir,
      msgLimit: 10,
      bypassCache: true,
      localApiConnect: async () => null
    });
    assert.equal(domFallbackUltraSnap.messages.length, 2);
    assert.ok(domFallbackUltraSnap.messages[0].text.endsWith('DOM_USER_135K_END') && domFallbackUltraSnap.messages[0].text.length > 135000, '无轨迹连接 DOM 回退路径用户消息 >120000 字应完整保留');
    assert.ok(domFallbackUltraSnap.messages[1].text.endsWith('DOM_REPLY_135K_END') && domFallbackUltraSnap.messages[1].text.length > 135000, '无轨迹连接 DOM 回退路径助手回复 >120000 字应完整保留');
    assert.ok(domFallbackUltraSnap.messages[1].html.includes('DOM_REPLY_135K_END'), '无轨迹连接 DOM 回退路径 HTML >120000 字应完整保留');

    // 窄屏下按钮文字隐藏、仅余原生 SVG 路径时仍能精确识别 4 种模式
    permTrigger.textContent = '';
    for (const [expectedKey, pathD] of [
      ['turbo', 'M502.92-344.77q9.38'],
      ['auto', 'M480-100.77Q350.23'],
      ['default', 'M252.31-100q-29.92'],
      ['request_review', 'M595.58-384.51q47.5']
    ]) {
      permTrigger.innerHTML = `<svg viewBox="0 -960 960 960"><path d="${pathD}"></path></svg>`;
      assert.equal(enhApi.getMobileSnapshot().permissionKey, expectedKey, `纯图标 SVG 应识别为 ${expectedKey}`);
    }
    enhApi.dispose?.();
    envEnh.sandbox.__AGContextMeter?.dispose?.();

    // 4. 验证远程网页 UI：向上翻页加载全部 150+2 条历史、无间隙新消息合并及 4 种授权模式图标动态变化
    const mobileHtml = remoteMod.buildMobileAppHtml();
    const inlineScript = mobileHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(inlineScript));

    const envUi = createDomEnv();
    envUi.doc.body.innerHTML = mobileHtml.match(/<body>([\s\S]*?)<script>/)[1];
    let liveSnapState = {
      ...snapFull,
      permissionKey: 'turbo',
      permissionLabel: '无限',
      permissionOptions: [
        { key: 'turbo', label: '⚡ 无限 (Turbo)' },
        { key: 'auto', label: '🛡️ 自动 (Auto)' },
        { key: 'default', label: '🔒 默认 (Default)' },
        { key: 'request_review', label: '👁️ 请求审核 (Review)' }
      ]
    };

    let delayNextMessagesGate = null;
    envUi.win.innerWidth = 414;
    envUi.win.innerHeight = 840;
    envUi.win.AbortController = AbortController;
    envUi.win.location = { pathname: '/', search: '?token=testtok', protocol: 'http:', reload() {} };
    envUi.win.history = { replaceState() {} };
    envUi.sandbox.location = envUi.win.location;
    envUi.sandbox.history = envUi.win.history;
    envUi.sandbox.AbortController = AbortController;
    envUi.sandbox.URLSearchParams = URLSearchParams;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      const jsonHeaders = { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') };
      if (u.pathname === '/api/snapshot') {
        return { ok: true, status: 200, headers: jsonHeaders, json: async () => liveSnapState };
      }
      if (u.pathname === '/api/messages') {
        if (delayNextMessagesGate) {
          const gate = delayNextMessagesGate;
          delayNextMessagesGate = null;
          await gate.promise;
        }
        const page = await remoteMod.getConversationMessagesPage({
          sessionId: u.searchParams.get('sessionId') || sid,
          before: u.searchParams.get('before'),
          limit: Number(u.searchParams.get('limit') || '30'),
          localApiConnect: mockConnect
        });
        return { ok: true, status: 200, headers: jsonHeaders, json: async () => page };
      }
      if (u.pathname === '/api/action') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.action === 'select-permission') {
          const labels = { turbo: '无限', auto: '自动', default: '默认', request_review: '请求审核' };
          liveSnapState = { ...liveSnapState, permissionKey: body.preset, permissionLabel: labels[body.preset] || body.preset };
          return {
            ok: true,
            status: 200,
            headers: jsonHeaders,
            json: async () => ({ ok: true, actionResult: { ok: true, preset: body.preset, permissionKey: body.preset, permissionLabel: labels[body.preset] }, snapshot: liveSnapState })
          };
        }
        return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: true, snapshot: liveSnapState }) };
      }
      return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: true }) };
    };

    const msgContainer = envUi.doc.getElementById('messages');
    // 为 #messages 挂载贴近真实 Flex 纵向排版的非均匀尺寸与动态视口几何计算器
    (function attachVerticalLayout(container) {
      const VIEWPORT_TOP = 54;
      const CLIENT_H = 400;
      const PAD_TOP = 14;
      const PAD_BOT = 12;
      const GAP = 16;
      let scrollTopVal = 0;
      let scrollHeightVal = CLIENT_H;

      container.clientHeight = CLIENT_H;
      container.getBoundingClientRect = () => ({
        top: VIEWPORT_TOP,
        left: 0,
        width: 380,
        right: 380,
        height: CLIENT_H,
        bottom: VIEWPORT_TOP + CLIENT_H
      });
      Object.defineProperty(container, 'scrollHeight', {
        configurable: true,
        get() { return scrollHeightVal; },
        set(v) { scrollHeightVal = Number(v) || CLIENT_H; }
      });
      Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get() { return scrollTopVal; },
        set(v) {
          const maxScroll = Math.max(0, scrollHeightVal - CLIENT_H);
          const n = Number(v) || 0;
          scrollTopVal = Math.max(0, Math.min(maxScroll, n));
        }
      });

      const innerHtmlDesc = Object.getOwnPropertyDescriptor(container, 'innerHTML');
      Object.defineProperty(container, 'innerHTML', {
        configurable: true,
        get() { return innerHtmlDesc.get.call(container); },
        set(htmlStr) {
          innerHtmlDesc.set.call(container, htmlStr);
          let y = PAD_TOP;
          for (const ch of container.children) {
            let h = 32;
            if (ch.id === 'btn-load-earlier') {
              h = 34;
            } else if (ch.classList?.contains('msg')) {
              const idx = Number(ch.getAttribute('data-msg-idx'));
              h = 56 + ((Number.isFinite(idx) ? idx : 0) % 4) * 22;
            }
            ch.offsetTop = y;
            ch.offsetHeight = h;
            ch.getBoundingClientRect = () => {
              const top = VIEWPORT_TOP + (ch.offsetTop - scrollTopVal);
              return { top, left: 0, width: 380, right: 380, height: h, bottom: top + h };
            };
            y += h + GAP;
          }
          scrollHeightVal = container.children.length
            ? Math.max(CLIENT_H, y - GAP + PAD_BOT)
            : CLIENT_H;
        }
      });
    })(msgContainer);

    vm.runInContext(inlineScript, envUi.sandbox);
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(msgContainer.querySelector('#btn-load-earlier'), '存在更早消息时顶部应渲染加载更早按钮');
    assert.equal(msgContainer.querySelectorAll('.msg').length, 30);

    const getViewportOffset = (idx) => {
      const node = msgContainer.querySelector(`[data-msg-idx="${idx}"]`);
      assert.ok(node, `消息 #${idx} 节点应存在`);
      return node.getBoundingClientRect().top - msgContainer.getBoundingClientRect().top;
    };

    // 场景 1（向上分页）：向上滚到停在 #124（视口偏移 -18px），加载前 30 条 [90..119] 后阅读位置应精准锁在 #124 (-18px)
    const el124Before = msgContainer.querySelector('[data-msg-idx="124"]');
    const oldTop124 = el124Before.offsetTop;
    msgContainer.scrollTop = oldTop124 + 18;
    msgContainer.dispatchEvent({ type: 'scroll' });
    const scrollBeforePage = msgContainer.scrollTop;
    assert.equal(getViewportOffset(124), -18);

    msgContainer.querySelector('#btn-load-earlier').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(msgContainer.querySelectorAll('.msg').length, 60);
    const newTop124 = msgContainer.querySelector('[data-msg-idx="124"]').offsetTop;
    const insertedAbove124 = newTop124 - oldTop124;
    assert.ok(insertedAbove124 > 2000, '顶部插入 30 条后 #124 应真实下移超过 2000px');
    assert.equal(msgContainer.scrollTop, scrollBeforePage + insertedAbove124, '上翻分页应精确补偿上方新增高度');
    assert.equal(getViewportOffset(124), -18, '上翻分页后可见锚点 #124 视口偏移应丝毫不差保持 -18px');

    // 底部新增 2 条消息使尾窗滑动为 [122..151]，已加载的 [90..121] 应无间隙衔接，且不拉动上方阅读锚点
    steps150.push(
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '新增用户问题 #75' }] } },
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '新增助手回复 #75' } }
    );
    liveSnapState = await remoteMod.enrichSnapshotWithCatalog({
      ...liveSnapState,
      messages: [
        ...tail3DomMsgs,
        { id: 'u-new', role: 'user', text: '新增用户问题 #75' },
        { id: 'a-new', role: 'assistant', text: '新增助手回复 #75' }
      ]
    }, { stateDir, configDir, msgLimit: 30, bypassCache: true, localApiConnect: mockConnect });
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(msgContainer.querySelectorAll('.msg').length, 62, '底部滑动窗口更新后已加载历史 [90..121] 不得出现断层');
    assert.equal(getViewportOffset(124), -18, '尾部追加消息时不主动打断上方阅读位置');

    // 场景 2（缺口位于视口下方）：停在上方历史 #105（视口偏移 +14px），底部突发新增 40 条产生下方空洞 [152..161] 并回填
    const el105Before = msgContainer.querySelector('[data-msg-idx="105"]');
    msgContainer.scrollTop = el105Before.offsetTop - 14;
    msgContainer.dispatchEvent({ type: 'scroll' });
    const scrollBeforeGapBelow = msgContainer.scrollTop;
    const scrollHBeforeGapBelow = msgContainer.scrollHeight;
    assert.equal(getViewportOffset(105), 14);

    for (let k = 76; k < 96; k++) {
      steps150.push(
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: `新增空洞用户 #${k}` }] } },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: `新增空洞回复 #${k}` } }
      );
    }
    liveSnapState = await remoteMod.enrichSnapshotWithCatalog({
      ...liveSnapState,
      messages: [
        { id: 'u-jump-last', role: 'user', text: '新增空洞用户 #95' },
        { id: 'a-jump-last', role: 'assistant', text: '新增空洞回复 #95' }
      ]
    }, { stateDir, configDir, msgLimit: 30, bypassCache: true, localApiConnect: mockConnect });
    assert.equal(liveSnapState.totalMessages, 192);
    assert.equal(liveSnapState.messagesStartIndex, 162);

    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 80));
    const afterGapMsgs = msgContainer.querySelectorAll('.msg');
    assert.equal(afterGapMsgs.length, 102, '突发新增 40 条产生索引空洞 [152..161] 后应自动回填补齐 [90..191] 共 102 条连续消息');
    for (let i = 0; i < afterGapMsgs.length; i++) {
      assert.equal(Number(afterGapMsgs[i].getAttribute('data-msg-idx')), 90 + i, `消息索引第 ${i} 项应严格连续为 ${90 + i}`);
    }
    assert.ok((msgContainer.textContent || '').includes('新增空洞用户 #76'), '空洞区间内第 152 条消息必须完整补回');
    assert.ok((msgContainer.textContent || '').includes('新增空洞回复 #80'), '空洞区间内第 161 条消息必须完整补回');
    assert.ok(msgContainer.scrollHeight > scrollHBeforeGapBelow + 3000, '下方补齐 40 条后总滚动高度应显著增加');
    assert.equal(msgContainer.scrollTop, scrollBeforeGapBelow, '缺口位于视口下方时不得把下方新增高度累加到 scrollTop');
    assert.equal(getViewportOffset(105), 14, '缺口位于视口下方回填后，原可见锚点 #105 视口偏移应纹丝不动保持 14px');

    // 场景 3（缺口位于视口上方）：延迟空洞拉取，用户停留在下方 #210（+22px），待上方空洞 [192..201] 插入后锚点保持 +22px
    let resolveGapAboveGate;
    delayNextMessagesGate = {
      promise: new Promise((resolve) => { resolveGapAboveGate = resolve; })
    };
    for (let k = 96; k < 116; k++) {
      steps150.push(
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: `二次跳跃用户 #${k}` }] } },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: `二次跳跃回复 #${k}` } }
      );
    }
    liveSnapState = await remoteMod.enrichSnapshotWithCatalog({
      ...liveSnapState,
      messages: [
        { id: 'u-jump2-last', role: 'user', text: '二次跳跃用户 #115' },
        { id: 'a-jump2-last', role: 'assistant', text: '二次跳跃回复 #115' }
      ]
    }, { stateDir, configDir, msgLimit: 30, bypassCache: true, localApiConnect: mockConnect });
    assert.equal(liveSnapState.totalMessages, 232);
    assert.equal(liveSnapState.messagesStartIndex, 202);

    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));

    // 用户滚动到下方尾窗的 #210（距底远超 80px），使空洞 [192..201] 恰好位于当前视口上方
    const el210Before = msgContainer.querySelector('[data-msg-idx="210"]');
    const oldTop210 = el210Before.offsetTop;
    msgContainer.scrollTop = oldTop210 - 22;
    msgContainer.dispatchEvent({ type: 'scroll' });
    const scrollBeforeGapAbove = msgContainer.scrollTop;
    assert.equal(getViewportOffset(210), 22);

    resolveGapAboveGate();
    await new Promise((r) => setTimeout(r, 80));
    const afterGap2Msgs = msgContainer.querySelectorAll('.msg');
    assert.equal(afterGap2Msgs.length, 142, '上方空洞 [192..201] 回填完成后应拥有 [90..231] 共 142 条连续消息');
    for (let i = 0; i < afterGap2Msgs.length; i++) {
      assert.equal(Number(afterGap2Msgs[i].getAttribute('data-msg-idx')), 90 + i);
    }
    const newTop210 = msgContainer.querySelector('[data-msg-idx="210"]').offsetTop;
    const insertedAbove210 = newTop210 - oldTop210;
    assert.ok(insertedAbove210 > 800, '视口上方插入 [192..201] 后 #210 的 offsetTop 应下移超过 800px');
    assert.equal(msgContainer.scrollTop, scrollBeforeGapAbove + insertedAbove210, '缺口位于视口上方回填时应精准下移 scrollTop');
    assert.equal(getViewportOffset(210), 22, '缺口位于视口上方回填后，#210 视口偏移仍严格保持 22px');

    // 继续上翻直至第 0 条（首轮原始指令 @spec.md）完整呈现，且顶部按钮自动消失后锚点仍不跳动
    for (let step = 0; step < 5; step++) {
      const earlierBtn = msgContainer.querySelector('#btn-load-earlier');
      if (!earlierBtn) break;
      earlierBtn.click();
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(msgContainer.querySelectorAll('.msg').length, 232, '连续上翻应能读到从第 0 条至今全部 232 条对话内容');
    assert.ok((msgContainer.textContent || '').includes('首轮原始指令 @spec.md'), '第 0 条首轮消息及 @文件引用应完整可读');
    assert.equal(msgContainer.querySelector('#btn-load-earlier'), null, '翻到首条后顶部加载按钮应自动消失');

    // 验证 4 种授权模式图标随选择与快照实时切换（绝不固定在 Turbo 闪电图标）
    const permIconEl = envUi.doc.getElementById('perm-inline-icon');
    const seenSvgs = new Map();
    for (const [mode, expectedText] of [
      ['turbo', '无限'],
      ['auto', '自动'],
      ['default', '默认'],
      ['request_review', '请求审核']
    ]) {
      envUi.doc.getElementById('btn-perm-inline').click();
      const targetOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt').find((b) => (b.textContent || '').includes(expectedText));
      assert.ok(targetOpt, `权限弹窗应包含 ${expectedText}`);
      targetOpt.click();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(permIconEl.getAttribute('data-perm-mode'), mode, `切换到 ${expectedText} 后图标模式应变为 ${mode}`);
      assert.ok(permIconEl.classList.contains(mode));
      seenSvgs.set(mode, permIconEl.innerHTML);
    }
    assert.equal(new Set(seenSvgs.values()).size, 4, '4 种授权模式必须渲染 4 个各不相同的图标 SVG');
    envUi.doc.getElementById('btn-perm-inline').click();
    const activeOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt').find((b) => b.classList.contains('active'));
    assert.ok((activeOpt?.textContent || '').includes('请求审核'), '权限弹窗应精确高亮当前 请求审核 模式');
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    if (prevCtxStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevCtxStateDir;
    if (prevConfigDir === undefined) delete process.env.AG_CONFIG_DIR;
    else process.env.AG_CONFIG_DIR = prevConfigDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 21: 项目名条视觉层级、回车换行交互、浏览本机目录创建新项目与三态主题共存
// =========================================================================
test('需求 21: 项目分组头样式层级、Enter换行按钮发送、本机目录浏览建项目及三态外观共存', async () => {
  const { pathToFileURL } = require('url');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req19-'));
  const stateDir = path.join(tmpRoot, 'state');
  const homeDir = path.join(tmpRoot, 'home');
  const configDir = path.join(homeDir, '.gemini', 'config');
  const projectsDir = path.join(configDir, 'projects');
  const codebaseDir = path.join(homeDir, 'codebase');
  const sharedDir = path.join(homeDir, 'shared');
  const sharedArmyDir = path.join(sharedDir, '_army');
  const repoADir = path.join(codebaseDir, 'repo-a');
  const plainBDir = path.join(codebaseDir, 'plain-b');
  const existingRepoDir = path.join(codebaseDir, 'repo-existing');
  const dupOwnerDir = path.join(homeDir, 'other', 'plain-b-owner');
  const hiddenDir = path.join(codebaseDir, '.hidden-dir');

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(repoADir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repoADir, '.git', 'HEAD'), 'ref: refs/heads/develop\n', 'utf8');
  fs.mkdirSync(plainBDir, { recursive: true });
  fs.mkdirSync(existingRepoDir, { recursive: true });
  fs.mkdirSync(sharedArmyDir, { recursive: true });
  fs.mkdirSync(dupOwnerDir, { recursive: true });
  fs.mkdirSync(hiddenDir, { recursive: true });
  fs.writeFileSync(path.join(codebaseDir, 'note.txt'), 'not a folder', 'utf8');

  // 预设两个已有项目：一个将 ~/shared/_army 作为辅资源 [1]（不应误标 _army），一个占用名称 plain-b
  const existingProjId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(projectsDir, `${existingProjId}.json`), JSON.stringify({
    id: existingProjId,
    name: 'repo-existing',
    projectResources: {
      resources: [
        { folderUri: pathToFileURL(existingRepoDir).href },
        { folderUri: pathToFileURL(sharedArmyDir).href }
      ]
    },
    settings: {},
    isWorkspaceOnly: false
  }), 'utf8');

  const dupNameProjId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(projectsDir, `${dupNameProjId}.json`), JSON.stringify({
    id: dupNameProjId,
    name: 'plain-b',
    projectResources: {
      resources: [{ folderUri: pathToFileURL(dupOwnerDir).href }]
    },
    settings: {},
    isWorkspaceOnly: false
  }), 'utf8');

  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevCtxStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  const prevConfigDir = process.env.AG_CONFIG_DIR;

  try {
    process.env.APPDATA = stateDir;
    process.env.AG_METER_STATE_DIR = stateDir;
    process.env.AG_CONTEXT_METER_STATE_DIR = stateDir;
    process.env.AG_CONFIG_DIR = configDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const remoteMod = require('./mobile-remote.js');

    // 1. CSS 与 HTML 层级校验（项目头字号 > 会话项字号、桌面媒体查询同步、enterkeyhint="enter"）
    const html = remoteMod.buildMobileAppHtml();
    const cssText = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    assert.doesNotThrow(() => new vm.Script(inlineScript));

    const mobileCss = cssText.split('@media (min-width:860px)')[0];
    const desktopCss = cssText.split('@media (min-width:860px)')[1] || '';
    const parseFontPx = (chunk, sel) => {
      const m = chunk.match(new RegExp(`\\${sel}\\{[^}]*?font-size:([0-9.]+)px`));
      return m ? Number(m[1]) : 0;
    };
    const mobProjFs = parseFontPx(mobileCss, '.proj-toggle');
    const mobConvFs = parseFontPx(mobileCss, '.conv-item');
    const deskProjFs = parseFontPx(desktopCss, '.proj-toggle');
    const deskConvFs = parseFontPx(desktopCss, '.conv-item');
    assert.ok(mobProjFs > mobConvFs && mobProjFs >= 14, `移动端项目头字号 (${mobProjFs}px) 应显著大于会话项 (${mobConvFs}px)`);
    assert.ok(deskProjFs > deskConvFs && deskProjFs >= 13.5, `桌面端项目头字号 (${deskProjFs}px) 应大于会话项 (${deskConvFs}px)`);
    assert.ok(mobileCss.includes('.proj-group.is-current .proj-head'), '应包含当前活跃项目高亮样式');
    assert.ok(mobileCss.includes('.proj-body') && mobileCss.includes('border-left:'), '子会话容器应带缩进左导引线');
    assert.ok(html.includes('enterkeyhint="enter"'), '输入框应声明 enterkeyhint="enter" 以配合手机软键盘换行');
    assert.ok(html.includes('id="btn-new-project"') && html.includes('id="proj-modal-backdrop"'), '应包含新建项目入口与目录选择弹窗');
    assert.ok(cssText.includes('.new-proj-mini-btn{') && cssText.includes('width:34px;height:34px;padding:0'), '新建项目按钮应采用 34×34 紧凑纯图标样式以免挤压左侧栏');
    assert.equal(html.includes('id="btn-theme"'), false, '对话右上角外观按钮应已移除');
    assert.ok(html.includes('id="theme-seg"'), '侧边栏底部纯图标三态选择器必须与新建项目/多项目控件并存');
    const mobSubFs = parseFontPx(mobileCss, '.new-chat-sub');
    const deskSubFs = parseFontPx(desktopCss, '.new-chat-sub');
    assert.ok(mobSubFs > 0 && mobSubFs <= 11, `移动端新建对话下排项目名字号 (${mobSubFs}px) 应为极小字 <= 11px`);
    assert.ok(deskSubFs > 0 && deskSubFs <= 10.5, `桌面端新建对话下排项目名字号 (${deskSubFs}px) 应为极小字 <= 10.5px`);
    const newChatSubRule = (mobileCss.match(/\.new-chat-sub\{[^}]*\}/) || [''])[0];
    assert.ok(
      newChatSubRule.includes('white-space:normal') && newChatSubRule.includes('overflow-wrap:anywhere'),
      '新建对话下排项目名应允许自动换行完整显示'
    );
    assert.equal(newChatSubRule.includes('text-overflow:ellipsis'), false, '#new-chat-sub 不得省略截断长项目名');
    assert.ok(cssText.includes('.proj-head{') && cssText.includes('var(--proj-head-bg)'), '项目分组条应使用主题变量 var(--proj-head-bg)');
    assert.ok(cssText.includes('.proj-toggle{') && cssText.includes('color:var(--fg-strong)'), '项目标题文字应使用主题变量 var(--fg-strong)');
    assert.ok(cssText.includes('.proj-path-input,.proj-field-input{') && cssText.includes('var(--input-bg)'), '目录输入框应使用主题变量 var(--input-bg)');
    assert.ok(cssText.includes('.proj-summary-card.is-warn{') && cssText.includes('var(--warn-card-bg)'), '失败预警卡应使用主题变量 var(--warn-card-bg)');

    // 2. 本机目录读取、隐藏项切换、primaryPath 精确关联及非法目录名拦截
    const homeListing = remoteMod.listHostDirectories({ homeDir, configDir });
    assert.equal(homeListing.path, path.resolve(homeDir));
    assert.ok(homeListing.roots.some((r) => r.path === path.resolve(homeDir) && r.label.includes('~')));
    assert.ok(homeListing.roots.some((r) => r.path === path.resolve(codebaseDir) && r.label === 'codebase'));
    assert.ok(homeListing.roots.some((r) => r.path === path.resolve(sharedDir) && r.label === 'shared'));

    const codebaseDefault = remoteMod.listHostDirectories({ dirPath: codebaseDir, homeDir, configDir });
    const cbNames = codebaseDefault.entries.map((e) => e.name);
    assert.equal(cbNames.includes('note.txt'), false, '目录浏览不得列出普通文件');
    assert.equal(cbNames.includes('.hidden-dir'), false, '默认不列出点开头隐藏目录');
    const repoAEntry = codebaseDefault.entries.find((e) => e.name === 'repo-a');
    assert.equal(repoAEntry?.isGitRepo, true, '包含 .git 的目录应识别为 Git 仓库');
    assert.equal(repoAEntry?.existingProjectId, '', '未创建项目的目录不得误关联');
    const exEntry = codebaseDefault.entries.find((e) => e.name === 'repo-existing');
    assert.equal(exEntry?.existingProjectId, existingProjId, '已有主目录项目应准确标出');

    const sharedListing = remoteMod.listHostDirectories({ dirPath: sharedDir, homeDir, configDir });
    const armyEntry = sharedListing.entries.find((e) => e.name === '_army');
    assert.equal(armyEntry?.existingProjectId, '', '仅作辅资源 resources[1] 出现的共享目录不得被误判成已有主项目');

    const plainBListing = remoteMod.listHostDirectories({ dirPath: plainBDir, homeDir, configDir });
    assert.equal(plainBListing.suggestedName, 'plain-b (2)', '同名冲突目录应自动建议递增项目名 plain-b (2)');

    const codebaseWithHidden = remoteMod.listHostDirectories({ dirPath: codebaseDir, showHidden: true, homeDir, configDir });
    assert.ok(codebaseWithHidden.entries.some((e) => e.name === '.hidden-dir'), 'showHidden=true 时应显示隐藏目录');

    assert.throws(() => remoteMod.listHostDirectories({ dirPath: path.join(codebaseDir, 'note.txt'), homeDir, configDir }), /不是文件夹/);
    assert.throws(() => remoteMod.listHostDirectories({ dirPath: path.join(codebaseDir, 'missing-dir'), homeDir, configDir }), /不存在/);
    assert.throws(() => remoteMod.createHostSubdirectory({ parentPath: codebaseDir, name: '../escape' }, { homeDir }), /非法/);

    // 3. HTTP Handler (/api/fs/dirs, /api/fs/mkdir, /api/projects) + Mock Language Server 全链路
    const rpcCalls = [];
    const mockConnect = async () => ({
      call: async (method, body) => {
        rpcCalls.push({ method, body });
        if (method === 'ResolveFolder') {
          const p = decodeURIComponent(new URL(body.folderUri).pathname);
          return fs.existsSync(path.join(p, '.git'))
            ? { resourceType: 'FOLDER_TYPE_GIT_FOLDER', vcsType: 'VCS_TYPE_GIT' }
            : { resourceType: 'FOLDER_TYPE_LOCAL_FOLDER', vcsType: 'VCS_TYPE_UNSPECIFIED' };
        }
        if (method === 'GetRepoInfos') {
          return {
            repos: [{
              branches: [
                { name: 'develop', isCurrentBranch: true },
                { name: 'main', isCurrentBranch: false }
              ]
            }]
          };
        }
        if (method === 'CreateProject') {
          const proj = body.project;
          fs.writeFileSync(path.join(projectsDir, `${proj.id}.json`), JSON.stringify(proj, null, 2), 'utf8');
          return { project: proj };
        }
        if (method === 'ReadProject') {
          const pFile = path.join(projectsDir, `${body.id}.json`);
          if (fs.existsSync(pFile)) {
            return { project: JSON.parse(fs.readFileSync(pFile, 'utf8')) };
          }
        }
        return {};
      }
    });

    const httpCfg = remoteMod.loadOrCreateRemoteConfig();
    let currentProjIdState = existingProjId;
    let failNextNavError = '';
    const navCalls = [];
    const buildDynamicSnap = () => {
      const { metaMap } = (() => {
        const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json'));
        const list = files
          .map((f) => JSON.parse(fs.readFileSync(path.join(projectsDir, f), 'utf8')))
          .filter((p) => !p.archived);
        return { metaMap: list };
      })();
      const projectsList = metaMap.map((p) => ({
        id: p.id,
        name: p.name,
        conversationCount: p.id === existingProjId ? 1 : 0,
        runningCount: 0,
        waitingCount: 0,
        unreadCount: 0,
        isEmpty: p.id !== existingProjId,
        active: p.id === currentProjIdState
      }));
      const curP = projectsList.find((x) => x.id === currentProjIdState);
      return {
        ok: true,
        sessionId: currentProjIdState === existingProjId ? 'conv-existing-1' : '',
        isNewConversation: currentProjIdState !== existingProjId,
        currentProjectId: currentProjIdState,
        currentProjectName: curP?.name || '',
        title: currentProjIdState === existingProjId ? '既有会话' : `新建对话 · ${curP?.name || ''}`,
        busy: false,
        model: 'Claude Opus 4.6',
        permissionKey: 'auto',
        permissionLabel: '自动',
        messages: currentProjIdState === existingProjId ? [{ id: 'm1', msgIndex: 0, role: 'user', text: 'hi' }] : [],
        totalMessages: currentProjIdState === existingProjId ? 1 : 0,
        messagesStartIndex: 0,
        hasEarlierMessages: false,
        projects: projectsList,
        conversations: [
          {
            id: 'conv-existing-1',
            projectId: existingProjId,
            projectName: 'repo-existing',
            title: '既有项目会话',
            active: currentProjIdState === existingProjId,
            status: 'idle',
            updatedAt: Date.now()
          }
        ]
      };
    };

    const handler = remoteMod.createRemoteHttpHandler(httpCfg, {
      homeDir,
      configDir,
      localApiConnect: mockConnect,
      performAction: async (act) => {
        navCalls.push(act);
        if (failNextNavError) {
          return {
            ok: false,
            actionResult: { ok: false, error: failNextNavError },
            snapshot: buildDynamicSnap()
          };
        }
        if (act.action === 'new-conversation' && act.projectId) {
          currentProjIdState = act.projectId;
        }
        return { ok: true, actionResult: { ok: true, projectId: act.projectId || '' }, snapshot: buildDynamicSnap() };
      },
      fetchSnapshot: async () => buildDynamicSnap()
    });

    const invokeHttp = (method, reqPath, bodyObj = null) => new Promise((resolve) => {
      const req = new (require('events').EventEmitter)();
      req.method = method;
      req.url = reqPath;
      req.headers = {
        host: `127.0.0.1:${httpCfg.port}`,
        'x-ag-remote-token': httpCfg.token,
        ...(bodyObj ? { 'content-type': 'application/json' } : {})
      };
      req.socket = { remoteAddress: '127.0.0.1' };
      const res = {
        status: 200,
        headers: {},
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        writeHead(st, hdrs) {
          this.status = st;
          if (hdrs) Object.assign(this.headers, hdrs);
        },
        end(buf) {
          const text = String(buf || '');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: this.status, headers: this.headers, text, json });
        }
      };
      void handler(req, res);
      if (bodyObj !== null) {
        req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
        req.complete = true;
        req.emit('end');
      }
    });

    // 验证 /api/fs/mkdir 与非法路径拦截
    const mkdirRes = await invokeHttp('POST', '/api/fs/mkdir', { parentPath: codebaseDir, name: 'brand-new-dir' });
    assert.equal(mkdirRes.status, 200);
    assert.equal(mkdirRes.json.ok, true);
    assert.ok(fs.existsSync(path.join(codebaseDir, 'brand-new-dir')));

    const badMkdirRes = await invokeHttp('POST', '/api/fs/mkdir', { parentPath: codebaseDir, name: '../bad' });
    assert.equal(badMkdirRes.status, 400);

    // 4. 验证前端 UI：项目标题渲染、Enter 仅换行不发送、点击按钮 & Cmd+Enter 发送、从弹窗创建项目与入口跳转
    const sentActions = [];
    const envUi = createDomEnv();
    envUi.doc.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)[1];
    envUi.win.innerWidth = 414;
    envUi.win.innerHeight = 840;
    envUi.win.AbortController = AbortController;
    envUi.win.location = { pathname: '/', search: `?token=${httpCfg.token}`, protocol: 'http:', reload() {} };
    envUi.win.history = { replaceState() {} };
    envUi.sandbox.location = envUi.win.location;
    envUi.sandbox.history = envUi.win.history;
    envUi.sandbox.AbortController = AbortController;
    envUi.sandbox.URLSearchParams = URLSearchParams;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      const method = String(init?.method || 'GET').toUpperCase();
      if (u.pathname === '/api/snapshot') {
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : '') },
          json: async () => buildDynamicSnap()
        };
      }
      if (u.pathname === '/api/action') {
        const body = JSON.parse(String(init?.body || '{}'));
        sentActions.push(body);
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : '') },
          json: async () => ({ ok: true, actionResult: { ok: true }, snapshot: buildDynamicSnap() })
        };
      }
      if (u.pathname === '/api/fs/dirs' || u.pathname === '/api/fs/mkdir' || u.pathname === '/api/projects') {
        const bodyObj = init?.body ? JSON.parse(String(init.body)) : null;
        const r = await invokeHttp(method, u.pathname + u.search, bodyObj);
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          headers: { get: () => 'application/json' },
          json: async () => r.json
        };
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
    };

    vm.runInContext(inlineScript, envUi.sandbox);
    await new Promise((r) => setTimeout(r, 40));

    // 校验渲染的项目头 DOM 结构（.proj-group.is-current、.proj-icon、.proj-count、.proj-body）及与三态主题切换实时联动
    const convListEl = envUi.doc.getElementById('conv-list');
    assert.ok(convListEl.querySelector('.proj-group.is-current'), '当前项目组应带有 is-current 高亮类');
    assert.ok(convListEl.querySelector('.proj-toggle .proj-icon svg'), '项目标题条应渲染文件夹 SVG 图标');
    assert.ok(convListEl.querySelector('.proj-body .conv-item'), '项目下应有带导引线的 .proj-body 包裹会话项');
    assert.equal(envUi.doc.getElementById('btn-theme'), null, '右上角顶栏不应渲染独立外观切换按钮');
    assert.ok(envUi.doc.getElementById('theme-seg'), '侧边栏底部三段外观图标控件应与多项目列表共存在渲染 DOM 中');
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'repo-existing', '新建对话下排小字应完整展示初始活跃项目名');
    const recentTabEl = envUi.doc.querySelector('#conv-view-tabs button[data-conv-view="recent"]');
    const recentTabTxt = (recentTabEl?.textContent || '').trim();
    assert.ok(recentTabTxt.startsWith('活跃') && !recentTabTxt.includes('最近活跃'), `顶部标签应简写为「活跃」，实际: ${recentTabTxt}`);
    const newProjBtnDom = envUi.doc.getElementById('btn-new-project');
    assert.ok(newProjBtnDom && newProjBtnDom.querySelector('svg'), '侧边栏新建项目按钮应渲染文件夹加号 SVG 图标');
    assert.equal((newProjBtnDom.textContent || '').trim(), '', '侧边栏新建项目按钮应为紧凑纯图标形态，不附带占空间的文字');
    assert.equal(newProjBtnDom.getAttribute('aria-label'), '新建项目');
    envUi.doc.querySelector('#theme-seg button[data-theme-mode="light"]').click();
    assert.equal(envUi.doc.documentElement.getAttribute('data-theme'), 'light', '切换固定浅色模式后应立即更新 html[data-theme="light"]');
    assert.ok(convListEl.querySelector('.proj-group.is-current'), '切换主题后当前项目高亮与分组列表仍保持正常');
    envUi.doc.querySelector('#theme-seg button[data-theme-mode="dark"]').click();
    assert.equal(envUi.doc.documentElement.getAttribute('data-theme'), 'dark');

    // 校验 Enter 仅自然换行不发送，点按钮 & Cmd+Enter 才发送多行消息
    const ta = envUi.doc.getElementById('input');
    const sendBtn = envUi.doc.getElementById('btn-send');
    assert.equal(ta.getAttribute('enterkeyhint'), 'enter');
    assert.equal(ta.getAttribute('placeholder'), '发消息…', '聊天输入框占位提示应精简为单行短句');
    ta.value = '第一行内容';
    const plainEnterEv = { type: 'keydown', key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false };
    const allowNativeNewline = ta.dispatchEvent(plainEnterEv);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(allowNativeNewline, true, '普通 Enter 不得被 preventDefault() 拦截');
    assert.equal(plainEnterEv._prevented, undefined, '普通 Enter 应保留默认换行行为');
    assert.equal(sentActions.filter((a) => a.action === 'send').length, 0, '按回车换行后绝不能直接发送消息');

    ta.value = '第一行内容\n第二行内容';
    ta.dispatchEvent({ type: 'input' });
    assert.ok(sendBtn.classList.contains('ready'));
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sentActions.filter((a) => a.action === 'send').length, 1, '点击发送按钮应触发发送');
    assert.equal(sentActions[0].text, '第一行内容\n第二行内容', '多行换行内容应完整发送');

    ta.value = '第三行\n第四行';
    const cmdEnterEv = { type: 'keydown', key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false, isComposing: false };
    ta.dispatchEvent(cmdEnterEv);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cmdEnterEv._prevented, true, '桌面端 Cmd+Enter 快捷键应拦截默认换行并发送');
    assert.equal(sentActions.filter((a) => a.action === 'send').length, 2);
    assert.equal(sentActions[1].text, '第三行\n第四行');

    // 验证「选择项目新建对话」下拉菜单中也提供「新建项目（选择电脑目录）…」入口
    envUi.doc.getElementById('btn-new-chat-project').click();
    const pickerCreateOpt = envUi.doc.getElementById('sheet-list').querySelectorAll('.sheet-opt')
      .find((b) => (b.textContent || '').includes('新建项目（选择电脑目录）'));
    assert.ok(pickerCreateOpt, '项目下拉列表应包含新建项目选项');
    envUi.doc.getElementById('sheet-close').click();

    // 验证侧边栏「＋ 新建项目」按钮打开目录浏览器 -> 进入 codebase -> 进入 repo-a -> 创建并进入对话
    const modalBackdrop = envUi.doc.getElementById('proj-modal-backdrop');
    assert.equal(modalBackdrop.hidden, true);
    envUi.doc.getElementById('btn-new-project').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(modalBackdrop.hidden, false, '点击＋新建项目应弹出电脑目录浏览器');
    assert.equal(envUi.doc.getElementById('proj-name-input').value, '', '打开新建项目弹窗时项目名称必须默认留空，不得预填主目录名');
    assert.equal(envUi.doc.getElementById('proj-create-submit').disabled, true, '未填写项目名称前提交按钮应处于禁用状态');

    const codebaseRootBtn = envUi.doc.getElementById('proj-roots').querySelectorAll('.proj-root-pill')
      .find((b) => (b.textContent || '') === 'codebase');
    assert.ok(codebaseRootBtn, '目录弹窗应渲染快捷根目录 codebase');
    codebaseRootBtn.click();
    await new Promise((r) => setTimeout(r, 40));

    const repoAItem = envUi.doc.getElementById('proj-dir-list').querySelectorAll('.proj-dir-item')
      .find((b) => (b.textContent || '').includes('repo-a'));
    assert.ok(repoAItem && (repoAItem.textContent || '').includes('Git'), 'codebase 下应列出带 Git 标记的 repo-a');
    repoAItem.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(envUi.doc.getElementById('proj-path-input').value, path.resolve(repoADir));
    assert.equal(envUi.doc.getElementById('proj-name-input').value, '', '切换目录后项目名称仍应保持留空，由用户自行填写');
    assert.equal(envUi.doc.getElementById('proj-create-submit').disabled, true, '选好目录但未填项目名时提交按钮仍应禁用');

    // 用户手填名称后按钮解锁，再切换/回到目录也应保留已填名称不被覆盖
    envUi.doc.getElementById('proj-name-input').value = 'repo-a';
    envUi.doc.getElementById('proj-name-input').dispatchEvent({ type: 'input' });
    assert.equal(envUi.doc.getElementById('proj-create-submit').disabled, false, '填写项目名称后创建按钮应解锁');
    envUi.doc.getElementById('proj-up-btn').click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.doc.getElementById('proj-dir-list').querySelectorAll('.proj-dir-item')
      .find((b) => (b.textContent || '').includes('repo-a')).click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('proj-name-input').value, 'repo-a', '已填项目名称后更新目录不得清空或覆盖用户填写的名称');

    envUi.doc.getElementById('proj-create-submit').click();
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(modalBackdrop.hidden, true, '创建项目完成后应自动关闭弹窗');

    const createRpc = rpcCalls.find((c) => c.method === 'CreateProject');
    assert.ok(createRpc, '应调用 Language Server CreateProject 创建项目');
    assert.equal(createRpc.body.project.name, 'repo-a');
    assert.equal(createRpc.body.project.projectResources.resources[0].gitFolder.folderUri, pathToFileURL(path.resolve(repoADir)).href);
    assert.equal(createRpc.body.project.projectResources.resources[0].gitFolder.defaultBranch, 'main');
    assert.equal(currentProjIdState, createRpc.body.project.id, '创建后应导航并切换当前项目至新建的 repo-a');
    assert.ok(navCalls.some((c) => c.action === 'new-conversation' && c.projectId === createRpc.body.project.id));
    assert.equal((envUi.doc.getElementById('new-chat-label')?.textContent || '').trim(), '新建对话', '主标题应固定保持「新建对话」');
    assert.equal(envUi.doc.getElementById('new-chat-sub')?.hidden, false, '有活跃项目时第二行极小字 #new-chat-sub 应显示');
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'repo-a', '新建对话按钮下一行极小字应联动显示刚创建的新项目名');

    // 验证创建成功但桌面端导航失败时：不误关弹窗也不误报成功，且支持直接重试进入已有项目
    failNextNavError = '桌面端路由正忙';
    envUi.doc.getElementById('btn-new-project').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('proj-name-input').value, '', '重新打开新建项目弹窗时应清空上次输入，保持留空');
    envUi.doc.getElementById('proj-roots').querySelectorAll('.proj-root-pill')
      .find((b) => (b.textContent || '') === 'codebase').click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.doc.getElementById('proj-dir-list').querySelectorAll('.proj-dir-item')
      .find((b) => (b.textContent || '').includes('brand-new-dir')).click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('proj-name-input').value, '', '浏览到新目录时项目名称仍应留空');
    envUi.doc.getElementById('proj-name-input').value = 'brand-new-dir';
    envUi.doc.getElementById('proj-name-input').dispatchEvent({ type: 'input' });

    const createRpcBeforeNavFail = rpcCalls.filter((c) => c.method === 'CreateProject').length;
    envUi.doc.getElementById('proj-create-submit').click();
    await new Promise((r) => setTimeout(r, 80));

    const brandNewCreateRpcs = rpcCalls.filter((c) => c.method === 'CreateProject');
    assert.equal(brandNewCreateRpcs.length, createRpcBeforeNavFail + 1, '首次创建时应调用一次 CreateProject');
    const brandNewProjId = brandNewCreateRpcs[brandNewCreateRpcs.length - 1].body.project.id;
    assert.equal(modalBackdrop.hidden, false, '导航失败时弹窗必须保持打开以便用户看到提示并重试');
    assert.ok((envUi.doc.getElementById('toast').textContent || '').includes('项目「brand-new-dir」已创建，但未成功进入对话'), 'Toast 应明确告知项目已创建但未进入对话');
    assert.ok((envUi.doc.getElementById('toast').textContent || '').includes('桌面端路由正忙'));
    assert.ok((envUi.doc.getElementById('proj-selected-summary').textContent || '').includes('已创建，但未成功进入新对话'));
    assert.equal(envUi.doc.getElementById('proj-create-submit').textContent, '重试进入已有项目「brand-new-dir」');
    assert.equal(convListEl.querySelector('.proj-empty-toggle'), null, '不得渲染空项目折叠控件');
    assert.equal(convListEl.querySelector('.proj-empty-sec'), null, '新建空项目应直接展示在项目列表中');
    const brandNewToggleBtn = convListEl.querySelector(`button[data-proj-toggle="${brandNewProjId}"]`);
    assert.ok(brandNewToggleBtn, '新建的空项目无需展开折叠即可直接看见并点击');
    brandNewToggleBtn.click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'brand-new-dir', '点中新建空项目后顶部新建对话应联动为 brand-new-dir');
    const curProjGroups = convListEl.querySelectorAll('.is-current');
    assert.equal(curProjGroups.length, 1, '侧边栏高亮项目应切换为唯一的新建空项目');
    assert.equal((curProjGroups[0].querySelector('.proj-name')?.textContent || '').trim(), 'brand-new-dir');
    assert.ok((convListEl.textContent || '').includes('brand-new-dir'), '侧边栏项目列表应已同步刷新显示新建项目');
    assert.ok(convListEl.querySelector(`.proj-new-btn[data-new-proj="${brandNewProjId}"]`), '侧边栏也应提供该已有项目的新建对话重连入口');
    assert.notEqual(currentProjIdState, brandNewProjId);

    failNextNavError = '';
    envUi.doc.getElementById('proj-create-submit').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(rpcCalls.filter((c) => c.method === 'CreateProject').length, createRpcBeforeNavFail + 1, '重试进入已有项目时不得重复调用 CreateProject');
    assert.equal(modalBackdrop.hidden, true, '重试进入成功后应自动关闭弹窗');
    assert.equal(currentProjIdState, brandNewProjId, '重试后桌面端应成功进入该已有项目的新建对话');
    assert.ok(navCalls.filter((c) => c.action === 'new-conversation' && c.projectId === brandNewProjId).length >= 2);
    assert.ok((envUi.doc.getElementById('toast').textContent || '').includes('已进入项目「brand-new-dir」'));

    // 验证空项目名拦截、重名拦截、已有主目录项目直接进入复用与 archived:true 项目排除
    await assert.rejects(
      () => remoteMod.createRemoteProject({ folderPath: plainBDir, name: '   ' }, { homeDir, configDir, localApiConnect: mockConnect }),
      /请输入项目名称/
    );
    await assert.rejects(
      () => remoteMod.createRemoteProject({ folderPath: plainBDir, name: 'repo-a' }, { homeDir, configDir, localApiConnect: mockConnect }),
      /同名项目「repo-a」已存在/
    );
    const reuseRes = await remoteMod.createRemoteProject({ folderPath: existingRepoDir, name: 'repo-existing' }, { homeDir, configDir, localApiConnect: mockConnect });
    assert.equal(reuseRes.alreadyExists, true);
    assert.equal(reuseRes.project.id, existingProjId);

    const archivedProjId = '33333333-3333-4333-8333-333333333333';
    const archivedDir = path.join(codebaseDir, 'archived-repo');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, `${archivedProjId}.json`), JSON.stringify({
      id: archivedProjId,
      name: 'archived-repo',
      archived: true,
      projectResources: { resources: [{ folderUri: pathToFileURL(archivedDir).href }] }
    }), 'utf8');
    const cbAfterArchive = remoteMod.listHostDirectories({ dirPath: codebaseDir, homeDir, configDir });
    const archivedDirEntry = cbAfterArchive.entries.find((e) => e.name === 'archived-repo');
    assert.equal(archivedDirEntry?.existingProjectId, '', '已归档项目不得继续在目录中标记为已关联项目');
    const snapAfterArchive = await remoteMod.enrichSnapshotWithCatalog(
      { ok: true, sessionId: 'conv-existing-1', projects: [{ id: archivedProjId, name: 'archived-repo' }], conversations: [] },
      { stateDir, configDir, bypassCache: true }
    );
    assert.equal(snapAfterArchive.projects.some((p) => p.id === archivedProjId), false, 'archived:true 的项目不得出现在活跃项目列表中');

    // 验证长项目名（56 字符）在 #new-chat-sub 中完整保留、不被 JS 截断
    const longProjectName = 'antigravity-enterprise-multi-workspace-long-project-name';
    envUi.doc.getElementById('btn-new-project').click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.doc.getElementById('proj-roots').querySelectorAll('.proj-root-pill')
      .find((b) => (b.textContent || '') === 'codebase').click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.doc.getElementById('proj-dir-list').querySelectorAll('.proj-dir-item')
      .find((b) => (b.textContent || '').includes('plain-b')).click();
    await new Promise((r) => setTimeout(r, 40));
    envUi.doc.getElementById('proj-name-input').value = longProjectName;
    envUi.doc.getElementById('proj-name-input').dispatchEvent({ type: 'input' });
    envUi.doc.getElementById('proj-create-submit').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      (envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(),
      longProjectName,
      '#new-chat-sub 应完整展示超长项目名称而不得截取'
    );
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    if (prevCtxStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevCtxStateDir;
    if (prevConfigDir === undefined) delete process.env.AG_CONFIG_DIR;
    else process.env.AG_CONFIG_DIR = prevConfigDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 22: 手机端弹窗输入框聚焦按相对键盘位置防误抬高与按需位移
// =========================================================================
test('需求 22: 手机端弹窗输入框聚焦按相对键盘位置防误抬高与按需位移', async () => {
  delete require.cache[require.resolve('./mobile-remote.js')];
  const remoteMod = require('./mobile-remote.js');
  const html = remoteMod.buildMobileAppHtml();
  const cssText = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  const bodyHtml = html.match(/<body>([\s\S]*?)<script>/)?.[1] || '';
  const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const mainScript = inlineScripts[inlineScripts.length - 1]?.[1] || '';
  assert.ok(cssText && bodyHtml && mainScript, 'HTML 应包含样式、主体与控制脚本');

  // 1. CSS 布局与字号隔离校验：遮罩使用 --modal-h、移动端输入框 >=16px 防放大、桌面端恢复 13/14px
  const sheetBackdropRule = cssText.match(/\.sheet-backdrop\{[^}]+\}/)?.[0] || '';
  const drawerBackdropRule = cssText.match(/\.drawer-backdrop\{[^}]+\}/)?.[0] || '';
  const sheetRule = cssText.match(/\.sheet\{[^}]+\}/)?.[0] || '';
  const projModalRule = cssText.match(/\.sheet\.proj-modal\{[^}]+\}/)?.[0] || '';
  const dirListRule = cssText.match(/\.proj-dir-list\{[^}]+\}/)?.[0] || '';
  const desktopMediaBlock = cssText.slice(cssText.indexOf('@media (min-width:860px)'));
  assert.ok(sheetBackdropRule.includes('--modal-h'), '.sheet-backdrop 应绑定 --modal-h 而非 --app-h');
  assert.equal(sheetBackdropRule.includes('--app-h'), false, '.sheet-backdrop 不得再绑定会随键盘收缩的 --app-h');
  assert.ok(drawerBackdropRule.includes('--modal-h'), '.drawer-backdrop 应绑定 --modal-h');
  assert.ok(projModalRule.includes('var(--modal-h') && !/\b84dvh\b/.test(projModalRule), '.sheet.proj-modal 高度应锚定 --modal-h，不得因 dvh 收缩导致顶部下坠或触顶');
  assert.ok(dirListRule.includes('var(--modal-h') && !/\b34dvh\b/.test(dirListRule), '.proj-dir-list 高度应锚定 --modal-h');
  assert.ok(cssText.includes('.proj-modal-body{') && bodyHtml.includes('id="proj-modal-body"'), '新建项目弹窗应包含可独立滚动的 #proj-modal-body');
  assert.equal(/\btransition\s*:[^;}]*transform/i.test(sheetRule), false, '.sheet 不应设置 transform transition 以免中断坐标测量');
  assert.ok(/\.proj-path-input,\.proj-field-input\{[^}]*font-size:16px/.test(cssText), '移动端路径输入框字号应 >= 16px 防 iOS 自动缩放');
  assert.ok(/\.proj-field-input\{[^}]*font-size:16px/.test(cssText), '移动端文本字段输入框字号应 >= 16px');
  assert.ok(desktopMediaBlock.includes('.proj-path-input{font-size:13px}'), '桌面端应恢复 13px 路径输入框字号');
  assert.ok(desktopMediaBlock.includes('.proj-field-input{font-size:14px}'), '桌面端应恢复 14px 字段输入框字号');

  // 2. 构建 390x844 手机视口 + 可交互 visualViewport 测试环境
  const activeTimers = new Set();
  const env = createDomEnv();
  try {
    env.doc.body.innerHTML = bodyHtml;
    env.win.innerWidth = 390;
    env.win.innerHeight = 844;
    env.win.AbortController = AbortController;
    env.win.location = { pathname: '/', search: '?token=testtok', protocol: 'http:', origin: 'http://127.0.0.1:18765', reload() {} };
    env.win.history = { replaceState() {} };

    const scrollToCalls = [];
    env.win.scrollTo = (x, y) => { scrollToCalls.push([x, y]); };
    env.sandbox.scrollTo = env.win.scrollTo;

    const vvListeners = new Map();
    const vv = {
      width: 390,
      height: 844,
      offsetTop: 0,
      addEventListener(type, fn) {
        if (!vvListeners.has(type)) vvListeners.set(type, []);
        vvListeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = vvListeners.get(type);
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
      _emit(type) {
        for (const fn of [...(vvListeners.get(type) || [])]) fn({ type, target: vv });
      }
    };
    env.win.visualViewport = vv;
    env.sandbox.visualViewport = vv;
    env.sandbox.location = env.win.location;
    env.sandbox.history = env.win.history;
    env.sandbox.AbortController = AbortController;
    env.sandbox.URLSearchParams = URLSearchParams;
    env.sandbox.setTimeout = (fn, ms) => {
      const id = setTimeout(() => {
        activeTimers.delete(id);
        fn();
      }, ms);
      activeTimers.add(id);
      return id;
    };
    env.sandbox.clearTimeout = (id) => {
      activeTimers.delete(id);
      clearTimeout(id);
    };
    env.sandbox.fetch = async (url) => {
      const u = new URL(String(url), 'http://127.0.0.1:18765');
      const jsonHeaders = { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') };
      if (u.pathname === '/api/fs/dirs') {
        return {
          ok: true,
          status: 200,
          headers: jsonHeaders,
          json: async () => ({
            ok: true,
            path: '/Users/shenslu',
            parentPath: '/Users',
            currentName: 'shenslu',
            suggestedName: 'shenslu',
            roots: [{ label: '主目录 (~)', path: '/Users/shenslu' }],
            entries: [{ name: 'codebase', path: '/Users/shenslu/codebase', isGitRepo: false }]
          })
        };
      }
      if (u.pathname === '/api/snapshot') {
        return {
          ok: true,
          status: 200,
          headers: jsonHeaders,
          json: async () => ({ ok: true, sessionId: 's1', projects: [], conversations: [], messages: [] })
        };
      }
      return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ ok: true }) };
    };

    env.doc.activeElement = env.doc.body;
    const modalBackdrop = env.doc.getElementById('proj-modal-backdrop');
    const modalSheet = modalBackdrop.querySelector('.sheet.proj-modal');
    const titleEl = modalSheet.querySelector('.sheet-title');
    const modalBody = env.doc.getElementById('proj-modal-body');
    modalBody.scrollTop = 0;
    const parseShiftY = () => {
      const m = String(modalSheet.style.transform || '').match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
      return m ? Number(m[1]) : 0;
    };
    modalSheet.getBoundingClientRect = () => {
      const dy = parseShiftY();
      return { left: 0, right: 390, width: 390, height: 666, top: 178 + dy, bottom: 844 + dy };
    };
    titleEl.getBoundingClientRect = () => {
      const dy = parseShiftY();
      return { left: 14, right: 376, width: 362, height: 28, top: 191 + dy, bottom: 219 + dy };
    };
    modalBody.getBoundingClientRect = () => {
      const dy = parseShiftY();
      return { left: 14, right: 376, width: 362, height: 604, top: 228 + dy, bottom: 832 + dy };
    };
    const bindFocusableBox = (el, baseTop, baseBottom) => {
      el.type = el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '');
      el.getBoundingClientRect = () => {
        const dy = modalSheet.contains(el) ? parseShiftY() : 0;
        const scrollY = (modalBody && modalBody.contains(el)) ? (Number(modalBody.scrollTop) || 0) : 0;
        return { left: 14, right: 376, width: 362, height: baseBottom - baseTop, top: baseTop + dy - scrollY, bottom: baseBottom + dy - scrollY };
      };
      el.focus = () => {
        const prev = env.doc.activeElement;
        if (prev === el) return;
        if (prev && prev !== env.doc.body) {
          env.doc.activeElement = env.doc.body;
          env.doc.dispatchEvent({ type: 'focusout', target: prev });
        }
        env.doc.activeElement = el;
        env.doc.dispatchEvent({ type: 'focusin', target: el });
      };
      el.blur = () => {
        if (env.doc.activeElement !== el) return;
        env.doc.activeElement = env.doc.body;
        env.doc.dispatchEvent({ type: 'focusout', target: el });
      };
    };

    const pathInput = env.doc.getElementById('proj-path-input');
    const mkdirInput = env.doc.getElementById('proj-mkdir-input');
    const nameInput = env.doc.getElementById('proj-name-input');
    const chatInput = env.doc.getElementById('input');
    bindFocusableBox(pathInput, 220, 256);
    bindFocusableBox(mkdirInput, 306, 342);
    bindFocusableBox(nameInput, 742, 778);
    bindFocusableBox(chatInput, 780, 812);

    vm.runInContext(mainScript, env.sandbox);
    await new Promise((r) => setTimeout(r, 40));

    // 打开新建项目弹窗
    env.doc.getElementById('btn-new-project').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(modalBackdrop.hidden, false);

    // 场景 1: 聚焦顶部 #proj-path-input（位于 [220, 256]，高于 460px 键盘顶边），即使 innerHeight 与 vv.height 同缩至 460，也禁止任何抬高
    pathInput.focus();
    vv.height = 460;
    env.win.innerHeight = 460;
    vv._emit('resize');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.doc.documentElement.style.getPropertyValue('--modal-h'), '844px', '软键盘弹起时 --modal-h 必须锁定满屏 844px，不得把弹窗推出顶部或露出底层聊天');
    assert.equal(env.doc.documentElement.style.getPropertyValue('--app-h'), '844px', '弹窗输入框聚焦时 --app-h 也应保持 844px 不抽缩');
    assert.equal(modalSheet.style.transform, '', '顶部路径输入框已在键盘上方，弹窗绝不能被抬高');
    assert.equal(modalBody.scrollTop, 0);
    assert.deepEqual([pathInput.getBoundingClientRect().top, pathInput.getBoundingClientRect().bottom], [220, 256]);

    // 场景 2: 展开「＋ 新建文件夹」并聚焦 #proj-mkdir-input（[306, 342] <= 460 - 14），同样不抬高
    env.doc.getElementById('proj-mkdir-toggle').click();
    assert.equal(env.doc.getElementById('proj-mkdir-row').hidden, false);
    assert.equal(env.doc.activeElement, mkdirInput);
    assert.equal(modalSheet.style.transform, '', '高于键盘的新建文件夹输入框也不得触发多余抬高');
    assert.equal(modalBody.scrollTop, 0);

    // 场景 3: 聚焦底部被键盘遮挡的 #proj-name-input（[742, 778] > 446），整体最多上移 -166px 保持弹窗顶部 >= 12px，剩余 166px 遮挡交由内部容器滚动消除
    nameInput.focus();
    assert.equal(modalSheet.style.transform, 'translateY(-166px)', '整体上移必须受限于弹窗顶部安全界 (12 - 178 = -166px)');
    assert.ok(modalSheet.getBoundingClientRect().top >= 12, '上移后弹窗顶部与标题不得越过可视区顶边');
    assert.equal(modalBody.scrollTop, 166, '超出顶边上限的剩余遮挡应通过内部容器滚动精确吸收');
    assert.deepEqual([nameInput.getBoundingClientRect().top, nameInput.getBoundingClientRect().bottom], [410, 446]);

    // 场景 4: 保持键盘打开（460px），点键盘栏「^」把焦点切回顶部 #proj-path-input 时应准确反算并立即归零（整体位移与内部滚动双双清零）
    pathInput.focus();
    assert.equal(modalSheet.style.transform, '', '焦点从底部切回顶部未遮挡输入框时，弹窗应立即恢复 0px 位移');
    assert.equal(modalBody.scrollTop, 0, '切回顶部输入框后内部临时滚动应归零');
    assert.equal(modalBody.style.paddingBottom, '', '切回顶部输入框后内部临时 paddingBottom 应清空');
    assert.deepEqual([pathInput.getBoundingClientRect().top, pathInput.getBoundingClientRect().bottom], [220, 256]);

    // 场景 5: 若残留 vv.offsetTop = 240（可视区 [240, 700]，安全区 [252, 686]），应调用 scrollTo(0,0) 并同时约束弹窗顶边、标题与聚焦输入框都在可视区内，底部聚焦也由内部滚动配合消除遮挡，复位后彻底归零
    vv.offsetTop = 240;
    vv._emit('scroll');
    assert.ok(scrollToCalls.some(([x, y]) => x === 0 && y === 0), '检测到 vv.offsetTop > 0 时应尝试 reset scroll');
    assert.equal(modalSheet.style.transform, 'translateY(74px)', '正 vv.offsetTop 下应将弹窗顶边补偿至 vvTop + 12 (252px)');
    assert.ok(modalSheet.getBoundingClientRect().top >= 252, '弹窗顶边必须位于 vvTop + 12 之上可见区域内');
    assert.ok(titleEl.getBoundingClientRect().top >= 252 && titleEl.getBoundingClientRect().bottom <= 686, '弹窗标题必须完整位于可视区内');
    assert.ok(pathInput.getBoundingClientRect().top >= 252 && pathInput.getBoundingClientRect().bottom <= 686, '聚焦路径输入框必须完整位于可视区内');

    nameInput.focus();
    assert.equal(modalSheet.style.transform, 'translateY(74px)');
    assert.ok(modalSheet.getBoundingClientRect().top >= 252 && titleEl.getBoundingClientRect().bottom <= 686, '正 offsetTop 下聚焦底部框时弹窗顶边与标题仍保持在可视区内');
    assert.equal(modalBody.scrollTop, 166, '底部输入框超出可视区底边部分应由内部滚动吸收');
    assert.ok(nameInput.getBoundingClientRect().top >= titleEl.getBoundingClientRect().bottom && nameInput.getBoundingClientRect().bottom <= 686, '底部输入框应处于标题下方且位于可视区内');

    pathInput.focus();
    vv.offsetTop = 0;
    vv._emit('scroll');
    assert.equal(modalSheet.style.transform, '');
    assert.equal(modalBody.scrollTop, 0);

    env.doc.getElementById('proj-modal-close').click();
    assert.equal(modalBackdrop.hidden, true);
    assert.equal(env.doc.activeElement, env.doc.body);
    assert.equal(modalSheet.style.transform, '');

    // 场景 6: 键盘收回后聚焦主聊天输入框 #input 并重新弹出键盘，确认底部聊天框 kb-open 收缩行为零回归
    vv.height = 844;
    env.win.innerHeight = 844;
    vv._emit('resize');
    chatInput.focus();
    vv.height = 460;
    vv._emit('resize');
    const appEl = env.doc.querySelector('.app');
    assert.equal(appEl.classList.contains('kb-open'), true, '无弹窗时聚焦聊天输入框仍应启用 kb-open');
    assert.equal(env.doc.body.style.height, '460px');

    chatInput.blur();
    vv.height = 844;
    vv._emit('resize');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(appEl.classList.contains('kb-open'), false);
    assert.equal(env.doc.body.style.height, '100%');
  } finally {
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
    delete require.cache[require.resolve('./mobile-remote.js')];
  }
});

// =========================================================================
// 需求 23: 远程端切换防轮询假死与中止旧请求、折叠思考惰性挂载、轨迹签名缓存及 gzip 压缩
// =========================================================================
test('需求 23: 远程端切换防轮询假死与中止旧请求、折叠思考惰性挂载、轨迹签名缓存及 gzip 压缩', async () => {
  const zlib = require('zlib');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req23-'));
  const stateDir = path.join(tmpRoot, 'state');
  const configDir = path.join(tmpRoot, 'config');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });

  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevCtxStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  const prevConfigDir = process.env.AG_CONFIG_DIR;
  const origDateNow = Date.now;

  try {
    process.env.APPDATA = stateDir;
    process.env.AG_METER_STATE_DIR = stateDir;
    process.env.AG_CONTEXT_METER_STATE_DIR = stateDir;
    process.env.AG_CONFIG_DIR = configDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const remoteMod = require('./mobile-remote.js');

    // 1) trajSig 轨迹签名缓存命中与变更失效（超越 3500ms TTL 后只要 stepCount/lastModifiedTime/status 未变即跳过 GetCascadeTrajectory）
    let mockNow = origDateNow();
    Date.now = () => mockNow;
    let trajRpcCount = 0;
    let trajStepCount = 40;
    let trajModTime = '2026-11-19T10:00:00Z';
    let failSigTraj = false;
    const steps40 = [];
    for (let i = 0; i < 20; i++) {
      steps40.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: `问题 ${i}` }] } });
      steps40.push({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { thinking: `思考 ${i}`, response: `回复 **#${i}**` } });
    }
    const sigMockConnect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-sig-1': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: trajStepCount,
                lastModifiedTime: trajModTime
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          trajRpcCount += 1;
          if (failSigTraj) throw new Error('LS temporarily unavailable');
          return { trajectory: { steps: steps40 } };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });

    const baseSnapReq = () => ({
      ok: true,
      sessionId: 'sess-sig-1',
      busy: false,
      messages: [],
      conversations: [],
      projects: []
    });
    const snapSig1 = await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 1);
    assert.equal(snapSig1.totalMessages, 40);
    assert.equal(snapSig1.messages.length, 6);
    assert.ok(snapSig1.messages.every((m) => m.role !== 'assistant' || (typeof m.html === 'string' && m.html.includes('<strong>'))), '返回给客户端的最后 6 条消息必须渲染好 Markdown HTML');
    assert.equal(Object.prototype.hasOwnProperty.call(snapSig1, '_activeTrajSig'), false, '内部 _activeTrajSig 不得泄漏到对外快照中');

    // 时间推进 12s（远超 3500ms TTL），因签名一致应零 RPC 命中缓存
    mockNow += 12000;
    const snapSig2 = await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 1, '签名一致时超 TTL 仍应命中缓存，不得重拉 GetCascadeTrajectory');
    assert.equal(snapSig2.messages.length, 6);

    // 轨迹摘要步数变更后签名失效，应触发重新拉取
    trajStepCount = 42;
    trajModTime = '2026-11-19T10:00:15Z';
    mockNow += 500;
    await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 2, 'trajSig 变更后必须失效并重新拉取轨迹');

    // 显式 bypassCache: true 必须强制绕过缓存
    await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: true, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 3, 'bypassCache:true 应强制重新拉取轨迹');

    // 签名变化 -> 拉取失败 -> 服务恢复：失败时绝不能将新 trajSig 绑定到旧轨迹，恢复后空闲会话必须重拉新内容
    steps40.push({ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '新追加问题' }] } });
    steps40.push({ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '回复 **#new44**' } });
    trajStepCount = 44;
    trajModTime = '2026-11-19T10:00:30Z';
    failSigTraj = true;
    mockNow += 500;
    const snapFailFallback = await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 4);
    assert.equal(snapFailFallback.totalMessages, 40, '拉取失败时应安全降级返回旧缓存的 40 条历史');
    assert.equal(snapFailFallback.messages.some((m) => String(m.text || '').includes('#new44')), false);

    // 服务恢复后签名保持 stepCount=44 不变（空闲状态）且 bypassCache=false，此时之前保留的旧签名与新签名仍不匹配，必须立即重拉！
    failSigTraj = false;
    mockNow += 1000;
    const snapRecovered = await remoteMod.enrichSnapshotWithCatalog(baseSnapReq(), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: sigMockConnect
    });
    assert.equal(trajRpcCount, 5, '服务恢复后即使签名未再变且超过任意周期，也必须重拉此前失败未能更新的轨迹');
    assert.equal(snapRecovered.totalMessages, 42);
    assert.ok(snapRecovered.messages.some((m) => String(m.text || '').includes('#new44')), '恢复后必须展示最新回复');
    Date.now = origDateNow;

    // 2) HTTP gzip 压缩、Accept-Encoding q=0 质量值协商与 Cookie 版本号 1.9.17 验证
    assert.equal(remoteMod.acceptsGzipEncoding('gzip, deflate, br'), true);
    assert.equal(remoteMod.acceptsGzipEncoding('gzip;q=0.5'), true);
    assert.equal(remoteMod.acceptsGzipEncoding('deflate, *;q=0.8'), true);
    assert.equal(remoteMod.acceptsGzipEncoding('gzip;q=0'), false);
    assert.equal(remoteMod.acceptsGzipEncoding('br, gzip; q=0.0, *;q=1'), false);
    assert.equal(remoteMod.acceptsGzipEncoding('identity;q=1, *;q=0'), false);

    const cfg = remoteMod.loadOrCreateRemoteConfig();
    const handler = remoteMod.createRemoteHttpHandler(cfg);
    const invokeHttp = (method, urlPath, headers = {}) => new Promise((resolve) => {
      const resHeaders = {};
      let setCookie = null;
      handler({
        method,
        url: `${urlPath}${urlPath.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.token)}`,
        headers: { host: `127.0.0.1:${cfg.port}`, ...headers },
        socket: { remoteAddress: '127.0.0.1' }
      }, {
        setHeader(k, v) { if (String(k).toLowerCase() === 'set-cookie') setCookie = v; resHeaders[k] = v; },
        writeHead(status, h = {}) { this.status = status; Object.assign(resHeaders, h); },
        end(body) { resolve({ status: this.status, headers: resHeaders, setCookie, body }); }
      });
    });

    const htmlPlainRes = await invokeHttp('GET', '/');
    assert.equal(htmlPlainRes.status, 200);
    assert.ok(String(htmlPlainRes.setCookie || '').includes('ag_ui_ver=1.9.17'), '根目录响应应下发最新版本号 1.9.17');

    for (const rejectHeader of ['gzip;q=0', 'br, gzip; q=0.0, *;q=1', 'identity;q=1, *;q=0']) {
      const rejectedGzRes = await invokeHttp('GET', '/', { 'accept-encoding': rejectHeader });
      assert.equal(rejectedGzRes.status, 200);
      assert.equal(rejectedGzRes.headers['Content-Encoding'], undefined, `${rejectHeader} 禁止 gzip 时不得返回 Content-Encoding: gzip`);
      assert.equal(typeof rejectedGzRes.body, 'string');
      assert.ok(rejectedGzRes.body.includes('<!DOCTYPE html>'));
    }

    const htmlGzipRes = await invokeHttp('GET', '/', { 'accept-encoding': 'gzip, deflate' });
    assert.equal(htmlGzipRes.status, 200);
    assert.equal(htmlGzipRes.headers['Content-Encoding'], 'gzip');
    assert.ok(Buffer.isBuffer(htmlGzipRes.body));
    const gunzippedHtml = zlib.gunzipSync(htmlGzipRes.body).toString('utf8');
    assert.ok(gunzippedHtml.includes('id="conv-list"') && gunzippedHtml.includes('openThoughtIdxSet'));

    // 2b) evalInPickedTarget / performActionInTarget 非幂等副作用动作超时不得重放（send / new-conversation）
    for (const sideEffectPayload of [
      { action: 'send', text: 'do-not-replay-send' },
      { action: 'new-conversation', projectId: 'proj-a' }
    ]) {
      let pickCount = 0;
      const executedExprs = [];
      const hangingWcTarget = {
        id: 'wc-timeout-1',
        title: 'Antigravity',
        wc: {
          isDestroyed: () => false,
          executeJavaScript: (expr) => {
            executedExprs.push(expr);
            return new Promise(() => {});
          }
        }
      };
      await assert.rejects(
        () => remoteMod.performActionInTarget(sideEffectPayload, {
          timeoutMs: 40,
          pickTarget: async () => {
            pickCount += 1;
            return { target: hangingWcTarget, windows: [{ id: 'wc-timeout-1', title: 'Antigravity' }] };
          }
        }),
        /页面执行超时/
      );
      assert.equal(pickCount, 1, `${sideEffectPayload.action} 超时后不得重选窗口重试`);
      assert.equal(executedExprs.length, 1, `${sideEffectPayload.action} 在动作已派发但响应超时时绝不能重复执行`);

      // 模拟 evalInCdpTarget 抛出 CDP 请求超时（未注入 wc 的 WebSocket 超时场景）同样禁止重放
      let cdpPickCount = 0;
      let cdpEvalCount = 0;
      await assert.rejects(
        () => remoteMod.performActionInTarget(sideEffectPayload, {
          pickTarget: async () => {
            cdpPickCount += 1;
            return { target: { id: 'cdp-1', title: 'Antigravity' }, windows: [{ id: 'cdp-1', title: 'Antigravity' }] };
          },
          evalInTarget: async () => {
            cdpEvalCount += 1;
            const err = new Error('CDP 请求超时');
            err.cdpDispatched = true;
            throw err;
          }
        }),
        /CDP 请求超时/
      );
      assert.equal(cdpPickCount, 1);
      assert.equal(cdpEvalCount, 1, `${sideEffectPayload.action} 在 CDP 请求超时后不得二次重放`);
    }

    // 对比验证：若是派发前连接失败（cdpDispatched === false），则允许重选新目标执行一次
    let preErrPickCount = 0;
    let preErrExecCount = 0;
    const preErrRes = await remoteMod.performActionInTarget({ action: 'send', text: 'retry-only-on-pre-dispatch' }, {
      pickTarget: async (_id, opts = {}) => {
        preErrPickCount += 1;
        return {
          target: { id: opts.force ? 'cdp-fresh' : 'cdp-stale', title: 'Antigravity' },
          windows: [{ id: 'cdp-fresh', title: 'Antigravity' }]
        };
      },
      evalInTarget: async (target, expr) => {
        if (target.id === 'cdp-stale') {
          const err = new Error('CDP WebSocket 连接失败');
          err.cdpDispatched = false;
          throw err;
        }
        preErrExecCount += 1;
        if (expr.includes('getMobileSnapshot')) {
          return { ok: true, sessionId: 's1', messages: [], projects: [], conversations: [] };
        }
        return { ok: true };
      }
    }).catch((err) => {
      // fetchSnapshotFromTarget 内部走默认 pickCdpTarget 在测试环境无 DevTools 会返回 null snapshot，actionResult 仍为 ok:true
      return { unexpectedErr: err };
    });
    assert.equal(preErrRes.ok, true);
    assert.equal(preErrPickCount, 2, '派发前连接失败应触发强制重选新目标');
    assert.equal(preErrExecCount, 1, '重选后应精确执行一次目标动作');

    // 3) 客户端轮询保活/旧请求 Abort、折叠 <details> 惰性挂载、以及侧栏原地 class 乐观切换
    const mobileHtml = remoteMod.buildMobileAppHtml();
    const scriptMatch = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
    const bodyMatch = mobileHtml.match(/<body>([\s\S]*?)<script>/);
    assert.ok(scriptMatch && bodyMatch);
    assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));

    const env = createDomEnv();
    env.doc.body.innerHTML = bodyMatch[1];
    env.win.innerWidth = 390;
    env.win.innerHeight = 844;
    env.win.location = { pathname: '/', search: '?token=tok23', protocol: 'http:', reload() {} };
    env.win.history = { replaceState() {} };
    env.sandbox.location = env.win.location;
    env.sandbox.history = env.win.history;
    env.sandbox.URLSearchParams = URLSearchParams;

    let abortCreated = [];
    class TrackedAbortController extends AbortController {
      constructor() {
        super();
        abortCreated.push(this);
      }
    }
    env.win.AbortController = TrackedAbortController;
    env.sandbox.AbortController = TrackedAbortController;

    let timerSeq = 1;
    const activeTimerMap = new Map();
    env.sandbox.setTimeout = (fn, ms) => {
      const id = timerSeq++;
      activeTimerMap.set(id, { fn, ms });
      return id;
    };
    env.sandbox.clearTimeout = (id) => {
      activeTimerMap.delete(id);
    };
    env.win.setTimeout = env.sandbox.setTimeout;
    env.win.clearTimeout = env.sandbox.clearTimeout;

    const projAlphaBeta = [
      { id: 'proj-a', name: 'Alpha', conversationCount: 1 },
      { id: 'proj-b', name: 'Beta', conversationCount: 1 }
    ];
    const convsAB = [
      { id: 'sess-alpha', projectId: 'proj-a', projectName: 'Alpha', title: 'Alpha Title', active: true, status: 'idle', unread: false, updatedAt: 2000 },
      { id: 'sess-beta', projectId: 'proj-b', projectName: 'Beta', title: 'Beta Title', active: false, status: 'idle', unread: true, updatedAt: 1000 }
    ];
    const alphaSnap = {
      ok: true,
      serverBootId: 'boot-req23',
      serverBootAt: 5000,
      snapSeq: 1,
      sessionId: 'sess-alpha',
      isNewConversation: false,
      currentProjectId: 'proj-a',
      currentProjectName: 'Alpha',
      title: 'Alpha Title',
      busy: false,
      totalMessages: 1,
      messagesStartIndex: 0,
      messages: [{
        msgIndex: 0,
        role: 'assistant',
        text: '正文简短回复',
        html: '<p>正文简短回复</p>',
        thoughtLabel: '思考 5 秒',
        thoughtText: 'LAZY_THOUGHT_PAYLOAD_200KB'
      }],
      projects: projAlphaBeta,
      conversations: convsAB
    };

    let holdNextSnap = null;
    let nextActionMode = 'ok';
    env.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      const headers = { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : '') };
      if (u.pathname === '/api/snapshot') {
        if (holdNextSnap) {
          const g = holdNextSnap;
          holdNextSnap = null;
          await g.promise;
        }
        return { ok: true, status: 200, headers, json: async () => alphaSnap };
      }
      if (u.pathname === '/api/action') {
        if (nextActionMode === 'fail') {
          return { ok: true, status: 200, headers, json: async () => ({ ok: false, error: 'nav fail' }) };
        }
        const betaSnap = {
          ...alphaSnap,
          snapSeq: 2,
          sessionId: 'sess-beta',
          currentProjectId: 'proj-b',
          currentProjectName: 'Beta',
          title: 'Beta Title',
          messages: [{
            msgIndex: 0,
            role: 'assistant',
            text: 'Beta 正文回复',
            html: '<p>Beta 正文回复</p>',
            thoughtLabel: 'Beta 思考',
            thoughtText: 'BETA_LAZY_THOUGHT'
          }]
        };
        return { ok: true, status: 200, headers, json: async () => ({ ok: true, actionResult: { ok: true }, snapshot: betaSnap }) };
      }
      return { ok: true, status: 200, headers, json: async () => ({ ok: true }) };
    };

    vm.runInContext(scriptMatch[1], env.sandbox);
    await new Promise((r) => setTimeout(r, 30));

    // 3a) 折叠态 <details class="thought-box"> 不得预挂载 .thought-body，展开时惰性填充并跨同会话刷新保持打开
    const msgEl = env.doc.getElementById('messages');
    const thoughtDetails = msgEl.querySelector('.thought-box');
    assert.ok(thoughtDetails, '应渲染思考折叠容器');
    assert.equal(msgEl.querySelector('.thought-body'), null, '默认折叠态不得预挂载大量思考文本节点');
    assert.equal(msgEl.innerHTML.includes('LAZY_THOUGHT_PAYLOAD_200KB'), false);

    thoughtDetails.open = true;
    msgEl.dispatchEvent({ type: 'toggle', target: thoughtDetails });
    const hydratedBody = thoughtDetails.querySelector('.thought-body');
    assert.ok(hydratedBody && (hydratedBody.textContent || '').includes('LAZY_THOUGHT_PAYLOAD_200KB'), '展开 <details> 时应立即按需挂载完整思考内容');

    // 同会话再次刷新（触发 <details> 若重建应保留 open 与 .thought-body）
    const snapTimerEntry = Array.from(activeTimerMap.values()).find((t) => t.ms === 2500 || t.ms === 900);
    assert.ok(snapTimerEntry, '初次加载后必须调度后台轮询定时器');
    alphaSnap.snapSeq = 2;
    alphaSnap.messages[0].text = '正文更新内容';
    alphaSnap.messages[0].html = '<p>正文更新内容</p>';
    await snapTimerEntry.fn();
    assert.ok(msgEl.querySelector('.thought-box')?.hasAttribute?.('open') || msgEl.querySelector('.thought-box')?.open, '同会话重绘应保留已展开思考块状态');
    assert.ok((msgEl.querySelector('.thought-body')?.textContent || '').includes('LAZY_THOUGHT_PAYLOAD_200KB'));

    // 3b) 启动一个在途 /api/snapshot，然后点击 sess-beta 验证：
    //     - 旧 /api/snapshot 的 AbortController 被立即 abort()
    //     - 侧栏按钮采用原地 class 切换（节点引用同一实例，不重刷 innerHTML）
    //     - 消息区进入 .is-switching 且标题乐观切至 Beta Title
    //     - 即便切换失败也回滚标题、撤除 .is-switching，且后台 2500ms 轮询器仍存活未被扼杀！
    let resolveHeldSnap;
    holdNextSnap = { promise: new Promise((r) => { resolveHeldSnap = r; }) };
    const latestTimerFn = Array.from(activeTimerMap.values()).find((t) => t.ms === 2500 || t.ms === 900)?.fn;
    assert.ok(latestTimerFn);
    const inflightPollPromise = latestTimerFn();
    await new Promise((r) => setTimeout(r, 10));
    const snapAbortCtrl = abortCreated[abortCreated.length - 1];
    assert.equal(snapAbortCtrl.signal.aborted, false);

    const convListEl = env.doc.getElementById('conv-list');
    const betaBtnBefore = convListEl.querySelector('button[data-cid="sess-beta"]');
    assert.ok(betaBtnBefore);
    nextActionMode = 'fail';
    betaBtnBefore.click();

    // 同步阶段验证乐观交互与旧请求 abort
    assert.equal(snapAbortCtrl.signal.aborted, true, '点击切换对话必须立刻 abort 在途 /api/snapshot');
    assert.equal(convListEl.querySelector('button[data-cid="sess-beta"]'), betaBtnBefore, '点击会话项不得同步销毁重建整棵 #conv-list DOM');
    assert.equal(betaBtnBefore.classList.contains('active'), true);
    assert.equal(betaBtnBefore.classList.contains('is-unread'), false);
    assert.equal(msgEl.classList.contains('is-switching'), true, '切换途中消息区应添加 is-switching 视觉反馈');
    assert.equal(env.doc.getElementById('conv-title')?.textContent, 'Beta Title');

    resolveHeldSnap();
    await inflightPollPromise;
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(msgEl.classList.contains('is-switching'), false, '切换失败后必须撤除 is-switching');
    assert.equal(env.doc.getElementById('conv-title')?.textContent, 'Alpha Title', '切换失败后标题应恢复原会话');
    assert.ok(Array.from(activeTimerMap.values()).some((t) => t.ms === 2500 || t.ms === 900), '即使中途中止旧轮询且切换失败，后台轮询定时器也必须继续存活');

    // 3c) 正常切换至 sess-beta 成功后，openThoughtIdxSet 清理，轮询定时器继续保持调度
    nextActionMode = 'ok';
    convListEl.querySelector('button[data-cid="sess-beta"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.doc.getElementById('conv-title')?.textContent, 'Beta Title');
    assert.equal(msgEl.classList.contains('is-switching'), false);
    assert.equal(msgEl.querySelector('.thought-body'), null, '切入新会话后默认折叠，不预先注入新会话隐藏思考 DOM');
    assert.ok(Array.from(activeTimerMap.values()).some((t) => t.ms === 2500 || t.ms === 900), '切换会话完成后后台轮询定时器必须保持激活');
  } finally {
    Date.now = origDateNow;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    if (prevCtxStateDir === undefined) delete process.env.AG_CONTEXT_METER_STATE_DIR;
    else process.env.AG_CONTEXT_METER_STATE_DIR = prevCtxStateDir;
    if (prevConfigDir === undefined) delete process.env.AG_CONFIG_DIR;
    else process.env.AG_CONFIG_DIR = prevConfigDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

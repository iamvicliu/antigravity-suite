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
// 需求 16: Antigravity v2.33.0+ 裸进程识别、运行时长解析与调试参数探测
// =========================================================================
test('需求 16: parsePsElapsedSeconds 与 inspectAntigravityHostProcess 准确识别裸进程与调试端口参数', () => {
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

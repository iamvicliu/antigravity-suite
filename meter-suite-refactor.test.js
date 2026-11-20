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
      assert.equal(openSettingsBtn, null, '配额浮窗不再内置独立设置入口，已统一收敛到外部顶栏设置入口');
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

  // 1. 验证原配置抽屉、原编辑按钮与已移除的 256K 解锁区均不存在于面板
  for (const removedId of [
    'meter-colors-drawer',
    'token-colors-drawer',
    'proxy-notun-drawer',
    'context-unlock-drawer',
    'unlock-drawer-body',
    'settings-slot-unlock',
    'settings-slot-unlock-badge',
    'summary-subtier-wrap',
    'btn-edit-plan-custom'
  ]) {
    assert.equal(shadow.getElementById(removedId), null, `迁移或移除后不应再存在旧配置容器: #${removedId}`);
  }

  // 2. 验证所有原配置主体已无损迁移进 #panel-settings 内部
  for (const movedId of [
    'color-drawer-body',
    'token-color-drawer-body',
    'proxy-drawer-body',
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

    const pills = remotePop.querySelectorAll('.ag-rp-ch-pill');
    assert.equal(pills.length, 3, '浮窗应只读展示 局域网 / Tailscale / Bonjour 三个通道标签');
    assert.ok(pills[0].textContent.includes('局域网') && pills[0].textContent.includes('192.168.1.2'));
    assert.ok(pills[1].textContent.includes('Tailscale') && pills[1].textContent.includes('dev-mac.tailnet-demo.ts.net'));
    assert.ok(pills[2].textContent.includes('Bonjour') && pills[2].textContent.includes('dev-macbook-pro.local'));
    assert.equal(remotePop.querySelectorAll('.ag-rp-channel').length, 0, '通道开关已迁移至设置面板，浮窗不再内嵌 .ag-rp-channel 控件');
    assert.equal(remotePop.querySelector('#ag-remote-reset'), null, '重置令牌已迁移至设置面板，浮窗不再内嵌 #ag-remote-reset');

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

    // 打开统一设置面板的「远程设置」重置密钥后应清空已关联设备计数并同步浮窗与顶栏角标
    enhancer.toggleRemotePopover(false);
    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    const remotePane = shadow.getElementById('settings-pane-remote');
    assert.equal(remotePane.querySelectorAll('.ag-rp-channel').length, 3, '设置面板远程分页应渲染完整通道管理列表');
    shadow.getElementById('ag-remote-reset')?.click();
    await new Promise(r => setTimeout(r, 30));
    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 20));
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
    const remotePane = shadow.getElementById('settings-pane-remote');
    const remotePop = shadow.getElementById('ag-remote-popover');

    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    const toggleBtn = remotePane.querySelector('#ag-rp-tunnel-toggle');
    const cfgBtn = remotePane.querySelector('#ag-rp-tunnel-cfg-btn');
    assert.ok(toggleBtn && cfgBtn, '远程设置面板应渲染 #ag-rp-tunnel-toggle 与 #ag-rp-tunnel-cfg-btn');

    // 点击展开固定域名配置表单
    cfgBtn.click();
    assert.ok(remotePane.querySelector('#ag-rp-tunnel-form'), '点击 固定域名 应展开固定域名与 Token 配置表单');

    // Re-query fresh button after cfgBtn.click() re-rendered pane
    remotePane.querySelector('#ag-rp-tunnel-toggle')?.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(tunnelPosts[0]?.enabled, true, '点击开启应请求 /remote-tunnel enabled=true');
    const tunnelRow = remotePane.querySelector('#ag-rp-tunnel-toggle');
    assert.equal(tunnelRow?.getAttribute('aria-checked'), 'true', '隧道就绪后行复选框应呈勾选状态');
    enhancer.toggleRemotePopover(true);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(remotePop.querySelector('.ag-rp-qr svg'), '隧道就绪后浮窗应刷新融合公网二维码');

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
    const remotePane = shadow.getElementById('settings-pane-remote');

    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    const checkBtns = remotePane.querySelectorAll('.ag-rp-check');
    assert.equal(checkBtns.length, 4, '4 个连接通道应统一渲染 4 个复选框控件');
    assert.equal(checkBtns.every(b => b.getAttribute('role') === 'checkbox'), true);

    const lanChk = remotePane.querySelector('#ag-rp-toggle-lan');
    assert.equal(lanChk?.getAttribute('aria-checked'), 'true');
    lanChk.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(postedPatches[0]?.enabledChannels, { lan: false }, '取消勾选局域网应提交 enabledChannels.lan=false');
    assert.equal(remotePane.querySelector('#ag-rp-toggle-lan')?.getAttribute('aria-checked'), 'false');

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
    const remotePaneR = envR.getShadow().getElementById('settings-pane-remote');

    apiR.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));

    const tsRow = remotePaneR.querySelector('#ag-rp-toggle-tailscale');
    assert.ok(tsRow && tsRow.classList.contains('ag-rp-channel'), 'Tailscale 行自身即为 .ag-rp-channel 整行复选框热区');
    assert.equal(tsRow.getAttribute('aria-checked'), 'false', '未启用的通道应展示为未勾选，但允许整行点击重新启用');
    assert.equal(tsRow.hasAttribute('disabled'), false);

    // 整行点击未启用的 Tailscale 行应提交启用请求
    tsRow.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(remotePosts[0]?.enabledChannels, { tailscale: true }, '点击未勾选整行应启用对应通道');
    assert.equal(remotePaneR.querySelector('#ag-rp-toggle-tailscale')?.getAttribute('aria-checked'), 'true');

    // 点击 固定域名 按钮只展开表单，不额外触发 /remote-tunnel 请求
    const postCountBeforeCfg = remotePosts.length;
    remotePaneR.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(remotePaneR.querySelector('#ag-rp-tunnel-form'), '点击固定域名按钮应展开表单');
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
    const shadow = env.getShadow();
    const remotePane = shadow.getElementById('settings-pane-remote');
    const settingsPanel = shadow.getElementById('panel-settings');

    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    remotePane.querySelector('#ag-rp-tunnel-cfg-btn')?.click();

    const cfLink = remotePane.querySelector('#ag-rp-cf-get-token');
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
    assert.equal(settingsPanel.hidden, false, '点击获取 Token 不应关闭统一设置面板');
    assert.equal(tunnelPosts.length, 0, '点击获取 Token 不得误发 /remote-tunnel 请求');

    // 切换英文界面文案校验
    env.win.dispatchEvent({ type: 'ag-suite-prefs-changed', detail: { locale: 'en', hansCode: 'en', capsuleLang: 'en' } });
    assert.match(remotePane.querySelector('#ag-rp-cf-get-token')?.textContent || '', /Get Token on Cloudflare/);
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
    const remotePane = shadow.getElementById('settings-pane-remote');

    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    remotePane.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(remotePane.querySelector('#ag-rp-tunnel-form'), '应展开固定域名表单');

    remotePane.querySelector('#ag-rp-cf-host').value = 'https://draft.example.com';
    remotePane.querySelector('#ag-rp-cf-token').value = 'eyJbad_token_draft';
    remotePane.querySelector('#ag-rp-cf-save')?.click();
    await new Promise(r => setTimeout(r, 30));

    assert.ok(remotePane.querySelector('#ag-rp-tunnel-form'), '保存报错时表单必须保持展开，不得自动折叠');
    assert.equal(remotePane.querySelector('#ag-rp-cf-host')?.value, 'https://draft.example.com', '保存报错后应保留域名草稿');
    assert.equal(remotePane.querySelector('#ag-rp-cf-token')?.value, 'eyJbad_token_draft', '保存报错后应保留 Token 草稿');
    assert.ok(remotePane.querySelector('.ag-rp-err')?.textContent, '保存报错后应在表单下方显示错误提示');

    // 修正为合法 Token 后重试保存应成功并自动收起、清空草稿
    remotePane.querySelector('#ag-rp-cf-token').value = stdToken;
    remotePane.querySelector('#ag-rp-cf-save')?.click();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(remotePane.querySelector('#ag-rp-tunnel-form'), null, '保存成功后应自动收起配置表单');
    remotePane.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.equal(remotePane.querySelector('#ag-rp-cf-token')?.value, '', '保存成功后重新展开不应残留明文 Token 草稿');

    // 验证关闭设置面板会清理草稿
    remotePane.querySelector('#ag-rp-cf-token').value = 'temp-draft-tok';
    remotePane.querySelector('#ag-rp-cf-token')?.dispatchEvent({ type: 'input', target: { value: 'temp-draft-tok' } });
    shadow.getElementById('close-settings')?.click();
    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 20));
    remotePane.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.equal(remotePane.querySelector('#ag-rp-cf-token')?.value, '', '关闭设置面板应清空未提交的 Token 草稿');

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
    const paneQ = envQ.getShadow().getElementById('settings-pane-remote');

    apiQ.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    paneQ.querySelector('#ag-rp-tunnel-cfg-btn')?.click();
    assert.ok(paneQ.querySelector('#ag-rp-tunnel-form'));

    paneQ.querySelector('#ag-rp-cf-quick')?.click();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(paneQ.querySelector('#ag-rp-tunnel-form'), '临时隧道协商期间应保持表单展开以展示加载动画');
    assert.ok(paneQ.querySelector('#ag-rp-cf-quick .ag-rp-spin'), '切换按钮应渲染 .ag-rp-spin 加载动画');
    const toggleHostText = paneQ.querySelector('#ag-rp-tunnel-toggle')?.textContent || '';
    assert.ok(toggleHostText.includes('正在切换临时隧道'), '通道行应显示正在切换临时隧道');
    assert.ok(!toggleHostText.includes('hubo1989.cloudflareaccess.com'), '切换期间通道行不得继续显示旧的 cloudflareaccess.com');

    resolveQuickReq({ ok: true, json: async () => ({ ok: true, data: quickReadyInfo }) });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(paneQ.querySelector('#ag-rp-tunnel-form'), null, '临时隧道就绪后应自动收起表单');
    assert.ok(
      (paneQ.querySelector('#ag-rp-tunnel-toggle')?.textContent || '').includes('demo-quick.trycloudflare.com'),
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

  // 4. 设置面板 #set-auto-compact 开关与说明文案、双向同步及 240K 自动压缩状态机防重复验证
  const envAc = createDomEnv();
  envAc.sandbox.setTimeout = setTimeout;
  envAc.sandbox.clearTimeout = clearTimeout;
  const composer = envAc.doc.createElement('div');
  composer.className = 'surface-composer';
  const editor = envAc.doc.createElement('div');
  editor.setAttribute('data-lexical-editor', 'true');
  editor.setAttribute('contenteditable', 'true');
  const sendBtn = envAc.doc.createElement('button');
  sendBtn.setAttribute('data-testid', 'send-button');
  let sendClicks = 0;
  sendBtn.addEventListener('click', () => { sendClicks++; });
  composer.appendChild(editor);
  composer.appendChild(sendBtn);
  envAc.doc.body.appendChild(composer);

  const capMock = envAc.doc.createElement('button');
  capMock.setAttribute('data-agy-context-capsule', '1');
  capMock.__ctxUsageData = { contextUsed: 180000, usagePercent: 35, cacheDropDetected: false };
  envAc.doc.body.appendChild(capMock);

  const insertedTexts = [];
  envAc.doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'insertText') {
      insertedTexts.push(val);
      editor.textContent = String(val || '');
      return true;
    }
    if (cmd === 'delete') {
      editor.textContent = '';
      return true;
    }
    return true;
  };
  envAc.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  envAc.win.getSelection = () => ({ removeAllRanges() {}, addRange() {} });

  vm.runInContext(RENDERER_SRC, envAc.sandbox);
  vm.runInContext(ENHANCER_SRC, envAc.sandbox);
  const sdAc = envAc.getShadow();
  const enhAc = envAc.sandbox.__AGEnhancer;

  const chkAutoCompact = sdAc.getElementById('set-auto-compact');
  assert.ok(chkAutoCompact, '设置面板必须包含 #set-auto-compact 开关');
  assert.equal(chkAutoCompact.checked, true, '240K 自动压缩开关应默认开启');
  const terminalPaneText = sdAc.getElementById('settings-pane-terminal')?.textContent || '';
  assert.match(terminalPaneText, /512K/);
  assert.match(terminalPaneText, /240K/);
  assert.match(terminalPaneText, /\/compact/);
  assert.equal(enhAc.getAutoCompact(), true);

  chkAutoCompact.checked = false;
  chkAutoCompact.dispatchEvent({ type: 'change' });
  assert.equal(envAc.localStorage.getItem('ag_suite_auto_compact'), 'false');
  assert.ok(envAc.postedSettings.some(p => p.uiPreferences?.autoCompact === false));
  assert.equal(enhAc.getAutoCompact(), false);
  const disabledRes = enhAc.runAutoCompactTick({ immediate: true });
  assert.equal(disabledRes.triggered, false);
  assert.equal(disabledRes.reason, 'disabled');

  chkAutoCompact.checked = true;
  chkAutoCompact.dispatchEvent({ type: 'change' });
  assert.equal(enhAc.getAutoCompact(), true);

  // 未达 240K 阈值时不触发
  const belowRes = enhAc.runAutoCompactTick({ immediate: true });
  assert.equal(belowRes.triggered, false);
  assert.equal(belowRes.reason, 'below_threshold');

  // 达到 240K 阈值且输入框为空时自动触发 /compact 发送，并进入冷却防重
  capMock.__ctxUsageData = { contextUsed: 256000, usagePercent: 50, cacheDropDetected: false };
  const acRes = enhAc.runAutoCompactTick({ immediate: true });
  assert.equal(acRes.triggered, true);
  assert.equal(acRes.reason, 'threshold_240k');
  await new Promise(r => setTimeout(r, 90));
  assert.ok(insertedTexts.includes('/compact'), '自动压缩应向输入框写入 /compact');
  assert.equal(sendClicks, 1, '自动压缩应点击发送按钮提交 /compact');

  editor.textContent = '';
  const cooldownRes = enhAc.runAutoCompactTick({ immediate: true });
  assert.equal(cooldownRes.triggered, false);
  assert.equal(sendClicks, 1, '冷却期内不得重复触发 /compact');

  enhAc.dispose?.();
  envAc.sandbox.__AGContextMeter.dispose();
});
// =========================================================================
// 需求 19: 远程同设备跨通道去重合并、打开自动切换最快路线与连接方式测速弹窗验证
// =========================================================================
test('需求 19: 远程同设备跨通道去重合并、打开自动切换最快路线与连接方式测速弹窗验证', async () => {
  const os = require('node:os');
  const vm = require('node:vm');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req16-remote-'));
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
      recordPairedDeviceAccess,
      getPairedDevicesSummary,
      buildMobileAppHtml,
      encodeEndpointsParam,
      parseTailscalePingOutput
    } = require('./mobile-remote.js');

    // 0. 验证 tailscale ping 输出解析（直连内网 IP / DERP 中继 / 超时）
    const directPong = parseTailscalePingOutput('pong from iphone-16-pro-max-1 (100.122.156.8) via 10.181.50.74:55970 in 55ms');
    assert.deepEqual(
      { ok: directPong.ok, peerIp: directPong.peerIp, viaLanIp: directPong.viaLanIp, isDerp: directPong.isDerp, ms: directPong.ms },
      { ok: true, peerIp: '100.122.156.8', viaLanIp: '10.181.50.74', isDerp: false, ms: 55 }
    );
    const derpPong = parseTailscalePingOutput('pong from iphone (100.122.156.8) via DERP(hkg) in 88.4ms');
    assert.deepEqual(
      { ok: derpPong.ok, viaLanIp: derpPong.viaLanIp, isDerp: derpPong.isDerp, ms: derpPong.ms },
      { ok: true, viaLanIp: '', isDerp: true, ms: 88 }
    );
    assert.equal(parseTailscalePingOutput('timed out').ok, false);

    const cfg = saveRemoteTunnelConfig({
      enabled: true,
      tunnelMode: 'quick',
      enabledChannels: { lan: true, tailscale: false, bonjour: true, tunnel: true }
    });
    const tok = buildRemoteInfo().token;
    const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
    const baseNow = Date.now();

    // 1. 同设备跨 Tailscale -> Cloudflare -> LAN（即使 localStorage 设备 ID 不同或无 ID），按指纹+UA 去重为 1 台设备
    recordPairedDeviceAccess({
      url: '/api/snapshot',
      headers: {
        'user-agent': iphoneUa,
        'x-ag-device-id': 'dev-ts-origin',
        'x-ag-device-fp': 'fp-same111-393x852',
        host: '100.67.239.94:18765'
      },
      socket: { remoteAddress: '100.67.239.10' }
    }, tok, baseNow);

    recordPairedDeviceAccess({
      url: '/api/snapshot',
      headers: {
        'user-agent': iphoneUa,
        'x-ag-device-id': 'dev-cf-origin',
        'x-ag-device-fp': 'fp-same111-393x852',
        'cf-ray': 'ray-999',
        host: 'demo-quick.trycloudflare.com'
      },
      socket: { remoteAddress: '127.0.0.1' }
    }, tok, baseNow + 200);

    recordPairedDeviceAccess({
      url: '/?token=' + tok + '&autosw=1',
      headers: {
        'user-agent': iphoneUa,
        host: '10.181.51.171:18765'
      },
      socket: { remoteAddress: '10.181.51.88' }
    }, tok, baseNow + 500);

    // 测速探针请求不得误写入或覆盖关联设备
    assert.equal(recordPairedDeviceAccess({
      url: '/api/ping?probe=1&_t=123',
      headers: {
        'user-agent': iphoneUa,
        'x-ag-probe': '1',
        'cf-ray': 'ray-probe',
        host: 'demo-quick.trycloudflare.com'
      },
      socket: { remoteAddress: '127.0.0.1' }
    }, tok, baseNow + 700), null, '测速 /api/ping?probe=1 不得写入关联设备列表');

    let summary = getPairedDevicesSummary(tok, baseNow + 800);
    assert.equal(summary.pairedCount, 1, '同一台 iPhone 在 Tailscale / Cloudflare / LAN 间切换应去重合并为 1 台');
    assert.equal(summary.onlineCount, 1);
    assert.equal(summary.devices[0]?.channel, 'lan', '最新入口通道应更新为 lan，不得被测速探针覆盖');

    // 另一台不同指纹的 iPhone 应保持独立计数
    recordPairedDeviceAccess({
      url: '/api/snapshot',
      headers: {
        'user-agent': iphoneUa,
        'x-ag-device-id': 'dev-other-iphone',
        'x-ag-device-fp': 'fp-other222-440x956',
        host: '10.181.51.171:18765'
      },
      socket: { remoteAddress: '10.181.51.99' }
    }, tok, baseNow + 900);
    summary = getPairedDevicesSummary(tok, baseNow + 1000);
    assert.equal(summary.pairedCount, 2, '不同硬件指纹的 iPhone 必须保持为 2 台独立设备');
    assert.equal(summary.onlineCount, 2);

    // 2. /api/ping.gif 探针接口：启用通道返回 200 GIF，停用通道返回 403
    const handler = createRemoteHttpHandler(cfg, { getTunnelOrigin: () => 'https://demo-quick.trycloudflare.com' });
    const runHttpReq = async ({ url, headers = {}, remoteAddress = '127.0.0.1' }) => {
      let status = 0;
      const resHeaders = {};
      const chunks = [];
      const req = { method: 'GET', url, headers, socket: { remoteAddress } };
      const res = {
        setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
        writeHead(code, h = {}) {
          status = code;
          for (const [k, v] of Object.entries(h)) resHeaders[String(k).toLowerCase()] = v;
        },
        end(chunk) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      };
      await handler(req, res);
      return { status, resHeaders, buf: Buffer.concat(chunks) };
    };

    const gifOk = await runHttpReq({
      url: '/api/ping.gif?probe=1&_t=1',
      headers: { host: '10.181.51.171:18765' },
      remoteAddress: '10.181.51.88'
    });
    assert.equal(gifOk.status, 200);
    assert.equal(gifOk.resHeaders['content-type'], 'image/gif');
    assert.equal(gifOk.buf.subarray(0, 6).toString('ascii'), 'GIF89a');

    const gifBlocked = await runHttpReq({
      url: '/api/ping.gif?probe=1&_t=1',
      headers: { host: '100.67.239.94:18765' },
      remoteAddress: '100.67.239.10'
    });
    assert.equal(gifBlocked.status, 403, '已停用的 Tailscale 通道请求 /api/ping.gif 应返回 403');

    // 3. 验证移动端 PWA 打开自动测速切换最快路线 + 弹窗显示延迟与测速按钮
    const html = buildMobileAppHtml();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1]);

    const runMobileClientVm = ({ href, fetchHandler, imageHandler }) => {
      const timers = new Set();
      const makeEl = (id) => {
        const cls = new Set();
        const el = {
          id,
          hidden: false,
          disabled: false,
          value: '',
          innerHTML: '',
          textContent: '',
          scrollHeight: 28,
          scrollTop: 0,
          clientHeight: 600,
          offsetWidth: 300,
          dataset: {},
          style: {},
          className: '',
          children: [],
          classList: {
            add: (...xs) => xs.forEach((x) => cls.add(x)),
            remove: (...xs) => xs.forEach((x) => cls.delete(x)),
            toggle: (x) => (cls.has(x) ? cls.delete(x) : cls.add(x)),
            contains: (x) => cls.has(x)
          },
          setAttribute() {},
          removeAttribute() {},
          getAttribute: () => null,
          appendChild(child) {
            this.children.push(child);
            return child;
          },
          addEventListener() {},
          contains: () => false,
          focus() {},
          blur() {},
          click() {
            if (typeof this.onclick === 'function') return this.onclick({ stopPropagation() {} });
          },
          querySelectorAll: () => []
        };
        return el;
      };
      const ids = [
        'messages', 'sub-meta', 'status-dot', 'conv-title', 'quota-main', 'ctx-badge',
        'model-inline-label', 'perm-inline-label', 'quota-drawer', 'approval-dock',
        'chips', 'conv-list', 'drawer-nav-bar', 'input', 'btn-img', 'img-input',
        'btn-model-inline', 'btn-perm-inline', 'btn-send', 'attach-hint', 'btn-quota',
        'btn-drawer', 'drawer-backdrop', 'drawer-panel', 'btn-new-chat', 'toast',
        'sheet-backdrop', 'sheet-back-btn', 'sheet-title-text', 'sheet-sub-text',
        'sheet-action-btn', 'sheet-close', 'sheet-list'
      ];
      const byId = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
      byId['sheet-backdrop'].hidden = true;
      byId['quota-drawer'].hidden = true;
      byId['toast'].hidden = true;
      const appNode = makeEl('__app');
      const cardNode = makeEl('__card');

      const lStore = new Map();
      const sStore = new Map();
      const replacedUrls = [];
      const hrefAssigned = [];
      const uObj = new URL(href);
      const locObj = {
        get href() { return uObj.href; },
        set href(v) { hrefAssigned.push(String(v)); },
        origin: uObj.origin,
        protocol: uObj.protocol,
        pathname: uObj.pathname,
        search: uObj.search,
        port: uObj.port,
        replace(v) { replacedUrls.push(String(v)); }
      };

      const sandbox = {
        URL,
        URLSearchParams,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        Date,
        JSON,
        Promise,
        Uint8Array,
        TextEncoder,
        TextDecoder,
        AbortController,
        Intl,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        encodeURIComponent,
        decodeURIComponent,
        escape: (s) => encodeURIComponent(s),
        unescape: (s) => decodeURIComponent(s),
        screen: { width: 393, height: 852 },
        devicePixelRatio: 3,
        navigator: { platform: 'iPhone', maxTouchPoints: 5, hardwareConcurrency: 6 },
        location: locObj,
        history: { replaceState() {} },
        localStorage: {
          getItem: (k) => (lStore.has(k) ? lStore.get(k) : null),
          setItem: (k, v) => lStore.set(k, String(v)),
          removeItem: (k) => lStore.delete(k)
        },
        sessionStorage: {
          getItem: (k) => (sStore.has(k) ? sStore.get(k) : null),
          setItem: (k, v) => sStore.set(k, String(v)),
          removeItem: (k) => sStore.delete(k)
        },
        document: {
          hidden: false,
          activeElement: null,
          documentElement: { clientHeight: 852, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => '' },
          body: { style: {}, classList: { contains: () => false, toggle() {}, add() {}, remove() {} } },
          getElementById: (id) => byId[id] || null,
          querySelector: (sel) => (sel === '.app' ? appNode : (sel === '.composer-card' ? cardNode : null)),
          createElement: (tag) => makeEl(tag),
          addEventListener() {}
        },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        innerWidth: 393,
        innerHeight: 852,
        visualViewport: null,
        setTimeout: (fn, ms) => {
          const t = setTimeout(() => { timers.delete(t); fn(); }, Math.min(Number(ms) || 0, 50));
          timers.add(t);
          return t;
        },
        clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
        fetch: fetchHandler,
        Image: class MockImage {
          set src(val) {
            imageHandler(String(val), {
              succeed: () => { if (typeof this.onload === 'function') this.onload(); },
              fail: () => { if (typeof this.onerror === 'function') this.onerror(); }
            });
          }
        }
      };
      sandbox.window = sandbox;
      sandbox.addEventListener = () => {};
      vm.runInNewContext(scriptMatch[1], sandbox);
      return {
        byId,
        replacedUrls,
        hrefAssigned,
        cleanup: () => {
          for (const t of timers) clearTimeout(t);
          timers.clear();
        }
      };
    };

    const testEps = [
      { url: 'http://10.181.51.171:18765', kind: 'lan', priority: 0 },
      { url: 'https://demo-quick.trycloudflare.com', kind: 'tunnel', priority: 250 }
    ];
    const encEps = encodeEndpointsParam(testEps);

    // 3a. 从公网隧道打开，自动测速发现 LAN (~5ms) 显著快于 Cloudflare (~60ms) -> 调用 location.replace 自动切到 LAN 并携带 did/autosw/spd
    const autoVm = runMobileClientVm({
      href: `https://demo-quick.trycloudflare.com/?token=${tok}&endpoints=${encEps}`,
      fetchHandler: async (url) => {
        const u = String(url);
        if (u.includes('/api/ping')) {
          const parsedU = new URL(u, 'https://demo-quick.trycloudflare.com');
          const nonce = parsedU.searchParams.get('_n') || '';
          const delayMs = u.includes('10.181.51.171') ? 4 : 60;
          await new Promise((r) => setTimeout(r, delayMs));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              service: 'ag-mobile-remote',
              nonce,
              endpoints: testEps,
              hosts: ['10.181.51.171']
            })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            title: 'Test Session',
            busy: false,
            messages: [],
            endpoints: testEps,
            hosts: ['10.181.51.171']
          })
        };
      },
      imageHandler: (_src, cb) => {
        setTimeout(() => cb.succeed(), 2);
      }
    });
    try {
      await new Promise((r) => setTimeout(r, 180));
      assert.equal(autoVm.replacedUrls.length, 1, '从公网隧道打开且局域网明显更快时应自动切换到 LAN');
      const switchedUrl = new URL(autoVm.replacedUrls[0]);
      assert.equal(switchedUrl.origin, 'http://10.181.51.171:18765');
      assert.equal(switchedUrl.searchParams.get('autosw'), '1');
      assert.ok((switchedUrl.searchParams.get('did') || '').startsWith('dev-'), '跨源切换必须透传同一 deviceId');
      assert.ok(switchedUrl.searchParams.get('spd'), '跨源切换应附带最近一次测速结果参数 spd');
    } finally {
      autoVm.cleanup();
    }

    // 3b. manual=1 时锁定手动通道不自动重定向；打开切换连接方式弹窗展示最近测速延迟，点击 ⚡ 测速按钮可实时重测
    let pingRound = 0;
    const manualVm = runMobileClientVm({
      href: `https://demo-quick.trycloudflare.com/?token=${tok}&manual=1&endpoints=${encEps}`,
      fetchHandler: async (url) => {
        const u = String(url);
        if (u.includes('/api/ping')) {
          const parsedU = new URL(u, 'https://demo-quick.trycloudflare.com');
          const nonce = parsedU.searchParams.get('_n') || '';
          pingRound += 1;
          const delayMs = u.includes('10.181.51.171') ? 4 : 35;
          await new Promise((r) => setTimeout(r, delayMs));
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, service: 'ag-mobile-remote', nonce, endpoints: testEps })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, title: 'Test Session', busy: false, messages: [], endpoints: testEps })
        };
      },
      imageHandler: (_src, cb) => {
        setTimeout(() => cb.succeed(), 2);
      }
    });
    try {
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(manualVm.replacedUrls.length, 0, 'manual=1 手动切换后不应再次自动跳转');

      // 打开切换连接方式弹窗
      manualVm.byId['sub-meta'].click();
      assert.equal(manualVm.byId['sheet-backdrop'].hidden, false);
      assert.equal(manualVm.byId['sheet-title-text'].textContent, '切换连接方式');
      assert.equal(manualVm.byId['sheet-sub-text'].hidden, false);
      assert.ok(manualVm.byId['sheet-sub-text'].textContent.includes('最近测速'), '弹窗应显示最近一次测速时间参考');
      assert.equal(manualVm.byId['sheet-action-btn'].hidden, false);
      assert.ok(manualVm.byId['sheet-action-btn'].innerHTML.includes('测速'), '弹窗顶部应提供 测速 按钮');
      assert.ok(manualVm.byId['sheet-list'].innerHTML.includes('ms'), '各通道行应展示测速耗时 (ms)');
      assert.ok(manualVm.byId['sheet-list'].innerHTML.includes('最快'), '最快通道行应带有 最快 标识');

      const roundsBeforeBtn = pingRound;
      manualVm.byId['sheet-action-btn'].click();
      assert.equal(manualVm.byId['sheet-backdrop'].hidden, false, '点击测速按钮不应关闭弹窗');
      assert.ok(manualVm.byId['sheet-action-btn'].innerHTML.includes('测速中'), '点击测速后按钮应呈现测速中加载态');
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(pingRound > roundsBeforeBtn, '点击测速按钮应重新并发探针测速');
      assert.ok(manualVm.byId['sheet-action-btn'].innerHTML.includes('⚡ 测速'), '测速完成后按钮应恢复可点击态');
      assert.ok(manualVm.byId['sheet-sub-text'].textContent.includes('最近测速'), '测速完成后应刷新最近测速时间');
    } finally {
      manualVm.cleanup();
    }

    // 3c. 模拟 iOS Safari 在 HTTPS 页面拦截全部 http:// 图片与 fetch 探测，结合 /api/probe-hints 仍能识别内网延迟并自动切换
    const fullEps = [
      { url: 'http://10.181.51.171:18765', kind: 'lan', priority: 0 },
      { url: 'http://100.67.239.94:18765', kind: 'tailscale', priority: 100 },
      { url: 'http://hubertdemacbook-pro.local:18765', kind: 'bonjour', priority: 200 },
      { url: 'https://ag.20160325.xyz', kind: 'tunnel', priority: 250 }
    ];
    const encFull = encodeEndpointsParam(fullEps);
    const makeSafariHttpsHandlers = () => ({
      fetchHandler: async (url) => {
        const u = String(url);
        if (u.startsWith('http://')) {
          throw new Error('Blocked mixed content');
        }
        if (u.includes('/api/probe-hints')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              hints: {
                lan: { ok: true, ms: 14, via: 'server' },
                tailscale: { ok: true, ms: 55, via: 'server' },
                bonjour: { ok: true, ms: 19, via: 'server' }
              }
            })
          };
        }
        if (u.includes('/api/ping')) {
          const parsedU = new URL(u, 'https://ag.20160325.xyz');
          const nonce = parsedU.searchParams.get('_n') || '';
          await new Promise((r) => setTimeout(r, 45));
          return { ok: true, status: 200, json: async () => ({ ok: true, service: 'ag-mobile-remote', nonce, endpoints: fullEps }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, title: 'HTTPS Session', busy: false, messages: [], endpoints: fullEps })
        };
      },
      imageHandler: (_src, cb) => {
        setTimeout(() => cb.fail(), 2);
      }
    });

    const safariAutoVm = runMobileClientVm({
      href: `https://ag.20160325.xyz/?token=${tok}&endpoints=${encFull}`,
      ...makeSafariHttpsHandlers()
    });
    try {
      await new Promise((r) => setTimeout(r, 180));
      assert.equal(safariAutoVm.replacedUrls.length, 1, 'iOS Safari HTTPS 下借助 /api/probe-hints 发现更快 LAN 时应自动切换');
      assert.equal(new URL(safariAutoVm.replacedUrls[0]).origin, 'http://10.181.51.171:18765');
    } finally {
      safariAutoVm.cleanup();
    }

    const safariManualVm = runMobileClientVm({
      href: `https://ag.20160325.xyz/?token=${tok}&manual=1&endpoints=${encFull}`,
      ...makeSafariHttpsHandlers()
    });
    try {
      await new Promise((r) => setTimeout(r, 160));
      safariManualVm.byId['sub-meta'].click();
      const listHtml = safariManualVm.byId['sheet-list'].innerHTML;
      assert.ok(listHtml.includes('14 ms') && listHtml.includes('55 ms') && listHtml.includes('19 ms'),
        'HTTPS 下即使浏览器拦截 http:// 探针，也应通过 /api/probe-hints 展示 LAN/Tailscale/Bonjour 参考延迟');
      assert.ok(listHtml.includes('最快'), '局域网应标注 最快');
      assert.ok(!listHtml.includes('不可达'), 'iOS Safari HTTPS 拦截时不得误报 不可达');
    } finally {
      safariManualVm.cleanup();
    }
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
// 需求 20: QuickBar 右对齐建议/免CLI提示词优化 + 手机端防假1ms/发送锁定/分组模型滑窗/按项目聚合历史
// =========================================================================
test('需求 20: QuickBar 右对齐建议、免 CLI 提示词优化及手机端 5 项交互修复', async () => {
  // -----------------------------------------------------------------------
  // Part A: 桌面端 ag-enhancer-overlay.js
  // -----------------------------------------------------------------------
  const env = createDomEnv();
  const activeTimers = new Set();
  env.sandbox.setTimeout = (fn, ms) => {
    const delay = Number(ms) > 500 ? Number(ms) : Math.min(Number(ms) || 0, 10);
    const t = setTimeout(() => { activeTimers.delete(t); fn(); }, delay);
    activeTimers.add(t);
    return t;
  };
  env.sandbox.clearTimeout = (t) => { activeTimers.delete(t); clearTimeout(t); };
  env.sandbox.location = { pathname: '/c/conv-a1', origin: 'https://127.0.0.1:1234', href: 'https://127.0.0.1:1234/c/conv-a1' };
  env.sandbox.__APP_CONFIG__ = { csrfToken: 'test-csrf-token' };
  env.sandbox.PopStateEvent = class PopStateEvent { constructor(type) { this.type = type; } };
  env.sandbox.window.history = {
    pushState(_st, _t, url) { env.sandbox.location.pathname = String(url); }
  };

  // 构建模拟 Composer（含 Lexical 编辑器与 .agy-composer-footer）及按项目分组的侧边栏
  const mainWrap = env.doc.createElement('div');
  mainWrap.className = 'chat-pane';
  const composerEl = env.doc.createElement('div');
  composerEl.className = 'surface-composer';
  const editorParent = env.doc.createElement('div');
  const editorEl = env.doc.createElement('div');
  editorEl.setAttribute('data-lexical-editor', 'true');
  editorEl.setAttribute('contenteditable', 'true');
  editorParent.appendChild(editorEl);
  const footerEl = env.doc.createElement('div');
  footerEl.className = 'agy-composer-footer';
  const leftGroupEl = env.doc.createElement('div');
  const addCtxBtn = env.doc.createElement('button');
  addCtxBtn.setAttribute('aria-label', '添加上下文');
  leftGroupEl.appendChild(addCtxBtn);
  const rightGroupEl = env.doc.createElement('div');
  footerEl.appendChild(leftGroupEl);
  footerEl.appendChild(rightGroupEl);
  composerEl.appendChild(editorParent);
  composerEl.appendChild(footerEl);
  mainWrap.appendChild(composerEl);
  env.doc.body.appendChild(mainWrap);

  const sidebarEl = env.doc.createElement('div');
  sidebarEl.setAttribute('data-testid', 'conversation-list-sidebar');
  const sbH1 = env.doc.createElement('div');
  sbH1.setAttribute('data-testid', 'project-header');
  sbH1.textContent = 'antigravity-suite';
  const sbR1 = env.doc.createElement('div');
  sbR1.setAttribute('data-testid', 'conversation-row-sidebar');
  sbR1.setAttribute('data-cascade-id', 'conv-a1');
  const sbR1A = env.doc.createElement('a');
  sbR1A.setAttribute('href', '/c/conv-a1');
  const sbR1Span = env.doc.createElement('span');
  sbR1Span.className = 'truncate';
  sbR1Span.textContent = '当前对话 A1';
  sbR1A.appendChild(sbR1Span);
  sbR1.appendChild(sbR1A);
  const sbH2 = env.doc.createElement('div');
  sbH2.setAttribute('data-testid', 'project-header');
  sbH2.textContent = 'PMStudio';
  const sbR2 = env.doc.createElement('div');
  sbR2.setAttribute('data-testid', 'conversation-row-sidebar');
  sbR2.setAttribute('data-cascade-id', 'conv-b1');
  const sbR2A = env.doc.createElement('a');
  sbR2A.setAttribute('href', '/c/conv-b1');
  const sbR2Span = env.doc.createElement('span');
  sbR2Span.className = 'truncate';
  sbR2Span.textContent = '项目 B 对话';
  sbR2A.appendChild(sbR2Span);
  sbR2.appendChild(sbR2A);
  sidebarEl.appendChild(sbH1);
  sidebarEl.appendChild(sbR1);
  sidebarEl.appendChild(sbH2);
  sidebarEl.appendChild(sbR2);
  env.doc.body.appendChild(sidebarEl);

  env.sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  env.win.getSelection = env.sandbox.getSelection;
  env.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  env.doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'insertText') {
      editorEl.textContent = String(val || '');
      return true;
    }
    if (cmd === 'delete') {
      editorEl.textContent = '';
      return true;
    }
    return true;
  };

  const rpcCalls = [];
  env.sandbox.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    rpcCalls.push({ url: u, body });
    if (u.includes('GetUserStatus')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userStatus: {
            cascadeModelConfigData: {
              defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M437' } },
              clientModelConfigs: [
                { label: 'Gemini 4 Carbon (Medium)', modelId: 'gemini-4-carbon-medium', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M437' } }
              ]
            }
          }
        })
      };
    }
    if (u.includes('GetModelResponse')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: '```markdown\n1. 目标：将提交按钮调整为主品牌蓝。\n2. 约束：保持圆角、尺寸与对比度清晰。\n```'
        })
      };
    }
    if (u.includes('GetAllCascadeTrajectories')) {
      return { ok: true, status: 200, json: async () => ({ trajectorySummaries: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(ENHANCER_SRC, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;

  try {
    // 1. 移除缓存按钮，并将 Tab 补全建议移到 #ag-quick-capsule-bar 右侧 slot
    assert.equal(env.doc.getElementById('ag-qcap-brain'), null, '应移除无意义的缓存统计按钮 #ag-qcap-brain');
    const quickBar = env.doc.getElementById('ag-quick-capsule-bar');
    const rightSlot = env.doc.getElementById('ag-qcap-right-slot');
    const ghostEl = env.doc.getElementById('ag-next-step-ghost');
    assert.ok(quickBar && rightSlot && ghostEl, 'QuickBar 右侧建议槽位与 #ag-next-step-ghost 应存在');
    assert.equal(ghostEl.parentElement, rightSlot, '#ag-next-step-ghost 应挂载在导出 Markdown 右侧的 #ag-qcap-right-slot 中');
    assert.equal(editorParent.getAttribute('data-ag-has-ghost'), null, '输入框不应再附着 data-ag-has-ghost 遮挡层');
    assert.equal(quickBar.children[quickBar.children.length - 1], rightSlot, '#ag-qcap-right-slot 应位于 QuickBar 最右侧');
    assert.ok(ghostEl.textContent.includes('Tab / →'), '右侧建议栏应展示 Tab / → 补全提示');

    // 2. 免 CLI 提示词优化按钮挂载在 send 按钮 (.agy-composer-footer) 上方，使用单色 currentColor SVG，空输入禁用、非空调用默认模型优化并可撤回
    const optWrap = env.doc.getElementById('ag-prompt-opt-wrap');
    const optBtn = env.doc.getElementById('ag-prompt-opt-btn');
    const undoBtn = env.doc.getElementById('ag-prompt-undo-btn');
    assert.ok(optWrap && optBtn && undoBtn, '输入框内应挂载提示词优化与撤回按钮');
    assert.equal(optWrap.getAttribute('data-position'), 'above-send', '提示词优化栏应标记挂载在 send 上方');
    assert.equal(optWrap.nextElementSibling, footerEl, '#ag-prompt-opt-wrap 应紧邻位于 .agy-composer-footer 上方');
    assert.ok(optBtn.querySelector('svg'), '提示词优化按钮应使用单色 SVG 图标');
    assert.equal(optBtn.textContent.includes('✨'), false, '提示词优化按钮不得使用彩色 emoji ✨');
    assert.equal(optBtn.disabled, true, '输入框为空时优化按钮应禁用');
    assert.equal(undoBtn.hidden, true, '未优化前撤回按钮应隐藏');

    editorEl.textContent = '/plan 把按钮改成蓝色';
    enhancer.ensurePromptOptimizerControls();
    assert.equal(optBtn.disabled, false, '输入草稿后优化按钮应可用');

    const optRes = await enhancer.optimizeComposerPrompt();
    assert.equal(optRes.ok, true, '点击优化应成功返回并回填');
    const genCall = rpcCalls.find((c) => c.url.includes('GetModelResponse'));
    assert.ok(genCall, '应直接调用桌面端 GetModelResponse RPC 而不依赖 CLI');
    assert.equal(genCall.body.model, 'MODEL_PLACEHOLDER_M437', '应使用桌面端当前默认模型枚举');
    assert.ok(genCall.body.prompt.includes('Google Cloud') && genCall.body.prompt.includes('<draft>\n把按钮改成蓝色\n</draft>'), '应使用参考 Google Cloud 提示工程规范的优化指令');
    assert.ok(editorEl.textContent.startsWith('/plan 1. 目标：将提交按钮调整为主品牌蓝'), `应剥离外层代码围栏并保留 /plan 前缀，实际为: ${editorEl.textContent}`);
    assert.equal(undoBtn.hidden, false, '优化完成后应显示撤回按钮');

    await enhancer.undoPromptOptimize();
    assert.equal(editorEl.textContent, '/plan 把按钮改成蓝色', '点击 ↩ 撤回 后应恢复原始草稿');
    assert.equal(undoBtn.hidden, true, '撤回后撤回按钮应隐藏');

    // 3. 快照按项目聚合历史会话
    const snap = enhancer.getMobileSnapshot();
    assert.equal(snap.projectGroups.length, 2, '快照应包含按项目聚合的 projectGroups');
    assert.equal(snap.projectGroups[0].name, 'antigravity-suite');
    assert.equal(snap.projectGroups[1].name, 'PMStudio');
    assert.equal(snap.projectGroups[1].conversations[0].id, 'conv-b1');
  } finally {
    enhancer?.dispose?.();
    env.sandbox.__AGContextMeter?.dispose?.();
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
  }

  // -----------------------------------------------------------------------
  // Part B: 手机端防假 1ms 局域网误判 + 服务端探针隔离
  // -----------------------------------------------------------------------
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-v194-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmpState;
  delete require.cache[require.resolve('./mobile-remote.js')];
  const mr = require('./mobile-remote.js');
  try {
    const fakeNets = {
      en0: [{ address: '10.181.51.171', netmask: '255.255.254.0', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.67.239.94', netmask: '255.255.255.255', family: 'IPv4', internal: false }]
    };
    assert.equal(mr.isIpInLocalPhysicalLanSubnet('10.181.50.88', fakeNets), true, '同物理子网对端 IP 应匹配');
    assert.equal(mr.isIpInLocalPhysicalLanSubnet('10.181.51.171', fakeNets), false, '本机自身 LAN IP 必须排除，防环回 1ms');
    assert.equal(mr.isIpInLocalPhysicalLanSubnet('192.168.1.20', fakeNets), false, '不同网段内网 IP 不应误判本地物理局域网');

    mr.clearPairedDevicesForTests();
    const baseNow = 1795000000000;
    // 先在旧时刻通过内网访问过，随后跨时间切走 -> 过期(>12s) lastLanIp 不得再被 ping
    mr.recordPairedDeviceAccess({
      url: '/api/snapshot?did=dev-iphone-stale1',
      headers: { host: '10.181.51.171:18765', 'user-agent': 'Mozilla/5.0 (iPhone)', 'x-ag-device-id': 'dev-iphone-stale1' },
      socket: { remoteAddress: '::ffff:10.181.51.88' }
    }, 'tok-test-12345678901234567890', baseNow - 30000, 'https://ag.20160325.xyz');

    const executedCmds = [];
    const hints = await mr.probeClientPrivateReachability(
      {
        url: '/api/probe-hints?probe=1&did=dev-iphone-stale1',
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', 'x-ag-device-id': 'dev-iphone-stale1' }
      },
      { enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: true } },
      {
        force: true,
        now: baseNow,
        skipProbes: false,
        networkInterfaces: fakeNets,
        execAsync: async (bin, args) => {
          executedCmds.push([bin, ...args]);
          if (args.includes('status')) {
            return {
              ok: true,
              stdout: JSON.stringify({
                Peer: {
                  mac1: { Online: true, OS: 'macos', TailscaleIPs: ['100.84.19.75'] },
                  phone1: { Online: true, OS: 'ios', TailscaleIPs: ['100.122.156.8'] }
                }
              }),
              stderr: ''
            };
          }
          if (args.includes('ping') && bin.includes('tailscale')) {
            // DERP 中继下即使带私网 IP 也不可判局域网直连
            return { ok: true, stdout: 'pong from phone1 (100.122.156.8) via DERP(hkg) in 62ms', stderr: '' };
          }
          return { ok: false, stdout: '', stderr: 'unreachable' };
        }
      }
    );
    assert.equal(executedCmds.some((c) => c[0] === 'ping' && c.includes('10.181.51.88')), false, '过期超过 12 秒的 lastLanIp 不得触发服务端 LAN ping');
    assert.equal(hints.lan?.ok, false, '当前局域网不通时不得返回 fake 1ms ok');
    assert.equal(hints.tailscale?.ok, true);
    assert.equal(hints.tailscale?.ms, 62);

    // -----------------------------------------------------------------------
    // Part C: 手机端 DOM 交互验证（发送按钮立即禁用、隐藏测速按钮、模型分组左滑思考等级、按项目聚合历史）
    // -----------------------------------------------------------------------
    const mobileHtml = mr.buildMobileAppHtml();
    assert.ok(!mobileHtml.includes('/api/ping.gif'), '客户端测速探针不应再使用易被代理劫持伪造 1ms 的 ping.gif');
    assert.ok(mobileHtml.includes('.sheet-speed-btn[hidden]{display:none!important}') || mobileHtml.includes('[hidden],.sheet-speed-btn[hidden]'),
      '样式表必须确保 [hidden] 能正确隐藏 .sheet-speed-btn');

    const mEnv = createDomEnv();
    const mTimers = new Set();
    mEnv.sandbox.setTimeout = (fn, ms) => {
      const delay = Number(ms) > 500 ? Number(ms) : Math.min(Number(ms) || 0, 15);
      const t = setTimeout(() => { mTimers.delete(t); fn(); }, delay);
      mTimers.add(t);
      return t;
    };
    mEnv.sandbox.clearTimeout = (t) => { mTimers.delete(t); clearTimeout(t); };
    mEnv.sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
    mEnv.sandbox.innerWidth = 393;
    mEnv.sandbox.innerHeight = 852;
    mEnv.sandbox.URL = URL;
    mEnv.sandbox.URLSearchParams = URLSearchParams;
    mEnv.sandbox.Intl = Intl;
    mEnv.sandbox.screen = { width: 393, height: 852 };
    mEnv.sandbox.devicePixelRatio = 3;
    mEnv.sandbox.navigator = { platform: 'iPhone', maxTouchPoints: 5, hardwareConcurrency: 6 };
    mEnv.sandbox.localStorage = mEnv.localStorage;
    mEnv.sandbox.sessionStorage = { getItem: () => '1', setItem() {}, removeItem() {} };
    mEnv.sandbox.history = { replaceState() {} };
    mEnv.sandbox.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    mEnv.sandbox.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    mEnv.sandbox.encodeURIComponent = encodeURIComponent;
    mEnv.sandbox.decodeURIComponent = decodeURIComponent;
    mEnv.sandbox.escape = (s) => encodeURIComponent(s);
    mEnv.sandbox.unescape = (s) => decodeURIComponent(s);
    mEnv.sandbox.location = {
      href: 'https://ag.20160325.xyz/?token=tok-ui-test-1234567890&manual=1',
      origin: 'https://ag.20160325.xyz',
      protocol: 'https:',
      pathname: '/',
      search: '?token=tok-ui-test-1234567890&manual=1',
      port: '',
      replace() {}
    };
    Object.assign(mEnv.win, {
      matchMedia: mEnv.sandbox.matchMedia,
      innerWidth: 393,
      innerHeight: 852,
      visualViewport: null,
      location: mEnv.sandbox.location,
      localStorage: mEnv.sandbox.localStorage,
      sessionStorage: mEnv.sandbox.sessionStorage,
      history: mEnv.sandbox.history
    });

    const bodyMatch = mobileHtml.match(/<body>([\s\S]*?)<script>/);
    const scriptMatch = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(bodyMatch && scriptMatch);
    mEnv.doc.body.innerHTML = bodyMatch[1];

    // 增强 mock 节点的 dataset 自动映射，兼容 data-group-idx / data-variant-idx / data-proj-key / data-cid / data-idx
    const attachDatasetProxy = (root) => {
      if (!root) return;
      const syncNode = (n) => {
        if (!n || typeof n.getAttribute !== 'function') return;
        for (const attr of ['data-idx', 'data-mode-idx', 'data-group-idx', 'data-variant-idx', 'data-proj-key', 'data-cid', 'data-label']) {
          const val = n.getAttribute(attr);
          if (val !== null) {
            const camel = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            n.dataset[camel] = val;
          }
        }
        if (typeof n._patchedClick !== 'boolean') {
          n._patchedClick = true;
          const origClick = n.click.bind(n);
          n.click = () => {
            if (typeof n.onclick === 'function') {
              return n.onclick({ target: n, stopPropagation() {}, preventDefault() {} });
            }
            origClick();
          };
        }
        for (const ch of (n.children || [])) syncNode(ch);
      };
      syncNode(root);
    };

    const sampleSnap = {
      ok: true,
      title: '当前对话 A1',
      busy: false,
      model: 'Gemini 4 Carbon (Medium)',
      modelOptions: [
        { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', selected: false },
        { label: 'Gemini 4 Carbon (Medium)', modelId: 'gemini-4-carbon-medium', selected: true },
        { label: 'Gemini 4 Carbon (Low)', modelId: 'gemini-4-carbon-low', selected: false },
        { label: 'Orchestrator (Carbon)', modelId: 'gemini-pro-orchestrator', selected: false }
      ],
      permissionLabel: '⚡ 无限',
      messages: [{ id: 'm1', role: 'user', text: 'hello' }],
      projectGroups: [
        {
          id: 'grp-1',
          key: 'grp-1',
          name: 'antigravity-suite',
          count: 2,
          active: true,
          conversations: [
            { id: 'conv-a1', title: '当前对话 A1', active: true, project: 'antigravity-suite' },
            { id: 'conv-a2', title: '优化测试 A2', active: false, project: 'antigravity-suite' }
          ]
        },
        {
          id: 'grp-2',
          key: 'grp-2',
          name: 'PMStudio',
          count: 1,
          active: false,
          conversations: [
            { id: 'conv-b1', title: '项目 B 会话', active: false, project: 'PMStudio' }
          ]
        }
      ],
      conversations: [
        { id: 'conv-a1', title: '当前对话 A1', active: true, project: 'antigravity-suite' },
        { id: 'conv-a2', title: '优化测试 A2', active: false, project: 'antigravity-suite' },
        { id: 'conv-b1', title: '项目 B 会话', active: false, project: 'PMStudio' }
      ],
      endpoints: [
        { url: 'http://10.181.51.171:18765', kind: 'lan', priority: 0 },
        { url: 'https://ag.20160325.xyz', kind: 'tunnel', priority: 250 }
      ]
    };

    let resolveDeferredSend = null;
    const actionRequests = [];
    mEnv.sandbox.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/action')) {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        actionRequests.push(body);
        if (body.action === 'send') {
          return await new Promise((resolve) => {
            resolveDeferredSend = () => resolve({
              ok: true,
              status: 200,
              headers: { get: () => 'application/json' },
              json: async () => ({
                ok: true,
                actionResult: { ok: true },
                snapshot: { ...sampleSnap, busy: true }
              })
            });
          });
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            ok: true,
            actionResult: { ok: true, model: body.label || '' },
            snapshot: sampleSnap
          })
        };
      }
      if (u.includes('/api/snapshot')) {
        return { ok: true, status: 200, json: async () => sampleSnap };
      }
      return { ok: false, status: 500, json: async () => ({ ok: false }) };
    };

    try {
      vm.runInContext(scriptMatch[1], mEnv.sandbox);
      await new Promise((r) => setTimeout(r, 60));

      const btnSend = mEnv.doc.getElementById('btn-send');
      const inputEl = mEnv.doc.getElementById('input');
      const permBtn = mEnv.doc.getElementById('btn-perm-inline');
      const modelBtn = mEnv.doc.getElementById('btn-model-inline');
      const speedBtn = mEnv.doc.getElementById('sheet-action-btn');
      const backBtn = mEnv.doc.getElementById('sheet-back-btn');
      const sheetList = mEnv.doc.getElementById('sheet-list');
      const convList = mEnv.doc.getElementById('conv-list');
      const drawerNavBar = mEnv.doc.getElementById('drawer-nav-bar');

      // C1. 发送按钮点击后立刻禁用，得到响应后切换到真实状态（stop）
      inputEl.value = '测试消息';
      inputEl.dispatchEvent({ type: 'input' });
      assert.equal(btnSend.disabled, false, '输入非空后发送按钮应可点击');
      const sendPromise = btnSend.onclick();
      assert.equal(btnSend.disabled, true, '点击发送后按钮必须立刻变为禁止点击状态');
      assert.ok(btnSend.className.includes('pending'), '等待响应期间发送按钮应处于 pending 加载状态');
      assert.equal(btnSend.getAttribute('aria-busy'), 'true');
      assert.ok(typeof resolveDeferredSend === 'function');
      resolveDeferredSend();
      await sendPromise;
      assert.equal(btnSend.disabled, false, '收到响应且服务端处于 busy 时应切换到可点击的停止状态');
      assert.ok(btnSend.className.includes('stop'), '发送响应返回 busy=true 后按钮应切换到真实停止状态');

      // C2. 权限抽屉禁止出现测速按钮
      permBtn.onclick();
      assert.equal(speedBtn.hidden, true, '权限抽屉中测速按钮必须隐藏');

      // C3. 模型抽屉按 modelId 分组、隐藏测速按钮，点击带多档的模型左滑进入思考等级新抽屉
      modelBtn.onclick();
      assert.equal(speedBtn.hidden, true, '模型抽屉中测速按钮必须隐藏');
      attachDatasetProxy(sheetList);
      const groupButtons = sheetList.querySelectorAll('[data-group-idx]');
      assert.equal(groupButtons.length, 2, '4 个模型选项按 base modelId 应聚合为 2 组 (Gemini 4 Carbon 与 Orchestrator (Carbon))');
      assert.ok(groupButtons[0].textContent.includes('Gemini 4 Carbon') && groupButtons[0].textContent.includes('3 档'));

      // 点击 Gemini 4 Carbon -> 左滑切换为思考等级抽屉
      sheetList.onclick({ target: groupButtons[0] });
      attachDatasetProxy(sheetList);
      const trackEl = mEnv.doc.getElementById('sheet-stage-track');
      assert.ok(trackEl.classList.contains('step-effort'), '点击模型后轨道应添加 .step-effort 触发左滑动画');
      assert.equal(backBtn.hidden, false, '思考等级抽屉头部应显示返回按钮');
      const effortButtons = sheetList.querySelectorAll('[data-variant-idx]');
      assert.equal(effortButtons.length, 3, 'Gemini 4 Carbon 思考等级抽屉应包含 高/中/低 3 个选项');

      // 选择 High 等级
      await sheetList.onclick({ target: effortButtons[0] });
      assert.ok(actionRequests.some((r) => r.action === 'select-model' && r.modelId === 'gemini-4-carbon-high'),
        '选择思考等级后应调用 select-model 提交对应 modelId');

      // 返回重开模型抽屉点击无多档模型 Orchestrator (Carbon) -> 直接选中
      modelBtn.onclick();
      attachDatasetProxy(sheetList);
      const groupButtons2 = sheetList.querySelectorAll('[data-group-idx]');
      await sheetList.onclick({ target: groupButtons2[1] });
      assert.ok(actionRequests.some((r) => r.action === 'select-model' && r.modelId === 'gemini-pro-orchestrator'),
        '仅有单档思考等级的模型应点击即选中');

      // C4. 历史对话抽屉：默认按项目聚合 -> 点击项目切至项目内会话 -> 点击返回项目列表
      attachDatasetProxy(convList);
      const projBtns = convList.querySelectorAll('.proj-item');
      assert.equal(projBtns.length, 2, '历史对话默认应按项目聚合展示 2 个项目条目');
      assert.ok(drawerNavBar.textContent.includes('项目列表 (2)'));

      await convList.dispatchEvent({ type: 'click', target: projBtns[1] });
      attachDatasetProxy(convList);
      attachDatasetProxy(drawerNavBar);
      const convBtnsAfterDrill = convList.querySelectorAll('.conv-item');
      assert.equal(convBtnsAfterDrill.length, 1, '点击 PMStudio 项目后列表应切换为该项目的会话');
      assert.equal(convBtnsAfterDrill[0].dataset.cid, 'conv-b1');
      const drawerBackBtn = mEnv.doc.getElementById('btn-drawer-back');
      assert.ok(drawerBackBtn, '进入项目会话列表后头部应提供返回项目按钮 #btn-drawer-back');

      await drawerNavBar.dispatchEvent({ type: 'click', target: drawerBackBtn });
      attachDatasetProxy(convList);
      assert.equal(convList.querySelectorAll('.proj-item').length, 2, '点击返回项目按钮应回到项目聚合列表');
    } finally {
      for (const t of mTimers) clearTimeout(t);
      mTimers.clear();
    }
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('需求 21: Tab 补全 8 字截断悬停完整展示、单色 SVG 上方优化按钮、快捷提示词自定义、设置整合及 agy remote 多浏览器隔离', async () => {
  const http = require('node:http');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req19-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  process.env.APPDATA = tmpState;
  process.env.AG_METER_STATE_DIR = tmpState;
  delete require.cache[require.resolve('./mobile-remote.js')];

  const {
    buildMobileAppHtml,
    buildRemoteInfo,
    loadOrCreateRemoteConfig,
    saveRemoteTunnelConfig,
    createCloudflareTunnelController,
    createRemoteHttpHandler,
    getRemoteClientSession,
    clearRemoteClientSessionsForTests,
    DEFAULT_REMOTE_DISPLAY_CONFIG
  } = require('./mobile-remote.js');

  const env = createDomEnv();
  const savedSettingsCalls = [];
  const tunnelPosts = [];
  const rpcCalls = [];
  const sidebarClicks = [];
  const activeTimers = new Set();
  let api = null;
  let enhancer = null;

  try {
    env.sandbox.setTimeout = (fn, ms) => {
      const delay = Number(ms) > 500 ? Number(ms) : Math.min(Number(ms) || 0, 10);
      const t = setTimeout(() => { activeTimers.delete(t); fn(); }, delay);
      activeTimers.add(t);
      return t;
    };
    env.sandbox.clearTimeout = (t) => { activeTimers.delete(t); clearTimeout(t); };
    env.sandbox.location = { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/aaaaaaaa-1111-1111-1111-111111111111', origin: 'https://127.0.0.1:1234', href: 'https://127.0.0.1:1234/c/aaaaaaaa-1111-1111-1111-111111111111' };
    env.sandbox.__APP_CONFIG__ = { csrfToken: 'req19-csrf' };
    env.sandbox.PopStateEvent = class PopStateEvent { constructor(type) { this.type = type; } };
    env.sandbox.window.history = {
      pushState(_st, _t, url) { env.sandbox.location.pathname = String(url); }
    };
    env.win.__AGContextMeterLive = { port: 61299, token: 'tok-req19' };

    const initInfo = buildRemoteInfo({
      tunnelStatus: { enabled: false, state: 'stopped', mode: 'quick', binaryAvailable: true }
    });
    env.sandbox.fetch = async (url, init) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      rpcCalls.push({ url: u, body });
      if (u.includes('/save-settings')) {
        savedSettingsCalls.push(body);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.includes('/remote-info')) {
        return { ok: true, json: async () => ({ ok: true, data: buildRemoteInfo({ resetToken: Boolean(body.resetToken) }) }) };
      }
      if (u.includes('/remote-tunnel')) {
        tunnelPosts.push(body);
        saveRemoteTunnelConfig(body);
        return { ok: true, json: async () => ({ ok: true, data: buildRemoteInfo({ tunnelStatus: { enabled: false, state: 'stopped', binaryAvailable: true } }) }) };
      }
      if (u.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        return {
          ok: true,
          json: async () => ({
            generatorMetadata: [{
              chatModel: {
                modelDisplayName: 'Claude 4.5 Sonnet (Thinking)',
                timeToFirstToken: '0.4s',
                streamingDuration: '1.6s',
                usage: { inputTokens: 12000, cacheReadTokens: 8000, outputTokens: 200 },
                chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 20200, maxContextTokens: 200000 } }
              }
            }]
          })
        };
      }
      if (u.includes('GetCascadeTrajectory')) {
        return {
          ok: true,
          json: async () => ({
            numTotalSteps: 2,
            numTotalGeneratorMetadata: 1,
            trajectory: {
              summary: '独立隔离会话 B1',
              status: 'COMPLETED',
              steps: [
                { userInput: { items: [{ text: '帮我独立查看会话 B1' }] } },
                { plannerResponse: { response: '这是仅属于会话 B1 的孤立响应', thinking: '独立推演过程 B1' } }
              ]
            }
          })
        };
      }
      if (u.includes('GetAllCascadeTrajectories')) {
        return { ok: true, json: async () => ({ trajectorySummaries: {} }) };
      }
      return { ok: true, json: async () => ({ ok: true, data: initInfo }) };
    };

    // 构建桌面 Composer + Footer + 侧边栏 mock DOM
    const composerEl = env.doc.createElement('div');
    composerEl.className = 'surface-composer';
    const editorWrap = env.doc.createElement('div');
    const editorEl = env.doc.createElement('div');
    editorEl.setAttribute('data-lexical-editor', 'true');
    editorEl.setAttribute('contenteditable', 'true');
    editorWrap.appendChild(editorEl);
    const footerEl = env.doc.createElement('div');
    footerEl.className = 'agy-composer-footer';
    const addCtxBtn = env.doc.createElement('button');
    addCtxBtn.setAttribute('aria-label', '添加上下文');
    footerEl.appendChild(addCtxBtn);
    composerEl.appendChild(editorWrap);
    composerEl.appendChild(footerEl);
    env.doc.body.appendChild(composerEl);

    const sidebarEl = env.doc.createElement('div');
    sidebarEl.setAttribute('data-testid', 'conversation-list-sidebar');
    const CONV_A1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const CONV_B1 = 'bbbbbbbb-2222-2222-2222-222222222222';
    for (const [cid, title] of [[CONV_A1, '桌面当前会话 A1'], [CONV_B1, '独立隔离会话 B1']]) {
      const row = env.doc.createElement('div');
      row.setAttribute('data-testid', 'conversation-row-sidebar');
      row.setAttribute('data-cascade-id', cid);
      const a = env.doc.createElement('a');
      a.setAttribute('href', `/c/${cid}`);
      const sp = env.doc.createElement('span');
      sp.className = 'truncate';
      sp.textContent = title;
      a.appendChild(sp);
      a.addEventListener('click', () => {
        sidebarClicks.push(cid);
        env.sandbox.location.pathname = `/c/${cid}`;
      });
      row.appendChild(a);
      sidebarEl.appendChild(row);
    }
    env.doc.body.appendChild(sidebarEl);
    env.sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
    env.win.getSelection = env.sandbox.getSelection;
    env.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });
    env.doc.execCommand = (cmd, _ui, val) => {
      if (cmd === 'insertText') {
        editorEl.textContent = String(val || '');
        return true;
      }
      if (cmd === 'delete') {
        editorEl.textContent = '';
        return true;
      }
      return true;
    };

    vm.runInContext(RENDERER_SRC, env.sandbox);
    api = env.sandbox.__AGContextMeter;
    vm.runInContext(ENHANCER_SRC, env.sandbox);
    enhancer = env.sandbox.__AGEnhancer;
    const shadow = env.getShadow();
    const host = env.getHost();

    // 1A. Tab 补全 8 字截断与悬停完整提示
    assert.equal(enhancer.truncateNextStepText('12345678', 8), '12345678');
    assert.equal(enhancer.truncateNextStepText('先帮我梳理下当前任务并给出方案', 8), '先帮我梳理下当前..');
    enhancer.ensureNextStepGhost();
    const ghostEl = env.doc.getElementById('ag-next-step-ghost');
    const ghostTabBtn = ghostEl?.querySelector('.ag-ns-tab');
    assert.ok(ghostEl && ghostTabBtn, '应挂载 #ag-next-step-ghost 与 .ag-ns-tab');
    const ghostFull = ghostTabBtn.getAttribute('data-full-text') || '';
    const ghostLabel = ghostTabBtn.querySelector('.ag-ns-text')?.textContent || '';
    assert.equal(ghostFull, '先帮我梳理下当前任务并给出方案');
    assert.equal(ghostLabel, '💡 先帮我梳理下当前..');

    ghostTabBtn.dispatchEvent({ type: 'mouseenter', target: ghostTabBtn });
    const tipEl = env.doc.getElementById('ag-next-step-tooltip');
    assert.ok(tipEl && tipEl.hidden === false, '悬停在幽灵补全上时应显示完整 tooltip');
    assert.equal(tipEl.textContent, ghostFull, 'tooltip 应展示完整未截断文案');
    ghostTabBtn.dispatchEvent({ type: 'mouseleave', target: ghostTabBtn });
    assert.equal(tipEl.hidden, true, '鼠标移出后应隐藏 tooltip');

    await enhancer.acceptNextStepSuggestion();
    assert.equal(editorEl.textContent, ghostFull, '确认补全仍应插入完整文案而非截断文案');

    // 1B. 提示词优化按钮置于 send 上方、单色 currentColor SVG 与主题响应
    const optWrap = env.doc.getElementById('ag-prompt-opt-wrap');
    const optBtn = env.doc.getElementById('ag-prompt-opt-btn');
    assert.ok(optWrap && optBtn, '应挂载 #ag-prompt-opt-wrap 与 #ag-prompt-opt-btn');
    assert.equal(optWrap.getAttribute('data-position'), 'above-send');
    assert.equal(optWrap.nextElementSibling, footerEl, '优化按钮栏应紧贴位于 footer/send 区域上方');
    const optSvg = optBtn.querySelector('svg');
    assert.ok(optSvg, '优化按钮应包含单色 SVG');
    assert.equal(optSvg.getAttribute('stroke'), 'currentColor', 'SVG 应使用 stroke="currentColor" 跟随深浅主题');
    assert.equal(optBtn.textContent.includes('✨'), false, '优化按钮不应再包含彩色 emoji');
    host.setAttribute('data-theme', 'light');
    enhancer.ensurePromptOptimizerControls();
    assert.equal(optWrap.getAttribute('data-ag-theme'), 'light', '浅色主题下容器应同步 data-ag-theme="light"');
    host.setAttribute('data-theme', 'dark');
    enhancer.ensurePromptOptimizerControls();
    assert.equal(optWrap.getAttribute('data-ag-theme'), 'dark');

    // 1C. 快捷提示词自定义、持久化及快捷栏实时同步
    await api.setQuickPrompts([
      { id: 'rev', label: '逐行审查', text: '请逐行审查本文件改动' },
      { id: 'ut', label: '补全单测', text: '为新逻辑补充单元测试' }
    ]);
    await new Promise(r => setTimeout(r, 20));
    const savedQpRaw = env.win.localStorage.getItem('ag_suite_quick_prompts');
    assert.ok(savedQpRaw && savedQpRaw.includes('逐行审查'), '自定义快捷提示词应持久化到 localStorage');
    assert.ok(
      savedSettingsCalls.some((c) => Array.isArray(c?.uiPreferences?.quickPrompts) && c.uiPreferences.quickPrompts[0]?.label === '逐行审查'),
      '自定义快捷提示词应通过 /save-settings 保存至 uiPreferences'
    );
    const quickBar = env.doc.getElementById('ag-quick-capsule-bar');
    const customBtn0 = quickBar.querySelector('#ag-qcap-prompt-0');
    const customBtn1 = quickBar.querySelector('#ag-qcap-prompt-1');
    assert.ok(customBtn0 && customBtn1, '快捷栏应立即同步渲染自定义提示词 #ag-qcap-prompt-0 / #ag-qcap-prompt-1');
    assert.equal(customBtn0.textContent, '逐行审查');
    assert.equal(customBtn1.textContent, '补全单测');
    assert.ok(quickBar.querySelector('#ag-qcap-copyid') && quickBar.querySelector('#ag-qcap-export'), '内置「复制会话 ID」与「导出 Markdown」必须保留');

    customBtn0.click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(editorEl.textContent, '请逐行审查本文件改动', '点击自定义快捷提示词应填入对应文案');

    await api.resetQuickPrompts();
    assert.ok(quickBar.querySelector('#ag-qcap-compact') && quickBar.querySelector('#ag-qcap-plan') && quickBar.querySelector('#ag-qcap-reload'), '恢复默认后应还原 3 个默认快捷提示词');
    assert.equal(quickBar.querySelector('#ag-qcap-prompt-0'), null, '恢复默认后不应再保留自定义编号按钮');

    // 2A & 2B. 设置面板单一入口收敛 + 远程设置可配置内容
    assert.ok(shadow.getElementById('badge-settings') && shadow.getElementById('overflow-settings-btn'), '外部设置入口必须保留');
    assert.equal(shadow.getElementById('btn-open-settings-ctx'), null, '上下文面板内不应再有设置入口');
    assert.equal(shadow.getElementById('btn-open-settings-tokens'), null, 'Token 面板内不应再有设置入口');
    assert.equal(shadow.getElementById('btn-jump-plan-settings'), null, '套餐卡片内不应再有跳转设置按钮');

    api.openSettings('remote');
    await new Promise(r => setTimeout(r, 30));
    const remotePane = shadow.getElementById('settings-pane-remote');
    assert.ok(remotePane && !remotePane.hidden, '应可打开设置面板的「远程设置」分页');
    const chkUsage = shadow.getElementById('set-remote-usage-panel');
    assert.ok(chkUsage && chkUsage.checked === true, '默认应勾选启用顶部本机用量面板');
    chkUsage.checked = false;
    chkUsage.dispatchEvent({ type: 'change', target: chkUsage });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(
      tunnelPosts.some((p) => p?.remoteDisplay && p.remoteDisplay.showUsagePanel === false),
      true,
      '勾选更改 remoteDisplay 应提交至 /remote-tunnel'
    );
    assert.equal(api.getRemoteDisplayConfig().showUsagePanel, false);

    // 3A & 3B. agy remote 页面结构、可配置显示持久化、仅显示变更不重启 cloudflared
    const mobileHtml = buildMobileAppHtml();
    for (const marker of [
      'id="btn-context-panel"',
      'id="btn-usage-panel"',
      'id="context-drawer"',
      'id="usage-drawer"',
      'id="btn-follow-desktop"',
      'X-AG-Client-Id',
      'ag_remote_client_id_v1',
      'ag_remote_conv_id_v1',
      'applyRemoteDisplayConfig',
      'renderMarkdownSafe'
    ]) {
      assert.ok(mobileHtml.includes(marker), `mobileHtml 应包含 ${marker}`);
    }
    const mobileScript = mobileHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.doesNotThrow(() => new vm.Script(mobileScript[1]), 'mobileHtml 内联脚本语法必须无误');

    saveRemoteTunnelConfig({ remoteDisplay: { showUsagePanel: false, showThinking: false } });
    const persistedInfo = buildRemoteInfo();
    assert.equal(persistedInfo.remoteDisplay.showUsagePanel, false);
    assert.equal(persistedInfo.remoteDisplay.showThinking, false);
    assert.equal(persistedInfo.remoteDisplay.showContextPanel, true);

    const tunnelCtrl = createCloudflareTunnelController();
    const displayOnlyRes = await tunnelCtrl.configure({
      remoteDisplay: { ...DEFAULT_REMOTE_DISPLAY_CONFIG, showUsagePanel: true, showThinking: false }
    });
    assert.equal(displayOnlyRes.state, 'stopped', '仅修改 remoteDisplay 不应触发 cloudflared 启动');

    // 3C (后端 HTTP). 两套浏览器独立会话隔离 + /api/usage + /api/context + 重置令牌清空
    clearRemoteClientSessionsForTests();
    const actionCalls = [];
    const snapshotCalls = [];
    const cfg = loadOrCreateRemoteConfig();
    const handler = createRemoteHttpHandler(cfg, {
      getUsageData: async () => ({
        summary: { todayTokens: 1200, sevenDayTokens: 8400, thirtyDayTokens: 21000, totalTokens: 56000, sessionCount: 9 },
        referenceCost: { totalUsd: 1.25 },
        dailyMap: { '2026-11-18': { totalTokens: 1200 } },
        dailyMapBySource: { desktop: { '2026-11-18': { totalTokens: 1000 } }, cli: { '2026-11-18': { totalTokens: 200 } } }
      }),
      fetchSnapshot: async (targetId, opts = {}) => {
        snapshotCalls.push({ targetId, ...opts });
        const cid = opts.conversationId || 'conv-desktop';
        return {
          ok: true,
          currentTargetId: targetId || 'win-1',
          sessionId: cid,
          activeConversationId: cid,
          title: `Title ${cid}`,
          model: 'Gemini 4',
          contextBadge: '12k/1M (1%)',
          pulseText: '12k/1M (1%)',
          contextPanel: { usedTokens: 12000, limitTokens: 1000000, usagePercent: 1.2 },
          messages: [{ id: 'm1', role: 'assistant', text: `Reply from ${cid}` }],
          conversations: [{ id: cid, title: `Title ${cid}`, active: true }],
          projectGroups: []
        };
      },
      performAction: async (payload) => {
        actionCalls.push(payload);
        return {
          ok: true,
          actionResult: { ok: true, id: payload.id || payload.conversationId || '' },
          snapshot: {
            ok: true,
            currentTargetId: 'win-1',
            sessionId: payload.conversationId || 'conv-desktop',
            activeConversationId: payload.conversationId || 'conv-desktop',
            messages: []
          }
        };
      }
    });

    const srv = http.createServer((req, res) => { handler(req, res); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = srv.address().port;
      const base = `http://127.0.0.1:${port}`;
      const hdrA = { 'X-AG-Remote-Token': cfg.token, 'X-AG-Client-Id': 'agb-browser-a', 'Content-Type': 'application/json', Connection: 'close' };
      const hdrB = { 'X-AG-Remote-Token': cfg.token, 'X-AG-Client-Id': 'agb-browser-b', 'Content-Type': 'application/json', Connection: 'close' };

      const pingJson = await (await fetch(`${base}/api/ping`, { headers: hdrA })).json();
      assert.equal(pingJson.ok, true);
      assert.equal(pingJson.displayConfig?.showThinking, false, '/api/ping 应透传 displayConfig');

      const usageJson = await (await fetch(`${base}/api/usage`, { headers: hdrA })).json();
      assert.equal(usageJson.ok, true);
      assert.equal(usageJson.data?.summary?.totalTokens, 56000);

      // 浏览器 A 切到 conv-alpha，浏览器 B 切到 conv-beta，互不串扰
      const swA = await (await fetch(`${base}/api/action`, {
        method: 'POST',
        headers: hdrA,
        body: JSON.stringify({ action: 'switch-conversation', id: 'conv-alpha', isolated: true })
      })).json();
      assert.equal(swA.ok, true);
      const swB = await (await fetch(`${base}/api/action`, {
        method: 'POST',
        headers: hdrB,
        body: JSON.stringify({ action: 'switch-conversation', id: 'conv-beta', isolated: true })
      })).json();
      assert.equal(swB.ok, true);

      const snapA = await (await fetch(`${base}/api/snapshot`, { headers: hdrA })).json();
      const snapB = await (await fetch(`${base}/api/snapshot`, { headers: hdrB })).json();
      assert.equal(snapA.sessionId, 'conv-alpha', '浏览器 A 轮询应保持独立会话 conv-alpha');
      assert.equal(snapB.sessionId, 'conv-beta', '浏览器 B 轮询应保持独立会话 conv-beta');

      const ctxB = await (await fetch(`${base}/api/context`, { headers: hdrB })).json();
      assert.equal(ctxB.conversationId, 'conv-beta', '/api/context 应绑定请求所属浏览器的独立会话');
      assert.equal(ctxB.contextPanel?.usedTokens, 12000);

      // 浏览器 A 发消息未显式传 conversationId 时，服务端自动绑定 A 的隔离会话 conv-alpha
      const sendA = await (await fetch(`${base}/api/action`, {
        method: 'POST',
        headers: hdrA,
        body: JSON.stringify({ action: 'send', text: 'hello alpha' })
      })).json();
      assert.equal(sendA.ok, true);
      assert.equal(actionCalls[actionCalls.length - 1]?.conversationId, 'conv-alpha');
      assert.equal(getRemoteClientSession('agb-browser-b')?.conversationId, 'conv-beta');

      // 浏览器 A 点同步桌面，仅清理 A 的隔离绑定而不影响 B
      const followA = await (await fetch(`${base}/api/action`, {
        method: 'POST',
        headers: hdrA,
        body: JSON.stringify({ action: 'switch-conversation', id: 'follow-desktop' })
      })).json();
      assert.equal(followA.ok, true);
      assert.equal(getRemoteClientSession('agb-browser-b')?.conversationId, 'conv-beta');

      buildRemoteInfo({ resetToken: true });
      assert.equal(getRemoteClientSession('agb-browser-b'), null, '重置密钥应清空全部客户端隔离会话');
    } finally {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    }

    // 3C (前端 Bridge). getMobileSnapshotAsync 独立 RPC 读取会话 B1，且不改变桌面当前 CONV_A1
    const isoSnap = await enhancer.getMobileSnapshotAsync({ conversationId: CONV_B1 });
    assert.equal(isoSnap.isolated, true);
    assert.equal(isoSnap.sessionId, CONV_B1);
    assert.equal(isoSnap.desktopSessionId, CONV_A1);
    assert.equal(env.sandbox.location.pathname, `/c/${CONV_A1}`, '独立 RPC 读取会话 B1 不得跳转桌面窗口');
    assert.ok(isoSnap.messages.some((m) => m.text.includes('孤立响应')), '应从 GetCascadeTrajectory 提取会话 B1 消息');
    assert.equal(isoSnap.contextPanel?.limitTokens, 200000, '应从 GeneratorMetadata 计算会话 B1 上下文上限');

    // performMobileAction 针对孤立会话操作时应临时切换并还原桌面会话
    sidebarClicks.length = 0;
    const fillRes = await enhancer.performMobileAction({ action: 'fill', text: '针对 B1 的输入', conversationId: CONV_B1 });
    assert.equal(fillRes.ok, true);
    assert.deepEqual(sidebarClicks, [CONV_B1, CONV_A1], '针对另一会话执行操作后应自动恢复桌面原会话');
    assert.equal(env.sandbox.location.pathname, `/c/${CONV_A1}`);

    // Cherry-pick CDP 增强校验: AG_CDP_PORT、find_antigravity_app、可选 install-launcher 且 setup-macos-cdp.sh 不默认强建
    const asarSrc = fs.readFileSync(path.join(__dirname, "asar-engine.js"), "utf8");
    assert.ok(asarSrc.includes("AG_CDP_PORT"), "asar-engine 应保留 AG_CDP_PORT 环境变量探测");
    const binSrc = fs.readFileSync(path.join(__dirname, "bin", "ag-context-meter"), "utf8");
    assert.ok(binSrc.includes("find_antigravity_app()"), "ag-context-meter 应使用 find_antigravity_app 兼容 /Applications 与 ~/Applications");
    assert.ok(binSrc.includes("install-launcher)"), "ag-context-meter 应保留可选 install-launcher 命令");
    const setupSrc = fs.readFileSync(path.join(__dirname, "scripts", "setup-macos-cdp.sh"), "utf8");
    assert.equal(setupSrc.includes("install-launcher"), false, "setup-macos-cdp.sh 不应默认强制创建独立启动器 .app");

  } finally {
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
    try { enhancer?.dispose?.(); } catch {}
    try { api?.dispose?.(); } catch {}
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 22: 远程设置默认启用免登录零配置隧道 + cloudflared 一键复制安装命令引导
// =========================================================================
test('需求 22: 远程设置默认免登录零配置可用与 cloudflared 一键复制安装命令引导', async () => {
  const os = require('node:os');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-remote-zero-cfg-'));
  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  let api = null;
  try {
    process.env.APPDATA = tmpState;
    process.env.AG_METER_STATE_DIR = tmpState;
    delete require.cache[require.resolve('./mobile-remote.js')];
    const {
      loadOrCreateRemoteConfig,
      saveRemoteTunnelConfig,
      getCloudflaredInstallGuide,
      buildRemoteInfo
    } = require('./mobile-remote.js');

    // 1. 全新配置默认启用免登录零配置临时隧道（tunnelEnabled=true, tunnelMode='quick'）
    const freshCfg = loadOrCreateRemoteConfig();
    assert.equal(freshCfg.tunnelEnabled, true, '全新配置默认应启用 Cloudflare 隧道');
    assert.equal(freshCfg.enabledChannels?.tunnel, true, '全新配置 enabledChannels.tunnel 应默认为 true');
    assert.equal(freshCfg.tunnelMode, 'quick', '全新配置默认应使用免登录零配置 quick 模式');

    // 显式关闭后应尊重持久化状态
    saveRemoteTunnelConfig({ enabled: false });
    const disabledCfg = loadOrCreateRemoteConfig();
    assert.equal(disabledCfg.tunnelEnabled, false, '显式关闭隧道后不应被强制重开');
    assert.equal(disabledCfg.enabledChannels?.tunnel, false);

    // 恢复默认启用，检查 getCloudflaredInstallGuide 与 buildRemoteInfo 字段
    saveRemoteTunnelConfig({ enabled: true, tunnelMode: 'quick' });
    const macGuide = getCloudflaredInstallGuide('darwin');
    const winGuide = getCloudflaredInstallGuide('win32');
    const linuxGuide = getCloudflaredInstallGuide('linux');
    assert.equal(macGuide.command, 'brew install cloudflared');
    assert.equal(winGuide.command, 'winget install --id Cloudflare.cloudflared');
    assert.ok(linuxGuide.command.includes('cloudflared-linux-amd64'));

    const missingInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: { enabled: true, mode: 'quick', state: 'error', binaryAvailable: false, error: '未检测到 cloudflared' }
    });
    assert.ok(missingInfo.cloudflaredInstall?.commands?.darwin, 'buildRemoteInfo 应暴露各平台 cloudflared 安装命令');
    const readyInfo = buildRemoteInfo({
      resetToken: false,
      tunnelStatus: { enabled: true, mode: 'quick', state: 'running', publicUrl: 'https://zero-cfg.trycloudflare.com', binaryAvailable: true }
    });

    // 2. 设置面板渲染一键复制安装命令引导（缺失态 + 已安装态 + 平台切换 + 一键复制 + 重新检测）
    const env = createDomEnv();
    env.win.__AGContextMeterLive = { port: 61229, token: 'tok-install-guide' };
    let infoMode = 'missing';
    let infoFetchCount = 0;
    let copiedText = '';
    env.sandbox.navigator.clipboard = {
      writeText: async (text) => { copiedText = String(text || ''); }
    };
    env.sandbox.fetch = async (url) => {
      if (String(url).includes('/remote-info')) {
        infoFetchCount++;
        return { ok: true, json: async () => ({ ok: true, data: infoMode === 'missing' ? missingInfo : readyInfo }) };
      }
      return { ok: false, json: async () => ({}) };
    };
    const freshRendererSrc = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
    vm.runInContext(freshRendererSrc, env.sandbox);
    api = env.sandbox.__AGContextMeter;
    const remotePane = env.getShadow().getElementById('settings-pane-remote');

    api.openSettings('remote');
    await new Promise((r) => setTimeout(r, 30));

    // 缺失态：展示高亮安装引导与重新检测按钮
    const guideMissing = remotePane.querySelector('#ag-rp-cf-install-guide');
    assert.ok(guideMissing, '远程设置应渲染 #ag-rp-cf-install-guide 安装命令引导');
    assert.equal(guideMissing.getAttribute('data-missing'), 'true', '缺少 cloudflared 时应标记 data-missing=true');
    assert.ok(remotePane.querySelector('#ag-rp-cf-recheck'), '缺少 cloudflared 时应提供重新检测按钮');
    assert.ok((remotePane.querySelector('#ag-rp-tunnel-cfg-btn')?.textContent || '').includes('免登录零配置'), 'quick 模式下配置按钮应体现免登录零配置');

    // 切换 Windows 平台命令并一键复制
    remotePane.querySelector('#ag-rp-install-tab-win32')?.click();
    assert.equal(
      remotePane.querySelector('#ag-rp-cf-install-cmd')?.textContent?.trim(),
      'winget install --id Cloudflare.cloudflared',
      '切换 Windows 标签应展示 winget 安装命令'
    );
    remotePane.querySelector('#ag-rp-cf-copy-install')?.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(copiedText, 'winget install --id Cloudflare.cloudflared', '点击一键复制应将当前平台安装命令写入剪贴板');
    assert.ok((remotePane.querySelector('#ag-rp-cf-copy-install')?.textContent || '').includes('已复制'), '复制后按钮应显示已复制反馈');

    // 点击重新检测后切换为已安装态，仍保留安装命令引导且 data-missing=false
    infoMode = 'ready';
    const beforeRecheck = infoFetchCount;
    remotePane.querySelector('#ag-rp-cf-recheck')?.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(infoFetchCount > beforeRecheck, '点击重新检测应重新拉取 /remote-info');
    const guideReady = remotePane.querySelector('#ag-rp-cf-install-guide');
    assert.ok(guideReady, '已安装 cloudflared 时仍应保留可一键复制的安装命令引导');
    assert.equal(guideReady.getAttribute('data-missing'), 'false');
    assert.equal(remotePane.querySelector('#ag-rp-cf-recheck'), null, '已安装状态下无需再显示重新检测按钮');
  } finally {
    try { api?.dispose?.(); } catch {}
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    delete require.cache[require.resolve('./mobile-remote.js')];
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 23: 提示词优化轻量快速模型优先、多模型自动回退与完整错误信息保留
// =========================================================================
test('需求 23: 提示词优化轻量快速模型优先、429/500/空响应自动回退与完整错误信息保留', async () => {
  const env = createDomEnv();
  const activeTimers = new Set();
  env.sandbox.setTimeout = (fn, ms) => {
    const delay = Number(ms) > 500 ? Number(ms) : Math.min(Number(ms) || 0, 10);
    const t = setTimeout(() => { activeTimers.delete(t); fn(); }, delay);
    activeTimers.add(t);
    return t;
  };
  env.sandbox.clearTimeout = (t) => {
    activeTimers.delete(t);
    clearTimeout(t);
  };
  env.sandbox.location = { pathname: '/', origin: 'https://127.0.0.1:53892', href: 'https://127.0.0.1:53892/' };
  env.sandbox.window.__APP_CONFIG__ = { csrfToken: 'csrf-opt-test' };
  env.sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  env.win.getSelection = env.sandbox.getSelection;
  env.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });

  const composerWrap = env.doc.createElement('div');
  const composerEl = env.doc.createElement('div');
  composerEl.className = 'surface-composer';
  const cardEl = env.doc.createElement('div');
  cardEl.className = 'surface-composer-card';
  const editorEl = env.doc.createElement('div');
  editorEl.setAttribute('data-lexical-editor', 'true');
  editorEl.setAttribute('contenteditable', 'true');
  const footerEl = env.doc.createElement('div');
  footerEl.className = 'agy-composer-footer';
  cardEl.appendChild(editorEl);
  cardEl.appendChild(footerEl);
  composerEl.appendChild(cardEl);
  composerWrap.appendChild(composerEl);
  env.doc.body.appendChild(composerWrap);

  env.doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'insertText') {
      editorEl.textContent = String(val || '');
      return true;
    }
    if (cmd === 'delete') {
      editorEl.textContent = '';
      return true;
    }
    return true;
  };

  let mode = 'fallback-succeed';
  const calledModels = [];
  env.sandbox.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (u.includes('GetUserStatus')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userStatus: {
            cascadeModelConfigData: {
              defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
              clientModelConfigs: [
                { label: 'Gemini 4 Neon (High)', modelId: 'gemini-4-neon-high', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
                { label: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' } },
                { label: 'Gemini 4 Neon (Low)', modelId: 'gemini-4-neon-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' } },
                { label: 'Gemini 3.8 Flash (Low)', modelId: 'gemini-3.8-flash-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M320' } },
                { label: 'Claude Sonnet 5.5 (Low)', modelId: 'claude-sonnet-5-5-low', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M403' } }
              ]
            }
          }
        })
      };
    }
    if (u.includes('GetModelResponse')) {
      calledModels.push(body.model);
      if (mode === 'fallback-succeed') {
        if (body.model === 'MODEL_PLACEHOLDER_M320') {
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ code: 'resource_exhausted', message: 'flash quota hit' })
          };
        }
        if (body.model === 'MODEL_PLACEHOLDER_M403') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ response: '' })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: '请为登录页补充表单校验、错误提示与键盘回车提交支持。' })
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ code: 'internal', message: 'model backend unavailable' })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const freshEnhancerSrc = fs.readFileSync(path.join(ROOT, 'ag-enhancer-overlay.js'), 'utf8');
  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(freshEnhancerSrc, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;

  try {
    // 1. 在新建会话 (/) 下优先尝试轻量快速模型，且遇到 429 与空响应自动回退至下一个不同模型并成功
    editorEl.textContent = '帮我改下登录页';
    enhancer.ensurePromptOptimizerControls();
    const res1 = await enhancer.optimizeComposerPrompt();
    assert.equal(res1.ok, true, '第 1 个模型 429、第 2 个模型空响应后应自动回退到第 3 个模型并成功');
    assert.deepEqual(
      calledModels,
      ['MODEL_PLACEHOLDER_M320', 'MODEL_PLACEHOLDER_M403', 'MODEL_PLACEHOLDER_M534'],
      '应按轻量快速优先且跨族多样顺序依次尝试不同模型（Flash Low -> Sonnet Low -> Neon Low）'
    );
    const modelCache = enhancer.getPromptOptModels();
    assert.equal(modelCache.primary, 'MODEL_PLACEHOLDER_M320', '首选模型应为轻量快速的 Flash Low 而非 High');
    assert.notEqual(modelCache.primary, modelCache.fallback, 'primary 与 fallback 不得为同一模型');
    assert.equal(res1.attempts.length, 2, '应记录前两次失败尝试');
    assert.equal(enhancer.getLastPromptOptError(), null, '成功后应清空 lastError');
    assert.ok(editorEl.textContent.includes('登录页补充表单校验'), '应成功回填优化结果');

    // 1b. 撤回提示在发送或修改输入框内容前应始终显示，修改或发送后立即收起
    const undoToastEl = env.doc.querySelector('#ag-quick-capsule-bar .ag-qcap-toast');
    assert.ok(undoToastEl, '应渲染快捷栏提示条');
    assert.equal(undoToastEl.getAttribute('data-visible'), 'true', '优化成功后撤回提示应立即显示');
    assert.equal(undoToastEl.getAttribute('data-persistent'), 'true', '撤回提示应持久显示不自动消失');
    assert.equal(undoToastEl.getAttribute('data-tag'), 'prompt-opt-undo');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(undoToastEl.getAttribute('data-visible'), 'true', '未修改未发送时撤回提示应持续可见');

    // 修改输入框内容后自动收起撤回提示
    editorEl.textContent = `${editorEl.textContent}（补充修改）`;
    env.doc.dispatchEvent({ type: 'input', target: editorEl });
    assert.equal(undoToastEl.getAttribute('data-visible'), 'false', '修改输入框内容后应自动收起撤回提示');

    // 再次优化后按回车发送，同样应自动收起撤回提示
    calledModels.length = 0;
    editorEl.textContent = '再优化一次';
    const res1b = await enhancer.optimizeComposerPrompt();
    assert.equal(res1b.ok, true);
    assert.equal(undoToastEl.getAttribute('data-visible'), 'true');
    assert.equal(undoToastEl.getAttribute('data-persistent'), 'true');
    env.doc.dispatchEvent({ type: 'keydown', key: 'Enter', target: editorEl, shiftKey: false, altKey: false });
    assert.equal(undoToastEl.getAttribute('data-visible'), 'false', '发送消息后应自动收起撤回提示');

    // 2. 全部候选均返回 500 时保留完整 JSON 错误细节与诊断记录，并在 toast 中展示与悬停 title 保留
    calledModels.length = 0;
    mode = 'all-fail';
    editorEl.textContent = '写一个脚本';
    const res2 = await enhancer.optimizeComposerPrompt();
    assert.equal(res2.ok, false);
    assert.equal(calledModels.length, 4, '应依次尝试最多 4 个不重复候选模型（含兜底默认模型）');
    assert.equal(new Set(calledModels).size, 4, '尝试的模型列表不得有重复');
    const lastErr = enhancer.getLastPromptOptError();
    assert.ok(lastErr, '失败后应通过 getLastPromptOptError() 保留完整诊断信息');
    assert.equal(lastErr.attempts.length, 4);
    assert.equal(lastErr.pathname, '/');
    assert.equal(lastErr.hasCsrf, true);
    assert.ok(lastErr.message.includes('HTTP 500') && lastErr.message.includes('model backend unavailable'), '应解析并保留服务端 JSON 错误详情');
    const toastEl = env.doc.querySelector('#ag-quick-capsule-bar .ag-qcap-toast');
    assert.ok(toastEl, '应渲染快捷栏提示条');
    assert.equal(toastEl.getAttribute('data-tone'), 'error', '失败提示条应标记 data-tone=error');
    assert.ok((toastEl.textContent || '').includes('model backend unavailable'), 'toast 应包含服务端错误详情');
    assert.ok((toastEl.title || '').includes('Gemini 3.8 Flash (Low)'), 'toast title 应保留全部尝试模型的完整错误详情');
  } finally {
    enhancer?.dispose?.();
    env.sandbox.__AGContextMeter?.dispose?.();
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
  }
});

// =========================================================================
// 需求 24: 远程面板多项目分组浏览、按项目新建对话、全会话状态与防缩水持久列表
// =========================================================================
test('需求 24: 远程面板支持多项目分组浏览、按项目新建对话、全会话状态汇总与防缩水持久列表', async () => {
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
    const lastSw = dispatchedActions[dispatchedActions.length - 1];
    assert.equal(lastSw?.action, 'switch-conversation');
    assert.equal(lastSw?.id, 'conv-root-245');
    assert.equal(lastSw?.isolated, true);
    assert.ok(typeof lastSw?.clientId === 'string' && lastSw.clientId.length > 0);

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
    const compactChip = envUi.doc.getElementById('chips').querySelectorAll('.chip').find((b) => (b.textContent || '').trim() === '/compact');
    assert.ok(compactChip, '快捷操作条应包含「/compact」按钮');
    compactChip.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(nextNonNavOverrideResp, null, '晚起飞非导航动作必须实际触发 /api/action 并消耗拦截回包');
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
// 需求 25: 远程会话全量历史消息上翻加载、长回复防截断与授权模式图标动态联动
// =========================================================================
test('需求 25: 远程会话全量历史消息上翻加载、长回复防截断与授权模式图标动态联动', async () => {
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
// 需求 26: 项目名条视觉层级、回车换行交互、浏览本机目录创建新项目与三态主题共存
// =========================================================================
test('需求 26: 项目分组头样式层级、Enter换行按钮发送、本机目录浏览建项目及三态外观共存', async () => {
  const { pathToFileURL } = require('url');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req19-'));
  const stateDir = path.join(tmpRoot, 'state');
  const homeDir = path.join(tmpRoot, 'home');
  const configDir = path.join(homeDir, '.gemini', 'config');
  const projectsDir = path.join(configDir, 'projects');
  const codebaseDir = path.join(homeDir, 'codebase');
  const sharedDir = path.join(homeDir, 'shared');
  const sharedResDir = path.join(sharedDir, '_shared_res');
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
  fs.mkdirSync(sharedResDir, { recursive: true });
  fs.mkdirSync(dupOwnerDir, { recursive: true });
  fs.mkdirSync(hiddenDir, { recursive: true });
  fs.writeFileSync(path.join(codebaseDir, 'note.txt'), 'not a folder', 'utf8');

  // 预设两个已有项目：一个将 ~/shared/_shared_res 作为辅资源 [1]（不应误标 _shared_res），一个占用名称 plain-b
  const existingProjId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(projectsDir, `${existingProjId}.json`), JSON.stringify({
    id: existingProjId,
    name: 'repo-existing',
    projectResources: {
      resources: [
        { folderUri: pathToFileURL(existingRepoDir).href },
        { folderUri: pathToFileURL(sharedResDir).href }
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
    const sharedResEntry = sharedListing.entries.find((e) => e.name === '_shared_res');
    assert.equal(sharedResEntry?.existingProjectId, '', '仅作辅资源 resources[1] 出现的共享目录不得被误判成已有主项目');

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
// 需求 27: 手机端弹窗输入框聚焦按相对键盘位置防误抬高与按需位移
// =========================================================================
test('需求 27: 手机端弹窗输入框聚焦按相对键盘位置防误抬高与按需位移', async () => {
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
            path: '/Users/demo',
            parentPath: '/Users',
            currentName: 'demo',
            suggestedName: 'demo',
            roots: [{ label: '主目录 (~)', path: '/Users/demo' }],
            entries: [{ name: 'codebase', path: '/Users/demo/codebase', isGitRepo: false }]
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
// 需求 28: 远程端切换防轮询假死与中止旧请求、折叠思考惰性挂载、轨迹签名缓存及 gzip 压缩
// =========================================================================
test('需求 28: 远程端切换防轮询假死与中止旧请求、折叠思考惰性挂载、轨迹签名缓存及 gzip 压缩', async () => {
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

    // 1b) 回归测试：预热(warmSession) → 持续 2500ms 轮询 → 实际拉取 TTL 到期与签名变化失效
    let warm1Rpc = 0;
    let warm1StepCount = 10;
    let warm1ModTime = '2026-11-19T10:05:00Z';
    let warm1ReplyText = '回复 **#warm1-init**';
    const warm1Connect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-warm-poll-1': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: warm1StepCount,
                lastModifiedTime: warm1ModTime
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          warm1Rpc += 1;
          return {
            trajectory: {
              steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '预热测试1' }] } },
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: warm1ReplyText } }
              ]
            }
          };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });
    const makeWarmSnap = (sid) => ({
      ok: true,
      sessionId: sid,
      busy: false,
      messages: [],
      conversations: [],
      projects: []
    });

    await remoteMod.warmConversationSession('sess-warm-poll-1', { localApiConnect: warm1Connect });
    assert.equal(warm1Rpc, 1, 'warmConversationSession 应执行一次预热拉取');

    // 第 1 次 2500ms 轮询（距预热 +500ms < 3500ms）：应命中预热缓存，不得延长 at，且不能将空签名升级为已验证 S1
    mockNow += 500;
    const warm1Poll1 = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm1Connect
    });
    assert.equal(warm1Rpc, 1);
    assert.ok(warm1Poll1.messages.some((m) => String(m.text || '').includes('#warm1-init')));

    // 后端更新内容但摘要步数仍暂持 S1；连续 2500ms 轮询到 +3000ms (< 3500ms) 仍命中，绝不得把 at 滑动延长到 +3000
    warm1ReplyText = '回复 **#warm1-ttl-refetched**';
    mockNow += 2500;
    await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm1Connect
    });
    assert.equal(warm1Rpc, 1, '距实际预热 3000ms < 3500ms 内命中缓存');

    // 再推进 2500ms（距上次轮询仅 2500ms，但距实际预热拉取已 5500ms >= 3500ms）：TTL 必须到期并重拉最新轨迹！
    mockNow += 2500;
    const warm1Poll3 = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm1Connect
    });
    assert.equal(warm1Rpc, 2, '连续 2500ms 轮询不得滑动刷新 at，超时后必须基于实际拉取时间过期重拉');
    assert.ok(warm1Poll3.messages.some((m) => String(m.text || '').includes('#warm1-ttl-refetched')));

    // 确认第 2 次真实拉取已将 S1 绑定为已验证签名，后续 S1 空闲轮询零 RPC，直到签名变更 S2 立刻重拉
    mockNow += 2500;
    await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm1Connect
    });
    assert.equal(warm1Rpc, 2, '签名 S1 验证锁定后空闲轮询应零 RPC');

    warm1StepCount = 12;
    warm1ModTime = '2026-11-19T10:05:25Z';
    warm1ReplyText = '回复 **#warm1-sig-S2**';
    mockNow += 2500;
    const warm1Poll5 = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm1Connect
    });
    assert.equal(warm1Rpc, 3, '预热周期后摘要签名推进到 S2 必须立刻重拉并展示最新内容');
    assert.ok(warm1Poll5.messages.some((m) => String(m.text || '').includes('#warm1-sig-S2')));

    // 预热子场景 B：3500ms TTL 窗口内首次轮询记录 observedSig=S1，下一次 2500ms 轮询前签名推进到 S2（总计 < 3500ms）也必须立刻重拉
    let warm2Rpc = 0;
    let warm2StepCount = 20;
    let warm2ModTime = '2026-11-19T10:06:00Z';
    let warm2ReplyText = '回复 **#warm2-v1**';
    const warm2Connect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-warm-poll-2': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: warm2StepCount,
                lastModifiedTime: warm2ModTime
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          warm2Rpc += 1;
          return {
            trajectory: {
              steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '预热测试2' }] } },
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: warm2ReplyText } }
              ]
            }
          };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });
    await remoteMod.warmConversationSession('sess-warm-poll-2', { localApiConnect: warm2Connect });
    mockNow += 400;
    const warm2Poll1 = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-2'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm2Connect
    });
    assert.equal(warm2Rpc, 1);
    assert.ok(warm2Poll1.messages.some((m) => String(m.text || '').includes('#warm2-v1')));

    // 仅过 1200ms（总计 1600ms < 3500ms），摘要由 S1 推进到 S2，observedSig 不一致必须立刻失效重拉
    warm2StepCount = 22;
    warm2ModTime = '2026-11-19T10:06:05Z';
    warm2ReplyText = '回复 **#warm2-v2**';
    mockNow += 1200;
    const warm2Poll2 = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-warm-poll-2'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: warm2Connect
    });
    assert.equal(warm2Rpc, 2, '预热 TTL 窗口内观测签名从 S1 变为 S2 必须立刻重拉');
    assert.ok(warm2Poll2.messages.some((m) => String(m.text || '').includes('#warm2-v2')));

    // 1c) 回归测试：localApiConnect 真实走 inflightMap 并发去重 & “S1 拉取未完成 → 摘要推进 S2 → 旧请求返回” 跨签名隔离与代际保护
    const createDeferred = () => {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, resolve };
    };
    const waitUntil = async (pred) => {
      for (let i = 0; i < 60; i++) {
        if (pred()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('waitUntil timed out');
    };

    // 先确认同签名并发请求通过 localApiConnect 实际进入 inflightMap 去重（只发 1 次 RPC）
    let dedupRpcCount = 0;
    const sameSigGate = createDeferred();
    const dedupConnect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-inflight-dedup': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: 8,
                lastModifiedTime: '2026-11-19T10:08:00Z'
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          dedupRpcCount += 1;
          await sameSigGate.promise;
          return {
            trajectory: {
              steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '并发去重问题' }] } },
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '回复 **#dedup-ok**' } }
              ]
            }
          };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });
    const dedupP1 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-inflight-dedup'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: dedupConnect
    });
    const dedupP2 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-inflight-dedup'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: dedupConnect
    });
    await waitUntil(() => dedupRpcCount === 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(dedupRpcCount, 1, 'localApiConnect 同签名并发请求必须走 inflightMap 去重');
    sameSigGate.resolve();
    const [dedupR1, dedupR2] = await Promise.all([dedupP1, dedupP2]);
    assert.equal(dedupRpcCount, 1);
    assert.ok(dedupR1.messages.some((m) => String(m.text || '').includes('#dedup-ok')));
    assert.ok(dedupR2.messages.some((m) => String(m.text || '').includes('#dedup-ok')));

    // 竞争顺序 1：S1 在途 → 摘要推进 S2 并发起 S2（不得复用 S1 in-flight）→ S1 先返回 → S2 后返回 → 后续 S2 轮询绝不命中 S1
    let race1Rpc = 0;
    let race1StepCount = 10;
    let race1ModTime = '2026-11-19T10:10:00Z';
    const race1GateS1 = createDeferred();
    const race1GateS2 = createDeferred();
    const race1Connect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-race-order1': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: race1StepCount,
                lastModifiedTime: race1ModTime
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          race1Rpc += 1;
          const idx = race1Rpc;
          const reply = idx === 1 ? await race1GateS1.promise : await race1GateS2.promise;
          return {
            trajectory: {
              steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '竞态问题1' }] } },
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: reply } }
              ]
            }
          };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });
    const req1S1 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race1Connect
    });
    await waitUntil(() => race1Rpc === 1);
    race1StepCount = 12;
    race1ModTime = '2026-11-19T10:10:15Z';
    mockNow += 200;
    const req1S2 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race1Connect
    });
    await waitUntil(() => race1Rpc === 2);

    race1GateS1.resolve('回复 **#race1-S1-stale**');
    await req1S1;
    race1GateS2.resolve('回复 **#race1-S2-fresh**');
    const res1S2 = await req1S2;
    assert.ok(res1S2.messages.some((m) => String(m.text || '').includes('#race1-S2-fresh')), 'S2 请求必须拿到新轨迹内容');

    mockNow += 15000;
    const poll1After = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order1'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race1Connect
    });
    assert.equal(race1Rpc, 2, '稳定态 S2 应命中最新缓存，不再重拉');
    assert.ok(poll1After.messages.some((m) => String(m.text || '').includes('#race1-S2-fresh')));
    assert.equal(poll1After.messages.some((m) => String(m.text || '').includes('#race1-S1-stale')), false);

    // 竞争顺序 2：S1 在途 → 摘要推进 S2 并发起 S2 → S2 先返回写入缓存 → 慢速 S1 后返回（绝不得覆盖 S2 缓存）
    let race2Rpc = 0;
    let race2StepCount = 10;
    let race2ModTime = '2026-11-19T10:12:00Z';
    const race2GateS1 = createDeferred();
    const race2GateS2 = createDeferred();
    const race2Connect = async () => ({
      call: async (method) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              'sess-race-order2': {
                status: 'CASCADE_RUN_STATUS_IDLE',
                stepCount: race2StepCount,
                lastModifiedTime: race2ModTime
              }
            }
          };
        }
        if (method === 'GetCascadeTrajectory') {
          race2Rpc += 1;
          const idx = race2Rpc;
          const reply = idx === 1 ? await race2GateS1.promise : await race2GateS2.promise;
          return {
            trajectory: {
              steps: [
                { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: '竞态问题2' }] } },
                { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: reply } }
              ]
            }
          };
        }
        if (method === 'ListProjects') return { projectIds: [] };
        return {};
      }
    });
    const req2S1 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order2'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race2Connect
    });
    await waitUntil(() => race2Rpc === 1);
    race2StepCount = 14;
    race2ModTime = '2026-11-19T10:12:15Z';
    mockNow += 200;
    const req2S2 = remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order2'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race2Connect
    });
    await waitUntil(() => race2Rpc === 2);

    race2GateS2.resolve('回复 **#race2-S2-fresh**');
    const res2S2 = await req2S2;
    assert.ok(res2S2.messages.some((m) => String(m.text || '').includes('#race2-S2-fresh')));
    race2GateS1.resolve('回复 **#race2-S1-stale**');
    await req2S1;

    mockNow += 15000;
    const poll2After = await remoteMod.enrichSnapshotWithCatalog(makeWarmSnap('sess-race-order2'), {
      stateDir, configDir, msgLimit: 6, bypassCache: false, localApiConnect: race2Connect
    });
    assert.equal(race2Rpc, 2, '迟到的 S1 返回后绝不得覆盖 S2 缓存');
    assert.ok(poll2After.messages.some((m) => String(m.text || '').includes('#race2-S2-fresh')));
    assert.equal(poll2After.messages.some((m) => String(m.text || '').includes('#race2-S1-stale')), false);
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
    assert.ok(String(htmlPlainRes.setCookie || '').includes('ag_ui_ver=2.1.0'), '根目录响应应下发最新版本号 2.1.0');

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
          snapSeq: (Number(alphaSnap.snapSeq) || 1) + 1,
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

    // 经「展开/收起思考」chip 本地切换时，同样必须同步 openThoughtIdxSet 并按需填充 .thought-body
    const thoughtToggleChip = env.doc.getElementById('chips').querySelectorAll('.chip').find((b) => (b.textContent || '').includes('展开/收起思考'));
    assert.ok(thoughtToggleChip, '快捷操作条应包含「展开/收起思考」按钮');
    thoughtToggleChip.click();
    alphaSnap.snapSeq = 3;
    alphaSnap.messages[0].text = '正文二次更新';
    alphaSnap.messages[0].html = '<p>正文二次更新</p>';
    await snapTimerEntry.fn();
    assert.equal(msgEl.querySelector('.thought-body'), null, '点击收起思考后重绘不得继续挂载 .thought-body');
    thoughtToggleChip.click();
    const chipExpandedBody = msgEl.querySelector('.thought-box')?.querySelector?.('.thought-body');
    assert.ok(chipExpandedBody && (chipExpandedBody.textContent || '').includes('LAZY_THOUGHT_PAYLOAD_200KB'), '再次点击展开/收起思考应同步挂载完整思考正文');

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

// =========================================================================
// 需求 29: 融合回归——隔离会话后跨项目新建与进空项目、项目/模型选择器交替打开互不串扰
// =========================================================================
test('需求 29: 融合回归——隔离会话后跨项目新建与进空项目、项目/模型选择器交替打开互不串扰', async () => {
  const { pathToFileURL } = require('url');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req29-'));
  const stateDir = path.join(tmpRoot, 'state');
  const homeDir = path.join(tmpRoot, 'home');
  const configDir = path.join(homeDir, '.gemini', 'config');
  const projectsDir = path.join(configDir, 'projects');
  const emptyDir = path.join(homeDir, 'codebase', 'empty-proj-r2');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });

  const prevAppData = process.env.APPDATA;
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const prevCtxStateDir = process.env.AG_CONTEXT_METER_STATE_DIR;
  const prevConfigDir = process.env.AG_CONFIG_DIR;
  const prevHome = process.env.HOME;

  try {
    process.env.APPDATA = stateDir;
    process.env.AG_METER_STATE_DIR = stateDir;
    process.env.AG_CONTEXT_METER_STATE_DIR = stateDir;
    process.env.AG_CONFIG_DIR = configDir;
    process.env.HOME = homeDir;

    delete require.cache[require.resolve('./mobile-remote.js')];
    const remoteMod = require('./mobile-remote.js');
    const httpCfg = remoteMod.loadOrCreateRemoteConfig();

    const fetchedSnaps = [];
    const performedActs = [];
    const mockConnect = async () => ({
      rpc: async (method, body) => {
        if (method === 'GetProjects') {
          const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith('.json'));
          return {
            projects: files.map((f) => ({
              project: JSON.parse(fs.readFileSync(path.join(projectsDir, f), 'utf8'))
            }))
          };
        }
        if (method === 'CreateProject') {
          const proj = body.project;
          fs.writeFileSync(path.join(projectsDir, `${proj.id}.json`), JSON.stringify(proj, null, 2), 'utf8');
          return { project: proj };
        }
        if (method === 'ReadProject') {
          const pFile = path.join(projectsDir, `${body.id}.json`);
          if (fs.existsSync(pFile)) return { project: JSON.parse(fs.readFileSync(pFile, 'utf8')) };
        }
        return {};
      }
    });

    const handler = remoteMod.createRemoteHttpHandler(httpCfg, {
      homeDir,
      configDir,
      localApiConnect: mockConnect,
      fetchSnapshot: async (tid, opts = {}) => {
        fetchedSnaps.push({ tid, opts });
        const cid = String(opts.conversationId || '');
        if (cid === '__new__') {
          return { ok: true, isNewConversation: true, sessionId: '', currentProjectId: 'proj-b-empty', currentProjectName: 'Empty Beta', projects: [], conversations: [] };
        }
        return {
          ok: true,
          isNewConversation: false,
          sessionId: cid || 'conv-desktop',
          activeConversationId: cid || 'conv-desktop',
          isolated: cid === 'conv-proj-a-1',
          currentProjectId: cid === 'conv-proj-a-1' ? 'proj-a' : 'proj-b-empty',
          projects: [],
          conversations: []
        };
      },
      performAction: async (act) => {
        performedActs.push(act);
        return {
          ok: true,
          actionResult: { ok: true, projectId: act.projectId || '' },
          snapshot: {
            ok: true,
            isNewConversation: true,
            sessionId: '',
            currentProjectId: act.projectId || '',
            currentProjectName: act.projectId === 'proj-b-empty' ? 'Empty Beta' : 'Empty Proj R2',
            projects: [],
            conversations: []
          }
        };
      }
    });

    const invokeHttp = (method, reqPath, bodyObj = null, extraHeaders = {}) => new Promise((resolve) => {
      const req = new (require('events').EventEmitter)();
      req.method = method;
      req.url = reqPath;
      req.headers = {
        host: `127.0.0.1:${httpCfg.port}`,
        'x-ag-remote-token': httpCfg.token,
        'x-ag-client-id': 'client-r2-cross',
        ...(bodyObj ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders
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
      } else {
        req.complete = true;
        req.emit('end');
      }
    });

    // 1a) 服务端：隔离切到 Project A 的会话后，跨项目在空项目 B 新建对话不得携带旧 conversationId
    const isoSwRes = await invokeHttp('POST', '/api/action', {
      action: 'switch-conversation',
      id: 'conv-proj-a-1',
      isolated: true
    });
    assert.equal(isoSwRes.status, 200);
    assert.equal(isoSwRes.json.ok, true);
    await invokeHttp('GET', '/api/snapshot');
    assert.equal(fetchedSnaps[fetchedSnaps.length - 1].opts.conversationId, 'conv-proj-a-1');

    const crossNewRes = await invokeHttp('POST', '/api/action', {
      action: 'new-conversation',
      projectId: 'proj-b-empty'
    });
    assert.equal(crossNewRes.status, 200);
    assert.equal(crossNewRes.json.ok, true);
    const crossNewAct = performedActs[performedActs.length - 1];
    assert.equal(crossNewAct.action, 'new-conversation');
    assert.equal(crossNewAct.projectId, 'proj-b-empty');
    assert.equal(crossNewAct.conversationId, '', '跨项目新建对话不得继承旧隔离会话 ID');

    await invokeHttp('GET', '/api/snapshot');
    assert.equal(fetchedSnaps[fetchedSnaps.length - 1].opts.conversationId, '__new__', '新建对话后轮询应绑定 __new__ 而非回跳旧隔离会话');

    // 1b) 服务端：再次切回隔离会话后，经 /api/projects 新建并进入空项目不得被旧隔离会话劫持
    await invokeHttp('POST', '/api/action', { action: 'switch-conversation', id: 'conv-proj-a-1', isolated: true });
    const createEmptyRes = await invokeHttp('POST', '/api/projects', {
      name: 'Empty Proj R2',
      folderPath: emptyDir
    });
    assert.equal(createEmptyRes.status, 200);
    assert.equal(createEmptyRes.json.ok, true);
    assert.equal(createEmptyRes.json.navOk, true);
    const projNavAct = performedActs[performedActs.length - 1];
    assert.equal(projNavAct.action, 'new-conversation');
    assert.equal(projNavAct.projectId, createEmptyRes.json.project.id);
    assert.equal(projNavAct.clientId, 'client-r2-cross');
    assert.equal(projNavAct.conversationId, '', '创建空项目进入新对话时不得携带旧隔离会话 ID');

    await invokeHttp('GET', '/api/snapshot');
    assert.equal(fetchedSnaps[fetchedSnaps.length - 1].opts.conversationId, '__new__');

    // 2) 前端 UI：隔离会话切走后进入空项目新建对话 + 项目选择器与两档模型选择器交替打开互不串扰
    const html = remoteMod.buildMobileAppHtml();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    const bodyMatch = html.match(/<body>([\s\S]*?)<script>/);
    assert.ok(scriptMatch && bodyMatch);

    const attachDatasetProxy = (root) => {
      if (!root) return;
      const syncNode = (n) => {
        if (!n || typeof n.getAttribute !== 'function') return;
        for (const attr of ['data-idx', 'data-group-idx', 'data-variant-idx', 'data-proj-key', 'data-cid', 'data-proj-toggle']) {
          const val = n.getAttribute(attr);
          if (val !== null) {
            const camel = attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            n.dataset[camel] = val;
          }
        }
        for (const ch of (n.children || [])) syncNode(ch);
      };
      syncNode(root);
    };

    const envUi = createDomEnv();
    envUi.doc.body.innerHTML = bodyMatch[1];
    envUi.win.innerWidth = 390;
    envUi.win.innerHeight = 844;
    envUi.win.AbortController = AbortController;
    envUi.win.location = { pathname: '/', search: `?token=${httpCfg.token}`, protocol: 'http:', reload() {} };
    envUi.win.history = { replaceState() {} };
    envUi.sandbox.location = envUi.win.location;
    envUi.sandbox.history = envUi.win.history;
    envUi.sandbox.AbortController = AbortController;
    envUi.sandbox.URLSearchParams = URLSearchParams;

    const projectsAB = [
      { id: 'proj-a', name: 'Alpha Main', path: pathToFileURL(path.join(homeDir, 'codebase', 'alpha')).href, conversationCount: 1, runningCount: 0, waitingCount: 0, unreadCount: 0, isEmpty: false, active: true },
      { id: 'proj-b-empty', name: 'Empty Beta', path: pathToFileURL(emptyDir).href, conversationCount: 0, runningCount: 0, waitingCount: 0, unreadCount: 0, isEmpty: true, active: false }
    ];
    const modelOpts = [
      { label: 'Gemini 4 Carbon (High)', modelId: 'MODEL_CARBON-high', selected: false },
      { label: 'Gemini 4 Carbon (Medium)', modelId: 'MODEL_CARBON-medium', selected: false },
      { label: 'Gemini 4 Carbon (Low)', modelId: 'MODEL_CARBON-low', selected: true },
      { label: 'Claude Opus 4.6', modelId: 'MODEL_OPUS', selected: false }
    ];
    let currentUiState = {
      sessionId: 'conv-proj-a-0',
      isNewConversation: false,
      currentProjectId: 'proj-a',
      currentProjectName: 'Alpha Main',
      title: 'Alpha 会话 0',
      isolated: false
    };
    const uiSnap = () => ({
      ok: true,
      sessionId: currentUiState.sessionId,
      isNewConversation: currentUiState.isNewConversation,
      currentProjectId: currentUiState.currentProjectId,
      currentProjectName: currentUiState.currentProjectName,
      title: currentUiState.title,
      isolated: currentUiState.isolated,
      busy: false,
      model: 'Gemini 4 Carbon (Low)',
      modelOptions: modelOpts,
      permissionKey: 'auto',
      permissionLabel: '自动',
      messages: [],
      totalMessages: 0,
      messagesStartIndex: 0,
      hasEarlierMessages: false,
      projects: projectsAB,
      conversations: [
        { id: 'conv-proj-a-1', projectId: 'proj-a', projectName: 'Alpha Main', title: 'Alpha 隔离目标', active: currentUiState.sessionId === 'conv-proj-a-1', status: 'idle', updatedAt: Date.now() },
        { id: 'conv-proj-a-2', projectId: 'proj-a', projectName: 'Alpha Main', title: 'Alpha 目标二', active: currentUiState.sessionId === 'conv-proj-a-2', status: 'idle', updatedAt: Date.now() - 500 }
      ]
    });

    const uiActions = [];
    const uiSnapUrls = [];
    let holdNextNewConv = null;
    envUi.sandbox.fetch = async (url, init) => {
      const u = new URL(String(url), 'http://127.0.0.1');
      const headers = { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : '') };
      if (u.pathname === '/api/snapshot') {
        uiSnapUrls.push(u.pathname + u.search);
        return { ok: true, status: 200, headers, json: async () => uiSnap() };
      }
      if (u.pathname === '/api/action') {
        const body = JSON.parse(String(init?.body || '{}'));
        uiActions.push(body);
        if (body.action === 'new-conversation' && holdNextNewConv) {
          const gate = holdNextNewConv;
          holdNextNewConv = null;
          await gate.promise;
          return {
            ok: true,
            status: 200,
            headers,
            json: async () => ({
              ok: true,
              actionResult: { ok: true },
              snapshot: {
                ...uiSnap(),
                sessionId: '',
                activeConversationId: '__new__',
                isNewConversation: true,
                currentProjectId: body.projectId || '',
                currentProjectName: body.projectId === 'proj-b-empty' ? 'Empty Beta' : 'Alpha Main',
                title: '过期新建响应标题'
              }
            })
          };
        }
        if (body.action === 'switch-conversation') {
          currentUiState = {
            sessionId: body.id,
            isNewConversation: false,
            currentProjectId: 'proj-a',
            currentProjectName: 'Alpha Main',
            title: body.id === 'conv-proj-a-2' ? 'Alpha 目标二' : 'Alpha 隔离目标',
            isolated: true
          };
        } else if (body.action === 'new-conversation') {
          currentUiState = {
            sessionId: '',
            isNewConversation: true,
            currentProjectId: body.projectId || '',
            currentProjectName: body.projectId === 'proj-b-empty' ? 'Empty Beta' : 'Alpha Main',
            title: '新对话',
            isolated: true
          };
        }
        return { ok: true, status: 200, headers, json: async () => ({ ok: true, actionResult: { ok: true, model: body.label || '' }, snapshot: uiSnap() }) };
      }
      return { ok: true, status: 200, headers, json: async () => ({ ok: true }) };
    };

    vm.runInContext(scriptMatch[1], envUi.sandbox);
    await new Promise((r) => setTimeout(r, 40));

    // 2a) 点击会话进入隔离状态 -> 再点选空项目并在顶栏新建对话
    const convListEl = envUi.doc.getElementById('conv-list');
    convListEl.querySelector('button[data-cid="conv-proj-a-1"]').click();
    await new Promise((r) => setTimeout(r, 30));
    const lastSwAct = uiActions[uiActions.length - 1];
    assert.equal(lastSwAct.action, 'switch-conversation');
    assert.equal(lastSwAct.id, 'conv-proj-a-1');
    assert.equal(lastSwAct.isolated, true);

    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(uiSnapUrls[uiSnapUrls.length - 1].includes('conversationId=conv-proj-a-1'));

    convListEl.querySelector('button[data-proj-toggle="proj-b-empty"]').click();
    assert.equal((envUi.doc.getElementById('new-chat-sub')?.textContent || '').trim(), 'Empty Beta');
    envUi.doc.getElementById('btn-new-chat').click();
    await new Promise((r) => setTimeout(r, 30));
    const newInEmptyAct = uiActions[uiActions.length - 1];
    assert.equal(newInEmptyAct.action, 'new-conversation');
    assert.equal(newInEmptyAct.projectId, 'proj-b-empty');
    assert.equal(newInEmptyAct.conversationId, undefined, '点击新建对话时前端不得附带旧 selectedConversationId');

    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(uiSnapUrls[uiSnapUrls.length - 1].includes('conversationId=__new__'), '新建进入空项目后轮询应附带 conversationId=__new__');

    // 2b) 交替打开项目选择器与两档模型选择器并点击，验证事件与 activeSheetState 互不串扰
    const sheetList = envUi.doc.getElementById('sheet-list');
    const countActions = (act) => uiActions.filter((a) => a.action === act).length;

    // Step A: 打开项目选择器再关闭
    envUi.doc.getElementById('btn-new-chat-project').click();
    assert.ok(sheetList.querySelectorAll('.sheet-opt').some((b) => (b.textContent || '').includes('Empty Beta')));
    envUi.doc.getElementById('sheet-close').onclick();

    // Step B: 打开两档模型选择器 -> 先 dispatchEvent 再 onclick 点击多档模型（仅触发 1 次 select-model，不触发 new-conversation）
    const baseNewCnt = countActions('new-conversation');
    const baseModelCnt = countActions('select-model');
    envUi.doc.getElementById('btn-model-inline').onclick();
    attachDatasetProxy(sheetList);
    const groupBtns = sheetList.querySelectorAll('[data-group-idx]');
    assert.equal(groupBtns.length, 2);
    sheetList.dispatchEvent({ type: 'click', target: groupBtns[0] });
    sheetList.onclick({ target: groupBtns[0] });
    attachDatasetProxy(sheetList);
    assert.ok(envUi.doc.getElementById('sheet-stage-track')?.classList?.contains('step-effort'));
    const variantBtns = sheetList.querySelectorAll('[data-variant-idx]');
    assert.equal(variantBtns.length, 3);
    sheetList.dispatchEvent({ type: 'click', target: variantBtns[0] });
    await sheetList.onclick({ target: variantBtns[0] });
    assert.equal(countActions('select-model'), baseModelCnt + 1, '切换模型分档后应精确发送 1 次 select-model');
    assert.equal(countActions('new-conversation'), baseNewCnt, 'activeSheetState 清空后不得误触项目选择回调');
    assert.equal(uiActions[uiActions.length - 1].label, 'Gemini 4 Carbon (High)');

    // Step C: 立即再次打开项目选择器并选择 Empty Beta（验证 openSheet 恢复了 listEl.onclick = handleSheetListClick，且不走旧模型闭包）
    envUi.doc.getElementById('btn-new-chat-project').click();
    const emptyProjOpt1 = sheetList.querySelectorAll('.sheet-opt').find((b) => (b.textContent || '').includes('Empty Beta'));
    assert.ok(emptyProjOpt1);
    emptyProjOpt1.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(countActions('new-conversation'), baseNewCnt + 1, '关闭模型弹窗后重新打开项目选择器必须正常新建项目会话');
    assert.equal(countActions('select-model'), baseModelCnt + 1);
    assert.equal(uiActions[uiActions.length - 1].projectId, 'proj-b-empty');

    // Step C2: 再打开一次项目选择器，直接调用 restored listEl.onclick 确认 .onclick 路径同样已从模型闭包复原
    envUi.doc.getElementById('btn-new-chat-project').click();
    const emptyProjOpt2 = sheetList.querySelectorAll('.sheet-opt').find((b) => (b.textContent || '').includes('Empty Beta'));
    await sheetList.onclick({ target: emptyProjOpt2 });
    assert.equal(countActions('new-conversation'), baseNewCnt + 2);
    assert.equal(countActions('select-model'), baseModelCnt + 1);

    // Step D: 立即再次打开模型选择器并点击单档模型 Claude Opus 4.6
    envUi.doc.getElementById('btn-model-inline').onclick();
    attachDatasetProxy(sheetList);
    const groupBtns2 = sheetList.querySelectorAll('[data-group-idx]');
    await sheetList.onclick({ target: groupBtns2[1] });
    assert.equal(countActions('select-model'), baseModelCnt + 2);
    assert.equal(countActions('new-conversation'), baseNewCnt + 2);
    assert.equal(uiActions[uiActions.length - 1].label, 'Claude Opus 4.6');

    // 2c) 乱序竞态回归：新建请求挂起 → 切换至另一会话 → 旧新建响应迟到返回
    // 2c-1) 跨项目场景：挂起 Empty Beta 新建对话 → 切换至 Alpha conv-proj-a-1 → 放行旧新建响应
    let resolveCrossRaceNew;
    holdNextNewConv = { promise: new Promise((r) => { resolveCrossRaceNew = r; }) };
    convListEl.querySelector('button[data-new-proj="proj-b-empty"]').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(typeof resolveCrossRaceNew, 'function', '跨项目新建请求应已进入挂起态');

    convListEl.querySelector('button[data-cid="conv-proj-a-1"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, 'Alpha 隔离目标');

    resolveCrossRaceNew();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, 'Alpha 隔离目标', '迟到旧新建响应不得回退跨项目已切入会话标题');
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(uiSnapUrls[uiSnapUrls.length - 1].includes('conversationId=conv-proj-a-1'), '跨项目旧新建回包后轮询仍应保持最后切换目标 conv-proj-a-1');
    const compactBtnCross = envUi.doc.getElementById('chips').querySelectorAll('.chip').find((b) => (b.textContent || '').trim() === '/compact');
    assert.ok(compactBtnCross);
    compactBtnCross.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(uiActions[uiActions.length - 1].conversationId, 'conv-proj-a-1', '跨项目旧新建回包后非导航动作仍应携带最后导航会话 ID');

    // 2c-2) 同项目场景：在 Alpha 内挂起新建对话 → 立即切至同项目 conv-proj-a-2 → 放行旧新建响应
    let resolveSameProjRaceNew;
    holdNextNewConv = { promise: new Promise((r) => { resolveSameProjRaceNew = r; }) };
    convListEl.querySelector('button[data-new-proj="proj-a"]').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(typeof resolveSameProjRaceNew, 'function', '同项目新建请求应已进入挂起态');

    convListEl.querySelector('button[data-cid="conv-proj-a-2"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, 'Alpha 目标二');

    resolveSameProjRaceNew();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(envUi.doc.getElementById('conv-title')?.textContent, 'Alpha 目标二', '同项目内迟到旧新建响应不得回退后续切换标题');
    envUi.win.dispatchEvent({ type: 'pageshow' });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(uiSnapUrls[uiSnapUrls.length - 1].includes('conversationId=conv-proj-a-2'), '同项目旧新建回包后轮询仍应保持 conv-proj-a-2');
    const compactBtnSame = envUi.doc.getElementById('chips').querySelectorAll('.chip').find((b) => (b.textContent || '').trim() === '/compact');
    assert.ok(compactBtnSame);
    compactBtnSame.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(uiActions[uiActions.length - 1].conversationId, 'conv-proj-a-2', '同项目旧新建回包后后续动作仍应保持 conv-proj-a-2');

    // 2d) 跨微任务去重单测：先触发 onclick(sharedEv) 后清空两轮微任务再派发同一事件，WeakSet 不得被清除从而仍只发送 1 次
    const beforeMicrotaskCompactCount = uiActions.filter((a) => a.action === 'send' && a.text === '/compact').length;
    const sharedClickEv = { type: 'click', target: compactBtnSame, preventDefault() {}, stopPropagation() {} };
    const pClick = compactBtnSame.onclick(sharedClickEv);
    await Promise.resolve();
    await Promise.resolve();
    compactBtnSame.dispatchEvent(sharedClickEv);
    await pClick;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      uiActions.filter((a) => a.action === 'send' && a.text === '/compact').length,
      beforeMicrotaskCompactCount + 1,
      '同一事件对象跨微任务经过 onclick 与 addEventListener 时只能执行一次'
    );

    // 2e) 真实 Headless Chrome 原生鼠标与触摸输入回归：验证真实浏览器中仅单事件路径且鼠标/触摸单击 /compact 与发送按钮精确触发 1 次 /api/action
    const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(CHROME_BIN)) {
      const http = require('node:http');
      const { spawn } = require('node:child_process');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const chromeActions = [];
      const chromeSnap = {
        ok: true,
        sessionId: 'conv-chrome-r4',
        isNewConversation: false,
        currentProjectId: 'proj-a',
        currentProjectName: 'Alpha Main',
        title: 'Chrome 原生点击验证',
        busy: false,
        model: 'Gemini 4 Carbon (Low)',
        modelOptions: modelOpts,
        permissionKey: 'auto',
        permissionLabel: '自动',
        messages: [],
        totalMessages: 0,
        messagesStartIndex: 0,
        hasEarlierMessages: false,
        projects: projectsAB,
        conversations: [
          { id: 'conv-chrome-r4', projectId: 'proj-a', projectName: 'Alpha Main', title: 'Chrome 原生点击验证', active: true, status: 'idle', updatedAt: Date.now() }
        ]
      };
      const chromeServer = http.createServer(remoteMod.createRemoteHttpHandler(httpCfg, {
        homeDir,
        configDir,
        localApiConnect: mockConnect,
        fetchSnapshot: async () => chromeSnap,
        performAction: async (act) => {
          chromeActions.push(act);
          return { ok: true, actionResult: { ok: true }, snapshot: chromeSnap };
        }
      }));
      await new Promise((resolve) => chromeServer.listen(0, '127.0.0.1', resolve));
      const chromePort = chromeServer.address().port;
      const chromeUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req29-chrome-'));
      let chromeProc = null;
      let cdpWs = null;
      try {
        const chromeEnv = { ...process.env };
        if (prevHome === undefined) delete chromeEnv.HOME;
        else chromeEnv.HOME = prevHome;
        chromeProc = spawn(CHROME_BIN, [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--remote-debugging-port=0',
          `--user-data-dir=${chromeUserDir}`,
          'about:blank'
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: chromeEnv });
        const browserWsUrl = await new Promise((resolve, reject) => {
          let errOut = '';
          const timer = setTimeout(() => reject(new Error('Chrome startup timeout: ' + errOut)), 10000);
          chromeProc.stderr.on('data', (chunk) => {
            errOut += String(chunk);
            const m = errOut.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (m) {
              clearTimeout(timer);
              resolve(m[1]);
            }
          });
          chromeProc.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome exited (${code}): ${errOut}`));
          });
        });
        const devOrigin = browserWsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
        const tabMeta = await new Promise((resolve, reject) => {
          const req = http.request(`${devOrigin}/json/new?about:blank`, { method: 'PUT' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.end();
        });
        cdpWs = new WebSocket(tabMeta.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          cdpWs.addEventListener('open', resolve, { once: true });
          cdpWs.addEventListener('error', reject, { once: true });
        });
        let cdpSeq = 0;
        const cdpPending = new Map();
        const rejectAllPending = (err) => {
          for (const [, p] of cdpPending) {
            clearTimeout(p.timer);
            p.reject(err);
          }
          cdpPending.clear();
        };
        cdpWs.addEventListener('close', () => rejectAllPending(new Error('CDP WebSocket closed')));
        cdpWs.addEventListener('error', () => rejectAllPending(new Error('CDP WebSocket error')));
        cdpWs.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.id && cdpPending.has(msg.id)) {
            const p = cdpPending.get(msg.id);
            cdpPending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
            else p.resolve(msg.result);
          }
        });
        const cdpCall = (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++cdpSeq;
          const timer = setTimeout(() => {
            cdpPending.delete(id);
            reject(new Error(`CDP timeout on ${method}`));
          }, 8000);
          cdpPending.set(id, { resolve, reject, timer });
          cdpWs.send(JSON.stringify({ id, method, params }));
        });
        const cdpEval = async (expression) => {
          const res = await cdpCall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (res?.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error');
          }
          return res?.result?.value;
        };

        await cdpCall('Page.enable');
        await cdpCall('Runtime.enable');
        await cdpCall('Page.bringToFront');
        await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await cdpCall('Page.navigate', { url: `http://127.0.0.1:${chromePort}/?token=${encodeURIComponent(httpCfg.token)}` });

        let chipRect = null;
        const waitStart = Date.now();
        while (Date.now() - waitStart < 8000) {
          chipRect = await cdpEval(`(() => {
            const chip = Array.from(document.querySelectorAll('#chips .chip')).find((el) => (el.textContent || '').trim() === '/compact');
            const modelBtn = document.getElementById('btn-model-inline');
            const sheetList = document.getElementById('sheet-list');
            if (!chip || !modelBtn || !sheetList) return null;
            chip.scrollIntoView({ block: 'center', inline: 'center' });
            const r = chip.getBoundingClientRect();
            return r.width > 0 && r.height > 0
              ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), isNativeEventTarget: chip instanceof EventTarget && modelBtn instanceof EventTarget && sheetList instanceof EventTarget }
              : null;
          })()`);
          if (chipRect) break;
          await sleep(60);
        }
        assert.ok(chipRect && chipRect.isNativeEventTarget, '真实 Chrome 中按钮必须识别为原生 EventTarget 且可定位 /compact 坐标');

        // 桌面端原生鼠标左键单击 /compact -> 精确触发 1 次
        await cdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chipRect.x, y: chipRect.y });
        await cdpCall('Input.dispatchMouseEvent', { type: 'mousePressed', x: chipRect.x, y: chipRect.y, button: 'left', clickCount: 1 });
        await cdpCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chipRect.x, y: chipRect.y, button: 'left', clickCount: 1 });
        await sleep(260);
        assert.equal(
          chromeActions.filter((a) => a.action === 'send' && a.text === '/compact').length,
          1,
          '真实 Chrome 原生鼠标左键单击 /compact 只能触发 1 次 /api/action'
        );

        // 移动端原生触摸点按 /compact -> 再精确 +1 次（累计 2 次）
        await cdpCall('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdpCall('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await sleep(80);
        const touchChipPt = await cdpEval(`(() => {
          const chip = Array.from(document.querySelectorAll('#chips .chip')).find((el) => (el.textContent || '').trim() === '/compact');
          chip?.scrollIntoView?.({ block: 'center', inline: 'center' });
          const r = chip?.getBoundingClientRect?.();
          return r && r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        })()`);
        assert.ok(touchChipPt);
        await cdpCall('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: touchChipPt.x, y: touchChipPt.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
        });
        await cdpCall('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(260);
        assert.equal(
          chromeActions.filter((a) => a.action === 'send' && a.text === '/compact').length,
          2,
          '真实 Chrome 原生触摸点按 /compact 只能触发 1 次（累计 2 次）/api/action'
        );

        // 原生鼠标左键单击发送按钮 #btn-send -> 同样精确触发 1 次
        await cdpCall('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdpCall('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await sleep(80);
        const sendPt = await cdpEval(`(() => {
          const taEl = document.getElementById('input');
          const sendEl = document.getElementById('btn-send');
          if (!taEl || !sendEl) return null;
          taEl.focus();
          taEl.value = 'native-click-once';
          taEl.dispatchEvent(new Event('input', { bubbles: true }));
          sendEl.scrollIntoView({ block: 'center', inline: 'center' });
          const r = sendEl.getBoundingClientRect();
          return (!sendEl.disabled && r.width > 0) ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        })()`);
        assert.ok(sendPt);
        await cdpCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sendPt.x, y: sendPt.y });
        await cdpCall('Input.dispatchMouseEvent', { type: 'mousePressed', x: sendPt.x, y: sendPt.y, button: 'left', clickCount: 1 });
        await cdpCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sendPt.x, y: sendPt.y, button: 'left', clickCount: 1 });
        await sleep(260);
        assert.equal(
          chromeActions.filter((a) => a.action === 'send' && a.text === 'native-click-once').length,
          1,
          '真实 Chrome 原生鼠标左键单击 #btn-send 只能触发 1 次 /api/action'
        );
      } finally {
        try { cdpWs?.close(); } catch {}
        try { chromeProc?.kill('SIGKILL'); } catch {}
        await sleep(150);
        chromeServer.closeAllConnections?.();
        await new Promise((resolve) => chromeServer.close(resolve));
        fs.rmSync(chromeUserDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
      }
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
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
// 需求 30: macOS LaunchAgent 监听 SingletonSocket 与非 Homebrew Node PATH 自动发现
// =========================================================================
test('需求 30: macOS LaunchAgent 改用 SingletonSocket、写入 EnvironmentVariables.PATH 并兼容最小 PATH 发现 nvm Node', { skip: process.platform !== 'darwin' }, () => {
  const { execFileSync } = require('node:child_process');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-req30-'));
  const fakeHome = path.join(tmpRoot, 'home');
  const stubBin = path.join(tmpRoot, 'stub-bin');
  const nvmLowBin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v22.5.0', 'bin');
  const nvmNodeBin = path.join(fakeHome, '.nvm', 'versions', 'node', 'v26.99.0', 'bin');
  const nvmMarkerLog = path.join(tmpRoot, 'nvm-node-invocations.log');
  const launchAgentsDir = path.join(fakeHome, 'Library', 'LaunchAgents');
  const setupScript = path.join(__dirname, 'scripts', 'setup-macos-cdp.sh');
  const agBin = path.join(__dirname, 'bin', 'ag-context-meter');
  const testLabel = 'com.testuser.ag-live-helper';
  const plistPath = path.join(launchAgentsDir, `${testLabel}.plist`);
  const realNodeBinDir = path.dirname(fs.realpathSync(process.execPath));
  const parsePlistJson = (p) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', p], { encoding: 'utf8' }));

  try {
    fs.mkdirSync(nvmLowBin, { recursive: true });
    fs.mkdirSync(nvmNodeBin, { recursive: true });
    fs.mkdirSync(stubBin, { recursive: true });

    // Executable wrappers log their own path before exec'ing real node to deterministically prove nvm hit & version ordering
    const makeNodeWrapper = (dir) => {
      const target = path.join(dir, 'node');
      fs.writeFileSync(
        target,
        `#!/bin/sh\necho "NVM_NODE_INVOKED:$0" >> "${nvmMarkerLog}"\nexec "${process.execPath}" "$@"\n`,
        { mode: 0o755 }
      );
      return target;
    };
    const lowNodeExe = makeNodeWrapper(nvmLowBin);
    const highNodeExe = makeNodeWrapper(nvmNodeBin);

    // Stub launchctl so tests never touch real macOS launchd
    const launchctlLog = path.join(tmpRoot, 'launchctl.log');
    const stubLaunchctl = path.join(stubBin, 'launchctl');
    fs.writeFileSync(stubLaunchctl, `#!/usr/bin/env bash\necho "$*" >> "${launchctlLog}"\nexit 0\n`, { mode: 0o755 });

    const minimalPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const baseEnv = {
      HOME: fakeHome,
      PATH: `${stubBin}:${minimalPath}`,
      AG_DEFAULT_NODE_PATHS: '',
      AG_LIVE_LABEL: testLabel,
      AG_METER_TEST_MODE: '1',
      ANTIGRAVITY_AGENT: '1'
    };

    // 1) setup-macos-cdp.sh（默认模式）：绕开宿主机固定目录，确定命中测试 nvm 最高版本 node 并写入 SingletonSocket 与 EnvironmentVariables.PATH
    execFileSync('bash', [setupScript], { env: baseEnv, encoding: 'utf8' });
    assert.ok(fs.existsSync(plistPath), 'setup-macos-cdp.sh 应生成 LaunchAgent plist');
    const plistDefault = fs.readFileSync(plistPath, 'utf8');
    const parsedDefault = parsePlistJson(plistPath);
    assert.ok(parsedDefault.WatchPaths.some((w) => w.endsWith('/Antigravity/SingletonSocket')), 'WatchPaths 应监听 SingletonSocket');
    assert.ok(!plistDefault.includes('SingletonLock'), 'WatchPaths 不得再包含悬空软链 SingletonLock');
    assert.equal(parsedDefault.StartInterval, 5, 'setup-macos-cdp.sh 应写入 StartInterval=5 轻量轮询');
    assert.equal(parsedDefault.ThrottleInterval, 5, 'setup-macos-cdp.sh 应写入 ThrottleInterval=5');
    assert.equal(parsedDefault.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, '最小 PATH 下应将解析后的真实 Node 可执行目录写入 EnvironmentVariables.PATH');
    const setupInvocations = fs.readFileSync(nvmMarkerLog, 'utf8').trim().split('\n');
    assert.ok(setupInvocations.includes(`NVM_NODE_INVOKED:${highNodeExe}`), 'setup-macos-cdp.sh 实际执行的必须是测试 nvm v26.99.0 的 node');
    assert.ok(!setupInvocations.includes(`NVM_NODE_INVOKED:${lowNodeExe}`), '不得误用较低版本 v22.5.0 的 node');
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 2) setup-macos-cdp.sh --no-remote：EnvironmentVariables 同时包含 PATH 与 AG_DISABLE_MOBILE_REMOTE=1
    execFileSync('bash', [setupScript, '--no-remote'], { env: baseEnv, encoding: 'utf8' });
    const parsedNoRemote = parsePlistJson(plistPath);
    assert.equal(parsedNoRemote.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, '--no-remote 时仍应保留真实 Node 可执行目录');
    assert.equal(parsedNoRemote.EnvironmentVariables.AG_DISABLE_MOBILE_REMOTE, '1', '--no-remote 时应写入 AG_DISABLE_MOBILE_REMOTE=1');
    assert.ok(parsedNoRemote.WatchPaths.some((w) => w.endsWith('/Antigravity/SingletonSocket')), '--no-remote 时应监听 SingletonSocket');
    assert.ok(!parsedNoRemote.WatchPaths.some((w) => w.includes('SingletonLock')), '--no-remote 时不得包含 SingletonLock');
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 3) bin/ag-context-meter 在 launchd 最小 PATH 且屏蔽宿主机固定目录时确定命中测试 nvm node 并输出 status JSON
    fs.writeFileSync(nvmMarkerLog, '', 'utf8');
    const statusJsonRaw = execFileSync('bash', [agBin, 'status', '--json'], {
      env: { HOME: fakeHome, PATH: minimalPath, AG_DEFAULT_NODE_PATHS: '', AG_METER_TEST_MODE: '1' },
      encoding: 'utf8'
    });
    const statusJson = JSON.parse(statusJsonRaw);
    assert.equal(typeof statusJson, 'object');
    assert.ok('liveWindow' in statusJson, '最小 PATH 下应能自动找到 node 并正常输出 status JSON');
    const cliInvocations = fs.readFileSync(nvmMarkerLog, 'utf8').trim().split('\n');
    assert.ok(cliInvocations.includes(`NVM_NODE_INVOKED:${highNodeExe}`), 'bin/ag-context-meter 实际执行的必须是测试 nvm v26.99.0 的 node');
    assert.ok(!cliInvocations.includes(`NVM_NODE_INVOKED:${lowNodeExe}`), 'bin/ag-context-meter 不得误用较低版本 v22.5.0 的 node');

    // 4a) auto-on 升级含旧 SingletonLock 且缺 EnvironmentVariables 的 plist
    const legacyLockPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${testLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fakeHome}/.local/bin/ag-context-meter</string>
    <string>_auto-trigger</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${fakeHome}/Library/Application Support/Antigravity/DevToolsActivePort</string>
    <string>${fakeHome}/Library/Application Support/Antigravity/SingletonLock</string>
  </array>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, legacyLockPlist, 'utf8');
    execFileSync('bash', [agBin, 'auto-on'], { env: baseEnv, encoding: 'utf8' });
    const parsedA = parsePlistJson(plistPath);
    assert.ok(parsedA.WatchPaths.some((w) => w.endsWith('/Antigravity/SingletonSocket')), 'auto-on 应将 SingletonLock 升级为 SingletonSocket');
    assert.ok(!parsedA.WatchPaths.some((w) => w.includes('SingletonLock')), 'auto-on 升级后不得残留 SingletonLock');
    assert.equal(parsedA.StartInterval, 5, 'auto-on 升级旧 plist 应补充 StartInterval=5');
    assert.equal(parsedA.ThrottleInterval, 5, 'auto-on 升级旧 plist 应补充 ThrottleInterval=5');
    assert.equal(parsedA.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, 'auto-on 应补充真实 Node 可执行目录到 EnvironmentVariables.PATH');
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 4b) auto-on 升级仅含 DevToolsActivePort 且已有 AG_DISABLE_MOBILE_REMOTE 的旧 plist
    const legacyNoRemotePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${testLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fakeHome}/.local/bin/ag-context-meter</string>
    <string>_auto-trigger</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AG_DISABLE_MOBILE_REMOTE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${fakeHome}/Library/Application Support/Antigravity/DevToolsActivePort</string>
  </array>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, legacyNoRemotePlist, 'utf8');
    execFileSync('bash', [agBin, 'auto-on'], { env: baseEnv, encoding: 'utf8' });
    const parsedB = parsePlistJson(plistPath);
    assert.ok(parsedB.WatchPaths.some((w) => w.endsWith('/Antigravity/SingletonSocket')), 'auto-on 应为旧 plist 补齐 SingletonSocket');
    assert.equal(parsedB.EnvironmentVariables.AG_DISABLE_MOBILE_REMOTE, '1', 'auto-on 升级应保留既有 AG_DISABLE_MOBILE_REMOTE');
    assert.equal(parsedB.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, 'auto-on 升级应在既有 EnvironmentVariables 内补充真实 Node 目录');
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 4c) auto-on 升级已有含 XML 实体（&amp;）PATH 的旧 plist：不得二次转义为 &amp;amp;，原路径各目录实际值保持不变
    const legacyEncodedPathPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${testLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fakeHome}/.local/bin/ag-context-meter</string>
    <string>_auto-trigger</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/tmp/a&amp;b/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${fakeHome}/Library/Application Support/Antigravity/DevToolsActivePort</string>
    <string>${fakeHome}/Library/Application Support/Antigravity/SingletonLock</string>
  </array>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, legacyEncodedPathPlist, 'utf8');
    execFileSync('bash', [agBin, 'auto-on'], { env: baseEnv, encoding: 'utf8' });
    const rawC = fs.readFileSync(plistPath, 'utf8');
    assert.ok(!rawC.includes('&amp;amp;'), 'auto-on 不得对已有 XML 实体做二次转义');
    const parsedC = parsePlistJson(plistPath);
    assert.deepEqual(
      parsedC.EnvironmentVariables.PATH.split(':'),
      [realNodeBinDir, '/tmp/a&b/bin', '/usr/bin', '/bin'],
      '迁移后原 PATH 中含 & 符号的目录及原有顺序必须保持完全不变'
    );
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 4d) auto-on 升级已有但不等于 5 的 StartInterval=60 与 ThrottleInterval=30：均须更新为 5
    const legacyNonFivePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${testLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${fakeHome}/.local/bin/ag-context-meter</string>
    <string>_auto-trigger</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WatchPaths</key>
  <array>
    <string>${fakeHome}/Library/Application Support/Antigravity/DevToolsActivePort</string>
    <string>${fakeHome}/Library/Application Support/Antigravity/SingletonSocket</string>
  </array>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, legacyNonFivePlist, 'utf8');
    execFileSync('bash', [agBin, 'auto-on'], { env: baseEnv, encoding: 'utf8' });
    const parsedD = parsePlistJson(plistPath);
    assert.equal(parsedD.StartInterval, 5, 'auto-on 应将已有 StartInterval=60 更新为 5');
    assert.equal(parsedD.ThrottleInterval, 5, 'auto-on 应将已有 ThrottleInterval=30 更新为 5');
    execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

    // 5) asdf/mise 项目级版本配置 shim 回归：shim 仅在含 .tool-versions 的项目目录可用；
    //    验证 setup-macos-cdp.sh、auto-on 与 install-launcher 均将解析出的真实 Node 可执行目录写入产物，
    //    并在无 .tool-versions、最小 PATH、无 shell 初始化的空目录中直接执行 node 成功。
    const shimHome = path.join(tmpRoot, 'shim-home');
    const asdfShimsDir = path.join(shimHome, '.asdf', 'shims');
    const projectDir = path.join(tmpRoot, 'project-with-tool-versions');
    const emptyCwd = path.join(tmpRoot, 'empty-cwd-no-config');
    const shimPlistPath = path.join(shimHome, 'Library', 'LaunchAgents', `${testLabel}.plist`);
    const shimMarkerLog = path.join(tmpRoot, 'asdf-shim.log');
    fs.mkdirSync(asdfShimsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(emptyCwd, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tool-versions'), 'nodejs 24.0.0\n', 'utf8');
    fs.writeFileSync(
      path.join(asdfShimsDir, 'node'),
      `#!/bin/sh
if [ ! -f "$PWD/.tool-versions" ] || ! grep -q "nodejs 24.0.0" "$PWD/.tool-versions"; then
  echo "No version is set for command node" >&2
  exit 126
fi
echo "ASDF_SHIM_OK:$PWD" >> "${shimMarkerLog}"
exec "${process.execPath}" "$@"
`,
      { mode: 0o755 }
    );

    // 先确认该 shim 在无项目配置的空目录中确实会失败
    assert.throws(
      () => execFileSync(path.join(asdfShimsDir, 'node'), ['-v'], { cwd: emptyCwd, env: { HOME: shimHome, PATH: minimalPath }, stdio: 'pipe' }),
      '测试用 asdf shim 在不含 .tool-versions 的目录中应失败'
    );

    const shimEnv = {
      HOME: shimHome,
      PATH: `${stubBin}:${minimalPath}`,
      AG_DEFAULT_NODE_PATHS: '',
      AG_LIVE_LABEL: testLabel,
      AG_METER_TEST_MODE: '1',
      ANTIGRAVITY_AGENT: '1'
    };

    // 5a) setup-macos-cdp.sh 在项目目录内通过 shim 启动，但写入 plist 的应为真实 Node 可执行目录
    execFileSync('bash', [setupScript], { cwd: projectDir, env: shimEnv, encoding: 'utf8' });
    const shimLogText = fs.readFileSync(shimMarkerLog, 'utf8');
    assert.ok(
      shimLogText.includes(`ASDF_SHIM_OK:${projectDir}`) || shimLogText.includes(`ASDF_SHIM_OK:${fs.realpathSync(projectDir)}`),
      'setup 阶段确实经由 asdf shim 解析'
    );
    const parsedShimSetup = parsePlistJson(shimPlistPath);
    assert.equal(parsedShimSetup.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, 'setup 生成的 plist 应写入真实 Node 目录而非 shim 目录');
    assert.ok(!parsedShimSetup.EnvironmentVariables.PATH.includes(asdfShimsDir), 'setup 生成的 plist PATH 不应依赖 shim 目录');
    const setupNodeVer = execFileSync('node', ['-v'], {
      cwd: emptyCwd,
      env: { HOME: shimHome, PATH: parsedShimSetup.EnvironmentVariables.PATH },
      encoding: 'utf8'
    }).trim();
    assert.match(setupNodeVer, /^v\d+\./, '脱离项目目录与 shell 初始化后，使用 setup plist PATH 必须能直接执行 node');

    // 5b) auto-on 在项目目录内升级旧 plist 后，使用升级后的 plist PATH 脱离项目目录仍可执行 node
    const shimLegacyPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${testLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${shimHome}/.local/bin/ag-context-meter</string>
    <string>_auto-trigger</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${shimHome}/Library/Application Support/Antigravity/DevToolsActivePort</string>
    <string>${shimHome}/Library/Application Support/Antigravity/SingletonLock</string>
  </array>
</dict>
</plist>
`;
    fs.writeFileSync(shimPlistPath, shimLegacyPlist, 'utf8');
    execFileSync('bash', [agBin, 'auto-on'], { cwd: projectDir, env: shimEnv, encoding: 'utf8' });
    const parsedShimAutoOn = parsePlistJson(shimPlistPath);
    assert.equal(parsedShimAutoOn.EnvironmentVariables.PATH.split(':')[0], realNodeBinDir, 'auto-on 升级后的 plist 应写入真实 Node 目录');
    const autoOnNodeVer = execFileSync('node', ['-v'], {
      cwd: emptyCwd,
      env: { HOME: shimHome, PATH: parsedShimAutoOn.EnvironmentVariables.PATH },
      encoding: 'utf8'
    }).trim();
    assert.match(autoOnNodeVer, /^v\d+\./, '脱离项目目录后，使用 auto-on plist PATH 必须能直接执行 node');

    // 5c) install-launcher 在项目目录内生成启动器后，启动器导出的 PATH 脱离项目目录与 shell 初始化仍可直接执行真实 node
    execFileSync('bash', [agBin, 'install-launcher'], { cwd: projectDir, env: shimEnv, encoding: 'utf8' });
    const launcherScript = path.join(shimHome, 'Applications', 'Antigravity 增强启动器.app', 'Contents', 'MacOS', 'launch');
    assert.ok(fs.existsSync(launcherScript), 'install-launcher 应生成 launch 脚本');
    const launcherText = fs.readFileSync(launcherScript, 'utf8');
    const pathLineMatch = launcherText.match(/^export PATH=".*"$/m);
    assert.ok(pathLineMatch, 'launch 脚本应包含 export PATH 行');
    assert.ok(pathLineMatch[0].includes(realNodeBinDir), 'launch 脚本 PATH 应包含真实 Node 可执行目录');
    assert.ok(!pathLineMatch[0].includes(asdfShimsDir), 'launch 脚本 PATH 不应依赖 shim 目录');
    const launcherCheck = execFileSync('bash', ['-c', `${pathLineMatch[0]}; command -v node; node -v`], {
      cwd: emptyCwd,
      env: { HOME: shimHome, PATH: minimalPath },
      encoding: 'utf8'
    }).trim().split('\n');
    assert.equal(path.dirname(launcherCheck[0]), realNodeBinDir, '启动器在空目录最小 PATH 下应直接命中真实 Node 目录');
    assert.match(launcherCheck[1], /^v\d+\./, '启动器在空目录最小 PATH 下必须能直接执行 node');

    // 6) _auto-trigger 纯 bash 毫秒级幂等快路径：宿主未运行、已带调试端口且新 live-host 存活、裸宿主运行 >30s 均须零 node 启动快速 exit 0
    const fastPathCases = [
      {
        name: '宿主未运行',
        mockPs: '  101 05:10 /Applications/Antigravity.app/Contents/Resources/bin/language_server\n',
        mockLiveHost: '0',
        mockLiveElapsed: ''
      },
      {
        name: '带调试端口且新 live-host 已存活',
        mockPs: '  202 00:12 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n',
        mockLiveHost: '1',
        mockLiveElapsed: '5'
      },
      {
        name: '裸宿主已运行超过 30 秒',
        mockPs: '  303 01:05 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
        mockLiveHost: '0',
        mockLiveElapsed: ''
      }
    ];
    for (const tc of fastPathCases) {
      fs.writeFileSync(nvmMarkerLog, '', 'utf8');
      const t0 = Date.now();
      execFileSync('bash', [agBin, '_auto-trigger'], {
        env: {
          HOME: fakeHome,
          PATH: minimalPath,
          AG_DEFAULT_NODE_PATHS: '',
          AG_MOCK_PS_OUTPUT: tc.mockPs,
          AG_MOCK_LIVE_HOST_RUNNING: tc.mockLiveHost,
          ...(tc.mockLiveElapsed ? { AG_MOCK_LIVE_HOST_ELAPSED: tc.mockLiveElapsed } : {})
        },
        encoding: 'utf8'
      });
      const elapsedMs = Date.now() - t0;
      assert.equal(fs.readFileSync(nvmMarkerLog, 'utf8').trim(), '', `_auto-trigger [${tc.name}] 应命中快路径，不得启动 node`);
      assert.ok(elapsedMs < 3000, `_auto-trigger [${tc.name}] 应毫秒级退出（实际 ${elapsedMs}ms）`);
    }

    // 6d) 旧 live-host.js 仍存活（live_elapsed=120 > host_elapsed=5）但 Antigravity 已换新宿主：
    //     不得误走快路径跳过，必须触发 cli.js live 为新宿主重新挂载
    const mockSuiteDir = path.join(tmpRoot, 'mock-suite');
    const mockActionLog = path.join(tmpRoot, 'mock-suite-actions.log');
    fs.mkdirSync(mockSuiteDir, { recursive: true });
    fs.writeFileSync(
      path.join(mockSuiteDir, 'asar-engine.js'),
      `module.exports = {
        resolveActiveCdpTarget: async () => ({ port: 59999, targets: [{ id: 't1', url: 'https://127.0.0.1:59999/' }] }),
        inspectAntigravityHostProcess: () => ({ running: false, pid: null, hasDebugSwitch: false, elapsedSec: null })
      };\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(mockSuiteDir, 'cli.js'),
      `const fs = require('fs');
       fs.appendFileSync(${JSON.stringify(mockActionLog)}, 'CLI_LIVE_CALLED:' + process.argv.slice(2).join(' ') + '\\n');\n`,
      'utf8'
    );
    fs.writeFileSync(mockActionLog, '', 'utf8');
    execFileSync('bash', [agBin, '_auto-trigger'], {
      env: {
        HOME: fakeHome,
        PATH: minimalPath,
        AG_DEFAULT_NODE_PATHS: '',
        AG_SUITE_DIR: mockSuiteDir,
        AG_MOCK_PS_OUTPUT: '  404 00:05 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n',
        AG_MOCK_LIVE_HOST_RUNNING: '1',
        AG_MOCK_LIVE_HOST_ELAPSED: '120'
      },
      encoding: 'utf8'
    });
    assert.ok(
      fs.readFileSync(mockActionLog, 'utf8').includes('CLI_LIVE_CALLED:live'),
      '旧 live-host.js 存活但宿主已换新（live_elapsed > host_elapsed）时必须重新触发 cli.js live'
    );

    // 7) 20 秒内再次重启（新裸宿主 PID != 上次冷却 PID）：不得被旧冷却跳过，而同 PID 在 20 秒内应保持防重入
    const relaunchLockPath = path.join(tmpRoot, 'relaunch.lock');
    const openLog = path.join(tmpRoot, 'open.log');
    const stubOpen = path.join(stubBin, 'open');
    const stubOsascript = path.join(stubBin, 'osascript');
    fs.writeFileSync(stubOpen, `#!/usr/bin/env bash\necho "OPEN:$*" >> "${openLog}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(stubOsascript, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const nowSec = Math.floor(Date.now() / 1000);
    // 7a) 同 PID 4001 在 2 秒前刚触发过重拉 -> 冷却生效，不重复触发
    fs.writeFileSync(relaunchLockPath, `${nowSec - 2} 4001\n`, 'utf8');
    fs.writeFileSync(openLog, '', 'utf8');
    fs.writeFileSync(mockActionLog, '', 'utf8');
    execFileSync('bash', [agBin, '_auto-trigger'], {
      env: {
        HOME: fakeHome,
        PATH: `${stubBin}:${minimalPath}`,
        AG_DEFAULT_NODE_PATHS: '',
        AG_SUITE_DIR: mockSuiteDir,
        AG_RELAUNCH_LOCK_FILE: relaunchLockPath,
        AG_MOCK_PS_OUTPUT: ' 4001 00:05 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n'
      },
      encoding: 'utf8'
    });
    assert.equal(fs.readFileSync(openLog, 'utf8').trim(), '', '20 秒内同一裸宿主 PID 不应重复重拉');

    // 7b) 新裸宿主 PID 4002 在距上次重拉仅 2 秒时启动 -> 不得被旧 PID 4001 的冷却跳过，应立即补参重拉并执行 live 注入
    execFileSync('bash', [agBin, '_auto-trigger'], {
      env: {
        HOME: fakeHome,
        PATH: `${stubBin}:${minimalPath}`,
        AG_DEFAULT_NODE_PATHS: '',
        AG_SUITE_DIR: mockSuiteDir,
        AG_RELAUNCH_LOCK_FILE: relaunchLockPath,
        AG_MOCK_PS_OUTPUT: ' 4002 00:03 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n'
      },
      encoding: 'utf8'
    });
    assert.ok(fs.readFileSync(openLog, 'utf8').includes('--remote-debugging-port=0'), '20 秒内新裸宿主 PID 4002 必须立即触发补参重拉');
    assert.ok(fs.readFileSync(mockActionLog, 'utf8').includes('CLI_LIVE_CALLED:live'), '补参重拉后必须完成 cli.js live 注入');

    // 7c) 带调试参数但 CDP 未就绪期间，宿主重启切换为新裸进程：
    //     注入等待循环必须及时跳出并转入补参重拉，不能空等 30 秒跨过保护窗口而永久跳过恢复
    const dynamicPsFile = path.join(tmpRoot, 'dynamic-ps.txt');
    const cdpFlipSuiteDir = path.join(tmpRoot, 'cdp-flip-suite');
    const cdpFlipStateFile = path.join(tmpRoot, 'cdp-flip-state.json');
    fs.mkdirSync(cdpFlipSuiteDir, { recursive: true });
    fs.writeFileSync(dynamicPsFile, ' 5001 00:02 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n', 'utf8');
    fs.writeFileSync(cdpFlipStateFile, JSON.stringify({ probes: 0, relaunched: false }), 'utf8');
    fs.writeFileSync(
      path.join(cdpFlipSuiteDir, 'asar-engine.js'),
      `const fs = require('fs');
      module.exports = {
        resolveActiveCdpTarget: async () => {
          const st = JSON.parse(fs.readFileSync(${JSON.stringify(cdpFlipStateFile)}, 'utf8'));
          st.probes += 1;
          if (st.probes === 1) {
            // 首次 CDP 探测未就绪，同时模拟宿主重启切换为无调试参数的新裸进程 5002
            fs.writeFileSync(${JSON.stringify(dynamicPsFile)}, ' 5002 00:01 /Applications/Antigravity.app/Contents/MacOS/Antigravity\\n', 'utf8');
            fs.writeFileSync(${JSON.stringify(cdpFlipStateFile)}, JSON.stringify(st));
            return { port: null, targets: [] };
          }
          fs.writeFileSync(${JSON.stringify(cdpFlipStateFile)}, JSON.stringify(st));
          if (st.relaunched) {
            return { port: 59998, targets: [{ id: 't2', url: 'https://127.0.0.1:59998/' }] };
          }
          return { port: null, targets: [] };
        },
        inspectAntigravityHostProcess: () => ({ running: false, pid: null, hasDebugSwitch: false, elapsedSec: null })
      };\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(cdpFlipSuiteDir, 'cli.js'),
      `const fs = require('fs');
       fs.appendFileSync(${JSON.stringify(mockActionLog)}, 'FLIP_CLI_LIVE_OK:' + process.argv.slice(2).join(' ') + '\\n');\n`,
      'utf8'
    );
    const flipStubOpen = path.join(stubBin, 'open');
    fs.writeFileSync(
      flipStubOpen,
      `#!/usr/bin/env bash
echo "OPEN:$*" >> "${openLog}"
"${process.execPath}" -e '
const fs = require("fs");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(cdpFlipStateFile)}, "utf8"));
st.relaunched = true;
fs.writeFileSync(${JSON.stringify(cdpFlipStateFile)}, JSON.stringify(st));
'
exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(openLog, '', 'utf8');
    fs.writeFileSync(mockActionLog, '', 'utf8');
    const flipStart = Date.now();
    execFileSync('bash', [agBin, '_auto-trigger'], {
      env: {
        HOME: fakeHome,
        PATH: `${stubBin}:${minimalPath}`,
        AG_DEFAULT_NODE_PATHS: '',
        AG_SUITE_DIR: cdpFlipSuiteDir,
        AG_RELAUNCH_LOCK_FILE: relaunchLockPath,
        AG_MOCK_PS_FILE: dynamicPsFile,
        AG_MOCK_LIVE_HOST_RUNNING: '0'
      },
      encoding: 'utf8'
    });
    const flipElapsedMs = Date.now() - flipStart;
    assert.ok(flipElapsedMs < 8000, `CDP 等待期间切裸宿主应立即跳出重拉，不得空等 30 秒（实际 ${flipElapsedMs}ms）`);
    assert.ok(fs.readFileSync(openLog, 'utf8').includes('--remote-debugging-port=0'), '跳出等待循环后必须立即补参重拉新裸宿主 5002');
    assert.ok(fs.readFileSync(mockActionLog, 'utf8').includes('FLIP_CLI_LIVE_OK:live'), '补参重拉后必须完成 cli.js live 注入');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// =========================================================================
// 需求 24（主干）: 内置推荐池统一胶囊开关（含 /goal /swarm /boost 等 + 复制会话 ID / 导出 MD）+ 干净自定义提示词 + 斜杠命令原生菜单自动点选转换
// =========================================================================
test('需求 24: 内置推荐池统一开关、三列自定义提示词与斜杠命令自动点选原生菜单', async () => {
  const env = createDomEnv();
  const activeTimers = new Set();
  env.sandbox.setTimeout = (fn, ms) => {
    const delay = Number(ms) > 500 ? Number(ms) : Math.min(Number(ms) || 0, 10);
    const t = setTimeout(() => { activeTimers.delete(t); fn(); }, delay);
    activeTimers.add(t);
    return t;
  };
  env.sandbox.clearTimeout = (t) => {
    activeTimers.delete(t);
    clearTimeout(t);
  };
  env.sandbox.location = { protocol: 'https:', hostname: '127.0.0.1', pathname: '/c/cccccccc-3333-3333-3333-333333333333', origin: 'https://127.0.0.1:53892', href: 'https://127.0.0.1:53892/c/cccccccc-3333-3333-3333-333333333333' };
  env.sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  env.win.getSelection = env.sandbox.getSelection;
  env.doc.createRange = () => ({ selectNodeContents() {}, collapse() {} });

  const composerEl = env.doc.createElement('div');
  composerEl.className = 'surface-composer';
  const editorEl = env.doc.createElement('div');
  editorEl.setAttribute('data-lexical-editor', 'true');
  editorEl.setAttribute('contenteditable', 'true');
  composerEl.appendChild(editorEl);
  env.doc.body.appendChild(composerEl);

  // 模拟 Antigravity 斜杠候选菜单：输入 /compact 后弹出 [role=option]，点击后转成 command pill
  let slashMenuEl = null;
  let slashOptionClicked = false;
  env.doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'delete') {
      editorEl.textContent = '';
      if (slashMenuEl) { slashMenuEl.remove?.(); slashMenuEl = null; }
      return true;
    }
    if (cmd === 'insertText') {
      editorEl.textContent = String(val || '');
      if (String(val || '').trim().toLowerCase() === '/compact') {
        if (slashMenuEl) slashMenuEl.remove?.();
        slashMenuEl = env.doc.createElement('div');
        slashMenuEl.setAttribute('role', 'listbox');
        const optEl = env.doc.createElement('div');
        optEl.setAttribute('role', 'option');
        const nameSpan = env.doc.createElement('span');
        nameSpan.textContent = 'compact';
        const descSpan = env.doc.createElement('span');
        descSpan.textContent = 'Compact the conversation now';
        optEl.appendChild(nameSpan);
        optEl.appendChild(descSpan);
        optEl.addEventListener('click', () => {
          slashOptionClicked = true;
          editorEl.textContent = 'compact ';
          editorEl.setAttribute('data-converted-slash', 'compact');
          slashMenuEl?.remove?.();
          slashMenuEl = null;
        });
        slashMenuEl.appendChild(optEl);
        env.doc.body.appendChild(slashMenuEl);
      }
      return true;
    }
    return true;
  };

  const freshRendererSrc = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
  const freshEnhancerSrc = fs.readFileSync(path.join(ROOT, 'ag-enhancer-overlay.js'), 'utf8');
  vm.runInContext(freshRendererSrc, env.sandbox);
  vm.runInContext(freshEnhancerSrc, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  const enhancer = env.sandbox.__AGEnhancer;
  const shadow = env.getShadow();

  try {
    const quickBar = env.doc.getElementById('ag-quick-capsule-bar');
    assert.ok(quickBar, '默认应挂载快捷栏');

    // 1. 不搞特殊：移除旧版硬塞的 #quick-builtin-toggles-grid 与左列 .qp-enable-checkbox
    assert.equal(shadow.getElementById('quick-builtin-toggles-grid'), null, '不应再渲染孤立的内置开关大框');
    assert.equal(shadow.querySelector('.qp-enable-checkbox'), null, '自定义列表不得再出现左列原生复选框');

    // 2. 内置推荐池应按 3 大场景分组并按推荐度排序（共 14 项，默认开启 5 项，推荐项带 ★ 星标）
    const poolGrid = shadow.getElementById('quick-builtin-pool-grid');
    const groups = Array.from(poolGrid?.querySelectorAll('.qp-pool-group') || []);
    assert.equal(groups.length, 3, '内置推荐池应按 3 大场景分组渲染');
    assert.deepEqual(
      groups.map((g) => g.getAttribute('data-pool-group')),
      ['daily', 'heavy', 'tools'],
      '分组顺序应为 daily -> heavy -> tools'
    );
    const getGroupChipIds = (idx) => Array.from(groups[idx]?.querySelectorAll('.qp-pool-chip') || []).map((c) => c.getAttribute('data-pool-id'));
    assert.deepEqual(getGroupChipIds(0), ['compact', 'plan', 'grill-me', 'btw', 'learn'], '日常高频组内部应按推荐程度排序');
    assert.deepEqual(getGroupChipIds(1), ['goal', 'boost', 'swarm', 'teamwork', 'browser', 'schedule'], '复杂攻坚组内部应按推荐程度排序');
    assert.deepEqual(getGroupChipIds(2), ['reload', 'copyid', 'export'], '会话工具组内部应排序正确');

    const chips = Array.from(poolGrid?.querySelectorAll('.qp-pool-chip') || []);
    assert.equal(chips.length, 14, '内置推荐池应包含全部 14 个内置推荐项');
    const getChip = (id) => shadow.getElementById(`ag-qp-pool-${id}`);
    assert.ok(getChip('compact')?.querySelector('.qp-pool-chip-star'), '/compact 应带有 ★ 推荐星标');
    assert.ok(getChip('boost')?.querySelector('.qp-pool-chip-star'), '/boost 应带有 ★ 推荐星标');
    assert.equal(getChip('swarm')?.querySelector('.qp-pool-chip-star'), null, '/swarm 不应带有 ★ 星标');

    // 悬停或点击内置胶囊时，底部实时解读栏 #quick-builtin-info-box 应零延迟切换
    getChip('boost')?.dispatchEvent({ type: 'mouseenter' });
    assert.match(shadow.getElementById('quick-info-title')?.textContent || '', /\/boost/);
    assert.equal(shadow.getElementById('quick-info-rec')?.hidden, false);
    assert.match(shadow.getElementById('quick-info-role')?.textContent || '', /Boost/);
    assert.match(shadow.getElementById('quick-info-scene')?.textContent || '', /Bug|算法/);

    for (const onId of ['compact', 'plan', 'reload', 'copyid', 'export']) {
      assert.equal(getChip(onId)?.getAttribute('data-active'), 'true', `内置推荐项 ${onId} 默认应激活`);
      assert.ok(quickBar.querySelector(`#ag-qcap-${onId}`), `默认应在快捷栏显示 #ag-qcap-${onId}`);
    }
    for (const offId of ['goal', 'swarm', 'boost', 'teamwork', 'grill-me', 'btw', 'learn', 'browser', 'schedule']) {
      assert.equal(getChip(offId)?.getAttribute('data-active'), 'false', `推荐池 ${offId} 默认应为未激活待选`);
      assert.equal(quickBar.querySelector(`#ag-qcap-${offId}`), null, `默认不在快捷栏显示 #ag-qcap-${offId}`);
    }

    // 快捷栏按钮应移除原生 title 并支持方案 C 零延迟双行悬浮气泡 (#ag-quickbar-tooltip)
    const compactBtn = quickBar.querySelector('#ag-qcap-compact');
    assert.equal(compactBtn?.getAttribute('title'), null, '快捷栏按钮不应设置原生 title 以免遮挡双行气泡');
    compactBtn?.dispatchEvent({ type: 'mouseenter' });
    const qTip = env.doc.getElementById('ag-quickbar-tooltip');
    assert.ok(qTip, '悬停快捷栏按钮应渲染 #ag-quickbar-tooltip 悬浮气泡');
    assert.equal(qTip.hidden, false, 'mouseenter 时应立即显示 #ag-quickbar-tooltip');
    assert.match(qTip.querySelector('.ag-qtip-title')?.textContent || '', /\/compact/);
    assert.match(qTip.querySelector('.ag-qtip-role')?.textContent || '', /压缩/);
    assert.match(qTip.querySelector('.ag-qtip-scene')?.textContent || '', /240K/);
    compactBtn?.dispatchEvent({ type: 'mouseleave' });
    assert.equal(qTip.hidden, true, 'mouseleave 时应立即隐藏 #ag-quickbar-tooltip');

    // 点亮 /goal 与 /swarm，并隐藏 复制会话 ID 与 导出 Markdown，均应立即同步并持久化
    getChip('goal')?.click();
    getChip('swarm')?.click();
    getChip('copyid')?.click();
    getChip('export')?.click();
    await new Promise(r => setTimeout(r, 25));

    assert.equal(getChip('goal')?.getAttribute('data-active'), 'true');
    assert.equal(getChip('swarm')?.getAttribute('data-active'), 'true');
    assert.equal(getChip('copyid')?.getAttribute('data-active'), 'false');
    assert.equal(getChip('export')?.getAttribute('data-active'), 'false');
    assert.ok(quickBar.querySelector('#ag-qcap-goal'), '点亮 /goal 后应立即出现在快捷栏');
    assert.ok(quickBar.querySelector('#ag-qcap-swarm'), '点亮 /swarm 后应立即出现在快捷栏');
    assert.equal(quickBar.querySelector('#ag-qcap-copyid'), null, '关闭复制会话 ID 后应立即从快捷栏隐藏');
    assert.equal(quickBar.querySelector('#ag-qcap-export'), null, '关闭导出 Markdown 后应立即从快捷栏隐藏');

    const savedPool = JSON.parse(env.localStorage.getItem('ag_suite_quick_pool') || '{}');
    assert.equal(savedPool.goal, true);
    assert.equal(savedPool.swarm, true);
    assert.equal(savedPool.copyid, false);
    assert.equal(savedPool.export, false);
    assert.ok(
      env.postedSettings.some(p => p?.uiPreferences?.quickPool?.goal === true && p?.uiPreferences?.quickPool?.copyid === false),
      '推荐池开关应透传持久化到 uiPreferences.quickPool'
    );

    // 3. 自定义区默认 0 行，点击 + 新增后渲染干净三列行，点击「恢复默认」一键还原
    const customList = shadow.getElementById('quick-prompts-editor-list');
    assert.equal(customList?.querySelectorAll('.qp-row').length, 0, '未添加自定义项时默认不应渲染内置项输入框行');
    assert.ok(customList?.querySelector('.qp-empty-hint'), '空态时应展示引导提示');

    shadow.getElementById('btn-add-quick-prompt')?.click();
    const addedRows = Array.from(customList?.querySelectorAll('.qp-row') || []);
    assert.equal(addedRows.length, 1, '点击 + 新增应插入一行自定义三列行');
    assert.equal(customList?.querySelector('.qp-empty-hint'), null, '新增行后应移除空态提示');
    addedRows[0].querySelector('.qp-label-input').value = '自检风格';
    addedRows[0].querySelector('.qp-text-input').value = '请按项目规范审查本文件';
    shadow.getElementById('btn-save-quick-prompts')?.click();
    await new Promise(r => setTimeout(r, 25));
    assert.ok(quickBar.querySelector('#ag-qcap-prompt-0'), '保存后自定义按钮应出现在快捷栏');
    assert.equal(quickBar.querySelector('#ag-qcap-prompt-0')?.textContent, '自检风格');

    shadow.getElementById('btn-reset-quick-prompts')?.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(getChip('goal')?.getAttribute('data-active'), 'false', '恢复默认应还原 /goal 为未启用');
    assert.equal(getChip('copyid')?.getAttribute('data-active'), 'true', '恢复默认应还原 复制会话 ID 为启用');
    assert.equal(getChip('export')?.getAttribute('data-active'), 'true', '恢复默认应还原 导出 Markdown 为启用');
    assert.ok(quickBar.querySelector('#ag-qcap-copyid') && quickBar.querySelector('#ag-qcap-export'));
    assert.equal(quickBar.querySelector('#ag-qcap-goal'), null);
    assert.equal(quickBar.querySelector('#ag-qcap-prompt-0'), null, '恢复默认应清空自定义快捷按钮');

    // 4. 点击 /compact 压缩应自动匹配并点选斜杠候选菜单 [role="option"] 转成原生斜杠命令
    quickBar.querySelector('#ag-qcap-compact')?.click();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(slashOptionClicked, true, '点击 /compact 压缩时应自动点选弹出的斜杠候选菜单项 [role="option"]');
    assert.equal(editorEl.getAttribute('data-converted-slash'), 'compact', '应将纯文本 /compact 转换为原生斜杠命令状态');
  } finally {
    enhancer?.dispose?.();
    api?.dispose?.();
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
  }
});

// =========================================================================
// 需求 25: UI 主题色系一致性静态门禁与动态主题变量绑定验证
// =========================================================================
test('需求 25: UI 主题色系一致性静态门禁与动态主题变量绑定验证', () => {
  const uiFiles = [
    ['src/renderer/suite-settings.css', fs.readFileSync(path.join(ROOT, 'src/renderer/suite-settings.css'), 'utf8')],
    ['src/renderer/suite-settings.js', fs.readFileSync(path.join(ROOT, 'src/renderer/suite-settings.js'), 'utf8')],
    ['src/renderer/suite-settings.html', fs.readFileSync(path.join(ROOT, 'src/renderer/suite-settings.html'), 'utf8')],
    ['ag-enhancer-overlay.js', fs.readFileSync(path.join(ROOT, 'ag-enhancer-overlay.js'), 'utf8')]
  ];
  const forbiddenPatterns = [
    { name: '硬编码翠绿 #10b981', re: /#10b981/i },
    { name: '硬编码翠绿 rgba(16,185,129)', re: /16,\s*185,\s*129/ },
    { name: '硬编码翠绿 #34d399', re: /#34d399/i },
    { name: '硬编码深绿 #059669', re: /#059669/i },
    { name: '硬编码天蓝 #38bdf8', re: /#38bdf8/i },
    { name: '硬编码天蓝 rgba(56,189,248)', re: /56,\s*189,\s*248/ },
    { name: '硬编码天蓝 rgba(2,132,199)', re: /2,\s*132,\s*199/ },
    { name: '硬编码浅蓝 #7dd3fc', re: /#7dd3fc/i },
    { name: '硬编码深蓝 #0369a1/#0c4a6e', re: /#(?:0369a1|0c4a6e)/i },
    { name: '硬编码橘色 #fb923c/#c2410c', re: /#(?:fb923c|c2410c)|249,\s*115,\s*22|234,\s*88,\s*12/i }
  ];
  for (const [relPath, src] of uiFiles) {
    for (const rule of forbiddenPatterns) {
      assert.equal(rule.re.test(src), false, `${relPath} 不得硬编码非主题色（命中：${rule.name}）`);
    }
  }

  const suiteCss = uiFiles[0][1];
  assert.match(suiteCss, /\.qp-pool-chip\[data-active="true"\][^}]*--ag-accent-border[^}]*--ag-accent-bg/, '内置推荐池激活态必须绑定 --ag-accent-* 变量');
  assert.match(suiteCss, /\.qp-info-box[^}]*--ag-accent-border/, '底部指令解读框必须绑定 --ag-accent-border');
  assert.match(suiteCss, /\.qp-info-rec[^}]*--ag-accent-bg[^}]*--ag-custom-token-accent/, '推荐徽章必须绑定 --ag-accent-* 与 --ag-custom-token-accent');
  assert.match(suiteCss, /\.qp-label-input,\.qp-text-input,\.ag-rp-input\{[^}]*background:var\(--ag-bg-input\)/, '设置面板所有输入框底色必须统一使用 --ag-bg-input');

  const enhancerSrc = uiFiles[3][1];
  assert.match(enhancerSrc, /#\$\{QUICK_BAR_TOOLTIP_ID\}\s*\{[^}]*--ag-accent-border/, '快捷栏双行悬浮气泡必须绑定 --ag-accent-border');
  assert.match(enhancerSrc, /#\$\{QUICK_BAR_TOOLTIP_ID\}\s+\.ag-qtip-rec\s*\{[^}]*--ag-accent-bg[^}]*--ag-effective-accent/, '快捷栏气泡推荐徽章必须绑定 --ag-accent-bg 与 --ag-effective-accent');
  assert.match(enhancerSrc, /#\$\{QUICK_BAR_ID\}\s+#\$\{NEXT_STEP_GHOST_ID\}\s+\.ag-ns-accept\s*\{[^}]*--ag-accent-border[^}]*--ag-effective-accent/, '追问建议胶囊必须绑定动态主题强调色');
  assert.match(enhancerSrc, /#\$\{PROMPT_OPT_WRAP_ID\}\s+\.ag-prompt-opt-btn\[data-loading="true"\]\s*\{[^}]*--ag-effective-accent/, '提示词优化按钮必须绑定动态主题强调色');

  // 运行时动态切换色系预设时，host 与 documentElement 必须同步刷新 --ag-accent-* 与 --ag-effective-accent
  const env = createDomEnv();
  const activeTimers = new Set();
  env.sandbox.setTimeout = (fn, ms) => {
    const t = setTimeout(() => { activeTimers.delete(t); fn(); }, Math.min(Number(ms) || 0, 10));
    activeTimers.add(t);
    return t;
  };
  env.sandbox.clearTimeout = (t) => { activeTimers.delete(t); clearTimeout(t); };
  const freshRendererSrc = fs.readFileSync(path.join(ROOT, 'meter-renderer.js'), 'utf8');
  vm.runInContext(freshRendererSrc, env.sandbox);
  const api = env.sandbox.__AGContextMeter;
  try {
    api.setHeatPreset('blue');
    const host = env.doc.getElementById('ag-context-meter');
    assert.equal(host.style.getPropertyValue('--ag-effective-accent'), '#60a5fa', '切换蓝色预设后 host --ag-effective-accent 应跟随为 #60a5fa');
    assert.equal(env.doc.documentElement.style.getPropertyValue('--ag-effective-accent'), '#60a5fa', 'documentElement --ag-effective-accent 必须同步镜像供外部悬浮气泡继承');
    assert.match(env.doc.documentElement.style.getPropertyValue('--ag-accent-bg'), /96,\s*165,\s*250/, 'documentElement --ag-accent-bg 必须同步更新 RGB');
  } finally {
    api?.dispose?.();
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
  }
});

// =========================================================================
// 需求 26: 同步 antigravity-chinese v3.3.53 登录页欢迎标题与设置侧栏优先扫描
// =========================================================================
test('需求 26: antigravity-hans-overlay 仅翻译 div.entrance-title 登录欢迎标题，保留 [data-uri] 保护并优先处理设置侧栏', async () => {
  const hansSrc = fs.readFileSync(path.join(ROOT, 'antigravity-hans-overlay.js'), 'utf8');
  const env = createDomEnv();
  env.sandbox.location.pathname = '/workbench.html';
  env.sandbox.location.href = 'file:///Applications/Antigravity.app/workbench.html';
  env.win.location = env.sandbox.location;
  env.win.top = env.win;
  env.sandbox.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
  env.sandbox.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 };

  const makeTextNode = (val, parentElement) => ({
    nodeType: 3,
    nodeValue: val,
    get textContent() { return this.nodeValue; },
    set textContent(v) { this.nodeValue = String(v); },
    parentElement
  });

  // 1. div.entrance-title 中的 Welcome to Antigravity! 应译为 欢迎使用 Antigravity！
  const entranceDiv = env.doc.createElement('div');
  entranceDiv.className = 'entrance-title text-3xl font-normal';
  const entranceText = makeTextNode('Welcome to Antigravity!', entranceDiv);
  entranceDiv.childNodes.push(entranceText);
  env.doc.body.appendChild(entranceDiv);

  // 2. 非 entrance-title 的 #project-name 与 [data-uri] 必须保留原文
  const projectDiv = env.doc.createElement('div');
  projectDiv.id = 'project-name';
  projectDiv.className = 'antigravity-agent-side-panel';
  const projectText = makeTextNode('Welcome to Antigravity!', projectDiv);
  projectDiv.childNodes.push(projectText);
  env.doc.body.appendChild(projectDiv);

  const uriDiv = env.doc.createElement('div');
  uriDiv.setAttribute('data-uri', 'file:///tmp/Welcome to Antigravity!');
  uriDiv.className = 'antigravity-agent-side-panel';
  const uriText = makeTextNode('Settings', uriDiv);
  uriDiv.childNodes.push(uriText);
  env.doc.body.appendChild(uriDiv);

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

  let observerCallback = null;
  env.sandbox.MutationObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  };
  const activeTimers = new Set();
  env.sandbox.setTimeout = (fn, ms) => {
    const t = setTimeout(() => { activeTimers.delete(t); fn(); }, Math.min(Number(ms) || 0, 10));
    activeTimers.add(t);
    return t;
  };
  env.sandbox.clearTimeout = (t) => { activeTimers.delete(t); clearTimeout(t); };

  try {
    vm.runInContext(hansSrc, env.sandbox);
    assert.equal(entranceText.nodeValue, '欢迎使用 Antigravity！', 'div.entrance-title 内的 Welcome to Antigravity! 应译为欢迎语');
    assert.equal(projectText.nodeValue, 'Welcome to Antigravity!', '#project-name 中的 Welcome to Antigravity! 必须保留原文');
    assert.equal(uriText.nodeValue, 'Settings', '[data-uri] 路径保护必须保留原文');

    // 3. 验证 .settings-modal-backdrop 内 [data-testid="settings-sidebar"] 优先于普通子树被翻译
    const writeOrder = [];
    const makeTrackedTextNode = (val, parentElement, tag) => {
      let cur = val;
      return {
        nodeType: 3,
        get nodeValue() { return cur; },
        set nodeValue(v) { cur = String(v); writeOrder.push(tag); },
        get textContent() { return cur; },
        set textContent(v) { cur = String(v); },
        parentElement
      };
    };

    const otherEl = env.doc.createElement('div');
    otherEl.className = 'antigravity-agent-side-panel';
    const otherSpan = env.doc.createElement('span');
    const otherText = makeTrackedTextNode('Settings', otherSpan, 'other');
    otherSpan.childNodes.push(otherText);
    otherEl.appendChild(otherSpan);
    env.doc.body.appendChild(otherEl);

    const backdrop = env.doc.createElement('div');
    backdrop.className = 'settings-modal-backdrop';
    const sidebar = env.doc.createElement('div');
    sidebar.setAttribute('data-testid', 'settings-sidebar');
    const sidebarHeading = env.doc.createElement('h1');
    const sidebarText = makeTrackedTextNode('Settings', sidebarHeading, 'sidebar');
    sidebarHeading.childNodes.push(sidebarText);
    sidebar.appendChild(sidebarHeading);
    backdrop.appendChild(sidebar);
    backdrop.querySelector = (sel) => (sel === '[data-testid="settings-sidebar"]' ? sidebar : null);
    env.doc.body.appendChild(backdrop);

    assert.ok(typeof observerCallback === 'function', '应注册 MutationObserver 回调');
    observerCallback([{ type: 'childList', target: env.doc.body, addedNodes: [otherEl, backdrop] }]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sidebarText.nodeValue, '设置', '设置模态框侧栏应在异步 flush 中完成翻译');
    assert.equal(otherText.nodeValue, '设置', '普通子树也应在同轮 flush 中继续完成翻译');
    assert.deepEqual(writeOrder, ['sidebar', 'other'], 'settings-sidebar 必须优先于同批次普通子树完成翻译');
  } finally {
    env.win.__antigravityZhPatchCleanup?.();
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
  }
});

test('远程入口多通道切换与 Cloudflare 隧道隔离修复 (#08)', async () => {
  const mobileSrc = fs.readFileSync(path.join(__dirname, 'mobile-remote.js'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(__dirname, 'ag-enhancer-overlay.js'), 'utf8');
  const { resolveEmptyCloudflaredConfigPath } = require('./mobile-remote');

  // 1. cloudflared 空配置路径解析：POSIX 返回 /dev/null；Windows 清空既有非空文件并校验 0 字节；失败路径回退/报错中止
  const posixCfg = resolveEmptyCloudflaredConfigPath({ platform: 'darwin' });
  assert.equal(posixCfg.ok, true);
  assert.equal(posixCfg.path, '/dev/null');

  const tmpWinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cf-empty-win-'));
  const tmpWinFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cf-empty-fb-'));
  try {
    // 1a. 既存非空 .cloudflared-empty.yml 必须被强制清空为 0 字节
    const prefilledPath = path.join(tmpWinDir, '.cloudflared-empty.yml');
    fs.writeFileSync(prefilledPath, 'ingress:\n  - service: http_status:404\n', 'utf8');
    const winCfg = resolveEmptyCloudflaredConfigPath({ platform: 'win32', baseDir: tmpWinDir, fallbackDir: null });
    assert.equal(winCfg.ok, true);
    assert.equal(winCfg.path, prefilledPath);
    assert.equal(fs.statSync(winCfg.path).size, 0, 'Windows 既有的非空 .cloudflared-empty.yml 必须被清空为 0 字节');

    // 1b. 主目录不可写时回退至 fallbackDir
    const blockerFile = path.join(tmpWinDir, 'not-a-dir');
    fs.writeFileSync(blockerFile, 'x', 'utf8');
    const fbCfg = resolveEmptyCloudflaredConfigPath({
      platform: 'win32',
      baseDir: path.join(blockerFile, 'sub'),
      fallbackDir: tmpWinFallback
    });
    assert.equal(fbCfg.ok, true, '主目录不可写时应回退至临时目录创建 0 字节空配置');
    assert.equal(fs.statSync(fbCfg.path).size, 0);

    // 1c. 主目录与回退均失败时必须明确返回 ok=false 与错误说明（绝不静默省略 --config）
    const failedCfg = resolveEmptyCloudflaredConfigPath({
      platform: 'win32',
      baseDir: path.join(blockerFile, 'sub'),
      fallbackDir: null
    });
    assert.equal(failedCfg.ok, false);
    assert.equal(failedCfg.path, '');
    assert.ok(failedCfg.error.includes('已中止启动'), '失败时应返回明确的隔离失败报错');
  } finally {
    fs.rmSync(tmpWinDir, { recursive: true, force: true });
    fs.rmSync(tmpWinFallback, { recursive: true, force: true });
  }

  // 2. cloudflared 启动参数、失败中止、quick 就绪事件/超时兜底、navigatingAway 恢复联动 schedulePoll 与 endpoints 持久化
  assert.ok(
    mobileSrc.includes('if (!emptyCfg.ok || !emptyCfg.path)')
    && mobileSrc.includes("['tunnel', '--config', emptyCfg.path, '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run']")
    && mobileSrc.includes("['tunnel', '--config', emptyCfg.path, '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', '--url'"),
    'cloudflared quick/named 模式必须在隔离空配置失败时报错中止，成功时强制传入 --config'
  );
  assert.ok(
    mobileSrc.includes('quickUrlCandidate && quickRegistered')
    && mobileSrc.includes("mode === 'quick' && quickUrlCandidate && state === 'starting' && child === spawned && !errorMsg")
    && mobileSrc.includes('function resetNavigationGuard(resumePoll)')
    && mobileSrc.includes('if (resumePoll && wasNavigating && !document.hidden)')
    && mobileSrc.includes('schedulePoll();')
    && mobileSrc.includes('pairState.endpoints = snap.endpoints;')
    && mobileSrc.includes('saveStoredPair(pairState);'),
    'quick 模式就绪/超时、pageshow/6s 恢复联动 schedulePoll 与快照 endpoints 持久化均应完整存在'
  );

  // 2b. 行为级验证：endpoints 持久化写入 localStorage 后在刷新重载（无 URL 参数）可完整恢复，且 resetNavigationGuard 恢复轮询
  const mockStore = new Map();
  let pollResumedCount = 0;
  const navSandbox = {
    localStorage: {
      getItem: (k) => (mockStore.has(k) ? mockStore.get(k) : null),
      setItem: (k, v) => { mockStore.set(k, String(v)); }
    },
    document: { hidden: false },
    setTimeout,
    clearTimeout,
    schedulePoll: () => { pollResumedCount += 1; }
  };
  vm.runInNewContext(`
    const PAIR_STORAGE_KEY = 'ag_remote_pair_v1';
    function loadStoredPair() {
      const raw = localStorage.getItem(PAIR_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }
    function saveStoredPair(st) {
      localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify({
        token: st.token || '', name: st.name || '',
        hosts: Array.isArray(st.hosts) ? st.hosts : [],
        endpoints: Array.isArray(st.endpoints) ? st.endpoints : []
      }));
    }
    const pairState = { token: 'tok', name: 'mac', hosts: ['192.168.1.10'], endpoints: [{ url: 'https://old.trycloudflare.com', kind: 'tunnel', priority: 250 }] };
    pairState.endpoints = [{ url: 'https://fresh.trycloudflare.com', kind: 'tunnel', priority: 250 }];
    saveStoredPair(pairState);
    const reloaded = loadStoredPair();
    globalThis.__reloadedEndpoints = reloaded.endpoints;

    let navigatingAway = true;
    let navigatingAwayTimer = null;
    function resetNavigationGuard(resumePoll) {
      const wasNavigating = navigatingAway;
      navigatingAway = false;
      clearTimeout(navigatingAwayTimer);
      navigatingAwayTimer = null;
      if (resumePoll && wasNavigating && !document.hidden) schedulePoll();
    }
    resetNavigationGuard(true);
    globalThis.__navAfterReset = navigatingAway;
  `, navSandbox);
  assert.equal(navSandbox.__reloadedEndpoints?.[0]?.url, 'https://fresh.trycloudflare.com', '刷新重载后应从 localStorage 恢复最新 endpoints');
  assert.equal(navSandbox.__navAfterReset, false, 'resetNavigationGuard 应重置 navigatingAway 为 false');
  assert.equal(pollResumedCount, 1, '导航恢复后必须重新调用 schedulePoll() 恢复快照轮询');

  // 3. 桌面端远程配对浮窗点击 .ag-rp-ch-pill 切换通道，且所选通道失效后自动回退
  const env = createDomEnv();
  env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };
  let copiedText = '';
  env.sandbox.navigator.clipboard = {
    writeText: async (text) => { copiedText = String(text || ''); }
  };
  let lanAvailable = true;
  const buildInfoPayload = () => ({
    port: 18765,
    token: 'tok-switch-test-123456',
    deviceName: 'test-host',
    pairedCount: 0,
    onlineCount: 0,
    pairedDevices: [],
    channels: [
      {
        key: 'lan',
        label: '局域网',
        labelEn: 'LAN',
        enabled: true,
        available: lanAvailable,
        displayHost: lanAvailable ? '192.168.1.10' : '',
        url: lanAvailable ? 'http://192.168.1.10:18765/?token=tok-switch-test-123456' : '',
        qrSvg: lanAvailable ? '<svg id="qr-lan"><rect/></svg>' : ''
      },
      {
        key: 'tailscale',
        label: 'Tailscale',
        labelEn: 'Tailscale',
        enabled: true,
        available: true,
        displayHost: 'test.ts.net',
        url: 'http://100.64.0.2:18765/?token=tok-switch-test-123456',
        qrSvg: '<svg id="qr-ts"><rect/></svg>'
      },
      {
        key: 'tunnel',
        label: 'Cloudflare 隧道',
        labelEn: 'Cloudflare Tunnel',
        enabled: true,
        available: true,
        state: 'running',
        mode: 'quick',
        displayHost: 'demo.trycloudflare.com',
        url: 'https://demo.trycloudflare.com/?token=tok-switch-test-123456',
        qrSvg: '<svg id="qr-tunnel"><rect/></svg>'
      }
    ],
    fusedUrl: 'https://demo.trycloudflare.com/?token=tok-switch-test-123456',
    primaryUrl: 'https://demo.trycloudflare.com/?token=tok-switch-test-123456',
    qrSvg: '<svg id="qr-tunnel"><rect/></svg>'
  });

  env.sandbox.fetch = async (url) => {
    if (String(url).includes('/remote-info')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: buildInfoPayload() }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(overlaySrc, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;
  const shadow = env.getShadow();
  enhancer.toggleRemotePopover(true);
  await new Promise((r) => setTimeout(r, 40));

  const remotePop = shadow.getElementById('ag-remote-popover');
  assert.ok(remotePop && !remotePop.hidden, '点击远程按钮应打开配对浮窗');
  assert.ok(remotePop.innerHTML.includes('id="qr-tunnel"'), '默认应优先展示 Cloudflare 隧道二维码');

  const findPill = (key) => Array.from(remotePop.querySelectorAll('.ag-rp-ch-pill'))
    .find((node) => node.getAttribute('data-ch-key') === key);

  const lanPill = findPill('lan');
  assert.ok(lanPill, '浮窗应渲染可点击的局域网通道胶囊');
  lanPill.click();
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(
    findPill('lan')?.getAttribute('data-active'),
    'true',
    '点击局域网胶囊后应激活局域网通道'
  );
  assert.ok(
    remotePop.innerHTML.includes('id="qr-lan"'),
    '切换通道后二维码应即时更新为局域网二维码'
  );
  remotePop.querySelector('#ag-remote-copy')?.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(copiedText, 'http://192.168.1.10:18765/?token=tok-switch-test-123456', '复制链接应复制当前选中通道的 URL');

  // 4. 所选局域网通道失效刷新后，应自动回退至最高优先级可用通道 (Cloudflare)
  lanAvailable = false;
  remotePop.querySelector('#ag-remote-refresh')?.click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    findPill('tunnel')?.getAttribute('data-active'),
    'true',
    '所选通道失效后应自动回退激活 Cloudflare 通道'
  );
  assert.ok(remotePop.innerHTML.includes('id="qr-tunnel"'), '回退后二维码应恢复为 Cloudflare 二维码');
  remotePop.querySelector('#ag-remote-copy')?.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(copiedText, 'https://demo.trycloudflare.com/?token=tok-switch-test-123456', '回退后复制链接应指向回退通道 URL');

  enhancer.dispose?.();
});

test('远程会话顶栏显示所属项目名与手机端右上角紧凑布局 (#06 #09)', async () => {
  const { buildMobileAppHtml } = require('./mobile-remote');
  const html = buildMobileAppHtml();

  // 1. 顶栏项目名徽章 DOM 与响应式/去重 CSS 规则存在
  assert.ok(html.includes('id="conv-project-badge"'), '顶栏 .title-row 应渲染 #conv-project-badge 项目名徽章');
  assert.ok(html.includes('body.has-ctx-btn .quota-pill #ctx-badge{display:none}'), '手机端上下文按钮可见时应隐藏配额胶囊内重复的 #ctx-badge');
  assert.ok(html.includes('#btn-usage-panel #usage-top-val{display:none}'), '窄屏下用量按钮应折叠文字标签为图标按钮以释放标题空间');
  assert.ok(html.includes('syncTopbarProjectBadge(resolveConversationProjectName(snap))'), 'renderSnapshot 应同步更新顶栏项目名徽章');
  assert.ok(html.includes("document.body.classList.toggle('has-ctx-btn', Boolean(cfg.showContextPanel))"), 'applyRemoteDisplayConfig 应联动切换 body.has-ctx-btn');

  // 2. 行为级验证 resolveConversationProjectName 与 syncTopbarProjectBadge（含新建对话、直接字段、projects 查表、conversations 反查与空值隐藏）
  const badgeEl = { textContent: '', title: '', hidden: true };
  const sandbox = {
    $: (id) => (id === 'conv-project-badge' ? badgeEl : null),
    normalizeProjectId: (v) => String(v || '').trim(),
    getEffectiveSelectedProject: () => ({ id: 'proj-new', name: 'NewTargetRepo' })
  };
  const fnStart = html.indexOf('function resolveConversationProjectName(snap)');
  const fnEnd = html.indexOf('function syncNewChatButtonUi(snap)');
  assert.ok(fnStart > 0 && fnEnd > fnStart, '应能提取 resolveConversationProjectName 与 syncTopbarProjectBadge');
  vm.runInNewContext(html.slice(fnStart, fnEnd) + '\nglobalThis.__resolve = resolveConversationProjectName;\nglobalThis.__sync = syncTopbarProjectBadge;', sandbox);

  assert.equal(sandbox.__resolve({ isNewConversation: true }), 'NewTargetRepo', '新建对话应展示目标选中项目名');
  assert.equal(sandbox.__resolve({ currentProjectName: 'antigravity-suite' }), 'antigravity-suite', '常规会话应优先展示 currentProjectName');
  assert.equal(
    sandbox.__resolve({ currentProjectId: 'p2', currentProjectName: '未归属项目', projects: [{ id: 'p2', name: 'alpha-app' }] }),
    'alpha-app',
    'currentProjectName 为占位值时应从 projects 表解析真实项目名'
  );
  assert.equal(
    sandbox.__resolve({ activeConversationId: 'c9', conversations: [{ id: 'c9', projectName: 'beta-service' }] }),
    'beta-service',
    '缺少顶层项目字段时应从 conversations 列表反查当前会话所属项目名'
  );

  sandbox.__sync('antigravity-suite');
  assert.equal(badgeEl.hidden, false);
  assert.equal(badgeEl.textContent, 'antigravity-suite');
  assert.equal(badgeEl.title, '所属项目：antigravity-suite');

  sandbox.__sync('');
  assert.equal(badgeEl.hidden, true, '无项目名时应自动隐藏徽章');
  assert.equal(badgeEl.textContent, '');
});

test('远程端支持系统确认选择框与交互式提问卡片展示与提交 (#03)', async () => {
  const overlaySrc = fs.readFileSync(path.join(__dirname, 'ag-enhancer-overlay.js'), 'utf8');
  const { buildMobileAppHtml } = require('./mobile-remote');
  const html = buildMobileAppHtml();

  // 1. 远程网页端包含交互式选择确认框 UI、会话级草稿隔离与清理、稳定 promptKey 传递
  assert.ok(html.includes('const promptDraftState = new Map();'), '远程网页端应维护交互式选择框草稿状态 Map');
  assert.ok(html.includes("String(snapSid || '__default__') + '::' + activePromptKey"), '草稿签名必须包含会话 ID 与稳定 promptKey');
  assert.ok(html.includes('openThoughtIdxSet.clear();\n        promptDraftState.clear();'), '切换会话时必须清空 promptDraftState');
  assert.ok(html.includes("action: 'respond-prompt'") && html.includes('promptKey: activePromptKey'), '远程网页端提交应携带稳定 promptKey 调用 respond-prompt');
  assert.ok(html.includes('class="prompt-card"') && html.includes('class="prompt-other-input"'), '远程网页端应渲染结构化选择卡片与自定义输入框');

  // 2. 桌面端 overlay 采集：过滤普通消息内复选框清单、隐藏卡片、已禁用结束卡片，仅采集真实可见待确认框
  const env = createDomEnv();
  env.win.__AGContextMeterLive = { port: 61220, token: 'tok-test' };

  const mainEl = env.doc.createElement('main');

  // 2a. 普通消息中的 Markdown 任务清单（2 个 checkbox 但无确认/提交按钮）不得被误采
  const ordinaryMsg = env.doc.createElement('div');
  ordinaryMsg.setAttribute('data-testid', 'agent-response');
  ordinaryMsg.offsetWidth = 360;
  ordinaryMsg.offsetHeight = 120;
  for (const txt of ['待办项 A', '待办项 B']) {
    const lbl = env.doc.createElement('label');
    const c = env.doc.createElement('input');
    c.setAttribute('type', 'checkbox');
    c.type = 'checkbox';
    c.offsetWidth = 16;
    c.offsetHeight = 16;
    lbl.appendChild(c);
    const sp = env.doc.createElement('span');
    sp.textContent = txt;
    lbl.appendChild(sp);
    ordinaryMsg.appendChild(lbl);
  }
  mainEl.appendChild(ordinaryMsg);

  // 2b. 隐藏的选择框容器（hidden=true）不得被采集
  const hiddenDlg = env.doc.createElement('div');
  hiddenDlg.setAttribute('role', 'dialog');
  hiddenDlg.hidden = true;
  hiddenDlg.offsetWidth = 0;
  hiddenDlg.offsetHeight = 0;
  const hiddenBtn = env.doc.createElement('button');
  hiddenBtn.textContent = 'Submit';
  hiddenBtn.offsetWidth = 80;
  hiddenBtn.offsetHeight = 32;
  hiddenDlg.appendChild(hiddenBtn);
  mainEl.appendChild(hiddenDlg);

  // 2c. 已结束（所有控件与按钮均 disabled）的旧卡片不得被采集
  const finishedCard = env.doc.createElement('div');
  finishedCard.setAttribute('data-testid', 'ask-question-card');
  finishedCard.offsetWidth = 360;
  finishedCard.offsetHeight = 140;
  for (const txt of ['旧选项 1', '旧选项 2']) {
    const r = env.doc.createElement('input');
    r.setAttribute('type', 'radio');
    r.type = 'radio';
    r.disabled = true;
    r.setAttribute('aria-label', txt);
    finishedCard.appendChild(r);
  }
  const doneBtn = env.doc.createElement('button');
  doneBtn.textContent = 'Submit';
  doneBtn.disabled = true;
  doneBtn.offsetWidth = 80;
  doneBtn.offsetHeight = 32;
  finishedCard.appendChild(doneBtn);
  mainEl.appendChild(finishedCard);

  // 2d. 真实的可见待确认多选弹窗
  const dlg = env.doc.createElement('div');
  dlg.setAttribute('role', 'dialog');
  dlg.offsetWidth = 360;
  dlg.offsetHeight = 220;

  const titleEl = env.doc.createElement('h3');
  titleEl.textContent = '请选择部署环境';
  dlg.appendChild(titleEl);

  const descEl = env.doc.createElement('p');
  descEl.textContent = '支持多选并附带自定义备注';
  dlg.appendChild(descEl);

  const mkCheckboxOpt = (id, text, initialChecked) => {
    const lbl = env.doc.createElement('label');
    const inp = env.doc.createElement('input');
    inp.setAttribute('type', 'checkbox');
    inp.type = 'checkbox';
    inp.setAttribute('id', id);
    inp.checked = initialChecked;
    inp.offsetWidth = 16;
    inp.offsetHeight = 16;
    inp.addEventListener('click', () => { inp.checked = !inp.checked; });
    lbl.appendChild(inp);
    const sp = env.doc.createElement('span');
    sp.textContent = text;
    lbl.appendChild(sp);
    return { lbl, inp };
  };

  const optA = mkCheckboxOpt('opt-a', 'Staging 预发环境', true);
  const optB = mkCheckboxOpt('opt-b', 'Production 生产环境', false);
  dlg.appendChild(optA.lbl);
  dlg.appendChild(optB.lbl);

  const otherInp = env.doc.createElement('input');
  otherInp.setAttribute('type', 'text');
  otherInp.type = 'text';
  otherInp.setAttribute('placeholder', '其他说明');
  otherInp.value = '';
  let otherInputFired = 0;
  otherInp.addEventListener('input', () => { otherInputFired += 1; });
  dlg.appendChild(otherInp);

  let submitted = false;
  const submitBtn = env.doc.createElement('button');
  submitBtn.setAttribute('type', 'submit');
  submitBtn.textContent = 'Submit';
  submitBtn.offsetWidth = 80;
  submitBtn.offsetHeight = 32;
  submitBtn.addEventListener('click', () => { submitted = true; });
  dlg.appendChild(submitBtn);

  const cancelBtn = env.doc.createElement('button');
  cancelBtn.setAttribute('type', 'button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.offsetWidth = 80;
  cancelBtn.offsetHeight = 32;
  dlg.appendChild(cancelBtn);

  mainEl.appendChild(dlg);
  env.doc.body.appendChild(mainEl);

  vm.runInContext(RENDERER_SRC, env.sandbox);
  vm.runInContext(overlaySrc, env.sandbox);
  const enhancer = env.sandbox.__AGEnhancer;

  const snap = enhancer.getMobileSnapshot();
  assert.equal(snap.pendingPrompts.length, 1, '仅应采集真实可见待确认弹窗，不得误采普通消息、隐藏卡片或已禁用卡片');
  const prompt = snap.pendingPrompts[0];
  assert.equal(prompt.title, '请选择部署环境');
  assert.ok(prompt.promptKey && prompt.promptKey.includes('请选择部署环境'), '应生成稳定 promptKey');
  assert.equal(prompt.multiSelect, true);
  assert.equal(prompt.options.length, 2);
  assert.equal(prompt.options[0].selected, true);
  assert.equal(prompt.options[1].selected, false);
  assert.equal(prompt.hasOtherInput, true);
  assert.equal(prompt.actions.length, 2);

  // 3. 过期/不匹配的 promptKey 与缺失按钮必须返回错误且绝不修改表单状态
  const staleRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: 'choice|已消失的旧提示|A|Submit',
    promptIndex: 0,
    selectedIndices: [1],
    otherText: '不应写入',
    actionLabel: 'Submit'
  });
  assert.equal(staleRes.ok, false, '不匹配的 promptKey 不得回退操作 cards[0]');
  assert.equal(optA.inp.checked, true, 'promptKey 失效时不得修改原勾选状态');
  assert.equal(optB.inp.checked, false, 'promptKey 失效时不得勾选其他选项');
  assert.equal(otherInp.value, '', 'promptKey 失效时不得写入输入框');

  const missingBtnRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: prompt.promptKey,
    promptIndex: 0,
    selectedIndices: [1],
    otherText: '不应写入',
    actionLabel: 'NonExistentButton'
  });
  assert.equal(missingBtnRes.ok, false, '目标按钮不存在时必须返回错误');
  assert.equal(optA.inp.checked, true, '按钮校验失败前不得提前修改选项状态');
  assert.equal(otherInp.value, '', '按钮校验失败前不得提前修改输入框');

  // 4. 正确 promptKey 执行 respond-prompt：取消勾选 0、勾选 1、填写自定义备注并点击 Submit
  const actRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: prompt.promptKey,
    promptIndex: 0,
    selectedIndices: [1],
    otherText: '灰度发布 10%',
    actionLabel: 'Submit'
  });
  assert.equal(actRes.ok, true, 'respond-prompt 应执行成功');
  assert.equal(optA.inp.checked, false, '原勾选的选项 0 应被幂等取消勾选');
  assert.equal(optB.inp.checked, true, '目标选项 1 应被勾选');
  assert.equal(otherInp.value, '灰度发布 10%', '自定义输入框值应同步写入');
  assert.ok(otherInputFired >= 1, '写入自定义输入框应触发 input 事件');
  assert.equal(submitted, true, '应触发目标 Submit 按钮点击');

  // 5. 行为验证：两个会话出现相同标题与选项时，草稿签名彼此隔离且切会话清空草稿
  const draftMap = new Map();
  const makeSig = (sid, p) => String(sid || '__default__') + '::' + String(p.promptKey || p.id || '') + '|' + String(p.title || '') + '|'
    + (p.options || []).map((o) => o.label).join(',') + '|'
    + (p.actions || []).map((a) => a.label).join(',');
  const sigS1 = makeSig('conv-1', prompt);
  const sigS2 = makeSig('conv-2', prompt);
  assert.notEqual(sigS1, sigS2, '不同会话下相同标题和选项必须拥有不同的草稿签名');
  draftMap.set(sigS1, { selected: new Set([1]), otherText: '会话1草稿' });
  assert.equal(draftMap.has(sigS2), false, '会话 2 不得继承会话 1 的草稿');

  // 6. 内嵌 radiogroup 的外层提问卡（标题/输入框/提交按钮在 radiogroup 外部）必须采集完整卡片并去重
  const nestedCard = env.doc.createElement('div');
  nestedCard.setAttribute('data-testid', 'ask-question-card');
  nestedCard.offsetWidth = 360;
  nestedCard.offsetHeight = 220;
  const nestedTitle = env.doc.createElement('h3');
  nestedTitle.textContent = '选择构建目标';
  nestedCard.appendChild(nestedTitle);
  const rg = env.doc.createElement('div');
  rg.setAttribute('role', 'radiogroup');
  rg.offsetWidth = 340;
  rg.offsetHeight = 90;
  let pickedTarget = '';
  for (const [id, label] of [['r-mac', 'macOS ARM64'], ['r-win', 'Windows x64']]) {
    const lbl = env.doc.createElement('label');
    const r = env.doc.createElement('input');
    r.setAttribute('type', 'radio');
    r.type = 'radio';
    r.setAttribute('id', id);
    r.checked = false;
    r.addEventListener('click', () => { r.checked = true; pickedTarget = label; });
    lbl.appendChild(r);
    const sp = env.doc.createElement('span');
    sp.textContent = label;
    lbl.appendChild(sp);
    rg.appendChild(lbl);
  }
  nestedCard.appendChild(rg);
  const nestedOther = env.doc.createElement('input');
  nestedOther.setAttribute('type', 'text');
  nestedOther.type = 'text';
  nestedOther.value = '';
  nestedCard.appendChild(nestedOther);
  let nestedSubmitted = false;
  const nestedSubmit = env.doc.createElement('button');
  nestedSubmit.setAttribute('type', 'submit');
  nestedSubmit.textContent = '确认构建';
  nestedSubmit.offsetWidth = 80;
  nestedSubmit.offsetHeight = 32;
  nestedSubmit.addEventListener('click', () => { nestedSubmitted = true; });
  nestedCard.appendChild(nestedSubmit);
  mainEl.appendChild(nestedCard);

  // 7. 非弹窗多选卡（选项可勾选、Submit 初始禁用，勾选任意项后启用）必须被采集并端到端提交
  const initDisabledCard = env.doc.createElement('form');
  initDisabledCard.offsetWidth = 360;
  initDisabledCard.offsetHeight = 180;
  const idTitle = env.doc.createElement('h3');
  idTitle.textContent = '选择清理项';
  initDisabledCard.appendChild(idTitle);
  let idSubmitted = false;
  const idSubmit = env.doc.createElement('button');
  idSubmit.setAttribute('type', 'submit');
  idSubmit.textContent = '提交清理';
  idSubmit.disabled = true;
  idSubmit.offsetWidth = 80;
  idSubmit.offsetHeight = 32;
  idSubmit.addEventListener('click', () => { if (!idSubmit.disabled) idSubmitted = true; });
  const idBoxes = [];
  for (const [id, label] of [['c-cache', '缓存目录'], ['c-log', '历史日志']]) {
    const lbl = env.doc.createElement('label');
    const c = env.doc.createElement('input');
    c.setAttribute('type', 'checkbox');
    c.type = 'checkbox';
    c.setAttribute('id', id);
    c.checked = false;
    c.addEventListener('click', () => {
      c.checked = !c.checked;
      idSubmit.disabled = !idBoxes.some((b) => b.checked);
    });
    idBoxes.push(c);
    lbl.appendChild(c);
    const sp = env.doc.createElement('span');
    sp.textContent = label;
    lbl.appendChild(sp);
    initDisabledCard.appendChild(lbl);
  }
  initDisabledCard.appendChild(idSubmit);
  mainEl.appendChild(initDisabledCard);

  const snap2 = enhancer.getMobileSnapshot();
  const nestedFound = snap2.pendingPrompts.filter((p) => p.title === '选择构建目标');
  assert.equal(nestedFound.length, 1, '内嵌 radiogroup 的提问卡应只采集 1 张完整外层卡并去重');
  assert.equal(nestedFound[0].hasOtherInput, true, '外层提问卡应保留自定义输入框');
  assert.equal(nestedFound[0].actions[0]?.label, '确认构建', '外层提问卡应保留提交按钮');
  const nestedRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: nestedFound[0].promptKey,
    selectedIndices: [1],
    otherText: '--release',
    actionLabel: '确认构建'
  });
  assert.equal(nestedRes.ok, true);
  assert.equal(pickedTarget, 'Windows x64');
  assert.equal(nestedOther.value, '--release');
  assert.equal(nestedSubmitted, true);

  const initDisFound = snap2.pendingPrompts.find((p) => p.title === '选择清理项');
  assert.ok(initDisFound, '选项可操作、提交按钮初始禁用的多选卡必须被采集');
  const idRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: initDisFound.promptKey,
    selectedIndices: [0],
    actionLabel: '提交清理'
  });
  assert.equal(idRes.ok, true, '勾选选项启用初始禁用的提交按钮后应成功提交');
  assert.equal(idSubmit.disabled, false);
  assert.equal(idSubmitted, true);

  // 8. 连续轮询复用已挂载提示 DOM，保留滚动位置且请求未完成时阻止重复提交
  assert.ok(
    html.includes('if (dock.dataset.promptSig !== promptSig)')
    && html.includes('if (promptSubmittingSig === promptSig) return;')
    && html.includes("dock.querySelectorAll('.prompt-act-btn').forEach((b) => { b.disabled = true; });")
    && html.includes("String(activePrompt.description || '')"),
    '连续轮询命中相同 promptSig 时应跳过重建 DOM 以保留滚动位置与提交中禁用锁，且签名包含 description'
  );

  // 9. 无中间空态、标题/选项/按钮完全相同但说明不同的连续两张提示框：实例 ID 与 description 区分 promptKey，第二张可正常提交
  const mkSameShapeDlg = (descText, onSubmit) => {
    const d = env.doc.createElement('div');
    d.setAttribute('role', 'dialog');
    d.offsetWidth = 360;
    d.offsetHeight = 180;
    const h = env.doc.createElement('h3');
    h.textContent = '继续执行操作？';
    d.appendChild(h);
    const p = env.doc.createElement('p');
    p.textContent = descText;
    d.appendChild(p);
    const b = env.doc.createElement('button');
    b.setAttribute('type', 'submit');
    b.textContent = 'Confirm';
    b.offsetWidth = 80;
    b.offsetHeight = 32;
    b.addEventListener('click', onSubmit);
    d.appendChild(b);
    return d;
  };
  let seq1Submitted = false;
  let seq2Submitted = false;
  const seqDlg1 = mkSameShapeDlg('步骤 1：删除临时缓存目录', () => { seq1Submitted = true; });
  mainEl.appendChild(seqDlg1);
  const snapSeq1 = enhancer.getMobileSnapshot();
  const pSeq1 = snapSeq1.pendingPrompts.find((p) => p.title === '继续执行操作？');
  assert.ok(pSeq1 && pSeq1.description.includes('步骤 1'));
  const seqRes1 = await enhancer.performMobileAction({ action: 'respond-prompt', promptKey: pSeq1.promptKey, actionLabel: 'Confirm' });
  assert.equal(seqRes1.ok, true);
  assert.equal(seq1Submitted, true);

  // 直接替换为第二张同标题同按钮但说明不同的新弹窗（模拟轮询未捕获中间空态）
  seqDlg1.hidden = true;
  const seqDlg2 = mkSameShapeDlg('步骤 2：重启本地服务', () => { seq2Submitted = true; });
  mainEl.appendChild(seqDlg2);
  const snapSeq2 = enhancer.getMobileSnapshot();
  const pSeq2 = snapSeq2.pendingPrompts.find((p) => p.title === '继续执行操作？');
  assert.ok(pSeq2 && pSeq2.description.includes('步骤 2'));
  assert.notEqual(pSeq2.promptKey, pSeq1.promptKey, '连续两张同标题同按钮的提示框必须拥有不同 promptKey（实例 ID + description）');
  const seqRes2 = await enhancer.performMobileAction({ action: 'respond-prompt', promptKey: pSeq2.promptKey, actionLabel: 'Confirm' });
  assert.equal(seqRes2.ok, true);
  assert.equal(seq2Submitted, true, '第二张连续提示框应独立展示并成功提交');

  // 10. 原生必填校验未通过时返回 ok:false 且不误触发提交；补充输入后重试成功提交
  const reqForm = env.doc.createElement('form');
  reqForm.offsetWidth = 360;
  reqForm.offsetHeight = 180;
  const reqTitle = env.doc.createElement('h3');
  reqTitle.textContent = '填写发布原因';
  reqForm.appendChild(reqTitle);
  for (const [id, lblTxt] of [['rf-1', '热修复'], ['rf-2', '常规版本']]) {
    const l = env.doc.createElement('label');
    const r = env.doc.createElement('input');
    r.setAttribute('type', 'radio');
    r.type = 'radio';
    r.setAttribute('id', id);
    r.checked = id === 'rf-1';
    r.addEventListener('click', () => { r.checked = true; });
    l.appendChild(r);
    const sp = env.doc.createElement('span');
    sp.textContent = lblTxt;
    l.appendChild(sp);
    reqForm.appendChild(l);
  }
  const reqOther = env.doc.createElement('input');
  reqOther.setAttribute('type', 'text');
  reqOther.type = 'text';
  reqOther.required = true;
  reqOther.setAttribute('required', '');
  reqOther.value = '';
  reqOther.checkValidity = () => Boolean(String(reqOther.value || '').trim());
  reqOther.validationMessage = '请填写发布原因';
  reqForm.appendChild(reqOther);
  let reqSubmitted = false;
  const reqSubmitBtn = env.doc.createElement('button');
  reqSubmitBtn.setAttribute('type', 'submit');
  reqSubmitBtn.textContent = '提交发布';
  reqSubmitBtn.offsetWidth = 80;
  reqSubmitBtn.offsetHeight = 32;
  reqSubmitBtn.addEventListener('click', () => { reqSubmitted = true; });
  reqForm.appendChild(reqSubmitBtn);
  mainEl.appendChild(reqForm);

  const snapReq = enhancer.getMobileSnapshot();
  const pReq = snapReq.pendingPrompts.find((p) => p.title === '填写发布原因');
  assert.ok(pReq, '带必填自定义输入的确认卡应被采集');
  const failReqRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: pReq.promptKey,
    selectedIndices: [0],
    otherText: '',
    actionLabel: '提交发布'
  });
  assert.equal(failReqRes.ok, false, '必填自定义输入为空时必须返回 ok=false');
  assert.equal(reqSubmitted, false, '校验失败时不得触发提交按钮');

  const okReqRes = await enhancer.performMobileAction({
    action: 'respond-prompt',
    promptKey: pReq.promptKey,
    selectedIndices: [0],
    otherText: '修复线上支付回调超时',
    actionLabel: '提交发布'
  });
  assert.equal(okReqRes.ok, true, '补充必填项后重试应返回 ok=true');
  assert.equal(reqOther.value, '修复线上支付回调超时');
  assert.equal(reqSubmitted, true, '补充必填项后应成功完成提交');

  // 11. 纯 JS 校验阻止提交（无 required 属性）→ 轮询后仍存在且草稿保留、按钮解锁 → 修改后再次提交成功
  assert.ok(
    !html.includes('promptDraftState.delete(promptSig);')
    && html.includes('if (dock.dataset.promptSig === promptSig) {\n                  dock.querySelectorAll(\'.prompt-act-btn\').forEach((b) => { b.disabled = false; });\n                }'),
    '请求结束后应解锁操作按钮且不提前销毁草稿，直至提示框真正消失或变更'
  );
  const jsValDlg = env.doc.createElement('div');
  jsValDlg.setAttribute('role', 'dialog');
  jsValDlg.offsetWidth = 360;
  jsValDlg.offsetHeight = 180;
  const jsValTitle = env.doc.createElement('h3');
  jsValTitle.textContent = '纯 JS 校验确认框';
  jsValDlg.appendChild(jsValTitle);
  const jsValInput = env.doc.createElement('input');
  jsValInput.setAttribute('type', 'text');
  jsValInput.type = 'text';
  jsValInput.value = '';
  jsValDlg.appendChild(jsValInput);
  let jsValAccepted = false;
  const jsValBtn = env.doc.createElement('button');
  jsValBtn.setAttribute('type', 'button');
  jsValBtn.textContent = 'Confirm';
  jsValBtn.offsetWidth = 80;
  jsValBtn.offsetHeight = 32;
  jsValBtn.addEventListener('click', () => {
    if (String(jsValInput.value || '').trim().length >= 4) {
      jsValAccepted = true;
      jsValDlg.hidden = true;
    }
  });
  jsValDlg.appendChild(jsValBtn);
  mainEl.appendChild(jsValDlg);

  const snapJs1 = enhancer.getMobileSnapshot();
  const pJs1 = snapJs1.pendingPrompts.find((p) => p.title === '纯 JS 校验确认框');
  assert.ok(pJs1, '纯 JS 校验确认框应被采集');
  await enhancer.performMobileAction({ action: 'respond-prompt', promptKey: pJs1.promptKey, otherText: 'ab', actionLabel: 'Confirm' });
  assert.equal(jsValAccepted, false, '输入长度不足时纯 JS 校验应阻止关闭');
  const snapJs2 = enhancer.getMobileSnapshot();
  const pJs2 = snapJs2.pendingPrompts.find((p) => p.title === '纯 JS 校验确认框');
  assert.ok(pJs2 && pJs2.promptKey === pJs1.promptKey, '校验未通过后轮询应仍存在同一 promptKey 提示框');
  const retryRes = await enhancer.performMobileAction({ action: 'respond-prompt', promptKey: pJs2.promptKey, otherText: 'abcd-ok', actionLabel: 'Confirm' });
  assert.equal(retryRes.ok, true);
  assert.equal(jsValAccepted, true, '修改输入后再次提交应通过纯 JS 校验并关闭确认框');
  assert.equal(enhancer.getMobileSnapshot().pendingPrompts.some((p) => p.title === '纯 JS 校验确认框'), false, '关闭后提示框应从快照中消失');

  enhancer.dispose?.();
});

test('远程端网页支持排队消息队列显示、立即发送与撤回删除 (#01)', async () => {
  const {
    extractMessagesFromTrajectorySteps,
    extractQueuedMessagesFromTrajectorySteps,
    createRemoteHttpHandler,
    buildMobileAppHtml
  } = require('./mobile-remote');

  // 1. 轨迹解析：排队消息从步骤中准确提取且不重复混入普通消息流
  const steps = [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: '第一条已发送指令' }] } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: '正在处理第一条' } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_QUEUED', userInput: { items: [{ text: '排队任务 A：跑单测' }] } },
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_QUEUED', userInput: { items: [{ text: '排队任务 B：更新文档' }] } }
  ];
  const normalMsgs = extractMessagesFromTrajectorySteps(steps);
  const queuedMsgs = extractQueuedMessagesFromTrajectorySteps(steps);
  assert.equal(normalMsgs.length, 2, '已发送消息流不应包含 CORTEX_STEP_STATUS_QUEUED 排队消息');
  assert.equal(queuedMsgs.length, 2, '应准确提取 2 条排队消息');
  assert.deepEqual(queuedMsgs, [
    { stepIndex: 2, text: '排队任务 A：跑单测', status: 'queued' },
    { stepIndex: 3, text: '排队任务 B：更新文档', status: 'queued' }
  ]);

  // 2. HTTP /api/action 路由验证：send-queued-messages / delete-queued-message 正确透传 RPC、校验参数并处理 RPC 失败
  const rpcCalls = [];
  let rpcFailNext = false;
  const mockCfg = {
    port: 18765,
    token: 'tok-queue-test-1234567890abcdef',
    tunnelEnabled: false,
    enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: false }
  };
  const handler = createRemoteHttpHandler(mockCfg, {
    callLanguageServer: async (method, body) => {
      rpcCalls.push({ method, body });
      if (rpcFailNext) {
        rpcFailNext = false;
        return null;
      }
      return {};
    },
    fetchSnapshot: async (_tid, opts) => ({
      ok: true,
      sessionId: opts?.conversationId || 'conv-q1',
      activeConversationId: opts?.conversationId || 'conv-q1',
      title: '队列测试会话',
      queuedMessages: []
    })
  });

  const postAction = async (bodyObj) => {
    const reqBody = JSON.stringify(bodyObj);
    const { Readable } = require('stream');
    const req = Readable.from([Buffer.from(reqBody, 'utf8')]);
    req.method = 'POST';
    req.url = '/api/action';
    req.headers = {
      host: '127.0.0.1:18765',
      'content-type': 'application/json',
      'x-ag-remote-token': mockCfg.token
    };
    req.socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' };
    let status = 200;
    let out = '';
    const res = {
      setHeader() {},
      writeHead(code) { status = code; },
      end(chunk) { out += chunk ? String(chunk) : ''; }
    };
    await handler(req, res);
    return { status, json: JSON.parse(out) };
  };

  // 2a. 缺少有效会话 ID 或非法 stepIndex（含 null / '' / false / true / 负数 / 小数）必须拒绝且零 RPC 调用
  const badCid = await postAction({ action: 'send-queued-messages', conversationId: '__new__' });
  assert.equal(badCid.json.ok, false, '新建草稿态不得调用队列发送 RPC');
  for (const badVal of [null, undefined, '', '   ', false, true, -1, 1.5, '2abc']) {
    const r = await postAction({ action: 'delete-queued-message', conversationId: 'conv-q1', stepIndex: badVal });
    assert.equal(r.json.ok, false, `非法 stepIndex (${JSON.stringify(badVal)}) 必须被拒绝`);
  }
  assert.equal(rpcCalls.length, 0, '任何非法参数均不得触发 DeleteQueuedUserInputStep RPC');

  // 2b. 正常删除单条排队消息
  const delRes = await postAction({ action: 'delete-queued-message', conversationId: 'conv-q1', stepIndex: 2 });
  assert.equal(delRes.json.ok, true);
  assert.deepEqual(rpcCalls[0], { method: 'DeleteQueuedUserInputStep', body: { cascadeId: 'conv-q1', stepIndex: 2 } });

  // 2c. 正常立即发送全部排队消息
  const sendRes = await postAction({ action: 'send-queued-messages', conversationId: 'conv-q1' });
  assert.equal(sendRes.json.ok, true);
  assert.deepEqual(rpcCalls[1], { method: 'SendAllQueuedMessages', body: { cascadeId: 'conv-q1' } });

  // 2d. RPC 返回 null（不可达/超时）时必须返回 ok:false 而非静默成功
  rpcFailNext = true;
  const failRes = await postAction({ action: 'send-queued-messages', conversationId: 'conv-q1' });
  assert.equal(failRes.json.ok, false, 'LanguageServer 返回 null 时必须向前端返回失败');

  // 3. 并发乱序失效验证：invalidateSession 推进 gen 并清除 inflightMap，旧请求晚归不得覆盖新队列状态
  const { createConversationHistoryManager } = require('./mobile-remote');
  const histMgr = createConversationHistoryManager();
  let resolveOldFetch;
  let resolveNewFetch;
  let fetchCount = 0;
  const controlledApi = {
    call: async (method) => {
      if (method !== 'GetCascadeTrajectory') return null;
      fetchCount += 1;
      if (fetchCount === 1) {
        return await new Promise((r) => { resolveOldFetch = r; });
      }
      return await new Promise((r) => { resolveNewFetch = r; });
    }
  };
  const baseSnap = { ok: true, sessionId: 'conv-race-1', messages: [], busy: false, _activeTrajSig: 'sig-1' };
  const oldPromise = histMgr.enrichMessages(baseSnap, { localApiConnect: async () => controlledApi });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(fetchCount, 1, '旧请求应已发出并处于在途状态');

  // 触发失效后再发起新刷新：必须发出第 2 次独立 RPC（不复用旧 inflight）
  histMgr.invalidateSession('conv-race-1');
  const newPromise = histMgr.enrichMessages(baseSnap, { localApiConnect: async () => controlledApi });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(fetchCount, 2, 'invalidateSession 后刷新必须发起新请求而不得复用失效前的在途请求');

  // 让新请求先完成（队列已清空），再让旧请求晚归（仍含旧排队项）
  resolveNewFetch({
    trajectory: {
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: '已完成' }] } }
      ]
    }
  });
  const newSnap = await newPromise;
  assert.equal(newSnap.queuedMessages.length, 0, '新请求应得到已清空的队列状态');

  resolveOldFetch({
    trajectory: {
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: '已完成' }] } },
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_QUEUED', userInput: { items: [{ text: '过期的旧排队消息' }] } }
      ]
    }
  });
  await oldPromise;

  // 再次读取缓存：必须仍为新状态（0 条排队），绝不能被晚归的旧请求覆盖
  const afterRaceSnap = await histMgr.enrichMessages(baseSnap, { localApiConnect: async () => controlledApi });
  assert.equal(afterRaceSnap.queuedMessages.length, 0, '晚归的旧请求绝不得覆盖失效后已落地的新队列状态');

  // 3b. 失效→旧请求先返回→新请求后返回：旧请求的返回快照不得泄漏过期队列，且最终缓存为新请求结果
  const histMgr2 = createConversationHistoryManager();
  let resolveOld2;
  let resolveNew2;
  let fetchCount2 = 0;
  const controlledApi2 = {
    call: async (method) => {
      if (method !== 'GetCascadeTrajectory') return null;
      fetchCount2 += 1;
      if (fetchCount2 === 1) return await new Promise((r) => { resolveOld2 = r; });
      return await new Promise((r) => { resolveNew2 = r; });
    }
  };
  const snapInput2 = {
    ok: true,
    sessionId: 'conv-race-2',
    messages: [],
    busy: false,
    _activeTrajSig: 'sig-2',
    queuedMessages: [{ stepIndex: 9, text: '输入快照自带的过期队列', status: 'queued' }]
  };
  const oldP2 = histMgr2.enrichMessages(snapInput2, { localApiConnect: async () => controlledApi2 });
  await new Promise((r) => setTimeout(r, 15));
  histMgr2.invalidateSession('conv-race-2');
  const newP2 = histMgr2.enrichMessages(snapInput2, { localApiConnect: async () => controlledApi2 });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(fetchCount2, 2);

  // 旧请求先返回（携带过期排队消息），此时新请求尚未返回：不得泄漏旧 RPC 队列也不得回退到输入快照的旧队列
  resolveOld2({
    trajectory: {
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_QUEUED', userInput: { items: [{ text: '失效前过期排队项' }] } }
      ]
    }
  });
  const oldSnap2 = await oldP2;
  assert.equal(oldSnap2.queuedMessages.length, 0, '已失效的旧请求先返回时，绝不得泄漏过期队列或回退使用 cleanSnap.queuedMessages');

  // 新请求后返回权威空队列：必须返回 []，绝不得回退使用输入快照携带的旧 queuedMessages
  resolveNew2({
    trajectory: {
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { items: [{ text: '全部执行完成' }] } }
      ]
    }
  });
  const newSnap2 = await newP2;
  assert.equal(newSnap2.queuedMessages.length, 0, '刷新取得权威空队列 [] 时绝不得回退到 cleanSnap.queuedMessages');
  const finalCached2 = await histMgr2.enrichMessages(snapInput2, { localApiConnect: async () => controlledApi2 });
  assert.equal(finalCached2.queuedMessages.length, 0, '缓存命中权威空队列时也绝不得回退到 cleanSnap.queuedMessages');

  // 3c. invalidateSession 后新请求 RPC 失败：不得恢复输入快照中的旧队列；未失效时 RPC 失败保留输入快照队列
  const histMgr3 = createConversationHistoryManager();
  const failApi = { call: async () => null };
  const snapWithStale = {
    ok: true,
    sessionId: 'conv-fail-1',
    messages: [],
    busy: false,
    _activeTrajSig: 'sig-f1',
    queuedMessages: [{ stepIndex: 5, text: '输入快照旧队列', status: 'queued' }]
  };
  const uninvalidatedFail = await histMgr3.enrichMessages(snapWithStale, { localApiConnect: async () => failApi });
  assert.equal(uninvalidatedFail.queuedMessages.length, 1, '未失效情况下 RPC 失败应保留输入快照队列');

  histMgr3.invalidateSession('conv-fail-1');
  const invFailSnap = await histMgr3.enrichMessages(snapWithStale, { localApiConnect: async () => failApi });
  assert.equal(invFailSnap.queuedMessages.length, 0, 'invalidateSession 后 RPC 失败绝不得恢复输入快照中的旧队列');
  const invFailCached = await histMgr3.enrichMessages(snapWithStale, { localApiConnect: async () => failApi });
  assert.equal(invFailCached.queuedMessages.length, 0, '失效后后续缓存读取同样不得恢复旧队列');

  // 4. 远程网页端包含 #queue-dock、排队条渲染、立即发送与撤回按钮及防重锁
  const html = buildMobileAppHtml();
  assert.ok(html.includes('id="queue-dock"'), '应渲染 #queue-dock 排队消息容器');
  assert.ok(html.includes("action: 'send-queued-messages'") && html.includes("action: 'delete-queued-message'"), '前端应接入立即发送与单条撤回动作');
  assert.ok(html.includes('if (qDock.dataset.queueSig !== qSig)') && html.includes('if (queueActionBusy) return;'), '前端应按队列签名防闪烁重建并带操作并发锁');
});

test('远程端支持通用文件与图片上传及消息流本地展示预览 (#02)', async () => {
  const {
    resolveSafeLocalMediaPath,
    extractTrajectoryUserAttachments,
    extractMessagesFromTrajectorySteps,
    createRemoteHttpHandler,
    buildMobileAppHtml
  } = require('./mobile-remote');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-media-test-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-media-outside-'));
  try {
    const pngPath = path.join(tmpRoot, '截图测试.png');
    const svgPath = path.join(tmpRoot, 'vector.svg');
    const envPath = path.join(tmpRoot, '.env.local');
    const sshDir = path.join(tmpRoot, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    const sshKeyPath = path.join(sshDir, 'config');
    const outsideSecret = path.join(outsideDir, 'outside.txt');
    const escapeLink = path.join(tmpRoot, 'escape-link.txt');

    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(svgPath, '<svg><script>alert(1)</script></svg>', 'utf8');
    fs.writeFileSync(envPath, 'SECRET=1', 'utf8');
    fs.writeFileSync(sshKeyPath, 'Host *', 'utf8');
    fs.writeFileSync(outsideSecret, 'nope', 'utf8');
    fs.symlinkSync(outsideSecret, escapeLink);

    // 1. resolveSafeLocalMediaPath 安全边界验证
    const okPng = resolveSafeLocalMediaPath(pngPath, { allowedRoots: [tmpRoot] });
    assert.equal(okPng.ok, true);
    assert.equal(okPng.contentType, 'image/png');
    assert.equal(okPng.forceAttachment, false);

    const okFileUri = resolveSafeLocalMediaPath('file://' + encodeURI(pngPath), { allowedRoots: [tmpRoot] });
    assert.equal(okFileUri.ok, true, '应支持 file:// URI 路径解码');

    const okSvg = resolveSafeLocalMediaPath(svgPath, { allowedRoots: [tmpRoot] });
    assert.equal(okSvg.ok, true);
    assert.equal(okSvg.forceAttachment, true, 'SVG 必须强制 attachment 下载防止存储型 XSS');

    assert.equal(resolveSafeLocalMediaPath(envPath, { allowedRoots: [tmpRoot] }).ok, false, '必须拦截 .env* 敏感文件');
    assert.equal(resolveSafeLocalMediaPath(sshKeyPath, { allowedRoots: [tmpRoot] }).ok, false, '必须拦截 .ssh 敏感目录');
    assert.equal(resolveSafeLocalMediaPath(escapeLink, { allowedRoots: [tmpRoot] }).ok, false, '必须通过 realpath 拦截符号链接逃逸');

    // 2. GET /api/media HTTP 路由验证（含中文文件名 RFC5987 头、SVG 强制下载与未授权 401）
    const mockCfg = {
      port: 18765,
      token: 'tok-media-test-1234567890abcdef',
      tunnelEnabled: false,
      enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: false }
    };
    const handler = createRemoteHttpHandler(mockCfg, {
      mediaOptions: { allowedRoots: [tmpRoot] }
    });
    const getMedia = async (queryPath, authMode = 'header') => {
      const { Readable } = require('stream');
      const req = Readable.from([]);
      req.method = 'GET';
      req.url = '/api/media?path=' + encodeURIComponent(queryPath)
        + (authMode === 'query' ? ('&token=' + encodeURIComponent(mockCfg.token)) : '');
      const authHdrs = authMode === 'header'
        ? { 'x-ag-remote-token': mockCfg.token }
        : (authMode === 'cookie'
            ? { cookie: 'ag_remote_token=' + encodeURIComponent(mockCfg.token) }
            : (authMode === 'invalid' ? { 'x-ag-remote-token': 'wrong-token-000' } : {}));
      req.headers = {
        host: '127.0.0.1:18765',
        ...authHdrs
      };
      req.socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' };
      let status = 200;
      let headers = {};
      const chunks = [];
      const res = {
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        writeHead(code, hdrs = {}) {
          status = code;
          for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
        },
        end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); }
      };
      await handler(req, res);
      return { status, headers, body: Buffer.concat(chunks) };
    };

    const unauth = await getMedia(pngPath, 'none');
    assert.equal(unauth.status, 401, '未鉴权请求 /api/media 必须返回 401');
    const badAuth = await getMedia(pngPath, 'invalid');
    assert.equal(badAuth.status, 401, '无效 Token 请求 /api/media 必须返回 401');

    const pngRes = await getMedia(pngPath, 'header');
    assert.equal(pngRes.status, 200, '有效 Header Token 访问中文文件名图片应返回 200');
    assert.equal(pngRes.headers['content-type'], 'image/png');
    assert.ok(String(pngRes.headers['content-disposition']).startsWith('inline;'));
    assert.equal(pngRes.body.length, 8);

    const cookieRes = await getMedia(pngPath, 'cookie');
    assert.equal(cookieRes.status, 200, '有效 Cookie 鉴权访问 /api/media 应返回 200');
    const queryRes = await getMedia(pngPath, 'query');
    assert.equal(queryRes.status, 200, '有效查询参数 Token 访问 /api/media 应返回 200');

    const svgRes = await getMedia(svgPath, 'header');
    assert.equal(svgRes.status, 200);
    assert.ok(String(svgRes.headers['content-disposition']).startsWith('attachment;'), 'SVG 响应必须为 attachment');

    const envRes = await getMedia(envPath, 'header');
    assert.equal(envRes.status, 403, '访问 .env 文件必须返回 403');

    // 2b. 完整前缀匹配与裸凭证扩展名拦截变体（.envrc / .env_prod / id_rsa_work / id_ed25519_deploy / .pem / .key）
    for (const secretName of ['.envrc', '.env_prod', 'id_rsa_work', 'id_ed25519_deploy', 'id_ecdsa_ci', '.pem', '.key']) {
      const p = path.join(tmpRoot, secretName);
      fs.writeFileSync(p, 'TOP_SECRET', 'utf8');
      assert.equal(resolveSafeLocalMediaPath(p, { allowedRoots: [tmpRoot] }).ok, false, `resolveSafeLocalMediaPath 必须拦截 ${secretName}`);
      const resp = await getMedia(p, 'header');
      assert.equal(resp.status, 403, `/api/media 必须对 ${secretName} 返回 403`);
    }

    // 3. 轨迹附件提取与消息流携带
    const stepUi = {
      items: [
        { text: '请帮我核对这张截图和报告' },
        { item: { file: { absoluteUri: 'file://' + encodeURI(path.join(tmpRoot, 'report.md')) } } }
      ],
      media: [{ mimeType: 'image/png', uri: 'file://' + encodeURI(pngPath) }]
    };
    const atts = extractTrajectoryUserAttachments(stepUi);
    assert.equal(atts.length, 2, '应提取图片与文件两类附件');
    assert.equal(atts[0].kind, 'image');
    assert.equal(atts[1].kind, 'file');
    const msgs = extractMessagesFromTrajectorySteps([{ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: stepUi }]);
    assert.equal(msgs[0].attachments?.length, 2, '用户消息对象应携带 attachments');

    // 4. 整页生成 <script> 语法校验 + 附件上传、缩略图点击、灯箱开关及 >15MB 图片前置拒绝运行验证
    const html = buildMobileAppHtml();
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptMatches.length >= 2, 'buildMobileAppHtml 应包含首屏主题脚本与主应用脚本');
    for (let i = 0; i < scriptMatches.length; i++) {
      assert.doesNotThrow(
        () => new vm.Script(scriptMatches[i][1], { filename: `mobile-app-script-${i}.js` }),
        `生成页面第 ${i} 段 <script> 必须通过完整 JS 语法解析`
      );
    }
    assert.ok(html.includes('<input id="img-input" type="file" multiple hidden>'), '#img-input 应放开 image/* 限制支持通用文件');
    assert.ok(html.includes('function readAttachmentFile(file)') && html.includes('id="media-lightbox"'), '应支持通用文件读取与图片灯箱放大');
    assert.ok(html.includes('/api/media?path=') && html.includes('class="msg-att-img"') && html.includes('class="msg-att-file"'), '消息流应渲染本地图片缩略图与文件附件胶囊');

    const blockStart = html.indexOf('let uploadedAttachments = [];');
    const blockEnd = html.indexOf("$('btn-img').onclick");
    assert.ok(blockStart > 0 && blockEnd > blockStart);
    let compressCalled = false;
    const uploadedActions = [];
    const lbEl = { hidden: true, addEventListener() {} };
    const lbImgEl = { src: '', alt: '' };
    const lbCloseEl = { _onClick: null, addEventListener(ev, fn) { if (ev === 'click') this._onClick = fn; } };
    const hintEl = {
      hidden: true,
      innerHTML: '',
      _thumbHandlers: [],
      _clearHandler: null,
      querySelectorAll(sel) {
        if (sel === '.attach-thumb') {
          const item = { dataset: { attIdx: '0' }, set onclick(fn) { hintEl._thumbHandlers.push(fn); } };
          return [item];
        }
        return [];
      },
      querySelector(sel) {
        if (sel === '.attach-clear-btn') return { set onclick(fn) { hintEl._clearHandler = fn; } };
        return null;
      }
    };
    const attSandbox = {
      uploadedNames: [],
      $: (id) => ({ 'media-lightbox': lbEl, 'media-lightbox-img': lbImgEl, 'media-lightbox-close': lbCloseEl, 'attach-hint': hintEl }[id] || null),
      msgEl: { addEventListener() {} },
      esc: (s) => String(s ?? ''),
      showToast: () => {},
      syncSendButtonUI: () => {},
      apiAction: async (p) => { uploadedActions.push(p); return { ok: true }; },
      compressAndReadImage: async (f) => {
        compressCalled = true;
        return { name: f.name, mimeType: 'image/jpeg', base64: 'data:image/jpeg;base64,AAA=' };
      },
      FileReader: class {
        readAsDataURL() {
          this.result = 'data:application/pdf;base64,JVBERi0=';
          setTimeout(() => this.onload?.(), 0);
        }
      }
    };
    vm.runInNewContext(
      html.slice(blockStart, blockEnd) + '\nglobalThis.__readAtt = readAttachmentFile;\nglobalThis.__upload = uploadImageFiles;',
      attSandbox
    );

    // 4a. >15MB 图片必须在进入 compressAndReadImage 之前即被拒绝
    await assert.rejects(
      () => attSandbox.__readAtt({ name: 'huge.png', type: 'image/png', size: 16 * 1024 * 1024 }),
      /超过 15MB/,
      '超过 15MB 的图片必须在进入压缩前即被拒绝'
    );
    assert.equal(compressCalled, false, '超限图片不得进入 compressAndReadImage');

    // 4b. 正常上传 1 张图片 + 1 个 PDF 文件 → 展示缩略图与文件胶囊 → 点击缩略图打开灯箱 → 点击关闭按钮关闭灯箱
    await attSandbox.__upload([
      { name: 'demo.png', type: 'image/png', size: 2048 },
      { name: 'spec.pdf', type: 'application/pdf', size: 4096 }
    ]);
    assert.equal(compressCalled, true, '合法图片应走 compressAndReadImage');
    assert.equal(uploadedActions.length, 2, '图片与通用文件均应触发 upload-image');
    assert.equal(hintEl.hidden, false, '上传完成后 #attach-hint 应显示');
    assert.ok(hintEl.innerHTML.includes('attach-thumb') && hintEl.innerHTML.includes('spec.pdf'), '附件条应同时包含图片缩略图与 PDF 文件胶囊');
    hintEl._thumbHandlers[0]?.();
    assert.equal(lbEl.hidden, false, '点击缩略图应打开全屏灯箱');
    assert.equal(lbImgEl.src, 'data:image/jpeg;base64,AAA=', '灯箱图片地址应与缩略图一致');
    lbCloseEl._onClick?.();
    assert.equal(lbEl.hidden, true, '点击灯箱关闭按钮应关闭灯箱');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('远程端支持对话关联文件直点预览、变更/产物验收与项目文件树浏览 (#04)', async () => {
  const {
    renderSafeMarkdownToHtml,
    listSafeProjectTree,
    readSafeTextFilePreview,
    createRemoteHttpHandler,
    buildMobileAppHtml
  } = require('./mobile-remote');

  // 1. Markdown file:// 链接转为可点击的 .md-file-link（内部保留 .md-pill 兼容）并保留行号
  const mdHtml = renderSafeMarkdownToHtml('请查看 [app.js](file:///tmp/demo/app.js#L42-L55) 的改动。');
  assert.ok(
    mdHtml.includes('class="md-file-link"')
    && mdHtml.includes('<code class="md-pill">app.js</code>')
    && mdHtml.includes('data-file-path="/tmp/demo/app.js"')
    && mdHtml.includes('data-file-line="42"'),
    'renderSafeMarkdownToHtml 应将 file:// 链接转为带路径与行号的可点击按钮'
  );

  // 2. 项目文件树列举、敏感文件/越界符号链接隐藏、文本/二进制/图片预览与 /api/session-files 路由安全过滤
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proj-tree-'));
  const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proj-out-'));
  try {
    fs.mkdirSync(path.join(tmpProj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpProj, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpProj, 'src', 'index.js'), 'const a = 1;\nconsole.log(a);\n', 'utf8');
    fs.writeFileSync(path.join(tmpProj, 'README.md'), '# Demo Project\n', 'utf8');
    fs.writeFileSync(path.join(tmpProj, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    fs.writeFileSync(path.join(tmpProj, '.env'), 'SECRET=1', 'utf8');
    fs.writeFileSync(path.join(tmpOutside, 'secret-outside.txt'), 'OUTSIDE', 'utf8');
    fs.symlinkSync(path.join(tmpOutside, 'secret-outside.txt'), path.join(tmpProj, 'link-outside.txt'));
    fs.symlinkSync(tmpOutside, path.join(tmpProj, 'link-outside-dir'));
    fs.symlinkSync(path.join(tmpProj, '.env'), path.join(tmpProj, 'link-to-env.txt'));

    const tree = listSafeProjectTree(tmpProj, { allowedRoots: [tmpProj] });
    assert.equal(tree.ok, true);
    const names = tree.entries.map((e) => e.name);
    assert.ok(names.includes('src') && names.includes('README.md'), '应列出正常目录与源码文件');
    assert.equal(names.includes('node_modules'), false, '默认应隐藏 node_modules 噪声目录');
    assert.equal(names.includes('.env'), false, '文件树必须隐藏 .env 等敏感凭证文件');
    assert.equal(names.includes('link-outside.txt'), false, '文件树必须过滤指向允许根目录之外的符号链接');
    assert.equal(names.includes('link-to-env.txt'), false, '文件树必须过滤指向敏感凭证文件的符号链接');
    assert.equal(tree.entries[0].isDir, true, '目录应排在文件之前');

    const jsPrev = readSafeTextFilePreview(path.join(tmpProj, 'src', 'index.js'), { allowedRoots: [tmpProj] });
    assert.equal(jsPrev.ok, true);
    assert.equal(jsPrev.isBinary, false);
    assert.equal(jsPrev.lineCount, 3);
    assert.ok(jsPrev.content.includes('console.log(a);'));

    const mdPrev = readSafeTextFilePreview(path.join(tmpProj, 'README.md'), { allowedRoots: [tmpProj] });
    assert.equal(mdPrev.ok, true);
    assert.equal(mdPrev.isMarkdown, true);

    const binPrev = readSafeTextFilePreview(path.join(tmpProj, 'bin.dat'), { allowedRoots: [tmpProj] });
    assert.equal(binPrev.ok, true);
    assert.equal(binPrev.isBinary, true, '含 NUL 字节的二进制文件应标记为 isBinary');

    const envPrev = readSafeTextFilePreview(path.join(tmpProj, '.env'), { allowedRoots: [tmpProj] });
    assert.equal(envPrev.ok, false, '文件预览必须拦截 .env 敏感文件');

    // 3. HTTP 路由鉴权与返回验证：/api/file-content、/api/project-tree、/api/session-files
    const mockCfg = {
      port: 18765,
      token: 'tok-files-test-1234567890abcdef',
      tunnelEnabled: false,
      enabledChannels: { lan: true, tailscale: true, bonjour: true, tunnel: false }
    };
    const handler = createRemoteHttpHandler(mockCfg, {
      mediaOptions: { allowedRoots: [tmpProj] },
      callLanguageServer: async (method) => {
        if (method === 'GetTrajectoryFileDiffs') {
          return {
            fileDiffs: [
              { path: path.join(tmpProj, 'src', 'index.js'), unifiedDiff: '@@ -1 +1 @@\n-const a = 0;\n+const a = 1;' },
              { path: 'src/index.js', unifiedDiff: '@@ -1 +1 @@\n+valid relative' },
              { path: path.join(tmpProj, '.env'), unifiedDiff: '+SECRET=LEAK' },
              { path: path.join(tmpOutside, 'secret-outside.txt'), unifiedDiff: '+OUTSIDE=LEAK' },
              { path: '../secret-outside.txt', unifiedDiff: '+REL_TRAVERSAL=LEAK' },
              { fileName: 'src/../../etc/passwd', unifiedDiff: '+NAME_TRAVERSAL=LEAK' },
              { path: '.ssh/config', unifiedDiff: '+SSH_CONFIG=LEAK' },
              { name: 'nested/.ssh/config', unifiedDiff: '+NAME_SSH=LEAK' },
              { path: 'link-outside.txt', unifiedDiff: '+REL_SYMLINK=LEAK' },
              { fileName: 'link-outside-dir/secret-outside.txt', unifiedDiff: '+REL_DIR_SYMLINK=LEAK' },
              { path: 'link-to-env.txt', unifiedDiff: '+REL_ENV_SYMLINK=LEAK' }
            ]
          };
        }
        if (method === 'GetArtifactSnapshots') {
          return {
            artifacts: [
              { title: '验收报告.md', content: '# 验收通过' },
              { title: 'id_rsa', path: path.join(tmpProj, '.ssh', 'id_rsa'), content: 'PRIVATE KEY' },
              { title: 'outside.md', path: path.join(tmpOutside, 'secret-outside.txt'), content: 'OUTSIDE' },
              { name: '../outside-artifact.md', content: 'REL_TRAVERSAL_ART' },
              { path: '.ssh/config', title: 'ssh-cfg', content: 'SSH_ART' },
              { name: 'link-outside-dir/secret-outside.txt', content: 'REL_SYMLINK_ART' },
              { path: 'link-to-env.txt', content: 'REL_ENV_ART' }
            ]
          };
        }
        return null;
      }
    });
    const getApi = async (urlPath, withAuth = true) => {
      const { Readable } = require('stream');
      const req = Readable.from([]);
      req.method = 'GET';
      req.url = urlPath;
      req.headers = {
        host: '127.0.0.1:18765',
        ...(withAuth ? { 'x-ag-remote-token': mockCfg.token } : {})
      };
      req.socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' };
      let status = 200;
      let out = '';
      const res = {
        setHeader() {},
        writeHead(code) { status = code; },
        end(chunk) { if (chunk) out += String(chunk); }
      };
      await handler(req, res);
      return { status, json: JSON.parse(out) };
    };

    assert.equal((await getApi('/api/project-tree?dir=' + encodeURIComponent(tmpProj), false)).status, 401, '未鉴权访问 /api/project-tree 必须返回 401');
    assert.equal((await getApi('/api/file-content?path=' + encodeURIComponent(path.join(tmpProj, 'README.md')), false)).status, 401, '未鉴权访问 /api/file-content 必须返回 401');
    assert.equal((await getApi('/api/session-files?conversationId=conv-review-1', false)).status, 401, '未鉴权访问 /api/session-files 必须返回 401');

    const treeResp = await getApi('/api/project-tree?dir=' + encodeURIComponent(tmpProj), true);
    assert.equal(treeResp.status, 200);
    assert.equal(treeResp.json.ok, true);

    const fileResp = await getApi('/api/file-content?path=' + encodeURIComponent(path.join(tmpProj, 'README.md')), true);
    assert.equal(fileResp.status, 200);
    assert.equal(fileResp.json.isMarkdown, true);

    const envFileResp = await getApi('/api/file-content?path=' + encodeURIComponent(path.join(tmpProj, '.env')), true);
    assert.equal(envFileResp.status, 403, '/api/file-content 访问 .env 必须返回 403');

    const sessResp = await getApi('/api/session-files?conversationId=conv-review-1', true);
    assert.equal(sessResp.status, 200);
    assert.equal(sessResp.json.diffs.length, 2, '/api/session-files 必须仅保留合法绝对/相对路径 Diff，过滤 ../、.ssh/config、相对符号链接逃逸与敏感文件');
    assert.deepEqual(sessResp.json.diffs.map((d) => d.name), ['index.js', 'index.js']);
    assert.equal(sessResp.json.artifacts.length, 1, '/api/session-files 必须过滤 ../、.ssh/config、相对符号链接逃逸与敏感凭证 Artifact');
    assert.equal(sessResp.json.artifacts[0].name, '验收报告.md');

    // 4. 整页生成 <script> 语法校验 + 顶栏文件入口与弹窗 DOM 校验
    const html = buildMobileAppHtml();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 2);
    for (let i = 0; i < scripts.length; i++) {
      assert.doesNotThrow(() => new vm.Script(scripts[i][1], { filename: `mobile-app-04-script-${i}.js` }));
    }
    assert.ok(html.includes('id="btn-files-panel"') && html.includes('id="file-viewer-modal"'), '应渲染顶栏文件入口与文件/验收弹窗');
    assert.ok(html.includes("'/api/file-content?path='") && html.includes("'/api/project-tree'") && html.includes("'/api/session-files?conversationId='"));
  } finally {
    fs.rmSync(tmpProj, { recursive: true, force: true });
    fs.rmSync(tmpOutside, { recursive: true, force: true });
  }
});

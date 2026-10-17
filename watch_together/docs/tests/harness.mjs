/* =========================================================
   WatchTogether — بيئة اختبار مشتركة (بلا متصفح)
   ---------------------------------------------------------
   تبني DOM وهمياً من room.html ثم تشغّل سكربتات المشروع داخله.
   تستعملها: room-dom.mjs  و  join-room.mjs
   ========================================================= */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const base = path.resolve(__dirname, '../..');

/* ==================== DOM وهمي ==================== */
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => x && this.set.add(x)); this.sync(); }
  remove(...c) { c.forEach(x => this.set.delete(x)); this.sync(); }
  toggle(c, force) {
    if (!c) return;
    const on = force === undefined ? !this.set.has(c) : !!force;
    on ? this.set.add(c) : this.set.delete(c);
    this.sync();
  }
  contains(c) { return this.set.has(c); }
  sync() { this.el._className = [...this.set].join(' '); }
}

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._className = '';
    this.classList = new ClassList(this);
    this.style = new Proxy({ setProperty() { }, removeProperty() { }, cssText: '' }, {
      get: (o, k) => (k in o ? o[k] : ''),
      set: (o, k, v) => { o[k] = v; return true; }
    });
    this.dataset = {};
    this.attrs = {};
    this._text = '';
    this._html = '';
    this._handlers = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.selectionStart = 0;
    this.isContentEditable = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.offsetWidth = 100;
    this.type = '';
    /* حقول عنصر <video> الوهمي */
    this.currentTime = 0;
    this.duration = 0;
    this.paused = true;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.buffered = null;
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    const re = /<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const c = new El(m[1]);
      const attrs = m[2] || '';
      const idm = attrs.match(/\bid="([^"]*)"/); if (idm) c.id = idm[1];
      if (/\bhidden\b/.test(attrs)) c.hidden = true;
      const cm = attrs.match(/class="([^"]*)"/); if (cm) c.className = cm[1];
      const tm = attrs.match(/type="([^"]*)"/); if (tm) c.type = tm[1];
      Array.from(attrs.matchAll(/data-([a-zA-Z-]+)="([^"]*)"/g)).forEach(dm => { c.dataset[dm[1]] = dm[2]; c.attrs['data-' + dm[1]] = dm[2]; });
      c.parentNode = this;
      this.children.push(c);
    }
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChild(n, old) {
    const i = this.children.indexOf(old);
    if (i >= 0) this.children[i] = n;
    n.parentNode = this;
    if (old) old.parentNode = null;
    return old;
  }
  insertBefore(n, ref) {
    const i = this.children.indexOf(ref);
    if (i >= 0) this.children.splice(i, 0, n);
    else this.children.push(n);
    n.parentNode = this;
    return n;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'id') this.id = v;
    /* كما في المتصفح: data-* يحدّث dataset أيضاً */
    if (typeof k === 'string' && k.indexOf('data-') === 0) this.dataset[k.slice(5)] = v;
  }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) { if (this._handlers[ev]) this._handlers[ev] = this._handlers[ev].filter(f => f !== fn); }
  dispatch(ev, e) {
    const list = this._handlers[ev] || [];
    const ev2 = Object.assign({
      type: ev, target: this, clientX: 0, key: '', pointerId: 1,
      preventDefault() { }, stopPropagation() { }
    }, e || {});
    list.forEach(fn => fn(ev2));
    return list.length;
  }
  focus() { this._focused = true; }
  click() { this.dispatch('click', {}); }

  /* ---- وسائط وهمية (mp4/HLS) حتى يصير المشغّل «جاهزاً» في الاختبار ---- */
  load() { }
  play() { this.paused = false; this.dispatch('play', {}); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatch('pause', {}); }
  canPlayType() { return ''; }
  get ended() { return this._ended === true; }
  set ended(v) { this._ended = !!v; }
  setPointerCapture() { }
  scrollIntoView() { }
  requestFullscreen() { }
  webkitRequestFullscreen() { }
  animate() { return { finished: Promise.resolve() }; }
  closest(sel) {
    let n = this;
    while (n) { if (sel.startsWith('.') && n.classList.contains(sel.slice(1))) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return this._query(sel)[0] || null; }
  querySelectorAll(sel) { return this._query(sel); }
  _query(sel) {
    if (sel.includes(',')) return [...new Set(sel.split(',').flatMap(s => this._query(s.trim())))];
    const out = [];
    const match = (n) => {
      if (sel.startsWith('#')) return n.id === sel.slice(1);
      if (sel.startsWith('.')) return n.classList.contains(sel.slice(1));
      if (sel.startsWith('[')) {
        const m = sel.match(/^\[([a-zA-Z-]+)\]?$/);
        if (m) return n.attrs[m[1]] !== undefined || (m[1].startsWith('data-') && n.dataset[m[1].slice(5)] !== undefined);
        const kv = sel.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
        if (kv) {
          const key = kv[1].startsWith('data-') ? null : kv[1];
          if (key) return n.attrs[key] === kv[2];
          return n.dataset[kv[1].slice(5)] === kv[2];
        }
        return false;
      }
      return n.tagName === sel.toUpperCase();
    };
    const walk = (n) => n.children.forEach(c => { if (match(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  matches() { return false; }
  getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 22 }; }
}

/* ==================== بناء الصفحة من room.html ==================== */
export function buildRoomDom() {
  const html = fs.readFileSync(path.join(base, 'room.html'), 'utf8');
  const byId = new Map();
  let m;
  const ID_RE = /id="([A-Za-z0-9_-]+)"/g;
  while ((m = ID_RE.exec(html))) {
    if (byId.has(m[1])) continue;
    const e = new El('div');
    e.id = m[1];
    byId.set(m[1], e);
  }

  const ID_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)\bid="([A-Za-z0-9_-]+)"([^>]*)>/g;
  Array.from(html.matchAll(ID_TAG_RE)).forEach(mm => {
    const tag = mm[1];
    const el2 = byId.get(mm[3]);
    if (!el2) return;
    el2.tagName = tag.toUpperCase();
    const all = ' ' + mm[2] + ' ' + mm[4] + ' ';
    const attrPairs = Array.from(all.matchAll(/([a-zA-Z-]+)="([^"]*)"/g));
    attrPairs.forEach(pair => { el2.attrs[pair[1]] = pair[2]; });
    if (/\shidden(\s|=|>|$)/.test(all)) el2.hidden = true;
    const cm = all.match(/\sclass="([^"]*)"/);
    if (cm) el2.className = cm[1];
    const innerStart = mm.index + mm[0].length;
    const closeAt = html.indexOf('</' + tag + '>', innerStart);
    const inner = closeAt < 0 ? '' : html.slice(innerStart, closeAt);
    if (inner && inner.length < 4000 && !/<(section|main|aside|form|div)\b/.test(inner)) {
      Array.from(inner.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)).forEach(sm => {
        const c = new El(sm[1]);
        const attrs = sm[2] || '';
        const scm = attrs.match(/class="([^"]*)"/);
        if (scm) c.className = scm[1];
        Array.from(attrs.matchAll(/data-([a-zA-Z-]+)="([^"]*)"/g)).forEach(dm => { c.dataset[dm[1]] = dm[2]; c.attrs['data-' + dm[1]] = dm[2]; });
        const idm = attrs.match(/\bid="([A-Za-z0-9_-]+)"/);
        if (idm) c.id = idm[1];
        c.parentNode = el2;
        el2.children.push(c);
      });
    }
  });

  const body = new El('body');
  byId.forEach(e => body.appendChild(e));

  /* أزرار التفاعلات (react-row) كما في HTML */
  const reactRowHtml = (html.match(/<div class="react-row"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1];
  const reactRow = byId.get('reactRow');
  if (reactRow) {
    Array.from(reactRowHtml.matchAll(/<button[^>]*data-react="([^"]+)"[^>]*>/g)).forEach(mm => {
      const b = new El('button');
      b.dataset.react = mm[1];
      b.attrs['data-react'] = mm[1];
      b.textContent = mm[1];
      reactRow.appendChild(b);
    });
  }
  return { html, byId, body, El };
}

/* ==================== بيئة متصفح كاملة ==================== */
/**
 * @param {object} o
 *   o.search      ?id=…&host=1&v=…   (شريط بحث الصفحة)
 *   o.WebSocket   صنف WebSocket (حقيقي أو وهمي)
 *   o.fetch       دالة fetch (وهمية أو حقيقية)
 *   o.scripts     قائمة السكربتات (افتراضياً كل سكربتات الغرفة)
 */
export function createRoomEnv(o = {}) {
  const { html, byId, body } = buildRoomDom();
  (o.omitIds || []).forEach(id => { byId.get(id)?.remove(); byId.delete(id); });
  const timeouts = new Set(), intervals = new Set();
  const timers = {
    setTimeout(fn, ms) { const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms); timeouts.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timeouts.delete(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { clearInterval(id); intervals.delete(id); }
  };
  const store = o.store || {};
  const localStorageStub = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };

  const channels = o.channels || {};
  class BroadcastChannelStub {
    constructor(topic) { this.topic = topic; (channels[topic] = channels[topic] || []).push(this); }
    postMessage(d) {
      (channels[this.topic] || []).forEach(c => {
        if (c !== this && c.onmessage) setTimeout(() => c.onmessage({ data: JSON.parse(JSON.stringify(d)) }), 0);
      });
    }
    close() { channels[this.topic] = (channels[this.topic] || []).filter(c => c !== this); }
  }

  const documentStub = {
    body,
    head: new El('head'),
    documentElement: new El('html'),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    addEventListener: (ev, fn) => (documentStub._h[ev] = documentStub._h[ev] || []).push(fn),
    dispatch(ev, e) {
      (documentStub._h[ev] || []).forEach(fn => fn(Object.assign({ type: ev, target: body, preventDefault() { } }, e)));
    },
    title: '', hidden: false, readyState: 'complete',
    fullscreenElement: null, webkitFullscreenElement: null,
    exitFullscreen() { }, webkitExitFullscreen() { },
    execCommand: () => true,
    _h: {}
  };

  const sandbox = {
    console,
    Date, Math, JSON, Promise, ...timers, AbortController,
    Uint32Array, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, Symbol, Blob,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    URLSearchParams, URL, Intl, Proxy, MutationObserver: class { observe() { } disconnect() { } },
    document: documentStub,
    localStorage: localStorageStub,
    sessionStorage: {
      _d: o.session || {},
      getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    navigator: {
      clipboard: { writeText: async () => true, readText: async () => '' },
      userAgent: 'node', share: null, sendBeacon: () => true
    },
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967295); return a; } },
    location: {
      origin: o.origin || 'http://localhost:8080',
      host: o.host || 'localhost:8080',
      protocol: 'http:',
      search: o.search || '?id=ABC123',
      pathname: '/room.html',
      href: '',
      replace(u) { this.href = u; },
      assign(u) { this.href = u; }
    },
    matchMedia: () => ({ matches: false, addEventListener() { } }),
    BroadcastChannel: BroadcastChannelStub,
    WebSocket: o.WebSocket || function () { throw new Error('ws غير متاح في الاختبار'); },
    fetch: o.fetch || (() => Promise.reject(new Error('الشبكة محجوبة في الاختبار'))),
    requestAnimationFrame: f => setTimeout(f, 0),
    addEventListener: (ev, fn) => (sandbox._wh[ev] = sandbox._wh[ev] || []).push(fn),
    removeEventListener() { },
    confirm: () => true,
    alert: () => { },
    _wh: {},
    YT: null, Hls: null, qrcode: null
  };
  /* حقن كائنات إضافية (FormData / XMLHttpRequest / URL…) لاختبار الرفع */
  Object.assign(sandbox, o.globals || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const scripts = o.scripts || ['assets/js/config.js', 'assets/js/util.js', 'assets/js/icons.js',
    'assets/js/auth.js', 'assets/js/transport.js', 'assets/js/player.js', 'assets/js/media.js', 'assets/js/room.js'];
  const loaded = [];
  for (const f of scripts) {
    try {
      vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sandbox, { filename: f });
      loaded.push({ file: f, ok: true });
    } catch (e) {
      loaded.push({ file: f, ok: false, error: e });
    }
  }

  const dispose = () => {
    timeouts.forEach(clearTimeout); intervals.forEach(clearInterval);
    timeouts.clear(); intervals.clear();
  };
  return { sandbox, documentStub, byId, body, html, store, channels, loaded, El, dispose };
}

export const wait = (ms) => new Promise(r => setTimeout(r, ms));

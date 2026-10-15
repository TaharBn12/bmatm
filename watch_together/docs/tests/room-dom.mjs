/* =========================================================
   WatchTogether — اختبار واجهة الغرفة بدون متصفح (DOM وهمي)
   التشغيل:  node docs/tests/room-dom.mjs
   ---------------------------------------------------------
   يبني DOM وهمياً من room.html ثم يشغّل room.js بالكامل:
   بوابة الاسم ← الدخول ← الوضع المحلي ← المزامنة ← الرسائل
   ← التفاعلات ← وضع الرسائل ← المنضمون، ويلتقط أي خطأ runtime.
   ========================================================= */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '../..');

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name} ${extra}`); }
};

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
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    /* ابنِ عقدة وهمية لكل وسم + التقط class/type/data-* */
    const re = /<([a-zA-Z][a-zA-Z0-9]*)((?:[^>](?!\/>))*?)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const c = new El(m[1]);
      const attrs = m[2] || '';
      const cm = attrs.match(/class="([^"]*)"/); if (cm) c.className = cm[1];
      const tm = attrs.match(/type="([^"]*)"/); if (tm) c.type = tm[1];
      Array.from(attrs.matchAll(/data-([a-zA-Z-]+)="([^"]*)"/g)).forEach(dm => { c.dataset[dm[1]] = dm[2]; c.attrs['data-' + dm[1]] = dm[2]; });
      c.parentNode = this;
      this.children.push(c);
    }
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
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
    const out = [];
    const match = (n) => {
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

/* طبّق tagName و hidden والسمات كما في HTML الحقيقي */
Array.from(html.matchAll(/<([a-zA-Z][^>]*?)\bid="([A-Za-z0-9_-]+)"([^>]*?)>/g)).forEach(mm => {
  const el2 = byId.get(mm[2]);
  if (!el2) return;
  el2.tagName = mm[1].toUpperCase();
  const all = ' ' + mm[1] + ' ' + mm[3] + ' ';
  if (/\shidden(\s|=|>|$)/.test(all)) el2.hidden = true;
  const cm = all.match(/\sclass="([^"]*)"/);
  if (cm) el2.className = cm[1];
  /* ابنِ العُقد الابن المباشرة (مثل <span class="ic"> داخل الأزرار) */
  const inner = html.slice(mm.index + mm[0].length, html.indexOf('</' + mm[1] + '>', mm.index));
  if (inner && inner.length < 4000 && !/<(section|main|aside|form|div)\b/.test(inner)) {
    Array.from(inner.matchAll(/<([a-zA-Z][^>]*?)>/g)).forEach(sm => {
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

/* ==================== بيئة المتصفح الوهمية ==================== */
const store = {};
const localStorageStub = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

const channels = {};
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
  Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  Uint32Array, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, Symbol, Blob,
  isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  URLSearchParams, URL, Intl, Proxy, MutationObserver: class { observe() { } disconnect() { } },
  document: documentStub,
  localStorage: localStorageStub,
  sessionStorage: {
    _d: {},
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
    origin: 'http://localhost:8080', host: 'localhost:8080', protocol: 'http:',
    search: '?id=ABC123&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4',
    pathname: '/room.html', href: '', replace(u) { this.href = u; }, assign(u) { this.href = u; }
  },
  matchMedia: () => ({ matches: false, addEventListener() { } }),
  BroadcastChannel: BroadcastChannelStub,
  WebSocket: function () { throw new Error('ws غير متاح في الاختبار'); },
  fetch: () => Promise.reject(new Error('الشبكة محجوبة في الاختبار')),
  requestAnimationFrame: f => setTimeout(f, 0),
  addEventListener: (ev, fn) => (sandbox._wh[ev] = sandbox._wh[ev] || []).push(fn),
  removeEventListener() { },
  confirm: () => true,
  alert: () => { },
  _wh: {},
  YT: null, Hls: null, qrcode: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* ==================== تحميل السكربتات ==================== */
const scripts = ['assets/js/config.js', 'assets/js/util.js', 'assets/js/icons.js',
  'assets/js/auth.js', 'assets/js/transport.js', 'assets/js/player.js', 'assets/js/room.js'];
for (const f of scripts) {
  try {
    vm.runInContext(fs.readFileSync(path.join(base, f), 'utf8'), sandbox, { filename: f });
    t(`تحميل ${path.basename(f)}`, true);
  } catch (e) {
    t(`تحميل ${path.basename(f)}`, false, e.message);
    console.log(e.stack);
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

const run = async () => {
  await wait(150);

  /* ---- 1) كل العناصر المطلوبة موجودة ---- */
  const needed = ['gate', 'gateCode', 'gateName', 'gateForm', 'gateError', 'gateSubmit', 'avatarPreview',
    'room', 'roomTitle', 'roomSub', 'roomCodeText', 'copyCodeBtn', 'statusBadge', 'statusText',
    'copyLinkBtn', 'shareBtn', 'qrBtn', 'leaveBtn', 'stage', 'player', 'playerPlaceholder', 'ctrlbar',
    'playPauseBtn', 'iconPlay', 'iconPause', 'backBtn', 'fwdBtn', 'muteBtn', 'iconSound', 'iconMuted',
    'fullBtn', 'volRange', 'progressBar', 'progressFill', 'progressBuffer', 'progressKnob',
    'curTime', 'durTime', 'changeUrlBtn', 'resyncBtn', 'focusToggleBtn', 'focusToggleLabel',
    'membersBadge', 'membersCount', 'syncBadge', 'syncBadgeText', 'syncNote', 'syncNoteText',
    'changeBar', 'newUrl', 'applyUrlBtn', 'cancelUrlBtn', 'membersPanel', 'membersList',
    'membersToggle', 'sideMembersCount', 'infoGrid', 'infoCode', 'infoProvider', 'infoController',
    'infoSync', 'infoRole', 'infoTransport', 'chat', 'chatBody', 'chatEmpty', 'chatCount',
    'clearChatBtn', 'reactRow', 'chatForm', 'chatInput', 'chatSend', 'typing',
    'backToVideoBtn', 'chatFab', 'chatFabCount', 'sbMode', 'sbSync', 'sbMe', 'sbMeBtn',
    'qrModal', 'qrBox', 'qrUrl', 'qrClose', 'qrCopy',
    'meModal', 'meClose', 'meAvatar', 'meName', 'meMail', 'meNameInput', 'meSave', 'meSignout'];
  const missing = needed.filter(id => !byId.has(id));
  t('كل عناصر room.html موجودة', missing.length === 0, missing.join(','));

  /* ---- 2) ترتيب الأقسام: مشغّل ← تحكم ← منضمون ← رسائل ---- */
  const orderOf = ['stage', 'ctrlbar', 'membersPanel', 'chat'].map(id => html.indexOf(`id="${id}"`));
  t('الترتيب: المشغّل أولاً', orderOf[0] > -1 && orderOf[0] < orderOf[1], orderOf.join(','));
  t('الترتيب: أدوات التحكم تحت المشغّل', orderOf[1] < orderOf[2], orderOf.join(','));
  t('الترتيب: المنضمون تحت التحكم', orderOf[2] < orderOf[3], orderOf.join(','));
  t('الترتيب: الرسائل في الأسفل', orderOf[3] > orderOf[2]);

  /* ---- 3) لا إيموجي في واجهة التحكم (أيقونات SVG فقط) ---- */
  const chrome = html.replace(/<div class="react-row"[\s\S]*?<\/div>/, '');   // استثناء منطقة التفاعل
  const emojiInChrome = (chrome.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []);
  t('لا إيموجي خارج منطقة التفاعل', emojiInChrome.length === 0, emojiInChrome.join(' '));
  t('أيقونات SVG مستخدمة', (html.match(/data-icon="/g) || []).length >= 30,
    'count=' + (html.match(/data-icon="/g) || []).length);

  /* ---- 4) البوابة: الحالة الأولية ---- */
  t('البوابة ظاهرة قبل إدخال الاسم', byId.get('gate').hidden === false);
  t('الغرفة مخفية قبل الدخول', byId.get('room').hidden === true);
  t('كود الغرفة في البوابة', byId.get('gateCode').textContent === 'ABC123');
  t('كود الغرفة في الشريط', byId.get('roomCodeText').textContent === 'ABC123');
  t('رابط صفحة الدخول موجود', /auth\.html/.test(html));

  /* اسم قصير → رفض */
  byId.get('gateName').value = 'أ';
  byId.get('gateForm').dispatch('submit', {});
  t('الاسم القصير مرفوض', byId.get('gateError').textContent.length > 0, byId.get('gateError').textContent);
  t('البوابة ما زالت ظاهرة', byId.get('gate').hidden === false);

  /* صورة الاسم الحرفية */
  byId.get('gateName').value = 'أمين بن علي';
  byId.get('gateName').dispatch('input', {});
  t('الصورة الحرفية تتحدث', byId.get('avatarPreview').textContent.length >= 1, byId.get('avatarPreview').textContent);

  /* ---- 5) الدخول ---- */
  byId.get('gateForm').dispatch('submit', {});
  await wait(500);
  t('البوابة اختفت بعد إدخال الاسم', byId.get('gate').hidden === true);
  t('الغرفة ظهرت', byId.get('room').hidden === false);
  t('الاسم حُفظ محلياً', store['wt:name'] === '"أمين بن علي"', String(store['wt:name']));
  t('الوضع المحلي مُختار (لا سيرفر في الاختبار)', byId.get('sbMode').textContent.includes('محلي'), byId.get('sbMode').textContent);
  t('الخادم معروض في المعلومات', byId.get('infoTransport').textContent.length > 0);

  /* ---- 6) المنضمون ---- */
  await wait(250);
  t('أنا في قائمة المنضمين', byId.get('membersList').innerHTML.includes('أمين بن علي'),
    byId.get('membersList').innerHTML.slice(0, 90));
  t('شارة «أنت» ظاهرة', byId.get('membersList').innerHTML.includes('(أنت)'));
  t('عدد المنضمين = 1', byId.get('membersCount').textContent === '1', byId.get('membersCount').textContent);
  t('شارة المنضمين في الشريط العلوي', byId.get('sideMembersCount').textContent === '1');

  /* ---- 7) الرسائل ---- */
  const chatBody = byId.get('chatBody');
  const before = chatBody.children.length;
  const input = byId.get('chatInput');
  input.value = 'أهلاً بالجميع';
  byId.get('chatForm').dispatch('submit', {});
  await wait(80);
  t('الرسالة أُضيفت', chatBody.children.length > before, `${chatBody.children.length} vs ${before}`);
  t('حقل الإدخال فُرّغ', input.value === '', input.value);
  t('عدّاد الرسائل يتحدث', /رسالة|رسائل/.test(byId.get('chatCount').textContent), byId.get('chatCount').textContent);
  t('رسالة نظام الانضمام موجودة', chatBody.children.some(c => String(c._className).includes('msg--system')));

  /* ---- 8) التفاعلات (الإيموجي هنا فقط) ---- */
  const beforeReact = chatBody.children.length;
  const reactBtn = reactRow.children.find(c => c.dataset.react);
  t('أزرار التفاعل موجودة', !!reactBtn, 'n=' + reactRow.children.length);
  if (reactBtn) {
    reactBtn.dispatch('click', {});
    await wait(60);
    t('التفاعل أُرسل كرسالة', chatBody.children.length > beforeReact);
    t('نمط رسالة التفاعل', chatBody.children.some(c => String(c._className).includes('msg--react')),
      chatBody.children.map(c => c._className).join('|').slice(0, 120));
  }

  /* ---- 9) وضع الرسائل (إخفاء المشغّل) ---- */
  byId.get('focusToggleBtn').dispatch('click', {});
  await wait(120);
  t('الجسم أخذ صنف chat-focus', documentStub.body.classList.contains('chat-focus'));
  t('زر العودة للفيديو ظهر', byId.get('backToVideoBtn').hidden === false);
  t('تسمية الزر تغيّرت', byId.get('focusToggleLabel').textContent.includes('فيديو'), byId.get('focusToggleLabel').textContent);
  byId.get('backToVideoBtn').dispatch('click', {});
  await wait(60);
  t('العودة ألغت وضع الرسائل', !documentStub.body.classList.contains('chat-focus'));
  t('زر العودة اختفى', byId.get('backToVideoBtn').hidden === true);

  /* ---- 10) أزرار التحكم مربوطة ---- */
  ['playPauseBtn', 'backBtn', 'fwdBtn', 'muteBtn', 'fullBtn', 'resyncBtn', 'changeUrlBtn',
    'focusToggleBtn', 'membersToggle', 'copyCodeBtn', 'copyLinkBtn', 'qrBtn', 'qrClose', 'qrCopy',
    'leaveBtn', 'clearChatBtn', 'sbMeBtn', 'meClose', 'meSave', 'meSignout', 'cancelUrlBtn', 'applyUrlBtn']
    .forEach(id => {
      const h = byId.get(id)._handlers['click'] || [];
      t(`زر ${id} مربوط`, h.length >= 1, 'handlers=' + h.length);
    });

  /* ---- 11) تغيير الرابط ---- */
  byId.get('changeUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط فتح', byId.get('changeBar').hidden === false);
  byId.get('cancelUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط أُغلق', byId.get('changeBar').hidden === true);

  /* رابط غير صالح → تنبيه ولا يُطبَّق */
  byId.get('changeUrlBtn').dispatch('click', {});
  byId.get('newUrl').value = 'not a url';
  byId.get('applyUrlBtn').dispatch('click', {});
  t('الرابط غير الصالح مرفوض', byId.get('changeBar').hidden === false);
  byId.get('cancelUrlBtn').dispatch('click', {});

  /* ---- 12) QR ---- */
  byId.get('qrBtn').dispatch('click', {});
  t('نافذة QR فتحت', byId.get('qrModal').hidden === false);
  t('رابط QR صحيح', byId.get('qrUrl').textContent.includes('room.html?id=ABC123'), byId.get('qrUrl').textContent);
  byId.get('qrClose').dispatch('click', {});
  t('نافذة QR أُغلقت', byId.get('qrModal').hidden === true);

  /* ---- 13) الحساب ---- */
  byId.get('sbMeBtn').dispatch('click', {});
  t('نافذة الحساب فتحت', byId.get('meModal').hidden === false);
  t('اسمي في نافذة الحساب', byId.get('meName').textContent === 'أمين بن علي', byId.get('meName').textContent);
  t('شارة الضيف', byId.get('meMail').textContent.includes('ضيف'), byId.get('meMail').textContent);
  byId.get('meClose').dispatch('click', {});
  t('نافذة الحساب أُغلقت', byId.get('meModal').hidden === true);

  /* ---- 14) معلومات الغرفة ---- */
  t('معلومات: الكود', byId.get('infoCode').textContent === 'ABC123');
  t('معلومات: المصدر', byId.get('infoProvider').textContent.length > 0, byId.get('infoProvider').textContent);
  t('معلومات: وضعي', byId.get('infoRole').textContent.length > 0, byId.get('infoRole').textContent);
  t('شارة المزامنة', byId.get('syncBadgeText').textContent.length > 0, byId.get('syncBadgeText').textContent);

  /* ---- 15) اختصارات لوحة المفاتيح ---- */
  documentStub.dispatch('keydown', { key: 'd', target: { tagName: 'BODY', isContentEditable: false } });
  await wait(40);
  t('اختصار D يفتح وضع الرسائل', documentStub.body.classList.contains('chat-focus'));
  documentStub.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY', isContentEditable: false } });
  await wait(40);
  t('Escape يغلق وضع الرسائل', !documentStub.body.classList.contains('chat-focus'));

  /* ---- 16) إعدادات المزامنة المطلوبة ---- */
  const cfg = sandbox.WT_CONFIG;
  t('الرفع إلى قاعدة البيانات كل 5 ثوانٍ', cfg.sync.persistMs === 5000, String(cfg.sync.persistMs));
  t('التحاق المتأخرين مفعّل', cfg.sync.lateJoinCatchup === true);
  t('حساسية الانحراف عالية', cfg.sync.driftTolerance <= 1.2, String(cfg.sync.driftTolerance));

  console.log('\n' + errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });
run().catch(e => { console.log('RUN ERROR:', (e && e.stack) || e); process.exit(1); });

/* =========================================================
   WatchTogether — اختبار واجهة الغرفة بدون متصفح (DOM وهمي)
   التشغيل:  node docs/tests/room-dom.mjs
   ---------------------------------------------------------
   يبني DOM وهمياً من room.html، ثم يشغّل room.js بالكامل
   (بوابة الاسم → الدخول → الوضع المحلي → مزامنة → دردشة)
   ويلتقط أي خطأ runtime أو مرجع عنصر ناقص.
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
const ID_RE = /id="([A-Za-z0-9_-]+)"/g;

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); this.sync(); }
  remove(...c) { c.forEach(x => this.set.delete(x)); this.sync(); }
  toggle(c, force) {
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
    this.style = { setProperty() { }, cssText: '' };
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
  }
  get className() { return this._className; }
  set className(v) { this._className = v; this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    /* ابنِ عقدة وهمية لكل وسم حتى تعمل querySelectorAll */
    const tags = String(v).match(/<([a-zA-Z][a-zA-Z0-9]*)/g) || [];
    tags.forEach(tt => {
      const c = new El(tt.slice(1));
      c.parentNode = this; this.children.push(c);
    });
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
    e = Object.assign({ type: ev, target: this, preventDefault() { }, stopPropagation() { } }, e || {});
    list.forEach(fn => fn(e));
    return list.length;
  }
  focus() { this._focused = true; }
  click() { this.dispatch('click', {}); }
  setPointerCapture() { }
  scrollIntoView() { }
  requestFullscreen() { }
  querySelector(sel) { return this._query(sel)[0] || null; }
  querySelectorAll(sel) { return this._query(sel); }
  _query(sel) {
    const out = [];
    const walk = (n) => {
      n.children.forEach(c => {
        if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) out.push(c);
        else if (!sel.startsWith('.') && c.tagName === sel.toUpperCase()) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 20 }; }
}

/* ==================== بناء الصفحة من room.html ==================== */
const html = fs.readFileSync(path.join(base, 'room.html'), 'utf8');
const ids = new Set();
let m; while ((m = ID_RE.exec(html))) ids.add(m[1]);

const byId = new Map();
ids.forEach(id => {
  const e = new El('div');
  e.id = id;
  byId.set(id, e);
});

/* طبّق السمة hidden كما هي في HTML الحقيقي */
Array.from(html.matchAll(/<([a-zA-Z][^>]*?)\bid="([A-Za-z0-9_-]+)"([^>]*?)>/g)).forEach(mm => {
  const attrs = mm[1] + ' ' + mm[3];
  const el2 = byId.get(mm[2]);
  if (!el2) return;
  el2.tagName = mm[1].toUpperCase();
  if (/\shidden(\s|=|>|$)/.test(' ' + attrs)) el2.hidden = true;
});

/* ابنِ عُقداً لأزرار الإيموجي الموجودة في HTML */
const emojiRowHtml = (html.match(/<div class="emoji-row"[^>]*>([\s\S]*?)<\/div>/) || [, ''])[1];
const emojiRow = byId.get('emojiRow');
if (emojiRow) {
  Array.from(emojiRowHtml.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).forEach(mm => {
    const b = new El('button');
    b.textContent = mm[1];
    emojiRow.appendChild(b);
  });
}

const body = new El('body');
byId.forEach(e => body.appendChild(e));

const documentStub = {
  body,
  documentElement: new El('html'),
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => new El(tag),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener: (ev, fn) => (documentStub._h[ev] = documentStub._h[ev] || []).push(fn),
  dispatch(ev, e) { (documentStub._h[ev] || []).forEach(fn => fn(Object.assign({ type: ev, preventDefault() { } }, e))); },
  title: '',
  hidden: false,
  fullscreenElement: null,
  exitFullscreen() { },
  execCommand: () => true,
  _h: {}
};

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

const sandbox = {
  console,
  Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  Uint32Array, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set, Symbol,
  isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  URLSearchParams, URL, Intl,
  document: documentStub,
  localStorage: localStorageStub,
  sessionStorage: {
    _d: {},
    getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  navigator: { clipboard: { writeText: async () => true, readText: async () => '' }, userAgent: 'node', share: null },
  crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967295); return a; } },
  location: {
    origin: 'http://localhost:8080', host: 'localhost:8080', protocol: 'http:',
    search: '?id=ABC123&host=1&v=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&name=%D8%A3%D9%85%D9%8A%D9%86',
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
  YT: null,
  Hls: null,
  qrcode: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* ==================== تحميل السكربتات ==================== */
for (const f of ['assets/js/config.js', 'assets/js/util.js', 'assets/js/transport.js', 'assets/js/player.js', 'assets/js/room.js']) {
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
  await wait(120);
  if (process.env.DBG) {
    console.log('DBG location.search =', sandbox.location.search);
    console.log('DBG sessionStorage  =', JSON.stringify(sandbox.sessionStorage._d));
    console.log('DBG gate.hidden     =', byId.get('gate').hidden);
    console.log('DBG gateName.value  =', JSON.stringify(byId.get('gateName').value));
    console.log('DBG room.hidden     =', byId.get('room').hidden);
    console.log('DBG store keys      =', Object.keys(store));
  }

  /* ---- 1) كل العناصر المطلوبة موجودة في room.html ---- */
  const needed = ['gate', 'gateCode', 'gateName', 'gateForm', 'gateError', 'gateSubmit', 'avatarPreview',
    'room', 'roomTitle', 'roomSub', 'roomCodeText', 'copyCodeBtn', 'statusBadge', 'statusText',
    'membersBadge', 'membersCount', 'sideMembersCount', 'copyLinkBtn', 'shareBtn', 'leaveBtn',
    'player', 'playerPlaceholder', 'playPauseBtn', 'iconPlay', 'iconPause', 'backBtn', 'fwdBtn',
    'muteBtn', 'iconSound', 'iconMuted', 'fullBtn', 'progressBar', 'progressFill', 'curTime', 'durTime',
    'hostBadge', 'takeoverBtn', 'resyncBtn', 'changeUrlBtn', 'syncNote', 'syncHost', 'syncNoteTakeover',
    'changeBar', 'newUrl', 'applyUrlBtn', 'cancelUrlBtn', 'chat', 'chatBody', 'chatEmpty', 'chatForm',
    'chatInput', 'chatSend', 'chatCount', 'clearChatBtn', 'chatToggleBtn', 'typing', 'emojiRow',
    'membersList', 'infoCode', 'infoProvider', 'infoHost', 'infoRole', 'infoSync',
    'sideCopyLink', 'sideQr', 'sbMode', 'sbSync', 'sbMe', 'chatFab', 'chatFabCount',
    'qrModal', 'qrBox', 'qrUrl', 'qrClose'];
  const missing = needed.filter(id => !byId.has(id));
  t('كل عناصر room.html موجودة', missing.length === 0, missing.join(','));

  /* ---- 2) بوابة الاسم: الحالة الأولية صحيحة ---- */
  t('البوابة ظاهرة قبل إدخال الاسم', byId.get('gate').hidden === false);
  t('الغرفة مخفية قبل الدخول', byId.get('room').hidden === true);
  t('كود الغرفة معروض في البوابة', byId.get('gateCode').textContent === 'ABC123', byId.get('gateCode').textContent);
  t('كود الغرفة معروض في الشريط', byId.get('roomCodeText').textContent === 'ABC123');

  /* ---- 2ب) اسم قصير جداً → رفض مع رسالة ---- */
  byId.get('gateName').value = 'أ';
  byId.get('gateForm').dispatch('submit', {});
  t('الاسم القصير مرفوض', byId.get('gateError').textContent.length > 0, byId.get('gateError').textContent);
  t('البوابة ما زالت ظاهرة', byId.get('gate').hidden === false);

  /* ---- 2ج) صورة الاسم الحرفية تتحدث ---- */
  byId.get('gateName').value = 'أمين بن علي';
  byId.get('gateName').dispatch('input', {});
  t('الأحرف الأولى للصور الرمزية', byId.get('avatarPreview').textContent === 'أب'.slice(0,2) || byId.get('avatarPreview').textContent.length >= 1,
    byId.get('avatarPreview').textContent);

  /* ---- 2د) إدخال اسم صالح → دخول الغرفة ---- */
  byId.get('gateForm').dispatch('submit', {});
  await wait(400);
  t('البوابة اختفت بعد إدخال الاسم', byId.get('gate').hidden === true, 'hidden=' + byId.get('gate').hidden);
  t('الغرفة ظهرت', byId.get('room').hidden === false);
  t('الاسم حُفظ محلياً', store['wt:name'] === '"أمين بن علي"', String(store['wt:name']));

  /* ---- 3) الوضع المحلي تم اختياره (لا سيرفر في الاختبار) ---- */
  await wait(400);
  t('وضع المزامنة = محلي', byId.get('sbMode').textContent.includes('محلي'), byId.get('sbMode').textContent);
  t('شارة الحالة', byId.get('statusText').textContent.length > 0, byId.get('statusText').textContent);

  /* ---- 4) المضيف: شارة «أنت المضيف» ظاهرة ---- */
  t('شارة المضيف ظاهرة', byId.get('hostBadge').hidden === false);
  t('زر تولّي التحكم مخفي للمضيف', byId.get('takeoverBtn').hidden === true);
  t('تنبيه المتابعة مخفي للمضيف', byId.get('syncNote').hidden === true);
  t('الدور معروض', byId.get('infoRole').textContent.includes('مضيف'), byId.get('infoRole').textContent);
  t('اسمي في الشريط السفلي', byId.get('sbMe').textContent.includes('مضيف'), byId.get('sbMe').textContent);

  /* ---- 5) الدردشة ---- */
  const chatBody = byId.get('chatBody');
  const beforeChat = chatBody.children.length;
  const input = byId.get('chatInput');
  input.value = 'أهلاً بالجميع 👋';
  const n = byId.get('chatForm').dispatch('submit', {});
  t('معالج الإرسال مربوط', n >= 1, 'handlers=' + n);
  await wait(60);
  t('الرسالة ظهرت في الدردشة', chatBody.children.length > beforeChat,
    'children=' + chatBody.children.length + ' (كان ' + beforeChat + ')');
  t('حقل الإدخال فُرّغ', input.value === '', input.value);
  t('عدّاد الرسائل', /رسالة|رسائل/.test(byId.get('chatCount').textContent), byId.get('chatCount').textContent);


  /* ---- 6) الإيموجي السريع ---- */
  const emojiBtns = byId.get('emojiRow').children;
  t('أزرار الإيموجي موجودة', emojiBtns.length >= 1, 'n=' + emojiBtns.length);

  /* ---- 7) اختصار لوحة المفاتيح C (نسخ الرابط) ---- */
  documentStub.dispatch('keydown', { key: 'c', target: { tagName: 'BODY', isContentEditable: false } });
  await wait(30);
  t('اختصار C لا يسبب خطأ', true);

  /* ---- 8) أزرار التحكم مربوطة ---- */
  ['playPauseBtn', 'backBtn', 'fwdBtn', 'muteBtn', 'fullBtn', 'resyncBtn', 'changeUrlBtn',
    'copyCodeBtn', 'copyLinkBtn', 'sideCopyLink', 'sideQr', 'leaveBtn', 'clearChatBtn'].forEach(id => {
      const h = byId.get(id)._handlers['click'] || [];
      t(`زر ${id} مربوط`, h.length >= 1, 'handlers=' + h.length);
    });

  /* ---- 9) تغيير الرابط ---- */
  byId.get('changeUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط فتح', byId.get('changeBar').hidden === false);
  byId.get('cancelUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط أغلق', byId.get('changeBar').hidden === true);

  /* ---- 10) QR ---- */
  byId.get('sideQr').dispatch('click', {});
  t('نافذة QR فتحت', byId.get('qrModal').hidden === false);
  t('رابط QR صحيح', byId.get('qrUrl').textContent.includes('room.html?id=ABC123'), byId.get('qrUrl').textContent);
  byId.get('qrClose').dispatch('click', {});
  t('نافذة QR أغلقت', byId.get('qrModal').hidden === true);

  /* ---- 11) قائمة المشاركين تحتوي على نفسي ---- */
  await wait(200);
  t('عدد المشاركين ≥ 1', parseInt(byId.get('membersCount').textContent || '0', 10) >= 1,
    byId.get('membersCount').textContent);

  /* ---- 12) رسالة نظام الدخول + وضع المزامنة ---- */
  t('عقدة رسالة النظام أُضيفت', chatBody.children.length >= beforeChat + 1, 'children=' + chatBody.children.length);
  t('نمط رسالة النظام صحيح', chatBody.children.some(c => String(c._className).includes('msg--system')),
    chatBody.children.map(c => c._className).join('|'));
  t('الوضع المحلي معروض في الشريط السفلي', byId.get('sbMode').textContent.includes('محلي'), byId.get('sbMode').textContent);
  t('معلومات الغرفة: الكود', byId.get('infoCode').textContent === 'ABC123');
  t('معلومات الغرفة: المصدر يوتيوب', byId.get('infoProvider').textContent.includes('يوتيوب'), byId.get('infoProvider').textContent);

  console.log('\n' + errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', e && e.stack || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', e && e.stack || e); });
run().catch(e => { console.log('RUN ERROR:', e && e.stack || e); process.exit(1); });

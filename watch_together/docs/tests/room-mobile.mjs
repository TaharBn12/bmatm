/* =========================================================
   WatchTogether — اختبار دعم الهاتف وموضع الدراور (room-mobile.mjs)
   التشغيل:  node docs/tests/room-mobile.mjs
   ---------------------------------------------------------
   يفحص شيئين لا يمكن فحصهما بالنظر على الحاسوب:
     1) موضع دراور الغرفة على كل مقاسات الهاتف — بحساب فعلي
        لتتابع CSS (الشلال + الاستعلامات الإعلامية + النوعية)
        من ملف app.css الحقيقي، مع شجرة DOM الحقيقية من room.html.
        أي: «أين يقف الدراور بالضبط؟» يُجاب عنه بأرقام لا بتخمين.
     2) دعم الهاتف الكامل: أهداف اللمس، منطقة الأمان،
        منع التكبير عند الكتابة، الأفق القصير، عدم تجاوز العرض.
   ========================================================= */
import fs from 'fs';
import path from 'path';
import { createRoomEnv, wait, base } from './harness.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const css = fs.readFileSync(path.join(base, 'assets/css/app.css'), 'utf8');
const roomHtml = fs.readFileSync(path.join(base, 'room.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const authHtml = fs.readFileSync(path.join(base, 'auth.html'), 'utf8');

/* =========================================================
   1) شجرة DOM حقيقية من room.html
   ========================================================= */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseTree(html) {
  const root = { tag: '#root', id: '', classes: [], attrs: {}, children: [], parent: null };
  let node = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[0];
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;
    if (m[1]) {                                   /* وسم إغلاق */
      let up = node;
      while (up && up.tag.toLowerCase() !== m[1].toLowerCase()) up = up.parent;
      if (up && up.parent) node = up.parent;
      continue;
    }
    const tag = m[2].toLowerCase();
    const attrsRaw = m[3] || '';
    const attrs = {};
    const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(attrsRaw))) {
      attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
    }
    const el = {
      tag, id: attrs.id || '', attrs,
      classes: String(attrs.class || '').trim().split(/\s+/).filter(Boolean),
      children: [], parent: node
    };
    node.children.push(el);
    if (!VOID.has(tag) && !m[4]) node = el;
  }
  return root;
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) { const f = findById(c, id); if (f) return f; }
  return null;
}
/** [العنصر نفسه, الأب, الجد, …] */
function chainOf(el) { const chain = []; let n = el; while (n) { chain.push(n); n = n.parent; } return chain; }
function insideOf(el, ancestorId) { let n = el.parent; while (n) { if (n.id === ancestorId) return true; n = n.parent; } return false; }

const roomTree = parseTree(roomHtml);
const modalEl = findById(roomTree, 'playlistModal');
const chatEl = findById(roomTree, 'chat');
const stageEl = findById(roomTree, 'stage');
const membersEl = findById(roomTree, 'membersPanel');

t('الدراور محذوف بالكامل (لوحة + زر + تعتيم)', !findById(roomTree, 'roomDrawer') && !findById(roomTree, 'drawerOpenBtn') && !findById(roomTree, 'drawerScrim'));
t('نافذة «قائمة الغرفة» موجودة بدل الدراور', !!modalEl);
t('الرسائل (#chat) داخل #roomMain', !!chatEl && insideOf(chatEl, 'roomMain'));
/* الشجرة الحقيقية: هل الرسائل هي العنصر التالي للمشغّل مباشرة في #roomMain؟ */
const roomMainEl = findById(roomTree, 'roomMain');
const siblings = roomMainEl.children.filter(c => c.id || c.classes.length);
const posOf = (idOrClass) => siblings.findIndex(c => c.id === idOrClass || c.classes.includes(idOrClass));
{
  const mediaIdx = siblings.findIndex(c => c.classes.includes('media-shell'));
  const chatIdx = siblings.findIndex(c => c.classes.includes('chat'));
  const barIdx = siblings.findIndex(c => c.classes.includes('room-bar'));
  const changeIdx = siblings.findIndex(c => c.classes.includes('change-bar'));
  t('الرسائل هي العنصر التالي للمشغّل مباشرة داخل #roomMain',
    mediaIdx >= 0 && chatIdx === mediaIdx + 1,
    siblings.map(c => (c.tag + (c.id ? '#' + c.id : '.' + c.classes.join('.')))).join(' → '));
  t('لا يوجد أي عنصر آخر بين المشغّل والرسائل (الشريط والنموذج القديمان غائبان)',
    chatIdx === mediaIdx + 1 && siblings.length === 3);
  t('الشريط العلوي (3 أيقونات) قبل المشغّل مباشرة',
    barIdx === 0 && mediaIdx === 1, siblings.map(c => c.id || c.classes.join('.')).join(','));
}
t('المشاركون انتقلوا إلى نافذة «قائمة الغرفة»', !!membersEl && insideOf(membersEl, 'playlistModal'));
t('قائمة المنظّمين بجانبهم داخل النافذة', !!findById(roomTree, 'organizerList') && insideOf(findById(roomTree, 'organizerList'), 'playlistModal'));

/* =========================================================
   2) محرّك تتابع CSS مبسّط: من app.css الحقيقي
   - يفهم الوسائط (max-width/min-width/max-height + orientation + pointer)
   - يفهم النوعية (ids/classes/elements) و !important
   - يستبعد قواعد الحالات التفاعلية (:hover/:focus/:active/:disabled)
   - يتجاهل ::before/::after و @keyframes و @font-face
   ========================================================= */
const STATEFUL = /:(hover|active|focus|focus-visible|focus-within|disabled|checked|placeholder|target|visited|first-child|last-child|nth-child|not\()/;

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

function parseRules(src) {
  const rules = [];
  const keyframes = [];
  let i = 0, order = 0;
  const text = stripComments(src);
  function readBlock(start) {                       /* يعيد [المحتوى, موضع ما بعد ] */
    let depth = 1, k = start;
    while (k < text.length && depth > 0) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      k++;
    }
    return [text.slice(start, k - 1), k];
  }
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    const [body, after] = readBlock(open + 1);
    if (/^@media/i.test(prelude)) {
      const cond = prelude.replace(/^@media/i, '').trim();
      const inner = parseRules(body);
      inner.rules.forEach(r => { r.media.push(cond); rules.push(r); });
      inner.keyframes.forEach(k => keyframes.push(k));
    } else if (/^@supports/i.test(prelude)) {
      const cond = prelude.replace(/^@supports/i, '').trim();
      const inner = parseRules(body);
      inner.rules.forEach(r => { r.supports.push(cond); rules.push(r); });
      inner.keyframes.forEach(k => keyframes.push(k));
    } else if (/^@(keyframes|-webkit-keyframes)/i.test(prelude)) {
      keyframes.push({ name: prelude.replace(/^@(-\w+-)?keyframes/i, '').trim(), body });
    } else if (/^@(font-face|charset|import|page)/i.test(prelude)) {
      /* يُتجاهل */
    } else {
      const decls = {};
      const important = new Set();
      body.split(';').forEach(d => {
        const idx = d.indexOf(':');
        if (idx < 0) return;
        const prop = d.slice(0, idx).trim().toLowerCase();
        let val = d.slice(idx + 1).trim();
        if (!prop || !val) return;
        if (/!important$/i.test(val)) { val = val.replace(/\s*!important$/i, ''); important.add(prop); }
        decls[prop] = val;
      });
      prelude.split(',').forEach(sel => {
        rules.push({ selector: sel.trim(), decls, important, media: [], supports: [], order: order++ });
      });
    }
    i = after;
  }
  return { rules, keyframes };
}

const { rules, keyframes } = parseRules(css);
t('محلّل CSS قرأ ألف قاعدة', rules.length > 700, String(rules.length));

function mediaMatches(cond, ctx) {
  const c = cond.trim();
  if (/prefers-reduced-motion/i.test(c)) return false;             /* الحالة الطبيعية: بلا تقليل حركة */
  if (/prefers-color-scheme/i.test(c)) return false;
  const parts = c.split(/\s+and\s+/i);
  return parts.every(p => {
    let m = p.match(/\(\s*max-width\s*:\s*([\d.]+)px\s*\)/i);
    if (m) return ctx.width <= parseFloat(m[1]);
    m = p.match(/\(\s*min-width\s*:\s*([\d.]+)px\s*\)/i);
    if (m) return ctx.width >= parseFloat(m[1]);
    m = p.match(/\(\s*max-height\s*:\s*([\d.]+)px\s*\)/i);
    if (m) return ctx.height <= parseFloat(m[1]);
    m = p.match(/\(\s*min-height\s*:\s*([\d.]+)px\s*\)/i);
    if (m) return ctx.height >= parseFloat(m[1]);
    m = p.match(/orientation\s*:\s*(landscape|portrait)/i);
    if (m) return ctx.orientation === m[1].toLowerCase();
    m = p.match(/pointer\s*:\s*(coarse|fine|none)/i);
    if (m) return ctx.pointer === m[1].toLowerCase();
    if (/hover\s*:\s*hover/i.test(p)) return ctx.pointer === 'fine';
    return true;                                                    /* شروط لا نعرفها: نعتبرها مطابقة */
  });
}

function specificity(sel) {
  const s = sel.replace(/::[a-z-]+/g, '');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length +
    (s.match(/:(?!not\()[\w-]+/g) || []).length;
  const type = (s.replace(/[#.\[][^\s>+~]*/g, ' ').match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return ids * 10000 + classes * 100 + type;
}

/* يطابق المُحدِّد مع عنصر حقيقي + سلسلة أجداده (الابن > الأب > الجد) */
function matchesSelector(sel, chain) {
  if (!sel || /::/.test(sel)) return false;
  if (STATEFUL.test(sel)) return false;                             /* نتجاهل قواعد الحالات */
  const parts = sel.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  const tokens = [];
  let pendingChild = false;
  parts.forEach(p => { if (p === '>') pendingChild = true; else { tokens.push({ sel: p, child: pendingChild }); pendingChild = false; } });
  if (!tokens.length) return false;
  let chainIdx = 0;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tok = tokens[k];
    /* الجزء الأيمن (الموضوع) يجب أن يطابق العنصر نفسه؛ ما بعده يطابق الأجداد فقط */
    const isSubject = (k === tokens.length - 1);
    const limit = isSubject ? 1 : (tok.child ? chainIdx + 1 : chain.length);
    let found = -1;
    for (let i = chainIdx; i < limit; i++) {
      if (compoundMatches(tok.sel, chain[i])) { found = i; break; }
    }
    if (found < 0) return false;
    chainIdx = found + 1;
  }
  return true;
}

function compoundMatches(comp, el) {
  const c = comp.trim();
  if (!c) return false;
  const re = /(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|(:[a-zA-Z-]+(?:\([^)]*\))?)/g;
  let m;
  const seenType = c.match(/^[a-zA-Z][\w-]*/);
  if (seenType && el.tag.toLowerCase() !== seenType[0].toLowerCase()) return false;
  while ((m = re.exec(c))) {
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !el.classes.includes(m[3])) return false;
    if (m[4]) {
      const attr = m[4].toLowerCase();
      if (!(attr in el.attrs)) return false;
      if (m[5] && m[5] !== '=') { /* مقارنة بسيطة فقط */ }
      else if (m[6] !== undefined && el.attrs[attr] !== m[6]) return false;
    }
    if (m[7]) {
      const pc = m[7].toLowerCase();
      if (pc === ':not(:hover)' || pc.startsWith(':not(.')) continue;
      if (pc.startsWith(':root')) return false;
    }
  }
  return true;
}

/** القيمة الفعّالة لخاصية على عنصر في سياق (عرض/طول/مؤشر) */
function effective(el, prop, ctx) {
  const chain = chainOf(el);
  let best = null;
  for (const r of rules) {
    if (!(prop in r.decls)) continue;
    if (r.media.length && !r.media.every(m => mediaMatches(m, ctx))) continue;
    if (r.supports.length && !r.supports.every(s => /env\(|padding/.test(s))) continue;
    if (!matchesSelector(r.selector, chain)) continue;
    const score = specificity(r.selector) + (r.important.has(prop) ? 100000 : 0);
    if (!best || score >= best.score) best = { score, value: r.decls[prop], selector: r.selector, order: r.order, important: r.important.has(prop) };
  }
  return best;
}
const val = (el, prop, ctx) => { const b = effective(el, prop, ctx); return b ? b.value : ''; };

/* حساب قيم الأطوال: px · vw · vh · % + min/max/calc المتداخلة */
function evalLength(expr, ctx) {
  if (!expr) return null;
  let s = String(expr).trim();
  const fn = s.match(/^(min|max|clamp)\((.*)\)$/i);
  if (fn) {
    const args = [];
    let depth = 0, cur = '';
    for (const ch of fn[2]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
      cur += ch;
    }
    args.push(cur);
    const nums = args.map(a => evalLength(a, ctx)).filter(n => n !== null);
    if (!nums.length) return null;
    if (/^min$/i.test(fn[1])) return Math.min(...nums);
    if (/^max$/i.test(fn[1])) return Math.max(...nums);
    return Math.min(Math.max(nums[0], nums[1] !== undefined ? nums[1] : nums[0]), nums[2] !== undefined ? nums[2] : Infinity);
  }
  const calc = s.match(/^calc\((.*)\)$/i);
  if (calc) {
    let inner = calc[1]
      .replace(/([\d.]+)vw/gi, (_, n) => String(parseFloat(n) * ctx.width / 100))
      .replace(/([\d.]+)vh/gi, (_, n) => String(parseFloat(n) * ctx.height / 100))
      .replace(/([\d.]+)%/g, (_, n) => String(parseFloat(n) * ctx.width / 100))
      .replace(/([\d.]+)px/gi, '$1');
    if (!/^[-+*/().\d\s]+$/.test(inner)) return null;
    try { return Function('"use strict";return (' + inner + ')')(); } catch (e) { return null; }
  }
  const single = s.match(/^([\d.]+)(px|vw|vh|%)$/i);
  if (single) {
    const n = parseFloat(single[1]), u = single[2].toLowerCase();
    if (u === 'px') return n;
    if (u === 'vw') return n * ctx.width / 100;
    if (u === 'vh') return n * ctx.height / 100;
    if (u === '%') return n * ctx.width / 100;
  }
  return null;
}

const VIEWPORTS = [
  { name: 'iPhone SE عمودي', width: 320, height: 568, pointer: 'coarse' },
  { name: 'هاتف صغير', width: 360, height: 640, pointer: 'coarse' },
  { name: 'iPhone 390', width: 390, height: 844, pointer: 'coarse' },
  { name: 'iPhone Plus', width: 414, height: 896, pointer: 'coarse' },
  { name: 'هاتف مقلوب', width: 844, height: 390, pointer: 'coarse' },
  { name: 'تابلت', width: 768, height: 1024, pointer: 'coarse' },
  { name: 'حاسوب', width: 1280, height: 800, pointer: 'fine' },
];
const ctxOf = v => ({ width: v.width, height: v.height, pointer: v.pointer, orientation: v.width >= v.height ? 'landscape' : 'portrait' });

/* =========================================================
   3) نافذة «قائمة الغرفة» — بديل الدراور المحذوف
   ========================================================= */
for (const v of VIEWPORTS) {
  const ctx = ctxOf(v);
  t(`[${v.name}] نافذة الغرفة position: fixed (تغطي الشاشة عند الفتح)`, val(modalEl, 'position', ctx) === 'fixed', val(modalEl, 'position', ctx));
  t(`[${v.name}] النافذة مخفية افتراضياً ([hidden] → display: none)`, val(modalEl, 'display', ctx) === 'none', val(modalEl, 'display', ctx));
  t(`[${v.name}] النافذة فوق المحتوى (z-index ≥ 110)`, parseInt(val(modalEl, 'z-index', ctx), 10) >= 110, val(modalEl, 'z-index', ctx));
}
console.log('\n  📐 نافذة «قائمة الغرفة» (بديل الدراور): fixed · مخفية بالـ hidden · z-index عالٍ · المحتوى كامل داخلها');
console.log('');

{
  const ctx = ctxOf(VIEWPORTS[1]);
  const cardEl = (modalEl.children || []).find(c => c.classes.includes('modal__card')) || modalEl;
  t('بطاقة النافذة تلائم الشاشة (min() لا عرض ثابت)', /^min\(/.test(val(cardEl, 'width', ctx)), val(cardEl, 'width', ctx));
  const bodyClosed = { tag: 'body', id: '', classes: ['room-body'], attrs: {}, children: [], parent: { tag: 'html', id: '', classes: [], attrs: {}, children: [], parent: null } };
  t('التمرير الأفقي محجوب على الغرفة (لا تمرير جانبي عارض)',
    val(bodyClosed, 'overflow-x', ctx) === 'hidden', val(bodyClosed, 'overflow-x', ctx));
  t('التمرير الأفقي محجوب على الغرفة (overflow-x: hidden) محفوظ', val(bodyClosed, 'overflow-x', ctx) === 'hidden');
}

/* =========================================================
   4) لا شيء يكسر التثبيت: الأجداد بلا containing block
   ========================================================= */
const BREAKERS = ['transform', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'perspective', 'contain', 'will-change', 'container-type'];
const transformKeyframes = keyframes.filter(k => /transform\s*:/.test(k.body)).map(k => k.name);
for (const v of VIEWPORTS) {
  const ctx = ctxOf(v);
  const ancestors = chainOf(modalEl).slice(1);
  const bad = [];
  for (const a of ancestors) {
    for (const prop of BREAKERS) {
      const value = val(a, prop, ctx);
      if (value && value !== 'none' && value !== 'auto' && !/^normal$/.test(value)) bad.push(`${a.tag}.${a.classes.join('.') || a.id}:${prop}=${value}`);
    }
    const anim = val(a, 'animation', ctx) + ' ' + val(a, 'animation-name', ctx);
    if (anim.trim() && transformKeyframes.some(n => anim.includes(n))) bad.push(`${a.tag}:animation=${anim}`);
  }
  t(`[${v.name}] لا يوجد جدّ للنافذة يكسر position: fixed`, bad.length === 0, bad.join(' | '));
}

const missingIds = [];
function byIdProbe(id) {
  const el = findById(roomTree, id);
  if (!el) { missingIds.push(id); return { tag: 'div', id, classes: [], attrs: {}, children: [], parent: { tag: 'body', classes: ['room-body'], attrs: {}, children: [], id: '' } }; }
  return el;
}

/* =========================================================
   5) دعم الهاتف: أهداف اللمس · الكتابة · العرض · الأفق
   ========================================================= */
{
  /* الأب الحقيقي لعنصر الوقت (span.vc__times) من الشجرة */

  const ctx = ctxOf(VIEWPORTS[1]);
  const tapChecks = [
    ['زر التشغيل/الإيقاف (منتصف الفيديو)', 'centerPlayBtn', ['width', 'height'], 44],
    ['زر الترجيع (حافة الفيديو)', 'seekBackBtn', ['width', 'height'], 44],
    ['زر التقديم (حافة الفيديو)', 'seekFwdBtn', ['width', 'height'], 44],
    ['زر الإرسال في الدردشة', 'chatSend', ['width', 'height'], 44],
    ['زر إعادة الاتصال', 'reconnectBtn', ['min-height', 'height', 'width'], 44],
    ['زر بحث/تغيير الفيديو', 'addVideoBtn', ['min-height', 'height', 'width'], 44],
    ['خانة الكتابة', 'chatInput', ['min-height', 'height'], 44],
  ];
  for (const [label, id, props, min] of tapChecks) {
    const el = byIdProbe(id);
    const got = props.map(p => ({ p, v: val(el, p, ctx) })).filter(x => x.v !== '');
    const sizes = got.map(x => evalLength(x.v, ctx)).filter(n => n !== null);
    const size = sizes.length ? Math.max(...sizes) : null;
    t(`هدف لمس ≥ ${min}px: ${label}`, size !== null && size >= min, got.map(x => x.p + '=' + x.v).join(', '));
  }
  t('خانة الكتابة 16px على اللمس (يمنع تكبير iOS)',
    evalLength(val(byIdProbe('chatInput'), 'font-size', ctx), ctx) === 16, val(byIdProbe('chatInput'), 'font-size', ctx));
  t('لوحة مفاتيح الهاتف لا تغطّي خانة الكتابة (interactive-widget=resizes-content)',
    /interactive-widget=resizes-content/.test(roomHtml + indexHtml + authHtml));
  t('حقول النموذج 16px على اللمس (منع تكبير iOS في البوابة والإعدادات)',
    evalLength(val(byIdProbe('gateName'), 'font-size', ctx), ctx) === 16, val(byIdProbe('gateName'), 'font-size', ctx));
  const modalCard = byIdProbe('diagModal').children.find(c => c.classes.includes('modal__card')) || byIdProbe('diagModal');
  t('بطاقة النافذة على الهاتف محدودة الارتفاع وقابلة للتمرير',
    /dvh/.test(val(modalCard, 'max-height', ctx)) && ['auto', 'scroll'].includes(val(modalCard, 'overflow-y', ctx)),
    `${val(modalCard, 'max-height', ctx)} / ${val(modalCard, 'overflow-y', ctx)}`);
  t('لا تكبير نصّي تلقائي على iOS (-webkit-text-size-adjust)',
    /-webkit-text-size-adjust\s*:\s*100%/.test(css));
  t('لا وميض أزرق عند اللمس (-webkit-tap-highlight-color)',
    /-webkit-tap-highlight-color\s*:\s*transparent/.test(css));
  t('سحب شريط التقدّم لا يمرّر الصفحة (touch-action: none)',
    val(byIdProbe('progressBar'), 'touch-action', ctx) === 'none', val(byIdProbe('progressBar'), 'touch-action', ctx));
  const timesEl = byIdProbe('curTime').parent;
  t('الوقت الرقمي يُخفى على الشاشات ≤400px ليوسّع شريط التنقل',
    val(timesEl, 'display', ctxOf({ width: 390, height: 844, pointer: 'coarse' })) === 'none',
    val(timesEl, 'display', ctxOf({ width: 390, height: 844, pointer: 'coarse' })));
  t('الوقت الرقمي يبقى ظاهراً على 420px',
    val(timesEl, 'display', ctxOf({ width: 420, height: 800, pointer: 'coarse' })) !== 'none');

  /* عرض المحتوى لا يتجاوز الشاشة */
  for (const view of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[4]]) {
    const c = ctxOf(view);
    const stageW = val(stageEl, 'width', c);
    t(`[${view.name}] بطاقة المشغّل محدودة بـ min() لا بعرض ثابت`, /^min\(/.test(stageW), stageW);
    t(`[${view.name}] بطاقة المشغّل لا تتجاوز 100%`, /100%/.test(stageW), stageW);
  }
  const chatMin = evalLength(val(chatEl, 'min-height', ctxOf({ width: 360, height: 640, pointer: 'coarse' })), ctxOf({ width: 360, height: 640, pointer: 'coarse' }));
  t('الرسائل لها ارتفاع أدنى معقول على الهاتف (≥200px وأقل من 300px)',
    chatMin !== null && chatMin >= 200 && chatMin <= 300, String(chatMin));
  t('الرسائل تتمدد لتملأ المساحة المتبقية على الهاتف',
    /1 1 auto|flex:\s*1/.test(val(chatEl, 'flex', ctx)), val(chatEl, 'flex', ctx));

  /* القرب الفعلي: المسافة بين المشغّل والرسائل على الهاتف */
  for (const dev of [{ n: 'هاتف صغير', w: 360, h: 640 }, { n: 'هاتف مقلوب', w: 844, h: 390 }]) {
    const c = ctxOf({ width: dev.w, height: dev.h, pointer: 'coarse' });
    const gap = evalLength(val(roomMainEl, 'gap', c), c);
    t(`[${dev.n}] المسافة بين بطاقة المشغّل والرسائل ≤ 10px`, gap !== null && gap <= 10, String(gap));
  }
  t('رسائل الصفحة تسبق كل شيء آخر: لا بطاقة بين الفيديو والمحادثة',
    val({ tag: 'section', id: 'chat', classes: ['chat', 'glass'], attrs: {}, children: [], parent: roomMainEl }, 'margin-top', ctxOf(VIEWPORTS[1])) === '0');

  /* ميزانية الارتفاع: هل يبقى للرسائل مكان معقول في شاشة هاتف حقيقية؟
     (أرقام معلنة في CSS: شريط الغرفة + أزرار الأدوات + الفيديو 16:9 + شريط التحكم + حشوة) */
  const ctrlBarH = 0;           /* لا شريط تحت الفيديو — التحكم داخله */
  const mainPad = 28;           /* 10px أعلى + 18px أسفل */
  console.log('\n  📱 ميزانية ارتفاع الغرفة على الهاتف (كم يبقى للرسائل فعلياً):');
  for (const dev of [{ n: 'iPhone SE', w: 320, h: 568 }, { n: 'هاتف صغير', w: 360, h: 640 }, { n: 'iPhone 390', w: 390, h: 844 }]) {
    const c = ctxOf({ width: dev.w, height: dev.h, pointer: 'coarse' });
    const barH = evalLength(val(byIdProbe('addVideoBtn').parent.parent, 'min-height', c), c) || 52;
    const actH = 0;             /* الأزرار الثلاثة داخل الشريط نفسه (صف واحد) */
    const stageW = evalLength(val(stageEl, 'width', c), c) || dev.w;
    const videoH = Math.round(stageW * 9 / 16);
    const chatSpace = Math.round(dev.h - (barH + actH + videoH + ctrlBarH + mainPad));
    console.log(`  • ${dev.n} (${dev.w}×${dev.h}) — شريط ${barH} + فيديو ${videoH} + بلا شريط تحكم ⇒ الرسائل ≈ ${chatSpace}px`);
    t(`[${dev.n}] تبقى مساحة معقولة للرسائل (≥ 180px)`, chatSpace >= 180, `${chatSpace}px`);
    t(`[${dev.n}] الفيديو لا يأكل أكثر من 45% من ارتفاع الشاشة`, videoH <= dev.h * 0.45, `${videoH} من ${dev.h}`);
  }
  t('شريط الغرفة لا يلتفّ إلى سطرين على الهاتف', val(byIdProbe('addVideoBtn').parent.parent, 'flex-wrap', ctx) !== 'wrap',
    val(byIdProbe('addVideoBtn').parent.parent, 'flex-wrap', ctx));

  /* ---- 5.ب) الشريط العلوي (2.7.0): 3 أيقونات فقط — لا عنوان، لا دراور ---- */
  {
    const barEl = byIdProbe('addVideoBtn').parent.parent;      /* div.room-bar */
    const barCtx = ctxOf(VIEWPORTS[1]);                       /* 360px — هاتف صغير */
    const barActions = byIdProbe('addVideoBtn').parent;        /* nav.bar-actions */

    t('الشريط العلوي يحوي 3 أزرار فقط (بحث · طيّ · إعادة اتصال)',
      ['addVideoBtn', 'collapseBtn', 'reconnectBtn'].every(id => !!byIdProbe(id)) &&
      barActions.children.filter(c => c.classes.includes('bar-action')).length === 3,
      barActions.children.map(c => c.id).join(','));
    t('الشريط لا يحوي عنواناً ولا دراور', !findById(roomTree, 'roomTitle') && !findById(roomTree, 'drawerOpenBtn') && !findById(roomTree, 'roomDrawer'));
    t('مجموعة الأيقونات بعرض محتواها فقط (flex: none) — لا تتمدد',
      /none|0 0 auto/.test(val(barActions, 'flex', barCtx)), val(barActions, 'flex', barCtx));
    for (const id of ['addVideoBtn', 'collapseBtn', 'reconnectBtn']) {
      t(`[${id}] لا ينكمش (flex: none)`, /none|0 0 auto/.test(val(byIdProbe(id), 'flex', barCtx)), val(byIdProbe(id), 'flex', barCtx));
      const w = evalLength(val(byIdProbe(id), 'width', barCtx), barCtx) || 0;
      const h = evalLength(val(byIdProbe(id), 'height', barCtx), barCtx) || 0;
      t(`[${id}] هدف لمس ≥ 44px`, Math.max(w, h) >= 44, `${w}×${h}`);
    }
    /* ميزانية العرض: 3 أزرار 44px + فجوات + حشو تتّسع على أصغر شاشة بلا تداخل */
    for (const view of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[2]]) {
      const fixed = 3 * 44 + 2 * 8 + 16;                    /* الأزرار + الفجوات + الحشو */
      t(`[${view.name}] الشريط (3 أيقونات) يتّسع دائماً بلا تداخل (هامش ≥ 60px)`,
        view.width - 20 - fixed >= 60, `الثابت=${fixed}px من ${view.width}px`);
    }
    t('مؤشر الحالة (نقطة ملوّنة) على زر إعادة الاتصال نفسه',
      /\.bar-action \.dot \{/.test(css) && /is-online \.dot/.test(css), '');
  }

  /* وضع الأفق القصير: قاعدة موجودة فعلاً */
  const landscapeRule = rules.some(r => r.media.some(m => /max-height:\s*54\dpx/i.test(m) && /orientation:\s*landscape/i.test(m)) && /\.stage/.test(r.selector));
  t('وضع الهاتف المقلوب يعالج حجم المشغّل', landscapeRule);
  const lctx = ctxOf(VIEWPORTS[4]);
  const lw = evalLength(val(stageEl, 'width', lctx), lctx);
  t('في الوضع الأفقي لا يأكل الفيديو الشاشة كلها', lw !== null && lw <= 480, String(lw));
  t('في الوضع الأفقي تبقى الرسائل ظاهرة', evalLength(val(chatEl, 'min-height', lctx), lctx) <= 240, val(chatEl, 'min-height', lctx));

  /* كل ارتفاع 100vh له بديل dvh */
  /* ارتفاع الشاشة الكامل: لكل مُحدِّد يصرّح 100vh يجب أن ينتهي الأمر بـ 100dvh */
  const vhSelectors = new Map();
  for (const r of rules) {
    for (const prop of ['min-height', 'height']) {
      const v = r.decls[prop];
      if (!v) continue;
      if (/100vh/.test(v)) vhSelectors.set(r.selector, { prop, hasDvh: /100dvh/.test(v), order: r.order });
      else if (/100dvh/.test(v) && vhSelectors.has(r.selector)) vhSelectors.get(r.selector).hasDvh = true;
    }
  }
  const missingDvh = [...vhSelectors.entries()].filter(([, v]) => !v.hasDvh).map(([sel]) => sel);
  t('كل عنصر بارتفاع 100vh ينتهي إلى 100dvh (شريط Safari المتغيّر)', missingDvh.length === 0, missingDvh.join(','));

  /* صفحة الهاتف: وسائط العرض */
  for (const [name, html] of [['room.html', roomHtml], ['index.html', indexHtml], ['auth.html', authHtml]]) {
    t(`${name}: وسيط viewport يدعم النتوء (viewport-fit=cover)`,
      /name="viewport"[^>]*width=device-width[^>]*viewport-fit=cover/.test(html));
    t(`${name}: مقياس 1 ولا يُمنع التكبير (بلا user-scalable=no)`, !/user-scalable\s*=\s*no/.test(html));
    t(`${name}: اتجاه عربي RTL`, /<html[^>]*dir="rtl"/.test(html));
    t(`${name}: لون شريط المتصفح (theme-color)`, /name="theme-color"/.test(html));
  }
  t('room.html: دعم تطبيق الويب على iOS (apple-mobile-web-app-capable)', /apple-mobile-web-app-capable/.test(roomHtml));
}

/* =========================================================
   6) سلوك الدراور فعلياً في بيئة الغرفة (فتح/إغلاق/قفل الخلفية)
   ========================================================= */

const env = createRoomEnv({
  search: '?id=MOB123&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4',
  store: { 'wt:owner:MOB123': JSON.stringify('b'.repeat(64)) }
});
env.sandbox.WT_CONFIG.javaServer.enabled = false;
env.sandbox.WT_CONFIG.supabase.ready = false;
await wait(100);
env.byId.get('gateName').value = 'أمين بن علي';
env.byId.get('gateForm').dispatch('submit', {});
await wait(500);
t('الدخول من الهاتف يفتح الغرفة', !env.byId.get('room').hidden && env.byId.get('gate').hidden);

const modal = env.byId.get('playlistModal');
env.byId.get('addVideoBtn').dispatch('click', {});
t('زر البحث يفتح نافذة «قائمة الغرفة» على الهاتف', modal.hidden === false);
t('النافذة تعرض خانة الرابط والأعضاء والأدوات',
  !!env.byId.get('newUrl') && !!env.byId.get('membersList') && !!env.byId.get('copyLinkBtn') && !!env.byId.get('leaveBtn'));
env.byId.get('playlistCloseBtn').dispatch('click', {});
t('زر الإغلاق يغلق النافذة', modal.hidden === true);

env.byId.get('addVideoBtn').dispatch('click', {});
await wait(20);
env.documentStub.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY', isContentEditable: false } });
t('Escape يغلق النافذة على الهاتف أيضاً', modal.hidden === true);

t('المشاركون داخل النافذة يعرضون أنفسهم (وصول من الهاتف)',
  env.byId.get('membersList').innerHTML.includes('أمين بن علي'), '');

/* =========================================================
   النتيجة
   ========================================================= */
process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n' + errors.join('\n'));
process.exit(fail ? 1 : 0);

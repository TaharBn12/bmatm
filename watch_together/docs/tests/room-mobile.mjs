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
const drawerEl = findById(roomTree, 'roomDrawer');
const scrimEl = findById(roomTree, 'drawerScrim');
const chatEl = findById(roomTree, 'chat');
const stageEl = findById(roomTree, 'stage');
const membersEl = findById(roomTree, 'membersPanel');

t('دراور الغرفة موجود في الصفحة', !!drawerEl);
t('شريط التعتيم (scrim) موجود في الصفحة', !!scrimEl);
t('محتوى الغرفة (#room) هو الأب المباشر للدراور', !!drawerEl && !!drawerEl.parent && drawerEl.parent.id === 'room');
t('الدراور خارج تدفّق المحتوى (ليس داخل #roomMain)',
  !!drawerEl && !insideOf(drawerEl, 'roomMain'));
t('الرسائل (#chat) داخل #roomMain', !!chatEl && insideOf(chatEl, 'roomMain'));
t('المشاركون انتقلوا إلى الدراور', !!membersEl && insideOf(membersEl, 'roomDrawer'));
t('المشاركون آخر أقسام الدراور (بعد المنظّمين)', (() => {
  const sections = drawerEl.children.filter(c => c.tag === 'section');
  return sections.length === 2 && sections[1].id === 'membersPanel';
})(), drawerEl.children.map(c => c.tag + (c.id ? '#' + c.id : '')).join(','));

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
   3) موضع الدراور — أرقام فعلية لكل مقاس
   ========================================================= */
/* نسخة من الدراور مع الصنف is-open — لحساب حالته المفتوحة بلا متصفح */
function openDrawerProbe() {
  const clone = { tag: drawerEl.tag, id: drawerEl.id, classes: drawerEl.classes.concat('is-open'), attrs: drawerEl.attrs, children: [], parent: drawerEl.parent };
  return clone;
}

const report = [];
for (const v of VIEWPORTS) {
  const ctx = ctxOf(v);
  const pos = val(drawerEl, 'position', ctx);
  const widthExpr = val(drawerEl, 'width', ctx);
  const width = evalLength(widthExpr, ctx);
  const insetStart = val(drawerEl, 'inset-inline-start', ctx);
  const left = val(drawerEl, 'left', ctx);
  const right = val(drawerEl, 'right', ctx);
  const z = val(drawerEl, 'z-index', ctx);
  const closedT = val(drawerEl, 'transform', ctx);
  const openT = val({ ...openDrawerProbe() }, 'transform', ctx);

  report.push({
    v: v.name, w: v.width,
    width: Math.round(width), gap: Math.round(v.width - (typeof width === 'number' ? width : 0)),
    side: 'يمين (RTL)', z, state: 'translateX(105%) ← خارج الشاشة', open: 'translateX(0) ← داخل الشاشة'
  });

  t(`[${v.name}] الدراور position: fixed (لا ينزلق مع التمرير)`, pos === 'fixed', pos);
  t(`[${v.name}] الدراور ملتصق بحافة الشاشة (inset-inline-start: 0)`, insetStart === '0', insetStart);
  t(`[${v.name}] موضع أفقي معرّف منطقياً فقط (لا left/right مطلق), يتّبع RTL`,
    left === '' && right === '', `left=${left}, right=${right}`);
  t(`[${v.name}] الدراور فوق شريط التعتيم (z-index ≥ 110)`, parseInt(z, 10) >= 110, z);
  t(`[${v.name}] عرض الدراور لا يغطي الشاشة كاملة (يظل 22px+ للنقر خارجاً)`,
    width !== null && width <= v.width - 22, `${width} من ${v.width}`);
  t(`[${v.name}] عرض الدراور كافٍ للاستعمال (≥ 280px)`, width !== null && width >= 280, String(width));
  t(`[${v.name}] الدراور مخفيّ افتراضياً بدفعه إلى حافّته (+X لأن الاتجاه RTL)`,
    /translateX\(\s*1\d\d%/.test(closedT.replace(/\s+/g, '')), closedT);
  /* الجهة الفعلية: RTL + inset-inline-start:0 ⇒ الحافة اليمنى، والدفع +X يخرجه يميناً */
  t(`[${v.name}] جهة الدراور الفعلية: الحافة اليمنى (RTL) والخروج للأسفل عنها`,
    /dir="rtl"/.test(roomHtml) && insetStart === '0' && /translateX\(\s*1\d\d%/.test(closedT.replace(/\s+/g, '')),
    `dir=rtl, inline-start=${insetStart}, closed=${closedT}`);
  t(`[${v.name}] عند الفتح يعود إلى مكانه (translateX(0))`, openT === 'translateX(0)', openT);
}
console.log('\n  📐 أين يقف دراور الغرفة على كل مقاس (محسوب فعلياً من app.css + room.html):');
report.forEach(r => {
  console.log(`  • ${r.v} — الشاشة ${r.w}px · الدراور ${r.width}px من الحافة اليمنى (RTL) · ` +
    `يبقى ${r.gap}px للنقر خارجاً · z-index ${r.z} · مغلق: خارج الشاشة، مفتوح: translateX(0)`);
});
console.log('');

/* النافذة الكاملة: الشريط يغطي الشاشة والدراور فوقه */
{
  const ctx = ctxOf(VIEWPORTS[1]);
  t('شريط التعتيم يغطي الشاشة كاملة', val(scrimEl, 'position', ctx) === 'fixed' && val(scrimEl, 'inset', ctx) === '0');
  t('شريط التعتيم لا يعلو الدراور', parseInt(val(scrimEl, 'z-index', ctx), 10) < parseInt(val(drawerEl, 'z-index', ctx), 10));
  t('الشريط مخفيّ عن الإغلاق ([hidden] → display: none)',
    val(scrimEl, 'display', ctx) === 'none', val(scrimEl, 'display', ctx));
  t('الدراور يُخفى كلياً عندما يكون مغلقاً (visibility: hidden)',
    val(drawerEl, 'visibility', ctx) === 'hidden', val(drawerEl, 'visibility', ctx));
  t('الدراور قابل للتمرير داخلياً على الهاتف (overflow: auto)',
    ['auto', 'scroll'].includes(val(drawerEl, 'overflow', ctx)), val(drawerEl, 'overflow', ctx));
  t('تمرير داخل الدراور لا يجرّ الصفحة (overscroll-behavior: contain)',
    /contain/.test(val(drawerEl, 'overscroll-behavior', ctx)), val(drawerEl, 'overscroll-behavior', ctx));
  const bodyOpen = { tag: 'body', id: '', classes: ['room-body', 'drawer-open'], attrs: {}, children: [], parent: { tag: 'html', id: '', classes: [], attrs: {}, children: [], parent: null } };
  const bodyClosed = { tag: 'body', id: '', classes: ['room-body'], attrs: {}, children: [], parent: { tag: 'html', id: '', classes: [], attrs: {}, children: [], parent: null } };
  t('فتح الدراور يقفل تمرير الصفحة خلفه (body.drawer-open → overflow: hidden)',
    val(bodyOpen, 'overflow', ctx) === 'hidden', val(bodyOpen, 'overflow', ctx));
  t('بلا فتح الدراور لا يُقفل التمرير', val(bodyClosed, 'overflow', ctx) !== 'hidden', val(bodyClosed, 'overflow', ctx));
  t('التمرير الأفقي محجوب على الغرفة (لا تمرير جانبي عارض)',
    val(bodyClosed, 'overflow-x', ctx) === 'hidden', val(bodyClosed, 'overflow-x', ctx));
}

/* منطقة الأمان (iPhone notch / شريط سفلي) */
{
  const ctx = ctxOf(VIEWPORTS[0]);
  const pad = val(drawerEl, 'padding', ctx);
  t('الدراور يحترم منطقة الأمان العلوية', /env\(safe-area-inset-top/.test(pad), pad);
  t('الدراور يحترم منطقة الأمان السفلية', /env\(safe-area-inset-bottom/.test(pad), pad);
  t('الدراور يستعمل 100dvh (أدقّ من 100vh على الهاتف)',
    /100dvh/.test(val(drawerEl, 'height', ctx)), val(drawerEl, 'height', ctx));
}

/* =========================================================
   4) لا شيء يكسر التثبيت: الأجداد بلا containing block
   ========================================================= */
const BREAKERS = ['transform', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'perspective', 'contain', 'will-change', 'container-type'];
const transformKeyframes = keyframes.filter(k => /transform\s*:/.test(k.body)).map(k => k.name);
for (const v of VIEWPORTS) {
  const ctx = ctxOf(v);
  const ancestors = chainOf(drawerEl).slice(1);
  const bad = [];
  for (const a of ancestors) {
    for (const prop of BREAKERS) {
      const value = val(a, prop, ctx);
      if (value && value !== 'none' && value !== 'auto' && !/^normal$/.test(value)) bad.push(`${a.tag}.${a.classes.join('.') || a.id}:${prop}=${value}`);
    }
    const anim = val(a, 'animation', ctx) + ' ' + val(a, 'animation-name', ctx);
    if (anim.trim() && transformKeyframes.some(n => anim.includes(n))) bad.push(`${a.tag}:animation=${anim}`);
  }
  t(`[${v.name}] لا يوجد جدّ للدراور يكسر position: fixed`, bad.length === 0, bad.join(' | '));
}

/* =========================================================
   5) دعم الهاتف: أهداف اللمس · الكتابة · العرض · الأفق
   ========================================================= */
{
  /* الأب الحقيقي لعنصر الوقت (span.vc__times) من الشجرة */

  const ctx = ctxOf(VIEWPORTS[1]);
  const tapChecks = [
    ['زر التشغيل/الإيقاف', 'playPauseBtn', ['width', 'height'], 44],
    ['زر كتم الصوت', 'muteBtn', ['width', 'height'], 44],
    ['زر الإرسال في الدردشة', 'chatSend', ['width', 'height'], 44],
    ['زر فتح القائمة', 'drawerOpenBtn', ['min-height', 'height'], 44],
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
  t('الوقت الرقمي يُخفى على الشاشات ≤400px ليوسّع الشريط',
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

  /* ميزانية الارتفاع: هل يبقى للرسائل مكان معقول في شاشة هاتف حقيقية؟
     (أرقام معلنة في CSS: شريط الغرفة + أزرار الأدوات + الفيديو 16:9 + شريط التحكم + حشوة) */
  const ctrlBarH = 64;          /* أزرار 44-50px + حشوة الشريط */
  const mainPad = 28;           /* 10px أعلى + 18px أسفل */
  console.log('\n  📱 ميزانية ارتفاع الغرفة على الهاتف (كم يبقى للرسائل فعلياً):');
  for (const dev of [{ n: 'iPhone SE', w: 320, h: 568 }, { n: 'هاتف صغير', w: 360, h: 640 }, { n: 'iPhone 390', w: 390, h: 844 }]) {
    const c = ctxOf({ width: dev.w, height: dev.h, pointer: 'coarse' });
    const barH = evalLength(val(byIdProbe('drawerOpenBtn').parent.parent, 'min-height', c), c) || 52;
    const actH = evalLength(val(byIdProbe('addVideoBtn'), 'min-height', c), c) || 46;
    const stageW = evalLength(val(stageEl, 'width', c), c) || dev.w;
    const videoH = Math.round(stageW * 9 / 16);
    const chatSpace = Math.round(dev.h - (barH + actH + videoH + ctrlBarH + mainPad));
    console.log(`  • ${dev.n} (${dev.w}×${dev.h}) — شريط ${barH} + أزرار ${actH} + فيديو ${videoH} + تحكم ${ctrlBarH} ⇒ الرسائل ≈ ${chatSpace}px`);
    t(`[${dev.n}] تبقى مساحة معقولة للرسائل (≥ 180px)`, chatSpace >= 180, `${chatSpace}px`);
    t(`[${dev.n}] الفيديو لا يأكل أكثر من 45% من ارتفاع الشاشة`, videoH <= dev.h * 0.45, `${videoH} من ${dev.h}`);
  }
  t('عنوان الغرفة يُقصّ بـ ellipsis ولا يكسر الشريط',
    /vw/.test(val(byIdProbe('roomTitle'), 'max-width', ctx), '') || /vw/.test(val(byIdProbe('roomTitle'), 'max-width', ctx)),
    val(byIdProbe('roomTitle'), 'max-width', ctx));
  t('شريط الغرفة لا يلتفّ إلى سطرين على الهاتف', val(byIdProbe('drawerOpenBtn').parent.parent, 'flex-wrap', ctx) !== 'wrap',
    val(byIdProbe('drawerOpenBtn').parent.parent, 'flex-wrap', ctx));

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
const missingIds = [];
function byIdProbe(id) {
  const el = findById(roomTree, id);
  if (!el) { missingIds.push(id); return { tag: 'div', id, classes: [], attrs: {}, children: [], parent: { tag: 'body', classes: ['room-body'], attrs: {}, children: [], id: '' } }; }
  return el;
}

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

const drawer = env.byId.get('roomDrawer');
const body = env.documentStub.body;
env.byId.get('drawerOpenBtn').dispatch('click', {});
t('فتح القائمة يضيف is-open ويكشف شريط التعتيم',
  drawer.classList.contains('is-open') && env.byId.get('drawerScrim').hidden === false);
t('فتح القائمة يقفل تمرير الصفحة (body.drawer-open)',
  body.classList.contains('drawer-open'), body._className);
t('aria للقائمة يتحدّث عند الفتح',
  drawer.getAttribute('aria-hidden') === 'false' && env.byId.get('drawerOpenBtn').getAttribute('aria-expanded') === 'true');
env.byId.get('drawerScrim').dispatch('click', {});
t('النقر على الفراغ خارج القائمة يغلقها',
  !drawer.classList.contains('is-open') && env.byId.get('drawerScrim').hidden === true && !body.classList.contains('drawer-open'));

env.byId.get('drawerOpenBtn').dispatch('click', {});
await wait(20);
env.documentStub.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY', isContentEditable: false } });
t('Escape يغلق القائمة على الهاتف أيضاً', !drawer.classList.contains('is-open'));

t('المشاركون داخل القائمة يعرضون أنفسهم (وصول من الهاتف)',
  env.byId.get('membersList').innerHTML.includes('أمين بن علي'), '');

/* =========================================================
   النتيجة
   ========================================================= */
process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n' + errors.join('\n'));
process.exit(fail ? 1 : 0);

/* =========================================================
   WatchTogether — اختبار هيكل التحكم في المشغّل (بلا متصفح)
   ---------------------------------------------------------
   العقد الحالي (الإصدار 2.6):
     1) شريط التحكم أسفل الفيديو (خارج الصورة) لا فوقه
     2) فيه فقط: تشغيل/إيقاف + الوقت + شريط التقدم + كتم الصوت
     3) محذوف نهائياً: شريط الصوت، ملء الشاشة، التقديم/الترجيع
     4) الرسائل ظاهرة دائماً وتأخذ المساحة الكبيرة
   ========================================================= */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8');
const [html, js, css] = await Promise.all([read('room.html'), read('assets/js/room.js'), read('assets/css/app.css')]);

/** مدى العنصر بصيغة <tag ... id="X"> … </tag> (يُراعي التداخل) */
function elementRange(source, id) {
  const open = source.search(new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid="${id}"`));
  if (open < 0) return null;
  const tag = /^<([a-zA-Z][\w-]*)/.exec(source.slice(open))[1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(source))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return { start: open, end: m.index + m[0].length, tag };
  }
  return null;
}

/* ---------- 1) البنية: شريط التحكم أسفل الفيديو لا فوقه ---------- */
const stage = elementRange(html, 'stage');
const player = elementRange(html, 'player');
const bar = elementRange(html, 'ctrlbar');
assert.ok(stage && player && bar, 'stage/player/ctrlbar موجودة');
assert.ok(stage.start < player.start && player.end <= stage.end, 'المشغّل داخل المسرح');
assert.ok(player.end <= bar.start, 'شريط التحكم بعد إغلاق المشغّل (أسفل الفيديو وليس فوقه)');
assert.ok(bar.end <= stage.end, 'شريط التحكم داخل بطاقة المسرح (فيُخفي مع طيّ الفيديو)');
assert.ok(html.indexOf('id="ctrlbar"') < html.indexOf('id="progressBar"'), 'شريط التقدم داخل شريط التحكم');
assert.ok(html.indexOf('id="playPauseBtn"') < html.indexOf('id="progressBar"'), 'زر التشغيل مع شريط التقدم في الشريط نفسه');

/* ---------- 2) عناصر التحكم المطلوبة ---------- */
for (const id of ['centerPlayBtn', 'playPauseBtn', 'progressBar', 'progressTip', 'curTime', 'durTime', 'muteBtn']) {
  assert.ok(html.includes(`id="${id}"`), `عنصر التحكم ${id} موجود`);
}
/* الشريط ظاهر في الغرفة الفارغة (يُخفى فقط لفيديوهات التضمين عبر room.js) */
assert.ok(!/<div class="ctrlbar vcontrols" id="ctrlbar"[^>]*\shidden/.test(html), 'شريط التحكم ظاهر افتراضياً');

/* ---------- 3) المحذوف نهائياً: شريط الصوت + ملء الشاشة + التقديم/الترجيع ---------- */
for (const id of ['volRange', 'fullBtn', 'skipBackBtn', 'skipFwdBtn']) {
  assert.ok(!html.includes(`id="${id}"`), `${id} يجب أن يكون محذوفاً من الغرفة`);
  assert.ok(!js.includes(`'${id}'`), `${id} لا يُستعمل في room.js`);
}
assert.doesNotMatch(js, /fullscreen|RequestFullscreen|exitFullscreen/i, 'لا كود ملء شاشة في الغرفة');
assert.doesNotMatch(js, /setVolume\(|volRange/, 'لا كود شريط صوت في الغرفة');
assert.doesNotMatch(js, /e\.key\.toLowerCase\(\) === 'f'/, 'لا اختصار ملء شاشة');
/* أزرار التقديم/الترجيع محذوفة — يبقى مفتاحا السهمين للتنقل بلا واجهة */
assert.doesNotMatch(js, /el\.skip(Back|Fwd)/, 'لا مراجع لأزرار التقديم/الترجيع');
assert.match(js, /skip\(-10\)/, 'الترجيع بمفتاح السهم الأيمن');
assert.match(js, /skip\(\+10\)/, 'التقديم بمفتاح السهم الأيسر');
assert.doesNotMatch(css, /\.vol\b(?!ume)/, 'لا تنسيق لشريط الصوت');
assert.doesNotMatch(css, /\.vcontrols \.vol/, 'لا تنسيق لشريط الصوت داخل شريط التحكم');

/* ---------- 4) المشغّل بلا أزرار أصلية، والتحكم عبر الطبقة الموحّدة ---------- */
assert.match(js, /player\.load\(parsed, \{ autoplay: !!opts\.autoplay, controls: false \}\)/);
assert.match(js, /el\.ctrlbar\.hidden = parsed\.kind === 'embed'/);
assert.match(js, /player\._video\.controls = false/);
assert.match(js, /el\.player\.addEventListener\('click'/, 'النقر على الفيديو يبدّل التشغيل');
assert.match(js, /function pokeVideoUI\(\)/, 'طبقة التحكم موحّدة');

/* ---------- 5) CSS: الشريط أسفل الفيديو وظاهر دائماً، والرسائل كبيرة ---------- */
assert.match(css, /\.room-body \.ctrlbar\.vcontrols \{[^}]*position: static/, 'شريط التحكم أسفل الفيديو (بلا تعويم فوق الصورة)');
assert.match(css, /\.room-body \.stage \{[^}]*flex-direction: column/, 'المسرح عمودي: الفيديو ثم الشريط');
assert.doesNotMatch(css, /\.player\.is-playing\.is-ui-hidden \.vcontrols \{ opacity: 0/, 'لا إخفاء تلقائي للتحكم');
assert.match(css, /\.room-main > #chat \{[^}]*display: flex/, 'الرسائل ظاهرة دائماً');
assert.match(css, /\.room-main > #chat \{[^}]*flex: 1 1 auto/, 'الرسائل تأخذ المساحة المتبقية');
assert.match(css, /\.room-main > #chat \{[^}]*min-height: 240px/, 'الرسائل ذات ارتفاع أدنى معقول');
assert.match(css, /width: min\(100%, max\(320px, 54vh\)\)/, 'ارتفاع الفيديو محدود لتبقى للرسائل المساحة الأكبر');
assert.match(css, /\.vcenter \{/, 'الزر المركزي ما زال موجوداً');
assert.match(css, /\.room\.is-media-collapsed \.stage \.player \{ display: none; \}/, 'طيّ الفيديو يُخفي الصورة ويُبقي التحكم');
assert.match(css, /\.vcontrols\[hidden\], |\.room-body \.ctrlbar\.vcontrols\[hidden\] \{ display: none !important; \}/, 'إخفاء الشريط للتضمينات');
console.log('Player control regression checks passed');

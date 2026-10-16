/* =========================================================
   WatchTogether — اختبار هيكل التحكم في المشغّل (بلا متصفح)
   ---------------------------------------------------------
   العقد الحالي (الإصدار 2.7):
     1) كل التحكم داخل الفيديو: ترجيع/تقديم 10 ثوانٍ على الحافتين،
        تشغيل/إيقاف في المنتصف، وشريط التنقل (وقت + تقدم) أسفله بوسطه
     2) لا شريط تحكم أسفل الفيديو إطلاقاً
     3) محذوف نهائياً: شريط الصوت/الكتم، ملء الشاشة، الشريط القديم ctrlbar
     4) صندوق الرسائل: آخر 6 رسائل مرئية والأقدم بالتمرير
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

/* ---------- 1) البنية: كل التحكم داخل الفيديو ---------- */
const stage = elementRange(html, 'stage');
const player = elementRange(html, 'player');
assert.ok(stage && player, 'stage/player موجودة');
assert.ok(stage.start < player.start && player.end <= stage.end, 'المشغّل داخل المسرح');
assert.ok(!html.includes('id="ctrlbar"'), 'الشريط القديم أسفل الفيديو محذوف');
assert.ok(!html.includes('id="playPauseBtn"'), 'زر التشغيل القديم أسفل الفيديو محذوف');
assert.ok(!html.includes('id="muteBtn"'), 'زر الكتم محذوف');

/* أزرار الحافتين + المنتصف + شريط التنقل كلها داخل المشغّل */
for (const id of ['seekBackBtn', 'seekFwdBtn', 'centerPlayBtn', 'vbar', 'progressBar']) {
  const r = elementRange(html, id);
  assert.ok(r && r.start > player.start && r.end <= player.end, `${id} داخل الفيديو`);
}
assert.ok(html.indexOf('id="vbar"') > html.indexOf('id="centerPlayBtn"'), 'شريط التنقل بعد زر المنتصف (أسفله)');
assert.ok(html.indexOf('id="progressBar"') > html.indexOf('id="vbar"'), 'شريط التقدم داخل شريط التنقل');

/* ---------- 2) عناصر التحكم المطلوبة ---------- */
for (const id of ['centerPlayBtn', 'iconPlay', 'iconPause', 'progressBar', 'progressTip', 'curTime', 'durTime', 'seekBackBtn', 'seekFwdBtn', 'vbar']) {
  assert.ok(html.includes(`id="${id}"`), `عنصر التحكم ${id} موجود`);
}
/* شريط التنقل ظاهر في الغرفة الفارغة (يُخفى فقط لفيديوهات التضمين عبر room.js) */
assert.ok(!/<div class="vbar vcontrols" id="vbar"[^>]*\shidden/.test(html), 'شريط التنقل ظاهر افتراضياً');

/* ---------- 3) المحذوف نهائياً: الكتم + ملء الشاشة ---------- */
for (const id of ['volRange', 'fullBtn', 'iconSound', 'iconMuted', 'playPauseBtn', 'muteBtn', 'ctrlbar']) {
  assert.ok(!html.includes(`id="${id}"`), `${id} يجب أن يكون محذوفاً من الغرفة`);
}
assert.doesNotMatch(js, /fullscreen|RequestFullscreen|exitFullscreen/i, 'لا كود ملء شاشة في الغرفة');
assert.doesNotMatch(js, /setVolume\(|volRange/, 'لا كود شريط صوت في الغرفة');
assert.doesNotMatch(js, /e\.key\.toLowerCase\(\) === 'f'/, 'لا اختصار ملء شاشة');
assert.doesNotMatch(js, /el\.muteBtn/, 'لا مراجع لزر الكتم');
assert.doesNotMatch(js, /el\.ctrlbar/, 'لا مراجع للشريط القديم');
assert.doesNotMatch(js, /el\.playPause\b/, 'لا مراجع لزر التشغيل القديم');

/* أزرار التقدم/الترجيع تعمل على الحافتين + السهمان محفوظان */
assert.match(js, /el\.seekBackBtn\.addEventListener\('click', \(\) => skip\(-10\)\)/, 'الترجيع من زر الحافة');
assert.match(js, /el\.seekFwdBtn\.addEventListener\('click', \(\) => skip\(\+10\)\)/, 'التقديم من زر الحافة');
assert.match(js, /skip\(-10\)/, 'الترجيع بمفتاح السهم الأيمن');
assert.match(js, /skip\(\+10\)/, 'التقديم بمفتاح السهم الأيسر');
assert.doesNotMatch(css, /\.vol\b(?!ume)/, 'لا تنسيق لشريط الصوت');

/* ---------- 4) المشغّل بلا أزرار أصلية، والتحكم عبر الطبقة الموحّدة ---------- */
assert.match(js, /player\.load\(parsed, \{ autoplay: !!opts\.autoplay, controls: false \}\)/);
assert.match(js, /el\.vbar\.hidden = isEmbed/, 'إخفاء شريطنا لفيديوهات التضمين');
assert.match(js, /player\._video\.controls = false/);
assert.match(js, /el\.player\.addEventListener\('click'/, 'النقر على الفيديو يبدّل التشغيل');
assert.match(js, /function pokeVideoUI\(\)/, 'طبقة التحكم موحّدة');
assert.match(js, /if \(el\.centerPlay\) el\.centerPlay\.addEventListener\('click', togglePlay\)/, 'الزر الأوسط يبدّل التشغيل/الإيقاف');

/* ---------- 5) CSS: التحكم داخل الفيديو، والرسائل محدودة بآخر 6 ---------- */
assert.match(css, /\.vbar \{[^}]*position: absolute/, 'شريط التنقل مثبّت داخل الفيديو');
assert.match(css, /\.vseek--back \{[^}]*inset-inline-start/, 'زر الترجيع على الحافة اليمنى (بداية RTL)');
assert.match(css, /\.vseek--fwd \{[^}]*inset-inline-end/, 'زر التقديم على الحافة اليسرى (نهاية RTL)');
assert.match(css, /\.vcenter \{[^}]*position: absolute/, 'زر المنتصف داخل الفيديو');
assert.match(css, /\.vcenter\.is-playing/, 'الزر الأوسط يبقى ظاهراً (خفيف) أثناء التشغيل');
assert.match(css, /\.ctrlbar \{ display: none !important; \}/, 'كل قواعد الشريط القديم ملغاة صراحة');
assert.match(css, /\.chat__body \{[^}]*max-height: 342px/, 'صندوق الرسائل له سقف (آخر 6 رسائل)');
assert.match(js, /CHAT_VISIBLE_MAX = 6/, 'السقف يحسبه fitChatViewport لآخر 6 رسائل');
assert.match(js, /function fitChatViewport\(\)/, 'ضبط سقف الصندوق ديناميكياً');
assert.match(css, /\.room-main > #chat \{[^}]*display: flex/, 'الرسائل ظاهرة دائماً');
assert.match(css, /width: min\(100%, max\(320px, 54vh\)\)/, 'ارتفاع الفيديو محدود لتبقى للرسائل المساحة الأكبر');
assert.match(css, /\.room\.is-media-collapsed \.stage \.player \{ display: none; \}/, 'طيّ الفيديو يُخفي الصورة ويُبقي التحكم');
assert.match(css, /\.vbar\[hidden\] \{ display: none !important; \}/, 'إخفاء الشريط للتضمينات');
console.log('Player control regression checks passed');

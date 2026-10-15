import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8');
const [html, js, css] = await Promise.all([read('room.html'), read('assets/js/room.js'), read('assets/css/app.css')]);

/* التحكم داخل الفيديو: لا يوجد شريط تحكم/تقدم منفصل أسفل المشغّل */
assert.equal((html.match(/id="ctrlbar"/g) || []).length, 1);
assert.ok(!/<section class="ctrlbar/.test(html), 'يجب ألا يوجد شريط تحكم منفصل أسفل الفيديو');
assert.ok(html.indexOf('id="mediaShell"') < html.indexOf('id="stage"'));
assert.ok(html.indexOf('id="stage"') < html.indexOf('id="player"'));
assert.ok(html.indexOf('id="player"') < html.indexOf('id="ctrlbar"'), 'شريط التحكم داخل المشغّل نفسه');
assert.ok(html.indexOf('id="ctrlbar"') < html.indexOf('id="progressBar"'));
assert.ok(html.indexOf('id="ctrlbar"') < html.indexOf('<!-- الأزرار الثلاثة المطلوبة أسفل المشغّل -->'));

/* عناصر التحكم من الفيديو: زر مركزي، تقديم/ترجيع، ملء شاشة، معاينة وقت */
for (const id of ['centerPlayBtn', 'skipBackBtn', 'skipFwdBtn', 'fullBtn', 'progressTip']) {
  assert.ok(html.includes(`id="${id}"`), `عنصر التحكم ${id} موجود داخل الفيديو`);
}
assert.ok(html.indexOf('id="player"') < html.indexOf('id="fullBtn"') &&
  html.indexOf('id="fullBtn"') < html.indexOf('<!-- الأزرار الثلاثة المطلوبة أسفل المشغّل -->'),
  'زر ملء الشاشة داخل منطقة الفيديو');

/* المشغّل بلا أزرار أصلية: التحكم كله عبر الطبقة الموحّدة فوق الفيديو */
assert.match(js, /player\.load\(parsed, \{ autoplay: !!opts\.autoplay, controls: false \}\)/);
assert.match(js, /el\.ctrlbar\.hidden = parsed\.kind === 'embed'/);
assert.match(js, /player\._video\.controls = false/);
assert.match(js, /const target = el\.mediaShell/);
assert.match(js, /el\.player\.addEventListener\('click'/, 'النقر على الفيديو يبدّل التشغيل');
assert.match(js, /function pokeVideoUI\(\)/, 'إظهار/إخفاء تلقائي لطبقة التحكم');
assert.match(js, /skip\(-10\)/);
assert.match(js, /skip\(10\)/);

/* الطبقة فوق الفيديو مباشرة وتختفي أثناء التشغيل */
assert.match(css, /\.ctrlbar\.vcontrols \{\s*position: absolute;/);
assert.match(css, /\.player\.is-playing\.is-ui-hidden \.vcontrols \{ opacity: 0;/);
assert.match(css, /\.vcenter \{/);
assert.match(css, /\.vcontrols\[hidden\] \{ display: none !important; \}/);
assert.doesNotMatch(css, /position: sticky; bottom: 0; z-index: 45/);
console.log('Player control regression checks passed');

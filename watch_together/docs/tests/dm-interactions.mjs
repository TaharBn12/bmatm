/* =========================================================
   WatchTogether — التفاعل السريع وسحب الردّ (dm-interactions)
   منطق الإيماءات حقيقي (vm)، وربط الواجهة وSQL يُفحصان نصياً.

   التشغيل: node docs/tests/dm-interactions.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : String(detail));
}

/* ==================== 1) منطق الإيماءات ==================== */
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('assets/js/dm-gestures.js'), sandbox, { filename: 'dm-gestures.js' });
const G = sandbox.WTDMGestures;

{
  t('الوحدة تُحمَّل', !!G && typeof G.swipeIntent === 'function');
  t('تفاعل واحد سريع افتراضي', G.QUICK === '❤️');
  t('قائمة تفاعلات محدودة', Array.isArray(G.REACTIONS) && G.REACTIONS.length === 5 &&
    G.reactionAllowed('❤️') && G.reactionAllowed('🔥'));

  const tap = G.swipeIntent(4, 2);
  t('نقرة صغيرة لا تسحب', tap.active === false && tap.trigger === false);

  const scroll = G.swipeIntent(10, 60);
  t('التمرير العمودي يُترك للمتصفح', scroll.vertical === true && scroll.active === false);

  const short = G.swipeIntent(30, 4);
  t('سحب قصير: حركة بلا ردّ', short.active === true && short.trigger === false && short.offset === 30);

  const full = G.swipeIntent(60, 6);
  t('سحب كافٍ: يُفعّل الردّ', full.trigger === true && full.direction === 1 && full.offset === 60);

  const left = G.swipeIntent(-70, 5);
  t('السحب لليسار يعمل أيضاً (RTL)', left.trigger === true && left.direction === -1 && left.offset === -70);

  t('الحركة مقيدة بحد أقصى', G.swipeIntent(400, 0).offset === G.SWIPE_MAX);
  t('سحب قطري قوي لا يُفعّل الردّ', G.swipeIntent(50, 45).trigger === false);

  t('toggleReaction: يضع ❤️ على رسالة بلا تفاعل', G.toggleReaction(null, '❤️') === '❤️');
  t('toggleReaction: النقر مرتين يزيل', G.toggleReaction('❤️', '❤️') === null);
  t('toggleReaction: يبدّل إلى تفاعل آخر', G.toggleReaction('🔥', '❤️') === '❤️');
  t('toggleReaction: يرفض تفاعلاً غير مدعوم', G.reactionAllowed('💀') === false);
}

/* ==================== 2) SQL ==================== */
{
  const sql = read('docs/sql/11-dm-reactions.sql');
  t('SQL: عمود reaction', /add column if not exists reaction text/.test(sql));
  t('SQL: قيد التفاعلات المسموحة', /check \(reaction is null or reaction in/.test(sql));
  t('SQL: يعيد بناء message_json مع التفاعل', /create or replace function wt_social_private\.message_json/.test(sql) &&
    /'reaction',m\.reaction/.test(sql));
  t('SQL: RPC محمي للمسجّلين فقط', /wt_social_react\(bigint,text\) from public, anon/.test(sql) &&
    /grant execute on function public\.wt_social_react\(bigint,text\) to authenticated/.test(sql));
  t('SQL: يتحقّق من الصداقة والحظر', /if not wt_social_private\.friends\(u, peer\) or wt_social_private\.blocked\(u, peer\)/.test(sql));
  t('SQL: لا تفاعل على رسالة محذوفة', /m\.deleted_at is not null[\s\S]{0,120}raise exception/.test(sql));
  t('SQL: التغيير يرفع version (لبثّ فوري)', /version = nextval\('public\.wt_social_change_seq'\)/.test(sql));
  t('SQL: تحديد معدّل', /consume\('react:'/.test(sql));
  t('SQL: idempotent', !/drop table/i.test(sql) && !/delete from/i.test(sql));
}

/* ==================== 3) الواجهة ==================== */
{
  const messages = read('assets/js/messages.js');
  const html = read('messages.html');
  const css = read('assets/css/social.css');
  const social = read('assets/js/social.js');
  const sw = read('sw.js');

  t('الواجهة: يستخدم وحدة الإيماءات', /window\.WTDMGestures/.test(messages));
  t('الواجهة: نقر مزدوج للتفاعل', /addEventListener\('dblclick'/.test(messages) && /reactTo\(ctx,m\)/.test(messages));
  t('الواجهة: زرّ تفاعل في قائمة الإجراءات', /data-msg-action="react"/.test(messages));
  t('الواجهة: يعرض التفاعل على الفقاعة', /class="dm-reaction"/.test(messages));
  t('الواجهة: سحب باللمس', /touchstart/.test(messages) && /touchmove/.test(messages) && /touchend/.test(messages));
  t('الواجهة: السحب يفتح الردّ', /startReply\(ctx,m\)/.test(messages));
  t('الواجهة: ينظّف حالة السحب', /row\.classList\.remove\('is-swiping','is-ready'\)/.test(messages));
  t('الواجهة: يمنع التفاعل بلا صلاحية إرسال', /!ctx\.canSend \|\| !m \|\| m\.deleted_at \|\| ctx\.reactBusy/.test(messages));
  t('الواجهة: رسالة واضحة إن لم يُنفَّذ 11', /11-dm-reactions\.sql/.test(messages));
  t('الواجهة: لا يعلن نجاحاً قبل الخادم', /const updated = await S\.call\('react'/.test(messages));

  t('social.js: طريقة react مسجّلة', /'call_current','call_reset','react'/.test(social));
  t('messages.html: يحمّل dm-gestures قبل messages.js',
    html.indexOf('dm-gestures.js') > 0 && html.indexOf('dm-gestures.js') < html.indexOf('assets/js/messages.js'));

  t('CSS: تفاعل منسّق', /\.dm-reaction\s*\{/.test(css));
  t('CSS: حالة السحب', /\.dm-row\.is-swiping/.test(css) && /\.dm-row\.is-ready/.test(css));
  t('CSS: يحترم تقليل الحركة', /prefers-reduced-motion[\s\S]{0,120}dm-reaction/.test(css) ||
    /data-wt-motion="reduce"\] \.dm-reaction/.test(css));

  t('sw.js: يخزّن dm-gestures', /'assets\/js\/dm-gestures\.js'/.test(sw));
}

console.log(`DM interactions: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

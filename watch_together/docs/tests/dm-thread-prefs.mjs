/* =========================================================
   WatchTogether — تفضيلات المحادثة: تثبيت · كتم · أرشفة
   يفحص عقد SQL (جدول لكل مستخدم، RLS مغلق، فصل المؤرشف)
   وربط الواجهة (قائمة الخيارات، إخفاء العدّاد عند الكتم، زرّ الأرشيف).

   التشغيل: node docs/tests/dm-thread-prefs.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
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

const sql = read('docs/sql/12-dm-thread-prefs.sql');
const messages = read('assets/js/messages.js');
const html = read('messages.html');
const css = read('assets/css/social.css');
const social = read('assets/js/social.js');

/* ==================== 1) قاعدة البيانات ==================== */
t('SQL: جدول تفضيلات لكل (محادثة، مستخدم)', /create table if not exists public\.wt_dm_prefs/.test(sql) &&
  /primary key \(thread_id, user_id\)/.test(sql));
t('SQL: الأعمدة الثلاثة', /pinned\s+boolean not null default false/.test(sql) &&
  /muted\s+boolean not null default false/.test(sql) &&
  /archived\s+boolean not null default false/.test(sql));
t('SQL: RLS مفعّلة والجدول مغلق', /alter table public\.wt_dm_prefs enable row level security/.test(sql) &&
  /revoke all on public\.wt_dm_prefs from public, anon, authenticated/.test(sql));
t('SQL: التفضيل يخصّ المستخدم وحده', /thread_id = t\.id and pr\.user_id = u/.test(sql));
t('SQL: RPC واحدة بثلاثة خيارات', /wt_social_thread_pref\([\s\S]{0,120}p_pinned boolean default null/.test(sql));
t('SQL: null لا يمسح القيمة الحالية', /coalesce\(p_pinned,\s+p\.pinned\)/.test(sql) &&
  /coalesce\(p_muted,\s+p\.muted\)/.test(sql) && /coalesce\(p_archived,\s+p\.archived\)/.test(sql));
t('SQL: يتحقّق من عضوية المحادثة', /perform wt_social_private\.thread_peer\(p_thread, u\)/.test(sql));
t('SQL: صلاحيات RPC للمسجّلين فقط', /wt_social_thread_pref\(uuid,boolean,boolean,boolean\) from public, anon/.test(sql) &&
  /grant execute on function public\.wt_social_thread_pref\(uuid,boolean,boolean,boolean\) to authenticated/.test(sql));
t('SQL: المؤرشف مخفي افتراضياً', /p_archived boolean default false/.test(sql) &&
  /coalesce\(pr\.archived,false\) = coalesce\(p_archived,false\)/.test(sql));
t('SQL: المثبّتة أولاً', /order by pinned desc, activity desc/.test(sql));
t('SQL: يعدّ المخفي ليُعلم المستخدم', /hidden_archived/.test(sql));
t('SQL: يعيد التفضيلات مع كل محادثة', /'prefs', jsonb_build_object\('pinned'/.test(sql));
t('SQL: يحدّث مخطط PostgREST', /notify pgrst, 'reload schema'/.test(sql));
t('SQL: لا يحذف رسائل أو محادثات', !/delete from/i.test(sql) && !/drop table/i.test(sql));
t('SQL: يزيل التوقيع القديم لقائمة المحادثات', /drop function if exists public\.wt_social_threads\(int\)/.test(sql));

/* ==================== 2) الواجهة ==================== */
t('social.js: thread_pref مسجّلة', /'react','thread_pref'/.test(social));
t('الواجهة: قائمة خيارات لكل محادثة', /data-thread-menu=/.test(messages) && /function openThreadMenu/.test(messages));
t('الواجهة: ثلاثة خيارات', /threadMenuItem\('pinned'/.test(messages) && /threadMenuItem\('muted'/.test(messages) &&
  /threadMenuItem\('archived'/.test(messages));
t('الواجهة: تحفظ عبر RPC واحدة', /S\.call\('thread_pref',args\)/.test(messages));
t('الواجهة: ترسل المفتاح المتغيّر فقط', /args\['p_' \+ key\] = !!value/.test(messages));
t('الواجهة: لا تفترض النجاح قبل الخادم', /const data = await S\.call\('thread_pref'/.test(messages) &&
  /U\.toast\(key === 'pinned'/.test(messages));
t('الواجهة: رسالة واضحة إن لم يُنفَّذ 12', /12-dm-thread-prefs\.sql/.test(messages));
t('الواجهة: الأرشفة تخفي من القائمة فقط', /أرشفة \(إخفاء من القائمة\)/.test(messages) &&
  /لا تحذف أي رسالة/.test(messages));
t('الواجهة: زرّ عرض المؤرشف', /id="threadArchived"/.test(html) && /threadArchived'\)\.onclick/.test(messages));
t('الواجهة: عدّاد المؤرشف يظهر عند وجوده', /state\.hiddenArchived/.test(messages) && /archivedCount\.hidden/.test(messages));
t('الواجهة: كتم يُخفي شارة العدّاد فقط', /const unread = t\.unread && !prefs\.muted/.test(messages) &&
  /\/\* الكتم يخفي شارة العدّاد فقط/.test(messages));
t('الواجهة: علامة تثبيت وكتم في الصف', /thread-flag/.test(messages) && /icon\('pin',12\)/.test(messages));
t('الواجهة: القائمة تُغلق بالنقر خارجها أو Escape', /closeThreadMenu\(\)/.test(messages) &&
  /event\.key === 'Escape'/.test(messages));
t('الواجهة: ترسل حالة الأرشيف للخادم', /p_archived:!!state\.showArchived/.test(messages));
t('CSS: تنسيق القائمة وزرّ الأرشيف', /\.dm-thread-menu\s*\{/.test(css) && /\.thread-archive-toggle\s*\{/.test(css));

console.log(`DM thread prefs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

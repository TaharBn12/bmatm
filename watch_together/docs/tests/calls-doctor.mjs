/* =========================================================
   WatchTogether — اختبار ملف التشخيص docs/sql/11-calls-doctor.sql
   التشغيل:  node docs/tests/calls-doctor.mjs
   ---------------------------------------------------------
   يعمل على PostgreSQL حقيقي (PGlite) لا على نصّ مُحاكى:
     1) بعد 09-calls.sql → كل الصفوف سليمة
     2) قبل 09          → يقول «ناقص» ويوجّه إلى 09
     3) توقيع قديم مكرّر → يكشفه ويعطي أمر drop الصحيح
     4) دالة محذوفة      → يكشفها بالاسم
   إن لم تكن حزمة pglite مثبّتة يُتخطّى الاختبار بلا فشل.
   ========================================================= */
import fs from 'fs';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch (e) {
  console.log('Calls doctor: skipped (npm install @electric-sql/pglite)');
  process.exit(0);
}

const SQL = (name) => fs.readFileSync(new URL('../sql/' + name, import.meta.url), 'utf8');
const DOCTOR = SQL('11-calls-doctor.sql');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push('✗ ' + name + ' ' + extra); }
};

/* بيئة Supabase مصغّرة: نفس ما تفترضه ملفات SQL */
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      created_at timestamptz default now(), updated_at timestamptz default now());
    create publication supabase_realtime;
    create table storage.buckets(id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),
      bucket_id text references storage.buckets(id), name text, owner uuid default auth.uid(),
      metadata jsonb, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert, delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select string_to_array(name, '/') $$;
    insert into auth.users(id, email, raw_user_meta_data) values
      ('${A}', 'a@example.com', '{"full_name":"أحمد"}'),
      ('${B}', 'b@example.com', '{"full_name":"مريم"}');
  `);
  await db.exec(SQL('01-bootstrap.sql'));
  await db.exec(SQL('07-social.sql'));
  return db;
}

/* يعيد صفوف التقرير مفهرسة برقم الفحص */
async function report(db) {
  const result = await db.query(DOCTOR);
  const rows = result.rows;
  const byCheck = {};
  rows.forEach((row) => { byCheck[String(row['الفحص'])] = row; });
  const summary = rows.find((row) => row['#'] === 999);
  return { rows, byCheck, summary };
}
const statusOf = (byCheck, fragment) => {
  const key = Object.keys(byCheck).find((name) => name.includes(fragment));
  return key ? byCheck[key]['النتيجة'] : '—';
};

/* ---------------- 1) التقرير نفسه: للقراءة فقط ---------------- */
{
  t('الملف موجود', fs.existsSync(new URL('../sql/11-calls-doctor.sql', import.meta.url)));
  t('موسوم بأنه للقراءة فقط', /للقراءة فقط/.test(DOCTOR));
  t('لا ينفّذ أي تعديل على المخطط', !/^\s*(create|alter|insert|update|delete|drop|grant|revoke)\s/im.test(DOCTOR));
  t('يفحص كل دوال المكالمات', (DOCTOR.match(/wt_social_call/g) || []).length >= 10);
  t('يفحص الجدولين', /wt_dm_calls/.test(DOCTOR) && /wt_call_signals/.test(DOCTOR));
  t('يفحص عمود allow_calls', /allow_calls/.test(DOCTOR));
  t('يكشف التواقيع المكرّرة', /to_regprocedure/.test(DOCTOR) && /PGRST203|نسخ مكرّرة/.test(DOCTOR));
  t('يقترح تحديث كاش PostgREST', /reload schema/.test(DOCTOR));
}

/* ---------------- 2) بعد 09: كل شيء سليم ---------------- */
let db = await database();
await db.exec(SQL('09-calls.sql'));
{
  const { rows, byCheck, summary } = await report(db);
  t('سليم: يُنتج صفوفاً', rows.length >= 15, String(rows.length));
  t('سليم: المخطط موجود', /✅/.test(statusOf(byCheck, 'wt_social_private')));
  t('سليم: جدول المكالمات', /✅/.test(statusOf(byCheck, 'wt_dm_calls')));
  t('سليم: جدول الإشارات', /✅/.test(statusOf(byCheck, 'wt_call_signals')));
  t('سليم: عمود allow_calls', /✅/.test(statusOf(byCheck, 'allow_calls')));
  t('سليم: كل الدوال العشر جاهزة', rows.filter((r) => /الدالة /.test(r['الفحص']) && /✅/.test(r['النتيجة'])).length === 10);
  t('سليم: لا نسخ مكرّرة', /✅/.test(statusOf(byCheck, 'مكرّرة')));
  t('سليم: لا مكالمات معلّقة', /✅/.test(statusOf(byCheck, 'مفتوحة')));
  t('سليم: خلاصة إيجابية', /✅/.test(summary['النتيجة']), summary['النتيجة']);
  t('سليم: لا يوصي بحذف أي دالة', !/drop function/.test(summary['ما تفعله'] || ''));
}
await db.close();

/* ---------------- 3) قبل 09: يقول ناقص ---------------- */
db = await database();
{
  const { byCheck, summary } = await report(db);
  t('بدون 09: جدول المكالمات مفقود', /❌/.test(statusOf(byCheck, 'wt_dm_calls')));
  t('بدون 09: دالة البداية مفقودة', /❌/.test(statusOf(byCheck, 'wt_social_call_start')));
  t('بدون 09: الخلاصة توجّه إلى 09', /09/.test(summary['ما تفعله'] || ''), summary['ما تفعله']);
}
await db.close();

/* ---------------- 4) توقيع قديم مكرّر ---------------- */
db = await database();
await db.exec(SQL('09-calls.sql'));
await db.exec("create function public.wt_social_call_start(p_thread uuid) returns jsonb language sql as $$ select '{}'::jsonb $$");
{
  const { byCheck, summary } = await report(db);
  const dup = Object.keys(byCheck).find((name) => name.includes('مكرّرة'));
  t('تكرار: يكشف النسخة الزائدة', /⚠️/.test(byCheck[dup]['النتيجة']), byCheck[dup]['النتيجة']);
  t('تكرار: يعطي أمر drop الصحيح', /drop function wt_social_call_start\(uuid\);/.test(byCheck[dup]['ما تفعله'] || ''),
    byCheck[dup]['ما تفعله']);
  t('تكرار: الخلاصة تطلب الحذف', /احذفها/.test(summary['النتيجة'] || ''), summary['النتيجة']);
  t('تكرار: لا يحذف شيئاً بنفسه (التوقيع ما زال موجوداً)',
    (await db.query("select 1 from pg_proc where proname='wt_social_call_start'")).rows.length === 2);
}
await db.close();

/* ---------------- 5) دالة محذوفة ---------------- */
db = await database();
await db.exec(SQL('09-calls.sql'));
await db.exec('drop function public.wt_social_call_end(uuid,text)');
{
  const { byCheck, summary } = await report(db);
  t('ناقص: يكشف الدالة المحذوفة بالاسم', /❌/.test(statusOf(byCheck, 'wt_social_call_end')));
  t('ناقص: بقية الدوال سليمة', /✅/.test(statusOf(byCheck, 'wt_social_call_start')));
  t('ناقص: الخلاصة حمراء', /❌/.test(summary['النتيجة'] || ''), summary['النتيجة']);
}
await db.close();

if (errors.length) console.log(errors.join('\n'));
console.log(`Calls doctor: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

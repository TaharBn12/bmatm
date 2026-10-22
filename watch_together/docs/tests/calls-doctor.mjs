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

/* ---------------- 6) دورة مكالمة كاملة على قاعدة حقيقية ---------------- */
/* يكشف أعطالاً لا يراها أي فحص نصّي: دوال pgcrypto غير المتاحة (42883)،
   أو منع «مكالمة عالقة» يوقف كل المكالمات، أو nonce لا يطابق قيد الجدول. */
db = await database();
await db.exec(SQL('09-calls.sql'));
{
  const as = (user, sql, params = []) => db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return tx.query(sql, params);
  });
  const call = async (user, name, args = {}) => {
    const keys = Object.keys(args);
    const result = await as(user, 'select public.' + name + '(' +
      keys.map((key, i) => key + ' => $' + (i + 1)).join(',') + ') as r',
      keys.map((key) => typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key]));
    return result.rows[0].r;
  };

  /* أي استثناء غير متوقّع يصبح فحصاً فاشلاً واضحاً لا أثراً مكدّساً */
  let hard = '';
  try {
    await call(A, 'wt_social_bootstrap');
    await call(B, 'wt_social_bootstrap');
    /* user_low/user_high أعمدة مولّدة — لا تُدرَج */
    await db.exec(`insert into public.wt_friendships(requester, recipient, status)
      values ('${A}', '${B}', 'accepted')`);
    const opened = await call(A, 'wt_social_open_thread', { p_user: B });
    const thread = { id: opened.id };
    let started = null, failure = '';
    try { started = await call(A, 'wt_social_call_start', { p_thread: thread.id, p_media: 'audio' }); }
    catch (error) { failure = error.code + ' ' + error.message; }
    t('مكالمة: البدء ينجح بين صديقين', !!started && started.ok === true, failure);
    t('مكالمة: الحالة رنين صادر', started && started.call.state === 'ringing', started && started.call.state);

    if (started) {
      const answered = await call(B, 'wt_social_call_answer', { p_call: started.call.id, p_accept: true });
      t('مكالمة: الرد ينقلها إلى جارية', answered.call.state === 'active', answered.call.state);
      const put = await call(A, 'wt_social_call_signal_put', { p_call: started.call.id, p_payload: { k: 'offer', sdp: 'v=0' } });
      t('مكالمة: إشارة WebRTC تُحفظ', put.ok === true);
      const got = await call(B, 'wt_social_call_signal_get', { p_call: started.call.id, p_after: 0 });
      t('مكالمة: الإشارة تصل للطرف الآخر', Array.isArray(got.signals) && got.signals.length === 1);
      const ended = await call(A, 'wt_social_call_end', { p_call: started.call.id, p_reason: 'hangup' });
      t('مكالمة: الإنهاء يُغلقها', ended.call.state === 'ended', ended.call.state);

      const logged = await db.query("select nonce, kind, body from public.wt_dm_messages where kind='call' order by id desc limit 1");
      t('مكالمة: سطر السجل يُكتب في المحادثة', logged.rows.length === 1);
      t('مكالمة: nonce يطابق قيد الجدول (48–128 hex)', /^[a-f0-9]{64}$/.test(logged.rows[0] ? logged.rows[0].nonce : ''), logged.rows[0] && logged.rows[0].nonce);
      const current = await call(A, 'wt_social_call_current');
      t('مكالمة: لا شيء معلّق بعد الإنهاء', !current.call);
    }

    /* الانحدار الشهير: مكالمة قديمة عالقة كانت تُفشل كل مكالمة جديدة بـ42883 */
    await db.exec(`insert into public.wt_dm_calls(thread_id, caller_id, callee_id, media, state, created_at, last_seen_at)
      values ('${thread.id}', '${B}', '${A}', 'audio', 'ringing', now() - interval '2 days', now() - interval '2 days')`);
    let second = null, err2 = '';
    try { second = await call(B, 'wt_social_call_start', { p_thread: thread.id, p_media: 'audio' }); }
    catch (error) { err2 = error.code + ' ' + error.message; }
    t('انحدار: مكالمة عالقة قديمة لا تمنع مكالمة جديدة', !!second && second.ok === true, err2);
    const stale = await db.query("select state from public.wt_dm_calls where created_at < now() - interval '1 day'");
    t('انحدار: العالقة القديمة أُغلقت تلقائياً', stale.rows.every((row) => row.state !== 'ringing'),
      stale.rows.map((row) => row.state).join(','));
  } catch (error) {
    hard = (error && (error.code || '')) + ' ' + (error && error.message ? error.message : String(error));
    t('مكالمة: الدورة كاملة بلا استثناء', false, hard);
  }
}
await db.close();

if (errors.length) console.log(errors.join('\n'));
console.log(`Calls doctor: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

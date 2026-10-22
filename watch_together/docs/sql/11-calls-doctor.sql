-- =====================================================================
--  WatchTogether — تشخيص المكالمات (11-calls-doctor.sql)
--  للقراءة فقط: لا يُنشئ ولا يحذف ولا يعدّل أي شيء. آمن تماماً.
--
--  استعمله عندما تقول الواجهة «ميزات المكالمات غير مفعّلة بعد» رغم أنك
--  نفّذت 09-calls.sql. يخبرك بالضبط أي كائن ناقص على **هذا** المشروع.
--
--  الخلاصة: إذا كانت كل الصفوف ✅ فالمشكلة ليست في قاعدة البيانات
--  (غالباً: الموقع يشير إلى مشروع آخر، أو كاش قديم) — راجع
--  docs/troubleshooting.md § «نفّذت 09 وما زالت المكالمات معطّلة».
-- =====================================================================

with expected(fn, sig) as (
  values
    ('wt_social_calls_pref',     'public.wt_social_calls_pref(boolean)'),
    ('wt_social_call_start',     'public.wt_social_call_start(uuid,text)'),
    ('wt_social_call_answer',    'public.wt_social_call_answer(uuid,boolean)'),
    ('wt_social_call_end',       'public.wt_social_call_end(uuid,text)'),
    ('wt_social_call_state',     'public.wt_social_call_state(uuid)'),
    ('wt_social_call_signal_put','public.wt_social_call_signal_put(uuid,jsonb)'),
    ('wt_social_call_signal_get','public.wt_social_call_signal_get(uuid,bigint)'),
    ('wt_social_call_incoming',  'public.wt_social_call_incoming(uuid)'),
    ('wt_social_call_current',   'public.wt_social_call_current()'),
    ('wt_social_call_reset',     'public.wt_social_call_reset()')
),

report as (
  /* ---- 1) المخطط الداخلي ---- */
  select 1 as ord, 'المخطط wt_social_private' as check_name,
    case when exists (select 1 from pg_namespace where nspname = 'wt_social_private')
         then '✅ موجود' else '❌ مفقود' end as status,
    case when exists (select 1 from pg_namespace where nspname = 'wt_social_private')
         then 'الدوال الداخلية تعيش هنا' else 'كل دوال المكالمات الداخلية مفقودة' end as detail,
    case when exists (select 1 from pg_namespace where nspname = 'wt_social_private')
         then '—' else 'أعد تنفيذ 07-social.sql ثم 09-calls.sql' end as fix

  union all
  /* ---- 2) جدول المكالمات ---- */
  select 2, 'الجدول wt_dm_calls',
    case when to_regclass('public.wt_dm_calls') is null then '❌ مفقود'
         when (select relrowsecurity from pg_class where oid = to_regclass('public.wt_dm_calls')) then '✅ موجود + RLS'
         else '⚠️ موجود بلا RLS' end,
    case when to_regclass('public.wt_dm_calls') is null then 'لا وجود لجدول حالة المكالمة'
         else 'صفوف تقديرية: ' || coalesce((select greatest(reltuples, 0)::text from pg_class where oid = to_regclass('public.wt_dm_calls')), '0') end,
    case when to_regclass('public.wt_dm_calls') is null then 'نفّذ 09-calls.sql' else '—' end

  union all
  /* ---- 3) جدول الإشارات ---- */
  select 3, 'الجدول wt_call_signals',
    case when to_regclass('public.wt_call_signals') is null then '❌ مفقود'
         when (select relrowsecurity from pg_class where oid = to_regclass('public.wt_call_signals')) then '✅ موجود + RLS'
         else '⚠️ موجود بلا RLS' end,
    case when to_regclass('public.wt_call_signals') is null then 'لا وجود لجدول إشارات WebRTC'
         else 'صفوف تقديرية: ' || coalesce((select greatest(reltuples, 0)::text from pg_class where oid = to_regclass('public.wt_call_signals')), '0') end,
    case when to_regclass('public.wt_call_signals') is null then 'نفّذ 09-calls.sql' else '—' end

  union all
  /* ---- 4) عمود تفضيل الاستقبال ---- */
  select 4, 'العمود wt_profiles.allow_calls',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'wt_profiles' and column_name = 'allow_calls')
         then '✅ موجود' else '❌ مفقود' end,
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'wt_profiles' and column_name = 'allow_calls')
         then 'يتحكّم في زر «استقبال المكالمات» بكل حساب'
         else 'زر «استقبال المكالمات» في الملف الشخصي لن يعمل' end,
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'wt_profiles' and column_name = 'allow_calls')
         then '—' else 'نفّذ 09-calls.sql' end

  union all
  /* ---- 5) الدوال العامة العشر ---- */
  select 9 + row_number() over (order by e.fn), 'الدالة ' || e.fn,
    case when to_regprocedure(e.sig) is null then '❌ غير موجودة'
         when has_function_privilege('authenticated', e.sig, 'execute') then '✅ جاهزة'
         else '⚠️ بلا صلاحية' end,
    'التوقيع المتوقّع: ' || e.sig,
    case when to_regprocedure(e.sig) is null then 'نفّذ 09-calls.sql كاملاً'
         when has_function_privilege('authenticated', e.sig, 'execute') then '—'
         else 'grant execute on function ' || e.sig || ' to authenticated;' end
  from expected e

  union all
  /* ---- 6) الدوال الداخلية ---- */
  select 30, 'الدوال الداخلية (call_expire/call_finalize/call_touch/thread_peer)',
    case when found = 4 then '✅ كلها موجودة'
         when found = 0 then '❌ كلها مفقودة'
         else '⚠️ ' || found || ' من 4' end,
    'ناقص منها يمنع التنظيف التلقائي وإغلاق المكالمات المهجورة',
    case when found = 4 then '—' else 'نفّذ 09-calls.sql كاملاً' end
  from (
    select count(*) as found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'wt_social_private'
      and p.proname in ('call_expire', 'call_finalize', 'call_touch', 'thread_peer')
  ) internal_fn

  union all
  /* ---- 6ب) دوال pgcrypto غير المتاحة (سبب 42883 الشائع جداً) ---- */
  select 40, 'اعتماد على pgcrypto داخل دوالنا',
    case when count(*) = 0 then '✅ لا اعتماد'
         else '❌ ' || count(*) || ' دالة معطوبة' end,
    coalesce(string_agg(n.nspname || '.' || p.proname, '  |  '), 'كل الدوال تستخدم دوال PostgreSQL المدمجة'),
    case when count(*) = 0 then '—'
         else 'أعد تنفيذ 09-calls.sql (النسخة الحالية تستخدم sha256 بدل gen_random_bytes)' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'wt_social_private')
    and p.proname like 'wt%'
    and p.prosrc ~ '(gen_random_bytes|gen_salt|uuid_generate|digest\()'

  union all
  /* ---- 7) نسخ مكرّرة بتوقيع قديم (سبب PGRST202/PGRST203 الشائع) ---- */
  select 60, 'نسخ مكرّرة من دوال المكالمات',
    case when count(*) = 0 then '✅ لا تكرار'
         else '⚠️ ' || count(*) || ' نسخة زائدة' end,
    coalesce(string_agg(p.oid::regprocedure::text, '  |  '), 'توقيع واحد لكل دالة'),
    coalesce(string_agg('drop function ' || p.oid::regprocedure::text || ';', ' '),
             '—')
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select fn from expected)
    and p.oid not in (select to_regprocedure(sig) from expected where to_regprocedure(sig) is not null)

  union all
  /* ---- 8) مكالمات معلّقة تمنع بدء مكالمة جديدة ---- */
  select 70, 'مكالمات ما زالت مفتوحة',
    case when coalesce(live, 0) = 0 then '✅ لا شيء معلّق'
         else '⚠️ ' || live || ' مكالمة' end,
    'السجلات العالقة تُغلق تلقائياً بعد 45 ثانية بلا نبضة',
    case when coalesce(live, 0) = 0 then '—'
         else 'افتح المحادثة واختر «أنهِ المكالمة السابقة»' end
  from (
    select case when to_regclass('public.wt_dm_calls') is null then 0
                else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.wt_dm_calls where state in (''ringing'',''active'')', false, true, '')))[1]::text::int
           end as live
  ) live_calls

  union all
  /* ---- 9) كاش PostgREST ---- */
  select 80, 'كاش PostgREST (تعريف الدوال)',
    'ℹ️ لا يمكن فحصه من هنا',
    'إن كانت كل الصفوف أعلاه ✅ والخطأ باقٍ: الكاش لم يتحدّث',
    'نفّذ: notify pgrst, ''reload schema'';'
)

select
  ord as "#",
  check_name as "الفحص",
  status     as "النتيجة",
  detail     as "التفصيل",
  fix        as "ما تفعله"
from report
union all
select 999, 'الخلاصة',
  case when exists (select 1 from report where ord = 60 and status like '⚠️%') then '❌ نسخ مكرّرة — احذفها'
       when exists (select 1 from report where status like '❌%') then '❌ ناقص: نفّذ 09-calls.sql'
       when exists (select 1 from report where status like '⚠️%' and ord <> 70) then '⚠️ يعمل مع ملاحظات'
       else '✅ قاعدة البيانات جاهزة للمكالمات' end,
  'عدد الصفوف السليمة: ' || (select count(*) from report where status like '✅%') || ' من ' || (select count(*) from report),
  case when exists (select 1 from report where ord = 60 and status like '⚠️%')
            then 'انسخ أوامر drop من عمود «ما تفعله» في الصف 60 ونفّذها'
       when exists (select 1 from report where status like '❌%')
            then 'نفّذ 09-calls.sql كاملاً على نفس المشروع'
       else 'إن بقيت المشكلة فراجع مشروع Supabase في config.js' end
order by 1;

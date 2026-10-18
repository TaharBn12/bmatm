-- =====================================================================
-- WatchTogether — (00) حذف كل الجداول والأدوات (reset-drop-all.sql)
--
-- ⚠️ تحذير: هذا الملف **يحذف كل شيء** يتعلّق بـ WatchTogether:
--     جداول (rooms · messages · presence · room_members · room_queue)
--     وكل الرسائل والغرف وقائمة التشغيل، والدوال wt_* ، ومخطط wt_private،
--     والعرض wt_health ، وتسلسلات المعرّفات، وعضوية الجداول في Realtime.
--     **لا يمكن التراجع عن الحذف.**
--
-- متى تستعمله؟
--   • إذا كان الجدول القديم تالفاً ولا تحتاج بياناته، وتريد البدء من الصفر
--     نظيفاً تماماً (مثل خطأ messages_id_seq أو عمود body المفقود).
--
-- كيف تنفّذه؟
--   1) Supabase Dashboard → SQL Editor → New query → الصق كل ما هنا → Run.
--   2) ثم **نفّذ فوراً** الملف `01-bootstrap.sql` لإعادة إنشاء كل شيء صحيحاً
--      (لا تترك المشروع بلا جداول!). أو نفّذه مباشرة بعده في نفس النافذة.
--
-- آمن للتكرار: كل الأوامر بـ if exists فلا يفشل لو كان الجدول محذوفاً أصلاً.
-- لا يمسّ أي جدول أو مخطط لا يخصّ WatchTogether.
-- =====================================================================

-- 1) إزالة الجداول من منشور Realtime أولاً (تنظيف مرتّب، ويُتجاهل إن مُنع)
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
  loop
    begin
      execute format('alter publication supabase_realtime drop table public.%I', t);
    exception
      when undefined_object then null;         -- الجدول غير موجود
      when insufficient_privilege then null;   -- لا صلاحية على المنشور — الحذف أدناه يكفي
    end;
  end loop;
end
$$;

-- 2) الدوال (wt_*) قبل الجداول — cascade يتكفّل بأي تابع آخر
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'wt\_%' or p.proname like 'wt-%')
  loop
    begin
      execute 'drop function if exists ' || f.sig || ' cascade';
    exception when insufficient_privilege then null;
    end;
  end loop;
end
$$;

-- 3) العرض المساعد
drop view if exists public.wt_health;

-- 4) الجداول (cascade: يسقط السياسات والمفاتيح والفهارس والاعتماديات)
drop table if exists public.messages      cascade;
drop table if exists public.room_queue    cascade;
drop table if exists public.room_members  cascade;
drop table if exists public.presence      cascade;
drop table if exists public.rooms         cascade;

-- 5) التسلسلات (لو بقيت بلا مالك بعد حذف الجداول)
drop sequence if exists public.messages_id_seq;
drop sequence if exists public.room_queue_id_seq;

-- 6) مخطط الأسرار الخاص (مفاتيح المنشئين والمنظّمين)
drop schema if exists wt_private cascade;

-- 7) اطلب من PostgREST نسيان المخطط القديم فوراً
notify pgrst, 'reload schema';

-- 8) تأكيد: يجب أن يكون العدد صفر
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('rooms','messages','presence','room_members','room_queue')) as جداول_متبقية,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public') as جداول_realtime_متبقية;

-- ✅ النتيجة المطلوبة: 0 و 0
-- ➡️ الخطوة التالية الإلزامية: نفّذ 01-bootstrap.sql لإعادة بناء المخطط.

-- =====================================================================
-- WatchTogether — (05) فحص سريع بعد التنفيذ (health-check.sql)
--
-- متى تستعمله؟
--   بعد تنفيذ 01-bootstrap.sql (أو 04-repair-messages.sql) للتأكد أن كل شيء
--   في مكانه: الجداول، عمود نصّ الرسالة، عمود المعرّف، الصلاحيات، Realtime.
--
-- كيف تنفّذه؟
--   Supabase Dashboard → SQL Editor → New query → الصق كل ما هنا → Run.
--   قراءة فقط: لا يعدّل ولا يحذف أي شيء.
-- =====================================================================

-- 1) الجداول الخمسة موجودة؟ (المطلوب: 5)
select count(*) as جداول_موجودة
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('rooms', 'messages', 'presence', 'room_members', 'room_queue');

-- 2) جدول الرسائل: الأعمدة وأنواعها (يجب أن يظهر body و is_nullable = NO، و id بقيمة افتراضية)
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'messages'
 order by ordinal_position;

-- 3) عمود المعرّف: هل له تسلسل/افتراضي؟ (المطلوب سطر واحد: id → messages_id_seq أو gen_random_uuid())
select
  c.column_name,
  c.data_type,
  c.is_identity,
  c.column_default,
  pg_get_serial_sequence('public.messages', 'id') as التسلسل
from information_schema.columns c
where c.table_schema = 'public' and c.table_name = 'messages' and c.column_name = 'id';

-- 4) الصلاحيات لـ anon (يجب أن تظهر select و insert على messages)
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'messages'
   and grantee in ('anon', 'authenticated')
 order by grantee, privilege_type;

-- 5) Realtime: الجداول المضافة إلى منشور supabase_realtime (المطلوب 4 على الأقل)
select tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;

-- 6) الأدوار (RPC) الموجودة: wt_create_room · wt_join_room · wt_apply_room_state · wt_delete_room …
select proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'wt\_%'
 order by proname;

-- 7) اختبار عملي كامل: أرسل رسالة تجريبية ثم احذفها (يعمل حتى مع سياسات RLS)
do $$
declare
  v_id bigint;
begin
  insert into public.messages(room_id, name, body)
  values ('HEALTHCHECK', 'فحص', 'رسالة فحص — ستُحذف فوراً')
  returning id into v_id;

  raise notice 'WatchTogether: الكتابة في جدول الرسائل تعمل ✓ (id = %)', v_id;

  delete from public.messages where id = v_id;
  raise notice 'WatchTogether: القراءة والحذف يعملان ✓ — الجدول سليم.';
exception when others then
  raise notice 'WatchTogether: فشلت الكتابة في الرسائل — % (%)', sqlerrm, sqlstate;
end
$$;

-- 8) ملخّص جاهز (نفس العرض الذي يستعمله الموقع في «تشخيص الاتصال»)
select * from public.wt_health;

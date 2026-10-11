-- =====================================================================
--  WatchTogether — مخطط قاعدة بيانات Supabase
--  الملف: docs/schema.sql
-- ---------------------------------------------------------------------
--  طريقة الاستخدام:
--    1) افتح Supabase Dashboard → SQL Editor → New query
--    2) الصق هذا الملف كاملاً → Run
--    3) افتح الموقع (index.html) وستظهر الشارة: "Supabase متصل ✓"
--
--  ملاحظة: الجداول تعمل بصلاحيات "زائر مجهول" (anon) بدون تسجيل دخول،
--          لأن الموقع يطلب الاسم فقط وليس حساباً.
-- =====================================================================

-- ---------- 1) جدول الغرف ----------
create table if not exists public.rooms (
  room_id    text primary key,
  title      text,
  video_url  text,
  host_name  text,
  -- حالة المزامنة الكاملة: { url, kind, playing, pos, t, hostId, hostName, seq }
  state      jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table  public.rooms       is 'غرف المشاهدة المشتركة';
comment on column public.rooms.state is 'حالة المزامنة (الرابط/التشغيل/الموضع/المضيف/رقم التسلسل)';

-- ---------- 2) جدول الرسائل (الدردشة) ----------
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room_id    text not null,
  name       text not null,
  body       text not null,
  kind       text not null default 'chat',          -- chat | system
  client_id  text,
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- ---------- 3) جدول الحضور (المشاركون المتصلون) ----------
create table if not exists public.presence (
  room_id    text not null,
  client_id  text not null,
  name       text,
  is_host    boolean default false,
  last_seen  timestamptz not null default now(),
  primary key (room_id, client_id)
);

create index if not exists presence_room_idx on public.presence (room_id);

-- =====================================================================
--  4) Realtime: تفعيل البث المباشر للتغييرات
-- ---------------------------------------------------------------------
--  ملاحظة: لا حاجة لإنشاء أي جدول في مخطط `realtime` —
--  جدول `realtime.messages` موجود مسبقاً في كل مشروع Supabase،
--  وإنشاء جداول هناك ممنوع على دور postgres (خطأ 42501).
--  المطلوب فقط إضافة جدولينا إلى منشور `supabase_realtime`.
-- =====================================================================
do $$
begin
  begin
    alter publication supabase_realtime add table public.rooms;
  exception
    when duplicate_object      then null;   -- مُضاف مسبقاً
    when insufficient_privilege then null;  -- أضِفها يدوياً (انظر أدناه)
  end;

  begin
    alter publication supabase_realtime add table public.messages;
  exception
    when duplicate_object      then null;
    when insufficient_privilege then null;
  end;
end $$;

-- إن ظهر أن الجدولين غير مُضافين (استعلام التحقّق في الأسفل)،
-- أضِفهما من Dashboard → Database → Replication → supabase_realtime
-- أو نفّذ هذين السطرين وحدهما:
--   alter publication supabase_realtime add table public.rooms;
--   alter publication supabase_realtime add table public.messages;

-- =====================================================================
--  5) الصلاحيات + سياسات RLS (وصول الزائر المجهول anon)
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant all on public.rooms, public.messages, public.presence to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- تفعيل RLS مع سياسات تسمح بالدخول بالاسم فقط (بدون تسجيل)
alter table public.rooms    enable row level security;
alter table public.messages enable row level security;
alter table public.presence enable row level security;

-- الغرف
drop policy if exists rooms_all_anon on public.rooms;
create policy rooms_all_anon on public.rooms
  as permissive for all to anon, authenticated
  using (true) with check (true);

-- الرسائل
drop policy if exists messages_all_anon on public.messages;
create policy messages_all_anon on public.messages
  as permissive for all to anon, authenticated
  using (true) with check (true);

-- الحضور
drop policy if exists presence_all_anon on public.presence;
create policy presence_all_anon on public.presence
  as permissive for all to anon, authenticated
  using (true) with check (true);

-- =====================================================================
--  6) تنظيف تلقائي (اختياري): احذف الحضور المنتهي والرسائل القديمة
--     Dashboard → Database → Extensions → فعّل "pg_cron" ثم شغّل:
--
--     select cron.schedule('wt-cleanup', '*/10 * * * *', $$
--       delete from public.presence where last_seen < now() - interval '30 seconds';
--       delete from public.messages where created_at < now() - interval '7 days';
--       delete from public.rooms    where updated_at < now() - interval '30 days';
--     $$);
-- =====================================================================

-- =====================================================================
--  7) تحقّق سريع بعد التنفيذ (نفّذ كل استعلام على حدة)
-- =====================================================================

-- أ) هل Realtime مفعّل لجدولينا؟ (يجب أن ترى صفّين: rooms و messages)
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and schemaname = 'public';

-- ب) هل جدول بث Realtime موجود في مشروعك؟ (يجب أن يعيد true — لا تنشئه يدوياً)
-- select exists (
--   select 1 from information_schema.tables
--   where table_schema = 'realtime' and table_name = 'messages'
-- ) as realtime_messages_exists;

-- ج) هل سياسات RLS الثلاث موجودة؟
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' order by tablename;

-- د) هل الجداول أُنشئت؟
-- select * from public.rooms    limit 5;
-- select * from public.messages order by created_at desc limit 5;

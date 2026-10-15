-- =====================================================================
--  WatchTogether — مخطط «سيرفر جديد» على Supabase (Bootstrap)
--  الملف: docs/bootstrap.sql
-- ---------------------------------------------------------------------
--  هذا الملف يُنفَّذ ONCE على أي مشروع Supabase (جديد أو قديم):
--    • ينشئ الجداول الثلاثة (rooms / messages / presence)
--    • يمنح صلاحيات الزائر المجهول (anon) + يفعّل RLS بسياسات مفتوحة
--    • يربط الجداول بمنشور supabase_realtime (بدونه لا يصل البث المباشر)
--    • يضيف فهارس الاستطلاع + منظّفا تلقائياً
--    • ينشئ view باسم wt_health للتحقق السريع
--
--  طريقة الاستخدام:
--    Supabase Dashboard → SQL Editor → New query → الصق الملف → Run
--  أو بأمر واحد (ينشئ المشروع.new + ينفّذ الملف + يربطه بالموقع):
--    node tools/sbctl.mjs create --name wt-new --org-id <id> --db-password <pw>
--
--  آمن للتكرار: ينفَّذ عدة مرات بدون أخطاء وبدون فقدان بيانات.
-- =====================================================================

-- =====================================================================
--  1) جدول الغرف (يحمل حالة المزامنة كاملة في عمود state jsonb)
-- =====================================================================
create table if not exists public.rooms (
  room_id    text primary key,
  title      text,
  video_url  text,
  host_name  text,
  -- حالة المزامنة الكاملة:
  -- { url, kind, playing, pos, t, rev, updatedBy, updatedByName }
  -- t   = ختم زمني (مللي ثانية) لآخر تحديث → أساس حساب الالتحاق للمتأخرين
  -- rev = رقم تسلسلي يمنع تطبيق تحديث قديم (ارتداد الفيديو للخلف)
  state      jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table  public.rooms       is 'غرف المشاهدة المشتركة (WatchTogether)';
comment on column public.rooms.state is 'حالة المزامنة: الرابط/التشغيل/الموضع/المضيف/الرقم التسلسلي';

-- =====================================================================
--  2) جدول الرسائل (الدردشة + التفاعلات)
-- =====================================================================
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room_id    text not null,
  name       text not null,
  body       text not null,
  kind       text not null default 'chat',       -- chat | system | react
  client_id  text,
  user_id    uuid,                               -- الحساب (اختياري)
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- =====================================================================
--  3) جدول الحضور (المشاركون المتصلون الآن)
-- =====================================================================
create table if not exists public.presence (
  room_id    text not null,
  client_id  text not null,
  name       text,
  is_host    boolean default false,
  last_seen  timestamptz not null default now(),
  primary key (room_id, client_id)
);

create index if not exists presence_room_idx on public.presence (room_id);
create index if not exists rooms_updated_idx on public.rooms (updated_at desc);

-- =====================================================================
--  4) الصلاحيات
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant all on public.rooms, public.messages, public.presence to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
alter default privileges in schema public
  grant all on tables to anon, authenticated;

-- =====================================================================
--  5) RLS — سياسات مفتوحة للزائر المجهول (الموقع يطلب الاسم فقط)
-- =====================================================================
alter table public.rooms    enable row level security;
alter table public.messages enable row level security;
alter table public.presence enable row level security;

drop policy if exists rooms_all_anon on public.rooms;
create policy rooms_all_anon on public.rooms
  as permissive for all to anon, authenticated
  using (true) with check (true);

drop policy if exists messages_all_anon on public.messages;
create policy messages_all_anon on public.messages
  as permissive for all to anon, authenticated
  using (true) with check (true);

drop policy if exists presence_all_anon on public.presence;
create policy presence_all_anon on public.presence
  as permissive for all to anon, authenticated
  using (true) with check (true);

-- =====================================================================
--  6) Realtime — بدون هذا لا يصل البث المباشر
-- ---------------------------------------------------------------------
--  مهم: REPLICA IDENTITY FULL ضروري لأن الفلتر (room_id=eq.…) يُقيَّم
--  على أحداث UPDATE — بدونه تُسقَط التحديثات ولا يتزامن أحد.
-- =====================================================================
alter table public.rooms    replica identity full;
alter table public.messages replica identity full;
alter table public.presence replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.rooms;
  exception
    when duplicate_object      then null;   -- مُضاف مسبقاً
    when insufficient_privilege then null;  -- أضِفه يدوياً (Dashboard → Replication)
  end;

  begin
    alter publication supabase_realtime add table public.messages;
  exception
    when duplicate_object      then null;
    when insufficient_privilege then null;
  end;

  begin
    alter publication supabase_realtime add table public.presence;
  exception
    when duplicate_object      then null;
    when insufficient_privilege then null;
  end;
end $$;

-- =====================================================================
--  7) جدول فحص سريع (wt_health) — استعلام واحد يخبرك بكل شيء
-- =====================================================================
create or replace view public.wt_health as
select
  (select count(*) from public.rooms)                                        as rooms,
  (select count(*) from public.messages)                                     as messages,
  (select count(*) from public.presence)                                     as presence,
  (select count(*) from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public')         as realtime_tables,
  (select count(*) from pg_policies where schemaname = 'public')             as policies;

grant select on public.wt_health to anon, authenticated;

-- =====================================================================
--  8) تنظيف تلقائي (اختياري) — فعّل pg_cron من Dashboard ثم نفّذ:
-- =====================================================================
--  select cron.schedule('wt-cleanup', '*/10 * * * *', $$
--    delete from public.presence where last_seen < now() - interval '30 seconds';
--    delete from public.messages where created_at < now() - interval '7 days';
--    delete from public.rooms    where updated_at < now() - interval '30 days';
--  $$);

-- =====================================================================
--  9) تحقّق بعد التنفيذ — النتيجة المطلوبة:
--     realtime_tables = 3   policies = 3   (أو أكثر)
-- =====================================================================
select * from public.wt_health;

-- ج) تأكد أن الجداول في منشور البث:
-- select tablename from pg_publication_tables
--  where pubname = 'supabase_realtime' and schemaname = 'public';

-- د) تأكد أن السياسات موجودة:
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public' order by tablename;

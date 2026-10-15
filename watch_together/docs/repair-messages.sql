-- =====================================================================
-- WatchTogether — إصلاح جدول الرسائل (repair-messages.sql)
--
-- متى تستعمله؟
--   حين تظهر في الأداة أو في Console هذا الخطأ عند إرسال رسالة دردشة:
--     supabase: Could not find the 'body' column of 'messages' in the schema cache
--   رمز الخطأ: PGRST204
--
-- السبب:
--   جدول messages في مشروعك أُنشئ بنسخة قديمة من المخطط (العمود اسمه text
--   أو message أو content بدل body، أو ينقصه أحد الأعمدة الجديدة).
--   `create table if not exists` في bootstrap.sql يتجاهل الجدول القائم،
--   فلا يصل الإصلاح إليه — لذلك هذا الملف مستقل ويتعامل مع الجدول كما هو.
--
-- كيف تنفّذه؟
--   Supabase Dashboard → SQL Editor → New query → الصق كل ما هنا → Run
--   ثم افتح الغرفة من جديد (أو اضغط «إعادة الاتصال» في نافذة التشخيص).
--
-- آمن تماماً للتكرار: لا يحذف أي رسالة ولا أي غرفة.
-- =====================================================================

-- 0) إن لم يكن الجدول موجوداً أصلاً، أنشئه بالشكل الصحيح (وإلا فنحن نُصلح القائم)
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  room_id    text not null,
  name       text not null,
  body       text not null,
  kind       text not null default 'chat',
  client_id  text,
  user_id    uuid,
  created_at timestamptz not null default now()
);

-- 0ب) أعمدة أساسية قد تكون ناقصة في الجداول القديمة
alter table public.messages add column if not exists room_id text;
alter table public.messages add column if not exists name text;
alter table public.messages add column if not exists created_at timestamptz not null default now();
alter table public.messages add column if not exists user_id uuid;
alter table public.messages add column if not exists client_id text;
alter table public.messages add column if not exists kind text not null default 'chat';

-- 1) عمود النص: أعِد تسمية العمود القديم (text/message/content/msg) إلى body،
--    أو أضِفه إن لم يكن للجدول عمود نصّ إطلاقاً.
do $$
declare
  legacy text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'messages' and column_name = 'body'
  ) then
    select column_name into legacy
      from information_schema.columns
     where table_schema = 'public' and table_name = 'messages'
       and column_name in ('text', 'message', 'content', 'msg')
     order by array_position(array['text', 'message', 'content', 'msg'], column_name)
     limit 1;

    if legacy is not null then
      execute format('alter table public.messages rename column %I to body', legacy);
      raise notice 'WatchTogether: أُعيد تسمية العمود % إلى body في جدول messages.', legacy;
    else
      execute 'alter table public.messages add column body text';
      raise notice 'WatchTogether: أُضيف العمود body إلى جدول messages.';
    end if;
  end if;
end $$;

-- 2) ثبّت شكل العمود كما في المخطط (بلا فقدان أي نصّ قائم)
update public.messages set body = '' where body is null;
alter table public.messages alter column body set default '';
alter table public.messages alter column body set not null;
update public.messages set name = 'زائر' where name is null;
update public.messages set room_id = 'legacy' where room_id is null;

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);

-- 3) الصلاحيات والسياسة (كالمخطط الأساسي)
grant select, insert on public.messages to anon, authenticated;
do $$   -- التسلسل قد لا يكون موجوداً في جدول مبنيّ يدوياً — لا نُفشل السكربت لأجله
begin
  if to_regclass('public.messages_id_seq') is not null then
    execute 'grant usage, select on sequence public.messages_id_seq to anon, authenticated';
  end if;
end $$;
alter table public.messages enable row level security;
drop policy if exists messages_read_write on public.messages;
create policy messages_read_write on public.messages
  for all to anon, authenticated using (true) with check (true);

-- 4) Realtime (يُتجاهل إن كان مضافاً مسبقاً)
alter table public.messages replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
end $$;

-- 5) الأهم: اطلب من PostgREST إعادة قراءة المخطط فوراً (يزيل رسالة schema cache)
notify pgrst, 'reload schema';

-- 6) تحقق سريع — يجب أن يعرض body ضمن الأعمدة وأن يكون not_null = YES
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'messages'
 order by ordinal_position;

-- ملاحظة: إن كان الجدول تالفاً تماماً ولا تحتاج رسائله القديمة:
--   drop table if exists public.messages;
--   ثم أعد تنفيذ docs/bootstrap.sql كاملاً — سيُنشأ الجدول بالشكل الصحيح.

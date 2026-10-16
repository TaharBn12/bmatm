-- =====================================================================
-- WatchTogether — (03) ترقية قاعدة Supabase قائمة — نسخة «migration»
-- مطابق تماماً للملف 01 (فرق الترويسة فقط) — نفّذ واحداً منهما فقط.
--
-- نفّذ هذا الملف كاملاً في Supabase Dashboard → SQL Editor لترقية قاعدة قائمة أو حديثة.
-- آمن للتكرار: لا يحذف بيانات الغرف أو الرسائل، وينقل الأسرار التجريبية إلى مخطط خاص عند وجودها.
-- يهيّئ مزامنة خادمية موثوقة، مفاتيح مالك خاصة، منظّمين، ورسائل وقائمة مشتركة.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) الحالة الأساسية للغرف. لا يُسمح للعميل بالكتابة المباشرة إلى rooms؛
--    جميع تغييرات الحالة تمر عبر wt_apply_room_state للتحقق من الدور.
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  room_id    text primary key,
  title      text,
  video_url  text,
  host_name  text,
  state      jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rooms_updated_idx on public.rooms (updated_at desc);
comment on table public.rooms is 'حالة غرف WatchTogether؛ كل كتابة تمر عبر دوال RPC الموثقة.';

-- الأسرار في مخطط غير معروض عبر PostgREST أو Realtime؛ لا توضع داخل جداول عامة.
create schema if not exists wt_private;
revoke all on schema wt_private from public, anon, authenticated;
create table if not exists wt_private.room_secrets (
  room_id text primary key references public.rooms(room_id) on delete cascade,
  owner_token text not null
);
-- ترحيل آمن من أي نسخة تجريبية خزّنت السرّ مباشرةً في rooms.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='rooms' and column_name='owner_token') then
    execute 'insert into wt_private.room_secrets(room_id, owner_token) select room_id, owner_token from public.rooms where owner_token is not null on conflict (room_id) do nothing';
    execute 'alter table public.rooms drop column owner_token';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) سجل الرسائل. الرسائل لا تتحكم في حالة الفيديو.
-- ---------------------------------------------------------------------
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

alter table public.messages add column if not exists user_id uuid;
alter table public.messages add column if not exists client_id text;
alter table public.messages add column if not exists kind text not null default 'chat';
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2ب) إصلاح جدول الرسائل في المشاريع القديمة — يعالج خطأي PostgREST:
--     «Could not find the 'body' column of 'messages' in the schema cache» (PGRST204)
--     «null value in column "id" of relation "messages" violates not-null constraint»
--
--     السبب: مشروع قديم أنشأ messages بعمود text/message بدل body، أو بلا
--     أعمدة المخطط الجديد. `create table if not exists` يتجاهل الجدول القائم،
--     فلا يُضاف العمود أبداً وترفض الدردشة الكتابة.
--     وإن كان الجدول القديم بلا identity وبلا default لعمود id، يفشل الإدراج
--     بالخطأ الثاني — لأن العميل لا يرسل id أصلاً.
--     هذا القسم آمن للتكرار ولا يحذف أي رسالة.
-- ---------------------------------------------------------------------
alter table public.messages add column if not exists room_id text;
alter table public.messages add column if not exists name text;
alter table public.messages add column if not exists created_at timestamptz not null default now();
alter table public.messages add column if not exists user_id uuid;
alter table public.messages add column if not exists client_id text;
alter table public.messages add column if not exists kind text not null default 'chat';
alter table public.messages add column if not exists id bigint;

do $$
declare
  legacy text;
begin
  /* 1) عمود النص: أعِد تسمية العمود القديم (text/message/content/msg) إلى body إن وُجد */
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
end
$$;

/* 2) ثبّت شكل عمود النص كما في المخطط (بلا فقدان أي نصّ قائم) */
update public.messages set body = '' where body is null;
alter table public.messages alter column body set default '';
alter table public.messages alter column body set not null;
update public.messages set name = 'زائر' where name is null;
update public.messages set room_id = 'legacy' where room_id is null;

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);

/* 2ج) عمود المعرّف: جدول قديم بعمود id عادي (بلا identity وبلا default) يجعل
       إدراج الرسائل يفشل: «null value in column "id" … violates not-null
       constraint» لأن العميل لا يرسل id. نُصلح العمود حسب نوعه. */
do $$
declare
  ident  text;
  idtype text;
  adef   text;
begin
  select a.attidentity::text, format_type(a.atttypid, null), pg_get_expr(d.adbin, d.adrelid)
    into ident, idtype, adef
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.messages'::regclass
     and a.attname = 'id'
     and not a.attisdropped;

  if ident is null then
    return;                                   /* لا عمود id إطلاقاً */
  end if;

  if ident in ('a', 'd') or adef is not null then
    /* العمود سليم (identity أو له default) — نكفي بضبط عدّاد التسلسل الرقمي */
    if idtype in ('bigint', 'integer', 'smallint')
       and pg_get_serial_sequence('public.messages', 'id') is not null then
      execute 'select setval(pg_get_serial_sequence(''public.messages'', ''id''), coalesce((select max(id) from public.messages), 0) + 1, false)';
    end if;
    return;
  end if;

  if idtype in ('bigint', 'integer', 'smallint') then
    execute 'create sequence if not exists public.messages_id_seq';
    execute 'alter sequence public.messages_id_seq owned by public.messages.id';
    execute 'alter table public.messages alter column id set default nextval(''public.messages_id_seq''::regclass)';
    execute 'select setval(''public.messages_id_seq'', coalesce((select max(id) from public.messages), 0) + 1, false)';
    raise notice 'WatchTogether: أُنشئ تسلسل messages_id_seq ورُبط بعمود id في جدول messages.';
  elsif idtype = 'uuid' then
    execute 'alter table public.messages alter column id set default gen_random_uuid()';
    raise notice 'WatchTogether: عُيّن الافتراضي gen_random_uuid() لعمود id (uuid) في جدول messages.';
  elsif idtype in ('text', 'character varying', 'character') then
    execute 'alter table public.messages alter column id set default gen_random_uuid()::text';
    raise notice 'WatchTogether: عُيّن الافتراضي gen_random_uuid()::text لعمود id في جدول messages.';
  else
    raise notice 'WatchTogether: عمود id في messages نوعه % — لم نتمكّن من إصلاحه تلقائياً. للمطابقة الكاملة: drop table public.messages; ثم أعِد تنفيذ bootstrap.sql كاملاً.', idtype;
  end if;
end
$$;

/* 3) اطلب من PostgREST إعادة قراءة المخطط فوراً — يزيل رسالة schema cache */
notify pgrst, 'reload schema';

-- إن كان الجدول تالفاً تماماً ولا تحتاج رسائله القديمة، استبدل القسم أعلاه بـ:
-- drop table if exists public.messages;
-- ثم أعد تنفيذ هذا الملف من أوله (سيُنشأ الجدول بالشكل الصحيح).

-- ---------------------------------------------------------------------
-- 3) الحضور (للتوافق مع الإصدارات السابقة) وسجل الأدوار الآمن.
--    member_token سرّ لكل تبويب/عضو، ولا يقرأه العميل من PostgREST.
-- ---------------------------------------------------------------------
create table if not exists public.presence (
  room_id    text not null,
  client_id  text not null,
  name       text,
  is_host    boolean not null default false,
  last_seen  timestamptz not null default now(),
  primary key (room_id, client_id)
);
create index if not exists presence_room_idx on public.presence (room_id);

create table if not exists public.room_members (
  room_id      text not null references public.rooms(room_id) on delete cascade,
  client_id    text not null,
  display_name text not null default 'زائر',
  role         text not null default 'viewer' check (role in ('owner', 'organizer', 'viewer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (room_id, client_id)
);
create index if not exists room_members_room_updated_idx on public.room_members (room_id, updated_at);
create table if not exists wt_private.member_secrets (
  room_id text not null,
  client_id text not null,
  member_token text not null,
  primary key (room_id, client_id),
  foreign key (room_id, client_id) references public.room_members(room_id, client_id) on delete cascade
);
-- ترحيل آمن من أي نسخة تجريبية خزّنت السرّ في room_members العام.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='room_members' and column_name='member_token') then
    execute 'insert into wt_private.member_secrets(room_id, client_id, member_token) select room_id, client_id, member_token from public.room_members where member_token is not null on conflict (room_id, client_id) do nothing';
    execute 'alter table public.room_members drop column member_token';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4) قائمة تشغيل مشتركة؛ يضيف أي عضو، ويحذف العضو عنصره أو يتحكم المنظّم.
-- ---------------------------------------------------------------------
create table if not exists public.room_queue (
  id              bigint generated always as identity primary key,
  room_id         text not null references public.rooms(room_id) on delete cascade,
  url             text not null,
  title           text not null default 'فيديو',
  added_by_client text not null,
  added_by        text not null default 'مشارك',
  created_at      timestamptz not null default now()
);
create index if not exists room_queue_room_id_idx on public.room_queue (room_id, id);

-- ---------------------------------------------------------------------
-- 5) أمان PostgREST: قراءات عامة محدودة، والكتابة الحساسة عبر RPC فقط.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

revoke all on public.rooms, public.messages, public.presence, public.room_members, public.room_queue from public, anon, authenticated;
grant select (room_id, title, video_url, host_name, state, created_at, updated_at)
  on public.rooms to anon, authenticated;
grant select, insert on public.messages to anon, authenticated;
do $$   /* تسلسل المعرّف: قد لا يوجد في جدول قديم/جدول معرّفه uuid — لا نُفشل السكربت بسببه */
begin
  if to_regclass('public.messages_id_seq') is not null then
    execute 'grant usage, select on sequence public.messages_id_seq to anon, authenticated';
  end if;
end
$$;
grant select, insert, update, delete on public.presence to anon, authenticated;
grant select (room_id, client_id, display_name, role, created_at, updated_at)
  on public.room_members to anon, authenticated;
grant select (id, room_id, url, title, added_by_client, added_by, created_at)
  on public.room_queue to anon, authenticated;

alter table public.rooms enable row level security;
alter table public.messages enable row level security;
alter table public.presence enable row level security;
alter table public.room_members enable row level security;
alter table public.room_queue enable row level security;

-- احذف السياسات القديمة أيضاً، حتى لا تبقى سياسة permissive تسمح بتجاوز RPC.
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname
    from pg_policies where schemaname = 'public'
      and tablename in ('rooms', 'messages', 'presence', 'room_members', 'room_queue')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

create policy rooms_read on public.rooms
  for select to anon, authenticated using (true);
create policy messages_read_write on public.messages
  for all to anon, authenticated using (true) with check (true);
create policy presence_read_write on public.presence
  for all to anon, authenticated using (true) with check (true);
create policy room_members_read on public.room_members
  for select to anon, authenticated using (true);
create policy room_queue_read on public.room_queue
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------
-- 6) RPC: إنشاء/استعادة غرفة. owner_token يُحفظ ولا يُعاد في أي استجابة.
-- ---------------------------------------------------------------------
create or replace function public.wt_create_room(
  p_room_id text,
  p_title text,
  p_video_url text,
  p_owner_token text,
  p_owner_name text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_token text;
  v_has_secret boolean;
begin
  if p_room_id is null or p_room_id !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'رمز غرفة غير صالح' using errcode = '22023';
  end if;
  if p_owner_token is null or length(p_owner_token) < 48 or length(p_owner_token) > 256 then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;

  insert into public.rooms(room_id, title, video_url, host_name)
  values (p_room_id, nullif(left(coalesce(p_title, ''), 120), ''), nullif(left(coalesce(p_video_url, ''), 2048), ''),
          left(coalesce(p_owner_name, 'مضيف'), 30))
  on conflict (room_id) do nothing;

  perform 1 from public.rooms where room_id = p_room_id for update;
  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id for update;
  v_has_secret := found;
  if v_has_secret and v_owner_token <> p_owner_token then
    raise exception 'الغرفة يملكها منشئ آخر' using errcode = '42501';
  elsif not v_has_secret then
    insert into wt_private.room_secrets(room_id, owner_token) values (p_room_id, p_owner_token);
  end if;

  update public.rooms
  set title = coalesce(nullif(title, ''), nullif(left(coalesce(p_title, ''), 120), '')),
      video_url = coalesce(nullif(video_url, ''), nullif(left(coalesce(p_video_url, ''), 2048), '')),
      host_name = left(coalesce(nullif(p_owner_name, ''), host_name, 'مضيف'), 30),
      updated_at = clock_timestamp()
  where room_id = p_room_id;

  return jsonb_build_object('ok', true, 'room_id', p_room_id);
end;
$$;

-- ---------------------------------------------------------------------
-- RPC إداري لإزالة غرفة يملكها صاحب المفتاح، ويُستخدم لتنظيف فحص sbctl.
-- ---------------------------------------------------------------------
create or replace function public.wt_delete_room(p_room_id text, p_owner_token text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_token text;
begin
  if p_owner_token is null or length(p_owner_token) < 48 or length(p_owner_token) > 256 then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  perform 1 from public.rooms where room_id = p_room_id for update;
  if not found then return jsonb_build_object('ok', true, 'deleted', false); end if;
  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id for update;
  if not found or v_owner_token is distinct from p_owner_token then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  delete from public.messages where room_id = p_room_id;
  delete from public.presence where room_id = p_room_id;
  delete from public.rooms where room_id = p_room_id;
  return jsonb_build_object('ok', true, 'deleted', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 7) RPC: تسجيل/استعادة عضو. الدور لا يُمنح اعتماداً على client_id وحده.
-- ---------------------------------------------------------------------
create or replace function public.wt_join_room(
  p_room_id text,
  p_client_id text,
  p_member_token text,
  p_display_name text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_owner_token text;
  v_member_token text;
  v_role text := 'viewer';
  v_now_ms bigint;
begin
  if p_room_id is null or p_client_id is null or length(p_client_id) > 128
     or p_member_token is null or length(p_member_token) < 48 or length(p_member_token) > 256 then
    raise exception 'بيانات العضو غير صالحة' using errcode = '22023';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id;
  if not found then
    return jsonb_build_object('found', false, 'role', 'viewer', 'members', '[]'::jsonb, 'serverTime',
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
  end if;

  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id;
  if v_owner_token = p_member_token then
    v_role := 'owner';
  else
    select member_token into v_member_token from wt_private.member_secrets
      where room_id = p_room_id and client_id = p_client_id;
    if found then
      if v_member_token <> p_member_token then
        raise exception 'رمز العضو غير صالح' using errcode = '42501';
      end if;
      select role into v_role from public.room_members
        where room_id = p_room_id and client_id = p_client_id;
    else
      select role into v_role from public.room_members
        where room_id = p_room_id and client_id = p_client_id;
      if found and v_role in ('owner', 'organizer') then
        raise exception 'رمز العضو غير صالح' using errcode = '42501';
      end if;
      v_role := 'viewer';
    end if;
  end if;

  insert into public.room_members(room_id, client_id, display_name, role)
  values (p_room_id, p_client_id, left(coalesce(nullif(p_display_name, ''), 'زائر'), 30), v_role)
  on conflict (room_id, client_id) do update
    set display_name = excluded.display_name,
        updated_at = clock_timestamp(),
        role = excluded.role;

  if v_role <> 'owner' then
    insert into wt_private.member_secrets(room_id, client_id, member_token)
    values (p_room_id, p_client_id, p_member_token)
    on conflict (room_id, client_id) do nothing;
    -- لا نسمح بتبديل سرّ عضو مسجّل لمجرد معرفة client_id.
    select m.role into v_role
      from public.room_members m
      join wt_private.member_secrets s using (room_id, client_id)
      where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token;
    if not found then v_role := 'viewer'; end if;
  else
    -- لا تدع سرّ عضو قديم على client_id نفسه يرث دور المنشئ.
    delete from wt_private.member_secrets where room_id = p_room_id and client_id = p_client_id;
    update public.room_members set role = 'owner', updated_at = clock_timestamp()
      where room_id = p_room_id and client_id = p_client_id;
  end if;

  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return jsonb_build_object(
    'found', true,
    'role', coalesce(v_role, 'viewer'),
    'serverTime', v_now_ms,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', client_id, 'display_name', display_name, 'role', role)
                       order by updated_at asc)
      from public.room_members where room_id = p_room_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 8) RPC: تحقق خادمي من الدور، ثم ترقيم الحالة وكتابتها كمرجع مركزي.
-- ---------------------------------------------------------------------
create or replace function public.wt_apply_room_state(
  p_room_id text,
  p_client_id text,
  p_member_token text,
  p_state jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_role text;
  v_name text;
  v_rev bigint;
  v_state jsonb;
  v_now_ms bigint;
begin
  if p_client_id is null or length(p_client_id) > 128
     or p_member_token is null or length(p_member_token) < 48 or length(p_member_token) > 256 then
    raise exception 'بيانات العضو غير صالحة' using errcode = '22023';
  end if;
  if p_state is null or jsonb_typeof(p_state) is distinct from 'object' or octet_length(p_state::text) > 8192 then
    raise exception 'حالة الغرفة غير صالحة' using errcode = '22023';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id for update;
  if not found then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;

  if exists (select 1 from wt_private.room_secrets where room_id = p_room_id and owner_token = p_member_token) then
    v_role := 'owner';
    select display_name into v_name from public.room_members
      where room_id = p_room_id and client_id = p_client_id;
  else
    select m.role, m.display_name into v_role, v_name
      from public.room_members m
      join wt_private.member_secrets s using (room_id, client_id)
      where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token;
  end if;
  if coalesce(v_role, 'viewer') not in ('owner', 'organizer') then
    raise exception 'لا تملك صلاحية التحكم في هذه الغرفة' using errcode = '42501';
  end if;

  v_rev := coalesce(nullif(v_room.state->>'rev', '')::bigint, 0) + 1;
  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_state := p_state || jsonb_build_object(
    'rev', v_rev,
    't', v_now_ms,
    'updatedBy', p_client_id,
    'updatedByName', coalesce(nullif(v_name, ''), p_state->>'updatedByName', v_room.host_name, 'مضيف')
  );

  update public.rooms
  set state = v_state,
      video_url = nullif(left(coalesce(v_state->>'url', video_url, ''), 2048), ''),
      host_name = coalesce(nullif(v_state->>'updatedByName', ''), host_name),
      updated_at = clock_timestamp()
  where room_id = p_room_id;
  return v_state;
end;
$$;

-- ---------------------------------------------------------------------
-- 9) RPCs للأدوار وقائمة التشغيل المشتركة.
-- ---------------------------------------------------------------------
create or replace function public.wt_set_room_member_role(
  p_room_id text,
  p_owner_token text,
  p_target_client_id text,
  p_role text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_owner_token text;
begin
  if p_role not in ('organizer', 'viewer') then
    raise exception 'الدور المطلوب غير صالح' using errcode = '22023';
  end if;
  perform 1 from public.rooms where room_id = p_room_id for update;
  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id;
  if not found or v_owner_token is null or v_owner_token <> p_owner_token then
    raise exception 'إدارة المنظّمين متاحة لمنشئ الغرفة فقط' using errcode = '42501';
  end if;
  update public.room_members set role = p_role, updated_at = clock_timestamp()
    where room_id = p_room_id and client_id = p_target_client_id and role <> 'owner';
  if not found then raise exception 'المشارك غير موجود' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'client_id', p_target_client_id, 'role', p_role);
end;
$$;

create or replace function public.wt_queue_add(
  p_room_id text,
  p_client_id text,
  p_member_token text,
  p_url text,
  p_title text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_owner_token text;
  v_role text;
  v_name text;
  v_item public.room_queue%rowtype;
begin
  select * into v_room from public.rooms where room_id = p_room_id;
  if not found then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;
  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id;
  if v_owner_token = p_member_token then
    v_role := 'owner';
    select display_name into v_name from public.room_members where room_id = p_room_id and client_id = p_client_id;
  else
    select m.role, m.display_name into v_role, v_name
      from public.room_members m
      join wt_private.member_secrets s using (room_id, client_id)
      where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token;
  end if;
  if v_role is null then raise exception 'انضم إلى الغرفة أولاً' using errcode = '42501'; end if;
  if p_url is null or length(p_url) > 2048 or p_url !~* '^https?://' then
    raise exception 'رابط الفيديو غير صالح' using errcode = '22023';
  end if;

  insert into public.room_queue(room_id, url, title, added_by_client, added_by)
  values (p_room_id, p_url, left(coalesce(nullif(p_title, ''), p_url), 120), p_client_id,
          left(coalesce(nullif(v_name, ''), 'مشارك'), 30)) returning * into v_item;
  return to_jsonb(v_item);
end;
$$;

create or replace function public.wt_queue_remove(
  p_room_id text,
  p_client_id text,
  p_member_token text,
  p_item_id bigint
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_token text;
  v_role text;
  v_added_by text;
begin
  perform 1 from public.rooms where room_id = p_room_id;
  if not found then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;
  select owner_token into v_owner_token from wt_private.room_secrets where room_id = p_room_id;
  if v_owner_token = p_member_token then
    v_role := 'owner';
  else
    select m.role into v_role
      from public.room_members m
      join wt_private.member_secrets s using (room_id, client_id)
      where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token;
  end if;
  select added_by_client into v_added_by from public.room_queue where room_id = p_room_id and id = p_item_id;
  if not found then raise exception 'العنصر غير موجود' using errcode = 'P0002'; end if;
  if v_role is null then raise exception 'انضم إلى الغرفة أولاً' using errcode = '42501'; end if;
  if v_role not in ('owner', 'organizer') and v_added_by <> p_client_id then
    raise exception 'يمكنك حذف ما أضفته فقط' using errcode = '42501';
  end if;
  delete from public.room_queue where room_id = p_room_id and id = p_item_id;
  return jsonb_build_object('ok', true, 'id', p_item_id);
end;
$$;

revoke all on function public.wt_create_room(text, text, text, text, text) from public;
revoke all on function public.wt_delete_room(text, text) from public;
revoke all on function public.wt_join_room(text, text, text, text) from public;
revoke all on function public.wt_apply_room_state(text, text, text, jsonb) from public;
revoke all on function public.wt_set_room_member_role(text, text, text, text) from public;
revoke all on function public.wt_queue_add(text, text, text, text, text) from public;
revoke all on function public.wt_queue_remove(text, text, text, bigint) from public;
grant execute on function public.wt_create_room(text, text, text, text, text) to anon, authenticated;
grant execute on function public.wt_delete_room(text, text) to anon, authenticated;
grant execute on function public.wt_join_room(text, text, text, text) to anon, authenticated;
grant execute on function public.wt_apply_room_state(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.wt_set_room_member_role(text, text, text, text) to anon, authenticated;
grant execute on function public.wt_queue_add(text, text, text, text, text) to anon, authenticated;
grant execute on function public.wt_queue_remove(text, text, text, bigint) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10) Realtime. REST polling يبقى شبكة أمان للاستضافة الثابتة عند تعطل WS.
-- ---------------------------------------------------------------------
alter table public.rooms replica identity full;
alter table public.messages replica identity full;
alter table public.room_members replica identity full;
alter table public.room_queue replica identity full;
alter table public.presence replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.rooms;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
  begin alter publication supabase_realtime add table public.room_members;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
  begin alter publication supabase_realtime add table public.room_queue;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
  begin alter publication supabase_realtime add table public.presence;
  exception when duplicate_object then null; when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 11) فحص سريع للمشروع.
-- ---------------------------------------------------------------------
drop view if exists public.wt_health;
create view public.wt_health as
select
  (select count(*) from public.rooms) as rooms,
  (select count(*) from public.messages) as messages,
  (select count(*) from public.presence) as presence,
  (select count(*) from public.room_members) as room_members,
  (select count(*) from public.room_queue) as room_queue,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public') as realtime_tables,
  (select count(*) from pg_policies where schemaname = 'public') as policies;
grant select on public.wt_health to anon, authenticated;

-- النتيجة المطلوبة: خمسة جداول عامة وسياسات قراءة/كتابة بحسب الدور.
select * from public.wt_health;

-- لتنظيف الحضور/الرسائل القديمة اختياريًا (pg_cron):
-- select cron.schedule('wt-cleanup', '*/10 * * * *', $$
--   delete from public.presence where last_seen < now() - interval '30 seconds';
--   delete from public.messages where created_at < now() - interval '7 days';
-- $$);

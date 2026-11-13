-- =====================================================================
-- WatchTogether — (04) إدارة الغرف والخصوصية والتحكم والبلاغات
-- نفّذ هذا الملف بعد 01-bootstrap.sql أو 02-schema.sql أو 03-migration.sql.
-- آمن للتكرار ولا يحذف الغرف الموجودة.
-- =====================================================================

begin;

alter table public.rooms add column if not exists is_private boolean not null default false;
alter table public.rooms add column if not exists control_mode text not null default 'everyone';
alter table public.rooms add column if not exists creator_id uuid;
alter table public.rooms alter column control_mode set default 'everyone';
alter table public.presence add column if not exists user_key text;
alter table public.room_members add column if not exists user_key text;

-- Playback control is no longer configurable: every valid room member can use it.
update public.rooms set control_mode = 'everyone'
where control_mode is distinct from 'everyone';

alter table public.rooms drop constraint if exists rooms_control_mode_check;
alter table public.rooms add constraint rooms_control_mode_check
  check (control_mode = 'everyone');

-- البلاغات خاصة بالمراجعين؛ لا توجد قراءة/كتابة مباشرة عبر PostgREST.
create table if not exists public.room_reports (
  id bigint generated always as identity primary key,
  room_id text not null references public.rooms(room_id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('spam', 'inappropriate', 'illegal', 'other')),
  details text not null default '',
  created_at timestamptz not null default now(),
  unique (room_id, reporter_id)
);
DO $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_reports'::regclass and conname = 'room_reports_room_id_fkey'
  ) then
    alter table public.room_reports add constraint room_reports_room_id_fkey
      foreign key (room_id) references public.rooms(room_id) on delete cascade;
  end if;
end $$;
alter table public.room_reports enable row level security;
revoke all on public.room_reports from public, anon, authenticated;

-- قائمة الغرف العامة لا تتضمن أي غرفة خاصة.
drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select to anon, authenticated using (not is_private);
grant select (room_id, title, video_url, host_name, state, created_at, updated_at, is_private, control_mode)
  on public.rooms to anon, authenticated;
grant select (room_id, client_id, display_name, role, user_key, created_at, updated_at)
  on public.room_members to anon, authenticated;

create or replace function public.wt_set_presence_user_key()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  new.user_key := case when auth.uid() is null then null
    else md5(new.room_id || ':' || auth.uid()::text) end;
  return new;
end;
$$;
revoke all on function public.wt_set_presence_user_key() from public;
drop trigger if exists wt_presence_user_key on public.presence;
create trigger wt_presence_user_key
  before insert or update on public.presence
  for each row execute function public.wt_set_presence_user_key();
drop policy if exists presence_read_write on public.presence;
create policy presence_read_write on public.presence
  for all to anon, authenticated using (true)
  with check (user_key is not distinct from case when auth.uid() is null then null
    else md5(room_id || ':' || auth.uid()::text) end);

-- التوافق مع إنشاء الغرف القديم، مع حفظ هوية الحساب الموثّقة عند توفرها.
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
  insert into public.rooms(room_id, title, video_url, host_name, creator_id)
  values (p_room_id, nullif(left(coalesce(p_title, ''), 120), ''), nullif(left(coalesce(p_video_url, ''), 2048), ''),
          left(coalesce(p_owner_name, 'مضيف'), 30), auth.uid())
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
      creator_id = coalesce(creator_id, auth.uid()),
      updated_at = clock_timestamp()
  where room_id = p_room_id;
  return jsonb_build_object('ok', true, 'room_id', p_room_id);
end;
$$;

-- قراءة خاصة للمنشئ فقط، وتُستخدم لاستعادة الغرف الخاصة في قائمته.
create or replace function public.wt_get_owned_room(p_room_id text, p_owner_token text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_room public.rooms%rowtype;
begin
  if p_owner_token is null or length(p_owner_token) < 48 or length(p_owner_token) > 256 then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id;
  if not found then return null; end if;
  if v_room.creator_id is not null and v_room.creator_id is distinct from auth.uid() then
    raise exception 'سجّل الدخول بحساب منشئ الغرفة' using errcode = '42501';
  end if;
  if not exists (select 1 from wt_private.room_secrets where room_id = p_room_id and owner_token = p_owner_token) then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'room_id', v_room.room_id, 'title', v_room.title,
    'video_url', coalesce(v_room.state->>'url', v_room.video_url), 'created_at', v_room.created_at,
    'is_private', v_room.is_private, 'control_mode', v_room.control_mode,
    'queue_count', (select count(*) from public.room_queue where room_id = p_room_id)
  );
end;
$$;

create or replace function public.wt_room_management(p_room_id text, p_owner_token text)
returns jsonb
language sql security definer
set search_path = public, pg_temp
as $$
  select public.wt_get_owned_room(p_room_id, p_owner_token);
$$;

-- المنشئ وحده يغيّر الاسم والرابط والخصوصية؛ التحكم بالمشاهدة ثابت لكل المشاركين المنضمّين.
create or replace function public.wt_update_room(
  p_room_id text,
  p_owner_token text,
  p_title text default null,
  p_video_url text default null,
  p_is_private boolean default null,
  p_control_mode text default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_queue_count bigint;
  v_now timestamptz := clock_timestamp();
  v_rev bigint;
  v_video text;
begin
  if p_owner_token is null or length(p_owner_token) < 48 or length(p_owner_token) > 256 then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id for update;
  if not found then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;
  if v_room.creator_id is not null and v_room.creator_id is distinct from auth.uid() then
    raise exception 'سجّل الدخول بحساب منشئ الغرفة' using errcode = '42501';
  end if;
  if not exists (select 1 from wt_private.room_secrets where room_id = p_room_id and owner_token = p_owner_token) then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  if p_title is not null and (length(btrim(p_title)) < 1 or length(p_title) > 40) then
    raise exception 'اسم الغرفة غير صالح' using errcode = '22023';
  end if;
  if p_control_mode is not null and p_control_mode not in ('owner', 'everyone') then
    raise exception 'إعداد التحكم غير صالح' using errcode = '22023';
  end if;
  if p_video_url is not null then
    v_video := btrim(p_video_url);
    if length(v_video) > 2048 or (v_video <> '' and v_video !~* '^https?://[^[:space:]]+$') then
      raise exception 'رابط المشاهدة غير صالح' using errcode = '22023';
    end if;
    select count(*) into v_queue_count from public.room_queue where room_id = p_room_id;
    if v_queue_count > 0 then
      raise exception 'أفرغ قائمة التشغيل قبل تغيير رابط المشاهدة' using errcode = '55000';
    end if;
    v_rev := coalesce(nullif(v_room.state->>'rev', '')::bigint, 0) + 1;
    update public.rooms
      set title = coalesce(p_title, title),
          creator_id = coalesce(creator_id, auth.uid()),
          video_url = nullif(v_video, ''),
          is_private = coalesce(p_is_private, is_private),
          control_mode = 'everyone',
          state = coalesce(state, '{}'::jsonb) || jsonb_build_object(
            'url', nullif(v_video, ''), 'playing', false, 'pos', 0, 't', floor(extract(epoch from v_now) * 1000)::bigint, 'rev', v_rev
          ),
          updated_at = v_now
      where room_id = p_room_id;
  else
    update public.rooms
      set title = coalesce(p_title, title),
          creator_id = coalesce(creator_id, auth.uid()),
          is_private = coalesce(p_is_private, is_private),
          control_mode = 'everyone',
          updated_at = v_now
      where room_id = p_room_id;
  end if;
  return public.wt_get_owned_room(p_room_id, p_owner_token);
end;
$$;

-- يسجّل هوية حساب مستعارة داخل الغرفة، مع إبقاء client_id ومفتاح العضوية لكل اتصال.
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

  insert into public.room_members(room_id, client_id, display_name, role, user_key)
  values (p_room_id, p_client_id, left(coalesce(nullif(p_display_name, ''), 'زائر'), 30), v_role,
    case when auth.uid() is null then null else md5(p_room_id || ':' || auth.uid()::text) end)
  on conflict (room_id, client_id) do update
    set display_name = excluded.display_name,
        updated_at = clock_timestamp(),
        role = excluded.role,
        user_key = excluded.user_key;

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
      select jsonb_agg(jsonb_build_object('client_id', client_id, 'display_name', display_name, 'role', role, 'user_key', user_key)
                       order by updated_at asc)
      from public.room_members where room_id = p_room_id
    ), '[]'::jsonb)
  );
end;
$$;

-- كل عضو نجح في الانضمام بمفتاحه يستطيع التحكم في المشاهدة.
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
    select display_name into v_name from public.room_members where room_id = p_room_id and client_id = p_client_id;
  else
    select m.role, m.display_name into v_role, v_name
      from public.room_members m
      join wt_private.member_secrets s using (room_id, client_id)
      where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token;
  end if;
  if v_role is null then
    raise exception 'انضم إلى الغرفة أولاً للتحكم بالمشاهدة' using errcode = '42501';
  end if;

  v_rev := coalesce(nullif(v_room.state->>'rev', '')::bigint, 0) + 1;
  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_state := p_state || jsonb_build_object(
    'rev', v_rev, 't', v_now_ms, 'updatedBy', p_client_id,
    'updatedByName', coalesce(nullif(v_name, ''), p_state->>'updatedByName', v_room.host_name, 'مشارك')
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

-- لقطة غرفة عبر مفتاح العضو بعد نجاح wt_join_room، بما في ذلك الغرف الخاصة.
create or replace function public.wt_room_snapshot(p_room_id text, p_client_id text, p_member_token text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_room public.rooms%rowtype;
begin
  if p_client_id is null or length(p_client_id) > 128 or p_member_token is null
     or length(p_member_token) < 48 or length(p_member_token) > 256 then
    raise exception 'بيانات العضو غير صالحة' using errcode = '22023';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id;
  if not found then return null; end if;
  if not exists (select 1 from wt_private.room_secrets where room_id = p_room_id and owner_token = p_member_token)
     and not exists (
       select 1 from public.room_members m
       join wt_private.member_secrets s using (room_id, client_id)
       where m.room_id = p_room_id and m.client_id = p_client_id and s.member_token = p_member_token
     ) then
    raise exception 'رمز العضو غير صالح' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'room_id', v_room.room_id, 'title', v_room.title, 'video_url', v_room.video_url,
    'host_name', v_room.host_name, 'state', v_room.state, 'updated_at', v_room.updated_at,
    'is_private', v_room.is_private, 'control_mode', v_room.control_mode
  );
end;
$$;

-- حذف نهائي للغرفة وكل ما يتبعها. المفاتيح التابعة تُحذف عبر ON DELETE CASCADE.
create or replace function public.wt_delete_room(p_room_id text, p_owner_token text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_room public.rooms%rowtype;
begin
  if p_owner_token is null or length(p_owner_token) < 48 or length(p_owner_token) > 256 then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  select * into v_room from public.rooms where room_id = p_room_id for update;
  if not found then return jsonb_build_object('ok', true, 'deleted', false); end if;
  if v_room.creator_id is not null and v_room.creator_id is distinct from auth.uid() then
    raise exception 'سجّل الدخول بحساب منشئ الغرفة' using errcode = '42501';
  end if;
  if not exists (select 1 from wt_private.room_secrets where room_id = p_room_id and owner_token = p_owner_token) then
    raise exception 'مفتاح المنشئ غير صالح' using errcode = '42501';
  end if;
  delete from public.messages where room_id = p_room_id;
  delete from public.presence where room_id = p_room_id;
  delete from public.room_reports where room_id = p_room_id;
  delete from public.rooms where room_id = p_room_id;
  return jsonb_build_object('ok', true, 'deleted', true);
end;
$$;

-- لا يمكن تقديم بلاغ دون حساب موثّق، ولا يقبل المنشئ الإبلاغ عن غرفته.
create or replace function public.wt_report_room(p_room_id text, p_reason text, p_details text default '')
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_creator uuid;
begin
  if auth.uid() is null then raise exception 'سجّل الدخول لإرسال البلاغ' using errcode = '42501'; end if;
  if p_reason not in ('spam', 'inappropriate', 'illegal', 'other') then
    raise exception 'سبب البلاغ غير صالح' using errcode = '22023';
  end if;
  select creator_id into v_creator from public.rooms where room_id = p_room_id;
  if not found then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;
  if v_creator = auth.uid() then raise exception 'لا يمكنك الإبلاغ عن غرفتك' using errcode = '42501'; end if;
  insert into public.room_reports(room_id, reporter_id, reason, details)
  values (p_room_id, auth.uid(), p_reason, left(coalesce(p_details, ''), 500))
  on conflict (room_id, reporter_id) do update
    set reason = excluded.reason, details = excluded.details, created_at = clock_timestamp();
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.wt_create_room(text, text, text, text, text) from public;
revoke all on function public.wt_get_owned_room(text, text) from public;
revoke all on function public.wt_room_management(text, text) from public;
revoke all on function public.wt_update_room(text, text, text, text, boolean, text) from public;
revoke all on function public.wt_apply_room_state(text, text, text, jsonb) from public;
revoke all on function public.wt_room_snapshot(text, text, text) from public;
revoke all on function public.wt_delete_room(text, text) from public;
revoke all on function public.wt_report_room(text, text, text) from public;
grant execute on function public.wt_create_room(text, text, text, text, text) to anon, authenticated;
grant execute on function public.wt_get_owned_room(text, text) to anon, authenticated;
grant execute on function public.wt_room_management(text, text) to anon, authenticated;
grant execute on function public.wt_update_room(text, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.wt_apply_room_state(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.wt_room_snapshot(text, text, text) to anon, authenticated;
grant execute on function public.wt_delete_room(text, text) to authenticated;
grant execute on function public.wt_report_room(text, text, text) to authenticated;

commit;

-- تحقق اختياري بعد التنفيذ:
-- select room_id, is_private, control_mode from public.rooms order by created_at desc limit 10;
-- select count(*) from public.room_reports;

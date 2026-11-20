-- WatchTogether — (13) reject stale playback snapshots.
-- Apply once after 04-room-management.sql. Idempotent and additive.
-- Prevents a delayed/offline room tab from replacing a newer play/pause action.
begin;

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
  v_client_rev bigint;
  v_current_rev bigint;
  v_current_by text;
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

  v_current_rev := coalesce(nullif(v_room.state->>'rev', '')::bigint, 0);
  v_current_by := coalesce(v_room.state->>'updatedBy', v_room.state->>'hostId', '');
  if coalesce(p_state->>'rev', '') ~ '^[0-9]{1,18}$' then
    v_client_rev := (p_state->>'rev')::bigint;
  else
    v_client_rev := null;
  end if;

  /* Reject stale snapshots instead of letting a delayed tab overwrite newer play/pause state.
     Equal revisions are concurrent; use the same stable client-id tie-break as WTUtil.stateWins. */
  if v_client_rev is null then
    if coalesce(v_room.state, '{}'::jsonb) <> '{}'::jsonb then return v_room.state; end if;
    v_client_rev := v_current_rev + 1;
  end if;
  if v_client_rev < v_current_rev
     or (v_client_rev = v_current_rev and p_client_id <= v_current_by) then
    return v_room.state;
  end if;

  v_rev := v_current_rev + 1;
  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_state := (p_state - 'authoritative') || jsonb_build_object(
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

revoke all on function public.wt_apply_room_state(text, text, text, jsonb) from public;
grant execute on function public.wt_apply_room_state(text, text, text, jsonb) to anon, authenticated;
notify pgrst, 'reload schema';

commit;

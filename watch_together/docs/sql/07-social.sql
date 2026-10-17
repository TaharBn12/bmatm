-- WatchTogether 3.0 — profiles, opt-in discovery, friendship, private messages and avatars.
-- Run AFTER 01 (or 02) in Supabase SQL Editor. Additive/idempotent; never drops room data.
-- Client writes go through authenticated RPCs. Actor IDs ALWAYS come from auth.uid().
begin;
create schema if not exists wt_social_private;
revoke all on schema wt_social_private from public, anon, authenticated;

create table if not exists public.wt_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 24),
  bio text not null default '' check (char_length(bio) <= 280),
  location text not null default '' check (char_length(location) <= 60),
  website text not null default '' check (website = '' or (char_length(website) <= 200 and website ~ '^https?://[^/@[:space:]]+([/?#].*)?$')),
  avatar_path text,
  interests text[] not null default '{}' check (cardinality(interests) <= 8 and interests <@ array['scifi','drama','comedy','thriller','animation','documentary','fantasy','adventure','romance','mystery','anime','shorts']::text[]),
  favorites text[] not null default '{}' check (cardinality(favorites) <= 3),
  mood text not null default 'none' check (mood in ('none','open','quiet','busy')),
  accent text not null default 'mint' check (accent in ('mint','violet','amber','rose')),
  cover text not null default 'orbit' check (cover in ('orbit','prism','ripple')),
  discoverable boolean not null default false,
  allow_requests boolean not null default true,
  read_receipts boolean not null default true,
  show_friend_count boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.wt_friendships (
  requester uuid not null references public.wt_profiles(user_id) on delete cascade,
  recipient uuid not null references public.wt_profiles(user_id) on delete cascade,
  user_low uuid generated always as (least(requester, recipient)) stored,
  user_high uuid generated always as (greatest(requester, recipient)) stored,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (user_low, user_high), check (requester <> recipient)
);
create index if not exists wt_friendships_recipient_idx on public.wt_friendships(recipient, status);
create index if not exists wt_friendships_requester_idx on public.wt_friendships(requester, status);
create table if not exists public.wt_blocks (
  blocker uuid not null references public.wt_profiles(user_id) on delete cascade,
  blocked uuid not null references public.wt_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(), primary key (blocker, blocked), check (blocker <> blocked)
);
create table if not exists public.wt_dm_threads (
  id uuid primary key default gen_random_uuid(),
  user_low uuid not null references public.wt_profiles(user_id) on delete cascade,
  user_high uuid not null references public.wt_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(), unique(user_low, user_high), check (user_low < user_high)
);
create index if not exists wt_dm_threads_high_idx on public.wt_dm_threads(user_high);
create sequence if not exists public.wt_social_change_seq;
create table if not exists public.wt_dm_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.wt_dm_threads(id) on delete cascade,
  sender_id uuid not null references public.wt_profiles(user_id) on delete cascade,
  nonce text not null check (nonce ~ '^[a-f0-9]{48,128}$'),
  version bigint not null default nextval('public.wt_social_change_seq'),
  body text not null check (char_length(body) <= 2000),
  kind text not null default 'text' check (kind in ('text','room')),
  room_id text,
  reply_id bigint references public.wt_dm_messages(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), edited_at timestamptz, deleted_at timestamptz,
  unique(sender_id, nonce)
);
create index if not exists wt_dm_messages_history_idx on public.wt_dm_messages(thread_id, id desc);
create index if not exists wt_dm_messages_changes_idx on public.wt_dm_messages(thread_id, version);
create table if not exists public.wt_dm_reads (
  thread_id uuid not null references public.wt_dm_threads(id) on delete cascade,
  user_id uuid not null references public.wt_profiles(user_id) on delete cascade,
  last_read_id bigint not null default 0, primary key(thread_id, user_id)
);
create table if not exists public.wt_dm_typing (
  thread_id uuid not null references public.wt_dm_threads(id) on delete cascade,
  user_id uuid not null references public.wt_profiles(user_id) on delete cascade,
  expires_at timestamptz not null, primary key(thread_id, user_id)
);
create table if not exists wt_social_private.rate_limits (
  key text primary key, hits integer not null, started_at timestamptz not null
);
create index if not exists wt_social_rate_age_idx on wt_social_private.rate_limits(started_at);

-- Defense in depth: no direct client table privileges, even for authenticated users.
-- RPCs below return explicit JSON fields and apply relationship/block checks server-side.
revoke all on public.wt_profiles, public.wt_friendships, public.wt_blocks, public.wt_dm_threads,
  public.wt_dm_messages, public.wt_dm_reads, public.wt_dm_typing from public, anon, authenticated;
revoke all on sequence public.wt_dm_messages_id_seq, public.wt_social_change_seq from public, anon, authenticated;
alter table public.wt_profiles enable row level security;
alter table public.wt_friendships enable row level security;
alter table public.wt_blocks enable row level security;
alter table public.wt_dm_threads enable row level security;
alter table public.wt_dm_messages enable row level security;
alter table public.wt_dm_reads enable row level security;
alter table public.wt_dm_typing enable row level security;
drop policy if exists wt_profile_self on public.wt_profiles;
create policy wt_profile_self on public.wt_profiles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists wt_friend_self on public.wt_friendships;
create policy wt_friend_self on public.wt_friendships for select to authenticated using ((select auth.uid()) in (requester, recipient));
drop policy if exists wt_block_self on public.wt_blocks;
create policy wt_block_self on public.wt_blocks for select to authenticated using (blocker = (select auth.uid()));
drop policy if exists wt_thread_self on public.wt_dm_threads;
create policy wt_thread_self on public.wt_dm_threads for select to authenticated using ((select auth.uid()) in (user_low, user_high));
drop policy if exists wt_message_self on public.wt_dm_messages;
create policy wt_message_self on public.wt_dm_messages for select to authenticated using (exists (
  select 1 from public.wt_dm_threads t where t.id=thread_id and (select auth.uid()) in (t.user_low,t.user_high)));
drop policy if exists wt_reads_self on public.wt_dm_reads;
create policy wt_reads_self on public.wt_dm_reads for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists wt_typing_self on public.wt_dm_typing;
create policy wt_typing_self on public.wt_dm_typing for select to authenticated using (user_id = (select auth.uid()));

create or replace function wt_social_private.actor() returns uuid language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare u uuid := auth.uid();
begin if u is null then raise exception 'سجّل الدخول بحساب لاستخدام هذه الميزة' using errcode='42501'; end if; return u; end $$;
create or replace function wt_social_private.blocked(a uuid,b uuid) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists(select 1 from public.wt_blocks where (blocker=a and blocked=b) or (blocker=b and blocked=a)) $$;
create or replace function wt_social_private.friends(a uuid,b uuid) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select not wt_social_private.blocked(a,b) and exists(select 1 from public.wt_friendships where user_low=least(a,b) and user_high=greatest(a,b) and status='accepted') $$;
create or replace function wt_social_private.relation(a uuid,b uuid) returns text language sql stable security definer set search_path = pg_catalog, public as $$
  select case when a=b then 'self' when wt_social_private.blocked(a,b) then 'unavailable'
    else coalesce((select case when status='accepted' then 'friends' when requester=a then 'outgoing' else 'incoming' end from public.wt_friendships where user_low=least(a,b) and user_high=greatest(a,b)), 'none') end $$;
create or replace function wt_social_private.consume(k text, budget int, seconds int) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare n int;
begin
  insert into wt_social_private.rate_limits as r(key,hits,started_at) values(k,1,clock_timestamp())
  on conflict(key) do update set hits=case when r.started_at < clock_timestamp()-make_interval(secs=>seconds) then 1 else r.hits+1 end,
    started_at=case when r.started_at < clock_timestamp()-make_interval(secs=>seconds) then clock_timestamp() else r.started_at end returning hits into n;
  if n > budget then raise exception 'محاولات كثيرة؛ انتظر قليلاً ثم أعد المحاولة' using errcode='P0001'; end if;
  delete from wt_social_private.rate_limits where started_at < clock_timestamp()-interval '2 days';
end $$;
create or replace function wt_social_private.ensure_profile(u uuid) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.wt_profiles(user_id,username,display_name,created_at)
  select id, 'u_'||left(replace(id::text,'-',''),20),
    case when char_length(btrim(coalesce(raw_user_meta_data->>'full_name',''))) >= 2 then left(btrim(raw_user_meta_data->>'full_name'),24) else 'مستخدم' end, coalesce(created_at,now())
  from auth.users where id=u on conflict(user_id) do nothing;
  if not exists(select 1 from public.wt_profiles where user_id=u) then raise exception 'الحساب غير متاح' using errcode='42501'; end if;
end $$;
create or replace function wt_social_private.sync_auth() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform wt_social_private.ensure_profile(new.id);
  if tg_op='UPDATE' and new.raw_user_meta_data->>'full_name' is distinct from old.raw_user_meta_data->>'full_name'
    and char_length(btrim(coalesce(new.raw_user_meta_data->>'full_name',''))) >= 2 then
    update public.wt_profiles set display_name=left(btrim(new.raw_user_meta_data->>'full_name'),24),updated_at=clock_timestamp() where user_id=new.id;
  end if;
  return new;
end $$;
drop trigger if exists wt_social_auth_profile on auth.users;
create trigger wt_social_auth_profile after insert or update of raw_user_meta_data on auth.users for each row execute function wt_social_private.sync_auth();
-- Existing accounts get an opt-in, non-discoverable profile. No email/phone is copied.
insert into public.wt_profiles(user_id,username,display_name,created_at)
select id,'u_'||left(replace(id::text,'-',''),20),case when char_length(btrim(coalesce(raw_user_meta_data->>'full_name','')))>=2 then left(btrim(raw_user_meta_data->>'full_name'),24) else 'مستخدم' end,coalesce(created_at,now())
from auth.users on conflict(user_id) do nothing;

create or replace function wt_social_private.profile_json(u uuid,v uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('user_id',p.user_id,'username',p.username,'display_name',p.display_name,'bio',p.bio,'location',p.location,'website',p.website,
   'avatar_path',p.avatar_path,'interests',p.interests,'favorites',p.favorites,'mood',p.mood,'accent',p.accent,'cover',p.cover,'created_at',p.created_at,'updated_at',p.updated_at,
   'own',u=v,'relation',wt_social_private.relation(v,u),'allow_requests',p.allow_requests,
   'discoverable',case when u=v then p.discoverable else null end,'read_receipts',case when u=v then p.read_receipts else null end,
   'show_friend_count',p.show_friend_count,
   'friend_count',case when u=v or p.show_friend_count then (select count(*) from public.wt_friendships f where u in(f.requester,f.recipient) and f.status='accepted') else null end,
   'shared_interests',to_jsonb(array(select unnest(p.interests) intersect select unnest(me.interests))))
 from public.wt_profiles p left join public.wt_profiles me on me.user_id=v where p.user_id=u $$;
create or replace function wt_social_private.counts(u uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('friends',(select count(*) from public.wt_friendships where u in(requester,recipient) and status='accepted'),
 'incoming',(select count(*) from public.wt_friendships where recipient=u and status='pending'),
 'outgoing',(select count(*) from public.wt_friendships where requester=u and status='pending'),
 'unread',(select count(*) from public.wt_dm_messages m join public.wt_dm_threads t on t.id=m.thread_id
 left join public.wt_dm_reads r on r.thread_id=t.id and r.user_id=u
 where u in(t.user_low,t.user_high) and m.sender_id<>u and m.deleted_at is null and m.id>coalesce(r.last_read_id,0))) $$;
create or replace function public.wt_social_bootstrap() returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor();
begin perform wt_social_private.ensure_profile(u); return jsonb_build_object('profile',wt_social_private.profile_json(u,u),'counts',wt_social_private.counts(u)); end $$;
create or replace function public.wt_social_profile(p_user uuid default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); target uuid := coalesce(p_user,u); result jsonb;
begin
 perform wt_social_private.ensure_profile(u);
 if wt_social_private.blocked(u,target) then raise exception 'الملف غير متاح' using errcode='42501'; end if;
 result := wt_social_private.profile_json(target,u);
 if result is null then raise exception 'الملف غير موجود' using errcode='P0002'; end if;
 return result;
end $$;
create or replace function public.wt_social_save_profile(p_patch jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); p public.wt_profiles; k text; v text;
begin
 perform wt_social_private.ensure_profile(u);
 perform wt_social_private.consume('profile:'||u::text,60,60);
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or octet_length(p_patch::text)>10000 then raise exception 'بيانات الملف غير صالحة' using errcode='22023'; end if;
 for k in select jsonb_object_keys(p_patch) loop
   if k not in('username','display_name','bio','location','website','avatar_path','interests','favorites','mood','accent','cover','discoverable','allow_requests','read_receipts','show_friend_count') then raise exception 'حقل غير مسموح' using errcode='22023'; end if;
 end loop;
 select * into p from public.wt_profiles where user_id=u for update;
 for k in select jsonb_object_keys(p_patch) loop
   if k in('discoverable','allow_requests','read_receipts','show_friend_count') then
     if jsonb_typeof(p_patch->k)<>'boolean' then raise exception 'إعداد خصوصية غير صالح' using errcode='22023'; end if;
   elsif k in('interests','favorites') then
     if jsonb_typeof(p_patch->k)<>'array' or exists(select 1 from jsonb_array_elements(p_patch->k) x where jsonb_typeof(x)<>'string') then raise exception 'قائمة غير صالحة' using errcode='22023'; end if;
   elsif k<>'avatar_path' and jsonb_typeof(p_patch->k)<>'string' then raise exception 'حقل غير صالح' using errcode='22023'; end if;
 end loop;
 if p_patch ? 'display_name' then p.display_name := btrim(p_patch->>'display_name'); end if;
 if p_patch ? 'username' then p.username := lower(btrim(p_patch->>'username')); end if;
 if p_patch ? 'bio' then p.bio := btrim(p_patch->>'bio'); end if;
 if p_patch ? 'location' then p.location := btrim(p_patch->>'location'); end if;
 if p_patch ? 'website' then p.website := btrim(p_patch->>'website'); end if;
 if p_patch ? 'interests' then p.interests := array(select distinct jsonb_array_elements_text(p_patch->'interests')); end if;
 if p_patch ? 'favorites' then p.favorites := array(select btrim(jsonb_array_elements_text(p_patch->'favorites'))); end if;
 if exists(select 1 from unnest(p.favorites) f where char_length(f)>80 or char_length(f)<1) then raise exception 'عنوان المفضلة من 1 إلى 80 حرفاً' using errcode='22023'; end if;
 if p_patch ? 'mood' then p.mood := p_patch->>'mood'; end if;
 if p_patch ? 'accent' then p.accent := p_patch->>'accent'; end if;
 if p_patch ? 'cover' then p.cover := p_patch->>'cover'; end if;
 if p_patch ? 'discoverable' then p.discoverable := (p_patch->>'discoverable')::boolean; end if;
 if p_patch ? 'allow_requests' then p.allow_requests := (p_patch->>'allow_requests')::boolean; end if;
 if p_patch ? 'read_receipts' then p.read_receipts := (p_patch->>'read_receipts')::boolean; end if;
 if p_patch ? 'show_friend_count' then p.show_friend_count := (p_patch->>'show_friend_count')::boolean; end if;
 if p_patch ? 'avatar_path' then
   v := nullif(p_patch->>'avatar_path','');
   if v is not null and (v !~ ('^'||u::text||'/[a-f0-9]{48}\.webp$') or not exists(select 1 from storage.objects where bucket_id='wt-avatars' and name=v)) then raise exception 'صورة الملف غير صالحة' using errcode='22023'; end if;
   p.avatar_path := v;
 end if;
 update public.wt_profiles set username=p.username,display_name=p.display_name,bio=p.bio,location=p.location,website=p.website,
 avatar_path=p.avatar_path,interests=p.interests,favorites=p.favorites,mood=p.mood,accent=p.accent,cover=p.cover,discoverable=p.discoverable,
 allow_requests=p.allow_requests,read_receipts=p.read_receipts,show_friend_count=p.show_friend_count,updated_at=clock_timestamp() where user_id=u;
 if p_patch ?| array['display_name','avatar_path','username'] then
   update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)||
     jsonb_build_object('full_name',p.display_name,'avatar_path',p.avatar_path,'wt_username',p.username),updated_at=clock_timestamp() where id=u;
 end if;
 return wt_social_private.profile_json(u,u);
exception when unique_violation then raise exception 'المعرّف مستخدم بالفعل؛ اختر معرّفاً آخر' using errcode='23505';
 when check_violation or not_null_violation then raise exception 'تحقّق من أطوال الحقول والمعرّف والرابط والاهتمامات' using errcode='22023';
end $$;

create or replace function public.wt_social_search(p_query text default '', p_genre text default null,p_offset int default 0) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); result jsonb; total int;
begin
 perform wt_social_private.ensure_profile(u);
 if char_length(p_query)>60 or p_offset<0 or p_offset>2000 then raise exception 'بحث غير صالح' using errcode='22023'; end if;
 select coalesce(jsonb_agg(x.profile order by x.shared desc,x.username),'[]'::jsonb),count(*) into result,total from (
   select wt_social_private.profile_json(p.user_id,u) profile,p.username,cardinality(array(select unnest(p.interests) intersect select unnest(me.interests))) shared
   from public.wt_profiles p join public.wt_profiles me on me.user_id=u
   where p.user_id<>u and p.discoverable and not wt_social_private.blocked(u,p.user_id)
   and (p_query='' or p.display_name ilike '%'||p_query||'%' or p.username ilike '%'||ltrim(p_query,'@')||'%')
   and (p_genre is null or p_genre=any(p.interests))
   order by shared desc,p.username limit 31 offset p_offset
 ) x;
 return jsonb_build_object('people',coalesce((select jsonb_agg(e.value order by e.ordinality) from jsonb_array_elements(result) with ordinality e(value,ordinality) where e.ordinality<=30),'[]'::jsonb),'has_more',total>30);
end $$;
create or replace function public.wt_social_friends(p_tab text default 'friends',p_offset int default 0,p_query text default '') returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); result jsonb; total int;
begin
 perform wt_social_private.ensure_profile(u);
 if p_tab not in('friends','incoming','outgoing','blocked') or char_length(p_query)>60 or p_offset<0 or p_offset>2000 then raise exception 'طلب غير صالح' using errcode='22023'; end if;
 if p_tab='blocked' then
   select coalesce(jsonb_agg(x.profile),'[]'::jsonb),count(*) into result,total from (
    select jsonb_build_object('user_id',p.user_id,'display_name',p.display_name,'username',p.username,'avatar_path',p.avatar_path,'relation','blocked','interests','[]'::jsonb,'shared_interests','[]'::jsonb,'mood','none','accent',p.accent) profile
    from public.wt_blocks b join public.wt_profiles p on p.user_id=b.blocked where b.blocker=u and (p_query='' or p.display_name ilike '%'||p_query||'%' or p.username ilike '%'||ltrim(p_query,'@')||'%') order by b.created_at desc limit 31 offset p_offset) x;
 else
   select coalesce(jsonb_agg(x.profile),'[]'::jsonb),count(*) into result,total from (
    select wt_social_private.profile_json(case when f.requester=u then f.recipient else f.requester end,u)||jsonb_build_object('request_created_at',f.created_at) profile
    from public.wt_friendships f join public.wt_profiles p on p.user_id=case when f.requester=u then f.recipient else f.requester end where (
    (p_tab='friends' and u in(f.requester,f.recipient) and f.status='accepted') or
    (p_tab='incoming' and f.recipient=u and f.status='pending') or (p_tab='outgoing' and f.requester=u and f.status='pending'))
    and (p_query='' or p.display_name ilike '%'||p_query||'%' or p.username ilike '%'||ltrim(p_query,'@')||'%')
    order by f.updated_at desc limit 31 offset p_offset) x;
 end if;
 return jsonb_build_object('people',coalesce((select jsonb_agg(e.value order by e.ordinality) from jsonb_array_elements(result) with ordinality e(value,ordinality) where e.ordinality<=30),'[]'::jsonb),'has_more',total>30,'counts',wt_social_private.counts(u));
end $$;
create or replace function public.wt_social_friend_action(p_user uuid,p_action text) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); f public.wt_friendships;
begin
 perform wt_social_private.ensure_profile(u);
 if p_user=u or not exists(select 1 from public.wt_profiles where user_id=p_user) then raise exception 'العملية غير متاحة' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(least(u,p_user)::text||greatest(u,p_user)::text,0));
 if p_action='block' then
   insert into public.wt_blocks(blocker,blocked) values(u,p_user) on conflict do nothing;
   delete from public.wt_friendships where user_low=least(u,p_user) and user_high=greatest(u,p_user);
   return jsonb_build_object('relation','blocked','counts',wt_social_private.counts(u));
 elsif p_action='unblock' then
   delete from public.wt_blocks where blocker=u and blocked=p_user;
   return jsonb_build_object('relation',wt_social_private.relation(u,p_user),'counts',wt_social_private.counts(u));
 end if;
 if wt_social_private.blocked(u,p_user) then raise exception 'العملية غير متاحة' using errcode='42501'; end if;
 select * into f from public.wt_friendships where user_low=least(u,p_user) and user_high=greatest(u,p_user) for update;
 if p_action='request' then
   if f.status is not null then return jsonb_build_object('relation',wt_social_private.relation(u,p_user),'counts',wt_social_private.counts(u)); end if;
   if not (select allow_requests from public.wt_profiles where user_id=p_user) then raise exception 'هذا العضو لا يستقبل طلبات صداقة الآن' using errcode='42501'; end if;
   perform wt_social_private.consume('requests:'||u::text,30,3600);
   perform wt_social_private.consume('request:'||u::text||':'||p_user::text,1,60);
   insert into public.wt_friendships(requester,recipient) values(u,p_user);
 elsif p_action='accept' and f.status='pending' and f.recipient=u then
   update public.wt_friendships set status='accepted',updated_at=clock_timestamp() where user_low=f.user_low and user_high=f.user_high;
 elsif (p_action='reject' and f.status='pending' and f.recipient=u) or
       (p_action='cancel' and f.status='pending' and f.requester=u) or (p_action='remove' and f.status='accepted') then
   delete from public.wt_friendships where user_low=f.user_low and user_high=f.user_high;
 else raise exception 'هذا الإجراء غير مسموح' using errcode='42501'; end if;
 return jsonb_build_object('relation',wt_social_private.relation(u,p_user),'counts',wt_social_private.counts(u));
end $$;

create or replace function wt_social_private.thread_peer(t uuid,u uuid) returns uuid language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare peer uuid;
begin
 select case when user_low=u then user_high else user_low end into peer from public.wt_dm_threads where id=t and u in(user_low,user_high);
 if peer is null then raise exception 'المحادثة غير متاحة' using errcode='42501'; end if; return peer;
end $$;
create or replace function wt_social_private.peer_json(p uuid,u uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select case when wt_social_private.blocked(p,u) then jsonb_build_object('user_id',p,'display_name','مستخدم غير متاح','username',null,'avatar_path',null,'unavailable',true,'relation','unavailable') else wt_social_private.profile_json(p,u) end $$;
create or replace function wt_social_private.message_json(m public.wt_dm_messages) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('id',m.id::text,'version',m.version::text,'thread_id',m.thread_id,'sender_id',m.sender_id,'nonce',m.nonce,'body',m.body,'kind',m.kind,'room_id',m.room_id,
 'reply_id',m.reply_id::text,'created_at',m.created_at,'updated_at',m.updated_at,'edited_at',m.edited_at,'deleted_at',m.deleted_at,
 'reply',(select jsonb_build_object('id',r.id::text,'sender_id',r.sender_id,'body',left(r.body,120),'deleted_at',r.deleted_at,'kind',r.kind) from public.wt_dm_messages r where r.id=m.reply_id and r.thread_id=m.thread_id)) $$;
create or replace function public.wt_social_open_thread(p_user uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); t uuid;
begin
 perform wt_social_private.ensure_profile(u);
 perform pg_advisory_xact_lock(hashtextextended(least(u,p_user)::text||greatest(u,p_user)::text,0));
 if p_user=u or not wt_social_private.friends(u,p_user) then raise exception 'المراسلة متاحة بعد قبول الصداقة' using errcode='42501'; end if;
 insert into public.wt_dm_threads(user_low,user_high) values(least(u,p_user),greatest(u,p_user)) on conflict(user_low,user_high) do nothing;
 select id into t from public.wt_dm_threads where user_low=least(u,p_user) and user_high=greatest(u,p_user);
 return jsonb_build_object('id',t,'peer',wt_social_private.peer_json(p_user,u),'can_send',true);
end $$;
create or replace function public.wt_social_threads(p_offset int default 0) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); result jsonb; total int;
begin
 if p_offset<0 or p_offset>5000 then raise exception 'طلب غير صالح' using errcode='22023'; end if;
 select coalesce(jsonb_agg(x.thread order by x.activity desc),'[]'::jsonb),count(*) into result,total from (
 select coalesce(last.created_at,t.created_at) activity,jsonb_build_object('id',t.id,
 'peer',wt_social_private.peer_json(case when t.user_low=u then t.user_high else t.user_low end,u),
 'can_send',wt_social_private.friends(t.user_low,t.user_high),'preview',case when last.id is null then null else wt_social_private.message_json(last) end,
 'updated_at',coalesce(last.created_at,t.created_at),
 'unread',(select count(*) from public.wt_dm_messages m where m.thread_id=t.id and m.sender_id<>u and m.deleted_at is null and m.id>coalesce(r.last_read_id,0))) thread
 from public.wt_dm_threads t left join lateral(select * from public.wt_dm_messages where thread_id=t.id order by id desc limit 1) last on true
 left join public.wt_dm_reads r on r.thread_id=t.id and r.user_id=u where u in(t.user_low,t.user_high)
 order by activity desc,t.id limit 31 offset p_offset) x;
 return jsonb_build_object('threads',coalesce((select jsonb_agg(e.value order by e.ordinality) from jsonb_array_elements(result) with ordinality e(value,ordinality) where e.ordinality<=30),'[]'::jsonb),'has_more',total>30,'counts',wt_social_private.counts(u));
end $$;
-- A monotonic change sequence + per-pair write lock avoids clock-skew/commit-order gaps.
-- Initial cursor is captured BEFORE the history query; concurrent new rows are harmless duplicates.
create or replace function public.wt_social_messages(p_thread uuid,p_before bigint default null,p_cursor bigint default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); peer uuid; rows jsonb; n int; cursor_value bigint := coalesce(p_cursor,0); more boolean := false;
begin
 peer := wt_social_private.thread_peer(p_thread,u);
 if p_cursor is not null then
   select coalesce(jsonb_agg(wt_social_private.message_json(x) order by x.version),'[]'::jsonb),count(*) into rows,n from (
     select * from public.wt_dm_messages where thread_id=p_thread and version>p_cursor order by version limit 101) x;
   more := n>100;
   rows := coalesce((select jsonb_agg(e.value order by e.ordinality) from jsonb_array_elements(rows) with ordinality e(value,ordinality) where e.ordinality<=100),'[]'::jsonb);
   if jsonb_array_length(rows)>0 then cursor_value := (rows->-1->>'version')::bigint; end if;
 else
   select coalesce(max(version),0) into cursor_value from public.wt_dm_messages where thread_id=p_thread;
   select coalesce(jsonb_agg(wt_social_private.message_json(x) order by x.id),'[]'::jsonb) into rows from (
     select * from public.wt_dm_messages where thread_id=p_thread and (p_before is null or id<p_before) order by id desc limit 50) x;
 end if;
 return jsonb_build_object('messages',rows,'has_more',exists(select 1 from public.wt_dm_messages where thread_id=p_thread and id<coalesce((rows->0->>'id')::bigint,0)),
 'cursor',cursor_value::text,'has_more_changes',more,
 'peer_read_id',case when wt_social_private.friends(u,peer) and (select read_receipts from public.wt_profiles where user_id=peer) then (select last_read_id::text from public.wt_dm_reads where thread_id=p_thread and user_id=peer) else null end,
 'typing',exists(select 1 from public.wt_dm_typing where thread_id=p_thread and user_id=peer and expires_at>clock_timestamp()) and wt_social_private.friends(u,peer),
 'can_send',wt_social_private.friends(u,peer),'peer',wt_social_private.peer_json(peer,u));
end $$;
create or replace function public.wt_social_send(p_thread uuid,p_body text,p_nonce text,p_reply bigint default null,p_room text default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); peer uuid; m public.wt_dm_messages; text_body text := btrim(coalesce(p_body,'')); room_title text;
begin
 peer := wt_social_private.thread_peer(p_thread,u);
 perform pg_advisory_xact_lock(hashtextextended(least(u,peer)::text||greatest(u,peer)::text,0));
 if not wt_social_private.friends(u,peer) then raise exception 'المراسلة متاحة للأصدقاء فقط، ما لم يوجد حظر' using errcode='42501'; end if;
 if p_nonce is null or p_nonce !~ '^[a-f0-9]{48,128}$' then raise exception 'معرّف إرسال غير صالح' using errcode='22023'; end if;
 select * into m from public.wt_dm_messages where sender_id=u and nonce=p_nonce;
 if m.id is not null then
   if m.thread_id<>p_thread then raise exception 'معرّف إرسال مستخدم' using errcode='22023'; end if;
   return wt_social_private.message_json(m);
 end if;
 if p_reply is not null and not exists(select 1 from public.wt_dm_messages where id=p_reply and thread_id=p_thread) then raise exception 'رد غير صالح' using errcode='22023'; end if;
 if p_room is not null then
   if p_room !~ '^[A-Z0-9]{4,12}$' then raise exception 'غرفة غير صالحة' using errcode='22023'; end if;
   select coalesce(nullif(title,''),'غرفة '||room_id) into room_title from public.rooms where room_id=p_room;
   if room_title is null then raise exception 'الغرفة غير موجودة على هذا الخادم' using errcode='22023'; end if;
   text_body := left(room_title,120);
 elsif char_length(text_body)<1 or char_length(text_body)>2000 then raise exception 'الرسالة من 1 إلى 2000 حرف' using errcode='22023'; end if;
 perform wt_social_private.consume('dm:'||u::text,80,60);
 insert into public.wt_dm_messages(thread_id,sender_id,nonce,body,kind,room_id,reply_id)
 values(p_thread,u,p_nonce,text_body,case when p_room is null then 'text' else 'room' end,p_room,p_reply) returning * into m;
 return wt_social_private.message_json(m);
end $$;
create or replace function public.wt_social_edit_message(p_message bigint,p_body text default null,p_delete boolean default false) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); m public.wt_dm_messages; peer uuid;
begin
 select * into m from public.wt_dm_messages where id=p_message and sender_id=u;
 if m.id is null then raise exception 'لا يمكنك تعديل هذه الرسالة' using errcode='42501'; end if;
 peer := wt_social_private.thread_peer(m.thread_id,u);
 perform pg_advisory_xact_lock(hashtextextended(least(u,peer)::text||greatest(u,peer)::text,0));
 select * into m from public.wt_dm_messages where id=p_message and sender_id=u for update;
 if not p_delete and (not wt_social_private.friends(u,peer) or m.kind<>'text' or m.deleted_at is not null or char_length(btrim(coalesce(p_body,''))) not between 1 and 2000) then raise exception 'تعذّر تعديل الرسالة' using errcode='42501'; end if;
 perform wt_social_private.consume('edit:'||u::text,120,60);
 update public.wt_dm_messages set body=case when p_delete then '' else btrim(p_body) end,
 room_id=case when p_delete then null else room_id end,kind=case when p_delete then 'text' else kind end,
 deleted_at=case when p_delete then coalesce(deleted_at,clock_timestamp()) else deleted_at end,
 edited_at=case when p_delete then edited_at else clock_timestamp() end,updated_at=clock_timestamp(),version=nextval('public.wt_social_change_seq') where id=m.id returning * into m;
 return wt_social_private.message_json(m);
end $$;
create or replace function public.wt_social_mark_read(p_thread uuid,p_message bigint) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); n bigint;
begin
 perform wt_social_private.thread_peer(p_thread,u);
 select max(id) into n from public.wt_dm_messages where thread_id=p_thread and id<=p_message;
 if n is not null then insert into public.wt_dm_reads as r(thread_id,user_id,last_read_id) values(p_thread,u,n)
   on conflict(thread_id,user_id) do update set last_read_id=greatest(r.last_read_id,excluded.last_read_id); end if;
 return jsonb_build_object('ok',true,'counts',wt_social_private.counts(u),'unread',(
   select count(*) from public.wt_dm_messages m left join public.wt_dm_reads r on r.thread_id=m.thread_id and r.user_id=u
   where m.thread_id=p_thread and m.sender_id<>u and m.deleted_at is null and m.id>coalesce(r.last_read_id,0)));
end $$;
create or replace function public.wt_social_typing(p_thread uuid,p_active boolean default true) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); peer uuid;
begin
 peer := wt_social_private.thread_peer(p_thread,u);
 if not wt_social_private.friends(u,peer) then return jsonb_build_object('ok',false); end if;
 if p_active then perform wt_social_private.consume('typing:'||u::text,50,60);
   insert into public.wt_dm_typing(thread_id,user_id,expires_at) values(p_thread,u,clock_timestamp()+interval '6 seconds')
   on conflict(thread_id,user_id) do update set expires_at=excluded.expires_at;
 else delete from public.wt_dm_typing where thread_id=p_thread and user_id=u; end if;
 return jsonb_build_object('ok',true);
end $$;

-- Avatars are explicitly public images (not private documents). Metadata stays private.
-- Only the owner may INSERT a new immutable, random WebP path or DELETE their own image.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('wt-avatars','wt-avatars',true,262144,array['image/webp'])
on conflict(id) do update set public=true,file_size_limit=262144,allowed_mime_types=array['image/webp'];
drop policy if exists wt_avatar_insert on storage.objects;
create policy wt_avatar_insert on storage.objects for insert to authenticated with check (
 bucket_id='wt-avatars' and name ~ ('^'||(select auth.uid())::text||'/[a-f0-9]{48}\.webp$'));
create or replace function public.wt_social_avatar_unused(p_name text) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
 select auth.uid() is not null and p_name ~ ('^'||auth.uid()::text||'/[a-f0-9]{48}\.webp$')
 and not exists(select 1 from public.wt_profiles where user_id=auth.uid() and avatar_path=p_name) $$;
drop policy if exists wt_avatar_delete on storage.objects;
create policy wt_avatar_delete on storage.objects for delete to authenticated using (
 bucket_id='wt-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text and public.wt_social_avatar_unused(name));
drop policy if exists wt_avatar_owner_read on storage.objects;
create policy wt_avatar_owner_read on storage.objects for select to authenticated using (
 bucket_id='wt-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text);

-- Restrictive namespace guards also apply when another app installed a broad
-- permissive Storage policy. Other buckets are deliberately left untouched.
drop policy if exists wt_avatar_guard_insert on storage.objects;
create policy wt_avatar_guard_insert on storage.objects as restrictive for insert to public with check (
 bucket_id is distinct from 'wt-avatars' or (auth.uid() is not null and name ~ ('^'||auth.uid()::text||'/[a-f0-9]{48}\.webp$')));
drop policy if exists wt_avatar_guard_read on storage.objects;
create policy wt_avatar_guard_read on storage.objects as restrictive for select to public using (
 bucket_id is distinct from 'wt-avatars' or (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists wt_avatar_guard_update on storage.objects;
create policy wt_avatar_guard_update on storage.objects as restrictive for update to public using (
 bucket_id is distinct from 'wt-avatars') with check (bucket_id is distinct from 'wt-avatars');
drop policy if exists wt_avatar_guard_delete on storage.objects;
create policy wt_avatar_guard_delete on storage.objects as restrictive for delete to public using (
 bucket_id is distinct from 'wt-avatars' or (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists wt_avatar_guard_referenced on storage.objects;
create policy wt_avatar_guard_referenced on storage.objects as restrictive for delete to authenticated using (
 bucket_id is distinct from 'wt-avatars' or public.wt_social_avatar_unused(name));

-- PUBLIC has EXECUTE by default in PostgreSQL: explicitly close that default surface.
do $$ declare f record;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='wt_social_private' or (n.nspname='public' and p.proname like 'wt_social_%') loop
   execute format('revoke all on function %s from public, anon, authenticated',f.signature);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname = any(array['wt_social_bootstrap','wt_social_profile','wt_social_save_profile','wt_social_search','wt_social_friends','wt_social_friend_action','wt_social_open_thread','wt_social_threads','wt_social_messages','wt_social_send','wt_social_edit_message','wt_social_mark_read','wt_social_typing','wt_social_avatar_unused']) loop
   execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
commit;

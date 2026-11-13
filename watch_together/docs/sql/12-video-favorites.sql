-- WatchTogether — مفضّلة الفيديوهات الشخصية المتزامنة عبر الحساب.
-- Run once after the base schema. Idempotent and additive; does not touch room_queue
-- or the short text favorites array used by profile cards.
begin;

create table if not exists public.wt_video_favorites (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  site text not null check (site in ('youtube', 'dailymotion', 'external')),
  content_type text not null default 'video' check (content_type = 'video'),
  item_id text not null check (char_length(item_id) between 1 and 160),
  url text not null check (char_length(url) between 8 and 2048 and url ~ '^https?://'),
  title text not null check (char_length(title) between 1 and 180),
  author text not null default '' check (char_length(author) <= 100),
  thumbnail text check (thumbnail is null or (char_length(thumbnail) <= 2048 and thumbnail ~ '^https://')),
  duration integer not null default 0 check (duration >= 0),
  channel_id text check (channel_id is null or char_length(channel_id) <= 120),
  channel_url text check (channel_url is null or (char_length(channel_url) <= 2048 and channel_url ~ '^https://')),
  saved_at timestamptz not null default clock_timestamp(),
  constraint wt_video_favorites_owner_item unique (user_id, site, content_type, item_id)
);

create index if not exists wt_video_favorites_saved_at_idx
  on public.wt_video_favorites (user_id, saved_at desc);

alter table public.wt_video_favorites enable row level security;
revoke all on public.wt_video_favorites from public, anon;
grant select, insert, update, delete on public.wt_video_favorites to authenticated;

drop policy if exists wt_video_favorites_read_own on public.wt_video_favorites;
create policy wt_video_favorites_read_own on public.wt_video_favorites
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists wt_video_favorites_insert_own on public.wt_video_favorites;
create policy wt_video_favorites_insert_own on public.wt_video_favorites
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists wt_video_favorites_update_own on public.wt_video_favorites;
create policy wt_video_favorites_update_own on public.wt_video_favorites
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists wt_video_favorites_delete_own on public.wt_video_favorites;
create policy wt_video_favorites_delete_own on public.wt_video_favorites
  for delete to authenticated using (user_id = (select auth.uid()));

notify pgrst, 'reload schema';
commit;

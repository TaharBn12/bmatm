-- =====================================================================
--  WatchTogether — تفضيلات المحادثة: تثبيت · كتم · أرشفة (12-dm-thread-prefs.sql)
--  نفّذ هذا الملف بعد 07-social.sql. آمن للتكرار ولا يحذف بيانات.
--
--  لماذا جدول منفصل؟
--    التفضيل يخصّ **مستخدمًا واحدًا** لا المحادثة: لو خزّنّاه في
--    wt_dm_threads لأرشف أحدهما المحادثة عند الآخر. لذلك جدول
--    (thread_id, user_id) — ولا يراه إلا صاحبه.
--
--  الأرشفة لا تحذف شيئاً: تُخفي المحادثة من القائمة الافتراضية فقط،
--  وتبقى رسائلها وتبقى قابلة للاستعادة في أي وقت.
-- =====================================================================

create table if not exists public.wt_dm_prefs (
  thread_id  uuid not null references public.wt_dm_threads(id) on delete cascade,
  user_id    uuid not null references public.wt_profiles(user_id) on delete cascade,
  pinned     boolean not null default false,
  muted      boolean not null default false,
  archived   boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (thread_id, user_id)
);

alter table public.wt_dm_prefs enable row level security;
revoke all on public.wt_dm_prefs from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) RPC واحدة تُغيّر ما تُرسله فقط (null = لا تغيير)
-- ---------------------------------------------------------------------
create or replace function public.wt_social_thread_pref(
  p_thread uuid,
  p_pinned boolean default null,
  p_muted boolean default null,
  p_archived boolean default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); row_data public.wt_dm_prefs;
begin
  perform wt_social_private.thread_peer(p_thread, u);        -- يرفض غير أطراف المحادثة
  insert into public.wt_dm_prefs as p(thread_id, user_id, pinned, muted, archived)
  values (p_thread, u, coalesce(p_pinned,false), coalesce(p_muted,false), coalesce(p_archived,false))
  on conflict (thread_id, user_id) do update set
    pinned   = coalesce(p_pinned,   p.pinned),
    muted    = coalesce(p_muted,    p.muted),
    archived = coalesce(p_archived, p.archived),
    updated_at = clock_timestamp()
  returning * into row_data;
  return jsonb_build_object('ok',true,'thread',p_thread,
    'prefs',jsonb_build_object('pinned',row_data.pinned,'muted',row_data.muted,'archived',row_data.archived));
end $$;

revoke all on function public.wt_social_thread_pref(uuid,boolean,boolean,boolean) from public, anon;
grant execute on function public.wt_social_thread_pref(uuid,boolean,boolean,boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 2) قائمة المحادثات: تفضيلات + مثبّتة أولاً + فصل المؤرشف
--    (p_archived = false افتراضياً: المؤرشف مخفي حتى تطلبه)
-- ---------------------------------------------------------------------
drop function if exists public.wt_social_threads(int);

create or replace function public.wt_social_threads(p_offset int default 0, p_archived boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); result jsonb; total int; hidden int;
begin
  if p_offset < 0 or p_offset > 5000 then raise exception 'طلب غير صالح' using errcode='22023'; end if;
  select count(*) into hidden from public.wt_dm_threads t
    join public.wt_dm_prefs pr on pr.thread_id = t.id and pr.user_id = u
   where u in (t.user_low, t.user_high) and pr.archived and not coalesce(p_archived,false);
  select coalesce(jsonb_agg(x.thread order by x.pinned desc, x.activity desc),'[]'::jsonb), count(*)
    into result, total
  from (
    select
      coalesce(last.created_at, t.created_at) activity,
      coalesce(pr.pinned,false) pinned,
      jsonb_build_object('id', t.id,
        'peer', wt_social_private.peer_json(case when t.user_low = u then t.user_high else t.user_low end, u),
        'can_send', wt_social_private.friends(t.user_low, t.user_high),
        'preview', case when last.id is null then null else wt_social_private.message_json(last) end,
        'updated_at', coalesce(last.created_at, t.created_at),
        'prefs', jsonb_build_object('pinned', coalesce(pr.pinned,false),
                                    'muted', coalesce(pr.muted,false),
                                    'archived', coalesce(pr.archived,false)),
        'unread', (select count(*) from public.wt_dm_messages m
                    where m.thread_id = t.id and m.sender_id <> u and m.deleted_at is null
                      and m.id > coalesce(r.last_read_id,0))) thread
    from public.wt_dm_threads t
    left join lateral (select * from public.wt_dm_messages where thread_id = t.id order by id desc limit 1) last on true
    left join public.wt_dm_reads r on r.thread_id = t.id and r.user_id = u
    left join public.wt_dm_prefs pr on pr.thread_id = t.id and pr.user_id = u
    where u in (t.user_low, t.user_high)
      and coalesce(pr.archived,false) = coalesce(p_archived,false)
    order by pinned desc, activity desc, t.id
    limit 31 offset p_offset
  ) x;
  return jsonb_build_object(
    'threads', coalesce((select jsonb_agg(e.value order by e.ordinality) from jsonb_array_elements(result) with ordinality e(value,ordinality) where e.ordinality <= 30),'[]'::jsonb),
    'has_more', total > 30,
    'archived', coalesce(p_archived,false),
    'hidden_archived', hidden,
    'counts', wt_social_private.counts(u));
end $$;

revoke all on function public.wt_social_threads(int,boolean) from public, anon;
grant execute on function public.wt_social_threads(int,boolean) to authenticated;

notify pgrst, 'reload schema';

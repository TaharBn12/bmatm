-- =====================================================================
--  WatchTogether — المكالمات الصوتية (09-calls.sql)
--  نفّذ هذا الملف بعد 07-social.sql. آمن للتكرار (idempotent) ولا يحذف بيانات.
--
--  المبدأ:
--   • الصوت يمر مباشرة بين الجهازين (WebRTC) ولا يُخزَّن ولا يمر بخادمنا.
--   • قاعدة البيانات تحفظ «حالة المكالمة» فقط لبناء السجل والإشعارات.
--   • إشارات الاتصال (SDP/ICE) تُخزَّن مؤقتاً في جدول مغلق بلا أي سياسة
--     قراءة مباشرة، عبر RPC محمية فقط، وتُحذف تلقائياً.
--   • لا مفاتيح إدارة ولا وصول anon إلى أي جدول هنا.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) تفضيل استقبال المكالمات
-- ---------------------------------------------------------------------
alter table public.wt_profiles
  add column if not exists allow_calls boolean not null default true;

create or replace function public.wt_social_calls_pref(p_allow boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor();
begin
  update public.wt_profiles set allow_calls = coalesce(p_allow,true), updated_at = clock_timestamp() where user_id = u;
  return jsonb_build_object('ok',true,'allow_calls',coalesce(p_allow,true));
end $$;

-- ---------------------------------------------------------------------
-- 1.5) إظهار التفضيل في بطاقة الملف (حتّى يعرف الطرف الآخر قبل الاتصال)
-- ---------------------------------------------------------------------
-- profile_json يُستخدم في: الملف الشخصي · قائمة الأصدقاء · بيانات المحادثة.
-- إضافة allow_calls هنا تعني أن زرّ المكالمة يتعطّل فورًا بلا طلب إضافي،
-- مع بقاء الفحص الحقيقي على الخادم داخل wt_social_call_start.
-- (to_jsonb لا p.allow_calls: فيعمل الملف حتّى قبل إضافة العمود في بيئة قديمة)
create or replace function wt_social_private.profile_json(u uuid,v uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('user_id',p.user_id,'username',p.username,'display_name',p.display_name,'bio',p.bio,'location',p.location,'website',p.website,
   'avatar_path',p.avatar_path,'interests',p.interests,'favorites',p.favorites,'mood',p.mood,'accent',p.accent,'cover',p.cover,'created_at',p.created_at,'updated_at',p.updated_at,
   'own',u=v,'relation',wt_social_private.relation(v,u),'allow_requests',p.allow_requests,
   'allow_calls',coalesce((to_jsonb(p)->>'allow_calls')::boolean,true),
   'discoverable',case when u=v then p.discoverable else null end,'read_receipts',case when u=v then p.read_receipts else null end,
   'show_friend_count',p.show_friend_count,
   'friend_count',case when u=v or p.show_friend_count then (select count(*) from public.wt_friendships f where u in(f.requester,f.recipient) and f.status='accepted') else null end,
   'shared_interests',to_jsonb(array(select unnest(p.interests) intersect select unnest(me.interests))))
 from public.wt_profiles p left join public.wt_profiles me on me.user_id=v where p.user_id=u $$;

-- ---------------------------------------------------------------------
-- 2) أنواع رسائل المحادثة: نص · دعوة غرفة · سجل مكالمة
-- ---------------------------------------------------------------------
alter table public.wt_dm_messages drop constraint if exists wt_dm_messages_kind_check;
alter table public.wt_dm_messages
  add constraint wt_dm_messages_kind_check check (kind in ('text','room','call'));

-- ---------------------------------------------------------------------
-- 3) جدول المكالمات — حالة فقط، بلا صوت
-- ---------------------------------------------------------------------
create table if not exists public.wt_dm_calls (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.wt_dm_threads(id) on delete cascade,
  caller_id   uuid not null references public.wt_profiles(user_id) on delete cascade,
  callee_id   uuid not null references public.wt_profiles(user_id) on delete cascade,
  media       text not null default 'audio' check (media in ('audio','video')),
  state       text not null default 'ringing'
              check (state in ('ringing','active','ended','missed','declined','busy','failed')),
  created_at  timestamptz not null default clock_timestamp(),
  answered_at timestamptz,
  ended_at    timestamptz,
  end_reason  text,
  duration_s  int,
  check (caller_id <> callee_id)
);
-- نبضة آخر نشاط: تكشف المكالمة «العالقة» التي هجرها صاحبها (إغلاق تبويب/انقطاع شبكة)
alter table public.wt_dm_calls add column if not exists last_seen_at timestamptz not null default clock_timestamp();

create index if not exists wt_dm_calls_thread_idx on public.wt_dm_calls(thread_id, created_at desc);
create index if not exists wt_dm_calls_live_idx on public.wt_dm_calls(state, created_at desc);

alter table public.wt_dm_calls enable row level security;
revoke all on public.wt_dm_calls from public, anon, authenticated;
-- لا سياسات: القراءة والكتابة عبر الدوال الآمنة فقط.

-- ---------------------------------------------------------------------
-- 4) إشارات الاتصال (مؤقتة، مغلقة، بلا قراءة مباشرة)
-- ---------------------------------------------------------------------
create table if not exists public.wt_call_signals (
  seq        bigint generated always as identity primary key,
  call_id    uuid not null references public.wt_dm_calls(id) on delete cascade,
  sender_id  uuid not null,
  payload    jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists wt_call_signals_call_idx on public.wt_call_signals(call_id, seq);

alter table public.wt_call_signals enable row level security;
revoke all on public.wt_call_signals from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) أدوات داخلية
-- ---------------------------------------------------------------------
create or replace function wt_social_private.call_party(p_call uuid, u uuid) returns public.wt_dm_calls
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare c public.wt_dm_calls;
begin
  select * into c from public.wt_dm_calls where id = p_call and u in (caller_id, callee_id);
  if c.id is null then raise exception 'المكالمة غير متاحة لهذا الحساب' using errcode='42501'; end if;
  return c;
end $$;

create or replace function wt_social_private.call_public(c public.wt_dm_calls, u uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'id', c.id, 'thread_id', c.thread_id,
    'caller_id', c.caller_id, 'callee_id', c.callee_id,
    'role', case when c.caller_id = u then 'caller' else 'callee' end,
    'peer', wt_social_private.peer_json(case when c.caller_id = u then c.callee_id else c.caller_id end, u),
    'media', c.media, 'state', c.state,
    'created_at', c.created_at, 'answered_at', c.answered_at,
    'ended_at', c.ended_at, 'end_reason', c.end_reason, 'duration_s', c.duration_s
  )
$$;

-- يُغلق المكالمة مرة واحدة فقط ويكتب سطر السجل في المحادثة.
create or replace function wt_social_private.call_finalize(p_call uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.wt_dm_calls; reason text := coalesce(nullif(btrim(p_reason),''),'hangup'); dur int := 0; body text;
begin
  select * into c from public.wt_dm_calls where id = p_call for update;
  if c.id is null then raise exception 'المكالمة غير موجودة' using errcode='22023'; end if;
  if c.ended_at is not null then
    return jsonb_build_object('ok',true,'already',true,'end_reason',c.end_reason,'duration_s',c.duration_s);
  end if;
  if reason not in ('hangup','missed','timeout','declined','busy','failed','error') then reason := 'hangup'; end if;
  if c.answered_at is not null then
    dur := greatest(0, floor(extract(epoch from (clock_timestamp() - c.answered_at)))::int);
  end if;
  update public.wt_dm_calls set state = case
      when reason in ('missed','timeout') then 'missed'
      when reason = 'declined' then 'declined'
      when reason = 'busy' then 'busy'
      when reason in ('failed','error') then 'failed'
      else 'ended' end,
    end_reason = reason, ended_at = clock_timestamp(), duration_s = dur
   where id = c.id returning * into c;

  body := case
    when c.state = 'missed' then 'مكالمة صوتية فائتة'
    when c.state = 'declined' then 'مكالمة صوتية مرفوضة'
    when c.state = 'busy' then 'مكالمة صوتية — كان مشغولاً'
    when c.state = 'failed' then 'تعذّرت المكالمة الصوتية'
    when dur <= 0 then 'مكالمة صوتية'
    else 'مكالمة صوتية · ' || case when dur >= 3600
      then floor(dur/3600)::text || ':' || lpad(floor((dur % 3600)/60)::text,2,'0') || ':' || lpad((dur % 60)::text,2,'0')
      else floor(dur/60)::text || ':' || lpad((dur % 60)::text,2,'0') end
  end;

  /* nonce عشوائي 64 حرفاً hex — بـsha256 المدمجة في PostgreSQL.
     لا تستخدم gen_random_bytes: هي من pgcrypto وتُثبَّت في مخطط extensions،
     ودوالنا تعمل بـsearch_path = pg_catalog, public → تفشل بـ42883
     «function gen_random_bytes(integer) does not exist» وهي رسالة لا تشبه
     سببها إطلاقاً (تظهر للمستخدم كأن 09 لم يُنفَّذ). */
  insert into public.wt_dm_messages(thread_id, sender_id, nonce, body, kind)
  values (c.thread_id, c.caller_id,
    encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text,'UTF8')),'hex'),
    body, 'call');

  delete from public.wt_call_signals where call_id = c.id;
  return jsonb_build_object('ok',true,'state',c.state,'end_reason',c.end_reason,'duration_s',c.duration_s,'body',body);
end $$;

-- نبضة: كل طلب ناجح من أحد الطرفين يعني أن المكالمة ما زالت حيّة.
-- (في الخلفية يخفض المتصفح المؤقّتات؛ لذلك لا نعتبر المكالمة «عالقة» قبل دقائق.)
create or replace function wt_social_private.call_touch(p_call uuid) returns void
language sql security definer set search_path = pg_catalog, public as $$
  update public.wt_dm_calls set last_seen_at = clock_timestamp() where id = p_call;
$$;

-- يُغلق: كل رنين أقدم من 50 ثانية، وكل مكالمة «نشطة» هجرها طرفاها (بلا نبضة 10 دقائق).
-- كان الرنين وحده يُغلق؛ أمّا مكالمة بقيت active بعد إغلاق التبويب فكانت تحجب
-- أي مكالمة جديدة حتّى 3 ساعات: هذا هو سبب «تبقى مكالمة جارية ولا أجد أين أقطعها».
create or replace function wt_social_private.call_expire(p_thread uuid default null) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare r record;
begin
  for r in select id from public.wt_dm_calls
    where state = 'ringing'
      and created_at < clock_timestamp() - interval '50 seconds'
      and (p_thread is null or thread_id = p_thread)
  loop
    perform wt_social_private.call_finalize(r.id,'timeout');
  end loop;
  for r in select id from public.wt_dm_calls
    where state = 'active'
      and ended_at is null
      and coalesce(last_seen_at, created_at) < clock_timestamp() - interval '10 minutes'
      and (p_thread is null or thread_id = p_thread)
  loop
    perform wt_social_private.call_finalize(r.id,'failed');
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6) الدوال العامة (RPC) — كلها للحساب المسجّل فقط
-- ---------------------------------------------------------------------
create or replace function public.wt_social_call_start(p_thread uuid, p_media text default 'audio') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); peer uuid; c public.wt_dm_calls; allowed boolean; text_body jsonb; r record;
begin
  if coalesce(p_media,'audio') <> 'audio' then raise exception 'المكالمات الصوتية فقط متاحة حالياً' using errcode='22023'; end if;
  perform wt_social_private.ensure_profile(u);
  peer := wt_social_private.thread_peer(p_thread, u);
  if wt_social_private.blocked(u, peer) then raise exception 'لا يمكن إجراء مكالمة مع عضو محظور' using errcode='42501'; end if;
  if not wt_social_private.friends(u, peer) then raise exception 'المكالمات متاحة للأصدقاء المقبولين فقط' using errcode='42501'; end if;
  select allow_calls into allowed from public.wt_profiles where user_id = peer;
  if coalesce(allowed,true) is false then raise exception 'هذا العضو أوقف استقبال المكالمات' using errcode='42501'; end if;
  perform wt_social_private.call_expire(null);   /* مسح شامل: لا تحبسك مكالمة مهجورة في محادثة أخرى */
  /* مكالمة «حيّة» بلا نبضة منذ 45 ثانية = مهجورة فعلاً (تبويب أُغلق، جهاز نام،
     أو إنهاء لم يصل للخادم). الطرفان يستطلعان كل 0.9–2.6 ثانية ما داما في
     المكالمة، وكل استطلاع يلمس last_seen_at — فالنبضة الطازجة تعني أن أحداً
     ما زال فيها. بدون هذا كان المستخدم يُحبس 10 دقائق برسالة «لديك مكالمة جارية». */
  for r in select id from public.wt_dm_calls
            where state in ('ringing','active') and ended_at is null
              and u in (caller_id, callee_id)
              and coalesce(last_seen_at, created_at) < clock_timestamp() - interval '45 seconds'
  loop
    perform wt_social_private.call_finalize(r.id,'failed');
  end loop;
  if exists (select 1 from public.wt_dm_calls
             where state in ('ringing','active')
               and created_at > clock_timestamp() - interval '3 hours'
               and u in (caller_id, callee_id)) then
    raise exception 'لديك مكالمة جارية بالفعل' using errcode='42501';
  end if;
  perform wt_social_private.consume('call:' || u::text, 6, 60);
  insert into public.wt_dm_calls(thread_id, caller_id, callee_id, media, state)
  values (p_thread, u, peer, 'audio', 'ringing') returning * into c;
  return jsonb_build_object('ok',true,'call', wt_social_private.call_public(c,u));
end $$;

create or replace function public.wt_social_call_answer(p_call uuid, p_accept boolean default true) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls;
begin
  c := wt_social_private.call_party(p_call, u);
  if c.callee_id <> u then raise exception 'القبول من المستقبل فقط' using errcode='42501'; end if;
  if c.state <> 'ringing' or c.ended_at is not null then
    return jsonb_build_object('ok',true,'changed',false,'call', wt_social_private.call_public(c,u));
  end if;
  if p_accept then
    update public.wt_dm_calls set state='active', answered_at = clock_timestamp(),
      last_seen_at = clock_timestamp() where id=c.id returning * into c;
  else
    perform wt_social_private.call_finalize(c.id,'declined');
    select * into c from public.wt_dm_calls where id = c.id;
  end if;
  return jsonb_build_object('ok',true,'changed',true,'call', wt_social_private.call_public(c,u));
end $$;

create or replace function public.wt_social_call_end(p_call uuid, p_reason text default 'hangup') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls; done jsonb;
begin
  c := wt_social_private.call_party(p_call, u);
  done := wt_social_private.call_finalize(c.id, p_reason);
  select * into c from public.wt_dm_calls where id = c.id;
  return done || jsonb_build_object('call', wt_social_private.call_public(c,u));
end $$;

create or replace function public.wt_social_call_state(p_call uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls;
begin
  c := wt_social_private.call_party(p_call, u);
  if c.state = 'ringing' and c.created_at < clock_timestamp() - interval '50 seconds' then
    perform wt_social_private.call_finalize(c.id,'timeout');
    select * into c from public.wt_dm_calls where id = c.id;
  end if;
  return jsonb_build_object('ok',true,'call', wt_social_private.call_public(c,u));
end $$;

create or replace function public.wt_social_call_signal_put(p_call uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls; seq_value bigint;
begin
  c := wt_social_private.call_party(p_call, u);
  if c.state not in ('ringing','active') or c.ended_at is not null then
    raise exception 'المكالمة مغلقة' using errcode='42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'حمولة إشارة غير صالحة' using errcode='22023';
  end if;
  if octet_length(p_payload::text) > 65536 then
    raise exception 'حمولة الإشارة كبيرة' using errcode='22023';
  end if;
  perform wt_social_private.consume('sig:' || u::text, 240, 60);
  perform wt_social_private.call_touch(c.id);
  delete from public.wt_call_signals where call_id = c.id and created_at < clock_timestamp() - interval '90 seconds';
  insert into public.wt_call_signals(call_id, sender_id, payload) values (c.id, u, p_payload) returning seq into seq_value;
  return jsonb_build_object('ok',true,'seq',seq_value);
end $$;

create or replace function public.wt_social_call_signal_get(p_call uuid, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls; rows jsonb; head bigint;
begin
  c := wt_social_private.call_party(p_call, u);
  if c.state = 'ringing' and c.created_at < clock_timestamp() - interval '50 seconds' then
    perform wt_social_private.call_finalize(c.id,'timeout');
    select * into c from public.wt_dm_calls where id = c.id;
  end if;
  if c.state = 'active' and coalesce(c.last_seen_at, c.created_at) < clock_timestamp() - interval '10 minutes' then
    perform wt_social_private.call_finalize(c.id,'failed');
    select * into c from public.wt_dm_calls where id = c.id;
  elsif c.state in ('ringing','active') and c.ended_at is null then
    perform wt_social_private.call_touch(c.id);   /* نبضة: الطرفان يستطلعان كل ثوانٍ */
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('seq',s.seq,'sender_id',s.sender_id,'payload',s.payload,'created_at',s.created_at) order by s.seq),'[]'::jsonb)
    into rows
    from (select * from public.wt_call_signals
           where call_id = c.id and seq > coalesce(p_after,0) and sender_id <> u
           order by seq limit 50) s;
  select max(seq) into head from public.wt_call_signals where call_id = c.id;
  return jsonb_build_object('ok',true,'call', wt_social_private.call_public(c,u),'signals',rows,'cursor',coalesce(head,0));
end $$;

-- p_thread = null يعني: «هل يرنّ أحد لي في أي محادثة؟» — كي لا تفوتك مكالمة
-- لأنك لم تكن فاتحًا المحادثة نفسها.
create or replace function public.wt_social_call_incoming(p_thread uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls; other uuid;
begin
  if p_thread is not null then
    other := wt_social_private.thread_peer(p_thread, u);
    if not wt_social_private.friends(u, other) or wt_social_private.blocked(u, other) then
      return jsonb_build_object('ok',true,'call',null);
    end if;
  end if;
  perform wt_social_private.call_expire(p_thread);
  select * into c from public.wt_dm_calls
    where callee_id = u and state = 'ringing' and ended_at is null
      and (p_thread is null or thread_id = p_thread)
      and created_at > clock_timestamp() - interval '50 seconds'
    order by created_at desc limit 1;
  if c.id is not null and (wt_social_private.blocked(u,c.caller_id) or not wt_social_private.friends(u,c.caller_id)) then
    c.id := null;
  end if;
  return jsonb_build_object('ok',true,'call', case when c.id is null then null else wt_social_private.call_public(c,u) end);
end $$;

-- مكالمتي الحيّة الآن (رنين أو جارية) — تُستخدم عند فتح الصفحة من جديد
-- لاستعادة الشريط وزرّ الإنهاء بدل أن تبقى «عالقة» بلا مكان تُقطع منه.
create or replace function public.wt_social_call_current() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); c public.wt_dm_calls;
begin
  perform wt_social_private.call_expire(null);
  select * into c from public.wt_dm_calls
    where u in (caller_id, callee_id) and state in ('ringing','active') and ended_at is null
    order by created_at desc limit 1;
  return jsonb_build_object('ok',true,'call', case when c.id is null then null else wt_social_private.call_public(c,u) end);
end $$;

-- إنهاء أي مكالمة عالقة لحسابي (زرّ «إنهاء المكالمة السابقة»).
-- ملك للحساب نفسه فقط، ولا يمسّ مكالمات الآخرين.
create or replace function public.wt_social_call_reset() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); r record; n int := 0;
begin
  for r in select id from public.wt_dm_calls
    where u in (caller_id, callee_id) and state in ('ringing','active') and ended_at is null
  loop
    /* 'hangup' لا 'missed': المستخدم هو من أنهى، فلا نكتب «مكالمة فائتة» على الطرف الآخر */
    perform wt_social_private.call_finalize(r.id,'hangup');
    n := n + 1;
  end loop;
  return jsonb_build_object('ok',true,'closed',n);
end $$;

-- ---------------------------------------------------------------------
-- 7) الصلاحيات
-- ---------------------------------------------------------------------
revoke all on function public.wt_social_calls_pref(boolean) from public, anon;
revoke all on function public.wt_social_call_start(uuid,text) from public, anon;
revoke all on function public.wt_social_call_answer(uuid,boolean) from public, anon;
revoke all on function public.wt_social_call_end(uuid,text) from public, anon;
revoke all on function public.wt_social_call_state(uuid) from public, anon;
revoke all on function public.wt_social_call_signal_put(uuid,jsonb) from public, anon;
revoke all on function public.wt_social_call_signal_get(uuid,bigint) from public, anon;
revoke all on function public.wt_social_call_incoming(uuid) from public, anon;
revoke all on function public.wt_social_call_current() from public, anon;
revoke all on function public.wt_social_call_reset() from public, anon;

grant execute on function public.wt_social_calls_pref(boolean) to authenticated;
grant execute on function public.wt_social_call_start(uuid,text) to authenticated;
grant execute on function public.wt_social_call_answer(uuid,boolean) to authenticated;
grant execute on function public.wt_social_call_end(uuid,text) to authenticated;
grant execute on function public.wt_social_call_state(uuid) to authenticated;
grant execute on function public.wt_social_call_signal_put(uuid,jsonb) to authenticated;
grant execute on function public.wt_social_call_signal_get(uuid,bigint) to authenticated;
grant execute on function public.wt_social_call_incoming(uuid) to authenticated;
grant execute on function public.wt_social_call_current() to authenticated;
grant execute on function public.wt_social_call_reset() to authenticated;

-- ---------------------------------------------------------------------
-- 8) حذف سجلات الإشارات القديمة (يمكن جدولته في cron)
-- ---------------------------------------------------------------------
create or replace function public.wt_calls_cleanup() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n int;
begin
  perform wt_social_private.call_expire(null);
  delete from public.wt_call_signals where created_at < clock_timestamp() - interval '10 minutes';
  get diagnostics n = row_count;
  return jsonb_build_object('ok',true,'removed_signals',n);
end $$;
revoke all on function public.wt_calls_cleanup() from public, anon, authenticated;

-- فحص سريع بعد التنفيذ
create or replace view public.wt_calls_health as
select
  (select count(*) from public.wt_dm_calls) as calls,
  (select count(*) from public.wt_dm_calls where state in ('ringing','active')) as live_calls,
  (select count(*) from public.wt_call_signals) as signals,
  (select count(*) from public.wt_profiles where allow_calls) as accepting_calls;
revoke all on public.wt_calls_health from public, anon, authenticated;

notify pgrst, 'reload schema';

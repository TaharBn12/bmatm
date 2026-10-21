-- =====================================================================
--  WatchTogether — تفاعل سريع على الرسائل (11-dm-reactions.sql)
--  نفّذ هذا الملف بعد 07-social.sql و 10-dm-realtime.sql.
--  آمن للتكرار (idempotent) ولا يحذف بيانات.
--
--  القرار: تفاعل واحد لكل رسالة (لا عدّاد لكل شخص) — أبسط وأصدق:
--  إمّا ❤️ أو لا شيء. أي من طرفَي المحادثة يستطيع وضعه أو إزالته،
--  والنتيجة تظهر للطرفين فوراً عبر البثّ الحيّ.
--  لا تُحفظ تفاعلات على رسالة محذوفة، ولا من غير الأصدقاء المقبولين.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) العمود + القيد
-- ---------------------------------------------------------------------
alter table public.wt_dm_messages add column if not exists reaction text;
alter table public.wt_dm_messages drop constraint if exists wt_dm_messages_reaction_check;
alter table public.wt_dm_messages add constraint wt_dm_messages_reaction_check
  check (reaction is null or reaction in ('❤️','😮','😂','👍','🔥'));

-- ---------------------------------------------------------------------
-- 2) إعادة بناء message_json كي تُعاد خانة التفاعل في كل RPC
-- ---------------------------------------------------------------------
create or replace function wt_social_private.message_json(m public.wt_dm_messages) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('id',m.id::text,'version',m.version::text,'thread_id',m.thread_id,'sender_id',m.sender_id,'nonce',m.nonce,'body',m.body,'kind',m.kind,'room_id',m.room_id,
 'reply_id',case when m.reply_id is null then null else m.reply_id::text end,'created_at',m.created_at,'edited_at',m.edited_at,'deleted_at',m.deleted_at,
 'reaction',m.reaction,
 'reply',(select jsonb_build_object('id',r.id::text,'sender_id',r.sender_id,'body',left(r.body,120),'deleted_at',r.deleted_at,'kind',r.kind) from public.wt_dm_messages r where r.id=m.reply_id and r.thread_id=m.thread_id)) $$;

-- ---------------------------------------------------------------------
-- 3) RPC التفاعل
-- ---------------------------------------------------------------------
create or replace function public.wt_social_react(p_message bigint, p_reaction text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare u uuid := wt_social_private.actor(); m public.wt_dm_messages; peer uuid; want text;
begin
  select * into m from public.wt_dm_messages where id = p_message;
  if m.id is null then raise exception 'الرسالة غير موجودة' using errcode='P0002'; end if;
  peer := wt_social_private.thread_peer(m.thread_id, u);           -- يرفض غير أطراف المحادثة
  if not wt_social_private.friends(u, peer) or wt_social_private.blocked(u, peer) then
    raise exception 'التفاعل متاح للأصدقاء المقبولين فقط' using errcode='42501';
  end if;
  if m.deleted_at is not null then
    raise exception 'لا يمكن التفاعل مع رسالة محذوفة' using errcode='22023';
  end if;
  want := nullif(btrim(coalesce(p_reaction, '')), '');
  if want is not null and want not in ('❤️','😮','😂','👍','🔥') then
    raise exception 'تفاعل غير مدعوم' using errcode='22023';
  end if;
  perform wt_social_private.consume('react:' || u::text, 60, 60);
  -- تغيير version يُطلق مشغّل البثّ (10-dm-realtime.sql) فيرى الطرف الآخر فوراً
  update public.wt_dm_messages
     set reaction = want, updated_at = clock_timestamp(), version = nextval('public.wt_social_change_seq')
   where id = m.id returning * into m;
  return wt_social_private.message_json(m);
end $$;

revoke all on function public.wt_social_react(bigint,text) from public, anon;
grant execute on function public.wt_social_react(bigint,text) to authenticated;

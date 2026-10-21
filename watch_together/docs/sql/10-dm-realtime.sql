-- =====================================================================
--  WatchTogether — البثّ الحيّ للرسائل الخاصة (10-dm-realtime.sql)
--  نفّذ هذا الملف بعد 07-social.sql و 09-calls.sql.
--  آمن للتكرار (idempotent) ولا يحذف بيانات.
--
--  لماذا ملف منفصل؟
--    جداول wt_dm_* ممنوعٌ الوصول إليها مباشرة (revoke all + RLS تعتمد
--    على استعلامات مرتبطة)، وSupabase Realtime لا يستطيع فرض هذه
--    السياسات في postgres_changes. لذلك نستخدم **Broadcast**:
--    مشغّل (trigger) يرسل حدثاً صغيراً إلى قناة خاصة بكل مستخدم،
--    والعميل يعيد قراءة الرسائل عبر RPC المحمي كما هو.
--
--  الخصوصية:
--    • لا يُبَثّ أي نصّ رسالة — فقط معرّفات وطوابع (thread, id, version).
--    • القناة `wt:user:<uuid>` خاصة، وسياسة RLS على realtime.messages
--      تمنع أي مستخدم من الاستماع لقناة غيره.
--    • لو فشل البثّ لأي سبب لا تفشل كتابة الرسالة (تحذير فقط).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) إرسال إلى طرفَي المحادثة (أو إلى الطرف الآخر فقط)
-- ---------------------------------------------------------------------
create or replace function wt_social_private.realtime_thread(
  p_thread uuid, p_event text, p_payload jsonb, p_skip uuid default null
) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare lo uuid; hi uuid;
begin
  select t.user_low, t.user_high into lo, hi
    from public.wt_dm_threads t where t.id = p_thread;
  if lo is null then return; end if;
  if lo is distinct from p_skip then
    perform realtime.send(p_payload, p_event, 'wt:user:' || lo::text, true);
  end if;
  if hi is distinct from lo and hi is distinct from p_skip then
    perform realtime.send(p_payload, p_event, 'wt:user:' || hi::text, true);
  end if;
exception when others then
  -- البثّ تحسين لا شرط: لا نُسقط رسالة لأن خدمة Realtime تعطّلت.
  raise warning 'wt realtime: تعذّر البثّ (%)', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 2) مشغّلات الرسائل: جديد/تعديل/حذف ناعم
-- ---------------------------------------------------------------------
create or replace function wt_social_private.trg_dm_message() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform wt_social_private.realtime_thread(
    new.thread_id,
    'message',
    jsonb_build_object('thread', new.thread_id, 'id', new.id, 'version', new.version,
                       'sender', new.sender_id, 'kind', new.kind)
  );
  return null;
exception when others then
  raise warning 'wt realtime: تعذّر بثّ الرسالة (%)', sqlerrm;
  return null;
end $$;

drop trigger if exists wt_dm_message_realtime on public.wt_dm_messages;
create trigger wt_dm_message_realtime
  after insert or update of body, deleted_at, version on public.wt_dm_messages
  for each row execute function wt_social_private.trg_dm_message();

-- إشعار الطرف الآخر حين يقرأ (لبناء «قُرئت» فورياً بدل انتظار الاستطلاع)
create or replace function wt_social_private.trg_dm_read() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform wt_social_private.realtime_thread(
    new.thread_id,
    'read',
    jsonb_build_object('thread', new.thread_id, 'user', new.user_id, 'last_read', new.last_read_id),
    new.user_id
  );
  return null;
exception when others then
  raise warning 'wt realtime: تعذّر بثّ القراءة (%)', sqlerrm;
  return null;
end $$;

drop trigger if exists wt_dm_read_realtime on public.wt_dm_reads;
create trigger wt_dm_read_realtime
  after insert or update of last_read_id on public.wt_dm_reads
  for each row execute function wt_social_private.trg_dm_read();

-- مؤشّر «يكتب الآن»
create or replace function wt_social_private.trg_dm_typing() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare row_data public.wt_dm_typing := coalesce(new, old);
begin
  perform wt_social_private.realtime_thread(
    row_data.thread_id,
    'typing',
    jsonb_build_object('thread', row_data.thread_id, 'user', row_data.user_id,
                       'until', row_data.expires_at, 'active', case when tg_op = 'DELETE' then false else true end),
    row_data.user_id
  );
  return null;
exception when others then
  raise warning 'wt realtime: تعذّر بثّ الكتابة (%)', sqlerrm;
  return null;
end $$;

drop trigger if exists wt_dm_typing_realtime on public.wt_dm_typing;
create trigger wt_dm_typing_realtime
  after insert or update or delete on public.wt_dm_typing
  for each row execute function wt_social_private.trg_dm_typing();

-- ---------------------------------------------------------------------
-- 3) سياسة الاشتراك: كل مستخدم يستمع لقناته فقط، وبثّ فقط
-- ---------------------------------------------------------------------
-- realtime.messages يديرها Supabase؛ نضيف سياسة قراءة واحدة.
drop policy if exists wt_dm_realtime_own_topic on realtime.messages;
create policy wt_dm_realtime_own_topic on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      case when realtime.topic() like 'realtime:%' then substr(realtime.topic(), 10)
           else realtime.topic() end
    ) = 'wt:user:' || (select auth.uid())::text
  );

-- ---------------------------------------------------------------------
-- 4) فحص سريع بعد التنفيذ
-- ---------------------------------------------------------------------
create or replace view public.wt_realtime_health as
select
  (select count(*) from pg_trigger where tgname = 'wt_dm_message_realtime') as message_triggers,
  (select count(*) from pg_trigger where tgname = 'wt_dm_read_realtime') as read_triggers,
  (select count(*) from pg_trigger where tgname = 'wt_dm_typing_realtime') as typing_triggers,
  (select count(*) from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'wt_dm_realtime_own_topic') as topic_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'realtime' and p.proname = 'send') as realtime_send;

comment on view public.wt_realtime_health is
  'يجب أن تكون القيم كلها 1 (أو أكثر) بعد تنفيذ 10-dm-realtime.sql';

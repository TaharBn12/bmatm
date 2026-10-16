-- =====================================================================
-- WatchTogether — (06) تنظيف دوري اختياري (cleanup-cron.sql)
--
-- متى تستعمله؟
--   إن أردت تنظيفاً تلقائياً: إزالة الحضور القديم والرسائل الأقدم من 7 أيام،
--   وتقليص جدول الغرف المهجورة. **اختياري تماماً** — الموقع يعمل بلا هذا الملف.
--
-- يحتاج امتداد pg_cron (متوفّر في Supabase: Database → Extensions → pg_cron).
-- آمن للتكرار: كل مهمة تُنشأ مرة واحدة باسمها ثم تُحدَّث.
--
-- كيف تنفّذه؟
--   Supabase Dashboard → SQL Editor → New query → الصق كل ما هنا → Run.
-- =====================================================================

create extension if not exists pg_cron;

-- أزل المهام القديمة بنفس الأسماء (لو كنت نفّذت الملف سابقاً)
do $$
begin
  begin perform cron.unschedule('wt-cleanup-presence'); exception when others then null; end;
  begin perform cron.unschedule('wt-cleanup-messages'); exception when others then null; end;
  begin perform cron.unschedule('wt-cleanup-rooms');    exception when others then null; end;
end
$$;

-- 1) الحضور: من لم يظهر خلال 30 ثانية يُعدّ خارجاً
select cron.schedule('wt-cleanup-presence', '* * * * *', $cron$
  delete from public.presence where last_seen < now() - interval '30 seconds';
$cron$);

-- 2) الرسائل: احتفظ بآخر 7 أيام فقط
select cron.schedule('wt-cleanup-messages', '17 * * * *', $cron$
  delete from public.messages where created_at < now() - interval '7 days';
$cron$);

-- 3) الغرف المهجورة: لم تُحدَّث خلال 7 أيام
select cron.schedule('wt-cleanup-rooms', '23 3 * * *', $cron$
  delete from public.rooms where updated_at < now() - interval '7 days';
$cron$);

-- اعرض المهام المُجدولة (المطلوب ثلاثة أسطر تبدأ بـ wt-cleanup)
select jobid, schedule, jobname, active
  from cron.job
 where jobname like 'wt-cleanup%'
 order by jobname;

-- لإيقاف التنظيف لاحقاً:
--   select cron.unschedule('wt-cleanup-messages');

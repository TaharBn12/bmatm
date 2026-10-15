-- =====================================================================
--  WatchTogether — ترقية قاعدة قائمة (migration.sql)
--  نفّذه فقط إن كنت أنشأت الجداول من نسخة أقدم، وتريد إضافة:
--    • ربط الرسائل بحساب المستخدم (user_id)
--    • نوع الرسالة "react" للتفاعلات
--    • فهرس أسرع لاسترجاع آخر رسائل الغرفة
--  الملف آمن لإعادة التشغيل.
-- =====================================================================

--  أهم سطر في هذا الملف: دونه لا تصل أحداث UPDATE المفلترة عبر Realtime،
--  فيبدو وكأن الأصدقاء لا يدخلون نفس الغرفة (نفّذه حتى لو كنت نفّذت schema.sql)
alter table public.rooms    replica identity full;
alter table public.messages replica identity full;

alter table public.messages add column if not exists user_id   uuid;
alter table public.messages add column if not exists client_id text;
alter table public.messages add column if not exists kind      text not null default 'chat';
alter table public.rooms    add column if not exists updated_at timestamptz not null default now();

create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- تفعيل تسجيل الدخول بالبريد وكلمة المرور (اختياري لكن مطلوب لصفحة auth.html):
--   Dashboard → Authentication → Providers → Email → Enable "Email"
--   ولتخطّي رسالة تأكيد البريد أثناء التطوير: أطفئ "Confirm email"

-- تحقّق:
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'messages' order by ordinal_position;

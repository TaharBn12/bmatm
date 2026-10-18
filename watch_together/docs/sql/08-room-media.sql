-- =====================================================================
-- WatchTogether — 08) وسائط الغرفة (صور وفيديو)
-- ---------------------------------------------------------------------
-- ما الذي يفعله هذا الملف:
--   1) يضيف أعمدة رابط الوسائط إلى جدول الرسائل (media_url/media_type/
--      media_meta) فيحفظ رابط الملف الذي أعادته مواقع التخزين المجانية.
--   2) ينشئ دلو تخزين عاماً «wt-room-media» في Supabase Storage مع حدود
--      للحجم وأنواع الملفات، وسياسات كتابة/قراءة آمنة.
--   3) يحدّث كاش PostgREST ليعمل العميل فوراً.
--
-- أمانته: لا يحذف أي رسالة ولا يغيّر جدولاً آخر، ويمكن تكراره بلا أثر.
-- ملاحظة: الوسائط تُعرض داخل الدردشة من الرابط، وروابط الوسائط عامة
--           (مثل أي رابط صورة على الإنترنت) — يمكن حذفها يدوياً من لوحة
--           Supabase أو عبر مهمة تنظيف دورية.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) أعمدة رابط الوسائط في جدول الرسائل
-- ---------------------------------------------------------------------
alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text;
alter table public.messages add column if not exists media_meta jsonb;

create index if not exists messages_media_idx on public.messages (room_id, created_at desc)
  where media_url is not null;

-- ---------------------------------------------------------------------
-- 2) دلو التخزين المجاني (Supabase Storage — الخطط المجانية تشمل مساحة)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wt-room-media', 'wt-room-media', true, 104857600,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg', 'video/3gpp'
  ]
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 3) سياسات الكتابة والقراءة
--    المسار: rooms/<كود الغرفة>/<وقت>-<رمز>.<امتداد>
--    لا يُقبل إلا هذا النمط، والحدود (الحجم والنوع) يفرضها الدلو.
-- ---------------------------------------------------------------------
drop policy if exists wt_room_media_insert on storage.objects;
create policy wt_room_media_insert on storage.objects for insert to anon, authenticated with check (
  bucket_id = 'wt-room-media'
  and (storage.foldername(name))[1] = 'rooms'
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9]{1,12}$'
  and (storage.foldername(name))[3] ~ '^[0-9]{10,16}-[a-f0-9]{8,64}\.(jpg|jpeg|png|webp|gif|avif|bmp|mp4|webm|mov|m4v|mkv|ogv|3gp)$'
);

drop policy if exists wt_room_media_read on storage.objects;
create policy wt_room_media_read on storage.objects for select to anon, authenticated using (
  bucket_id = 'wt-room-media'
);

-- ---------------------------------------------------------------------
-- 4) تحديث كاش PostgREST حتى يقبل الجدول الأعمدة الجديدة فوراً
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';
commit;

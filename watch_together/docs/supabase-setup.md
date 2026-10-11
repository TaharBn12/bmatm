# 🗄️ إعداد Supabase خطوة بخطوة

هذا الدليل لتشغيل المزامنة والدردشة على **استضافة عادية** (cPanel / Netlify / GitHub Pages / Vercel)
حيث لا يوجد خادم Java — عندها يقوم Supabase بدور الخادم (تخزين + بث مباشر).

---

## 1) أنشئ مشروعاً (أو استخدم مشروعك الحالي)

- سجّل الدخول في <https://supabase.com> → **New project**.
- المشروع المستخدم في `assets/js/config.js` حالياً:
  - **URL:** `https://cazwkhcbkzhnsluuafwz.supabase.co`
  - **anon key:** موجودة داخل الملف (هي مفتاح عام مصمّم للعمل من المتصفح).
- إن أردت استخدام مشروعك أنت: **Project Settings → API** وانسخ `Project URL` و `anon public key`
  ثم ضعها في `assets/js/config.js`:

```js
supabase: {
  url: 'https://xxxxxxxx.supabase.co',
  anonKey: 'eyJhbGci...',
  ready: true
},
```

> 🔐 **لا تستخدم `service_role key` في هذا الملف أبداً** — هو مفتاح سرّي يخترق كل الصلاحيات.

---

## 2) نفّذ مخطط قاعدة البيانات

1. من القائمة الجانبية: **SQL Editor** → **New query**.
2. افتح ملف [`schema.sql`](schema.sql) وانسخ محتواه كاملاً.
3. الصقه في المحرر → **Run** (أو `Ctrl+Enter`).

سينشئ الملف:

| الجدول | الوظيفة |
|--------|---------|
| `rooms` | الغرفة + `state` (jsonb) الذي يحمل حالة المزامنة كاملة |
| `messages` | رسائل الدردشة مع فهرس على `(room_id, created_at desc)` |
| `presence` | من متصل الآن (اسم + مضيف؟ + آخر ظهور) |

وأيضاً:
- يضيف الجدولين إلى `supabase_realtime` (بدون هذا **لا يصل البث المباشر**).
- يفعّل **RLS** مع سياسات تسمح للزائر المجهول (`anon`) بالقراءة والكتابة — لأن الموقع
  يطلب الاسم فقط ولا يوجد تسجيل دخول.
- يمنح الصلاحيات اللازمة لدور `anon`.

> ℹ️ **لا تنشئ أي جدول داخل مخطط `realtime`** — جدول `realtime.messages` موجود تلقائياً
> في كل مشروع، وإنشاؤه يدوياً يعطي الخطأ
> `42501: permission denied for schema realtime`.
> (النسخة الحالية من `schema.sql` لا تحتوي هذا المقطع إطلاقاً — إن كان لديك نسخة قديمة فحدّثها.)

---

## 3) تحقّق أن كل شيء جاهز

في **Table Editor** يجب أن ترى الجداول الثلاثة. وللتحقق من السياسات:

```sql
select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public';
```

يجب أن ترى `rooms_all_anon` و `messages_all_anon` و `presence_all_anon`.

وللتحقق من Realtime:

```sql
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public';
```

يجب أن ترى `rooms` و `messages`. إن لم تَرهما:

```sql
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.messages;
```

أو من **Dashboard → Database → Replication → supabase_realtime** وفعّل الجدولين.

وللتأكد أن جدول البث موجود في مشروعك (لا تنشئه — فقط تحقق):

```sql
select exists (
  select 1 from information_schema.tables
  where table_schema = 'realtime' and table_name = 'messages'
) as realtime_messages_exists;   -- يجب أن تكون true
```

---

## 4) افتح الموقع وتحقّق من الشارة

- افتح `index.html` على نطاقك → الشارة أعلى الصفحة يجب أن تقول:
  - ✅ **«Supabase متصل ✓»** → كل شيء يعمل.
  - ⚠️ **«أنشئ الجداول من docs/schema.sql»** → لم تنفّذ الخطوة 2 بعد.
  - ⚠️ **«فعّل صلاحيات RLS»** → السياسات ناقصة، أعد تنفيذ `schema.sql`.

---

## 5) التنظيف التلقائي (اختياري لكن مستحسن)

حتى لا تتراكم الرسائل والحضور المنتهي:

1. **Database → Extensions** → ابحث عن `pg_cron` → **Enable**.
2. في SQL Editor نفّذ:

```sql
select cron.schedule('wt-cleanup', '*/10 * * * *', $$
  delete from public.presence where last_seen < now() - interval '30 seconds';
  delete from public.messages where created_at < now() - interval '7 days';
  delete from public.rooms    where updated_at < now() - interval '30 days';
$$);
```

---

## 6) كيف تعمل المزامنة تقنياً؟

```
 المضيف (يتحكم بالفيديو)                     الضيوف
        │                                      ▲
        │ POST /rest/v1/rooms (upsert state)   │
        ▼                                      │
   ┌──────────┐   postgres_changes (Realtime)  │
   │ Supabase │ ───────────────────────────────┘
   └──────────┘   رسائل الدردشة: INSERT على messages
```

- **حالة المزامنة** تُكتب في `rooms.state` (upsert بمفتاح `room_id`)، وأي تعديل يصل
  لجميع المشتركين في القناة عبر `postgres_changes` على جدول `rooms`.
- **الدردشة**: `INSERT` في `messages` → يصل للجميع فوراً. الموقع يعرض رسالتك محلياً
  ثم يتجاهل نسختك عندما ترجع من Realtime (منع التكرار).
- **الرقم التسلسلي `seq`** داخل الحالة يمنع تطبيق تحديث قديم وصل متأخراً.
- **الحضور**: `upsert` في `presence` كل 3 ثوانٍ + حذف الصف عند المغادرة، وأي مشارك
  لم يظهر منذ 12 ثانية يُحذف من القائمة.

---

## 7) حل المشاكل الشائعة

| المشكلة | السبب | الحل |
|---------|-------|------|
| الشارة «وضع محلي» | فشل الاتصال بـ Supabase | تحقّق من `url` و `anonKey`، ومن أن الموقع يعمل بـ **https** |
| الرسائل لا تصل | الجدول غير مضاف لـ Realtime | أعد تنفيذ قسم Realtime في `schema.sql` |
| `42501 permission denied for schema realtime` | نسخة قديمة من `schema.sql` تحاول إنشاء `realtime.messages` | حدّث الملف من المستودع وأعد التنفيذ — الجدول موجود تلقائياً |
| `42501 permission denied` (على `public`) | سياسات RLS أو الصلاحيات ناقصة | أعد تنفيذ `schema.sql` كاملاً |
| `42P01 relation does not exist` | الجداول غير منشأة | نفّذ `schema.sql` |
| الحالة تتأخر | اتصال ضعيف | قلّل `heartbeatMs` في `config.js` إلى 2500 |

---

## 8) هل أحتاج Supabase أصلاً؟

لا، إذا:
- شغّلت الموقع عبر **`java-server/`** (الوضع الأول في الترتيب) → المزامنة داخل السيرفر.
- أو كنت تجرّب محلياً فقط → **الوضع المحلي** يعمل بدون أي إعداد.

وجود Supabase مهم عندما ترفع الملفات على **استضافة ثابتة** (لا تشغّل Java)،
أو عندما تريد حفظ الرسائل وسجل الغرف حتى بعد إيقاف السيرفر.

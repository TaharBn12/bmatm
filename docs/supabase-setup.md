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
2. افتح ملف [`02-schema.sql`](02-schema.sql) أو [`01-bootstrap.sql`](01-bootstrap.sql). كلاهما يهيّئ المخطط الآمن نفسه، ويمكن إعادة تشغيله لترقية مشروع قائم.
3. الصقه في المحرر → **Run** (أو `Ctrl+Enter`).

> 🛠️ **أسرع طريقة:** `node tools/sbctl.mjs create …` ينشئ المشروع وينفّذ المخطط
> ويربطه بالموقع في أمر واحد — راجع [`new-supabase-server.md`](new-supabase-server.md).
>
> 🔎 **للتأكد بعد التنفيذ:** `node tools/sbctl.mjs doctor` يفحص الجداول والسياسات
> وRealtime ويطبع النتيجة.

يهيّئ الملف الجداول العامة التالية:

| الجدول | الوظيفة والصلاحيات |
|--------|--------------------|
| `rooms` | الحالة المركزية `state`؛ قراءة عامة، والتغيير عبر RPC يتحقق من الدور |
| `messages` | رسائل الدردشة؛ قراءة وإضافة للضيوف. نصّ الرسالة في العمود `body` (المشاريع القديمة قد تستخدم `text` — انظر `04-repair-messages.sql`) |
| `presence` | حضور تقريبي (اسم وآخر ظهور) للتوافق مع الواجهة |
| `room_members` | أسماء المشاركين وأدوارهم؛ القراءة فقط من العميل |
| `room_queue` | قائمة التشغيل المشتركة؛ القراءة فقط، والتعديل عبر RPC |

وتُحفظ مفاتيح المنشئ والأعضاء في جداول خاصة داخل مخطط `wt_private`، غير مكشوف عبر PostgREST.
تتحقق `wt_create_room` و`wt_join_room` و`wt_apply_room_state` وRPCs الأدوار والقائمة من المفتاح والدور.
كما يفعّل المخطط RLS ويضيف الجداول اللازمة إلى `supabase_realtime`؛ ويظل استطلاع REST شبكة أمان عند تعطل Realtime.

> ℹ️ **لا تنشئ أي جدول داخل مخطط `realtime`** — جدول `realtime.messages` موجود تلقائياً
> في كل مشروع. المخطط يضيف جداول التطبيق نفسها إلى المنشور، ولا ينشئ جداول داخل مخطط Realtime.

---

## 2ب) تفعيل تسجيل الدخول (لصفحة `auth.html`)

صفحة إنشاء الحساب/تسجيل الدخول تستخدم **Supabase Auth**:

1. **Authentication → Providers → Email** → اجعله **Enabled**.
2. للتجربة بدون رسائل تأكيد: أطفئ **Confirm email**
   (وإلا سيُطلب من المستخدم تأكيد بريده قبل أول دخول — والموقع يعرض له رسالة واضحة).
3. لا حاجة لأي جدول إضافي: الاسم يُحفظ في `auth.users → user_metadata.full_name`،
   والعمود `messages.user_id` يربط الرسائل بالحساب (اختياري). دور المنشئ يُثبت بمفتاح الغرفة الخاص، سواء دخل بحساب أو كضيف.

> إن أردت الموقع **بالاسم فقط بدون حسابات**: اجعل في `assets/js/config.js`
> ```js
> auth: { required: false, allowGuest: true }
> ```
> عندها تعمل نافذة «أدخل اسمك» في الغرفة كما هي، وصفحة `auth.html` تبقى متاحة اختيارياً.

### ترقية قاعدة قائمة
إن كنت تملك قاعدة أقدم، نفّذ [`03-migration.sql`](03-migration.sql) أو `02-schema.sql` كاملاً؛ المخطط آمن للتكرار وينقل أسرار النسخ التجريبية إلى `wt_private` إن وجدت، ولا يحذف بيانات الغرف والرسائل.

---

## 3) تحقّق أن كل شيء جاهز

في **Table Editor** يجب أن ترى الجداول الخمسة. وللتحقق من السياسات:

```sql
select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public';
```

يجب أن ترى سياسات القراءة للغرف والأعضاء والقائمة، وسياسات الرسائل والحضور. لا ينبغي وجود سياسة تسمح للعميل بتحديث `rooms` أو كتابة أدوار الأعضاء مباشرة.

وللتحقق من Realtime:

```sql
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public';
```

يجب أن ترى `rooms` و `messages` و `room_members` و `room_queue` (و`presence`). إن لم تَرهما:

```sql
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.room_members;
alter publication supabase_realtime add table public.room_queue;
alter publication supabase_realtime add table public.presence;
```

أو من **Dashboard → Database → Replication → supabase_realtime** وفعّل الجداول المذكورة.

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
  - ⚠️ **«أنشئ الجداول من docs/sql/02-schema.sql»** → لم تنفّذ الخطوة 2 بعد.
  - ⚠️ **«فعّل صلاحيات RLS»** → السياسات ناقصة، أعد تنفيذ `02-schema.sql`.

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
 المنشئ/المنظّم (مفتاح عضو)                 المشاهدون
        │                                      ▲
        │ RPC wt_apply_room_state (تحقق + ترقيم)│
        ▼                                      │
   ┌──────────┐   postgres_changes + REST poll │
   │ Supabase │ ───────────────────────────────┘
   └──────────┘   الدردشة: INSERT على messages
```

- **حالة المزامنة** تُكتب إلى `rooms.state` عبر RPC بعد التحقق من مالك/منظّم العضو، والخادم هو من يرقّم `rev` ويثبت وقت التحديث. تصل الحالة عبر Realtime أو الاستطلاع الاحتياطي.
- **الدردشة**: `INSERT` في `messages` → يصل للجميع عبر Realtime/الاستطلاع. الموقع يعرض رسالتك محلياً ثم يتجاهل نسختك عند عودتها (منع التكرار).
- **الرقم التسلسلي `seq`** داخل الحالة يمنع تطبيق تحديث قديم وصل متأخراً.
- **الحضور**: `upsert` في `presence` كل 3 ثوانٍ + حذف الصف عند المغادرة، وأي مشارك
  لم يظهر منذ 12 ثانية يُحذف من القائمة.

---

## 7) حل المشاكل الشائعة

| المشكلة | السبب | الحل |
|---------|-------|------|
| الشارة «وضع محلي» | فشل الاتصال بـ Supabase | تحقّق من `url` و `anonKey`، ومن أن الموقع يعمل بـ **https** |
| الرسائل لا تصل | الجدول غير مضاف لـ Realtime | أعد تنفيذ قسم Realtime في `02-schema.sql` |
| `42501 permission denied for schema realtime` | نسخة قديمة من `02-schema.sql` تحاول إنشاء `realtime.messages` | حدّث الملف من المستودع وأعد التنفيذ — الجدول موجود تلقائياً |
| `42501 permission denied` | قد يكون مخططاً أو RLS قديماً، أو أن مفتاح العضو غير صحيح | أعد تنفيذ `02-schema.sql`؛ رابط الغرفة يتيح المشاهدة ولا يمنح التحكم |
| `42P01 relation does not exist` | الجداول غير منشأة | نفّذ `02-schema.sql` |
| الحالة تتأخر | اتصال ضعيف | قلّل `heartbeatMs` في `config.js` إلى 2500 |

---

## 7ب) أخطاء «تعذّر الاتصال» الشائعة — تشخيص سريع

| الرسالة التي تظهر في الغرفة | السبب الحقيقي | الحل |
|------------------------------|---------------|------|
| «جداول قاعدة البيانات غير موجودة» (42P01) | لم يُنفَّذ المخطط | نفّذ `docs/sql/01-bootstrap.sql` |
| «صلاحيات RLS ناقصة» (42501) | سياسات ناقصة | أعد تنفيذ المخطط كاملاً |
| «مفتاح anon غير صالح» (401) | مفتاح مقلَّم | `node tools/sbctl.mjs set --url … --key …` |
| «مشروع Supabase متوقف» (5xx) | مشروع مجاني خامل | Dashboard → Resume، أو أنشئ مشروعاً جديداً |
| «لا يوجد اتصال بمشروع Supabase» | شبكة/بروكسي/بلا https | تأكد من الإنترنت وأن الموقع على https |
| «الدردشة معطّلة… المزامنة تعمل» | جدول `messages` ناقص فقط | نفّذ المخطط — المزامنة ليست معطّلة |
| `Could not find the 'body' column of 'messages' in the schema cache` (PGRST204) | جدول `messages` قديم (العمود `text`/`message` بدل `body`) و`create table if not exists` لا يعدّله | نفّذ [`04-repair-messages.sql`](04-repair-messages.sql) ثم `notify pgrst, 'reload schema';` — منذ 2.5.0 العميل يتكيّف مؤقتاً ويكتب في العمود الفعلي |

زر **«تشخيص»** في شريط الغرفة يعرض هذه القائمة عملياً مع الحلّ لكل حالة.

---

## 8) هل أحتاج Supabase أصلاً؟

لا، إذا:
- شغّلت الموقع عبر **`java-server/`** (الوضع الأول في الترتيب) → المزامنة داخل السيرفر.
- أو كنت تجرّب محلياً فقط → **الوضع المحلي** يعمل بدون أي إعداد.

وجود Supabase مهم عندما ترفع الملفات على **استضافة ثابتة** (لا تشغّل Java)،
أو عندما تريد حفظ الرسائل وسجل الغرف حتى بعد إيقاف السيرفر.

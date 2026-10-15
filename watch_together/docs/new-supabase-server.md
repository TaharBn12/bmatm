# 🚀 سيرفر جديد على Supabase — خطوة بخطوة

هذا الدليل يشرح كيف تنشئ **سيرفر Supabase جديداً** لمشروع WatchTogether
وتربطه بالموقع، وكيف تتحقق أن الغرفة تعمل فعلاً (دخول صديق + مزامنة + دردشة).

> 🎯 **لماذا سيرفر جديد؟** لأن Supabase يوقف المشاريع المجانية بعد فترة خمول،
> ولأن المشاريع القديمة قد تكون بُنيت بنسخة قديمة من `schema.sql` (بدون `messages.kind`
> أو بدون Realtime). السيرفر الجديد = بداية نظيفة ومضمونة.

---

## ⚡ المسار الأسرع (أمر واحد)

إن كان عندك **رمز وصول (Access Token)** من Supabase، الأمر الواحد ينفّذ كل شيء:
ينشئ المشروع، ينفّذ المخطط، جلب المفتاح، وربطه بالموقع.

```bash
cd watch_together

# 1) أنشئ رمز وصول:
#    supabase.com → Account (أو Settings) → Access Tokens → Generate New Token
export SUPABASE_ACCESS_TOKEN="sbp_..."

# 2) أنشئ السيرفر الجديد واربطه:
node tools/sbctl.mjs create \
  --name "watchtogether-new" \
  --org-id "<ORGANIZATION_ID>" \
  --db-password "<كلمة مرور قوية لقاعدة البيانات>" \
  --region "eu-central-1"

# 3) تأكّد أن كل شيء سليم:
node tools/sbctl.mjs doctor
```

الأمر ينفّذ هذه الخطوات تلقائياً:

| # | الخطوة | ما تفعله الأداة |
|---|--------|------------------|
| 1 | إنشاء مشروع جديد | `POST api.supabase.com/v1/projects` |
| 2 | انتظار جهوزية القاعدة | استطلاع حالة المشروع حتى `ACTIVE` |
| 3 | تنفيذ المخطط | `docs/bootstrap.sql` كاملاً (جداول + RLS + Realtime) |
| 4 | جلب المفتاح | `anon public key` من `/api-keys` |
| 5 | ربط الموقع | كتابة `assets/js/config.js` + رفع رقم الكاش `?v=` |
| 6 | فحص نهائي | REST + الجداول + Realtime + كتابة/قراءة وحذف |

> 🔐 رمز الوصول يُقرأ من متغيّر البيئة `SUPABASE_ACCESS_TOKEN` فقط —
> لا يُكتب في الملفات ولا يُرفع إلى Git.

**تجربة قبل التنفيذ (بدون أي تغيير):**

```bash
node tools/sbctl.mjs create --name wt-test --org-id 000 --db-password x --dry-run
```

---

## 🧭 المسار اليدوي (من لوحة Supabase)

إن لم تردّ على استخدام رمز الوصول، اتبع هذه الخطوات — 5 دقائق:

### 1) أنشئ المشروع

1. افتح <https://supabase.com/dashboard> وسجّل الدخول.
2. **New project** → الاسم: `watchtogether` (أي اسم) → كلمة مرور قاعدة البيانات (احفظها!).
3. المنطقة (Region): اختر الأقرب لزوّارك — `eu-central-1` لأوروبا/الجزائر، أو `us-east-1`.
4. انتظر حتى تصبح الحالة **Active**.

### 2) نفّذ مخطط القاعدة

1. من القائمة الجانبية: **SQL Editor** → **New query**.
2. افتح [`bootstrap.sql`](bootstrap.sql) وانسخه كاملاً.
3. الصق → **Run**.

النتيجة المطلوبة في آخر الاستعلام:

```
rooms | messages | presence | room_members | room_queue | realtime_tables | policies
   0  |         0 |        0 |            0 |          0 |              5 |        5
```

`realtime_tables` يتضمن الجداول الخمسة العامة التي يهيئها المخطط.

### 3) فعّل تسجيل الدخول (اختياري — لصفحة `auth.html`)

**Authentication → Providers → Email** → **Enabled**.
للتجربة السريعة بدون بريد تأكيد: أطفئ **Confirm email**.

### 4) انسخ بيانات المشروع

**Project Settings → API**:
- **Project URL** → `https://xxxxxxxx.supabase.co`
- **anon public key** → `eyJhbGci...`

> ⚠️ لا تنسخ `service_role` key أبداً — هو مفتاح سرّي يخترق كل الصلاحيات.

### 5) اربطها بالموقع

```bash
cd watch_together
node tools/sbctl.mjs set --url "https://xxxxxxxx.supabase.co" --key "eyJhbGci..."
```

أو يدوياً في [`assets/js/config.js`](../assets/js/config.js):

```js
supabase: {
  url: 'https://xxxxxxxx.supabase.co',
  anonKey: 'eyJhbGci...',
  ready: true,
  auth: true
},
```

> 🧹 `sbctl set` يرفع أيضاً رقم الكاش `?v=` في `index.html` و `room.html` و `auth.html`
> حتى لا يعرض المتصفح النسخة القديمة من `config.js` (سبب شائع لـ «التغييرات لم تظهر»).

### 6) تحقّق

```bash
node tools/sbctl.mjs doctor
```

المتوقّع:

```
  ✓ REST يستجيب (240ms)
  ✓ جدول rooms موجود
  ✓ جدول messages موجود
  ✓ جدول presence موجود
  ✓ Realtime يعمل (180ms)
  ✓ الكتابة والقراءة في القاعدة تعملان ✓
  النتيجة: المشروع صالح ✓
```

---

## 🔎 تشخيص من داخل الغرفة

زر **«تشخيص»** في شريط الغرفة العلوي يفحص المشروع **من متصفح المستخدم** ويعرض:

- هل REST يستجيب وكم استغرق؟ (مللي ثانية)
- هل الجداول المطلوبة (`rooms`, `messages`, `presence`, `room_members`, `room_queue`) موجودة؟
- هل Realtime يقبل الانضمام؟
- ما **السبب الدقيق** لأي خطأ + **الحل** (بلقطة واحدة).
- زر **«إعادة الاتصال»** + **«نسخ التقرير»** (ترسله لصديقك أو للمطوّر).

نفس الفحص يعمل من الطرفية:

```bash
node tools/sbctl.mjs doctor                    # المشروع المهيّأ
node tools/sbctl.mjs doctor --url <URL> --key <KEY>   # مشروع آخر
node tools/sbctl.mjs doctor --json             # مخرجات JSON للأتمتة
```

---

## 🧪 اختبار حي (ينشئ غرفة ويكتب ويقرأ ويحذف)

```bash
node tools/sbctl.mjs smoke
```

يُنشئ غرفة باسم عشوائي، يكتب فيها حالة مزامنة، يقرأها، يجرّب رسالة دردشة، ثم يحذف كل شيء.
ممتاز للتأكد أن المشروع الجديد سليم **قبل** رفع الملفات على الاستضافة.

---

## 🔄 الرجوع إلى السيرفر القديم (لو صار خطأ)

الإعدادات القديمة محفوظة في Git — استرجعها بأمر واحد:

```bash
git diff assets/js/config.js     # شوف التغيير
git checkout assets/js/config.js # ارجع القديم
```

أو شغّل `sbctl set` بالعنوان القديم:

```bash
node tools/sbctl.mjs set --url "https://cazwkhcbkzhnsluuafwz.supabase.co" --key "<anon key القديم>"
```

---

## ❓ أخطاء شائعة وحلولها

| ما تراه | السبب | الحل |
|---------|-------|-----|
| `✗ REST لا يستجيب — لا يوجد اتصال` | حجب/بروكسي/بلا https | تأكد أن الموقع يعمل على **https**، وأن جهازك متصل بالإنترنت |
| `✗ جدول rooms مفقود` | لم يُنفَّذ `bootstrap.sql` | SQL Editor → الصق `docs/bootstrap.sql` → Run |
| `✗ صلاحيات RLS ناقصة` | نُسخة قديمة من المخطط | أعد تنفيذ `bootstrap.sql` كاملاً |
| `✗ مفتاح anon غير صالح` | مفتاح مقلَّم/مستبدَل | انسخ `anon public key` من Project Settings → API، ثم `sbctl set` |
| `! Realtime لا يعمل` | الجداول غير مربوطة بالمنشور | أعد تنفيذ `bootstrap.sql`، أو أضف `rooms`, `messages`, `room_members`, `room_queue`, `presence` إلى `supabase_realtime` |
| `✗ المشروع متوقف` | مشروع مجاني خامل | Dashboard → Project Settings → **Resume**، أو أنشئ مشروعاً جديداً |
| `الدردشة لا تعمل` لكن الفيديو متزامن | جدول `messages` مفقود | نفّذ `bootstrap.sql` |
| الأصدقاء لا يدخلون نفس الغرفة | كود مختلف أو الرابط القديم | انسخ «رابط الدعوة» من الغرفة (يحمل الكود + رابط الفيديو) |

---

## 🔐 ملاحظات أمنية

- `config.js` يحتوي **مفتاح anon عام** — هذا مقصود (يُقرأ من المتصفح).
- لا تضع `service_role key` في أي ملف داخل المستودع.
- القراءة العامة مخصصة للغرف والأدوار والقائمة؛ كتابة حالة المشاهدة وإدارة الأدوار تمر عبر RPC تتحقق من المفتاح الخاص. الرسائل والحضور يسمحان للضيوف بالإضافة وفق RLS.
- لا يخرج مفتاح المنشئ من المتصفح ولا يدخل في رابط الدعوة؛ من يحصل على رابط الغرفة يدخل كمشاهد فقط.
- رمز الوصول (`SUPABASE_ACCESS_TOKEN`) يُقرأ من متغيّر البيئة فقط.

---

## 📚 روابط مفيدة

- [مخطط القاعدة (bootstrap.sql)](bootstrap.sql) — انسخه إلى SQL Editor
- [المخطط القديم (schema.sql)](schema.sql) — نفس المحتوى تقريباً (للمشاريع القائمة)
- [دليل Supabase الكامل](supabase-setup.md) — الشرح المفصّل لكل خطوة
- [دليل النشر](deployment.md) — رفع الملفات على الاستضافة
- [دليل حل المشاكل](troubleshooting.md) — «رفعت الملفات ولم تظهر التغييرات»

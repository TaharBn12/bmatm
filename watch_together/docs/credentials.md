# 🔐 خريطة المفاتيح — من أين تجيبها، وأين تضعها بالضبط

> **القاعدة الواحدة التي تحلّ 90% من الأخطاء:**
> كل ما يدخل `assets/js/config.js` **يقرأه أي زائر**. لذلك فيه مفاتيح **عامة** فقط.
> وكل مفتاح **سري** (secret / service_role / API key لخدمة مدفوعة) يعيش في
> **متغيّرات بيئة على خادم** (Supabase Secrets / Cloudflare Secrets / cPanel)،
> ولا يمرّ أبداً عبر المتصفح ولا GitHub.

---

## 0) قبل أن تبدأ: صنّف المفتاح

| النوع | أمثلة | أين يعيش | يظهر للمتصفح؟ |
|------|-------|----------|----------------|
| **عام (public)** | `supabase.url` · `supabase.anonKey` · مفتاح البوابة العام `pk_…` | `assets/js/config.js` | ✅ نعم، وهذا طبيعي |
| **سري (secret)** | `service_role` · `sk_…` / `sk_secret_…` · TURN API key · webhook signing secret | Secrets على الخادم فقط | ❌ **إطلاقاً** |
| **بيانات دخول** | كلمة مرور قاعدة البيانات · `JWT secret` · مفتاح SSH | لوحة المزوّد فقط، لا تُنسخ لأي ملف | ❌ **إطلاقاً** |

**كيف تعرف أن المفتاح سري؟** اسمه أو وصفه يقول `secret` / `service_role` / `private`،
أو أن اللوحة تُظهره مرة واحدة عند الإنشاء وتقول «لن تراه مرة أخرى».
وسّع أي مفتاح سرّي ظهر في صورة أو محادثة أو commit = **اعتبره مسروقاً وبدّله**.

---

## 1) Supabase — ما يحتاجه الموقع فعلاً

### أ) من أين تجيبه
1. افتح <https://supabase.com/dashboard> واختر مشروعك.
2. **Project Settings** (⚙️ أسفل القائمة) ← **API** (أو **API Keys** في اللوحة الجديدة).
3. انسخ قيمتين فقط:
   - **Project URL** — مثل `https://abcdefghijkl.supabase.co`
   - **anon / public** — سلسلة طويلة تبدأ بـ`eyJ…` (JWT) أو `sb_publishable_…`

### ب) أين تضعه — الطريقة الآمنة (أمر واحد)

```bash
cd watch_together
node tools/sbctl.mjs set --url "https://abcdefghijkl.supabase.co" --key "eyJhbGciOi..."
```

هذا الأمر:
- يكتب القيمتين داخل `assets/js/config.js` في المكان الصحيح،
- يجعل `ready: true`،
- **يرفع أرقام `?v=`** في كل الصفحات تلقائياً حتى لا يبقى المتصفح على نسخة قديمة.

ثم افحص:

```bash
node tools/sbctl.mjs doctor     # REST + الجداول + Realtime + كتابة/قراءة
node tools/sbctl.mjs smoke      # اختبار حي: ينشئ غرفة ويكتب ويقرأ ويحذف
```

### ج) أو يدوياً (إن أردت)

افتح `assets/js/config.js` وعدّل هذين السطرين فقط:

```js
supabase: {
  url: 'https://abcdefghijkl.supabase.co',
  anonKey: 'eyJhbGciOi...',
  ready: true,
  auth: true
}
```

ثم ارفع `?v=` في الصفحات أو غيّر `build` في أعلى الملف (ومعه `sw.js`).

### د) كيف تتأكّد أنك لم تخلط بين `anon` و`service_role`؟

الصق المفتاح في هذا الأمر — يطبع دوره:

```bash
node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url')).role)" "eyJhbGciOi..."
```

- الناتج **`anon`** ✅ هذا هو الصحيح.
- الناتج **`service_role`** ❌ **اخطر خطأ ممكن**: يتجاوز كل سياسات الأمان. لا تضعه في `config.js` أبداً وأبدله فوراً من اللوحة.

> ملاحظة مهمة: مفتاح `anon` **ليس سرّاً** — يظهر في كل موقع يستخدم Supabase.
> الحماية الحقيقية هي **RLS + RPC** التي نفّذتها في ملفات `docs/sql`. لا تحاول «إخفاءه»، بل لا تمنحه صلاحيات زائدة.

### هـ) ما **لا** تحتاجه من Supabase
| القيمة | لماذا لا |
|--------|-----------|
| `service_role` key | يتجاوز RLS؛ المتصفح لا يستخدمه إطلاقاً |
| كلمة مرور قاعدة البيانات | للاتصال المباشر فقط (أدوات/CLI) |
| `JWT secret` | لتوقيع الرموز؛ لا يخرج من اللوحة |
| Connection string / Port 5432 | لا يستخدمه الموقع |

---

## 2) قاعدة البيانات — «بيانات» لا مفاتيح

كل ما يخصّ الجداول يُنفَّذ كـ**SQL** في: Dashboard ← **SQL Editor** ← New query ← لصق ← Run.
الترتيب الإلزامي (كلها idempotent إلا 00):

```
01-bootstrap.sql → 07-social.sql → 09-calls.sql → 10-dm-realtime.sql → 11-dm-reactions.sql → 12-dm-thread-prefs.sql
```

بعدها افحص:

```sql
select * from public.wt_realtime_health;
```

---

## 3) TURN (المكالمات خارج الواي فاي) — المفتاح سرّي

### أ) من أين تجيبه
1. سجّل في <https://dashboard.metered.ca/signup> (خطة Free: 20 غ.ب/شهر).
2. **TURN Server** (أو *Open Relay*).
3. انسخ **اسم التطبيق** (`<appname>` من رابط `https://<appname>.metered.live`) و**TURN API key** (زرّ *Generate API Key*).

### ب) أين تضعه — على خادم، لا في `config.js`

اختر خادماً واحداً:

**Supabase Edge Function**
```bash
supabase secrets set METERED_APP=yourapp METERED_KEY=xxxxxxxx ALLOWED_ORIGIN=https://your-site.com
supabase functions deploy turn --no-verify-jwt
```

**Cloudflare Worker**
```bash
wrangler secret put METERED_APP
wrangler secret put METERED_KEY
wrangler secret put ALLOWED_ORIGIN
wrangler deploy
```

**PHP / cPanel** — ضع المتغيّرات في *MultiPHP INI* أو `.htaccess` **خارج المستودع**:
```apache
SetEnv METERED_APP yourapp
SetEnv METERED_KEY xxxxxxxx
SetEnv ALLOWED_ORIGIN https://your-site.com
```

### ج) ما يدخل `config.js` هو **الرابط فقط**

```js
calls: {
  turnFetchUrl: 'https://your-endpoint.example/turn',
  turnFetchTimeoutMs: 5000
}
```

### د) تحقّق

```bash
node tools/turn/check.mjs https://your-endpoint.example/turn --origin https://your-site.com --stun
```

أخضر بالكامل = جاهز. التفاصيل الكاملة في [`turn-setup.md`](turn-setup.md).

---

## 4) الدفع (غير منفَّذ في المشروع) — المفتاح سرّي

المشروع **لا يحتوي أي تكامل دفع** حالياً. إن أردت إضافته لاحقاً فالقواعد ثابتة:

| القيمة | مكانها |
|--------|--------|
| **Publishable / public key** (`pk_…`) | `config.js` — آمن للعرض |
| **Secret key** (`sk_…`, `sk_secret_…`) | Secrets على الخادم فقط (Edge Function) |
| **Webhook signing secret** (`whsec_…`) | Secrets على الخادم فقط |

التدفّق الصحيح:
1. المتصفح يطلب من **خادمك** إنشاء جلسة دفع.
2. خادمك يستدعي البوابة بالمفتاح السري ويعيد **رابط الدفع** فقط.
3. البوابة تُبلّغ خادمك عبر **Webhook** عند النجاح، وخادمك يتحقّق من التوقيع ثم يحدّث قاعدة البيانات.
4. لا يُصدَّق أي شيء يقوله المتصفح عن نجاح الدفع.

> ⚠️ **إن كان المفتاح الذي أرسلته في الصورة حقيقياً: بدّله الآن** من لوحة البوابة
> (Revoke / Roll). أي مفتاح سري ظهر في محادثة أو لقطة شاشة يُعتبر مكشوفاً — حتى لو
> حذفت الرسالة. ثم ضع الجديد في Secrets على الخادم مباشرة.

---

## 5) الجدول النهائي: كل قيمة وأين تنتهي

| # | القيمة | مصدرها | مكانها | تظهر للمتصفح؟ |
|---|--------|--------|--------|----------------|
| 1 | `Project URL` | Supabase ← Settings ← API | `config.js: supabase.url` | ✅ |
| 2 | `anon` key | نفس المكان | `config.js: supabase.anonKey` | ✅ |
| 3 | `service_role` | نفس المكان | ❌ لا تُستخدم | — |
| 4 | METERED_APP | لوحة Metered | Secrets على الخادم | ❌ |
| 5 | METERED_KEY | لوحة Metered | Secrets على الخادم | ❌ |
| 6 | رابط الوسيط | نشر الخادم | `config.js: calls.turnFetchUrl` | ✅ (رابط فقط) |
| 7 | مفتاح عام للبوابة `pk_…` | لوحة البوابة | `config.js` (عند التنفيذ) | ✅ |
| 8 | `sk_…` / `whsec_…` | لوحة البوابة | Secrets على الخادم | ❌ |
| 9 | كلمة مرور DB / JWT secret | Supabase | اللوحة فقط | ❌ |

---

## 6) قائمة «لا تفعل» (كل واحدة منها حصلت فعلاً لمشاريع حقيقية)

- ❌ لا تضع `service_role` أو `sk_` في `config.js` — الملف يُقرأ من أي زائر.
- ❌ لا تضع مفاتيح في `messages.html` / سكربت داخل الصفحة.
- ❌ لا ترفع ملف `.env` أو `secrets.*` إلى Git. أضفه إلى `.gitignore`.
- ❌ لا ترسل مفتاحاً في محادثة أو صورة أو تذكرة دعم.
- ❌ لا تضع مفتاحاً في `sw.js` أو في نصوص الكاش.
- ❌ لا تعتمد على «إخفاء» `anon` key؛ اعتمد على RLS.
- ✅ عند أي شكّ: **دوّر المفتاح** ثم افحص السجلّات.

---

## 7) أخطاء شائعة ومعناها

| الرسالة / العَرَض | السبب | الحل |
|---|---|---|
| «الميزات الاجتماعية غير مفعّلة على الخادم» | لم يُنفَّذ `07-social.sql` | نفّذه في SQL Editor |
| `PGRST202` / `42883` | دالة RPC غير موجودة | نفّذ ملف SQL المذكور في الرسالة |
| `401 Unauthorized` | انتهت الجلسة أو مفتاح خاطئ | أعد تسجيل الدخول، وتأكّد من `anonKey` |
| `403` مع رسالة عربية | RLS رفضت العملية (حظر/صداقة) | سلوك صحيح — راجع العلاقة |
| الموقع يعرض نسخة قديمة | Service Worker | Clear site data، وتأكّد من بصمة البناء في `Ctrl+K` |
| المكالمة تعمل على الواي فاي فقط | لا TURN | القسم 3 أعلاه |

---

**الخلاصة:** للنسخة الحالية تحتاج **قيمتين فقط** في `config.js` (URL + anon)،
ورابطاً واحداً اختيارياً للمكالمات (`turnFetchUrl`)، و**صفر مفاتيح سرّية** في المتصفح.

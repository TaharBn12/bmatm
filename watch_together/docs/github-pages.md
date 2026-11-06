# الموقع على GitHub Pages + السيرفر على Render

أفضل توزيع مجاني للمشروع: **الصفحات الثابتة** على GitHub Pages (لا تنام أبداً،
وسريعة عبر CDN)، و**السيرفر** على Render لخدمتَي **البحث** و**تحويل الرابط إلى
رابط مباشر**، و**الغرف** عبر Supabase.

```
المتصفح ──► GitHub Pages  (الصفحات: index / room / search …)
   │
   ├─► Supabase   ← إنشاء الغرف ومزامنتها (Realtime + استطلاع 2.5s)
   └─► Render     ← /api/search  و  /api/resolve  (عبر نطاقين: CORS)
```

---

## 1) لماذا **لا تتوقف الغرفة** في هذه البنية؟

لأن **الغرفة لا تمرّ بالسيرفر أصلاً**:

| الوظيفة | من ينفّذها | هل تتأثر بنوم Render؟ |
|---|---|---|
| الغرف والمزامنة والدردشة وقائمة الانتظار | **Supabase** | ❌ لا |
| البحث (ديليموشن/يوتيوب) | Render عبر `/api/search` | ✅ أول بحث بعد النوم ~50 ثانية |
| تحويل الرابط إلى رابط مباشر | Render عبر `/api/resolve` (yt-dlp) | ✅ نفس الشيء |

فإن توقّفت الغرفة على GitHub Pages، فالسبب **ليس Render** بل أحد هذه:

| العَرَض | السبب | الحل |
|---|---|---|
| الشارة تقول **«مزامنة محلية»** | السقوط إلى الوضع المحلي: تعذّر الوصول إلى Supabase | تأكد من `supabase.url` و`anonKey` و`ready: true` في `config.js` |
| «تعذّر إنشاء الغرفة» | مخطط قاعدة البيانات غير مطبّق | نفّذ [`docs/sql/01-bootstrap.sql`](sql/01-bootstrap.sql) |
| الغرفة تُنشأ لكن لا تزامن | الجداول ليست في منشور Realtime | أضف `rooms, messages, room_members, room_queue` إلى `supabase_realtime` (مشمول في السكربت) |
| الغرفة تعمل ثم تتوقف | `?local=1` في الرابط، أو `wt:forceLocal` في التخزين | احذف الرابط الزائد أو نظّف التخزين |

> طريقة تحقّق سريعة: افتح `index.html` وانظر الشارة في الأعلى — يجب أن تقول
> **«Supabase متصل»**. وإن قالت «وضع محلي» فالمشكلة في Supabase لا في Render.

---

## 2) الإعداد خطوة بخطوة

### أ) GitHub Pages

1. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. الفرع `main` والمجلد `/ (root)` → **Save**.
3. رابط الموقع سيكون:
   `https://TaharBn12.github.io/bmatm/watch_together/`
   （لأن الموقع داخل مجلد `watch_together/`).
   > إن أردت رابطاً أقصر: انسخ **محتويات** `watch_together/` إلى مجلد `docs/`
   > في جذر المستودع واختر المجلد `/docs`.

### ب) Supabase (للغرف)

نفّذ [`docs/sql/01-bootstrap.sql`](sql/01-bootstrap.sql) في **SQL Editor → Run**،
وفعّل Email في **Authentication → Providers**.

### ج) Render — **سيرفر API فقط**

كما في [`docs/render.md`](render.md) — Blueprint أو Web Service — ثم أضف متغيرَين:

```
WT_ALLOWED_ORIGINS = https://taharbn12.github.io
WT_API_ONLY        = true
```

（افصل بين أكثر من نطاق بفاصلة. القيمة `*` تسمح للجميع — للتجربة فقط.）

**ما يفعله `WT_API_ONLY=true`؟**

| | `true` (هذه البنية) | `false` (الافتراضي) |
|---|---|---|
| `/` | صفحة حالة عربية تؤكد العمل وتعرض النقاط | الموقع كاملاً من `ROOT` |
| `/api/search` · `/api/resolve` · `/api/suggest` | ✅ | ✅ |
| `/healthz` · `/api/stats` | ✅ | ✅ |
| `/ws` و`/api/rooms` | تعمل لكنها غير مستخدمة | مستخدمة (الغرف على السيرفر) |

اللافتة في سجل Render تطبع سطر **«الوضع: API فقط (الموقع على استضافة ثابتة)»**.

> `render.yaml` في جذر المستودع مضبوط أصلاً على `WT_API_ONLY=true` و`plan: free`
> و`region: frankfurt` — لا تحتاج إلا متغيّر `WT_ALLOWED_ORIGINS` من اللوحة.

### د) الربط في `config.js`

```js
javaServer: {
  enabled: true,
  url: null,
  apiBase: 'https://watchtogether-xxxx.onrender.com',   /* ← عنوان سيرفرك على Render */
  ...
}
```

`apiBase` يجعل العميل يطلب `/api/search` و`/api/resolve` من النطاق المطلق
بدل المسار النسبي (الذي يعني على Pages مساراً غير موجود).

**لا تضبط `url`** (عنوان WebSocket) — الغرف عندك على Supabase، ولا حاجة لغرف عبر Render.

> **تجربة سريعة بلا تعديل ملفات**: أضف `?api=https://watchtogether-xxxx.onrender.com`
> إلى رابط أي صفحة، أو نفّذ في الطرفية (Console):
> `localStorage.setItem('wt:apiBase','https://watchtogether-xxxx.onrender.com')`
> ثم أعد التحميل. يفيد هذا قبل أن تعتمد التعديل في `config.js`.

### هـ) تحقّق

من المتصفح (بدّل الرابط برابط سيرفرك):

```
https://watchtogether-xxxx.onrender.com/healthz        → ok
https://watchtogether-xxxx.onrender.com/api/stats      → إحصاءات
```

ثم في الموقع:
1. `index.html` → الشارة **«Supabase متصل»**.
2. `search.html` → ابحث عن كلمة: تظهر النتائج (المصدر: `yt-dlp على السيرفر`).
3. اضغط نتيجة ديليموشن → يُستخرج رابط مباشر ويُشغّل.
4. أنشئ غرفة وادعُ صديقاً — المزامنة عبر Supabase لا علاقة لها بنوم Render.

---

## 3) ما الذي يعمله السيرفر بالضبط؟

| النقطة | الوظيفة | مَن يطلبها |
|---|---|---|
| `GET /api/search?q=…&site=dailymotion\|youtube` | بحث عبر yt-dlp | صفحة البحث |
| `POST /api/resolve` | تحويل رابط فيديو إلى **رابط مباشر** | صفحة البحث وصفحة الغرفة |
| `POST /api/suggest` | اقتراحات «التالي» | صفحة الغرفة |
| `GET /healthz` | فحص الحياة (ونبضة الإبقاء) | العميل |
| `GET /api/stats` | إحصاءات للتشخيص | أنت |

ملاحظة: `/api/rooms` و`/ws` (الغرف عبر سيرفر Java) **غير مستخدمتين** في هذه البنية،
فلا يضرّ نوم الخدمة بين الجلسات.

---

## 4) القيود

- **أول بحث بعد 15 دقيقة خمول** يستغرق ~50 ثانية (إيقاظ النسخة المجانية).
  الغرف لا تتأثر، لكن نافذة البحث تنتظر — وقد أضفنا رسالة «جارٍ البحث…».
- **يوتيوب قد يحجب عناوين مراكز البيانات**: التشغيل يظل يعمل (مشغّله الرسمي داخل iframe)،
  أما بحث yt-dlp واستخراج يوتيوب فقد يتعطّلان على Render تحديداً.
- GitHub Pages لا يشغّل أي كود خادم: كل ما سبق يعتمد على Supabase وRender.

---

## 5) الأمان

- القائمة `WT_ALLOWED_ORIGINS` تمنع أي موقع آخر من استهلاك سيرفرك؛
  الطلب من مصدر غير مسموح يُرجع `403` مع رسالة توضّح الحل.
- النقاط ترسل `Access-Control-Allow-Origin` للمصدر المسموح فقط (مع `Vary: Origin`)
  وتجيب على الطلب التمهيدي `OPTIONS` بـ `204`.
- `anonKey` في `config.js` مفتاح عام بصلاحيات مقيدة بـ RLS — طبيعي أن يظهر في الكود.

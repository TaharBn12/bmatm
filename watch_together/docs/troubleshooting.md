# 🩺 حل المشاكل

**«رفعت الملفات ولم تظهر التغييرات»** — اتبع الخطوات 1 و 2.
**«الأصدقاء لا يدخلون نفس الغرفة»** — اذهب مباشرة للخطوة [9](#9-الأصدقاء-لا-يدخلون-نفس-الغرفة-).

اتبع الخطوات **بالترتيب** — 95% من الحالات تُحل في الخطوتين 1 و 2.

---

## 1) تأكد أنك رفعت من الفرع الصحيح ✅ (السبب الأكثر شيوعاً)

كل التعديلات كانت على فرع `arena/5b5d72b5-bmatm` داخل **Pull Request**.
إن نزّلت أو سحبت من `main` قبل دمج الـ PR، فستحصل على الملفات القديمة.

**التحقق:**
```bash
git fetch origin
git log --oneline -1 origin/main          # يجب أن يحتوي Merge pull request #1
git ls-tree -r origin/main --name-only | grep watch_together | head
```
يجب أن ترى `watch_together/index.html` و `watch_together/room.html` و `watch_together/auth.html`.

**أو من المتصفح مباشرة** — افتح هذين الرابطين وتأكد أن الملف موجود:
- `https://raw.githubusercontent.com/TaharBn12/bmatm/main/watch_together/auth.html`
- `https://github.com/TaharBn12/bmatm/tree/main/watch_together`

> ℹ️ **تم دمج PR #1 إلى `main`** — إذن التنزيل من `main` الآن يعطيك أحدث نسخة.
> لتنزيلها كملف مضغوط:
> `https://codeload.github.com/TaharBn12/bmatm/zip/refs/heads/main`

---

## 2) كاش المتصفح ✅ (ثاني أكثر سبب)

المتصفح يحتفظ بالنسخة القديمة من `app.css` و `room.js` فيعرض لك التصميم القديم.

**الحل الفوري:**
| الجهاز | الاختصار |
|--------|----------|
| Windows/Linux (Chrome, Edge, Firefox) | `Ctrl + Shift + R` أو `Ctrl + F5` |
| Mac (Chrome, Safari) | `Cmd + Shift + R` |
| iPhone / iPad (Safari) | الإعدادات ← Safari ← **مسح السجل وبيانات الموقع**، أو افتح الرابط في **تبويب خاص** |
| Android (Chrome) | ⋮ ← السجل ← مسح بيانات التصفح ← «الصور والملفات المخزنة مؤقتاً» |

**الحل الدائم (مُطبَّق في المشروع الآن):**
- كل مراجع CSS/JS تحمل رقم إصدار: `assets/css/app.css?v=2.4.0`
  → عند أي تعديل ارفع الرقم في الملفات الثلاثة (`index.html`, `room.html`, `auth.html`).
  (أو بالأمر: `node tools/sbctl.mjs set --url … --key …` يرفع الرقم تلقائياً.)
- ملف **`.htaccess`** يمنع تخزين صفحات HTML نهائياً ويضغط المحتوى بـ Gzip.
- وسوم `<meta http-equiv="Cache-Control" content="no-cache">` داخل الصفحات.

**للتأكد أن الخادم يقدّم النسخة الجديدة** (من طرفك):
```bash
curl -I https://موقعك.com/room.html | grep -i 'cache-control\|last-modified'
curl -s https://موقعك.com/room.html | grep -c 'data-icon='   # يجب أن يكون ≥ 40
```
إن كان العدد `0` → الخادم ما زال يقدّم النسخة القديمة (ارجع للخطوة 1 أو 3).

---

## 3) تأكد أنك رفعت **محتويات** المجلد لا المجلد نفسه

البنية الصحيحة داخل `public_html`:
```
public_html/
├── index.html          ← ✔ صحيح
├── room.html
├── auth.html
├── .htaccess
└── assets/
    ├── css/app.css
    ├── js/*.js
    └── vendor/*.js
```

البنية **الخاطئة** الشائعة:
```
public_html/
└── watch_together/     ← ✗ مجلد إضافي
    ├── index.html
    └── ...
```
عندها يصبح رابط الموقع `https://موقعك.com/watch_together/` وليس `https://موقعك.com/`.

**كلا الحالتين تعمل** (كل الروابط نسبية) — لكن تأكد أي رابط تفتحه.

---

## 4) تأكد أن الملفات الجديدة موجودة فعلاً على الاستضافة

افتح هذه الروابط مباشرة؛ أي واحد يعطي **404** يعني أن الملف لم يُرفع:

```
https://موقعك.com/auth.html
https://موقعك.com/assets/js/icons.js
https://موقعك.com/assets/js/auth.js
https://موقعك.com/assets/js/room.js
https://موقعك.com/.htaccess        (قد يخفيه الخادم — هذا طبيعي)
```

قائمة الملفات التي **يجب** أن تكون مرفوعة (13 ملف JS/CSS/HTML):

| الملف | الوظيفة |
|-------|---------|
| `index.html` `room.html` `auth.html` | الصفحات الثلاث |
| `.htaccess` | الكاش + Gzip + حماية الملفات |
| `assets/css/app.css` | التصميم |
| `assets/js/config.js` | الإعدادات |
| `assets/js/util.js` `icons.js` `auth.js` | أدوات + أيقونات + مصادقة |
| `assets/js/transport.js` `player.js` | مزامنة + مشغّل |
| `assets/js/home.js` `auth-page.js` `room.js` | منطق الصفحات |
| `assets/vendor/hls.min.js` `qrcode.min.js` | مكتبات مضمّنة |

---

## 5) الاستضافة على Netlify / Vercel / GitHub Pages

| المنصة | الإعداد المطلوب |
|--------|-----------------|
| **GitHub Pages** | Settings → Pages → Branch: `main` → Folder: **`/watch_together`** (وليس `/root`) |
| **Netlify** | Base directory: `watch_together` • Build command: **فارغ** • Publish directory: `.` |
| **Vercel** | Root Directory: `watch_together` • Framework Preset: **Other** |
| **Cloudflare Pages** | Root directory: `watch_together` • Build command: فارغ |

ثم **أعد النشر** (Deploy → Trigger deploy / Redeploy) — النشر لا يتحدّث تلقائياً دائماً.
ولمحو كاش Cloudflare: **Caching → Configuration → Purge Everything**.

---

## 6) الموقع يظهر لكن **المزامنة لا تعمل**

افتح الموقع وانظر الشارة أعلى الصفحة:

| الشارة | المعنى | الحل |
|--------|--------|------|
| **«Supabase متصل»** | كل شيء سليم ✅ | — |
| **«أنشئ الجداول (docs/schema.sql)»** | الجداول غير منشأة | نفّذ `docs/schema.sql` في SQL Editor |
| **«صلاحيات RLS أو مفتاح العضو»** | المخطط قديم أو رمز العضو غير مطابق | أعد تنفيذ `docs/schema.sql`؛ رابط الدعوة يسمح بالمشاهدة ولا يمنح التحكم |
| **«وضع محلي (بدون سيرفر)»** | تعذّر الوصول لـ Supabase | تحقّق من `url` و `anonKey` في `config.js`، وأن الموقع يعمل بـ **HTTPS** |
| **«سيرفر Java متاح»** | يعمل عبر السيرفر ✅ | — |

> ⚠️ **HTTPS إلزامي** لعمل WebSocket و `navigator.clipboard` (نسخ رابط الغرفة).
> على `http://` عادي سيعمل الموقع لكن قد يفشل الاتصال بـ Supabase Realtime.

**لفحص الاتصال يدوياً** — افتح Console (F12) والصق:
```js
fetch(WT_CONFIG.supabase.url + '/rest/v1/rooms?select=room_id&limit=1', {
  headers: { apikey: WT_CONFIG.supabase.anonKey, Authorization: 'Bearer ' + WT_CONFIG.supabase.anonKey }
}).then(r => r.json()).then(console.log).catch(console.error)
```
- `[]` أو `[{...}]` → الاتصال سليم.
- `42P01` → الجداول غير منشأة.
- `42501` → سياسات RLS ناقصة.
- `Failed to fetch` → الشبكة/النطاق/HTTPS.

---

## 6ب) «تعذّر الاتصال» في الغرفة — التشخيص الجديد 🔍

منذ الإصدار 2.3.0 لم تعد رسالة «تعذّر الاتصال» بلا سبب: التطبيق **يشرح السبب ويقترح الحل**،
ويوجد زر **«تشخيص الاتصال»** ضمن قائمة الغرفة الجانبية لفحص المشروع من المتصفح.

### أ) من داخل الغرفة (الأسهل)

1. افتح الغرفة → افتح **القائمة الجانبية** واختر **«تشخيص الاتصال»**.
2. ستظهر نافذة فيها:
   - هل REST يستجيب؟ وكم استغرق (مللي ثانية)؟
   - هل الجداول الخمسة (`rooms` / `messages` / `presence` / `room_members` / `room_queue`) موجودة؟
   - هل **Realtime** يعمل أو يجري الاعتماد على الاستطلاع الاحتياطي؟
   - **السبب الدقيق** لأي خطأ + **الحل** بعبارة واحدة.
3. أزرار: **إعادة الاتصال** · **إعادة الفحص** · **نسخ التقرير** (أرسله لمن شاء).

### ب) من الطرفية (أعمق)

```bash
cd watch_together
node tools/sbctl.mjs doctor          # يفحص المشروع المهيّأ في config.js
node tools/sbctl.mjs doctor --json   # نفس الفحص بمخرجات JSON
```

### ج) الحل الأسرع: **سيرفر Supabase جديد**

إن كان المشروع القديم موقوفاً أو بُني بنسخة قديمة من المخطط، أنشئ مشروعاً جديداً:

```bash
export SUPABASE_ACCESS_TOKEN="sbp_..."          # من supabase.com → Access Tokens
node tools/sbctl.mjs create --name wt-new \
  --org-id <ORGANIZATION_ID> --db-password "<كلمة مرور قوية>"
```

الأمر ينشئ المشروع، ينفّذ `docs/bootstrap.sql`، جلب المفتاح، يربطه بالموقع،
ثم يفحصه ويطبع النتيجة. الدليل الكامل: [`new-supabase-server.md`](new-supabase-server.md).

> 💡 حتى لا يسقط الاتصال بسبب جدول واحد ناقص: التطبيق الآن **لا يسقط بالكامل** إذا كان
> جدول `messages` مفقوداً — المزامنة (الفيديو) تعمل والدردشة فقط تتعطّل مع تنبيه واضح.

---

## 7) الفيديو لا يعمل

| الرابط | الشرط |
|--------|-------|
| **يوتيوب** | يجب أن يكون الفيديو **عاماً** وغير محظور التضمين. الخاص/المحذوف يعطي خطأ في المشغّل |
| **MP4/WebM** | يجب أن يسمح خادم الملف بـ **CORS** وإلا لن يعمل من نطاق آخر |
| **HLS (m3u8)** | يحتاج CORS أيضاً؛ Safari يشغّله أصلياً وبقية المتصفحات عبر `hls.js` المضمّن |
| **روابط تضمين** (تويتش/فيميو…) | بعض المواقع تمنع التضمين خارج نطاقها (`X-Frame-Options`) — هذا خارج سيطرتنا |

جرّب دائماً بأزرار **التجربة السريعة** في الصفحة الرئيسية (روابط عامة معروفة تعمل).

---

## 8) فحص سريع شامل (انسخه في Console)

```js
console.table({
  'الإصدار': document.querySelector('link[href*="app.css"]')?.href.split('v=')[1] || 'بلا إصدار (نسخة قديمة!)',
  'الأيقونات': document.querySelectorAll('.ic svg').length,
  'المصادقة': typeof WTAuth !== 'undefined' ? (WTAuth.enabled() ? 'مفعّلة' : 'غير مفعّلة') : 'auth.js غير محمّل!',
  'المزامنة': document.getElementById('sbMode')?.textContent || document.getElementById('modeBadge')?.textContent,
  'الحالة': document.getElementById('statusText')?.textContent || '—',
  'المشغّل': typeof WTPlayer !== 'undefined' ? 'محمّل' : 'غير محمّل',
  'HLS': typeof Hls !== 'undefined' ? 'محمّل' : 'غير محمّل'
});
```

النتيجة المتوقعة في نسخة سليمة:
- **الإصدار:** `2.4.0`
- **الأيقونات:** رقم أكبر من 20
- **المزامنة/الحالة:** «Supabase متصل» أو «سيرفر Java متاح»

إن ظهر «بلا إصدار» أو «غير محمّل» → الملفات المرفوعة قديمة (ارجع للخطوة 1 و 3).

---

## 9) الأصدقاء لا يدخلون «نفس الغرفة» 🎯

هذا عرضٌ لعدة أسباب — راجعها بالترتيب:

| # | السبب | كيف تكشفه | الحل |
|---|-------|-----------|------|
| 1 | **السيرفر غير متصل** → الموقع يعمل في «الوضع المحلي»، وكل جهاز له غرفة مستقلة | شارة الحالة تقول **«وضع محلي»**، وتظهر رسالة صفراء في الدردشة | شغّل سيرفر Java، أو فعّل Supabase في `config.js` ونفّذ `docs/schema.sql` |
| 2 | **Realtime غير مفعّل أو الفلتر لا يعمل** على Supabase | المزامنة تتأخر أو تنتقل للاستطلاع | أعد تنفيذ `docs/schema.sql` وتأكد من إضافة `rooms`, `messages`, `room_members`, `room_queue` إلى `supabase_realtime`؛ الاستطلاع يبقى بديلاً تلقائياً |
| 3 | **أنت على سيرفر Java وصديقك على Supabase** (أو العكس) — غرفتان مختلفتان تماماً | في شارة الاتصال أعلى الغرفة: أنت «سيرفر Java» وهو «Supabase» | استضف الجميع على نفس الخادم؛ أو اجعل `javaServer.enabled = false` إن كان موقعك لا يدعم Java |
| 4 | **الضيف كتب الكود خطأ** أو المضيف خرج | رسالة نظام: «لم يتم العثور على هذه الغرفة…» | انسخ **الرابط** من زر «نسخ الرابط» (يحمل الكود + الفيديو) بدل الكود وحده |
| 5 | **ملفات MP4 كانت لا تتزامن أصلاً** (خلل قديم في `canSync`) | يوتيوب يتزامن والملفات المباشرة لا | حُلّ — حدّث الملفات وارفع رقم الإصدار `?v=` |

**نصيحة:** استخدم دائماً زر **«نسخ الرابط»** أو **QR** من داخل الغرفة، لا الكود وحده —
فالرابط يحمل كود الغرفة **ورابط الفيديو**، فيلتحق صديقك بنفس المشاهدة حتى لو تأخّرت حالة الغرفة.

### فحص سريع من الكونسول (في صفحة الغرفة)
```js
console.table({
  'كود الغرفة': WTRoom.roomId,
  'السيرفر': WTRoom.session.mode,
  'حالة الاتصال': WTRoom.session.transport && WTRoom.session.transport.status,
  'الفيديو': WTRoom.state.url,
  'الموضع': WTRoom.state.pos,
  'رقم تسلسلي': WTRoom.state.rev,
  'المنضمون': Object.keys(WTRoom.session.members).length
});
```
يجب أن يكون **«السيرفر» و«الفيديو» و«رقم تسلسلي» متطابقة** عندك وعند صديقك.

---

## 10) ما زال لا يعمل؟

أرسل لي:
1. **رابط موقعك** المنشور.
2. لقطة من **Console** (F12 → Console) بالأخطاء الحمراء.
3. نتيجة الفحص السريع في الخطوة 8.

وسأحدّد السبب بدقة.

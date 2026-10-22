# 🌐 الخطوة 2 بالتفصيل — تجهيز TURN للمكالمات الصوتية

> هذه هي **الخطوة الوحيدة المتبقّية** بعد تنفيذ `09-calls.sql` لتعمل المكالمات على
> شبكات الجوال والشبكات المقيّدة. المستند يشرح: لماذا نحتاجها، كيف يقرأها كودك،
> كيف تُشغّلها عبر خدمة مُدارة أو خادمك، وكيف **تتأكّد** أنها تعمل فعلاً.

---

## 0) الخلاصة في 30 ثانية

```js
// assets/js/config.js
calls: {
  turnFetchUrl: 'https://your-worker.example.workers.dev/turn', // يعيد بيانات مؤقتة
  turnFetchTimeoutMs: 5000
}
```
1. أنشئ حساب **Metered** المجاني (20 غ.ب شهرياً) واحصل على مفتاح الـAPI.
2. ضع المفتاح في **خادم صغير** (Cloudflare Worker / Supabase Edge Function / PHP).
3. ذلك الخادم يعيد للعميل: `username` + `credential` + `urls` — **بلا كشف المفتاح**.
4. اختبر على **بيانات الجوال** (أطفئ الواي فاي) من جهازين مختلفين.

> ⚠️ **لا تضع مفتاح Metered داخل `config.js`** أبداً: كل زائر يقرأ الملف، وسيستهلك
> حصتك أو يبيعها. المفتاح يبقى على الخادم فقط.

---

## 0.5) كيف أسجّل وأجلب البيانات؟ (خطوة بخطوة)

### أ) إنشاء الحساب في Metered (5 دقائق)

1. افتح **<https://dashboard.metered.ca/signup>** (أو `metered.ca` ← *Get Started*).
2. أنشئ الحساب بالبريد أو Google، ثم **أكّد البريد** من الرسالة.
3. حين يُطلب اختيار خطة: اختر **Free**.
   - الحصة المجانية المعلنة: **20 غ.ب/شهر** لترحيل TURN (وبعض الحسابات تحصل على حصة
     أصغر حتى تُضاف وسيلة دفع — ابحث عن `Usage` في اللوحة لمعرفة حصتك الفعلية).
4. من القائمة الجانبية افتح قسم **TURN Server** (أو **Open Relay**).

### ب) ما الذي تنسخه بالضبط؟

| ما تنسخه | أين تجده | إلى أين يذهب |
|-----------|----------|---------------|
| **اسم التطبيق** (`<appname>`) | أعلى اللوحة، أو في رابط `https://<appname>.metered.live/...` | `METERED_APP` في **خادمك** فقط |
| **TURN API key** (مفتاح REST) | في صفحة TURN ← *API Keys / Generate API Key* | `METERED_KEY` في **خادمك** فقط |
| **username + password** (اختياري) | *Credentials* ← *Create credential* (يمكن تحديد صلاحية) | لإعداد تجربة سريعة فقط في `calls.turn` |

> ⚠️ **المفتاح لا يدخل `config.js`** — كل زائر يقرأ الملف. المفتاح يبقى في
> Supabase Secrets / Cloudflare Secrets / متغيّرات بيئة PHP.

### ب.١) الطريقة في ملف — `assets/js/turn.local.js`

الملف موجود في المشروع ومربوط في `messages.html` **قبل** `calls.js`:

```js
window.WT_TURN_LOCAL = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: '…', credential: '…' },
  …
];
```

1. افتح `assets/js/turn.local.js` وضع **كلمة المرور** مكان `ضع-كلمة-المرور-هنا`
   (اسم المستخدم موضوع مسبقاً).
2. ارفع الملف، ثم امسح بيانات الموقع مرة وأعد التحميل.
3. ابدأ مكالمة — ستظهر في شاشة الرنين ملاحظة «تُستخدم بيانات TURN من ملف محلي».

**التفاصيل المهمة:**
- إن تركت كلمة المرور كما هي (أو كتبت `PASSWORD`/`x`)، **يتجاهل الكود التمرير
  تلقائياً** ويستمر بالـSTUN وحده — لا مكالمات معطوبة.
- الأولوية: تجاوز الكونسول (`WT_TURN_OVERRIDE`) ← **الملف المحلي** ← `calls.turn` ←
  `turnFetchUrl`. وأي وجود لملف محلي يُلغي طلب الوسيط (لا فائدة من الاثنين).
- الملف **مرئي لكل زائر** للموقع المنشور. راقب `Usage` في لوحة Metered،
  وبدّل الاعتماد عند الشكّ. للإيقاف: اجعل `window.WT_TURN_LOCAL = null;` أو احذف الملف.
- الاختبارات تحرس هذا: `docs/tests/calls.mjs` يرفض أي `credential` خارج
  `turn.local.js`، و`secrets-guard.mjs` يمنع مفاتيح الدفع/الإدارة في أي ملف.

### ب.٢) أسرع طريق للتجربة الآن — بلا لمس المستودع

بيانات Metered الجاهزة (Open Relay) تُلصق في **كونسول المتصفح** مرة واحدة:

```js
// F12 → Console، ثم الصق بياناتك الحقيقية
window.WT_TURN_OVERRIDE = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'USERNAME', credential: 'PASSWORD' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'USERNAME', credential: 'PASSWORD' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'USERNAME', credential: 'PASSWORD' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'USERNAME', credential: 'PASSWORD' }
];
location.reload();   // ثم أعد لصق السطرين بعد التحديث (لا يُحفظ شيء)
```

- **لا يُكتب في أي ملف** ولا يُرسل لأي خادم ولا يُخزَّن (يُنسى عند تحديث الصفحة).
- يتجاوز `turnFetchUrl` و`calls.turn` مؤقتاً، ويظهر في شاشة الرنين تنبيه بذلك.
- للتحقّق أن المسار يعمل: في `chrome://webrtc-internals` يجب أن يظهر مرشّح **`relay`**.

> ⚠️ لا تضع هذه القيم في `config.js` على موقع عام: كل زائر يقرأ الملف ويستهلك
> حصّتك (20 غ.ب/شهر). اختبار المشروع `docs/tests/calls.mjs` يفشل إن وُجدت
> `credential` مضمّنة في `config.js`.

### ج) كيف تجلب البيانات؟ (طريقتان)

**1) تجربة سريعة — بيانات ثابتة (10 دقائق، لجهازك فقط):**

```js
// assets/js/config.js — لا ترفع هذا إلى موقع عام!
calls: {
  turn: {
    urls: ['turn:standard.relay.metered.ca:80',
           'turn:standard.relay.metered.ca:80?transport=tcp',
           'turns:standard.relay.metered.ca:443'],
    username: '<username من Credentials>',
    credential: '<password من Credentials>'
  }
}
```

**2) الإنتاج — بيانات مؤقتة عبر خادمك:**

```bash
# اختبر يدوياً أن المفتاح واسم التطبيق يعملان (من حاسوبك، لا من المتصفح):
curl -s "https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<API_KEY>" | head -c 400
```

المتوقّع: مصفوفة مثل `[{"urls":"turn:standard.relay.metered.ca:80","username":"…","credential":"…"}, …]`.

ثم انشر الوسيط الجاهز في المستودع (اختر واحداً):

| الخادم | الملف | الأمر |
|--------|-------|-------|
| Supabase Edge Function | [`tools/turn/supabase-edge.ts`](../tools/turn/supabase-edge.ts) | `supabase functions deploy turn --no-verify-jwt` ثم `supabase secrets set METERED_APP=… METERED_KEY=… ALLOWED_ORIGIN=https://موقعك` |
| Cloudflare Worker | [`tools/turn/cloudflare-worker.js`](../tools/turn/cloudflare-worker.js) | `wrangler secret put METERED_KEY` … ثم `wrangler deploy` |
| استضافة PHP/cPanel | [`tools/turn/turn.php`](../tools/turn/turn.php) | ارفعه إلى جذر الموقع واضبط `SetEnv` |

ثم في `config.js`:

```js
calls: { turnFetchUrl: 'https://…/turn', turnFetchTimeoutMs: 5000 }
```

### د) هل نجح؟ أمر واحد

```bash
node tools/turn/check.mjs https://…/turn --origin https://your-site.com --stun
```
أخضر بالكامل ⇒ انتقل للاختبار في المتصفح (القسم 8).

---

## 1) لماذا هذه الخطوة ضرورية؟ (المشكلة التي تحلّها)

عندما يريد هاتفان التحدث، يحاول المتصفح أولاً **اتصالاً مباشراً** بينهما:

| المكوّن | دوره | تكلفته | هل يكفي وحده؟ |
|---------|------|--------|----------------|
| **STUN** | يخبر كل جهاز «ما هو عنوانك العام من الخارج؟» | مجاني (لدينا اثنان في الإعدادات) | ❌ يفشل عند CGNAT/جدران الشركات |
| **TURN** | خادم **يُرحّل** الصوت عندما يستحيل الاتصال المباشر | نطاق ترددي | ✅ الحل |

**الحقيقة العملية:** نحو **15–30%** من المكالمات لا تنجح مباشرة (بيانات الجوال خلف
CGNAT، شبكات المقاهي والجامعات، بعض VPN). بدون TURN ستسمع: «المكالمة تعمل في البيت
وتفشل خارجاً».

> 🔐 **الخصوصية لا تتغيّر:** الصوت يبقى مشفّراً من طرف إلى طرف (DTLS‑SRTP). TURN يرى
> حزماً مشفّرة ولا يستطيع فكّها ولا تخزينها — نفس مبدأ «لا نسمع مكالماتك».

---

## 2) كيف يستهلك كودك TURN بالضبط (اقرأ هذا قبل أي إعداد)

من `assets/js/calls.js`:

1. عند بدء المكالمة (مرة واحدة) يجمع الخوادم:
   - `calls.iceServers` (STUN) دائماً.
   - `calls.turn` إن وُجد (بيانات ثابتة).
   - **`calls.turnFetchUrl`:** طلب `POST` بجسم `{}`، مع مهلة `turnFetchTimeoutMs`.
2. يقبل **ثلاث صيغ** للاستجابة:
   ```json
   { "urls": "turn:host:443", "username": "u", "credential": "p" }
   ```
   ```json
   [ { "urls": ["turn:host:80", "turn:host:443?transport=tcp"], "username": "u", "credential": "p" } ]
   ```
   ```json
   { "iceServers": [ { "urls": "...", "username": "...", "credential": "..." } ] }
   ```
3. إن فشل الطلب أو تأخّر أو لم يحتوِ أي `turn:`/`turns:`:
   - **لا تتعطّل المكالمة** — يكمل بـSTUN فقط.
   - تظهر في شاشة الرنين ملاحظة عربية: «تعذّر جلب بيانات TURN…» أو «لم نستلم خادم
     ترحيل (TURN)…» — أي أن الواجهة تخبرك بالسبب بدلاً من الفشل الصامت.

**لذلك شكل الاستجابة عندك = العقد الوحيد الذي يجب أن يحترمه خادمك.**

---

## 3) معنى `urls` — أي عنوان تختار؟

```text
turn:relay.example.com:80                     UDP، سريع، يُحجب أحياناً
turn:relay.example.com:80?transport=tcp       TCP على 80 — ينفذ من جدران كثيرة
turn:relay.example.com:443                    UDP على 443 — يبدو كـHTTPS
turns:relay.example.com:443?transport=tcp     TLS على 443 — الأقوى ضد الحجب (يثقله TLS)
stun:relay.example.com:80                     اكتشاف فقط
```

**التوصية:** أعِد **أربعة** عناوين معاً (80 UDP + 80/TCP + 443 + 443/TCP). المتصفح
يجرّبها بالتوازي ويختار الأنجح — هذا ما يفعله مزوّد مثل Metered تلقائياً.

---

## 4) المسار A (المُوصى به): Metered Open Relay — مجاني 20 غ.ب/شهر

### 4.1 إنشاء الحساب والمفتاح
1. سجّل في `metered.ca` واختر الخطة المجانية.
2. من لوحة التحكم انسخ **اسم التطبيق** (مثل `yourapp`) و**API key** الخاص بـTURN.
3. (اختياري) أنشئ Credential واحدة بلافتة واضحة، ومدة صلاحية قصيرة (ساعة).

الـAPI الجاهز لديهم يعيد المصفوفة التي يقبلها كودك مباشرة:

```
GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<API_KEY>
```

**لكن لا تستدعِه من المتصفح** (سيظهر المفتاح). استدعِه من خادمك — كما يلي.

### 4.2 الخيار 1: Cloudflare Worker (أسرع، بلا خادم)

```js
// worker.js — انشره: wrangler deploy
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Cache-Control': 'no-store'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

    const upstream = 'https://' + env.METERED_APP + '.metered.live/api/v1/turn/credentials?apiKey=' + env.METERED_KEY;
    const response = await fetch(upstream);
    if (!response.ok) return new Response(JSON.stringify({ error: 'upstream' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });

    const list = await response.json(); // [{urls,username,credential}, ...]
    return new Response(JSON.stringify(list), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
```

```bash
wrangler secret put METERED_KEY     # المفتاح — لا يظهر في الكود
wrangler secret put METERED_APP     # اسم التطبيق
wrangler secret put ALLOWED_ORIGIN  # https://your-site.com
```

ثم: `turnFetchUrl: 'https://<worker>.workers.dev/turn'`.

> **لماذا `OPTIONS`؟** طلبنا يُرسل `Content-Type: application/json` فيُعتبر
> «غير بسيط» ويسبقه **preflight**. إن لم يُجب خادمك عن `OPTIONS` بالفؤوس أعلاه
> فسيفشل جلب TURN في المتصفح رغم أن `curl` يعمل.

### 4.3 الخيار 2: Supabase Edge Function (أنت على Supabase أصلاً)

```ts
// supabase/functions/turn/index.ts
const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Cache-Control': 'no-store'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });

  const app = Deno.env.get('METERED_APP');
  const key = Deno.env.get('METERED_KEY');
  if (!app || !key) return new Response(JSON.stringify({ error: 'missing secrets' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });

  const upstream = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${key}`);
  if (!upstream.ok) return new Response(JSON.stringify({ error: 'upstream' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });

  return new Response(await upstream.text(), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
```

```bash
supabase secrets set METERED_APP=yourapp METERED_KEY=xxxx ALLOWED_ORIGIN=https://your-site.com
supabase functions deploy turn --no-verify-jwt   # ← مهم: عميلنا لا يرسل JWT لهذا الطلب
```

`turnFetchUrl: 'https://<project-ref>.supabase.co/functions/v1/turn'`.

> ⚠️ بدون `--no-verify-jwt` ستحصل على **401** ولن يُجلب TURN. إن أردت حماية أقوى:
> أرسل رمز جلسة Supabase من العميل وأزل `--no-verify-jwt` (أستطيع إضافة هذا الخيار
> لكود `calls.js` إن رغبت).

### 4.4 الخيار 3: PHP على استضافة cPanel (المشروع يدعمها)

```php
<?php
// turn.php — وضعه في جذر الموقع، والمفتاح في متغيّر بيئة أو ملف خارج الويب
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$origin = getenv('ALLOWED_ORIGIN') ?: 'https://your-site.com';
header('Access-Control-Allow-Origin: ' . $origin);
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: content-type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }

$app = getenv('METERED_APP');
$key = getenv('METERED_KEY');
$cacheFile = sys_get_temp_dir() . '/wt-turn.json';

// إعادة استخدام الاستجابة 60 ثانية لتفادي ضرب الـAPI في كل مكالمة
if (is_file($cacheFile) && time() - filemtime($cacheFile) < 60) {
  readfile($cacheFile); exit;
}
$url = 'https://' . rawurlencode($app) . '.metered.live/api/v1/turn/credentials?apiKey=' . rawurlencode($key);
$ch = curl_init($url);
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 4]);
$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($code !== 200 || !$body) { http_response_code(502); echo '{"error":"upstream"}'; exit; }
file_put_contents($cacheFile, $body);
echo $body;
```

`turnFetchUrl: 'https://your-site.com/turn.php'` — وبهذا لا تحتاج أي خادم إضافي.

---

## 5) المسار B: coturn على VPS (استقلال كامل)

مناسب إذا أردت ألا تعتمد على طرف ثالث:

```bash
# Ubuntu 22/24
sudo apt update && sudo apt install -y coturn
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

```conf
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=ضع_سراً_طويلاً_عشوائياً
realm=turn.your-domain.com
external-ip=IP_الخادم
min-port=49160
max-port=49200
no-multicast-peers
# شهادة TLS (Let's Encrypt) لخيار turns:
cert=/etc/letsencrypt/live/turn.your-domain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.your-domain.com/privkey.pem
```

افتح في الجدار الناري: `3478/udp`, `3478/tcp`, `5349/tcp`, ونطاق `49160–49200/udp`.

**بيانات مؤقتة بنمط REST (HMAC):**
```text
username   = "<انتهاء الصلاحية بالثواني>:<معرّف المستخدم>"
credential = base64(HMAC-SHA1(السر, username))
```

مثال Node (10 دقائق صلاحية):
```js
import { createHmac } from 'node:crypto';
const ttl = 600, user = String(userId).slice(0, 32);
const username = Math.floor(Date.now() / 1000 + ttl) + ':' + user;
const credential = createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
res.json({ urls: [
  'turn:turn.your-domain.com:3478?transport=udp',
  'turn:turn.your-domain.com:3478?transport=tcp',
  'turns:turn.your-domain.com:5349?transport=tcp'
], username, credential });
```

> يعني: لا تُرسل كلمة سر ثابتة للجميع؛ كل مكالمة تأخذ بيانات تنتهي بعد دقائق.

---

## 6) المسار C: مزوّدون آخرون

| المزوّد | ملاحظة |
|---------|--------|
| **Twilio Network Traversal** | Console ← *Network Traversal* ← أنشئ Credential؛ التسجيل عبر `POST https://api.twilio.com/2010-04-01/Accounts/<SID>/Tokens.json` (Basic auth) يعيد `ice_servers`؛ ضعه في خادمك بنفس شكل `{iceServers:[…]}` ⇒ مدعوم بلا تعديل كود |
| **Cloudflare Realtime (TURN)** | بيانات مؤقتة عبر API بمفتاح على الخادم؛ أداء ممتاز |
| **خدمة STUN/TURN عامة ببيانات ثابتة** | ❌ لا تُستخدم في منتج: لا ضمان، وقد تُغلق أو تُستغل |

القاعدة: أي مزوّد يعيد `{urls, username, credential}` أو `{iceServers:[...]}` يعمل
دون تعديل كود.

---

## 7) الأمان — قائمة تحقّق إلزامية

- [ ] مفتاح المزوّد/السر **على الخادم فقط** (Secret/Env) — لا في `config.js` ولا في Git.
- [ ] صلاحية البيانات **قصيرة** (5–30 دقيقة) — لا سنة.
- [ ] `Access-Control-Allow-Origin` = نطاقك فقط، لا `*` في الإنتاج.
- [ ] تحديد معدّل على نقطة النهاية (مثلاً 20 طلباً/دقيقة/IP) لتفادي استهلاك الحصة.
- [ ] عدم تسجيل `credential` في أي سجل (logs).
- [ ] مراقبة الاستهلاك شهرياً (لوحة المزوّد) لتفادي تجاوز الحصة.
- [ ] تدوير المفتاح عند أي شكّ في تسريبه.

---

## 8) الاختبار والتحقّق — كيف تعرف أنها تعمل فعلاً؟

### 8.0 فاحص جاهز في المستودع (الأسرع)

```bash
cd watch_together
node tools/turn/check.mjs https://your-endpoint/turn --origin https://your-site.com --stun
```

يفحص: الاستجابة والشكل، فؤوس CORS، وجود `turn:`/`turns:`، بيانات الاعتماد، انتهاء
صلاحيتها، وردّ خادم TURN فعلياً على الشبكة (STUN Binding). يعيد `0` عند النجاح
و`1` عند وجود مشكلة — صالح للتشغيل في CI بعد النشر.

لفحص بيانات ثابتة (قبل بناء الخادم):
```bash
node tools/turn/check.mjs --servers '[{"urls":"turn:host:3478","username":"u","credential":"p"}]'
```


### 8.1 اختبار نقطة النهاية (قبل المتصفح)
```bash
curl -i -X POST https://your-endpoint/turn \
  -H 'Origin: https://your-site.com' \
  -H 'Content-Type: application/json' -d '{}'
```
المتوقّع: `200` + `Access-Control-Allow-Origin` + مصفوفة فيها عنصر واحد على الأقل `"urls": "turn:…"`.

### 8.2 اختبار الوصول إلى TURN من المتصفح (بلا مكالمة)
افتح موقعك، وفي Console:
```js
(async () => {
  const list = await (await fetch('https://your-endpoint/turn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).json();
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(list) ? list : list.iceServers });
  pc.createDataChannel('probe');
  pc.onicecandidate = (e) => e.candidate && console.log(e.candidate.type, e.candidate.candidate);
  await pc.setLocalDescription(await pc.createOffer());
  setTimeout(() => pc.close(), 12000);
})();
```
**المطلوب:** أن ترى سطراً يبدأ بـ **`relay`**. إن ظهر `host` و`srflx` فقط ⇒ TURN لا
يُستخدم (بيانات خاطئة، أو منفذ محجوب، أو `urls` ليست `turn:`).

### 8.3 مكالمة حقيقية (الأهم)
| السيناريو | المتوقّع |
|-----------|----------|
| جهازان على نفس الواي فاي | تعمل (قد تكون مباشرة بلا TURN) |
| هاتف على بيانات + حاسوب على واي فاي | تعمل — **هذا هو اختبار TURN الحقيقي** |
| هاتفان على شبكتي جوال مختلفتين | تعمل |
| شبكة مؤسسة/جامعة مقيّدة | تعمل عبر TCP/TLS 443 |
| `chrome://webrtc-internals` أثناء المكالمة | وجود مسار `relay` عند الحاجة |

تلميح: أثناء المكالمة افتح `chrome://webrtc-internals` وابحث عن `candidate-pair` بحالة
`succeeded` واكتب نوعه؛ `relay` = TURN يعمل.

---

## 9) السعة والتكلفة (أرقام واقعية)

- مكالمة صوتية Opus ≈ **32 ك.بت/ث** لكل اتجاه، ومع أعباء RTP ≈ **36 ك.بت/ث**.
- عند الترحيل يمر الصوت في الاتجاهين ≈ **72 ك.بت/ث ≈ 32 م.ب/ساعة**.
- **20 غ.ب/شهر** (Metered المجاني) ≈ **~600 ساعة مكالمة مُرحّلة** شهرياً.
- **فقط** المكالمات التي تفشل مباشرة تُرحّل — لا تُحسب المكالمات الناجحة P2P.

لذلك: للاختبار والإطلاق المبكر، الحصة المجانية كافية جداً. عند النمو، إمّا خطة مدفوعة
من المزوّد، أو coturn على VPS صغير (النطاق الترددي غالباً أرخص من التسعير بالغ.ب).

---

## 10) تشخيص الأخطاء

| العَرَض | السبب المرجّح | الحل |
|---------|----------------|------|
| «تعذّر جلب بيانات TURN» في شاشة الرنين | CORS أو 401/502 أو DNS | اختبر بالـ`curl`؛ أضف `OPTIONS` + `Allow-Origin` |
| يعمل على الواي فاي فقط | لا يوجد `relay` | تحقّق من `urls` تبدأ بـ`turn:`/`turns:`، ومن فتح المنافذ |
| `401 Unauthorized` من TURN | بيانات منتهية أو خاطئة | مدّة صلاحية أطول قليلاً (10–30 د) أو سرّ صحيح |
| يعمل على أندرويد لا iOS | صلاحية الميكروفون/HTTPS | HTTPS صالح + ضغطة المستخدم على «قبول» |
| كل المكالمات تُرحّل (بطيئة) | TURN يُفرض دائماً | تأكّد من وجود STUN مع TURN (موجود افتراضياً) |
| توقّف بعد أسابيع | تجاوز الحصة | راقب لوحة المزوّد أو فعّل coturn |

---

## 11) التراجع بأمان

```js
calls: { turnFetchUrl: null }
```
فيعود الموقع إلى STUN فقط — لا كسر، ولا تغيير في قاعدة البيانات. صفوف المكالمات
وإشاراتها تُنظَّف تلقائياً على الخادم.

---

## 12) قائمة تحقّق نهائية

- [ ] `09-calls.sql` منفّذ (وإلا سيظهر «غير مفعّلة بعد»).
- [ ] حساب TURN + مفتاح سري على الخادم.
- [ ] نقطة النهاية تعيد الشكل الصحيح، وتجيب `OPTIONS`.
- [ ] `turnFetchUrl` مضبوط في `config.js` ومنشور.
- [ ] اختبار `relay` في Console ناجح.
- [ ] مكالمة بين شبكتين مختلفتين ناجحة (صوت واضح بلا تقطيع).
- [ ] HTTPS على النطاق (شرط الميكروفون).
- [ ] مراقبة الاستهلاك مفعّلة.

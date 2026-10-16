# 🚀 دليل النشر على الاستضافات

المشروع يعمل على ثلاثة أنواع من الاستضافة. اختر ما يناسبك — **الصفحات نفسها لا تتغير**،
فقط طريقة وصولها إلى طبقة المزامنة.

---

## الخيار أ) استضافة عادية ثابتة (cPanel / Netlify / GitHub Pages / Vercel / Cloudflare Pages)

**الأبسط والأرخص** — لا تحتاج خادم Java.

### cPanel (استضافة مشتركة)
1. ادخل **File Manager** → `public_html`.
2. ارفع **محتويات** مجلد `watch_together/` (وليس المجلد نفسه) حتى يصبح:
   ```
   public_html/index.html
   public_html/room.html
   public_html/assets/...
   ```
   > إن أردت وضعه في مجلد فرعي: `public_html/watch/` ثم الرابط `https://نطاقك.com/watch/`.
     كل الروابط في المشروع **نسبية** فتعمل بدون تعديل.
3. نفّذ [`docs/sql/02-schema.sql`](02-schema.sql) في Supabase (راجع [`supabase-setup.md`](supabase-setup.md)).
4. افتح الموقع → الشارة يجب أن تقول «Supabase متصل ✓».

### GitHub Pages / Netlify / Vercel / Cloudflare Pages
```bash
# من جذر المستودع
git push            # ثم فعّل Pages/Deploy واجعل جذر النشر: watch_together/
```
- **GitHub Pages:** Settings → Pages → Branch `main` → مجلد `/watch_together`.
- **Netlify:** Base directory = `watch_together`، Build command = (اتركه فارغاً).
- **Vercel:** Root Directory = `watch_together`، Framework = Other.

> ⚠️ **مهم:** هذه الاستضافات تعمل بـ **HTTPS** وهذا مطلوب لعمل `navigator.clipboard`
> (نسخ رابط الغرفة) و WebSocket الخاص بـ Supabase Realtime.

---

## الخيار ب) استضافة تدعم Java (VPS / Tomcat / Jetty / Render / Railway)

### تشغيل مباشر على VPS
```bash
cd watch_together/java-server
./build.sh && ./run.sh                 # المنفذ الافتراضي 8080
PORT=80 java -cp out com.watchtogether.Main
```
اجعله يعمل دائماً:
```bash
# systemd: /etc/systemd/system/watchtogether.service
[Unit]
Description=WatchTogether
After=network.target

[Service]
WorkingDirectory=/var/www/bmatm/watch_together/java-server
ExecStart=/usr/bin/java -Dfile.encoding=UTF-8 -cp out com.watchtogether.Main
Environment=PORT=8080
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now watchtogether
```

### خلف Nginx (مع HTTPS — مطلوب للمشاركة خارج شبكتك)
```nginx
server {
    listen 443 ssl http2;
    server_name watch.example.com;

    ssl_certificate     /etc/letsencrypt/live/watch.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/watch.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;                 # ← مطلوب لـ WebSocket
        proxy_set_header Upgrade $http_upgrade; # ← مطلوب لـ WebSocket
        proxy_set_header Connection "upgrade";  # ← مطلوب لـ WebSocket
        proxy_read_timeout 3600s;               # لا تقطع الاتصالات الطويلة
        proxy_buffering off;
    }
}
```
ثم `sudo certbot --nginx -d watch.example.com`.

### Tomcat (WAR) — ملاحظة
الخادم المرفق يستخدم `com.sun.net.httpserver` (JDK فقط) وهو **ليس WAR**.
إن كانت استضافتك لا تقبل إلا WAR:
1. انسخ `index.html` و `room.html` و `assets/` إلى `src/main/webapp/` في مشروع Spring Boot.
2. استبدل `WebSocketServer.java` بـ `@ServerEndpoint("/ws")` من `jakarta.websocket`
   (منطق `RoomStore.java` ينتقل كما هو تقريباً).
3. أو الأسهل: استخدم **الخيار أ** (استضافة ثابتة + Supabase) ولا تحتاج WAR إطلاقاً.

---

## الخيار ج) تجربة محلية / شبكة منزلية

```bash
cd watch_together/java-server && ./run.sh
```
الخادم يطبع عناوين الشبكة المحلية، مثال:
```
▸ http://localhost:8080/
▸ http://192.168.1.25:8080/
```
أرسل `http://192.168.1.25:8080/room.html?id=XXXXXX` لصديقك على نفس الشبكة — يعمل فوراً.

### بدون Java (وضع محلي)
```bash
cd watch_together && python3 -m http.server 8080
```
يعمل الموقع في **الوضع المحلي**: المزامنة بين تبويبات نفس الجهاز فقط (للتجربة والتصميم).

---

## جدول مقارنة سريع

| | استضافة ثابتة + Supabase | سيرفر Java | الوضع المحلي |
|---|---|---|---|
| يحتاج خادم Java | لا | نعم | لا |
| مستخدمون من أماكن مختلفة | ✅ | ✅ | ❌ (نفس الجهاز) |
| حفظ الرسائل بعد الإغلاق | ✅ (في قاعدة البيانات) | ⚠️ في الذاكرة فقط | ⚠️ في المتصفح |
| التكلفة | مجاني حتى 500MB | VPS (~5$) | مجاني |
| صعوبة الإعداد | سهلة (SQL مرة واحدة) | متوسطة | صفر |

---

## ✅ قائمة تحقق قبل النشر

- [ ] `assets/js/config.js` يحتوي `url` و `anonKey` الصحيحين لمشروعك (أو `javaServer.enabled = true`).
- [ ] تم تنفيذ `docs/sql/02-schema.sql` في Supabase (إذا اخترت الخيار أ).
- [ ] الموقع يعمل بـ **HTTPS** (مطلوب للنسخ والـ WebSocket).
- [ ] فتحت `index.html` → الشارة تقول «Supabase متصل ✓» أو «سيرفر Java متاح ✓».
- [ ] أنشأت غرفة → نسخت الرابط → فتحته في **نافذة تصفح خاصة** → ظهرت نافذة إدخال الاسم.
- [ ] شغّلت/أوقفت الفيديو في نافذة → تحرّك في النافذة الثانية خلال ثانية.
- [ ] أرسلت رسالة دردشة → ظهرت في النافذة الثانية.
- [ ] اختبرت على **الهاتف** (الشاشة الصغيرة + زر الدردشة العائم).

---

## 🩺 لم تظهر التغييرات بعد الرفع؟

راجع **[`troubleshooting.md`](troubleshooting.md)** — يشرح بالترتيب:
الفرع الصحيح، كاش المتصفح (مع اختصارات iPhone/Android)، بنية المجلدات على
cPanel/Netlify/Vercel/GitHub Pages، فحص الملفات المفقودة، وفحص اتصال Supabase.

**قاعدة ذهبية:** بعد كل تعديل ارفع رقم الإصدار `?v=` في الصفحات الثلاث،
واضغط `Ctrl+Shift+R` (أو افتح تبويباً خاصاً على الهاتف).

---

## 🔧 نصائح أداء

- الملفات في `assets/vendor/` (~430KB) تُخزَّن مؤقتاً لمدة ساعة عبر ترويسات الخادم المرفق.
- إن كانت استضافتك لا تضغط الملفات: فعّل **gzip/Brotli** من cPanel (Optimize Website).
- قلّل `sync.heartbeatMs` إلى 2500 للمزامنة الأدق، أو ارفعه إلى 6000 لتقليل الطلبات.
- للدردشة الكثيفة ارفع `chat.historyLimit` (يحدّ عدد الرسائل في DOM).

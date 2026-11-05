# تشغيل سيرفر Java على ويندوز عبر CMD (خطوة بخطوة)

هذا الدليل لمن يريد تشغيل `java-server` على ويندوز ليفعل:
مزامنة الغرف عبر WebSocket، واستخراج الروابط (`/api/resolve`)،
و**اقتراحات بقية الصيغ عبر yt-dlp** (`/api/suggest`).

---

## 0) افتح موجه الأوامر
<kbd>Win</kbd> + <kbd>R</kbd> ← اكتب `cmd` ← <kbd>Enter</kbd>
(أو «PowerShell» — نفس الأوامر تعمل.)

---

## 1) تثبيت Java (JDK 11 فأحدث)

تحقق أولاً — ربما مثبّت عندك:
```bat
java -version
javac -version
```
إن ظهر إصدار (مثال `21.0.x`) **تجاوز هذه الخطوة**. إن ظهر
«ليس أمراً داخلياً أو خارجياً» فثبّته:

**الطريقة السريعة:**
```bat
winget install EclipseAdoptium.Temurin.21.JDK
```
**أو يدوياً:** من https://adoptium.net ← Windows x64 ← MSI ← فعّل خياري
*Set JAVA_HOME variable* و *Add to PATH*.

> ⚠️ بعد التثبيت **أغلق نافذة CMD وافتح نافذة جديدة** حتى تُقرأ المتغيرات.

إن كان `java` يعمل و`javac` لا (يحدث عند تثبيت JRE فقط)، أضف مسار JDK يدوياً:
```bat
dir "C:\Program Files\Eclipse Adoptium"
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot"
setx PATH "%PATH%;%JAVA_HOME%\bin"
```
ثم **نافذة CMD جديدة** وتحقق: `javac -version`

---

## 2) جلب المشروع

بـ Git:
```bat
cd %USERPROFILE%\Desktop
git clone https://github.com/TaharBn12/bmatm.git
cd bmatm\watch_together\java-server
```
أو بدون Git: من GitHub ← **Code** ← **Download ZIP** ← فك الضغط، ثم:
```bat
cd C:\Users\اسمك\Downloads\bmatm-main\watch_together\java-server
```

---

## 3) البناء والتشغيل

```bat
build.bat
run.bat
```

سيطبع السيرفر قائمة الروابط، منها:
```
مجلة الموقع  : …\watch_together
الاستماع على : 0.0.0.0:8080
WebSocket    : /ws
الحالة       : /api/stats
افتح في المتصفح:
  ▸ http://localhost:8080/
```
افتح **http://localhost:8080** — السيرفر يقدّم الموقع كاملاً من المجلد الأب.

**تغيير المنفذ** (إن كان 8080 مشغولاً):
```bat
set PORT=3000
run.bat
```

**الإيقاف:** <kbd>Ctrl</kbd> + <kbd>C</kbd>

---

## 4) Python و yt-dlp (مطلوبان للاقتراحات والاستخراج)

```bat
python --version
```
إن لم يكن مثبتاً: `winget install Python.Python.3.12` (ثم نافذة جديدة)، أو من
https://www.python.org/downloads — وفعّل **Add python.exe to PATH**.

ثم ثبّت yt-dlp وحدّثه:
```bat
python -m pip install -U yt-dlp
yt-dlp --version
```

> السيرفر يبحث عن المترجم تلقائياً بالترتيب:
> `WT_PYTHON` (إن ضبطته) ← `python3` ← `python` ← `py -3`
> فلا يفشل على ويندوز. لتثبيته يدوياً: `set WT_PYTHON=python`

---

## 5) التحقق من الخدمات

```bat
curl http://localhost:8080/healthz
curl http://localhost:8080/api/stats
```
اختبار الاستخراج:
```bat
curl -X POST http://localhost:8080/api/resolve -H "Content-Type: application/json" -d "{\"url\":\"https://www.dailymotion.com/video/x8v9qk\"}"
```
اختبار الاقتراحات (الصيغ غير اليوتيوب):
```bat
curl -X POST http://localhost:8080/api/suggest -H "Content-Type: application/json" -d "{\"url\":\"https://example.com/video.mp4\",\"limit\":6}"
```

---

## 6) تشغيل دائم (اختياري)

مهمة مجدولة عند تسجيل الدخول:
- **Program/script:** `java`
- **Arguments:** `-Dfile.encoding=UTF-8 -cp out com.watchtogether.Main`
- **Start in:** `C:\Users\اسمك\Desktop\bmatm\watch_together\java-server`

أو كخدمة ويندوز بحزمة NSSM: `nssm install WatchTogether`.

---

## 7) استكشاف الأخطاء

| العَرَض | السبب | الحل |
|---|---|---|
| `javac ليس أمراً…` | JDK غير مثبّت أو ليس في PATH | خطوة 1 |
| `Address already in use` | المنفذ 8080 مشغول | `set PORT=3000` ثم `run.bat` |
| الصفحة تفتح لكن المزامنة لا تعمل | فتحت الملفات مباشرة بدل السيرفر | افتح `http://localhost:8080` لا `file://` |
| `خدمة الاستخراج غير متاحة` | yt-dlp أو Python غير مثبت | خطوة 4 |
| `/api/suggest` يرجع قائمة فارغة | الرابط موقع غير مدعوم أو خاص | جرّب رابطاً عاماً، وحدّث yt-dlp |
| لا وصول من جهاز آخر | الجدار الناري | اسمح لـ java في «السماح بتطبيق عبر الجدار الناري» |

للمشاركة خارج شبكتك (HTTPS + نطاق) راجع `docs/deployment.md` — الخيار ب.
وعلى استضافة ثابتة (Supabase) لا تحتاج هذا السيرفر إلا لميزات yt-dlp.

/* =========================================================
   WatchTogether — الإعدادات (config.js)
   عدّل هذا الملف فقط؛ كل شيء آخر يعمل تلقائياً.
   ========================================================= */
window.WT_CONFIG = {
  appName: 'WatchTogether — شاهدوا معاً',

  /* بصمة الإصدار: تظهر في لوحة الأوامر (Ctrl+K) وفي نافذة الاختصارات (؟).
     غيّرها عند كل نشر لتتأكّد أن متصفحك يعرض النسخة الجديدة لا نسخة مخزّنة. */
  build: '2026-10-23.4',

  /* ---------- 1) Supabase (للاستضافة العادية: cPanel / Netlify / GitHub Pages) ----------
     Dashboard → Project Settings → API
     الجدول يجب أن يكون منشأً من docs/sql/02-schema.sql */
  supabase: {
    url: 'https://cazwkhcbkzhnsluuafwz.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhendraGNia3pobnNsdXVhZnd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5NDQ3ODIsImV4cCI6MjA4MzUyMDc4Mn0.u1l9BrzI7ZA9P3CSdXN0tYkHu1TUNTGsqczByNSPUN0',
    ready: true,      /* هل نفّذت docs/sql/02-schema.sql ؟ إذا لا اجعلها false */
    auth: true        /* تفعيل تسجيل الدخول/إنشاء الحساب عبر Supabase Auth */
  },

  /* ---------- 2) المصادقة ---------- */
  auth: {
    /* يجب أن يكون لكل مشارك حساب مسجّل؛ لا يوجد دخول كضيف أو باسم مؤقت. */
    required: true,
    allowGuest: false,
    rememberName: true,        /* تذكّر الاسم في المتصفح */
    timeoutMs: 6000            /* مهلة طلب الحساب؛ لا يجمّد الدخول عند انقطاع الشبكة */
  },

  /* ---------- 3) سيرفر Java (للاستضافة التي تدعم Java: Tomcat / VPS) ----------
     يُكتشف تلقائياً على ws(s)://نفس-النطاق/ws عند فتح الموقع عبر السيرفر */
  javaServer: {
    enabled: true,
    url: null,          /* null = اكتشاف تلقائي، أو 'wss://example.com/ws' */
    timeoutMs: 2500
  },

  /* ---------- 4) المزامنة (حساسة جداً) ---------- */
  sync: {
    persistMs: 5000,        /* ⏱ رفع حالة الغرفة إلى قاعدة البيانات كل 5 ثوانٍ */
    pollMs: 2500,           /* ⏱ شبكة أمان: سؤال قاعدة البيانات كل 2.5 ثانية (إن تعطّل Realtime) */
    heartbeatMs: 5000,      /* نبضة المزامنة الدورية */
    driftTolerance: 0.8,    /* فرق الثواني المسموح قبل التصحيح الناعم */
    hardDrift: 2.5,         /* فرق كبير → قفزة فورية إلى الوقت الصحيح */
    driftCheckMs: 2000,     /* كم مرة نفحص الانحراف */
    lateJoinCatchup: true   /* من ينضم لاحقاً يأخذ الوقت الحالي من آخر حالة محفوظة */
  },

  /* ---------- 5) الرسائل ---------- */
  chat: {
    maxLength: 600,
    historyLimit: 250,
    cooldownMs: 350,
    reactions: ['👍', '❤️', '😂', '😮', '🔥', '👏', '🍿']   /* خيارات التفاعل مع الرسائل */
  },

  /* ---------- 6) الغرف ---------- */
  room: {
    codeLength: 6,           /* طول كود الغرفة، مثال: 8F3K2Q */
    presenceMs: 3000,        /* نبضة الحضور (المنضمون الحقيقيون) */
    presenceTimeoutMs: 12000 /* اعتبار المشارك منقطعاً بعد هذه المدة */
  },

  /* ---------- 7) المكالمات الصوتية (WebRTC) ----------
     الصوت ينتقل مباشرة بين الجهازين ولا يُخزَّن. الإشارات فقط عبر Supabase.
     ⚠️ مطلوب لنجاح المكالمات على شبكات الجوال: TURN (خدمة مُدارة أو coturn).
     لا تضع مفاتيح سرية هنا؛ استخدم رابطاً على خادمك يعيد بيانات مؤقتة:
       turnFetchUrl: 'https://your-endpoint.example/turn'
     يقبل ثلاث صيغ: {urls,username,credential} · [{urls,...},...] · {iceServers:[...]}
     أو بيانات ثابتة لمزوّد يسمح بذلك:
       turn: { urls: ['turn:turn.example.com:3478'], username: '...', credential: '...' }
     التفصيل خطوة بخطوة: docs/turn-setup.md
     نفّذ docs/sql/09-calls.sql أولاً. */
  calls: {
    enabled: true,
    ringTimeoutMs: 45000,        /* مهلة الرنين قبل اعتبارها فائتة */
    signalPollMs: 900,           /* سرعة تبادل الإشارات أثناء الرنين والاتصال */
    signalPollActiveMs: 2600,    /* أثناء المكالمة: نكتفي بفحص الانتهاء */
    maxCallMs: 7200000,          /* سقف أمان للمكالمة (ساعتان) */
    vibrate: true,               /* اهتزاز الهاتف مع الرنين والردّ والإنهاء (أندرويد) */
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    /* TURN — ثلاث طرق، اختر واحدة:
       1) الإنتاج (الأفضل): turnFetchUrl إلى وسيطك فيعيد بيانات مؤقتة.
          المضبوط أدناه هو دالة Supabase Edge Function المنشورة باسم wt-turn
          (المصدر: tools/turn/supabase-edge.ts). المفتاح الحقيقي يعيش في
          Supabase → Edge Functions → Secrets ولا يصل إلى المتصفح أبداً:
            ALLOWED_ORIGIN  أصول موقعك مفصولة بفاصلة
            METERED_APP + METERED_KEY   ← بيانات مؤقتة (الأفضل)
            TURN_STATIC                 ← بديل JSON إن لم يكن عندك مفتاح API
          قبل ضبط السرّ تعيد الدالة 503، فيرتدّ العميل تلقائياً إلى
          turn.local.js ثم إلى STUN — لا تتعطّل المكالمة.
       2) تجربة على جهازك فقط: من كونسول المتصفح (لا يدخل المستودع):
            window.WT_TURN_OVERRIDE = [
              { urls: 'stun:stun.relay.metered.ca:80' },
              { urls: 'turn:global.relay.metered.ca:80', username: '...', credential: '...' },
              { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '...', credential: '...' }
            ];
       3) turn ثابت هنا: ممنوع على موقع عام — كل زائر يقرأه ويستهلك حصّتك.
          (اختبارات المشروع تُفشل البناء إن وُجدت credential مضمّنة.) */
    turn: null,                  /* { urls, username, credential } — للتجربة المحلية فقط */
    turnFetchUrl: 'https://cazwkhcbkzhnsluuafwz.supabase.co/functions/v1/wt-turn',
    turnFetchTimeoutMs: 5000     /* لا نُبطئ بدء المكالمة إن تعطّل الخادم */
  },

  /* ---------- 8) الوسائط (صور وفيديو في دردشة الغرفة) ----------
     الموقع المضمون هو Supabase Storage داخل مشروعك (دائم وسريع)،
     وإن فشل ينتقل العميل تلقائياً عبر البدائل المجانية بالترتيب. */
  media: {
    enabled: true,
    maxImageMB: 12,          /* أقصى حجم للصورة */
    maxVideoMB: 80,          /* أقصى حجم للفيديو */
    maxPerMessage: 4,        /* أقصى عدد ملفات في رسالة واحدة */
    supabaseBucket: 'wt-room-media',   /* دلو التخزين في Supabase (ينشئه 08-room-media.sql) */
    providers: ['supabase', '0x0', 'pixeldrain', 'catbox', 'gofile', 'oshi', 'litterbox', 'tmpfiles', 'fileio', 'uguu'],
    /* مزوّدون مدعومون (الترتيب = أولوية المحاولة):
         supabase  → Supabase Storage — الموقع المضمون: مساحة دائمة داخل مشروعك
         0x0       → 0x0.st (مجاني دائم — حتى 512 م.ب، مفتوح المصدر)
         pixeldrain→ pixeldrain.com (مجاني دائم — حتى 20 غ.ب)
         catbox    → catbox.moe (مجاني دائم — أحياناً يتعطّل فيُجرَّب التالي)
         gofile    → gofile.io (مجاني دائم — ملفات كبيرة، بلا حساب)
         oshi      → oshi.at (مجاني — حتى 5 غ.ب، 14 يوماً)
         litterbox → litterbox.catbox.moe (موثوق — يحفظ الملف 72 ساعة)
         tmpfiles  → tmpfiles.org (مجاني — يحفظ الملف 7 أيام)
         fileio    → file.io (مؤقّت 14 يوماً — آخر البدائل السريعة)
         uguu      → uguu.se (مؤقّت 3 ساعات — آخر حل في السلسلة) */
  }
};

/* =========================================================
   WatchTogether — الإعدادات (config.js)
   عدّل هذا الملف فقط؛ كل شيء آخر يعمل تلقائياً.
   ========================================================= */
window.WT_CONFIG = {
  appName: 'WatchTogether — شاهدوا معاً',

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
    /* true  = يجب تسجيل الدخول قبل إنشاء غرفة (صفحة auth.html)
       false = الدخول بالاسم فقط كافٍ (الوضع الأبسط) */
    required: false,
    allowGuest: true,          /* السماح بالدخول كضيف بدون حساب */
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

  /* ---------- 7) الوسائط (صور وفيديو في دردشة الغرفة) ----------
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

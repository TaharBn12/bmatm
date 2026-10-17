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
  }
};

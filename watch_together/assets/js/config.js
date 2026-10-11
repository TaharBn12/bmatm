/* =========================================================
   WatchTogether — إعدادات الموقع
   عدّل القيم هنا فقط. كل شيء آخر يعمل تلقائياً.
   ========================================================= */
window.WT_CONFIG = {
  /* اسم التطبيق الظاهر في الواجهات */
  appName: 'WatchTogether — شاهدوا معاً',

  /* ---------- 1) إعدادات Supabase (للاستضافة العادية: cPanel / Netlify / GitHub Pages) ----------
     Dashboard → Project Settings → API
     اتركها كما هي (تم وضع مفاتيحك) أو استبدلها بمشروعك. */
  supabase: {
    url: 'https://cazwkhcbkzhnsluuafwz.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhendraGNia3pobnNsdXVhZnd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5NDQ3ODIsImV4cCI6MjA4MzUyMDc4Mn0.u1l9BrzI7ZA9P3CSdXN0tYkHu1TUNTGsqczByNSPUN0',
    /* هل أنشأت الجداول من ملف supabase/schema.sql ؟ إذا لا → اتركها false */
    ready: true
  },

  /* ---------- 2) إعدادات سيرفر Java (للاستضافة التي تدعم Java: Tomcat / VPS) ----------
     إذا فتحت الموقع عبر سيرفر Java المرفق في مجلد java-server/
     سيتم اكتشافه تلقائياً على ws(s)://نفس-النطاق/ws — لا حاجة للتعديل. */
  javaServer: {
    enabled: true,
    /* اتركه null للاستخدام التلقائي (نفس النطاق)، أو ضع رابطاً صريحاً:
       url: 'wss://example.com/ws' */
    url: null,
    timeoutMs: 2500
  },

  /* ---------- 3) المزامنة ---------- */
  sync: {
    heartbeatMs: 4000,     /* نبضة المضيف كل كم ميلي ثانية */
    driftTolerance: 1.2,   /* فرق الثواني المسموح قبل التصحيح التلقائي */
    hardDrift: 3.0         /* فرق كبير → قفزة فورية بدون تدريج */
  },

  chat: {
    maxLength: 600,
    historyLimit: 200,
    cooldownMs: 400        /* حماية من الإغراق */
  },

  room: {
    codeLength: 6          /* طول كود الغرفة، مثال: 8F3K2Q */
  }
};

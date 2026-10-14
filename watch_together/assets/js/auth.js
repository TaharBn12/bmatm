/* =========================================================
   WatchTogether — المصادقة (auth.js)
   تسجيل / دخول عبر Supabase Auth (GoTrue REST) بدون أي مكتبة.
   ---------------------------------------------------------
   • يُخزَّن اسم العرض في user_metadata.full_name
   • الجلسة في localStorage (wt:session) مع تجديد تلقائي
   • إن لم يكن Supabase مفعّلاً → الموقع يعمل كضيف بدون تسجيل
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;
  const cfg = () => (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};

  function enabled() {
    const c = cfg();
    const a = (global.WT_CONFIG && global.WT_CONFIG.auth) || {};
    return !!(c && c.url && c.anonKey && c.auth !== false && a.disabled !== true);
  }

  function base() { return cfg().url.replace(/\/$/, ''); }

  function headers(extra) {
    return Object.assign({
      'apikey': cfg().anonKey,
      'Authorization': 'Bearer ' + cfg().anonKey,
      'Content-Type': 'application/json'
    }, extra || {});
  }

  async function req(path, options) {
    options = options || {};
    const token = options.token || cfg().anonKey;
    const res = await fetch(base() + path, {
      method: options.method || 'POST',
      headers: headers({ 'Authorization': 'Bearer ' + token }),
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
      const err = new Error(translate(msg, data && data.code));
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  /** ترجمة أخطاء Supabase الشائعة إلى عربية */
  function translate(msg, code) {
    const m = String(msg || '').toLowerCase();
    if (m.includes('invalid login credentials') || code === 'invalid_credentials')
      return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    if (m.includes('already registered') || m.includes('already been registered'))
      return 'هذا البريد الإلكتروني مسجّل مسبقاً — سجّل الدخول بدلاً من ذلك';
    if (m.includes('email not confirmed'))
      return 'بريدك غير مؤكَّد بعد — تحقّق من صندوق الوارد (أو عطّل تأكيد البريد من Dashboard)';
    if (m.includes('password should be at least'))
      return 'كلمة المرور قصيرة جداً — 6 أحرف على الأقل';
    if (m.includes('unable to validate email'))
      return 'صيغة البريد الإلكتروني غير صحيحة';
    if (m.includes('rate limit') || m.includes('too many'))
      return 'محاولات كثيرة — انتظر دقيقة ثم أعد المحاولة';
    if (m.includes('failed to fetch') || m.includes('networkerror'))
      return 'تعذّر الاتصال بـ Supabase — تحقق من الإنترنت أو من إعدادات config.js';
    if (code === 'otp_expired') return 'انتهت صلاحية رمز التحقق — اطلب رمزاً جديداً';
    return msg || 'حدث خطأ غير متوقع';
  }

  /* ============================== الجلسة ============================== */
  function saveSession(s) {
    if (!s) return null;
    const session = {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: (s.expires_in ? Date.now() + s.expires_in * 1000 : (s.expires_at || 0)),
      user: {
        id: (s.user && s.user.id) || '',
        email: (s.user && s.user.email) || '',
        name: (s.user && s.user.user_metadata && (s.user.user_metadata.full_name || s.user.user_metadata.name)) || ''
      }
    };
    if (!session.user.name) session.user.name = session.user.email.split('@')[0] || 'مستخدم';
    U.store.set('session', session);
    return session;
  }

  function getSession() { return U.store.get('session', null); }

  function currentUser() {
    const s = getSession();
    return s && s.user ? s.user : null;
  }

  function clearSession() { U.store.del('session'); }

  let refreshing = null;
  async function refresh() {
    const s = getSession();
    if (!s || !s.refresh_token) return null;
    if (refreshing) return refreshing;
    refreshing = req('/auth/v1/token?grant_type=refresh_token', {
      body: { refresh_token: s.refresh_token }
    }).then(saveSession).catch((err) => {
      clearSession();
      throw err;                       // يلتقطه validSession
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  /** أعِد جلسة صالحة (يجدّد Token قبل انتهاء صلاحيته بدقيقة) — لا يرمي استثناءات أبداً */
  async function validSession() {
    try {
      const s = getSession();
      if (!s || !s.user) return null;
      if (!s.access_token) return s;                       // ضيف
      if (s.expires_at && s.expires_at - Date.now() < 60_000) {
        try { return await refresh(); } catch (e) { return getSession(); }
      }
      return s;
    } catch (e) { return null; }
  }

  /* ============================== العمليات ============================== */
  async function signUp(email, password, name) {
    if (!enabled()) throw new Error('المصادقة غير مفعّلة — اضبط supabase في config.js');
    const data = await req('/auth/v1/signup', {
      body: {
        email: String(email).trim(),
        password: String(password),
        data: { full_name: U.cleanName(name) || String(email).split('@')[0] }
      }
    });
    /* بعض المشاريع تؤكّد البريد تلقائياً → ترجع جلسة مباشرة */
    if (data && data.access_token) return saveSession(data);
    return { needsConfirmation: true };
  }

  async function signIn(email, password) {
    if (!enabled()) throw new Error('المصادقة غير مفعّلة — اضبط supabase في config.js');
    const data = await req('/auth/v1/token?grant_type=password', {
      body: { email: String(email).trim(), password: String(password) }
    });
    return saveSession(data);
  }

  async function signOut() {
    const s = getSession();
    try {
      if (s && s.access_token && enabled()) {
        await fetch(base() + '/auth/v1/logout', {
          method: 'POST',
          headers: headers({ 'Authorization': 'Bearer ' + s.access_token })
        });
      }
    } catch (e) { /* تجاهل */ }
    clearSession();
  }

  async function updateName(name) {
    const s = await validSession();
    if (!s) return null;
    const data = await req('/auth/v1/user', {
      method: 'PUT',
      token: s.access_token,
      body: { data: { full_name: U.cleanName(name) } }
    });
    const session = getSession();
    if (session && data && data.user_metadata) {
      session.user.name = data.user_metadata.full_name || session.user.name;
      U.store.set('session', session);
    }
    return session;
  }

  /** دخول كضيف (بدون حساب) — يعمل حتى بدون Supabase */
  function signInAsGuest(name) {
    const guest = {
      access_token: null, refresh_token: null, expires_at: 0,
      user: { id: 'guest-' + U.randomCode(8), email: '', name: U.cleanName(name) || 'زائر', guest: true }
    };
    U.store.set('session', guest);
    U.store.set('name', guest.user.name);
    return guest;
  }

  /** حارس الصفحة: يعيد المستخدم أو يحوّل لصفحة الدخول */
  async function requireUser(opts) {
    opts = opts || {};
    if (!enabled() || (global.WT_CONFIG.auth && global.WT_CONFIG.auth.required === false)) {
      const s = getSession();
      if (s && s.user) return s.user;
      return null;                     /* وضع الضيف: الصفحة تتكفّل بطلب الاسم */
    }
    const s = await validSession();
    if (s && s.user && s.user.id) return s.user;
    if (!opts.noRedirect) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.replace('auth.html?next=' + back);
    }
    return null;
  }

  /* تجديد دوري للجلسة */
  if (enabled()) {
    setInterval(() => {
      const s = getSession();
      if (s && s.expires_at && s.expires_at - Date.now() < 5 * 60 * 1000) refresh().catch(() => { });
    }, 60_000);
  }

  global.WTAuth = {
    enabled, signUp, signIn, signOut, updateName, signInAsGuest,
    getSession, validSession, currentUser, clearSession, requireUser
  };
})(typeof window !== 'undefined' ? window : globalThis);

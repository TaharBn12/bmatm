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
    const controller = global.AbortController ? new global.AbortController() : null;
    const authCfg = (global.WT_CONFIG && global.WT_CONFIG.auth) || {};
    let timer;
    /* المهلة تشمل قراءة الجسم أيضاً، ولا تعتمد على تعاون fetch مع abort. */
    try {
      return await Promise.race([
        (async () => {
          const res = await fetch(base() + path, {
            method: options.method || 'POST',
            headers: headers({ 'Authorization': 'Bearer ' + token }),
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller ? controller.signal : undefined
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
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('انتهت مهلة الاتصال بالحساب — تحقق من الإنترنت وأعد المحاولة');
            err.code = 'auth-timeout';
            reject(err);
            if (controller) controller.abort();
          }, authCfg.timeoutMs || 6000);
        })
      ]);
    } finally { clearTimeout(timer); }
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
    const previous = currentUser();
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
    if (previous && previous.id === session.user.id) {
      if (validAvatarPath(previous.avatar_path, previous.id)) session.user.avatar_path = previous.avatar_path;
      if (/^[a-z0-9_]{3,24}$/.test(previous.username || '')) session.user.username = previous.username;
    }
    const metadata = s.user && s.user.user_metadata;
    if (metadata && Object.prototype.hasOwnProperty.call(metadata,'avatar_path')) {
      session.user.avatar_path = validAvatarPath(metadata.avatar_path,session.user.id) ? metadata.avatar_path : null;
    }
    if (metadata && /^[a-z0-9_]{3,24}$/.test(metadata.wt_username || '')) session.user.username = metadata.wt_username;

    U.store.set('session', session);
    return session;
  }

  function getSession() { return U.store.get('session', null); }

  function currentUser() {
    const s = getSession();
    return s && s.user ? s.user : null;
  }

  /** Only a real Supabase account is accepted in rooms; legacy guest sessions are rejected. */
  function accountUser() {
    const s = getSession();
    return s && s.access_token && s.user && s.user.id && !s.user.guest && (!s.expires_at || s.expires_at > Date.now()) ? s.user : null;
  }

  function validAvatarPath(path, id) {
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '') &&
      new RegExp('^' + id + '/[a-f0-9]{48}\\.webp$').test(path || '');
  }

  function avatarURL(user) {
    user = user || currentUser();
    if (!user || !validAvatarPath(user.avatar_path, user.id || user.user_id)) return '';
    try {
      const url = new URL(cfg().url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      return url.href.replace(/\/$/, '') + '/storage/v1/object/public/wt-avatars/' + user.avatar_path;
    } catch (_) { return ''; }
  }

  /** Cache ONLY our server-returned profile; token/expiry/refresh fields stay unchanged. */
  function cacheProfile(profile) {
    const session = getSession();
    if (!session || !accountUser() || profile.user_id !== session.user.id) return false;
    session.user.name = U.cleanName(profile.display_name) || session.user.name;
    session.user.username = /^[a-z0-9_]{3,24}$/.test(profile.username || '') ? profile.username : '';
    session.user.avatar_path = validAvatarPath(profile.avatar_path, session.user.id) ? profile.avatar_path : null;
    U.store.set('session', session);
    return true;
  }

  function clearSession() {
    const user = currentUser();
    if (user && user.id) {
      try {
        Object.keys(global.localStorage).filter(k => k.startsWith('wt:dm-draft:' + user.id + ':') || k.startsWith('wt:dm-outbox:' + user.id + ':')).forEach(k => global.localStorage.removeItem(k));
      } catch (_) { /* storage may be blocked */ }
    }
    U.store.del('session');
  }

  let refreshing = null;
  async function refresh() {
    const s = getSession();
    if (!s || !s.refresh_token) return null;
    if (refreshing) return refreshing;
    refreshing = req('/auth/v1/token?grant_type=refresh_token', {
      body: { refresh_token: s.refresh_token }
    }).then(saveSession).catch((err) => {
      /* لا تُسجّل خروج المستخدم بسبب انقطاع الشبكة أو انتهاء المهلة. */
      if (err.status === 400 || err.status === 401 || err.status === 403) clearSession();
      throw err;                       // يلتقطه validSession
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  /** أعِد جلسة صالحة (يجدّد Token قبل انتهاء صلاحيته بدقيقة) — لا يرمي استثناءات أبداً */
  async function validSession() {
    try {
      const s = getSession();
      if (!s || !s.user || !s.access_token || !s.user.id || s.user.guest) {
        if (s && s.user && s.user.guest) clearSession();
        return null;
      }
      if (s.expires_at && s.expires_at - Date.now() < 60_000) {
        try { return await refresh(); } catch (e) {
          const current = getSession();
          return current && (!current.expires_at || current.expires_at > Date.now()) ? current : null;
        }
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
        await req('/auth/v1/logout', { token: s.access_token });
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

  /** حارس الصفحة: لا يسمح إلا بجلسة حساب حقيقية. */
  async function requireUser(opts) {
    opts = opts || {};
    const s = await validSession();
    if (s && s.access_token && s.user && s.user.id && !s.user.guest && (!s.expires_at || s.expires_at > Date.now())) return s.user;
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
    enabled, signUp, signIn, signOut, updateName,
    getSession, validSession, currentUser, accountUser, clearSession, requireUser, avatarURL, cacheProfile
  };
})(typeof window !== 'undefined' ? window : globalThis);

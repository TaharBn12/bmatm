/* =========================================================
   WatchTogether — منطق صفحة الدخول/التسجيل (auth-page.js)
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const Auth = window.WTAuth;
  const $ = (id) => document.getElementById(id);

  const el = {
    tabLogin: $('tabLogin'), tabSignup: $('tabSignup'),
    loginForm: $('loginForm'), signupForm: $('signupForm'), guestForm: $('guestForm'),
    loginEmail: $('loginEmail'), loginPass: $('loginPass'), loginError: $('loginError'), loginBtn: $('loginBtn'),
    signupName: $('signupName'), signupEmail: $('signupEmail'), signupPass: $('signupPass'),
    signupError: $('signupError'), signupBtn: $('signupBtn'),
    guestName: $('guestName'), guestBtn: $('guestBtn'),
    meterFill: $('meterFill'), meterLabel: $('meterLabel')
  };

  const params = new URLSearchParams(location.search);
  const nextUrl = params.get('next') || 'index.html';
  const roomParam = params.get('room');

  /* إذا وصلنا من غرفة معيّنة → نعود إليها بعد الدخول */
  function destination() {
    if (roomParam && /^[a-z0-9]{4,12}$/i.test(roomParam)) return 'room.html?id=' + encodeURIComponent(roomParam);
    try {
      const root = new URL('.', location.href), next = new URL(nextUrl, root);
      const file = next.pathname.slice(root.pathname.length);
      if (next.origin === root.origin && next.pathname === root.pathname + file &&
        ['index.html', 'room.html', 'profile.html', 'friends.html', 'messages.html'].includes(file)) return file + next.search + next.hash;
    } catch (_) { /* never follow an external or malformed return URL */ }
    return 'index.html';
  }

  /* ---------- إن كان مسجلاً مسبقاً → حوّله مباشرة ---------- */
  (async function autoForward() {
    await Auth.validSession();
    const u = Auth.currentUser(), session = Auth.getSession();
    if (!params.has('reauth') && u && u.id && !u.guest && session.access_token && (!session.expires_at || session.expires_at > Date.now())) {
      if (el.guestName) el.guestName.value = u.name || '';
      U.toast('أنت مسجّل الدخول بالفعل — جارٍ التحويل…', 'success', 1500);
      setTimeout(() => location.replace(destination()), 700);
    } else if (u && u.name && el.guestName) {
      el.guestName.value = u.name;
    } else {
      const saved = U.store.get('name', '');
      if (saved && el.guestName) el.guestName.value = saved;
      if (saved && el.signupName) el.signupName.value = saved;
    }
  })();

  /* ---------- تبديل التبويبات ---------- */
  function showTab(which) {
    const login = which === 'login';
    el.tabLogin.classList.toggle('is-active', login);
    el.tabSignup.classList.toggle('is-active', !login);
    el.tabLogin.setAttribute('aria-selected', login ? 'true' : 'false');
    el.tabSignup.setAttribute('aria-selected', login ? 'false' : 'true');
    el.loginForm.hidden = !login;
    el.signupForm.hidden = login;
    el.loginError.textContent = '';
    el.signupError.textContent = '';
    setTimeout(() => (login ? el.loginEmail : el.signupName).focus(), 60);
  }
  el.tabLogin.addEventListener('click', () => showTab('login'));
  el.tabSignup.addEventListener('click', () => showTab('signup'));
  if (params.get('mode') === 'signup') showTab('signup');

  /* ---------- إظهار/إخفاء كلمة المرور ---------- */
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.getAttribute('data-toggle'));
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = window.WTIcons.html(show ? 'eyeOff' : 'eye', 17);
      btn.classList.toggle('is-on', show);
    });
  });

  /* ---------- مؤشر قوة كلمة المرور ---------- */
  function scorePassword(v) {
    let s = 0;
    if (v.length >= 6) s++;
    if (v.length >= 10) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/\d/.test(v)) s++;
    if (/[^\w\s]/.test(v)) s++;
    return Math.min(s, 5);
  }
  el.signupPass.addEventListener('input', () => {
    const v = el.signupPass.value;
    const s = v ? scorePassword(v) : 0;
    const labels = ['قوة كلمة المرور', 'ضعيفة جداً', 'ضعيفة', 'متوسطة', 'جيدة', 'قوية'];
    const colors = ['rgba(255,255,255,.14)', '#ff5c72', '#ff8a5c', '#ffb020', '#7ee08a', '#2dd4a7'];
    el.meterFill.style.width = (s / 5 * 100) + '%';
    el.meterFill.style.background = colors[s];
    el.meterLabel.textContent = labels[s];
    el.meterLabel.style.color = s >= 4 ? colors[s] : '';
  });

  /* ---------- أدوات ---------- */
  function setLoading(btn, on, label) {
    btn.disabled = on;
    btn.dataset.html = btn.dataset.html || btn.innerHTML;
    btn.innerHTML = on
      ? '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> ' + U.esc(label || 'جارٍ التنفيذ…')
      : btn.dataset.html;
  }
  function fail(node, err) {
    node.textContent = (err && err.message) ? err.message : String(err || 'حدث خطأ');
    node.classList.remove('is-shake');
    void node.offsetWidth;                 // إعادة تشغيل الحركة
    node.classList.add('is-shake');
  }

  function afterAuth(user, msg) {
    U.store.set('name', user.name || '');
    U.toast(msg || ('أهلاً ' + user.name + ' ✓'), 'success', 1800);
    setTimeout(() => location.replace(destination()), 600);
  }

  /* ---------- تسجيل الدخول ---------- */
  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.loginError.textContent = '';
    const email = el.loginEmail.value.trim();
    const pass = el.loginPass.value;
    if (!email || !pass) { fail(el.loginError, new Error('أدخل البريد وكلمة المرور')); return; }

    setLoading(el.loginBtn, true, 'جارٍ الدخول…');
    try {
      const s = await Auth.signIn(email, pass);
      afterAuth(s.user);
    } catch (err) {
      fail(el.loginError, err);
      setLoading(el.loginBtn, false);
    }
  });

  /* ---------- إنشاء حساب ---------- */
  el.signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.signupError.textContent = '';
    const name = U.cleanName(el.signupName.value);
    const email = el.signupEmail.value.trim();
    const pass = el.signupPass.value;

    if (name.length < 2) { fail(el.signupError, new Error('أدخل اسماً من حرفين على الأقل')); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { fail(el.signupError, new Error('صيغة البريد الإلكتروني غير صحيحة')); return; }
    if (pass.length < 6) { fail(el.signupError, new Error('كلمة المرور 6 أحرف على الأقل')); return; }

    setLoading(el.signupBtn, true, 'جارٍ إنشاء الحساب…');
    try {
      const res = await Auth.signUp(email, pass, name);
      if (res && res.needsConfirmation) {
        setLoading(el.signupBtn, false);
        el.signupForm.innerHTML = `
          <div class="confirm-box">
            <span class="ic confirm-box__ic" data-icon="mail" data-size="30"></span>
            <h2 class="auth-form__title">تحقّق من بريدك</h2>
            <p class="auth-form__sub">أرسلنا رابط تأكيد إلى <b dir="ltr">${U.esc(email)}</b>.<br>
            بعد التأكيد سجّل الدخول من تبويب «تسجيل الدخول».</p>
            <p class="auth-note"><span class="ic" data-icon="info" data-size="15"></span>
              لتخطّي هذه الخطوة: Dashboard → Authentication → Providers → Email →
              أطفئ <b>Confirm email</b>.</p>
            <button class="btn btn--ghost btn--block" type="button" id="backToLogin">
              <span class="ic" data-icon="chevronRight" data-size="17"></span> رجوع
            </button>
          </div>`;
        window.WTIcons.apply(document);
        const back = document.getElementById('backToLogin');
        if (back) back.addEventListener('click', () => location.reload());
        return;
      }
      const session = Auth.getSession();
      afterAuth(session.user, 'تم إنشاء حسابك ✓ أهلاً ' + session.user.name);
    } catch (err) {
      fail(el.signupError, err);
      setLoading(el.signupBtn, false);
    }
  });

  /* ---------- دخول كضيف ---------- */
  el.guestForm.addEventListener('submit', (e) => {
    e.preventDefault();
    let name = U.cleanName(el.guestName.value);
    if (name.length < 2) {
      name = 'ضيف-' + U.randomCode(4);
      U.toast('لم تدخل اسماً — استخدمنا «' + name + '»', 'warn');
    }
    const g = Auth.signInAsGuest(name);
    afterAuth(g.user, 'أهلاً ' + g.user.name + ' ✓');
  });

  /* ---------- Enter ينتقل بين الحقول ---------- */
  [el.loginEmail, el.loginPass, el.signupName, el.signupEmail, el.signupPass].forEach((input) => {
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const form = input.closest('form');
      if (!form) return;
      const fields = Array.from(form.querySelectorAll('input:not([type=hidden])'));
      const i = fields.indexOf(input);
      if (i >= 0 && i < fields.length - 1) { e.preventDefault(); fields[i + 1].focus(); }
    });
  });

})();

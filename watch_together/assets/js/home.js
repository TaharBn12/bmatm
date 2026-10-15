/* =========================================================
   WatchTogether — الصفحة الرئيسية (home.js) — الإصدار 2
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const IC = window.WTIcons;
  const Auth = window.WTAuth;
  const $ = (id) => document.getElementById(id);
  if (new URLSearchParams(location.search).get('secure') === 'required') {
    setTimeout(() => U.toast('يلزم متصفح حديث لإنشاء مفتاح غرفة آمن — حدّث المتصفح ثم أعد المحاولة', 'warn', 7000), 100);
  }

  const els = {
    form: $('createForm'),
    url: $('videoUrl'),
    paste: $('pasteBtn'),
    preview: $('preview'),
    previewThumb: $('previewThumb'),
    previewKind: $('previewKind'),
    previewUrl: $('previewUrl'),
    name: $('hostName'),
    title: $('roomTitle'),
    createBtn: $('createBtn'),
    joinForm: $('joinForm'),
    joinCode: $('joinCode'),
    modeBadge: $('modeBadge'),
    navAuth: $('navAuth'),
    footerMode: $('footerMode')
  };

  /* ============================== الحساب في الشريط العلوي ============================== */
  function renderNavAuth() {
    if (!els.navAuth) return;
    const user = Auth && Auth.currentUser ? Auth.currentUser() : null;

    if (user && user.name) {
      els.navAuth.innerHTML =
        '<button class="user-chip" id="navUser" title="حسابي">' +
        '<span class="user-chip__av" style="background:' + U.colorFor(user.name) + '">' + U.esc(U.initials(user.name)) + '</span>' +
        U.esc(user.name) +
        '</button>' +
        '<a class="btn btn--sm btn--ghost" href="auth.html" id="navAuthBtn">' +
        '<span class="ic">' + IC.html('login', 16) + '</span> ' + (user.guest ? 'تسجيل الدخول' : 'حسابي') + '</a>';

      if (!els.name.value) els.name.value = user.name;
      $('navUser').addEventListener('click', () => { location.href = 'auth.html'; });
    } else {
      els.navAuth.innerHTML =
        '<a class="btn btn--sm btn--primary" href="auth.html">' +
        '<span class="ic">' + IC.html('login', 16) + '</span> إنشاء حساب / دخول</a>';
    }
  }

  /* ============================== استرجاع البيانات المحفوظة ============================== */
  (function prefill() {
    const user = Auth && Auth.currentUser ? Auth.currentUser() : null;
    els.name.value = (user && user.name) || U.store.get('name', '') || '';
    els.title.value = U.store.get('lastRoomTitle', '') || '';
    renderNavAuth();
  })();

  /* ============================== فحص وضع الاتصال ============================== */
  (function detectMode() {
    const cfg = window.WT_CONFIG;
    const finishTxt = [];
    const set = (txt, cls) => {
      els.modeBadge.className = 'badge ' + (cls || '');
      els.modeBadge.innerHTML = '<span class="dot ' + (cls ? 'dot--pulse' : '') + '"></span> ' + U.esc(txt);
      if (els.footerMode) els.footerMode.textContent = 'الخادم: ' + txt;
    };

    if (window.WTTransport && WTTransport.forceLocal && WTTransport.forceLocal()) {
      set('وضع محلي (?local=1)', 'badge--host');
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = (cfg.javaServer && cfg.javaServer.url) || (proto + '//' + location.host + '/ws');

    let done = false;
    const finish = (txt, cls) => { if (!done) { done = true; set(txt, cls); } };

    if (cfg.javaServer && cfg.javaServer.enabled) {
      try {
        const ws = new WebSocket(wsUrl);
        const to = setTimeout(() => { try { ws.close(); } catch (e) { } }, cfg.javaServer.timeoutMs || 2500);
        ws.onopen = () => { clearTimeout(to); try { ws.close(); } catch (e) { } finish('سيرفر Java متاح', 'badge--live'); };
        ws.onerror = () => { clearTimeout(to); next(); };
      } catch (e) { next(); }
    } else next();

    let checked = false;
    function next() {
      if (checked) return;
      checked = true;
      if (cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey && cfg.supabase.ready !== false) {
        const ctrl = ('AbortController' in window) ? new AbortController() : null;
        const t = ctrl && setTimeout(() => ctrl.abort(), 5000);
        fetch(cfg.supabase.url.replace(/\/$/, '') + '/rest/v1/rooms?select=room_id&limit=1', {
          headers: { 'apikey': cfg.supabase.anonKey, 'Authorization': 'Bearer ' + cfg.supabase.anonKey },
          signal: ctrl ? ctrl.signal : undefined
        }).then(async (r) => {
          clearTimeout(t);
          let body = {};
          try { body = await r.json(); } catch (e) { body = {}; }
          if (r.ok) finish('Supabase متصل', 'badge--live');
          else if (body && (body.code === '42P01' || r.status === 404)) finish('أنشئ الجداول (docs/schema.sql)', 'badge--host');
          else if (body && body.code === '42501') finish('فعّل صلاحيات RLS', 'badge--host');
          else finish('Supabase: ' + (body.message || r.status), 'badge--host');
        }).catch(() => { clearTimeout(t); finish('وضع محلي (بدون سيرفر)', ''); });
      } else {
        finish('وضع محلي (بدون سيرفر)', '');
      }
    }
    void finishTxt;
  })();

  /* ============================== معاينة الرابط ============================== */
  const updatePreview = U.debounce(function () {
    const raw = els.url.value.trim();
    const parsed = U.parseWatchUrl(raw);
    if (!raw) { els.preview.classList.remove('is-on'); return; }
    els.preview.classList.add('is-on');

    if (!parsed) {
      els.previewKind.innerHTML = '<span class="ic" style="color:var(--warn)">' + IC.html('alert', 14) + '</span> رابط غير مدعوم';
      els.previewUrl.textContent = raw;
      els.previewThumb.style.backgroundImage = '';
      els.previewThumb.innerHTML = '<span class="ic">' + IC.html('alert', 22) + '</span>';
      return;
    }

    els.previewKind.innerHTML = '<span class="ic" style="color:var(--ok)">' + IC.html('check', 14) + '</span> ' +
      U.esc(parsed.label) + ' • ' + U.esc(parsed.provider);
    els.previewUrl.textContent = raw;

    const thumb = parsed.kind === 'youtube' ? window.WTPlayer.thumbFor(parsed.id) : null;
    if (thumb) {
      els.previewThumb.innerHTML = '';
      els.previewThumb.style.backgroundImage = 'url("' + thumb + '")';
      els.previewThumb.style.backgroundSize = 'cover';
      els.previewThumb.style.backgroundPosition = 'center';
    } else {
      els.previewThumb.style.backgroundImage = '';
      els.previewThumb.innerHTML = '<span class="ic">' +
        IC.html(parsed.kind === 'hls' ? 'broadcast' : parsed.kind === 'file' ? 'film' : 'link', 22) + '</span>';
    }
  }, 240);

  els.url.addEventListener('input', updatePreview);
  els.url.addEventListener('paste', () => setTimeout(updatePreview, 30));

  els.paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { els.url.value = text.trim(); updatePreview(); U.toast('تم لصق الرابط', 'success', 1700); }
    } catch (e) {
      U.toast('متصفحك يمنع القراءة من الحافظة — الصق يدوياً (Ctrl+V)', 'warn');
    }
  });

  /* ============================== روابط التجربة ============================== */
  document.querySelectorAll('[data-demo]').forEach(btn => {
    btn.addEventListener('click', () => {
      els.url.value = btn.getAttribute('data-demo');
      updatePreview();
      els.url.focus();
    });
  });

  /* ============================== إنشاء الغرفة ============================== */
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();

    const raw = els.url.value.trim();
    const parsed = U.parseWatchUrl(raw);
    if (!parsed) {
      U.toast('أدخل رابط مشاهدة صالحاً (يوتيوب أو mp4 أو m3u8)', 'error');
      els.url.focus();
      return;
    }

    let name = U.cleanName(els.name.value);
    if (!name) {
      name = 'مضيف-' + U.randomCode(3);
      els.name.value = name;
      U.toast('لم تدخل اسمك — استخدمنا اسماً مؤقتاً، يمكنك تغييره من الغرفة', 'warn');
    }

    const code = U.randomCode(window.WT_CONFIG.room.codeLength);
    let ownerToken;
    try { ownerToken = U.randomToken(32); }
    catch (err) {
      U.toast('تعذّر إنشاء مفتاح تحكم آمن — حدّث المتصفح ثم أعد المحاولة', 'error', 6000);
      return;
    }
    U.store.set('name', name);
    U.store.set('lastRoomTitle', els.title.value.trim());
    /* مفتاح المنشئ يبقى على جهازه ولا يدخل أبداً في رابط الدعوة. */
    U.store.set('owner:' + code, ownerToken);

    try {
      sessionStorage.setItem('wt:create:' + code, JSON.stringify({
        videoUrl: parsed.src,
        title: U.cleanName(els.title.value) || 'غرفة مشاهدة',
        host: true,
        name,
        ownerToken,
        at: Date.now()
      }));
    } catch (err) { /* ignore */ }

    els.createBtn.disabled = true;
    els.createBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> جارٍ إنشاء الغرفة…';

    const q = new URLSearchParams({ id: code, host: '1', v: parsed.src, name });
    if (new URLSearchParams(location.search).get('local') === '1') q.set('local', '1');
    setTimeout(() => { location.href = 'room.html?' + q.toString(); }, 200);
  });

  /* ============================== الدخول بكود ============================== */
  els.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const code = els.joinCode.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      U.toast('أدخل كود غرفة صحيحاً (مثال: 8F3K2Q)', 'error');
      els.joinCode.focus();
      return;
    }
    const name = U.cleanName(els.name.value);
    const q = new URLSearchParams({ id: code });
    if (name) q.set('auto', '1');
    if (new URLSearchParams(location.search).get('local') === '1') q.set('local', '1');
    location.href = 'room.html?' + q.toString();
  });

  els.joinCode.addEventListener('input', function () {
    const p = this.selectionStart;
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    try { this.setSelectionRange(p, p); } catch (e) { }
  });

  /* ============================== تحويل ?id= تلقائياً ============================== */
  (function autoRedirect() {
    const id = U.qs('id') || U.qs('room');
    if (id) location.replace('room.html?' + location.search.replace(/^\?/, ''));
  })();

})();

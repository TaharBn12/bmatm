/* =========================================================
   WatchTogether — الصفحة الرئيسية (home.js)
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const $ = (id) => document.getElementById(id);

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
    modeBadge: $('modeBadge')
  };

  /* ---------- استرجاع اسم المستخدم السابق ---------- */
  els.name.value = U.store.get('name', '') || '';
  els.title.value = U.store.get('lastRoomTitle', '') || '';

  /* ---------- فحص وضع الاتصال لعرضه في الشارة ---------- */
  (function detectMode() {
    const cfg = window.WT_CONFIG;
    const set = (txt, cls) => {
      els.modeBadge.className = 'badge ' + (cls || '');
      els.modeBadge.innerHTML = '<span class="dot ' + (cls ? 'dot--pulse' : '') + '"></span> ' + txt;
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = (cfg.javaServer && cfg.javaServer.url) || (proto + '//' + location.host + '/ws');

    let done = false;
    const finish = (txt, cls) => { if (!done) { done = true; set(txt, cls); } };

    /* ?local=1 → اعرض الوضع المحلي مباشرة بدون انتظار مهلات السيرفرات */
    if (window.WTTransport && WTTransport.forceLocal && WTTransport.forceLocal()) {
      finish('وضع محلي (?local=1)', 'badge--host');
      return;
    }

    /* 1) هل يوجد سيرفر Java؟ */
    if (cfg.javaServer && cfg.javaServer.enabled) {
      try {
        const ws = new WebSocket(wsUrl);
        const to = setTimeout(() => { try { ws.close(); } catch (e) { } }, cfg.javaServer.timeoutMs || 2500);
        ws.onopen = () => { clearTimeout(to); try { ws.close(); } catch (e) { } finish('سيرفر Java متاح ✓', 'badge--live'); };
        ws.onerror = () => { clearTimeout(to); next(); };
        ws.onclose = () => { clearTimeout(to); };
      } catch (e) { next(); }
    } else next();

    let checked = false;
    function next() {
      if (checked) return;
      checked = true;
      /* 2) هل Supabase مضبوط وي reachable؟ */
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
          if (r.ok) finish('Supabase متصل ✓', 'badge--live');
          else if (body && (body.code === '42P01' || r.status === 404))
            finish('Supabase: أنشئ الجداول من docs/schema.sql', 'badge--host');
          else if (body && body.code === '42501')
            finish('Supabase: فعّل صلاحيات RLS (schema.sql)', 'badge--host');
          else finish('Supabase: ' + (body.message || r.status), 'badge--host');
        }).catch(() => { clearTimeout(t); finish('وضع محلي (بدون سيرفر)', ''); });
      } else {
        finish('وضع محلي (بدون سيرفر)', '');
      }
    }
  })();

  /* ---------- معاينة الرابط أثناء الكتابة ---------- */
  const updatePreview = U.debounce(function () {
    const raw = els.url.value.trim();
    const parsed = U.parseWatchUrl(raw);
    if (!raw) { els.preview.classList.remove('is-on'); return; }
    els.preview.classList.add('is-on');

    if (!parsed) {
      els.previewKind.textContent = '⚠️ رابط غير مدعوم';
      els.previewUrl.textContent = raw;
      els.previewThumb.textContent = '⚠️';
      els.previewThumb.style.backgroundImage = '';
      return;
    }
    els.previewKind.textContent = '✓ ' + parsed.label + ' — ' + parsed.provider;
    els.previewUrl.textContent = raw;

    const thumb = parsed.kind === 'youtube' ? window.WTPlayer.thumbFor(parsed.id) : null;
    if (thumb) {
      els.previewThumb.textContent = '';
      els.previewThumb.style.backgroundImage = `url("${thumb}")`;
      els.previewThumb.style.backgroundSize = 'cover';
      els.previewThumb.style.backgroundPosition = 'center';
    } else {
      els.previewThumb.style.backgroundImage = '';
      els.previewThumb.textContent = parsed.kind === 'hls' ? '📡' : parsed.kind === 'file' ? '🎞️' : '🔗';
    }
  }, 260);

  els.url.addEventListener('input', updatePreview);
  els.url.addEventListener('paste', () => setTimeout(updatePreview, 30));

  /* ---------- زر اللصق ---------- */
  els.paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { els.url.value = text.trim(); updatePreview(); U.toast('تم لصق الرابط ✓', 'success', 1800); }
    } catch (e) {
      U.toast('متصفحك يمنع القراءة من الحافظة — الصق يدوياً (Ctrl+V)', 'warn');
    }
  });

  /* ---------- أزرار التجربة ---------- */
  document.querySelectorAll('[data-demo]').forEach(btn => {
    btn.addEventListener('click', () => {
      els.url.value = btn.getAttribute('data-demo');
      updatePreview();
      els.url.focus();
      U.toast('تم وضع رابط تجريبي — اضغط إنشاء الغرفة', 'info', 2200);
    });
  });

  /* ---------- إنشاء الغرفة ---------- */
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
      U.toast('لم تدخل اسمك — استخدمنا اسماً مؤقتاً، يمكنك تغييره في الغرفة', 'warn');
    }

    const code = U.randomCode(window.WT_CONFIG.room.codeLength);
    U.store.set('name', name);
    U.store.set('lastRoomTitle', els.title.value.trim());
    /* نمرّر البيانات عبر sessionStorage لتقرأها صفحة الغرفة */
    try {
      sessionStorage.setItem('wt:create:' + code, JSON.stringify({
        videoUrl: parsed.src,
        title: U.cleanName(els.title.value) || 'غرفة مشاهدة',
        host: true,
        name,
        at: Date.now()
      }));
    } catch (err) { /* ignore */ }

    els.createBtn.disabled = true;
    els.createBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> جارٍ إنشاء الغرفة…';

    const params = new URLSearchParams({ id: code, host: '1', v: parsed.src, name });
    setTimeout(() => { location.href = 'room.html?' + params.toString(); }, 220);
  });

  /* ---------- الدخول لغرفة موجودة ---------- */
  els.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const code = els.joinCode.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      U.toast('أدخل كود غرفة صحيحاً (مثال: 8F3K2Q)', 'error');
      els.joinCode.focus();
      return;
    }
    location.href = 'room.html?id=' + encodeURIComponent(code);
  });

  els.joinCode.addEventListener('input', function () {
    const p = this.selectionStart;
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    try { this.setSelectionRange(p, p); } catch (e) { }
  });

  /* ---------- دعم: فتح الموقع برابط يحتوي ?id= ---------- */
  (function autoRedirect() {
    const id = U.qs('id') || U.qs('room');
    if (id) location.replace('room.html?id=' + encodeURIComponent(id));
  })();

})();

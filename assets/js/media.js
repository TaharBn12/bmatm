/* =========================================================
   WatchTogether — وسائط الغرفة (media.js)
   ---------------------------------------------------------
   • رفع الصور والفيديو إلى مواقع تخزين مجانية، ثم عرضها في
     الدردشة من الرابط الذي يعيده موقع الرفع، وتخزين الرابط
     في قاعدة البيانات مع الرسالة.
   • الموقع المضمون هو Supabase Storage داخل مشروعك (دائم وسريع)،
     وسلسلة البدائل العامة تُجرَّب بعده تلقائياً فلا يتعطّل الإرسال:
        1) Supabase Storage  — الموقع المضمون: مساحة دائمة داخل مشروعك
        2) Catbox            — موقع مجاني دائم (ملف حتى 200 ميغا)
        3) Litterbox         — موقع موثوق (حتى 1 غ.ب، يُحذف بعد 72 ساعة)
        4) Tmpfiles          — موقع مجاني (حتى 100 م.ب، يُحذف بعد 7 أيام)
        5) Uguu              — موقع مجاني مؤقّت (آخر حل)
   • كل رابط يُنقّى قبل العرض (http/https فقط) فلا تُنفَّذ
     روابط خبيثة، والغلاف يُقصَّر حتى لا يتجاوز حد التخزين.
   • عارض مكبّر (Lightbox) للصور والفيديو مع تنقّل ولوحة أدوات.
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;
  const IC = global.WTIcons;

  /* ---------- أنواع مسموحة ---------- */
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
  const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg', 'video/3gpp'];
  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/avif': 'avif', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'video/3gpp': '3gp'
  };
  /* حدّ النص المخزَّن في الرسالة (1000 محرف في سيرفر Java و Supabase) */
  const MAX_ENVELOPE = 940;
  const MAX_PER_MESSAGE = 4;

  function mediaCfg() {
    return (global.WT_CONFIG && global.WT_CONFIG.media) || {};
  }
  function supabaseCfg() {
    return (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};
  }

  /* =========================================================
     أدوات عامة
     ========================================================= */
  /** رابط آمن: http/https فقط، بلا بيانات دخول */
  function safeURL(raw) {
    const s = String(raw || '').trim();
    if (!s || s.length > 2000) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (u.username || u.password) return '';
      return u.href;
    } catch (e) { return ''; }
  }

  function kindOf(file) {
    const t = String((file && file.type) || '').toLowerCase();
    if (IMAGE_TYPES.indexOf(t) >= 0) return 'image';
    if (VIDEO_TYPES.indexOf(t) >= 0) return 'video';
    /* بعض الأجهزة تعطي نوعاً فارغاً → نخمّن من الامتداد */
    const name = String((file && file.name) || '').toLowerCase();
    if (/\.(jpe?g|png|webp|gif|avif|bmp)$/.test(name)) return 'image';
    if (/\.(mp4|webm|mov|m4v|mkv|ogv|3gp)$/.test(name)) return 'video';
    return '';
  }

  function extFor(file, kind) {
    const t = String((file && file.type) || '').toLowerCase();
    if (EXT[t]) return EXT[t];
    const name = String((file && file.name) || '');
    const m = name.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
    return kind === 'video' ? 'mp4' : 'jpg';
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' ب';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' ك.ب';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' م.ب';
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /** اتجاه الوسيط حسب أبعاده الحقيقية (أفقي / عمودي / مربع) */
  function orientationOf(w, h) {
    const nw = Number(w) || 0;
    const nh = Number(h) || 0;
    if (nw <= 0 || nh <= 0) return 'auto';
    const ratio = nw / nh;
    if (ratio > 1.15) return 'landscape';
    if (ratio < 0.87) return 'portrait';
    return 'square';
  }

  /**
   * يحسب مقاس المعاينة المصغّرة داخل الدردشة حسب أبعاد الصورة الأصلية
   * بحيث تبقى المعاينة ظاهرة متناسبة مع شكل الصورة ومصغّرة قليلاً.
   */
  function previewBox(w, h, maxW, maxH) {
    const nw = Number(w) || 0;
    const nh = Number(h) || 0;
    const mw = Number(maxW) || 200;
    const mh = Number(maxH) || 148;
    if (nw <= 0 || nh <= 0) return null;
    const scale = Math.min(1, mw / nw, mh / nh);
    const pw = Math.max(88, Math.round(nw * scale));
    const ph = Math.max(60, Math.round(nh * scale));
    return {
      w: pw,
      h: ph,
      orient: orientationOf(nw, nh),
      ratio: Math.round((nw / nh) * 100) / 100
    };
  }

  function applyMediaRatio(fig, frame, w, h) {
    const box = previewBox(w, h, 200, 148);
    if (!box) return;
    try {
      fig.setAttribute('data-orient', box.orient);
      fig.setAttribute('data-dims', Math.round(w) + 'x' + Math.round(h));
      if (fig.style && fig.style.setProperty) {
        fig.style.setProperty('--media-ar', Math.round(w) + ' / ' + Math.round(h));
        fig.style.setProperty('--media-w', box.w + 'px');
        fig.style.setProperty('--media-h', box.h + 'px');
      }
      if (frame && frame.style && frame.style.setProperty) {
        frame.style.setProperty('--media-ar', Math.round(w) + ' / ' + Math.round(h));
      }
    } catch (e) { }
  }

  /**
   * معرّف عشوائي بأحرف hex فقط (a-f0-9) وبطول محدد.
   * مهم: اسم ملف Supabase Storage يجب أن يطابق سياسة الدلو
   * `^[0-9]{10,16}-[a-f0-9]{8,40}\.ext` — أي 8-40 محرفاً hex فقط؛
   * أي معرّف أطول أو غير hex ترفضه السياسة فيفشل الرفع.
   */
  function randomId(hexLen) {
    const len = Math.max(8, Math.min(40, Number(hexLen) || 32));
    let s = '';
    try { s = U.randomToken(Math.ceil(len / 2) + 8); } catch (e) { s = ''; }
    s = String(s).toLowerCase().replace(/[^a-f0-9]/g, '');
    while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, len);
  }

  /* =========================================================
     الطلب الشبكي (XHR للتقدّم، وfetch كبديل)
     ========================================================= */
  function request(opts) {
    if (typeof global.XMLHttpRequest === 'function') return xhrRequest(opts);
    return fetchRequest(opts);
  }

  function xhrRequest(opts) {
    return new Promise((resolve, reject) => {
      let xhr;
      try { xhr = new global.XMLHttpRequest(); } catch (e) { return reject(new Error('تعذّر إنشاء طلب الرفع')); }
      try {
        xhr.open(opts.method || 'POST', opts.url, true);
      } catch (e) { return reject(new Error('تعذّر الاتصال بموقع الرفع')); }
      try { xhr.timeout = opts.timeoutMs || 120000; } catch (e) { }
      Object.keys(opts.headers || {}).forEach((k) => {
        try { xhr.setRequestHeader(k, opts.headers[k]); } catch (e) { }
      });
      if (opts.onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (ev && ev.lengthComputable && ev.total && opts.onProgress) {
            opts.onProgress(Math.max(1, Math.min(99, Math.round((ev.loaded / ev.total) * 100))));
          }
        };
      }
      xhr.onload = () => resolve({ status: xhr.status || 0, text: xhr.responseText || '' });
      xhr.onerror = () => reject(new Error('تعذّر الاتصال بموقع الرفع — تحقق من الإنترنت'));
      xhr.ontimeout = () => reject(new Error('انتهت مهلة الرفع — جرّب ملفاً أصغر'));
      xhr.onabort = () => reject(Object.assign(new Error('أُلغي الرفع'), { aborted: true }));
      try { xhr.send(opts.body == null ? null : opts.body); }
      catch (e) { reject(e); }
    });
  }

  function fetchRequest(opts) {
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) { try { controller.abort(); } catch (e) { } }
        reject(new Error('انتهت مهلة الرفع — جرّب ملفاً أصغر'));
      }, opts.timeoutMs || 120000);
    });
    const run = global.fetch(opts.url, {
      method: opts.method || 'POST',
      headers: opts.headers || undefined,
      body: opts.body == null ? undefined : opts.body,
      signal: controller ? controller.signal : undefined
    }).then(async (res) => {
      let text = '';
      try { text = await res.text(); } catch (e) { text = ''; }
      return { status: res.status, text };
    });
    return Promise.race([run, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /* =========================================================
     مزوّدو التخزين المجاني
     ========================================================= */
  const PROVIDERS = {
    /* 1) Supabase Storage — الموقع المضمون: مساحة مجانية دائمة داخل مشروعك */
    supabase: {
      id: 'supabase',
      label: 'Supabase',
      note: 'مساحة مجانية دائمة داخل مشروعك',
      available() {
        const s = supabaseCfg();
        return !!(s && s.url && s.anonKey);
      },
      upload(file, ctx, onProgress) {
        const s = supabaseCfg();
        const bucket = (mediaCfg().supabaseBucket || 'wt-room-media');
        const path = ctx.path;
        const headers = {
          'apikey': s.anonKey,
          'Authorization': 'Bearer ' + ctx.token,
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'false',
          'cache-control': '3600'
        };
        return request({
          url: String(s.url).replace(/\/$/, '') + '/storage/v1/object/' + bucket + '/' + path,
          method: 'POST', headers, body: file, onProgress, timeoutMs: 120000
        }).then((res) => {
          if (res.status < 200 || res.status >= 300) {
            throw new Error('Supabase: تعذّر الرفع (' + res.status + ')');
          }
          return String(s.url).replace(/\/$/, '') + '/storage/v1/object/public/' + bucket + '/' + path;
        });
      }
    },

    /* 2) Catbox — موقع مجاني دائم (حتى 200 ميغا)؛ أحياناً يرفض الرفع
          أو يتعطّل، عندها ينتقل العميل تلقائياً إلى Litterbox */
    catbox: {
      id: 'catbox',
      label: 'Catbox',
      note: 'موقع مجاني دائم',
      available() { return typeof global.FormData === 'function'; },
      upload(file, ctx, onProgress) {
        const form = new global.FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', file, file.name || 'file');
        return request({
          url: 'https://catbox.moe/user/api.php',
          method: 'POST', body: form, onProgress, timeoutMs: 150000
        }).then((res) => {
          const url = String(res.text || '').trim();
          if (res.status < 200 || res.status >= 300 || !/^https?:\/\//i.test(url)) {
            throw new Error('Catbox: ' + (url || ('HTTP ' + res.status)));
          }
          return url;
        });
      }
    },

    /* 3) Litterbox — موقع موثوق من فريق Catbox: يقبل بلا حساب، حتى 1 غ.ب،
          يحفظ الملف 72 ساعة ثم يحذفه تلقائياً، والرابط يقدّم الملف مباشرة */
    litterbox: {
      id: 'litterbox',
      label: 'Litterbox',
      note: 'موقع موثوق — يحفظ الملف 72 ساعة',
      temporary: true,
      available() { return typeof global.FormData === 'function'; },
      upload(file, ctx, onProgress) {
        const form = new global.FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '72h');
        form.append('fileToUpload', file, file.name || 'file');
        return request({
          url: 'https://litterbox.catbox.moe/resources/internals/api.php',
          method: 'POST', body: form, onProgress, timeoutMs: 150000
        }).then((res) => {
          const url = String(res.text || '').trim();
          if (res.status < 200 || res.status >= 300 || !/^https?:\/\//i.test(url)) {
            throw new Error('Litterbox: ' + (url || ('HTTP ' + res.status)));
          }
          return url;
        });
      }
    },

    /* 4) Tmpfiles — موقع مجاني: حتى 100 م.ب، يحفظ الملف 7 أيام، والرابط
          المباشر /dl/ يقدّم الملف مباشرة (مناسب للصور والفيديو) */
    tmpfiles: {
      id: 'tmpfiles',
      label: 'Tmpfiles',
      note: 'موقع مجاني — يحفظ الملف 7 أيام',
      temporary: true,
      available() { return typeof global.FormData === 'function'; },
      upload(file, ctx, onProgress) {
        const form = new global.FormData();
        form.append('file', file, file.name || 'file');
        return request({
          url: 'https://tmpfiles.org/api/v1/upload',
          method: 'POST', body: form, onProgress, timeoutMs: 150000
        }).then((res) => {
          if (res.status < 200 || res.status >= 300) throw new Error('Tmpfiles: HTTP ' + res.status);
          let data = null;
          try { data = JSON.parse(res.text); } catch (e) { data = null; }
          const page = data && data.data && data.data.url;
          if (!page || !/^https?:\/\//i.test(String(page))) throw new Error('Tmpfiles: استجابة غير مفهومة');
          /* صفحة العرض tmpfiles.org/<id>/name → الرابط المباشر tmpfiles.org/dl/<id>/name */
          return String(page).replace(/^https?:\/\/tmpfiles\.org\//i, 'https://tmpfiles.org/dl/');
        });
      }
    },

    /* 5) Uguu — موقع مجاني مؤقّت (آخر حل في السلسلة) */
    uguu: {
      id: 'uguu',
      label: 'Uguu',
      note: 'موقع مجاني مؤقّت (تُحذف الملفات بعد ساعات)',
      temporary: true,
      available() { return typeof global.FormData === 'function'; },
      upload(file, ctx, onProgress) {
        const form = new global.FormData();
        form.append('files[]', file, file.name || 'file');
        return request({
          url: 'https://uguu.se/upload.php',
          method: 'POST', body: form, onProgress, timeoutMs: 120000
        }).then((res) => {
          if (res.status < 200 || res.status >= 300) throw new Error('Uguu: HTTP ' + res.status);
          let data = null;
          try { data = JSON.parse(res.text); } catch (e) { data = null; }
          const url = data && data.files && data.files[0] && data.files[0].url;
          if (!url) throw new Error('Uguu: استجابة غير مفهومة');
          return url;
        });
      }
    }
  };

  function providerOrder() {
    const list = mediaCfg().providers;
    const ids = Array.isArray(list) && list.length ? list.slice() : ['supabase', 'catbox', 'litterbox', 'tmpfiles', 'uguu'];
    return ids.map((id) => String(id)).filter((id) => !!PROVIDERS[id]);
  }

  /* =========================================================
     التحقق من الملف
     ========================================================= */
  /** @returns {{ok:boolean, kind?:string, error?:string}} */
  function validate(file) {
    const cfg = mediaCfg();
    const kind = kindOf(file);
    if (!kind) return { ok: false, error: 'الملف ليس صورة ولا فيديو' };
    const size = Number(file.size) || 0;
    const maxImage = (cfg.maxImageMB || 12) * 1048576;
    const maxVideo = (cfg.maxVideoMB || 80) * 1048576;
    const limit = kind === 'image' ? maxImage : maxVideo;
    if (size <= 0) return { ok: false, error: 'الملف فارغ' };
    if (size > limit) {
      return { ok: false, error: 'الحجم أكبر من الحد (' + (kind === 'image' ? (cfg.maxImageMB || 12) : (cfg.maxVideoMB || 80)) + ' م.ب)' };
    }
    return { ok: true, kind };
  }

  /* =========================================================
     قراءة المقاس/المدة (اختيارية — لا تعطّل الرفع)
     ========================================================= */
  function probe(file, kind) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (data) => { if (done) return; done = true; resolve(data || {}); };
      const timer = setTimeout(() => finish({}), 2500);
      const makeURL = () => {
        try {
          if (global.URL && typeof global.URL.createObjectURL === 'function') return global.URL.createObjectURL(file);
        } catch (e) { }
        return '';
      };
      const url = makeURL();
      if (!url) { clearTimeout(timer); return finish({}); }
      try {
        if (kind === 'image') {
          const img = new global.Image();
          img.onload = () => { clearTimeout(timer); finish({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 }); };
          img.onerror = () => { clearTimeout(timer); finish({}); };
          img.src = url;
        } else if (kind === 'video') {
          const vid = global.document.createElement('video');
          vid.preload = 'metadata';
          vid.onloadedmetadata = () => {
            clearTimeout(timer);
            finish({
              w: vid.videoWidth || 0, h: vid.videoHeight || 0,
              d: Math.round((vid.duration || 0) * 10) / 10
            });
          };
          vid.onerror = () => { clearTimeout(timer); finish({}); };
          vid.src = url;
        } else { clearTimeout(timer); finish({}); }
      } catch (e) { clearTimeout(timer); finish({}); }
    });
  }

  /* =========================================================
     الرفع مع سلسلة البدائل
     ========================================================= */
  /**
   * @param {File} file
   * @param {{roomId?:string, onProgress?:Function, token?:string}} opts
   * @returns {Promise<{url:string, kind:string, provider:string, name:string, size:number, w:number, h:number, d:number}>}
   */
  async function upload(file, opts) {
    opts = opts || {};
    const check = validate(file);
    if (!check.ok) throw new Error(check.error);
    const kind = check.kind;

    /* الحروف والأرقام فقط: هذا هو النمط المسموح في سياسة دلو Supabase */
    const roomId = String(opts.roomId || 'local').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'local';
    const path = 'rooms/' + roomId + '/' + Date.now() + '-' + randomId(32) + '.' + extFor(file, kind);
    const token = opts.token || supabaseCfg().anonKey || '';

    const metaPromise = probe(file, kind);
    const order = providerOrder();
    if (!order.length) throw new Error('لا يوجد مزوّد تخزين مهيّأ');

    let lastError = null;
    for (let i = 0; i < order.length; i++) {
      const provider = PROVIDERS[order[i]];
      if (!provider) continue;
      if (provider.available && !provider.available()) continue;
      try {
        const url = await provider.upload(file, { path, roomId, token }, (pct) => {
          if (opts.onProgress) opts.onProgress(pct, provider.id, i, order.length);
        });
        const safe = safeURL(url);
        if (!safe) throw new Error(provider.label + ': رابط غير صالح');
        const meta = await metaPromise;
        return {
          url: safe,
          kind: kind,
          provider: provider.id,
          providerLabel: provider.label,
          temporary: !!provider.temporary,
          name: String(file.name || (kind === 'video' ? 'فيديو' : 'صورة')).slice(0, 80),
          size: Number(file.size) || 0,
          w: Number(meta.w) || 0,
          h: Number(meta.h) || 0,
          d: Number(meta.d) || 0
        };
      } catch (err) {
        lastError = err;
        if (err && err.aborted) throw err;
      }
    }
    throw lastError || new Error('تعذّر رفع الملف — جرّب مجدداً لاحقاً');
  }

  /* =========================================================
     شكل الوسيط داخل غلاف الرسالة
     ========================================================= */
  /** يحوّل وسيطاً خاماً (من الغلاف أو من قاعدة البيانات) إلى شكل موحّد آمن */
  function normalizeMedia(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = safeURL(raw.u || raw.url || '');
    if (!url) return null;
    const kind = raw.k === 'video' || raw.type === 'video' ? 'video' : (raw.k === 'image' || raw.type === 'image' ? 'image' : kindFromURL(url));
    return {
      u: url,
      k: kind,
      n: String(raw.n || raw.name || '').slice(0, 90),
      s: Number(raw.s || raw.size) || 0,
      w: Number(raw.w) || 0,
      h: Number(raw.h) || 0,
      d: Number(raw.d) || 0
    };
  }

  function kindFromURL(url) {
    return /\.(mp4|webm|mov|m4v|mkv|ogv|3gp)(\?|#|$)/i.test(String(url || '')) ? 'video' : 'image';
  }

  /** يستخرج قائمة الوسائط من غلاف رسالة (قد تكون واحدة أو عدة) */
  function mediaList(meta) {
    if (!meta) return [];
    if (Array.isArray(meta)) return meta.map(normalizeMedia).filter(Boolean);
    if (Array.isArray(meta.list)) return meta.list.map(normalizeMedia).filter(Boolean);
    const one = normalizeMedia(meta);
    return one ? [one] : [];
  }

  /** يحوّل وسائط إلى شكل يُخزَّن في الغلاف (مقصوص ليناسب حد التخزين) */
  function packMedia(list) {
    const items = (Array.isArray(list) ? list : [list]).map(normalizeMedia).filter(Boolean).slice(0, MAX_PER_MESSAGE);
    if (!items.length) return null;
    if (items.length === 1) return items[0];
    return { list: items };
  }

  /** عدد المحارف المتاح للنص بعد إضافة الوسائط */
  function textBudget(media) {
    if (!media) return Infinity;
    const size = JSON.stringify(media).length + 24;
    return Math.max(0, MAX_ENVELOPE - size);
  }

  /** تسمية نصّية للوسائط (تُستعمل في الاقتباس) — بلا إيموجي كما في بقية الواجهة */
  function label(media) {
    if (!media) return '';
    if (media.k === 'video') return 'فيديو';
    return 'صورة';
  }

  /* =========================================================
     العرض: بطاقة الوسائط داخل الرسالة
     ========================================================= */
  function make(tag, cls, attrs) {
    const node = global.document.createElement(tag);
    if (cls) node.className = cls;
    Object.keys(attrs || {}).forEach((k) => {
      if (k === 'text') { node.textContent = attrs[k]; return; }
      if (k === 'html') { node.innerHTML = attrs[k]; return; }
      try { node.setAttribute(k, attrs[k]); } catch (e) { }
    });
    return node;
  }

  /** يبحث عن أقرب عنصر يحمل data-act صعوداً حتى الجذر */
  function findAction(node, stopAt) {
    let cur = node;
    while (cur && cur !== stopAt) {
      if (cur.getAttribute) {
        const act = cur.getAttribute('data-act');
        if (act) return act;
      }
      cur = cur.parentNode;
    }
    if (stopAt && stopAt.getAttribute) return stopAt.getAttribute('data-act') || '';
    return '';
  }

  /**
   * يبني عنصر بطاقة وسائط احترافية داخل الرسالة (صورة/فيديو)
   * بمعاينة متناسبة مع الصورة ومصغّرة قليلاً، وعند الضغط تفتح كاملة.
   * @param {object} media  وسيط مُطبَّع
   * @param {{onExpand?:Function, preview?:string}} opts
   */
  function renderCard(media, opts) {
    opts = opts || {};
    const isVideo = media.k === 'video';
    const fig = make('figure', 'msg-media ' + (isVideo ? 'msg-media--video' : 'msg-media--image'));
    fig.setAttribute('data-media-kind', media.k);
    fig.setAttribute('data-media-url', media.u);

    const frame = make('div', 'msg-media__frame');
    if (media.w > 0 && media.h > 0) {
      applyMediaRatio(fig, frame, media.w, media.h);
    } else {
      fig.setAttribute('data-orient', 'auto');
    }

    const glow = make('div', 'msg-media__glow');
    glow.setAttribute('aria-hidden', 'true');
    frame.appendChild(glow);

    let videoEl = null;

    if (isVideo) {
      const video = make('video', 'msg-media__video');
      video.setAttribute('controls', 'controls');
      video.setAttribute('preload', 'metadata');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('aria-label', media.n || 'فيديو في الدردشة');
      video.onloadedmetadata = () => { fig.classList.add('is-loaded'); };
      video.onloadeddata = () => { fig.classList.add('is-loaded'); };
      video.onerror = () => { fig.classList.add('is-error'); };
      video.src = media.u;
      frame.appendChild(video);
      videoEl = video;
    } else {
      const img = make('img', 'msg-media__img');
      img.alt = media.n || 'صورة في الدردشة';
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.setAttribute('loading', 'lazy');
      img.onload = () => {
        fig.classList.add('is-loaded');
        fig.classList.remove('is-error');
      };
      img.onerror = () => {
        if (opts.preview && img.src !== opts.preview) {
          img.src = opts.preview;
          return;
        }
        fig.classList.add('is-error');
      };
      img.src = media.u;
      if (img.complete && img.naturalWidth > 0) {
        fig.classList.add('is-loaded');
      }
      frame.appendChild(img);
    }

    // نسبة ثابتة 16/4 للصور — تصميم احترافي خاص بدون تقليد
    fig.setAttribute('data-orient', 'wt-16x4');

    fig.appendChild(frame);

    // لا أيقونات تحميل/تكبير في المعاينة — النقر على البطاقة يكبّرها وحدها
    if (opts.onExpand) {
      const expand = (e) => {
        if (e && e._wtExpanded) return;
        if (e) e._wtExpanded = true;
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        if (videoEl && typeof videoEl.pause === 'function') {
          try { videoEl.pause(); } catch (err) { }
        }
        opts.onExpand(media);
      };
      // الصور: النقر في أي مكان يكبّر؛ الفيديو: النقر على الإطار (لا يتعارض مع التحكم)
      if (!isVideo) {
        fig.setAttribute('role', 'button');
        fig.setAttribute('tabindex', '0');
        fig.setAttribute('aria-label', 'عرض الصورة بالحجم الكامل');
        fig.addEventListener('click', expand);
        fig.addEventListener('keydown', (e) => {
          if (e && (e.key === 'Enter' || e.key === ' ')) {
            if (e.preventDefault) e.preventDefault();
            expand(e);
          }
        });
        fig.style.cursor = 'zoom-in';
      } else {
        frame.addEventListener('click', (e) => {
          const t = e && e.target;
          if (t && t.closest && t.closest('video')) return;
          expand(e);
        });
      }
    }
    return fig;
  }

  /* =========================================================
     العارض المكبّر (Lightbox)
     ========================================================= */
  let viewer = null;

  function viewerRoot() {
    if (viewer && viewer.root) return viewer;
    const root = global.document.getElementById('mediaLightbox');
    if (!root) return null;
    const byId = (id) => {
      try { return global.document.getElementById(id); } catch (e) { return null; }
    };
    const v = {
      root,
      stage: byId('mediaStage'),
      counter: byId('mediaCounter'),
      save: byId('mediaSaveBtn') || byId('mediaDownload'),
      download: byId('mediaDownload'),
      prev: byId('mediaPrev'),
      next: byId('mediaNext'),
      close: byId('mediaClose'),
      items: [],
      index: 0
    };
    if (!v.stage) return null;
    const hide = () => closeViewer();
    if (v.close) v.close.addEventListener('click', hide);
    root.addEventListener('click', (e) => {
      const t = e && e.target;
      const act = findAction(t, root);
      if (act === 'close' || t === v.stage || (t && t.classList && t.classList.contains('media-lightbox__frame'))) {
        if (e && e.preventDefault) e.preventDefault();
        hide();
      }
    });
    if (v.prev) v.prev.addEventListener('click', () => stepViewer(-1));
    if (v.next) v.next.addEventListener('click', () => stepViewer(1));
    // زر الحفظ — يبقى داخل العارض، لا ينتقل لموقع الرفع
    const saveBtn = v.save;
    if (saveBtn && !saveBtn._wtBound) {
      saveBtn._wtBound = true;
      saveBtn.addEventListener('click', async (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const cur = v.items && v.items[v.index];
        if (!cur || !cur.u) return;
        const url = cur.u;
        const name = (cur.n && String(cur.n).trim()) || 'image';
        // محاولة تنزيل مباشر دون فتح موقع الرفع
        try {
          const resp = await global.fetch(url, { mode: 'cors' });
          if (!resp || !resp.ok) throw new Error('bad');
          const blob = await resp.blob();
          const blobUrl = global.URL.createObjectURL(blob);
          const a = global.document.createElement('a');
          a.href = blobUrl;
          a.download = name;
          a.rel = 'noopener';
          global.document.body.appendChild(a);
          a.click();
          setTimeout(() => { try { a.remove(); global.URL.revokeObjectURL(blobUrl); } catch (err) {} }, 1200);
          return;
        } catch (err) {}
        // بديل محافظ: استخدم رابط قاعدة البيانات نفسه مع download، من دون فتح تبويب أو صفحة الرفع.
        // المتصفحات التي لا تسمح بـ CORS قد تتجاهل download، لكن التطبيق لا يغادره أبداً.
        try {
          const a = global.document.createElement('a');
          a.href = url;
          a.download = name;
          a.rel = 'noopener';
          global.document.body.appendChild(a);
          a.click();
          setTimeout(() => { try { a.remove(); } catch (e2) {} }, 800);
        } catch (e2) {}
      });
    }
    viewer = v;
    return v;
  }

  /** يفتح العارض على عنصر ضمن قائمة */
  function openViewer(items, index) {
    const v = viewerRoot();
    if (!v) return false;
    v.items = (items || []).filter(Boolean);
    v.index = Math.max(0, Math.min(v.items.length - 1, index || 0));
    paintViewer();
    v.root.hidden = false;
    v.root.setAttribute('aria-hidden', 'false');
    global.document.body.classList.add('media-lightbox-open');
    return true;
  }

  function closeViewer() {
    const v = viewerRoot();
    if (!v) return;
    v.root.hidden = true;
    v.root.setAttribute('aria-hidden', 'true');
    global.document.body.classList.remove('media-lightbox-open');
    if (v.stage) v.stage.innerHTML = '';
  }

  function stepViewer(delta) {
    const v = viewerRoot();
    if (!v || !v.items.length) return;
    v.index = (v.index + delta + v.items.length) % v.items.length;
    paintViewer();
  }

  function paintViewer() {
    const v = viewerRoot();
    if (!v) return;
    const item = v.items[v.index];
    if (v.stage) {
      v.stage.innerHTML = '';
      if (item && item.k === 'video') {
        const video = make('video', 'media-lightbox__video');
        video.src = item.u;
        video.setAttribute('controls', 'controls');
        video.setAttribute('autoplay', 'autoplay');
        video.setAttribute('playsinline', 'playsinline');
        v.stage.appendChild(video);
      } else if (item) {
        const img = make('img', 'media-lightbox__img');
        img.alt = item.n || 'صورة';
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        img.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          img.classList.toggle('is-zoomed');
        });
        img.src = item.u;
        v.stage.appendChild(img);
      }
    }
    if (v.counter) {
      const countPart = v.items.length > 1 ? (v.index + 1) + ' / ' + v.items.length : '';
      const metaPart = item ? [item.n || '', item.s ? fmtSize(item.s) : ''].filter(Boolean).join(' · ') : '';
      v.counter.textContent = [countPart, metaPart].filter(Boolean).join('  —  ');
    }
    // لا زر فتح لموقع الرفع — العرض من رابط قاعدة البيانات فقط
    if (v.save) {
      v.save.setAttribute('href', item ? item.u : '#');
      if (item && item.n) v.save.setAttribute('download', item.n);
      v.save.hidden = !item;
    }
    if (v.download && v.download !== v.save) {
      v.download.setAttribute('href', item ? item.u : '#');
      if (item && item.n) v.download.setAttribute('download', item.n);
    }
    const many = v.items.length > 1;
    if (v.prev) v.prev.hidden = !many;
    if (v.next) v.next.hidden = !many;
  }

  /* =========================================================
     الواجهة العامة
     ========================================================= */
  global.WTMedia = {
    upload, validate, kindOf, safeURL, fmtSize, fmtDuration, extFor,
    orientationOf, previewBox,
    normalizeMedia, mediaList, packMedia, textBudget, label,
    renderCard, openViewer, closeViewer, stepViewer, providerOrder,
    providers: PROVIDERS,
    MAX_PER_MESSAGE, MAX_ENVELOPE,
    IMAGE_TYPES, VIDEO_TYPES
  };
})(typeof window !== 'undefined' ? window : globalThis);

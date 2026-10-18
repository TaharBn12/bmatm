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
        /* نسبة رقمية تُستعمل في CSS لضبط عرض الصندوق حسب الارتفاع الأقصى */
        fig.style.setProperty('--media-ar-n', String(box.ratio));
        fig.style.setProperty('--media-w', box.w + 'px');
        fig.style.setProperty('--media-h', box.h + 'px');
      }
      if (frame && frame.style && frame.style.setProperty) {
        frame.style.setProperty('--media-ar', Math.round(w) + ' / ' + Math.round(h));
        frame.style.setProperty('--media-ar-n', String(box.ratio));
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

  function iconButton(icon, title, act) {
    const btn = make('button', 'msg-media__tool');
    btn.type = 'button';
    btn.setAttribute('data-act', act);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    btn.innerHTML = IC ? IC.html(icon, 15) : '';
    return btn;
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

    let zoom = null;
    let imgEl = null;
    let videoEl = null;

    if (isVideo) {
      const video = make('video', 'msg-media__video');
      video.setAttribute('controls', 'controls');
      video.setAttribute('preload', 'metadata');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('aria-label', media.n || 'فيديو في الدردشة');
      video.onloadedmetadata = () => {
        fig.classList.add('is-loaded');
        const vw = video.videoWidth || media.w || 0;
        const vh = video.videoHeight || media.h || 0;
        if (vw && vh) {
          media.w = media.w || vw;
          media.h = media.h || vh;
          applyMediaRatio(fig, frame, vw, vh);
        }
      };
      video.onloadeddata = () => { fig.classList.add('is-loaded'); };
      video.onerror = () => { fig.classList.add('is-error'); };
      video.src = media.u;
      frame.appendChild(video);
      videoEl = video;
      const durText = fmtDuration(media.d);
      const badge = make('span', 'msg-media__badge', {
        text: durText ? ('فيديو · ' + durText) : 'فيديو'
      });
      frame.appendChild(badge);
      const zoomBtn = make('button', 'msg-media__zoom');
      zoomBtn.type = 'button';
      zoomBtn.setAttribute('data-act', 'expand');
      zoomBtn.setAttribute('title', 'عرض الفيديو بالحجم الكامل');
      zoomBtn.setAttribute('aria-label', 'عرض الفيديو بالحجم الكامل');
      zoomBtn.innerHTML = (IC ? IC.html('maximize', 14) : '') +
        '<span class="msg-media__zoom-label">عرض كامل</span>';
      frame.appendChild(zoomBtn);
      zoom = zoomBtn;
    } else {
      const img = make('img', 'msg-media__img');
      img.alt = media.n || 'صورة في الدردشة';
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.onload = () => {
        fig.classList.add('is-loaded');
        fig.classList.remove('is-error');
        const nw = img.naturalWidth || media.w || 0;
        const nh = img.naturalHeight || media.h || 0;
        if (nw && nh) {
          media.w = media.w || nw;
          media.h = media.h || nh;
          applyMediaRatio(fig, frame, nw, nh);
        }
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
        applyMediaRatio(fig, frame, img.naturalWidth, img.naturalHeight);
      }
      frame.appendChild(img);
      imgEl = img;
      const zoomBtn = make('button', 'msg-media__zoom');
      zoomBtn.type = 'button';
      zoomBtn.setAttribute('data-act', 'expand');
      zoomBtn.setAttribute('title', 'اضغط لعرض الصورة كاملة');
      zoomBtn.setAttribute('aria-label', 'تكبير الصورة');
      zoomBtn.innerHTML = (IC ? IC.html('maximize', 14) : '') +
        '<span class="msg-media__zoom-label">عرض كاملة</span>';
      frame.appendChild(zoomBtn);
      zoom = zoomBtn;
    }

    const tools = make('div', 'msg-media__tools');
    const expandTool = iconButton('maximize', 'عرض بالحجم الكامل', 'expand');
    tools.appendChild(expandTool);
    const open = make('a', 'msg-media__tool');
    open.setAttribute('data-act', 'open');
    open.setAttribute('href', media.u);
    open.setAttribute('target', '_blank');
    open.setAttribute('rel', 'noopener noreferrer');
    open.setAttribute('title', 'فتح في تبويب جديد');
    open.setAttribute('aria-label', 'فتح في تبويب جديد');
    open.innerHTML = IC ? IC.html('link', 15) : '';
    tools.appendChild(open);
    const dl = make('a', 'msg-media__tool');
    dl.setAttribute('data-act', 'download');
    dl.setAttribute('href', media.u);
    dl.setAttribute('download', media.n || '');
    dl.setAttribute('title', 'تنزيل');
    dl.setAttribute('aria-label', 'تنزيل');
    dl.innerHTML = IC ? IC.html('download', 15) : '';
    tools.appendChild(dl);
    fig.appendChild(frame);
    fig.appendChild(tools);

    if (media.n || media.s) {
      const cap = make('figcaption', 'msg-media__caption');
      cap.textContent = (media.n || (isVideo ? 'فيديو' : 'صورة')) + (media.s ? ' · ' + fmtSize(media.s) : '');
      fig.appendChild(cap);
    }
    if (opts.onExpand) {
      /* الربط المباشر والاحتياطي ليعمل النقر على المعاينة أو أزرار التكبير دائماً */
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
      if (zoom) zoom.addEventListener('click', expand);
      if (imgEl) imgEl.addEventListener('click', expand);
      expandTool.addEventListener('click', expand);
      fig.addEventListener('click', (e) => {
        const t = e && e.target;
        const act = findAction(t, fig);
        if (act === 'open' || act === 'download') return;
        if (act === 'expand') { expand(e); return; }
        /* للصور: الضغط في أي مكان على بطاقة المعاينة يعرض الصورة كاملة */
        if (!isVideo) expand(e);
      });
    }
    return fig;
  }

  /* =========================================================
     العارض المكبّر (Lightbox)
     ---------------------------------------------------------
     التكبير هنا «حقيقي»: نُعيد رسم الصورة بالمقاس المطلوب
     بالبكسل (لا transform: scale الذي يشوّش الصورة)، فتظهر
     بالحجم الأصلي 100% أو أكبر منه، مع تمرير وسحب للتنقّل
     داخل الصورة الكبيرة.
     ========================================================= */
  let viewer = null;

  /* مستويات التكبير (1 = الحجم الحقيقي بالبكسل) */
  const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

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
      open: byId('mediaOpen'),
      download: byId('mediaDownload'),
      prev: byId('mediaPrev'),
      next: byId('mediaNext'),
      close: byId('mediaClose'),
      zoomIn: byId('mediaZoomIn'),
      zoomOut: byId('mediaZoomOut'),
      zoomLevel: byId('mediaZoomLevel'),
      items: [],
      index: 0,
      img: null,
      zoom: 'fit',        /* 'fit' = ملء الشاشة · أو معامل رقمي (1 = 100%) */
      pendingZoom: null,  /* تكبير مطلوب قبل اكتمال تحميل الصورة */
      panMoved: false
    };
    if (!v.stage) return null;
    const hide = () => closeViewer();
    if (v.close) v.close.addEventListener('click', hide);
    root.addEventListener('click', (e) => {
      const t = e && e.target;
      const act = findAction(t, root);
      const onCanvas = !!(t && t.classList && t.classList.contains('media-lightbox__canvas'));
      if (act === 'close' || t === v.stage || onCanvas ||
        (t && t.classList && t.classList.contains('media-lightbox__frame'))) {
        if (e && e.preventDefault) e.preventDefault();
        hide();
      }
    });
    if (v.prev) v.prev.addEventListener('click', () => stepViewer(-1));
    if (v.next) v.next.addEventListener('click', () => stepViewer(1));
    if (v.zoomIn) v.zoomIn.addEventListener('click', () => stepViewerZoom(1));
    if (v.zoomOut) v.zoomOut.addEventListener('click', () => stepViewerZoom(-1));
    if (v.zoomLevel) {
      v.zoomLevel.addEventListener('click', () => {
        if (!v.img) return;
        if (v.zoom === 'fit') applyViewerZoom(v, 1);
        else applyViewerZoom(v, 'fit');
      });
    }
    /* عجلة الفأرة: تكبير/تصغير متدرّج (مع منع تمرير الصفحة) */
    v.stage.addEventListener('wheel', (e) => {
      if (!v.img) return;
      if (e && e.preventDefault) e.preventDefault();
      const delta = Number(e.deltaY) || 0;
      if (!delta) return;
      stepViewerZoom(delta < 0 ? 1 : -1);
    }, { passive: false });
    /* سحب الصورة المكبّرة للتنقّل داخلها (بالفأرة؛ اللمس يمرّر natively) */
    v.stage.addEventListener('pointerdown', (e) => {
      if (!v.img || v.zoom === 'fit') return;
      if (e && e.pointerType && e.pointerType !== 'mouse') return;
      if (e && e.button !== undefined && e.button !== 0) return;
      const t = e && e.target;
      if (t && t.closest && t.closest('.media-lightbox__nav')) return;
      v.pan = {
        x: Number(e.clientX) || 0,
        y: Number(e.clientY) || 0,
        sl: Number(v.stage.scrollLeft) || 0,
        st: Number(v.stage.scrollTop) || 0
      };
      v.panMoved = false;
      if (v.stage.classList && v.stage.classList.add) v.stage.classList.add('is-panning');
      if (e && e.preventDefault) e.preventDefault();
    });
    v.stage.addEventListener('pointermove', (e) => {
      if (!v.pan) return;
      const dx = (Number(e.clientX) || 0) - v.pan.x;
      const dy = (Number(e.clientY) || 0) - v.pan.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) v.panMoved = true;
      v.stage.scrollLeft = v.pan.sl - dx;
      v.stage.scrollTop = v.pan.st - dy;
      if (e && e.preventDefault) e.preventDefault();
    });
    const endPan = () => {
      if (!v.pan) return;
      v.pan = null;
      if (v.stage.classList && v.stage.classList.remove) v.stage.classList.remove('is-panning');
    };
    v.stage.addEventListener('pointerup', endPan);
    v.stage.addEventListener('pointercancel', endPan);
    v.stage.addEventListener('pointerleave', endPan);
    /* تكبير باللمس (إصبعان) داخل العارض */
    let pinch = null;
    v.stage.addEventListener('touchstart', (e) => {
      if (!v.img || !e || !e.touches || e.touches.length !== 2) return;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinch = {
        dist: Math.sqrt(Math.pow(t1.clientX - t0.clientX, 2) + Math.pow(t1.clientY - t0.clientY, 2)),
        factor: v.zoom === 'fit' ? 1 : Number(v.zoom) || 1
      };
    }, { passive: true });
    v.stage.addEventListener('touchmove', (e) => {
      if (!pinch || !e || !e.touches || e.touches.length !== 2) return;
      if (e.cancelable && e.preventDefault) e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.sqrt(Math.pow(t1.clientX - t0.clientX, 2) + Math.pow(t1.clientY - t0.clientY, 2));
      if (!pinch.dist || !dist) return;
      const next = Math.min(8, Math.max(0.25, pinch.factor * (dist / pinch.dist)));
      applyViewerZoom(v, next);
    }, { passive: false });
    const endPinch = () => { pinch = null; };
    v.stage.addEventListener('touchend', endPinch);
    v.stage.addEventListener('touchcancel', endPinch);
    viewer = v;
    return v;
  }

  /** المقاس الفعلي (بكسل) للصورة عند معامل تكبير معيّن */
  function zoomedSize(nw, nh, factor) {
    return {
      w: Math.max(1, Math.round(nw * factor)),
      h: Math.max(1, Math.round(nh * factor))
    };
  }

  /** يحدّث مؤشّر مستوى التكبير وأزراره */
  function updateZoomUI(v) {
    if (!v) return;
    const isImg = !!v.img;
    const label = v.zoom === 'fit' ? 'ملء' : Math.round(Number(v.zoom) * 100) + '%';
    if (v.zoomLevel) {
      v.zoomLevel.textContent = label;
      v.zoomLevel.setAttribute('title', v.zoom === 'fit'
        ? 'اضغط لعرض الصورة بحجمها الحقيقي 100%'
        : 'اضغط للعودة إلى ملء الشاشة');
      if (v.zoomLevel.disabled !== undefined) v.zoomLevel.disabled = !isImg;
    }
    if (v.zoomIn && v.zoomIn.disabled !== undefined) v.zoomIn.disabled = !isImg;
    if (v.zoomOut && v.zoomOut.disabled !== undefined) v.zoomOut.disabled = !isImg;
  }

  /** يمرّر العرض ليبقى موضع النقطة (نسبة من الصورة) في منتصف الشاشة */
  function centerViewerOn(v, img, focus) {
    const stage = v && v.stage;
    if (!stage || !focus) return;
    const sw = Number(stage.clientWidth) || 0;
    const sh = Number(stage.clientHeight) || 0;
    if (!sw || !sh) return;
    const iw = Number(img.offsetWidth) || Number(img.naturalWidth) || 0;
    const ih = Number(img.offsetHeight) || Number(img.naturalHeight) || 0;
    if (!iw || !ih) return;
    stage.scrollLeft = Math.max(0, (iw * focus.px) - (sw / 2));
    stage.scrollTop = Math.max(0, (ih * focus.py) - (sh / 2));
  }

  /**
   * يطبّق حالة التكبير على صورة العارض.
   * factor = 'fit' لملء الشاشة، أو رقم: 1 = الحجم الحقيقي 100%، 2 = الضِعف…
   */
  function applyViewerZoom(v, factor, focus) {
    if (!v || !v.img) return;
    const img = v.img;
    if (factor === 'fit' || !factor) {
      img.classList.remove('is-zoomed');
      img.style.width = '';
      img.style.height = '';
      v.zoom = 'fit';
      v.pendingZoom = null;
      updateZoomUI(v);
      if (v.stage) { v.stage.scrollLeft = 0; v.stage.scrollTop = 0; }
      return;
    }
    const nw = Number(img.naturalWidth) || 0;
    const nh = Number(img.naturalHeight) || 0;
    img.classList.add('is-zoomed');
    v.zoom = factor;
    if (!nw || !nh) {
      /* الحجم غير معروف بعد: تبقى الصورة بحجمها الطبيعي ونعيد الحساب عند التحميل */
      img.style.width = '';
      img.style.height = '';
      v.pendingZoom = factor;
    } else {
      const size = zoomedSize(nw, nh, factor);
      img.style.width = size.w + 'px';
      img.style.height = size.h + 'px';
      v.pendingZoom = null;
    }
    updateZoomUI(v);
    if (focus) centerViewerOn(v, img, focus);
  }

  /** نقرة على الصورة: تبديل بين ملء الشاشة والحجم الحقيقي 100% */
  function toggleViewerZoom(v, e) {
    if (!v || !v.img) return;
    if (v.zoom !== 'fit') { applyViewerZoom(v, 'fit'); return; }
    /* نقطة النقر داخل الصورة تبقى في مكانها بعد التكبير */
    let focus = null;
    const rect = (v.img.getBoundingClientRect && v.img.getBoundingClientRect()) || null;
    if (rect && rect.width && rect.height && e && typeof e.clientX === 'number') {
      focus = {
        px: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        py: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
      };
    }
    applyViewerZoom(v, 1, focus);
  }

  /** تكبير/تصغير متدرّج بالمستويات (اتجاه 1 للأكبر، -1 للأصغر) */
  function stepViewerZoom(dir) {
    const v = viewerRoot();
    if (!v || !v.img) return;
    const cur = v.zoom === 'fit' ? 0 : Number(v.zoom) || 0;
    let next = 'fit';
    if (dir > 0) {
      const bigger = ZOOM_STEPS.filter(z => z > cur + 0.001);
      next = bigger.length ? bigger[0] : ZOOM_STEPS[ZOOM_STEPS.length - 1];
    } else {
      const smaller = ZOOM_STEPS.filter(z => z < cur - 0.001);
      next = smaller.length ? smaller[smaller.length - 1] : 'fit';
    }
    applyViewerZoom(v, next);
  }

  /** إعادة الضبط: العودة إلى ملء الشاشة */
  function resetViewerZoom() {
    const v = viewerRoot();
    if (!v) return;
    applyViewerZoom(v, 'fit');
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
    v.img = null;
    v.zoom = 'fit';
    v.pendingZoom = null;
    updateZoomUI(v);
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
    v.img = null;
    v.zoom = 'fit';
    v.pendingZoom = null;
    if (v.stage) {
      v.stage.innerHTML = '';
      const canvas = make('div', 'media-lightbox__canvas');
      if (item && item.k === 'video') {
        const video = make('video', 'media-lightbox__video');
        video.src = item.u;
        video.setAttribute('controls', 'controls');
        video.setAttribute('autoplay', 'autoplay');
        video.setAttribute('playsinline', 'playsinline');
        canvas.appendChild(video);
      } else if (item) {
        const img = make('img', 'media-lightbox__img');
        img.alt = item.n || 'صورة';
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        img.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (v.panMoved) { v.panMoved = false; return; }   /* كان سحباً لا نقرة */
          toggleViewerZoom(v, e);
        });
        img.addEventListener('load', () => {
          if (v.pendingZoom) {
            const factor = v.pendingZoom;
            v.pendingZoom = null;
            applyViewerZoom(v, factor);
          }
        });
        img.src = item.u;
        canvas.appendChild(img);
        v.img = img;
      }
      v.stage.appendChild(canvas);
    }
    if (v.counter) {
      const countPart = v.items.length > 1 ? (v.index + 1) + ' / ' + v.items.length : '';
      const metaPart = item ? [item.n || '', item.s ? fmtSize(item.s) : ''].filter(Boolean).join(' · ') : '';
      v.counter.textContent = [countPart, metaPart].filter(Boolean).join('  —  ');
    }
    if (v.open) { v.open.setAttribute('href', item ? item.u : '#'); }
    if (v.download) { v.download.setAttribute('href', item ? item.u : '#'); if (item && item.n) v.download.setAttribute('download', item.n); }
    const many = v.items.length > 1;
    if (v.prev) v.prev.hidden = !many;
    if (v.next) v.next.hidden = !many;
    updateZoomUI(v);
  }

  /* =========================================================
     الواجهة العامة
     ========================================================= */
  global.WTMedia = {
    upload, validate, kindOf, safeURL, fmtSize, fmtDuration, extFor,
    orientationOf, previewBox,
    normalizeMedia, mediaList, packMedia, textBudget, label,
    renderCard, openViewer, closeViewer, stepViewer, providerOrder,
    stepViewerZoom, applyViewerZoom, toggleViewerZoom, zoomedSize, resetViewerZoom,
    providers: PROVIDERS,
    MAX_PER_MESSAGE, MAX_ENVELOPE,
    IMAGE_TYPES, VIDEO_TYPES
  };
})(typeof window !== 'undefined' ? window : globalThis);

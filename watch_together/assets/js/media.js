/* =========================================================
   WatchTogether — وسائط الغرفة (media.js)
   ---------------------------------------------------------
   • رفع الصور والفيديو إلى مواقع تخزين مجانية، ثم عرضها في
     الدردشة من الرابط الذي يعيده موقع الرفع، وتخزين الرابط
     في قاعدة البيانات مع الرسالة.
   • سلسلة مزوّدين (سلسلة بدائل): إن فشل مزوّد ننتقل للذي يليه
     تلقائياً، فلا يتعطّل الإرسال:
        1) Supabase Storage  — مساحة مجانية دائمة داخل مشروعك
        2) Catbox            — موقع مجاني دائم (ملف حتى 200 ميغا)
        3) Pomf2            — موقع مجاني بديل
        4) Uguu              — موقع مجاني مؤقّت (آخر حل)
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

  function randomId(n) {
    try { return U.randomToken(n || 16); }
    catch (e) { return Math.random().toString(36).slice(2, 2 + (n || 16)); }
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
    /* 1) Supabase Storage — مساحة مجانية دائمة في مشروعك */
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

    /* 2) Catbox — موقع مجاني دائم، حدّه 200 ميغا */
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

    /* 3) Pomf2 — موقع مجاني بديل */
    pomf2: {
      id: 'pomf2',
      label: 'Pomf2',
      note: 'موقع مجاني بديل',
      available() { return typeof global.FormData === 'function'; },
      upload(file, ctx, onProgress) {
        const form = new global.FormData();
        form.append('files[]', file, file.name || 'file');
        return request({
          url: 'https://pomf2.lain.la/upload.php',
          method: 'POST', body: form, onProgress, timeoutMs: 150000
        }).then((res) => {
          if (res.status < 200 || res.status >= 300) throw new Error('Pomf2: HTTP ' + res.status);
          let data = null;
          try { data = JSON.parse(res.text); } catch (e) { data = null; }
          const url = data && data.files && data.files[0] && data.files[0].url;
          if (!url) throw new Error('Pomf2: استجابة غير مفهومة');
          return url;
        });
      }
    },

    /* 4) Uguu — موقع مجاني مؤقّت (آخر حل في السلسلة) */
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
    const ids = Array.isArray(list) && list.length ? list.slice() : ['supabase', 'catbox', 'pomf2', 'uguu'];
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

    const roomId = String(opts.roomId || 'local').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'local';
    const path = 'rooms/' + roomId + '/' + Date.now() + '-' + randomId(16) + '.' + extFor(file, kind);
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

  /**
   * يبني عنصر بطاقة وسائط (صورة/فيديو).
   * @param {object} media  وسيط مُطبَّع
   * @param {{onExpand?:Function}} opts
   */
  function renderCard(media, opts) {
    opts = opts || {};
    const fig = make('figure', 'msg-media' + (media.k === 'video' ? ' msg-media--video' : ''));
    fig.setAttribute('data-media-kind', media.k);
    fig.setAttribute('data-media-url', media.u);

    const frame = make('div', 'msg-media__frame');
    frame.appendChild(make('div', 'msg-media__glow'));
    let zoom = null;
    let imgEl = null;

    if (media.k === 'video') {
      const video = make('video', 'msg-media__video');
      video.src = media.u;
      video.setAttribute('controls', 'controls');
      video.setAttribute('preload', 'metadata');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('aria-label', media.n || 'فيديو في الدردشة');
      frame.appendChild(video);
      const badge = make('span', 'msg-media__badge', { text: 'فيديو' });
      frame.appendChild(badge);
    } else {
      const img = make('img', 'msg-media__img');
      img.src = media.u;
      img.alt = media.n || 'صورة في الدردشة';
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.onload = () => { fig.classList.add('is-loaded'); };
      img.onerror = () => { fig.classList.add('is-error'); };
      frame.appendChild(img);
      imgEl = img;
      const zoomBtn = make('button', 'msg-media__zoom');
      zoomBtn.type = 'button';
      zoomBtn.setAttribute('data-act', 'expand');
      zoomBtn.setAttribute('aria-label', 'تكبير الصورة');
      zoomBtn.innerHTML = IC ? IC.html('maximize', 18) : '';
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
      cap.textContent = media.n + (media.s ? ' · ' + fmtSize(media.s) : '');
      fig.appendChild(cap);
    }
    if (opts.onExpand) {
      /* الربط المباشر (لا نعتمد على فقاعة الحدث) ليعمل النقر على الزر دائماً */
      const expand = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        opts.onExpand(media);
      };
      if (zoom) zoom.addEventListener('click', expand);
      if (imgEl) imgEl.addEventListener('click', expand);
      expandTool.addEventListener('click', expand);
      fig.addEventListener('click', (e) => {
        const t = e && e.target;
        const act = t && t.getAttribute ? t.getAttribute('data-act') : '';
        if (act === 'expand') expand(e);
      });
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
      open: byId('mediaOpen'),
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
      if (t && t.getAttribute && t.getAttribute('data-act') === 'close') { e.preventDefault(); hide(); }
    });
    if (v.prev) v.prev.addEventListener('click', () => stepViewer(-1));
    if (v.next) v.next.addEventListener('click', () => stepViewer(1));
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
        img.src = item.u;
        img.alt = item.n || 'صورة';
        v.stage.appendChild(img);
      }
    }
    if (v.counter) v.counter.textContent = v.items.length > 1 ? (v.index + 1) + ' / ' + v.items.length : '';
    if (v.open) { v.open.setAttribute('href', item ? item.u : '#'); }
    if (v.download) { v.download.setAttribute('href', item ? item.u : '#'); if (item && item.n) v.download.setAttribute('download', item.n); }
    const many = v.items.length > 1;
    if (v.prev) v.prev.hidden = !many;
    if (v.next) v.next.hidden = !many;
  }

  /* =========================================================
     الواجهة العامة
     ========================================================= */
  global.WTMedia = {
    upload, validate, kindOf, safeURL, fmtSize, extFor,
    normalizeMedia, mediaList, packMedia, textBudget, label,
    renderCard, openViewer, closeViewer, providerOrder,
    providers: PROVIDERS,
    MAX_PER_MESSAGE, MAX_ENVELOPE,
    IMAGE_TYPES, VIDEO_TYPES
  };
})(typeof window !== 'undefined' ? window : globalThis);

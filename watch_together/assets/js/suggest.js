/* =========================================================
   WatchTogether — محرك اقتراحات يوتيوب (suggest.js)
   يعمل بلا مفتاح Data API وبلا سيرفر:
     • توسيع القوائم      → IFrame API: loadPlaylist + getPlaylist()
     • الاقتراحات         → قائمة «الميكس» التلقائية RD<id> (خوارزمية يوتيوب نفسها)
     • العناوين والصور    → YouTube oEmbed (يدعم CORS) مع ذاكرة محلية
   كل المراحل لها بديل آمن: إن تعطّل مصدر ننتقل للتالي بدل أن نُسكت الواجهة.
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;
  const CFG = () => (global.WT_CONFIG && global.WT_CONFIG.youtube) || {};
  const META_TTL = 7 * 24 * 3600 * 1000;     /* العناوين تتغيّر نادراً */
  const SUGGEST_TTL = 6 * 3600 * 1000;       /* ذاكرة الاقتراحات لكل فيديو */

  const LIST_RE = /(?:[?&]list=)([a-zA-Z0-9_-]{2,64})/;
  const VIDEO_RE = /(?:[?&]v=|youtu\.be\/|shorts\/|live\/|embed\/)([a-zA-Z0-9_-]{11})/;
  const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  /* ---------- أدوات صغيرة ---------- */
  function watchUrl(id, listId) {
    return 'https://www.youtube.com/watch?v=' + id + (listId ? '&list=' + listId : '');
  }
  function thumb(id) { return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'; }

  function timedFetch(url, ms) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 6000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /** هل الرابط يحمل قائمة تشغيل؟ يعيد {list, kind, videoId, index} أو null */
  function parseListUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const lm = s.match(LIST_RE);
    if (!lm) return null;
    const list = lm[1];
    const prefix = list.slice(0, 2).toUpperCase();
    if (!/^(PL|UU|LL|RD|OL|FL|TL)$/.test(prefix)) return null;
    const vm = s.match(VIDEO_RE);
    const im = s.match(/(?:[?&]index=)(\d{1,4})/);
    return {
      list: list,
      kind: prefix === 'RD' ? 'mix' : prefix === 'UU' ? 'uploads' : 'playlist',
      videoId: vm && ID_RE.test(vm[1]) ? vm[1] : '',
      index: im ? Math.max(1, parseInt(im[1], 10) || 1) : 0
    };
  }

  /* ---------- مِسبار يوتيوب المخفي ----------
     مشغّل صغير غير مرئي نستخدمه لقراءة محتوى قائمة (معرفات فقط) دون تشغيلها. */
  let probeHost = null;
  function ensureProbeHost() {
    if (probeHost && probeHost.isConnected) return probeHost;
    probeHost = document.createElement('div');
    probeHost.className = 'yt-probe-host';
    probeHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probeHost);
    return probeHost;
  }

  function ytApi() {
    if (global.WTPlayer && global.WTPlayer.loadYouTubeApi) return global.WTPlayer.loadYouTubeApi();
    return Promise.reject(new Error('مشغّل يوتيوب غير متاح'));
  }

  /**
   * يقرأ معرّفات قائمة يوتيوب (بما في ذلك قوائم الميكس RD وقوائم القناة UU).
   * @param {string} listId  معرّف القائمة
   * @param {{limit?:number, timeoutMs?:number}} opts
   * @returns {Promise<string[]>}
   */
  function probeList(listId, opts) {
    opts = opts || {};
    const limit = opts.limit || 40;
    return ytApi().then((YT) => new Promise((resolve, reject) => {
      const host = ensureProbeHost();
      const holder = document.createElement('div');
      host.appendChild(holder);
      let player = null, poll = null, timer = null, done = false;

      const finish = (ids, err) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        const dead = player;
        setTimeout(() => { try { dead && dead.destroy && dead.destroy(); } catch (e) { } holder.remove(); }, 80);
        if (err) reject(err); else resolve(ids || []);
      };
      let emptyPolls = 0;
      const read = () => {
        try {
          const p = player && player.getPlaylist && player.getPlaylist();
          if (!Array.isArray(p)) return;
          if (p.length) { finish(p.filter(ID_RE.test.bind(ID_RE)).slice(0, limit)); return; }
          /* قائمة فارغة معلومة (الحالة 5 = مهيّأة) — لا جدوى من انتظار المهلة كاملة */
          let st = -1;
          try { st = player.getPlayerState ? player.getPlayerState() : -1; } catch (e) { }
          if ((st === 5 || st === -1) && ++emptyPolls >= 3) finish([]);
        } catch (e) { /* لم يجهز بعد */ }
      };

      try {
        player = new YT.Player(holder, {
          playerVars: {
            listType: 'playlist', list: listId,
            controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1,
            playsinline: 1, iv_load_policy: 3, cc_load_policy: 0,
            enablejsapi: 1, origin: location.origin
          },
          events: {
            onReady: () => {
              try { player.mute(); } catch (e) { }
              read();
              poll = setInterval(read, 250);
              timer = setTimeout(() => finish(null, new Error('تعذّر قراءة محتوى القائمة من يوتيوب')), opts.timeoutMs || 9000);
            },
            onError: () => finish(null, new Error('هذه القائمة غير متاحة للتضمين (قد تكون خاصة أو محذوفة)'))
          }
        });
      } catch (err) { finish(null, err); }
    }));
  }

  /* ---------- العناوين والصور (oEmbed + ذاكرة) ---------- */
  const metaMemo = new Map();

  function readCache(id) {
    const v = U.store.get('ytmeta:' + id, null);
    if (v && v.ts && Date.now() - v.ts < META_TTL) return v;
    return null;
  }

  function fetchMetaOne(id) {
    if (metaMemo.has(id)) return Promise.resolve(metaMemo.get(id));
    const cached = readCache(id);
    if (cached) { metaMemo.set(id, cached); return Promise.resolve(cached); }

    const direct = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const fallbacks = (CFG().oembedFallbacks || []).map(b => b + encodeURIComponent('https://www.youtube.com/watch?v=' + id));

    return timedFetch(direct, 6000)
      .catch(() => {
        if (!fallbacks.length) throw new Error('no-oembed');
        return fallbacks.reduce((p, url) => p.catch(() => timedFetch(url, 6000)), Promise.reject(new Error('no-oembed')));
      })
      .then((d) => {
        /* author_url قد يكون /channel/UC… (مفيد لاقتراحات نفس القناة) أو @handle */
        const au = (d && d.author_url) ? String(d.author_url) : '';
        const cm = au.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
        const rec = {
          id: id,
          title: U.cleanName((d && (d.title || d.name)) || '') || 'فيديو يوتيوب',
          author: U.cleanName((d && d.author_name) || '') || '',
          channel: cm ? cm[1] : '',
          thumb: (d && d.thumbnail_url) || thumb(id),
          ts: Date.now()
        };
        U.store.set('ytmeta:' + id, rec);
        metaMemo.set(id, rec);
        return rec;
      })
      .catch(() => {
        const rec = { id: id, title: 'فيديو يوتيوب (' + id + ')', author: '', thumb: thumb(id), ts: Date.now() };
        metaMemo.set(id, rec);
        return rec;
      });
  }

  /** يجلب بيانات مجموعة معرّفات (توازٍ محدود حتى لا نُثقل الشبكة) */
  function meta(ids) {
    const list = (ids || []).filter(ID_RE.test.bind(ID_RE));
    const out = [];
    let cursor = 0;
    const workers = new Array(Math.min(4, Math.max(1, list.length))).fill(0).map(() => {
      const step = () => {
        if (cursor >= list.length) return Promise.resolve();
        const id = list[cursor++];
        return fetchMetaOne(id).then(rec => { out.push(rec); return step(); });
      };
      return step();
    });
    return Promise.all(workers).then(() => {
      const byId = new Map(out.map(r => [r.id, r]));
      return list.map(id => byId.get(id)).filter(Boolean);
    });
  }

  function decorate(ids, source) {
    return meta(ids).then(rows => rows.map(r => Object.assign({
      id: r.id, title: r.title, author: r.author, thumb: r.thumb,
      url: watchUrl(r.id), source: source
    }, {})));
  }

  /* ---------- الاقتراحات ---------- */
  function cachedSuggestions(videoId) {
    const key = 'ytsug:' + videoId;
    const v = U.store.get(key, null);
    if (v && v.ts && Date.now() - v.ts < SUGGEST_TTL && Array.isArray(v.items)) return v.items;
    return null;
  }
  function cacheSuggestions(videoId, items) {
    try { U.store.set('ytsug:' + videoId, { ts: Date.now(), items: items }); } catch (e) { }
  }

  /** مرايا اختيارية (Piped/Invidius) — لا تُستخدم إلا إن ضبطها صاحب الموقع في config.js */
  function fromMirror(videoId) {
    const mirrors = CFG().mirrors || [];
    if (!mirrors.length) return Promise.resolve([]);
    return mirrors.reduce((p, base) => p.then(found => {
      if (found.length) return found;
      const url = String(base).replace(/\/$/, '') + '/streams/' + encodeURIComponent(videoId);
      return timedFetch(url, 7000).then((d) => {
        const rel = d && d.relatedStreams;
        if (!Array.isArray(rel)) return [];
        return rel.map(s => String(s.url || '').match(VIDEO_RE)).filter(Boolean).map(m => m[1]).filter(ID_RE.test.bind(ID_RE));
      }).catch(() => []);
    }), Promise.resolve([]));
  }

  /**
   * اقتراحات بحسب محتوى الفيديو الحالي.
   * @param {string} videoId
   * @param {{excludeIds?:string[], playlist?:{id:string,ids:string[]}, channelId?:string, limit?:number, fresh?:boolean}} ctx
   * @returns {Promise<{items:Array, source:string}>}
   */
  async function forVideo(videoId, ctx) {
    ctx = ctx || {};
    if (!ID_RE.test(String(videoId || ''))) return { items: [], source: 'none' };

    if (!ctx.fresh) {
      const hit = cachedSuggestions(videoId);
      if (hit) return { items: hit, source: 'cache' };
    }

    const limit = ctx.limit || CFG().suggestLimit || 12;
    /* ميزانية زمنية واحدة لكل المصادر: إن تعطّل مصدر لا نُبقي المشاهد ينتظر */
    const deadline = Date.now() + (ctx.budgetMs || CFG().suggestBudgetMs || 6000);
    const budget = (cap) => Math.max(700, Math.min(cap, deadline - Date.now()));
    const seen = new Set([videoId]);
    (ctx.excludeIds || []).forEach(id => seen.add(id));
    const picked = [];
    const take = (ids, source) => {
      (ids || []).forEach((id) => {
        if (!ID_RE.test(id) || seen.has(id) || picked.length >= limit) return;
        seen.add(id);
        picked.push({ id: id, source: source });
      });
    };

    /* 1) تكملة نفس القائمة: إن كان الفيديو من قائمة مستوردة، فالتالي منها هو الأحق */
    if (ctx.playlist && ctx.playlist.ids && ctx.playlist.ids.length) {
      const at = ctx.playlist.ids.indexOf(videoId);
      if (at >= 0) take(ctx.playlist.ids.slice(at + 1, at + 1 + Math.min(6, limit)), 'playlist');
    }

    /* 2) ميكس يوتيوب التلقائي (RD) — نفس خوارزمية الاقتراح التي يستخدمها يوتيوب */
    if (picked.length < limit && Date.now() < deadline) {
      try { take(await probeList('RD' + videoId, { limit: limit + 3, timeoutMs: budget(9000) }), 'mix'); }
      catch (e) { /* نكمل بالمصدر التالي */ }
    }

    /* 3) أحدث فيديوهات نفس القناة (UU…) — بديل قريب من المحتوى */
    if (picked.length < limit && Date.now() < deadline &&
        ctx.channelId && /^UC[a-zA-Z0-9_-]{22}$/.test(ctx.channelId)) {
      try { take(await probeList('UU' + ctx.channelId.slice(2), { limit: 12, timeoutMs: budget(3500) }), 'channel'); }
      catch (e) { /* تجاهل */ }
    }

    /* 4) مرايا اختيارية يضبطها صاحب الموقع */
    if (picked.length < limit && Date.now() < deadline) {
      try { take(await fromMirror(videoId), 'mirror'); } catch (e) { /* تجاهل */ }
    }

    const items = await decorate(picked.map(p => p.id), 'youtube');
    const withSource = items.map((it, i) => Object.assign(it, { reason: picked[i] ? picked[i].source : 'youtube' }));
    const source = withSource.length ? (withSource[0].reason || 'youtube') : 'none';
    if (withSource.length) cacheSuggestions(videoId, withSource);
    return { items: withSource, source: source };
  }

  /**
   * توسيع قائمة تشغيل إلى عناصر جاهزة للإضافة.
   * @param {string} listInput رابط أو معرّف القائمة
   */
  function playlistItems(listInput, opts) {
    opts = opts || {};
    const parsed = parseListUrl(listInput) ||
      (/^(PL|UU|LL|OL|FL|TL)[a-zA-Z0-9_-]+$/.test(String(listInput || '')) ? { list: listInput, kind: 'playlist', videoId: '', index: 0 } : null);
    if (!parsed) return Promise.reject(new Error('رابط القائمة غير صالح'));
    return probeList(parsed.list, { limit: opts.limit || CFG().maxImport || 60 })
      .then(ids => decorate(ids, 'playlist'))
      .then(items => ({ list: parsed.list, kind: parsed.kind, videoId: parsed.videoId, items: items }));
  }

  global.WTSuggest = {
    parseListUrl,
    parseVideoId(raw) {
      const m = String(raw || '').match(VIDEO_RE);
      return m && ID_RE.test(m[1]) ? m[1] : (ID_RE.test(String(raw || '').trim()) ? String(raw).trim() : '');
    },
    probeList,
    meta,
    forVideo,
    playlistItems,
    watchUrl,
    thumb,
    timedFetch,
    clearCache() { metaMemo.clear(); }
  };
})(window);

/* =========================================================
   WatchTogether — صفحة البحث (search.js)
   ---------------------------------------------------------
   • مصدران: ديليموشن ويوتيوب، من سيرفر Java (/api/search).
   • ديليموشن: عند الضغط يستخرج السيرفر رابط تشغيل مباشر
     عبر yt-dlp (WTResolve → /api/resolve) ويُشغّل في <video>.
   • يوتيوب: لا يحتاج استخراجاً — يُشغّل بمشغّله الرسمي
     داخل iframe (بلا مفتاح API).
   • من أي نتيجة: افتح غرفة، أو أضفها إلى قائمة انتظار غرفة
     موجودة (تُسلَّم عبر sessionStorage وتُقرأ في room.js).
   التزام: بلا مكتبات خارجية · RTL · وصولية · Midnight Gold
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const IC = window.WTIcons;
  const Auth = window.WTAuth;
  const Rooms = window.WTRooms;
  const Favorites = window.WTFavorites;

  const $ = id => document.getElementById(id);
  const el = {
    form: $('searchForm'), input: $('searchInput'), go: $('searchGo'), clear: $('searchClear'),
    sources: $('searchSources'), types: $('searchTypes'), chips: $('searchChips'), status: $('searchStatus'), note: $('serverNote'),
    noteText: $('serverNoteText'),
    results: $('results'), empty: $('empty'), emptyText: $('emptyText'),
    browseBar: $('browseBar'), browseBack: $('browseBack'), browseTitle: $('browseTitle'), browseMeta: $('browseMeta'),
    browseMore: $('browseMore'), browseLoadMore: $('browseLoadMore'),
    dialog: $('playDialog'), dTitle: $('playTitle'), dClose: $('playClose'),
    stage: $('playStage'), spinner: $('playSpinner'), spinnerText: $('playSpinnerText'),
    video: $('playVideo'), error: $('playError'),
    room: $('playRoom'), queue: $('playQueue'), favorite: $('playFavorite'), channel: $('playChannel'), copy: $('playCopy'),
    source: $('playSource'), hint: $('playHint'),
    picker: $('roomPicker'), pickerList: $('pickerList'), pickerEmpty: $('pickerEmpty'),
    pickerClose: $('pickerClose')
  };

  const QUICK_DM = ['وثائقيات', 'موسيقى', 'طبخ', 'رياضة', 'تقنية', 'أفلام قصيرة'];
  const QUICK_YT = ['محاضرات', 'قرآن', 'أغاني', 'برمجة', 'طبخ', 'رياضة'];
  const RECENT_KEY = 'search:recent';
  const SITE_KEY = 'search:site';
  const PENDING = 'pending-queue:';
  const LIMIT = 18;

  /* اقتراحات حقيقية (روابط فعلية موجودة على كل منصة) تُعرض عندما لا يعثر البحث على نتائج.
     ليست نتائج مزيفة — كل رابط يشير إلى محتوى حقيقي على المنصة الأصلية. */
  const SUGGESTED = {
    youtube: [
      { id: 'dQw4w9WgXcQ', site: 'youtube', title: 'Rick Astley - Never Gonna Give You Up (Official)', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', duration: 213, author: 'Rick Astley' }
    ],
    dailymotion: [
      { id: 'x76l7q9', site: 'dailymotion', title: 'فيديو مقترح من ديليموشن', url: 'https://www.dailymotion.com/video/x76l7q9', thumb: 'https://www.dailymotion.com/thumbnail/video/x76l7q9', duration: 0, author: 'Dailymotion' }
    ],
  };

  const state = {
    query: '', site: 'dailymotion', searchType: 'all', items: [], viewItems: [], view: 'search', loading: false,
    browse: null, favoriteKeys: new Set(), favoriteError: null,
    server: null,            /* null = لم يُختبر · true = سيرفر Java · false = استضافة ثابتة */
    reason: '',              /* سبب تعذّر الوصول إلى /api/search (نص تشخيصي) */
    token: 0,                /* رقم مسلسل للبحث الجاري — يمنع نتائج قديمة من التغطية على جديدة */
    direct: new Map(),       /* معرّف الفيديو ← رابط التشغيل */
    current: null, busyId: null
  };

  /* ============================== 1) أدوات ============================== */

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem('wt:' + key) || 'null');
      localStorage.setItem('wt:' + key, JSON.stringify(value));
    } catch (e) { /* التخزين محجوب */ }
    return null;
  }

  function recent() {
    const list = store(RECENT_KEY);
    return Array.isArray(list) ? list.filter(v => typeof v === 'string') : [];
  }

  function pushRecent(term) {
    const clean = String(term || '').trim();
    if (clean.length < 2) return;
    store(RECENT_KEY, [clean].concat(recent().filter(v => v !== clean)).slice(0, 6));
  }

  function status(message, isError) {
    el.status.textContent = message || '';
    el.status.hidden = !message;
    el.status.classList.toggle('is-error', !!isError);
  }

  function skeleton(count) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += '<div class="result-card result-card--skeleton" aria-hidden="true">' +
        '<div class="result-card__thumb"></div>' +
        '<div class="result-card__body"><div class="sk-line"></div><div class="sk-line sk-line--short"></div></div></div>';
    }
    el.results.innerHTML = html;
    el.results.setAttribute('aria-busy', 'true');
  }

  function duration(sec) {
    const n = Number(sec) || 0;
    return n > 0 ? U.fmtTime(n) : '';
  }

  /* ============================== 2) مصدر النتائج ============================== */

  function safeYouTubeProfile(raw) {
    try {
      const url = new URL(String(raw || '').trim());
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (url.protocol !== 'https:' || !['youtube.com', 'm.youtube.com'].includes(host) || url.username || url.password) return '';
      if (!/^\/(?:channel\/UC[A-Za-z0-9_-]{20,30}|@[A-Za-z0-9._-]{3,64}|c\/[A-Za-z0-9._-]{1,64}|user\/[A-Za-z0-9._-]{1,64})(?:\/.*)?$/.test(url.pathname)) return '';
      const match = url.pathname.match(/^\/(channel\/UC[A-Za-z0-9_-]{20,30}|@[A-Za-z0-9._-]{3,64}|c\/[A-Za-z0-9._-]{1,64}|user\/[A-Za-z0-9._-]{1,64})/);
      return match ? 'https://www.youtube.com/' + match[1] : '';
    } catch (_) { return ''; }
  }

  function safeWebUrl(raw, httpsOnly) {
    try {
      const url = new URL(String(raw || '').trim());
      if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) || url.username || url.password) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function normalize(raw, site) {
    if (!raw || typeof raw !== 'object') return null;
    const source = String(raw.site || site || '').toLowerCase();
    const isYT = source === 'youtube' || source === 'yt';
    const isDM = source === 'dailymotion' || source === 'dm';
    const type = ['video', 'channel', 'playlist'].includes(String(raw.type || '').toLowerCase())
      ? String(raw.type || '').toLowerCase() : 'video';
    let id = String(raw.id || '').trim();
    let url = String(raw.url || '').trim();
    if (type === 'video') {
      if (isYT) {
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) id = U.parseYouTube(url) || '';
        if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
        url = 'https://www.youtube.com/watch?v=' + id;
      } else if (isDM) {
        if (!/^[A-Za-z0-9]{1,32}$/.test(id)) {
          const match = url.match(/(?:dailymotion\.com\/(?:video)\/|dai\.ly\/)([A-Za-z0-9]+)/i);
          id = match ? match[1] : '';
        }
        if (!/^[A-Za-z0-9]{1,32}$/.test(id)) return null;
        if (!url) url = 'https://www.dailymotion.com/video/' + id;
      } else {
        if (!url) return null;
        id = id || url;
      }
    } else if (type === 'channel') {
      if (!isYT) return null;
      const profile = safeYouTubeProfile(url || raw.channelUrl || raw.channel_url);
      if (!profile) return null;
      url = profile;
      id = id || String(raw.channelId || raw.channel_id || profile);
    } else if (type === 'playlist') {
      if (!isYT) return null;
      const playlist = U.parseYouTubePlaylist(url) || id;
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(playlist)) return null;
      id = playlist;
      url = 'https://www.youtube.com/playlist?list=' + id;
    }
    url = safeWebUrl(url, false);
    if (!url) return null;
    let thumb = safeWebUrl(raw.thumb || raw.thumbnail || '', true);
    if (!thumb && isYT && type === 'video') thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    if (!thumb && isDM) thumb = 'https://www.dailymotion.com/thumbnail/video/' + id;
    const author = String(raw.author || raw.owner || raw.channel || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const channelId = String(raw.channelId || raw.channel_id || '').trim().slice(0, 120);
    const channelUrl = isYT ? safeYouTubeProfile(raw.channelUrl || raw.channel_url ||
      (channelId.match(/^UC[A-Za-z0-9_-]{20,30}$/) ? 'https://www.youtube.com/channel/' + channelId : '')) : '';
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 240) || 'بدون عنوان';
    return {
      id, type, site: isYT ? 'youtube' : isDM ? 'dailymotion' : (source || 'external'),
      title, url, thumb, duration: Number(raw.duration) || 0, author,
      channelId, channelUrl, count: Number(raw.count || raw.channel_follower_count || 0) || 0
    };
  }

  /**
   * المحاولة الأولى: سيرفر Java (yt-dlp، أو واجهة ديليموشن عبر السيرفر).
   * نفرّق بدقّة بين ثلاث حالات كانت تُظهر كلها رسالة واحدة مبهمة:
   *   1) لا سيرفر أصلاً (ملف file://، منفذ خاطئ، سيرفر قديم) → null
   *   2) السيرفر موجود لكن خدمة البحث معطّلة (5xx) → خطأ serverDown
   *   3) خطأ من عندنا (4xx) → خطأ عادي
   */
  async function fromServer(term, limit, site, type, browse) {
    const api = (window.WTServer && window.WTServer.api) ? window.WTServer.api('api/search') : 'api/search';
    const params = new URLSearchParams({ q: term || '', limit: String(limit), site: String(site || '') });
    if (browse) {
      params.set('browse', browse.type);
      params.set('url', browse.url);
      params.set('offset', String(browse.offset || 0));
    } else if (site === 'youtube') {
      params.set('type', type || 'video');
    }
    const url = api + '?' + params.toString();
    let response = null;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (networkError) {
      state.reason = location.protocol === 'file:'
        ? 'الصفحة مفتوحة كملف (file://) لا عبر السيرفر'
        : 'تعذّر الاتصال بالسيرفر على ' + (location.host || 'العنوان الحالي');
      return null;
    }
    let text = '';
    try { text = await response.text(); } catch (e) { text = ''; }
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!response.ok) {
      const message = (data && data.error) ? data.error : 'استجابة غير متوقعة (' + response.status + ')';
      if (response.status === 426) {                            /* ليس سيرفر API أصلاً */
        state.status = 426;
        state.reason = wrongApiMessage(String(api).replace(/\/api\/search$/, ''), 426);
        return null;
      }
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        state.reason = await diagnoseMissing(response.status);   /* لا تستخدم status وحدها: هي دالة العرض */
        return null;
      }
      if (response.status >= 400 && response.status < 500) throw new Error(message);
      const error = new Error(message);              /* 5xx: السيرفر موجود لكن yt-dlp/Python معطّل */
      error.serverDown = true;
      error.status = response.status;
      throw error;
    }
    if (!data || !Array.isArray(data.items)) { state.reason = 'استجابة غير مفهومة من /api/search'; return null; }
    state.reason = '';
    return {
      items: data.items.map(item => normalize(item, site)).filter(Boolean), source: data.source || 'server',
      hasMore: !!data.hasMore, nextOffset: Number(data.nextOffset) || 0, browseType: data.browseType || '', browseUrl: data.browseUrl || ''
    };
  }

  /** هل الصفحة على جهازك أو شبكتك المحلية؟ (خلاف ذلك: استضافة عامة/ثابتة) */
  function privateHost() {
    if (window.WTServer && typeof window.WTServer.isPrivateHost === 'function') return window.WTServer.isPrivateHost();
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|\[::1\])/i
      .test(String(location.hostname || ''));
  }

  /**
   * عنوان السيرفر **الفعلي** الذي ستُوجَّه إليه الطلبات:
   * WTServer.apiBase() (config.js أو ?api= أو localStorage) ثم config.js.
   */
  function apiBaseUrl() {
    if (window.WTServer && typeof window.WTServer.apiBase === 'function') {
      const eff = window.WTServer.apiBase();
      if (eff) return String(eff).replace(/\/+$/, '');
    }
    const js = window.WT_CONFIG && window.WT_CONFIG.javaServer;
    return js && js.apiBase ? String(js.apiBase).replace(/\/+$/, '') : '';
  }

  /**
   * ردّ 426 Upgrade Required: العنوان يرفض طلبات HTTP العادية كلها.
   * سيرفرنا (Java) لا يردّ 426 أبداً — فمن يفعل هو غالباً خدمة WebSocket
   * لشخص آخر، أي: **العنوان المضبوط ليس سيرفر API**. نقولها صراحة بدل
   * «تعذّر الاتصال» الذي يوحي بأن السيرفر نائم أو معطّل.
   */
  function wrongApiMessage(api, status) {
    return 'السيرفر ' + (api || location.origin) + ' ردّ ' + status + ' Upgrade Required — أي أنه لا يخدم طلبات HTTP عادية ' +
      '(خدمة WebSocket فقط، أو عنوان خدمة أخرى غير خدمتك). انسخ عنوان خدمتك من لوحة Render ' +
      '(الرابط أعلى صفحة الخدمة) وجرّبه فوراً بإضافة ?api=<العنوان> للرابط.';
  }

  /**
   * /api/search غير موجود (404): هل هو سيرفر Java قديم، أم ليس سيرفر Java أصلاً؟
   * نفحص /api/healthz لأنها موجودة في كل نسخة Java حديثة.
   */
  async function diagnoseMissing(status) {
    const from = location.origin && location.origin !== 'null' ? location.origin : 'ملف محلي (file://)';
    const base = 'الصفحة مفتوحة من ' + from + '، وهذا السيرفر لا يعرض /api/search (' + status + ')';
    if (!privateHost()) {
      return base + ' — استضافة ثابتة: اضبط javaServer.apiBase بعنوان سيرفر Render في assets/js/config.js';
    }
    let java = false;
    try {
      const health = (window.WTServer && window.WTServer.api) ? window.WTServer.api('healthz') : 'healthz';
      const probe = await fetch(health, { headers: { Accept: 'text/plain' }, cache: 'no-store' });
      java = !!probe && probe.ok;
    } catch (e) { java = false; }
    return base + ' — ' + (java
      ? 'سيرفر Java يعمل لكنه نسخة قديمة: أعد build.bat ثم run.bat'
      : 'هذا ليس سيرفر Java: شغّل run.bat وافتح الصفحة من العنوان الذي تطبعه اللافتة');
  }

  /** بديل للاستضافة الثابتة: واجهة ديليموشن العامة (يوتيوب بلا مفتاح → غير متاح) */
  async function fromDailymotion(term, limit) {
    const url = 'https://api.dailymotion.com/videos?search=' + encodeURIComponent(term) +
      '&limit=' + limit + '&sort=relevance&fields=id,title,thumbnail_720_url,duration';
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error('تعذّر الاتصال بديليموشن (HTTP ' + response.status + ')');
    const data = await response.json();
    const list = data && Array.isArray(data.list) ? data.list : [];
    return { items: list.map(item => normalize(item, 'dailymotion')).filter(Boolean), source: 'dailymotion' };
  }

  async function runSearch(term) {
    const query = String(term || '').trim();
    if (query.length < 2) { status('اكتب كلمتين على الأقل للبحث', true); el.input.focus(); return; }
    const token = ++state.token;
    state.view = 'search';
    state.browse = null;
    state.loading = true;
    state.query = query;
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    el.go.disabled = true;
    skeleton(8);
    el.empty.hidden = true;
    status('جارٍ البحث عن «' + query + '»…');
    try {
      let result = null;
      try {
        result = await fromServer(query, LIMIT, state.site, state.site === 'youtube' ? state.searchType : 'video');
        if (token !== state.token) return;
        state.server = result !== null;
      } catch (error) {
        if (token !== state.token) return;
        if (error && error.serverDown) {
          state.server = true;
          if (state.site !== 'dailymotion') throw error;
          try {
            result = await fromDailymotion(query, LIMIT);
            if (token !== state.token) return;
          } catch (_) { throw error; }
        } else {
          state.server = null;
          throw error;
        }
      }
      if (!result) {
        state.server = false;
        result = state.site === 'youtube' ? { items: [], source: 'none' } : await fromDailymotion(query, LIMIT);
        if (token !== state.token) return;
      }
      state.items = result.items.map(item => normalize(item, state.site)).filter(Boolean);
      state.viewItems = state.items;
      updateNote();
      if (!state.items.length) {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = false;
        if (state.site === 'youtube') {
          const requestedType = state.searchType === 'all' ? 'الفيديوهات والقنوات والقوائم' :
            ({ video: 'الفيديوهات', channel: 'القنوات', playlist: 'قوائم التشغيل' }[state.searchType] || 'النتائج');
          el.emptyText.textContent = state.server === false
            ? 'بحث يوتيوب يحتاج سيرفر Java مع yt-dlp' + (state.reason ? ' — ' + state.reason : '') +
              (privateHost()
                ? ' — افتح الصفحة من العنوان الذي تطبعه لافتة run.bat (مثل http://localhost:8081/search.html)'
                : ' — على استضافة ثابتة: اضبط javaServer.apiBase بعنوان سيرفر Render في assets/js/config.js') +
              ' — حدّث yt-dlp ثم أعد المحاولة: py -m pip install -U yt-dlp'
            : 'لم يُرجع يوتيوب ' + requestedType + ' عن «' + query + '» — حدّث yt-dlp ثم أعد المحاولة: py -m pip install -U yt-dlp';
        } else {
          el.emptyText.textContent = 'لا نتائج لـ «' + query + '» في ديليموشن — جرّب كلمة أخرى.';
        }
        status('');
        const suggested = state.searchType === 'video' ? (SUGGESTED[state.site] || []) : [];
        if (suggested.length) {
          el.empty.hidden = true;
          renderSuggested(suggested);
        }
      } else {
        const existing = el.results.parentNode.querySelector('.search-status--suggested');
        if (existing) existing.remove();
        render(state.items);
        pushRecent(query);
        status(state.items.length + ' نتيجة — المصدر: ' + (
          result.source === 'yt-dlp' ? 'yt-dlp على السيرفر' :
          result.source === 'dailymotion-api' ? 'واجهة ديليموشن' : 'ديليموشن مباشرة'
        ));
        loadFavoriteState(false).then(() => {
          if (token === state.token && state.view === 'search' && !state.browse) render(state.items);
        });
      }
      renderChips();
    } catch (error) {
      if (token !== state.token) return;
      el.results.innerHTML = '';
      el.results.setAttribute('aria-busy', 'false');
      el.empty.hidden = false;
      el.emptyText.textContent = error && error.serverDown
        ? 'خدمة البحث على السيرفر معطّلة (' + (error.status || '5xx') + '): ' + (error.message || '') +
          ' — حدّث yt-dlp: py -m pip install -U yt-dlp'
        : 'تعذّر البحث — تحقّق من الاتصال ثم أعد المحاولة';
      status(error && error.message ? error.message : 'تعذّر البحث', true);
    } finally {
      if (token === state.token) {
        state.loading = false;
        el.go.disabled = false;
      }
    }
  }

  function updateNote() {
    const noServer = state.server === false;
    el.note.hidden = !noServer;
    if (!noServer || !el.noteText) return;
    if (state.status === 426 && state.reason) { el.noteText.textContent = state.reason; return; }
    /* التوجيه يختلف جذرياً بين «جهازك» و«استضافة ثابتة» */
    let where;
    const api = apiBaseUrl();
    if (location.protocol === 'file:') {
      where = 'أنت تفتح الصفحة كملف (file://) — لا تعمل أي نقطة /api. شغّل run.bat ثم افتح العنوان الذي تطبعه اللافتة.';
    } else if (!privateHost()) {
      where = (api
        ? 'تعذّر الوصول إلى السيرفر ' + api + (state.reason ? ' — ' + state.reason : '') +
          '. تأكد أنه يعمل (افتح ' + api + '/healthz) وأن نطاق الموقع مضاف إلى WT_ALLOWED_ORIGINS.'
        : 'هذه استضافة ثابتة (' + (location.host || '') + ') ولا تحتوي أي نقطة /api. ' +
          'اضبط javaServer.apiBase بعنوان سيرفر Render في assets/js/config.js' +
          ' — أو جرّب الآن بإضافة ?api=https://<عنوان السيرفر> للرابط.');
    } else {
      where = (state.reason || '') + ' — أغلق كل نسخة قديمة (taskkill /F /IM java.exe) ثم شغّل run.bat واقرأ المنفذ من اللافتة.';
    }
    const siteMsg = state.site === 'youtube'
      ? 'بحث يوتيوب يحتاج سيرفر Java مع yt-dlp. '
      : 'نتائج البحث تعمل، لكن استخراج رابط التشغيل المباشر يحتاج سيرفر Java مع yt-dlp. ';
    el.noteText.textContent = siteMsg + where;
  }

  /* ============================== 3) العرض ============================== */

  function favoriteKey(item) {
    try { return Favorites && Favorites.identity ? Favorites.identity(item) : ''; }
    catch (_) { return ''; }
  }

  function isFavorite(item) {
    const key = favoriteKey(item);
    return !!key && state.favoriteKeys.has(key);
  }

  async function loadFavoriteState(force) {
    if (!Favorites || typeof Favorites.list !== 'function') return null;
    try {
      const list = await Favorites.list({ force: !!force });
      state.favoriteKeys = new Set(list.map(favoriteKey).filter(Boolean));
      state.favoriteError = null;
      return list;
    } catch (error) {
      state.favoriteError = error;
      state.favoriteKeys = new Set();
      return null;
    }
  }

  function paintFavoriteButton(button, saved) {
    if (!button) return;
    const on = !!saved;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
    const label = on ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  async function toggleFavorite(item) {
    if (!Favorites || typeof Favorites.toggle !== 'function') throw new Error('خدمة المفضّلة غير متاحة');
    const result = await Favorites.toggle(item);
    const key = favoriteKey(item);
    if (key) {
      if (result.saved) state.favoriteKeys.add(key);
      else state.favoriteKeys.delete(key);
    }
    if (state.view === 'favorites' && !result.saved)
      state.items = state.items.filter(value => favoriteKey(value) !== key);
    if (state.browse) {
      render(state.browse.items);
    } else {
      state.viewItems = state.items;
      render(state.items);
      if (state.view === 'favorites' && !result.saved) {
        status(state.items.length ? state.items.length + ' فيديو في مفضّلتك' : '');
        el.empty.hidden = state.items.length > 0;
        if (!state.items.length) el.emptyText.textContent = 'لم تحفظ فيديوهات بعد — اضغط القلب على فيديو لإضافته إلى مفضّلتك';
      }
    }
    paintFavoriteButton(el.favorite, state.current && isFavorite(state.current));
    U.toast(result.saved ? 'حُفظ الفيديو في مفضّلتك الشخصية' : 'أُزيل الفيديو من مفضّلتك', 'success', 2200);
    return result;
  }

  function render(items) {
    items = Array.isArray(items) ? items : [];
    state.viewItems = items;
    el.empty.hidden = items.length > 0;
    el.results.setAttribute('aria-busy', 'false');
    el.results.innerHTML = items.map((item, index) => {
      const type = item.type || 'video';
      const isVideo = type === 'video';
      const badge = isVideo ? duration(item.duration) : '';
      const tag = type === 'channel' ? 'قناة' : type === 'playlist' ? 'قائمة تشغيل' : '';
      const thumb = item.thumb
        ? '<img class="result-card__img" src="' + U.esc(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : '<span class="result-card__thumb--placeholder">' + IC.html(type === 'channel' ? 'users' : type === 'playlist' ? 'playlist' : 'film', 36) + '</span>';
      const channel = isVideo && item.channelUrl
        ? '<button class="result-card__channel" type="button" data-channel-index="' + index + '" aria-label="تصفّح قناة ' + U.esc(item.author || 'الفيديو') + '">' +
            IC.html('users', 14) + '<span>' + U.esc(item.author || 'افتح القناة') + ' · القناة</span></button>'
        : '';
      const author = item.author && !channel ? '<span class="result-card__author">' + U.esc(item.author) + '</span>' : '';
      const count = item.count > 0 ? '<span>' + U.esc(U.fmtCount ? U.fmtCount(item.count) : item.count) + '</span>' : '';
      const heart = isVideo
        ? '<button class="result-card__favorite' + (isFavorite(item) ? ' is-on' : '') + '" type="button" data-favorite-index="' + index + '" aria-pressed="' + String(isFavorite(item)) + '" aria-label="' + (isFavorite(item) ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة') + '" title="' + (isFavorite(item) ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة') + '">' + IC.html('heart', 18) + '</button>'
        : '';
      const action = isVideo ? 'تشغيل' : 'تصفّح';
      return '<article class="result-card result-card--' + U.esc(type) + '">' +
        '<button class="result-card__main" type="button" data-index="' + index + '" aria-label="' + action + ': ' + U.esc(item.title) + '">' +
          '<span class="result-card__thumb">' + thumb +
            (badge ? '<span class="result-card__badge">' + badge + '</span>' : '') +
            (tag ? '<span class="result-card__type">' + tag + '</span>' : '') +
            (isVideo ? '<span class="result-card__play"><span>' + IC.html('play', 22) + '</span></span>' : '') +
          '</span>' +
          '<span class="result-card__body">' +
            '<span class="result-card__title">' + U.esc(item.title) + '</span>' +
            '<span class="result-card__meta">' + author + count + '</span>' +
          '</span>' +
        '</button>' + channel + heart +
      '</article>';
    }).join('');
  }

  /* عرض اقتراحات حقيقية من المنصة عندما يكون البحث فارغاً — البطاقات تفتح الرابط الحقيقي في تبويب جديد */
  function renderSuggested(items) {
    /* إزالة أي توضيح سابق من بحث سابق */
    const existing = el.results.parentNode.querySelector('.search-status--suggested');
    if (existing) existing.remove();
    el.results.setAttribute('aria-busy', 'false');
    el.results.innerHTML = items.map((item, index) => {
      const badge = duration(item.duration);
      const author = item.author ? '<span class="result-card__author">' + U.esc(item.author) + '</span>' : '';
      const hasThumb = item.thumb ? '<img class="result-card__img" src="' + U.esc(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '<span class="result-card__thumb--empty">' + IC.html('film', 64) + '</span>';
      return '' +
        '<a class="result-card result-card--suggested" href="' + U.esc(item.url) + '" target="_blank" rel="noopener noreferrer" aria-label="افتح: ' + U.esc(item.title) + '">' +
          '<span class="result-card__thumb">' +
            hasThumb +
            (badge ? '<span class="result-card__badge">' + badge + '</span>' : '') +
            '<span class="result-card__open"><span>' + IC.html('link', 18) + '</span></span>' +
          '</span>' +
          '<span class="result-card__body">' +
            '<span class="result-card__title">' + U.esc(item.title) + '</span>' +
            '<span class="result-card__meta">' + author + '</span>' +
          '</span>' +
        '</a>';
    }).join('');
    /* رسالة توضيحية فوق الاقتراحات */
    const hint = document.createElement('p');
    hint.className = 'search-status search-status--suggested';
    hint.textContent = 'لا نتائج — مقترحات من ' + { youtube: 'يوتيوب', dailymotion: 'ديليموشن' }[state.site] || state.site;
    el.results.parentNode.insertBefore(hint, el.results);
  }

  function renderChips() {
    const list = recent();
    const quick = state.site === 'youtube' ? QUICK_YT
      : QUICK_DM;
    const terms = list.concat(quick.filter(v => list.indexOf(v) < 0)).slice(0, 8);
    el.chips.innerHTML = terms.map(term => {
      const isRecent = list.indexOf(term) >= 0;
      return '<button class="chip' + (term === state.query ? ' is-active' : '') + '" type="button" data-term="' + U.esc(term) + '">' +
        '<span>' + U.esc(term) + '</span>' +
        (isRecent ? '<span class="chip__x" data-remove="' + U.esc(term) + '" role="button" tabindex="0" aria-label="حذف من الأخيرة">×</span>' : '') +
        '</button>';
    }).join('');
  }

  function renderTabs() {
    if (el.sources) el.sources.querySelectorAll('[data-site]').forEach(tab => {
      const on = tab.getAttribute('data-site') === state.site;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    if (el.types) el.types.querySelectorAll('[data-search-type]').forEach(tab => {
      const on = state.view === 'search' && tab.getAttribute('data-search-type') === state.searchType;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      if (['channel', 'playlist'].includes(tab.getAttribute('data-search-type')))
        tab.hidden = state.site !== 'youtube';
    });
    if (el.types) el.types.querySelectorAll('[data-search-view]').forEach(tab => {
      const on = state.view === 'favorites';
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
  }

  const SITE_LABEL_AR = { youtube: 'يوتيوب', dailymotion: 'ديليموشن' };
  const TYPE_LABEL_AR = { all: 'الكل', video: 'فيديوهات', channel: 'قنوات', playlist: 'قوائم التشغيل' };

  function setSite(site, run) {
    state.site = ['youtube','dailymotion'].includes(site) ? site : 'dailymotion';
    if (state.site !== 'youtube' && ['channel', 'playlist'].includes(state.searchType)) state.searchType = 'video';
    state.view = 'search';
    state.browse = null;
    store(SITE_KEY, state.site);
    const badge = $('searchSourceBadge');
    if (badge) badge.textContent = SITE_LABEL_AR[state.site];
    renderTabs();
    renderChips();
    updateNote();
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    if (run && state.query) runSearch(state.query);
  }

  function setSearchType(type, run) {
    state.searchType = ['all', 'video', 'channel', 'playlist'].includes(type) ? type : 'all';
    state.view = 'search';
    state.browse = null;
    renderTabs();
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    if (run && state.query.length >= 2) runSearch(state.query);
    else {
      el.results.innerHTML = '';
      el.empty.hidden = false;
      el.emptyText.textContent = 'اكتب عبارة للبحث عن ' + (TYPE_LABEL_AR[state.searchType] || 'محتوى يوتيوب');
      status('');
    }
  }

  async function showFavorites() {
    const token = ++state.token;
    state.view = 'favorites';
    state.browse = null;
    state.loading = true;
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    renderTabs();
    el.empty.hidden = true;
    skeleton(6);
    status('جارٍ تحميل مفضّلتك…');
    try {
      if (!Favorites || typeof Favorites.list !== 'function') throw new Error('خدمة المفضّلة غير متاحة');
      const saved = await Favorites.list({ force: true });
      if (token !== state.token) return;
      state.favoriteKeys = new Set(saved.map(favoriteKey).filter(Boolean));
      state.favoriteError = null;
      state.items = saved.map(item => normalize(item, item.site)).filter(Boolean);
      state.viewItems = state.items;
      if (state.items.length) {
        render(state.items);
        status(state.items.length + ' فيديو في مفضّلتك الشخصية');
      } else {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = false;
        el.emptyText.textContent = 'لم تحفظ فيديوهات بعد — اضغط القلب على فيديو لإضافته إلى مفضّلتك';
        status('');
      }
    } catch (error) {
      if (token !== state.token) return;
      state.items = [];
      state.viewItems = [];
      el.results.innerHTML = '';
      el.results.setAttribute('aria-busy', 'false');
      el.empty.hidden = false;
      el.emptyText.textContent = error && error.message ? error.message : 'تعذّر تحميل المفضّلة';
      status(error && error.message ? error.message : 'تعذّر تحميل المفضّلة', true);
    } finally {
      if (token === state.token) state.loading = false;
    }
  }

  function openBrowse(type, rawUrl, title) {
    type = type === 'playlist' ? 'playlist' : 'channel';
    let url = '';
    if (type === 'channel') url = safeYouTubeProfile(rawUrl);
    else {
      const id = U.parseYouTubePlaylist(rawUrl) || String(rawUrl || '').trim();
      if (/^[A-Za-z0-9_-]{2,64}$/.test(id)) url = 'https://www.youtube.com/playlist?list=' + id;
      else if (U.parseYouTubePlaylist(rawUrl)) url = 'https://www.youtube.com/playlist?list=' + U.parseYouTubePlaylist(rawUrl);
    }
    if (!url) { U.toast('رابط القناة أو القائمة غير صالح', 'error'); return; }
    state.browse = { type, url, title: String(title || (type === 'channel' ? 'قناة يوتيوب' : 'قائمة تشغيل')).trim(), offset: 0, nextOffset: 0, hasMore: true, items: [], loading: false };
    state.viewItems = [];
    el.browseTitle.textContent = state.browse.title;
    el.browseMeta.textContent = type === 'channel' ? 'فيديوهات القناة' : 'فيديوهات قائمة التشغيل';
    el.browseBar.hidden = false;
    el.browseMore.hidden = true;
    loadBrowsePage(false);
  }

  async function loadBrowsePage(append) {
    const browse = state.browse;
    if (!browse || browse.loading || (!browse.hasMore && append)) return;
    const token = ++state.token;
    browse.loading = true;
    const offset = append ? browse.nextOffset : 0;
    if (append) el.browseLoadMore.disabled = true;
    else {
      el.empty.hidden = true;
      skeleton(6);
      status('جارٍ تحميل فيديوهات ' + (browse.type === 'channel' ? 'القناة' : 'القائمة') + '…');
    }
    try {
      const result = await fromServer(browse.title, LIMIT, 'youtube', 'video', { type: browse.type, url: browse.url, offset });
      if (token !== state.token || state.browse !== browse) return;
      if (!result) throw new Error(state.reason || 'التصفّح يحتاج سيرفر Java مع yt-dlp');
      state.server = true;
      const found = result.items.map(item => normalize(item, 'youtube')).filter(item => item && item.type === 'video');
      const combined = append ? browse.items.concat(found) : found;
      const seen = new Set();
      browse.items = combined.filter(item => {
        const key = item.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      browse.nextOffset = Number(result.nextOffset) || offset + found.length;
      browse.hasMore = !!result.hasMore;
      state.viewItems = browse.items;
      render(browse.items);
      el.browseMore.hidden = !browse.hasMore;
      if (!browse.items.length) {
        el.empty.hidden = false;
        el.emptyText.textContent = 'لا توجد فيديوهات متاحة هنا — قد تكون القناة أو القائمة خاصة أو فارغة';
        status('');
      } else {
        status(browse.items.length + ' فيديو — ' + (browse.type === 'channel' ? 'القناة' : 'قائمة التشغيل'));
      }
      loadFavoriteState(false).then(() => {
        if (token === state.token && state.browse === browse) render(browse.items);
      });
    } catch (error) {
      if (token !== state.token || state.browse !== browse) return;
      el.results.innerHTML = '';
      el.results.setAttribute('aria-busy', 'false');
      el.empty.hidden = false;
      el.emptyText.textContent = error && error.message ? error.message : 'تعذّر تصفّح المحتوى';
      status(error && error.message ? error.message : 'تعذّر التصفّح', true);
      el.browseMore.hidden = true;
    } finally {
      if (token === state.token) {
        browse.loading = false;
        if (append) el.browseLoadMore.disabled = false;
      }
    }
  }

  function backFromBrowse() {
    if (!state.browse) return;
    state.browse = null;
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    renderTabs();
    if (state.view === 'favorites') {
      render(state.items);
      status(state.items.length ? state.items.length + ' فيديو في مفضّلتك الشخصية' : '');
      el.empty.hidden = state.items.length > 0;
      if (!state.items.length) el.emptyText.textContent = 'لم تحفظ فيديوهات بعد — اضغط القلب على فيديو لإضافته إلى مفضّلتك';
    } else {
      render(state.items);
      status(state.items.length ? state.items.length + ' نتيجة' : '');
      el.empty.hidden = state.items.length > 0;
    }
  }

  /* ============================== 4) التشغيل ============================== */

  function frame() {
    if (!el.frame) {
      const f = document.createElement('iframe');
      f.className = 'play-frame';
      f.title = 'مشغّل الفيديو';
      f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      f.setAttribute('allowfullscreen', '');
      f.setAttribute('referrerpolicy', 'no-referrer');
      el.stage.appendChild(f);
      el.frame = f;
    }
    return el.frame;
  }

  function openDialog(item) {
    state.current = item;
    el.dTitle.textContent = item.title;
    el.error.hidden = true;
    el.video.hidden = true;
    el.video.removeAttribute('src');
    el.video.poster = item.thumb || '';
    if (el.frame) { el.frame.hidden = true; el.frame.removeAttribute('src'); }
    el.spinner.hidden = false;
    el.spinnerText.textContent = item.site === 'youtube'
      ? 'جارٍ تجهيز المشغّل…'
      : 'جارٍ استخراج رابط التشغيل المباشر…';
    el.room.disabled = true;
    el.queue.disabled = true;
    el.copy.disabled = true;
    el.favorite.disabled = false;
    paintFavoriteButton(el.favorite, isFavorite(item));
    el.channel.hidden = !item.channelUrl;
    el.channel.disabled = !item.channelUrl;
    el.source.href = item.url;
    el.source.hidden = true;
    el.hint.hidden = true;
    if (typeof el.dialog.showModal === 'function') el.dialog.showModal();
    else el.dialog.setAttribute('open', '');
  }

  function showError(message) {
    el.spinner.hidden = true;
    el.video.hidden = true;
    if (el.frame) el.frame.hidden = true;
    el.error.hidden = false;
    el.error.textContent = message;
    el.hint.hidden = false;
    el.hint.textContent = state.server === false
      ? 'شغّل الموقع من سيرفر Java (run.bat) لتفعيل استخراج الروابط عبر yt-dlp.'
      : 'يمكنك فتح الفيديو على موقعه الأصلي من الزر بالأسفل.';
  }

  function ready(url, hint) {
    el.spinner.hidden = true;
    el.error.hidden = true;
    el.room.disabled = false;
    el.queue.disabled = false;
    el.copy.disabled = false;
    el.hint.hidden = false;
    el.hint.textContent = hint;
    if (state.current.site === 'youtube') {
      const f = frame();
      f.src = 'https://www.youtube.com/embed/' + state.current.id + '?rel=0&autoplay=1';
      f.hidden = false;
      el.video.hidden = true;
      el.source.hidden = true;
    } else {
      el.video.hidden = false;
      el.video.src = url;
      if (el.frame) el.frame.hidden = true;
      el.source.hidden = true;
      const played = el.video.play();
      if (played && typeof played.catch === 'function') played.catch(() => { /* يمنع المتصفح التشغيل التلقائي */ });
    }
  }

  async function play(item) {
    if (!item) return;
    if (item.type === 'channel' || item.type === 'playlist') {
      openBrowse(item.type, item.url, item.title);
      return;
    }
    openDialog(item);
    /* يوتيوب لا يحتاج استخراجاً: مشغّله الرسمي يعمل داخل iframe */
    if (item.site === 'youtube') {
      state.direct.set(item.id, item.url);
      ready(item.url, 'يُشغَّل يوتيوب بمشغّله الرسمي — لا حاجة لاستخراج رابط مباشر.');
      return;
    }
    /* تيك توك/كيك/تويتش/ديليموشن: نحاول استخراج رابط التشغيل عبر السيرفر (yt-dlp).
       إن تعذّر الاستعرض (لا سيرفر، أو المنصة غير مدعومة)، نعرض زر «افتح على موقعها الأصلي». */
    const cached = state.direct.get(item.id);
    if (cached) {
      ready(cached, item.site === 'dailymotion'
        ? 'الرابط المباشر مؤقّت (توقيع من ديليموشن) — صالح للتشغيل الآن فقط.'
        : 'الرابط المباشر مؤقّت — صالح للتشغيل الآن فقط.');
      return;
    }
    try {
      if (!window.WTResolve) throw new Error('خدمة الاستخراج غير متاحة في هذه النسخة');
      const media = await window.WTResolve(item.url);
      const src = media && media.parsed && media.parsed.src;
      if (!src) throw new Error('لم يرجع السيرفر رابط تشغيل');
      state.direct.set(item.id, src);
      ready(src, item.site === 'dailymotion'
        ? 'الرابط المباشر مؤقّت (توقيع من ديليموشن) — صالح للتشغيل الآن فقط.'
        : 'الرابط المباشر مؤقّت — صالح للتشغيل الآن فقط.');
    } catch (error) {
      showError(item.site === 'youtube'
        ? 'تعذّر تجهيز مشغّل يوتيوب.'
        : 'تعذّر استخراج رابط التشغيل — يمكنك فتح الفيديو على موقعها الأصلي من الزر بالأسفل.');
      el.source.href = item.url;
      el.source.hidden = false;
      el.source.textContent = 'افتح على ' + {
        dailymotion: 'ديليموشن'
      }[item.site] || 'الموقع الأصلي';
    }
  }

  /* ============================== 5) الغرفة وقائمة الانتظار ============================== */

  function playableUrl() {
    const item = state.current;
    if (!item) return '';
    return state.direct.get(item.id) || (item.site === 'youtube' ? item.url : '');
  }

  async function copyLink() {
    const src = playableUrl();
    if (!src) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(src);
      else throw new Error('no-clipboard');
      U.toast('نُسخ الرابط', 'success', 2000);
    } catch (e) {
      const box = document.createElement('textarea');
      box.value = src;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(box);
      box.select();
      try { document.execCommand('copy'); U.toast('نُسخ الرابط', 'success', 2000); }
      catch (err) { U.toast('تعذّر النسخ — انسخ الرابط يدوياً', 'error', 2400); }
      box.remove();
    }
  }

  function account() {
    const user = Auth && Auth.accountUser ? Auth.accountUser() : null;
    const session = Auth && Auth.getSession ? Auth.getSession() : null;
    if (!user || !session || !session.access_token || user.guest) return null;
    if (session.expires_at && session.expires_at <= Date.now()) return null;
    return user;
  }

  async function createRoom() {
    const src = playableUrl();
    const item = state.current;
    if (!item || !src) return;
    const user = account();
    if (!user) {
      location.replace('auth.html?next=' + encodeURIComponent(location.pathname + location.search || 'search.html'));
      return;
    }
    el.room.disabled = true;
    const label = el.room.innerHTML;
    el.room.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> جارٍ إنشاء الغرفة…';
    try {
      const room = await Rooms.create({ title: item.title.slice(0, 40), videoUrl: src, hostName: user.name || user.email || '' });
      location.href = Rooms.href(room);
    } catch (error) {
      el.room.disabled = false;
      el.room.innerHTML = label;
      U.toast(error && error.message ? error.message : 'تعذّر إنشاء الغرفة', 'error', 2600);
    }
  }

  /** اختيار غرفة لإضافة الفيديو إلى قائمة انتظارها */
  async function openPicker() {
    const src = playableUrl();
    if (!src) return;
    el.pickerList.innerHTML = '<p class="picker-empty">جارٍ تحميل الغرف…</p>';
    el.pickerEmpty.hidden = true;
    if (typeof el.picker.showModal === 'function') el.picker.showModal();
    else el.picker.setAttribute('open', '');
    let rooms = [];
    try {
      const result = Rooms && Rooms.list ? await Rooms.list() : null;
      rooms = (result && Array.isArray(result.rooms) ? result.rooms : []);
    } catch (e) { rooms = []; }
    if (!rooms.length) {
      el.pickerList.innerHTML = '';
      el.pickerEmpty.hidden = false;
      return;
    }
    el.pickerList.innerHTML = rooms.slice(0, 30).map(room => {
      const mode = room.mode === 'local' ? 'محلية' : room.mode === 'java' ? 'سيرفر Java' : 'سحابية';
      const count = Number(room.queueCount) || 0;
      return '<button class="picker-room" type="button" role="listitem" data-room="' + U.esc(room.id) + '">' +
        '<span class="picker-room__body">' +
          '<span class="picker-room__title">' + U.esc(room.title || room.id) + '</span>' +
          '<span class="picker-room__meta">' + U.esc(mode) + ' · ' + count + ' في الانتظار</span>' +
        '</span>' +
        '<span class="picker-room__badge">أضف</span>' +
      '</button>';
    }).join('');
  }

  function addToRoom(roomId) {
    const src = playableUrl();
    const item = state.current;
    if (!item || !src) return;
    try {
      sessionStorage.setItem('wt:' + PENDING + roomId, JSON.stringify([{ url: src, title: item.title }]));
    } catch (e) { /* التخزين محجوب */ }
    const room = { id: roomId, mode: window.WTRooms && window.WTRooms.localMode && window.WTRooms.localMode() ? 'local' : '' };
    location.href = (Rooms && Rooms.href) ? Rooms.href(room) : 'room.html?id=' + encodeURIComponent(roomId);
  }

  /* ============================== 6) الأحداث ============================== */

  el.form.addEventListener('submit', event => { event.preventDefault(); runSearch(el.input.value); });

  el.input.addEventListener('input', () => { el.clear.hidden = !el.input.value; });

  let typeTimer;
  el.input.addEventListener('keydown', () => {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      const value = el.input.value.trim();
      if (value.length >= 3 && value !== state.query) runSearch(value);
    }, 700);
  });

  el.clear.addEventListener('click', () => {
    el.input.value = '';
    el.clear.hidden = true;
    el.input.focus();
  });

  el.sources.addEventListener('click', event => {
    const tab = event.target.closest('[data-site]');
    if (!tab) return;
    const site = tab.getAttribute('data-site');
    if (site === state.site) return;
    setSite(site, state.query.length >= 2);
  });

  el.types.addEventListener('click', event => {
    const favoriteTab = event.target.closest('[data-search-view]');
    if (favoriteTab) { showFavorites(); return; }
    const tab = event.target.closest('[data-search-type]');
    if (!tab) return;
    const type = tab.getAttribute('data-search-type');
    if (type === state.searchType && state.view === 'search') return;
    setSearchType(type, state.query.length >= 2);
  });

  el.browseBack.addEventListener('click', backFromBrowse);
  el.browseLoadMore.addEventListener('click', () => loadBrowsePage(true));

  el.chips.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const term = remove.getAttribute('data-remove');
      store(RECENT_KEY, recent().filter(v => v !== term));
      renderChips();
      return;
    }
    const chip = event.target.closest('[data-term]');
    if (!chip) return;
    el.input.value = chip.getAttribute('data-term');
    el.clear.hidden = false;
    runSearch(el.input.value);
  });

  el.results.addEventListener('click', event => {
    const favorite = event.target.closest('[data-favorite-index]');
    if (favorite) {
      event.preventDefault();
      event.stopPropagation();
      const item = state.viewItems[Number(favorite.getAttribute('data-favorite-index'))];
      if (!item || favorite.disabled) return;
      favorite.disabled = true;
      toggleFavorite(item).catch(error => U.toast(error && error.message ? error.message : 'تعذّر حفظ المفضّلة', 'error', 3000))
        .finally(() => { favorite.disabled = false; });
      return;
    }
    const channel = event.target.closest('[data-channel-index]');
    if (channel) {
      event.preventDefault();
      event.stopPropagation();
      const item = state.viewItems[Number(channel.getAttribute('data-channel-index'))];
      if (item && item.channelUrl) openBrowse('channel', item.channelUrl, item.author || 'قناة يوتيوب');
      return;
    }
    const card = event.target.closest('[data-index]');
    if (!card) return;
    const item = state.viewItems[Number(card.getAttribute('data-index'))];
    if (!item || state.busyId) return;
    const busyKey = item.type + ':' + item.site + ':' + item.id;
    state.busyId = busyKey;
    card.classList.add('is-busy');
    play(item).finally(() => {
      state.busyId = null;
      card.classList.remove('is-busy');
    });
  });

  el.dClose.addEventListener('click', () => {
    try { el.video.pause(); } catch (e) { /* لا مشغل */ }
    if (typeof el.dialog.close === 'function') el.dialog.close();
    else el.dialog.removeAttribute('open');
  });

  el.dialog.addEventListener('close', () => {
    try { el.video.pause(); } catch (e) { /* لا مشغل */ }
    if (el.frame) { el.frame.hidden = true; el.frame.removeAttribute('src'); }
  });

  el.video.addEventListener('error', () => {
    if (!el.video.hidden && el.video.src) {
      showError('تعذّر تشغيل الرابط المباشر في هذا المتصفح — قد يكون منتهي الصلاحية أو محجوباً');
    }
  });

  el.copy.addEventListener('click', copyLink);
  el.room.addEventListener('click', createRoom);
  el.queue.addEventListener('click', openPicker);
  el.favorite.addEventListener('click', async () => {
    if (!state.current || el.favorite.disabled) return;
    el.favorite.disabled = true;
    try { await toggleFavorite(state.current); }
    catch (error) { U.toast(error && error.message ? error.message : 'تعذّر حفظ المفضّلة', 'error', 3000); }
    finally {
      el.favorite.disabled = false;
      paintFavoriteButton(el.favorite, state.current && isFavorite(state.current));
    }
  });
  el.channel.addEventListener('click', () => {
    const item = state.current;
    if (!item || !item.channelUrl) return;
    try { el.video.pause(); } catch (_) { }
    if (typeof el.dialog.close === 'function') el.dialog.close();
    else el.dialog.removeAttribute('open');
    openBrowse('channel', item.channelUrl, item.author || 'قناة يوتيوب');
  });

  el.pickerClose.addEventListener('click', () => {
    if (typeof el.picker.close === 'function') el.picker.close();
    else el.picker.removeAttribute('open');
  });

  el.pickerList.addEventListener('click', event => {
    const button = event.target.closest('[data-room]');
    if (!button) return;
    addToRoom(button.getAttribute('data-room'));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el.picker && el.picker.open) {
      event.preventDefault();
      el.pickerClose.click();
    }
  });

  /* ============================== 7) البداية ============================== */

  const savedSite = store(SITE_KEY);
  if (['youtube','dailymotion'].includes(savedSite)) state.site = savedSite;
  const badge = $('searchSourceBadge');
  if (badge) badge.textContent = SITE_LABEL_AR[state.site];
  renderTabs();
  renderChips();

  const params = new URLSearchParams(location.search);
  if (params.get('site')) { const s = params.get('site'); if (['youtube','dailymotion'].includes(s)) state.site = s; }
  if (['all', 'video', 'channel', 'playlist'].includes(params.get('type'))) state.searchType = params.get('type');
  if (state.site !== 'youtube' && ['channel', 'playlist'].includes(state.searchType)) state.searchType = 'video';
  if (badge) badge.textContent = SITE_LABEL_AR[state.site];
  renderTabs();
  const initial = params.get('q');
  if (initial) {
    el.input.value = initial;
    el.clear.hidden = false;
    runSearch(initial);
  }
})();

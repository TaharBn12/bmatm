/* =========================================================
   WatchTogether — صفحة البحث (search.js)
   ---------------------------------------------------------
   • المصادر: ديليموشن ويوتيوب وPornFlip وePorner (18+)، من سيرفر Java.
   • مصادر البالغين تتطلب إقراراً صريحاً بالعمر في كل جلسة قبل أي طلب؛ لا يُخزّن البحث في السجل.
   • ديليموشن: يستخرج السيرفر رابط التشغيل عبر yt-dlp؛ PornFlip وePorner يستخدمان المشغّل المضمّن.
   • يوتيوب: يُشغّل بمشغّله الرسمي داخل iframe (بلا مفتاح API).
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
    pickerClose: $('pickerClose'), adultGate: $('adultGate'),
    adultGateAccept: $('adultGateAccept'), adultGateCancel: $('adultGateCancel'),
    epornerHero: $('epornerHero'), searchGenericHero: $('searchGenericHero'),
    epornerConsent: $('epornerConsent'), epornerConsentOpen: $('epornerConsentOpen'),
    epornerFilters: $('epornerSearchFilters'), epornerDiscovery: $('epornerDiscovery'),
    epornerOrder: $('epornerOrder'), epornerPerPage: $('epornerPerPage'), epornerPage: $('epornerPage'),
    epornerGay: $('epornerGay'), epornerLq: $('epornerLq'), epornerMinDuration: $('epornerMinDuration'),
    epornerMaxDuration: $('epornerMaxDuration'), epornerAddedAfter: $('epornerAddedAfter'),
    epornerAddedBefore: $('epornerAddedBefore'), epornerThumbsize: $('epornerThumbsize'),
    epornerThumbs: $('epornerThumbs'), epornerLang: $('epornerLang'), epornerFormat: $('epornerFormat'),
    epornerFieldCategories: $('epornerFieldCategories'), epornerFieldPornstars: $('epornerFieldPornstars'),
    epornerFieldQuality: $('epornerFieldQuality'), epornerCategoryFilter: $('epornerCategoryFilter'),
    epornerCategoryList: $('epornerCategoryList'), epornerCategoriesMeta: $('epornerCategoriesMeta'),
    epornerCategoriesReload: $('epornerCategoriesReload'), epornerPornstarList: $('epornerPornstarList'),
    epornerPornstarsMeta: $('epornerPornstarsMeta'), epornerPornstarsReload: $('epornerPornstarsReload'),
    epornerPornstarsPerPage: $('epornerPornstarsPerPage'), epornerPornstarsPrev: $('epornerPornstarsPrev'),
    epornerPornstarsNext: $('epornerPornstarsNext'), epornerPornstarsPageLabel: $('epornerPornstarsPageLabel'),
    epornerTools: $('epornerTools'), epornerOperation: $('epornerOperation'),
    epornerOperationPath: $('epornerOperationPath'), epornerOperationHelp: $('epornerOperationHelp'),
    epornerOperationForm: $('epornerOperationForm'), epornerOperationFields: $('epornerOperationFields'),
    epornerRun: $('epornerRunOperation'), epornerOutputWrap: $('epornerOutputWrap'),
    epornerOutputTitle: $('epornerOutputTitle'), epornerOutputMeta: $('epornerOutputMeta'), epornerOutput: $('epornerOutput')
  };

  const QUICK_DM = ['وثائقيات', 'موسيقى', 'طبخ', 'رياضة', 'تقنية', 'أفلام قصيرة'];
  const QUICK_YT = ['محاضرات', 'قرآن', 'أغاني', 'برمجة', 'طبخ', 'رياضة'];
  const RECENT_KEY = 'search:recent';
  const ADULT_ACK_KEY = 'wt:search:adult-confirmed';
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
    query: '', site: 'eporner', searchType: 'video', items: [], viewItems: [], view: 'search', loading: false,
    browse: null, favoriteKeys: new Set(), favoriteError: null,
    adultConfirmed: false,    /* إقرار 18+ مؤقت للجلسة فقط */
    previousSite: 'dailymotion', pendingAdultAction: '', pendingAdultQuery: '',
    server: null,            /* null = لم يُختبر · true = سيرفر Java · false = استضافة ثابتة */
    reason: '',              /* سبب تعذّر الوصول إلى /api/search (نص تشخيصي) */
    epornerNextPage: 1, epornerHasMore: false, epornerToolBusy: false,
    epornerCategories: [], epornerCategoriesLoaded: false, epornerCategoriesLoading: false,
    epornerPornstarsPage: 1, epornerPornstarsTotalPages: 1,
    epornerPornstarsLoaded: false, epornerPornstarsLoading: false,
    epornerOperationBusy: false,
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

  function safePornFlipUrl(raw) {
    const safe = safeWebUrl(raw, true);
    if (!safe) return '';
    try {
      const host = new URL(safe).hostname.toLowerCase().replace(/^www\./, '');
      return host === 'pornflip.com' || host.endsWith('.pornflip.com') ? safe : '';
    } catch (_) { return ''; }
  }

  function pornFlipVideoId(raw) {
    const safe = safePornFlipUrl(raw);
    if (!safe) return '';
    try {
      const path = new URL(safe).pathname.split('/').filter(Boolean);
      const id = /^(?:v|video|videos|sv|embed)$/i.test(path[0] || '') ? path[1] : path[0];
      return /^[A-Za-z0-9_-]{8,32}$/.test(id || '') ? id : '';
    } catch (_) { return ''; }
  }

  function pornFlipEmbedUrl(item) {
    if (!item) return '';
    const url = safePornFlipUrl(item.url);
    const id = String(item.id || '').trim();
    if (!url || !/^[A-Za-z0-9_-]{8,32}$/.test(id) || pornFlipVideoId(url) !== id) return '';
    return 'https://www.pornflip.com/embed/' + encodeURIComponent(id);
  }

  function isPornFlipEmbedUrl(raw) {
    const safe = safePornFlipUrl(raw);
    if (!safe) return false;
    try {
      const url = new URL(safe);
      return url.origin === 'https://www.pornflip.com' &&
        /^\/embed\/[A-Za-z0-9_-]{8,32}\/?$/i.test(url.pathname) && !url.search && !url.hash;
    } catch (_) { return false; }
  }

  function isAdultSource(site) { return site === 'pornflip' || site === 'eporner'; }

  function safeEpornerUrl(raw) {
    const safe = safeWebUrl(raw, true);
    if (!safe) return '';
    try {
      const url = new URL(safe);
      if (url.port) return '';
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      return host === 'eporner.com' || host.endsWith('.eporner.com') ? safe : '';
    } catch (_) { return ''; }
  }

  function epornerVideoId(raw) {
    const safe = safeEpornerUrl(raw);
    if (!safe) return '';
    try {
      const path = new URL(safe).pathname;
      const match = path.match(/^\/(?:video-([A-Za-z0-9]{11})|embed\/([A-Za-z0-9]{11}))(?:\/|$)/i);
      return match ? (match[1] || match[2]) : '';
    } catch (_) { return ''; }
  }

  function safeEpornerEmbed(raw, id) {
    const safe = safeEpornerUrl(raw);
    if (!safe || !/^[A-Za-z0-9]{11}$/.test(String(id || ''))) return '';
    try {
      const url = new URL(safe);
      const match = url.pathname.match(/^\/embed\/([A-Za-z0-9]{11})\/?$/i);
      if (!match || match[1] !== id || url.search || url.hash) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function isAdultItem(item) {
    if (!item) return false;
    if (isAdultSource(String(item.site || '').toLowerCase())) return true;
    try {
      const host = new URL(String(item.url || '')).hostname.toLowerCase().replace(/^www\./, '');
      return host === 'pornflip.com' || host.endsWith('.pornflip.com') ||
        host === 'eporner.com' || host.endsWith('.eporner.com');
    } catch (_) { return false; }
  }

  function normalize(raw, site) {
    if (!raw || typeof raw !== 'object') return null;
    const source = String(raw.site || site || '').toLowerCase();
    const isYT = source === 'youtube' || source === 'yt';
    const isDM = source === 'dailymotion' || source === 'dm';
    const isPF = source === 'pornflip';
    const isEP = source === 'eporner';
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
      } else if (isPF) {
        url = safePornFlipUrl(url);
        if (!url) return null;
        id = id || url;
      } else if (isEP) {
        url = safeEpornerUrl(url);
        if (!url) return null;
        const pathId = epornerVideoId(url);
        if (!/^[A-Za-z0-9]{11}$/.test(id)) id = pathId;
        if (!/^[A-Za-z0-9]{11}$/.test(id) || (pathId && pathId !== id)) return null;
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
    url = isPF ? safePornFlipUrl(url) : isEP ? safeEpornerUrl(url) : safeWebUrl(url, false);
    if (!url) return null;
    let thumb = isPF ? safePornFlipUrl(raw.thumb || raw.thumbnail || '')
      : isEP ? safeEpornerUrl(raw.thumb || raw.thumbnail || raw.default_thumb && raw.default_thumb.src || '')
      : safeWebUrl(raw.thumb || raw.thumbnail || '', true);
    if (!thumb && isYT && type === 'video') thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    if (!thumb && isDM) thumb = 'https://www.dailymotion.com/thumbnail/video/' + id;
    const performers = isEP && Array.isArray(raw.pornstars)
      ? raw.pornstars.map(person => String(person && person.name || '').trim()).filter(Boolean).slice(0, 3).join(', ') : '';
    const categories = isEP && Array.isArray(raw.categories)
      ? raw.categories.map(category => String(typeof category === 'string' ? category : category && category.name || '').trim()).filter(Boolean).slice(0, 3) : [];
    const quality = isEP && raw.quality && typeof raw.quality === 'object'
      ? { max: String(raw.quality.max || '').trim(), hd: raw.quality.hd === true, vr: raw.quality.vr === true,
        fps: Number(raw.quality.fps) || 0, available: Array.isArray(raw.quality.available)
          ? raw.quality.available.map(value => String(value || '').trim()).filter(Boolean).slice(0, 7) : [] } : null;
    const translation = isEP && raw.translation && typeof raw.translation === 'object'
      ? { lang: String(raw.translation.lang || '').trim(), title: String(raw.translation.title || '').trim() } : null;
    const author = String(raw.author || raw.owner || raw.channel || performers).replace(/\s+/g, ' ').trim().slice(0, 140);
    const channelId = String(raw.channelId || raw.channel_id || '').trim().slice(0, 120);
    const channelUrl = isYT ? safeYouTubeProfile(raw.channelUrl || raw.channel_url ||
      (channelId.match(/^UC[A-Za-z0-9_-]{20,30}$/) ? 'https://www.youtube.com/channel/' + channelId : '')) : '';
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 240) || 'بدون عنوان';
    return {
      id, type, site: isYT ? 'youtube' : isDM ? 'dailymotion' : isPF ? 'pornflip' : isEP ? 'eporner' : (source || 'external'),
      title, url, thumb, duration: Number(raw.duration || raw.length_sec) || 0, author,
      embedUrl: isEP ? safeEpornerEmbed(raw.embed || raw.embedUrl, id) : '',
      categories, quality, translation, channelId, channelUrl,
      count: Number(raw.count || raw.channel_follower_count || raw.views || 0) || 0
    };
  }

  function epornerInteger(raw, key, minimum, maximum) {
    const value = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(value)) throw new Error(key + ' يجب أن يكون عددًا صحيحًا');
    const parsed = BigInt(value);
    if (parsed < BigInt(minimum) || (maximum != null && parsed > BigInt(maximum)))
      throw new Error(key + ' يجب أن يكون بين ' + minimum + (maximum == null ? ' فأكثر' : ' و' + maximum));
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
  }

  function incrementEpornerPage(value) {
    const raw = String(value == null || value === '' ? '1' : value).trim();
    return /^\d+$/.test(raw) ? (BigInt(raw) + 1n).toString() : '2';
  }

  function decrementEpornerPage(value) {
    const raw = String(value == null || value === '' ? '1' : value).trim();
    if (!/^\d+$/.test(raw)) return '1';
    const parsed = BigInt(raw);
    return parsed > 1n ? (parsed - 1n).toString() : '1';
  }

  function epornerSearchParams(term, pageOverride) {
    const readInteger = (control, key, fallback, minimum, maximum) => {
      const raw = String(control && control.value || '').trim();
      return epornerInteger(raw || fallback, key, minimum, maximum);
    };
    const fields = [
      [el.epornerFieldCategories, 'categories'],
      [el.epornerFieldPornstars, 'pornstars'],
      [el.epornerFieldQuality, 'quality']
    ].filter(([control]) => control && (control.checked === true || typeof control.checked === 'undefined'))
      .map(([, value]) => value);
    const params = {
      query: String(term || '').trim() || 'all',
      per_page: readInteger(el.epornerPerPage, 'per_page', 30, 1, 1000),
      page: pageOverride == null
        ? readInteger(el.epornerPage, 'page', 1, 1, null)
        : readInteger({ value: pageOverride }, 'page', 1, 1, null),
      order: String(el.epornerOrder && el.epornerOrder.value || 'latest'),
      gay: readInteger(el.epornerGay, 'gay', 0, 0, 2),
      lq: readInteger(el.epornerLq, 'lq', 1, 0, 2),
      thumbsize: String(el.epornerThumbsize && el.epornerThumbsize.value || 'medium'),
      thumbs: String(el.epornerThumbs && el.epornerThumbs.value || 'all'),
      format: String(el.epornerFormat && el.epornerFormat.value || 'json')
    };
    const minDuration = String(el.epornerMinDuration && el.epornerMinDuration.value || '').trim();
    const maxDuration = String(el.epornerMaxDuration && el.epornerMaxDuration.value || '').trim();
    const addedAfter = String(el.epornerAddedAfter && el.epornerAddedAfter.value || '').trim();
    const addedBefore = String(el.epornerAddedBefore && el.epornerAddedBefore.value || '').trim();
    const lang = String(el.epornerLang && el.epornerLang.value || '').trim();
    if (minDuration) params.min_duration = readInteger({ value: minDuration }, 'min_duration', 0, 0, 86400);
    if (maxDuration) params.max_duration = readInteger({ value: maxDuration }, 'max_duration', 0, 0, 86400);
    if (addedAfter) params.added_after = addedAfter;
    if (addedBefore) params.added_before = addedBefore;
    if (fields.length) params.fields = fields.join(',');
    if (lang) {
      if (!/^[a-z]{2}$/.test(lang)) throw new Error('lang يجب أن يكون حرفين صغيرين مثل pl أو fr أو es');
      params.lang = lang;
    }
    if (!['latest', 'longest', 'shortest', 'top-rated', 'most-popular', 'top-weekly', 'top-monthly'].includes(params.order))
      throw new Error('قيمة order غير مدعومة في OpenAPI');
    if (![0, 1, 2].includes(params.gay) || ![0, 1, 2].includes(params.lq))
      throw new Error('قيم gay وlq الموثّقة هي 0 أو 1 أو 2');
    if (!['small', 'medium', 'big'].includes(params.thumbsize) || !['all', 'default', 'none'].includes(params.thumbs))
      throw new Error('قيمة حجم/عدد الصور غير مدعومة في OpenAPI');
    if (!['json', 'xml'].includes(params.format)) throw new Error('صيغة البحث يجب أن تكون json أو xml');
    return params;
  }

  /**
   * المحاولة الأولى: سيرفر Java (yt-dlp لكل المصادر، مع واجهة ديليموشن كخيار احتياطي).
   * نفرّق بدقّة بين ثلاث حالات كانت تُظهر كلها رسالة واحدة مبهمة:
   *   1) لا سيرفر أصلاً (ملف file://، منفذ خاطئ، سيرفر قديم) → null
   *   2) السيرفر موجود لكن خدمة البحث معطّلة (5xx) → خطأ serverDown
   *   3) خطأ من عندنا (4xx) → خطأ عادي
   */
  async function fromServer(term, limit, site, type, browse) {
    if (site === 'eporner') {
      if (!state.adultConfirmed) throw new Error('تأكيد 18+ مطلوب قبل البحث في ePorner');
      if (!window.WTEpornerApi) throw new Error('عميل ePorner API غير متاح في هذه النسخة');
      const params = epornerSearchParams(term, browse && browse.page != null ? browse.page : null);
      const page = String(params.page || '1');
      let data;
      try {
        data = await window.WTEpornerApi.search(params);
      } catch (error) {
        if (error && error.status) { state.server = true; throw error; }
        state.reason = location.protocol === 'file:'
          ? 'الصفحة مفتوحة كملف (file://) لا عبر سيرفر Java'
          : 'تعذّر الاتصال بخادم ePorner على ' + (apiBaseUrl() || location.host || 'العنوان الحالي');
        return null;
      }
      state.reason = '';
      if (typeof data === 'string') return {
        items: [], raw: data, source: 'eporner-api-xml', hasMore: false, nextOffset: incrementEpornerPage(page),
        totalCount: 0, totalPages: page, format: params.format
      };
      if (!data || !Array.isArray(data.videos)) throw new Error('استجابة بحث ePorner غير مفهومة');
      const totalPagesValue = data.total_pages == null ? page : String(data.total_pages);
      let hasMore = false;
      try { hasMore = BigInt(page) < BigInt(totalPagesValue); } catch (_) { hasMore = false; }
      return {
        items: data.videos.map(item => normalize({ ...item, type: 'video', site: 'eporner' }, 'eporner')).filter(Boolean),
        source: 'eporner-api', hasMore, nextOffset: incrementEpornerPage(page),
        totalCount: Number(data.total_count) || 0, totalPages: Number(data.total_pages) || Number(page) || 1,
        format: params.format
      };
    }
    const api = (window.WTServer && window.WTServer.api) ? window.WTServer.api('api/search') : 'api/search';
    const params = new URLSearchParams({ q: term || '', limit: String(limit), site: String(site || '') });
    if (site === 'pornflip') {
      if (!state.adultConfirmed) throw new Error('تأكيد 18+ مطلوب قبل البحث في PornFlip');
      params.set('adult_confirmed', '1');
    }
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
    const enteredQuery = String(term || '').trim();
    if (isAdultSource(state.site) && !state.adultConfirmed) {
      requestAdultConfirmation('search', enteredQuery);
      return;
    }
    if (state.site !== 'eporner' && enteredQuery.length < 2) {
      status('اكتب كلمتين على الأقل للبحث', true);
      el.input.focus();
      return;
    }
    const query = state.site === 'eporner' && !enteredQuery ? 'all' : enteredQuery;
    const token = ++state.token;
    state.view = 'search';
    state.browse = null;
    state.loading = true;
    state.query = query;
    state.epornerNextPage = state.site === 'eporner'
      ? incrementEpornerPage(el.epornerPage && el.epornerPage.value) : 1;
    state.epornerHasMore = false;
    if (state.site === 'eporner') clearEpornerToolOutput();
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
        result = ['youtube', 'pornflip', 'eporner'].includes(state.site)
          ? { items: [], source: 'none' }
          : await fromDailymotion(query, LIMIT);
        if (token !== state.token) return;
      }
      state.items = result.items.map(item => normalize(item, state.site)).filter(item =>
        item && (!isAdultItem(item) || (isAdultSource(state.site) && state.adultConfirmed)));
      state.viewItems = state.items;
      state.epornerHasMore = state.site === 'eporner' && !!result.hasMore;
      state.epornerNextPage = state.site === 'eporner'
        ? String(result.nextOffset || incrementEpornerPage(el.epornerPage && el.epornerPage.value)) : 1;
      if (state.site === 'eporner' && el.epornerPage) el.epornerPage.value = decrementEpornerPage(state.epornerNextPage);
      el.browseMore.hidden = !state.epornerHasMore;
      updateNote();
      if (state.site === 'eporner' && typeof result.raw === 'string') {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = true;
        state.epornerHasMore = false;
        el.browseMore.hidden = true;
        showEpornerToolOutput(result.raw, 'رد XML خام من /video/search/', 'text/xml');
        status('أعاد ePorner XML. افتح مختبر API لقراءة الرد الخام؛ لم يُحوّل إلى بطاقات.');
        renderChips();
        return;
      }
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
        } else if (state.site === 'pornflip') {
          el.emptyText.textContent = state.server === false
            ? 'بحث PornFlip يحتاج خادم Java.' + (state.reason ? ' — ' + state.reason : ' شغّل الخادم أو اضبط javaServer.apiBase ثم أعد المحاولة.')
            : 'لم يُرجع PornFlip نتائج عن «' + query + '» — جرّب عبارة أخرى.';
        } else if (state.site === 'eporner') {
          el.emptyText.textContent = state.server === false
            ? 'عمليات ePorner تحتاج خادم Java.' + (state.reason ? ' — ' + state.reason : ' شغّل الخادم أو اضبط javaServer.apiBase ثم أعد المحاولة.')
            : 'لم يُرجع ePorner نتائج عن «' + query + '» — جرّب عبارة أخرى.';
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
        if (!isAdultSource(state.site)) pushRecent(query);
        status(state.items.length + ' نتيجة — المصدر: ' + (
          result.source === 'pornflip-html' ? 'PornFlip (صفحة النتائج)' :
          result.source === 'eporner-api' ? 'ePorner API v2' :
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
        ? state.site === 'pornflip'
          ? 'تعذّر جلب نتائج PornFlip من الخادم (' + (error.status || '5xx') + '): ' + (error.message || '')
          : state.site === 'eporner'
            ? 'تعذّر الاتصال بواجهة ePorner API (' + (error.status || '5xx') + '): ' + (error.message || '') +
              (error.retryAfter ? ' — أعد المحاولة بعد ' + error.retryAfter + ' ثانية' : '')
            : 'خدمة البحث على السيرفر معطّلة (' + (error.status || '5xx') + '): ' + (error.message || '') +
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

  async function loadMoreEporner() {
    if (state.site !== 'eporner' || state.view !== 'search' || state.loading || !state.epornerHasMore) return;
    const token = ++state.token;
    const page = state.epornerNextPage;
    state.loading = true;
    el.browseLoadMore.disabled = true;
    status('جارٍ تحميل الصفحة ' + page + ' من ePorner…');
    try {
      const result = await fromServer(state.query, LIMIT, 'eporner', 'video', { page });
      if (token !== state.token || state.site !== 'eporner') return;
      const seen = new Set(state.items.map(item => item.id));
      const found = result.items.filter(item => !seen.has(item.id));
      state.items = state.items.concat(found);
      state.viewItems = state.items;
      state.epornerNextPage = String(result.nextOffset || incrementEpornerPage(page));
      if (el.epornerPage) el.epornerPage.value = String(page);
      state.epornerHasMore = !!result.hasMore;
      render(state.items);
      el.browseMore.hidden = !state.epornerHasMore;
      status(state.items.length + ' نتيجة — ePorner API v2');
      loadFavoriteState(false).then(() => {
        if (token === state.token && state.site === 'eporner' && state.view === 'search') render(state.items);
      });
    } catch (error) {
      if (token !== state.token) return;
      status(error && error.message ? error.message : 'تعذّر تحميل نتائج ePorner الإضافية', true);
    } finally {
      if (token === state.token) {
        state.loading = false;
        el.browseLoadMore.disabled = false;
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
      : state.site === 'pornflip'
        ? 'بحث PornFlip يحتاج سيرفر Java، ويُشغّل عبر مشغّله المضمّن. '
        : state.site === 'eporner'
          ? 'بحث وعمليات ePorner API v2 تحتاج سيرفر Java. '
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
    if (isAdultItem(item)) throw new Error('حفظ نتائج مصادر البالغين في المفضّلة غير متاح');
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
      const displayTitle = item.translation && item.translation.title ? item.translation.title : item.title;
      const originalTitle = displayTitle !== item.title
        ? '<span class="result-card__translation">العنوان الأصلي · ' + U.esc(item.title) + '</span>' : '';
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
      const heart = isVideo && !isAdultItem(item)
        ? '<button class="result-card__favorite' + (isFavorite(item) ? ' is-on' : '') + '" type="button" data-favorite-index="' + index + '" aria-pressed="' + String(isFavorite(item)) + '" aria-label="' + (isFavorite(item) ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة') + '" title="' + (isFavorite(item) ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة') + '">' + IC.html('heart', 18) + '</button>'
        : '';
      const epornerTags = [];
      if (item.site === 'eporner') {
        (item.categories || []).slice(0, 2).forEach(name => epornerTags.push('الفئة · ' + name));
        if (item.quality && item.quality.max) epornerTags.push(item.quality.max);
        else if (item.quality && item.quality.hd) epornerTags.push('HD');
        if (item.quality && item.quality.available && item.quality.available.length)
          epornerTags.push('الجودات · ' + item.quality.available.join(' / '));
        if (item.quality && item.quality.vr) epornerTags.push('VR');
        if (item.quality && item.quality.fps > 0) epornerTags.push(item.quality.fps + ' fps');
      }
      const extra = epornerTags.length ? '<span class="result-card__api-tags">' + epornerTags.map(tag =>
        '<span>' + U.esc(tag) + '</span>').join('') + '</span>' : '';
      const action = isVideo ? 'تشغيل' : 'تصفّح';
      return '<article class="result-card result-card--' + U.esc(type) + '">' +
        '<button class="result-card__main" type="button" data-index="' + index + '" aria-label="' + action + ': ' + U.esc(displayTitle) + '">' +
          '<span class="result-card__thumb">' + thumb +
            (badge ? '<span class="result-card__badge">' + badge + '</span>' : '') +
            (tag ? '<span class="result-card__type">' + tag + '</span>' : '') +
            (isVideo ? '<span class="result-card__play"><span>' + IC.html('play', 22) + '</span></span>' : '') +
          '</span>' +
          '<span class="result-card__body">' +
            '<span class="result-card__title">' + U.esc(displayTitle) + '</span>' +
            originalTitle + extra +
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
    const list = isAdultSource(state.site) ? [] : recent();
    const quick = state.site === 'youtube' ? QUICK_YT
      : isAdultSource(state.site) ? [] : QUICK_DM;
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
    if (el.types) {
      el.types.hidden = state.site === 'eporner';
      el.types.querySelectorAll('[data-search-type]').forEach(tab => {
        const on = state.view === 'search' && tab.getAttribute('data-search-type') === state.searchType;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
        if (['channel', 'playlist'].includes(tab.getAttribute('data-search-type')))
          tab.hidden = state.site !== 'youtube';
      });
      el.types.querySelectorAll('[data-search-view]').forEach(tab => {
        const on = state.view === 'favorites';
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
      });
    }
  }

  const SITE_LABEL_AR = { youtube: 'يوتيوب', dailymotion: 'ديليموشن', pornflip: 'PornFlip · 18+', eporner: 'ePorner · 18+' };
  const TYPE_LABEL_AR = { all: 'الكل', video: 'فيديوهات', channel: 'قنوات', playlist: 'قوائم التشغيل' };
  const EPORNER_OPERATIONS = {
    search: {
      path: '/video/search/',
      help: 'query اختياري (الافتراضي all؛ كل كلمة يجب أن تطابق). per_page من 1 إلى 1000، وpage من 1 فأكثر. الترتيب والقيم والحقول واللغة والصيغة محصورة في القوائم الموثّقة.',
      fields: [
        { name: 'query', label: 'عبارة البحث · query', type: 'text', placeholder: 'all لعرض كل الفيديوهات', default: 'all' },
        { name: 'per_page', label: 'عدد الفيديوهات · per_page', type: 'number', min: 1, max: 1000, default: '30' },
        { name: 'page', label: 'رقم الصفحة · page', type: 'number', min: 1, default: '1' },
        { name: 'order', label: 'الترتيب · order', type: 'select', default: 'latest', options: [
          ['latest', 'الأحدث'], ['longest', 'الأطول'], ['shortest', 'الأقصر'], ['top-rated', 'الأعلى تقييمًا'],
          ['most-popular', 'الأكثر مشاهدة'], ['top-weekly', 'الأكثر مشاهدة أسبوعيًا'], ['top-monthly', 'الأكثر مشاهدة شهريًا']
        ] },
        { name: 'gay', label: 'المحتوى المثلي · gay', type: 'select', default: '0', options: [['0', 'استبعاد · 0'], ['1', 'تضمين · 1'], ['2', 'هذا النوع فقط · 2']] },
        { name: 'lq', label: 'الجودة المنخفضة · lq', type: 'select', default: '1', options: [['0', 'استبعاد · 0'], ['1', 'تضمين · 1'], ['2', 'هذا النوع فقط · 2']] },
        { name: 'min_duration', label: 'أقصر مدة · min_duration (ثانية)', type: 'number', min: 0, max: 86400, placeholder: 'اختياري' },
        { name: 'max_duration', label: 'أطول مدة · max_duration (ثانية)', type: 'number', min: 0, max: 86400, placeholder: 'اختياري' },
        { name: 'added_after', label: 'أُضيف بعد · added_after', type: 'text', placeholder: 'YYYY-MM-DD أو RFC 3339 أو Unix' },
        { name: 'added_before', label: 'أُضيف قبل · added_before', type: 'text', placeholder: 'YYYY-MM-DD أو RFC 3339 أو Unix' },
        { name: 'thumbsize', label: 'حجم الصورة · thumbsize', type: 'select', default: 'medium', options: [['small', 'صغير · 190×152'], ['medium', 'متوسط · 427×240'], ['big', 'كبير · 640×360']] },
        { name: 'thumbs', label: 'الصور · thumbs', type: 'select', default: 'all', options: [['all', 'كل الصور (الافتراضي)'], ['default', 'الصورة الافتراضية فقط'], ['none', 'من دون صور']] },
        { name: 'fields', label: 'الحقول الإضافية · fields', type: 'checkboxes', default: ['categories', 'pornstars', 'quality'], options: [['categories', 'الفئات'], ['pornstars', 'المؤدّون'], ['quality', 'الجودة وVR']] },
        { name: 'lang', label: 'لغة العنوان المترجم · lang', type: 'text', maxLength: 2, pattern: '[a-z]{2}', placeholder: 'pl / fr / es' },
        { name: 'format', label: 'صيغة الرد · format', type: 'select', default: 'json', options: [['json', 'JSON'], ['xml', 'XML (رد خام)']] }
      ]
    },
    video: {
      path: '/video/id/',
      help: 'أدخل معرّف فيديو من 11 حرفًا أو رقمًا (حساس لحالة الأحرف). الفيديو المحذوف أو غير المتاح يعيد []، ولا يعني ذلك خطأ في الخدمة.',
      fields: [
        { name: 'id', label: 'معرّف الفيديو · id (مطلوب)', type: 'text', required: true, pattern: '[A-Za-z0-9]{11}', placeholder: '11 حرفًا أو رقمًا' },
        { name: 'thumbsize', label: 'حجم الصورة · thumbsize', type: 'select', default: 'medium', options: [['small', 'صغير · 190×152'], ['medium', 'متوسط · 427×240'], ['big', 'كبير · 640×360']] },
        { name: 'thumbs', label: 'الصور · thumbs', type: 'select', default: 'all', options: [['all', 'كل الصور (الافتراضي)'], ['default', 'الصورة الافتراضية فقط'], ['none', 'من دون صور']] },
        { name: 'fields', label: 'الحقول الإضافية · fields', type: 'checkboxes', default: ['categories', 'pornstars', 'quality'], options: [['categories', 'الفئات'], ['pornstars', 'المؤدّون'], ['quality', 'الجودة وVR']] },
        { name: 'lang', label: 'لغة العنوان المترجم · lang', type: 'text', maxLength: 2, pattern: '[a-z]{2}', placeholder: 'pl / fr / es' },
        { name: 'format', label: 'صيغة الرد · format', type: 'select', default: 'json', options: [['json', 'JSON'], ['xml', 'XML (رد خام)']] }
      ]
    },
    removed: {
      path: '/video/removed/',
      help: 'since يقبل تاريخًا أو وقت RFC 3339 أو طابع Unix. بعد كل رد مرّر قيمة next في after لمتابعة القائمة؛ اتركهما فارغين لطلب ملف المعرّفات الكامل. per_page من 1 إلى 1000.',
      fields: [
        { name: 'since', label: 'من وقت · since', type: 'text', placeholder: 'YYYY-MM-DD أو RFC 3339 أو Unix' },
        { name: 'after', label: 'رمز المتابعة · after', type: 'text', placeholder: 'قيمة next من الرد السابق' },
        { name: 'per_page', label: 'عدد العناصر · per_page', type: 'number', min: 1, max: 1000, default: '1000' }
      ]
    },
    status: {
      path: '/video/status/',
      help: 'أدخل من 1 إلى 100 معرّف فيديو، مفصولة بفواصل. لا يفرض مخطط OpenAPI نمطًا شكليًا آخر على هذا الحقل. تُعاد الحالات بالترتيب نفسه: active أو removed أو unavailable أو unknown.',
      fields: [{ name: 'id', label: 'معرّفات الفيديو · id (مطلوب، 1–100)', type: 'textarea', required: true, placeholder: 'id-one, id-two, …' }]
    },
    categories: {
      path: '/categories/',
      help: 'يعيد الدليل الكامل للفئات. لا تقبل هذه العملية معاملات؛ استخدم التصفية المحلية في بطاقة الفئات، ثم ابحث باسم الفئة عبر query.'
    },
    pornstars: {
      path: '/pornstars/',
      help: 'دليل المؤدّين مرتب حسب الشعبية. page من 1 إلى 100000 وper_page من 1 إلى 1000؛ لا يقبل endpoint مرشح اسم أو معرّف.',
      fields: [
        { name: 'page', label: 'رقم الصفحة · page', type: 'number', min: 1, max: 100000, default: '1' },
        { name: 'per_page', label: 'عدد المؤدّين · per_page', type: 'number', min: 1, max: 1000, default: '100' }
      ]
    },
    oembed: {
      path: '/oembed/',
      help: 'ألصق رابط صفحة فيديو أو مشغّله على eporner.com أو أحد نطاقاته اللغوية. maxwidth وmaxheight عددان صحيحان ≥1؛ صيغة JSON فقط.',
      fields: [
        { name: 'url', label: 'رابط فيديو ePorner · url (مطلوب)', type: 'url', required: true, placeholder: 'https://www.eporner.com/video-…/' },
        { name: 'maxwidth', label: 'أقصى عرض · maxwidth (بكسل)', type: 'number', min: 1, placeholder: 'اختياري؛ الافتراضي حتى 1280' },
        { name: 'maxheight', label: 'أقصى ارتفاع · maxheight (بكسل)', type: 'number', min: 1, placeholder: 'اختياري' },
        { name: 'format', label: 'صيغة الرد · format', type: 'select', default: 'json', options: [['json', 'JSON فقط']] }
      ]
    },
    openapi: {
      path: '/openapi/',
      help: 'يعيد وثيقة OpenAPI v2.1.0 بصيغة JSON، وهي نفس المواصفة المحفوظة في المشروع. لا تقبل هذه العملية معاملات.'
    }
  };

  const EPORNER_OPERATION_NAMES = {
    search: 'بحث الفيديوهات', video: 'بيانات فيديو', removed: 'الفيديوهات المحذوفة', status: 'حالة الفيديوهات',
    categories: 'دليل الفئات', pornstars: 'دليل المؤدّين', oembed: 'بيانات المشغّل', openapi: 'وثيقة OpenAPI'
  };

  function updateEpornerToolsVisibility() {
    const active = state.site === 'eporner';
    const allowed = active && state.adultConfirmed;
    if (el.epornerHero) el.epornerHero.hidden = !active;
    if (el.searchGenericHero) el.searchGenericHero.hidden = active;
    if (el.form) el.form.classList.toggle('eporner-search-form', active);
    if (el.input) el.input.placeholder = active
      ? 'ابحث عن عنوان، كلمة مفتاحية، فئة أو مؤدٍ…'
      : state.site === 'youtube' ? 'ابحث في يوتيوب…'
        : state.site === 'pornflip' ? 'ابحث في PornFlip…' : 'ابحث في ديليموشن…';
    if (el.epornerConsent) el.epornerConsent.hidden = !active || state.adultConfirmed;
    if (el.epornerFilters) el.epornerFilters.hidden = !allowed;
    if (el.epornerDiscovery) el.epornerDiscovery.hidden = !allowed;
    if (el.epornerTools) el.epornerTools.hidden = !allowed;
    if (el.types) el.types.hidden = active;
    if (allowed) loadEpornerDirectories(false);
  }

  function operationFieldMarkup(field, index) {
    const id = 'epornerParam_' + field.name + '_' + index;
    if (field.type === 'checkboxes') {
      return '<fieldset class="eporner-field eporner-field--wide eporner-fields-choice"><legend>' + U.esc(field.label) + '</legend>' +
        field.options.map((option, optionIndex) => {
          const checked = Array.isArray(field.default) && field.default.includes(option[0]);
          return '<label><input type="checkbox" data-eporner-param="' + U.esc(field.name) + '" data-default="' + (checked ? 'checked' : '') +
            '" data-value="' + U.esc(option[0]) + '" value="' + U.esc(option[0]) + '"> ' + U.esc(option[1]) + '</label>';
        }).join('') + '</fieldset>';
    }
    const common = ' id="' + id + '" class="input" data-eporner-param="' + U.esc(field.name) + '" data-default="' +
      U.esc(field.default == null ? '' : field.default) + '"';
    const attrs = (field.required ? ' required' : '') +
      (field.min != null ? ' min="' + field.min + '"' : '') +
      (field.max != null ? ' max="' + field.max + '"' : '') +
      (field.maxLength != null ? ' maxlength="' + field.maxLength + '"' : '') +
      (field.pattern ? ' pattern="' + U.esc(field.pattern) + '"' : '') +
      (field.placeholder ? ' placeholder="' + U.esc(field.placeholder) + '"' : '');
    let control;
    if (field.type === 'select') {
      control = '<select' + common + attrs + '>' + field.options.map(option =>
        '<option value="' + U.esc(option[0]) + '">' + U.esc(option[1]) + '</option>').join('') + '</select>';
    } else if (field.type === 'textarea') {
      control = '<textarea' + common + attrs + ' rows="3"></textarea>';
    } else {
      control = '<input' + common + ' type="' + U.esc(field.type) + '" step="1"' + attrs + '>';
    }
    return '<label class="eporner-field" for="' + id + '"><span>' + U.esc(field.label) + '</span>' + control + '</label>';
  }

  function setEpornerToolExample() {
    if (!el.epornerOperation || !el.epornerOperationFields) return;
    const operation = el.epornerOperation.value || 'search';
    const definition = EPORNER_OPERATIONS[operation] || EPORNER_OPERATIONS.search;
    if (el.epornerOperationPath) el.epornerOperationPath.textContent = 'GET ' + definition.path;
    if (el.epornerOperationHelp) el.epornerOperationHelp.textContent = definition.help;
    el.epornerOperationFields.innerHTML = (definition.fields || []).map(operationFieldMarkup).join('') ||
      '<p class="eporner-no-params">لا توجد معاملات لهذه العملية. نفّذ الطلب مباشرة.</p>';
    el.epornerOperationFields.querySelectorAll('[data-eporner-param]').forEach(control => {
      const defaultValue = control.getAttribute('data-default');
      if (control.type === 'checkbox') {
        control.checked = defaultValue === 'checked';
        control.value = control.getAttribute('data-value') || control.value;
      } else if (defaultValue) control.value = defaultValue;
    });
  }

  function readEpornerOperationParams() {
    const operation = el.epornerOperation && el.epornerOperation.value || 'search';
    const definition = EPORNER_OPERATIONS[operation];
    if (!definition) throw new Error('عملية ePorner غير معروفة');
    const params = {};
    const fields = {};
    el.epornerOperationFields.querySelectorAll('[data-eporner-param]').forEach(control => {
      const name = control.getAttribute('data-eporner-param');
      const spec = (definition.fields || []).find(item => item.name === name);
      if (!spec) return;
      if (control.type === 'checkbox') {
        if (control.checked) (fields[name] = fields[name] || []).push(control.value);
        return;
      }
      const raw = String(control.value || '').trim();
      if (!raw) {
        if (spec.required) throw new Error('المعامل مطلوب: ' + name);
        return;
      }
      if (spec.type === 'number') {
        if (!/^\d+$/.test(raw)) throw new Error(name + ' يجب أن يكون عددًا صحيحًا');
        const value = BigInt(raw);
        if (value < BigInt(spec.min || 0) || (spec.max != null && value > BigInt(spec.max)))
          throw new Error(name + ' خارج المجال الموثّق');
        params[name] = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
      } else {
        params[name] = raw;
      }
    });
    Object.keys(fields).forEach(name => {
      if (fields[name].length) params[name] = fields[name].join(',');
    });
    if (operation === 'video' && !/^[A-Za-z0-9]{11}$/.test(String(params.id || '')))
      throw new Error('id يجب أن يتكوّن من 11 حرفًا أو رقمًا');
    if (operation === 'status') {
      const ids = String(params.id || '').split(',').map(value => value.trim());
      if (ids.length < 1 || ids.length > 100 || ids.some(id => !id))
        throw new Error('أدخل من 1 إلى 100 معرّف غير فارغ، مفصولة بفواصل');
      params.id = ids.join(',');
    }
    if (operation === 'removed' && params.after && !/^\d{1,10}\.\d{1,10}$/.test(String(params.after)))
      throw new Error('after يجب أن يكون قيمة next المنسوخة من الرد السابق');
    if (operation === 'oembed') {
      if (!safeEpornerUrl(params.url)) throw new Error('url يجب أن يكون رابط HTTPS على نطاق ePorner');
      if (params.format && params.format !== 'json') throw new Error('عملية oEmbed توفر JSON فقط');
    }
    if (params.lang && !/^[a-z]{2}$/.test(String(params.lang))) throw new Error('lang يجب أن يكون حرفين صغيرين مثل pl أو fr أو es');
    if (params.gay != null && !['0', '1', '2'].includes(String(params.gay))) throw new Error('gay يقبل 0 أو 1 أو 2');
    if (params.lq != null && !['0', '1', '2'].includes(String(params.lq))) throw new Error('lq يقبل 0 أو 1 أو 2');
    return { operation, params };
  }

  function clearEpornerToolOutput() {
    if (el.epornerOutputWrap) el.epornerOutputWrap.hidden = true;
    if (el.epornerOutput) el.epornerOutput.textContent = '';
    if (el.epornerOutputMeta) el.epornerOutputMeta.textContent = '';
  }

  function showEpornerToolOutput(data, title, contentType) {
    if (!el.epornerOutput) return;
    if (el.epornerTools) el.epornerTools.open = true;
    if (el.epornerOutputWrap) el.epornerOutputWrap.hidden = false;
    if (el.epornerOutputTitle) el.epornerOutputTitle.textContent = title || 'استجابة API';
    if (el.epornerOutputMeta) el.epornerOutputMeta.textContent = contentType || (typeof data === 'string' ? 'نص خام' : 'application/json');
    el.epornerOutput.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }

  function renderEpornerCategories(categories, message) {
    if (!Array.isArray(categories) || !el.epornerCategoryList) return;
    state.epornerCategories = categories.filter(item => item && typeof item.name === 'string');
    state.epornerCategoriesLoaded = true;
    const filter = String(el.epornerCategoryFilter && el.epornerCategoryFilter.value || '').trim().toLowerCase();
    const visible = state.epornerCategories.filter(item => !filter ||
      String(item.name || '').toLowerCase().includes(filter) || String(item.slug || '').toLowerCase().includes(filter));
    if (el.epornerCategoriesMeta) el.epornerCategoriesMeta.textContent = message ||
      (visible.length === state.epornerCategories.length
        ? state.epornerCategories.length + ' فئة — اختر اسمًا للبحث'
        : visible.length + ' من ' + state.epornerCategories.length + ' فئة مطابقة');
    el.epornerCategoryList.innerHTML = visible.map(category => {
      const name = String(category.name || '').trim();
      const slug = String(category.slug || '').trim();
      return '<button class="eporner-category-chip" type="button" role="listitem" data-eporner-search="' + U.esc(name) + '" aria-label="ابحث عن فئة ' + U.esc(name) + '">' +
        '<span class="eporner-category-chip__dot" aria-hidden="true"></span><span>' + U.esc(name) + '</span>' +
        (slug ? '<small>' + U.esc(slug) + '</small>' : '') + '</button>';
    }).join('') || '<p class="eporner-directory-empty">' + (state.epornerCategories.length ? 'لا توجد فئات تطابق هذا الاسم.' : 'لا تتوفر فئات في هذا الرد.') + '</p>';
  }

  function updateEpornerPornstarPager() {
    const page = state.epornerPornstarsPage;
    const pages = state.epornerPornstarsTotalPages;
    if (el.epornerPornstarsPageLabel) el.epornerPornstarsPageLabel.textContent = page + ' / ' + pages;
    if (el.epornerPornstarsPrev) el.epornerPornstarsPrev.disabled = state.epornerPornstarsLoading || page <= 1;
    if (el.epornerPornstarsNext) el.epornerPornstarsNext.disabled = state.epornerPornstarsLoading || page >= pages;
  }

  function renderEpornerPornstars(data, requestedPage, requestedPerPage) {
    const entries = data && Array.isArray(data.pornstars) ? data.pornstars : [];
    state.epornerPornstarsLoaded = true;
    const page = Math.max(1, Number(data && data.page) || requestedPage || 1);
    const pages = Math.max(1, Number(data && data.total_pages) || page);
    state.epornerPornstarsPage = page;
    state.epornerPornstarsTotalPages = pages;
    const total = Number(data && data.total_count);
    if (el.epornerPornstarsMeta) el.epornerPornstarsMeta.textContent = Number.isFinite(total) && total > 0
      ? total.toLocaleString() + ' مؤدٍ في الدليل · ترتيب حسب الشعبية'
      : entries.length + ' مؤدٍ في هذه الصفحة';
    if (el.epornerPornstarsPerPage && requestedPerPage) el.epornerPornstarsPerPage.value = String(requestedPerPage);
    if (el.epornerPornstarList) {
      el.epornerPornstarList.innerHTML = entries.map(person => {
        const name = String(person && person.name || '').trim();
        if (!name) return '';
        const gender = person.gender === 'female' ? 'أنثى' : person.gender === 'male' ? 'ذكر' : 'المؤدّي';
        const videos = Number(person.videos) || 0;
        const photos = Number(person.photos) || 0;
        return '<button class="eporner-performer-card" type="button" role="listitem" data-eporner-search="' + U.esc(name) + '" aria-label="ابحث عن ' + U.esc(name) + '">' +
          '<span class="eporner-performer-card__avatar" aria-hidden="true">' + U.esc(name.slice(0, 1).toUpperCase()) + '</span>' +
          '<span class="eporner-performer-card__copy"><strong>' + U.esc(name) + '</strong><small>' + U.esc(gender) + ' · ' + videos.toLocaleString() + ' فيديو · ' + photos.toLocaleString() + ' صورة</small></span>' +
          '<span class="ic" data-icon="search" data-size="15"></span></button>';
      }).join('') || '<p class="eporner-directory-empty">لا توجد أسماء في هذه الصفحة.</p>';
    }
    updateEpornerPornstarPager();
  }

  async function loadEpornerCategories(force) {
    if (!state.adultConfirmed || state.site !== 'eporner' || state.epornerCategoriesLoading ||
        (state.epornerCategoriesLoaded && !force) || !window.WTEpornerApi) return;
    state.epornerCategoriesLoading = true;
    if (el.epornerCategoriesMeta) el.epornerCategoriesMeta.textContent = 'جارٍ تحميل دليل الفئات…';
    try {
      const data = await window.WTEpornerApi.categories({});
      renderEpornerCategories(data && data.categories, '');
      if (!Array.isArray(data && data.categories)) throw new Error('استجابة الفئات غير مفهومة');
    } catch (error) {
      if (el.epornerCategoriesMeta) el.epornerCategoriesMeta.textContent =
        (error && error.message ? error.message : 'تعذّر تحميل الفئات') + (error && error.retryAfter ? ' · أعد المحاولة بعد ' + error.retryAfter + ' ثانية' : '');
    } finally { state.epornerCategoriesLoading = false; }
  }

  function epornerPornstarsPerPage() {
    const raw = String(el.epornerPornstarsPerPage && el.epornerPornstarsPerPage.value || '').trim();
    const value = raw ? Number(raw) : 24;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('per_page للمؤدّين يجب أن يكون بين 1 و1000');
    return value;
  }

  async function loadEpornerPornstars(page, force) {
    if (!state.adultConfirmed || state.site !== 'eporner' || state.epornerPornstarsLoading ||
        (state.epornerPornstarsLoaded && !force) || !window.WTEpornerApi) return;
    let perPage;
    try { perPage = epornerPornstarsPerPage(); }
    catch (error) {
      if (el.epornerPornstarsMeta) el.epornerPornstarsMeta.textContent = error.message;
      return;
    }
    const requestedPage = Math.max(1, Number(page) || 1);
    state.epornerPornstarsLoading = true;
    updateEpornerPornstarPager();
    if (el.epornerPornstarsMeta) el.epornerPornstarsMeta.textContent = 'جارٍ تحميل الصفحة ' + requestedPage + '…';
    try {
      const data = await window.WTEpornerApi.pornstars({ page: requestedPage, per_page: perPage });
      if (!data || !Array.isArray(data.pornstars)) throw new Error('استجابة دليل المؤدّين غير مفهومة');
      renderEpornerPornstars(data, requestedPage, perPage);
    } catch (error) {
      if (el.epornerPornstarsMeta) el.epornerPornstarsMeta.textContent =
        (error && error.message ? error.message : 'تعذّر تحميل المؤدّين') + (error && error.retryAfter ? ' · أعد المحاولة بعد ' + error.retryAfter + ' ثانية' : '');
    } finally {
      state.epornerPornstarsLoading = false;
      updateEpornerPornstarPager();
    }
  }

  function loadEpornerDirectories(force) {
    if (!state.adultConfirmed || state.site !== 'eporner') return;
    loadEpornerCategories(!!force);
    loadEpornerPornstars(force ? 1 : state.epornerPornstarsPage, !!force);
  }

  function startEpornerSearchFromDirectory(term) {
    const name = String(term || '').trim();
    if (!name) return;
    el.input.value = name;
    el.clear.hidden = false;
    state.site = 'eporner';
    updateSourceBadge();
    renderTabs();
    updateEpornerToolsVisibility();
    runSearch(name);
    el.input.focus();
  }

  function rawOutputLabel(operation) {
    return 'استجابة ' + (EPORNER_OPERATION_NAMES[operation] || 'ePorner API') + ' · ' + EPORNER_OPERATIONS[operation].path;
  }

  function renderEpornerOperationVideos(data, operation, params) {
    let rawVideos = [];
    if (operation === 'search' && data && Array.isArray(data.videos)) rawVideos = data.videos;
    else if (operation === 'video' && data && !Array.isArray(data) && typeof data === 'object') rawVideos = [data];
    const items = rawVideos.map(item => normalize({ ...item, type: 'video', site: 'eporner' }, 'eporner')).filter(Boolean);
    state.site = 'eporner';
    state.view = 'search';
    state.browse = null;
    state.items = items;
    state.viewItems = items;
    state.epornerHasMore = false;
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    if (items.length) {
      el.empty.hidden = true;
      render(items);
      status(items.length + ' نتيجة — ePorner API v2');
    } else {
      el.results.innerHTML = '';
      el.results.setAttribute('aria-busy', 'false');
      el.empty.hidden = false;
      el.emptyText.textContent = operation === 'video' ? 'لا توجد بيانات متاحة لهذا المعرّف.' : 'لم يُرجع البحث فيديوهات.';
      status('');
    }
    if (operation === 'search') {
      const page = Number(params.page) || 1;
      const totalPages = Number(data.total_pages) || page;
      const total = Number(data.total_count) || 0;
      status(items.length + ' نتيجة — ' + total.toLocaleString() + ' إجمالًا · الصفحة ' + page + ' من ' + totalPages);
    }
  }

  async function runEpornerTool(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (state.site !== 'eporner' || !state.adultConfirmed) {
      requestAdultConfirmation('', '');
      return;
    }
    if (state.epornerOperationBusy || !window.WTEpornerApi) return;
    let operation, params;
    try {
      const parsed = readEpornerOperationParams();
      operation = parsed.operation;
      params = parsed.params;
      if (el.epornerOperationForm && typeof el.epornerOperationForm.reportValidity === 'function' && !el.epornerOperationForm.reportValidity()) return;
    } catch (error) {
      showEpornerToolOutput(error.message || 'تحقّق من معاملات العملية', 'تحقّق من المدخلات', 'خطأ');
      return;
    }
    state.epornerOperationBusy = true;
    if (el.epornerRun) el.epornerRun.disabled = true;
    showEpornerToolOutput('جارٍ تنفيذ ' + EPORNER_OPERATIONS[operation].path + '…', 'جارٍ تنفيذ العملية', 'قيد التنفيذ');
    try {
      const data = await window.WTEpornerApi.run(operation, params);
      if (operation === 'categories') {
        if (!data || !Array.isArray(data.categories)) throw new Error('استجابة دليل الفئات غير مفهومة');
        renderEpornerCategories(data.categories);
      } else if (operation === 'pornstars') {
        if (!data || !Array.isArray(data.pornstars)) throw new Error('استجابة دليل المؤدّين غير مفهومة');
        renderEpornerPornstars(data, Number(params.page) || 1, Number(params.per_page) || 100);
      } else if (operation === 'search' && typeof data !== 'string' || operation === 'video' && typeof data !== 'string') {
        renderEpornerOperationVideos(data, operation, params);
      }
      showEpornerToolOutput(data, rawOutputLabel(operation), typeof data === 'string' ? 'نص خام / XML أو text' : 'application/json');
    } catch (error) {
      showEpornerToolOutput((error && error.message ? error.message : 'تعذّرت عملية ePorner') +
        (error && error.retryAfter ? ' — أعد المحاولة بعد ' + error.retryAfter + ' ثانية' : ''), 'تعذّر تنفيذ العملية', 'خطأ');
    } finally {
      state.epornerOperationBusy = false;
      if (el.epornerRun) el.epornerRun.disabled = false;
    }
  }

  function updateSourceBadge() {
    const badge = $('searchSourceBadge');
    if (badge) badge.textContent = SITE_LABEL_AR[state.site] || SITE_LABEL_AR.dailymotion;
  }

  function adultGateIsOpen() {
    return !!(el.adultGate && el.adultGate.getAttribute('open') !== null);
  }

  function closeAdultGate() {
    if (!el.adultGate) return;
    if (typeof el.adultGate.close === 'function') el.adultGate.close();
    else el.adultGate.removeAttribute('open');
  }

  function clearSearchResults(message) {
    state.items = [];
    state.viewItems = [];
    el.results.innerHTML = '';
    el.results.setAttribute('aria-busy', 'false');
    el.empty.hidden = false;
    el.emptyText.textContent = message || 'ابحث عن فيديو لتبدأ';
    el.browseBar.hidden = true;
    el.browseMore.hidden = true;
    status('');
  }

  function requestAdultConfirmation(action, query) {
    if (state.adultConfirmed) return false;
    if (action) {
      state.pendingAdultAction = action;
      state.pendingAdultQuery = String(query || '').trim();
    } else if (!adultGateIsOpen()) {
      state.pendingAdultAction = '';
      state.pendingAdultQuery = '';
    }
    status('يتطلب ' + (SITE_LABEL_AR[state.site] || 'المصدر المخصص للبالغين') + ' إقرارًا صريحًا بأن عمرك 18 عامًا أو أكثر.');
    if (el.adultGateTitle) el.adultGateTitle.textContent = (SITE_LABEL_AR[state.site] || 'مصدر بالغين') + ' — تأكيد العمر';
    if (!el.adultGate) return true;
    if (!adultGateIsOpen()) {
      if (typeof el.adultGate.showModal === 'function') el.adultGate.showModal();
      else el.adultGate.setAttribute('open', '');
      if (el.adultGateAccept && typeof el.adultGateAccept.focus === 'function') el.adultGateAccept.focus();
    }
    return true;
  }

  function acceptAdultConfirmation() {
    state.adultConfirmed = true;
    try { window.sessionStorage.setItem(ADULT_ACK_KEY, 'yes'); } catch (_) { /* يبقى التأكيد في ذاكرة الصفحة */ }
    updateEpornerToolsVisibility();
    const action = state.pendingAdultAction;
    const query = state.pendingAdultQuery;
    state.pendingAdultAction = '';
    state.pendingAdultQuery = '';
    closeAdultGate();
    status('');
    if (action === 'search') runSearch(query);
    else if (action === 'favorites') showFavorites();
    else {
      el.empty.hidden = false;
      el.emptyText.textContent = state.site === 'eporner'
        ? 'ابحث عن فيديو، أو اختر فئة أو مؤدّيًا من الدليل.'
        : 'اكتب عبارة للبحث في ' + (SITE_LABEL_AR[state.site] || 'المصدر') + ' بعد إقرار 18+.';
      status('');
    }
  }

  function cancelAdultConfirmation() {
    closeAdultGate();
    state.pendingAdultAction = '';
    state.pendingAdultQuery = '';
    const fallback = ['youtube', 'dailymotion'].includes(state.previousSite) ? state.previousSite : 'dailymotion';
    state.site = fallback;
    state.previousSite = fallback;
    state.view = 'search';
    state.browse = null;
    state.loading = false;
    state.token++;
    state.query = '';
    el.input.value = '';
    el.clear.hidden = true;
    el.go.disabled = false;
    updateSourceBadge();
    renderTabs();
    renderChips();
    updateNote();
    updateEpornerToolsVisibility();
    clearSearchResults('لم يتم تأكيد العمر؛ لم يُرسل أي طلب إلى مصدر البالغين.');
    status('لم يتم تأكيد 18+؛ لم يُرسل أي طلب إلى مصدر البالغين.');
  }

  function setSite(site, run) {
    const nextSite = ['youtube', 'dailymotion', 'pornflip', 'eporner'].includes(site) ? site : 'dailymotion';
    if (nextSite === state.site && !(isAdultSource(nextSite) && !state.adultConfirmed)) return;
    if (isAdultSource(nextSite) && !state.adultConfirmed) {
      if (!isAdultSource(state.site)) state.previousSite = state.site;
      state.site = nextSite;
      if (['channel', 'playlist'].includes(state.searchType)) state.searchType = 'video';
      state.view = 'search';
      state.browse = null;
      state.loading = false;
      state.token++;
      el.go.disabled = false;
      updateSourceBadge();
      renderTabs();
      renderChips();
      updateEpornerToolsVisibility();
      clearSearchResults('تأكيد 18+ مطلوب قبل تحميل نتائج ' + (SITE_LABEL_AR[state.site] || 'المصدر') + '.');
      requestAdultConfirmation(run && state.query.length >= 2 ? 'search' : '', run ? state.query : '');
      return;
    }
    const leavingAdult = isAdultSource(state.site) && !isAdultSource(nextSite);
    if (leavingAdult) {
      state.loading = false;
      state.token++;
      state.query = '';
      el.input.value = '';
      el.clear.hidden = true;
      el.go.disabled = false;
      run = false; /* لا ترسل عبارة بحث للبالغين إلى منصة أخرى */
      clearSearchResults('ابحث عن فيديو لتبدأ');
    }
    const previousSource = state.site;
    state.site = nextSite;
    if (state.site === 'youtube' && previousSource !== 'youtube') state.searchType = 'all';
    else if (state.site !== 'youtube' && ['channel', 'playlist'].includes(state.searchType)) state.searchType = 'video';
    state.view = 'search';
    state.browse = null;
    updateSourceBadge();
    renderTabs();
    renderChips();
    updateNote();
    updateEpornerToolsVisibility();
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
      const hiddenAdultFavorites = !state.adultConfirmed && saved.some(isAdultItem);
      state.items = saved.filter(item => state.adultConfirmed || !isAdultItem(item))
        .map(item => normalize(item, item.site)).filter(Boolean);
      state.viewItems = state.items;
      if (state.items.length) {
        render(state.items);
        status(state.items.length + ' فيديو في مفضّلتك الشخصية');
      } else {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = false;
        el.emptyText.textContent = hiddenAdultFavorites
          ? 'بعض المفضّلات مخفية حتى تأكيد 18+ في تبويب مصدر بالغين.'
          : 'لم تحفظ فيديوهات بعد — اضغط القلب على فيديو لإضافته إلى مفضّلتك';
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
      : item.site === 'pornflip' ? 'جارٍ فتح مشغّل PornFlip…'
        : item.site === 'eporner' ? 'جارٍ تجهيز مشغّل ePorner عبر API v2…' : 'جارٍ استخراج رابط التشغيل المباشر…';
    el.room.disabled = true;
    el.queue.disabled = true;
    el.copy.disabled = true;
    el.favorite.hidden = isAdultItem(item);
    el.favorite.disabled = isAdultItem(item);
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

  function directKey(item) { return String(item.site || '') + ':' + String(item.id || ''); }

  function ready(url, hint) {
    el.spinner.hidden = true;
    el.error.hidden = true;
    el.room.disabled = false;
    el.queue.disabled = false;
    el.copy.disabled = false;
    el.hint.hidden = false;
    el.hint.textContent = hint;
    if (state.current.site === 'pornflip' && isPornFlipEmbedUrl(url)) {
      const f = frame();
      f.src = url;
      f.hidden = false;
      try { el.video.pause(); } catch (_) { }
      el.video.removeAttribute('src');
      el.video.hidden = true;
      el.source.href = state.current.url;
      el.source.hidden = false;
      el.source.textContent = 'افتح على PornFlip';
    } else if (state.current.site === 'eporner' && safeEpornerEmbed(url, state.current.id)) {
      const f = frame();
      f.src = url;
      f.hidden = false;
      try { el.video.pause(); } catch (_) { }
      el.video.removeAttribute('src');
      el.video.hidden = true;
      el.source.href = state.current.url;
      el.source.hidden = false;
      el.source.textContent = 'افتح على ePorner';
    } else if (state.current.site === 'youtube') {
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
      state.direct.set(directKey(item), item.url);
      ready(item.url, 'يُشغَّل يوتيوب بمشغّله الرسمي — لا حاجة لاستخراج رابط مباشر.');
      return;
    }
    if (item.site === 'pornflip') {
      /* PornFlip يقدّم DASH؛ استخدم مشغّل الموقع المضمّن بدلاً من تمرير MPD إلى <video>. */
      const embedUrl = pornFlipEmbedUrl(item);
      if (!embedUrl) {
        showError('تعذّر التحقق من رابط PornFlip.');
        el.hint.textContent = 'يمكنك فتح الرابط الأصلي على PornFlip من الزر بالأسفل.';
        el.source.href = item.url;
        el.source.hidden = false;
        el.source.textContent = 'افتح على PornFlip';
        return;
      }
      state.direct.set(directKey(item), embedUrl);
      ready(embedUrl, 'يُشغَّل الفيديو بمشغّل PornFlip المضمّن. إذا منع المتصفح التضمين، استخدم زر «افتح على PornFlip».');
      return;
    }
    if (item.site === 'eporner') {
      const embedUrl = safeEpornerEmbed(item.embedUrl, item.id);
      if (!embedUrl) {
        showError('لم تُرجع واجهة ePorner رابط مشغّل صالحاً لهذا الفيديو.');
        el.hint.textContent = 'يمكنك فتح الرابط الأصلي على ePorner من الزر بالأسفل.';
        el.source.href = item.url;
        el.source.hidden = false;
        el.source.textContent = 'افتح على ePorner';
        return;
      }
      state.direct.set(directKey(item), embedUrl);
      ready(embedUrl, 'يُشغَّل الفيديو بمشغّل ePorner المضمّن حسب بيانات API v2. إذا منع المتصفح التضمين، استخدم زر «افتح على ePorner».');
      return;
    }
    /* تيك توك/كيك/تويتش/ديليموشن: نحاول استخراج رابط التشغيل عبر السيرفر (yt-dlp).
       إن تعذّر الاستخراج (لا سيرفر، أو المنصة غير مدعومة)، نعرض زر «افتح على موقعها الأصلي». */
    const cached = state.direct.get(directKey(item));
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
      state.direct.set(directKey(item), src);
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
        dailymotion: 'ديليموشن', pornflip: 'PornFlip'
      }[item.site] || 'الموقع الأصلي';
    }
  }

  /* ============================== 5) الغرفة وقائمة الانتظار ============================== */

  function playableUrl() {
    const item = state.current;
    if (!item) return '';
    return state.direct.get(directKey(item)) || (item.site === 'youtube' ? item.url : '');
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

  if (el.adultGateAccept) el.adultGateAccept.addEventListener('click', acceptAdultConfirmation);
  if (el.adultGateCancel) el.adultGateCancel.addEventListener('click', cancelAdultConfirmation);
  if (el.epornerConsentOpen) el.epornerConsentOpen.addEventListener('click', () => requestAdultConfirmation('', ''));
  if (el.adultGate) el.adultGate.addEventListener('cancel', event => {
    event.preventDefault();
    cancelAdultConfirmation();
  });

  el.sources.addEventListener('click', event => {
    const tab = event.target.closest('[data-site]');
    if (!tab) return;
    const site = tab.getAttribute('data-site');
    if (site === state.site && !(isAdultSource(site) && !state.adultConfirmed)) return;
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
  el.browseLoadMore.addEventListener('click', () => {
    if (state.site === 'eporner' && !state.browse) loadMoreEporner();
    else loadBrowsePage(true);
  });
  if (el.epornerOperation) el.epornerOperation.addEventListener('change', setEpornerToolExample);
  if (el.epornerOperationForm) el.epornerOperationForm.addEventListener('submit', runEpornerTool);
  if (el.epornerCategoryFilter) el.epornerCategoryFilter.addEventListener('input', () =>
    renderEpornerCategories(state.epornerCategories));
  if (el.epornerCategoriesReload) el.epornerCategoriesReload.addEventListener('click', () => loadEpornerCategories(true));
  if (el.epornerPornstarsReload) el.epornerPornstarsReload.addEventListener('click', () =>
    loadEpornerPornstars(state.epornerPornstarsPage, true));
  if (el.epornerPornstarsPerPage) el.epornerPornstarsPerPage.addEventListener('change', () => loadEpornerPornstars(1, true));
  if (el.epornerPornstarsPrev) el.epornerPornstarsPrev.addEventListener('click', () =>
    loadEpornerPornstars(Math.max(1, state.epornerPornstarsPage - 1), true));
  if (el.epornerPornstarsNext) el.epornerPornstarsNext.addEventListener('click', () =>
    loadEpornerPornstars(Math.min(state.epornerPornstarsTotalPages, state.epornerPornstarsPage + 1), true));
  if (el.epornerCategoryList) el.epornerCategoryList.addEventListener('click', event => {
    const button = event.target.closest('[data-eporner-search]');
    if (button) startEpornerSearchFromDirectory(button.getAttribute('data-eporner-search'));
  });
  if (el.epornerPornstarList) el.epornerPornstarList.addEventListener('click', event => {
    const button = event.target.closest('[data-eporner-search]');
    if (button) startEpornerSearchFromDirectory(button.getAttribute('data-eporner-search'));
  });

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
    if (!state.current || isAdultItem(state.current) || el.favorite.disabled) return;
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

  try { state.adultConfirmed = window.sessionStorage.getItem(ADULT_ACK_KEY) === 'yes'; }
  catch (_) { state.adultConfirmed = false; }
  renderTabs();
  renderChips();

  const params = new URLSearchParams(location.search);
  const requestedSite = params.get('site');
  if (['youtube', 'dailymotion', 'pornflip', 'eporner'].includes(requestedSite)) {
    if (isAdultSource(requestedSite) && !isAdultSource(state.site)) state.previousSite = state.site;
    state.site = requestedSite;
  }
  if (['all', 'video', 'channel', 'playlist'].includes(params.get('type'))) state.searchType = params.get('type');
  else if (state.site === 'youtube') state.searchType = 'all';
  if (state.site !== 'youtube' && ['channel', 'playlist'].includes(state.searchType)) state.searchType = 'video';
  updateSourceBadge();
  renderTabs();
  renderChips();
  updateEpornerToolsVisibility();
  setEpornerToolExample();
  const initial = params.get('q');
  if (initial) {
    el.input.value = initial;
    el.clear.hidden = false;
    runSearch(initial);
  } else if (state.site === 'eporner' && !state.adultConfirmed) {
    if (el.epornerConsent) el.epornerConsent.hidden = false;
    el.empty.hidden = false;
    el.emptyText.textContent = 'أكّد 18+ أولًا لفتح البحث والدليلين. لن يُرسل أي طلب قبل موافقتك.';
  } else if (isAdultSource(state.site) && !state.adultConfirmed) {
    requestAdultConfirmation('', '');
  } else if (state.site === 'eporner') {
    el.empty.hidden = false;
    el.emptyText.textContent = 'ابحث عن فيديو، أو اختر فئة أو مؤدّيًا من الدليل.';
  }
})();

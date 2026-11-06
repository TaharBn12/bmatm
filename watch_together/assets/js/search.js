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

  const $ = id => document.getElementById(id);
  const el = {
    form: $('searchForm'), input: $('searchInput'), go: $('searchGo'), clear: $('searchClear'),
    sources: $('searchSources'), chips: $('searchChips'), status: $('searchStatus'), note: $('serverNote'),
    noteText: $('serverNoteText'),
    results: $('results'), empty: $('empty'), emptyText: $('emptyText'),
    dialog: $('playDialog'), dTitle: $('playTitle'), dClose: $('playClose'),
    stage: $('playStage'), spinner: $('playSpinner'), spinnerText: $('playSpinnerText'),
    video: $('playVideo'), error: $('playError'),
    room: $('playRoom'), queue: $('playQueue'), copy: $('playCopy'),
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

  const state = {
    query: '', site: 'dailymotion', items: [], loading: false,
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

  function normalize(raw, site) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!id) return null;
    const youtube = site === 'youtube';
    if (youtube ? !/^[A-Za-z0-9_-]{11}$/.test(id) : !/^[a-zA-Z0-9]{1,32}$/.test(id)) return null;
    const url = youtube ? 'https://www.youtube.com/watch?v=' + id
      : (String(raw.url || '').trim() || 'https://www.dailymotion.com/video/' + id);
    let thumb = String(raw.thumb || '').trim();
    if (!thumb && youtube) thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    if (!thumb) thumb = 'https://www.dailymotion.com/thumbnail/video/' + id;
    let author = String(raw.author || raw.owner || '').trim();
    if (author === 'undefined' || author === 'null') author = '';
    return {
      id: id, site: youtube ? 'youtube' : 'dailymotion',
      title: String(raw.title || '').trim() || 'بدون عنوان',
      url: url, thumb: thumb,
      duration: Number(raw.duration) || 0, author: author
    };
  }

  /**
   * المحاولة الأولى: سيرفر Java (yt-dlp، أو واجهة ديليموشن عبر السيرفر).
   * نفرّق بدقّة بين ثلاث حالات كانت تُظهر كلها رسالة واحدة مبهمة:
   *   1) لا سيرفر أصلاً (ملف file://، منفذ خاطئ، سيرفر قديم) → null
   *   2) السيرفر موجود لكن خدمة البحث معطّلة (5xx) → خطأ serverDown
   *   3) خطأ من عندنا (4xx) → خطأ عادي
   */
  async function fromServer(term, limit, site) {
    const api = (window.WTServer && window.WTServer.api) ? window.WTServer.api('api/search') : 'api/search';
    const url = api + '?q=' + encodeURIComponent(term) + '&limit=' + limit + '&site=' + encodeURIComponent(site);
    let response = null;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (networkError) {
      state.reason = location.protocol === 'file:'
        ? 'الصفحة مفتوحة كملف (file://) لا عبر السيرفر'
        : 'تعذّر الاتصال بالسيرفر على ' + (location.host || 'العنوان الحالي') +
          ' — أغلق كل نسخة قديمة (taskkill /F /IM java.exe) ثم شغّل run.bat واقرأ المنفذ من اللافتة';
      return null;
    }
    let text = '';
    try { text = await response.text(); } catch (e) { text = ''; }
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!response.ok) {
      const message = (data && data.error) ? data.error : 'استجابة غير متوقعة (' + response.status + ')';
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
    return { items: data.items.map(item => normalize(item, site)).filter(Boolean), source: data.source || 'server' };
  }

  /**
   * /api/search غير موجود (404): هل هو سيرفر Java قديم، أم ليس سيرفر Java أصلاً؟
   * نفحص /api/healthz لأنها موجودة في كل نسخة Java حديثة.
   */
  async function diagnoseMissing(status) {
    const from = location.origin && location.origin !== 'null' ? location.origin : 'ملف محلي (file://)';
    const base = 'الصفحة مفتوحة من ' + from + '، وهذا السيرفر لا يعرض /api/search (' + status + ')';
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
    /* رقم مسلسل للطلب: أي بحث أحدث يُلغي نتائج البحث الذي سبقه.
       بدونه، تبديل المصدر أثناء بحث جارٍ كان يُتجاهل بسبب حاجز state.loading
       فتبقى نتائج المصدر القديم معروضة تحت تبويب المصدر الجديد. */
    const token = ++state.token;
    state.loading = true;
    state.query = query;
    el.go.disabled = true;
    skeleton(8);
    el.empty.hidden = true;
    status('جارٍ البحث عن «' + query + '»…');
    try {
      let result = null;
      try {
        result = await fromServer(query, LIMIT, state.site);
        if (token !== state.token) return;            /* بحث أحدث تولّى العرض */
        state.server = result !== null;
      } catch (error) {
        if (token !== state.token) return;
        if (error && error.serverDown) {
          /* السيرفر موجود، لكن خدمة البحث فيه معطّلة (yt-dlp/Python) — لا نقول «استضافة ثابتة» */
          state.server = true;
          if (state.site !== 'dailymotion') throw error;            /* يوتيوب: لا بديل في المتصفح */
          try {
            result = await fromDailymotion(query, LIMIT);           /* بديل المتصفح لديليموشن */
            if (token !== state.token) return;
          } catch (browserError) { throw error; }
        } else {
          state.server = null;
          throw error;                                 /* خطأ صريح من السيرفر (400/429/…) */
        }
      }
      if (!result) {
        state.server = false;
        if (state.site === 'youtube') {
          result = { items: [], source: 'none' };
        } else {
          result = await fromDailymotion(query, LIMIT);
          if (token !== state.token) return;
        }
      }
      state.items = result.items;
      updateNote();
      if (!state.items.length) {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = false;
        el.emptyText.textContent = state.site === 'youtube'
          ? (state.server === false
              ? 'بحث يوتيوب يحتاج سيرفر Java مع yt-dlp' + (state.reason ? ' — ' + state.reason : '') +
                ' — افتح الصفحة من العنوان الذي تطبعه لافتة run.bat (مثل http://localhost:8081/search.html)'
              : 'لم يُرجع يوتيوب نتائج عن «' + query + '» — حدّث yt-dlp ثم أعد المحاولة: py -m pip install -U yt-dlp')
          : 'لا نتائج لـ «' + query + '» — جرّب كلمة أخرى';
        status('');
      } else {
        render(state.items);
        pushRecent(query);
        status(state.items.length + ' نتيجة — المصدر: ' + (
          result.source === 'yt-dlp' ? 'yt-dlp على السيرفر' :
          result.source === 'dailymotion-api' ? 'واجهة ديليموشن' : 'ديليموشن مباشرة'
        ));
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
    /* state.reason يحمل التعليمات المناسبة لكل سبب (منفذ قديم · 404 · انقطاع) */
    const where = location.protocol === 'file:'
      ? 'أنت تفتح الصفحة كملف (file://) — لا تعمل أي نقطة /api. شغّل run.bat ثم افتح العنوان الذي تطبعه اللافتة.'
      : (state.reason || 'شغّل run.bat ثم أعد تحميل الصفحة من العنوان الذي تطبعه اللافتة.');
    el.noteText.textContent = state.site === 'youtube'
      ? 'بحث يوتيوب يحتاج سيرفر Java مع yt-dlp. ' + where
      : 'نتائج البحث تعمل، لكن استخراج رابط التشغيل المباشر يحتاج سيرفر Java مع yt-dlp. ' + where;
  }

  /* ============================== 3) العرض ============================== */

  function render(items) {
    el.empty.hidden = true;
    el.results.setAttribute('aria-busy', 'false');
    el.results.innerHTML = items.map((item, index) => {
      const badge = duration(item.duration);
      const author = item.author ? '<span class="result-card__author">' + U.esc(item.author) + '</span>' : '';
      return '' +
        '<button class="result-card" type="button" data-index="' + index + '" aria-label="تشغيل: ' + U.esc(item.title) + '">' +
          '<span class="result-card__thumb">' +
            '<img class="result-card__img" src="' + U.esc(item.thumb) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
            (badge ? '<span class="result-card__badge">' + badge + '</span>' : '') +
            '<span class="result-card__play"><span>' + IC.html('play', 22) + '</span></span>' +
          '</span>' +
          '<span class="result-card__body">' +
            '<span class="result-card__title">' + U.esc(item.title) + '</span>' +
            '<span class="result-card__meta">' + author + '</span>' +
          '</span>' +
        '</button>';
    }).join('');
  }

  function renderChips() {
    const list = recent();
    const quick = state.site === 'youtube' ? QUICK_YT : QUICK_DM;
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
    el.sources.querySelectorAll('[data-site]').forEach(tab => {
      const on = tab.getAttribute('data-site') === state.site;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
  }

  function setSite(site, run) {
    state.site = site === 'youtube' ? 'youtube' : 'dailymotion';
    store(SITE_KEY, state.site);
    renderTabs();
    renderChips();
    updateNote();
    if (run && state.query) runSearch(state.query);
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
    el.source.href = item.url;
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
    } else {
      el.video.hidden = false;
      el.video.src = url;
      if (el.frame) el.frame.hidden = true;
      const played = el.video.play();
      if (played && typeof played.catch === 'function') played.catch(() => { /* يمنع المتصفح التشغيل التلقائي */ });
    }
  }

  async function play(item) {
    if (!item) return;
    openDialog(item);
    /* يوتيوب لا يحتاج استخراجاً: مشغّله الرسمي يعمل داخل iframe */
    if (item.site === 'youtube') {
      state.direct.set(item.id, item.url);
      ready(item.url, 'يُشغَّل يوتيوب بمشغّله الرسمي — لا حاجة لاستخراج رابط مباشر.');
      return;
    }
    const cached = state.direct.get(item.id);
    if (cached) { ready(cached, 'الرابط المباشر مؤقّت (توقيع من ديليموشن) — صالح للتشغيل الآن فقط.'); return; }
    try {
      if (!window.WTResolve) throw new Error('خدمة الاستخراج غير متاحة في هذه النسخة');
      const media = await window.WTResolve(item.url);
      const src = media && media.parsed && media.parsed.src;
      if (!src) throw new Error('لم يرجع السيرفر رابط تشغيل');
      state.direct.set(item.id, src);
      ready(src, 'الرابط المباشر مؤقّت (توقيع من ديليموشن) — صالح للتشغيل الآن فقط.');
    } catch (error) {
      showError(error && error.message ? error.message : 'تعذّر استخراج رابط التشغيل');
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
    const card = event.target.closest('[data-index]');
    if (!card) return;
    const item = state.items[Number(card.getAttribute('data-index'))];
    if (!item || state.busyId) return;
    state.busyId = item.id;
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
  if (savedSite === 'youtube' || savedSite === 'dailymotion') state.site = savedSite;
  renderTabs();
  renderChips();

  const params = new URLSearchParams(location.search);
  if (params.get('site')) { const s = params.get('site'); if (s === 'youtube' || s === 'dailymotion') state.site = s; }
  renderTabs();
  const initial = params.get('q');
  if (initial) {
    el.input.value = initial;
    el.clear.hidden = false;
    runSearch(initial);
  }
})();

/* =========================================================
   WatchTogether — صفحة البحث في ديليموشن (search.js)
   ---------------------------------------------------------
   • البحث: من سيرفر Java (/api/search) إن كان يعمل، وإلا
     مباشرة من واجهة ديليموشن العامة (بدون مفتاح).
   • التشغيل: عند الضغط على نتيجة يستدعي WTResolve() الذي
     يمرّر الرابط إلى /api/resolve — هناك يعمل yt-dlp على
     السيرفر ويرجع رابط تشغيل مباشر (ملف mp4 موحّد).
   • ثم: تشغيل فوري + إمكانية فتح غرفة مشاهدة جماعية.
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
    chips: $('searchChips'), status: $('searchStatus'), note: $('serverNote'),
    results: $('results'), empty: $('empty'), emptyText: $('emptyText'),
    dialog: $('playDialog'), dTitle: $('playTitle'), dClose: $('playClose'),
    stage: $('playStage'), spinner: $('playSpinner'), spinnerText: $('playSpinnerText'),
    video: $('playVideo'), error: $('playError'),
    room: $('playRoom'), copy: $('playCopy'), source: $('playSource'), hint: $('playHint')
  };

  const QUICK = ['وثائقيات', 'موسيقى', 'طبخ', 'رياضة', 'تقنية', 'أفلام قصيرة'];
  const RECENT_KEY = 'search:recent';
  const LIMIT = 18;

  const state = {
    query: '',
    items: [],
    loading: false,
    server: null,          /* null = لم يُختبر بعد · true = سيرفر Java يعمل · false = استضافة ثابتة */
    direct: new Map(),     /* معرّف الفيديو ← رابط التشغيل المباشر */
    current: null,
    busyId: null
  };

  /* ============================== 1) أدوات ============================== */

  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem('wt:' + RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter(v => typeof v === 'string').slice(0, 6) : [];
    } catch (e) { return []; }
  }

  function writeRecent(list) {
    try { localStorage.setItem('wt:' + RECENT_KEY, JSON.stringify(list.slice(0, 6))); } catch (e) { /* التخزين محجوب */ }
  }

  function pushRecent(term) {
    const clean = String(term || '').trim();
    if (clean.length < 2) return;
    const next = [clean].concat(readRecent().filter(v => v !== clean)).slice(0, 6);
    writeRecent(next);
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
        '<div class="result-card__body">' +
        '<div class="sk-line"></div><div class="sk-line sk-line--short"></div>' +
        '</div></div>';
    }
    el.results.innerHTML = html;
    el.results.setAttribute('aria-busy', 'true');
  }

  function duration(sec) {
    const n = Number(sec) || 0;
    return n > 0 ? U.fmtTime(n) : '';
  }

  /* ============================== 2) مصدر النتائج ============================== */

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!/^[a-zA-Z0-9]{1,32}$/.test(id)) return null;
    const url = String(raw.url || '').trim() || ('https://www.dailymotion.com/video/' + id);
    let thumb = String(raw.thumb || '').trim();
    const title = String(raw.title || '').trim();
    let author = String(raw.author || raw.owner || '').trim();
    if (/^https:\/\/(www\.)?dailymotion\.com\/video\//i.test(url) && !thumb) {
      thumb = 'https://www.dailymotion.com/thumbnail/video/' + id;
    }
    if (author === 'undefined' || author === 'null') author = '';
    return {
      id: id,
      title: title || 'بدون عنوان',
      url: url,
      thumb: thumb,
      duration: Number(raw.duration) || 0,
      author: author
    };
  }

  /** المحاولة الأولى: سيرفر Java (yt-dlp أو واجهة ديليموشن عبر السيرفر) */
  async function fromServer(term, limit) {
    const url = 'api/search?q=' + encodeURIComponent(term) + '&limit=' + limit;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!response.ok) {
      if (data && data.error) throw new Error(data.error);
      return null;                                  /* ليست نقطة خدمة — نجرّب المباشر */
    }
    if (!data || !Array.isArray(data.items)) return null;
    const items = data.items.map(normalize).filter(Boolean);
    return { items: items, source: data.source || 'server' };
  }

  /** المحاولة الثانية (استضافة ثابتة): واجهة ديليموشن العامة من المتصفح */
  async function fromDailymotion(term, limit) {
    const url = 'https://api.dailymotion.com/videos?search=' + encodeURIComponent(term) +
      '&limit=' + limit + '&sort=relevance&fields=id,title,thumbnail_720_url,duration';
    const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error('تعذّر الاتصال بديليموشن (HTTP ' + response.status + ')');
    const data = await response.json();
    const list = data && Array.isArray(data.list) ? data.list : [];
    return { items: list.map(normalize).filter(Boolean), source: 'dailymotion' };
  }

  async function runSearch(term) {
    if (state.loading) return;
    const query = String(term || '').trim();
    if (query.length < 2) { status('اكتب كلمتين على الأقل للبحث', true); el.input.focus(); return; }
    state.loading = true;
    state.query = query;
    el.go.disabled = true;
    skeleton(8);
    el.empty.hidden = true;
    status('جارٍ البحث عن «' + query + '»…');
    try {
      let result = null;
      try {
        result = await fromServer(query, LIMIT);
        state.server = result !== null;
      } catch (error) {
        state.server = null;
        throw error;                                  /* خطأ صريح من السيرفر (429/400…) */
      }
      if (!result) {
        state.server = false;
        result = await fromDailymotion(query, LIMIT);
      }
      state.items = result.items;
      el.note.hidden = state.server !== false;
      if (!state.items.length) {
        el.results.innerHTML = '';
        el.results.setAttribute('aria-busy', 'false');
        el.empty.hidden = false;
        el.emptyText.textContent = 'لا نتائج لـ «' + query + '» — جرّب كلمة أخرى';
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
      el.results.innerHTML = '';
      el.results.setAttribute('aria-busy', 'false');
      el.empty.hidden = false;
      el.emptyText.textContent = 'تعذّر البحث — تحقّق من الاتصال ثم أعد المحاولة';
      status(error && error.message ? error.message : 'تعذّر البحث', true);
    } finally {
      state.loading = false;
      el.go.disabled = false;
    }
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
    const recent = readRecent();
    const terms = recent.concat(QUICK.filter(v => recent.indexOf(v) < 0)).slice(0, 8);
    el.chips.innerHTML = terms.map(term => {
      const isRecent = recent.indexOf(term) >= 0;
      return '<button class="chip' + (term === state.query ? ' is-active' : '') + '" type="button" data-term="' + U.esc(term) + '">' +
        '<span>' + U.esc(term) + '</span>' +
        (isRecent ? '<span class="chip__x" data-remove="' + U.esc(term) + '" role="button" tabindex="0" aria-label="حذف من الأخيرة">×</span>' : '') +
        '</button>';
    }).join('');
  }

  /* ============================== 4) التشغيل ============================== */

  function openDialog(item) {
    state.current = item;
    el.dTitle.textContent = item.title;
    el.error.hidden = true;
    el.video.hidden = true;
    el.video.removeAttribute('src');
    el.video.poster = item.thumb || '';
    el.spinner.hidden = false;
    el.spinnerText.textContent = 'جارٍ استخراج رابط التشغيل المباشر…';
    el.room.disabled = true;
    el.copy.disabled = true;
    el.source.href = item.url;
    el.hint.hidden = true;
    if (typeof el.dialog.showModal === 'function') el.dialog.showModal();
    else el.dialog.setAttribute('open', '');
  }

  function showError(message) {
    el.spinner.hidden = true;
    el.video.hidden = true;
    el.error.hidden = false;
    el.error.textContent = message;
    el.hint.hidden = false;
    el.hint.textContent = state.server === false
      ? 'شغّل الموقع من سيرفر Java (run.bat) لتفعيل استخراج الروابط عبر yt-dlp.'
      : 'يمكنك فتح الفيديو على ديليموشن مباشرة من الزر بالأسفل.';
  }

  async function play(item) {
    if (!item) return;
    openDialog(item);
    const cached = state.direct.get(item.id);
    if (cached) { showVideo(cached); return; }
    try {
      if (!window.WTResolve) throw new Error('خدمة الاستخراج غير متاحة في هذه النسخة');
      const media = await window.WTResolve(item.url);
      const src = media && media.parsed && media.parsed.src;
      if (!src) throw new Error('لم يرجع السيرفر رابط تشغيل');
      state.direct.set(item.id, src);
      showVideo(src);
    } catch (error) {
      showError(error && error.message ? error.message : 'تعذّر استخراج رابط التشغيل');
    }
  }

  function showVideo(src) {
    el.spinner.hidden = true;
    el.error.hidden = true;
    el.video.hidden = false;
    el.video.src = src;
    el.room.disabled = false;
    el.copy.disabled = false;
    el.hint.hidden = false;
    el.hint.textContent = 'الرابط المباشر مؤقّت (توقيع من ديليموشن) — صالح للتشغيل الآن فقط.';
    const played = el.video.play();
    if (played && typeof played.catch === 'function') played.catch(() => { /* المتصفح يمنع التشغيل التلقائي */ });
  }

  async function copyLink() {
    const item = state.current;
    if (!item) return;
    const src = state.direct.get(item.id) || '';
    if (!src) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(src);
      else throw new Error('no-clipboard');
      U.toast('نُسخ رابط التشغيل المباشر', 'success', 2000);
    } catch (e) {
      const box = document.createElement('textarea');
      box.value = src;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(box);
      box.select();
      try { document.execCommand('copy'); U.toast('نُسخ رابط التشغيل المباشر', 'success', 2000); }
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
    const item = state.current;
    const src = item && state.direct.get(item.id);
    if (!item || !src) return;
    const user = account();
    if (!user) {
      const next = location.pathname + location.search;
      location.replace('auth.html?next=' + encodeURIComponent(next || 'search.html'));
      return;
    }
    el.room.disabled = true;
    const label = el.room.innerHTML;
    el.room.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> جارٍ إنشاء الغرفة…';
    try {
      const room = await Rooms.create({
        title: item.title.slice(0, 40),
        videoUrl: src,
        hostName: user.name || user.email || ''
      });
      location.href = Rooms.href(room);
    } catch (error) {
      el.room.disabled = false;
      el.room.innerHTML = label;
      U.toast(error && error.message ? error.message : 'تعذّر إنشاء الغرفة', 'error', 2600);
    }
  }

  /* ============================== 5) الأحداث ============================== */

  el.form.addEventListener('submit', event => {
    event.preventDefault();
    runSearch(el.input.value);
  });

  el.input.addEventListener('input', () => {
    el.clear.hidden = !el.input.value;
  });

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

  el.chips.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const term = remove.getAttribute('data-remove');
      writeRecent(readRecent().filter(v => v !== term));
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
  });

  el.video.addEventListener('error', () => {
    if (!el.video.hidden && el.video.src) {
      showError('تعذّر تشغيل الرابط المباشر في هذا المتصفح — قد يكون منتهي الصلاحية أو محجوباً');
    }
  });

  el.copy.addEventListener('click', copyLink);
  el.room.addEventListener('click', createRoom);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el.dialog.open) {
      event.preventDefault();
      el.dClose.click();
    }
  });

  /* ============================== 6) البداية ============================== */

  renderChips();
  const params = new URLSearchParams(location.search);
  const initial = params.get('q');
  if (initial) {
    el.input.value = initial;
    el.clear.hidden = false;
    runSearch(initial);
  }
})();

/* =========================================================
   WatchTogether — طبقة الموقع المشتركة (site.js)
   تعمل على كل الصفحات: لوحة أوامر (Ctrl/⌘ + K) · مركز تحكم
   · اختصارات · مؤشر اتصال · شريط تقدّم · زر صعود · تثبيت التطبيق
   · خدمة عمل دون اتصال (PWA) — دون أي مكتبة خارجية.
   التزام: Midnight Gold + خط Cairo · RTL · وصولية كاملة.
   ========================================================= */
(function (global) {
  'use strict';

  if (global.WTSite) return;

  var doc = global.document;
  var VERSION = '1.0.0';
  var PREFS_KEY = 'prefs';
  var RECENT_KEY = 'command-recent';
  var MAX_RECENT = 4;
  var PAGES = {
    index: { title: 'الغرف', file: 'index.html' },
    room: { title: 'الغرفة', file: 'room.html' },
    profile: { title: 'الملف الشخصي', file: 'profile.html' },
    friends: { title: 'الأصدقاء', file: 'friends.html' },
    messages: { title: 'الرسائل الخاصة', file: 'messages.html' },
    auth: { title: 'الحساب', file: 'auth.html' }
  };
  var ACCENTS = [
    { id: 'gold', name: 'ذهبي', c1: '#C5A572', c2: '#E8DCC6' },
    { id: 'mint', name: 'نعناعي', c1: '#7FC0A0', c2: '#CDEBDD' },
    { id: 'rose', name: 'وردي', c1: '#E099A6', c2: '#F3D2D8' },
    { id: 'azure', name: 'سماوي', c1: '#86B4E0', c2: '#CFE4F7' }
  ];
  var DEFAULT_PREFS = { accent: 'gold', motion: 'auto', contrast: 'normal', compact: false };

  /* ============================== 1) أدوات عامة (بلا DOM) ============================== */
  function safeParse(value, fallback) {
    try { var out = JSON.parse(value); return out == null ? fallback : out; }
    catch (e) { return fallback; }
  }

  function readPrefs() {
    var raw = {};
    try { raw = safeParse(global.localStorage.getItem('wt:' + PREFS_KEY), {}); } catch (e) { raw = {}; }
    if (!raw || typeof raw !== 'object') raw = {};
    var prefs = {
      accent: ACCENTS.some(function (a) { return a.id === raw.accent; }) ? raw.accent : DEFAULT_PREFS.accent,
      motion: raw.motion === 'reduce' || raw.motion === 'full' ? raw.motion : 'auto',
      contrast: raw.contrast === 'high' ? 'high' : 'normal',
      compact: !!raw.compact
    };
    return prefs;
  }

  function writePrefs(prefs) {
    try { global.localStorage.setItem('wt:' + PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* التخزين محجوب */ }
  }

  function systemReducedMotion() {
    try { return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function effectiveMotion(prefs) {
    if (prefs.motion === 'reduce') return 'reduce';
    if (prefs.motion === 'full') return 'full';
    return systemReducedMotion() ? 'reduce' : 'full';
  }

  function applyPrefs(prefs) {
    if (!doc || !doc.documentElement) return;
    var root = doc.documentElement;
    if (prefs.accent && prefs.accent !== 'gold') root.setAttribute('data-wt-accent', prefs.accent);
    else root.removeAttribute('data-wt-accent');
    root.setAttribute('data-wt-motion', effectiveMotion(prefs));
    if (prefs.contrast === 'high') root.setAttribute('data-wt-contrast', 'high');
    else root.removeAttribute('data-wt-contrast');
    if (prefs.compact) root.setAttribute('data-wt-compact', '1');
    else root.removeAttribute('data-wt-compact');
  }

  /* تطبيع عربي: يوحّد الهمزات والتاء المربوطة والياء ويحذف التشكيل */
  function normalize(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
      .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .replace(/\u0629/g, '\u0647')
      .replace(/[^\u0621-\u064Aa-z0-9@]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** ترتيب نتائج البحث: العنوان أولاً، ثم الوصف والكلمات المفتاحية */
  function score(item, query) {
    var q = normalize(query);
    if (!q) return 1;
    var title = normalize(item && item.title);
    var sub = normalize((item && item.sub) + ' ' + (item && item.keywords));
    var points = 0;
    if (title === q) points = 14;
    else if (title.indexOf(q) === 0) points = 11;
    else if (title.indexOf(q) > 0) points = 8;
    else if (title.split(' ').some(function (word) { return word.indexOf(q) === 0; })) points = 7;
    else if (sub.indexOf(q) >= 0) points = 4;
    else {
      var tokens = q.split(' ').filter(Boolean);
      if (tokens.length > 1 && tokens.every(function (token) {
        return title.indexOf(token) >= 0 || sub.indexOf(token) >= 0;
      })) points = 5;
    }
    return points;
  }

  function rank(items, query, limit) {
    var list = (items || []).slice();
    var q = String(query == null ? '' : query).trim();
    if (!q) return list.slice(0, limit || list.length);
    return list
      .map(function (item, index) { return { item: item, index: index, points: score(item, q) }; })
      .filter(function (entry) { return entry.points > 0; })
      .sort(function (a, b) { return b.points - a.points || a.index - b.index; })
      .slice(0, limit || list.length)
      .map(function (entry) { return entry.item; });
  }

  /** هل النص يشبه كود غرفة (4–10 أحرف/أرقام)؟ */
  function looksLikeRoomCode(value) {
    var code = String(value || '').trim();
    return /^[A-Za-z0-9]{4,10}$/.test(code) && /[A-Za-z]/.test(code) && /\d/.test(code);
  }

  /* ============================== 2) حالة الطبقة ============================== */
  var state = {
    prefs: readPrefs(),
    mounted: false,
    deferredInstall: null,
    leader: false,
    leaderTimer: 0,
    lastErrorAt: 0,
    activeIndex: 0,
    results: [],
    returnFocus: null,
    netBackTimer: 0
  };
  var ui = {};

  function U() { return global.WTUtil; }
  function IC() { return global.WTIcons; }
  function $(id) { return doc ? doc.getElementById(id) : null; }
  function esc(value) {
    var util = U();
    if (util && util.esc) return util.esc(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function icon(name, size) {
    var icons = IC();
    return icons && icons.html ? icons.html(name, size || 18) : '<span aria-hidden="true"></span>';
  }
  function toast(message, type, ms) {
    var util = U();
    if (util && util.toast) { util.toast(message, type, ms); return; }
    try { console.log('[WatchTogether]', message); } catch (e) { /* تجاهل */ }
  }
  function currentPage() {
    var file = (global.location && global.location.pathname || '').split('/').pop() || 'index.html';
    var key = file.replace(/\.html?$/i, '');
    return PAGES[key] ? key : null;
  }

  /* ============================== 3) عناصر الواجهة ============================== */
  function focusEl(el, preventScroll) {
    if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
    try { el.focus({ preventScroll: preventScroll !== false }); return true; }
    catch (e) {
      try { el.focus(); return true; } catch (err) { return false; }
    }
  }

  function node(tag, className, html) {
    var el = doc.createElement(tag);
    if (className) el.className = className;
    if (html != null) el.innerHTML = html;
    return el;
  }

  function buildPalette() {
    var layer = node('div', 'wt-layer');
    layer.id = 'wtPaletteLayer';
    layer.hidden = true;
    layer.innerHTML =
      '<div class="wt-palette" role="dialog" aria-modal="true" aria-labelledby="wtPaletteTitle" aria-describedby="wtPaletteHelp">' +
        '<div class="wt-palette__head">' +
          '<span class="wt-palette__ic" aria-hidden="true">' + icon('search', 21) + '</span>' +
          '<h2 class="sr-only" id="wtPaletteTitle">لوحة الأوامر</h2>' +
          '<input class="wt-palette__input" id="wtPaletteInput" type="text" role="combobox" autocomplete="off" spellcheck="false" ' +
            'aria-expanded="true" aria-controls="wtPaletteList" aria-autocomplete="list" placeholder="ابحث عن صفحة، غرفة، أو أمر…">' +
          '<kbd class="wt-palette__hint">Esc</kbd>' +
        '</div>' +
        '<div class="wt-palette__body">' +
          '<p class="wt-palette__group" id="wtPaletteGroup">الأوامر</p>' +
          '<ul class="wt-palette__list" id="wtPaletteList" role="listbox" aria-labelledby="wtPaletteTitle"></ul>' +
          '<div class="wt-palette__empty" id="wtPaletteEmpty" hidden><strong>لا شيء بهذا الاسم</strong>جرّب اسم صفحة (الأصدقاء)، أو كود غرفة، أو أمراً (مشاركة).</div>' +
        '</div>' +
        '<div class="wt-palette__foot" id="wtPaletteHelp">' +
          '<span><kbd class="wt-kbd">↑</kbd><kbd class="wt-kbd">↓</kbd> تنقّل · <kbd class="wt-kbd">↵</kbd> تشغيل</span>' +
          '<span class="wt-palette__brand">WatchTogether</span>' +
        '</div>' +
      '</div>';
    doc.body.appendChild(layer);
    return layer;
  }

  function buildSheet() {
    var layer = node('div', 'wt-layer');
    layer.id = 'wtSheetLayer';
    layer.hidden = true;
    layer.innerHTML = '<div class="wt-sheet" role="dialog" aria-modal="true" aria-labelledby="wtSheetTitle"></div>';
    doc.body.appendChild(layer);
    return layer;
  }

  function buildNet() {
    var pill = node('div', 'wt-net');
    pill.id = 'wtNet';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.innerHTML = '<span class="wt-net__dot" aria-hidden="true"></span><span id="wtNetText">أنت غير متصل — ستُستأنف المزامنة تلقائياً</span>';
    doc.body.appendChild(pill);
    return pill;
  }

  function buildProgress() {
    var bar = node('div', 'wt-progress');
    bar.id = 'wtProgress';
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = '<span class="wt-progress__bar" id="wtProgressBar"></span>';
    doc.body.appendChild(bar);
    return bar;
  }

  function buildTop() {
    var button = node('button', 'wt-top');
    button.id = 'wtTop';
    button.type = 'button';
    button.setAttribute('aria-label', 'العودة إلى أعلى الصفحة');
    button.title = 'إلى الأعلى';
    button.innerHTML = icon('chevronUp', 19);
    doc.body.appendChild(button);
    return button;
  }

  function injectSkipLink() {
    if (doc.querySelector('.s-skip, .skip-link, [data-wt-skip]')) return;
    var target = doc.querySelector('main, [role="main"]');
    if (!target) return;
    if (!target.id) target.id = 'wtMainContent';
    var link = node('a', 'wt-skip', 'تخطّ إلى المحتوى');
    link.href = '#' + target.id;
    link.setAttribute('data-wt-skip', '');
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    doc.body.insertBefore(link, doc.body.firstChild);
  }

  /* ============================== 4) الأوامر ============================== */
  function go(href) {
    if (!href) return;
    if (global.location && global.location.href.indexOf(href) === global.location.href.length - href.length) return;
    global.location.href = href;
  }

  /** ينفّذ إجراءً على عنصر: معرّف، أو محدّد CSS، أو تركيز حقل */
  function click(target, mode) {
    var el = null;
    if (target && target.charAt(0) === '#' && target.indexOf(' ') < 0) el = $(target.slice(1));
    else if (target && /^[\[.#]/.test(target)) el = doc.querySelector(target);
    else el = $(target);
    if (!el) { toast('هذا الإجراء غير متاح في هذه الصفحة', 'warn'); return; }
    if (mode === 'focus') {
      focusEl(el, false);
      try { el.select(); } catch (e) { /* ليس حقلاً نصياً */ }
      return;
    }
    if (el.disabled) { toast('هذا الإجراء غير متاح الآن', 'warn'); return; }
    el.click();
  }

  function navCommands() {
    var page = currentPage();
    var list = [
      { id: 'nav-rooms', group: 'التنقّل', title: 'الغرف', sub: 'الصفحة الرئيسية — غرف المشاهدة', icon: 'home', keys: ['G', 'H'], keywords: 'رئيسية lobby rooms', run: function () { go('index.html'); } },
      { id: 'nav-profile', group: 'التنقّل', title: 'ملفي الشخصي', sub: 'بياناتك وذوقك وخصوصيتك', icon: 'user', keys: ['G', 'P'], keywords: 'حساب بروفايل', run: function () { go('profile.html'); } },
      { id: 'nav-friends', group: 'التنقّل', title: 'الأصدقاء', sub: 'ابحث عن رفاق مشاهدة', icon: 'users', keys: ['G', 'F'], keywords: 'صداقة بحث', run: function () { go('friends.html'); } },
      { id: 'nav-messages', group: 'التنقّل', title: 'الرسائل الخاصة', sub: 'محادثاتك مع الأصدقاء', icon: 'chat', keys: ['G', 'M'], keywords: 'دردشة محادثة', run: function () { go('messages.html'); } },
      { id: 'nav-auth', group: 'التنقّل', title: 'تسجيل الدخول أو إنشاء حساب', sub: 'صفحة الحساب', icon: 'login', keywords: 'دخول تسجيل حساب auth', run: function () { go('auth.html'); } }
    ];
    return list.filter(function (item) {
      if (!page) return true;
      if (item.id === 'nav-rooms' && page === 'index') return false;
      if (item.id === 'nav-profile' && page === 'profile') return false;
      if (item.id === 'nav-friends' && page === 'friends') return false;
      if (item.id === 'nav-messages' && page === 'messages') return false;
      if (item.id === 'nav-auth' && page === 'auth') return false;
      return true;
    });
  }

  function pageActions() {
    var page = currentPage();
    var list = [];
    function exists(target) {
      try {
        if (target.charAt(0) === '#' && target.indexOf(' ') < 0) return !!$(target.slice(1));
        if (/^[\[.#]/.test(target)) return !!doc.querySelector(target);
        return !!$(target);
      } catch (e) { return false; }
    }
    function add(id, title, sub, iconName, target, keywords, danger, mode) {
      if (!exists(target)) return;
      list.push({
        id: id, group: PAGES[page] ? PAGES[page].title : 'هذه الصفحة', title: title, sub: sub,
        icon: iconName, keywords: keywords, danger: !!danger,
        run: function () { click(target, mode); }
      });
    }
    function addAlways(id, title, sub, iconName, target, keywords, fallback) {
      list.push({
        id: id, group: PAGES[page] ? PAGES[page].title : 'هذه الصفحة', title: title, sub: sub,
        icon: iconName, keywords: keywords, danger: false,
        run: function () {
          if (exists(target)) { click(target); return; }
          if (typeof fallback === 'function') fallback();
        }
      });
    }
    if (page === 'index') {
      add('act-new-room', 'إضافة غرفة جديدة', 'افتح نموذج الإنشاء', 'plus', 'createToggle', 'انشاء غرفة جديدة add');
      add('act-refresh-rooms', 'تحديث قائمة الغرف', 'اسحب أحدث الغرف من الخادم', 'sync', 'refreshRooms', 'تحديث تحديثات');
    }
    if (page === 'room') {
      add('act-copy-room', 'نسخ رابط الغرفة', 'شارك الدعوة مع من تحب', 'link', 'copyLinkBtn', 'نسخ رابط دعوة مشاركة');
      add('act-qr', 'رمز QR للغرفة', 'امسحه بالهاتف للانضمام', 'qr', 'qrBtn', 'qr رمز مسح');
      add('act-playlist', 'قائمة التشغيل', 'ما سيُشاهد بعد ذلك', 'playlist', 'playlistBtn', 'قائمة فيديوهات queue');
      add('act-people', 'المشاركون والإعدادات', 'افتح قائمة الغرفة', 'users', 'drawerOpenBtn', 'مشاركون اعضاء قائمة');
      add('act-diag', 'تشخيص الاتصال', 'اعرف سبب أي انقطاع', 'server', 'diagBtn', 'شبكة اتصال مشكلة');
      add('act-leave-room', 'مغادرة الغرفة', 'إنهاء الجلسة لهذا الحساب', 'logout', 'leaveBtn', 'خروج مغادرة', true);
    }
    if (page === 'friends') {
      add('act-friend-search', 'بحث عن صديق', 'انتقل إلى حقل البحث', 'search', '#friendQuery', 'بحث اسم معرف', false, 'focus');
      add('act-friend-incoming', 'طلبات الصداقة الواردة', 'اقبل أو ارفض الطلبات', 'userPlus', 'friend-tab-incoming', 'طلبات صداقة واردة');
      add('act-friend-friends', 'قائمة أصدقائي', 'كل الصداقات المقبولة', 'users', 'friend-tab-friends', 'اصدقاء قائمة');
      add('act-friend-blocked', 'المحظورون', 'من أوقفت التعامل معه', 'block', 'friend-tab-blocked', 'حظر محظورون');
    }
    if (page === 'messages') {
      add('act-new-chat', 'محادثة جديدة', 'ابدأ حديثاً مع صديق', 'pencil', 'newChat', 'محادثة جديدة رسالة');
      add('act-chat-invite', 'دعوة إلى غرفة', 'أرسل دعوة مشاهدة في المحادثة', 'film', 'chatInvite', 'دعوة غرفة مشاهدة');
      add('act-messages-search', 'البحث في المحادثات', 'فلترة القائمة المحمّلة', 'search', '#threadQuery', 'بحث محادثات', false, 'focus');
    }
    if (page === 'profile') {
      addAlways('act-profile-edit', 'تعديل الملف', 'الاسم والنبذة والصور', 'pencil', '[data-profile-action="edit"]', 'تعديل ملف', function () { go('profile.html?edit=details'); });
      addAlways('act-profile-share', 'مشاركة ملفي', 'شارك صفحتك مع صديق', 'share', '[data-profile-action="share"]', 'مشاركة ملف', sharePage);
    }
    if (page === 'auth') {
      add('act-auth-login', 'التبويب: تسجيل الدخول', 'الدخول إلى حسابك', 'login', 'tabLogin', 'دخول');
      add('act-auth-signup', 'التبويب: إنشاء حساب', 'حساب جديد ببريد وكلمة مرور', 'userPlus', 'tabSignup', 'انشاء حساب تسجيل');
    }
    return list;
  }

  function roomCommands() {
    var host = $('roomsList');
    if (!host) return [];
    var rooms = host.querySelectorAll('.room-tile');
    var list = [];
    Array.prototype.forEach.call(rooms, function (tile) {
      if (list.length >= 8) return;
      var link = tile.querySelector('.room-tile__link');
      var titleEl = tile.querySelector('.room-tile__title');
      var href = link && link.getAttribute('href');
      if (!href || href === '#' || href.indexOf('room.html') < 0) return;
      var title = (titleEl && titleEl.textContent || '').trim() || 'غرفة';
      list.push({
        id: 'room-' + href,
        group: 'غرف مفتوحة',
        title: 'الانضمام إلى: ' + title,
        sub: 'دخول مباشر إلى الغرفة',
        icon: 'film',
        keywords: 'غرفة مشاهدة join',
        run: function () { go(href); }
      });
    });
    return list;
  }

  function systemCommands() {
    var list = [
      { id: 'sys-settings', group: 'النظام', title: 'مركز التحكم', sub: 'الألوان والحركة والتباين', icon: 'sliders', keys: ['Alt', 'S'], keywords: 'اعدادات تفضيلات مظهر الوضع', run: openSettings },
      { id: 'sys-share', group: 'النظام', title: 'مشاركة هذه الصفحة', sub: 'نسخ الرابط أو مشاركته', icon: 'share', keywords: 'مشاركة نسخ رابط', run: sharePage },
      { id: 'sys-help', group: 'النظام', title: 'اختصارات لوحة المفاتيح', sub: 'تنقّل أسرع بلا فأرة', icon: 'keyboard', keys: ['?'], keywords: 'اختصارات مفاتيح مساعدة', run: openHelp }
    ];
    if (state.deferredInstall) {
      list.push({ id: 'sys-install', group: 'النظام', title: 'تثبيت التطبيق', sub: 'افتح WatchTogether كتطبيق مستقل', icon: 'download', keywords: 'تثبيت تطبيق pwa', run: promptInstall });
    }
    return list;
  }

  function recentCommands() {
    var ids = [];
    try { ids = safeParse(global.localStorage.getItem('wt:' + RECENT_KEY), []); } catch (e) { ids = []; }
    if (!Array.isArray(ids) || !ids.length) return [];
    var pool = navigationPool();
    var found = [];
    ids.forEach(function (id) {
      var match = pool.filter(function (item) { return item.id === id; })[0];
      if (match && found.indexOf(match) < 0) found.push(match);
    });
    return found.slice(0, MAX_RECENT).map(function (item) {
      return Object.assign({}, item, { group: 'الأخيرة', id: 'recent-' + item.id, sub: item.sub });
    });
  }

  function navigationPool() {
    return navCommands().concat(pageActions(), systemCommands(), roomCommands());
  }

  function allCommands() {
    var recent = recentCommands();
    var pool = navigationPool();
    if (!recent.length) return pool;
    var recentIds = recent.map(function (item) { return String(item.id).replace(/^recent-/, ''); });
    return recent.concat(pool.filter(function (item) { return recentIds.indexOf(item.id) < 0; }));
  }

  function rememberCommand(id) {
    if (!id || id.indexOf('recent-') === 0) return;
    var ids = [];
    try { ids = safeParse(global.localStorage.getItem('wt:' + RECENT_KEY), []); } catch (e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    ids = [id].concat(ids.filter(function (value) { return value !== id; })).slice(0, MAX_RECENT);
    try { global.localStorage.setItem('wt:' + RECENT_KEY, JSON.stringify(ids)); } catch (e) { /* تجاهل */ }
  }

  function extraQuickCommands(query) {
    var text = String(query || '').trim();
    var code = text.replace(/\s+/g, '');
    if (!looksLikeRoomCode(code)) return [];
    return [{
      id: 'join-code',
      group: 'دخول سريع',
      title: 'الدخول إلى الغرفة «' + code.toUpperCase() + '»',
      sub: 'كود غرفة — اضغط Enter',
      icon: 'login',
      keywords: 'كود غرفة دخول',
      run: function () { go('room.html?id=' + encodeURIComponent(code.toUpperCase())); }
    }];
  }

  /* ============================== 5) لوحة الأوامر ============================== */
  function openPalette(initialQuery) {
    if (!state.mounted) return;
    if (ui.sheetLayer && !ui.sheetLayer.hidden) closeSheet();
    if (ui.helpLayer && !ui.helpLayer.hidden) closeHelp();
    state.returnFocus = doc.activeElement;
    ui.paletteLayer.hidden = false;
    ui.paletteInput.value = initialQuery || '';
    state.activeIndex = 0;
    renderResults();
    focusEl(ui.paletteInput);
    try { ui.paletteInput.select(); } catch (e) { /* ignore */ }
  }

  function closePalette(restoreFocus) {
    if (!ui.paletteLayer || ui.paletteLayer.hidden) return;
    ui.paletteLayer.hidden = true;
    ui.paletteInput.value = '';
    state.results = [];
    ui.list.innerHTML = '';
    var target = restoreFocus === false ? null : state.returnFocus;
    state.returnFocus = null;
    focusEl(target);
  }

  function renderResults() {
    var query = ui.paletteInput.value;
    var pool = allCommands().concat(extraQuickCommands(query));
    var results = rank(pool, query, query ? 24 : 40);
    state.results = results;
    state.activeIndex = results.length ? Math.min(state.activeIndex, results.length - 1) : -1;
    ui.list.innerHTML = '';
    ui.empty.hidden = results.length > 0;
    ui.list.hidden = !results.length;
    var lastGroup = '';
    results.forEach(function (item, index) {
      if (item.group && item.group !== lastGroup) {
        lastGroup = item.group;
        var group = node('li', 'wt-palette__group');
        group.setAttribute('role', 'presentation');
        group.textContent = item.group;
        ui.list.appendChild(group);
      }
      var li = node('li');
      li.setAttribute('role', 'presentation');
      var button = node('button', 'wt-cmd' + (item.danger ? ' is-danger' : ''));
      button.type = 'button';
      button.id = 'wtCmd' + index;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === state.activeIndex));
      var keys = (item.keys || []).map(function (key) { return '<kbd class="wt-kbd">' + esc(key) + '</kbd>'; }).join('');
      button.innerHTML =
        '<span class="wt-cmd__icon" aria-hidden="true">' + icon(item.icon || 'sparkle', 18) + '</span>' +
        '<span class="wt-cmd__text"><span class="wt-cmd__title">' + esc(item.title) + '</span>' +
        (item.sub ? '<span class="wt-cmd__sub">' + esc(item.sub) + '</span>' : '') + '</span>' +
        (keys ? '<span class="wt-cmd__keys">' + keys + '</span>' : '');
      if (index === state.activeIndex) button.classList.add('is-active');
      button.addEventListener('click', function () { runCommand(index); });
      button.addEventListener('mousemove', function () { setActive(index, false); });
      li.appendChild(button);
      ui.list.appendChild(li);
    });
    syncActiveDescendant();
  }

  function scrollIntoViewSafe(node) {
    try { if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' }); }
    catch (e) { /* متصفح قديم */ }
  }

  function syncActiveDescendant() {
    var active = state.activeIndex >= 0 ? $('wtCmd' + state.activeIndex) : null;
    if (active) {
      ui.paletteInput.setAttribute('aria-activedescendant', active.id);
      scrollIntoViewSafe(active);
    } else {
      ui.paletteInput.removeAttribute('aria-activedescendant');
    }
    var firstGroup = state.results[0] && state.results[0].group;
    ui.group.textContent = firstGroup || 'الأوامر';
  }

  function setActive(index, scroll) {
    if (!state.results.length) return;
    var previous = $('wtCmd' + state.activeIndex);
    if (previous) { previous.classList.remove('is-active'); previous.setAttribute('aria-selected', 'false'); }
    state.activeIndex = (index + state.results.length) % state.results.length;
    var next = $('wtCmd' + state.activeIndex);
    if (next) {
      next.classList.add('is-active');
      next.setAttribute('aria-selected', 'true');
      if (scroll !== false) scrollIntoViewSafe(next);
    }
    syncActiveDescendant();
  }

  function runCommand(index) {
    var item = state.results[index];
    if (!item) return;
    rememberCommand(item.id);
    closePalette(false);
    global.setTimeout(function () {
      try { item.run(); }
      catch (e) {
        toast('تعذّر تنفيذ الأمر — حاول مرة أخرى', 'error');
        try { console.warn('[WatchTogether] command failed', e); } catch (err) { /* تجاهل */ }
      }
    }, 40);
  }

  /* ============================== 6) مركز التحكم ============================== */
  function openSettings() {
    if (!state.mounted) return;
    var previous = doc.activeElement;
    closePalette(false);
    if (!previous || (ui.paletteLayer && ui.paletteLayer.contains(previous))) previous = doc.body;
    state.returnFocus = previous;
    renderSheet();
    ui.sheetLayer.hidden = false;
    var focusTarget = ui.sheetLayer.querySelector('.wt-sheet__body .wt-swatch[aria-pressed="true"]') ||
      ui.sheetLayer.querySelector('.wt-close');
    focusEl(focusTarget);
  }

  function closeSheet() {
    if (!ui.sheetLayer || ui.sheetLayer.hidden) return;
    ui.sheetLayer.hidden = true;
    var target = state.returnFocus;
    state.returnFocus = null;
    focusEl(target);
  }

  function swatchMarkup() {
    return ACCENTS.map(function (accent) {
      return '<button class="wt-swatch" type="button" data-wt-accent-choice="' + accent.id + '" ' +
        'style="--swatch:' + accent.c1 + ';--swatch-2:' + accent.c2 + '" aria-pressed="' + (state.prefs.accent === accent.id) + '">' +
        '<span class="wt-swatch__dot" aria-hidden="true"></span><span>' + accent.name + '</span></button>';
    }).join('');
  }

  function rowToggle(id, title, sub, pressed, action) {
    return '<div class="wt-row"><span class="wt-row__text"><span class="wt-row__title">' + title + '</span>' +
      '<span class="wt-row__sub">' + sub + '</span></span>' +
      '<button class="wt-switch" type="button" id="' + id + '" data-wt-toggle="' + action + '" ' +
      'role="switch" aria-checked="' + pressed + '" aria-label="' + title + '"></button></div>';
  }

  function renderSheet() {
    var sheet = ui.sheetLayer.querySelector('.wt-sheet');
    var isStandalone = false;
    try {
      isStandalone = (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) ||
        global.navigator.standalone === true;
    } catch (e) { isStandalone = false; }
    var canInstall = !!state.deferredInstall;
    var installHint = isStandalone ? 'التطبيق مثبّت ويعمل مستقلاً الآن.' :
      canInstall ? 'ثبّته ليفتح بلا شريط المتصفح.' : 'من قائمة المتصفح: «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».';
    var motionOn = effectiveMotion(state.prefs) === 'reduce';
    sheet.innerHTML =
      '<div class="wt-sheet__head">' +
        '<div><p class="wt-sheet__eyebrow">YOUR SPACE, YOUR WAY</p>' +
        '<h2 class="wt-sheet__title" id="wtSheetTitle">مركز التحكم</h2>' +
        '<p class="wt-sheet__sub">تفضيلات تُحفظ على هذا الجهاز فقط، وتتبعك في كل صفحات WatchTogether.</p></div>' +
        '<button class="wt-close" type="button" id="wtSheetClose" aria-label="إغلاق مركز التحكم">' + icon('x', 17) + '</button>' +
      '</div>' +
      '<div class="wt-sheet__body">' +
        '<section class="wt-group"><h3 class="wt-group__title">' + icon('sparkle', 15) + ' لون الموقع</h3>' +
          '<div class="wt-swatches">' + swatchMarkup() + '</div></section>' +
        '<section class="wt-group"><h3 class="wt-group__title">' + icon('sliders', 15) + ' الراحة والوصول</h3><div class="wt-rows">' +
          rowToggle('wtMotion', 'تقليل الحركة', 'أوقف الحركات والتدرجات البصرية', motionOn, 'motion') +
          rowToggle('wtContrast', 'تباين عالٍ', 'نص أوضح وحدود أقوى', state.prefs.contrast === 'high', 'contrast') +
          rowToggle('wtCompact', 'واجهة مضغوطة', 'مساحات أقل، محتوى أكثر على الشاشة', state.prefs.compact, 'compact') +
        '</div></section>' +
        '<section class="wt-group"><h3 class="wt-group__title">' + icon('phone', 15) + ' التطبيق</h3><div class="wt-rows">' +
          '<div class="wt-row"><span class="wt-row__text"><span class="wt-row__title">تثبيت WatchTogether</span>' +
          '<span class="wt-row__sub">' + esc(installHint) + '</span></span>' +
          (isStandalone ? '<span class="wt-muted">مثبّت</span>' :
            '<button class="wt-row__action wt-row__action--accent" type="button" id="wtInstall"' + (canInstall ? '' : ' disabled') + '>تثبيت</button>') +
          '</div>' +
          '<div class="wt-row"><span class="wt-row__text"><span class="wt-row__title">مشاركة الموقع</span>' +
          '<span class="wt-row__sub">رابط الصفحة الحالية — بلا أي مفتاح دخول</span></span>' +
          '<button class="wt-row__action" type="button" id="wtShare">مشاركة</button></div>' +
          '<div class="wt-row"><span class="wt-row__text"><span class="wt-row__title">اختصارات لوحة المفاتيح</span>' +
          '<span class="wt-row__sub">تنقّل أسرع بلا فأرة</span></span>' +
          '<button class="wt-row__action" type="button" id="wtOpenKeys">عرض</button></div>' +
        '</div></section>' +
        '<section class="wt-group"><h3 class="wt-group__title">' + icon('shield', 15) + ' الخصوصية</h3><div class="wt-rows">' +
          '<div class="wt-row"><span class="wt-row__text"><span class="wt-row__title">إعادة ضبط التفضيلات</span>' +
          '<span class="wt-row__sub">تعود الألوان والحركة والتباين للوضع الافتراضي. لا يمسّ حسابك ولا رسائلك.</span></span>' +
          '<button class="wt-row__action" type="button" id="wtReset">إعادة ضبط</button></div>' +
        '</div></section>' +
      '</div>' +
      '<div class="wt-sheet__footer"><span>الإصدار ' + VERSION + ' · تفضيلات محلية</span>' +
      '<span id="wtNetState">' + (isOnline() ? 'متصل' : 'غير متصل') + '</span></div>';

    IC().apply && IC().apply(sheet);
    var close = $('wtSheetClose');
    if (close) close.addEventListener('click', function () { closeSheet(); });
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-wt-accent-choice]'), function (button) {
      button.addEventListener('click', function () { setPrefs({ accent: button.getAttribute('data-wt-accent-choice') }); });
    });
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-wt-toggle]'), function (button) {
      button.addEventListener('click', function () { togglePref(button.getAttribute('data-wt-toggle')); });
    });
    var install = $('wtInstall');
    if (install) install.addEventListener('click', promptInstall);
    var share = $('wtShare');
    if (share) share.addEventListener('click', sharePage);
    var keys = $('wtOpenKeys');
    if (keys) keys.addEventListener('click', function () { closeSheet(); openHelp(); });
    var reset = $('wtReset');
    if (reset) reset.addEventListener('click', function () {
      state.prefs = Object.assign({}, DEFAULT_PREFS);
      writePrefs(state.prefs);
      applyPrefs(state.prefs);
      renderSheet();
      toast('أُعيدت التفضيلات إلى الوضع الافتراضي', 'success');
      focusEl(sheet.querySelector('.wt-swatch[aria-pressed="true"]'));
    });
  }

  function setPrefs(patch) {
    state.prefs = Object.assign({}, state.prefs, patch || {});
    writePrefs(state.prefs);
    applyPrefs(state.prefs);
    renderSheet();
    var focusMap = { accent: '.wt-swatch[aria-pressed="true"]', motion: '#wtMotion', contrast: '#wtContrast', compact: '#wtCompact' };
    var key = Object.keys(patch || {})[0];
    var target = key && focusMap[key] ? ui.sheetLayer.querySelector(focusMap[key]) : null;
    focusEl(target);
    if (key === 'accent') toast('تم تغيير لون الموقع', 'success', 1800);
  }

  function togglePref(kind) {
    if (kind === 'motion') {
      setPrefs({ motion: effectiveMotion(state.prefs) === 'reduce' ? 'full' : 'reduce' });
    } else if (kind === 'contrast') {
      setPrefs({ contrast: state.prefs.contrast === 'high' ? 'normal' : 'high' });
    } else if (kind === 'compact') {
      setPrefs({ compact: !state.prefs.compact });
    }
  }

  /* ============================== 7) الاختصارات ============================== */
  var KEY_ROWS = [
    ['فتح لوحة الأوامر', ['Ctrl', 'K']],
    ['البحث / التركيز على حقل البحث', ['/']],
    ['الانتقال بين الصفحات', ['G', 'H / P / F / M']],
    ['مركز التحكم', ['Alt', 'S']],
    ['هذه القائمة', ['?']],
    ['إغلاق أي نافذة', ['Esc']]
  ];

  function openHelp() {
    if (!state.mounted) return;
    var previous = doc.activeElement;
    closePalette(false);
    if (!ui.helpLayer) {
      ui.helpLayer = node('div', 'wt-layer');
      ui.helpLayer.id = 'wtHelpLayer';
      ui.helpLayer.hidden = true;
      ui.helpLayer.innerHTML = '<div class="wt-sheet" role="dialog" aria-modal="true" aria-labelledby="wtHelpTitle"></div>';
      doc.body.appendChild(ui.helpLayer);
    }
    var sheet = ui.helpLayer.querySelector('.wt-sheet');
    sheet.innerHTML =
      '<div class="wt-sheet__head"><div><p class="wt-sheet__eyebrow">MOVE FASTER</p>' +
      '<h2 class="wt-sheet__title" id="wtHelpTitle">اختصارات لوحة المفاتيح</h2>' +
      '<p class="wt-sheet__sub">تعمل حين لا يكون المؤشر داخل حقل كتابة.</p></div>' +
      '<button class="wt-close" type="button" id="wtHelpClose" aria-label="إغلاق الاختصارات">' + icon('x', 17) + '</button></div>' +
      '<div class="wt-sheet__body"><div class="wt-keys">' + KEY_ROWS.map(function (row) {
        return '<div class="wt-keys__row"><span>' + esc(row[0]) + '</span><span class="wt-keys__combo">' +
          row[1].map(function (key) { return '<kbd class="wt-kbd">' + esc(key) + '</kbd>'; }).join('') + '</span></div>';
      }).join('') + '</div>' +
      '<p class="wt-keys__note">داخل لوحة الأوامر: الأسهم للتنقّل، Enter للتشغيل، Esc للإغلاق. على الهاتف كل شيء متاح من مركز التحكم.</p></div>' +
      '<div class="wt-sheet__footer"><span>WatchTogether</span><span>اضغط <kbd class="wt-kbd">?</kbd> في أي وقت</span></div>';
    IC().apply && IC().apply(sheet);
    $('wtHelpClose').addEventListener('click', closeHelp);
    if (!previous || (ui.paletteLayer && ui.paletteLayer.contains(previous))) previous = doc.body;
    state.returnFocus = previous;
    ui.helpLayer.hidden = false;
    focusEl(ui.helpLayer.querySelector('.wt-close'));
  }

  function closeHelp() {
    if (!ui.helpLayer || ui.helpLayer.hidden) return;
    ui.helpLayer.hidden = true;
    var target = state.returnFocus;
    state.returnFocus = null;
    focusEl(target);
  }

  function anyDialogOpen() {
    return (ui.paletteLayer && !ui.paletteLayer.hidden) ||
      (ui.sheetLayer && !ui.sheetLayer.hidden) ||
      (ui.helpLayer && !ui.helpLayer.hidden);
  }

  function isTyping(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!target.isContentEditable;
  }

  function focusPageSearch() {
    var input = doc.querySelector('#friendQuery, #threadQuery, [role="search"] input[type="search"], [role="search"] input[type="text"]');
    if (input && input.offsetParent !== null) {
      input.focus();
      try { input.select(); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  function leaderNavigate(key) {
    var map = {
      h: 'index.html', r: 'index.html', p: 'profile.html',
      f: 'friends.html', m: 'messages.html', a: 'auth.html'
    };
    var href = map[key];
    if (!href) { toast('صفحة غير معروفة — h الغرف · p ملفي · f الأصدقاء · m الرسائل', 'warn'); return; }
    var page = currentPage();
    if (PAGES[page] && PAGES[page].file === href) { toast('أنت في هذه الصفحة الآن', 'info', 1600); return; }
    startProgress();
    global.location.href = href;
  }

  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    var key = event.key;
    var target = event.target;
    var paletteOpen = ui.paletteLayer && !ui.paletteLayer.hidden;
    var helpOpen = ui.helpLayer && !ui.helpLayer.hidden;
    var sheetOpen = ui.sheetLayer && !ui.sheetLayer.hidden;

    if (paletteOpen) {
      if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePalette(); return; }
      if (key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); setActive(state.activeIndex + 1); return; }
      if (key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setActive(state.activeIndex - 1); return; }
      if (key === 'Home') { event.preventDefault(); setActive(0); return; }
      if (key === 'End') { event.preventDefault(); setActive(state.results.length - 1); return; }
      if (key === 'Enter') { event.preventDefault(); event.stopPropagation(); runCommand(state.activeIndex); return; }
      if (key === 'Tab') { event.preventDefault(); return; }
      return;
    }
    if (helpOpen || sheetOpen) {
      if (key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (helpOpen) closeHelp(); else closeSheet();
        return;
      }
      if (key === 'Tab') {
        trapFocus(event, helpOpen ? ui.helpLayer : ui.sheetLayer);
        return;
      }
      return;
    }

    var mod = event.ctrlKey || event.metaKey;
    if (mod && (key === 'k' || key === 'K')) {
      event.preventDefault();
      openPalette();
      return;
    }
    if (mod || event.altKey) {
      if (event.altKey && (key === 's' || key === 'S') && !mod) {
        event.preventDefault();
        openSettings();
      }
      return;
    }
    if (isTyping(target)) return;

    if (key === '?') { event.preventDefault(); openHelp(); return; }
    if (key === '/') {
      event.preventDefault();
      if (!focusPageSearch()) openPalette();
      return;
    }
    if (key === 'g' || key === 'G') {
      state.leader = true;
      clearTimeout(state.leaderTimer);
      state.leaderTimer = global.setTimeout(function () { state.leader = false; }, 1500);
      toast('اذهب إلى: h الغرف · p ملفي · f الأصدقاء · m الرسائل', 'info', 1500);
      return;
    }
    if (state.leader && /^[a-zA-Z]$/.test(key)) {
      state.leader = false;
      clearTimeout(state.leaderTimer);
      event.preventDefault();
      leaderNavigate(key.toLowerCase());
    }
  }

  function trapFocus(event, layer) {
    var focusables = layer.querySelectorAll('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  /* ============================== 8) الحالة والشبكة ============================== */
  function isOnline() {
    return typeof global.navigator.onLine === 'boolean' ? global.navigator.onLine : true;
  }

  function renderNet() {
    if (!ui.net) return;
    if (isOnline()) {
      if (ui.net.classList.contains('is-on')) {
        ui.net.classList.add('is-back');
        ui.net.querySelector('#wtNetText').textContent = 'عاد الاتصال — المزامنة تستأنف تلقائياً';
        clearTimeout(state.netBackTimer);
        state.netBackTimer = global.setTimeout(function () { ui.net.classList.remove('is-on', 'is-back'); }, 2600);
      }
      var netState = $('wtNetState');
      if (netState) netState.textContent = 'متصل';
    } else {
      clearTimeout(state.netBackTimer);
      ui.net.classList.remove('is-back');
      ui.net.querySelector('#wtNetText').textContent = 'أنت غير متصل — ستُستأنف المزامنة تلقائياً';
      ui.net.classList.add('is-on');
      var stateEl = $('wtNetState');
      if (stateEl) stateEl.textContent = 'غير متصل';
    }
  }

  /* ============================== 9) التقدّم والصعود ============================== */
  function startProgress() {
    if (!ui.progress) return;
    clearTimeout(startProgress.timer);
    ui.progress.classList.remove('is-done');
    ui.progress.classList.add('is-on');
    ui.progressBar.classList.remove('is-run');
    void ui.progressBar.offsetWidth;
    ui.progressBar.classList.add('is-run');
    startProgress.timer = global.setTimeout(finishProgress, 2500);
  }

  function finishProgress() {
    if (!ui.progress) return;
    clearTimeout(startProgress.timer);
    ui.progress.classList.add('is-done');
    startProgress.timer = global.setTimeout(function () {
      ui.progress.classList.remove('is-on', 'is-done');
      ui.progressBar.classList.remove('is-run');
    }, 340);
  }

  function onScroll() {
    if (!ui.top) return;
    var y = global.pageYOffset || (doc.documentElement && doc.documentElement.scrollTop) || 0;
    var tall = (doc.documentElement && doc.documentElement.scrollHeight - global.innerHeight) > 320;
    ui.top.classList.toggle('is-on', tall && y > 420);
  }

  function onDocumentClick(event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.getAttribute('href').charAt(0) === '#') return;
    var url;
    try { url = new URL(anchor.href, global.location.href); } catch (e) { return; }
    if (url.origin !== global.location.origin) return;
    if (!/\.html?$/i.test(url.pathname)) return;
    startProgress();
  }

  /* ============================== 10) المشاركة والتثبيت ============================== */
  function sharePage() {
    var data = {
      title: doc.title || 'WatchTogether',
      text: 'شاهد معي على WatchTogether',
      url: global.location.href
    };
    if (global.navigator && typeof global.navigator.share === 'function') {
      global.navigator.share(data).then(function () {
        toast('تمت المشاركة', 'success', 1800);
      }).catch(function () { /* المستخدم أغلق المشاركة */ });
      return;
    }
    var util = U();
    if (util && util.copyText) {
      util.copyText(data.url).then(function (ok) {
        toast(ok ? 'تم نسخ رابط الصفحة' : 'تعذّر النسخ — انسخ الرابط من شريط العنوان', ok ? 'success' : 'warn');
      });
    }
  }

  function promptInstall() {
    if (!state.deferredInstall) {
      toast('من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»', 'info', 5200);
      return;
    }
    var prompt = state.deferredInstall;
    state.deferredInstall = null;
    prompt.prompt();
    prompt.userChoice.then(function (choice) {
      if (choice && choice.outcome === 'accepted') toast('جارٍ تثبيت WatchTogether', 'success');
      renderSheetIfOpen();
    }).catch(function () { renderSheetIfOpen(); });
  }

  function renderSheetIfOpen() {
    if (ui.sheetLayer && !ui.sheetLayer.hidden) renderSheet();
  }

  /* ============================== 11) الأخطاء ============================== */
  function guardErrors() {
    global.addEventListener('error', function (event) {
      if (!event || !event.error) return;                    /* موارد الصور/الخطوط ليست أخطاء منطق */
      if (/^https?:/i.test(String(event.filename || '')) && String(event.filename).indexOf(global.location.host) < 0) return;
      var now = Date.now();
      if (now - state.lastErrorAt < 20000) return;
      state.lastErrorAt = now;
      toast('حدث خطأ غير متوقع — إن تكرر فأعد تحميل الصفحة', 'error', 4200);
    });
    global.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      if (!reason) return;
      if (/AbortError|aborted|NetworkError|Failed to fetch/i.test(String(reason.name || '') + ' ' + String(reason.message || ''))) return;
      var now = Date.now();
      if (now - state.lastErrorAt < 20000) return;
      state.lastErrorAt = now;
      toast('لم تكتمل العملية — تحقّق من الاتصال وحاول مجدداً', 'warn', 4000);
    });
  }

  /* ============================== 12) خدمة العمل دون اتصال ============================== */
  function registerServiceWorker() {
    if (!('serviceWorker' in global.navigator)) return;
    var protocol = global.location.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return;
    var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(global.location.hostname);
    var forced = /[?&]sw=1\b/.test(global.location.search);
    if (/[?&]nosw=1\b/.test(global.location.search)) return;
    if (isLocal && !forced) return;                          /* لا نُدخل الكاش في بيئة التطوير */
    global.addEventListener('load', function () {
      global.navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' })
        .then(function (registration) {
          if (registration.waiting && global.navigator.serviceWorker.controller) {
            toast('تحديث جديد جاهز — أعد تحميل الصفحة لتفعيله', 'info', 5200);
          }
          registration.addEventListener('updatefound', function () {
            var worker = registration.installing;
            if (!worker) return;
            worker.addEventListener('statechange', function () {
              if (worker.state === 'installed' && global.navigator.serviceWorker.controller) {
                toast('تحديث جديد جاهز — أعد تحميل الصفحة لتفعيله', 'info', 5200);
              }
            });
          });
        })
        .catch(function () { /* المتصفح يمنع العمل دون اتصال — الموقع يعمل عادياً */ });
    });
  }

  /* ============================== 13) التركيب ============================== */
  function bind() {
    ui.paletteInput.addEventListener('input', function () { state.activeIndex = 0; renderResults(); });
    ui.paletteLayer.addEventListener('mousedown', function (event) {
      if (event.target === ui.paletteLayer) closePalette();
    });
    ui.sheetLayer.addEventListener('mousedown', function (event) {
      if (event.target === ui.sheetLayer) closeSheet();
    });
    if (ui.helpLayer) {
      ui.helpLayer.addEventListener('mousedown', function (event) {
        if (event.target === ui.helpLayer) closeHelp();
      });
    }
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('click', onDocumentClick);
    global.addEventListener('online', renderNet);
    global.addEventListener('offline', renderNet);
    global.addEventListener('scroll', onScroll, { passive: true });
    global.addEventListener('resize', onScroll, { passive: true });
    global.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.deferredInstall = event;
      renderSheetIfOpen();
    });
    global.addEventListener('appinstalled', function () {
      state.deferredInstall = null;
      toast('تم تثبيت WatchTogether — استمتع به كتطبيق', 'success', 4200);
      renderSheetIfOpen();
    });
    if (global.matchMedia) {
      try {
        var query = global.matchMedia('(prefers-reduced-motion: reduce)');
        var onChange = function () { if (state.prefs.motion === 'auto') applyPrefs(state.prefs); };
        if (query.addEventListener) query.addEventListener('change', onChange);
        else if (query.addListener) query.addListener(onChange);
      } catch (e) { /* متصفح قديم */ }
    }
    global.addEventListener('storage', function (event) {
      if (event.key !== 'wt:' + PREFS_KEY) return;
      state.prefs = readPrefs();
      applyPrefs(state.prefs);
      renderSheetIfOpen();
    });
  }

  function mount() {
    if (state.mounted || !doc || !doc.body) return;
    state.mounted = true;
    applyPrefs(state.prefs);
    ui.paletteLayer = buildPalette();
    ui.sheetLayer = buildSheet();
    ui.progress = buildProgress();
    ui.progressBar = $('wtProgressBar');
    ui.net = buildNet();
    ui.top = buildTop();
    ui.paletteInput = $('wtPaletteInput');
    ui.list = $('wtPaletteList');
    ui.empty = $('wtPaletteEmpty');
    ui.group = $('wtPaletteGroup');
    injectSkipLink();
    bind();
    guardErrors();
    renderNet();
    onScroll();
    ui.top.addEventListener('click', function () {
      try { global.scrollTo({ top: 0, behavior: effectiveMotion(state.prefs) === 'reduce' ? 'auto' : 'smooth' }); }
      catch (e) { global.scrollTo(0, 0); }
    });
    finishProgress();
    registerServiceWorker();
    if (doc.documentElement) doc.documentElement.setAttribute('data-wt-ready', '1');
  }

  function boot() {
    if (!doc) return;
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }

  /* ============================== 14) الواجهة العامة ============================== */
  global.WTSite = {
    version: VERSION,
    pages: PAGES,
    accents: ACCENTS,
    openPalette: openPalette,
    openSettings: openSettings,
    openHelp: openHelp,
    share: sharePage,
    prefs: function () { return Object.assign({}, state.prefs); },
    setPrefs: setPrefs,
    canInstall: function () { return !!state.deferredInstall; },
    _internal: {
      normalize: normalize,
      score: score,
      rank: rank,
      looksLikeRoomCode: looksLikeRoomCode,
      readPrefs: readPrefs,
      effectiveMotion: effectiveMotion,
      applyPrefs: applyPrefs
    }
  };

  boot();
})(typeof window !== 'undefined' ? window : globalThis);

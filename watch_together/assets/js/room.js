/* =========================================================
   WatchTogether — صفحة الغرفة (room.js) — الإصدار 2
   ---------------------------------------------------------
   الترتيب: مشغّل ← أدوات تحكم ← المنضمون ← الرسائل
   المزامنة:
     • التحكم لمنشئ الغرفة والمنظّمين الذين يعيّنهم
     • الخادم يتحقق من الدور ويرقّم كل تغيير؛ الحالة المحلية ليست مرجعاً
     • الحالة تُرفع إلى قاعدة بيانات الغرفة دورياً، مع إعادة اتصال واستطلاع احتياطي
     • من ينضم لاحقاً يأخذ الوقت المحسوب من آخر حالة (يلحق بالجميع)
     • عند خروج آخر مستخدم تُرفع الحالة فوراً (Java: خادم / Supabase: beacon)
     • رقم تسلسلي rev يمنع تطبيق تحديث قديم
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const IC = window.WTIcons;
  const CFG = window.WT_CONFIG;
  const Auth = window.WTAuth;
  const $ = (id) => document.getElementById(id);

  /* ============================== المعرّفات ============================== */
  const params = new URLSearchParams(location.search);
  const roomId = (params.get('id') || params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const paramVideo = params.get('v') || '';
  if (!roomId) { location.replace('index.html'); return; }

  let createInfo = null;
  try { createInfo = JSON.parse(sessionStorage.getItem('wt:create:' + roomId) || 'null'); } catch (e) { createInfo = null; }

  /* هوية تبويب ثابتة عند إعادة التحميل، ومفتاح تحكم خاص لا يوضع في رابط الدعوة. */
  const storedOwnerToken = U.store.get('owner:' + roomId, '') || '';
  const ownerToken = (createInfo && createInfo.ownerToken) || storedOwnerToken || '';
  if (ownerToken && !storedOwnerToken) U.store.set('owner:' + roomId, ownerToken);
  let roomIdentity = null;
  try { roomIdentity = JSON.parse(sessionStorage.getItem('wt:identity:' + roomId) || 'null'); } catch (e) { roomIdentity = null; }
  const clientId = (roomIdentity && roomIdentity.clientId) || U.uid('c');
  let memberToken = ownerToken || (roomIdentity && roomIdentity.memberToken) || '';
  if (!memberToken) {
    try { memberToken = U.randomToken(32); }
    catch (e) { location.replace('index.html?secure=required'); return; }
  }
  try { sessionStorage.setItem('wt:identity:' + roomId, JSON.stringify({ clientId, memberToken })); } catch (e) { }

  /* ============================== الجلسة ============================== */
  const session = {
    clientId,
    memberToken,
    ownerToken,
    role: 'viewer',
    isOwner: false,
    queue: [],
    roles: {},
    name: '',
    userId: null,
    isGuest: true,
    ready: false,
    transport: null,
    mode: '—',
    clockOffset: 0,          /* فرق ساعة الخادم عن ساعتي (مللي ثانية) */
    applyingRemote: false,
    autoplayBlocked: false,
    lastSyncAt: 0,
    lastPersistAt: 0,
    lastAppliedRev: -1,
    lastAppliedAt: 0,        /* متى وصلت آخر حالة (لحساب الالتحاق) */
    lastRemoteAt: 0,         /* متى وصل آخر تحديث من «شخص آخر» (لاختيار من يرفع الحالة) */
    revClock: 0,             /* ساعة منطقية: أكبر رقم تسلسلي رآه هذا العميل */
    lastApplied: { rev: -1, by: '' },   /* آخر حالة طُبّقت {rev, updatedBy} */
    lastStateT: 0,
    controllerName: '—',
    members: {},
    recentSent: {},
    lastChatSend: 0,
    lastTypingSent: 0,
    typingNames: {},
    unread: 0,
    focusMode: false,
    replyTo: null,        /* الرسالة المُختارة للرد عليها {cid, name, text, row} */
    editing: null,        /* الرسالة قيد التعديل {cid, orig, row} */
    msgMenu: null,        /* قائمة خيارات الرسالة (تُنشأ عند أول استعمال) */
    videoParsed: null,
    pendingDrift: 0,
    lastError: null,       /* آخر خطأ اتصال (مترجم) */
    lastReport: null       /* آخر تقرير تشخيص */
  };

  /** حالة الغرفة المتزامنة */
  let st = {
    url: '',
    kind: '',
    playing: false,
    pos: 0,
    t: 0,              /* وقت الخادم عند آخر تحديث */
    rev: 0,
    updatedBy: '',
    updatedByName: ''
  };

  /* ============================== العناصر ============================== */
  const el = {
    gate: $('gate'), gateCode: $('gateCode'), gateName: $('gateName'), gateForm: $('gateForm'),
    gateError: $('gateError'), gateSubmit: $('gateSubmit'), avatarPreview: $('avatarPreview'), gateAuthLink: $('gateAuthLink'),
    room: $('room'), roomSub: $('roomSub'),
    codeText: $('roomCodeText'), copyCodeBtn: $('copyCodeBtn'),
    statusBadge: $('statusBadge'), statusText: $('statusText'),
    copyLinkBtn: $('copyLinkBtn'), shareBtn: $('shareBtn'), qrBtn: $('qrBtn'), leaveBtn: $('leaveBtn'),
    drawer: $('roomDrawer'), drawerScrim: $('drawerScrim'), drawerOpenBtn: $('drawerOpenBtn'), drawerCloseBtn: $('drawerCloseBtn'),
    membersCount: $('membersCount'), organizerList: $('organizerList'), organizerCount: $('organizerCount'), organizerEmpty: $('organizerEmpty'),
    mediaShell: $('mediaShell'),
    stage: $('stage'), player: $('player'), placeholder: $('playerPlaceholder'), ctrlbar: $('ctrlbar'),
    videoFullscreen: $('videoFullscreenBtn'),
    centerPlay: $('centerPlayBtn'),
    progressBar: $('progressBar'), progressFill: $('progressFill'), progressBuffer: $('progressBuffer'),
    progressKnob: $('progressKnob'), progressTip: $('progressTip'),
    addVideoBtn: $('addVideoBtn'), messagesBtn: $('messagesBtn'), messagesIcon: $('messagesIcon'), messagesCount: $('messagesCount'),
    playlistBtn: $('playlistBtn'), playlistCount: $('playlistCount'),
    changeBar: $('changeBar'), newUrl: $('newUrl'), newTitle: $('newTitle'), applyUrlBtn: $('applyUrlBtn'), cancelUrlBtn: $('cancelUrlBtn'),
    membersPanel: $('membersPanel'), membersList: $('membersList'), sideMembersCount: $('sideMembersCount'),
    chat: $('chat'), chatBody: $('chatBody'), chatEmpty: $('chatEmpty'), chatCount: $('chatCount'),
    clearChatBtn: $('clearChatBtn'), refreshChatBtn: $('refreshChatBtn'), chatForm: $('chatForm'),
    chatInput: $('chatInput'), chatSend: $('chatSend'), typing: $('typing'),
    composerBar: $('composerBar'), composerBarLabel: $('composerBarLabel'), composerBarText: $('composerBarText'), composerBarCancel: $('composerBarCancel'),
    playlistModal: $('playlistModal'), playlistCloseBtn: $('playlistCloseBtn'), queueList: $('queueList'), queueEmpty: $('queueEmpty'),
    sbMeBtn: $('sbMeBtn'), qrModal: $('qrModal'), qrBox: $('qrBox'), qrUrl: $('qrUrl'), qrClose: $('qrClose'), qrCopy: $('qrCopy'),
    meModal: $('meModal'), meClose: $('meClose'), meAvatar: $('meAvatar'), meName: $('meName'),
    meMail: $('meMail'), meNameInput: $('meNameInput'), meSave: $('meSave'), meSignout: $('meSignout'),
    diagBtn: $('diagBtn'), diagModal: $('diagModal'), diagBody: $('diagBody'),
    diagRunBtn: $('diagRunBtn'), diagCopyBtn: $('diagCopyBtn'), diagCloseBtn: $('diagCloseBtn'),
    diagReconnectBtn: $('diagReconnectBtn')
  };

  el.gateCode.textContent = roomId;
  el.codeText.textContent = roomId;
  document.title = 'غرفة ' + roomId + ' — WatchTogether';
  if (el.gateAuthLink) el.gateAuthLink.href = 'auth.html?room=' + encodeURIComponent(roomId);

  /* ============================== المشغّل ============================== */
  const player = new window.WTPlayer.UnifiedPlayer(el.player, {
    onReady: () => {
      if (el.placeholder) { el.placeholder.remove(); el.placeholder = null; }
      session.applyingRemote = true;
      applyState(st, { initial: true });
      setTimeout(() => { session.applyingRemote = false; }, 350);
      updateProgressUI();
      updatePlayIcon();
    },
    onStateChange: (d) => {
      if (session.applyingRemote) return;
      if (!canControl()) {
        applyState(st, { initial: false });
        return;
      }
      if (d.playing === true && !st.playing) { st.playing = true; localControl('play'); }
      else if (d.playing === false && st.playing) { st.playing = false; localControl('pause'); }
      updatePlayIcon();
      pokeVideoUI();
    },
    onEvent: (d) => {
      if (d.type === 'error') U.toast(d.message || 'حدث خطأ في المشغّل', 'error');
      if (d.type === 'autoplay-blocked') showAutoplayPrompt();
      if (d.type === 'retry' && session.videoParsed) {
        loadVideo(session.videoParsed, { autoplay: st.playing, initial: true });
      }
    },
    onTime: () => updateProgressUI()
  });

  /* ============================== بوابة الاسم ============================== */
  function initGate() {
    const user = Auth.currentUser();
    const saved = (user && user.name) || U.store.get('name', '') || '';
    if (saved && !el.gateName.value) el.gateName.value = saved;
    paintAvatar();
    el.gateName.addEventListener('input', paintAvatar);

    el.gateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const name = U.cleanName(el.gateName.value);
      if (name.length < 2) {
        el.gateError.textContent = 'أدخل اسماً من حرفين على الأقل';
        el.gateError.classList.remove('is-shake'); void el.gateError.offsetWidth;
        el.gateError.classList.add('is-shake');
        el.gateName.focus();
        return;
      }
      el.gateError.textContent = '';
      el.gateSubmit.disabled = true;
      el.gateSubmit.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> جارٍ الدخول…';
      session.name = name;
      U.store.set('name', name);
      enterRoom();
    });

    /* Real accounts enter any room directly, including cards and invitation links.
       Guests always confirm a name, even with a saved guest session or ?auto=1. */
    const account = Auth.accountUser();
    if (account) {
      session.name = U.cleanName(account.name) || 'مستخدم';
      el.gate.hidden = true;
      setTimeout(() => enterRoom({ accountOnly: true }), 0);
    } else {
      el.gate.hidden = false;
      el.gateName.focus();
    }
  }

  function paintAvatar() {
    const n = U.cleanName(el.gateName.value) || '؟';
    el.avatarPreview.textContent = U.initials(n);
    el.avatarPreview.style.background = U.colorFor(n);
  }

  /**
   * الوضع المحلي يعني: لا سيرفر → كل جهاز/متصفح له غرفته المستقلة،
   * فالأصدقاء لن يلتحقوا بك. نقولها صراحةً بدل أن تبدو «الغرفة مختلفة».
   */
  function warnLocalMode() {
    const why = session.lastError ? (session.lastError.title + ' — ' + session.lastError.fix) : '';
    sysMessage('السيرفر غير متصل — هذه الغرفة محلية داخل متصفحك فقط، ولن يدخلها أصدقاؤك من أجهزتهم' +
      (why ? '\nالسبب: ' + why : ''));
    U.toast('تعذّر الاتصال بالسيرفر — المزامنة داخل هذا المتصفح فقط', 'warn', 8000);
    if (el.roomSub) el.roomSub.textContent = 'وضع محلي — الأصدقاء لن يلتحقوا (السيرفر غير متصل)';
    if (el.statusText) el.statusText.textContent = 'محلي فقط';
    /* لا نفتح نافذة التشخيص قسراً (تزعج المستخدم) — نكتفي بتنبيه +
       زر «تشخيص» في الشريط العلوي يكفي لمن يريد التفاصيل */
    if (session.lastError) {
      U.toast('السبب: ' + session.lastError.title + ' — اضغط «تشخيص» في الأعلى للحل', 'warn', 9000);
    }
  }

  /* ============================== تشخيص الاتصال ============================== */
  /**
   * يفحص سيرفر المشروع الحالي (Supabase) ويعرض النتيجة:
   * هل REST يردّ؟ هل الجداول موجودة؟ هل Realtime يعمل؟ وما الحلّ إن كان هناك خطأ.
   */
  async function runDiagnostics() {
    const cfg = window.WT_CONFIG;
    if (el.diagBody) {
      el.diagBody.innerHTML = '<div class="diag__loading"><span class="spinner"></span> جارٍ فحص السيرفر…</div>';
    }
    const report = {
      active: session.transport ? { kind: session.transport.kind, label: session.transport.label } : null,
      activeNote: '',
      supabase: null,
      at: Date.now()
    };
    if (session.transport && session.transport.kind === 'local' && session.lastError) {
      report.activeNote = session.lastError.title + ' — ' + session.lastError.fix;
    }
    try {
      if (cfg && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey) {
        const probe = new window.WTTransport.SupabaseTransport(cfg.supabase);
        report.supabase = await probe.diagnose();
      } else {
        report.supabase = null;
      }
    } catch (err) {
      report.supabase = {
        ok: false, url: (cfg && cfg.supabase && cfg.supabase.url) || '—',
        rest: { ok: false, error: { title: 'تعذّر الفحص', detail: String(err && err.message || err), fix: 'أعد المحاولة' } },
        tables: {}, realtime: { ok: false }, problems: []
      };
    }
    session.lastReport = report;
    renderDiagnostics(report);
    return report;
  }

  function diagRow(icon, label, value, cls) {
    return '<div class="diag-row ' + (cls || '') + '">' +
      '<span class="ic diag-row__ic" data-icon="' + icon + '" data-size="16"></span>' +
      '<span class="diag-row__k">' + U.esc(label) + '</span>' +
      '<span class="diag-row__v">' + value + '</span>' +
      '</div>';
  }

  function renderDiagnostics(report) {
    if (!el.diagBody) return;
    const sb = report.supabase;
    let html = '';

    /* السيرفر المستخدم الآن */
    html += '<div class="diag-sec"><h4 class="diag-sec__t">السيرفر المستخدم الآن</h4>' +
      diagRow('server', 'الوضع', U.esc(report.active ? report.active.label : '—'),
        report.active && report.active.kind === 'local' ? 'is-bad' : 'is-good') +
      (report.activeNote ? '<p class="diag-note is-bad">' + U.esc(report.activeNote) + '</p>' : '') +
      '</div>';

    if (!sb) {
      html += '<div class="diag-sec"><h4 class="diag-sec__t">مشروع Supabase</h4>' +
        '<p class="diag-note is-bad">لا يوجد مشروع Supabase مهيّأ في assets/js/config.js — ' +
        'شغّل: <code>node tools/sbctl.mjs create</code></p></div>';
      el.diagBody.innerHTML = html;
      if (window.WTIcons && WTIcons.apply) WTIcons.apply(el.diagBody);
      return;
    }

    /* النتيجة العامة */
    const overall = sb.ok
      ? '<span class="diag-verdict is-good">المشروع يعمل ✓</span>'
      : '<span class="diag-verdict is-bad">المشروع لا يعمل</span>';
    html += '<div class="diag-sec"><h4 class="diag-sec__t">مشروع Supabase ' + overall + '</h4>' +
      diagRow('globe', 'العنوان', '<code>' + U.esc(sb.url) + '</code>') +
      diagRow('lock', 'المفتاح', '<code>' + U.esc(sb.key) + '</code>') +
      diagRow('database', 'REST / الجداول',
        (sb.rest && sb.rest.ok ? 'يستجيب ✓' : 'لا يستجيب ✕') +
        (sb.rest && sb.rest.ms ? ' · ' + sb.rest.ms + 'ms' : ''),
        sb.rest && sb.rest.ok ? 'is-good' : 'is-bad') +
      diagRow('check', 'جدول الغرف (rooms)', sb.tables && sb.tables.rooms ? 'موجود ✓' : 'مفقود ✕',
        sb.tables && sb.tables.rooms ? 'is-good' : 'is-bad') +
      diagRow('chat', 'جدول الرسائل (messages)', sb.tables && sb.tables.messages ? 'موجود ✓' : 'مفقود ✕',
        sb.tables && sb.tables.messages ? 'is-good' : 'is-warn') +
      (sb.messageField ? diagRow('check', 'عمود نصّ الرسالة',
        '<code>' + U.esc(sb.messageField) + '</code>' + (sb.messageField === 'body' ? ' ✓' : ' — جدول قديم (تكيّف العميل)'),
        sb.messageField === 'body' ? 'is-good' : 'is-warn') : '') +
      diagRow('users', 'جدول الأدوار (room_members)', sb.tables && sb.tables.room_members ? 'موجود ✓' : 'مفقود ✕',
        sb.tables && sb.tables.room_members ? 'is-good' : 'is-bad') +
      diagRow('playlist', 'قائمة التشغيل (room_queue)', sb.tables && sb.tables.room_queue ? 'موجود ✓' : 'مفقود ✕',
        sb.tables && sb.tables.room_queue ? 'is-good' : 'is-bad') +
      diagRow('users', 'جدول الحضور القديم (presence)', sb.tables && sb.tables.presence ? 'موجود ✓' : 'اختياري',
        sb.tables && sb.tables.presence ? 'is-good' : 'is-warn') +
      diagRow('broadcast', 'Realtime', sb.realtime && sb.realtime.ok ? 'يعمل ✓' : ('لا يعمل ✕ ' + U.esc((sb.realtime && sb.realtime.error) || '')),
        sb.realtime && sb.realtime.ok ? 'is-good' : 'is-warn') +
      '</div>';

    /* المشاكل والحلول */
    const probs = (sb.problems || []).concat(sb.warnings || []);
    if (probs.length) {
      html += '<div class="diag-sec"><h4 class="diag-sec__t">المشاكل والحلول</h4>';
      probs.forEach(p => {
        html += '<div class="diag-problem">' +
          '<div class="diag-problem__t">' + U.esc(p.title || '') + '</div>' +
          '<div class="diag-problem__d">' + U.esc(p.detail || '') + '</div>' +
          '<div class="diag-problem__f">' + U.esc(p.fix || '') + '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    /* الغرفة نفسها */
    if (sb.room && sb.room.id) {
      html += '<div class="diag-sec"><h4 class="diag-sec__t">الغرفة</h4>' +
        diagRow('info', 'كود الغرفة', '<code>' + U.esc(sb.room.id) + '</code>') +
        diagRow('info', 'صف الغرفة في القاعدة', sb.room.found ? 'موجود ✓' : 'غير موجود ✕',
          sb.room.found ? 'is-good' : 'is-warn') +
        '</div>';
    }

    el.diagBody.innerHTML = html;
    if (window.WTIcons && WTIcons.apply) WTIcons.apply(el.diagBody);
  }

  function openDiag() {
    if (!el.diagModal) return;
    el.diagModal.hidden = false;
    runDiagnostics();
  }

  function closeDiag() {
    if (el.diagModal) el.diagModal.hidden = true;
  }

  /** إعادة الاتصال من الصفر: نغلق النقل الحالي ونعيد البناء */
  async function reconnect() {
    if (enteringRoom) { U.toast('جارٍ الدخول إلى الغرفة — انتظر اكتمال الاتصال', 'info'); return; }
    try { if (session.transport) session.transport.close(); } catch (e) { }
    session.ready = false;
    session.transport = null;
    session.lastError = null;
    clearInterval(session._persistTimer);
    clearInterval(session._pingTimer);
    clearInterval(session._uiTimer);
    clearInterval(session._driftTimer);
    setStatus('connecting', 'جارٍ إعادة الاتصال…');
    await connect();
    U.toast('تمت إعادة الاتصال', 'success', 2500);
  }

  /* ============================== الدخول ============================== */
  let enteringRoom = false;
  async function enterRoom(options) {
    options = options || {};
    if (enteringRoom || session.ready) return;
    enteringRoom = true;
    el.gate.hidden = true;
    el.room.hidden = false;
    setStatus('connecting', 'جارٍ التحقق من الجلسة…');
    try {
      /* validSession يعيد الجلسة لا كائن المستخدم. الأزرار مربوطة مسبقاً،
         وطلبات الحساب محدودة المهلة، فلا تبقى الغرفة متجمّدة عند تجديد token. */
      const authSession = await (Auth ? Auth.validSession().catch(() => null) : null);
      const user = authSession && authSession.user;
      const account = authSession && authSession.access_token && user && user.id && !user.guest ? user : null;
      if (options.accountOnly && !account) {
        session.name = '';
        el.room.hidden = true;
        el.gate.hidden = false;
        el.gateSubmit.disabled = false;
        el.gateError.textContent = 'انتهت جلسة الحساب — أدخل اسمك كضيف أو سجّل الدخول';
        el.gateName.focus();
        return;
      }
      session.userId = account ? account.id : null;
      session.isGuest = !account;
      if (account) session.name = U.cleanName(account.name) || 'مستخدم';

      const startUrl = (createInfo && createInfo.videoUrl) || paramVideo || '';
      if (startUrl) {
        const parsed = U.parseWatchUrl(startUrl);
        if (parsed) { st.url = parsed.src; st.kind = parsed.kind; session.videoParsed = parsed; }
      }

      const title = (createInfo && createInfo.title) || U.store.get('roomTitle:' + roomId) || '';
      session.roomTitle = title || ('غرفة ' + roomId);
      if (title) U.store.set('roomTitle:' + roomId, title);

      paintMe();
      addMember(session.clientId, session.name, { me: true });
      renderPlayerPlaceholder();
      await connect();
    } catch (err) {
      console.error(err);
      setStatus('offline', 'تعذّر تهيئة الغرفة — افتح تشخيص الاتصال لإعادة المحاولة');
      U.toast('تعذّر الدخول إلى الغرفة — أعد المحاولة من قائمة التشخيص', 'error');
    } finally { enteringRoom = false; }
  }

  function paintMe() {
    if (!el.meAvatar) return;
    el.meAvatar.textContent = U.initials(session.name);
    el.meAvatar.style.background = U.colorFor(session.name);
    el.meName.textContent = session.name;
    const user = Auth && Auth.currentUser ? Auth.currentUser() : null;
    const picture = Auth && Auth.avatarURL ? Auth.avatarURL(user) : '';
    if (picture) {
      const image = document.createElement('img'); image.src = picture; image.alt = ''; image.referrerPolicy = 'no-referrer';
      image.onerror = () => { image.remove(); }; el.meAvatar.appendChild(image);
    }

    el.meMail.textContent = user && user.email ? user.email : 'دخول كضيف — بدون حساب';
    el.meNameInput.value = session.name;
  }

  async function connect() {
    setStatus('connecting', 'جارٍ الاتصال…');
    try {
      const { transport, result } = await window.WTTransport.connectRoom(roomId, {
        clientId: session.clientId,
        name: session.name,
        userId: session.userId,
        videoUrl: st.url || null,
        title: (createInfo && createInfo.title) || session.roomTitle || 'غرفة مشاهدة',
        /* من أنشأ الغرفة هو من يملك الحق في إنشاء صفّها في قاعدة البيانات؛
           البقية ينتظرونها ولا ينشئون غرفة فارغة تحمل نفس الكود */
        host: !!(createInfo && createInfo.host) || params.get('host') === '1',
        ownerToken: ownerToken || '',
        memberToken: memberToken || ownerToken || ''
      }, (s) => {
        if (s && s.state === 'failed') {
          /* فشل وضع معيّن — نحتفظ بالسبب لعرضه في نافذة التشخيص */
          session.lastError = (s.error && s.error.diag) || window.WTTransport.classifyError(s.error);
          return;
        }
        setStatus(s.state, s.detail);
      });

      session.transport = transport;
      session.mode = transport.label;
      session.role = (result && result.role) || (transport.kind === 'local' && ownerToken ? 'owner' : 'viewer');
      session.isOwner = session.role === 'owner';
      session.queue = Array.isArray(result && result.queue) ? result.queue : [];
      if (Array.isArray(result && result.roles)) updateRoles(result.roles);
      if (Array.isArray(result && result.members)) mergeMembers(result.members);
      updateControlAccess();
      renderQueue();
      const serverTime = (result && result.serverTime) || transport.serverTime;
      if (typeof serverTime === 'number') session.clockOffset = serverTime - Date.now();

      /* استرجاع الحالة المحفوظة في قاعدة بيانات الغرفة */
      if (result && result.state && typeof result.state === 'object') {
        const incoming = normalizeState(result.state);
        /* لا تسمح لحالة فارغة بمحو الرابط القادم من رابط الدعوة (?v=) */
        if (!incoming.url && st.url) { incoming.url = st.url; incoming.kind = st.kind; }
        st = incoming;
        session.lastApplied = { rev: st.rev || 0, by: st.updatedBy || '' };
        session.lastAppliedRev = st.rev || 0;
        session.revClock = Math.max(session.revClock, Number.isFinite(+st.rev) ? +st.rev : 0);
        session.lastAppliedAt = Date.now();     /* وصلت الآن → نحسب الالتحاق من الآن */
        session.lastRemoteAt = Date.now();
        session.controllerName = st.updatedByName || '—';
      }
      if (result && result.room && result.room.videoUrl && !st.url) {
        const parsed = U.parseWatchUrl(result.room.videoUrl);
        if (parsed) { st.url = parsed.src; st.kind = parsed.kind; }
      }

      bindTransport(transport);
      session.ready = true;

      /* تنبيه صريح: الوضع المحلي يعني أن الأصدقاء لن يلتحقوا بك */
      if (transport.kind === 'local') warnLocalMode();

      /* أَوّل من يدخل ومعه رابط فيديو ينشره فوراً، فلا ينتظر المنضمّون
         نبضة الـ5 ثوانٍ ولا يجدون «غرفة فارغة» ويظنّونها غرفة أخرى */
      const savedUrl = (result && result.state && result.state.url) || '';
      if (st.url && !savedUrl) publish({ force: true });

      /* تحميل الفيديو لا يحجز الحضور والدردشة أو اكتمال الاتصال. */
      if (st.url) loadVideo(U.parseWatchUrl(st.url), { autoplay: st.playing, initial: true });
      else {
        renderPlayerPlaceholder();
        sysMessage('لا يوجد فيديو في هذه الغرفة بعد — أضف فيديو إلى قائمة التشغيل وابدأ عرضه');
      }

      pingPresence(true);
      sysMessage(session.name + ' انضم إلى الغرفة');
      el.roomSub.textContent = 'متصل • ' + transport.label;
      startLoops();

      if (result && result.messages && result.messages.length) {
        result.messages.forEach(m => addChatMessage(m, { silent: true }));
        scrollChat(true);
      }
      updateChatCount();
      updateSyncBadge();
    } catch (err) {
      console.error(err);
      const d = (err && err.diag) || window.WTTransport.classifyError(err);
      session.lastError = d;
      setStatus('offline', d.title);
      U.toast('تعذّر الاتصال بالغرفة — ' + d.title, 'error', 6000);
      sysMessage('تعذّر الاتصال بالغرفة: ' + d.title + (d.fix ? ' — الحل: ' + d.fix : ''));
    }
  }

  function restoreServerState(raw) {
    if (!raw || typeof raw !== 'object') return;
    const incoming = normalizeState(raw);
    const previousUrl = st.url;
    st = incoming;
    session.revClock = Math.max(session.revClock, incoming.rev || 0);
    session.lastAppliedRev = incoming.rev || 0;
    session.lastApplied = { rev: incoming.rev || 0, by: incoming.updatedBy || '' };
    session.lastAppliedAt = Date.now();
    session.lastRemoteAt = Date.now();
    session.controllerName = incoming.updatedByName || '—';
    if (incoming.url && incoming.url !== previousUrl) {
      const parsed = U.parseWatchUrl(incoming.url);
      if (parsed) { loadVideo(parsed, { autoplay: incoming.playing, remote: true }); return; }
    }
    if (player.isReady()) applyState(incoming, { initial: true });
    else if (incoming.url) {
      const parsed = U.parseWatchUrl(incoming.url);
      if (parsed) loadVideo(parsed, { autoplay: incoming.playing, remote: true });
    }
  }

  function bindTransport(t) {
    t.on('state', onRemoteState);
    t.on('chat', (m) => {
      if (!m) return;
      if (m.sender === session.clientId || m.client === session.clientId) return;
      if (m.text && session.recentSent[m.text]) { delete session.recentSent[m.text]; return; }
      addChatMessage(m);
      if (!isChatVisible()) { session.unread++; updateMessagesBadge(); }
    });
    t.on('system', (m) => { if (m && m.text) sysMessage(m.text); });
    t.on('chat-error', (d, info) => {
      if (!d) return;
      session.lastChatError = d;
      /* جدول قديم تكيّف معه العميل: تنبيه ودي بلا إزعاج */
      U.toast(d.title + (d.fix && !(info && info.healed) ? ' — ' + d.fix : ''), (info && info.healed) ? 'warn' : 'error', 8000);
      if (!(info && info.healed)) sysMessage('تعذّر إرسال الرسائل: ' + d.title + (d.fix ? ' — الحل: ' + d.fix : ''));
    });
    t.on('status', (s) => setStatus(s.state, s.detail));
    t.on('serverTime', (time) => { if (typeof time === 'number') session.clockOffset = time - Date.now(); });
    t.on('members', (list) => { if (Array.isArray(list)) mergeMembers(list); });
    t.on('roles', updateRoles);
    t.on('queue', setQueue);
    t.on('presence', handlePresence);
    t.on('typing', handleTyping);
    t.on('error', (e) => {
      if (!e) return;
      if (e.permission) {
        U.toast(e.message || 'لا تملك صلاحية تنفيذ هذا الإجراء', 'warn', 2800);
        if (e.action === 'state') {
          if (session.role === 'organizer') { session.role = 'viewer'; updateControlAccess(); }
          if (e.state) restoreServerState(e.state);
        }
      } else {
        session.lastError = e.diag || session.lastError;
        if (e.transient) setStatus('offline', 'الاتصال متقطع — تتم إعادة المحاولة تلقائياً');
      }
    });
  }

  /* ============================== الحالة: توحيد الشكل ============================== */
  function serverNow() { return Date.now() + session.clockOffset; }

  function normalizeState(raw) {
    raw = raw || {};
    return {
      url: String(raw.url || ''),
      kind: String(raw.kind || ''),
      playing: !!raw.playing,
      pos: Number.isFinite(+raw.pos) ? +raw.pos : 0,
      t: Number.isFinite(+raw.t) ? +raw.t : 0,
      rev: Number.isFinite(+raw.rev) ? +raw.rev : (Number.isFinite(+raw.seq) ? +raw.seq : 0),
      updatedBy: String(raw.updatedBy || raw.hostId || ''),
      updatedByName: String(raw.updatedByName || raw.hostName || '')
    };
  }

  /** الوقت المتوقع "الآن" انطلاقاً من آخر حالة (يلتحق به من يدخل متأخراً) */
  function expectedPos() {
    const refT = st.t || session.lastStateT || session.lastAppliedAt || Date.now();
    return U.expectedPosition(st.pos, st.playing, refT, serverNow());
  }

  /* ============================== صلاحيات التحكم ============================== */
  function canControl() { return session.role === 'owner' || session.role === 'organizer'; }
  function canManageRoles() { return session.role === 'owner'; }

  function updateControlAccess() {
    const locked = !canControl();
    if (el.centerPlay) el.centerPlay.disabled = locked;
    if (el.progressBar) {
      el.progressBar.setAttribute('aria-disabled', locked ? 'true' : 'false');
      el.progressBar.classList.toggle('is-locked', locked);
      el.progressBar.title = locked ? 'التحكم بالمنشئ والمنظّمين فقط' : 'اسحب للتقديم أو الترجيع';
    }
    if (el.player) el.player.classList.toggle('player--view-only', locked);
    if (player && player._video) player._video.controls = false;
    if (el.room) el.room.classList.toggle('room--viewer', locked);
    renderMembers();
  }

  function requireControl() {
    if (canControl()) return true;
    U.toast('التحكم متاح لمنشئ الغرفة والمنظّمين فقط', 'warn', 2600);
    return false;
  }

  function roleName(role) {
    return role === 'owner' ? 'منشئ الغرفة' : role === 'organizer' ? 'منظّم' : 'مشاهد';
  }

  /* ============================== النشر (المعتمد عبر السيرفر) ============================== */
  let publishTimer = null;

  /**
   * يبني الحالة الحالية ويبثّها.
   * @param {{force?:boolean, immediate?:boolean, persist?:boolean}} o
   */
  function publish(o) {
    o = o || {};
    if (!session.ready || !session.transport || !canControl()) return Promise.resolve(false);

    let pos = st.pos || 0;
    /* نثق بحالة st.playing (التي يضبطها التحكم) بدل player.isPlaying()،
       لأن player.isPlaying() قد يتأخر (مثلاً buffering في يوتيوب) فينشر
       حالة معاكسة ويمنع التشغيل/الإيقاف. */
    let playing = !!st.playing;
    if (player.isReady() && player.canSync()) {
      pos = player.getCurrentTime();
    }

    st.pos = pos;
    st.playing = playing;
    st.t = serverNow();
    /* ساعة منطقية: الرقم التسلسلي أكبر من كل ما رآه هذا العميل،
       فلا يتساوى رقمان إذا بثّ اثنان في نفس اللحظة (كان ذلك يجمّد المزامنة) */
    st.rev = U.nextRev(st.rev, session.revClock, session.lastAppliedRev);
    st.updatedBy = session.clientId;
    st.updatedByName = session.name;
    /* لا ننشر أبداً رابطاً فارغاً ونحن نعرف واحداً */
    if (!st.url && session.videoParsed && session.videoParsed.src) {
      st.url = session.videoParsed.src;
      st.kind = session.videoParsed.kind;
    }

    session.revClock = st.rev;
    session.lastApplied = { rev: st.rev, by: st.updatedBy };
    session.lastAppliedRev = st.rev;
    session.lastAppliedAt = Date.now();
    session.lastSyncAt = Date.now();
    session.controllerName = session.name;

    const snapshot = Object.assign({}, st);
    const sent = session.transport.publishState(snapshot);
    if (sent && typeof sent.then === 'function') {
      return sent.then((canonical) => {
        const accepted = canonical && canonical.state ? canonical.state : canonical;
        if (accepted && Number.isFinite(+accepted.rev)) {
          st = normalizeState(accepted);
          session.revClock = Math.max(session.revClock, st.rev);
          session.lastAppliedRev = st.rev;
          session.lastApplied = { rev: st.rev, by: st.updatedBy };
        }
        session.lastPersistAt = Date.now();
        return true;
      }).catch((err) => {
        if (err && (err.status === 401 || err.status === 403 || err.code === '42501')) {
          session.role = 'viewer';
          session.isOwner = false;
          updateControlAccess();
          U.toast('لم يقبل السيرفر هذا التحكم — تم تحديث الصلاحيات', 'warn', 3500);
        }
        return false;
      });
    }
    session.lastPersistAt = Date.now();
    return true;
  }

  /** إجراء محلي (تشغيل/إيقاف/تقديم…) → يرسل للسيرفر للتحقق ثم يبثه */
  function localControl(reason) {
    if (!session.ready || !requireControl()) return;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => publish({ immediate: true }), reason === 'seek' ? 140 : 35);
  }

  /* ============================== الاستقبال ============================== */
  function onRemoteState(raw) {
    if (!raw) return;
    const incoming = normalizeState(raw);
    const authoritative = raw.authoritative === true;

    /* صدى ذاتي (سيرفر Java يعيد الحالة لصاحبها بعد ترقيمها) → نحدّث الساعة فقط */
    if (incoming.updatedBy === session.clientId && !authoritative) {
      if (Number.isFinite(+incoming.rev) && +incoming.rev > session.revClock) session.revClock = +incoming.rev;
      return;
    }
    /* تحديث قديم أو مكرر → تجاهله (يمنع ارتداد الفيديو للخلف).
       عند تساوي rev يفوز صاحب المعرّف الأكبر — نفس القرار عند الجميع */
    if (!authoritative && !U.stateWins(incoming, session.lastApplied)) return;
    if (Number.isFinite(+incoming.rev) && +incoming.rev > session.revClock) session.revClock = +incoming.rev;
    session.lastApplied = { rev: +incoming.rev, by: incoming.updatedBy };

    const first = session.lastAppliedRev < 0;
    const urlChanged = incoming.url && incoming.url !== st.url;

    session.lastAppliedRev = incoming.rev || session.lastAppliedRev;
    session.lastAppliedAt = Date.now();
    session.lastSyncAt = Date.now();
    session.lastRemoteAt = Date.now();
    session.controllerName = incoming.updatedByName || session.controllerName;

    const prevUrl = st.url;
    st = incoming;

    if (urlChanged || (incoming.url && !player.isReady())) {
      const parsed = U.parseWatchUrl(incoming.url);
      if (parsed) {
        if (prevUrl && urlChanged) sysMessage('غيّر ' + (incoming.updatedByName || 'أحد المشاركين') + ' الفيديو');
        loadVideo(parsed, { autoplay: incoming.playing, remote: true });
        return;
      }
    }

    if (!player.isReady()) return;
    applyState(st, { initial: first });
    updateSyncBadge();
  }

  /** تطبيق الحالة على المشغّل مع تصحيح الانحراف */
  function applyState(s, opts) {
    opts = opts || {};
    if (!player.isReady()) return;

    session.applyingRemote = true;

    /* 1) الوقت المتوقع الآن (يلتحق المتأخرون بالجميع) */
    const expected = opts.initial ? expectedPos() : expectedPos();
    const canSync = player.canSync();

    /* 2) تشغيل/إيقاف */
    const cur = player.isPlaying();
    if (s.playing && !cur) player.play();
    else if (!s.playing && cur) player.pause();

    /* 3) تصحيح الموضع */
    if (canSync) {
      const actual = player.getCurrentTime();
      const drift = expected - actual;
      const abs = Math.abs(drift);
      session.pendingDrift = abs;

      if (opts.initial || abs > (CFG.sync.hardDrift || 3)) {
        player.seek(Math.max(0, expected));
      } else if (abs > (CFG.sync.driftTolerance || 1.2)) {
        nudge(drift > 0 ? 1.35 : 0.75, 1500);
      } else if (abs > 0.35) {
        nudge(drift > 0 ? 1.1 : 0.92, 900);
      }
      updateSyncBadge();
    }

    updatePlayIcon();
    updateProgressUI();
    setTimeout(() => { session.applyingRemote = false; }, 240);
  }

  let nudgeTimer = null;
  function nudge(rate, ms) {
    const v = player._video;
    if (!v) return;
    try {
      v.playbackRate = rate;
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { try { v.playbackRate = 1; } catch (e) { } }, ms);
    } catch (e) { }
  }

  function updateSyncBadge() {
    const d = session.pendingDrift || 0;
    /* تفاصيل الانحراف لا تُعرض باستمرار لتبقى الواجهة هادئة؛ تصحيحها يعمل في الخلفية. */
    if (el.statusBadge) {
      el.statusBadge.title = !player.isReady() ? 'حالة اتصال الغرفة' :
        (d <= 0.35 ? 'المشاهدة متزامنة' : 'يُصحّح الانحراف تلقائياً (' + d.toFixed(1) + ' ث)');
    }
  }

  /* ============================== الفيديو ============================== */
  let videoLoadVersion = 0;
  async function loadVideo(parsed, opts) {
    opts = opts || {};
    if (!parsed) { renderPlayerPlaceholder('الرابط غير مدعوم'); return; }
    const version = ++videoLoadVersion;
    clearAutoplayPrompt();
    session.videoParsed = parsed;
    st.url = parsed.src;
    st.kind = parsed.kind;

    try {
      el.ctrlbar.hidden = parsed.kind === 'embed';
      el.player.classList.toggle('is-embed', parsed.kind === 'embed');
      pokeVideoUI();
      await player.load(parsed, { autoplay: !!opts.autoplay, controls: false });
      if (version !== videoLoadVersion) return;
      if (el.placeholder) { el.placeholder.remove(); el.placeholder = null; }

      /* الموضع: عند الانضمام نحسب الوقت المتوقع، وإلا نستخدم الموضع المحفوظ */
      const target = opts.initial ? expectedPos() : (st.pos || 0);
      if (player.canSync() && target > 0.6) player.seek(target);

      if (st.playing && player.canSync()) {
        player.play();
        setTimeout(() => {
          if (version === videoLoadVersion && st.playing && player.isReady() && !player.isPlaying()) showAutoplayPrompt();
        }, 1200);
      }
      updatePlayIcon();
      updateProgressUI();
      updateSyncBadge();
    } catch (err) {
      if (version !== videoLoadVersion || (err && err.code === 'load-cancelled')) return;
      updatePlayIcon();
    }
  }

  function renderPlayerPlaceholder(text) {
    if (el.player.querySelector('.player__placeholder')) return;
    const d = document.createElement('div');
    d.className = 'player__placeholder';
    d.innerHTML =
      '<span class="ic player__placeholder-icon">' + IC.html('film', 46) + '</span>' +
      '<p class="player__placeholder-text">' + (text
        ? U.esc(text)
        : 'لا يوجد فيديو في هذه الغرفة بعد.<br>أضف فيديو إلى قائمة التشغيل المشتركة لبدء المشاهدة معاً.') + '</p>';
    el.player.appendChild(d);
    el.placeholder = d;
  }

  function clearAutoplayPrompt() {
    if (session.autoplayPrompt) session.autoplayPrompt.remove();
    session.autoplayPrompt = null;
    session.autoplayBlocked = false;
  }

  function showAutoplayPrompt() {
    if (session.autoplayBlocked || !st.playing || !player.isReady() || !player.canSync()) return;
    session.autoplayBlocked = true;
    const ov = document.createElement('div');
    session.autoplayPrompt = ov;
    ov.className = 'player__overlay player__overlay--autoplay';
    ov.innerHTML =
      '<div class="player__overlay-box">' +
      '<button type="button" class="btn btn--primary btn--lg" id="unblockPlay">' + IC.html('play', 19) + ' اضغط للتشغيل</button>' +
      '<p class="player__overlay-text">متصفحك يمنع التشغيل التلقائي — اضغط الزر لتلتحق بالجميع.</p>' +
      '</div>';
    el.player.appendChild(ov);
    ov.querySelector('#unblockPlay').addEventListener('click', (e) => {
      e.stopPropagation();
      clearAutoplayPrompt();
      if (!st.playing) return;
      player.seek(expectedPos());
      player.play();
      /* السماح المحلي بالتشغيل ليس أمراً جديداً للغرفة، خصوصاً للمشاهد. */
      updatePlayIcon();
    });
  }

  /* ============================== الحلقات الدورية ============================== */
  function startLoops() {
    /* 1) رفع الحالة إلى قاعدة بيانات الغرفة كل 5 ثوانٍ
          — الذي يتحكّم الآن هو من يرفعها (لا الكل، وإلا تخاصمت الحالات)
          وإن صمت/خرج تولاها آخر بعد مهلة */
    clearInterval(session._persistTimer);
    const persistMs = (CFG.sync && CFG.sync.persistMs) || 5000;
    session._persistTimer = setInterval(() => {
      if (!session.ready || !session.transport || !canControl()) return;
      if (!player.isReady()) return;
      const mine = !st.updatedBy || st.updatedBy === session.clientId;
      const lastRemote = session.lastRemoteAt || session.lastAppliedAt || 0;
      if (mine || Date.now() - lastRemote > persistMs * 2.5) publish({ persist: true });
    }, persistMs);

    /* 2) نبضة الحضور (المنضمون الحقيقيون) */
    clearInterval(session._pingTimer);
    const presenceMs = (CFG.room && CFG.room.presenceMs) || 3000;
    session._pingTimer = setInterval(() => { pingPresence(false); pruneMembers(); }, presenceMs);

    /* 3) تحديث الواجهة كل 500ms */
    clearInterval(session._uiTimer);
    session._uiTimer = setInterval(() => {
      if (!session.ready) return;
      updateProgressUI();
      updatePlayIcon();
      updateSyncBadge();
    }, 500);

    /* 4) تصحيح الانحراف باستمرار (حتى لو لم تصل حالة جديدة) */
    clearInterval(session._driftTimer);
    session._driftTimer = setInterval(() => {
      if (!session.ready || !player.isReady() || !player.canSync()) return;
      const expected = expectedPos();
      const actual = player.getCurrentTime();
      const drift = expected - actual;
      const abs = Math.abs(drift);
      session.pendingDrift = abs;
      if (abs > (CFG.sync.hardDrift || 3) && st.playing) player.seek(Math.max(0, expected));
      else if (abs > (CFG.sync.driftTolerance || 1.2)) nudge(drift > 0 ? 1.3 : 0.78, 1400);
      else if (abs > 0.4) nudge(drift > 0 ? 1.08 : 0.93, 800);
    }, (CFG.sync && CFG.sync.driftCheckMs) || 2000);
  }

  /* ============================== الحضور (المنضمون الحقيقيون) ============================== */
  function addMember(id, name, extra) {
    if (!id) return;
    const prev = session.members[id];
    session.members[id] = Object.assign({
      id, name: name || 'زائر', host: false, me: false, role: session.roles[id] || 'viewer',
      lastSeen: Date.now(), joined: prev ? prev.joined : Date.now(), typing: false
    }, prev || {}, extra || {});
    if (session.roles[id]) session.members[id].role = session.roles[id];
    renderMembers();
  }

  function removeMember(id) {
    const m = session.members[id];
    if (!m) return;
    delete session.members[id];
    renderMembers();
    if (!m.me) sysMessage(m.name + ' غادر الغرفة');
  }

  function handlePresence(p) {
    if (!p) return;
    if (p.left || p.type === 'leave') return removeMember(p.clientId);
    addMember(p.clientId, p.name, { host: !!p.host, role: p.role || session.roles[p.clientId] || 'viewer', typing: !!p.typing });
  }

  function mergeMembers(list) {
    const seen = {};
    list.forEach(m => {
      if (!m || !(m.id || m.client_id)) return;
      const id = m.id || m.client_id;
      seen[id] = 1;
      addMember(id, m.name || m.display_name, {
        host: !!m.host,
        role: m.role || session.roles[id] || 'viewer'
      });
    });
    Object.keys(session.members).forEach(id => {
      if (!seen[id] && !session.members[id].me) delete session.members[id];
    });
    renderMembers();
  }

  function updateRoles(rows) {
    if (!Array.isArray(rows)) return;
    const roles = {};
    rows.forEach(row => {
      if (!row) return;
      const id = row.client_id || row.clientId || row.id;
      if (id) roles[id] = row.role || 'viewer';
    });
    session.roles = roles;
    Object.values(session.members).forEach(m => { m.role = roles[m.id] || 'viewer'; });
    const role = roles[session.clientId];
    if (role) {
      session.role = role;
      session.isOwner = role === 'owner';
      updateControlAccess();
    }
    renderMembers();
  }

  async function changeMemberRole(clientId, role) {
    if (!canManageRoles() || !session.transport || typeof session.transport.setMemberRole !== 'function') {
      U.toast('إدارة المنظّمين متاحة لمنشئ الغرفة فقط', 'warn');
      return;
    }
    try {
      const result = await session.transport.setMemberRole(clientId, role);
      if (Array.isArray(result)) updateRoles(result);
      else if (result && Array.isArray(result.members)) updateRoles(result.members);
      U.toast(role === 'organizer' ? 'تمت إضافة المنظّم' : 'تمت إزالة صلاحية المنظّم', 'success', 2200);
    } catch (err) {
      U.toast('تعذّر تحديث الصلاحية — تحقق من الاتصال ثم أعد المحاولة', 'error', 3500);
    }
  }

  function renderMemberCard(m, allowActions) {
    const role = session.roles[m.id] || m.role || 'viewer';
    const cls = ['member-card'];
    if (m.me) cls.push('is-me');
    if (role === 'owner') cls.push('is-owner');
    else if (role === 'organizer') cls.push('is-organizer');
    const action = allowActions && canManageRoles() && !m.me && role !== 'owner'
      ? '<button class="member-role-btn" type="button" data-client-id="' + U.esc(m.id) + '" data-set-role="' + (role === 'organizer' ? 'viewer' : 'organizer') + '" aria-label="' + (role === 'organizer' ? 'إزالة المنظّم' : 'تعيين منظّم') + '">' +
        IC.html(role === 'organizer' ? 'user' : 'userPlus', 15) + '<span>' + (role === 'organizer' ? 'إزالة' : 'منظّم') + '</span></button>'
      : '';
    return '<div class="' + cls.join(' ') + '" title="' + U.esc(m.name) + '">' +
      '<span class="member-card__av" style="background:' + U.colorFor(m.name) + '">' + U.esc(U.initials(m.name)) + '</span>' +
      '<span class="member-card__body"><span class="member-card__name">' + U.esc(m.name) + (m.me ? ' (أنت)' : '') + '</span>' +
      '<span class="member-card__meta">' + U.esc(roleName(role)) + (m.typing ? ' · يكتب…' : '') + '</span></span>' +
      (role === 'owner' ? '<span class="member-card__role" title="منشئ الغرفة">' + IC.html('crown', 15) + '</span>' :
        role === 'organizer' ? '<span class="member-card__role" title="منظّم">' + IC.html('shield', 15) + '</span>' : '') + action +
      '</div>';
  }

  function renderMembers() {
    const list = Object.values(session.members).map(m => {
      m.role = session.roles[m.id] || m.role || 'viewer';
      return m;
    }).sort((a, b) => {
      const rank = x => x.role === 'owner' ? 0 : x.role === 'organizer' ? 1 : 2;
      return rank(a) - rank(b) || (b.me - a.me) || (b.host - a.host) || (a.joined - b.joined);
    });
    const organizers = list.filter(m => m.role === 'owner' || m.role === 'organizer');

    el.membersList.innerHTML = list.length
      ? list.map(m => renderMemberCard(m, true)).join('')
      : '<div class="members-empty">لا يوجد مشاركون الآن — انسخ الرابط وشاركه</div>';
    el.organizerList.innerHTML = organizers.length
      ? organizers.map(m => renderMemberCard(m, false)).join('')
      : '';
    el.organizerEmpty.hidden = organizers.length > 1 || (organizers.length === 1 && organizers[0].role === 'organizer');
    el.organizerCount.textContent = String(organizers.filter(m => m.role === 'organizer').length);
    el.membersCount.textContent = String(list.length);
    el.sideMembersCount.textContent = String(list.length);

    el.membersList.querySelectorAll('[data-set-role]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        changeMemberRole(btn.getAttribute('data-client-id') || (btn.dataset && (btn.dataset.clientId || btn.dataset['client-id'])),
          btn.getAttribute('data-set-role') || (btn.dataset && (btn.dataset.setRole || btn.dataset['set-role'])));
      });
    });
  }

  function pingPresence(first) {
    addMember(session.clientId, session.name, { me: true, host: st.updatedBy === session.clientId });
    const t = session.transport;
    if (!t || !session.ready) return;
    const payload = {
      type: 'presence', clientId: session.clientId, name: session.name,
      host: st.updatedBy === session.clientId, ts: Date.now()
    };
    if (t.kind === 'ws' && t._send) t._send(payload);
    else if (t.kind === 'supabase') supabasePing(t);
    else if (t.kind === 'local' && t._bc) t._bc(payload);
  }

  function supabasePing(t) {
    if (!t._fetch) return;
    t.emit('presence', { clientId: session.clientId, name: session.name, host: st.updatedBy === session.clientId });
    t._fetch('/rest/v1/presence', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: {
        room_id: roomId,
        client_id: session.clientId,
        name: String(session.name || 'زائر').slice(0, 30),
        is_host: st.updatedBy === session.clientId,
        last_seen: new Date().toISOString()
      }
    }).then(() => fetchPresenceList(t)).catch(() => { /* الجدول اختياري */ });
  }

  function fetchPresenceList(t) {
    t._fetch('/rest/v1/presence?room_id=eq.' + encodeURIComponent(roomId) + '&select=*&order=last_seen.desc&limit=40')
      .then(rows => {
        if (!Array.isArray(rows)) return;
        const now = Date.now();
        rows.forEach(r => {
          if (now - (Date.parse(r.last_seen) || 0) > 15000) return;
          addMember(r.client_id, r.name, { host: !!r.is_host });
        });
      }).catch(() => { });
  }

  function pruneMembers() {
    const now = Date.now();
    let changed = false;
    Object.values(session.members).forEach(m => {
      const timeout = (CFG.room && CFG.room.presenceTimeoutMs) || 12000;
      if (!m.me && now - m.lastSeen > timeout) { delete session.members[m.id]; changed = true; }
    });
    if (changed) renderMembers();
  }

  /* ============================== الرسائل ==============================
     • بطاقة صغيرة بأسلوب مسنجر: النص والوقت فقط بلا اسم وبلا أيقونة تفاعل داخل الفقاعة.
     • السحب على رسالة ← الرد عليها · الضغط المطوّل (أو زر الفأرة الأيمن) ← تفاعل بالإيموجي/رد/تعديل/حذف.
     • الحذف يترك مكان الرسالة بنص «محذوفة»، والتعديل يحدثها في مكانها.
     • الرد/التعديل/الحذف والتفاعلات تُزامَن عبر غلاف JSON مدمج في نص الرسالة
       (يعمل مع أي ناقل: WebSocket أو Supabase أو محلي) دون تغيير الجداول.
     ==================================================================== */

  /* غلاف البيانات التعريفي: \u0001 + JSON — يحمل المعرف والاقتباس والتعديل والتفاعل */
  const CHAT_MARK = '\u0001';
  const CHAT_REACTIONS = Array.from(new Set(
    (CFG.chat && Array.isArray(CFG.chat.reactions) ? CFG.chat.reactions : ['👍', '❤️', '😂', '😮', '🔥', '👏', '🍿'])
      .filter(emoji => typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 32)
  )).slice(0, 14);
  /* Hold reactions delivered before their message; bounded like the visible history. */
  const pendingReactions = new Map();
  function encodeChatText(text, meta) {
    if (!meta) return String(text == null ? '' : text);
    try {
      return CHAT_MARK + JSON.stringify(Object.assign({ t: String(text == null ? '' : text) }, meta));
    } catch (e) { return String(text == null ? '' : text); }
  }
  function decodeChatText(raw) {
    const s = String(raw == null ? '' : raw);
    if (s.charAt(0) === CHAT_MARK) {
      try {
        const o = JSON.parse(s.slice(1)) || {};
        return {
          ok: true,
          text: String(o.t || ''),
          cid: String(o.c || ''),
          reply: o.r ? { name: String(o.r.n || ''), text: String(o.r.t || '') } : null,
          next: o.n != null ? String(o.n) : '',
          action: o.a === 'reaction' ? 'reaction' : '',
          reaction: typeof o.e === 'string' && typeof o.u === 'string'
            ? { emoji: o.e, actor: o.u, version: o.v } : null
        };
      } catch (e) {
        /* ليس غلافاً — نسقط العلامة ونتعامل معه كنص عادي */
        return { ok: false, text: s.slice(1), cid: '', reply: null, next: '' };
      }
    }
    return { ok: false, text: s, cid: '', reply: null, next: '' };
  }

  function addChatMessage(m, opts) {
    opts = opts || {};
    if (!m) return;

    const d = decodeChatText(m.text);
    /* The envelope also identifies reactions on legacy tables without a kind column. */
    if (m.kind === 'reaction' || d.action === 'reaction') return applyMessageReaction(m);
    if (m.kind === 'edit' || m.kind === 'del') return applyChatAction(m, m.kind);

    const text = d.text;
    const cid = d.cid || String(m.id || '') || U.uid('m');
    /* BroadcastChannel + storage, Realtime + polling, or reconnect history may repeat a message. */
    const existing = Array.from(el.chatBody.children).find(child => child.dataset && child.dataset.cid === cid);
    if (existing) return existing;
    if (el.chatEmpty) el.chatEmpty.style.display = 'none';

    const mine = !!opts.mine || m.client === session.clientId;
    const row = document.createElement('div');

    if (m.kind === 'system' || opts.system) {
      row.className = 'msg msg--system';
      row.innerHTML = '<div class="msg__bubble">' + U.esc(text || '') + '</div>';
    } else {
      /* Legacy kind=react messages also use the ordinary sender-aligned bubble. */
      row.className = 'msg' + (mine ? ' msg--me' : '');
      const color = U.colorFor(m.name || '?');
      row.innerHTML =
        '<span class="msg__avatar" style="background:' + color + '" title="' + U.esc(m.name || 'زائر') + '">' + U.esc(U.initials(m.name)) + '</span>' +
        '<div class="msg__bubble">' +
        (d.reply ? '<div class="msg__quote">' +
          '<span class="msg__quote-name">' + U.esc(d.reply.name) + '</span>' +
          '<span class="msg__quote-text">' + U.esc(d.reply.text) + '</span></div>' : '') +
        '<p class="msg__text">' + U.linkify(U.esc(text || '')) + '</p>' +
        '<p class="msg__meta">' +
        '<span class="msg__time">' + U.fmtClock(m.ts || Date.now()) + '</span>' +
        '</p>' +
        '</div>';
      /* بيانات المطابقة للرد/التعديل/الحذف (محلياً وعن بُعد) */
      row.dataset.cid = cid;
      row.dataset.client = String(m.client || m.sender || '');
      row.dataset.text = text;
      row.dataset.name = String(m.name || '');
      row._reactions = new Map();
    }

    const followLatest = el.chatBody.scrollHeight - el.chatBody.scrollTop - el.chatBody.clientHeight < 80;
    el.chatBody.appendChild(row);
    if (row._reactions && pendingReactions.has(cid)) {
      row._reactions = pendingReactions.get(cid);
      pendingReactions.delete(cid);
      renderMessageReactions(row);
    }
    if (window.WTIcons && window.WTIcons.apply) window.WTIcons.apply(row);
    const limit = (CFG.chat && CFG.chat.historyLimit) || 200;
    while (el.chatBody.children.length > limit) el.chatBody.removeChild(el.chatBody.firstChild);

    if (!opts.silent && followLatest) scrollChat(true);
    updateChatCount();
    return row;
  }

  /* العثور على صف رسالة بمعرفها أو بمطابقة (المرسل + النص الأصلي) */
  function findMsgRow(cid, client, origText) {
    const kids = el.chatBody.children || [];
    let fallback = null;
    for (let i = kids.length - 1; i >= 0; i--) {
      const row = kids[i];
      if (!row || !row.dataset || row.dataset.text === undefined) continue;
      if (row.classList && row.classList.contains('msg--deleted')) continue;
      if (cid && row.dataset.cid === String(cid)) return row;
      if (!fallback && row.dataset.client === String(client || '') &&
        row.dataset.text === String(origText == null ? '' : origText)) fallback = row;
    }
    return fallback;
  }

  function canReactToMessage(row) {
    return !!(row && row.parentNode === el.chatBody && row.dataset && row.dataset.cid &&
      !row.classList.contains('msg--system') && !row.classList.contains('msg--deleted'));
  }

  function renderMessageReactions(row) {
    const followLatest = el.chatBody.scrollHeight - el.chatBody.scrollTop - el.chatBody.clientHeight < 80;
    let group = row.querySelector('.msg__reactions');
    const totals = new Map();
    row._reactions.forEach((reaction, actor) => {
      if (!reaction.emoji) return;
      if (!totals.has(reaction.emoji)) totals.set(reaction.emoji, { names: [], mine: false });
      const total = totals.get(reaction.emoji);
      total.names.push(actor === session.clientId ? 'أنت' : reaction.name);
      if (actor === session.clientId) total.mine = true;
    });
    if (!totals.size) {
      if (group) group.remove();
    } else {
      if (!group) {
        group = document.createElement('div');
        group.className = 'msg__reactions';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'تفاعلات الرسالة');
        row.querySelector('.msg__bubble').appendChild(group);
      }
      group.innerHTML = '';
      CHAT_REACTIONS.forEach(emoji => {
        const total = totals.get(emoji);
        if (!total) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'msg__reaction';
        button.dataset.emoji = emoji;
        button.textContent = emoji + ' ' + total.names.length;
        button.setAttribute('aria-pressed', String(total.mine));
        button.setAttribute('aria-label', emoji + '، ' + total.names.length + ' تفاعل' + (total.mine ? '، إلغاء تفاعلك' : '، إضافة تفاعلك'));
        button.setAttribute('title', total.names.join('، '));
        button.addEventListener('click', () => toggleMessageReaction(row, emoji));
        group.appendChild(button);
      });
    }
    if (followLatest) scrollChat(true);
  }

  function applyMessageReaction(m) {
    const d = decodeChatText(m.text);
    const reaction = d.reaction;
    const actor = String(m.client || m.sender || (reaction && reaction.actor) || '');
    if (!d.cid || d.cid.length > 120 || !reaction || !actor || actor.length > 120 ||
      reaction.actor !== actor || !Number.isSafeInteger(reaction.version) || reaction.version < 1 ||
      (reaction.emoji !== '' && !CHAT_REACTIONS.includes(reaction.emoji))) return null;
    const row = Array.from(el.chatBody.children).find(child => child.dataset && child.dataset.cid === d.cid);
    if (row && !canReactToMessage(row)) return null;
    let state = row ? row._reactions : pendingReactions.get(d.cid);
    if (!state) {
      state = new Map();
      pendingReactions.set(d.cid, state);
      const limit = (CFG.chat && CFG.chat.historyLimit) || 200;
      while (pendingReactions.size > limit) pendingReactions.delete(pendingReactions.keys().next().value);
    }
    const previous = state.get(actor);
    /* Explicit set/remove plus a per-actor version makes replay/dual delivery idempotent. */
    if (previous && previous.version >= reaction.version) return row || null;
    state.set(actor, { emoji: reaction.emoji, version: reaction.version, name: String(m.name || 'زائر').slice(0, 30) });
    if (row) renderMessageReactions(row);
    return row || null;
  }

  function toggleMessageReaction(row, emoji) {
    if (!canReactToMessage(row) || !CHAT_REACTIONS.includes(emoji)) return false;
    if (!session.ready || !session.transport) {
      U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn');
      return false;
    }
    const previous = row._reactions.get(session.clientId);
    const version = Math.max(Date.now(), previous ? previous.version + 1 : 1);
    const wire = encodeChatText('', {
      a: 'reaction', c: row.dataset.cid, u: session.clientId,
      e: previous && previous.emoji === emoji ? '' : emoji, v: version
    });
    const message = { name: session.name, text: wire, kind: 'reaction', client: session.clientId, ts: Date.now() };
    session.transport.sendChat(message);
    rememberChatSend(wire, message.kind, message.ts);
    applyMessageReaction(message);
    return true;
  }

  function markEdited(row) {
    if (!row || (row.classList && row.classList.contains('msg--edited'))) return;
    if (row.classList) row.classList.add('msg--edited');
    const meta = row.querySelector('.msg__meta');
    if (meta && !meta.querySelector('.msg__edited')) {
      const s = document.createElement('span');
      s.className = 'msg__edited';
      s.textContent = 'تم التعديل';
      meta.appendChild(s);
    }
  }

  function markDeleted(row) {
    if (!row || !row.classList) return;
    row.classList.add('msg--deleted');
    row.classList.remove('msg--edited');
    const reactions = row.querySelector('.msg__reactions');
    if (reactions) reactions.remove();
    if (row._reactions) row._reactions.clear();
    if (session.msgMenu && session.msgMenu._row === row) hideMsgMenu();
    const quote = row.querySelector('.msg__quote');
    if (quote) quote.remove();
    const textEl = row.querySelector('.msg__text');
    if (textEl) {
      textEl.className = 'msg__text msg__text--gone';
      textEl.textContent = 'محذوفة';
    }
    const ed = row.querySelector('.msg__edited');
    if (ed) ed.remove();
    if (row.dataset) row.dataset.text = '';
  }

  function applyEditToRow(row, next) {
    const textEl = row.querySelector('.msg__text');
    if (textEl) textEl.innerHTML = U.linkify(U.esc(next));
    if (row.dataset) row.dataset.text = next;
    markEdited(row);
  }

  function applyChatAction(m, kind) {
    const d = decodeChatText(m.text);
    const row = findMsgRow(d.cid, m.client || m.sender, d.text);
    if (!row) return null;
    if (kind === 'edit') { if (d.next) applyEditToRow(row, d.next); }
    else markDeleted(row);
    return row;
  }

  function sysMessage(text) {
    addChatMessage({ text, kind: 'system', ts: Date.now(), name: 'النظام' }, { system: true });
  }

  // The four-row window is sized in CSS, not by message length; older rows stay scrollable.
  function scrollChat(force) {
    const b = el.chatBody;
    const near = b.scrollHeight - b.scrollTop - b.clientHeight < 180;
    if (near || force) b.scrollTop = b.scrollHeight;
  }

  function updateChatCount() {
    const n = el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
    el.chatCount.textContent = n + (n === 1 ? ' رسالة' : ' رسائل');
  }

  /* زر «تحديث الرسائل» بجانب زر المسح: يعيد جلب أحدث الرسائل من السيرفر
     (addChatMessage يتجاهل المكرر بالمعرف، فيُستعاد ما مُسح محلياً فقط) */
  let refreshingChat = false;
  async function refreshChat() {
    if (refreshingChat) return { added: 0 };
    if (!session.ready || !session.transport) {
      U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn');
      return { added: 0 };
    }
    refreshingChat = true;
    if (el.refreshChatBtn) {
      el.refreshChatBtn.classList.add('is-spinning');
      el.refreshChatBtn.disabled = true;
    }
    try {
      const t = session.transport;
      const before = el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
      if (t.kind === 'supabase' && typeof t._fetch === 'function') {
        /* نفس استعلام الدخول: أحدث 100 رسالة ثم نعرضها بالترتيب */
        const rows = await t._fetch('/rest/v1/messages?room_id=eq.' + encodeURIComponent(roomId) +
          '&select=*&order=id.desc&limit=100');
        const list = Array.isArray(rows) ? rows.slice().reverse() : [];
        const readText = (window.WTTransport && window.WTTransport.msgText) ||
          ((r) => (r && (r.body || r.text || r.message || r.content || r.msg)) || '');
        list.forEach(r => {
          const n = +r.id;
          if (Number.isFinite(n) && n > (t._lastMsgId || 0)) t._lastMsgId = n;
          if (typeof t._learnMessageField === 'function') t._learnMessageField(r);
          addChatMessage({
            id: String(r.id), name: r.name, text: readText(r),
            ts: Date.parse(r.created_at) || Date.now(), kind: r.kind || 'chat', client: r.client_id || null
          }, { silent: true });
        });
        t._msgsReady = true;
        if (typeof t._pollOnce === 'function') { try { await t._pollOnce(); } catch (e) { } }
      } else if (t.kind === 'local' && t._msgsKey) {
        const saved = U.store.get(t._msgsKey, []);
        (Array.isArray(saved) ? saved : []).forEach(m => addChatMessage(m, { silent: true }));
      } else if (t.kind === 'ws') {
        /* سيرفر Java يدفع الرسائل لحظياً ولا يوفّر أرشيفاً — لا شيء إضافي يُجلب */
      }
      const after = el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
      const added = Math.max(0, after - before);
      updateChatCount();
      scrollChat(true);
      U.toast(added > 0 ? 'تم تحديث الرسائل (' + added + ' جديدة)' : 'الرسائل محدّثة — لا جديد', 'success', 2200);
      return { added };
    } catch (err) {
      U.toast('تعذّر تحديث الرسائل — تحقق من الاتصال ثم أعد المحاولة', 'error', 3000);
      return { added: 0 };
    } finally {
      refreshingChat = false;
      if (el.refreshChatBtn) {
        el.refreshChatBtn.classList.remove('is-spinning');
        el.refreshChatBtn.disabled = false;
      }
    }
  }

  /* الدردشة ظاهرة دائماً في الغرفة (تأخذ المساحة الكبيرة) → لا عدّاد «غير مقروء» */
  function isChatVisible() { return true; }

  function updateMessagesBadge() {
    if (!el.messagesCount) return;
    el.messagesCount.hidden = session.unread === 0;
    el.messagesCount.textContent = session.unread > 99 ? '99+' : String(session.unread);
  }

  function rememberChatSend(wire, kind, now) {
    session.recentSent[wire + '|' + kind] = now;
    session.recentSent[wire] = now;
    setTimeout(() => { delete session.recentSent[wire + '|' + kind]; delete session.recentSent[wire]; }, 15000);
  }

  function sendMessage(text, kind) {
    if (kind === 'react') kind = 'chat';
    text = String(text || '').trim();
    if (!text) return false;
    if (!session.ready) { U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn'); return false; }

    const now = Date.now();
    if (now - session.lastChatSend < ((CFG.chat && CFG.chat.cooldownMs) || 400)) {
      U.toast('على مهلك', 'warn', 1300); return false;
    }
    session.lastChatSend = now;

    const maxLen = (CFG.chat && CFG.chat.maxLength) || 600;
    const body = text.slice(0, maxLen);
    const cid = U.uid('m');
    const isChat = !kind || kind === 'chat';

    /* غلاف الرسالة: المعرف + اقتباس الرد — يُفكَّك لدى كل مستقبل */
    let meta = null, reply = null;
    if (isChat) {
      meta = { c: cid };
      if (session.replyTo) {
        reply = { name: session.replyTo.name || '', text: String(session.replyTo.text || '').slice(0, 120) };
        meta.r = { n: reply.name, t: reply.text };
      }
    }
    const wire = encodeChatText(body, meta);
    const msg = {
      id: cid, client: session.clientId, name: session.name,
      text: wire, ts: now, kind: kind || 'chat'
    };
    if (reply) msg.reply = reply;
    session.transport.sendChat({ name: msg.name, text: wire, kind: msg.kind, client: session.clientId });
    rememberChatSend(wire, msg.kind, now);
    addChatMessage(msg, { mine: true });
    if (isChat) clearComposer();
    scrollChat(true);
    return true;
  }

  /* ============================== الرد والتعديل والحذف ============================== */
  function setComposerBar() {
    const bar = el.composerBar;
    if (!bar) return;
    if (session.editing) {
      bar.hidden = false;
      bar.dataset.mode = 'edit';
      if (el.composerBarLabel) el.composerBarLabel.textContent = 'تعديل الرسالة';
      if (el.composerBarText) el.composerBarText.textContent = session.editing.orig;
    } else if (session.replyTo) {
      bar.hidden = false;
      bar.dataset.mode = 'reply';
      if (el.composerBarLabel) el.composerBarLabel.textContent = 'الرد على ' + (session.replyTo.name || '');
      if (el.composerBarText) el.composerBarText.textContent = session.replyTo.text;
    } else {
      bar.hidden = true;
    }
  }

  function setReplyTo(row) {
    if (!row || !row.dataset || row.dataset.text === undefined) return;
    if (row.classList && row.classList.contains('msg--deleted')) return;
    session.editing = null;
    session.replyTo = {
      cid: row.dataset.cid || '', name: row.dataset.name || '',
      text: row.dataset.text || '', row: row
    };
    setComposerBar();
    if (el.chatInput) el.chatInput.focus();
  }

  function startEdit(row) {
    if (!row || !row.dataset || row.dataset.text === undefined) return;
    if (row.classList && row.classList.contains('msg--deleted')) return;
    session.replyTo = null;
    session.editing = { cid: row.dataset.cid || '', orig: row.dataset.text || '', row: row };
    setComposerBar();
    if (el.chatInput) {
      el.chatInput.value = session.editing.orig;
      el.chatInput.focus();
    }
  }

  function clearComposer() {
    session.replyTo = null;
    session.editing = null;
    setComposerBar();
  }

  function deleteMessage(row) {
    if (!row || !row.dataset || row.dataset.text === undefined) return;
    if (row.classList && row.classList.contains('msg--deleted')) return;
    const orig = row.dataset.text || '';
    const cid = row.dataset.cid || '';
    markDeleted(row);
    if (session.replyTo && session.replyTo.row === row) clearComposer();
    if (session.ready && session.transport) {
      session.transport.sendChat({
        name: session.name, kind: 'del', client: session.clientId,
        text: encodeChatText(orig, { c: cid })
      });
    }
  }

  function commitEdit(ed, next) {
    if (!ed || !ed.row) return;
    applyEditToRow(ed.row, next);
    if (session.ready && session.transport) {
      session.transport.sendChat({
        name: session.name, kind: 'edit', client: session.clientId,
        text: encodeChatText(ed.orig, { c: ed.cid, n: next })
      });
    }
    session.editing = null;
    setComposerBar();
  }

  function submitChat() {
    const input = el.chatInput;
    if (!input) return;
    const text = String(input.value || '').trim();
    if (session.editing) {
      if (text) commitEdit(session.editing, text);
      input.value = '';
      autosize();
      return;
    }
    const sent = sendMessage(text, 'chat');
    /* لم يُرسَل (تهدئة/اتصال) → نُبقي النص وشريط الرد كي يعيد المحاولة */
    if (sent) { input.value = ''; autosize(); }
  }

  /* خيارات الرسالة: تفاعل بالإيموجي · رد · تعديل · حذف */
  function ensureMsgMenu() {
    if (session.msgMenu) return session.msgMenu;
    const menu = document.createElement('div');
    menu.className = 'msg-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'خيارات الرسالة والتفاعلات');
    menu.innerHTML =
      '<div class="msg-menu__reactions" role="group" aria-label="اختر تفاعلاً">' +
      CHAT_REACTIONS.map(emoji => '<button type="button" class="msg-menu__reaction" data-emoji="' + U.esc(emoji) +
        '" aria-label="تفاعل ' + U.esc(emoji) + '" aria-pressed="false">' + U.esc(emoji) + '</button>').join('') + '</div>' +
      '<button type="button" class="msg-menu__btn" data-act="reply">رد</button>' +
      '<button type="button" class="msg-menu__btn" data-act="edit">تعديل</button>' +
      '<button type="button" class="msg-menu__btn msg-menu__btn--danger" data-act="delete">حذف</button>';
    document.body.appendChild(menu);
    if (window.WTIcons && window.WTIcons.apply) window.WTIcons.apply(menu);
    (menu.querySelectorAll('.msg-menu__btn') || []).forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = menu._row;
        const act = btn.dataset ? btn.dataset.act : (btn.getAttribute ? btn.getAttribute('data-act') : '');
        hideMsgMenu();
        if (!row) return;
        if (act === 'reply') setReplyTo(row);
        else if (act === 'edit') startEdit(row);
        else if (act === 'delete') deleteMessage(row);
      });
    });
    menu.querySelectorAll('.msg-menu__reaction').forEach(button => {
      button.addEventListener('click', () => {
        const row = menu._row;
        const emoji = button.dataset.emoji;
        hideMsgMenu(true);
        toggleMessageReaction(row, emoji);
      });
    });
    session.msgMenu = menu;
    return menu;
  }

  let suppressMenuCloseUntil = 0;

  function openMsgMenu(row, x, y, trigger) {
    if (!canReactToMessage(row)) return;
    hideMsgMenu();
    const menu = ensureMsgMenu();
    menu._row = row;
    menu.hidden = false;
    menu._trigger = trigger || row.querySelector('.msg__bubble') || row;
    if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'true');
    if (row.classList) row.classList.add('is-menu');
    const current = row._reactions.get(session.clientId);
    menu.querySelectorAll('.msg-menu__reaction').forEach(button => {
      button.setAttribute('aria-pressed', String(!!current && current.emoji === button.dataset.emoji));
    });
    const isMine = row.classList.contains('msg--me');
    /* تعديل/حذف لرسائلي فقط — والرد والتفاعل متاحان للجميع */
    (menu.querySelectorAll('.msg-menu__btn') || []).forEach(b => {
      const act = b.dataset ? b.dataset.act : '';
      b.hidden = (act === 'edit' || act === 'delete') ? !isMine : false;
    });
    if (!x && !y && menu._trigger && menu._trigger.getBoundingClientRect) {
      const rect = menu._trigger.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top;
    }
    positionMsgMenu(menu, x, y);
    const first = menu.querySelector('.msg-menu__reaction');
    if (first) first.focus({ preventScroll: true });
  }

  function positionMsgMenu(menu, x, y) {
    const pad = 10;
    const w = menu.offsetWidth || 280, h = menu.offsetHeight || 160;
    const vw = window.innerWidth || 390, vh = window.innerHeight || 844;
    menu.style.left = Math.max(pad, Math.min((x || 0) - w / 2, vw - w - pad)) + 'px';
    const above = (y || 0) - h - 10;
    const top = above < pad && (y || 0) + h + 10 < vh - pad ? (y || 0) + 10 : above;
    menu.style.top = Math.max(pad, Math.min(top, vh - h - pad)) + 'px';
  }

  function followMsgMenu() {
    const menu = session.msgMenu;
    if (!menu || menu.hidden || !menu._trigger) return;
    if (!canReactToMessage(menu._row)) { hideMsgMenu(); return; }
    const rect = menu._trigger.getBoundingClientRect();
    /* Smooth scrolling/focus and the mobile keyboard must not dismiss a freshly opened picker. */
    positionMsgMenu(menu, rect.left + rect.width / 2, rect.top);
  }

  function hideMsgMenu(restoreFocus) {
    const menu = session.msgMenu;
    if (menu) {
      const trigger = menu._trigger;
      menu.hidden = true;
      menu._row = null;
      menu._trigger = null;
      if (trigger) {
        if (trigger.getAttribute && trigger.getAttribute('aria-expanded') !== null) {
          trigger.setAttribute('aria-expanded', 'false');
        }
        if (restoreFocus && trigger.parentNode && trigger.focus) trigger.focus({ preventScroll: true });
      }
    }
    const kids = el.chatBody ? (el.chatBody.children || []) : [];
    for (let i = 0; i < kids.length; i++) if (kids[i].classList) kids[i].classList.remove('is-menu');
  }

  /* إغلاق القائمة عند الضغط في أي مكان آخر */
  document.addEventListener('click', (e) => {
    const menu = session.msgMenu;
    if (!menu || menu.hidden) return;
    const t = e && e.target;
    if (t && t.closest && t.closest('.msg-menu')) return;
    if (Date.now() < suppressMenuCloseUntil) return;
    hideMsgMenu();
  });

  /* ---- إيماءات الرسالة: السحب = رد · الضغط المطوّل = تفاعل/رد/تعديل/حذف ---- */
  (function bindMsgGestures() {
    if (!el.chatBody) return;
    let drag = null;

    const rowOf = (e) => {
      const t = e && e.target;
      return t && t.closest ? t.closest('.msg') : null;
    };
    const actionable = (row) => row && row.classList &&
      !row.classList.contains('msg--system') && !row.classList.contains('msg--deleted');
    const resetRow = (row) => {
      if (!row) return;
      const bubble = row.querySelector('.msg__bubble');
      if (bubble && bubble.style) bubble.style.transform = '';
      if (row.classList) { row.classList.remove('is-dragging'); row.classList.remove('is-swiped'); }
    };

    el.chatBody.addEventListener('pointerdown', (e) => {
      const target = e && e.target;
      if (target && target.closest && (target.closest('.msg__reaction') || target.closest('a'))) return;
      const row = rowOf(e);
      if (!actionable(row)) return;
      if (drag) { clearTimeout(drag.lpTimer); resetRow(drag.row); }
      drag = {
        row: row, x0: e.clientX || 0, y0: e.clientY || 0, mode: '', dx: 0,
        lpTimer: setTimeout(function () {
          if (!drag || drag.mode) return;
          drag.mode = 'menu';
          suppressMenuCloseUntil = Date.now() + 600;
          openMsgMenu(drag.row, drag.x0, drag.y0);
        }, 450)
      };
      const t = e && e.target;
      if (e.pointerId != null && t && t.setPointerCapture) { try { t.setPointerCapture(e.pointerId); } catch (err) { } }
    });

    el.chatBody.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX || 0) - drag.x0;
      const dy = (e.clientY || 0) - drag.y0;
      if (!drag.mode) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4) {
          drag.mode = 'swipe';
          clearTimeout(drag.lpTimer);
          if (drag.row.classList) drag.row.classList.add('is-dragging');
        } else if (Math.abs(dy) > 12) {
          clearTimeout(drag.lpTimer);
          resetRow(drag.row);
          drag = null;
          return;
        }
      }
      if (drag.mode === 'swipe') {
        drag.dx = Math.max(-90, Math.min(90, dx));
        const bubble = drag.row.querySelector('.msg__bubble');
        if (bubble && bubble.style) bubble.style.transform = 'translateX(' + drag.dx + 'px)';
        if (drag.row.classList) drag.row.classList.toggle('is-swiped', Math.abs(drag.dx) > 40);
      }
    });

    const endDrag = () => {
      if (!drag) return;
      clearTimeout(drag.lpTimer);
      const d = drag;
      drag = null;
      resetRow(d.row);
      if (d.mode === 'menu') suppressMenuCloseUntil = Date.now() + 400;
      else if (d.mode === 'swipe' && Math.abs(d.dx) > 48) setReplyTo(d.row);
    };
    el.chatBody.addEventListener('pointerup', endDrag);
    el.chatBody.addEventListener('pointercancel', endDrag);

    /* زر الفأرة الأيمن على الحاسوب = نفس قائمة الخيارات */
    el.chatBody.addEventListener('scroll', followMsgMenu, { passive: true });
    window.addEventListener('resize', followMsgMenu);
    window.addEventListener('scroll', followMsgMenu, { passive: true });

    el.chatBody.addEventListener('contextmenu', (e) => {
      const row = rowOf(e);
      if (!actionable(row)) return;
      if (e.preventDefault) e.preventDefault();
      suppressMenuCloseUntil = Date.now() + 400;
      openMsgMenu(row, e.clientX || 0, e.clientY || 0);
    });
  })();

  function handleTyping(d) {
    if (!d || d.clientId === session.clientId) return;
    session.typingNames[d.clientId] = { name: d.name, at: Date.now() };
    renderTyping();
  }

  function renderTyping() {
    const now = Date.now();
    Object.keys(session.typingNames).forEach(k => { if (now - session.typingNames[k].at > 4000) delete session.typingNames[k]; });
    const names = Object.values(session.typingNames).map(x => x.name);
    el.typing.textContent = names.length
      ? names.slice(0, 2).join('، ') + (names.length > 2 ? ' وآخرون' : '') + ' يكتب…'
      : '';
    const typingSet = new Set(names);
    Object.values(session.members).forEach(m => { m.typing = typingSet.has(m.name); });
    renderMembers();
  }

  function autosize() {
    const t = el.chatInput;
    t.style.height = 'auto';
    t.style.height = Math.min(96, t.scrollHeight) + 'px';
  }

  /* يضمن ظهور كل محتوى الصفحة على كل هاتف: عند فتح لوحة المفاتيح
     تبقى خانة الكتابة والرسائل ظاهرة، وعند تدوير الهاتف يُعاد حساب التخطيط */
  function bindMobileViewport() {
    const vv = window.visualViewport;
    if (vv) {
      const onVp = () => { if (document.activeElement === el.chatInput) requestAnimationFrame(() => scrollChat(true)); };
      vv.addEventListener('resize', onVp);
      vv.addEventListener('scroll', onVp);
    }
    if (el.chatInput) {
      el.chatInput.addEventListener('focus', () => {
        setTimeout(() => {
          scrollChat(true);
          el.chatBody.scrollTop = el.chatBody.scrollHeight;
          if (window.innerWidth <= 640) el.chat.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 260);
      });
    }
    window.addEventListener('orientationchange', () => setTimeout(() => { updateProgressUI(); scrollChat(true); }, 320));
    window.addEventListener('resize', () => { if (window.innerWidth > 640) return; requestAnimationFrame(() => scrollChat(false)); });
  }

  /* ============================== وضع الرسائل ============================== */
  function setFocusMode(on) {
    session.focusMode = !!on;
    document.body.classList.toggle('chat-focus', session.focusMode);
    if (el.messagesBtn) {
      el.messagesBtn.classList.toggle('is-on', session.focusMode);
      el.messagesBtn.setAttribute('aria-expanded', String(session.focusMode));
      const label = session.focusMode ? 'تصغير الرسائل' : 'تكبير الرسائل';
      el.messagesBtn.setAttribute('aria-label', label);
      el.messagesBtn.setAttribute('title', label + ' (D)');
      el.messagesIcon.innerHTML = IC.html(session.focusMode ? 'chatUp' : 'chatDown', 19);
    }
    /* Keep the latest message in view when switching between video and chat focus. */
    scrollChat(true);
    if (session.focusMode) {
      session.unread = 0;
      updateMessagesBadge();
      setTimeout(() => {
        if (!session.focusMode) return;
        el.chatInput.focus({ preventScroll: true });
      }, 90);
    }
  }

  /* ============================== قائمة التشغيل المشتركة ============================== */
  function setQueue(items) {
    session.queue = Array.isArray(items) ? items.slice() : [];
    renderQueue();
  }

  function renderQueue() {
    const queue = session.queue || [];
    el.playlistCount.textContent = String(queue.length);
    el.queueEmpty.hidden = queue.length > 0;
    if (!queue.length) { el.queueList.innerHTML = ''; return; }
    el.queueList.innerHTML = queue.map((item, index) => {
      const title = item.title || item.url || 'فيديو';
      const canRemove = canControl() || item.addedByClient === session.clientId || item.added_by_client === session.clientId;
      return '<article class="queue-item" data-queue-id="' + U.esc(item.id) + '">' +
        '<span class="queue-item__index">' + String(index + 1).padStart(2, '0') + '</span>' +
        '<span class="queue-item__body"><strong>' + U.esc(title) + '</strong><small dir="ltr">' + U.esc(item.url || '') + '</small>' +
        '<small>أُضيف بواسطة ' + U.esc(item.addedBy || item.added_by || 'مشارك') + '</small></span>' +
        (canControl() ? '<button type="button" class="queue-item__play" data-play-queue="' + U.esc(item.id) + '" aria-label="تشغيل الآن">' + IC.html('play', 16) + '</button>' : '') +
        (canRemove ? '<button type="button" class="queue-item__remove" data-remove-queue="' + U.esc(item.id) + '" aria-label="إزالة من القائمة">' + IC.html('x', 16) + '</button>' : '') +
        '</article>';
    }).join('');

    el.queueList.querySelectorAll('[data-play-queue]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-play-queue');
      const item = queue.find(x => String(x.id) === String(id));
      if (item) playQueueItem(item);
    }));
    el.queueList.querySelectorAll('[data-remove-queue]').forEach(btn => btn.addEventListener('click', () => {
      removeQueueItem(btn.getAttribute('data-remove-queue'));
    }));
  }

  async function addQueueItem() {
    const parsed = U.parseWatchUrl(el.newUrl.value);
    if (!parsed) { U.toast('الرابط غير صالح — أدخل رابط يوتيوب أو mp4 أو m3u8', 'error'); el.newUrl.focus(); return; }
    if (!session.transport || typeof session.transport.addQueueItem !== 'function') {
      U.toast('قائمة التشغيل غير متاحة في وضع الاتصال الحالي', 'warn'); return;
    }
    const item = { url: parsed.src, title: U.cleanName(el.newTitle.value) || parsed.label || 'فيديو', addedBy: session.name, addedByClient: session.clientId };
    try {
      const result = await session.transport.addQueueItem(item);
      if (Array.isArray(result)) setQueue(result);
      el.newUrl.value = '';
      el.newTitle.value = '';
      el.changeBar.hidden = true;
      U.toast('أُضيف الفيديو إلى قائمة الغرفة', 'success', 2200);
    } catch (err) {
      U.toast('تعذّر إضافة الفيديو — تحقق من الاتصال ثم أعد المحاولة', 'error', 3200);
    }
  }

  async function removeQueueItem(id) {
    if (!session.transport || typeof session.transport.removeQueueItem !== 'function') return;
    try {
      const result = await session.transport.removeQueueItem(id);
      if (Array.isArray(result)) setQueue(result);
    } catch (err) { U.toast('تعذّر إزالة الفيديو من القائمة', 'error', 2600); }
  }

  function playQueueItem(item) {
    if (!requireControl()) return;
    const parsed = U.parseWatchUrl(item && item.url);
    if (!parsed) { U.toast('رابط الفيديو في القائمة غير صالح', 'error'); return; }
    st.url = parsed.src;
    st.kind = parsed.kind;
    st.pos = 0;
    st.playing = true;
    session.lastAppliedRev = -1;
    loadVideo(parsed, { autoplay: true });
    publish({ force: true });
    el.playlistModal.hidden = true;
    sysMessage('بدأ ' + session.name + ' عرض «' + (item.title || parsed.label) + '»');
  }

  /* ============================== الحالة والشريط ============================== */
  function setStatus(state, detail) {
    const map = {
      connecting: { txt: 'يتصل…', cls: 'is-connecting', pulse: true },
      online: { txt: 'متصل', cls: 'is-online', pulse: true },
      local: { txt: 'محلي', cls: 'is-local', pulse: false },
      offline: { txt: 'يعيد الاتصال', cls: 'is-offline', pulse: true }
    };
    const m = map[state] || map.offline;
    if (el.statusBadge) {
      el.statusBadge.className = 'badge room-connection ' + m.cls;
      el.statusBadge.setAttribute('data-state', state || 'offline');
      el.statusBadge.title = detail || 'حالة اتصال الغرفة';
    }
    if (el.statusText) el.statusText.textContent = m.txt;
    const dot = el.statusBadge && el.statusBadge.querySelector('.dot');
    if (dot) dot.className = 'dot' + (m.pulse ? ' dot--pulse' : '');
    if (detail && el.roomSub) el.roomSub.textContent = detail;
  }

  /* ============================== ربط الواجهة ============================== */
  function wireUI() {
    /* ---- تشغيل/إيقاف (من زر التحكم أسفل الفيديو، أو الزر الكبير، أو النقر على الفيديو) ---- */
    const togglePlay = () => {
      if (!requireControl()) return;
      if (!player.isReady()) {
        if (!st.url) return openChangeBar();
        return U.toast('لم يكتمل تحميل الفيديو بعد', 'warn');
      }
      if (player.isPlaying()) { player.pause(); st.playing = false; }
      else { player.play(); st.playing = true; }
      updatePlayIcon();
      pokeVideoUI();
      localControl('toggle');
    };
    if (el.centerPlay) el.centerPlay.addEventListener('click', togglePlay);

    /* النقر على سطح الفيديو نفسه يبدّل التشغيل (النقرة المزدوجة تُحسب نقرة واحدة).
       نقرات شريط التحكم والزر الكبير وطبقات التحميل لا تصل إلى هنا. */
    let lastPlayerClick = 0;
    el.player.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('.vcontrols') || t.closest('.vcenter') || t.closest('.video-fullscreen') ||
        t.closest('.player__overlay') || t.closest('.player__placeholder'))) return;
      const now = Date.now();
      if (now - lastPlayerClick < 320) return;   /* تفادي النقر المزدوج */
      lastPlayerClick = now;
      togglePlay();
    });

    /* ---- تقديم/ترجيع بمفاتيح الأسهم فقط (لا أزرار في الواجهة) ---- */
    const skip = (delta) => {
      if (!requireControl()) return;
      if (!player.isReady()) return U.toast('لا يوجد فيديو يعمل', 'warn');
      const to = Math.max(0, player.getCurrentTime() + delta);
      player.seek(to);
      st.pos = to;
      localControl('seek');
      updateProgressUI();
      pokeVideoUI();
    };

    if (el.videoFullscreen) el.videoFullscreen.addEventListener('click', async () => {
      const target = document.getElementById('stage');
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (target.requestFullscreen) await target.requestFullscreen();
        else if (player._video && player._video.webkitEnterFullscreen) player._video.webkitEnterFullscreen();
        else U.toast('التكبير غير مدعوم في هذا المتصفح', 'warn');
      } catch (e) { U.toast('تعذر تكبير الفيديو', 'warn'); }
    });

    /* ---- شريط التقدم داخل الفيديو (سحب باللمس والفأرة + معاينة الوقت) ---- */
    const ratioFromEvent = (ev) => {
      const rect = el.progressBar.getBoundingClientRect();
      return U.clamp(1 - ((ev.clientX - rect.left) / rect.width), 0, 1);   /* RTL: التقدم من اليمين */
    };
    const showTip = (ev) => {
      if (!el.progressTip || !player.isReady()) return;
      const dur = player.getDuration();
      if (!dur) return;
      const ratio = ratioFromEvent(ev);
      el.progressTip.textContent = U.fmtTime(ratio * dur);
      el.progressTip.style.insetInlineStart = (ratio * 100) + '%';
      el.progressTip.hidden = false;
    };
    const hideTip = () => { if (el.progressTip) el.progressTip.hidden = true; };
    const seekFromEvent = (ev) => {
      if (!canControl()) return;
      const dur = player.getDuration();
      if (!dur) return;
      const to = ratioFromEvent(ev) * dur;
      player.seek(to);
      st.pos = to;
      updateProgressUI();
    };
    let dragging = false;
    el.progressBar.addEventListener('pointerdown', (e) => {
      if (!canControl() || !player.isReady()) return;
      dragging = true;
      el.progressBar.classList.add('is-active');
      try { el.progressBar.setPointerCapture(e.pointerId); } catch (err) { }
      showTip(e);
      seekFromEvent(e);
      pokeVideoUI();
    });
    el.progressBar.addEventListener('pointermove', (e) => { showTip(e); if (dragging) seekFromEvent(e); });
    el.progressBar.addEventListener('pointerleave', hideTip);
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      el.progressBar.classList.remove('is-active');
      hideTip();
      localControl('seek');
    };
    el.progressBar.addEventListener('pointerup', endDrag);
    el.progressBar.addEventListener('pointercancel', endDrag);
    el.progressBar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();             /* لا تنفّذ اختصار الصفحة مرة ثانية */
      skip(e.key === 'ArrowLeft' ? 5 : -5);   /* RTL: اليسار يتقدم */
    });

    /* ---- أدوات المشاهدة ---- */
    el.addVideoBtn.addEventListener('click', openChangeBar);
    el.messagesBtn.addEventListener('click', () => setFocusMode(!session.focusMode));
    el.playlistBtn.addEventListener('click', () => { renderQueue(); el.playlistModal.hidden = false; });
    el.playlistCloseBtn.addEventListener('click', () => { el.playlistModal.hidden = true; });
    el.playlistModal.addEventListener('click', (e) => { if (e.target === el.playlistModal) el.playlistModal.hidden = true; });
    el.cancelUrlBtn.addEventListener('click', () => { el.changeBar.hidden = true; });
    el.applyUrlBtn.addEventListener('click', addQueueItem);
    el.newUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addQueueItem(); } });

    /* ---- القائمة الجانبية ---- */
    const setDrawerOpen = (open) => {
      el.drawer.classList.toggle('is-open', !!open);
      el.drawerScrim.hidden = !open;
      el.drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      el.drawerOpenBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('drawer-open', !!open);
      /* preventScroll: منع تحريك الصفحة عند نقل التركيز (خاصة في RTL على الهاتف) */
      if (open) setTimeout(() => el.drawerCloseBtn.focus({ preventScroll: true }), 30);
      else el.drawerOpenBtn.focus({ preventScroll: true });
    };
    el.drawerOpenBtn.addEventListener('click', () => setDrawerOpen(true));
    el.drawerCloseBtn.addEventListener('click', () => setDrawerOpen(false));
    el.drawerScrim.addEventListener('click', () => setDrawerOpen(false));

    /* ---- نسخ ومشاركة ---- */
    /* الرابط يحمل كود الغرفة + رابط الفيديو، فيلتحق الصديق بنفس المشاهدة
       حتى لو تأخّرت حالة الغرفة في الوصول */
    const roomUrl = () => {
      const base = location.origin + location.pathname.replace(/[^/]*$/, '') + 'room.html?id=' + roomId;
      return st.url ? base + '&v=' + encodeURIComponent(st.url) : base;
    };
    const copy = async (text, okMsg) => {
      const done = await U.copyText(text);
      U.toast(done ? okMsg : 'تعذّر النسخ — انسخه يدوياً: ' + text, done ? 'success' : 'error', done ? 2200 : 6000);
    };
    el.copyCodeBtn.addEventListener('click', () => copy(roomId, 'تم نسخ كود الغرفة'));
    el.copyLinkBtn.addEventListener('click', () => copy(roomUrl(), 'تم نسخ رابط الغرفة'));

    if (navigator.share) {
      el.shareBtn.hidden = false;
      el.shareBtn.addEventListener('click', () => {
        navigator.share({ title: 'شاهدوا معي', text: 'انضم إلى غرفتي في WatchTogether', url: roomUrl() }).catch(() => { });
      });
    }

    /* ---- QR ---- */
    el.qrBtn.addEventListener('click', () => {
      const url = roomUrl();
      el.qrUrl.textContent = url;
      el.qrBox.innerHTML = '';
      try {
        if (window.qrcode) {
          const qr = window.qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          el.qrBox.innerHTML = qr.createImgTag(5, 8);
        } else {
          el.qrBox.innerHTML = '<p style="color:#111;font-size:13px">مكتبة QR غير متوفرة</p>';
        }
      } catch (e) {
        el.qrBox.innerHTML = '<p style="color:#111;font-size:13px">تعذّر إنشاء QR</p>';
      }
      el.qrModal.hidden = false;
    });
    el.qrClose.addEventListener('click', () => { el.qrModal.hidden = true; });
    el.qrCopy.addEventListener('click', () => copy(roomUrl(), 'تم نسخ رابط الغرفة'));
    el.qrModal.addEventListener('click', (e) => { if (e.target === el.qrModal) el.qrModal.hidden = true; });

    /* ---- تشخيص الاتصال ---- */
    if (el.diagBtn) el.diagBtn.addEventListener('click', () => openDiag());
    if (el.diagCloseBtn) el.diagCloseBtn.addEventListener('click', () => closeDiag());
    if (el.diagRunBtn) el.diagRunBtn.addEventListener('click', () => runDiagnostics());
    if (el.diagModal) el.diagModal.addEventListener('click', (e) => { if (e.target === el.diagModal) closeDiag(); });
    if (el.diagReconnectBtn) el.diagReconnectBtn.addEventListener('click', async () => {
      closeDiag();
      await reconnect();
    });
    if (el.diagCopyBtn) el.diagCopyBtn.addEventListener('click', async () => {
      const r = session.lastReport;
      const sb = r && r.supabase;
      const lines = [
        'WatchTogether — تقرير تشخيص الاتصال',
        'التاريخ: ' + new Date().toLocaleString('ar-DZ'),
        'الغرفة: ' + roomId,
        'السيرفر المستخدم: ' + (r && r.active ? r.active.label : '—'),
        'المشروع: ' + (sb ? sb.url : '—'),
        'المفتاح: ' + (sb ? sb.key : '—'),
        'REST: ' + (sb && sb.rest && sb.rest.ok ? 'يعمل (' + sb.rest.ms + 'ms)' : 'فشل'),
        'جدول rooms: ' + (sb && sb.tables && sb.tables.rooms ? 'موجود' : 'مفقود'),
        'جدول messages: ' + (sb && sb.tables && sb.tables.messages ? 'موجود' : 'مفقود'),
        'عمود نصّ الرسالة: ' + (sb && sb.messageField ? sb.messageField : 'غير معروف (body المتوقع)'),
        'جدول room_members (الأدوار): ' + (sb && sb.tables && sb.tables.room_members ? 'موجود' : 'مفقود'),
        'جدول room_queue (قائمة التشغيل): ' + (sb && sb.tables && sb.tables.room_queue ? 'موجود' : 'مفقود'),
        'جدول presence (قديم/اختياري): ' + (sb && sb.tables && sb.tables.presence ? 'موجود' : 'مفقود'),
        'Realtime: ' + (sb && sb.realtime && sb.realtime.ok ? 'يعمل' : 'لا يعمل'),
        ''
      ];
      ((sb && (sb.problems || []).concat(sb.warnings || [])) || []).forEach(p => {
        lines.push('• ' + (p.title || ''), '  ' + (p.detail || ''), '  الحل: ' + (p.fix || ''), '');
      });
      await copy(lines.join('\n'), 'تم نسخ التقرير');
    });

    /* ---- الحساب ---- */
    el.sbMeBtn.addEventListener('click', () => { paintMe(); el.meModal.hidden = false; });
    el.meClose.addEventListener('click', () => { el.meModal.hidden = true; });
    el.meModal.addEventListener('click', (e) => { if (e.target === el.meModal) el.meModal.hidden = true; });
    el.meSave.addEventListener('click', async () => {
      const name = U.cleanName(el.meNameInput.value);
      if (name.length < 2) return U.toast('اسم قصير جداً', 'error');
      session.name = name;
      U.store.set('name', name);
      if (Auth && Auth.currentUser && Auth.currentUser() && !Auth.currentUser().guest) {
        try { await Auth.updateName(name); } catch (e) { /* غير حرج */ }
      }
      paintMe();
      addMember(session.clientId, name, { me: true });
      pingPresence(false);
      publish();
      el.meModal.hidden = true;
      U.toast('تم تحديث اسمك', 'success');
    });
    el.meSignout.addEventListener('click', async () => {
      if (Auth) await Auth.signOut();
      location.href = 'auth.html';
    });

    /* ---- مغادرة ---- */
    el.leaveBtn.addEventListener('click', async () => {
      if (!confirm('مغادرة الغرفة؟')) return;
      goodbye(false);
      setTimeout(() => { location.href = 'index.html'; }, 120);
    });

    /* ---- الرسائل ---- */
    el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitChat();
    });
    if (el.composerBarCancel) el.composerBarCancel.addEventListener('click', () => {
      const wasEdit = !!session.editing;
      clearComposer();
      /* إلغاء التعديل يمسح المسودة؛ إلغاء الرد يُبقي ما كتبه المستخدم */
      if (wasEdit && el.chatInput) { el.chatInput.value = ''; autosize(); }
    });
    el.chatInput.addEventListener('input', () => {
      autosize();
      const now = Date.now();
      if (session.ready && session.transport && now - session.lastTypingSent > 1600) {
        session.lastTypingSent = now;
        const t = session.transport;
        const payload = { type: 'typing', clientId: session.clientId, name: session.name };
        if (t.kind === 'ws' && t._send) t._send(payload);
        else if (t.kind === 'local' && t._bc) t._bc(payload);
      }
    });
    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitChat();
      }
    });
    el.clearChatBtn.addEventListener('click', () => {
      hideMsgMenu();
      pendingReactions.clear();
      el.chatBody.innerHTML = '';
      el.chatEmpty.style.display = '';
      el.chatBody.appendChild(el.chatEmpty);
      clearComposer();
      updateChatCount();
    });
    if (el.refreshChatBtn) el.refreshChatBtn.addEventListener('click', () => { refreshChat(); });

    updateMessagesBadge();
    bindMobileViewport();

    /* ---- اختصارات ---- */
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && session.msgMenu && !session.msgMenu.hidden) {
        e.preventDefault();
        hideMsgMenu(true);
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      const interactive = ['input', 'textarea', 'select', 'button', 'a', 'summary'].includes(tag) || e.target.isContentEditable;
      if (interactive && e.key !== 'Escape') return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(+10); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); skip(-10); }
      else if (e.key.toLowerCase() === 'c') copy(roomUrl(), 'تم نسخ رابط الغرفة');
      else if (e.key.toLowerCase() === 'd') setFocusMode(!session.focusMode);
      else if (e.key === 'Escape') {
        if (!el.playlistModal.hidden) el.playlistModal.hidden = true;
        else if (el.diagModal && !el.diagModal.hidden) closeDiag();
        else if (!el.qrModal.hidden) el.qrModal.hidden = true;
        else if (!el.meModal.hidden) el.meModal.hidden = true;
        else if (el.drawer.classList.contains('is-open')) setDrawerOpen(false);
        else if (session.focusMode) setFocusMode(false);
      }
    });

    /* ---- حفظ الحالة عند المغادرة (خروج آخر مستخدم) ---- */
    window.addEventListener('pagehide', () => goodbye(true));
    window.addEventListener('beforeunload', () => goodbye(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) goodbye(true, true); // Saving on tab switch is not leaving the room.
      else if (session.ready) pingPresence(false);
    });
    window.addEventListener('focus', () => { if (session.focusMode) { session.unread = 0; updateMessagesBadge(); } });
  }

  function openChangeBar() {
    el.changeBar.hidden = false;
    el.newUrl.value = '';
    el.newTitle.value = '';
    el.newUrl.focus();
    el.changeBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setVideoNow(raw) {
    if (!requireControl()) return false;
    const parsed = U.parseWatchUrl(raw);
    if (!parsed) { U.toast('رابط غير صالح — أدخل رابط يوتيوب أو mp4 أو m3u8', 'error'); return false; }
    st.url = parsed.src;
    st.kind = parsed.kind;
    st.pos = 0;
    st.playing = true;
    session.lastAppliedRev = -1;
    loadVideo(parsed, { autoplay: true });
    publish({ force: true });
    sysMessage('غيّر ' + session.name + ' الفيديو');
    return true;
  }

  /* ============================== الوداع وحفظ آخر حالة ============================== */
  let goodbyeDone = false;
  function goodbye(keepAlive, saveOnly) {
    const t = session.transport;
    if (!t) return;

    /* 1) ارفع الحالة الحالية فوراً (خصوصاً إن كنت آخر من سيخرج) */
    try {
      if (session.ready && player.isReady()) {
        const snapshot = Object.assign({}, st, {
          pos: player.canSync() ? player.getCurrentTime() : st.pos,
          playing: player.canSync() ? player.isPlaying() : st.playing,
          t: serverNow(),
          rev: (st.rev || 0) + 1,
          updatedBy: session.clientId,
          updatedByName: session.name,
          final: true                     /* علامة «آخر حفظ» */
        });
        st = snapshot;
        /* Supabase لا يقبل الكتابة المباشرة إلى rooms؛ ارفع الحالة عبر RPC
           الموثّق مع keepalive حتى يحافظ الخادم على الدور والترقيم المركزي. */
        const saved = t.publishState(snapshot, { keepalive: t.kind === 'supabase' || !!keepAlive });
        if (saved && typeof saved.catch === 'function') saved.catch(() => { });
        session.lastPersistAt = Date.now();
      }
    } catch (e) { }

    if (saveOnly) return;

    /* 2) أشعر الآخرين بالمغادرة واحذف صف الحضور */
    if (!goodbyeDone) {
      goodbyeDone = true;
      try {
        if (t.kind === 'supabase' && t._fetch) {
          t._fetch('/rest/v1/presence?room_id=eq.' + encodeURIComponent(roomId) +
            '&client_id=eq.' + encodeURIComponent(session.clientId), { method: 'DELETE' }).catch(() => { });
        } else if (t.kind === 'ws' && t._send) {
          t._send({ type: 'leave', clientId: session.clientId, room: roomId });
        } else if (t.kind === 'local' && t._bc) {
          t._bc({ type: 'leave', clientId: session.clientId });
        }
      } catch (e) { }
      setTimeout(() => { goodbyeDone = false; }, 5000);
    }

    if (!keepAlive) { try { t.close(); } catch (e) { } }
  }

  /* ============================== واجهة صغيرة ============================== */
  /* طبقة التحكم صارت أسفل الفيديو وظاهرة دائماً — لا إخفاء تلقائي */
  function pokeVideoUI() {
    if (!el.player) return;
    el.player.classList.remove('is-ui-hidden');
  }

  function updatePlayIcon() {
    if (!st.playing || !player.isReady()) clearAutoplayPrompt();
    const playing = player.isReady() ? (player.isPlaying() || !!st.playing) : !!st.playing;
    if (el.player) {
      el.player.classList.toggle('is-playing', playing);
      if (!playing) el.player.classList.remove('is-ui-hidden');
    }
    /* الزر الكبير في المنتصف يظهر فقط عندما يكون الفيديو جاهزاً ومتوقفاً */
    if (el.centerPlay) {
      el.centerPlay.hidden = playing || !player.isReady() || !!(el.ctrlbar && el.ctrlbar.hidden);
    }
  }

  function updateProgressUI() {
    if (!player.isReady()) {
      return;
    }
    const cur = player.getCurrentTime();
    const dur = player.getDuration();
    const pct = dur ? U.clamp((cur / dur) * 100, 0, 100) : 0;
    el.progressFill.style.width = pct + '%';
    el.progressKnob.style.insetInlineStart = pct + '%';
    el.progressBar.setAttribute('aria-valuenow', String(Math.round(cur)));

    /* التخزين المؤقت (للملفات و HLS فقط) */
    const v = player._video;
    if (v && v.buffered && v.buffered.length && dur) {
      let end = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= cur && v.buffered.end(i) > end) end = v.buffered.end(i);
      }
      el.progressBuffer.style.width = U.clamp((end / dur) * 100, 0, 100) + '%';
    }
  }

  /* ============================== تشغيل ============================== */
  /* ربط الواجهة مرة واحدة، قبل أي طلب شبكة أو تجديد لجلسة الحساب. */
  wireUI();
  updateControlAccess();
  initGate();

  /* رابط تصحيح: يفيد الاختبارات الآلية، ويفيدك في الكونسول (WTRoom.state) */
  window.WTRoom = {
    roomId,
    session,
    player,
    el,
    get state() { return st; },
    publish,
    onRemoteState,
    diagnose: runDiagnostics,
    openDiag,
    closeDiag,
    reconnect,
    chat: {
      addChatMessage, setReplyTo, startEdit, deleteMessage, commitEdit,
      submitChat, clearComposer, encodeChatText, decodeChatText, findMsgRow, toggleMessageReaction, openMsgMenu,
      refreshChat
    },
    setVideo(url) {
      const parsed = U.parseWatchUrl(url);
      if (!parsed) return false;
      st.url = parsed.src; st.kind = parsed.kind;
      loadVideo(parsed, { autoplay: st.playing });
      publish({ force: true });
      return true;
    }
  };

})();

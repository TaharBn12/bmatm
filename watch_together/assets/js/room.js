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
    room: $('room'), roomTitle: $('roomTitle'), roomSub: $('roomSub'),
    codeText: $('roomCodeText'), copyCodeBtn: $('copyCodeBtn'),
    statusBadge: $('statusBadge'), statusText: $('statusText'),
    copyLinkBtn: $('copyLinkBtn'), shareBtn: $('shareBtn'), qrBtn: $('qrBtn'), leaveBtn: $('leaveBtn'),
    drawer: $('roomDrawer'), drawerScrim: $('drawerScrim'), drawerOpenBtn: $('drawerOpenBtn'), drawerCloseBtn: $('drawerCloseBtn'),
    membersCount: $('membersCount'), organizerList: $('organizerList'), organizerCount: $('organizerCount'), organizerEmpty: $('organizerEmpty'),
    mediaShell: $('mediaShell'),
    stage: $('stage'), player: $('player'), placeholder: $('playerPlaceholder'), ctrlbar: $('ctrlbar'),
    playPause: $('playPauseBtn'), iconPlay: $('iconPlay'), iconPause: $('iconPause'),
    centerPlay: $('centerPlayBtn'),
    muteBtn: $('muteBtn'), iconSound: $('iconSound'), iconMuted: $('iconMuted'),
    progressBar: $('progressBar'), progressFill: $('progressFill'), progressBuffer: $('progressBuffer'),
    progressKnob: $('progressKnob'), progressTip: $('progressTip'), curTime: $('curTime'), durTime: $('durTime'),
    addVideoBtn: $('addVideoBtn'), messagesBtn: $('messagesBtn'), messagesCount: $('messagesCount'),
    playlistBtn: $('playlistBtn'), playlistCount: $('playlistCount'),
    changeBar: $('changeBar'), newUrl: $('newUrl'), newTitle: $('newTitle'), applyUrlBtn: $('applyUrlBtn'), cancelUrlBtn: $('cancelUrlBtn'),
    collapseBtn: $('collapseBtn'), membersPanel: $('membersPanel'), membersList: $('membersList'), sideMembersCount: $('sideMembersCount'),
    chat: $('chat'), chatBody: $('chatBody'), chatEmpty: $('chatEmpty'), chatCount: $('chatCount'),
    clearChatBtn: $('clearChatBtn'), reactRow: $('reactRow'), chatForm: $('chatForm'),
    chatInput: $('chatInput'), chatSend: $('chatSend'), typing: $('typing'), backToVideoBtn: $('backToVideoBtn'),
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
    onEvent: (d) => { if (d.type === 'error') U.toast('حدث خطأ في المشغّل', 'error'); },
    onTime: () => updateProgressUI()
  });

  /* ============================== بوابة الاسم ============================== */
  function initGate() {
    const user = Auth.currentUser();
    const saved = (user && user.name) || U.store.get('name', '') || '';
    if (saved) el.gateName.value = saved;
    paintAvatar();
    el.gateName.addEventListener('input', paintAvatar);

    /* من أنشأ الغرفة وله اسم محفوظ → يدخل مباشرة */
    const autoName = (createInfo && createInfo.name) || (user && user.name) || '';
    if (autoName && (createInfo || params.get('auto') === '1')) {
      session.name = U.cleanName(autoName);
      el.gateName.value = session.name;
      paintAvatar();
      setTimeout(() => { el.gate.hidden = true; enterRoom(); }, 50);
      return;
    }
    el.gateName.focus();

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
  async function enterRoom() {
    el.gate.hidden = true;
    el.room.hidden = false;

    /* هوية المستخدم */
    const user = await (Auth ? Auth.validSession().catch(() => null) : null);
    if (user && user.id) {
      session.userId = user.id;
      session.isGuest = !!user.guest;
      if (!session.name) session.name = U.cleanName(user.name) || 'مستخدم';
    }

    const startUrl = (createInfo && createInfo.videoUrl) || paramVideo || '';
    if (startUrl) {
      const parsed = U.parseWatchUrl(startUrl);
      if (parsed) { st.url = parsed.src; st.kind = parsed.kind; session.videoParsed = parsed; }
    }

    const title = (createInfo && createInfo.title) || U.store.get('roomTitle:' + roomId) || '';
    el.roomTitle.textContent = title || ('غرفة ' + roomId);
    if (title) U.store.set('roomTitle:' + roomId, title);

    paintMe();
    addMember(session.clientId, session.name, { me: true });
    renderPlayerPlaceholder();

    wireUI();
    await connect();
  }

  function paintMe() {
    if (!el.meAvatar) return;
    el.meAvatar.textContent = U.initials(session.name);
    el.meAvatar.style.background = U.colorFor(session.name);
    el.meName.textContent = session.name;
    const user = Auth && Auth.currentUser ? Auth.currentUser() : null;
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
        title: (createInfo && createInfo.title) || el.roomTitle.textContent || 'غرفة مشاهدة',
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

      /* حمّل الفيديو (الموضع يُحسب داخل applyState) */
      if (st.url) await loadVideo(U.parseWatchUrl(st.url), { autoplay: st.playing, initial: true });
      else {
        renderPlayerPlaceholder();
        sysMessage('لا يوجد فيديو في هذه الغرفة بعد — سيظهر تلقائياً حين يبدأ المضيف، أو أضفه من زر «تغيير الفيديو»');
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
    if (el.playPause) el.playPause.disabled = locked;
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
  async function loadVideo(parsed, opts) {
    opts = opts || {};
    if (!parsed) { renderPlayerPlaceholder('الرابط غير مدعوم'); return; }

    session.videoParsed = parsed;
    st.url = parsed.src;
    st.kind = parsed.kind;

    try {
      el.ctrlbar.hidden = parsed.kind === 'embed';
      el.player.classList.toggle('is-embed', parsed.kind === 'embed');
      pokeVideoUI();
      await player.load(parsed, { autoplay: !!opts.autoplay, controls: false });
      if (el.placeholder) { el.placeholder.remove(); el.placeholder = null; }

      /* الموضع: عند الانضمام نحسب الوقت المتوقع، وإلا نستخدم الموضع المحفوظ */
      const target = opts.initial ? expectedPos() : (st.pos || 0);
      if (player.canSync() && target > 0.6) player.seek(target);

      if (opts.autoplay) {
        player.play();
        setTimeout(() => { if (st.playing && !player.isPlaying()) showAutoplayPrompt(); }, 1200);
      }
      updatePlayIcon();
      updateProgressUI();
      updateSyncBadge();
    } catch (err) {
      U.toast('تعذّر تحميل الفيديو — جرّب رابطاً آخر', 'error', 4500);
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
        : 'لا يوجد فيديو في هذه الغرفة بعد.<br>أضف رابطاً من زر «تغيير الفيديو» لبدء المشاهدة معاً.') + '</p>';
    el.player.appendChild(d);
    el.placeholder = d;
  }

  function showAutoplayPrompt() {
    if (session.autoplayBlocked) return;
    session.autoplayBlocked = true;
    const ov = document.createElement('div');
    ov.className = 'player__overlay';
    ov.innerHTML =
      '<div class="player__overlay-box">' +
      '<button class="btn btn--primary btn--lg" id="unblockPlay">' + IC.html('play', 19) + ' اضغط للتشغيل</button>' +
      '<p class="player__overlay-text">متصفحك يمنع التشغيل التلقائي — اضغط الزر لتلتحق بالجميع.</p>' +
      '</div>';
    el.player.appendChild(ov);
    ov.querySelector('#unblockPlay').addEventListener('click', () => {
      player.play();
      st.playing = true;
      ov.remove();
      session.autoplayBlocked = false;
      publish();
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

  /* ============================== الرسائل ============================== */
  function addChatMessage(m, opts) {
    opts = opts || {};
    if (!m) return;
    if (el.chatEmpty) el.chatEmpty.style.display = 'none';

    const mine = !!opts.mine || m.client === session.clientId;
    const row = document.createElement('div');

    if (m.kind === 'system' || opts.system) {
      row.className = 'msg msg--system';
      row.innerHTML = '<div class="msg__bubble">' + U.esc(m.text || '') + '</div>';
    } else if (m.kind === 'react') {
      row.className = 'msg msg--react';
      row.innerHTML = '<div class="react-bubble">' + U.esc(m.text || '👍') +
        '<small>' + U.esc(m.name || '') + '</small></div>';
    } else {
      row.className = 'msg' + (mine ? ' msg--me' : '');
      const color = U.colorFor(m.name || '?');
      row.innerHTML =
        '<span class="msg__avatar" style="background:' + color + '">' + U.esc(U.initials(m.name)) + '</span>' +
        '<div class="msg__bubble">' +
        '<p class="msg__name" style="color:' + color + '">' + U.esc(m.name || 'زائر') + (mine ? ' • أنت' : '') + '</p>' +
        '<p class="msg__text">' + U.linkify(U.esc(m.text || '')) + '</p>' +
        '<p class="msg__time">' + U.fmtClock(m.ts || Date.now()) + '</p>' +
        '</div>';
    }

    el.chatBody.appendChild(row);
    const limit = (CFG.chat && CFG.chat.historyLimit) || 200;
    while (el.chatBody.children.length > limit) el.chatBody.removeChild(el.chatBody.firstChild);

    if (!opts.silent) scrollChat();
    updateChatCount();
    return row;
  }

  function sysMessage(text) {
    addChatMessage({ text, kind: 'system', ts: Date.now(), name: 'النظام' }, { system: true });
  }

  function scrollChat(force) {
    const b = el.chatBody;
    const near = b.scrollHeight - b.scrollTop - b.clientHeight < 180;
    if (near || force) b.scrollTop = b.scrollHeight;
  }

  function updateChatCount() {
    const n = el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
    el.chatCount.textContent = n + (n === 1 ? ' رسالة' : ' رسائل');
  }

  /* الدردشة ظاهرة دائماً في الغرفة (تأخذ المساحة الكبيرة) → لا عدّاد «غير مقروء» */
  function isChatVisible() { return true; }

  function updateMessagesBadge() {
    if (!el.messagesCount) return;
    el.messagesCount.hidden = session.unread === 0;
    el.messagesCount.textContent = session.unread > 99 ? '99+' : String(session.unread);
  }

  function sendMessage(text, kind) {
    text = String(text || '').trim();
    if (!text) return;
    if (!session.ready) { U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn'); return; }

    const now = Date.now();
    if (kind !== 'react' && now - session.lastChatSend < ((CFG.chat && CFG.chat.cooldownMs) || 400)) {
      U.toast('على مهلك', 'warn', 1300); return;
    }
    session.lastChatSend = now;

    const msg = {
      id: U.uid('m'), client: session.clientId, name: session.name,
      text: text.slice(0, (CFG.chat && CFG.chat.maxLength) || 600),
      ts: now, kind: kind || 'chat'
    };
    session.transport.sendChat({ name: msg.name, text: msg.text, kind: msg.kind, client: session.clientId });
    session.recentSent[msg.text + '|' + msg.kind] = now;
    session.recentSent[msg.text] = now;
    setTimeout(() => { delete session.recentSent[msg.text + '|' + msg.kind]; delete session.recentSent[msg.text]; }, 15000);
    addChatMessage(msg, { mine: true });
    scrollChat(true);
  }

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
    t.style.height = Math.min(130, t.scrollHeight) + 'px';
  }

  /* ============================== وضع الرسائل ============================== */
  function setFocusMode(on) {
    session.focusMode = !!on;
    document.body.classList.toggle('chat-focus', session.focusMode);
    if (el.messagesBtn) el.messagesBtn.classList.toggle('is-on', session.focusMode);
    el.backToVideoBtn.hidden = !session.focusMode;
    if (session.focusMode) {
      session.unread = 0;
      updateMessagesBadge();
      setTimeout(() => { scrollChat(true); el.chatInput.focus(); }, 90);
    } else {
      scrollChat(true);
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
    el.playPause.addEventListener('click', togglePlay);
    if (el.centerPlay) el.centerPlay.addEventListener('click', togglePlay);

    /* النقر على سطح الفيديو نفسه يبدّل التشغيل (النقرة المزدوجة تُحسب نقرة واحدة).
       نقرات شريط التحكم والزر الكبير وطبقات التحميل لا تصل إلى هنا. */
    let lastPlayerClick = 0;
    el.player.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest('.vcontrols') || t.closest('.vcenter') ||
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

    /* ---- الصوت: زر كتم فقط (لا شريط صوت) ---- */
    el.muteBtn.addEventListener('click', () => {
      const m = !player.isMuted();
      player.setMuted(m);
      el.iconSound.hidden = m;
      el.iconMuted.hidden = !m;
    });

    /* ---- طيّ الفيديو وإظهاره (يبقى الصوت والتحكم يعملان) ---- */
    if (el.collapseBtn) {
      el.collapseBtn.addEventListener('click', () => {
        const collapsed = el.room.classList.toggle('is-media-collapsed');
        el.collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        el.collapseBtn.classList.toggle('is-on', collapsed);
      });
    }

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
      if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-5); }
      if (e.key === 'ArrowRight') { e.preventDefault(); skip(5); }
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
    el.backToVideoBtn.addEventListener('click', () => setFocusMode(false));

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
      sendMessage(el.chatInput.value, 'chat');
      el.chatInput.value = '';
      autosize();
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
        sendMessage(el.chatInput.value, 'chat');
        el.chatInput.value = '';
        autosize();
      }
    });
    el.clearChatBtn.addEventListener('click', () => {
      el.chatBody.innerHTML = '';
      el.chatEmpty.style.display = '';
      el.chatBody.appendChild(el.chatEmpty);
      updateChatCount();
    });

    /* ---- التفاعلات (الإيموجي هنا فقط) ---- */
    el.reactRow.querySelectorAll('[data-react]').forEach(b => {
      b.addEventListener('click', () => {
        const emoji = (b.dataset && b.dataset.react) || b.getAttribute('data-react');
        sendMessage(emoji, 'react');
        b.animate
          ? b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 260 })
          : null;
      });
    });

    updateMessagesBadge();

    /* ---- اختصارات ---- */
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); el.playPause.click(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(+10); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); skip(-10); }
      else if (e.key.toLowerCase() === 'm') el.muteBtn.click();
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
    document.addEventListener('visibilitychange', () => { if (document.hidden) goodbye(true); });
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
  function goodbye(keepAlive) {
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
    const playing = player.isReady() ? (player.isPlaying() || !!st.playing) : !!st.playing;
    el.iconPlay.hidden = playing;
    el.iconPause.hidden = !playing;
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
      el.curTime.textContent = U.fmtTime(st.pos || 0);
      el.durTime.textContent = '—';
      return;
    }
    const cur = player.getCurrentTime();
    const dur = player.getDuration();
    el.curTime.textContent = U.fmtTime(cur);
    el.durTime.textContent = dur ? U.fmtTime(dur) : '—';
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

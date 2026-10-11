/* =========================================================
   WatchTogether — صفحة الغرفة (room.js)
   المزامنة بكل الحالات: تشغيل/إيقاف/تقديم/تأخير/تبديل الفيديو
   + دخول بالاسم + دردشة + قائمة مشاركين
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const CFG = window.WT_CONFIG;
  const $ = (id) => document.getElementById(id);

  /* ============================== حالة الجلسة ============================== */
  const params = new URLSearchParams(location.search);
  const roomId = (params.get('id') || params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const paramHost = params.get('host') === '1';
  const paramVideo = params.get('v') || '';

  if (!roomId) { location.replace('index.html'); return; }

  let createInfo = null;
  try { createInfo = JSON.parse(sessionStorage.getItem('wt:create:' + roomId) || 'null'); } catch (e) { createInfo = null; }

  const session = {
    clientId: U.uid('client'),
    name: '',
    isHost: false,
    hostId: null,
    ready: false,
    applyingRemote: false,     /* أثناء تطبيق حالة قادمة (لتجنّب الصدى) */
    autoplayBlocked: false,
    lastSyncAt: 0,
    seq: 0,
    lastAppliedSeq: -1,
    transport: null,
    mode: '—',
    members: {},
    lastChatSend: 0,
    unread: 0,
    lastTypingSent: 0,
    typingNames: {},
    videoParsed: null,
    localSeeking: false,
    recentSent: {}
  };

  /* حالة الفيديو المتزامنة */
  let st = {
    url: '',
    kind: '',
    playing: false,
    pos: 0,
    t: 0,          /* وقت الجهاز عند آخر تحديث */
    hostId: null,
    hostName: '',
    seq: 0
  };

  /* ============================== عناصر الواجهة ============================== */
  const el = {
    gate: $('gate'), gateCode: $('gateCode'), gateName: $('gateName'), gateForm: $('gateForm'),
    gateError: $('gateError'), gateSubmit: $('gateSubmit'), avatar: $('avatarPreview'),
    room: $('room'), roomTitle: $('roomTitle'), roomSub: $('roomSub'),
    codeText: $('roomCodeText'), copyCodeBtn: $('copyCodeBtn'),
    statusBadge: $('statusBadge'), statusText: $('statusText'),
    membersBadge: $('membersBadge'), membersCount: $('membersCount'), sideMembersCount: $('sideMembersCount'),
    copyLinkBtn: $('copyLinkBtn'), shareBtn: $('shareBtn'), leaveBtn: $('leaveBtn'),
    player: $('player'), placeholder: $('playerPlaceholder'),
    playPause: $('playPauseBtn'), iconPlay: $('iconPlay'), iconPause: $('iconPause'),
    backBtn: $('backBtn'), fwdBtn: $('fwdBtn'), muteBtn: $('muteBtn'),
    iconSound: $('iconSound'), iconMuted: $('iconMuted'), fullBtn: $('fullBtn'),
    progressBar: $('progressBar'), progressFill: $('progressFill'), curTime: $('curTime'), durTime: $('durTime'),
    hostBadge: $('hostBadge'), takeoverBtn: $('takeoverBtn'), resyncBtn: $('resyncBtn'), changeUrlBtn: $('changeUrlBtn'),
    syncNote: $('syncNote'), syncHost: $('syncHost'), syncNoteTakeover: $('syncNoteTakeover'),
    changeBar: $('changeBar'), newUrl: $('newUrl'), applyUrlBtn: $('applyUrlBtn'), cancelUrlBtn: $('cancelUrlBtn'),
    chat: $('chat'), chatBody: $('chatBody'), chatEmpty: $('chatEmpty'), chatForm: $('chatForm'),
    chatInput: $('chatInput'), chatSend: $('chatSend'), chatCount: $('chatCount'), clearChatBtn: $('clearChatBtn'),
    chatToggleBtn: $('chatToggleBtn'), typing: $('typing'), emojiRow: $('emojiRow'),
    membersList: $('membersList'),
    infoCode: $('infoCode'), infoProvider: $('infoProvider'), infoHost: $('infoHost'), infoRole: $('infoRole'), infoSync: $('infoSync'),
    sideCopyLink: $('sideCopyLink'), sideQr: $('sideQr'),
    sbMode: $('sbMode'), sbSync: $('sbSync'), sbMe: $('sbMe'),
    chatFab: $('chatFab'), chatFabCount: $('chatFabCount'),
    qrModal: $('qrModal'), qrBox: $('qrBox'), qrUrl: $('qrUrl'), qrClose: $('qrClose')
  };

  el.gateCode.textContent = roomId;
  el.codeText.textContent = roomId;
  el.infoCode.textContent = roomId;
  document.title = 'الغرفة ' + roomId + ' — WatchTogether';

  /* ============================== المشغّل ============================== */
  const player = new window.WTPlayer.UnifiedPlayer(el.player, {
    onReady: () => {
      el.placeholder && el.placeholder.remove();
      el.placeholder = null;
      session.applyingRemote = true;
      applyState(st, { initial: true });
      setTimeout(() => { session.applyingRemote = false; }, 400);
      updateProgressUI();
    },
    onStateChange: (d) => {
      if (session.applyingRemote) return;
      if (d.playing === true) { st.playing = true; onLocalAction('play'); }
      else if (d.playing === false) { st.playing = false; onLocalAction('pause'); }
      updatePlayIcon();
    },
    onEvent: (d) => {
      if (d.type === 'error') U.toast('حدث خطأ في المشغّل', 'error');
    },
    onTime: () => updateProgressUI()
  });

  /* ============================== بوابة الاسم ============================== */
  function initGate() {
    const saved = U.store.get('name', '');
    if (saved) el.gateName.value = saved;
    paintAvatar();

    el.gateName.addEventListener('input', paintAvatar);

    el.gateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const name = U.cleanName(el.gateName.value);
      if (name.length < 2) {
        el.gateError.textContent = '⚠️ أدخل اسماً من حرفين على الأقل';
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

    /* إن كان هو منشئ الغرفة وله اسم → ادخل مباشرة */
    if (createInfo && createInfo.host && createInfo.name) {
      session.name = U.cleanName(createInfo.name);
      el.gateName.value = session.name;
      paintAvatar();
      setTimeout(() => { el.gate.hidden = true; enterRoom(); }, 60);
    }
  }

  function paintAvatar() {
    const n = U.cleanName(el.gateName.value) || '؟';
    el.avatar.textContent = U.initials(n);
    el.avatar.style.background = U.colorFor(n);
  }

  /* ============================== الدخول إلى الغرفة ============================== */
  function enterRoom() {
    el.gate.hidden = true;
    el.room.hidden = false;

    /* من أنشأ الغرفة هو المضيف */
    const startAsHost = !!(paramHost || (createInfo && createInfo.host));
    session.isHost = startAsHost;
    session.hostId = startAsHost ? session.clientId : null;
    st.hostId = session.hostId;
    st.hostName = session.name;

    const startUrl = (createInfo && createInfo.videoUrl) || paramVideo || '';
    if (startUrl) {
      const parsed = U.parseWatchUrl(startUrl);
      if (parsed) { st.url = parsed.src; st.kind = parsed.kind; session.videoParsed = parsed; }
    }

    const title = (createInfo && createInfo.title) || U.store.get('roomTitle:' + roomId) || '';
    if (title) { el.roomTitle.textContent = title; U.store.set('roomTitle:' + roomId, title); }
    else el.roomTitle.textContent = 'غرفة ' + roomId;

    el.sbMe.textContent = 'أنت: ' + session.name + (session.isHost ? ' (مضيف 👑)' : '');
    addMember(session.clientId, session.name, session.isHost);   /* أظهَر نفسي فوراً */
    updateRoleUI();
    renderPlayerPlaceholder();

    wireUI();
    connect();
  }

  async function connect() {
    setStatus('connecting', 'جارٍ الاتصال…');

    try {
      const { transport, result } = await window.WTTransport.connectRoom(roomId, {
        clientId: session.clientId,
        name: session.name,
        videoUrl: st.url || null
      }, (s) => setStatus(s.state, s.detail));

      session.transport = transport;
      session.mode = transport.label;
      el.sbMode.textContent = 'الوضع: ' + transport.label;

      /* استرجاع حالة الغرفة المحفوظة */
      if (result.state && result.state.url !== undefined) {
        st = Object.assign(st, result.state);
        session.lastAppliedSeq = st.seq || 0;
      }
      if (result.room && result.room.videoUrl && !st.url) {
        const parsed = U.parseWatchUrl(result.room.videoUrl);
        if (parsed) { st.url = parsed.src; st.kind = parsed.kind; }
      }

      /* غرفة فارغة (لا حالة محفوظة ولا مضيف) → أول داخل يصبح المضيف */
      const emptyRoom = !result.state && !st.hostId;
      if (emptyRoom) session.isHost = true;

      if (session.isHost) {
        session.hostId = session.clientId;
        st.hostId = session.clientId;
        st.hostName = session.name;
        session.lastAppliedSeq = -1;
        publishState(true);
      } else {
        /* ضيف: تبنَّ المضيف من الحالة المحفوظة */
        if (st.hostId) { session.hostId = st.hostId; session.seq = Math.max(session.seq, st.seq || 0); }
      }

      bindTransport(transport);
      session.ready = true;
      updateRoleUI();

      /* حمّل الفيديو */
      if (st.url) await loadVideo(U.parseWatchUrl(st.url), { autoplay: st.playing });

      /* سجّل الدخول وأرسل رسالة نظام + نبضة وجود */
      pingPresence(true);
      sysMessage(`${session.name} دخل الغرفة 👋`);
      el.roomSub.textContent = 'متصل • ' + transport.label;

      /* رسائل سابقة */
      if (result.messages && result.messages.length) {
        result.messages.forEach(m => addChatMessage(m, { silent: true }));
        scrollChat(true);
      }
      updateChatCount();
    } catch (err) {
      console.error(err);
      setStatus('offline', String(err && err.message || err));
      U.toast('تعذّر الاتصال بالغرفة: ' + (err && err.message || ''), 'error', 6000);
    }
  }

  function bindTransport(t) {
    t.on('state', (incoming) => onRemoteState(incoming));
    t.on('chat', (m) => {
      if (!m) return;
      if (m.sender === session.clientId || m.client === session.clientId) return;   /* صدى ذاتي */
      if (m.text && session.recentSent[m.text]) {                /* نسختنا رجعت من السيرفر */
        delete session.recentSent[m.text];
        return;
      }
      addChatMessage(m);
      if (isChatHidden()) { session.unread++; updateFab(); }
    });
    t.on('system', (m) => {
      if (m && m.text) sysMessage(m.text);
    });
    t.on('status', (s) => setStatus(s.state, s.detail));
    t.on('members', (list) => { if (Array.isArray(list)) mergeMembers(list); });
    t.on('presence', (p) => handlePresence(p));
    t.on('typing', (d) => handleTyping(d));
    t.on('error', (e) => { if (e && e.message) U.toast(e.message, 'error'); });
  }

  /* ============================== الحالة: نشر (مضيف) ============================== */
  function nextSeq() {
    session.seq = Math.max(session.seq, st.seq || 0) + 1;
    return session.seq;
  }

  function snapshotState() {
    const p = player.canSync() ? player.getCurrentTime() : st.pos;
    return {
      url: st.url || '',
      kind: st.kind || '',
      playing: player.canSync() ? player.isPlaying() : !!st.playing,
      pos: Number.isFinite(p) ? p : (st.pos || 0),
      t: Date.now(),
      hostId: session.clientId,
      hostName: session.name,
      seq: nextSeq()
    };
  }

  function publishState(force) {
    if (!session.ready || !session.transport) return;
    if (!session.isHost && !force) return;
    const next = force ? Object.assign(snapshotState(), {
      url: st.url, kind: st.kind, playing: !!st.playing, pos: st.pos || 0,
      hostId: session.clientId, hostName: session.name
    }) : snapshotState();

    st = Object.assign(st, next);
    session.lastAppliedSeq = next.seq;
    session.lastSyncAt = Date.now();
    el.sbSync.textContent = 'آخر مزامنة: ' + U.fmtClock(session.lastSyncAt);
    session.transport.publishState(next);
  }

  /* إجراء محلي من المضيف → انشره للجميع */
  let publishTimer = null;
  function onLocalAction(reason) {
    if (!session.isHost) return;             /* الضيف لا ينشر (وضع المتابعة) */
    clearTimeout(publishTimer);
    /* تأخير بسيط لتجميع التغييرات السريعة */
    publishTimer = setTimeout(() => publishState(false), reason === 'seek' ? 220 : 60);
    updateRoleUI();
  }

  /* ============================== الحالة: استقبال ============================== */
  function onRemoteState(incoming) {
    if (!incoming) return;
    if (incoming.hostId && incoming.hostId === session.clientId) return;   /* صدى ذاتي */
    if (typeof incoming.seq === 'number' && incoming.seq <= session.lastAppliedSeq) return; /* قديم */

    /* إذا لم يكن هناك مضيف معروف → هذا هو المضيف */
    if (!session.hostId && incoming.hostId) {
      session.hostId = incoming.hostId;
      if (incoming.hostName) addMember(incoming.hostId, incoming.hostName, true);
    }

    session.lastAppliedSeq = incoming.seq || session.lastAppliedSeq;
    session.lastSyncAt = Date.now();
    el.sbSync.textContent = 'آخر مزامنة: ' + U.fmtClock(session.lastSyncAt);

    const prevUrl = st.url;
    st = Object.assign({}, st, incoming);

    /* تغيير الفيديو؟ */
    if (incoming.url && incoming.url !== prevUrl) {
      const parsed = U.parseWatchUrl(incoming.url);
      if (parsed) {
        sysMessage(`🎞️ ${incoming.hostName || 'المضيف'} غيّر الفيديو`);
        loadVideo(parsed, { autoplay: !!incoming.playing, fromRemote: true });
        return;
      }
    }

    if (!player.isReady() && st.url) {
      loadVideo(U.parseWatchUrl(st.url), { autoplay: !!st.playing, fromRemote: true });
      return;
    }
    applyState(st, {});
  }

  /** تطبيق الحالة على المشغّل (لضيف أو لتحميل أولي) */
  function applyState(s, opts) {
    opts = opts || {};
    if (!player.isReady()) return;

    session.applyingRemote = true;

    /* 1) حساب الوقت المتوقع الآن (نعوّض زمن انتقال الرسالة) */
    const age = Math.max(0, (Date.now() - (s.t || Date.now())) / 1000);
    const expected = (s.pos || 0) + (s.playing ? Math.min(age, 15) : 0);

    /* 2) تشغيل/إيقاف */
    const cur = player.isPlaying();
    if (s.playing && !cur) player.play();
    else if (!s.playing && cur) player.pause();

    /* 3) تصحيح انحراف الوقت */
    if (player.canSync()) {
      const actual = player.getCurrentTime();
      const drift = Math.abs(actual - expected);
      if (drift > (CFG.sync.hardDrift || 3)) {
        player.seek(expected);
        flashSync('🔄 تمت المزامنة (فرق ' + drift.toFixed(1) + ' ث)');
      } else if (drift > (CFG.sync.driftTolerance || 1.2)) {
        /* تصحيح ناعم عبر سرعة التشغيل */
        nudge(actual < expected ? 1.25 : 0.85, 1600);
      } else if (drift > 0.4) {
        nudge(actual < expected ? 1.08 : 0.94, 900);
      }
      el.infoSync.textContent = drift <= 0.4 ? 'ممتازة ✓' : drift <= 1.2 ? 'جيدة (' + drift.toFixed(1) + ' ث)' : 'تصحيح… (' + drift.toFixed(1) + ' ث)';
    }

    updatePlayIcon();
    updateProgressUI();

    setTimeout(() => { session.applyingRemote = false; }, 260);
  }

  let nudgeTimer = null;
  function nudge(rate, ms) {
    const v = player._video;
    if (v) {
      v.playbackRate = rate;
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { try { v.playbackRate = 1; } catch (e) { } }, ms);
    }
  }

  function flashSync(text) {
    U.toast(text, 'success', 1800);
  }

  /* ============================== تحميل الفيديو ============================== */
  async function loadVideo(parsed, opts) {
    opts = opts || {};
    if (!parsed) {
      renderPlayerPlaceholder('⚠️ الرابط غير مدعوم');
      return;
    }
    session.videoParsed = parsed;
    st.url = parsed.src;
    st.kind = parsed.kind;
    U.store.set('roomTitle:' + roomId, el.roomTitle.textContent);
    el.infoProvider.textContent = parsed.label;

    try {
      await player.load(parsed, { autoplay: !!opts.autoplay, controls: true });
      el.placeholder && el.placeholder.remove();
      el.placeholder = null;

      if (opts.autoplay) {
        player.play();
        /* كشف حظر التشغيل التلقائي */
        setTimeout(() => {
          if (st.playing && !player.isPlaying()) showAutoplayPrompt();
        }, 1200);
      }
      if (player.canSync() && typeof st.pos === 'number' && st.pos > 1) player.seek(st.pos);
      updatePlayIcon();
      updateProgressUI();
    } catch (err) {
      U.toast('تعذّر تحميل الفيديو — جرّب رابطاً آخر', 'error', 4500);
    }
  }

  function renderPlayerPlaceholder(text) {
    if (!el.player.querySelector('.player__placeholder')) {
      const d = document.createElement('div');
      d.className = 'player__placeholder';
      d.innerHTML = `<div class="player__placeholder-icon">🎬</div>
        <p class="player__placeholder-text">${text || 'لا يوجد فيديو في هذه الغرفة بعد.<br>الصق رابطاً في الأسفل لبدء المشاهدة معاً.'}</p>`;
      el.player.appendChild(d);
      el.placeholder = d;
    }
  }

  function showAutoplayPrompt() {
    session.autoplayBlocked = true;
    const ov = document.createElement('div');
    ov.className = 'player__overlay';
    ov.innerHTML = `<div class="player__overlay-box">
        <button class="btn btn--primary btn--lg" id="unblockPlay">▶️ اضغط للتشغيل</button>
        <p class="player__overlay-text">متصفحك يمنع التشغيل التلقائي — اضغط الزر للمتابعة مع الجميع.</p>
      </div>`;
    el.player.appendChild(ov);
    ov.querySelector('#unblockPlay').addEventListener('click', () => {
      player.play();
      ov.remove();
      session.autoplayBlocked = false;
      if (session.isHost) publishState(false);
    });
  }

  /* ============================== الحضور (المشاركون) ============================== */
  function addMember(id, name, isHost, extra) {
    if (!id) return;
    const prev = session.members[id];
    session.members[id] = Object.assign({
      id, name: name || 'زائر', host: !!isHost, lastSeen: Date.now(), joined: prev ? prev.joined : Date.now()
    }, extra || {});
    renderMembers();
  }

  function removeMember(id) {
    if (session.members[id]) {
      const n = session.members[id].name;
      delete session.members[id];
      renderMembers();
      sysMessage(`${n} غادر الغرفة 👋`);
    }
  }

  function handlePresence(p) {
    if (!p) return;
    if (p.type === 'leave') return removeMember(p.clientId);
    addMember(p.clientId, p.name, p.host, { typing: p.typing });
    if (p.host && p.clientId !== session.hostId) {
      session.hostId = p.clientId;
      updateRoleUI();
    }
  }

  function mergeMembers(list) {
    const seen = {};
    list.forEach(m => { if (m && m.id) { seen[m.id] = 1; addMember(m.id, m.name, m.host); } });
    Object.keys(session.members).forEach(id => { if (!seen[id] && id !== session.clientId) delete session.members[id]; });
    renderMembers();
  }

  function renderMembers() {
    const list = Object.values(session.members).sort((a, b) => (b.host - a.host) || (a.joined - b.joined));
    if (!list.some(m => m.id === session.clientId)) {
      list.unshift({ id: session.clientId, name: session.name, host: session.isHost, joined: Date.now() });
    }
    el.membersList.innerHTML = list.map(m => `
      <div class="member">
        <span class="member__avatar" style="background:${U.colorFor(m.name)}">${U.esc(U.initials(m.name))}</span>
        <div style="min-width:0;flex:1">
          <p class="member__name">${U.esc(m.name)}${m.id === session.clientId ? ' (أنت)' : ''}</p>
          <p class="member__meta">${m.host ? '👑 مضيف' : 'مشاهد'} • ${m.typing ? 'يكتب…' : 'متصل'}</p>
        </div>
        ${m.host ? '<span class="badge badge--host">👑</span>' : ''}
      </div>`).join('');
    const n = list.length;
    el.membersCount.textContent = n;
    el.sideMembersCount.textContent = n;
  }

  /* نبضة وجود كل 3 ثوانٍ + كشف غياب المضيف */
  function pingPresence(first) {
    addMember(session.clientId, session.name, session.isHost);

    const send = () => {
      const t = session.transport;
      if (!t || !session.ready) return;
      const payload = { type: 'presence', clientId: session.clientId, name: session.name, host: session.isHost, ts: Date.now() };
      if (t.kind === 'ws' && t._send) t._send(payload);
      else if (t.kind === 'supabase') supabasePing();
      else if (t.kind === 'local' && t._bc) t._bc(payload);
      pruneMembers();
      checkHostActivity();
    };

    if (first) send();
    clearInterval(session._pingTimer);
    session._pingTimer = setInterval(send, 3000);
  }

  function supabasePing() {
    const t = session.transport;
    if (!t || !t._fetch) return;
    /* بث فوري لنفس الجهاز (يُستخدم في الوضع المحلي فقط) */
    t.emit('presence', { clientId: session.clientId, name: session.name, host: session.isHost });
    t._fetch('/rest/v1/presence', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: {
        room_id: roomId,
        client_id: session.clientId,
        name: String(session.name || 'زائر').slice(0, 30),
        is_host: !!session.isHost,
        last_seen: new Date().toISOString()
      }
    }).then(() => fetchPresenceList(t)).catch(() => { /* جدول الحضور اختياري */ });
  }

  function fetchPresenceList(t) {
    t._fetch(`/rest/v1/presence?room_id=eq.${encodeURIComponent(roomId)}&select=*&order=last_seen.desc&limit=40`)
      .then(rows => {
        if (!Array.isArray(rows)) return;
        const now = Date.now();
        rows.forEach(r => {
          const seen = Date.parse(r.last_seen) || 0;
          if (now - seen > 15000) return;               /* منتهي */
          addMember(r.client_id, r.name, r.is_host);
        });
      }).catch(() => { });
  }

  function pruneMembers() {
    const now = Date.now();
    Object.values(session.members).forEach(m => {
      if (m.id !== session.clientId && now - m.lastSeen > 12000) delete session.members[m.id];
    });
    renderMembers();
  }

  /* إذا اختفى المضيف → اعرض زر تولّي التحكم */
  function checkHostActivity() {
    if (session.isHost) return;
    const host = session.members[session.hostId];
    const stale = !host || (Date.now() - host.lastSeen > 9000);
    el.takeoverBtn.hidden = !stale;
    if (stale) el.takeoverBtn.textContent = '👑 تولّي التحكم (المضيف غير نشط)';
  }

  function takeover() {
    session.isHost = true;
    session.hostId = session.clientId;
    st.hostId = session.clientId;
    st.hostName = session.name;
    addMember(session.clientId, session.name, true);
    publishState(true);
    updateRoleUI();
    sysMessage(`👑 ${session.name} تولّى التحكم في الغرفة`);
    U.toast('أصبحت المضيف — التحكم الآن بيدك 👑', 'success');
  }

  /* ============================== واجهة الأدوار ============================== */
  function updateRoleUI() {
    const host = session.isHost;
    el.hostBadge.hidden = !host;
    el.takeoverBtn.hidden = host;
    el.syncNote.hidden = host;
    el.infoRole.textContent = host ? 'مضيف 👑 (أتحكم)' : 'مشاهد (وضع المتابعة)';
    const hostMember = Object.values(session.members).find(m => m.host);
    el.infoHost.textContent = host ? session.name : (st.hostName || (hostMember && hostMember.name) || '—');
    if (!host) {
      el.syncHost.textContent = st.hostName || el.infoHost.textContent || 'المضيف';
    }
    /* الضيف: تبهيت أزرار التحكم (ماعدا الصوت وملء الشاشة) */
    [el.playPause, el.backBtn, el.fwdBtn].forEach(b => { b.style.opacity = host ? '1' : '.45'; });
    el.progressBar.style.opacity = host ? '1' : '.6';
    el.sbMe.textContent = 'أنت: ' + session.name + (host ? ' (مضيف 👑)' : '');
  }

  function setStatus(state, detail) {
    const map = {
      connecting: { txt: 'جارٍ الاتصال', cls: '', pulse: false },
      online: { txt: 'متصل ● مباشر', cls: 'badge--live', pulse: true },
      local: { txt: 'وضع محلي', cls: 'badge--host', pulse: false },
      offline: { txt: 'غير متصل', cls: '', pulse: false }
    };
    const m = map[state] || map.offline;
    el.statusBadge.className = 'badge ' + m.cls;
    el.statusText.textContent = m.txt;
    const dot = el.statusBadge.querySelector('.dot');
    if (dot) dot.className = 'dot' + (m.pulse ? ' dot--pulse' : '');
    if (detail) el.roomSub.textContent = detail;
  }

  /* ============================== الدردشة ============================== */
  function addChatMessage(m, opts) {
    opts = opts || {};
    if (!m) return;
    el.chatEmpty && (el.chatEmpty.style.display = 'none');

    const mine = !!opts.mine || m.client === session.clientId;
    const row = document.createElement('div');
    row.className = 'msg' + (mine && !opts.system ? ' msg--me' : '');

    if (opts.system || m.kind === 'system') {
      row.className = 'msg msg--system';
      row.innerHTML = `<div class="msg__bubble">${U.esc(m.text || '')}</div>`;
    } else {
      const color = U.colorFor(m.name || '?');
      row.innerHTML = `
        <span class="msg__avatar" style="background:${color}">${U.esc(U.initials(m.name))}</span>
        <div class="msg__bubble">
          <p class="msg__name" style="color:${color}">${U.esc(m.name || 'زائر')}${mine ? ' • أنت' : ''}</p>
          <p class="msg__text">${U.linkify(U.esc(m.text || ''))}</p>
          <p class="msg__time">${U.fmtClock(m.ts || Date.now())}</p>
        </div>`;
    }
    el.chatBody.appendChild(row);

    /* حدّ أقصى للعناصر في DOM */
    while (el.chatBody.children.length > (CFG.chat.historyLimit || 200)) el.chatBody.removeChild(el.chatBody.firstChild);

    if (!opts.silent) scrollChat();
    updateChatCount();
    return row;
  }

  function sysMessage(text) {
    addChatMessage({ text, kind: 'system', ts: Date.now(), name: 'النظام' }, { system: true, silent: false });
    scrollChat();
  }

  function scrollChat(force) {
    const b = el.chatBody;
    const nearBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 160;
    if (nearBottom || force) b.scrollTop = b.scrollHeight;
  }

  function updateChatCount() {
    const n = el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
    el.chatCount.textContent = n + (n === 1 ? ' رسالة' : ' رسائل');
  }

  function isChatHidden() { return el.chat.classList.contains('is-collapsed'); }

  function updateFab() {
    el.chatFabCount.hidden = session.unread === 0;
    el.chatFabCount.textContent = session.unread > 99 ? '99+' : session.unread;
  }

  function sendChat(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (!session.ready) { U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn'); return; }
    const now = Date.now();
    if (now - session.lastChatSend < (CFG.chat.cooldownMs || 400)) {
      U.toast('على مهلك 🙂', 'warn', 1400); return;
    }
    session.lastChatSend = now;

    const msg = {
      id: U.uid('m'), client: session.clientId, name: session.name,
      text: text.slice(0, CFG.chat.maxLength || 600), ts: now, kind: 'chat'
    };
    session.transport.sendChat({ name: msg.name, text: msg.text, kind: 'chat', client: session.clientId });
    /* نعرضها فوراً لإحساس الاستجابة، ونتجاهل نسختنا عندما ترجع من السيرفر */
    session.recentSent[msg.text] = Date.now();
    setTimeout(() => { delete session.recentSent[msg.text]; }, 15000);
    addChatMessage(msg, { mine: true });
    scrollChat(true);
    el.chatInput.value = '';
    autosize();
  }

  function autosize() {
    const t = el.chatInput;
    t.style.height = 'auto';
    t.style.height = Math.min(120, t.scrollHeight) + 'px';
  }

  function handleTyping(d) {
    if (!d || d.clientId === session.clientId) return;
    session.typingNames[d.clientId] = { name: d.name, at: Date.now() };
    renderTyping();
  }

  function renderTyping() {
    const now = Date.now();
    const names = Object.values(session.typingNames).filter(x => now - x.at < 4000).map(x => x.name);
    el.typing.textContent = names.length ? (names.slice(0, 2).join('، ') + (names.length > 2 ? ' وآخرون' : '') + ' يكتب…') : '';
    Object.values(session.members).forEach(m => { m.typing = false; });
    names.forEach(n => {
      const m = Object.values(session.members).find(x => x.name === n);
      if (m) m.typing = true;
    });
  }
  setInterval(renderTyping, 1500);

  /* ============================== ربط الواجهة ============================== */
  function wireUI() {
    /* --- تشغيل/إيقاف --- */
    el.playPause.addEventListener('click', () => {
      if (!session.isHost) return notHostToast();
      if (!player.isReady()) return U.toast('لم يتم تحميل فيديو بعد', 'warn');
      if (player.isPlaying()) { player.pause(); st.playing = false; }
      else { player.play(); st.playing = true; }
      updatePlayIcon();
      onLocalAction('play');
    });

    /* --- تقديم/ترجيع --- */
    const skip = (delta) => {
      if (!session.isHost) return notHostToast();
      if (!player.isReady()) return;
      const to = Math.max(0, player.getCurrentTime() + delta);
      player.seek(to);
      st.pos = to;
      onLocalAction('seek');
    };
    el.backBtn.addEventListener('click', () => skip(-10));
    el.fwdBtn.addEventListener('click', () => skip(10));

    /* --- كتم --- */
    el.muteBtn.addEventListener('click', () => {
      const m = !player.isMuted();
      player.setMuted(m);
      el.iconSound.hidden = m;
      el.iconMuted.hidden = !m;
    });

    /* --- ملء الشاشة --- */
    el.fullBtn.addEventListener('click', () => {
      const target = el.player;
      if (!document.fullscreenElement) {
        (target.requestFullscreen || target.webkitRequestFullscreen || function () { }).call(target);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () { }).call(document);
      }
    });

    /* --- شريط التقدم --- */
    const seekFromEvent = (ev) => {
      if (!session.isHost) return notHostToast();
      const dur = player.getDuration();
      if (!dur) return;
      const rect = el.progressBar.getBoundingClientRect();
      /* RTL: نحسب من اليمين */
      const ratio = 1 - ((ev.clientX - rect.left) / rect.width);
      const to = U.clamp(ratio, 0, 1) * dur;
      player.seek(to);
      st.pos = to;
      onLocalAction('seek');
      updateProgressUI();
    };
    let dragging = false;
    el.progressBar.addEventListener('pointerdown', (e) => { dragging = true; seekFromEvent(e); el.progressBar.setPointerCapture(e.pointerId); });
    el.progressBar.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
    el.progressBar.addEventListener('pointerup', () => { dragging = false; });

    /* --- مزامنة يدوية --- */
    el.resyncBtn.addEventListener('click', () => {
      if (session.isHost) { publishState(false); U.toast('تم بث حالتك للجميع ✓', 'success'); }
      else { applyState(st, {}); U.toast('تمت المزامنة مع المضيف ✓', 'success'); }
    });

    /* --- تولّي التحكم --- */
    el.takeoverBtn.addEventListener('click', takeover);
    el.syncNoteTakeover.addEventListener('click', takeover);

    /* --- تغيير الرابط --- */
    const openChange = () => {
      el.changeBar.hidden = false;
      el.newUrl.value = st.url || '';
      el.newUrl.focus();
      el.changeBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    el.changeUrlBtn.addEventListener('click', () => {
      if (!session.isHost) return notHostToast();
      openChange();
    });
    el.cancelUrlBtn.addEventListener('click', () => { el.changeBar.hidden = true; });
    el.applyUrlBtn.addEventListener('click', applyNewUrl);
    el.newUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyNewUrl(); } });

    function applyNewUrl() {
      const parsed = U.parseWatchUrl(el.newUrl.value);
      if (!parsed) { U.toast('رابط غير صالح — أدخل رابط يوتيوب أو mp4 أو m3u8', 'error'); return; }
      st.url = parsed.src; st.kind = parsed.kind; st.pos = 0; st.playing = true; st.seq = 0; session.seq = 0;
      session.lastAppliedSeq = -1;
      el.changeBar.hidden = true;
      loadVideo(parsed, { autoplay: true });
      publishState(true);
      sysMessage(`🎞️ تم تغيير الفيديو بواسطة ${session.name}`);
      U.toast('تم تغيير الفيديو للجميع ✓', 'success');
    }

    /* --- نسخ الرابط/الكود --- */
    const roomUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '') + 'room.html?id=' + roomId;
    const copy = async (text, okMsg) => {
      const done = await U.copyText(text);
      U.toast(done ? okMsg : 'تعذّر النسخ — انسخه يدوياً: ' + text, done ? 'success' : 'error', done ? 2200 : 6000);
    };
    el.copyCodeBtn.addEventListener('click', () => copy(roomId, 'تم نسخ كود الغرفة ✓'));
    el.copyLinkBtn.addEventListener('click', () => copy(roomUrl(), 'تم نسخ رابط الغرفة ✓'));
    el.sideCopyLink.addEventListener('click', () => copy(roomUrl(), 'تم نسخ رابط الدعوة ✓'));

    /* --- مشاركة أصلية --- */
    if (navigator.share) {
      el.shareBtn.hidden = false;
      el.shareBtn.addEventListener('click', () => {
        navigator.share({ title: 'شاهدوا معي 🍿', text: 'انضم لغرفتي في WatchTogether', url: roomUrl() }).catch(() => { });
      });
    }

    /* --- QR --- */
    el.sideQr.addEventListener('click', () => {
      const url = roomUrl();
      el.qrUrl.textContent = url;
      el.qrBox.innerHTML = '';
      try {
        if (window.qrcode) {
          /* qrcode-generator 1.4.4 — نستخدم createImgTag لتوافق كل الإصدارات */
          const qr = window.qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          el.qrBox.innerHTML = qr.createImgTag(5, 8);
          const img = el.qrBox.querySelector('img');
          if (img) { img.style.width = '240px'; img.style.height = '240px'; img.style.imageRendering = 'pixelated'; img.alt = 'رابط الدعوة QR'; }
        } else {
          el.qrBox.innerHTML = '<p style="color:#111;font-size:13px">مكتبة QR غير متوفرة</p>';
        }
      } catch (e) {
        el.qrBox.innerHTML = '<p style="color:#111;font-size:13px">تعذّر إنشاء QR</p>';
      }
      el.qrModal.hidden = false;
    });
    el.qrClose.addEventListener('click', () => { el.qrModal.hidden = true; });
    el.qrModal.addEventListener('click', (e) => { if (e.target === el.qrModal) el.qrModal.hidden = true; });

    /* --- مغادرة --- */
    el.leaveBtn.addEventListener('click', async () => {
      if (!confirm('مغادرة الغرفة؟')) return;
      await goodbye();
      location.href = 'index.html';
    });

    /* --- الدردشة --- */
    el.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(el.chatInput.value); });
    el.chatInput.addEventListener('input', () => {
      autosize();
      const now = Date.now();
      if (session.ready && session.transport && now - session.lastTypingSent > 1800) {
        session.lastTypingSent = now;
        const t = session.transport;
        const payload = { type: 'typing', clientId: session.clientId, name: session.name };
        if (t.kind === 'ws' && t._send) t._send(payload);
        else if (t.kind === 'local' && t._bc) t._bc(payload);
      }
    });
    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(el.chatInput.value); }
    });
    el.clearChatBtn.addEventListener('click', () => {
      el.chatBody.innerHTML = '';
      el.chatEmpty.style.display = '';
      el.chatBody.appendChild(el.chatEmpty);
      updateChatCount();
    });

    /* إيموجي سريع */
    el.emojiRow.querySelectorAll('.emoji-btn').forEach(b => {
      b.addEventListener('click', () => {
        el.chatInput.value += b.textContent;
        el.chatInput.focus();
        autosize();
      });
    });

    /* --- زر الدردشة العائم (جوال) --- */
    if (window.matchMedia('(max-width: 720px)').matches) el.chat.classList.add('is-collapsed');
    el.chatFab.addEventListener('click', () => {
      const hidden = isChatHidden();
      el.chat.classList.toggle('is-collapsed', !hidden);
      if (hidden) { session.unread = 0; updateFab(); scrollChat(true); el.chat.scrollIntoView({ behavior: 'smooth', block: 'end' }); el.chatInput.focus(); }
    });
    el.chatToggleBtn.style.display = '';
    el.chatToggleBtn.addEventListener('click', () => {
      el.chat.classList.toggle('is-collapsed');
      el.chatToggleBtn.textContent = isChatHidden() ? '▴' : '▾';
    });

    /* --- اختصارات لوحة المفاتيح --- */
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); el.playPause.click(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); skip(+10); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-10); }
      else if (e.key.toLowerCase() === 'm') el.muteBtn.click();
      else if (e.key.toLowerCase() === 'f') el.fullBtn.click();
      else if (e.key.toLowerCase() === 'c') copy(roomUrl(), 'تم نسخ رابط الغرفة ✓');
    });

    /* --- مغادرة عند إغلاق التبويب --- */
    window.addEventListener('beforeunload', goodbye);
    document.addEventListener('visibilitychange', () => { if (document.hidden) goodbye(true); });

    /* --- كشف الرسائل الجديدة عند العودة للتبويب --- */
    window.addEventListener('focus', () => { if (isChatHidden()) { session.unread = 0; updateFab(); } });
  }

  function notHostToast() {
    U.toast('التحكم بيد المضيف — اضغط «تولّي التحكم» إذا غاب', 'warn', 2600);
    el.syncNote.hidden = false;
  }

  function updatePlayIcon() {
    const playing = player.isReady() ? player.isPlaying() : !!st.playing;
    el.iconPlay.hidden = playing;
    el.iconPause.hidden = !playing;
  }

  function updateProgressUI() {
    if (!player.isReady()) { el.curTime.textContent = '00:00'; el.durTime.textContent = '00:00'; return; }
    const cur = player.getCurrentTime();
    const dur = player.getDuration();
    el.curTime.textContent = U.fmtTime(cur);
    el.durTime.textContent = dur ? U.fmtTime(dur) : '—';
    const pct = dur ? U.clamp((cur / dur) * 100, 0, 100) : 0;
    /* RTL: التعبئة من اليمين */
    el.progressFill.style.width = pct + '%';
  }
  setInterval(() => { if (session.ready) { updateProgressUI(); updatePlayIcon(); } }, 500);

  /* ============================== وداع ============================== */
  let goodbyeDone = false;
  function goodbye(keepAlive) {
    const t = session.transport;
    if (!t) return;
    if (!goodbyeDone) {
      goodbyeDone = true;
      try {
        if (t.kind === 'supabase' && t._fetch) {
          t._fetch(`/rest/v1/presence?room_id=eq.${encodeURIComponent(roomId)}&client_id=eq.${encodeURIComponent(session.clientId)}`,
            { method: 'DELETE' }).catch(() => { });
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

  /* ============================== تشغيل ============================== */
  initGate();

})();

/* =========================================================
   WatchTogether — المكالمات الصوتية (calls.js)
   WebRTC صوتي 1:1 بين صديقين مقبولين.
   • الصوت مباشر بين الجهازين ومشفّر (DTLS-SRTP) — لا يمر بخادمنا.
   • الإشارات (SDP/ICE) عبر RPC محمية في Supabase، ولا تُخزَّن في أي
     قناة عامة. لا مفاتيح إدارة، ولا تسجيل، ولا رفع صوتي.
   • كل حالة واجهة مشتقّة من حالة الخادم أو من WebRTC الحقيقي.
   ========================================================= */
(function (global) {
  'use strict';

  const S = global.WTSocial, U = global.WTUtil, C = global.WTSocialUI, IC = global.WTIcons, CS = global.WTCallState;
  if (!S || !CS) return;
  const $ = (id) => document.getElementById(id);
  const cfg = () => {
    const raw = (global.WT_CONFIG && global.WT_CONFIG.calls) || {};
    return {
      enabled: raw.enabled !== false,
      ringTimeoutMs: Number(raw.ringTimeoutMs) || 45000,
      signalPollMs: Number(raw.signalPollMs) || 900,
      signalPollActiveMs: Number(raw.signalPollActiveMs) || 2600,
      maxCallMs: Number(raw.maxCallMs) || 2 * 3600 * 1000,
      vibrate: raw.vibrate !== false,        /* اهتزاز الهاتف — يُطفأ من config.js */
      iceServers: Array.isArray(raw.iceServers) ? raw.iceServers.slice() : [],
      turn: raw.turn || null,
      turnFetchUrl: raw.turnFetchUrl || null,
      turnFetchTimeoutMs: Number(raw.turnFetchTimeoutMs) || 5000
    };
  };

  const state = {
    thread: null, peer: null, canSend: false,
    call: null, status: CS.STATES.IDLE, reason: '',
    pc: null, stream: null, audio: null, cursor: 0, offerSent: false, answerSent: false,
    pollTimer: null, tickTimer: null, ringTimer: null, startedAt: 0, answeredAt: 0,
    ringer: null, audioCtx: null, muted: false, busy: false, wakeLock: null,
    lastIncoming: 0, ui: null, note: '', turnSource: 'none',
    /* حراسة ضد «المكالمة العالقة»: مؤقّت إعادة الضبط، ومؤقّت انقطاع الخادم */
    resetTimer: null, watchdog: null, lastServerAt: 0, misses: 0, adopted: false, audioBlocked: false,
    pendingIce: [],
    /* تشخيص الصوت: نوع المرشّحات، حالة ICE، وآخر سبب فشل — لعرضه للمستخدم عند الحاجة */
    connectTimer: null, offerRetries: 0, ice: { host: 0, srflx: 0, relay: 0 }, lastError: '', remoteStream: null
  };

  /* ============================== أدوات ============================== */
  const esc = (value) => (U && U.esc ? U.esc(value) : String(value == null ? '' : value));
  const toast = (message, type, ms) => { try { U.toast(message, type, ms); } catch (e) { /* تجاهل */ } };
  const icon = (name, size) => (IC && IC.html ? IC.html(name, size || 18) : '');
  const secure = () => global.isSecureContext !== false || /^(localhost|127\.0\.0\.1)$/.test(global.location.hostname);
  /* اسم مشروع Supabase المتصل — يظهر في رسائل الخطأ لكشف «نفّذت SQL على مشروع آخر». */
  const projectHost = () => {
    try {
      const base = String((global.WT_CONFIG && global.WT_CONFIG.supabase && global.WT_CONFIG.supabase.url) || '');
      return base ? base.replace(/^https?:\/\//, '').replace(/\/$/, '') : String(global.location.hostname || '—');
    } catch (e) { return '—'; }
  };

  function micError(error) {
    const name = (error && (error.name || error.code)) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح ثم أعد المحاولة.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'لم نجد ميكروفوناً متصلاً بهذا الجهاز.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'الميكروفون مستخدم من تطبيق آخر. أغلقه ثم أعد المحاولة.';
    if (name === 'OverconstrainedError') return 'لا يوجد ميكروفون يطابق الإعدادات المطلوبة.';
    if (name === 'SecurityError' || !secure()) return 'المكالمات تحتاج اتصالاً آمناً (HTTPS).';
    return 'تعذّر تشغيل الميكروفون. تحقّق من الجهاز والإذن.';
  }

  async function mic() {
    if (state.stream) return state.stream;
    if (!global.navigator.mediaDevices || typeof global.navigator.mediaDevices.getUserMedia !== 'function') {
      throw Object.assign(new Error('هذا المتصفح لا يدعم الميكروفون.'), { name: 'NotSupportedError' });
    }
    state.stream = await global.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false
    });
    return state.stream;
  }

  /* بيانات TURN مُدخلة من الكونسول للتجربة فقط:
     window.WT_TURN_OVERRIDE = [ {urls, username, credential}, ... ]
     لا تُحفظ ولا تُرسل لأي مكان، وتُنسى عند تحديث الصفحة —
     وبهذا لا تدخل أي بيانات اعتماد إلى المستودع العام. */
  function turnOverride() {
    const raw = global.WT_TURN_OVERRIDE;
    if (!raw) return null;
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw.iceServers) ? raw.iceServers : [raw];
    const cleaned = entries
      .map((entry) => {
        const urls = entry && (entry.urls || entry.url);
        if (!urls) return null;
        return { urls, username: entry.username || '', credential: entry.credential || entry.password || '' };
      })
      .filter((entry) => entry && entry.urls);
    return cleaned.length ? cleaned : null;
  }

  /* بيانات TURN من ملف محلّي (assets/js/turn.local.js):
     مريحة للتجربة، لكنها مرئية لكل زائر — تُفضّل بيانات الوسيط في الإنتاج.
     نتجاهل أي قيمة لم تُملأ بعد (مكان كلمة المرور). */
  const TURN_PLACEHOLDER = /ضع-كلمة|PASSWORD|<|your|TODO|xxx/i;
  function turnLocal() {
    const raw = global.WT_TURN_LOCAL;
    if (!raw) return null;
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw.iceServers) ? raw.iceServers : [raw];
    const cleaned = entries
      .map((entry) => {
        const urls = entry && (entry.urls || entry.url);
        if (!urls) return null;
        const isTurn = /^turns?:/i.test([].concat(urls).join(' '));
        const credential = entry.credential || entry.password || '';
        if (isTurn && (!credential || TURN_PLACEHOLDER.test(credential))) return null;  /* كلمة المرور لم تُملأ */
        if (isTurn && (!entry.username || TURN_PLACEHOLDER.test(entry.username))) return null;
        return { urls, username: entry.username || '', credential };
      })
      .filter(Boolean);
    return cleaned.length ? cleaned : null;
  }

  /* هل في القائمة خادم ترحيل فعلاً؟ STUN وحده لا يكفي على شبكات الجوال. */
  function hasTurn(entries) {
    return (entries || []).some((entry) => /^turns?:/i.test([].concat(entry.urls).join(' ')));
  }

  /* ترويسات طلب الوسيط: نرسل مفتاح المشروع وجلسة المستخدم **فقط** إن كان الوسيط
     على نفس مشروع Supabase — فلا تُسرَّب مفاتيحنا إلى نطاق غريب إن غُيّر الرابط. */
  function turnHeaders(url) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const sb = (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};
      const hostOf = (value) => String(value || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      if (!sb.anonKey || !hostOf(url) || hostOf(url) !== hostOf(sb.url)) return headers;
      headers.apikey = sb.anonKey;
      const session = (global.WTAuth && global.WTAuth.getSession && global.WTAuth.getSession()) || null;
      headers.Authorization = 'Bearer ' + ((session && session.access_token) || sb.anonKey);
    } catch (e) { /* الترويسات تحسين لا شرط: لا نكسر المكالمة بسببها */ }
    return headers;
  }

  /* طلب TURN من وسيط الخادم. يعيد {entries, note} دائماً ولا يرمي أبداً:
     فشل الوسيط يعني فقط «جرّب المصدر التالي»، لا «أوقف المكالمة». */
  async function fetchTurn(conf) {
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    const timer = controller ? global.setTimeout(() => controller.abort(), conf.turnFetchTimeoutMs) : null;
    try {
      const response = await global.fetch(conf.turnFetchUrl, {
        method: 'POST',
        headers: turnHeaders(conf.turnFetchUrl),
        body: '{}',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      /* نقبل ثلاث صيغ شائعة: {urls,...} أو [ {urls,...}, ... ] أو {iceServers:[...]} */
      const entries = Array.isArray(data) ? data
        : Array.isArray(data && data.iceServers) ? data.iceServers
        : data && data.urls ? [data] : [];
      const cleaned = entries
        .map((entry) => {
          const urls = entry && (entry.urls || entry.url);
          if (!urls) return null;
          return { urls, username: entry.username || '', credential: entry.credential || entry.password || '' };
        })
        .filter(Boolean);
      if (!hasTurn(cleaned)) {
        return { entries: cleaned, note: 'لم نستلم خادم ترحيل (TURN)؛ تنجح المكالمة على الواي فاي وقد تفشل على شبكات الجوال.' };
      }
      return { entries: cleaned, note: '' };
    } catch (e) {
      return {
        entries: [],
        note: e && e.name === 'AbortError'
          ? 'تأخّر خادم TURN؛ نكمل بـSTUN (قد تفشل المكالمة على شبكات الجوال).'
          : 'تعذّر جلب بيانات TURN؛ قد تفشل المكالمة على بعض الشبكات.'
      };
    } finally {
      if (timer) global.clearTimeout(timer);
    }
  }

  /* ترتيب مصادر TURN — الأول يُجرَّب أولاً:
     1) تجاوز الكونسول (يدوي، لهذه الجلسة فقط)
     2) وسيط الخادم turnFetchUrl  ← الإنتاج: المفتاح يبقى على الخادم
     3) الملف المحلي turn.local.js ← احتياط: يعمل لكن بياناته مكشوفة لكل زائر
     4) turn ثابت في config.js
     5) STUN عام إن بقيت القائمة فارغة
     كان الوسيط مشروطاً بغياب الملف المحلي، فبقي الملف المكشوف هو المستخدَم دائماً
     ولم يُطلَب الوسيط قط. الآن الوسيط أولاً، والمحلي شبكة أمان إن تعذّر. */
  async function iceServers() {
    const conf = cfg();
    const list = conf.iceServers.slice();
    const override = turnOverride();
    const local = turnLocal();
    if (override) {
      list.push(...override);
      state.note = 'تُستخدم بيانات TURN مؤقتة من الكونسول (تجربة على هذا الجهاز فقط).';
      state.turnSource = 'override';
    } else {
      const fetched = conf.turnFetchUrl ? await fetchTurn(conf) : null;
      if (fetched && hasTurn(fetched.entries)) {
        list.push(...fetched.entries);
        state.turnSource = 'proxy';
      } else if (local) {
        list.push(...local);
        state.turnSource = 'local';
        state.note = fetched
          ? 'تعذّر وسيط TURN؛ رجعنا إلى بيانات ملف محلي (turn.local.js) المكشوفة للزوّار.'
          : 'تُستخدم بيانات TURN من ملف محلي (turn.local.js).';
      } else if (fetched && fetched.entries.length) {
        list.push(...fetched.entries);           /* الوسيط أعطى STUN فقط */
        state.turnSource = 'proxy';
      } else if (conf.turn && conf.turn.urls) {
        const urls = Array.isArray(conf.turn.urls) ? conf.turn.urls : [conf.turn.urls];
        if (urls.length) list.push({ urls, username: conf.turn.username || '', credential: conf.turn.credential || '' });
        state.turnSource = 'static';
      }
      if (fetched && fetched.note && !state.note) state.note = fetched.note;
      if (!hasTurn(list) && !state.note) {
        state.note = 'لم نستلم خادم ترحيل (TURN)؛ تنجح المكالمة على الواي فاي وقد تفشل على شبكات الجوال.';
      }
    }
    if (!list.length) list.push({ urls: 'stun:stun.l.google.com:19302' });
    return list;
  }

  /* ============================== النغمة والاهتزاز ============================== */
  function tone(freq, at, duration, gain) {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0, ctx.currentTime + at);
    amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + at + 0.04);
    amp.gain.linearRampToValueAtTime(0, ctx.currentTime + at + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + duration + 0.05);
  }

  function audioCtx() {
    if (state.audioCtx) return state.audioCtx;
    try {
      const Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null;
      state.audioCtx = new Ctor();
    } catch (e) { state.audioCtx = null; }
    return state.audioCtx;
  }

  /* اهتزاز الهاتف: يتكرّر مع دورة الرنين (كالهاتف الحقيقي) لا مرة واحدة —
     وإلا فالهاتف في الجيب يرنّ مرّة واحدة ثم يصمت وتفوتك المكالمة. */
  function buzz(pattern) {
    try {
      if (cfg().vibrate === false) return;
      if (!global.navigator || typeof global.navigator.vibrate !== 'function') return;
      global.navigator.vibrate(pattern);
    } catch (e) { /* متصفح أو نظام يمنعه */ }
  }

  function startRinger(kind) {
    stopRinger();
    if (!cfg().enabled) return;
    const ctx = audioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const incoming = kind === 'incoming';
    const ring = () => {
      if (incoming) { tone(660, 0, 0.28, 0.05); tone(880, 0.34, 0.28, 0.05); buzz([220, 160, 220]); }
      else { tone(440, 0, 0.22, 0.035); }
    };
    ring();
    state.ringer = global.setInterval(ring, incoming ? 2400 : 3200);
    /* الشاشة لا تُقفل أثناء الرنين: على الهاتف يعني هذا رنيناً بلا إضاءة */
    requestWakeLock();
  }

  function stopRinger() {
    if (state.ringer) { global.clearInterval(state.ringer); state.ringer = null; }
    try { if (cfg().vibrate !== false && global.navigator && global.navigator.vibrate) global.navigator.vibrate(0); } catch (e) { /* تجاهل */ }
  }

  function stopTones() {
    try { state.audioCtx && state.audioCtx.close(); } catch (e) { /* تجاهل */ }
    state.audioCtx = null;
  }

  /* ============================== الواجهة ============================== */
  function ensureUi() {
    if (state.ui) return state.ui;
    const layer = document.createElement('div');
    layer.id = 'wtCallLayer';
    layer.className = 'call-layer';
    layer.hidden = true;
    layer.innerHTML =
      '<div class="call-card" role="dialog" aria-modal="true" aria-labelledby="wtCallTitle" aria-describedby="wtCallStatus">' +
        '<div class="call-card__glow" aria-hidden="true"></div>' +
        '<p class="call-eyebrow" id="wtCallEyebrow">AUDIO CALL</p>' +
        '<div class="call-avatar" id="wtCallAvatar"></div>' +
        '<h2 class="call-title" id="wtCallTitle"></h2>' +
        '<p class="call-status" id="wtCallStatus" role="status" aria-live="polite"></p>' +
        '<div class="call-actions" id="wtCallActions"></div>' +
        '<p class="call-note" id="wtCallNote" hidden></p>' +
        '<p class="call-privacy">الصوت ينتقل مباشرة بين الجهازين ومشفّر — لا يُسجَّل ولا يُخزَّن.</p>' +
      '</div>';
    document.body.appendChild(layer);

    const bar = document.createElement('div');
    bar.id = 'wtCallBar';
    bar.className = 'call-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="call-bar__dot" aria-hidden="true"></span>' +
      '<span class="call-bar__text"><strong id="wtCallBarName"></strong><span id="wtCallBarTime" dir="ltr">00:00</span>' +
        '<span class="call-bar__note" id="wtCallBarNote" hidden></span></span>' +
      '<button class="call-bar__btn" type="button" id="wtCallAudio" aria-label="تشغيل صوت المكالمة" hidden></button>' +
      '<button class="call-bar__btn" type="button" id="wtCallMute" aria-pressed="false" aria-label="كتم الميكروفون"></button>' +
      '<button class="call-bar__btn call-bar__btn--end" type="button" id="wtCallEnd" aria-label="إنهاء المكالمة"></button>';
    document.body.appendChild(bar);

    state.ui = { layer, bar };
    $('wtCallMute').addEventListener('click', toggleMute);
    $('wtCallEnd').addEventListener('click', () => endCall('hangup'));
    $('wtCallAudio').addEventListener('click', () => {
      const audio = state.audio || ensureAudio();
      audio.play().then(() => { state.audioBlocked = false; paint(); })
        .catch(() => toast('لم يسمح المتصفح بالصوت. اضغط زرّ الصوت مرة أخرى.', 'warn', 4000));
    });
    return state.ui;
  }

  function paint() {
    const ui = ensureUi();
    const conf = cfg();
    const call = state.call;
    const peer = (call && call.peer) || state.peer || {};
    const name = peer.display_name || 'رفيقك';
    const live = !!call && CS.isLive(state.status);
    const ringing = CS.isRinging(state.status);
    const terminal = CS.isTerminal(state.status);

    ui.layer.hidden = !(live && ringing);
    ui.bar.hidden = !(live && !ringing) && !(terminal && state.status !== CS.STATES.IDLE);
    document.body.classList.toggle('has-call', live);

    if (ui.layer.hidden && ui.bar.hidden) return;

    if (!ui.layer.hidden) {
      $('wtCallEyebrow').textContent = state.status === CS.STATES.RINGING_IN ? 'INCOMING CALL' : 'CALLING…';
      $('wtCallTitle').textContent = name;
      $('wtCallStatus').textContent = CS.statusText(state.status, name);
      $('wtCallAvatar').innerHTML = C.avatar(peer, 'hero');
      const actions = state.status === CS.STATES.RINGING_IN
        ? '<button class="call-btn call-btn--accept" type="button" id="wtCallAccept">' + icon('phoneCall', 22) + '<span>قبول</span></button>' +
          '<button class="call-btn call-btn--reject" type="button" id="wtCallReject">' + icon('phoneOff', 22) + '<span>رفض</span></button>'
        : '<button class="call-btn call-btn--reject" type="button" id="wtCallCancel">' + icon('phoneOff', 22) + '<span>إلغاء</span></button>';
      $('wtCallActions').innerHTML = actions;
      if ($('wtCallAccept')) $('wtCallAccept').onclick = () => answer(true);
      if ($('wtCallReject')) $('wtCallReject').onclick = () => answer(false);
      if ($('wtCallCancel')) $('wtCallCancel').onclick = () => endCall('hangup');
      const note = $('wtCallNote');
      note.hidden = !state.note && !conf.turnFetchUrl;
      note.textContent = state.note || (conf.turnFetchUrl ? 'يُجهَّز مسار الصوت…' : '');
      const focus = state.status === CS.STATES.RINGING_IN ? $('wtCallAccept') : $('wtCallCancel');
      if (focus && document.activeElement === document.body) { try { focus.focus({ preventScroll: true }); } catch (e) { /* تجاهل */ } }
    }

    if (!ui.bar.hidden) {
      $('wtCallBarName').textContent = name;
      $('wtCallBarTime').textContent = state.status === CS.STATES.ACTIVE
        ? CS.formatDuration(Date.now() - state.answeredAt)
        : CS.statusText(state.status, name);
      const audioBtn = $('wtCallAudio');
      if (audioBtn) {
        audioBtn.hidden = !state.audioBlocked;
        audioBtn.innerHTML = icon('volume', 18);
      }
      const barNote = $('wtCallBarNote');
      if (barNote) {
        const text = state.note || '';
        barNote.hidden = !text;
        barNote.textContent = text;
      }
      $('wtCallMute').innerHTML = icon(state.muted ? 'micOff' : 'mic', 18);
      $('wtCallMute').setAttribute('aria-pressed', String(state.muted));
      $('wtCallMute').disabled = state.status !== CS.STATES.ACTIVE;
      $('wtCallMute').setAttribute('aria-label', state.muted ? 'إلغاء كتم الميكروفون' : 'كتم الميكروفون');
      $('wtCallEnd').innerHTML = icon('phoneOff', 18);
      $('wtCallBarTime').classList.toggle('is-time', state.status === CS.STATES.ACTIVE);
    }
  }

  function startTicker() {
    stopTicker();
    state.tickTimer = global.setInterval(() => {
      if (state.status === CS.STATES.ACTIVE) {
        const elapsed = Date.now() - state.answeredAt;
        if (elapsed > cfg().maxCallMs) { endCall('hangup'); return; }
        if ($('wtCallBarTime') && !$('wtCallBar').hidden) $('wtCallBarTime').textContent = CS.formatDuration(elapsed);
      } else if (CS.isRinging(state.status) && CS.ringExpired(state.call && state.call.created_at, Date.now(), cfg().ringTimeoutMs)) {
        endCall('missed');
      }
    }, 1000);
  }
  function stopTicker() { if (state.tickTimer) { global.clearInterval(state.tickTimer); state.tickTimer = null; } }

  /* ============================== الإشارات ============================== */
  /* كل الإشارات تمرّ في طابور واحد: يمنع وصول مرشّح ICE قبل SDP
     (وإلا يُهمَل المرشّح ويبقى الصوت صامتاً رغم أن الحالة «متصل»). */
  let signalChain = Promise.resolve();
  function putSignal(payload) {
    if (!state.call) return Promise.resolve();
    const callId = state.call.id;
    signalChain = signalChain
      .then(() => S.call('call_signal_put', { p_call: callId, p_payload: payload }))
      .catch(() => null);
    return signalChain;
  }

  function queueIce(candidate) {
    if (!candidate) return;
    state.pendingIce.push(candidate);
    if (state.pendingIce.length > 40) state.pendingIce.shift();
  }
  async function flushIce() {
    const pc = state.pc;
    if (!pc || !pc.remoteDescription) return;
    const pending = state.pendingIce.splice(0);
    for (const candidate of pending) {
      try { await pc.addIceCandidate(candidate); } catch (e) { /* مرشّح متأخر — نتجاهله */ }
    }
  }

  /* دورتان بلا ردّ (≈50 ثانية) = مكالمة ميتة. أقصر من ذلك قد يقطع مكالمة حقيقية
     على شبكة بطيئة، وأطول يترك المستخدم عالقاً. */
  const WATCHDOG_MS = 25000;

  function schedulePoll(delay) {
    if (state.pollTimer) { global.clearTimeout(state.pollTimer); state.pollTimer = null; }
    if (!state.call) return;
    state.pollTimer = global.setTimeout(poll, delay);
  }

  /* حارس المكالمة: إن توقّف الخادم عن الردّ 25 ثانية (شبكة مقطوعة، تبويب مُجمَّد،
     المكالمة أُغلقت من جهاز آخر) نُنهيها محلياً — بدل أن تبقى «جارية» إلى الأبد
     وتحجب أي مكالمة جديدة برسالة «لديك مكالمة جارية بالفعل». */
  function armWatchdog() {
    if (state.watchdog) global.clearTimeout(state.watchdog);
    state.lastServerAt = Date.now();
    state.misses = 0;
    if (!state.call) return;
    state.watchdog = global.setTimeout(watchdogTick, WATCHDOG_MS);
  }
  function watchdogTick() {
    state.watchdog = null;
    if (!state.call || CS.isTerminal(state.status)) return;
    /* التبويب مخفي/الشاشة مقفلة: المتصفح يخفض المؤقّتات، فغياب الردّ ليس دليلاً على الانقطاع */
    if (document.visibilityState === 'hidden') { state.watchdog = global.setTimeout(watchdogTick, WATCHDOG_MS); return; }
    state.misses = (state.misses || 0) + 1;
    if (state.misses < 2) { state.watchdog = global.setTimeout(watchdogTick, WATCHDOG_MS); return; }
    state.note = 'انقطع الاتصال بخادم المكالمة — أنهيناها محلياً.';
    terminate('failed');
    toast('انقطع الاتصال؛ أُنهيت المكالمة. يمكنك الاتصال من جديد.', 'warn', 4200);
  }
  /* مؤقّت الاتصال: من اللحظة التي يُفترض أن يبدأ فيها الصوت. بلا هذا يبقى المستخدم
     أمام «يُفتح مسار الصوت…» بلا نهاية. نعيد إرسال العرض مرة واحدة ثم نُظهر السبب. */
  function armConnect(ms) {
    if (state.connectTimer) global.clearTimeout(state.connectTimer);
    state.connectTimer = global.setTimeout(connectTick, ms || 14000);
  }
  function clearConnect() { if (state.connectTimer) { global.clearTimeout(state.connectTimer); state.connectTimer = null; } }
  async function connectTick() {
    state.connectTimer = null;
    if (!state.call || state.status !== CS.STATES.CONNECTING) return;
    if (state.pc && state.pc.connectionState === 'connected') return;
    if (isCaller() && !state.answerSent && state.offerRetries < 2) {
      state.offerRetries++;
      state.offerSent = false;
      state.note = 'نعيد محاولة فتح مسار الصوت… (' + state.offerRetries + '/2)';
      paint();
      try { await sendOffer(); } catch (error) { state.lastError = String(error && error.message || error); }
      armConnect(14000);
      return;
    }
    const ice = state.pc ? state.pc.iceConnectionState : '—';
    state.note = 'تعذّر إيصال الصوت (' + ice + (state.ice.relay ? ' · TURN متاح' : ' · لا مرشّح TURN') + '). '
      + 'جرّب شبكة أخرى أو أعد الاتصال.';
    paint();
  }
  function clearWatchdog() {
    if (state.watchdog) { global.clearTimeout(state.watchdog); state.watchdog = null; }
  }

  async function poll() {
    state.pollTimer = null;
    const call = state.call;
    if (!call) return;
    try {
      const data = await S.call('call_signal_get', { p_call: call.id, p_after: state.cursor });
      if (!state.call || state.call.id !== call.id) return;
      if (CS.isTerminal(state.status)) return;   /* انتهت أثناء الطلب — لا نعيد إحياءها */
      if (data && data.call) {
        state.call = Object.assign({}, state.call, data.call);
        applyServerState(data.call);
      }
      state.cursor = Number(data && data.cursor) || state.cursor;
      armWatchdog();                       /* الخادم ردّ: المكالمة ما زالت معروفة */
      for (const entry of (data && data.signals) || []) {
        if (!state.call) break;
        /* خطأ في إشارة واحدة (ميكروفون مرفوض، SDP غير صالح) لا يجب أن يُسقط
           بقية الإشارات — كان يترك المكالمة «تُفتح» إلى الأبد. */
        try { await onSignal(entry.payload); }
        catch (error) {
          state.lastError = String((error && (error.name ? error.name + ': ' : '') + (error.message || error)) || '');
          if (/NotAllowed|Permission/i.test(state.lastError)) {
            state.note = 'لم يُسمح بالميكروفون — اسمح به من إعدادات المتصفح ثم أعد الاتصال.';
          } else {
            state.note = 'تعذّر تفعيل الصوت (' + state.lastError.slice(0, 60) + ').';
          }
          paint();
        }
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (error && /المكالمة (غير متاحة|مغلقة)/.test(error.message || '')) { terminate('failed'); return; }
      if (error && /(جارية|غير متاحة)/.test(error.message || '')) { terminate('failed'); return; }
      state.note = 'شبكة متذبذبة — نحاول المزامنة.';
      if (!$('wtCallBar').hidden || !$('wtCallLayer').hidden) paint();
    }
    if (state.call && !CS.isTerminal(state.status)) schedulePoll(state.status === CS.STATES.ACTIVE ? cfg().signalPollActiveMs : cfg().signalPollMs);
  }

  function applyServerState(remote) {
    const next = CS.next(state.status, eventForRemote(remote));
    if (next !== state.status) state.status = next;
    if (['ended', 'missed', 'declined', 'busy', 'failed'].includes(remote.state)) {
      terminate(remote.end_reason || remote.state);
      return;
    }
    if (remote.state !== 'active' || !isCaller() || state.offerSent || state.pc) return;
    /* الخادم يقول «نشطة» ولا يوجد عندنا اتصال ولا عرض مُرسل:
       • الحالة العادية: الطرف الآخر قبل للتوّ → نرسل العرض.
       • الحالة المنسيّة: الصفحة أُعيد تحميلها فاعتمدنا المكالمة بلا وسائط —
         كنّا نبقى صامتين إلى الأبد. الآن نفتح المسار من جديد. */
    if (state.status !== CS.STATES.CONNECTING) { state.status = CS.STATES.CONNECTING; paint(); }
    sendOffer().catch((error) => {
      state.lastError = String((error && error.message) || error);
      state.note = 'تعذّر فتح مسار الصوت (' + state.lastError.slice(0, 60) + '). أنهِ المكالمة وأعد الاتصال.';
      paint();
    });
  }

  function eventForRemote(remote) {
    if (remote.state === 'ringing') return state.status === CS.STATES.IDLE ? (isCaller() ? 'invite' : 'incoming') : state.status;
    if (remote.state === 'active') return state.status === CS.STATES.RINGING_OUT || state.status === CS.STATES.RINGING_IN ? 'accept' : 'connected';
    if (remote.state === 'declined') return 'reject';
    if (remote.state === 'missed') return 'timeout';
    if (remote.state === 'busy' || remote.state === 'failed') return 'fail';
    if (remote.state === 'ended') return 'hangup';
    return state.status;
  }

  async function onSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    const kind = payload.k;
    if (kind === 'offer' && payload.sdp) {
      const pc = state.pc;
      /* عرض ثانٍ بعد أن أجبنا = الطرف الآخر أعاد تحميل الصفحة ويطلب فتح المسار
         من جديد. نعيد الإجابة بدل تجاهلها (كان يُترك صامتاً إلى الأبد). */
      if (state.answerSent && pc && pc.signalingState === 'stable') {
        state.note = 'الطرف الآخر يعيد فتح مسار الصوت…';
        paint();
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await flushIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await putSignal({ k: 'answer', sdp: pc.localDescription });
        armConnect(14000);
        return;
      }
      if (state.answerSent) return;
      await acceptRemoteOffer(payload.sdp);
    } else if (kind === 'answer' && payload.sdp) {
      const pc = state.pc;
      if (!pc || pc.signalingState === 'stable') return;
      if (!pc.remoteDescription) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushIce();
      state.status = CS.STATES.CONNECTING; paint();
    } else if (kind === 'ice' && payload.candidate) {
      const pc = state.pc;
      if (!pc || !pc.remoteDescription) { queueIce(payload.candidate); return; }
      try { await pc.addIceCandidate(payload.candidate); } catch (e) { queueIce(payload.candidate); }
    } else if (kind === 'end') {
      endCall(payload.reason || 'hangup', true);
    }
  }

  function isCaller() {
    const me = (global.WTAuth && global.WTAuth.accountUser && global.WTAuth.accountUser()) || null;
    return !!state.call && !!me && state.call.caller_id === me.id;
  }

  /* ============================== WebRTC ============================== */
  async function ensurePeerConnection() {
    if (state.pc) return state.pc;
    if (typeof global.RTCPeerConnection !== 'function') throw new Error('هذا المتصفح لا يدعم المكالمات الصوتية.');
    const servers = await iceServers();
    const pc = new global.RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 2 });
    const stream = await mic();
    armWatchdog();   /* انتظار إذن الميكروفون قد يطول — لا نعدّه انقطاعاً */
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (event) => {
      const audio = ensureAudio();
      const stream = (event.streams && event.streams[0]) || new global.MediaStream([event.track]);
      state.remoteStream = stream;
      try { audio.removeAttribute('src'); } catch (e) { /* تجاهل */ }
      audio.srcObject = stream;
      audio.muted = false; audio.volume = 1;
      const play = audio.play();
      if (play && play.then) {
        play.then(() => { state.audioBlocked = false; state.note = ''; paint(); })
          .catch(() => {
            /* منع التشغيل التلقائي: نُظهر زرّ «تشغيل الصوت» في الشريط بدل رسالة عابرة */
            state.audioBlocked = true; paint();
            toast('اضغط زرّ الصوت في شريط المكالمة لتسمع الطرف الآخر.', 'info', 4200);
          });
      }
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const plain = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      const raw = String((plain && plain.candidate) || '');
      const kind = / typ (relay|srflx|prflx|host)\b/.exec(raw);
      if (kind && state.ice[kind[1]] !== undefined) state.ice[kind[1]]++;
      putSignal({ k: 'ice', candidate: plain });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearConnect();
        state.status = CS.STATES.ACTIVE; state.answeredAt = state.answeredAt || Date.now();
        state.note = ''; startTicker(); paint(); requestWakeLock();
        verifyAudio(pc);
      } else if (pc.connectionState === 'failed') {
        state.lastError = 'ICE failed (' + pc.iceConnectionState + ')';
        if (!state.offerRetries && isCaller()) { connectTick(); }
        else terminate('failed');
      } else if (pc.connectionState === 'disconnected') {
        state.note = 'انقطع الصوت لحظياً — نحاول الاستعادة…'; paint();
        global.setTimeout(() => {
          if (state.pc === pc && pc.connectionState === 'disconnected') { try { pc.restartIce(); } catch (e) { /* تجاهل */ } }
        }, 8000);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch (e) { /* تجاهل */ }
        global.setTimeout(() => { if (state.pc && state.pc.iceConnectionState === 'failed') terminate('failed'); }, 15000);
      }
    };
    state.pc = pc;
    return pc;
  }

  /* بعد الاتصال: هل يصل صوت فعلاً؟ «متصل» لا تعني «تسمع».
     إن كان الاتصال قائماً بلا بايتات صوت واردة فالمشكلة في الشبكة/المسار (TURN). */
  function verifyAudio(pc) {
    if (!pc || typeof pc.getStats !== 'function') return;
    global.setTimeout(async () => {
      if (state.pc !== pc || state.status !== CS.STATES.ACTIVE) return;
      try {
        const stats = await pc.getStats();
        let found = false, bytes = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
            found = true;
            bytes = Math.max(bytes, Number(report.bytesReceived) || 0);
          }
        });
        if (found && bytes === 0) {
          state.note = 'متصل لكن لا يصل صوت' + (state.ice.relay ? ' (TURN يعمل — المشكلة في الجهاز أو كتم الصوت).' : ' — الشبكة تمنع الاتصال المباشر ولا مرشّح TURN.');
          paint();
        } else if (found) {
          state.note = ''; paint();
        }
      } catch (e) { /* بعض المتصفحات تمنع getStats */ }
    }, 6000);
  }

  function ensureAudio() {
    if (state.audio) return state.audio;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = false;
    audio.volume = 1;
    audio.setAttribute('autoplay', '');
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.className = 'call-audio';
    audio.setAttribute('aria-hidden', 'true');
    document.body.appendChild(audio);
    state.audio = audio;
    return audio;
  }

  /* iOS/Safari: عنصر <audio> لا يُشغَّل إلا بعد أن يعمل مرة واحدة داخل «لمسة مستخدم».
     نشغّل صمتاً قصيراً لحظة الضغط على الاتصال/القبول، فيصبح العنصر مفتوحاً
     ويستطيع استقبال صوت الطرف الآخر لاحقاً بلا رفض. */
  function silentWavUrl() {
    if (state.silentUrl !== undefined) return state.silentUrl;
    try {
      const bytes = new Uint8Array(44 + 160);
      const view = new DataView(bytes.buffer);
      const write = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
      write(0, 'RIFF'); view.setUint32(4, 36 + 160, true); write(8, 'WAVE');
      write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      write(36, 'data'); view.setUint32(40, 160, true);
      state.silentUrl = global.URL.createObjectURL(new global.Blob([bytes], { type: 'audio/wav' }));
    } catch (e) { state.silentUrl = null; }
    return state.silentUrl;
  }
  function primeAudio() {
    const audio = ensureAudio();
    const url = silentWavUrl();
    if (!url) return;
    try {
      if (!audio.srcObject) { audio.src = url; audio.load && audio.load(); }
      const playing = audio.play();
      if (playing && playing.then) playing.then(() => { state.audioBlocked = false; }).catch(() => {});
    } catch (e) { /* تجاهل */ }
  }

  /* iOS/كروم: تشغيل الصوت يحتاج «لمسة مستخدم». أوّل لمسة في الصفحة تفتح القفل
     ونشغّل عنصر الصوت من جديد إن كان قد مُنع. */
  function unlockAudio() {
    const audio = state.audio;
    if (!audio) return;
    const replay = () => {
      const playing = audio.play();
      if (playing && playing.then) playing.then(() => { state.audioBlocked = false; paint(); }).catch(() => {});
    };
    replay();
    try {
      if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
    } catch (e) { /* تجاهل */ }
  }
  document.addEventListener('pointerdown', unlockAudio, true);
  document.addEventListener('touchstart', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);

  async function sendOffer() {
    const pc = await ensurePeerConnection();
    state.offerSent = true;
    state.status = CS.STATES.CONNECTING; paint();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await putSignal({ k: 'offer', sdp: pc.localDescription });
    armConnect(14000);
  }

  async function acceptRemoteOffer(sdp) {
    const pc = await ensurePeerConnection();
    state.status = CS.STATES.CONNECTING; paint();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.answerSent = true;
    await putSignal({ k: 'answer', sdp: pc.localDescription });
    armConnect(14000);
  }

  async function requestWakeLock() {
    try {
      if (!global.navigator.wakeLock || state.wakeLock) return;
      state.wakeLock = await global.navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (e) { /* أفضل جهد */ }
  }
  function releaseWakeLock() {
    try { if (state.wakeLock) state.wakeLock.release(); } catch (e) { /* تجاهل */ }
    state.wakeLock = null;
  }

  /* ============================== دورة المكالمة ============================== */
  /* يصنّف فشل call_start ويحوّله إلى خطوة عملية واحدة.
     درس من الميدان: رسالة واحدة عامة «نفّذ 09-calls.sql» أخفت السبب الحقيقي
     (نسخة قديمة من الدالة، أو مشروع آخر، أو كاش) فصار المستخدم يعيد التنفيذ بلا نهاية. */
  function failureHint(error) {
    const code = String((error && error.code) || '');
    const raw = String((error && (error.raw || error.message)) || '').trim();
    const project = projectHost();
    if (code === 'PGRST203' || /best candidate|ambiguous function/i.test(raw)) {
      return {
        text: 'على الخادم أكثر من نسخة من دوال المكالمات' + (code ? ' (' + code + ')' : '') + '.\n' +
          'نفّذ docs/sql/11-calls-doctor.sql ثم أوامر drop في الصف 60.',
        ms: 12000
      };
    }
    if (error && (error.setup || ['PGRST202', '42883', '42P01'].includes(code) ||
        /does not exist|غير مفعّلة/i.test(raw))) {
      return {
        text: 'لم أجد دوال المكالمات على هذا المشروع' + (code ? ' (' + code + ')' : '') + ' — ' + project + '.\n' +
          '١) نفّذ docs/sql/09-calls.sql كاملاً بلا تحديد جزء من النص.\n' +
          '٢) إن كنت فعلت: نفّذ docs/sql/11-calls-doctor.sql وأرسل الجدول.',
        ms: 15000
      };
    }
    return { text: raw || 'تعذّر بدء المكالمة', ms: 5600 };
  }

  async function start() {
    const conf = cfg();
    if (!conf.enabled) { toast('المكالمات غير مفعّلة على هذا الموقع', 'warn'); return; }
    if (!state.thread) { toast('افتح محادثة أولاً', 'warn'); return; }
    if (state.call) { toast('لديك مكالمة جارية بالفعل', 'warn'); return; }
    const gate = CS.canStart({
      friends: state.canSend,
      blocked: false,
      peerAllowsCalls: !state.peer || state.peer.allow_calls !== false,
      hasActiveCall: !!state.call,
      hasMicApi: !!(global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia),
      secure: secure()
    });
    if (!gate.ok) { toast(gate.reason, 'warn', 4200); return; }
    try { await mic(); }
    catch (error) { toast(micError(error), 'error', 5200); return; }

    state.busy = true;
    clearReset(); clearWatchdog();
    try {
      const data = await S.call('call_start', { p_thread: state.thread, p_media: 'audio' });
      if (!data || !data.call) throw new Error('تعذّر بدء المكالمة');
      state.call = data.call;
      state.peer = data.call.peer || state.peer;
      state.status = CS.STATES.RINGING_OUT;
      state.cursor = 0; state.offerSent = false; state.answerSent = false; state.muted = false;
      state.pendingIce = []; state.adopted = false; state.audioBlocked = false;
      state.startedAt = Date.now(); state.answeredAt = 0; state.note = '';
      primeAudio();
      startRinger('outgoing'); startTicker(); armWatchdog(); paint();
      schedulePoll(500);
      document.dispatchEvent(new CustomEvent('wt:call-started', { detail: { call: state.call } }));
    } catch (error) {
      const hint = failureHint(error);
      const stuck = /مكالمة جارية/.test(String((error && (error.raw || error.message)) || ''));
      if (stuck) {
        /* الحالة الأشهر: مكالمة سابقة لم تُغلق (تبويب أُغلق/شبكة انقطعت) فبقيت على الخادم.
           نعرض على المستخدم إغلاقها صراحةً ثم نحاول مرة واحدة. */
        const clear = await C.confirm({
          title: 'مكالمة سابقة ما زالت مفتوحة',
          body: 'يوجد سجلّ مكالمة لم يُغلق من جلسة سابقة، وهو يمنع بدء مكالمة جديدة. إنهاؤه الآن لن يؤثر على أي مكالمة حقيقية في جهاز آخر.',
          label: 'أنهِ المكالمة السابقة'
        }).catch(() => false);
        if (clear) {
          try {
            const done = await S.call('call_reset');
            state.call = null; state.status = CS.STATES.IDLE;
            paint(); syncButton();
            toast('أُغلقت ' + ((done && done.closed) || 0) + ' مكالمة معلّقة — أعد المحاولة الآن.', 'success', 4200);
          } catch (e) {
            const missing = e && (e.setup || e.status === 404 || e.code === 'PGRST202' || e.code === '42883');
            toast(missing ? 'أعد تنفيذ docs/sql/09-calls.sql لتفعيل الإصلاح.' : (e.message || 'تعذّر الإغلاق.'), 'error', 5200);
          }
        }
        teardown();
        return;
      }
      toast(hint.text, 'error', hint.ms);
      teardown();
    } finally { state.busy = false; }
  }

  async function answer(accept) {
    const call = state.call;
    if (!call) return;
    stopRinger();

    /* الرفض ينهي المكالمة محلياً فوراً — لا نترك المستخدم عالقاً إن فشلت الشبكة */
    if (!accept) {
      const id = call.id;
      try { S.call('call_answer', { p_call: id, p_accept: false }).catch(() => {}); } catch (e) { /* تجاهل */ }
      try { S.call('call_end', { p_call: id, p_reason: 'declined' }).catch(() => {}); } catch (e) { /* تجاهل */ }
      terminate('declined');
      return;
    }

    /* إذن الميكروفون يجب أن يُطلب في نفس «لمسة» المستخدم على iOS،
       وإلا يأتي الطلب لاحقاً من الاستطلاع فيرفضه النظام وتبقى المكالمة صامتة. */
    primeAudio();
    try { await mic(); }
    catch (error) { toast(micError(error), 'error', 5200); return; }

    try {
      await S.call('call_answer', { p_call: call.id, p_accept: true });
    } catch (error) {
      toast(error.message || 'تعذّر الرد', 'error');
      return;
    }
    buzz(70);   /* إحساس ملموس بأن الردّ نجح */
    state.status = CS.STATES.CONNECTING;
    state.answeredAt = Date.now();
    state.offerRetries = 0;
    state.note = '';
    armWatchdog();
    armConnect(14000);
    paint();
    startTicker();
    schedulePoll(300);
  }

  /* الإنهاء محلي أولاً وبلا await: كان انتظار الخادم (حتى 8.5 ثانية) يجعل زرّ
     الإنهاء يبدو ميتاً — وهذا أسوأ عطل يمكن أن يراه المستخدم في مكالمة. */
  function endCall(reason, remote) {
    const finalReason = reason || 'hangup';
    const call = state.call;
    stopRinger();

    /* لا مكالمة معروفة لكن الواجهة ظاهرة؟ نُغلق كل شيء بدل تجاهل الضغطة */
    if (!call) { teardown(); return Promise.resolve(false); }

    const id = call.id;
    terminate(finalReason);

    if (!remote) {
      try { S.call('call_signal_put', { p_call: id, p_payload: { k: 'end', reason: finalReason } }).catch(() => {}); } catch (e) { /* تجاهل */ }
      closeOnServer(id, finalReason, 0);
    }
    return Promise.resolve(true);
  }

  /* إغلاق المكالمة على الخادم مع محاولتين: إن بقيت «نشطة» هناك حجبت مكالمة
     جديدة («لديك مكالمة جارية بالفعل») بينما الواجهة عندنا نظيفة. */
  function closeOnServer(id, reason, attempt) {
    S.call('call_end', { p_call: id, p_reason: reason }, null, { keepalive: true })
      .catch(() => {
        if (attempt >= 2) return;
        global.setTimeout(() => closeOnServer(id, reason, attempt + 1), 1200 * (attempt + 1));
      });
  }

  function terminate(reason) {
    if (!state.call) return;
    const finalReason = reason || 'hangup';
    stopRinger(); stopTicker(); clearWatchdog(); clearConnect(); releaseWakeLock();
    if (state.pollTimer) { global.clearTimeout(state.pollTimer); state.pollTimer = null; }
    state.status = ['missed', 'timeout'].includes(finalReason) ? CS.STATES.MISSED
      : finalReason === 'declined' ? CS.STATES.DECLINED
      : finalReason === 'busy' ? CS.STATES.BUSY
      : finalReason === 'failed' || finalReason === 'error' ? CS.STATES.FAILED
      : CS.STATES.ENDED;
    state.reason = finalReason;
    paint();
    teardownMedia();
    const label = CS.logLabel(finalReason, state.answeredAt ? Date.now() - state.answeredAt : 0);
    buzz(['missed', 'timeout', 'declined', 'failed'].includes(finalReason) ? [140, 90, 140] : 50);
    if (finalReason === 'hangup' || finalReason === 'ended') toast(label, 'info', 2600);
    else if (finalReason === 'declined') toast('لم يُقبل الرد', 'warn', 2600);
    else if (finalReason === 'missed' || finalReason === 'timeout') toast('لم يرد الطرف الآخر', 'warn', 3000);
    else toast('انتهت المكالمة', 'warn', 3000);
    document.dispatchEvent(new CustomEvent('wt:call-logged', { detail: { reason: finalReason } }));
    const ended = state.call;
    resetSoon();
    return ended;
  }

  function resetSoon() {
    clearReset();
    const ended = state.call;
    state.resetTimer = global.setTimeout(() => {
      state.resetTimer = null;
      /* لا نمسح مكالمة بدأت بعد هذه المهلة — نقارن المعرّف لا الكائن،
         لأن الاستطلاع يُنشئ كائناً جديداً لنفس المكالمة. */
      if (state.call && (!ended || state.call.id !== ended.id)) return;
      state.call = null; state.status = CS.STATES.IDLE; state.reason = '';
      state.cursor = 0; state.offerSent = false; state.answerSent = false;
      state.answeredAt = 0; state.startedAt = 0; state.note = '';
      state.adopted = false; state.audioBlocked = false;
      stopTones();
      paint(); syncButton();
    }, 2200);
  }
  function clearReset() {
    if (state.resetTimer) { global.clearTimeout(state.resetTimer); state.resetTimer = null; }
  }

  function teardownMedia() {
    try { if (state.pc) { state.pc.ontrack = null; state.pc.onicecandidate = null; state.pc.close(); } } catch (e) { /* تجاهل */ }
    state.pc = null;
    try { if (state.stream) state.stream.getTracks().forEach((track) => track.stop()); } catch (e) { /* تجاهل */ }
    state.stream = null;
    try { if (state.audio) { state.audio.srcObject = null; state.audio.pause(); state.audio.remove(); } } catch (e) { /* تجاهل */ }
    state.audio = null;
    state.muted = false;
    state.pendingIce = [];
    state.remoteStream = null;
    state.ice = { host: 0, srflx: 0, relay: 0 };
  }

  function teardown() {
    stopRinger(); stopTicker(); clearWatchdog(); clearConnect(); clearReset(); releaseWakeLock(); teardownMedia();
    state.ice = { host: 0, srflx: 0, relay: 0 }; state.offerRetries = 0; state.lastError = '';
    state.call = null; state.status = CS.STATES.IDLE; state.cursor = 0;
    state.adopted = false; state.audioBlocked = false;
    if (state.pollTimer) { global.clearTimeout(state.pollTimer); state.pollTimer = null; }
    paint(); syncButton();
  }

  function toggleMute() {
    if (!state.stream) return;
    state.muted = !state.muted;
    state.stream.getAudioTracks().forEach((track) => { track.enabled = !state.muted; });
    paint();
  }

  /* ============================== الواجهة الخارجية ============================== */
  function attach(context) {
    if (!context) return;
    state.thread = context.id || null;
    state.peer = context.peer || null;
    state.canSend = !!context.canSend;
    syncButton();
    if (!state.call) pollIncoming();
  }

  function syncButton() {
    const button = $('chatCall');
    if (!button) return;
    const conf = cfg();
    const allowed = conf.enabled && state.canSend && !!state.thread && (!state.peer || state.peer.allow_calls !== false) && !state.call;
    button.hidden = !state.canSend;
    button.disabled = !allowed;
    button.setAttribute('aria-disabled', String(!allowed));
    const title = !conf.enabled ? 'المكالمات غير مفعّلة'
      : state.call ? 'مكالمة جارية'
      : !state.canSend ? 'المكالمات للأصدقاء المقبولين فقط'
      : state.peer && state.peer.allow_calls === false ? 'هذا العضو أوقف استقبال المكالمات'
      : 'مكالمة صوتية';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.classList.toggle('is-live', !!state.call);
  }

  /* يعتمد مكالمة قائمة (من هذا الجهاز أو من جلسة سابقة) ويعرض واجهتها.
     هذا ما يمنع الحالة: «المكالمة جارية ولا أجد أين أقطعها» — فالشريط يعود
     مع زرّ الإنهاء حتّى بعد تحديث الصفحة. */
  function adopt(call, why) {
    if (!call || !call.id || state.call) return false;
    state.call = call;
    state.thread = call.thread_id || state.thread;
    state.peer = call.peer || state.peer;
    state.cursor = 0; state.offerSent = false; state.answerSent = false;
    state.startedAt = Date.parse(call.created_at) || Date.now();
    state.answeredAt = call.answered_at ? Date.parse(call.answered_at) : 0;
    state.adopted = true;
    state.note = why || '';
    const me = (global.WTAuth && global.WTAuth.accountUser && global.WTAuth.accountUser()) || null;
    state.status = CS.resumeState(call, me && me.id) || CS.STATES.ACTIVE;
    if (state.status === CS.STATES.RINGING_OUT) startRinger('outgoing');
    else if (state.status === CS.STATES.RINGING_IN) startRinger('incoming');
    else state.note = 'المكالمة من جلسة سابقة — الصوت قد يكون مفصولاً. أنهِها ثم أعد الاتصال.';
    ensureAudio(); armWatchdog(); startTicker(); paint(); syncButton();
    schedulePoll(400);
    return true;
  }

  async function reconcile() {
    if (state.call || !cfg().enabled) return false;
    try {
      const data = await S.call('call_current');
      const call = data && data.call;
      if (!call || !call.id) return false;
      return adopt(call);
    } catch (e) {
      return false;   /* الدالة غير منفّذة بعد — لا نُزعج المستخدم */
    }
  }

  async function pollIncoming() {
    if (state.call || !cfg().enabled) return;
    /* نبحث في أي محادثة لا في المحادثة المفتوحة فقط: كانت المكالمة تفوتك
       إن لم تكن فاتحًا محادثة الطرف المتّصل. */
    const now = Date.now();
    if (now - state.lastIncoming < 2500) return;
    state.lastIncoming = now;
    try {
      const data = await S.call('call_incoming', { p_thread: state.thread || null });
      if (!data || !data.call || state.call) return;
      const call = data.call;
      if (!state.thread) state.thread = call.thread_id || state.thread;
      if (call.state !== 'ringing' || CS.ringExpired(call.created_at, Date.now(), cfg().ringTimeoutMs)) return;
      state.call = call;
      state.peer = call.peer || state.peer;
      state.status = CS.STATES.RINGING_IN;
      state.cursor = 0; state.offerSent = false; state.answerSent = false;
      state.startedAt = Date.now(); state.answeredAt = 0; state.note = '';
      ensureAudio();
      startRinger('incoming'); paint(); syncButton(); schedulePoll(600);
      if (document.visibilityState === 'hidden' && global.Notification && global.Notification.permission === 'granted') {
        try { new global.Notification('مكالمة صوتية من ' + ((call.peer && call.peer.display_name) || 'صديقك'), { body: 'افتح WatchTogether للرد', tag: 'wt-call' }); } catch (e) { /* تجاهل */ }
      }
    } catch (e) { /* لا نُعلن شيئاً عند فشل الفحص */ }
  }

  /* استئناف/إنهاء آمن عند مغادرة الصفحة */
  global.addEventListener('beforeunload', () => { if (state.call) { putSignal({ k: 'end', reason: 'hangup' }); } });
  global.addEventListener('pagehide', () => {
    if (state.call) {
      /* keepalive: يصل الطلب حتّى والع صفحة تُغلق — هذا ما كان يترك مكالمات «عالقة» */
      try { S.call('call_end', { p_call: state.call.id, p_reason: 'hangup' }, null, { keepalive: true }).catch(() => {}); } catch (e) { /* تجاهل */ }
    }
    stopRinger(); stopTicker(); clearWatchdog(); teardownMedia();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    /* العودة من قفل الشاشة: المتصفح أوقف السياق الصوتي ومنع التشغيل —
       نُعيد فتحه ونُظهر زرّ الصوت إن بقي ممنوعاً. */
    try { if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume(); } catch (e) { /* تجاهل */ }
    if (state.call) {
      if (state.remoteStream && state.audio) {
        const playing = state.audio.play();
        if (playing && playing.then) playing.then(() => { state.audioBlocked = false; paint(); }).catch(() => { state.audioBlocked = true; paint(); });
      }
      requestWakeLock();
      armWatchdog();
    } else {
      pollIncoming();
    }
  });

  global.WTCalls = {
    attach, start, answer, end: endCall, syncButton, pollIncoming, reconcile, reset: resetStuck,
    active: () => !!state.call,
    status: () => state.status,
    toggleMute, debug,
    _internal: { cfg, micError, isCaller, adopt, state, failureHint, connectTick }
  };

  /* لقطة تشخيص واحدة: تُنسخ من الكونسول وتُرسَل بدل «الصوت لا يعمل». */
  function debug() {
    const pc = state.pc;
    return {
      status: state.status,
      call: state.call && { id: state.call.id, state: state.call.state, thread: state.call.thread_id },
      peer: state.peer && state.peer.user_id,
      connection: pc ? pc.connectionState : null,
      iceConnection: pc ? pc.iceConnectionState : null,
      signaling: pc ? pc.signalingState : null,
      candidates: Object.assign({}, state.ice),
      hasMic: !!state.stream,
      micTracks: state.stream ? state.stream.getAudioTracks().map((t) => ({ enabled: t.enabled, muted: t.muted, state: t.readyState })) : [],
      remoteStream: !!state.remoteStream,
      audioElement: !!state.audio,
      audioBlocked: state.audioBlocked,
      muted: state.muted,
      offerSent: state.offerSent,
      answerSent: state.answerSent,
      offerRetries: state.offerRetries,
      iceServers: cfg().iceServers.length + (global.WT_TURN_LOCAL ? 1 : 0),
      turnSource: state.turnSource,
      turnProxyConfigured: !!cfg().turnFetchUrl,
      turnLocal: !!turnLocal(),
      note: state.note,
      lastError: state.lastError
    };
  }

  /* إنهاء أي مكالمة عالقة على الخادم (زرّ الإنقاذ) */
  async function resetStuck() {
    try {
      const data = await S.call('call_reset');
      teardown();
      return (data && data.closed) || 0;
    } catch (e) { return 0; }
  }
})(window);

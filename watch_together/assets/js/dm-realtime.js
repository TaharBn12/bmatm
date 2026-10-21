/* =========================================================
   WatchTogether — البثّ الحيّ للرسائل الخاصة (dm-realtime.js)
   عميل خفيف لبروتوكول Supabase Realtime (Phoenix) بلا أي مكتبة:
   • اتصال واحد لكل جلسة، قناة خاصة `wt:user:<uuid>`.
   • يستقبل «إشارات تغيير» فقط (thread/id/version) — لا نصوص رسائل.
     النصّ يُقرأ لاحقاً عبر RPC المحمي، فلا تتجاوز RLS أبداً.
   • عند أي فشل: يتراجع تلقائياً إلى الاستطلاع الدوري في messages.js.
   • لا يعرض أي مؤشّر اتصال تخميني للمستخدم؛ الحالة للاستخدام البرمجي فقط.
   ========================================================= */
(function (global) {
  'use strict';

  const EVENTS = ['message', 'read', 'typing', 'status'];

  function create(options) {
    const opts = options || {};
    const cfg = opts.config || (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};
    const base = String(cfg.url || '').replace(/\/$/, '');
    const anonKey = String(cfg.anonKey || '');
    const uid = String(opts.uid || '');
    const getToken = typeof opts.getToken === 'function' ? opts.getToken : async () => (opts.token || '');
    const heartbeatMs = Math.max(10000, Number(opts.heartbeatMs) || 25000);
    const retryBaseMs = Math.max(10, Number(opts.retryBaseMs) || 1000);
    const retryMaxMs = Math.max(retryBaseMs, Number(opts.retryMaxMs) || 30000);

    const handlers = { message: [], read: [], typing: [], status: [] };
    const state = {
      ws: null, joined: false, closed: false, denied: false, retry: 0, seq: 0,
      hb: null, retryTimer: null, generation: 0, status: 'idle', lastError: ''
    };

    const usable = () => typeof global.WebSocket === 'function' && /^https?:\/\//i.test(base) && !!anonKey && !!uid;

    function emit(name, detail) {
      (handlers[name] || []).forEach((fn) => {
        try { fn(detail); } catch (e) { /* عطل في المستمع لا يُسقط الاتصال */ }
      });
    }
    function setStatus(next, error) {
      state.status = next;
      state.lastError = error || '';
      emit('status', { status: next, error: state.lastError, joined: state.joined });
    }
    function wsUrl() {
      return base.replace(/^http/i, 'ws') + '/realtime/v1/websocket?apikey=' +
        encodeURIComponent(anonKey) + '&vsn=1.0.0';
    }
    function topic() { return 'realtime:wt:user:' + uid.toLowerCase(); }
    function send(event, payload) {
      const ws = state.ws;
      if (!ws || ws.readyState !== 1) return false;
      try {
        ws.send(JSON.stringify({ topic: topic(), event, payload: payload || {}, ref: String(++state.seq) }));
        return true;
      } catch (e) { return false; }
    }
    function scheduleRetry() {
      if (state.closed || state.retryTimer) return;
      const delay = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.min(state.retry++, 5)));
      state.retryTimer = global.setTimeout(() => { state.retryTimer = null; connect(); }, delay);
    }
    function stopHeartbeat() {
      if (state.hb) { global.clearInterval(state.hb); state.hb = null; }
    }
    function handleFrame(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.event === 'phx_reply') {
        const status = msg.payload && msg.payload.status;
        if (status === 'ok') {
          if (!state.joined) {
            state.joined = true;
            state.retry = 0;
            stopHeartbeat();
            state.hb = global.setInterval(() => { if (!send('heartbeat', {})) scheduleRetry(); }, heartbeatMs);
            setStatus('open', '');
          }
        } else if (status === 'error') {
          /* القناة مرفوضة (غالباً سياسة RLS غير منفّذة) — نعود للاستطلاع بهدوء
             ونعيد المحاولة ببطء كي تلتقط التنفيذ اللاحق لـ10-dm-realtime.sql. */
          state.joined = false;
          state.denied = true;
          stopHeartbeat();
          setStatus('denied', 'تعذّر الاشتراك في القناة الخاصة؛ نعمل بالاستطلاع الدوري.');
          const socket = state.ws;
          state.ws = null;
          try { if (socket) socket.close(); } catch (e) { /* تجاهل */ }
          if (!state.retryTimer && !state.closed) {
            state.retryTimer = global.setTimeout(() => {
              state.retryTimer = null;
              state.denied = false;
              connect();
            }, 60000);
          }
        }
        return;
      }
      if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        state.joined = false;
        return;
      }
      if (msg.event === 'broadcast' && msg.payload) {
        const name = msg.payload.event;
        if (EVENTS.includes(name) && msg.payload.payload) emit(name, msg.payload.payload);
      }
    }
    function connect() {
      if (state.closed || !usable()) return;
      if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
      const generation = ++state.generation;
      let ws;
      try { ws = new global.WebSocket(wsUrl()); }
      catch (e) { setStatus('offline', 'تعذّر فتح قناة البثّ؛ نعمل بالاستطلاع الدوري.'); scheduleRetry(); return; }
      state.ws = ws;
      setStatus('connecting', '');

      ws.onopen = async () => {
        if (generation !== state.generation) return;
        let token = '';
        try { token = await getToken(); } catch (e) { token = ''; }
        if (generation !== state.generation) return;
        if (!token) { setStatus('offline', 'لا جلسة صالحة للبثّ؛ نعمل بالاستطلاع الدوري.'); try { ws.close(); } catch (e) { /* تجاهل */ } return; }
        try {
          ws.send(JSON.stringify({
            topic: topic(),
            event: 'phx_join',
            ref: String(++state.seq),
            payload: {
              config: { broadcast: { self: false }, presence: { key: uid }, private: true },
              access_token: token
            }
          }));
        } catch (e) { scheduleRetry(); }
      };
      ws.onmessage = (event) => {
        if (generation !== state.generation) return;
        handleFrame(event && event.data);
      };
      ws.onclose = () => {
        if (generation !== state.generation) return;
        stopHeartbeat();
        state.joined = false;
        state.ws = null;
        if (state.closed || state.denied) return;
        setStatus(navigator.onLine === false ? 'offline' : 'connecting', 'انقطع البثّ الحيّ؛ سنعيد المحاولة.');
        scheduleRetry();
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { scheduleRetry(); } };
    }

    if (global.addEventListener) {
      global.addEventListener('online', () => { state.retry = 0; if (!state.joined) connect(); });
      global.addEventListener('offline', () => { stopHeartbeat(); setStatus('offline', 'أنت دون اتصال.'); });
    }

    connect();

    return {
      on(name, fn) {
        if (!handlers[name] || typeof fn !== 'function') return () => {};
        handlers[name].push(fn);
        /* من يشترك متأخراً يعرف الحالة الحالية بدل انتظار تغييرها */
        if (name === 'status') {
          try { fn({ status: state.status, error: state.lastError, joined: state.joined }); } catch (e) { /* تجاهل */ }
        }
        return () => { const i = handlers[name].indexOf(fn); if (i >= 0) handlers[name].splice(i, 1); };
      },
      status: () => state.status,
      joined: () => !!state.joined,
      usable,
      retryNow() { state.retry = 0; if (!state.joined) connect(); },
      close() {
        state.closed = true;
        stopHeartbeat();
        if (state.retryTimer) { global.clearTimeout(state.retryTimer); state.retryTimer = null; }
        try { if (state.ws) state.ws.close(); } catch (e) { /* تجاهل */ }
        state.ws = null; state.joined = false;
        setStatus('closed', '');
      },
      _internal: { state, topic, handleFrame, connect }
    };
  }

  global.WTDMRealtime = { create, EVENTS };
})(window);

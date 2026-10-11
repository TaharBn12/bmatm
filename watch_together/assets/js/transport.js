/* =========================================================
   WatchTogether — طبقة المزامنة (transport.js)
   ---------------------------------------------------------
   ثلاثة أوضاع تعمل تلقائياً حسب استضافتك:
     1) ws      → سيرفر Java المرفق (Tomcat / VPS / معاينة حية)
     2) supabase→ جداول Supabase + Realtime (أي استضافة عادية: cPanel/Netlify)
     3) local   → وضع محلي احتياطي (نفس المتصفح/نفس الجهاز) للتجربة بدون سيرفر

   الواجهة الموحّدة:
     t.connect(roomId, meta) → { state, messages }
     t.publishState(state)
     t.sendChat({name, text, kind})
     t.close()
     t.on('state'|'chat'|'system'|'status'|'error', fn)
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;

  /* ============================== القاعدة المشتركة ============================== */
  function Emitter() {
    const map = {};
    return {
      on(ev, fn) { (map[ev] = map[ev] || []).push(fn); return this; },
      off(ev, fn) { if (map[ev]) map[ev] = map[ev].filter(f => f !== fn); },
      emit(ev, data) { (map[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
    };
  }

  function makeBase(kind, label) {
    const em = Emitter();
    this.kind = kind;
    this.label = label;
    this.connected = false;
    this.on = em.on.bind(em);
    this.off = em.off.bind(em);
    this.emit = em.emit.bind(em);
    this._setStatus = (state, detail) => {
      this.status = state;                 /* connecting | online | local | offline */
      this.statusDetail = detail || '';
      this.emit('status', { state, detail: this.statusDetail, kind: this.kind, label: this.label });
    };
  }
  makeBase.prototype.publishState = function () { };
  makeBase.prototype.sendChat = function () { };
  makeBase.prototype.close = function () { };

  /* ============================== 1) WebSocket (سيرفر Java) ============================== */
  function WsTransport(url) {
    makeBase.call(this, 'ws', 'سيرفر Java');
    this.url = url;
    this._seq = 0;
    this._closedByUser = false;
    this._retry = 0;
  }
  WsTransport.prototype = Object.create(makeBase.prototype);

  WsTransport.prototype.connect = function (roomId, meta) {
    const self = this;
    this.roomId = roomId; this.meta = meta || {};
    this._setStatus('connecting');

    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { return reject(e); }
      this.ws = ws;

      const fail = (err) => {
        try { ws.close(); } catch (e) { }
        reject(err || new Error('ws-failed'));
      };

      ws.onopen = () => {
        self._retry = 0;
        self._send({ type: 'join', room: roomId, client: self.meta.clientId, name: self.meta.name });
      };

      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }

        if (msg.type === 'welcome') {
          self.connected = true;
          self._setStatus('online', 'متصل بسيرفر Java');
          self.serverTime = msg.serverTime || Date.now();
          resolve({ state: msg.state || null, messages: msg.messages || [], members: msg.members || [] });
          return;
        }
        if (msg.type === 'state') {
          if (msg.sender && msg.sender === self.meta.clientId) return;
          return self.emit('state', msg.state);
        }
        if (msg.type === 'chat') {
          const m = msg.message || {};
          m.sender = msg.sender || null;
          return self.emit('chat', m);
        }
        if (msg.type === 'presence') return self.emit('presence', msg);
        if (msg.type === 'typing') return self.emit('typing', msg);
        if (msg.type === 'members') return self.emit('members', msg.members || []);
        if (msg.type === 'system') return self.emit('system', msg);
        if (msg.type === 'error') return self.emit('error', msg);
      };

      ws.onclose = () => {
        const wasConnected = self.connected;
        self.connected = false;
        self._setStatus('offline', 'انقطع الاتصال بالسيرفر');
        self.emit('system', { text: wasConnected ? 'انقطع الاتصال… جارٍ إعادة المحاولة' : 'تعذّر الاتصال بالسيرفر' });
        if (!self._closedByUser && wasConnected) {
          const delay = Math.min(8000, 800 * Math.pow(2, self._retry++));
          setTimeout(() => {
            if (self._closedByUser) return;
            self.connect(roomId, meta).then(
              () => self.emit('system', { text: 'تمت إعادة الاتصال ✓' }),
              () => { }
            );
          }, delay);
        } else if (!wasConnected) {
          fail(new Error('ws-closed'));
        }
      };

      ws.onerror = () => fail(new Error('ws-error'));
    });
  };

  WsTransport.prototype._send = function (obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  };
  WsTransport.prototype.publishState = function (state) {
    this._send({ type: 'state', room: this.roomId, state });
  };
  WsTransport.prototype.sendChat = function (message) {
    const m = Object.assign({ id: U.uid('m'), ts: Date.now(), room: this.roomId, client: this.meta.clientId }, message);
    this._send({ type: 'chat', room: this.roomId, message: m });
    return m;
  };
  WsTransport.prototype.close = function () {
    this._closedByUser = true;
    try { this.ws && this.ws.close(); } catch (e) { }
  };

  /* ============================== 2) Supabase (REST + Realtime) ============================== */
  function SupabaseTransport(cfg) {
    makeBase.call(this, 'supabase', 'Supabase');
    this.cfg = cfg;
    this.rest = cfg.url.replace(/\/$/, '');
    this.headers = {
      'apikey': cfg.anonKey,
      'Authorization': 'Bearer ' + cfg.anonKey,
      'Content-Type': 'application/json'
    };
    this._closedByUser = false;
    this._retry = 0;
    this._hbTimer = null;
  }
  SupabaseTransport.prototype = Object.create(makeBase.prototype);

  SupabaseTransport.prototype._fetch = function (path, options) {
    options = options || {};
    return fetch(this.rest + path, {
      method: options.method || 'GET',
      headers: Object.assign({}, this.headers, options.headers || {}),
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(async (r) => {
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        throw new Error('supabase: ' + msg);
      }
      return data;
    });
  };

  SupabaseTransport.prototype.connect = function (roomId, meta) {
    const self = this;
    this.roomId = roomId; this.meta = meta || {};
    this._setStatus('connecting');

    /* أ) جلب حالة الغرفة + آخر الرسائل */
    const pState = this._fetch(`/rest/v1/rooms?room_id=eq.${encodeURIComponent(roomId)}&select=*&limit=1`)
      .then(rows => (rows && rows[0]) || null);
    const pMsgs = this._fetch(`/rest/v1/messages?room_id=eq.${encodeURIComponent(roomId)}&select=*&order=created_at.desc,id.desc&limit=100`)
      .then(rows => (rows || []).reverse().map(r => ({
        id: String(r.id), name: r.name, text: r.body, ts: Date.parse(r.created_at) || Date.now(), kind: r.kind || 'chat'
      })));

    return Promise.all([pState, pMsgs]).then(([roomRow, messages]) => {
      /* ب) إنشاء الغرفة إن لم تكن موجودة */
      const ensure = roomRow ? Promise.resolve(roomRow) : self._fetch('/rest/v1/rooms', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: {
          room_id: roomId,
          video_url: (self.meta.videoUrl || null),
          host_name: self.meta.name || 'مضيف',
          state: null
        }
      }).then(rows => (rows && rows[0]) || null);

      return ensure.then((row) => {
        const state = row && row.state ? row.state : null;
        self._openRealtime();
        return {
          state,
          messages,
          room: { videoUrl: row && row.video_url, hostName: row && row.host_name }
        };
      });
    }).catch((err) => {
      self._setStatus('offline', String(err && err.message || err));
      throw err;
    });
  };

  SupabaseTransport.prototype._wsUrl = function () {
    return this.rest.replace(/^http/, 'ws') +
      '/realtime/v1/websocket?apikey=' + encodeURIComponent(this.cfg.anonKey) + '&vsn=1.0.0';
  };

  SupabaseTransport.prototype._openRealtime = function () {
    const self = this;
    if (this._closedByUser) return;
    const topic = 'room:' + this.roomId;
    let ws;
    try { ws = new WebSocket(this._wsUrl()); } catch (e) { return; }
    this.ws = ws;
    let joined = false;

    const cfgPayload = {
      config: {
        broadcast: { self: false },
        presence: { key: this.meta.clientId || U.uid('c') },
        postgres_changes: [{
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: 'room_id=eq.' + this.roomId
        }, {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: 'room_id=eq.' + this.roomId
        }]
      }
    };

    const send = (t, payload) => ws.send(JSON.stringify({ topic, event: t, payload: payload || {}, ref: t === 'heartbeat' ? String(++self._seq) : null }));

    ws.onopen = () => {
      send('phx_join', Object.assign({ access_token: self.cfg.anonKey }, cfgPayload));
    };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === 'phx_reply' && msg.payload && msg.payload.status === 'ok') {
        if (!joined) {
          joined = true;
          self.connected = true;
          self._retry = 0;
          self._setStatus('online', 'متصل بـ Supabase Realtime');
          clearInterval(self._hbTimer);
          self._hbTimer = setInterval(() => { if (ws.readyState === 1) send('heartbeat', {}); }, 25000);
        }
        return;
      }
      if (msg.event === 'postgres_changes') {
        const changes = (msg.payload && msg.payload.data && msg.payload.data.changes) || [];
        changes.forEach((c) => {
          const rec = c.record || {};
          if (c.table === 'messages') {
            if (c.type === 'DELETE') return;
            self.emit('chat', {
              id: String(rec.id), name: rec.name, text: rec.body,
              ts: Date.parse(rec.created_at) || Date.now(), kind: rec.kind || 'chat'
            });
          } else if (c.table === 'rooms' && c.type === 'UPDATE') {
            if (rec.state) self.emit('state', rec.state);
          }
        });
      }
    };

    const reconnect = () => {
      if (self._closedByUser) return;
      self.connected = false;
      self._setStatus('connecting', 'إعادة الاتصال بـ Supabase…');
      clearInterval(self._hbTimer);
      const delay = Math.min(10000, 1000 * Math.pow(2, self._retry++));
      setTimeout(() => self._openRealtime(), delay);
    };
    ws.onclose = reconnect;
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
  };

  SupabaseTransport.prototype.publishState = function (state) {
    /* حفظ الحالة في جدول rooms → يصل لكل المشاركين عبر Realtime */
    return this._fetch('/rest/v1/rooms', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: {
        room_id: this.roomId,
        state,
        updated_at: new Date().toISOString(),
        host_name: this.meta.name || 'مضيف'
      }
    }).catch((err) => {
      this.emit('error', { message: 'تعذّر حفظ حالة الغرفة: ' + (err.message || err) });
    });
  };

  SupabaseTransport.prototype.sendChat = function (message) {
    const local = {
      id: U.uid('m'), name: message.name, text: message.text,
      ts: Date.now(), kind: message.kind || 'chat'
    };
    this._fetch('/rest/v1/messages', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: {
        room_id: this.roomId,
        name: String(message.name || 'زائر').slice(0, 30),
        body: String(message.text || '').slice(0, 1000),
        kind: message.kind || 'chat',
        client_id: this.meta.clientId || null
      }
    }).catch((err) => {
      this.emit('error', { message: 'تعذّر إرسال الرسالة: ' + (err.message || err) });
    });
    return local;
  };

  SupabaseTransport.prototype.close = function () {
    this._closedByUser = true;
    clearInterval(this._hbTimer);
    try { this.ws && this.ws.close(); } catch (e) { }
  };

  /* ============================== 3) وضع محلي (BroadcastChannel) ============================== */
  function LocalTransport() {
    makeBase.call(this, 'local', 'وضع محلي');
    this._closedByUser = false;
  }
  LocalTransport.prototype = Object.create(makeBase.prototype);

  LocalTransport.prototype.connect = function (roomId, meta) {
    const self = this;
    this.roomId = roomId; this.meta = meta || {};
    /* مفاتيح منفصلة حتى لا تطمس الرسائلُ حالةَ المزامنة */
    this._key = 'wt:local:bus:' + roomId;        /* قناة النقل بين التبويبات */
    this._stateKey = 'local:state:' + roomId;    /* آخر حالة مزامنة */
    this._msgsKey = 'local:msgs:' + roomId;      /* آخر الرسائل */
    this._setStatus('connecting');

    return new Promise((resolve) => {
      try {
        self.bc = ('BroadcastChannel' in global) ? new BroadcastChannel('wt-' + roomId) : null;
      } catch (e) { self.bc = null; }

      if (self.bc) {
        self.bc.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.from === self.meta.clientId) return;   /* تجاهل صدى نفس التبويب */
          switch (m.type) {
            case 'state':    self.emit('state', m.state); break;
            case 'chat':     self.emit('chat', m.message); break;
            case 'presence': self.emit('presence', m); break;
            case 'typing':   self.emit('typing', m); break;
            case 'leave':    self.emit('presence', { type: 'leave', clientId: m.clientId }); break;
            default: break;
          }
        };
      }
      /* احتياط إضافي: أحداث التخزين بين التبويبات */
      self._onStorage = (e) => {
        if (e.key !== self._key || !e.newValue) return;
        try {
          const m = JSON.parse(e.newValue);
          if (m.from === self.meta.clientId) return;
          if (m.type === 'state') self.emit('state', m.state);
          else if (m.type === 'chat') self.emit('chat', m.message);
          else if (m.type === 'presence') self.emit('presence', m);
          else if (m.type === 'typing') self.emit('typing', m);
          else if (m.type === 'leave') self.emit('presence', { type: 'leave', clientId: m.clientId });
        } catch (err) { }
      };
      global.addEventListener('storage', self._onStorage);

      /* استرجاع آخر حالة ورسائل محفوظة محلياً */
      const savedState = U.store.get(self._stateKey, null);
      const savedMsgs = U.store.get(self._msgsKey, []);
      self.connected = true;
      self._setStatus('local', 'مزامنة محلية (نفس الجهاز/المتصفح)');
      resolve({ state: savedState, messages: Array.isArray(savedMsgs) ? savedMsgs : [] });
    });
  };

  LocalTransport.prototype._bc = function (obj) {
    obj.from = this.meta.clientId;
    try { this.bc && this.bc.postMessage(obj); } catch (e) { }
    /* قناة احتياطية بين التبويبات التي لا تدعم BroadcastChannel */
    try { localStorage.setItem(this._key, JSON.stringify(obj)); } catch (e) { }
  };

  LocalTransport.prototype.publishState = function (state) {
    this._bc({ type: 'state', state });
    U.store.set(this._stateKey, state);
  };

  LocalTransport.prototype.sendChat = function (message) {
    const m = {
      id: U.uid('m'), name: message.name, text: message.text,
      ts: Date.now(), kind: message.kind || 'chat'
    };
    this._bc({ type: 'chat', message: m });
    const prev = U.store.get(this._msgsKey, []);
    const list = (Array.isArray(prev) ? prev : []).concat([m]).slice(-100);
    U.store.set(this._msgsKey, list);
    return m;
  };

  LocalTransport.prototype.close = function () {
    this._closedByUser = true;
    try { this.bc && this.bc.close(); } catch (e) { }
    global.removeEventListener('storage', this._onStorage);
  };

  /* ============================== المُوجِّه: اختيار أفضل وضع ============================== */
  function withTimeout(promise, ms, tag) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout:' + tag)), ms);
      promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  function wsUrlForRoom(cfg) {
    if (cfg.url) return cfg.url;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  /**
   * جرّب الأوضاع بالترتيب وأعد أول واحد ينجح.
   * @returns {Promise<{transport, result}>}
   */
  /** هل طُلب الوضع المحلي صراحةً (?local=1) ؟ — مفيد للمعاينة السريعة والعرض */
  function forceLocal() {
    try {
      return /[?&]local=1\b/.test(global.location.search) ||
             global.localStorage.getItem('wt:forceLocal') === '1';
    } catch (e) { return false; }
  }

  function connectRoom(roomId, meta, onStatus) {
    const cfg = global.WT_CONFIG;
    meta = meta || {};
    meta.clientId = meta.clientId || U.uid('client');

    const candidates = [];
    const skipServers = forceLocal();

    if (!skipServers && cfg.javaServer && cfg.javaServer.enabled) {
      candidates.push({
        tag: 'ws',
        make: () => new WsTransport(wsUrlForRoom(cfg.javaServer)),
        timeout: cfg.javaServer.timeoutMs || 2500
      });
    }
    if (!skipServers && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey && cfg.supabase.ready !== false) {
      candidates.push({
        tag: 'supabase',
        make: () => new SupabaseTransport(cfg.supabase),
        timeout: 7000
      });
    }

    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        onStatus && onStatus({ state: 'local', detail: 'تعذّر الاتصال بأي سيرفر — تم التحويل للوضع المحلي' });
        const t = new LocalTransport();
        return t.connect(roomId, meta).then(result => ({ transport: t, result }));
      }
      const c = candidates[i++];
      const t = c.make();
      onStatus && onStatus({ state: 'connecting', detail: 'جارٍ الاتصال: ' + t.label });
      return withTimeout(t.connect(roomId, meta), c.timeout, c.tag).then(
        result => ({ transport: t, result }),
        err => {
          try { t.close(); } catch (e) { }
          console.warn('[WT] فشل الوضع ' + c.tag + ':', err && err.message);
          return tryNext();
        }
      );
    };

    return tryNext();
  }

  global.WTTransport = {
    WsTransport, SupabaseTransport, LocalTransport, connectRoom, forceLocal
  };
})(window);

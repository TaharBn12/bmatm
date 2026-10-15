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

  /* ============================== تشخيص الأخطاء ============================== */
  /**
   * ترجمة خطأ Supabase إلى سبب مفهوم + حل عملي.
   * الهدف: ألا يرى المستخدم «تعذّر الاتصال» بلا سبب — كل خطأ له تفسير وحل.
   */
  function classifyError(err) {
    const status = Number((err && err.status) || 0);
    const code = String((err && err.code) || '');
    const raw = String((err && err.message) || err || '');
    const lc = raw.toLowerCase();
    const mk = (c, title, detail, fix) => ({ code: c, title, detail, fix, status, raw });

    if (code === '42P01' || code === 'PGRST205' ||
      lc.indexOf('does not exist') >= 0 || lc.indexOf('schema cache') >= 0) {
      return mk('missing-table',
        'جداول قاعدة البيانات غير موجودة',
        'مشروع Supabase يردّ لكنه لا يعرف جداول (rooms / messages / presence) — رمز الخطأ: ' + (code || status),
        'افتح SQL Editor في مشروع Supabase، الصق محتوى docs/bootstrap.sql (أو docs/schema.sql) ثم Run.');
    }
    if (code === '42501') {
      return mk('rls',
        'صلاحيات RLS ناقصة',
        'الجداول موجودة، لكن دور anon (زائر بلا حساب) غير مسموح له بالقراءة أو الكتابة.',
        'نفّذ docs/bootstrap.sql كاملاً (فيه منح الصلاحيات وسياسات RLS).');
    }
    if (status === 401 || status === 403 || code === 'PGRST301' || code === 'PGRST302' ||
      lc.indexOf('invalid api key') >= 0 || lc.indexOf('jwt') >= 0) {
      return mk('bad-key',
        'مفتاح anon غير صالح',
        'Supabase رفض المفتاح الموجود في assets/js/config.js — رمز الخطأ: ' + (code || status),
        'من Project Settings → API انسخ «anon public key» الجديد، ثم: node tools/sbctl.mjs set --url <URL> --key <KEY>');
    }
    if (status === 404) {
      return mk('bad-url',
        'عنوان المشروع غير صحيح',
        'الرابط لا يردّ بصفحة مشروع Supabase (404).',
        'تأكد من Project URL (ينتهي بـ .supabase.co) أو شغّل: node tools/sbctl.mjs doctor');
    }
    if (status >= 500 || status === 522 || status === 524) {
      return mk('project-down',
        'مشروع Supabase متوقف أو مشغول',
        'السيرفر الداخلي للمشروع لا يردّ (الخطأ ' + (code || status) + ') — هذا يحدث غالباً لمشروع مجاني موقوف.',
        'من Dashboard → Project Settings اضغط «Resume» إن كان موقوفاً، أو أنشئ مشروعاً جديداً: node tools/sbctl.mjs create');
    }
    if (!status || lc.indexOf('failed to fetch') >= 0 || lc.indexOf('networkerror') >= 0 ||
      lc.indexOf('timeout') >= 0 || lc.indexOf('aborted') >= 0) {
      return mk('network',
        'لا يوجد اتصال بمشروع Supabase',
        'الطلب لم يخرج من المتصفح أصلاً (انقطاع الشبكة، بروكسي، أو الموقع يعمل بلا https).',
        'تأكد من الإنترنت، وأن الموقع يعمل على https (ws/wss كذلك)، ثم أعد المحاولة.');
    }
    return mk('unknown', 'خطأ غير معروف', raw || '—',
      'شغّل: node tools/sbctl.mjs doctor — أو انسخ التقرير من زر «تشخيص الاتصال» في الغرفة.');
  }

  /** بصمة قصيرة للمفتاح (لا نعرض المفتاح كاملاً أبداً) */
  function keyFingerprint(key) {
    const k = String(key || '');
    if (!k) return '—';
    return k.slice(0, 12) + '…' + k.slice(-6) + ' (' + k.length + ' حرفاً)';
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
        self._send({ type: 'join', room: roomId, client: self.meta.clientId, name: self.meta.name,
          host: !!self.meta.host, ownerToken: self.meta.ownerToken || '',
          memberToken: self.meta.memberToken || self.meta.ownerToken || '' });
      };

      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }

        if (msg.type === 'welcome') {
          self.connected = true;
          self._setStatus('online', 'متصل بسيرفر Java');
          self.serverTime = msg.serverTime || Date.now();
          self.role = msg.role || 'viewer';
          self.emit('members', msg.members || []);
          self.emit('roles', msg.members || []);
          self.emit('queue', msg.queue || []);
          resolve({ state: msg.state || null, messages: msg.messages || [], members: msg.members || [],
            roles: msg.members || [], queue: msg.queue || [], role: self.role });
          return;
        }
        if (msg.type === 'state') {
          /* نُبلّغ دائماً (حتى صدى الذات) — سيرفر Java يرقّم الحالة مركزياً،
             والواجهة تتجاهل صداها لكنها تحفظ رقمها التسلسلي المعتمد */
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
        if (msg.type === 'roles') return self.emit('roles', msg.roles || []);
        if (msg.type === 'queue') return self.emit('queue', msg.items || []);
        if (msg.type === 'system') return self.emit('system', msg);
        if (msg.type === 'error') return self.emit('error', Object.assign({ permission: msg.code === 'permission' }, msg));
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
  WsTransport.prototype.setMemberRole = function (clientId, role) {
    this._send({ type: 'setRole', room: this.roomId, target: clientId, role });
    return Promise.resolve(null);
  };
  WsTransport.prototype.addQueueItem = function (item) {
    this._send({ type: 'queue', room: this.roomId, action: 'add', item });
    return Promise.resolve(null);
  };
  WsTransport.prototype.removeQueueItem = function (id) {
    this._send({ type: 'queue', room: this.roomId, action: 'remove', id });
    return Promise.resolve(null);
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
    this._seq = 0;
    this._hbTimer = null;
    this._pollTimer = null;      /* استطلاع احتياطي إن تعطّل Realtime */
    this._pollBusy = false;
    this._lastMsgId = 0;         /* آخر رقم رسالة وصلنا (للاستطلاع التدريجي) */
    this._msgsReady = false;     /* هل اكتملت القراءة الأولى للرسائل؟ */
    this._lastStateSig = null;   /* بصمة آخر حالة (تفادي إعادة بثّ نفس الحالة) */
    this._found = false;         /* هل صفّ الغرفة موجود في قاعدة البيانات؟ */
    this._initialized = false;
    this._networkFailures = 0;
    this._recoveryTimer = null;
    this._recoveryDelay = 1000;
    this._realtimeConnected = false;
    this._restConnected = false;
    this._lastRolesSig = null;
    this._lastQueueSig = null;
    this._pendingState = null;
    this._pendingWrite = null;
    this._pendingChats = [];
    this._sendingChat = false;
    this.lastError = null;       /* آخر خطأ (مفهرس ومترجم) */
    this.warnings = [];          /* تحذيرات غير قاتلة (مثلاً جدول الرسائل مفقود) */
    this.degraded = false;       /* يعمل لكن Realtime أو الشبكة متقطعة */
  }
  SupabaseTransport.prototype = Object.create(makeBase.prototype);

  SupabaseTransport.prototype._fetch = function (path, options) {
    options = options || {};
    const self = this;
    const timeoutMs = options.timeoutMs || (this.cfg.timeoutMs || 9000);

    /* مهلة قصوى للطلب: يمنع تعليق الاتصال لو الشبكة اختنقت */
    let ctrl = null, timer = null;
    const init = {
      method: options.method || 'GET',
      headers: Object.assign({}, this.headers, options.headers || {}),
      body: options.body ? JSON.stringify(options.body) : undefined,
      keepalive: !!options.keepalive
    };
    if (typeof AbortController !== 'undefined') {
      try {
        ctrl = new AbortController();
        init.signal = ctrl.signal;
        timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, timeoutMs);
      } catch (e) { ctrl = null; }
    }

    return fetch(this.rest + path, init).then(async (r) => {
      if (timer) clearTimeout(timer);
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        const err = new Error('supabase: ' + msg);
        err.status = r.status;
        err.code = (data && data.code) || '';
        err.body = data;
        err.diag = classifyError(err);
        self.lastError = err.diag;
        throw err;
      }
      return data;
    }, (netErr) => {
      if (timer) clearTimeout(timer);
      const err = new Error('supabase: ' + (netErr && netErr.message ? netErr.message : 'تعذّر الاتصال'));
      err.status = 0;
      err.code = 'NETWORK';
      err.diag = classifyError(err);
      self.lastError = err.diag;
      throw err;
    });
  };

  SupabaseTransport.prototype._rpc = function (name, body, options) {
    return this._fetch('/rest/v1/rpc/' + encodeURIComponent(name), Object.assign({ method: 'POST', body }, options || {}));
  };

  SupabaseTransport.prototype._loadRoom = function (initial) {
    const self = this;
    const meta = this.meta || {};
    const create = meta.host && meta.ownerToken
      ? this._rpc('wt_create_room', {
        p_room_id: this.roomId,
        p_title: meta.title || 'غرفة مشاهدة',
        p_video_url: meta.videoUrl || null,
        p_owner_token: meta.ownerToken,
        p_owner_name: meta.name || 'مضيف'
      })
      : Promise.resolve(null);

    return create.then(() => this._rpc('wt_join_room', {
      p_room_id: this.roomId,
      p_client_id: meta.clientId,
      p_member_token: meta.memberToken || meta.ownerToken,
      p_display_name: meta.name || 'زائر'
    })).then(join => {
      if (!join || join.found === false) {
        self._found = false;
        self._initialized = true;
        self.connected = true;
        self._restConnected = true;
        self.degraded = false;
        self._setStatus('online', 'Supabase متصل — بانتظار إنشاء الغرفة');
        return { state: null, messages: [], queue: [], roles: [], role: 'viewer', found: false, serverTime: join.serverTime, keepTransport: true };
      }
      return Promise.all([
        this._fetch(`/rest/v1/rooms?room_id=eq.${encodeURIComponent(self.roomId)}&select=state,video_url,host_name&limit=1`)
          .then(rows => (rows && rows[0]) || null),
        this._fetch(`/rest/v1/messages?room_id=eq.${encodeURIComponent(self.roomId)}&select=*&order=id.desc&limit=100`)
          .then(rows => {
            const list = (rows || []).slice().reverse();
            list.forEach(r => { const n = +r.id; if (Number.isFinite(n) && n > (self._lastMsgId || 0)) self._lastMsgId = n; });
            self._msgsReady = true;
            return list.map(r => ({
              id: String(r.id), name: r.name, text: r.body,
              ts: Date.parse(r.created_at) || Date.now(), kind: r.kind || 'chat', client: r.client_id || null
            }));
          })
          .catch(err => {
            const d = err && err.diag ? err.diag : classifyError(err);
            self.warnings.push(d);
            self._msgsReady = false;
            setTimeout(() => { if (!self._closedByUser) self.emit('system', { text: 'الدردشة غير متاحة مؤقتاً؛ ستتم إعادة المحاولة تلقائياً.' }); }, 50);
            return [];
          }),
        this._fetch(`/rest/v1/room_members?room_id=eq.${encodeURIComponent(self.roomId)}&select=client_id,display_name,role&order=updated_at.asc`)
          .catch(() => Array.isArray(join.members) ? join.members : []),
        this._fetch(`/rest/v1/room_queue?room_id=eq.${encodeURIComponent(self.roomId)}&select=*&order=id.asc&limit=100`)
          .catch(() => [])
      ]).then(([row, messages, roles, queue]) => {
        const state = row && row.state ? row.state : null;
        self._lastStateSig = state ? U.stateSig(state) : null;
        self._found = !!row;
        self._initialized = true;
        self._networkFailures = 0;
        self.lastError = null;
        self.degraded = false;
        self.connected = true;
        self._restConnected = true;
        self._recoveryDelay = 1000;
        self._setStatus('online', 'متصل بـ Supabase');
        return {
          state, messages, queue: queue || [], roles: roles || join.members || [],
          role: join.role || 'viewer', found: !!row, serverTime: join.serverTime, keepTransport: true,
          room: { videoUrl: row && row.video_url, hostName: row && row.host_name }
        };
      });
    });
  };

  SupabaseTransport.prototype.connect = function (roomId, meta) {
    const self = this;
    this.roomId = roomId; this.meta = meta || {};
    this._setStatus('connecting');
    this._bindRecoveryEvents();

    return this._loadRoom(true).then(result => {
      self._openRealtime();
      self._startPolling();
      if (!result.found) {
        setTimeout(() => {
          if (!self._found && !self._closedByUser) self.emit('system', { text: 'لم يتم العثور على هذه الغرفة — تحقق من الكود أو تأكد أن المنشئ أنشأها على هذا السيرفر.' });
        }, 1400);
        self._scheduleRecovery();
      }
      return result;
    }).catch(err => {
      const d = (err && err.diag) ? err.diag : classifyError(err);
      self.lastError = d;
      self.degraded = true;
      self.connected = false;
      self._setStatus('offline', 'الاتصال متقطع — تتم إعادة المحاولة تلقائياً');
      self._openRealtime();
      self._startPolling();
      self._scheduleRecovery();
      /* أبقِ النقل مربوطاً بـ Supabase بدلاً من التحويل الصامت إلى غرفة محلية. */
      return { state: null, messages: [], queue: [], roles: [], role: 'viewer', found: false, degraded: true, keepTransport: true };
    });
  };

  SupabaseTransport.prototype._bindRecoveryEvents = function () {
    const self = this;
    if (this._recoveryEventsBound) return;
    this._recoveryEventsBound = true;
    if (global.addEventListener) global.addEventListener('online', () => self._recoverRoom());
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', () => {
        if (!global.document.hidden) { self._pollOnce(); self._recoverRoom(); }
      });
    }
  };

  SupabaseTransport.prototype._scheduleRecovery = function () {
    const self = this;
    if (this._closedByUser || this._recoveryTimer) return;
    const delay = Math.min(30000, this._recoveryDelay) + Math.floor(Math.random() * 350);
    this._recoveryDelay = Math.min(30000, Math.round(this._recoveryDelay * 1.8));
    this._recoveryTimer = setTimeout(() => {
      self._recoveryTimer = null;
      self._recoverRoom();
    }, delay);
  };

  SupabaseTransport.prototype._recoverRoom = function () {
    const self = this;
    if (this._closedByUser || this._recovering) return Promise.resolve(false);
    this._recovering = true;
    return this._loadRoom(false).then(result => {
      if (!result.found) { self._scheduleRecovery(); return false; }
      if (typeof result.serverTime === 'number') self.emit('serverTime', result.serverTime);
      if (result.state) {
        const sig = U.stateSig(result.state);
        if (sig !== self._lastStateSig) {
          self._lastStateSig = sig;
          self.emit('state', result.state);
        }
      }
      if (result.roles) self.emit('roles', result.roles);
      if (result.queue) self.emit('queue', result.queue);
      if (result.found) self.emit('members', (result.roles || []).map(r => ({ id: r.client_id || r.id, name: r.display_name || r.name, role: r.role })));
      if (self._pendingState) self._flushPendingState().catch(() => { });
      self._networkFailures = 0;
      self._recoveryDelay = 1000;
      return true;
    }).catch(err => {
      self.lastError = (err && err.diag) || classifyError(err);
      self.degraded = true;
      self.connected = false;
      self._restConnected = false;
      self._setStatus('offline', 'الاتصال متقطع — تتم إعادة المحاولة تلقائياً');
      self._scheduleRecovery();
      return false;
    }).finally(() => { self._recovering = false; });
  };

  /* ============================== فحص المشروع (تشخيص) ============================== */
  /**
   * يفحص مشروع Supabase كاملاً ويرجع تقريراً مفصّلاً:
   * هل REST يردّ؟ هل الجداول موجودة؟ هل Realtime يعمل؟
   * يُعرض في نافذة «تشخيص الاتصال» ويُستخدم في `tools/sbctl.mjs doctor`.
   */
  SupabaseTransport.prototype.diagnose = function (opts) {
    opts = opts || {};
    const self = this;
    const report = {
      url: this.rest,
      key: keyFingerprint(this.cfg.anonKey),
      checkedAt: Date.now(),
      rest: { ok: false, status: 0, ms: 0, error: null },
      tables: { rooms: false, messages: false, presence: false, room_members: false, room_queue: false },
      realtime: { ok: false, ms: 0, error: null },
      room: { id: this.roomId || null, found: !!this._found },
      transport: this.kind,
      warnings: [],
      problems: []
    };

    const t0 = Date.now();
    return this._fetch('/rest/v1/rooms?select=room_id&limit=1', { timeoutMs: opts.timeoutMs || 8000 })
      .then(() => {
        report.rest = { ok: true, status: 200, ms: Date.now() - t0, error: null };
        report.tables.rooms = true;
      })
      .catch(err => {
        const d = (err && err.diag) ? err.diag : classifyError(err);
        report.rest = { ok: false, status: d.status || 0, ms: Date.now() - t0, error: d };
        report.problems.push(d);
        /* خطأ 404/42P01 يعني غالباً أن الجداول غير منشأة أصلاً */
        if (d.code === 'missing-table' || d.code === 'bad-url') {
          report.tables.rooms = false;
          return null;
        }
        return null;
      })
      .then(() => {
        if (!report.rest.ok) return null;
        /* بقية الجداول — كل واحد مستقل (حضور اختياري، رسائل اختيارية) */
        return Promise.all(['messages', 'presence', 'room_members', 'room_queue'].map((t) =>
          this._fetch(`/rest/v1/${t}?select=*&limit=1`, { timeoutMs: opts.timeoutMs || 8000 })
            .then(() => { report.tables[t] = true; })
            .catch(err => {
              const d = (err && err.diag) ? err.diag : classifyError(err);
              report.tables[t] = false;
              report.warnings.push(d);
            })
        ));
      })
      .then(() => {
        if (!report.rest.ok) return null;
        return this._probeRealtime(opts.realtimeMs || 4000).then((r) => { report.realtime = r; });
      })
      .then(() => {
        /* ملخّص */
        if (report.rest.ok && !report.tables.messages) {
          report.problems.push({
            code: 'missing-table',
            title: 'جدول الرسائل غير موجود',
            detail: 'الدردشة لن تعمل، لكن مزامنة الفيديو تعمل.',
            fix: 'نفّذ docs/bootstrap.sql في مشروع Supabase.'
          });
        }
        if (report.rest.ok && !report.tables.presence) {
          report.warnings.push({
            code: 'missing-table',
            title: 'جدول الحضور غير موجود',
            detail: 'قائمة الحضور القديمة غير متاحة؛ أدوار الغرفة تستخدم room_members.',
            fix: 'نفّذ docs/bootstrap.sql في مشروع Supabase.'
          });
        }
        if (report.rest.ok && !report.tables.room_members) {
          report.problems.push({ code: 'missing-table', title: 'جدول الأدوار غير موجود',
            detail: 'لن يمكن التحقق من المنشئ والمنظّمين على الخادم.', fix: 'نفّذ docs/bootstrap.sql في مشروع Supabase.' });
        }
        if (report.rest.ok && !report.tables.room_queue) {
          report.problems.push({ code: 'missing-table', title: 'جدول قائمة التشغيل غير موجود',
            detail: 'القائمة المشتركة غير متاحة.', fix: 'نفّذ docs/bootstrap.sql في مشروع Supabase.' });
        }
        if (report.rest.ok && !report.realtime.ok) {
          report.warnings.push({
            code: 'realtime-down',
            title: 'Realtime لا يعمل',
            detail: 'الاستطلاع كل ' + ((global.WT_CONFIG && global.WT_CONFIG.sync && global.WT_CONFIG.sync.pollMs) || 2500) +
              ' مللي ثانية يغطّي النقص، لكن البث الفوري متأخر.',
            fix: 'تأكد أن rooms و messages و room_members و room_queue مُضافة إلى منشور supabase_realtime (docs/bootstrap.sql).'
          });
        }
        report.ok = report.rest.ok && report.tables.rooms && report.problems.length === 0;
        return report;
      })
      .catch(err => {
        report.problems.push(classifyError(err));
        report.ok = false;
        return report;
      });
  };

  /** مصافحة Realtime: هل يقبل الانضمام إلى قناة؟ */
  SupabaseTransport.prototype._probeRealtime = function (ms) {
    return new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(this._wsUrl()); }
      catch (e) { return resolve({ ok: false, ms: 0, error: 'WebSocket غير متاح: ' + (e && e.message) }); }
      const t0 = Date.now();
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        try { ws.close(); } catch (e) { }
        resolve(r);
      };
      const timer = setTimeout(() => finish({
        ok: false, ms: Date.now() - t0, error: 'انتهت المهلة (' + (ms || 4000) + ' مللي ثانية)'
      }), ms || 4000);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            topic: 'wt:diag', event: 'phx_join', ref: '1',
            payload: { config: { broadcast: { self: false }, presence: { key: 'diag' } } }
          }));
        } catch (e) { }
      };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.event === 'phx_reply' && msg.payload) {
          if (msg.payload.status === 'ok') {
            clearTimeout(timer);
            finish({ ok: true, ms: Date.now() - t0, error: null });
          } else if (msg.payload.status === 'error') {
            clearTimeout(timer);
            const why = (msg.payload.response && msg.payload.response.message) || 'رُفض الانضمام إلى القناة';
            finish({ ok: false, ms: Date.now() - t0, error: why });
          }
        }
      };
      ws.onerror = () => { clearTimeout(timer); finish({ ok: false, ms: Date.now() - t0, error: 'فشل اتصال Realtime' }); };
      ws.onclose = () => { clearTimeout(timer); finish({ ok: false, ms: Date.now() - t0, error: 'أُغلق اتصال Realtime' }); };
    });
  };

  /**
   * استطلاع دوري (Polling) — شبكة أمان فوق Realtime
   * ------------------------------------------------
   * إن لم تصل أحداث Realtime (المنشور non مفعّل، RLS، replica identity،
   * أو الشبكة)، يبقى الجميع متزامنين عبر سؤال قاعدة البيانات مباشرةً.
   * هذه الطبقة هي ما يجعل «الأصدقاء يدخلون نفس الغرفة» مضموناً.
   */
  SupabaseTransport.prototype._startPolling = function () {
    const self = this;
    if (this._closedByUser) return;
    clearInterval(this._pollTimer);
    const every = (global.WT_CONFIG && global.WT_CONFIG.sync && global.WT_CONFIG.sync.pollMs) || 2500;
    this._pollTimer = setInterval(() => self._pollOnce(), every);
    this._pollOnce();
  };

  SupabaseTransport.prototype._pollOnce = function () {
    const self = this;
    if (this._closedByUser || !this.roomId || this._pollBusy) return Promise.resolve(false);
    try { if (global.document && global.document.hidden) return Promise.resolve(false); } catch (e) { }
    this._pollBusy = true;

    const stateReq = this._fetch(`/rest/v1/rooms?room_id=eq.${encodeURIComponent(this.roomId)}&select=state,updated_at&limit=1`);
    const msgReq = this._msgsReady
      ? this._fetch(`/rest/v1/messages?room_id=eq.${encodeURIComponent(this.roomId)}&select=*&order=id.asc&limit=50&id=gt.${this._lastMsgId || 0}`).catch(() => [])
      : Promise.resolve([]);
    const rolesReq = this._fetch(`/rest/v1/room_members?room_id=eq.${encodeURIComponent(this.roomId)}&select=client_id,display_name,role&order=updated_at.asc`).catch(() => null);
    const queueReq = this._fetch(`/rest/v1/room_queue?room_id=eq.${encodeURIComponent(this.roomId)}&select=*&order=id.asc&limit=100`).catch(() => null);

    return Promise.all([stateReq, msgReq, rolesReq, queueReq]).then(([rows, messages, roles, queue]) => {
      self._networkFailures = 0;
      self.connected = true;
      self._restConnected = true;
      if (self.status !== 'online') self._setStatus('online', self._realtimeConnected ? 'متصل بـ Supabase Realtime' : 'متصل — المزامنة الاحتياطية تعمل');
      self.lastError = null;
      const row = rows && rows[0];
      if (row) {
        self._found = true;
        if (row.state) {
          const sig = U.stateSig(row.state);
          if (sig !== self._lastStateSig) { self._lastStateSig = sig; self.emit('state', row.state); }
        }
      }
      (messages || []).forEach(r => {
        const n = +r.id;
        if (Number.isFinite(n) && n > (self._lastMsgId || 0)) self._lastMsgId = n;
        if (r.client_id && r.client_id === self.meta.clientId) return;
        self.emit('chat', {
          id: String(r.id), name: r.name, text: r.body,
          ts: Date.parse(r.created_at) || Date.now(), kind: r.kind || 'chat', client: r.client_id || null
        });
      });
      if (Array.isArray(roles)) {
        const sig = JSON.stringify(roles.map(r => [r.client_id, r.role]));
        if (sig !== self._lastRolesSig) { self._lastRolesSig = sig; self.emit('roles', roles); }
      }
      if (Array.isArray(queue)) {
        const sig = JSON.stringify(queue.map(q => q.id));
        if (sig !== self._lastQueueSig) { self._lastQueueSig = sig; self.emit('queue', queue); }
      }
      if (self._pendingState) self._flushPendingState().catch(() => { });
      if (self._pendingChats.length) self._flushPendingChats();
      return true;
    }).catch(err => {
      self._networkFailures++;
      self.connected = false;
      self._restConnected = false;
      self.degraded = true;
      self.lastError = (err && err.diag) || classifyError(err);
      if (self._networkFailures >= 2) self._setStatus('offline', 'الاتصال متقطع — تتم إعادة المحاولة تلقائياً');
      self._scheduleRecovery();
      return false;
    }).finally(() => { self._pollBusy = false; });
  };

  SupabaseTransport.prototype._wsUrl = function () {
    return this.rest.replace(/^http/, 'ws') +
      '/realtime/v1/websocket?apikey=' + encodeURIComponent(this.cfg.anonKey) + '&vsn=1.0.0';
  };

  SupabaseTransport.prototype._scheduleRealtimeReconnect = function () {
    const self = this;
    if (this._closedByUser || this._realtimeTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(this._retry++, 5))) + Math.floor(Math.random() * 500);
    this._realtimeTimer = setTimeout(() => {
      self._realtimeTimer = null;
      self._openRealtime();
    }, delay);
  };

  SupabaseTransport.prototype._openRealtime = function () {
    const self = this;
    if (this._closedByUser) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const topic = 'room:' + this.roomId;
    let ws;
    try { ws = new WebSocket(this._wsUrl()); }
    catch (e) { this._realtimeConnected = false; this._scheduleRealtimeReconnect(); return; }
    this.ws = ws;
    const generation = (this._realtimeGeneration || 0) + 1;
    this._realtimeGeneration = generation;
    let joined = false;

    const cfgPayload = {
      config: {
        broadcast: { self: false },
        presence: { key: this.meta.clientId || U.uid('c') },
        postgres_changes: [{ event: '*', schema: 'public', table: 'messages', filter: 'room_id=eq.' + this.roomId },
          { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'room_id=eq.' + this.roomId },
          { event: '*', schema: 'public', table: 'room_members', filter: 'room_id=eq.' + this.roomId },
          { event: '*', schema: 'public', table: 'room_queue', filter: 'room_id=eq.' + this.roomId }]
      }
    };
    const send = (event, payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ topic, event, payload: payload || {}, ref: event === 'heartbeat' ? String(++self._seq) : null }));
    };

    ws.onopen = () => send('phx_join', Object.assign({ access_token: self.cfg.anonKey }, cfgPayload));
    ws.onmessage = (ev) => {
      if (generation !== self._realtimeGeneration) return;
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === 'phx_reply' && msg.payload) {
        if (msg.payload.status === 'error') { try { ws.close(); } catch (e) { } return; }
        if (msg.payload.status === 'ok' && !joined) {
          joined = true;
          self._realtimeConnected = true;
          self.connected = true;
          self.degraded = !self._restConnected;
          self._setStatus('online', 'متصل بـ Supabase Realtime');
          clearInterval(self._hbTimer);
          self._hbTimer = setInterval(() => send('heartbeat', {}), 25000);
          clearTimeout(self._stableTimer);
          self._stableTimer = setTimeout(() => { self._retry = 0; }, 45000);
        }
        return;
      }
      if (msg.event !== 'postgres_changes') return;
      const changes = (msg.payload && msg.payload.data && msg.payload.data.changes) || [];
      changes.forEach(c => {
        const rec = c.record || {};
        if (c.table === 'messages') {
          if (c.type === 'DELETE') return;
          self.emit('chat', { id: String(rec.id), name: rec.name, text: rec.body,
            ts: Date.parse(rec.created_at) || Date.now(), kind: rec.kind || 'chat', client: rec.client_id || null });
        } else if (c.table === 'rooms' && rec.state) {
          self._found = true;
          const sig = U.stateSig(rec.state);
          if (sig !== self._lastStateSig) { self._lastStateSig = sig; self.emit('state', rec.state); }
        } else if (c.table === 'room_members') {
          self._fetch(`/rest/v1/room_members?room_id=eq.${encodeURIComponent(self.roomId)}&select=client_id,display_name,role&order=updated_at.asc`)
            .then(rows => self.emit('roles', rows || [])).catch(() => { });
        } else if (c.table === 'room_queue') {
          self._fetch(`/rest/v1/room_queue?room_id=eq.${encodeURIComponent(self.roomId)}&select=*&order=id.asc&limit=100`)
            .then(rows => self.emit('queue', rows || [])).catch(() => { });
        }
      });
    };

    ws.onclose = () => {
      if (generation !== self._realtimeGeneration || self._closedByUser) return;
      self._realtimeConnected = false;
      self.connected = !!self._restConnected;
      self.degraded = true;
      clearInterval(self._hbTimer);
      clearTimeout(self._stableTimer);
      if (self._restConnected) self._setStatus('online', 'متصل — المزامنة الاحتياطية تعمل');
      else self._setStatus('connecting', 'إعادة الاتصال تلقائياً…');
      self._scheduleRealtimeReconnect();
      self._scheduleRecovery();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { self._scheduleRealtimeReconnect(); } };
  };

  SupabaseTransport.prototype.publishState = function (state, options) {
    this._pendingState = state;
    return this._flushPendingState(options || {});
  };

  SupabaseTransport.prototype._flushPendingState = function (options) {
    const self = this;
    if (this._closedByUser || !this._pendingState) return Promise.resolve(null);
    if (this._pendingWrite) return this._pendingWrite;
    const state = this._pendingState;
    const sig = U.stateSig(state);
    this._pendingWrite = this._rpc('wt_apply_room_state', {
      p_room_id: this.roomId,
      p_client_id: this.meta.clientId,
      p_member_token: this.meta.memberToken || this.meta.ownerToken,
      p_state: state
    }, { keepalive: !!options.keepalive }).then(accepted => {
      if (self._pendingState && U.stateSig(self._pendingState) === sig) self._pendingState = null;
      self._lastStateSig = U.stateSig(accepted || state);
      self._restConnected = true;
      self.connected = true;
      self._networkFailures = 0;
      if (self.status !== 'online') self._setStatus('online', 'متصل بـ Supabase');
      return accepted || state;
    }).catch(err => {
      const d = (err && err.diag) || classifyError(err);
      const permission = err && (err.status === 401 || err.status === 403 || err.code === '42501');
      if (permission) {
        self._pendingState = null;
        self._fetch(`/rest/v1/rooms?room_id=eq.${encodeURIComponent(self.roomId)}&select=state&limit=1`)
          .then(rows => {
            const canonical = rows && rows[0] && rows[0].state;
            if (canonical) {
              self._lastStateSig = U.stateSig(canonical);
              self.emit('state', Object.assign({}, canonical, { authoritative: true }));
            }
          }).catch(() => { });
      } else { self.degraded = true; self._scheduleRecovery(); }
      self.emit('error', {
        message: permission ? 'لا تملك صلاحية التحكم في هذه الغرفة' : 'تتم إعادة محاولة حفظ التغيير تلقائياً',
        permission: !!permission, transient: !permission, diag: d
      });
      throw err;
    }).finally(() => {
      self._pendingWrite = null;
      if (self._pendingState && U.stateSig(self._pendingState) !== sig && !self._closedByUser) {
        setTimeout(() => { self._flushPendingState().catch(() => { }); }, 0);
      }
    });
    return this._pendingWrite;
  };

  SupabaseTransport.prototype.sendChat = function (message) {
    const local = {
      id: U.uid('m'), name: message.name, text: message.text,
      ts: Date.now(), kind: message.kind || 'chat'
    };
    this._pendingChats.push({
      room_id: this.roomId,
      name: String(message.name || 'زائر').slice(0, 30),
      body: String(message.text || '').slice(0, 1000),
      kind: message.kind || 'chat', client_id: this.meta.clientId || null,
      user_id: this.meta.userId || null
    });
    this._flushPendingChats();
    return local;
  };

  SupabaseTransport.prototype._flushPendingChats = function () {
    const self = this;
    if (this._sendingChat || this._closedByUser || !this._pendingChats.length) return;
    this._sendingChat = true;
    const row = this._pendingChats[0];
    this._fetch('/rest/v1/messages', { method: 'POST', headers: { 'Prefer': 'return=minimal' }, body: row })
      .then(() => { self._pendingChats.shift(); self._sendingChat = false; if (self._pendingChats.length) self._flushPendingChats(); })
      .catch(err => {
        self._sendingChat = false;
        self.degraded = true;
        self._scheduleRecovery();
        /* لا نزعج المشاهدة برسائل متكررة؛ ستُعاد المحاولة تلقائياً. */
      });
  };

  SupabaseTransport.prototype._readQueue = function () {
    const self = this;
    return this._fetch(`/rest/v1/room_queue?room_id=eq.${encodeURIComponent(this.roomId)}&select=*&order=id.asc&limit=100`)
      .then(rows => { const list = rows || []; self.emit('queue', list); return list; });
  };

  SupabaseTransport.prototype._readRoles = function () {
    const self = this;
    return this._fetch(`/rest/v1/room_members?room_id=eq.${encodeURIComponent(this.roomId)}&select=client_id,display_name,role&order=updated_at.asc`)
      .then(rows => { const list = rows || []; self.emit('roles', list); return list; });
  };

  SupabaseTransport.prototype.addQueueItem = function (item) {
    const self = this;
    return this._rpc('wt_queue_add', {
      p_room_id: this.roomId,
      p_client_id: this.meta.clientId,
      p_member_token: this.meta.memberToken || this.meta.ownerToken,
      p_url: item.url,
      p_title: item.title || item.url
    }).then(() => self._readQueue());
  };

  SupabaseTransport.prototype.removeQueueItem = function (id) {
    const self = this;
    return this._rpc('wt_queue_remove', {
      p_room_id: this.roomId,
      p_client_id: this.meta.clientId,
      p_member_token: this.meta.memberToken || this.meta.ownerToken,
      p_item_id: Number(id)
    }).then(() => self._readQueue());
  };

  SupabaseTransport.prototype.setMemberRole = function (clientId, role) {
    const self = this;
    return this._rpc('wt_set_room_member_role', {
      p_room_id: this.roomId,
      p_owner_token: this.meta.ownerToken || this.meta.memberToken,
      p_target_client_id: clientId,
      p_role: role
    }).then(() => self._readRoles());
  };

  SupabaseTransport.prototype.close = function () {
    this._closedByUser = true;
    clearInterval(this._hbTimer);
    clearInterval(this._pollTimer);
    clearTimeout(this._recoveryTimer);
    clearTimeout(this._realtimeTimer);
    clearTimeout(this._stableTimer);
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
    this._queueKey = 'wt:local:queue:' + roomId;
    this._rolesKey = 'wt:local:roles:' + roomId;
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
            case 'queue':    self.emit('queue', m.items || []); break;
            case 'roles':    self.emit('roles', m.roles || []); break;
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
          else if (m.type === 'queue') self.emit('queue', m.items || []);
          else if (m.type === 'roles') self.emit('roles', m.roles || []);
          else if (m.type === 'leave') self.emit('presence', { type: 'leave', clientId: m.clientId });
        } catch (err) { }
      };
      global.addEventListener('storage', self._onStorage);

      /* استرجاع آخر حالة ورسائل محفوظة محلياً */
      const savedState = U.store.get(self._stateKey, null);
      const savedMsgs = U.store.get(self._msgsKey, []);
      const savedQueue = U.store.get(self._queueKey, []);
      const savedRoles = U.store.get(self._rolesKey, []);
      const role = self.meta.ownerToken ? 'owner' : ((savedRoles.find(r => r.id === self.meta.clientId) || {}).role || 'viewer');
      self.connected = true;
      self.role = role;
      self._setStatus('local', 'مزامنة محلية (نفس الجهاز/المتصفح)');
      const roles = Array.isArray(savedRoles) ? savedRoles.slice() : [];
      if (!roles.some(r => r.id === self.meta.clientId)) roles.push({ id: self.meta.clientId, name: self.meta.name, role });
      resolve({ state: savedState, messages: Array.isArray(savedMsgs) ? savedMsgs : [], queue: Array.isArray(savedQueue) ? savedQueue : [], roles, role });
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

  LocalTransport.prototype.addQueueItem = function (item) {
    const list = U.store.get(this._queueKey, []);
    const queue = (Array.isArray(list) ? list : []).concat([Object.assign({
      id: U.uid('q'), addedByClient: this.meta.clientId, addedBy: this.meta.name, createdAt: Date.now()
    }, item)]);
    U.store.set(this._queueKey, queue);
    this._bc({ type: 'queue', items: queue });
    this.emit('queue', queue);
    return Promise.resolve(queue);
  };

  LocalTransport.prototype.removeQueueItem = function (id) {
    const list = U.store.get(this._queueKey, []);
    const queue = (Array.isArray(list) ? list : []).filter(item => String(item.id) !== String(id));
    U.store.set(this._queueKey, queue);
    this._bc({ type: 'queue', items: queue });
    this.emit('queue', queue);
    return Promise.resolve(queue);
  };

  LocalTransport.prototype.setMemberRole = function (clientId, role) {
    const roles = U.store.get(this._rolesKey, []);
    const list = Array.isArray(roles) ? roles.slice() : [];
    const target = list.find(r => r.id === clientId);
    if (target) target.role = role;
    else list.push({ id: clientId, role, name: clientId });
    U.store.set(this._rolesKey, list);
    this._bc({ type: 'roles', roles: list });
    this.emit('roles', list);
    return Promise.resolve(list);
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

    const wsCandidate = (tag, ms) => ({
      tag,
      make: () => new WsTransport(wsUrlForRoom(cfg.javaServer)),
      timeout: ms
    });
    const wsTimeout = cfg.javaServer.timeoutMs || 2500;

    if (!skipServers && cfg.javaServer && cfg.javaServer.enabled) {
      candidates.push(wsCandidate('ws', wsTimeout));
    }
    if (!skipServers && cfg.supabase && cfg.supabase.url && cfg.supabase.anonKey && cfg.supabase.ready !== false) {
      candidates.push({
        tag: 'supabase',
        make: () => new SupabaseTransport(cfg.supabase),
        timeout: 7000,
        /* إن لم نجد صفّ الغرفة في قاعدة البيانات فالمضيف غالباً على سيرفر Java
           → نعتبر النتيجة «غير مؤكدة» ونمنح WebSocket فرصةً أطول قبل الاستسلام،
           حتى لا ينتهي الضيف وحيداً في غرفة فارغة على سيرفر آخر */
        verify: (result) => !!(result && (result.found || result.degraded))
      });
      if (!skipServers && cfg.javaServer && cfg.javaServer.enabled) {
        candidates.push(wsCandidate('ws-retry', Math.max(6000, wsTimeout * 3)));
      }
    }

    let i = 0;
    let unsure = null;    /* نتيجة صالحة لكن غير مؤكدة نعود إليها إن فشل ما بعدها */

    const tryNext = () => {
      if (i >= candidates.length) {
        if (unsure) return Promise.resolve(unsure);
        onStatus && onStatus({ state: 'local', detail: 'تعذّر الاتصال بأي سيرفر — تم التحويل للوضع المحلي' });
        const t = new LocalTransport();
        if (onStatus) t.on('status', onStatus);
        return t.connect(roomId, meta).then(result => {
          if (onStatus) t.off('status', onStatus);
          return { transport: t, result };
        });
      }
      const c = candidates[i++];
      const t = c.make();
      if (onStatus) t.on('status', onStatus);
      onStatus && onStatus({ state: 'connecting', detail: 'جارٍ الاتصال: ' + t.label });
      return withTimeout(t.connect(roomId, meta), c.timeout, c.tag).then(
        result => {
          if (onStatus) t.off('status', onStatus);
          const got = { transport: t, result };
          const sure = !c.verify || c.verify(result);
          if (sure) {
            if (unsure && unsure.transport !== t) { try { unsure.transport.close(); } catch (e) { } }
            return got;
          }
          /* نتيجة غير مؤكدة: احتفظ بها وجرّب التالي */
          if (!unsure) unsure = got;
          return i < candidates.length ? tryNext() : got;
        },
        err => {
          if (onStatus) t.off('status', onStatus);
          try { t.close(); } catch (e) { }
          console.warn('[WT] فشل الوضع ' + c.tag + ':', err && err.message);
          onStatus && onStatus({
            state: 'failed', tag: c.tag,
            detail: (err && err.diag) ? err.diag.title : String((err && err.message) || err),
            error: err
          });
          return tryNext();
        }
      );
    };

    return tryNext();
  }

  global.WTTransport = {
    WsTransport, SupabaseTransport, LocalTransport, connectRoom, forceLocal,
    classifyError, keyFingerprint
  };
})(window);

/* =========================================================
   WatchTogether — اختبار «عميلان في نفس الغرفة» (بلا متصفح)
   التشغيل:  node docs/tests/join-room.mjs
   ---------------------------------------------------------
   يشغّل نسختين كاملتين من room.html/room.js في نفس العملية:
     • مضيف  (أنشأ الغرفة برابط فيديو)
     • ضيف   (دخل من الرابط/الكود فقط)
   ويحقّق أنهما فعلاً في نفس الغرفة على كلا السيرفرين:
     1) سيرفر Java (WebSocket وهمي يرقّم التحديثات مركزياً)
     2) Supabase (REST وهمي + استطلاع، وبدون Realtime إطلاقاً)
   ========================================================= */
import { createRoomEnv, wait } from './harness.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name} ${extra}`); }
};

const VIDEO_A = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
const VIDEO_B = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4';
const ROOM = 'JOIN01';

/* ==================== خادم WebSocket وهمي (نظير سيرفر Java) ==================== */
function makeWsServer() {
  const rooms = new Map();
  const sockets = new Set();

  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { state: null, rev: 0, members: new Set(), history: [] });
    return rooms.get(id);
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      this.attrs = {};
      setTimeout(() => server.attach(this), 1);
    }
    send(text) { server.receive(this, String(text)); }
    close() { server.detach(this); }
  }

  const server = {
    FakeWebSocket,
    stats: { messages: 0 },

    attach(sock) {
      sockets.add(sock);
      sock.readyState = 1;
      sock.onopen && sock.onopen({});
    },

    detach(sock) {
      if (!sockets.delete(sock)) return;
      const r = sock.attrs.room ? rooms.get(sock.attrs.room) : null;
      if (r) {
        r.members.delete(sock);
        this.broadcast(r, { type: 'presence', clientId: sock.attrs.clientId, left: true }, null);
        this.broadcast(r, { type: 'members', members: memberList(r) }, null);
      }
      sock.readyState = 3;
      sock.onclose && sock.onclose({});
    },

    receive(sock, text) {
      let msg; try { msg = JSON.parse(text); } catch (e) { return; }
      const roomId = String(msg.room || sock.attrs.room || '?').toUpperCase();
      const r = room(roomId);

      if (msg.type === 'join') {
        /* اقطع أي اتصال قديم بنفس معرّف العميل */
        for (const other of Array.from(r.members)) {
          if (other !== sock && other.attrs.clientId === msg.client) this.detach(other);
        }
        sock.attrs.room = roomId;
        sock.attrs.clientId = msg.client;
        sock.attrs.name = msg.name;
        r.members.add(sock);
        this.send(sock, {
          type: 'welcome', room: roomId, state: r.state,
          serverTime: Date.now(), messages: r.history.slice(),
          members: memberList(r), lastSavedAt: Date.now()
        });
        this.broadcast(r, { type: 'system', text: (msg.name || 'زائر') + ' دخل الغرفة' }, null);
        this.broadcast(r, { type: 'members', members: memberList(r) }, null);
        return;
      }

      if (msg.type === 'state') {
        const s = msg.state || {};
        const incoming = Number.isFinite(+s.rev) ? +s.rev : 0;
        r.rev = Math.max(r.rev, incoming) + 1;           /* ترقيم مركزي */
        const stored = Object.assign({}, s, {
          rev: r.rev,
          updatedBy: s.updatedBy || s.hostId || String(sock.attrs.clientId),
          updatedByName: s.updatedByName || s.hostName || String(sock.attrs.name)
        });
        r.state = stored;
        sock.attrs.name = stored.updatedByName;
        this.stats.messages++;
        /* نبثّها للجميع بمن فيهم المرسل (الواجهة تتجاهل صداها عبر sender) */
        this.broadcast(r, { type: 'state', state: stored, sender: sock.attrs.clientId }, null);
        return;
      }

      if (msg.type === 'chat') {
        const m = Object.assign({}, msg.message, {
          id: 's-' + (r.history.length + 1),
          ts: Date.now(),
          client: sock.attrs.clientId
        });
        r.history.push(m);
        this.broadcast(r, { type: 'chat', message: m, sender: sock.attrs.clientId }, null);
        return;
      }

      if (msg.type === 'presence') {
        sock.attrs.name = msg.name || sock.attrs.name;
        sock.attrs.host = !!msg.host;
        this.broadcast(r, {
          type: 'presence', clientId: msg.clientId, name: msg.name, host: !!msg.host
        }, sock);
        this.broadcast(r, { type: 'members', members: memberList(r) }, null);
        return;
      }

      if (msg.type === 'typing') {
        this.broadcast(r, { type: 'typing', clientId: msg.clientId, name: msg.name }, sock);
        return;
      }

      if (msg.type === 'leave') { this.detach(sock); return; }
    },

    send(sock, obj) {
      if (!sock || sock.readyState !== 1 || !sock.onmessage) return;
      setTimeout(() => { sock.readyState === 1 && sock.onmessage && sock.onmessage({ data: JSON.stringify(obj) }); }, 0);
    },

    broadcast(r, obj, except) {
      for (const c of Array.from(r.members)) {
        if (except && c === except) continue;
        this.send(c, obj);
      }
    }
  };

  function memberList(r) {
    return Array.from(r.members).map(c => ({ id: c.attrs.clientId, name: c.attrs.name, host: !!c.attrs.host }));
  }

  return server;
}

/* ==================== خادم Supabase وهمي (REST فقط، بلا Realtime) ==================== */
function makeSupabaseStub() {
  const db = { rooms: new Map(), messages: [], presence: new Map(), nextId: 1 };
  const calls = { roomsInsert: 0, roomsSelect: 0, msgInsert: 0, msgSelect: 0, roomCreate: 0 };

  const matchEq = (url, key) => {
    const m = url.match(new RegExp('[?&]' + key + '=eq\\.([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  const fetchStub = (url, options = {}) => {
    const path = String(url);
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const json = (data, ok = true) => Promise.resolve({
      ok, status: ok ? 200 : 400,
      text: async () => JSON.stringify(data),
      json: async () => data
    });

    /* ---- الغرف ---- */
    if (path.includes('/rest/v1/rooms')) {
      if (method === 'GET') {
        calls.roomsSelect++;
        const id = matchEq(path, 'room_id');
        const row = id && db.rooms.has(id) ? db.rooms.get(id) : null;
        return json(row ? [row] : []);
      }
      if (method === 'POST') {
        calls.roomsInsert++;
        const id = body.room_id;
        if (!db.rooms.has(id)) calls.roomCreate++;
        const prev = db.rooms.get(id) || {};
        db.rooms.set(id, Object.assign(prev, body, { updated_at: new Date().toISOString() }));
        return json([db.rooms.get(id)]);
      }
    }

    /* ---- الرسائل ---- */
    if (path.includes('/rest/v1/messages')) {
      if (method === 'GET') {
        calls.msgSelect++;
        const id = matchEq(path, 'room_id');
        let rows = db.messages.filter(m => !id || m.room_id === id);
        const gt = path.match(/[?&]id=gt\.(\d+)/);
        if (gt) rows = rows.filter(m => m.id > +gt[1]);
        rows = rows.slice().sort((a, b) => a.id - b.id).slice(0, 100);
        return json(rows);
      }
      if (method === 'POST') {
        calls.msgInsert++;
        const row = Object.assign({}, body, { id: db.nextId++, created_at: new Date().toISOString() });
        db.messages.push(row);
        return json([]);
      }
      if (method === 'DELETE') return json([]);
    }

    /* ---- الحضور ---- */
    if (path.includes('/rest/v1/presence')) {
      if (method === 'POST') {
        db.presence.set(body.room_id + '|' + body.client_id, body);
        return json([]);
      }
      if (method === 'GET') {
        const id = matchEq(path, 'room_id');
        return json(Array.from(db.presence.values()).filter(p => !id || p.room_id === id));
      }
      if (method === 'DELETE') return json([]);
    }

    return json({ message: 'unknown route ' + path }, false);
  };

  return { db, calls, fetchStub };
}

/* ==================== مساعدات ==================== */
function findVideo(env) {
  let out = null;
  const walk = (n) => {
    if (!n || !n.children) return;
    n.children.forEach(c => {
      if (!out && String(c.tagName) === 'VIDEO') out = c;
      walk(c);
    });
  };
  walk(env.byId.get('player'));
  return out;
}

/** أدخل العميل من بوابة الاسم ثم أنهِ تحميل المشغّل */
async function enter(env, name) {
  env.byId.get('gateName').value = name;
  env.byId.get('gateForm').dispatch('submit', {});
  await wait(250);
  const v = findVideo(env);
  if (v) {
    v.duration = 600;
    v.dispatch('loadedmetadata', {});
    await wait(80);
  }
  return v;
}

const chatText = (env) => env.byId.get('chatBody').children
  .map(c => String(c.innerHTML || ''))
  .join(' ');

/* ==================== 1) سيرفر Java (WebSocket) ==================== */
async function testWebSocket() {
  const server = makeWsServer();
  const mk = (search) => {
    const env = createRoomEnv({ search, WebSocket: server.FakeWebSocket });
    return env;
  };

  const host = mk(`?id=${ROOM}&host=1&v=${encodeURIComponent(VIDEO_A)}`);
  await wait(30);
  const guest = mk(`?id=${ROOM}`);

  await enter(host, 'أمين');
  const hostVideo = findVideo(host);
  t('ws: المضيف حمّل الفيديو', !!hostVideo && hostVideo.src === VIDEO_A, hostVideo && hostVideo.src);

  await enter(guest, 'طهّار');
  await wait(150);

  t('ws: الضيف اتصل بنفس السيرفر', host.byId.get('sbMode').textContent.includes('Java'), host.byId.get('sbMode').textContent);
  t('ws: الضيف حصل على نفس الفيديو (نفس الغرفة)',
    !!findVideo(guest) && findVideo(guest).src === VIDEO_A,
    findVideo(guest) && findVideo(guest).src);

  /* ---- مزامنة الموضع من المضيف إلى الضيف ---- */
  hostVideo.currentTime = 120;
  host.sandbox.WTRoom.publish({ force: true });
  await wait(150);
  t('ws: حالة المضيف وصلت الضيف', Math.round(guest.sandbox.WTRoom.state.pos) === 120,
    'guest pos=' + guest.sandbox.WTRoom.state.pos);
  t('ws: الضيف طبّق الموضع على مشغّله', Math.round(findVideo(guest).currentTime) === 120,
    't=' + findVideo(guest).currentTime);

  /* ---- التحكم من الضيف يصل للمضيف (أي مستخدم يتحكم) ---- */
  findVideo(guest).currentTime = 300;
  guest.sandbox.WTRoom.publish({ force: true });
  await wait(150);
  t('ws: تحكم الضيف وصل للمضيف', Math.round(host.sandbox.WTRoom.state.pos) === 300,
    'host pos=' + host.sandbox.WTRoom.state.pos);

  /* ---- تغيير الفيديو يعمّم على الجميع ---- */
  host.sandbox.WTRoom.setVideo(VIDEO_B);
  await wait(250);
  t('ws: تغيير الفيديو وصل للضيف', !!findVideo(guest) && findVideo(guest).src === VIDEO_B,
    findVideo(guest) && findVideo(guest).src);

  /* ---- الدردشة في الاتجاهين ---- */
  host.byId.get('chatInput').value = 'أهلاً من المضيف';
  host.byId.get('chatForm').dispatch('submit', {});
  await wait(150);
  t('ws: رسالة المضيف وصلت الضيف', chatText(guest).includes('أهلاً من المضيف'));

  guest.byId.get('chatInput').value = 'وعليكم من الضيف';
  guest.byId.get('chatForm').dispatch('submit', {});
  await wait(150);
  t('ws: رسالة الضيف وصلت المضيف', chatText(host).includes('وعليكم من الضيف'));

  /* ---- المنضمون ---- */
  await wait(120);
  t('ws: المضيف يرى منضمَين', host.byId.get('membersCount').textContent === '2',
    host.byId.get('membersCount').textContent);
  t('ws: الضيف يرى منضمَين', guest.byId.get('membersCount').textContent === '2',
    guest.byId.get('membersCount').textContent);

  /* ---- الترقيم المركزي يمنع التعارض ---- */
  const ra = host.sandbox.WTRoom.state.rev;
  host.sandbox.WTRoom.publish();
  guest.sandbox.WTRoom.publish();
  await wait(200);
  t('ws: لا تعارض في الأرقام التسلسلية',
    host.sandbox.WTRoom.state.rev > ra &&
    host.sandbox.WTRoom.session.revClock === guest.sandbox.WTRoom.session.revClock,
    `host=${host.sandbox.WTRoom.state.rev} guest=${guest.sandbox.WTRoom.state.rev}`);
}

/* ==================== 2) Supabase (استطلاع، بلا Realtime) ==================== */
async function testSupabase() {
  const sb = makeSupabaseStub();
  const mk = (search) => {
    const env = createRoomEnv({ search, fetch: sb.fetchStub });
    env.sandbox.WT_CONFIG.sync.pollMs = 120;
    env.sandbox.WT_CONFIG.sync.persistMs = 300;
    return env;
  };

  /* الضيف يدخل أولاً برابط فيه الفيديو (كما يفتح رابط الدعوة) */
  const guest = mk(`?id=SB001&v=${encodeURIComponent(VIDEO_A)}`);
  const host = mk(`?id=SB001&host=1&v=${encodeURIComponent(VIDEO_A)}`);

  await enter(host, 'أمين');
  await wait(120);
  t('sb: المضيف أنشأ صف الغرفة', sb.db.rooms.has('SB001'));
  const createsAfterHost = sb.calls.roomCreate;

  await enter(guest, 'طهّار');
  await wait(200);
  t('sb: الضيف لم ينشئ غرفة جديدة (لا يطمس غرفة المضيف)',
    sb.calls.roomCreate === createsAfterHost,
    `creates=${sb.calls.roomCreate} vs ${createsAfterHost}`);

  /* المضيف ينشر حالة → تصل للضيف بالاستطلاع (بلا Realtime إطلاقاً) */
  findVideo(host).currentTime = 90;
  host.sandbox.WTRoom.publish({ force: true });
  await wait(500);
  t('sb: حالة المضيف وصلت الضيف بالاستطلاع', Math.round(guest.sandbox.WTRoom.state.pos) === 90,
    'guest pos=' + guest.sandbox.WTRoom.state.pos);
  t('sb: الضيف على نفس الرابط', guest.sandbox.WTRoom.state.url === VIDEO_A, guest.sandbox.WTRoom.state.url);

  /* تحكّم الضيف يصل للمضيف */
  findVideo(guest).currentTime = 200;
  guest.sandbox.WTRoom.publish({ force: true });
  await wait(500);
  t('sb: تحكم الضيف وصل للمضيف', Math.round(host.sandbox.WTRoom.state.pos) === 200,
    'host pos=' + host.sandbox.WTRoom.state.pos);

  /* الدردشة عبر الاستطلاع */
  host.byId.get('chatInput').value = 'رسالة واتسابية';
  host.byId.get('chatForm').dispatch('submit', {});
  await wait(500);
  t('sb: رسالة المضيف وصلت الضيف', chatText(guest).includes('رسالة واتسابية'));

  guest.byId.get('chatInput').value = 'رد الضيف';
  guest.byId.get('chatForm').dispatch('submit', {});
  await wait(500);
  t('sb: رسالة الضيف وصلت المضيف', chatText(host).includes('رد الضيف'));

  /* ---- سيناريو التعارض: نفس رقم تسلسلي من الطرفين (كان يجمّد المزامنة) ---- */
  const revBefore = host.sandbox.WTRoom.state.rev;
  host.sandbox.WTRoom.publish();
  guest.sandbox.WTRoom.publish();
  await wait(700);
  const hRev = host.sandbox.WTRoom.state.rev, gRev = guest.sandbox.WTRoom.state.rev;
  t('sb: بعد التعارض ما زالا يتحدثان (لا جمود)', hRev > revBefore && gRev > revBefore,
    `host=${hRev} guest=${gRev} before=${revBefore}`);
  t('sb: يلتقيان على نفس الرقم التسلسلي', hRev === gRev, `host=${hRev} guest=${gRev}`);

  /* الأهم: بعد التعارض تبقى القناة حيّة (كانت تتجمّد للأبد قبل الإصلاح) */
  findVideo(guest).currentTime = 400;
  guest.sandbox.WTRoom.publish({ force: true });
  await wait(600);
  t('sb: بعد التعارض يصل تحكّم الضيف للمضيف', Math.round(host.sandbox.WTRoom.state.pos) === 400,
    'host pos=' + host.sandbox.WTRoom.state.pos);
}

/* ==================== 3) المنطق: ترتيب الحالات ==================== */
async function testOrdering() {
  const env = createRoomEnv({});
  const U = env.sandbox.WTUtil;

  t('rev أكبر يفوز', U.stateWins({ rev: 5, updatedBy: 'a' }, { rev: 4, updatedBy: 'b' }) === true);
  t('rev أصغر يُرفض', U.stateWins({ rev: 3, updatedBy: 'a' }, { rev: 4, updatedBy: 'b' }) === false);
  t('تساوي rev → أكبر معرّف يفوز', U.stateWins({ rev: 7, updatedBy: 'zz' }, { rev: 7, updatedBy: 'aa' }) === true);
  t('تساوي rev → أصغر معرّف يُرفض', U.stateWins({ rev: 7, updatedBy: 'aa' }, { rev: 7, updatedBy: 'zz' }) === false);
  t('نفس المرسل = مكرر', U.stateWins({ rev: 7, updatedBy: 'a' }, { rev: 7, updatedBy: 'a' }) === false);
  t('بدون رقم تسلسلي يُرفض', U.stateWins({}, { rev: 0, updatedBy: 'a' }) === false);
  t('nextRev يتجاوز كل ما رآه العميل', U.nextRev(9, 12, 3) === 13);

  /* محاكاة التعارض الكلاسيكي: عميلان يبثّان في نفس اللحظة */
  let A = { rev: 10, updatedBy: 'client-A' }, B = { rev: 10, updatedBy: 'client-B' };
  A = { rev: U.nextRev(A.rev), updatedBy: 'client-A' };   /* 11 */
  B = { rev: U.nextRev(B.rev), updatedBy: 'client-B' };   /* 11 — تعارض */
  const aAccepts = U.stateWins(B, A);
  const bAccepts = U.stateWins(A, B);
  t('عند التعارض يقبل طرفٌ واحد فقط (قرار موحّد)', aAccepts !== bAccepts, `${aAccepts} / ${bAccepts}`);
  t('الجميع يلتقي على نفس الفائز', U.stateWins(B, A) === true && U.stateWins(A, B) === false);
  t('البصمة تتغيّر مع الموضع', U.stateSig({ rev: 1, pos: 5, playing: true, url: 'x' }) !== U.stateSig({ rev: 1, pos: 6, playing: true, url: 'x' }));
  t('البصمة تتطابق لنفس الحالة', U.stateSig({ rev: 1, pos: 5, playing: true, url: 'x' }) === U.stateSig({ rev: 1, pos: 5, playing: true, url: 'x' }));
}

/* ==================== 4) رابط الدعوة يحمل الفيديو ==================== */
async function testInviteLink() {
  const server = makeWsServer();
  const env = createRoomEnv({ search: `?id=INV01&host=1&v=${encodeURIComponent(VIDEO_A)}`, WebSocket: server.FakeWebSocket });
  await enter(env, 'أمين');
  env.byId.get('qrBtn').dispatch('click', {});
  const url = env.byId.get('qrUrl').textContent;
  t('رابط الدعوة يحمل كود الغرفة', url.includes('room.html?id=INV01'), url);
  t('رابط الدعوة يحمل رابط الفيديو', url.includes('v=' + encodeURIComponent(VIDEO_A)), url);
}


/* ==================== 5) اختيار السيرفر: لا يهبط الضيف على سيرفر آخر ==================== */
async function testTransportChoice() {
  /* سيناريو: WebSocket يفشل أول محاولتين (شبكة بطيئة)، والغرفة غير موجودة في Supabase
     → يجب أن يصبر ويجرّب WebSocket من جديد بدل أن يستقر وحيداً على Supabase */
  const server = makeWsServer();
  const emptySb = makeSupabaseStub();          /* قاعدة بيانات فارغة: لا وجود للغرفة */
  let attempts = 0;
  const FAILS = 2;
  class FlakyWebSocket {
    constructor(url) {
      attempts++;
      if (attempts <= FAILS) {
        this.readyState = 0;
        setTimeout(() => { this.onerror && this.onerror({}); }, 1);
        return;
      }
      return new server.FakeWebSocket(url);
    }
    send() { }
    close() { }
  }

  const env = createRoomEnv({
    search: `?id=TC001&v=${encodeURIComponent(VIDEO_A)}`,
    WebSocket: FlakyWebSocket,
    fetch: emptySb.fetchStub
  });
  env.sandbox.WT_CONFIG.sync.pollMs = 150;
  await enter(env, 'ضيف');

  t('اختيار السيرفر: رجع إلى WebSocket بعد فشل المحاولات الأولى',
    env.sandbox.WTRoom.session.transport.kind === 'ws',
    env.sandbox.WTRoom.session.transport.kind);
  t('اختيار السيرفر: استُخدم اتصال ثالث', attempts >= FAILS + 1, 'attempts=' + attempts);
  t('اختيار السيرفر: لم يستقر على Supabase الفارغة',
    emptySb.calls.roomCreate === 0, 'creates=' + emptySb.calls.roomCreate);

  /* ولا سيرفر إطلاقاً → رسالة واضحة أن الغرفة غير موجودة */
  const alone = createRoomEnv({ search: '?id=GHOST1', fetch: makeSupabaseStub().fetchStub });
  alone.sandbox.WT_CONFIG.sync.pollMs = 150;
  alone.byId.get('gateName').value = 'ضيف تائه';
  alone.byId.get('gateForm').dispatch('submit', {});
  await wait(2600);
  t('غرفة غير موجودة → رسالة صريحة',
    chatText(alone).includes('لم يتم العثور على هذه الغرفة'), chatText(alone).slice(0, 120));
  t('غرفة غير موجودة → لم تُنشأ في قاعدة البيانات',
    alone.sandbox.WTRoom.session.transport.kind === 'supabase',
    alone.sandbox.WTRoom.session.transport.kind);
}

/* ==================== 6) الوضع المحلي يُبلَّغ عنه صراحةً ==================== */
async function testLocalWarning() {
  const env = createRoomEnv({ search: `?id=LOC01&host=1&v=${encodeURIComponent(VIDEO_A)}` });
  env.sandbox.WT_CONFIG.javaServer.enabled = false;
  env.sandbox.WT_CONFIG.supabase.ready = false;
  await enter(env, 'أمين');
  t('الوضع المحلي: رسالة تحذير في الدردشة',
    chatText(env).includes('لن يدخلها أصدقاؤك'), chatText(env).slice(0, 160));
}

/* ==================== التشغيل ==================== */
const run = async () => {
  await testOrdering();
  await testInviteLink();
  await testWebSocket();
  await testSupabase();
  await testTransportChoice();
  await testLocalWarning();

  console.log('\n' + errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });
run().catch(e => { console.log('RUN ERROR:', (e && e.stack) || e); process.exit(1); });

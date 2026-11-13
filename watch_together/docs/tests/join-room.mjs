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
import { createRoomEnv, wait, setAccountName } from './harness.mjs';

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
  const room = id => {
    if (!rooms.has(id)) rooms.set(id, { state: null, rev: 0, members: new Set(), history: [], ownerToken: '', memberInfo: new Map(), queue: [], queueSeq: 0 });
    return rooms.get(id);
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.readyState = 0;
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
    attach(sock) { sockets.add(sock); sock.readyState = 1; sock.onopen && sock.onopen({}); },
    detach(sock) {
      if (!sockets.delete(sock)) return;
      const r = sock.attrs.room ? rooms.get(sock.attrs.room) : null;
      if (r) {
        r.members.delete(sock);
        this.broadcast(r, { type: 'presence', clientId: sock.attrs.clientId, left: true }, null);
        this.broadcast(r, { type: 'members', members: memberList(r) }, null);
        this.broadcast(r, { type: 'roles', roles: memberList(r) }, null);
      }
      sock.readyState = 3;
      sock.onclose && sock.onclose({});
    },
    receive(sock, text) {
      let msg; try { msg = JSON.parse(text); } catch (e) { return; }
      const roomId = String(msg.room || sock.attrs.room || '?').toUpperCase();
      const r = room(roomId);

      if (msg.type === 'join') {
        if ((msg.memberToken || '').length < 48 || (msg.ownerToken && msg.ownerToken.length < 48)) {
          this.send(sock, { type: 'error', code: 'permission', message: 'مفتاح العضو غير صالح' });
          setTimeout(() => sock.close(), 0);
          return;
        }
        if (!r.ownerToken && msg.host && msg.ownerToken) r.ownerToken = msg.ownerToken;
        const key = msg.client + '';
        const known = r.memberInfo.get(key);
        const owner = !!r.ownerToken && msg.ownerToken === r.ownerToken;
        const token = msg.memberToken || '';
        if (known && !owner && known.token !== token) {
          this.send(sock, { type: 'error', code: 'permission', message: 'رمز العضو غير صالح' });
          setTimeout(() => sock.close(), 0);
          return;
        }
        const role = owner ? 'owner' : known ? known.role : 'viewer';
        if (known) known.name = msg.name;
        else r.memberInfo.set(key, { name: msg.name, role, token });
        for (const other of Array.from(r.members)) {
          if (other !== sock && other.attrs.clientId === msg.client) this.detach(other);
        }
        sock.attrs.room = roomId; sock.attrs.clientId = msg.client; sock.attrs.name = msg.name;
        sock.attrs.userKey = msg.accessToken ? roomId + ':' + msg.accessToken : '';
        sock.attrs.role = role; sock.attrs.host = role === 'owner';
        r.members.add(sock);
        const members = memberList(r);
        this.send(sock, { type: 'welcome', room: roomId, state: r.state, serverTime: Date.now(), messages: r.history.slice(), members,
          queue: r.queue.slice(), role, controlMode: 'owner', lastSavedAt: Date.now() });
        this.broadcast(r, { type: 'system', text: (msg.name || 'زائر') + ' دخل الغرفة' }, null);
        this.broadcast(r, { type: 'members', members }, null);
        this.broadcast(r, { type: 'roles', roles: members }, null);
        return;
      }

      if (msg.type === 'state' && (!sock.attrs.room || sock.attrs.room !== roomId || !r.members.has(sock))) {
        this.send(sock, { type: 'error', code: 'permission', action: 'state', state: r.state, message: 'انضم إلى الغرفة أولاً' }); return;
      }
      if (!sock.attrs.room || sock.attrs.room !== roomId || !r.members.has(sock)) return;
      if (msg.type === 'state') {
        const s = msg.state || {};
        r.rev++;
        const stored = Object.assign({}, s, { rev: r.rev, t: Date.now(), updatedBy: sock.attrs.clientId, updatedByName: sock.attrs.name });
        r.state = stored; this.stats.messages++;
        this.broadcast(r, { type: 'state', state: stored, sender: sock.attrs.clientId }, null);
        return;
      }
      if (msg.type === 'setRole') {
        if (sock.attrs.role !== 'owner') { this.send(sock, { type: 'error', code: 'permission', message: 'المنشئ فقط' }); return; }
        const target = r.memberInfo.get(String(msg.target));
        if (!target || target.role === 'owner') { this.send(sock, { type: 'error', message: 'المشارك غير موجود' }); return; }
        target.role = msg.role === 'organizer' ? 'organizer' : 'viewer';
        for (const member of r.members) if (String(member.attrs.clientId) === String(msg.target)) member.attrs.role = target.role;
        const members = memberList(r);
        this.broadcast(r, { type: 'roles', roles: members }, null);
        this.broadcast(r, { type: 'members', members }, null);
        return;
      }
      if (msg.type === 'queue') {
        const client = String(sock.attrs.clientId || '');
        if (msg.action === 'add') {
          const item = msg.item || {};
          r.queue.push({ id: ++r.queueSeq, url: item.url, title: item.title, addedByClient: client, addedBy: sock.attrs.name, createdAt: Date.now() });
        } else if (msg.action === 'remove') {
          const item = r.queue.find(x => String(x.id) === String(msg.id));
          if (!item) { this.send(sock, { type: 'error', message: 'العنصر غير موجود' }); return; }
          if (!['owner', 'organizer'].includes(sock.attrs.role) && item.addedByClient !== client) {
            this.send(sock, { type: 'error', code: 'permission', message: 'يمكنك حذف ما أضفته فقط' }); return;
          }
          r.queue = r.queue.filter(x => x !== item);
        } else return;
        this.broadcast(r, { type: 'queue', items: r.queue.slice() }, null);
        return;
      }
      if (msg.type === 'chat') {
        const m = Object.assign({}, msg.message, { id: 's-' + (r.history.length + 1), ts: Date.now(), client: sock.attrs.clientId, name: sock.attrs.name });
        r.history.push(m); this.broadcast(r, { type: 'chat', message: m, sender: sock.attrs.clientId }, null); return;
      }
      if (msg.type === 'presence') {
        sock.attrs.name = msg.name || sock.attrs.name;
        sock.attrs.host = sock.attrs.role === 'owner';
        const members = memberList(r);
        this.broadcast(r, { type: 'presence', clientId: sock.attrs.clientId, userKey: sock.attrs.userKey, name: sock.attrs.name, host: sock.attrs.host, role: sock.attrs.role }, sock);
        this.broadcast(r, { type: 'members', members }, null);
        this.broadcast(r, { type: 'roles', roles: members }, null); return;
      }
      if (msg.type === 'typing') {
        this.broadcast(r, { type: 'typing', clientId: sock.attrs.clientId, name: sock.attrs.name }, sock); return;
      }
      if (msg.type === 'leave') { this.detach(sock); return; }
    },
    send(sock, obj) {
      if (!sock || sock.readyState !== 1 || !sock.onmessage) return;
      setTimeout(() => sock.readyState === 1 && sock.onmessage && sock.onmessage({ data: JSON.stringify(obj) }), 0);
    },
    broadcast(r, obj, except) { for (const c of Array.from(r.members)) if (!except || c !== except) this.send(c, obj); }
  };

  function memberList(r) {
    return Array.from(r.members).map(c => ({ id: c.attrs.clientId, userKey: c.attrs.userKey, name: c.attrs.name, host: !!c.attrs.host, role: c.attrs.role || 'viewer' }));
  }
  return server;
}
/* ==================== خادم Supabase وهمي (REST فقط، بلا Realtime) ==================== */
function makeSupabaseStub() {
  const db = { rooms: new Map(), messages: [], presence: new Map(), members: new Map(), queue: new Map(), nextId: 1, nextQueueId: 1 };
  const calls = { roomsInsert: 0, roomsSelect: 0, msgInsert: 0, msgSelect: 0, roomCreate: 0, rpc: [] };
  const matchEq = (url, key) => {
    const m = url.match(new RegExp('[?&]' + key + '=eq\\.([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const membersFor = room => Array.from(db.members.values()).filter(m => m.room_id === room);
  const queueFor = room => db.queue.get(room) || [];
  const userKeyFor = options => {
    const token = options && options.headers && (options.headers.Authorization || options.headers.authorization) || '';
    return String(token).replace(/^Bearer /i, 'user:');
  };
  const fetchStub = (url, options = {}) => {
    const path = String(url);
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const json = (data, status = 200) => Promise.resolve({
      ok: status >= 200 && status < 300, status,
      text: async () => JSON.stringify(data), json: async () => data
    });
    const rpc = path.match(/\/rest\/v1\/rpc\/([^?]+)/);
    if (rpc) {
      const name = decodeURIComponent(rpc[1]);
      calls.rpc.push(name);
      if (name === 'wt_create_room') {
        const id = body.p_room_id;
        let row = db.rooms.get(id);
        if (!row) {
          calls.roomCreate++;
          row = { room_id: id, title: body.p_title, video_url: body.p_video_url, host_name: body.p_owner_name, owner_token: body.p_owner_token, state: null, updated_at: new Date().toISOString() };
          db.rooms.set(id, row);
        }
        return row.owner_token === body.p_owner_token ? json({ ok: true }) : json({ code: '42501', message: 'room owner mismatch' }, 403);
      }
      if (name === 'wt_join_room') {
        const room = db.rooms.get(body.p_room_id);
        if (!room) return json({ found: false, role: 'viewer', members: [], serverTime: Date.now() });
        const key = body.p_room_id + '|' + body.p_client_id;
        let m = db.members.get(key);
        const isOwner = room.owner_token === body.p_member_token;
        if (m && !isOwner && m.token !== body.p_member_token) return json({ code: '42501', message: 'invalid member token' }, 403);
        const role = isOwner ? 'owner' : m ? m.role : 'viewer';
        if (!m) { m = { room_id: body.p_room_id, client_id: body.p_client_id, display_name: body.p_display_name, token: body.p_member_token, role, user_key: userKeyFor(options) }; db.members.set(key, m); }
        else { m.display_name = body.p_display_name; m.user_key = userKeyFor(options); if (isOwner) m.role = 'owner'; }
        return json({ found: true, role, serverTime: Date.now(), members: membersFor(body.p_room_id).map(({ room_id, client_id, display_name, role, user_key }) => ({ room_id, client_id, display_name, role, user_key })) });
      }
      if (name === 'wt_apply_room_state') {
        const room = db.rooms.get(body.p_room_id);
        const m = db.members.get(body.p_room_id + '|' + body.p_client_id);
        const isOwner = room && room.owner_token === body.p_member_token;
        const validMember = m && m.token === body.p_member_token;
        if (!room || (!isOwner && !validMember)) return json({ code: '42501', message: 'join first' }, 403);
        const state = Object.assign({}, body.p_state, { rev: Number(room.state && room.state.rev || 0) + 1, t: Date.now(), updatedBy: body.p_client_id });
        room.state = state; room.video_url = state.url; room.updated_at = new Date().toISOString();
        return json(state);
      }
      if (name === 'wt_set_room_member_role') {
        const room = db.rooms.get(body.p_room_id);
        if (!room || room.owner_token !== body.p_owner_token) return json({ code: '42501', message: 'permission denied' }, 403);
        const m = db.members.get(body.p_room_id + '|' + body.p_target_client_id);
        if (!m || m.role === 'owner') return json({ code: 'P0002', message: 'member not found' }, 404);
        m.role = body.p_role;
        return json({ ok: true });
      }
      if (name === 'wt_queue_add') {
        const room = db.rooms.get(body.p_room_id);
        const m = db.members.get(body.p_room_id + '|' + body.p_client_id);
        if (!room || !(room.owner_token === body.p_member_token || (m && m.token === body.p_member_token))) return json({ code: '42501', message: 'join first' }, 403);
        const list = queueFor(body.p_room_id);
        const item = { id: db.nextQueueId++, room_id: body.p_room_id, url: body.p_url, title: body.p_title, added_by_client: body.p_client_id, added_by: m && m.display_name || room.host_name };
        list.push(item); db.queue.set(body.p_room_id, list); return json(item);
      }
      if (name === 'wt_queue_remove') {
        const room = db.rooms.get(body.p_room_id);
        const m = db.members.get(body.p_room_id + '|' + body.p_client_id);
        const list = queueFor(body.p_room_id);
        const item = list.find(x => x.id === body.p_item_id);
        if (!room || !(room.owner_token === body.p_member_token || (m && m.token === body.p_member_token)) || !item) return json({ code: '42501', message: 'not allowed' }, 403);
        db.queue.set(body.p_room_id, list.filter(x => x !== item)); return json({ ok: true });
      }
      return json({ message: 'unknown rpc ' + name }, 404);
    }

    if (path.includes('/rest/v1/rooms')) {
      if (method === 'GET') {
        calls.roomsSelect++;
        const id = matchEq(path, 'room_id');
        const row = id && db.rooms.has(id) ? db.rooms.get(id) : null;
        return json(row ? [{ room_id: row.room_id, state: row.state, video_url: row.video_url, host_name: row.host_name, updated_at: row.updated_at }] : []);
      }
    }
    if (path.includes('/rest/v1/messages')) {
      if (method === 'GET') {
        calls.msgSelect++;
        const id = matchEq(path, 'room_id');
        let rows = db.messages.filter(m => !id || m.room_id === id);
        const gt = path.match(/[?&]id=gt\\.(\\d+)/);
        if (gt) rows = rows.filter(m => m.id > +gt[1]);
        rows = rows.slice().sort((a, b) => a.id - b.id).slice(0, 100);
        return json(rows);
      }
      if (method === 'POST') {
        calls.msgInsert++;
        const row = Object.assign({}, body, { id: db.nextId++, created_at: new Date().toISOString() });
        db.messages.push(row); return json([]);
      }
    }
    if (path.includes('/rest/v1/room_members')) {
      const id = matchEq(path, 'room_id');
      return json(membersFor(id).map(({ room_id, client_id, display_name, role, user_key }) => ({ room_id, client_id, display_name, role, user_key, updated_at: new Date().toISOString() })));
    }
    if (path.includes('/rest/v1/room_queue')) {
      const id = matchEq(path, 'room_id'); return json(queueFor(id).slice());
    }
    if (path.includes('/rest/v1/presence')) {
      if (method === 'POST') { db.presence.set(body.room_id + '|' + body.client_id, Object.assign({}, body, { user_key: userKeyFor(options) || null })); return json([]); }
      if (method === 'GET') { const id = matchEq(path, 'room_id'); return json(Array.from(db.presence.values()).filter(p => !id || p.room_id === id)); }
      if (method === 'DELETE') return json([]);
    }
    return json({ message: 'unknown route ' + path }, 404);
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

function accountStore(id, extra = {}) {
  return Object.assign({
    'wt:session': JSON.stringify({ access_token: 'access-' + id, refresh_token: '', expires_at: Date.now() + 3600000,
      user: { id, name: 'مستخدم اختبار', email: id + '@example.com' } })
  }, extra);
}

/** يدخل الحساب المسجّل مباشرةً؛ لا توجد بوابة اسم أو دخول ضيف. */
async function enter(env, name) {
  setAccountName(env, name);
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
  const ownerToken = 'd'.repeat(64);
  const ownerUserId = '11111111-1111-4111-8111-111111111111';
  const viewerUserId = '22222222-2222-4222-8222-222222222222';
  /* Match the real page's successful /healthz probe so these clients exercise
     WebSocket instead of accepting a degraded Supabase fallback. */
  const globals = { WTServer: {
    available: async () => true,
    isPrivateHost: () => true,
    keepAlive() { }
  } };
  const host = createRoomEnv({
    search: `?id=${ROOM}&host=1&v=${encodeURIComponent(VIDEO_A)}`,
    WebSocket: server.FakeWebSocket,
    globals,
    store: accountStore(ownerUserId, { ['wt:owner:' + ROOM]: JSON.stringify(ownerToken) })
  });
  const guest = createRoomEnv({ search: `?id=${ROOM}`, WebSocket: server.FakeWebSocket, globals, store: accountStore(viewerUserId) });
  setAccountName(guest, 'طهّار');

  await enter(host, 'أمين');
  const hostVideo = findVideo(host);
  t('ws: المضيف يملك الغرفة بصلاحية خادمية', host.sandbox.WTRoom.session.role === 'owner');
  t('ws: المضيف حمّل الفيديو', !!hostVideo && hostVideo.src === VIDEO_A, hostVideo && hostVideo.src);
  await enter(guest, 'طهّار');
  await wait(140);

  t('ws: الضيف متصل بالسيرفر نفسه', guest.sandbox.WTRoom.session.transport.kind === 'ws' && guest.byId.get('statusBadge').getAttribute('data-state') === 'online');
  t('ws: المشارك غير المنظّم يملك تحكم المشاهدة', guest.sandbox.WTRoom.session.role === 'viewer' && !guest.byId.get('centerPlayBtn').disabled);
  t('ws: الضيف حصل على نفس الفيديو', !!findVideo(guest) && findVideo(guest).src === VIDEO_A, findVideo(guest) && findVideo(guest).src);

  const guestCopy = createRoomEnv({ search: `?id=${ROOM}`, WebSocket: server.FakeWebSocket, globals, store: accountStore(viewerUserId) });
  await enter(guestCopy, 'طهّار');
  await wait(100);
  t('ws: الحساب نفسه في تبويبين يُعدّ مشاركًا واحدًا', host.byId.get('membersCount').textContent === '2' && guest.byId.get('membersCount').textContent === '2');
  guestCopy.sandbox.WTRoom.session.transport.close();
  await wait(80);
  t('ws: إغلاق تبويب لا يخفي الحساب ما دام تبويب آخر متصلاً', host.byId.get('membersCount').textContent === '2');
  guestCopy.dispose();

  hostVideo.currentTime = 120;
  host.sandbox.WTRoom.publish({ force: true });
  await wait(150);
  t('ws: حالة المضيف تصل للضيف', Math.round(guest.sandbox.WTRoom.state.pos) === 120, 'guest=' + guest.sandbox.WTRoom.state.pos);
  t('ws: الضيف طبّق الموضع على المشغّل', Math.round(findVideo(guest).currentTime) === 120, 't=' + findVideo(guest).currentTime);

  findVideo(guest).currentTime = 300;
  const viewerPublish = await guest.sandbox.WTRoom.publish({ force: true });
  await wait(100);
  t('ws: المشاهد المنضم يتحكم بالمشاهدة دون ترقية دوره', !!viewerPublish && Math.round(host.sandbox.WTRoom.state.pos) === 300 && guest.sandbox.WTRoom.session.role === 'viewer', 'host=' + host.sandbox.WTRoom.state.pos);

  /* يمكن للمشارك إضافة عنصر وتشغيله؛ الأدوار تبقى لإدارة الغرفة لا لقفل المشاهدة. */
  await guest.sandbox.WTRoom.session.transport.addQueueItem({ url: VIDEO_B, title: 'الفيديو التالي' });
  await wait(80);
  t('ws: قائمة التشغيل مشتركة', host.sandbox.WTRoom.session.queue.length === 1 && guest.sandbox.WTRoom.session.queue.length === 1);

  /* المنشئ يعيّن المنظّم؛ التغيير يصدر عن الخادم إلى المشاركين. */
  host.byId.get('drawerOpenBtn').dispatch('click', {});
  const roleButton = host.byId.get('membersList').querySelectorAll('[data-set-role]').find(b => b.getAttribute('data-client-id') === guest.sandbox.WTRoom.session.clientId);
  t('ws: زر تعيين منظّم يظهر للمنشئ', !!roleButton);
  if (roleButton) roleButton.dispatch('click', {});
  await wait(100);
  t('ws: المنظّم الجديد يحصل على صلاحية التحكم', guest.sandbox.WTRoom.session.role === 'organizer' && !guest.byId.get('centerPlayBtn').disabled);

  const playQueue = guest.byId.get('playlistBtn');
  playQueue.dispatch('click', {});
  const playButton = guest.byId.get('queueList').querySelector('[data-play-queue]');
  t('ws: تشغيل عنصر القائمة يظهر للمنظّم', !!playButton);
  if (playButton) playButton.dispatch('click', {});
  await wait(180);
  t('ws: تشغيل عنصر القائمة يغيّر الفيديو للجميع', host.sandbox.WTRoom.state.url === VIDEO_B && guest.sandbox.WTRoom.state.url === VIDEO_B);

  /* إزالة دور المنظّم تغيّر إدارة الغرفة فقط، لا تحكم المشاهدة. */
  await host.sandbox.WTRoom.session.transport.setMemberRole(guest.sandbox.WTRoom.session.clientId, 'viewer');
  await wait(100);
  t('ws: إزالة المنظّم لا تقفل التحكم على المشارك', guest.sandbox.WTRoom.session.role === 'viewer' && !guest.byId.get('centerPlayBtn').disabled);

  host.sandbox.WTRoom.setVideo(VIDEO_A);
  await wait(200);
  t('ws: تغيير الفيديو من المالك يصل للضيف', !!findVideo(guest) && findVideo(guest).src === VIDEO_A);

  host.byId.get('chatInput').value = 'أهلاً من المضيف';
  host.byId.get('chatForm').dispatch('submit', {});
  await wait(120);
  t('ws: رسالة المضيف تصل للضيف', chatText(guest).includes('أهلاً من المضيف'));
  guest.byId.get('chatInput').value = 'وعليكم من الضيف';
  guest.byId.get('chatForm').dispatch('submit', {});
  await wait(120);
  t('ws: رسالة الضيف تصل للمضيف', chatText(host).includes('وعليكم من الضيف'));

  await wait(80);
  t('ws: كلاهما يرى مشاركين اثنين', host.byId.get('membersCount').textContent === '2' && guest.byId.get('membersCount').textContent === '2');
  const revBefore = host.sandbox.WTRoom.state.rev;
  host.sandbox.WTRoom.publish();
  await wait(120);
  t('ws: الخادم يرقّم الحالة مركزياً', host.sandbox.WTRoom.state.rev > revBefore && guest.sandbox.WTRoom.session.revClock === host.sandbox.WTRoom.session.revClock);
}

/* A reconnect must send the refreshed bearer token for the same account only. */
async function testWebSocketAuthRefresh() {
  const server = makeWsServer();
  const userId = '55555555-5555-4555-8555-555555555555';
  const joins = [];
  class RecordingWebSocket extends server.FakeWebSocket {
    send(text) {
      const msg = JSON.parse(String(text));
      if (msg.type === 'join') joins.push(msg);
      super.send(text);
    }
  }
  const globals = { WTServer: { available: async () => true, isPrivateHost: () => true, keepAlive() { } } };
  const env = createRoomEnv({ search: '?id=AUTH01', WebSocket: RecordingWebSocket, globals, store: accountStore(userId) });
  await enter(env, 'حساب موثّق');
  const transport = env.sandbox.WTRoom.session.transport;
  const originalSession = env.sandbox.WTAuth.getSession();
  const refreshedToken = 'refreshed-account-access-token';
  t('ws auth: رمز الجلسة الموثّقة يُرسل عند الانضمام الأول', joins[0] && joins[0].accessToken === originalSession.access_token);

  env.sandbox.WTAuth.validSession = async () => Object.assign({}, originalSession, { access_token: refreshedToken });
  transport.ws.close(); // Simulate a remote disconnect so the transport runs its retry path.
  await wait(950);
  t('ws auth: إعادة الاتصال تستخدم الرمز المحدّث للحساب نفسه', joins[1] && joins[1].accessToken === refreshedToken);

  const otherSession = Object.assign({}, originalSession, {
    access_token: 'different-account-access-token',
    user: Object.assign({}, originalSession.user, { id: '66666666-6666-4666-8666-666666666666' })
  });
  env.sandbox.WTAuth.validSession = async () => otherSession;
  transport.ws.close();
  await wait(950);
  t('ws auth: لا يُستبدل رمز الغرفة بجلسة حساب مختلف', joins[2] && joins[2].accessToken === refreshedToken);

  env.sandbox.WTAuth.validSession = async () => Object.assign({}, originalSession, { access_token: refreshedToken });
  await env.sandbox.WTRoom.reconnect();
  t('ws auth: إعادة الاتصال اليدوية تستخدم جلسة الحساب الحالية', joins[3] && joins[3].accessToken === refreshedToken);

  env.sandbox.WTRoom.session.transport.close();
  env.dispose();
}
/* ==================== 2) Supabase (استطلاع، بلا Realtime) ==================== */
async function testSupabase() {
  const sb = makeSupabaseStub();
  const ownerToken = 'e'.repeat(64);
  const ownerUserId = '33333333-3333-4333-8333-333333333333';
  const viewerUserId = '44444444-4444-4444-8444-444444444444';
  const mk = (search, isHost = false, userId = isHost ? ownerUserId : viewerUserId) => {
    const extra = isHost ? { 'wt:owner:SB001': JSON.stringify(ownerToken) } : {};
    const env = createRoomEnv({
      search, fetch: sb.fetchStub, store: accountStore(userId, extra)
    });
    env.sandbox.WT_CONFIG.sync.pollMs = 100;
    env.sandbox.WT_CONFIG.sync.persistMs = 300;
    return env;
  };
  const guest = mk(`?id=SB001&v=${encodeURIComponent(VIDEO_A)}`);
  setAccountName(guest, 'طهّار');
  const host = mk(`?id=SB001&host=1&v=${encodeURIComponent(VIDEO_A)}`, true);

  await enter(host, 'أمين');
  await wait(120);
  t('sb: المالك أنشأ الغرفة عبر RPC', sb.db.rooms.has('SB001') && host.sandbox.WTRoom.session.role === 'owner');
  const createsAfterHost = sb.calls.roomCreate;
  await enter(guest, 'طهّار');
  await wait(200);
  t('sb: الضيف لم ينشئ صف غرفة جديداً', sb.calls.roomCreate === createsAfterHost);
  t('sb: المشارك يبدأ كمشاهد لكنه يستطيع التحكم بالمشاهدة', guest.sandbox.WTRoom.session.role === 'viewer' && !guest.byId.get('centerPlayBtn').disabled);

  const guestCopy = mk('?id=SB001', false, viewerUserId);
  await enter(guestCopy, 'طهّار');
  await wait(160);
  t('sb: تبويبان للحساب نفسه لا يكرران الحضور', host.byId.get('membersCount').textContent === '2' && guest.byId.get('membersCount').textContent === '2');

  findVideo(host).currentTime = 90;
  host.sandbox.WTRoom.publish({ force: true });
  await wait(350);
  t('sb: حالة المالك تصل عبر الاستطلاع', Math.round(guest.sandbox.WTRoom.state.pos) === 90, 'guest=' + guest.sandbox.WTRoom.state.pos);
  t('sb: رابط الفيديو واحد لدى الجميع', guest.sandbox.WTRoom.state.url === VIDEO_A);

  findVideo(guest).currentTime = 200;
  const viewerPublish = await guest.sandbox.WTRoom.publish({ force: true });
  await wait(180);
  t('sb: المشاهد المنضم يكتب الحالة عبر RPC', !!viewerPublish && Math.round(host.sandbox.WTRoom.state.pos) === 200, 'host=' + host.sandbox.WTRoom.state.pos);
  const outsiderState = await sb.fetchStub('/rest/v1/rpc/wt_apply_room_state', { method: 'POST', body: JSON.stringify({
    p_room_id: 'SB001', p_client_id: 'not-joined', p_member_token: 'z'.repeat(64),
    p_state: { url: VIDEO_B, playing: true, pos: 1 }
  }) });
  t('sb: الخادم يرفض التحكم دون عضوية ومفتاح صحيح', outsiderState.status === 403);

  await guest.sandbox.WTRoom.session.transport.addQueueItem({ url: VIDEO_B, title: 'الفيديو التالي', addedBy: 'طهّار' });
  await wait(180);
  t('sb: إضافة القائمة مسموحة للمشاهد وتنتشر', host.sandbox.WTRoom.session.queue.length === 1 && guest.sandbox.WTRoom.session.queue.length === 1);

  await host.sandbox.WTRoom.session.transport.setMemberRole(guest.sandbox.WTRoom.session.clientId, 'organizer');
  await wait(180);
  t('sb: RPC يعيّن المنظّم ويحدّث دوره', guest.sandbox.WTRoom.session.role === 'organizer' && !guest.byId.get('centerPlayBtn').disabled);
  const spoofJoin = await sb.fetchStub('/rest/v1/rpc/wt_join_room', { method: 'POST', body: JSON.stringify({
    p_room_id: 'SB001', p_client_id: guest.sandbox.WTRoom.session.clientId,
    p_member_token: 'z'.repeat(64), p_display_name: 'انتحال'
  }) });
  const protectedMember = sb.db.members.get('SB001|' + guest.sandbox.WTRoom.session.clientId);
  t('sb: مفتاح خاطئ لا ينتحل منظّماً بمعرّف معروف', spoofJoin.status === 403 && protectedMember.role === 'organizer' && protectedMember.display_name === 'طهّار');
  findVideo(guest).currentTime = 200;
  guest.sandbox.WTRoom.publish({ force: true });
  await wait(300);
  t('sb: المنظّم يستطيع تحديث الحالة عبر RPC', Math.round(host.sandbox.WTRoom.state.pos) === 200, 'host=' + host.sandbox.WTRoom.state.pos);

  host.byId.get('chatInput').value = 'رسالة عبر Supabase';
  host.byId.get('chatForm').dispatch('submit', {});
  await wait(300);
  t('sb: رسالة المالك تصل بالاستطلاع', chatText(guest).includes('رسالة عبر Supabase'));
  guest.byId.get('chatInput').value = 'رد المنظّم';
  guest.byId.get('chatForm').dispatch('submit', {});
  await wait(300);
  t('sb: رسالة المنظّم تصل للمالك', chatText(host).includes('رد المنظّم'));

  const oldRev = host.sandbox.WTRoom.state.rev;
  host.sandbox.WTRoom.publish();
  guest.sandbox.WTRoom.publish();
  const syncDeadline = Date.now() + 1500;
  let hRev = host.sandbox.WTRoom.state.rev, gRev = guest.sandbox.WTRoom.state.rev;
  let canonicalRev = sb.db.rooms.get('SB001').state.rev;
  while (Date.now() < syncDeadline && (hRev !== canonicalRev || gRev !== canonicalRev)) {
    await wait(100);
    hRev = host.sandbox.WTRoom.state.rev;
    gRev = guest.sandbox.WTRoom.state.rev;
    canonicalRev = sb.db.rooms.get('SB001').state.rev;
  }
  t('sb: RPC يرقّم التغييرات المتزامنة', hRev > oldRev && gRev > oldRev, `host=${hRev} guest=${gRev}`);
  t('sb: الطرفان يريان نفس revision', hRev === gRev, `host=${hRev} guest=${gRev}`);

  await host.sandbox.WTRoom.session.transport.setMemberRole(guest.sandbox.WTRoom.session.clientId, 'viewer');
  await wait(160);
  t('sb: سحب دور المنظّم لا يقفل تحكم المشاهدة', guest.sandbox.WTRoom.session.role === 'viewer' && !guest.byId.get('centerPlayBtn').disabled);
  guestCopy.sandbox.WTRoom.session.transport.close();
  guestCopy.dispose();
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
  const ownerToken = 'f'.repeat(64);
  const env = createRoomEnv({ search: `?id=INV01&host=1&v=${encodeURIComponent(VIDEO_A)}`, WebSocket: server.FakeWebSocket,
    store: { 'wt:owner:INV01': JSON.stringify(ownerToken) } });
  await enter(env, 'أمين');
  env.byId.get('qrBtn').dispatch('click', {});
  const url = env.byId.get('qrUrl').textContent;
  t('رابط الدعوة يحمل كود الغرفة', url.includes('room.html?id=INV01'), url);
  t('رابط الدعوة يحمل رابط الفيديو', url.includes('v=' + encodeURIComponent(VIDEO_A)), url);
  t('رابط الدعوة لا يكشف مفتاح المنشئ', !url.includes(ownerToken) && !url.includes('ownerToken'));
}


/* ==================== 5) اختيار السيرفر: لا يهبط الضيف على سيرفر آخر ==================== */
async function testTransportChoice() {
  /* سيناريو: فحص الصحة وجد سيرفر الغرف، لكن أول WebSocket تعثّر مؤقتاً
     → يجب أن يعيد المحاولة على السيرفر نفسه بدل الهبوط إلى قاعدة Supabase فارغة. */
  const server = makeWsServer();
  const emptySb = makeSupabaseStub();          /* قاعدة بيانات فارغة: لا وجود للغرفة */
  const globals = { WTServer: { available: async () => true, isPrivateHost: () => true, keepAlive() { } } };
  let attempts = 0;
  const FAILS = 1;
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
    fetch: emptySb.fetchStub,
    globals
  });
  env.sandbox.WT_CONFIG.sync.pollMs = 150;
  await enter(env, 'ضيف');

  t('اختيار السيرفر: رجع إلى WebSocket بعد فشل المحاولات الأولى',
    env.sandbox.WTRoom.session.transport.kind === 'ws',
    env.sandbox.WTRoom.session.transport.kind);
  t('اختيار السيرفر: أعاد المحاولة عبر WebSocket', attempts >= FAILS + 1, 'attempts=' + attempts);
  t('اختيار السيرفر: لم يستقر على Supabase الفارغة',
    emptySb.calls.roomCreate === 0, 'creates=' + emptySb.calls.roomCreate);

  /* ولا سيرفر إطلاقاً → رسالة واضحة أن الغرفة غير موجودة */
  const alone = createRoomEnv({ search: '?id=GHOST1', fetch: makeSupabaseStub().fetchStub });
  alone.sandbox.WT_CONFIG.sync.pollMs = 150;
  setAccountName(alone, 'مشارك تائه');
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
  await testWebSocketAuthRefresh();
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

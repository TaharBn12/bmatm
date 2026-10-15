/* =========================================================
   WatchTogether — اختبارات «سيرفر Supabase» الجديد
   التشغيل:  node docs/tests/supabase-server.mjs
   ---------------------------------------------------------
   يغطّي:
     1) ترجمة أخطاء Supabase إلى أسباب وحلول مفهومة
     2) تحمّل التطبيق لمشروع ناقص (جدول الرسائل مفقود) — المزامنة تستمر
     3) أداة sbctl: قراءة/كتابة الإعدادات + رفع رقم الكاش + جلب المفتاح
     4) فحص doctor على خادم PostgREST وهمي (محلي)
     5) نافذة «تشخيص الاتصال» في الغرفة + إعادة الاتصال
   ========================================================= */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRoomEnv, wait, base } from './harness.mjs';
import { readConfig, writeConfig, bumpVersion, pickAnonKey, doctorProject } from '../../tools/sbctl.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name} ${extra}`); }
};

/* =========================================================
   أدوات
   ========================================================= */
/** يبحث عن عنصر الفيديو داخل شجرة المشغّل الوهمية */
function findVideo(env) {
  let out = null;
  const walk = (n) => {
    if (!n || !n.children || out) return;
    n.children.forEach(c => {
      if (!out && String(c.tagName) === 'VIDEO') out = c;
      walk(c);
    });
  };
  walk(env.byId.get('player'));
  return out;
}

/* =========================================================
   1) ترجمة الأخطاء
   ========================================================= */
function testClassify() {
  const env = createRoomEnv({});
  const C = env.sandbox.WTTransport.classifyError;
  const mk = (status, code, msg) => {
    const e = new Error('supabase: ' + msg);
    e.status = status; e.code = code;
    return C(e);
  };

  t('خطأ: جدول مفقود → missing-table', mk(404, '42P01', 'relation does not exist').code === 'missing-table');
  t('خطأ: RLS → rls', mk(403, '42501', 'permission denied').code === 'rls');
  t('خطأ: مفتاح → bad-key', mk(401, '', 'Invalid API key').code === 'bad-key');
  t('خطأ: عنوان → bad-url', mk(404, '', 'Not Found').code === 'bad-url');
  t('خطأ: مشروع متوقف → project-down', mk(522, '', 'Cloudflare').code === 'project-down');
  t('خطأ: شبكة → network', C(new Error('Failed to fetch')).code === 'network');
  t('كل خطأ له عنوان وحل بالعربية',
    ['missing-table', 'rls', 'bad-key', 'bad-url', 'project-down', 'network']
      .every(c => {
        const d = c === 'network' ? C(new Error('Failed to fetch'))
          : mk(404, c === 'missing-table' ? '42P01' : '', 'x');
        return d.title && d.fix && d.title.length > 4 && d.fix.length > 8;
      }));
}

/* =========================================================
   2) تحمّل مشروع ناقص: جدول الرسائل مفقود
   ========================================================= */
function makePartialSupabaseStub() {
  const db = { rooms: new Map(), members: new Map(), queue: new Map(), nextId: 1 };
  const calls = { msgSelect: 0, msgInsert: 0, roomsInsert: 0, rpc: [] };

  const matchEq = (url, key) => {
    const m = url.match(new RegExp('[?&]' + key + '=eq\\.([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const json = (data, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(data),
    json: async () => data
  });
  const membersFor = room => Array.from(db.members.values()).filter(m => m.room_id === room);

  const fetchStub = (url, options = {}) => {
    const p = String(url);
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const rpc = p.match(/\/rest\/v1\/rpc\/([^?]+)/);
    if (rpc) {
      const name = decodeURIComponent(rpc[1]);
      calls.rpc.push(name);
      if (name === 'wt_create_room') {
        calls.roomsInsert++;
        const id = body.p_room_id;
        if (!db.rooms.has(id)) db.rooms.set(id, { room_id: id, title: body.p_title, video_url: body.p_video_url, host_name: body.p_owner_name, state: null, owner_token: body.p_owner_token });
        const row = db.rooms.get(id);
        return row.owner_token === body.p_owner_token ? json({ ok: true }) : json({ code: '42501', message: 'not owner' }, 403);
      }
      if (name === 'wt_join_room') {
        const row = db.rooms.get(body.p_room_id);
        if (!row) return json({ found: false, role: 'viewer', members: [], serverTime: Date.now() });
        const key = body.p_room_id + '|' + body.p_client_id;
        let member = db.members.get(key);
        const isOwner = row.owner_token === body.p_member_token;
        if (member && !isOwner && member.token !== body.p_member_token) return json({ code: '42501', message: 'invalid member token' }, 403);
        const role = isOwner ? 'owner' : member ? member.role : 'viewer';
        if (!member) { member = { room_id: body.p_room_id, client_id: body.p_client_id, display_name: body.p_display_name, role, token: body.p_member_token }; db.members.set(key, member); }
        else { member.display_name = body.p_display_name; if (isOwner) member.role = 'owner'; }
        return json({ found: true, role, serverTime: Date.now(), members: membersFor(body.p_room_id).map(({ room_id, client_id, display_name, role }) => ({ room_id, client_id, display_name, role })) });
      }
      if (name === 'wt_apply_room_state') {
        const row = db.rooms.get(body.p_room_id);
        const member = db.members.get(body.p_room_id + '|' + body.p_client_id);
        const role = row && row.owner_token === body.p_member_token ? 'owner' : member && member.token === body.p_member_token ? member.role : 'viewer';
        if (!row || !['owner', 'organizer'].includes(role)) return json({ code: '42501', message: 'permission denied' }, 403);
        const rev = Number(row.state && row.state.rev || 0) + 1;
        row.state = Object.assign({}, body.p_state, { rev, t: Date.now(), updatedBy: body.p_client_id });
        return json(row.state);
      }
      return json({ message: 'unknown RPC ' + name }, 404);
    }

    if (p.includes('/rest/v1/rooms')) {
      if (method === 'GET') {
        const id = matchEq(p, 'room_id');
        const row = id && db.rooms.has(id) ? db.rooms.get(id) : null;
        return json(row ? [{ room_id: row.room_id, state: row.state, video_url: row.video_url, host_name: row.host_name, updated_at: new Date().toISOString() }] : []);
      }
    }
    if (p.includes('/rest/v1/messages')) {
      /* جدول الرسائل غير موجود في هذا المشروع */
      if (method === 'GET') { calls.msgSelect++; return json({ code: '42P01', message: 'relation "public.messages" does not exist' }, 404); }
      if (method === 'POST') { calls.msgInsert++; return json({ code: '42P01', message: 'relation "public.messages" does not exist' }, 404); }
    }
    if (p.includes('/rest/v1/room_members')) return json(membersFor(matchEq(p, 'room_id')));
    if (p.includes('/rest/v1/room_queue')) return json([]);
    if (p.includes('/rest/v1/presence')) return json([]);
    return json({ message: 'unknown route' }, 404);
  };
  return { db, calls, fetchStub };
}
async function testPartialProject() {
  const sb = makePartialSupabaseStub();
  const ownerToken = 'b'.repeat(64);
  const env = createRoomEnv({
    search: '?id=PART01&host=1&v=' + encodeURIComponent('https://example.com/a.mp4'),
    store: { 'wt:owner:PART01': JSON.stringify(ownerToken) },
    fetch: sb.fetchStub
  });
  env.sandbox.WT_CONFIG.sync.pollMs = 120;
  env.sandbox.WT_CONFIG.sync.persistMs = 300;

  env.byId.get('gateName').value = 'أمين';
  env.byId.get('gateForm').dispatch('submit', {});
  await wait(400);

  t('مشروع ناقص: ما زال متصلاً بـ Supabase (لم يسقط للوضع المحلي)',
    env.sandbox.WTRoom.session.transport.kind === 'supabase' && env.byId.get('statusBadge').getAttribute('data-state') === 'online',
    env.byId.get('statusText').textContent);
  t('مشروع ناقص: صف الغرفة أُنشئ', sb.db.rooms.has('PART01'));
  t('مشروع ناقص: حاول قراءة الرسائل (وتوقّع الفشل)', sb.calls.msgSelect > 0);

  const chat = env.byId.get('chatBody').children.map(c => String(c.innerHTML || '')).join(' ');
  t('مشروع ناقص: تنبيه واضح بأن الدردشة غير متاحة مؤقتاً', chat.includes('الدردشة غير متاحة'), chat.slice(0, 160));

  /* المزامنة يجب أن تعمل رغم غياب جدول الرسائل */
  const v = findVideo(env);
  if (v) { v.duration = 600; v.dispatch('loadedmetadata', {}); }
  await wait(120);
  if (v) v.currentTime = 77;
  env.sandbox.WTRoom.publish({ force: true });
  await wait(250);
  const row = sb.db.rooms.get('PART01');
  t('مشروع ناقص: الحالة حُفظت رغم غياب جدول الرسائل',
    row && row.state && Math.round(row.state.pos) === 77,
    row && row.state && row.state.pos);
}

/* =========================================================
   3) أداة sbctl
   ========================================================= */
function testSbctl() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sbctl-'));
  const cfgPath = path.join(tmp, 'config.js');
  const orig = fs.readFileSync(path.join(base, 'assets/js/config.js'), 'utf8');
  fs.writeFileSync(cfgPath, orig, 'utf8');

  const c1 = readConfig(cfgPath);
  t('sbctl: يقرأ العنوان من config.js', /^https:\/\/.+\.supabase\.co$/.test(c1.url), c1.url);
  t('sbctl: يقرأ المفتاح', (c1.anonKey || '').length > 40);

  const c2 = writeConfig({
    url: 'https://abcdefghijklmnop.supabase.co',
    anonKey: 'NEW_KEY_1234567890',
    ready: true
  }, cfgPath);
  t('sbctl: يكتب العنوان الجديد', c2.url === 'https://abcdefghijklmnop.supabase.co', c2.url);
  t('sbctl: يكتب المفتاح الجديد', c2.anonKey === 'NEW_KEY_1234567890', c2.anonKey);
  t('sbctl: ready = true', c2.ready === true);
  t('sbctl: لم يتلف باقي الملف', fs.readFileSync(cfgPath, 'utf8').includes('codeLength'));

  /* رفع رقم الكاش */
  const tmpRoot = path.join(tmp, 'site');
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<script src="assets/js/config.js?v=2.2.0"></script>', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'room.html'), '<script src="assets/js/room.js?v=2.2.0"></script>', 'utf8');
  const changed = bumpVersion('2.4.0', tmpRoot);
  t('sbctl: يرفع رقم الكاش في الصفحات', changed.length === 2, changed.join(','));
  t('sbctl: الرقم الجديد صحيح',
    fs.readFileSync(path.join(tmpRoot, 'index.html'), 'utf8').includes('?v=2.4.0'));

  /* استخراج مفتاح anon من صيغ api-keys المختلفة */
  t('sbctl: يستخرج anon من صيغة القائمة',
    pickAnonKey([{ name: 'anon', type: 'anon', api_key: 'AAA' }]) === 'AAA');
  t('sbctl: يستخرج anon من صيغة الكائن',
    pickAnonKey({ anon_key: 'BBB' }) === 'BBB');
  t('sbctl: يتجاهل service_role',
    pickAnonKey([{ name: 'service_role', type: 'service_role', api_key: 'S' }, { name: 'anon', type: 'anon', api_key: 'C' }]) === 'C');
  t('sbctl: لا يختلق مفتاحاً', pickAnonKey([{ type: 'service_role', api_key: 'S' }]) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* =========================================================
   4) doctor على خادم PostgREST وهمي
   ========================================================= */
function startFakePostgrest(opts) {
  const state = { rows: new Map(), posts: 0, deletes: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const parseBody = (cb) => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        try { cb(JSON.parse(raw || '{}')); }
        catch (e) { send(400, { message: 'invalid JSON' }); }
      });
    };
    const rpc = url.match(/^\/rest\/v1\/rpc\/([^?]+)/);
    if (rpc && req.method === 'POST') {
      return parseBody(body => {
        const name = decodeURIComponent(rpc[1]);
        if (name === 'wt_create_room') {
          state.posts++;
          state.rows.set(body.p_room_id, {
            room_id: body.p_room_id, state: null, video_url: body.p_video_url,
            host_name: body.p_owner_name, owner_token: body.p_owner_token
          });
          return send(200, { ok: true });
        }
        if (name === 'wt_join_room') {
          const row = state.rows.get(body.p_room_id);
          if (!row) return send(200, { found: false, role: 'viewer', members: [], serverTime: Date.now() });
          return send(200, { found: true, role: row.owner_token === body.p_member_token ? 'owner' : 'viewer', members: [], serverTime: Date.now() });
        }
        if (name === 'wt_apply_room_state') {
          const row = state.rows.get(body.p_room_id);
          if (!row || row.owner_token !== body.p_member_token) return send(403, { code: '42501', message: 'permission denied' });
          row.state = Object.assign({}, body.p_state, { rev: Number(row.state && row.state.rev || 0) + 1, t: Date.now() });
          return send(200, row.state);
        }
        if (name === 'wt_delete_room') {
          const row = state.rows.get(body.p_room_id);
          if (row && row.owner_token !== body.p_owner_token) return send(403, { code: '42501', message: 'permission denied' });
          if (row) { state.rows.delete(body.p_room_id); state.deletes++; }
          return send(200, { ok: true, deleted: !!row });
        }
        return send(404, { message: 'unknown RPC' });
      });
    }
    if (url.startsWith('/rest/v1/rooms')) {
      if (req.method === 'GET') {
        if (opts.missingRooms) return send(404, { code: '42P01', message: 'relation "public.rooms" does not exist' });
        const id = (url.match(/room_id=eq\.([^&]+)/) || [])[1];
        const row = id && state.rows.has(decodeURIComponent(id)) ? state.rows.get(decodeURIComponent(id)) : null;
        return send(200, row ? [{ room_id: row.room_id, state: row.state, video_url: row.video_url, host_name: row.host_name }] : []);
      }
      if (req.method === 'DELETE') { state.deletes++; return send(200, []); }
    }
    if (url.startsWith('/rest/v1/messages')) {
      if (opts.missingMessages) return send(404, { code: '42P01', message: 'relation "public.messages" does not exist' });
      return send(200, []);
    }
    if (url.startsWith('/rest/v1/presence')) {
      if (opts.missingPresence) return send(404, { code: '42P01', message: 'relation "public.presence" does not exist' });
      return send(200, []);
    }
    if (url.startsWith('/rest/v1/room_members')) {
      if (opts.missingRoomMembers) return send(404, { code: '42P01', message: 'relation "public.room_members" does not exist' });
      return send(200, []);
    }
    if (url.startsWith('/rest/v1/room_queue')) {
      if (opts.missingRoomQueue) return send(404, { code: '42P01', message: 'relation "public.room_queue" does not exist' });
      return send(200, []);
    }
    send(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}
async function testDoctor() {
  /* حالة: كل شيء سليم */
  const good = await startFakePostgrest({});
  const r1 = await doctorProject({ url: good.url, anonKey: 'k', realtime: false, write: true });
  t('doctor: REST يردّ', r1.rest && r1.rest.ok === true);
  t('doctor: الجداول الخمسة موجودة',
    r1.tables.rooms === true && r1.tables.messages === true && r1.tables.presence === true &&
    r1.tables.room_members === true && r1.tables.room_queue === true);
  t('doctor: لا مشاكل', r1.problems.length === 0, JSON.stringify(r1.problems));
  t('doctor: اختبار الكتابة نجح', r1.write && r1.write.ok === true);
  t('doctor: حذف غرفة الاختبار', good.state.deletes >= 1);
  await good.close();

  /* حالة: الجداول غائبة */
  const bad = await startFakePostgrest({ missingRooms: true, missingMessages: true, missingPresence: true });
  const r2 = await doctorProject({ url: bad.url, anonKey: 'k', realtime: false, write: false });
  t('doctor: يكشف غياب الجداول', r2.ok === false && r2.problems.length > 0);
  t('doctor: يذكر أن الجداول غير موجودة',
    r2.problems.some(p => p.code === 'missing-table'), JSON.stringify(r2.problems.map(p => p.code)));
  t('doctor: يعطي حلاً عملياً', r2.problems.every(p => !!p.fix));
  await bad.close();

  /* حالة: رسائل مفقود فقط → المزامنة تعمل لكن الدردشة معطّلة */
  const part = await startFakePostgrest({ missingMessages: true });
  const r3 = await doctorProject({ url: part.url, anonKey: 'k', realtime: false, write: false });
  t('doctor: غياب الرسائل لا يوقف المزامنة', r3.coreOk === true);
  t('doctor: غياب الرسائل يُبلَّغ عنه كمشكلة', r3.problems.some(p => p.code === 'missing-table'),
    JSON.stringify(r3.problems.map(p => p.code)));
  t('doctor: المشروع ليس «سليماً تماماً»', r3.ok === false);
  await part.close();

  /* حالة: لا يوجد مشروع مهيّأ */
  const r4 = await doctorProject({ url: '', anonKey: '' });
  t('doctor: يتعامل مع مشروع غير مهيّأ', r4.ok === false && r4.problems[0].code === 'not-configured');
}

/* =========================================================
   5) نافذة تشخيص الاتصال داخل الغرفة
   ========================================================= */
async function testRoomDiagnostics() {
  const sb = makePartialSupabaseStub();
  const ownerToken = 'c'.repeat(64);
  const env = createRoomEnv({
    search: '?id=DIAG1&host=1&v=' + encodeURIComponent('https://example.com/a.mp4'),
    store: { 'wt:owner:DIAG1': JSON.stringify(ownerToken) },
    fetch: sb.fetchStub
  });
  env.sandbox.WT_CONFIG.sync.pollMs = 500;

  env.byId.get('gateName').value = 'أمين';
  env.byId.get('gateForm').dispatch('submit', {});
  await wait(350);

  t('غرفة: زر التشخيص موجود', !!env.byId.get('diagBtn'));
  t('غرفة: نافذة التشخيص موجودة', !!env.byId.get('diagModal'));

  env.byId.get('diagBtn').dispatch('click', {});
  await wait(250);
  t('غرفة: النافذة فُتحت', env.byId.get('diagModal').hidden === false);

  const body = env.byId.get('diagBody').innerHTML || '';
  t('غرفة: التقرير يعرض عنوان المشروع', body.includes('supabase.co') || body.includes('127.0.0.1'), body.slice(0, 120));
  t('غرفة: التقرير يذكر حالة الجداول', body.includes('rooms') && body.includes('messages'));
  t('غرفة: التقرير يشرح المشكلة والحل', body.includes('الحل'));

  /* إعادة الفحص */
  env.byId.get('diagRunBtn').dispatch('click', {});
  await wait(250);
  t('غرفة: إعادة الفحص تعمل', (env.byId.get('diagBody').innerHTML || '').includes('rooms'));

  /* إعادة الاتصال */
  env.byId.get('diagReconnectBtn').dispatch('click', {});
  await wait(400);
  t('غرفة: إعادة الاتصال تُبقي الاتصال حياً',
    env.sandbox.WTRoom.session.transport.kind === 'supabase' && env.byId.get('statusBadge').getAttribute('data-state') === 'online',
    env.byId.get('statusText').textContent);

  /* نافذة التشخيص تُغلق بزر الإغلاق */
  env.byId.get('diagBtn').dispatch('click', {});
  await wait(150);
  env.byId.get('diagCloseBtn').dispatch('click', {});
  t('غرفة: زر الإغلاق يغلق النافذة', env.byId.get('diagModal').hidden === true);
}

/* =========================================================
   التشغيل
   ========================================================= */
(async () => {
  console.log('\n=== اختبارات سيرفر Supabase ===\n');
  testClassify();
  await testPartialProject();
  testSbctl();
  await testDoctor();
  await testRoomDiagnostics();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log('\n' + errors.join('\n'));
    process.exit(1);
  }
  process.exit(0);
})();

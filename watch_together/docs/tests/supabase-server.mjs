/* =========================================================
   WatchTogether — اختبارات «سيرفر Supabase» الجديد
   التشغيل:  node docs/tests/supabase-server.mjs
   ---------------------------------------------------------
   يغطّي:
     1) ترجمة أخطاء Supabase إلى أسباب وحلول مفهومة
     2) تحمّل التطبيق لمشروع ناقص (جدول الرسائل مفقود) — المزامنة تستمر
     3) أداة sbctl: قراءة/كتابة الإعدادات + رفع رقم الكاش + جلب المفتاح
     4) جدول رسائل قديم (العمود text بدل body — خطأ PGRST204) والتكيّف معه
     5) فحص doctor على خادم PostgREST وهمي (محلي)
     6) نافذة «تشخيص الاتصال» في الغرفة + إعادة الاتصال
   ========================================================= */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRoomEnv, wait, base } from './harness.mjs';
import { ROOT, readConfig, writeConfig, bumpVersion, pickAnonKey, doctorProject, bootstrapSql, repairSql } from '../../tools/sbctl.mjs';

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
  /* PGRST204: العمود body غير موجود في جدول messages — أشهر سبب لتعذّر إرسال الرسالة */
  const colErr = mk(400, 'PGRST204', "Could not find the 'body' column of 'messages' in the schema cache");
  t('خطأ: عمود مفقود → schema-mismatch (لا missing-table)', colErr.code === 'schema-mismatch', colErr.code);
  t('خطأ: يذكر اسم العمود والجدول', /body/.test(colErr.title) && /messages/.test(colErr.title), colErr.title);
  t('خطأ: يعطي حلاً بملف الإصلاح', /repair-messages\.sql|bootstrap\.sql/.test(colErr.fix), colErr.fix);
  /* 23502: عمود المعرّف id بلا تسلسل/افتراضي في جدول قديم — يمنع إرسال الرسائل */
  const idErr = mk(400, '23502', 'null value in column "id" of relation "messages" violates not-null constraint');
  t('خطأ: معرّف قديم → legacy-id (لا missing-table)', idErr.code === 'legacy-id', idErr.code);
  t('خطأ: يشرح سبب المعرّف ويقدّم ملف الإصلاح',
    /id/.test(idErr.title) && /repair-messages\.sql/.test(idErr.fix), idErr.title);
  const seqErr = C(new Error('relation "public.messages_id_seq" does not exist'));
  t('خطأ: غياب تسلسل messages_id_seq → legacy-id', seqErr.code === 'legacy-id', seqErr.code);
  const parsedCol = env.sandbox.WTTransport.parseMissingColumn(colErr.raw);
  t('خطأ: يستخرج العمود والجدول', parsedCol && parsedCol.column === 'body' && parsedCol.table === 'messages');
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
   2ب) جدول رسائل قديم: العمود اسمه text بدل body (PGRST204)
   ---------------------------------------------------------
   نفس ما يحدث في مشروع حقيقي بُني بنسخة قديمة من المخطط:
   الإدراج بـ body يردّ 400 PGRST204، فيجب أن يتكيّف العميل
   (يكتشف العمود الصحيح) ويكمل الإرسال بدل الفشل الصامت.
   ========================================================= */
function makeLegacyMessagesStub() {
  const db = { rooms: new Map(), members: new Map(), messages: [], nextId: 1 };
  const calls = { msgBody: 0, msgText: 0, openapi: 0, probe: 0 };
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
      if (name === 'wt_create_room') {
        const id = body.p_room_id;
        if (!db.rooms.has(id)) db.rooms.set(id, { room_id: id, title: body.p_title, video_url: body.p_video_url, host_name: body.p_owner_name, state: null, owner_token: body.p_owner_token });
        return json({ ok: true });
      }
      if (name === 'wt_join_room') {
        const row = db.rooms.get(body.p_room_id);
        if (!row) return json({ found: false, role: 'viewer', members: [], serverTime: Date.now() });
        const key = body.p_room_id + '|' + body.p_client_id;
        if (!db.members.has(key)) db.members.set(key, { room_id: body.p_room_id, client_id: body.p_client_id, display_name: body.p_display_name, role: 'owner' });
        return json({ found: true, role: 'owner', serverTime: Date.now(), members: membersFor(body.p_room_id) });
      }
      if (name === 'wt_apply_room_state') {
        const row = db.rooms.get(body.p_room_id);
        if (!row) return json({ code: '42501', message: 'permission denied' }, 403);
        row.state = Object.assign({}, body.p_state, { rev: Number(row.state && row.state.rev || 0) + 1, t: Date.now() });
        return json(row.state);
      }
      return json({ message: 'unknown RPC ' + name }, 404);
    }

    /* OpenAPI: العميل يستعملها لاكتشاف أعمدة الجدول */
    if (/\/rest\/v1\/(\?|$)/.test(p) && method === 'GET') {
      calls.openapi++;
      return json({
        definitions: {
          messages: { properties: { id: {}, room_id: {}, name: {}, text: {}, created_at: {} } }
        }
      });
    }

    if (p.includes('/rest/v1/rooms')) {
      if (method === 'GET') {
        const id = matchEq(p, 'room_id');
        const row = id && db.rooms.has(id) ? db.rooms.get(id) : null;
        return json(row ? [{ room_id: row.room_id, state: row.state, video_url: row.video_url, host_name: row.host_name }] : []);
      }
    }

    /* جدول messages القديم: لا عمود body — فقط text */
    if (p.includes('/rest/v1/messages')) {
      if (method === 'POST') {
        if (Object.prototype.hasOwnProperty.call(body || {}, 'body')) {
          calls.msgBody++;
          return json({ code: 'PGRST204', message: "Could not find the 'body' column of 'messages' in the schema cache" }, 400);
        }
        if (Object.prototype.hasOwnProperty.call(body || {}, 'text')) {
          calls.msgText++;
          const row = Object.assign({ id: db.nextId++, created_at: new Date().toISOString() }, body);
          db.messages.push(row);
          return json(row, 201);
        }
        return json({ code: 'PGRST204', message: "Could not find the 'x' column of 'messages' in the schema cache" }, 400);
      }
      if (method === 'GET') {
        calls.probe++;
        return json(db.messages.map(r => Object.assign({}, r)));   /* الأعمدة: id, room_id, name, text, created_at */
      }
    }
    if (p.includes('/rest/v1/room_members')) return json(membersFor(matchEq(p, 'room_id')));
    if (p.includes('/rest/v1/room_queue')) return json([]);
    if (p.includes('/rest/v1/presence')) return json([]);
    return json({ message: 'unknown route' }, 404);
  };
  return { db, calls, fetchStub };
}
async function testLegacyMessagesTable() {
  const sb = makeLegacyMessagesStub();
  const env = createRoomEnv({
    search: '?id=OLD01&host=1&v=' + encodeURIComponent('https://example.com/a.mp4'),
    store: { 'wt:owner:OLD01': JSON.stringify('d'.repeat(64)) },
    fetch: sb.fetchStub
  });
  env.sandbox.WT_CONFIG.sync.pollMs = 120;

  env.byId.get('gateName').value = 'أمين';
  env.byId.get('gateForm').dispatch('submit', {});
  await wait(400);

  t('جدول قديم: الغرفة متصلة رغم شكل الجدول (لا سقوط للوضع المحلي)',
    env.sandbox.WTRoom.session.transport.kind === 'supabase',
    env.sandbox.WTRoom.session.transport.kind);

  /* إرسال رسالة من واجهة الغرفة */
  env.byId.get('chatInput').value = 'مرحباً من جدول قديم';
  env.byId.get('chatForm').dispatch('submit', {});
  await wait(600);

  t('جدول قديم: حاول أولاً الإدراج بـ body وردّ الخادم بـ PGRST204', sb.calls.msgBody >= 1, sb.calls.msgBody);
  t('جدول قديم: تكيّف العميل وكتب في العمود text', sb.calls.msgText >= 1, sb.calls.msgText);
  t('جدول قديم: الرسالة وصلت فعلاً للقاعدة',
    sb.db.messages.length === 1 && sb.db.messages[0].text === 'مرحباً من جدول قديم',
    JSON.stringify(sb.db.messages));
  t('جدول قديم: لم يبق في الطابور شيء (لم تُرسل مرتين)',
    sb.calls.msgText <= 2, sb.calls.msgText);

  /* الرسالة التالية تُكتب مباشرة في العمود المكتشف بلا محاولة فاشلة */
  const before = sb.calls.msgBody;
  env.byId.get('chatInput').value = 'رسالة ثانية';
  env.byId.get('chatForm').dispatch('submit', {});
  await wait(400);
  t('جدول قديم: الرسائل التالية تُرسل مباشرة بلا خطأ',
    sb.db.messages.length === 2 && sb.calls.msgBody === before,
    sb.calls.msgBody + ' / ' + sb.db.messages.length);

  /* التنبيه الودي يظهر مرة واحدة داخل الدردشة */
  const chat = env.byId.get('chatBody').children.map(c => String(c.innerHTML || '')).join(' ');
  t('جدول قديم: تنبيه بأن الجدول قديم والعميل تكيّف معه',
    chat.includes('جدول messages قديم') || chat.includes('repair-messages.sql'), chat.slice(0, 200));

  /* التشخيص يكتشف الحالة ويشرح الحل */
  const probe = new env.sandbox.WTTransport.SupabaseTransport({ url: 'http://127.0.0.1:9', anonKey: 'k' });
  probe._fetch = (path) => {
    if (path.includes('/rest/v1/rooms')) return Promise.resolve([{ room_id: 'OLD01', state: null }]);
    if (/\/rest\/v1\/messages\?select=body/.test(path)) {
      return Promise.reject(Object.assign(new Error("supabase: Could not find the 'body' column of 'messages' in the schema cache"), {
        status: 400, code: 'PGRST204',
        diag: { code: 'schema-mismatch', raw: "Could not find the 'body' column of 'messages' in the schema cache" }
      }));
    }
    if (path === '/rest/v1/') return Promise.resolve({ definitions: { messages: { properties: { text: {} } } } });
    return Promise.resolve([]);
  };
  probe._probeRealtime = () => Promise.resolve({ ok: false, error: 'لا يعمل في الاختبار' });
  probe.roomId = 'OLD01';
  const diag = await probe.diagnose({ realtimeMs: 10 });
  t('تشخيص: يكشف أن عمود النص ليس body', diag.messageField === 'text', JSON.stringify(diag.messageField));
  const diagProblems = (diag.problems || []);
  t('تشخيص: يُدرج مشكلة العمود المفقود مع الحل',
    diagProblems.some(p => /body/.test(String(p.title || '')) && /repair-messages|bootstrap/.test(String(p.fix || ''))),
    JSON.stringify(diagProblems.map(p => p.code)));
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
  const changed = bumpVersion('2.6.1', tmpRoot);
  t('sbctl: يرفع رقم الكاش في الصفحات', changed.length === 2, changed.join(','));
  t('sbctl: الرقم الجديد صحيح',
    fs.readFileSync(path.join(tmpRoot, 'index.html'), 'utf8').includes('?v=2.6.1'));

  /* مخطط القاعدة يحتوي قسم إصلاح جدول الرسائل (وإلا عاد خطأ عمود body أو خطأ التسلسل) */
  const boot = bootstrapSql();
  t('sbctl: bootstrap.sql يصلح العمود body', /rename column %I to body/.test(boot), '');
  t('sbctl: bootstrap.sql يعيد تحميل كاش PostgREST', /notify pgrst, 'reload schema'/.test(boot), '');
  const repair = repairSql();
  t('sbctl: repair-messages.sql موجود ويصلح العمود',
    /alter table public\.messages/.test(repair) && /notify pgrst/.test(repair), '');

  /* خطأ relation "public.messages_id_seq" does not exist:
     لا يجوز منح التسلسل منحاً غير محمي — الجداول القديمة قد لا تملك تسلسلاً أصلاً */
  const sqlDir = path.join(ROOT, 'docs');   /* ROOT = مجلد watch_together */
  const sqlFiles = ['bootstrap.sql', 'schema.sql', 'migration.sql', 'repair-messages.sql'];
  const rawGrant = 'grant usage, select on sequence public.messages_id_seq to anon, authenticated;';
  for (const f of sqlFiles) {
    const sql = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    t(`sql: ${f} لا يمنح messages_id_seq منحاً غير محمي`, !sql.includes(rawGrant), '');
    t(`sql: ${f} يفحص وجود التسلسل قبل منحه`, sql.includes("to_regclass('public.messages_id_seq')"), '');
    t(`sql: ${f} يُصلح عمود المعرّف id (لا خطأ not-null على id)`,
      /pg_get_serial_sequence\('public\.messages', 'id'\)/.test(sql) &&
      /create sequence if not exists public\.messages_id_seq/.test(sql), '');
    t(`sql: ${f} يعالج معرّفاً نصّياً/uuid بلا default`,
      /gen_random_uuid\(\)/.test(sql), '');
  }
  /* الملفات الثلاثة للمخطط يجب أن تبقى متطابقة في المتن (تختلف في الترويسة فقط) */
  const bodyOf = (f) => {
    const sql = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    return sql.slice(sql.indexOf('-- 1)'));
  };
  t('sql: bootstrap/schema/migration متطابقة في المتن',
    bodyOf('bootstrap.sql') === bodyOf('schema.sql') && bodyOf('bootstrap.sql') === bodyOf('migration.sql'), '');

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
      /* جدول قديم بلا تسلسل للمعرّف: id موجود لكن الإدراج يفشل بـ 23502 */
      if (opts.legacyMessagesId) {
        if (/select=id/.test(url)) {
          return send(400, { code: 'PGRST204', message: "Could not find the 'id' column of 'messages' in the schema cache" });
        }
        if (req.method === 'POST') {
          return send(400, { code: '23502', message: 'null value in column "id" of relation "messages" violates not-null constraint' });
        }
        return send(200, [{ id: 3, room_id: 'X', name: 'زائر', body: 'مرحبا', created_at: new Date().toISOString() }]);
      }
      /* جدول قديم: لا عمود body — نصّ الرسالة في text */
      if (opts.legacyMessagesText) {
        if (/select=body/.test(url)) {
          return send(400, { code: 'PGRST204', message: "Could not find the 'body' column of 'messages' in the schema cache" });
        }
        return send(200, [{ id: 1, room_id: 'X', name: 'زائر', text: 'مرحبا', created_at: new Date().toISOString() }]);
      }
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

  /* حالة: جدول رسائل قديم (العمود text بدل body) → doctor يكشفه */
  const legacy = await startFakePostgrest({ legacyMessagesText: true });
  const r5 = await doctorProject({ url: legacy.url, anonKey: 'k', realtime: false, write: false });
  t('doctor: يكشف العمود المفقود body', r5.messageField === 'text', String(r5.messageField));
  t('doctor: يُدرجه كمشكلة مع حل',
    r5.problems.some(p => p.code === 'schema-mismatch' && /repair-messages|bootstrap/.test(String(p.fix || ''))),
    JSON.stringify(r5.problems.map(p => p.code)));
  t('doctor: يشرح أن الجدول قديم', r5.problems.some(p => /بدل «body»|body/.test(String(p.title))));
  await legacy.close();

  /* حالة: جدول قديم بلا تسلسل للمعرّف (id) → doctor يكشفه ويقترح الإصلاح */
  const legacyId = await startFakePostgrest({ legacyMessagesId: true });
  const r6 = await doctorProject({ url: legacyId.url, anonKey: 'k', realtime: false, write: false });
  t('doctor: يكشف عمود المعرّف القديم (legacy-id)',
    r6.problems.some(p => p.code === 'legacy-id'), JSON.stringify(r6.problems.map(p => p.code)));
  t('doctor: حلّ المعرّف القديم يذكر repair-messages.sql',
    r6.problems.some(p => p.code === 'legacy-id' && /repair-messages\.sql/.test(String(p.fix || ''))));
  await legacyId.close();

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
  await testLegacyMessagesTable();
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

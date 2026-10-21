/* =========================================================
   WatchTogether — البثّ الحيّ للرسائل (dm-realtime)
   يشغّل العميل الحقيقي على WebSocket وهمي، ويتحقّق من:
   الاشتراك الخاص · استقبال الإشارات · رفض القناة · إعادة الاتصال · الإغلاق.
   ويقارن عقد SQL (بثّ بلا نصّ رسالة، قناة لكل مستخدم، مشغّلات).

   التشغيل: node docs/tests/dm-realtime.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : String(detail));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- WebSocket وهمي ---------------- */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  frame(payload) { if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) }); }
  reply(status) { this.frame({ event: 'phx_reply', payload: { status }, ref: '1' }); }
  get joins() { return this.sent.filter((m) => m.event === 'phx_join'); }
}
FakeSocket.instances = [];

/* ---------------- تشغيل العميل ---------------- */
function boot(options = {}) {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.navigator = { onLine: options.online !== false };
  sandbox.location = { hostname: 'example.test', protocol: 'https:' };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.WebSocket = options.noSocket ? undefined : FakeSocket;
  sandbox.addEventListener = () => {};
  sandbox.WT_CONFIG = {
    supabase: { url: 'https://demo.supabase.co', anonKey: 'anon-key-123' }
  };
  sandbox.WTDMRealtime = undefined;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/dm-realtime.js'), sandbox, { filename: 'dm-realtime.js' });
  return sandbox;
}

const UID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/* ==================== 1) الاشتراك ==================== */
{
  FakeSocket.instances = [];
  const app = boot();
  const seen = [];
  const rt = app.WTDMRealtime.create({ uid: UID, getToken: async () => 'jwt-token' });
  rt.on('message', (payload) => seen.push({ type: 'message', payload }));
  rt.on('read', (payload) => seen.push({ type: 'read', payload }));
  rt.on('typing', (payload) => seen.push({ type: 'typing', payload }));
  const statuses = [];
  rt.on('status', (s) => statuses.push(s.status));

  t('يتصل عبر WebSocket', FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  t('الرابط يحمل المفتاح العام وإصدار البروتوكول',
    socket.url === 'wss://demo.supabase.co/realtime/v1/websocket?apikey=anon-key-123&vsn=1.0.0', socket.url);

  socket.open();
  await sleep(30);
  const join = socket.joins[0];
  t('يرسل phx_join', !!join);
  t('القناة خاصة ولها اسم المستخدم', join && join.topic === 'realtime:wt:user:' + UID, join && join.topic);
  t('يعلن القناة خاصة (private)', join && join.payload.config.private === true);
  t('لا يعيد بثّ رسائله لنفسه', join && join.payload.config.broadcast.self === false);
  t('يرسل رمز الجلسة', join && join.payload.access_token === 'jwt-token');

  socket.reply('ok');
  await sleep(10);
  t('الحالة تصبح مفتوحة', rt.status() === 'open' && rt.joined() === true, rt.status());

  socket.frame({ event: 'broadcast', payload: { event: 'message', payload: { thread: 't1', id: 7 } } });
  socket.frame({ event: 'broadcast', payload: { event: 'read', payload: { thread: 't1', user: 'u2', last_read: 6 } } });
  socket.frame({ event: 'broadcast', payload: { event: 'typing', payload: { thread: 't1', user: 'u2', active: true } } });
  t('يستقبل إشارة الرسالة', seen.some((e) => e.type === 'message' && e.payload.id === 7));
  t('يستقبل إشارة القراءة', seen.some((e) => e.type === 'read' && e.payload.last_read === 6));
  t('يستقبل إشارة الكتابة', seen.some((e) => e.type === 'typing' && e.payload.active === true));

  socket.frame({ event: 'broadcast', payload: { event: 'unknown', payload: { x: 1 } } });
  socket.frame({ event: 'broadcast', payload: { event: 'message' } });
  t('يتجاهل الأحداث غير المعروفة أو الفارغة', seen.length === 3, seen.length);
  t('لا يرمي على إطار تالف', (() => { try { socket.onmessage({ data: '{oops' }); return true; } catch (e) { return false; } })());
  t('سجلّ الحالات مفهوم', statuses.includes('connecting') && statuses.includes('open'), statuses.join(','));

  rt.close();
  t('الإغلاق يوقف الاتصال', rt.status() === 'closed' && socket.closed === true);
}

/* ==================== 2) رفض القناة (سياسة غير منفّذة) ==================== */
{
  FakeSocket.instances = [];
  const app = boot();
  const rt = app.WTDMRealtime.create({ uid: UID, getToken: async () => 'jwt' });
  const socket = FakeSocket.instances[0];
  socket.open();
  await sleep(30);
  socket.reply('error');
  await sleep(10);
  t('الرفض يعطي حالة denied لا خطأ صامتاً', rt.status() === 'denied', rt.status());
  t('الرفض لا يعلّق الواجهة', rt.joined() === false);
  rt.close();
}

/* ==================== 3) إعادة الاتصال بعد الانقطاع ==================== */
{
  FakeSocket.instances = [];
  const app = boot();
  const rt = app.WTDMRealtime.create({ uid: UID, getToken: async () => 'jwt', retryBaseMs: 20, retryMaxMs: 40 });
  const first = FakeSocket.instances[0];
  first.open();
  await sleep(25);
  first.reply('ok');
  await sleep(10);
  t('متصل قبل الانقطاع', rt.status() === 'open');

  first.close();                       /* انقطاع مفاجئ */
  await sleep(120);
  t('يعيد المحاولة تلقائياً', FakeSocket.instances.length >= 2, FakeSocket.instances.length);
  t('الحالة تعود للاتصال', rt.status() !== 'closed');
  rt.close();
}

/* ==================== 4) بلا WebSocket أو بلا جلسة ==================== */
{
  const app = boot({ noSocket: true });
  const rt = app.WTDMRealtime.create({ uid: UID, getToken: async () => 'jwt' });
  t('بلا WebSocket: غير متاح بهدوء', rt.usable() === false && rt.status() !== 'open');
  rt.close();

  FakeSocket.instances = [];
  const app2 = boot();
  const rt2 = app2.WTDMRealtime.create({ uid: UID, getToken: async () => '' });
  const socket = FakeSocket.instances[0];
  socket.open();
  await sleep(20);
  t('بلا رمز جلسة لا يُرسل اشتراكاً', socket.joins.length === 0);
  t('بلا رمز جلسة: يتراجع للاستطلاع', /الاستطلاع/.test((() => {
    let msg = ''; rt2.on('status', (s) => { msg = s.error; });
    return msg;
  })()) || rt2.joined() === false);
  rt2.close();
}

/* ==================== 5) عقد SQL ==================== */
{
  const sql = read('docs/sql/10-dm-realtime.sql');
  t('SQL: البثّ عبر realtime.send', /realtime\.send\(/.test(sql));
  t('SQL: القناة خاصة (private)', /,\s*true\);/.test(sql) && /'wt:user:' \|\|/.test(sql));
  t('SQL: مشغّل الرسائل موجود', /create trigger wt_dm_message_realtime/.test(sql) &&
    /after insert or update of body, deleted_at, version/.test(sql));
  t('SQL: مشغّل القراءة والكتابة', /create trigger wt_dm_read_realtime/.test(sql) &&
    /create trigger wt_dm_typing_realtime/.test(sql));
  t('SQL: لا يُبَثّ نصّ الرسالة', !/'body',/.test(sql) && !/jsonb_build_object\([^)]*body/.test(sql));
  t('SQL: سياسة قراءة على realtime.messages', /create policy wt_dm_realtime_own_topic on realtime\.messages/.test(sql) &&
    /realtime\.messages\.extension = 'broadcast'/.test(sql));
  t('SQL: القناة محصورة بالمستخدم نفسه', /'wt:user:' \|\| \(select auth\.uid\(\)\)::text/.test(sql));
  t('SQL: فشل البثّ لا يُسقط الرسالة', /exception when others then/.test(sql) &&
    /raise warning/.test(sql));
  t('SQL: idempotent', !/drop table/i.test(sql) && !/delete from public\.wt_dm_messages/i.test(sql));
}

/* ==================== 6) الربط في الصفحة ==================== */
{
  const html = read('messages.html');
  const messages = read('assets/js/messages.js');
  const sw = read('sw.js');

  t('messages.html: يحمّل dm-realtime قبل messages.js',
    html.indexOf('assets/js/dm-realtime.js') > 0 &&
    html.indexOf('assets/js/dm-realtime.js') < html.indexOf('assets/js/messages.js'));
  t('messages.html: نسخة messages.js مرتفعة', /messages\.js\?v=3\.(3|4|5)\.0/.test(html), '');

  t('messages.js: يشغّل البثّ عند الإقلاع', /startRealtime\(\);/.test(messages) &&
    /function startRealtime/.test(messages));
  t('messages.js: يغلق البثّ عند مغادرة الصفحة', /pagehide[\s\S]{0,120}stopRealtime\(\)/.test(messages));
  t('messages.js: يستأنف بعد الرجوع من bfcache', /retryNow\(\)/.test(messages));
  t('messages.js: يقيّد التحديث السريع (throttle)', /liveChatTimer/.test(messages) && /liveListTimer/.test(messages));
  t('messages.js: مؤشّر الكتابة ينتهي وحده', /typingTimer/.test(messages) && /header\(ctx\)/.test(messages));
  t('messages.js: الاستطلاع الدوري باقٍ كشبكة أمان', /state\.timer = setTimeout\(tick,4000\)/.test(messages));
  t('messages.js: يتحقّق من الحساب قبل应用到 سياق محمّل', /ownsContext\(ctx\)/.test(messages));

  t('sw.js: يخزّن dm-realtime مسبقاً', /'assets\/js\/dm-realtime\.js'/.test(sw));
  t('sw.js: نسخة الكاش مرتفعة', /const VERSION = 'wt-v1\.0\.[4-9]'/.test(sw));

  const client = read('assets/js/dm-realtime.js');
  t('العميل لا يخزّن نصوص رسائل', !/body/.test(client) && !/localStorage/.test(client));
  t('العميل لا يستخدم مكتبات خارجية', !/https?:\/\/(?!demo)/.test(client.replace(/https?:\/\/\$\{/g, '')));
  t('العميل لا يعرض مؤشّر اتصال للمستخدم', !/toast|innerHTML|textContent/.test(client));
}

console.log(`DM realtime: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

/* =========================================================
   WatchTogether — اختبارات فاحص TURN (turn-check.mjs)
   بلا اعتماديات وبلا شبكة خارجية: خادم HTTP وUDP محليان.

   التشغيل: node docs/tests/turn-check.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { normalizeServers, classify, validateCredentials, usernameExpiry, hostPort, buildStunBindingRequest, isStunSuccess } from '../../tools/turn/lib.mjs';
import { checkEndpoint, stunProbe } from '../../tools/turn/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(base, file));

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : detail);
}

/* ==================== 1) تطبيع الصيغ ==================== */
{
  const single = normalizeServers({ urls: 'turn:h:3478', username: 'u', credential: 'p' });
  t('normalize: صيغة كائن مفرد', single.length === 1 && single[0].urls === 'turn:h:3478' && single[0].credential === 'p');

  const list = normalizeServers([
    { urls: ['turn:h:80', 'turns:h:443'], username: 'u', credential: 'p' },
    { urls: 'stun:h:80' }
  ]);
  t('normalize: مصفوفة عناوين', list.length === 2 && Array.isArray(list[0].urls));

  const wrapped = normalizeServers({ iceServers: [{ urls: 'turn:h:443', username: 'a', password: 'b' }] });
  t('normalize: صيغة iceServers + password', wrapped.length === 1 && wrapped[0].credential === 'b', JSON.stringify(wrapped));

  const metered = normalizeServers([
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:standard.relay.metered.ca:80', username: 'x', credential: 'y' },
    { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: 'x', credential: 'y' },
    { urls: 'turns:standard.relay.metered.ca:443', username: 'x', credential: 'y' }
  ]);
  t('normalize: استجابة Metered الحقيقية', metered.length === 4);

  t('normalize: يتجاهل الفارغ', normalizeServers([]).length === 0 && normalizeServers(null).length === 0 &&
    normalizeServers([{ username: 'x' }]).length === 0);
  t('normalize: لا يرمي على أي نوع', [normalizeServers('x'), normalizeServers(5), normalizeServers({})].every((x) => Array.isArray(x)));
}

/* ==================== 2) التصنيف والتحقّق ==================== */
{
  const kinds = classify(normalizeServers([
    { urls: 'turn:h:3478', username: 'u', credential: 'p' },
    { urls: 'turns:h:5349', username: 'u', credential: 'p' },
    { urls: 'stun:h:3478' },
    { urls: 'turn:h:80?transport=tcp', username: 'u', credential: 'p' }
  ]));
  t('classify: يفصل turn/turns/stun', kinds.turn.length === 2 && kinds.turns.length === 1 && kinds.stun.length === 1);

  const problems = validateCredentials(normalizeServers([
    { urls: 'turn:h:3478', username: 'u', credential: 'p' },
    { urls: 'turn:h2:3478' }
  ]));
  t('validateCredentials: يكتشف TURN بلا اعتماد', problems.length === 1);

  const stunOnly = validateCredentials(normalizeServers([{ urls: 'stun:h:3478' }]));
  t('validateCredentials: STUN لا يحتاج اعتماداً', stunOnly.length === 0);
}

/* ==================== 3) عمر الاعتماد ==================== */
{
  const now = 1_800_000_000_000; /* = 1800000000 ثانية */
  const fixed = usernameExpiry('1800000600:user-1', now);
  t('expiry: يقرأ نمط coturn REST', fixed.expiresAt === 1_800_000_600_000 && fixed.ttlSeconds === 600, JSON.stringify(fixed));

  const expired = usernameExpiry('1799999999:user', now);
  t('expiry: يكشف المنتهي', expired.ttlSeconds < 0);

  t('expiry: اعتماد ثابت = بلا انتهاء', usernameExpiry('some-user', now).expiresAt === null &&
    usernameExpiry('', now).expiresAt === null);
}

/* ==================== 4) hostPort ==================== */
{
  t('hostPort: turn افتراضي 3478', (() => { const h = hostPort('turn:relay.example.com'); return h.host === 'relay.example.com' && h.port === 3478 && h.transport === 'udp'; })());
  t('hostPort: turns افتراضي 5349', (() => { const h = hostPort('turns:relay.example.com'); return h.port === 5349; })());
  t('hostPort: منفذ صريح وtransport', (() => { const h = hostPort('turn:relay.example.com:80?transport=tcp'); return h.port === 80 && h.transport === 'tcp'; })());
  t('hostPort: stun', (() => { const h = hostPort('stun:stun.l.google.com:19302'); return h.host === 'stun.l.google.com' && h.port === 19302; })());
}

/* ==================== 5) حزمة STUN ==================== */
{
  const buffer = buildStunBindingRequest();
  t('STUN: 20 بايت', buffer.length === 20);
  t('STUN: نوع Binding Request', buffer.readUInt16BE(0) === 0x0001 && buffer.readUInt16BE(2) === 0);
  t('STUN: magic cookie صحيح', buffer.readUInt32BE(4) === 0x2112a442);
  t('STUN: معرّف معاملة متغيّر', !buildStunBindingRequest().equals(buildStunBindingRequest()));
  t('STUN: يقرأ نجاحاً', isStunSuccess(Buffer.from([0x01,0x01,0x00,0x00,0x21,0x12,0xa4,0x42,0,0,0,0,0,0,0,0,0,0,0,0])) === true);
  t('STUN: يرفض القصير أو الخطأ', isStunSuccess(Buffer.alloc(8)) === false &&
    isStunSuccess(Buffer.from([0x01,0x11,0,0,0x21,0x12,0xa4,0x42,0,0,0,0,0,0,0,0,0,0,0,0])) === false);
}

/* ==================== 6) checkEndpoint مع خادم محلي ==================== */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const goodPayload = [
  { urls: 'stun:relay.local:80' },
  { urls: 'turn:relay.local:80', username: 'u', credential: 'p' },
  { urls: 'turns:relay.local:443', username: 'u', credential: 'p' }
];

const { server: goodServer, port: goodPort } = await serve((request, response) => {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': 'http://localhost:8080' }); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:8080' });
  response.end(JSON.stringify(goodPayload));
});

{
  const result = await checkEndpoint('http://127.0.0.1:' + goodPort + '/turn', { origin: 'http://localhost:8080' });
  t('endpoint: 200 يُقرأ', result.ok && result.status === 200);
  t('endpoint: يقبل الشكل ويعيد 3 عناصر', result.servers.length === 3);
  t('endpoint: يرى CORS المطابق', result.corsOk === true && result.allowOrigin === 'http://localhost:8080');
  t('endpoint: يقيس الزمن', Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
}

const { server: wrongOriginServer, port: wrongOriginPort } = await serve((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://another-site.com' });
  response.end(JSON.stringify(goodPayload));
});
{
  const result = await checkEndpoint('http://127.0.0.1:' + wrongOriginPort + '/turn', { origin: 'http://localhost:8080' });
  t('endpoint: يكشف CORS الخاطئ', result.corsOk === false && result.allowOrigin === 'https://another-site.com');
}

const { server: noCorsServer, port: noCorsPort } = await serve((request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(goodPayload));
});
{
  const result = await checkEndpoint('http://127.0.0.1:' + noCorsPort + '/turn');
  t('endpoint: يكشف غياب CORS', result.corsOk === false && !result.allowOrigin);
}

const { server: brokenServer, port: brokenPort } = await serve((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
  response.end('<html>oops</html>');
});
{
  const result = await checkEndpoint('http://127.0.0.1:' + brokenPort + '/turn');
  t('endpoint: يكشف استجابة غير JSON', !!result.parseError && result.servers.length === 0);
}

const { server: errorServer, port: errorPort } = await serve((request, response) => {
  response.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  response.end('{"error":"unauthorized"}');
});
{
  const result = await checkEndpoint('http://127.0.0.1:' + errorPort + '/turn');
  t('endpoint: يكشف 401', result.ok === false && result.status === 401);
}

{
  const result = await checkEndpoint('http://127.0.0.1:1/turn', { timeoutMs: 1500 });
  t('endpoint: اتصال مرفوض لا يرمي', result.ok === false && !!result.parseError);
}

/* ==================== 7) stunProbe مع مستجيب محلي ==================== */
{
  const responder = dgram.createSocket('udp4');
  await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
  responder.on('message', (message, remote) => {
    const reply = Buffer.from(message);
    reply.writeUInt16BE(0x0101, 0); /* Binding Success */
    responder.send(reply, remote.port, remote.address);
  });
  const port = responder.address().port;
  const probe = await stunProbe('127.0.0.1', port, 2000);
  t('stunProbe: يرى نجاحاً من خادم محلي', probe.ok === true, JSON.stringify(probe));
  responder.close();

  const silent = dgram.createSocket('udp4');
  await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
  const silentPort = silent.address().port;
  const timeout = await stunProbe('127.0.0.1', silentPort, 400);
  t('stunProbe: ينتهي بمهلة مفهومة', timeout.ok === false && /المهلة/.test(timeout.error || ''), JSON.stringify(timeout));
  silent.close();

  const missing = await stunProbe('', 3478, 300);
  t('stunProbe: بلا host يعيد خطأ واضحاً', missing.ok === false && /host/.test(missing.error || ''));
}

goodServer.close();
wrongOriginServer.close();
noCorsServer.close();
brokenServer.close();
errorServer.close();

/* ==================== 8) الملفات الجاهزة للخادم ==================== */
{
  t('وسيط Supabase موجود', exists('tools/turn/supabase-edge.ts'));
  const edge = read('tools/turn/supabase-edge.ts');
  t('Supabase: يجيب OPTIONS', /request\.method === 'OPTIONS'/.test(edge) && /204/.test(edge));
  t('Supabase: يقرأ المفتاح من البيئة فقط', /Deno\.env\.get\('METERED_KEY'\)/.test(edge) && !/apiKey=[\"'][A-Za-z0-9]{6,}/.test(edge));
  t('Supabase: حدّ معدّل', /rateLimited/.test(edge) && /429/.test(edge));
  t('Supabase: لا يخزّن استجابة', /Cache-Control/.test(edge) && /no-store/.test(edge));

  const worker = read('tools/turn/cloudflare-worker.js');
  t('Worker: يجيب OPTIONS ويعيد 204', /status: 204/.test(worker) && /OPTIONS/.test(worker));
  t('Worker: أسرار من env فقط', /env\.METERED_KEY/.test(worker) && !/apiKey=[\"'][A-Za-z0-9]{6,}/.test(worker));

  const php = read('tools/turn/turn.php');
  t('PHP: يجيب preflight', /REQUEST_METHOD'\] === 'OPTIONS'/.test(php) && /204/.test(php));
  t('PHP: المفتاح من البيئة', /getenv\('METERED_KEY'\)/.test(php) && !/apiKey=[\"'][A-Za-z0-9]{6,}/.test(php));
  t('PHP: كاش قصير', /filemtime/.test(php) && /< 60/.test(php));

  const guide = read('docs/turn-setup.md');
  t('الدليل يشرح التسجيل في Metered', /metered\.ca/.test(guide) && /سجّل|signup|Sign up/i.test(guide));
  t('الدليل يشرح إخفاء المفتاح', /لا تضع مفتاح Metered/.test(guide));
  t('الدليل يذكر الفاحص', /tools\/turn\/check\.mjs/.test(guide));
  t('الدليل يشرح التحقّق من relay', /relay/.test(guide));
}

console.log(`TURN checker: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

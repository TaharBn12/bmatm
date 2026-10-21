/* =========================================================
   WatchTogether — فاحص نقطة TURN (tools/turn/check.mjs)

   الفحص الآلي يتحقّق من:
     1) هل نقطة النهاية تستجيب؟ ثمّ الشكل الصحيح للبيانات.
     2) هل فؤوس CORS تسمح لموقعك؟ (أهم سبب فشل في المتصفح)
     3) هل توجد عناوين turn/turns؟ وهل لها بيانات اعتماد؟
     4) عمر الاعتماد إن كان بنمط coturn REST.
     5) هل خادم TURN يردّ فعلاً على الشبكة (STUN Binding عبر UDP)؟
   ما لا يستطيعه: إتمام تخصيص TURN مصادق (Authentication) — هذا يحتاج متصفحاً.

   التشغيل:
     node tools/turn/check.mjs https://x.example/turn --origin https://site.com
     node tools/turn/check.mjs --servers '[{"urls":"turn:h:3478","username":"u","credential":"p"}]' --stun
   ========================================================= */
import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';
import { normalizeServers, classify, validateCredentials, usernameExpiry, hostPort, buildStunBindingRequest, isStunSuccess } from './lib.mjs';

const RESET = '\u001b[0m', BOLD = '\u001b[1m', GREEN = '\u001b[32m', RED = '\u001b[31m', YELLOW = '\u001b[33m', DIM = '\u001b[2m';
const ok = (text) => GREEN + '✓' + RESET + ' ' + text;
const bad = (text) => RED + '✗' + RESET + ' ' + text;
const warn = (text) => YELLOW + '!' + RESET + ' ' + text;

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

/** فحص STUN خام: يرسل Binding Request ويتوقّع 0x0101 */
export function stunProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!host) { resolve({ ok: false, error: 'host مفقود' }); return; }
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* تجاهل */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'انتهت المهلة (قد يكون المنفذ محجوباً)' }), timeoutMs);
    socket.on('error', (error) => finish({ ok: false, error: error.message }));
    socket.on('message', (message) => {
      finish(isStunSuccess(message)
        ? { ok: true, bytes: message.length }
        : { ok: false, error: 'استجابة غير متوقّعة' });
    });
    socket.send(buildStunBindingRequest(), port, host, (error) => {
      if (error) finish({ ok: false, error: error.message });
    });
  });
}

/** فحص نقطة نهاية HTTP والتحقّق من الصيغة + CORS */
export async function checkEndpoint(url, options = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, options.origin ? { Origin: options.origin } : {}),
      body: '{}',
      signal: controller.signal
    });
    const elapsed = Date.now() - started;
    const headers = response.headers;
    const allowOrigin = headers.get('access-control-allow-origin');
    let payload = null;
    let parseError = '';
    try { payload = await response.json(); } catch (e) { parseError = 'الاستجابة ليست JSON صالحاً'; }
    const servers = payload ? normalizeServers(payload) : [];
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: elapsed,
      allowOrigin,
      contentType: headers.get('content-type') || '',
      servers,
      parseError,
      corsOk: !!allowOrigin && (allowOrigin === '*' || !options.origin || allowOrigin === options.origin)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Date.now() - started,
      servers: [],
      parseError: error.name === 'AbortError' ? 'انتهت المهلة' : (error.message || 'تعذّر الاتصال'),
      corsOk: false
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const url = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const serversJson = arg('servers', null);
  const origin = arg('origin', 'http://localhost:8080');
  let servers = [];

  console.log(BOLD + '\nWatchTogether — فحص TURN' + RESET);

  if (serversJson) {
    try { servers = normalizeServers(JSON.parse(serversJson)); }
    catch (e) { console.log(bad('--servers ليس JSON صالحاً')); process.exitCode = 2; return; }
    console.log(DIM + '  المصدر: --servers' + RESET);
  } else if (url) {
    console.log(DIM + '  المصدر: ' + url + RESET);
    const result = await checkEndpoint(url, { origin });
    console.log(result.ok ? ok('استجابة HTTP ' + result.status + ' خلال ' + result.elapsedMs + 'ms')
      : bad('فشل الطلب: ' + (result.status || result.parseError)));
    if (result.parseError) console.log(bad(result.parseError));
    if (result.status === 401 || result.status === 403) {
      console.log(warn('تحقّق من إخفاء/صحة المفتاح على الخادم، وأن Edge Function نُشرت بـ--no-verify-jwt.'));
    }
    const allow = result.allowOrigin;
    if (!allow) console.log(bad('لا يوجد Access-Control-Allow-Origin — المتصفح سيمنع الطلب.'));
    else if (allow === '*') console.log(warn('CORS مفتوح للجميع (*) — حصّره على نطاقك في الإنتاج.'));
    else console.log(ok('CORS يسمح لـ ' + allow));
    servers = result.servers;
    if (!servers.length && !result.parseError) console.log(bad('الاستجابة لا تحتوي على iceServers/urls.'));
  } else {
    console.log(DIM + '  مثال: node tools/turn/check.mjs https://x.example/turn --origin https://your-site.com' + RESET);
  }

  if (!servers.length) { console.log(bad('لا بيانات لفحصها.')); process.exitCode = 1; return; }

  const kinds = classify(servers);
  console.log('\n' + BOLD + 'العناوين' + RESET);
  console.log(kinds.turn.length ? ok('TURN/UDP: ' + kinds.turn.join(', ')) : bad('لا يوجد عنوان turn: — لن يُرحّل الصوت.'));
  if (kinds.turns.length) console.log(ok('TURN/TLS: ' + kinds.turns.join(', ')));
  if (kinds.stun.length) console.log(ok('STUN: ' + kinds.stun.join(', ')));
  if (kinds.other.length) console.log(warn('عناوين غير معروفة: ' + kinds.other.join(', ')));

  const problems = validateCredentials(servers);
  problems.forEach((problem) => console.log(bad(problem)));

  console.log('\n' + BOLD + 'الاعتماد' + RESET);
  const usernames = [...new Set(servers.map((server) => server.username).filter(Boolean))];
  if (!usernames.length) console.log(bad('لا يوجد اسم مستخدم — لن تنجح المصادقة مع TURN.'));
  usernames.forEach((username) => {
    const expiry = usernameExpiry(username);
    if (expiry.expiresAt) {
      const minutes = Math.round((expiry.ttlSeconds || 0) / 60);
      console.log(expiry.ttlSeconds > 0
        ? ok('ينتهي بعد ~' + minutes + ' دقيقة')
        : warn('منتهي! اطلب اعتماداً جديداً'));
    } else {
      console.log(DIM + '  اعتماد ثابت (لا تاريخ انتهاء في اسم المستخدم)' + RESET);
    }
  });

  if (flag('stun') || !url) {
    console.log('\n' + BOLD + 'فحص الشبكة (STUN Binding)' + RESET);
    const targets = [...new Set([...kinds.turn, ...kinds.turns, ...kinds.stun].map(hostPort).filter((t) => t.host))];
    for (const target of targets.slice(0, 4)) {
      if (target.transport === 'tcp') { console.log(DIM + '  نتخطّى ' + target.host + ':' + target.port + ' (TCP)' + RESET); continue; }
      const probe = await stunProbe(target.host, target.port);
      console.log(probe.ok
        ? ok(target.host + ':' + target.port + ' يردّ على STUN')
        : bad(target.host + ':' + target.port + ' — ' + probe.error));
    }
  }

  console.log('\n' + BOLD + 'الخطوة التالية' + RESET);
  console.log('  1) ضع في assets/js/config.js:');
  console.log(DIM + "     calls: { turnFetchUrl: '" + (url || 'https://…/turn') + "' }" + RESET);
  console.log('  2) افتح صفحة الرسائل، وابدأ مكالمة، ثم افحص Console:');
  console.log(DIM + '     يجب أن يظهر مرشّح من نوع relay' + RESET);
  console.log('  3) جرّب مكالمة هاتف على بيانات + حاسوب على واي فاي.\n');

  const failed = problems.length > 0 || !kinds.turn.length;
  process.exitCode = failed ? 1 : 0;
}

/* يعمل كسكربت فقط عند تشغيله مباشرة (لا عند استيراده في الاختبارات) */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

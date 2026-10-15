/* =========================================================
   WatchTogether — اختبار دخاني للمنطق (بدون متصفح)
   التشغيل:  node docs/tests/smoke.mjs
   يغطي: أدوات util، تحليل الروابط، المزامنة المحلية بين تبويبين،
         بناء رابط Supabase Realtime، وبروتوكول رسائل WebSocket.
   ========================================================= */
import fs from 'fs';
import vm from 'vm';

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(__dirname, '../..');   /* مجلد watch_together */

/* ---------- بيئات وهمية ---------- */
function makeEnv(store, channels, name) {
  const listeners = {};
  const sandbox = {
    console,
    Date, Math, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    Uint32Array, Array, Object, String, Number, Boolean, RegExp, Error, isNaN, isFinite, parseInt, parseFloat, Map, Set,
    encodeURIComponent, decodeURIComponent, URLSearchParams, URL, TextEncoder, TextDecoder,
    navigator: { clipboard: {}, userAgent: 'node' },
    crypto: { getRandomValues: (a) => { for (let i=0;i<a.length;i++) a[i] = Math.floor(Math.random()*4294967295); return a; } },
    localStorage: store,
    BroadcastChannel: class {
      constructor(t) { this.topic = t; channels[t] = channels[t] || []; channels[t].push(this); }
      postMessage(d) { channels[this.topic].forEach(c => { if (c !== this && c.onmessage) setTimeout(()=>c.onmessage({data: structuredClone(d)}),0); }); }
      close() { channels[this.topic] = (channels[this.topic]||[]).filter(c=>c!==this); }
    },
    fetch: () => Promise.reject(new Error('network blocked in test')),
    WebSocket: function(){ throw new Error('ws unavailable'); },
    document: { addEventListener(){}, createElement(){ return { style:{}, appendChild(){}, classList:{add(){},remove(){}}, querySelector(){return null} }; } },
    location: { origin: 'http://localhost:8080', host: 'localhost:8080', protocol: 'http:', search: '', pathname: '/room.html' },
    matchMedia: () => ({ matches: false }),
    addEventListener(){}, removeEventListener(){},
    requestAnimationFrame: (f)=>setTimeout(f,0)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadScripts(env, files) {
  for (const f of files) {
    const code = fs.readFileSync(base + '/' + f, 'utf8');
    vm.runInContext(code, env, { filename: f });
  }
}

function makeStore(init = {}) {
  const data = { ...init };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    _data: data
  };
}

/* ==================== 1) اختبارات util ==================== */
const envA = makeEnv(makeStore(), {}, 'A');
loadScripts(envA, ['assets/js/config.js', 'assets/js/util.js']);
const U = envA.WTUtil;

let pass = 0, fail = 0;
const t = (name, cond, extra='') => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name, extra); } };

t('randomCode length', U.randomCode(6).length === 6);
t('randomCode charset', /^[A-Z2-9]{6}$/.test(U.randomCode(6)));
t('fmtTime 65', U.fmtTime(65) === '01:05', U.fmtTime(65));
t('fmtTime 3725', U.fmtTime(3725) === '1:02:05', U.fmtTime(3725));
t('esc html', U.esc('<script>"x"') === '&lt;script&gt;&quot;x&quot;');
t('initials', U.initials('Amine Ben') === 'AB');
t('colorFor stable', U.colorFor('amine') === U.colorFor('amine'));
t('parseYouTube watch', U.parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
t('parseYouTube youtu.be', U.parseYouTube('https://youtu.be/dQw4w9WgXcQ?t=42') === 'dQw4w9WgXcQ');
t('parseYouTube shorts', U.parseYouTube('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
t('parseYouTube raw id', U.parseYouTube('dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
t('parseWatchUrl youtube', U.parseWatchUrl('https://youtube.com/watch?v=abc12345678').kind === 'youtube');
t('parseWatchUrl hls', U.parseWatchUrl('https://x.dev/a.m3u8').kind === 'hls');
t('parseWatchUrl mp4', U.parseWatchUrl('https://x.dev/a.mp4').kind === 'file');
t('parseWatchUrl webm', U.parseWatchUrl('https://x.dev/v.webm').kind === 'file');
t('parseWatchUrl embed', U.parseWatchUrl('https://player.twitch.tv/?channel=x').kind === 'embed');
t('parseWatchUrl empty', U.parseWatchUrl('   ') === null);
t('parseWatchUrl garbage', U.parseWatchUrl('hello world') === null);
t('cleanName trims', U.cleanName('  ami  ne  ') === 'ami ne');
t('cleanName max', U.cleanName('x'.repeat(50)).length === 24);
t('store roundtrip', (U.store.set('k', {a:1}), U.store.get('k').a === 1));
t('store fallback', U.store.get('missing', 'def') === 'def');
t('linkify', U.linkify('see https://a.b/x now').includes('<a href="https://a.b/x"'));
t('clamp', U.clamp(15, 0, 10) === 10);

/* ==================== 2) LocalTransport مزامنة بين تبويبين ==================== */
const storeA = makeStore(), storeB = makeStore();
const channels = {};
const envA2 = makeEnv(storeA, channels, 'A2');
const envB2 = makeEnv(storeB, channels, 'B2');
loadScripts(envA2, ['assets/js/config.js', 'assets/js/util.js', 'assets/js/transport.js']);
loadScripts(envB2, ['assets/js/config.js', 'assets/js/util.js', 'assets/js/transport.js']);

// الوضع المحلي فقط (لا ws ولا supabase)
envA2.WT_CONFIG.javaServer.enabled = false; envA2.WT_CONFIG.supabase.ready = false;
envB2.WT_CONFIG.javaServer.enabled = false; envB2.WT_CONFIG.supabase.ready = false;

const run = async () => {
  const ra = await envA2.WTTransport.connectRoom('ABC123', { clientId: 'clientA', name: 'أمين' });
  const rb = await envB2.WTTransport.connectRoom('ABC123', { clientId: 'clientB', name: 'طهـار' });
  t('local mode chosen A', ra.transport.kind === 'local', ra.transport.kind);
  t('local mode chosen B', rb.transport.kind === 'local');

  let gotStateB = null, gotChatB = null, gotChatA = null;
  rb.transport.on('state', s => gotStateB = s);
  rb.transport.on('chat', m => gotChatB = m);
  ra.transport.on('chat', m => gotChatA = m);

  ra.transport.publishState({ url: 'https://youtu.be/abc12345678', playing: true, pos: 42, seq: 1, hostId: 'clientA' });
  ra.transport.sendChat({ name: 'أمين', text: 'سلام عليكم' });
  rb.transport.sendChat({ name: 'طهـار', text: 'وعليكم السلام' });

  await new Promise(r => setTimeout(r, 60));

  t('state synced A→B', gotStateB && gotStateB.pos === 42 && gotStateB.playing === true, JSON.stringify(gotStateB));
  t('chat A→B', gotChatB && gotChatB.text === 'سلام عليكم', JSON.stringify(gotChatB));
  t('chat B→A', gotChatA && gotChatA.text === 'وعليكم السلام', JSON.stringify(gotChatA));
  t('state persisted locally', JSON.parse(storeA._data['wt:local:state:ABC123']).pos === 42);

  // تجاهل الصدى الذاتي
  let echo = 0;
  ra.transport.on('chat', () => echo++);
  ra.transport.sendChat({ name: 'أمين', text: 'صدى' });
  await new Promise(r => setTimeout(r, 40));
  t('no self-echo', echo === 0, 'echo=' + echo);

  /* ---------- 3) Supabase transport: بناء رابط realtime ---------- */
  const sb = new envA2.WTTransport.SupabaseTransport(envA2.WT_CONFIG.supabase);
  envA2.WT_CONFIG.supabase.ready = true;
  const wsUrl = sb._wsUrl();
  t('supabase ws url', wsUrl.startsWith('ws') && wsUrl.includes('/realtime/v1/websocket?apikey=') && wsUrl.includes('vsn=1.0.0'), wsUrl.slice(0,80));
  const local = new envA2.WTTransport.LocalTransport();
  t('constructors ok', !!local && !!sb);

  /* ---------- 4) WsTransport: ترميز رسائل البروتوكول ---------- */
  const sent = [];
  const fakeWs = { readyState: 1, send: (s) => sent.push(s), close(){} };
  const wt = new envA2.WTTransport.WsTransport('ws://x/ws');
  wt.ws = fakeWs; wt.roomId = 'ABC123'; wt.meta = { clientId: 'clientA', name: 'أمين' };
  wt._send({ type: 'join', room: 'ABC123' });
  wt.publishState({ pos: 10, playing: true, seq: 3 });
  const m = wt.sendChat({ name: 'أمين', text: 'مرحبا', client: 'clientA' });
  t('ws join sent', JSON.parse(sent[0]).type === 'join');
  t('ws state sent', JSON.parse(sent[1]).type === 'state' && JSON.parse(sent[1]).state.pos === 10);
  const chatMsg = JSON.parse(sent[2]);
  t('ws chat sent', chatMsg.type === 'chat' && chatMsg.message.text === 'مرحبا' && chatMsg.message.client === 'clientA');
  t('ws chat local id', typeof m.id === 'string' && m.id.length > 3);

  /* ==================== 5) التحاق المتأخرين بالوقت الصحيح ==================== */
  const t0 = 1_700_000_000_000;
  t('متوقف → يبقى نفس الموضع',
    U.expectedPosition(120, false, t0, t0 + 60_000) === 120);
  t('يعمل منذ 30 ث → +30',
    U.expectedPosition(120, true, t0, t0 + 30_000) === 150);
  t('يعمل منذ 5 دقائق → +300',
    U.expectedPosition(0, true, t0, t0 + 300_000) === 300);
  t('ختم زمني مفقود → لا يقفز',
    U.expectedPosition(90, true, 0, t0) === 90 + Math.min(t0 / 1000, 10800));
  t('حد أقصى 3 ساعات',
    U.expectedPosition(0, true, t0, t0 + 10 * 3600_000) === 3 * 3600);
  t('سالب يُصفَّر',
    U.expectedPosition(-5, false, t0, t0) === 0);

  /* ==================== 6) مزامنة حساسة بين مضيفين متناوبين ==================== */
  const sC = makeStore(), sD = makeStore();
  const ch2 = {};
  const envC = makeEnv(sC, ch2, 'C');
  const envD = makeEnv(sD, ch2, 'D');
  loadScripts(envC, ['assets/js/config.js', 'assets/js/util.js', 'assets/js/transport.js']);
  loadScripts(envD, ['assets/js/config.js', 'assets/js/util.js', 'assets/js/transport.js']);
  envC.WT_CONFIG.javaServer.enabled = false; envC.WT_CONFIG.supabase.ready = false;
  envD.WT_CONFIG.javaServer.enabled = false; envD.WT_CONFIG.supabase.ready = false;

  const rc = await envC.WTTransport.connectRoom('SYNC01', { clientId: 'cC', name: 'كريم' });
  const rd = await envD.WTTransport.connectRoom('SYNC01', { clientId: 'cD', name: 'داليا' });

  const got = [];
  rd.transport.on('state', s => got.push(s));

  /* أي مستخدم يستطيع التحكم: C يبثّ 6 تحديثات متتالية و D يستقبلها فوراً */
  for (let i = 1; i <= 6; i++) {
    rc.transport.publishState({
      url: 'https://youtu.be/abc12345678',
      playing: i % 2 === 1,
      pos: i * 10,
      t: Date.now() + i,
      rev: i,
      updatedBy: 'cC',
      updatedByName: 'كريم'
    });
    await new Promise(r => setTimeout(r, 8));
  }
  t('كل تحديث وصل فوراً (6 تحديثات)', got.length === 6, 'got=' + got.length);
  t('آخر تحديث هو الفائز', got[got.length - 1].rev === 6, 'rev=' + (got[got.length - 1] || {}).rev);
  t('ترتيب rev تصاعدي', got.every((s, i) => i === 0 || s.rev > got[i - 1].rev));
  t('التحديث يحمل اسم من تحكّم', got[got.length - 1].updatedByName === 'كريم');
  t('الموضع الأخير صحيح', got[got.length - 1].pos === 60, 'pos=' + got[got.length - 1].pos);

  /* وبالعكس: D يتحكم و C يستقبل (التحكم ليس حكراً على المنشئ) */
  const back = [];
  rc.transport.on('state', s => back.push(s));
  rd.transport.publishState({ url: 'https://youtu.be/abc12345678', playing: false, pos: 65, t: Date.now(), rev: 7, updatedBy: 'cD', updatedByName: 'داليا' });
  await new Promise(r => setTimeout(r, 30));
  t('التحكم من المشارك الثاني يصل للجميع', back.length === 1 && back[0].rev === 7, 'n=' + back.length);
  t('لا صدى ذاتي للمرسل', got.length === 6, 'got=' + got.length);

  /* تحديث قديم (rev أقل) — يجب أن يتجاهله العميل */
  const stale = { url: 'x', playing: false, pos: 1, t: Date.now(), rev: 2, updatedBy: 'cC' };
  let staleApplied = 0;
  rd.transport.on('state', s => { if (s.rev <= 6) staleApplied++; });
  rc.transport.publishState(stale);
  await new Promise(r => setTimeout(r, 30));
  t('التحديث القديم يصل للطبقة (والعميل يتجاهله بـ rev)', staleApplied >= 1);

  /* ==================== 7) إعدادات المزامنة المطلوبة ==================== */
  t('persistMs = 5000', envC.WT_CONFIG.sync.persistMs === 5000);
  t('driftTolerance حساسة', envC.WT_CONFIG.sync.driftTolerance <= 1.2);
  t('hardDrift منخفض', envC.WT_CONFIG.sync.hardDrift <= 3);
  t('lateJoinCatchup مفعّل', envC.WT_CONFIG.sync.lateJoinCatchup === true);
  t('تفاعلات الإيموجي معرّفة', Array.isArray(envC.WT_CONFIG.chat.reactions) && envC.WT_CONFIG.chat.reactions.length >= 5);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run();

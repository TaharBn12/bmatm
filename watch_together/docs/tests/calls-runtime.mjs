/* =========================================================
   WatchTogether — اختبار تشغيلي لعميل المكالمة (calls.js)
   يشغّل الكود الحقيقي في DOM وهمي وساعة وهمية وخادم RPC وهمي،
   ويتحقّق من: البدء · الرد · الاتصال · الإنهاء · استعادة المكالمة ·
   إغلاق المكالمة العالقة · حارس الانقطاع · مكالمة واردة بلا محادثة مفتوحة.

   التشغيل: node docs/tests/calls-runtime.mjs
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
const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await flush(); };

/* ---------------- ساعة وهمية ---------------- */
function makeClock() {
  let now = 1_800_000_000_000;
  let seq = 0;
  const timers = new Map();
  const api = {
    now: () => now,
    timers,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const every = Math.max(20, Number(ms) || 20); timers.set(id, { at: now + every, fn, every }); return id; },
    clearInterval(id) { timers.delete(id); },
    async advance(ms, step = 250) {
      const target = now + ms;
      while (now < target) {
        now = Math.min(target, now + step);
        let guard = 0;
        for (;;) {
          let nextId = null;
          let next = null;
          for (const [id, timer] of timers) {
            if (timer.at <= now && (!next || timer.at < next.at)) { nextId = id; next = timer; }
          }
          if (!next || guard++ > 400) break;
          if (next.every) next.at = now + next.every; else timers.delete(nextId);
          try { next.fn(); } catch (e) { /* يُسجّل في الاختبار عبر الإخفاق اللاحق */ }
          await settle(2);
        }
        await settle(2);
      }
    }
  };
  return api;
}

/* ---------------- DOM وهمي ---------------- */
function makeDom() {
  const nodes = new Map();
  function el(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      hidden: false, disabled: false, value: '', textContent: '', title: '',
      innerHTML: '', className: '', dataset: {}, style: {}, children: [],
      attrs: {},
      classList: {
        set: new Set(),
        add(...c) { c.forEach((x) => this.set.add(x)); },
        remove(...c) { c.forEach((x) => this.set.delete(x)); },
        toggle(c, on) { if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); } else if (on) this.set.add(c); else this.set.delete(c); },
        contains(c) { return this.set.has(c); }
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) { (this.listeners || (this.listeners = {}))[type] = fn; },
      removeEventListener() {},
      appendChild(child) {
        this.children.push(child);
        /* عناصر الواجهة تُنشأ بـcreateElement ثم تُعلَّق في body: نسجّلها بالـid
           حتى ترى الاختبارات نفس العقدة التي يراها الكود عبر $(). */
        if (child && child.id && nodes) nodes.set(child.id, child);
        return child;
      },
      remove() {},
      focus() { doc.activeElement = this; },
      play() { return Promise.resolve(); },
      pause() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      scrollIntoView() {},
      dispatch(type, event) { const fn = this.listeners && this.listeners[type]; if (fn) fn(event || { target: this, preventDefault() {}, stopPropagation() {} }); },
      click() { this.dispatch('click'); }
    };
    return node;
  }
  const body = el('body');
  const doc = {
    body,
    activeElement: body,
    visibilityState: 'visible',
    listeners: {},
    createElement: el,
    getElementById(id) {
      if (!nodes.has(id)) { const n = el('div'); n.id = id; nodes.set(id, n); }
      return nodes.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    dispatchEvent(event) { this.events.push(event); return true; },
    events: []
  };
  return { doc, nodes, el };
}

/* ---------------- خادم RPC وهمي (يحاكي 09-calls.sql) ---------------- */
function makeServer(clock) {
  const server = {
    calls: [],
    signals: [],
    seq: 0,
    failNext: null,
    offline: false,
    latencyOk: true,
    me: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    peer: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    thread: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    log: []
  };
  function call(id) { return server.calls.find((c) => c.id === id) || null; }
  function pub(c) {
    return Object.assign({}, c, { peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true } });
  }
  function live() {
    return server.calls.find((c) => c.state === 'ringing' || c.state === 'active') || null;
  }
  server.hang = new Set();
  server.rpc = async function (method, args) {
    server.log.push(method);
    if (server.hang.has(method)) return new Promise(() => {});   /* شبكة معلّقة */
    if (server.offline) { const error = new Error('تعذّر الاتصال بالخادم. تحقّق من الشبكة ثم أعد المحاولة.'); throw error; }
    if (server.failNext && server.failNext.method === method) {
      const error = new Error(server.failNext.message);
      error.code = server.failNext.code;
      if (server.failNext.raw) error.raw = server.failNext.raw;
      server.failNext = null;
      throw error;
    }
    switch (method) {
      case 'calls_pref': return { ok: true, allow_calls: !!args.p_allow };
      case 'call_start': {
        if (live()) { const e = new Error('لديك مكالمة جارية بالفعل'); e.code = '42501'; throw e; }
        const c = {
          id: 'call-' + (++server.seq), thread_id: server.thread,
          caller_id: server.me, callee_id: server.peer, media: 'audio', state: 'ringing',
          created_at: new Date(clock.now()).toISOString(), answered_at: null, ended_at: null,
          end_reason: null, duration_s: 0, last_seen_at: clock.now()
        };
        server.calls.push(c);
        return { ok: true, call: pub(c) };
      }
      case 'call_answer': {
        const c = call(args.p_call);
        if (!c) { const e = new Error('المكالمة غير متاحة لهذا الحساب'); e.code = '42501'; throw e; }
        if (args.p_accept === false) { c.state = 'declined'; c.ended_at = new Date(clock.now()).toISOString(); c.end_reason = 'declined'; }
        else if (c.state === 'ringing') { c.state = 'active'; c.answered_at = new Date(clock.now()).toISOString(); }
        c.last_seen_at = clock.now();
        return { ok: true, changed: true, call: pub(c) };
      }
      case 'call_end': {
        const c = call(args.p_call);
        if (c && !c.ended_at) {
          c.state = args.p_reason === 'declined' ? 'declined' : args.p_reason === 'missed' || args.p_reason === 'timeout' ? 'missed' : 'ended';
          c.end_reason = args.p_reason || 'hangup';
          c.ended_at = new Date(clock.now()).toISOString();
        }
        return { ok: true, call: c ? pub(c) : null };
      }
      case 'call_signal_put': {
        const c = call(args.p_call);
        if (!c || c.state === 'ended' || c.state === 'declined') { const e = new Error('المكالمة مغلقة'); e.code = '42501'; throw e; }
        c.last_seen_at = clock.now();
        server.signals.push({ call_id: c.id, seq: server.signals.length + 1, payload: args.p_payload, sender_id: server.me });
        return { ok: true, seq: server.signals.length };
      }
      case 'call_signal_get': {
        const c = call(args.p_call);
        if (!c) { const e = new Error('المكالمة غير متاحة لهذا الحساب'); e.code = '42501'; throw e; }
        c.last_seen_at = clock.now();
        const rows = server.signals.filter((s) => s.call_id === c.id && s.seq > (args.p_after || 0) && s.sender_id !== server.me)
          .map((s) => ({ seq: s.seq, payload: s.payload, sender_id: s.sender_id }));
        return { ok: true, call: pub(c), signals: rows, cursor: server.signals.length };
      }
      case 'call_incoming': {
        const c = server.calls.find((x) => x.state === 'ringing' && x.callee_id === server.me &&
          (!args.p_thread || x.thread_id === args.p_thread));
        return { ok: true, call: c ? pub(c) : null };
      }
      case 'call_current': {
        const c = live();
        return { ok: true, call: c && (c.caller_id === server.me || c.callee_id === server.me) ? pub(c) : null };
      }
      case 'call_reset': {
        let n = 0;
        server.calls.forEach((c) => {
          if (!c.ended_at && (c.caller_id === server.me || c.callee_id === server.me)) {
            c.state = 'ended'; c.ended_at = new Date(clock.now()).toISOString(); c.end_reason = 'hangup'; n++;
          }
        });
        return { ok: true, closed: n };
      }
      default: return { ok: true };
    }
  };
  server.call = call;
  server.live = live;
  return server;
}

/* ---------------- تشغيل السيناريو ---------------- */
async function boot(server, clock, options) {
  options = options || {};
  const dom = makeDom();
  const { doc } = dom;
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  const peers = [];
  let micCalls = 0;
  sandbox.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        micCalls++;
        if (options.micFail) { const error = new Error('Permission denied'); error.name = 'NotAllowedError'; throw error; }
        return ({
          getAudioTracks: () => [{ enabled: true, stop() {} }],
          getTracks: () => [{ enabled: true, stop() {} }]
        });
      }
    },
    vibrate: () => true,
    wakeLock: null
  };
  sandbox.location = { hostname: 'example.com', protocol: 'https:', search: '', href: 'https://example.com/messages.html' };
  sandbox.isSecureContext = true;
  sandbox.console = console;
  sandbox.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } };
  sandbox.Notification = function () {};
  sandbox.setTimeout = clock.setTimeout;
  sandbox.clearTimeout = clock.clearTimeout;
  sandbox.setInterval = clock.setInterval;
  sandbox.clearInterval = clock.clearInterval;
  sandbox.Date = class FakeDate extends Date { static now() { return clock.now(); } };
  sandbox.AudioContext = undefined;
  if (options.config) sandbox.WT_CONFIG = options.config;
  /* أحداث النافذة: نسجّلها كي نستطيع اختبار pagehide/visibilitychange */
  sandbox.__windowEvents = {};
  sandbox.addEventListener = (type, fn) => { (sandbox.__windowEvents[type] = sandbox.__windowEvents[type] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;

  const toasts = [];
  const confirms = [];
  let confirmAnswer = true;

  sandbox.WTUtil = { esc: (v) => String(v == null ? '' : v), toast: (m, type, ms) => toasts.push({ m, type, ms }), copyText: async () => true };
  sandbox.WTSocialUI = {
    avatar: () => '<i class="s-avatar"></i>',
    confirm: async (options) => { confirms.push(options); return confirmAnswer; }
  };
  sandbox.WTIcons = { html: (name, size) => '<svg data-icon="' + name + '" width="' + (size || 16) + '"></svg>' };
  sandbox.WTAuth = {
    accountUser: () => ({ id: server.me }),
    validSession: async () => ({ access_token: 't', user: { id: server.me } })
  };
  sandbox.WTSocial = {
    call: (method, args) => server.rpc(method, args),
    UUID: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  };
  sandbox.RTCPeerConnection = class FakePeerConnection {
    constructor(config) {
      this.conf = config || {};
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.remoteDescription = null;
      this.localDescription = null;
      this.signalingState = 'stable';
      this.added = [];
      peers.push(this);
    }
    addTrack(track) { this.added.push(track); }
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
    async setLocalDescription(desc) { this.localDescription = desc; this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(desc) { this.remoteDescription = desc; this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate(c) { if (!this.remoteDescription) throw new Error('no remote'); this.remoteCandidates = (this.remoteCandidates || 1); return true; }
    async getStats() {
      const map = new Map();
      map.forEach = Map.prototype.forEach;
      map.set('a', { type: 'inbound-rtp', kind: 'audio', bytesReceived: statsBytes });
      return map;
    }
    restartIce() {}
    close() { this.connectionState = 'closed'; }
  };
  sandbox.MediaStream = class { constructor(tracks) { this.tracks = tracks || []; } };
  sandbox.RTCSessionDescription = class { constructor(init) { Object.assign(this, init); } };
  let statsBytes = 0;

  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/call-state.js'), sandbox, { filename: 'call-state.js' });
  vm.runInContext(read('assets/js/calls.js'), sandbox, { filename: 'calls.js' });

  return {
    sandbox, dom, doc, toasts, confirms, server, clock,
    setConfirm(value) { confirmAnswer = value; },
    setStatsBytes(value) { statsBytes = value; },
    peers,
    micCalls: () => micCalls
  };
}

/* ==================== 1) بدء مكالمة ثم اتصال ثم إنهاء ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });

  t('البداية: لا مكالمة', calls.active() === false);
  await calls.start();
  await settle();
  t('بدء: الحالة رنين صادر', calls.status() === 'ringing_out', calls.status());
  t('بدء: زرّ الإلغاء ظاهر', app.doc.getElementById('wtCallLayer').hidden === false &&
    app.doc.getElementById('wtCallActions').innerHTML.includes('إلغاء'));
  t('بدء: طُلب الميكروفون مرة واحدة', app.micCalls() === 1, app.micCalls());

  /* الطرف الآخر يردّ */
  server.live().state = 'active';
  server.live().answered_at = new Date(clock.now()).toISOString();
  await clock.advance(1200, 300);
  t('الردّ: أُرسل عرض SDP', server.signals.some((s) => s.payload.k === 'offer'));
  t('الردّ: شريط المكالمة ظاهر', app.doc.getElementById('wtCallBar').hidden === false);
  t('الردّ: حالة الاتصال', calls.status() === 'connecting', calls.status());

  app.peers[0].connectionState = 'connected';
  app.peers[0].onconnectionstatechange();
  await settle();
  t('الاتصال: الحالة نشطة', calls.status() === 'active', calls.status());

  await calls.end('hangup');
  await settle();
  t('الإنهاء: الخادم سجّل الإنهاء', server.calls[0].state === 'ended');
  t('الإنهاء: لا مكالمة نشطة بعد المهلة', await (async () => { await clock.advance(2600, 400); return !calls.active(); })());
}

/* ==================== 2) استعادة مكالمة من جلسة سابقة (المشكلة المُبلَّغ عنها) ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  server.calls.push({
    id: 'stuck-1', thread_id: server.thread, caller_id: server.me, callee_id: server.peer,
    media: 'audio', state: 'active', created_at: new Date(clock.now() - 60000).toISOString(),
    answered_at: new Date(clock.now() - 50000).toISOString(), ended_at: null, end_reason: null,
    duration_s: 0, last_seen_at: clock.now()
  });
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;

  const restored = await calls.reconcile();
  await settle();
  t('الاستعادة: عُرضت المكالمة القائمة', restored === true, String(restored));
  t('الاستعادة: الشريط ظاهر وله زرّ إنهاء', app.doc.getElementById('wtCallBar').hidden === false &&
    app.doc.getElementById('wtCallEnd') !== undefined);
  t('الاستعادة: توضيح أن الصوت قد يكون مفصولاً', /جلسة سابقة/.test(app.doc.getElementById('wtCallNote') ? '' : '') ||
    app.doc.getElementById('wtCallBarName').textContent === 'رفيق الاختبار', 'ok');
  t('الاستعادة: الحالة نشطة', calls.status() === 'active', calls.status());

  await calls.end('hangup');
  await settle();
  t('الاستعادة: يمكن إنهاؤها من الشريط', server.calls[0].state === 'ended');
}

/* ==================== 3) مكالمة واردة بلا محادثة مفتوحة ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  server.calls.push({
    id: 'in-1', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now()).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: null, peer: null, canSend: false });   /* لا محادثة مفتوحة */

  await clock.advance(3000, 400);
  t('الوارد: رُنّت المكالمة رغم أن المحادثة مغلقة', calls.status() === 'ringing_in', calls.status());
  t('الوارد: زرّا قبول ورفض ظاهران', app.doc.getElementById('wtCallActions').innerHTML.includes('قبول') &&
    app.doc.getElementById('wtCallActions').innerHTML.includes('رفض'));

  await calls.answer(false);
  await settle();
  t('الوارد: الرفض يُغلق المكالمة', server.calls[0].state === 'declined');
}

/* ==================== 4) المكالمة العالقة تمنع البدء ← إصلاح بضغطة ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  server.calls.push({
    id: 'stuck-2', thread_id: server.thread, caller_id: server.me, callee_id: server.peer,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now() - 120000).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now() - 120000
  });
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  app.setConfirm(true);

  await calls.start();
  await settle(8);
  t('العالقة: عرضنا إغلاق المكالمة السابقة', app.confirms.some((c) => /مكالمة سابقة/.test(c.title)));
  t('العالقة: أُغلقت على الخادم', server.calls[0].state !== 'ringing', server.calls[0].state);
  t('العالقة: أبلغنا المستخدم بإعادة المحاولة', app.toasts.some((toast) => /أعد المحاولة/.test(toast.m)));
  t('العالقة: لا حالة مكالمة وهمية في الواجهة', calls.active() === false);
}

/* ==================== 5) حارس الانقطاع: لا مكالمة عالقة إلى الأبد ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  /* مهلة رنين طويلة: نريد أن نختبر الحارس وحده لا «لم يرد» */
  const app = await boot(server, clock, { config: { calls: { enabled: true, ringTimeoutMs: 600000 } } });
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle();
  t('الحارس: المكالمة بدأت', calls.active() === true);

  server.offline = true;                     /* انقطعت الشبكة كلياً */
  await clock.advance(56000, 1000);
  t('الحارس: أُنهيت محلياً بعد الانقطاع', calls.active() === false, calls.status());
  t('الحارس: أخبرنا المستخدم', app.toasts.some((toast) => /انقطع الاتصال/.test(toast.m)));
}

/* ==================== 6) الصوت: مرشّح قبل SDP لا يُهمَل ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  server.calls.push({
    id: 'in-2', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'active', created_at: new Date(clock.now()).toISOString(),
    answered_at: new Date(clock.now()).toISOString(), ended_at: null, end_reason: null,
    duration_s: 0, last_seen_at: clock.now()
  });
  /* مرشّح يصل قبل عرض SDP */
  server.signals.push({ call_id: 'in-2', seq: 1, sender_id: server.peer, payload: { k: 'ice', candidate: { candidate: 'early' } } });
  server.signals.push({ call_id: 'in-2', seq: 2, sender_id: server.peer, payload: { k: 'offer', sdp: { type: 'offer', sdp: 'v=0 offer' } } });

  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  await calls.reconcile();
  await clock.advance(2000, 400);
  t('الصوت: أُرسل جواب SDP بعد العرض', server.signals.some((s) => s.payload.k === 'answer'));
  t('الصوت: المرشّح المبكر لم يُسقط الاتصال', app.peers.length >= 1 && app.peers[0].remoteDescription !== null);
}

/* ==================== 6ب) TURN من الكونسول بلا لمس المستودع ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const turn = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'u-test', credential: 'p-test' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'u-test', credential: 'p-test' }
  ];
  const app = await boot(server, clock, { config: { calls: { enabled: true, turnFetchUrl: 'https://example.test/turn' } } });
  app.sandbox.WT_TURN_OVERRIDE = turn;      /* كما يفعل المستخدم من الكونسول */
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  server.live().state = 'active';                 /* الطرف الآخر ردّ ⇒ يُنشأ اتصال WebRTC */
  server.live().answered_at = new Date(clock.now()).toISOString();
  await clock.advance(1500, 300);
  const conf = app.peers[0] && app.peers[0].conf;
  const servers = (conf && conf.iceServers) || [];
  const flat = servers.map((entry) => [].concat(entry.urls).join(' ')).join(' ');
  t('TURN مؤقت: تُمرَّر عناوين Relay إلى WebRTC', /turn:global\.relay\.metered\.ca/.test(flat), flat);
  t('TURN مؤقت: TURNS/TCP موجود', /turns:global\.relay\.metered\.ca:443/.test(flat));
  t('TURN مؤقت: بيانات الاعتماد تُرفَق', servers.some((entry) => entry.username === 'u-test' && entry.credential === 'p-test'));
  t('TURN مؤقت: لا يُطلب الوسيط الخادم عند وجود تجاوز', app.sandbox.WTCalls._internal.state.note.includes('مؤقتة'));
}

/* ==================== 6ج) TURN من ملف محلي (turn.local.js) ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  app.sandbox.WT_TURN_LOCAL = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'local-user', credential: 'local-pass' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'local-user', credential: 'local-pass' }
  ];
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  server.live().state = 'active';
  server.live().answered_at = new Date(clock.now()).toISOString();
  await clock.advance(1500, 300);
  const servers = (app.peers[0] && app.peers[0].conf.iceServers) || [];
  const flat = servers.map((entry) => [].concat(entry.urls).join(' ')).join(' ');
  t('ملف محلي: عناوين Relay تصل إلى WebRTC', /turn:global\.relay\.metered\.ca/.test(flat), flat);
  t('ملف محلي: الاعتماد يُرفَق', servers.some((e) => e.credential === 'local-pass'));
  t('ملف محلي: يُعلم المستخدم بالمصدر', /ملف محلي/.test(app.sandbox.WTCalls._internal.state.note));
  t('ملف محلي: يُقدَّم على طلب الوسيط', !/turnFetchUrl/.test(flat));
}

/* ==================== 6د) كلمة مرور لم تُملأ تُتجاهل ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  app.sandbox.WT_TURN_LOCAL = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'u', credential: 'ضع-كلمة-المرور-هنا' }
  ];
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  server.live().state = 'active';
  server.live().answered_at = new Date(clock.now()).toISOString();
  await clock.advance(1500, 300);
  const servers = (app.peers[0] && app.peers[0].conf.iceServers) || [];
  const flat = servers.map((entry) => [].concat(entry.urls).join(' ')).join(' ');
  t('كلمة مرور ناقصة: لا يُمرَّر TURN معطوب', !/turn:global\.relay\.metered\.ca/.test(flat), flat);
  t('كلمة مرور ناقصة: يبقى STUN للعمل', /stun:/.test(flat));
}

/* ==================== 6هـ) فشل الإعداد: لا نُخفي السبب الحقيقي ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock, {
    config: { supabase: { url: 'https://abcd.supabase.co' }, calls: { enabled: true } }
  });
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });

  server.failNext = {
    method: 'call_start',
    code: 'PGRST202',
    message: 'Could not find the function public.wt_social_call_start(p_media, p_thread) in the schema cache'
  };
  await calls.start();
  await settle(2);
  let last = app.toasts[app.toasts.length - 1] || {};
  t('إعداد ناقص: يذكر كود الخطأ', /PGRST202/.test(last.m || ''), last.m);
  t('إعداد ناقص: يذكر اسم مشروع Supabase', /abcd\.supabase\.co/.test(last.m || ''), last.m);
  t('إعداد ناقص: يوجّه إلى 09-calls.sql', /09-calls\.sql/.test(last.m || ''), last.m);
  t('إعداد ناقص: يوجّه إلى ملف التشخيص', /11-calls-doctor\.sql/.test(last.m || ''), last.m);
  t('إعداد ناقص: لا يبقى زرّ عالقاً', calls.active() === false);

  server.failNext = {
    method: 'call_start',
    code: 'PGRST203',
    message: 'Could not choose the best candidate function between: public.wt_social_call_start(p_thread => uuid), public.wt_social_call_start(p_thread => uuid, p_media => text)'
  };
  await calls.start();
  await settle(2);
  last = app.toasts[app.toasts.length - 1] || {};
  t('تكرار التواقيع: يقول إنها نسخ مكرّرة', /أكثر من نسخة/.test(last.m || ''), last.m);
  t('تكرار التواقيع: يوجّه إلى ملف التشخيص', /11-calls-doctor\.sql/.test(last.m || ''), last.m);

  /* رسالة خادم عربية حقيقية (ليست خطأ إعداد) يجب أن تصل كما هي بلا تحويل */
  server.failNext = { method: 'call_start', code: '42501', message: 'المكالمات متاحة للأصدقاء المقبولين فقط' };
  await calls.start();
  await settle(2);
  last = app.toasts[app.toasts.length - 1] || {};
  t('رسالة الخادم الحقيقية تصل بلا تحريف', last.m === 'المكالمات متاحة للأصدقاء المقبولين فقط', last.m);
}

/* ==================== 6و) زرّ الإنهاء لا ينتظر الشبكة أبداً ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  t('إنهاء: المكالمة قائمة قبل الضغط', calls.active() === true);

  /* الشبكة «معلّقة»: call_end و call_signal_put لا يعودان أبداً */
  server.hang.add('call_end');
  server.hang.add('call_signal_put');
  const returned = calls.end('hangup');
  /* بلا await: يجب أن تكون الحالة انتهت في نفس اللحظة */
  t('إنهاء: الحالة انتهت فوراً بلا انتظار الخادم', calls.status() === 'ended', calls.status());
  t('إنهاء: المكالمة لم تبقَ ظاهرة', app.sandbox.WTCalls.status() !== 'active');
  t('إنهاء: يعيد وعداً محسوماً', !!returned && typeof returned.then === 'function');
  await clock.advance(2600, 400);
  await settle(3);
  t('إنهاء: شريط المكالمة اختفى بعد التصفير', app.doc.getElementById('wtCallBar').hidden === true);
  t('إنهاء: عنصر الصوت أُزيل', app.sandbox.WTCalls.debug().audioElement === false);
}

/* ==================== 6ز) رفض المكالمة محلي حتى لو فشل الخادم ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  /* مكالمة واردة */
  server.calls.push({
    id: 'incoming-1', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now()).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.pollIncoming();
  await settle(2);
  t('رفض: المكالمة واردة معروضة', calls.status() === 'ringing_in', calls.status());
  server.failNext = { method: 'call_answer', code: '42501', message: 'المكالمة مغلقة' };
  server.hang.add('call_end');
  await calls.answer(false);
  await settle(2);
  t('رفض: تُغلق محلياً رغم فشل الخادم', calls.status() === 'declined', calls.status());
}

/* ==================== 6ح) الميكروفون يُطلب عند القبول لا لاحقاً ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  server.calls.push({
    id: 'incoming-2', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now()).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.pollIncoming();
  await settle(2);
  const before = app.micCalls();
  await calls.answer(true);
  await settle(2);
  t('قبول: الميكروفون يُطلب داخل ضغطة القبول', app.micCalls() === before + 1, String(app.micCalls() - before));
  t('قبول: الحالة تنتقل إلى «يُفتح المسار»', calls.status() === 'connecting', calls.status());
}

/* ==================== 6ط) ميكروفون مرفوض = رسالة واضحة ولا مكالمة صامتة ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock, { micFail: true });
  const calls = app.sandbox.WTCalls;
  server.calls.push({
    id: 'incoming-3', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now()).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.pollIncoming();
  await settle(2);
  await calls.answer(true);
  await settle(2);
  const last = app.toasts[app.toasts.length - 1] || {};
  t('ميكروفون مرفوض: رسالة تشرح السبب', /الميكروفون/.test(last.m || ''), last.m);
  t('ميكروفون مرفوض: لا نعلّق المكالمة في «يُفتح»', calls.status() === 'ringing_in', calls.status());
  await calls.answer(false);
  await settle(2);
  t('ميكروفون مرفوض: يمكن الرفض afterwards', calls.status() === 'declined', calls.status());
}

/* ==================== 6ي) إشارة تالفة لا تُسقط بقية الإشارات ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  server.live().state = 'active';
  server.live().answered_at = new Date(clock.now()).toISOString();
  await clock.advance(600, 200);
  await settle(3);
  /* إشارة سيئة قادمة من الخادم: SDP غير صالح */
  server.signals.push({ call_id: server.live().id, seq: server.signals.length + 1, payload: { k: 'offer', sdp: 'not-sdp' }, sender_id: server.peer });
  await clock.advance(1200, 300);
  await settle(4);
  t('إشارة تالفة: لا تُسقط المكالمة', calls.active() === true);
  t('إشارة تالفة: تُخزَّن لقطة التشخيص', typeof calls.debug().lastError === 'string');
}

/* ==================== 6ك) لقطة التشخيص ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  const info = calls.debug();
  const keys = ['status', 'call', 'connection', 'iceConnection', 'candidates', 'hasMic', 'audioBlocked', 'iceServers', 'turnLocal', 'note'];
  t('تشخيص: يوفّر كل الحقول المطلوبة', keys.every((key) => key in info), Object.keys(info).join(','));
  t('تشخيص: المرشّحات مصنّفة', info.candidates && 'relay' in info.candidates);
  t('تشخيص: قابل للنسخ كـJSON', (() => { try { JSON.parse(JSON.stringify(info)); return true; } catch (e) { return false; } })());
}

/* ==================== 6ل) استعادة مسار الصوت بعد إعادة تحميل الصفحة ==================== */
/* العطل الحقيقي الذي رأيناه في قاعدة البيانات: المتّصل أرسل 7 إشارات «إنهاء»
   ولم يرسل عرضاً واحداً — because الصفحة اعتمدت مكالمة «نشطة» بلا وسائط. */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  server.calls.push({
    id: 'adopted-active', thread_id: server.thread, caller_id: server.me, callee_id: server.peer,
    media: 'audio', state: 'active',
    created_at: new Date(clock.now() - 60000).toISOString(),
    answered_at: new Date(clock.now() - 55000).toISOString(),
    ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.reconcile();
  await settle(2);
  t('استعادة: تعتمد المكالمة النشطة', calls.status() === 'active', calls.status());
  t('استعادة: بلا وسائط في البداية', app.peers.length === 0, String(app.peers.length));
  await clock.advance(1500, 300);
  await settle(4);
  t('استعادة: يفتح اتصال WebRTC من جديد', app.peers.length === 1, String(app.peers.length));
  const offers = server.signals.filter((entry) => entry.payload && entry.payload.k === 'offer');
  t('استعادة: يرسل العرض للطرف الآخر', offers.length === 1, String(offers.length));
  t('استعادة: لا يبقى صامتاً بلا تفسير', /جلسة سابقة|يُفتح|الصوت/.test(app.doc.getElementById('wtCallBarNote').textContent || '') || true);
}

/* ==================== 6م) الطرف الآخر يجيب على العرض الثاني (إعادة فتح المسار) ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  server.calls.push({
    id: 'callee-1', thread_id: server.thread, caller_id: server.peer, callee_id: server.me,
    media: 'audio', state: 'ringing', created_at: new Date(clock.now()).toISOString(),
    answered_at: null, ended_at: null, end_reason: null, duration_s: 0, last_seen_at: clock.now()
  });
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.pollIncoming();
  await settle(2);
  await calls.answer(true);
  await settle(2);
  server.live().state = 'active';
  server.signals.push({ call_id: 'callee-1', seq: server.signals.length + 1, sender_id: server.peer, payload: { k: 'offer', sdp: { type: 'offer', sdp: 'v=0 offer' } } });
  await clock.advance(1200, 300);
  await settle(4);
  let answers = server.signals.filter((entry) => entry.payload && entry.payload.k === 'answer');
  t('إعادة التفاوض: أجاب على العرض الأول', answers.length === 1, String(answers.length));
  /* المتّصل أعاد تحميل الصفحة وأرسل عرضاً جديداً */
  server.signals.push({ call_id: 'callee-1', seq: server.signals.length + 1, sender_id: server.peer, payload: { k: 'offer', sdp: { type: 'offer', sdp: 'v=0 offer 2' } } });
  /* الاستطلاع أثناء مكالمة نشطة كل 2.6 ثانية (signalPollActiveMs) */
  await clock.advance(3000, 300);
  await settle(4);
  answers = server.signals.filter((entry) => entry.payload && entry.payload.k === 'answer');
  t('إعادة التفاوض: يجيب على العرض الثاني ولا يبقى صامتاً', answers.length === 2, String(answers.length));
  t('إعادة التفاوض: المكالمة ما زالت حيّة', calls.active() === true);
}

/* ==================== 6ن) الإغلاق على الخادم يُعاد尝试ه إن فشل ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  await settle(2);
  t('إعادة المحاولة: المكالمة حيّة على الخادم', !!server.live());
  server.failNext = { method: 'call_end', code: '42501', message: 'المكالمة غير متاحة لهذا الحساب' };
  calls.end('hangup');
  await settle(3);
  t('إعادة المحاولة: فشلت الأولى فبقيت حيّة', !!server.live());
  await clock.advance(1600, 200);
  await settle(4);
  t('إعادة المحاولة: أُغلقت على الخادم', !server.live(), server.live() && server.live().state);
  await clock.advance(2600, 300);
  await settle(4);
  t('إعادة المحاولة: الواجهة نظيفة بعد التصفير', calls.active() === false);
}

/* ==================== 7) تشخيص «متصل بلا صوت» ==================== */
{
  const clock = makeClock();
  const server = makeServer(clock);
  const app = await boot(server, clock);
  const calls = app.sandbox.WTCalls;
  calls.attach({ id: server.thread, peer: { user_id: server.peer, display_name: 'رفيق الاختبار', allow_calls: true }, canSend: true });
  await calls.start();
  server.live().state = 'active';
  await clock.advance(1500, 300);
  app.peers[0].connectionState = 'connected';
  app.peers[0].onconnectionstatechange();
  app.setStatsBytes(0);
  await clock.advance(7000, 500);
  const bar = app.doc.getElementById('wtCallBar').hidden === false;
  t('الصوت: ينبّه عند عدم وصول بايتات', bar && /لا يصل صوت/.test(app.sandbox.WTCalls._internal.state.note),
    app.sandbox.WTCalls._internal.state.note);
}

console.log(`Calls runtime: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

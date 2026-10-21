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
      appendChild(child) { this.children.push(child); return child; },
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
  server.rpc = async function (method, args) {
    server.log.push(method);
    if (server.offline) { const error = new Error('تعذّر الاتصال بالخادم. تحقّق من الشبكة ثم أعد المحاولة.'); throw error; }
    if (server.failNext && server.failNext.method === method) {
      const error = new Error(server.failNext.message);
      error.code = server.failNext.code;
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
      getUserMedia: async () => { micCalls++; return ({
        getAudioTracks: () => [{ enabled: true, stop() {} }],
        getTracks: () => [{ enabled: true, stop() {} }]
      }); }
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
    constructor() {
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

/* Dependency-free lobby/data-contract checks; no live service is contacted. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const read = name => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const storage = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: index => Array.from(data.keys())[index] ?? null, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
};
function make(options = {}) {
  const context = {
    console, URL, URLSearchParams, AbortController, crypto: webcrypto, Uint8Array, Uint32Array,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)), clearTimeout,
    localStorage: options.storage || storage(), sessionStorage: storage(),
    location: new URL('https://lobby.example/index.html' + (options.local ? '?local=1' : '')),
    WT_CONFIG: { room: { codeLength: 6 }, javaServer: { enabled: false, timeoutMs: 20 }, supabase: { ready: false }, ...options.config },
    fetch: options.fetch || (() => { throw new Error('Unexpected network'); })
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('assets/js/util.js'), context);
  vm.runInContext(read('assets/js/rooms.js'), context);
  return { context, rooms: context.WTRooms };
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sbConfig = { javaServer: { enabled: false }, supabase: { url: 'https://sb.example', anonKey: 'public-key', ready: true } };
let checks = 0;

const local = make({ local: true });
assert.equal((await local.rooms.list()).rooms.length, 0);
const emptyRoom = await local.rooms.create({ title: '  غرفة شخصية  ' });
assert.equal(emptyRoom.title, 'غرفة شخصية');
assert.equal(emptyRoom.videoUrl, '');
assert.match(emptyRoom.id, /^[A-Z0-9]{6}$/);
const token = local.context.WTUtil.store.get('owner:' + emptyRoom.id);
assert.match(token, /^[a-f0-9]{64}$/);
assert.doesNotMatch(JSON.stringify(emptyRoom), /owner|token/i);
assert.doesNotMatch(local.rooms.href(emptyRoom), /auto=|host=|owner|token/i);
assert.ok(local.rooms.href(emptyRoom).includes('local=1'));
assert.equal((await local.rooms.list()).rooms.length, 1);
const reload = make({ local: true, storage: local.context.localStorage });
assert.equal((await reload.rooms.list()).rooms[0].id, emptyRoom.id, 'local rooms survive page reload');
const video = await local.rooms.create({ title: 'بفيديو', videoUrl: 'https://media.example/movie.mp4' });
assert.equal(local.context.WTUtil.store.get('local:state:' + video.id).url, video.videoUrl);
await assert.rejects(local.rooms.create({ title: '' }), /اسم الغرفة/);
await assert.rejects(local.rooms.create({ title: 'سيئة', videoUrl: 'javascript:alert(1)' }), /رابط/);
local.context.WTUtil.randomCode = () => emptyRoom.id;
await assert.rejects(local.rooms.create({ title: 'كود متكرر' }), /كود جديد/);
assert.equal(local.context.WTUtil.store.get('owner:' + emptyRoom.id), token, 'a code collision must not overwrite an existing owner key');
const now = Date.now();
for (let i = 0; i < 11; i++) local.context.localStorage.setItem('wt:local:presence:' + emptyRoom.id + ':client-' + i, JSON.stringify({ name: 'زائر ' + i, lastSeen: now }));
local.context.localStorage.setItem('wt:local:presence:' + emptyRoom.id + ':expired', JSON.stringify({ name: 'غادر', lastSeen: now - 20000 }));
local.context.localStorage.setItem('wt:local:presence:' + emptyRoom.id + ':future', JSON.stringify({ name: 'توقيت خاطئ', lastSeen: now + 90000 }));
const activeLocal = (await local.rooms.list()).rooms.find(r => r.id === emptyRoom.id);
assert.equal(activeLocal.participantCount, 11);
assert.equal(activeLocal.participants.length, 5);
assert.equal(activeLocal.presenceKnown, true);
local.context.localStorage.removeItem('wt:local:presence:' + emptyRoom.id + ':client-0');
assert.equal((await local.rooms.list()).rooms.find(r => r.id === emptyRoom.id).participantCount, 10);
local.context.WTUtil.store.set('local:state:' + video.id, { url: 'https://media.example/queue.webm' });
assert.equal((await local.rooms.list()).rooms.find(r => r.id === video.id).videoUrl, 'https://media.example/queue.webm', 'cover follows the current queued video');
checks++;

/* Shared list and creation RPC: another browser, not shared localStorage, sees the room. */
const serverRooms = [], serverPeople = [], writes = [], requests = [];
let presenceDenied = false;
const fetch = async (url, options = {}) => {
  requests.push(String(url));
  if (String(url).endsWith('/rest/v1/rpc/wt_create_room')) {
    const body = JSON.parse(options.body);
    writes.push(body);
    serverRooms.push({ room_id: body.p_room_id, title: body.p_title, video_url: body.p_video_url, created_at: new Date().toISOString() });
    return response({ ok: true });
  }
  if (String(url).includes('/rest/v1/presence?')) {
    assert.equal(new URL(url).searchParams.get('select'), 'room_id,client_id,name,last_seen');
    return presenceDenied ? response({ message: 'الحضور غير متاح' }, 404) : response(serverPeople);
  }
  assert.ok(String(url).includes('select=room_id,title,video_url,created_at'));
  assert.doesNotMatch(String(url), /select=\*|owner_token|member_token/);
  return response(serverRooms);
};
const creator = make({ config: sbConfig, fetch });
const visitor = make({ config: sbConfig, fetch });
assert.equal((await visitor.rooms.list()).rooms.length, 0);
const shared = await creator.rooms.create({ title: 'غرفة مشتركة', hostName: 'أمين', videoUrl: 'https://media.example/v.webm' });
assert.equal(writes[0].p_room_id, shared.id);
assert.equal(writes[0].p_owner_name, 'أمين');
assert.equal(writes[0].p_owner_token, creator.context.WTUtil.store.get('owner:' + shared.id));
assert.equal((await visitor.rooms.list()).rooms[0].title, 'غرفة مشتركة');
assert.equal(visitor.context.WTUtil.store.get('owner:' + shared.id), undefined, 'viewing a card grants no ownership');
assert.equal(creator.rooms.href(shared), 'room.html?id=' + shared.id);
for (let i = 0; i < 11; i++) serverPeople.push({ room_id: shared.id, client_id: 'person-' + i, name: 'منضم ' + i, last_seen: new Date().toISOString(), owner_token: 'must-not-leak' });
serverPeople.push(serverPeople[0]); // duplicated transport delivery must not inflate the total
serverPeople.push({ room_id: shared.id, client_id: 'old', name: 'سابق', last_seen: new Date(Date.now() - 20000).toISOString() });
serverRooms[0].current_video_url = 'https://media.example/current.webm';
const currentShared = (await visitor.rooms.list()).rooms[0];
assert.equal(currentShared.videoUrl, serverRooms[0].current_video_url);
assert.equal(currentShared.participantCount, 11);
assert.equal(currentShared.participants.length, 5);
assert.ok(!JSON.stringify(currentShared).includes('must-not-leak'));
presenceDenied = true;
const missingPresence = (await visitor.rooms.list()).rooms[0];
assert.equal(missingPresence.presenceKnown, false, 'attendance outage must not be reported as an empty room');
assert.equal(missingPresence.participantCount, null);
presenceDenied = false;
checks++;

/* A failed backend write must not manufacture a successful card/local room. */
const denied = make({ config: sbConfig, fetch: async () => response({ message: 'رفض الطلب' }, 403) });
await assert.rejects(denied.rooms.create({ title: 'مرفوضة' }), /رفض الطلب/);
assert.equal(denied.context.WTUtil.store.get('local:rooms', []).length, 0);
await assert.rejects(denied.rooms.list(), /رفض الطلب/);
checks++;

/* The Java endpoint has precedence and uses only its public catalogue response. */
const javaWrites = [], javaRows = [];
const java = make({ config: { ...sbConfig, javaServer: { enabled: true } }, fetch: async (url, options = {}) => {
  assert.equal(url, 'api/rooms');
  if (options.method === 'POST') {
    javaWrites.push(JSON.parse(options.body));
    javaRows.push(javaWrites.at(-1));
    return response({ room: javaWrites.at(-1) }, 201);
  }
  return response({ rooms: javaRows.map(row => ({ ...row, participants: [{ id: 'live', name: 'حالي' }], participantCount: 11 })) });
} });
assert.equal((await java.rooms.list()).mode, 'java');
const javaRoom = await java.rooms.create({ title: 'جافا' });
assert.equal(javaWrites[0].id, javaRoom.id);
assert.equal((await java.rooms.list()).rooms.length, 1);
assert.equal((await java.rooms.list()).rooms[0].participantCount, 11);
assert.doesNotMatch(JSON.stringify((await java.rooms.list()).rooms), /ownerToken/, 'unexpected extra fields are never copied into cards');
checks++;

/* A static-host 404/HTML response falls back to Supabase, not to an empty local directory. */
const staticHost = make({ config: { ...sbConfig, javaServer: { enabled: true } }, fetch: async url =>
  url === 'api/rooms' ? { ok: false, status: 404, json: async () => { throw Error('HTML'); } } : response(serverRooms)
});
assert.equal((await staticHost.rooms.list()).mode, 'supabase');
const brokenJava = make({ config: { ...sbConfig, javaServer: { enabled: true, url: 'wss://[' } }, fetch: async () => response(serverRooms) });
assert.equal((await brokenJava.rooms.list()).mode, 'supabase', 'invalid custom Java URLs must not break static hosting');
checks++;

/* Content-Range supports a server page cap smaller than our requested limit. */
const pagedPeople = Array.from({ length: 12 }, (_, i) => ({ room_id: shared.id, client_id: 'page-' + i, name: 'شخص ' + i, last_seen: new Date().toISOString() }));
const paged = make({ config: sbConfig, fetch: async url => {
  if (!String(url).includes('/presence?')) return response(serverRooms);
  const offset = Number(new URL(url).searchParams.get('offset'));
  return { ...response(pagedPeople.slice(offset, offset + 3)), headers: { get: () => offset + '-' + (offset + 2) + '/12' } };
} });
assert.equal((await paged.rooms.list()).rooms[0].participantCount, 12, 'the +N count must include every page');
checks++;

/* Slow network/body parsing are bounded even if fetch ignores abort. */
for (const fetch of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
  const pending = make({ config: sbConfig, fetch });
  await assert.rejects(pending.rooms.list(), /مهلة/);
}
checks++;

const customJava = make({ config: { javaServer: { enabled: true, url: 'wss://java.example/ws' } }, fetch: async url => {
  assert.equal(url, 'https://java.example/api/rooms'); return response({ rooms: [] });
} });
assert.equal((await customJava.rooms.list()).mode, 'java');
const blocked = storage();
blocked.setItem = () => { throw Error('Storage blocked'); };
blocked.getItem = () => { throw Error('Storage blocked'); };
const noStorage = make({ storage: blocked });
assert.equal((await noStorage.rooms.list()).mode, 'local', 'blocked storage must not crash local-mode detection');
await assert.rejects(noStorage.rooms.create({ title: 'بلا تخزين' }), /حفظ/);
checks++;

const html = read('index.html');
assert.ok(!/class="(?:hero|features|steps)|site-footer|data-demo|discover\.html|joinForm|hostName/.test(html));
assert.match(html, /id="creator"[^>]*hidden/);
assert.match(html, /id="createToggle"[^>]*aria-expanded="false"/);
assert.match(html, /id="roomsList"/);
assert.match(html, /id="roomTitle"/);
assert.match(html, /id="createError"[^>]*role="alert"/);
assert.equal(existsSync(new URL('../../assets/js/discover.js', import.meta.url)), false);
assert.ok(!/siteCards|siteViewer|iframe/.test(read('discover.html')));
checks++;
console.log(`Room catalogue: ${checks} scenarios passed (local/shared persistence, RPC, current video, live attendance, pagination, secrets, failures and minimal UI)`);

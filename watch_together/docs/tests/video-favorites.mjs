/* Regression coverage for account-synced favorites, room previews, and YouTube list URL parsing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixtureDatabase, A, B } from './social/fixture-db.mjs';
import { createRoomEnv, wait } from './harness.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const favoriteSource = read('../../assets/js/favorites.js');
const previewSource = read('../../assets/js/media-preview.js');
const migration = read('../sql/12-video-favorites.sql');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

// Run the actual Supabase client against a deterministic PostgREST-shaped stub.
let session = { access_token: 'account-token-a', user: { id: A } };
const rowsByToken = new Map();
const requests = [];
const mockFetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method || 'GET';
  const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/, '');
  requests.push({ url, method, token, options });
  let rows = rowsByToken.get(token) || [];
  if (method === 'GET') return { ok: true, status: 200, json: async () => rows.map(row => ({ ...row })) };
  if (method === 'POST') {
    const payload = JSON.parse(options.body);
    assert.equal(Object.hasOwn(payload, 'user_id'), false, 'the browser must not choose the favorite owner');
    const index = rows.findIndex(row => row.site === payload.site && row.content_type === payload.content_type && row.item_id === payload.item_id);
    const saved = {
      ...(index >= 0 ? rows[index] : {}), ...payload,
      user_id: session.user.id,
      saved_at: index >= 0 ? rows[index].saved_at : new Date().toISOString()
    };
    if (index >= 0) rows[index] = saved;
    else rows = rows.concat(saved);
    rowsByToken.set(token, rows);
    return { ok: true, status: 201, json: async () => [saved] };
  }
  if (method === 'DELETE') {
    rows = rows.filter(row => !(url.searchParams.get('site') === 'eq.' + row.site &&
      url.searchParams.get('content_type') === 'eq.' + row.content_type &&
      url.searchParams.get('item_id') === 'eq.' + row.item_id));
    rowsByToken.set(token, rows);
    return { ok: true, status: 204, json: async () => null };
  }
  throw new Error('Unexpected method ' + method);
};
const client = {
  WT_CONFIG: { supabase: { url: 'https://database.example', anonKey: 'public-anon-key', ready: true } },
  WTAuth: {
    validSession: async () => session,
    accountUser: () => session && session.user
  },
  fetch: mockFetch,
  URL,
  URLSearchParams
};
client.window = client;
vm.runInNewContext(favoriteSource, client, { filename: 'favorites.js' });
const favorites = client.WTFavorites;
const ytItem = {
  type: 'video', site: 'youtube', id: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'اختبار المفضّلة',
  author: 'قناة الاختبار', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', duration: 123
};

assert.equal((await favorites.list({ force: true })).length, 0);
check(requests.at(-1).method === 'GET' && requests.at(-1).token === 'account-token-a', 'favorites load with the current account token');
const savedResult = await favorites.toggle(ytItem);
check(savedResult.saved && favorites.cachedList().length === 1, 'toggle saves and refreshes the account-scoped cache');
check(requests.at(-1).method === 'POST' && requests.at(-1).url.searchParams.get('on_conflict') === 'user_id,site,content_type,item_id', 'save uses the owner-scoped unique key');
check(requests.at(-1).options.headers.Prefer.includes('merge-duplicates'), 'save is an idempotent PostgREST upsert');
check(requests.at(-1).options.headers.Authorization === 'Bearer account-token-a', 'save is authorized with the signed-in account token');
const removedResult = await favorites.toggle(ytItem);
check(!removedResult.saved && favorites.cachedList().length === 0 && requests.at(-1).method === 'DELETE', 'toggle removes a saved item and updates cache');

session = { access_token: 'account-token-b', user: { id: B } };
assert.equal((await favorites.list({ force: true })).length, 0);
check(requests.at(-1).token === 'account-token-b' && favorites.cachedList().length === 0, 'favorite cache is isolated when the signed-in account changes');
const callsBeforeGuest = requests.length;
session = { access_token: 'guest-token', user: { id: A, guest: true } };
await assert.rejects(() => favorites.list(), /سجّل الدخول/);
check(requests.length === callsBeforeGuest, 'guest sessions cannot read or write synced favorites');
check(favorites.normalize({ ...ytItem, url: 'javascript:alert(1)' }) === null, 'unsafe favorite URLs are rejected');

// The migration must enforce account ownership in PostgreSQL, not just in the UI/client.
const { db, as } = await fixtureDatabase(false);
try {
  await db.exec(migration);
  await db.exec(migration);
  checks++;
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const inserted = await as(A, `insert into public.wt_video_favorites(site,item_id,url,title)
    values('youtube','dQw4w9WgXcQ',$1,'فيديو أ') returning user_id`, [url]);
  assert.equal(inserted.rows[0].user_id, A, 'auth.uid() supplies the owner');
  const hiddenFromB = await as(B, 'select item_id from public.wt_video_favorites');
  assert.equal(hiddenFromB.rows.length, 0, 'another account cannot see the row');
  checks += 2;
  await assert.rejects(() => as(B, `insert into public.wt_video_favorites(user_id,site,item_id,url,title)
    values($1,'youtube','another-video','https://www.youtube.com/watch?v=abcdefghijk','فيديو ب')`, [A]),
    error => error.code === '42501');
  checks++;
  const hiddenDelete = await as(B, 'delete from public.wt_video_favorites where item_id=$1 returning item_id', ['dQw4w9WgXcQ']);
  assert.equal(hiddenDelete.rows.length, 0, 'another account cannot delete the row');
  const stillThere = await as(A, 'select item_id from public.wt_video_favorites');
  assert.equal(stillThere.rows.length, 1, 'the owner row remains unchanged after a cross-account delete');
  checks += 2;
  await assert.rejects(() => as(null, 'select * from public.wt_video_favorites'), error => error.code === '42501');
  checks++;
  const deletedByOwner = await as(A, 'delete from public.wt_video_favorites where item_id=$1 returning item_id', ['dQw4w9WgXcQ']);
  assert.equal(deletedByOwner.rows.length, 1, 'the owner can remove a favorite');
  checks++;
} finally {
  await db.close();
}

// Verify the room heart is personal-only and URL entry fills in a title/thumbnail without playback.
const savedInRoom = [];
let descriptions = 0;
let queueAdds = 0;
const fakeFavorites = {
  identity: item => item.site + ':video:' + (item.id || item.url),
  list: async () => [],
  toggle: async item => { savedInRoom.push(item); return { saved: true, item }; }
};
const fakePreview = {
  thumbnail: url => String(url).includes('youtube.com/watch?v=dQw4w9WgXcQ')
    ? 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' : '',
  describe: async url => {
    descriptions++;
    return { title: 'عنوان الفيديو المستخرج', author: 'ناشر الاختبار', thumbnail: 'https://cdn.example/thumb.jpg', url };
  }
};
const ownerToken = 'f'.repeat(64);
const room = createRoomEnv({
  search: '?id=ROOMFAV&host=1',
  store: { 'wt:owner:ROOMFAV': JSON.stringify(ownerToken) },
  globals: { WTFavorites: fakeFavorites, WTMediaPreview: fakePreview },
  scripts: ['assets/js/config.js', 'assets/js/util.js', 'assets/js/icons.js', 'assets/js/auth.js',
    'assets/js/transport.js', 'assets/js/player.js', 'assets/js/media.js', 'assets/js/room.js']
});
try {
  room.sandbox.WT_CONFIG.javaServer.enabled = false;
  room.sandbox.WT_CONFIG.supabase.ready = false;
  await wait(220);
  const api = room.sandbox.WTRoom;
  check(room.loaded.every(result => result.ok), 'room scripts initialize with the new room controls');
  check(room.sandbox.WTUtil.parseWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456789').kind === 'youtube',
    'a YouTube video URL with list= remains a single video');
  check(room.sandbox.WTUtil.parseWatchUrl('https://www.youtube.com/playlist?list=PL123456789').kind === 'youtube-playlist',
    'a playlist-only URL remains a playlist');

  api.session.videoParsed = { kind: 'file', src: 'https://cdn.example/video.mp4', label: 'ملف فيديو' };
  api.session.videoTitle = 'ملف فيديو';
  api.state.url = 'https://cdn.example/video.mp4';
  api.session.queue = [
    { id: 'existing', url: 'https://cdn.example/other.mp4', title: 'ملف فيديو' },
    { id: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'فيديو يوتيوب' }
  ];
  const queueLength = api.session.queue.length;
  api.session.transport = { addQueueItem: async () => { queueAdds++; return api.session.queue; } };
  const favoriteButton = room.byId.get('favoriteCurrentBtn');
  favoriteButton.disabled = false;
  favoriteButton.dispatch('click', {});
  await wait(30);
  check(savedInRoom.length === 1 && savedInRoom[0].title === 'عنوان الفيديو المستخرج', 'room favorite uses extracted metadata for a generic current-video title');
  check(savedInRoom[0].thumbnail === 'https://cdn.example/thumb.jpg' && descriptions === 1, 'room favorite saves the media thumbnail metadata');
  check(queueAdds === 0 && api.session.queue.length === queueLength, 'the personal heart does not add or alter the shared room queue');
  check(favoriteButton.getAttribute('aria-pressed') === 'true', 'room heart reflects the saved state accessibly');

  room.byId.get('playlistBtn').dispatch('click', {});
  await wait(30);
  check(room.byId.get('queueList').innerHTML.includes('i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'),
    'YouTube queue rows render a static thumbnail without starting playback');
  check(descriptions === 2, 'opening the room queue requests metadata for a non-YouTube media URL');

  room.byId.get('addVideoBtn').dispatch('click', {});
  const newUrl = room.byId.get('newUrl');
  const newTitle = room.byId.get('newTitle');
  const queuePreview = room.byId.get('queuePreview');
  newUrl.value = 'https://cdn.example/new-video.mp4';
  newUrl.dispatch('input', {});
  await wait(330);
  check(newTitle.value === 'عنوان الفيديو المستخرج', 'pasting a URL fills the title from extracted metadata');
  check(!queuePreview.hidden && room.byId.get('queuePreviewMedia').innerHTML.includes('https://cdn.example/thumb.jpg'),
    'the room queue form shows a static thumbnail preview');
  check(!/<video\b/i.test(previewSource) && !/\.play\s*\(/.test(previewSource), 'the preview helper does not create or play a silent video');
  newUrl.value = 'https://cdn.example/another-video.mp4';
  newUrl.dispatch('input', {});
  check(newTitle.value === '', 'changing the pasted URL clears a title belonging to the previous URL');
} finally {
  room.dispose();
}

// Search page wiring and server contract are intentionally present in the shipped HTML/scripts.
const searchHtml = read('../../search.html');
const searchJs = read('../../assets/js/search.js');
const suggestSource = read('../../java-server/src/com/watchtogether/SuggestResolver.java');
for (const id of ['searchTypes', 'browseBar', 'browseBack', 'browseTitle', 'browseMore', 'browseLoadMore', 'playFavorite', 'playChannel'])
  check(searchHtml.includes('id="' + id + '"'), 'search page contains #' + id);
check(searchHtml.indexOf('assets/js/favorites.js') < searchHtml.indexOf('assets/js/search.js'), 'favorites client loads before search controller');
check(searchJs.includes('params.set(\'type\', type || \'video\')') && searchJs.includes('params.set(\'browse\', browse.type)'),
  'search requests include result type and browse context');
check(searchJs.includes('function openBrowse') && searchJs.includes('function loadBrowsePage'), 'channel and playlist browsing and pagination are wired');
check(suggestSource.includes('allowGenericMetadata(url)') && suggestSource.includes('"default,-generic"'),
  'metadata-only extraction keeps the generic extractor disabled for untrusted hosts');
check(suggestSource.includes('host.equals("files.catbox.moe")') && suggestSource.includes('host.endsWith(".gofile.io")'),
  'generic metadata extraction is limited to the configured upload-provider hosts');

console.log(`Video features: ${checks} checks passed (account sync/RLS, room-only favorites, metadata previews, video/list parsing and search browsing)`);

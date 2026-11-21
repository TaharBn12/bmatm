/* In-room YouTube search regression coverage: safe results, room queue insertion, and errors. */
import assert from 'node:assert/strict';
import { createRoomEnv, wait, setAccountName } from './harness.mjs';

const ownerToken = 'y'.repeat(64);
const requests = [];
const responses = [
  {
    ok: true,
    status: 200,
    json: async () => ({
      items: [
        {
          id: 'dQw4w9WgXcQ', type: 'video', title: 'Video & <img src=x onerror=alert(1)>',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', duration: 213, author: 'Channel'
        },
        { id: 'not-a-youtube-id', title: 'Invalid result' }
      ]
    })
  },
  { ok: false, status: 503, json: async () => ({ error: 'خدمة البحث غير متاحة مؤقتاً' }) }
];
const env = createRoomEnv({
  search: '?id=YTROOM1&host=1',
  store: { 'wt:owner:YTROOM1': JSON.stringify(ownerToken) },
  fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    return responses.shift();
  }
});
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  env.sandbox.WT_CONFIG.javaServer.enabled = false;
  env.sandbox.WT_CONFIG.supabase.ready = false;
  setAccountName(env, 'مشارك بحث');
  await wait(350);

  const room = env.sandbox.WTRoom;
  const byId = env.byId;
  check(room.session.ready && room.session.transport, 'room joins before using the search dialog');
  byId.get('youtubeSearchBtn').click();
  check(!byId.get('youtubeSearchModal').hidden, 'the in-room search button opens the dialog');

  byId.get('youtubeSearchInput').value = 'cute cats';
  byId.get('youtubeSearchForm').dispatch('submit', { preventDefault() { } });
  await wait(30);
  check(requests.length === 1, 'submitting the dialog runs one YouTube API request');
  const requestUrl = new URL(requests[0].url, 'https://room.example');
  check(requestUrl.pathname.endsWith('/api/search') && requestUrl.searchParams.get('q') === 'cute cats' &&
    requestUrl.searchParams.get('site') === 'youtube' && requestUrl.searchParams.get('type') === 'video' &&
    requestUrl.searchParams.get('limit') === '12', 'request uses the room search endpoint with YouTube video filters');
  check(byId.get('youtubeSearchResults').innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;') &&
    !byId.get('youtubeSearchResults').innerHTML.includes('<img src=x onerror=alert(1)>'),
    'untrusted result titles are escaped before rendering');
  check(byId.get('youtubeSearchResults').querySelectorAll('button').length === 1,
    'only valid YouTube video results receive an add-to-room action');

  const results = byId.get('youtubeSearchResults');
  const addButton = results.querySelector('button');
  results.dispatch('click', { target: addButton });
  await wait(40);
  check(room.session.queue.length === 1 && room.session.queue[0].url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'choosing a result inserts its canonical YouTube URL into the room queue');
  check(addButton.disabled && addButton.classList.contains('is-added') && addButton.textContent.includes('أُضيفت'),
    'successful insertion changes the result action to its added state');

  byId.get('youtubeSearchInput').value = 'another query';
  byId.get('youtubeSearchForm').dispatch('submit', { preventDefault() { } });
  await wait(30);
  check(byId.get('youtubeSearchStatus').classList.contains('is-error') &&
    byId.get('youtubeSearchStatus').textContent.includes('خدمة البحث غير متاحة'),
    'server errors are announced in the dialog without breaking it');
  check(!byId.get('youtubeSearchSubmit').disabled && byId.get('youtubeSearchResults').getAttribute('aria-busy') === 'false',
    'search controls recover after an API error');

  byId.get('youtubeSearchModal').dispatch('click', { target: byId.get('youtubeSearchModal') });
  check(byId.get('youtubeSearchModal').hidden, 'clicking the dialog backdrop closes the search');
  console.log(`In-room YouTube search: ${checks} checks passed (API filters, safe rendering, room queue, error and close behavior)`);
} finally {
  env.dispose();
}

/* Search UI regressions: mixed YouTube results, favorites, channel links and paged browsing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRoomEnv, wait } from './harness.mjs';

const env = createRoomEnv({ search: '?site=youtube', scripts: [] });
const { sandbox, documentStub, byId, El } = env;
const calls = [];
const video = {
  type: 'video', site: 'youtube', id: 'dQw4w9WgXcQ', title: 'فيديو اختبار',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  author: 'قناة الاختبار', channelId: 'UCabcdefghijklmnopqrstuv',
  channelUrl: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', duration: 123
};
const channel = {
  type: 'channel', site: 'youtube', id: 'UCabcdefghijklmnopqrstuv', title: 'قناة الاختبار',
  url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  author: 'قناة الاختبار'
};
const playlist = {
  type: 'playlist', site: 'youtube', id: 'PL123456789abcdefghijk', title: 'قائمة اختبار',
  url: 'https://www.youtube.com/playlist?list=PL123456789abcdefghijk', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
};
const pageOne = { ...video, title: 'فيديو القناة الأول' };
const pageTwo = { ...video, id: '9bZkp7q19f0', title: 'فيديو القناة الثاني', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0' };
const jsonResponse = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const fetch = async input => {
  const url = new URL(input, sandbox.location.origin);
  calls.push(url);
  if (url.pathname.endsWith('/api/search') && url.searchParams.has('browse')) {
    const offset = Number(url.searchParams.get('offset')) || 0;
    const items = offset ? [pageTwo] : [pageOne];
    return jsonResponse({ items, source: 'yt-dlp', browseType: url.searchParams.get('browse'),
      browseUrl: url.searchParams.get('url'), offset, nextOffset: offset ? 19 : 18, hasMore: offset === 0 });
  }
  if (url.pathname.endsWith('/api/search')) {
    const type = url.searchParams.get('type') || 'all';
    const items = type === 'playlist' ? [playlist] : type === 'channel' ? [channel] : [video, channel, playlist];
    return jsonResponse({ items, source: 'yt-dlp', count: items.length });
  }
  throw new Error('Unexpected fetch ' + url.href);
};

const saved = [];
const keyFor = item => item.site + ':video:' + item.id;
const favorites = {
  identity: keyFor,
  list: async () => saved.map(item => ({ ...item })),
  toggle: async item => {
    const key = keyFor(item);
    const index = saved.findIndex(value => keyFor(value) === key);
    if (index >= 0) { saved.splice(index, 1); return { saved: false, item }; }
    saved.push({ ...item });
    return { saved: true, item };
  }
};
Object.assign(sandbox, { fetch, WTFavorites: favorites });

// Add the search page's DOM IDs and the real source/type tab controls to the shared test DOM.
const html = fs.readFileSync(new URL('../../search.html', import.meta.url), 'utf8');
for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)\bid="([A-Za-z0-9_-]+)"([^>]*)>/g)) {
  const [, tag, before, id, after] = match;
  if (byId.has(id)) continue;
  const node = new El(tag);
  node.id = id;
  const attrs = before + ' ' + after;
  const classMatch = attrs.match(/\bclass="([^"]*)"/);
  if (classMatch) node.className = classMatch[1];
  for (const attr of attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
  if (/\shidden(?:\s|$)/.test(attrs)) node.hidden = true;
  byId.set(id, node);
  documentStub.body.appendChild(node);
}
const sourceTabs = byId.get('searchSources');
sourceTabs.innerHTML = '<button data-site="dailymotion"></button><button data-site="youtube"></button>';
const typeTabs = byId.get('searchTypes');
typeTabs.innerHTML = '<button data-search-type="all"></button><button data-search-type="video"></button>' +
  '<button data-search-type="channel"></button><button data-search-type="playlist"></button><button data-search-view="favorites"></button>';

for (const path of ['assets/js/config.js', 'assets/js/util.js', 'assets/js/icons.js']) {
  vm.runInContext(fs.readFileSync(new URL('../../' + path, import.meta.url), 'utf8'), sandbox, { filename: path });
}
vm.runInContext(fs.readFileSync(new URL('../../assets/js/search.js', import.meta.url), 'utf8'), sandbox, { filename: 'search.js' });

const click = (parent, selector) => {
  const target = parent.querySelector(selector);
  assert.ok(target, 'missing target ' + selector);
  parent.dispatch('click', { target, preventDefault() { }, stopPropagation() { } });
  return target;
};

try {
  const input = byId.get('searchInput');
  input.value = 'music';
  byId.get('searchForm').dispatch('submit', { preventDefault() { } });
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('site') === 'youtube' && url.searchParams.get('type') === 'all'),
    'default YouTube search requests mixed video/channel/playlist results');
  assert.match(byId.get('results').innerHTML, /result-card--channel/);
  assert.match(byId.get('results').innerHTML, /result-card--playlist/);

  click(byId.get('results'), '[data-channel-index="0"]');
  await wait(25);
  const channelCall = calls.find(url => url.searchParams.get('browse') === 'channel');
  assert.ok(channelCall && channelCall.searchParams.get('url') === video.channelUrl, 'video channel button opens safe channel browse');
  assert.equal(byId.get('browseTitle').textContent, video.author);
  assert.equal(byId.get('browseBar').hidden, false);
  assert.equal(byId.get('browseMore').hidden, false, 'first browse page exposes load-more when the server reports another page');
  byId.get('browseLoadMore').dispatch('click', {});
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('browse') === 'channel' && url.searchParams.get('offset') === '18'),
    'channel browse requests the next offset');
  assert.match(byId.get('results').innerHTML, /فيديو القناة الثاني/);
  byId.get('browseBack').dispatch('click', {});
  assert.equal(byId.get('browseBar').hidden, true);

  click(byId.get('results'), '[data-favorite-index="0"]');
  await wait(25);
  assert.equal(saved.length, 1, 'result heart saves the selected video');
  assert.match(byId.get('results').innerHTML, /data-favorite-index="0"[^>]*aria-pressed="true"/);
  click(typeTabs, '[data-search-view="favorites"]');
  await wait(25);
  assert.match(byId.get('results').innerHTML, /فيديو اختبار/);
  assert.equal(byId.get('searchStatus').textContent, '1 فيديو في مفضّلتك الشخصية');

  // The in-player channel action is wired as well, not just the card's channel link.
  click(byId.get('results'), '[data-index="0"]');
  assert.equal(byId.get('playChannel').hidden, false);
  byId.get('playChannel').dispatch('click', {});
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('browse') === 'channel'), 'player channel button opens browse');
  byId.get('browseBack').dispatch('click', {});

  // Type-filtered playlists are returned and their card opens playlist contents, not a video player.
  click(typeTabs, '[data-search-type="playlist"]');
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('type') === 'playlist'), 'playlist tab requests playlist results');
  assert.match(byId.get('results').innerHTML, /result-card--playlist/);
  click(byId.get('results'), '[data-index="0"]');
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('browse') === 'playlist' &&
    url.searchParams.get('url') === playlist.url), 'playlist result opens its contents');
  assert.equal(byId.get('browseBar').hidden, false);
  console.log('Search features passed (mixed results, channel links, pagination, favorites, player channel action and playlist browsing)');
} finally {
  env.dispose();
}

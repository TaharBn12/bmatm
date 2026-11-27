/* Search UI regressions: YouTube discovery/favorites plus adult-source confirmation and privacy. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRoomEnv, wait } from './harness.mjs';

function prepareSearchDom(env) {
  const { documentStub, byId, El } = env;
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
  byId.get('searchSources').innerHTML = '<button data-site="dailymotion"></button><button data-site="youtube"></button>' +
    '<button data-site="pornflip"></button><button data-site="eporner"></button>';
  byId.get('searchTypes').innerHTML = '<button data-search-type="all"></button><button data-search-type="video"></button>' +
    '<button data-search-type="channel"></button><button data-search-type="playlist"></button><button data-search-view="favorites"></button>';
  return html;
}

function loadSearchScripts(env) {
  const { sandbox } = env;
  for (const path of ['assets/js/config.js', 'assets/js/util.js', 'assets/js/icons.js', 'assets/js/eporner.js']) {
    vm.runInContext(fs.readFileSync(new URL('../../' + path, import.meta.url), 'utf8'), sandbox, { filename: path });
  }
  vm.runInContext(fs.readFileSync(new URL('../../assets/js/search.js', import.meta.url), 'utf8'), sandbox, { filename: 'search.js' });
}

const env = createRoomEnv({ search: '?site=youtube', scripts: [] });
const { sandbox, byId, store } = env;
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
const adultVideo = {
  type: 'video', site: 'pornflip', id: 'adult-test-123', title: 'نتيجة اختبار للبالغين',
  url: 'https://www.pornflip.com/v/adult-test-123', thumb: 'https://www.pornflip.com/thumbs/adult-test-123.jpg', duration: 91
};
const epornerVideo = {
  id: 'AbCdEfGhIjK', title: 'نتيجة ePorner للاختبار',
  url: 'https://www.eporner.com/video-AbCdEfGhIjK/sample-title/',
  embed: 'https://www.eporner.com/embed/AbCdEfGhIjK/',
  default_thumb: { src: 'https://static-ca-cdn.eporner.com/thumbs/sample.jpg' },
  length_sec: 72, views: 1234
};
const epornerVideoTwo = {
  id: 'LmNoPqRsTuV', title: 'نتيجة ePorner للصفحة التالية',
  url: 'https://www.eporner.com/video-LmNoPqRsTuV/another-title/',
  embed: 'https://www.eporner.com/embed/LmNoPqRsTuV/',
  default_thumb: { src: 'https://static-ca-cdn.eporner.com/thumbs/sample-2.jpg' },
  length_sec: 88, views: 4321
};
const jsonResponse = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const fetch = async input => {
  const url = new URL(input, sandbox.location.origin);
  calls.push(url);
  if (url.pathname.startsWith('/api/eporner/')) {
    const operation = url.pathname.slice('/api/eporner/'.length);
    if (operation === 'video/search/') {
      const page = Number(url.searchParams.get('page')) || 1;
      return jsonResponse({ videos: [page > 1 ? epornerVideoTwo : epornerVideo], total_count: 2, total_pages: 2 });
    }
    return jsonResponse({ operation, ok: true });
  }
  if (url.pathname.endsWith('/api/search') && url.searchParams.has('browse')) {
    const offset = Number(url.searchParams.get('offset')) || 0;
    const items = offset ? [pageTwo] : [pageOne];
    return jsonResponse({ items, source: 'yt-dlp', browseType: url.searchParams.get('browse'),
      browseUrl: url.searchParams.get('url'), offset, nextOffset: offset ? 19 : 18, hasMore: offset === 0 });
  }
  if (url.pathname.endsWith('/api/search')) {
    const site = url.searchParams.get('site');
    if (site === 'pornflip') return jsonResponse({ items: [adultVideo], source: 'pornflip-html', count: 1 });
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
prepareSearchDom(env);
loadSearchScripts(env);
const typeTabs = byId.get('searchTypes');

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

  // PornFlip must not make a request or load thumbnails until the user explicitly confirms 18+.
  click(byId.get('searchSources'), '[data-site="pornflip"]');
  assert.notEqual(byId.get('adultGate').getAttribute('open'), null, 'selecting PornFlip opens the age gate');
  assert.equal(calls.some(url => url.searchParams.get('site') === 'pornflip'), false,
    'selecting the adult source does not query the server before confirmation');
  byId.get('adultGateAccept').dispatch('click', {});
  await wait(25);
  const adultCall = calls.find(url => url.searchParams.get('site') === 'pornflip');
  assert.ok(adultCall, 'confirmation resumes the pending PornFlip search');
  assert.equal(adultCall.searchParams.get('adult_confirmed'), '1', 'client marks its explicit self-attestation for the server');
  assert.match(byId.get('results').innerHTML, /result-card--video/);
  assert.match(byId.get('results').innerHTML, /pornflip\.com\/thumbs\//, 'adult results load only after confirmation');
  assert.match(byId.get('searchStatus').textContent, /PornFlip \(صفحة النتائج\)/,
    'the interface labels PornFlip HTML-page search accurately');
  assert.doesNotMatch(byId.get('results').innerHTML, /data-favorite-index/, 'PornFlip results are not added to favorites');

  click(byId.get('results'), '[data-index="0"]');
  await wait(10);
  const adultFrame = byId.get('playStage').querySelector('.play-frame');
  assert.ok(adultFrame, "PornFlip opens the site's embedded player rather than failing direct MPD extraction");
  assert.equal(adultFrame.src, 'https://www.pornflip.com/embed/adult-test-123');
  assert.equal(sandbox.WTUtil.parseWatchUrl(adultFrame.src).kind, 'embed',
    'the generated player URL can also be embedded by the room player');
  assert.equal(byId.get('playVideo').hidden, true, 'the DASH page is not assigned to an HTML video element');
  assert.equal(byId.get('playSource').hidden, false, 'the original PornFlip page remains available as a fallback');
  assert.equal(calls.some(url => String(url).includes('/api/resolve')), false,
    'PornFlip playback does not request an unsupported single-file extraction');
  byId.get('playClose').dispatch('click', {});

  const adultQuery = 'private-adult-query';
  input.value = adultQuery;
  byId.get('searchForm').dispatch('submit', { preventDefault() { } });
  await wait(25);
  assert.ok(calls.some(url => url.searchParams.get('site') === 'pornflip' && url.searchParams.get('q') === adultQuery),
    'confirmed users can search PornFlip');
  assert.equal((store['wt:search:recent'] || []).includes(adultQuery), false,
    'adult search terms are not written to shared search history');

  // ePorner uses the documented v2 API, its returned embed URL, and a guarded tool for the remaining operations.
  click(byId.get('searchSources'), '[data-site="eporner"]');
  await wait(25);
  const epornerSearch = calls.find(url => url.pathname === '/api/eporner/video/search/');
  assert.ok(epornerSearch, 'ePorner search calls the documented video/search operation');
  assert.equal(epornerSearch.searchParams.get('adult_confirmed'), '1', 'ePorner API requests carry the server-side age attestation');
  assert.equal(epornerSearch.searchParams.get('query'), adultQuery, 'ePorner receives the entered query');
  assert.equal(byId.get('epornerTools').hidden, false, 'the remaining ePorner operations become visible after age confirmation');
  assert.match(byId.get('searchStatus').textContent, /ePorner API v2/);
  assert.equal(byId.get('browseMore').hidden, false, 'ePorner search exposes another page when total_pages requires it');
  byId.get('browseLoadMore').dispatch('click', {});
  await wait(25);
  assert.ok(calls.some(url => url.pathname === '/api/eporner/video/search/' && url.searchParams.get('page') === '2'),
    'ePorner pagination requests the next documented page number');
  assert.match(byId.get('results').innerHTML, /نتيجة ePorner للصفحة التالية/);
  assert.match(byId.get('results').innerHTML, /static-ca-cdn\.eporner\.com\/thumbs\/sample\.jpg/);
  assert.doesNotMatch(byId.get('results').innerHTML, /data-favorite-index/, 'ePorner results are not added to favorites');
  click(byId.get('results'), '[data-index="0"]');
  await wait(10);
  const epornerFrame = byId.get('playStage').querySelector('.play-frame');
  assert.ok(epornerFrame, 'ePorner results open in an embedded player');
  assert.equal(epornerFrame.src, epornerVideo.embed, 'playback uses the API-provided safe embed URL');
  assert.equal(sandbox.WTUtil.parseWatchUrl(epornerFrame.src).provider, 'ePorner', 'the room recognizes the embed as ePorner');
  assert.equal(byId.get('playVideo').hidden, true, 'the embedded player is not assigned to an HTML video element');
  assert.equal(calls.some(url => String(url).includes('/api/resolve')), false, 'ePorner playback uses its documented embed rather than yt-dlp');
  byId.get('playClose').dispatch('click', {});

  byId.get('epornerOperation').value = 'categories';
  byId.get('epornerOperation').dispatch('change', {});
  assert.match(byId.get('epornerParams').value, /^\{\s*\}$/);
  byId.get('epornerRunOperation').dispatch('click', {});
  await wait(20);
  assert.ok(calls.some(url => url.pathname === '/api/eporner/categories/' && url.searchParams.get('adult_confirmed') === '1'),
    'the ePorner operation UI can execute GET /categories/ after confirmation');
  assert.match(byId.get('epornerOutput').textContent, /categories/);
  assert.equal((store['wt:search:recent'] || []).includes(adultQuery), false,
    'ePorner search terms are not written to shared search history');

  // A direct ePorner URL also remains gated; cancelling restores a safe source and hides old adult favorites.
  const guardedEnv = createRoomEnv({ search: '?site=eporner&q=must-not-send', scripts: [] });
  const guardedCalls = [];
  guardedEnv.sandbox.fetch = async input => { guardedCalls.push(input); throw new Error('adult request should remain blocked'); };
  guardedEnv.sandbox.WTFavorites = {
    identity: item => String(item.site || 'external') + ':video:' + String(item.id || item.url),
    list: async () => [{ type: 'video', site: 'external', id: 'legacy-pf', title: 'مفضّلة قديمة',
      url: 'https://www.pornflip.com/v/legacy-pf', thumb: 'https://www.pornflip.com/thumbs/legacy-pf.jpg' }],
    toggle: async item => ({ saved: true, item })
  };
  prepareSearchDom(guardedEnv);
  loadSearchScripts(guardedEnv);
  await wait(10);
  assert.notEqual(guardedEnv.byId.get('adultGate').getAttribute('open'), null,
    'an ePorner deep link asks for confirmation before sending its query');
  assert.equal(guardedCalls.length, 0, 'deep-link query is not fetched before confirmation');
  assert.equal(guardedEnv.byId.get('epornerTools').hidden, true, 'ePorner API tools stay hidden before confirmation');
  guardedEnv.byId.get('adultGateCancel').dispatch('click', {});
  assert.equal(guardedCalls.length, 0, 'cancelling leaves the server untouched');
  assert.equal(guardedEnv.byId.get('adultGate').getAttribute('open'), null, 'cancel closes the gate');
  assert.equal(guardedEnv.byId.get('searchSources').querySelector('[data-site="dailymotion"]').classList.contains('is-active'), true,
    'cancel restores the previous non-adult source');
  click(guardedEnv.byId.get('searchTypes'), '[data-search-view="favorites"]');
  await wait(15);
  assert.match(guardedEnv.byId.get('emptyText').textContent, /مخفية حتى تأكيد 18\+/,
    'saved PornFlip links stay hidden from favorites without confirmation');
  assert.doesNotMatch(guardedEnv.byId.get('results').innerHTML, /pornflip|legacy-pf/i,
    'unconfirmed adult favorites do not render links or thumbnails');
  guardedEnv.dispose();

  const javaSearch = fs.readFileSync(new URL('../../java-server/src/com/watchtogether/SearchResolver.java', import.meta.url), 'utf8');
  assert.match(javaSearch, /pornflip && !"1"\.equals\(query\.get\("adult_confirmed"\)\)/,
    'Java API also requires explicit adult confirmation before fetching results');
  assert.ok(javaSearch.includes('items = viaPornFlipSearch(term, limit);'),
    'PornFlip search uses its HTML listing parser instead of treating a search page as a video');
  assert.ok(javaSearch.includes('item.put("url", PF_BASE + "/v/" + id);'),
    'PornFlip results use a video URL path supported by yt-dlp');
  assert.match(javaSearch, /PF_VIDEO_CARD = Pattern\.compile/,
    'the Java server parses result cards from the PornFlip search page');
  const cardDeclaration = javaSearch.match(/PF_VIDEO_CARD\s*=\s*Pattern\.compile\(\s*([\s\S]*?),\s*Pattern\.CASE_INSENSITIVE/);
  assert.ok(cardDeclaration, 'PornFlip result-card pattern is declared');
  const cardPattern = new RegExp([...cardDeclaration[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map(([, value]) => JSON.parse('"' + value + '"')).join(''), 'is');
  const sampleCard = '<div class="card thumbs_rotate itemVideo"><a href="/dzv9Mtw1qj2/sv/sample-title">' +
    '<img class="card-img-top" src="/thumbs/sample.jpg" alt="Fallback"></a><span class="duration">7:56</span>' +
    '<h5 class="card-title"><a href="/dzv9Mtw1qj2/sv/sample-title">Title &amp; More</a></h5></div>';
  const parsedCard = cardPattern.exec(sampleCard);
  assert.ok(parsedCard, 'PornFlip result-card parser recognizes the current card markup');
  assert.equal(parsedCard[1], '/dzv9Mtw1qj2/sv/sample-title');
  assert.equal(parsedCard[2], '/thumbs/sample.jpg');
  assert.equal(parsedCard[4], '7:56');
  assert.equal(parsedCard[5], 'Title &amp; More');
  assert.doesNotMatch(javaSearch, /PF_WATCH/,
    'search results do not construct the invalid /video/ID URL');
  console.log('Search features passed (YouTube browsing/favorites, PornFlip and ePorner search/playback, API tools, 18+ gating, privacy and server contract)');
} finally {
  env.dispose();
}

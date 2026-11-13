/* =========================================================
   WatchTogether — عناوين وصور مصغّرة ثابتة للوسائط.
   لا ينشئ مشغّلاً ولا يبدأ تشغيل فيديو صامت.
   ========================================================= */
(function (global) {
  'use strict';

  const cache = new Map();
  const pending = new Map();
  const MAX_CACHE = 250;
  const VALID_YT_ID = /^[A-Za-z0-9_-]{11}$/;

  function validHttp(raw, httpsOnly) {
    try {
      const url = new URL(String(raw || '').trim());
      if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) || url.username || url.password) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function urlKey(raw) {
    const text = String(raw || '');
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b ^ (code + i), 0x85ebca6b);
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
  }

  function youtubeLink(raw) {
    try {
      const url = new URL(String(raw || '').trim());
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      let id = '';
      if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
      else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
        if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
        else if (/^\/(?:shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2] || '';
      }
      if (!VALID_YT_ID.test(id)) return null;
      return { id, url: 'https://www.youtube.com/watch?v=' + id, thumbnail: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' };
    } catch (_) { return null; }
  }

  function dailymotionLink(raw) {
    try {
      const url = new URL(String(raw || '').trim());
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (!['dailymotion.com', 'm.dailymotion.com', 'dai.ly'].includes(host)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      const id = host === 'dai.ly' ? parts[0] : (parts[0] === 'video' ? parts[1] : '');
      if (!/^[A-Za-z0-9]{1,32}$/.test(id || '')) return null;
      return { id, url: 'https://www.dailymotion.com/video/' + id, thumbnail: 'https://www.dailymotion.com/thumbnail/video/' + id };
    } catch (_) { return null; }
  }

  function readCache(key) {
    const fresh = cache.get(key);
    if (fresh && Date.now() - fresh.at < 6 * 60 * 60 * 1000) return fresh.value;
    try {
      const saved = JSON.parse(global.localStorage.getItem('wt:media-meta:' + key) || 'null');
      if (saved && saved.value && Date.now() - saved.at < 6 * 60 * 60 * 1000) {
        cache.set(key, saved);
        return saved.value;
      }
    } catch (_) { /* no local cache */ }
    return null;
  }

  function storeCache(key, value) {
    const entry = { at: Date.now(), value };
    cache.set(key, entry);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    try { global.localStorage.setItem('wt:media-meta:' + key, JSON.stringify(entry)); } catch (_) { /* private mode/quota */ }
  }

  function parseOembed(raw) {
    const title = String(raw && raw.title || '').replace(/\s+/g, ' ').trim();
    const author = String(raw && raw.author_name || '').replace(/\s+/g, ' ').trim();
    const thumbnail = validHttp(raw && raw.thumbnail_url, true);
    const channelUrl = validHttp(raw && raw.author_url, true);
    return {
      title: title.slice(0, 240), author: author.slice(0, 140), thumbnail,
      channelUrl: channelUrl && /^https:\/\/(?:www\.)?youtube\.com\//i.test(channelUrl) ? channelUrl : ''
    };
  }

  async function fetchOembed(id, options) {
    const fetcher = options && options.fetch || global.fetch;
    if (typeof fetcher !== 'function') return null;
    const endpoint = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(1000, Math.min(Number(options && options.timeout) || 7000, 12000));
    const timer = controller ? global.setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetcher(endpoint, { signal: controller && controller.signal, cache: 'no-store' });
      if (!response || !response.ok) return null;
      const value = parseOembed(await response.json());
      return value.title ? value : null;
    } catch (_) { return null; }
    finally { if (timer) global.clearTimeout(timer); }
  }

  function video(id, options) {
    id = String(id || '').trim();
    if (!VALID_YT_ID.test(id)) return Promise.resolve(null);
    const key = 'youtube:' + id;
    const cached = readCache(key);
    if (cached && cached.title) return Promise.resolve(cached);
    if (pending.has(key)) return pending.get(key);
    const task = fetchOembed(id, options || {}).then(value => {
      if (!value) return null;
      const result = Object.assign({ id, site: 'youtube', type: 'video', url: 'https://www.youtube.com/watch?v=' + id,
        thumbnail: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' }, value);
      if (!result.thumbnail) result.thumbnail = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
      storeCache(key, result);
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  function localInfo(raw) {
    const url = validHttp(raw, false);
    if (!url) return null;
    const yt = youtubeLink(url);
    if (yt) return { id: yt.id, url: yt.url, thumbnail: yt.thumbnail, site: 'youtube', type: 'video' };
    const dm = dailymotionLink(url);
    if (dm) return { id: dm.id, url: dm.url, thumbnail: dm.thumbnail, site: 'dailymotion', type: 'video' };
    return { id: 'url-' + urlKey(url), url, thumbnail: '', site: 'external', type: 'video' };
  }

  async function fetchServerMetadata(url, options) {
    const fetcher = options && options.fetch || global.fetch;
    if (typeof fetcher !== 'function') return null;
    const endpoint = global.WTServer && typeof global.WTServer.api === 'function'
      ? global.WTServer.api('api/suggest') : 'api/suggest';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = Math.max(1500, Math.min(Number(options && options.timeout) || 12000, 20000));
    const timer = controller ? global.setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetcher(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, metadataOnly: true }), signal: controller && controller.signal, cache: 'no-store'
      });
      if (!response || !response.ok) return null;
      const data = await response.json();
      const raw = data && data.metadata;
      if (!raw || typeof raw !== 'object') return null;
      return {
        title: String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        author: String(raw.author || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        thumbnail: validHttp(raw.thumbnail || raw.thumb, true),
        url: validHttp(raw.url, false) || url,
        id: String(raw.id || '').slice(0, 160)
      };
    } catch (_) { return null; }
    finally { if (timer) global.clearTimeout(timer); }
  }

  async function describe(raw, options) {
    options = options || {};
    const base = localInfo(raw);
    if (!base) return null;
    const key = base.site + ':' + urlKey(base.url);
    const cached = readCache(key);
    if (cached && (cached.title || cached.thumbnail)) return Object.assign({}, base, cached);
    if (base.site === 'youtube') {
      const details = await video(base.id, options);
      return Object.assign({}, base, details || {}, { thumbnail: (details && details.thumbnail) || base.thumbnail });
    }
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const details = await fetchServerMetadata(base.url, options);
      const value = Object.assign({}, base, details || {}, { thumbnail: (details && details.thumbnail) || base.thumbnail });
      if (value.title || value.thumbnail) storeCache(key, value);
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  function thumbnail(raw) {
    const value = localInfo(raw);
    return value ? value.thumbnail : '';
  }

  global.WTMediaPreview = { video, describe, localInfo, youtubeLink, thumbnail };
})(typeof window !== 'undefined' ? window : globalThis);

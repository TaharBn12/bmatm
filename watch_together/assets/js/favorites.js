/* =========================================================
   WatchTogether — مفضّلة الفيديوهات الشخصية
   تُزامَن عبر Supabase مع الحساب نفسه؛ لا تدخل مطلقاً في قائمة الغرفة.
   ========================================================= */
(function (global) {
  'use strict';

  const TABLE = 'wt_video_favorites';
  const CACHE_MS = 30_000;
  const MAX_ITEMS = 500;
  const cache = new Map();
  const pendingLists = new Map();

  function configuration() {
    return (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};
  }

  async function account() {
    const auth = global.WTAuth;
    const session = auth && typeof auth.validSession === 'function' ? await auth.validSession() : null;
    if (!session || !session.access_token || !session.user || !session.user.id || session.user.guest) {
      throw new Error('سجّل الدخول لحفظ المفضّلة ومزامنتها مع حسابك');
    }
    const cfg = configuration();
    if (!cfg.url || !cfg.anonKey || cfg.ready === false) {
      throw new Error('خدمة المفضّلة غير مهيّأة — تحقّق من إعدادات Supabase');
    }
    return { id: String(session.user.id), token: session.access_token, cfg };
  }

  function siteFor(rawSite, rawUrl) {
    const site = String(rawSite || '').toLowerCase();
    if (site === 'youtube' || site === 'dailymotion') return site;
    try {
      const host = new URL(String(rawUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
      if (host === 'dailymotion.com' || host === 'dai.ly' || host.endsWith('.dailymotion.com')) return 'dailymotion';
    } catch (_) { /* external URL */ }
    return 'external';
  }

  function validUrl(raw, image) {
    const text = String(raw || '').trim();
    if (!text || text.length > (image ? 2048 : 2048)) return '';
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      if (image && url.protocol !== 'https:') return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function urlKey(url) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (let i = 0; i < url.length; i++) {
      const code = url.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b ^ (code + i), 0x85ebca6b);
    }
    return 'url-' + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = validUrl(raw.url, false);
    if (!url) return null;
    const site = siteFor(raw.site, url);
    let id = String(raw.id || '').trim().slice(0, 160);
    if (site === 'youtube') {
      const match = id.match(/^[A-Za-z0-9_-]{11}$/) ? id : url.match(/(?:[?&]v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/i);
      id = typeof match === 'string' ? match : (match && match[1]) || '';
      if (!id) return null;
    } else if (site === 'dailymotion') {
      const match = id.match(/^[A-Za-z0-9]{1,32}$/) ? id : url.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/i) || url.match(/dai\.ly\/([A-Za-z0-9]+)/i);
      id = typeof match === 'string' ? match : (match && match[1]) || '';
      if (!id) id = urlKey(url);
    } else {
      id = urlKey(url);
    }
    let title = String(raw.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!title) {
      try { title = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { title = 'فيديو'; }
    }
    return {
      type: 'video', site, id, url, title,
      author: String(raw.author || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
      thumbnail: validUrl(raw.thumbnail || raw.thumb || '', true),
      duration: Math.min(2147483647, Math.max(0, Math.floor(Number(raw.duration) || 0))),
      channelId: String(raw.channelId || raw.channel_id || '').trim().slice(0, 120),
      channelUrl: validUrl(raw.channelUrl || raw.channel_url || '', false),
      savedAt: Number(raw.savedAt) || Date.now()
    };
  }

  function identity(raw) {
    const item = normalize(raw);
    return item ? item.site + ':video:' + item.id : '';
  }

  function fromRow(row) {
    if (!row || typeof row !== 'object') return null;
    const item = normalize({
      type: row.content_type, site: row.site, id: row.item_id, url: row.url,
      title: row.title, author: row.author, thumbnail: row.thumbnail,
      duration: row.duration, channelId: row.channel_id, channelUrl: row.channel_url,
      savedAt: row.saved_at ? Date.parse(row.saved_at) : Date.now()
    });
    return item;
  }

  function copyItems(items) { return items.map(item => Object.assign({}, item)); }

  function replaceCache(userId, items) {
    const unique = new Map();
    (Array.isArray(items) ? items : []).forEach(raw => {
      const item = normalize(raw);
      const key = identity(item);
      if (key && !unique.has(key)) unique.set(key, item);
    });
    const value = Array.from(unique.values()).sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_ITEMS);
    cache.set(userId, { at: Date.now(), items: value });
    return value;
  }

  function cachedList() {
    const auth = global.WTAuth;
    const user = auth && typeof auth.accountUser === 'function' ? auth.accountUser() : null;
    const value = user && cache.get(String(user.id));
    return value ? copyItems(value.items) : [];
  }

  function hasCached(raw) {
    const key = identity(raw);
    return !!key && cachedList().some(item => identity(item) === key);
  }

  async function request(user, path, options) {
    const cfg = user.cfg;
    const headers = Object.assign({
      apikey: cfg.anonKey,
      Authorization: 'Bearer ' + user.token,
      Accept: 'application/json'
    }, options && options.headers || {});
    const requestOptions = Object.assign({ cache: 'no-store' }, options || {});
    requestOptions.headers = headers;
    const response = await global.fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/' + TABLE + path, requestOptions);
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) {
      const detail = data && (data.message || data.error_description || data.error || data.details);
      const error = new Error(response.status === 404
        ? 'جدول المفضّلة غير موجود — نفّذ docs/sql/12-video-favorites.sql في Supabase'
        : (detail || ('تعذّر الاتصال بالمفضّلة (HTTP ' + response.status + ')')));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function list(options) {
    options = options || {};
    const user = await account();
    const old = cache.get(user.id);
    if (!options.force && old && Date.now() - old.at < CACHE_MS) return copyItems(old.items);
    if (pendingLists.has(user.id)) return copyItems(await pendingLists.get(user.id));
    const query = '?select=site,content_type,item_id,url,title,author,thumbnail,duration,channel_id,channel_url,saved_at&order=saved_at.desc&limit=' + MAX_ITEMS;
    const task = request(user, query, { method: 'GET' }).then(rows => {
      const items = replaceCache(user.id, Array.isArray(rows) ? rows.map(fromRow).filter(Boolean) : []);
      return copyItems(items);
    }).finally(() => pendingLists.delete(user.id));
    pendingLists.set(user.id, task);
    return copyItems(await task);
  }

  async function save(raw) {
    const item = normalize(raw);
    if (!item) throw new Error('لا يمكن حفظ رابط الفيديو هذا في المفضّلة');
    const user = await account();
    const payload = {
      site: item.site, content_type: 'video', item_id: item.id,
      url: item.url, title: item.title, author: item.author,
      thumbnail: item.thumbnail || null, duration: item.duration,
      channel_id: item.channelId || null, channel_url: item.channelUrl || null
    };
    const conflict = 'user_id,site,content_type,item_id';
    const rows = await request(user, '?on_conflict=' + encodeURIComponent(conflict), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(payload)
    });
    const saved = fromRow(Array.isArray(rows) && rows[0] ? rows[0] : Object.assign({ saved_at: new Date().toISOString() }, payload));
    const previous = cache.get(user.id);
    replaceCache(user.id, [saved].concat(previous ? previous.items.filter(value => identity(value) !== identity(saved)) : []));
    return saved;
  }

  async function remove(raw) {
    const item = normalize(raw);
    if (!item) return false;
    const user = await account();
    const params = new URLSearchParams({
      site: 'eq.' + item.site, content_type: 'eq.video', item_id: 'eq.' + item.id
    });
    await request(user, '?' + params.toString(), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const previous = cache.get(user.id);
    if (previous) replaceCache(user.id, previous.items.filter(value => identity(value) !== identity(item)));
    return true;
  }

  async function toggle(raw) {
    const item = normalize(raw);
    if (!item) throw new Error('لا يمكن حفظ رابط الفيديو هذا في المفضّلة');
    const saved = (await list()).some(value => identity(value) === identity(item));
    if (saved) { await remove(item); return { saved: false, item }; }
    return { saved: !!(await save(item)), item };
  }

  function invalidate(userId) {
    if (userId) cache.delete(String(userId));
    else cache.clear();
  }

  global.WTFavorites = { list, save, remove, toggle, identity, cachedList, hasCached, invalidate, normalize };
})(typeof window !== 'undefined' ? window : globalThis);

/* Public room catalogue. Secrets stay in owner:<id>, never in cards or list responses. */
(function (global) {
  'use strict';
  const U = global.WTUtil;
  const config = () => global.WT_CONFIG || {};
  const LOCAL_KEY = 'local:rooms';
  const PRESENCE_TTL = 15000;
  const LOCAL_PRESENCE = 'wt:local:presence:';
  let backendPromise;

  function localMode() {
    if (new URLSearchParams(location.search).get('local') === '1') return true;
    try { return localStorage.getItem('wt:forceLocal') === '1'; } catch (_) { return false; }
  }

  function normalize(value, mode) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || value.room_id || '').toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(id)) return null;
    const title = String(value.title || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'غرفة ' + id;
    let videoUrl = '';
    try {
      const current = value.current_video_url != null ? value.current_video_url : (value.videoUrl || value.video_url || '');
      const url = new URL(current);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) videoUrl = url.href;
    } catch (_) { /* an empty room is valid */ }
    const date = value.createdAt || value.created_at;
    const createdAt = typeof date === 'number' ? date : Date.parse(date || '') || 0;
    const room = { id, title, videoUrl, createdAt, mode, participants: [], participantCount: null, presenceKnown: false };
    if (mode === 'java' && Array.isArray(value.participants)) {
      Object.assign(room, participantSnapshot(value.participants));
      if (Number.isSafeInteger(value.participantCount) && value.participantCount >= room.participantCount) room.participantCount = value.participantCount;
    }
    return room;
  }

  function normalizeList(rows, mode) {
    if (!Array.isArray(rows)) throw new Error('تعذّر قراءة قائمة الغرف');
    const unique = new Map();
    rows.forEach(value => {
      const room = normalize(value, mode);
      if (room && !unique.has(room.id)) unique.set(room.id, room);
    });
    return Array.from(unique.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }

  /* Only fresh, unique connections are people; saved role/history rows are not attendance. */
  function participantSnapshot(rows, requireTimestamp) {
    const unique = new Map(), now = Date.now();
    rows.forEach(value => {
      if (!value || typeof value !== 'object') return;
      const id = String(value.id || value.client_id || '').slice(0, 128);
      if (!id || unique.has(id)) return;
      const seen = value.last_seen || value.lastSeen;
      const at = typeof seen === 'number' ? seen : Date.parse(seen || '');
      if ((requireTimestamp || seen != null) && (!Number.isFinite(at) || now - at > PRESENCE_TTL || at - now > 60000)) return;
      const name = String(value.name || 'زائر').replace(/\s+/g, ' ').trim().slice(0, 30) || 'زائر';
      unique.set(id, { id, name });
    });
    const people = Array.from(unique.values()).sort((a, b) => a.id.localeCompare(b.id));
    return { participants: people.slice(0, 5), participantCount: people.length, presenceKnown: true };
  }

  function localSnapshots(rooms) {
    const byRoom = new Map(rooms.map(room => [room.id, []]));
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(LOCAL_PRESENCE)) continue;
        const rest = key.slice(LOCAL_PRESENCE.length), split = rest.indexOf(':');
        const people = byRoom.get(rest.slice(0, split));
        if (!people || split < 0) continue;
        let value;
        try { value = JSON.parse(localStorage.getItem(key)); } catch (_) { continue; }
        if (value && typeof value === 'object') people.push({ id: rest.slice(split + 1), name: value.name, lastSeen: value.lastSeen });
      }
      rooms.forEach(room => Object.assign(room, participantSnapshot(byRoom.get(room.id), true)));
    } catch (_) { /* Unavailable storage is not proof of zero people. */ }
    rooms.forEach(room => {
      const current = U.store.get('local:state:' + room.id, null);
      if (current && typeof current.url === 'string') room.videoUrl = normalize({ id: room.id, videoUrl: current.url }, 'local').videoUrl;
    });
  }

  async function supabaseSnapshots(target, rooms) {
    if (!rooms.length) return;
    const deadline = Date.now() + 3000, pageSize = 1000;
    const people = [], byRoom = new Map(rooms.map(room => [room.id, []]));
    for (let page = 0; page < 10; page++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('انتهت مهلة الحضور');
      const query = new URLSearchParams({
        select: 'room_id,client_id,name,last_seen', room_id: 'in.(' + rooms.map(room => room.id).join(',') + ')',
        last_seen: 'gte.' + new Date(Date.now() - PRESENCE_TTL).toISOString(),
        order: 'room_id.asc,client_id.asc', limit: String(pageSize), offset: String(people.length)
      });
      const result = await request(target.url + '/rest/v1/presence?' + query, {
        headers: Object.assign({}, target.headers, { Prefer: 'count=exact' })
      }, left, true);
      if (!Array.isArray(result.data)) throw new Error('حضور غير صالح');
      people.push(...result.data);
      const complete = result.total == null ? result.data.length < pageSize : people.length >= result.total;
      if (complete) {
        people.forEach(person => { if (person && byRoom.has(person.room_id)) byRoom.get(person.room_id).push(person); });
        rooms.forEach(room => Object.assign(room, participantSnapshot(byRoom.get(room.id), true)));
        return;
      }
      if (!result.data.length) break;
    }
    throw new Error('تعذّر تحميل الحضور كاملاً'); // Never show a truncated count as the real total.
  }

  function write(key, value) {
    try { localStorage.setItem('wt:' + key, JSON.stringify(value)); }
    catch (_) { throw new Error('تعذّر حفظ الغرفة في المتصفح'); }
  }

  async function request(url, options, timeoutMs, detailed) {
    const controller = global.AbortController ? new AbortController() : null;
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}, controller ? { signal: controller.signal } : {}));
          let data;
          try { data = await response.json(); } catch (_) { throw new Error('الخادم لا يدعم قائمة الغرف'); }
          if (!response.ok) {
            const error = new Error((data && (data.error || data.message)) || 'تعذّر الاتصال بالغرف');
            error.status = response.status;
            throw error;
          }
          if (!detailed) return data;
          const range = response.headers && response.headers.get('Content-Range');
          const total = range && /\/(\d+)$/.exec(range);
          return { data, total: total ? Number(total[1]) : null };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('انتهت مهلة الاتصال بالغرف — أعد المحاولة'));
            if (controller) controller.abort();
          }, timeoutMs || 7000);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  function javaEndpoint() {
    const custom = config().javaServer && config().javaServer.url;
    if (!custom) return 'api/rooms';
    const url = new URL(custom, location.href);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/api/rooms';
    url.search = ''; url.hash = '';
    return url.href;
  }

  async function detectBackend() {
    if (localMode()) return { mode: 'local' };
    const cfg = config();
    if (cfg.javaServer && cfg.javaServer.enabled) {
      try {
        const url = javaEndpoint();
        const data = await request(url, null, cfg.javaServer.timeoutMs || 2500);
        if (data && Array.isArray(data.rooms)) return { mode: 'java', url, initial: data.rooms };
      } catch (_) { /* Static hosting has no Java endpoint; use the configured Supabase. */ }
    }
    const sb = cfg.supabase;
    if (sb && sb.url && sb.anonKey && sb.ready !== false) {
      return {
        mode: 'supabase', url: sb.url.replace(/\/$/, ''),
        headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey, 'Content-Type': 'application/json' }
      };
    }
    return { mode: 'local' };
  }

  function backend() {
    if (!backendPromise) backendPromise = detectBackend().catch(error => { backendPromise = null; throw error; });
    return backendPromise;
  }

  async function list() {
    const target = await backend();
    let rows;
    if (target.mode === 'local') rows = U.store.get(LOCAL_KEY, []);
    else if (target.mode === 'java') {
      rows = target.initial || (await request(target.url)).rooms;
      target.initial = null;
    } else {
      /* Explicit public columns only; neither owner secrets nor member credentials are fetched. */
      rows = await request(target.url + '/rest/v1/rooms?select=room_id,title,video_url,created_at,current_video_url:state->>url&order=created_at.desc&limit=100', { headers: target.headers });
    }
    const rooms = normalizeList(rows, target.mode);
    if (target.mode === 'local') localSnapshots(rooms);
    else if (target.mode === 'supabase') {
      try { await supabaseSnapshots(target, rooms); } catch (_) { /* Keep the cards; mark presence unknown instead of inventing a zero. */ }
    }
    return { mode: target.mode, rooms };
  }

  async function create(input) {
    const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!title) throw new Error('أدخل اسم الغرفة');
    const target = await backend();
    let id = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = U.randomCode((config().room && config().room.codeLength) || 6);
      if (!U.store.get('owner:' + candidate, '')) { id = candidate; break; }
    }
    if (!id) throw new Error('تعذّر اختيار كود جديد — أعد المحاولة');
    const ownerToken = U.randomToken(32);
    const room = normalize({ id, title, videoUrl: input.videoUrl || '', createdAt: Date.now() }, target.mode);
    if (!room || (input.videoUrl && !room.videoUrl)) throw new Error('أدخل رابط فيديو صالحاً');
    Object.assign(room, { participants: [], participantCount: 0, presenceKnown: true });
    /* Save ownership before the network write: a lost response must not lose the room's key. */
    write('owner:' + id, ownerToken);
    if (target.mode === 'java') {
      await request(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id, title, videoUrl: room.videoUrl, hostName: input.hostName || '', ownerToken
      }) });
      target.initial = null;
    } else if (target.mode === 'supabase') {
      await request(target.url + '/rest/v1/rpc/wt_create_room', {
        method: 'POST', headers: target.headers, body: JSON.stringify({
          p_room_id: id, p_title: title, p_video_url: room.videoUrl || null,
          p_owner_token: ownerToken, p_owner_name: input.hostName || 'مضيف'
        })
      });
    } else {
      const previous = U.store.get(LOCAL_KEY, []);
      write(LOCAL_KEY, [room].concat(Array.isArray(previous) ? previous.filter(item => item.id !== id) : []).slice(0, 100));
      if (room.videoUrl) write('local:state:' + id, { url: room.videoUrl, kind: '', playing: false, pos: 0, t: Date.now(), rev: 0 });
    }
    U.store.set('roomTitle:' + id, title);
    try {
      sessionStorage.setItem('wt:create:' + id, JSON.stringify({ title, videoUrl: room.videoUrl, host: true, ownerToken, at: room.createdAt }));
    } catch (_) { /* The backend has already registered ownership; no tab-only data is required to join. */ }
    return room;
  }

  function href(room) {
    const query = new URLSearchParams({ id: room.id });
    if (room.mode === 'local') query.set('local', '1');
    return 'room.html?' + query.toString();
  }

  global.WTRooms = { list, create, href, normalize, localMode };
})(window);

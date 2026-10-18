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
    const controlMode = value.controlMode === 'everyone' || value.control_mode === 'everyone' ? 'everyone' : 'owner';
    const isPrivate = value.isPrivate === true || value.is_private === true;
    const queueCount = Number.isSafeInteger(value.queueCount) ? value.queueCount : Number.isSafeInteger(value.queue_count) ? value.queue_count : null;
    const room = { id, title, videoUrl, createdAt, mode, isPrivate, controlMode, queueCount, isOwner: false,
      participants: [], participantCount: null, presenceKnown: false };
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

  async function authenticatedHeaders(target) {
    const session = global.WTAuth && typeof global.WTAuth.validSession === 'function'
      ? await global.WTAuth.validSession() : null;
    if (session && session.access_token && session.user && session.user.id && !session.user.guest) {
      return Object.assign({}, target.headers, { Authorization: 'Bearer ' + session.access_token });
    }
    if (config().auth && config().auth.required) throw new Error('سجّل الدخول لمتابعة هذا الإجراء');
    return target.headers;
  }

  function ownerEntries() {
    const entries = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('wt:owner:')) continue;
        const id = key.slice('wt:owner:'.length).toUpperCase();
        let token = '';
        try { token = JSON.parse(localStorage.getItem(key)); } catch (_) { token = ''; }
        if (/^[A-Z0-9]{4,12}$/.test(id) && typeof token === 'string' && /^[a-f0-9]{48,256}$/i.test(token)) entries.push({ id, token });
      }
    } catch (_) { /* storage may be disabled */ }
    return entries;
  }

  function ownerToken(id) { return U.store.get('owner:' + String(id || '').toUpperCase(), '') || ''; }

  async function ownerRoom(target, entry) {
    if (target.mode === 'java') {
      const query = new URLSearchParams({ room: entry.id, ownerToken: entry.token });
      const data = await request(target.url + '?' + query.toString());
      return data && data.room;
    }
    if (target.mode === 'supabase') {
      return request(target.url + '/rest/v1/rpc/wt_get_owned_room', {
        method: 'POST', headers: await authenticatedHeaders(target),
        body: JSON.stringify({ p_room_id: entry.id, p_owner_token: entry.token })
      });
    }
    return null;
  }

  async function list() {
    const target = await backend();
    const owners = ownerEntries();
    let rows;
    if (target.mode === 'local') rows = U.store.get(LOCAL_KEY, []);
    else if (target.mode === 'java') {
      rows = target.initial || (await request(target.url)).rooms;
      target.initial = null;
    } else {
      /* Owner tokens never enter a public catalogue query; only public rooms are listed. */
      const query = '/rest/v1/rooms?select=room_id,title,video_url,created_at,current_video_url:state->>url,is_private,control_mode&is_private=eq.false&order=created_at.desc&limit=100';
      try { rows = await request(target.url + query, { headers: target.headers }); }
      catch (error) {
        /* Older schema deployments remain browsable until the management migration is applied. */
        if (error.status !== 400 && error.status !== 404) throw error;
        rows = await request(target.url + '/rest/v1/rooms?select=room_id,title,video_url,created_at,current_video_url:state->>url&order=created_at.desc&limit=100', { headers: target.headers });
      }
    }
    const byId = new Map(owners.map(entry => [entry.id, entry.token]));
    const rooms = normalizeList(rows, target.mode);
    rooms.forEach(room => { room.isOwner = byId.has(room.id); });

    /* Private rooms are never part of the public catalogue. An owner can recover only rooms
       for which this browser already holds the local, high-entropy owner key. */
    if (target.mode !== 'local' && owners.length) {
      const owned = await Promise.all(owners.slice(0, 100).map(async entry => {
        if (rooms.some(room => room.id === entry.id)) return null;
        try { return await ownerRoom(target, entry); } catch (_) { return null; }
      }));
      owned.forEach(value => {
        const room = normalize(value, target.mode);
        if (room && !rooms.some(item => item.id === room.id)) {
          room.isOwner = true;
          rooms.push(room);
        }
      });
      rooms.sort((a, b) => b.createdAt - a.createdAt);
    }
    const visible = rooms.filter(room => !room.isPrivate || room.isOwner).slice(0, 100);
    if (target.mode === 'local') localSnapshots(visible);
    else if (target.mode === 'supabase') {
      try { await supabaseSnapshots(target, visible); } catch (_) { /* Keep the cards; mark presence unknown instead of inventing a zero. */ }
    }
    return { mode: target.mode, rooms: visible };
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
    Object.assign(room, { participants: [], participantCount: 0, presenceKnown: true, isOwner: true, isPrivate: false, controlMode: 'owner', queueCount: 0 });
    /* Save ownership before the network write: a lost response must not lose the room's key. */
    write('owner:' + id, ownerToken);
    if (target.mode === 'java') {
      await request(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        id, title, videoUrl: room.videoUrl, hostName: input.hostName || '', ownerToken
      }) });
      target.initial = null;
    } else if (target.mode === 'supabase') {
      await request(target.url + '/rest/v1/rpc/wt_create_room', {
        method: 'POST', headers: await authenticatedHeaders(target), body: JSON.stringify({
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

  async function management(id) {
    id = String(id || '').toUpperCase();
    const token = ownerToken(id);
    if (!token) throw new Error('مفتاح المنشئ غير موجود في هذا المتصفح');
    const target = await backend();
    if (target.mode === 'local') {
      const room = (U.store.get(LOCAL_KEY, []) || []).find(item => item.id === id);
      if (!room) throw new Error('الغرفة غير موجودة');
      const queue = U.store.get('local:queue:' + id, []);
      return Object.assign({}, normalize(room, 'local'), { queueCount: Array.isArray(queue) ? queue.length : 0 });
    }
    if (target.mode === 'java') {
      const query = new URLSearchParams({ room: id, ownerToken: token });
      const data = await request(target.url + '?' + query.toString());
      return normalize(data && data.room, 'java');
    }
    const data = await request(target.url + '/rest/v1/rpc/wt_room_management', {
      method: 'POST', headers: await authenticatedHeaders(target),
      body: JSON.stringify({ p_room_id: id, p_owner_token: token })
    });
    const room = normalize(data, 'supabase');
    if (!room) throw new Error('تعذّر قراءة إعدادات الغرفة');
    return room;
  }

  async function update(id, changes) {
    id = String(id || '').toUpperCase();
    const token = ownerToken(id);
    if (!token) throw new Error('مفتاح المنشئ غير موجود في هذا المتصفح');
    changes = changes || {};
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
      payload.title = String(changes.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!payload.title) throw new Error('أدخل اسم الغرفة');
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'videoUrl')) {
      const raw = String(changes.videoUrl || '').trim();
      if (raw) {
        let url;
        try { url = new URL(raw); } catch (_) { throw new Error('رابط المشاهدة غير صالح'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw new Error('رابط المشاهدة غير صالح');
        payload.videoUrl = url.href;
      } else payload.videoUrl = '';
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'isPrivate')) payload.isPrivate = !!changes.isPrivate;
    if (Object.prototype.hasOwnProperty.call(changes, 'controlMode')) {
      if (!['owner', 'everyone'].includes(changes.controlMode)) throw new Error('إعداد التحكم غير صالح');
      payload.controlMode = changes.controlMode;
    }

    const target = await backend();
    if (target.mode === 'java') {
      await request(target.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        roomId: id, ownerToken: token, ...payload
      }) });
    } else if (target.mode === 'supabase') {
      await request(target.url + '/rest/v1/rpc/wt_update_room', {
        method: 'POST', headers: await authenticatedHeaders(target), body: JSON.stringify({
          p_room_id: id, p_owner_token: token,
          p_title: Object.prototype.hasOwnProperty.call(payload, 'title') ? payload.title : null,
          p_video_url: Object.prototype.hasOwnProperty.call(payload, 'videoUrl') ? payload.videoUrl : null,
          p_is_private: Object.prototype.hasOwnProperty.call(payload, 'isPrivate') ? payload.isPrivate : null,
          p_control_mode: Object.prototype.hasOwnProperty.call(payload, 'controlMode') ? payload.controlMode : null
        })
      });
    } else {
      if (Object.prototype.hasOwnProperty.call(payload, 'videoUrl')) {
        const queue = U.store.get('local:queue:' + id, []);
        if (Array.isArray(queue) && queue.length) throw new Error('أفرغ قائمة التشغيل قبل تغيير رابط المشاهدة');
      }
      const rooms = U.store.get(LOCAL_KEY, []);
      const index = Array.isArray(rooms) ? rooms.findIndex(room => room.id === id) : -1;
      if (index < 0) throw new Error('الغرفة غير موجودة');
      Object.assign(rooms[index], {
        ...(Object.prototype.hasOwnProperty.call(payload, 'title') ? { title: payload.title } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'videoUrl') ? { videoUrl: payload.videoUrl } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'isPrivate') ? { isPrivate: payload.isPrivate } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'controlMode') ? { controlMode: payload.controlMode } : {})
      });
      write(LOCAL_KEY, rooms);
      if (Object.prototype.hasOwnProperty.call(payload, 'videoUrl')) {
        write('local:state:' + id, { url: payload.videoUrl, kind: '', playing: false, pos: 0, t: Date.now(), rev: Date.now() });
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'title')) U.store.set('roomTitle:' + id, payload.title);
    return true;
  }

  async function remove(id) {
    id = String(id || '').toUpperCase();
    const token = ownerToken(id);
    if (!token) throw new Error('مفتاح المنشئ غير موجود في هذا المتصفح');
    const target = await backend();
    if (target.mode === 'java') {
      await request(target.url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: id, ownerToken: token }) });
    } else if (target.mode === 'supabase') {
      await request(target.url + '/rest/v1/rpc/wt_delete_room', {
        method: 'POST', headers: await authenticatedHeaders(target), body: JSON.stringify({ p_room_id: id, p_owner_token: token })
      });
    } else {
      write(LOCAL_KEY, (U.store.get(LOCAL_KEY, []) || []).filter(room => room.id !== id));
      U.store.del('local:state:' + id);
      U.store.del('local:msgs:' + id);
      U.store.del('local:queue:' + id);
      U.store.del('local:roles:' + id);
      U.store.del('local:bus:' + id);
      const reports = U.store.get('local:reports', []);
      write('local:reports', Array.isArray(reports) ? reports.filter(report => report && report.roomId !== id) : []);
      try {
        const prefix = 'wt:local:presence:' + id + ':';
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith(prefix)) localStorage.removeItem(key);
        }
      } catch (_) { /* storage cleanup is best-effort */ }
    }
    try { sessionStorage.removeItem('wt:create:' + id); } catch (_) { }
    U.store.del('owner:' + id);
    U.store.del('roomTitle:' + id);
    return true;
  }

  async function report(id, reporterId, reason, details) {
    id = String(id || '').toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(id)) throw new Error('رمز الغرفة غير صالح');
    if (!/^[a-f0-9-]{36}$/i.test(String(reporterId || ''))) throw new Error('سجّل الدخول للإبلاغ عن الغرفة');
    const allowed = ['spam', 'inappropriate', 'illegal', 'other'];
    if (!allowed.includes(reason)) throw new Error('سبب البلاغ غير صالح');
    details = String(details || '').trim().slice(0, 500);
    const target = await backend();
    if (target.mode === 'java') {
      const url = new URL(target.url, location.href);
      url.pathname = url.pathname.replace(/\/api\/rooms\/?$/, '/api/rooms/report');
      url.search = ''; url.hash = '';
      await request(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        roomId: id, reporterId, reason, details
      }) });
    } else if (target.mode === 'supabase') {
      const session = global.WTAuth && await global.WTAuth.validSession();
      if (!session || !session.access_token || !session.user || session.user.id !== reporterId || session.user.guest) throw new Error('سجّل الدخول للإبلاغ عن الغرفة');
      const headers = await authenticatedHeaders(target);
      await request(target.url + '/rest/v1/rpc/wt_report_room', {
        method: 'POST', headers, body: JSON.stringify({ p_room_id: id, p_reason: reason, p_details: details })
      });
    } else {
      const reports = U.store.get('local:reports', []);
      const next = Array.isArray(reports) ? reports.filter(item => !(item.roomId === id && item.reporterId === reporterId)) : [];
      next.push({ roomId: id, reporterId, reason, details, createdAt: Date.now() });
      write('local:reports', next.slice(-500));
    }
    return true;
  }

  function href(room) {
    const query = new URLSearchParams({ id: room.id });
    if (room.mode === 'local') query.set('local', '1');
    return 'room.html?' + query.toString();
  }

  global.WTRooms = { list, create, href, normalize, localMode, management, update, remove, report, ownerToken };
})(window);

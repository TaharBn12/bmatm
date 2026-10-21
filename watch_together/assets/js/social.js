/* Authenticated community API. No demo users, public message tables, service keys or fake success. */
(function (global) {
  'use strict';
  const U = global.WTUtil, Auth = global.WTAuth;
  const dict = values => Object.freeze(Object.assign(Object.create(null),values));
  const GENRES = dict({ scifi: 'خيال علمي', drama: 'دراما', comedy: 'كوميديا', thriller: 'إثارة', animation: 'رسوم متحركة', documentary: 'وثائقي', fantasy: 'فانتازيا', adventure: 'مغامرة', romance: 'رومانسي', mystery: 'غموض', anime: 'أنمي', shorts: 'أفلام قصيرة' });
  const MOODS = dict({ none: 'على مهل', open: 'مستعد لسهرة', quiet: 'مزاج هادئ', busy: 'مشغول الآن' });
  const ACCENTS = dict({ mint: '#c5a572', violet: '#c9b7ff', amber: '#f4ce91', rose: '#f4b8c9' });
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let bootPromise, me;
  const cfg = () => (global.WT_CONFIG && global.WT_CONFIG.supabase) || {};
  function safeURL(raw) {
    if (!raw) return '';
    try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; }
  }
  function avatarURL(profile) {
    if (!profile || !UUID.test(profile.user_id || '')) return '';
    const path = String(profile.avatar_path || '');
    if (!new RegExp('^' + profile.user_id + '/[a-f0-9]{48}\\.webp$').test(path)) return '';
    const base = safeURL(cfg().url);
    return base ? base.replace(/\/$/, '') + '/storage/v1/object/public/wt-avatars/' + path : '';
  }
  function failure(data, status) {
    const code = data && (data.code || data.errorCode);
    let message = String((data && (data.message || data.msg || data.error)) || '');
    const setup = status === 404 || ['PGRST202', '42P01', '42883'].includes(code);
    if (setup) message = 'الميزات الاجتماعية غير مفعّلة على الخادم. نفّذ docs/sql/07-social.sql ثم أعد المحاولة.';
    else if (status === 401) message = 'انتهت جلسة الحساب. سجّل الدخول مجددًا.';
    else if (code === '23505') message = 'المعرّف مستخدم بالفعل؛ اختر معرّفًا آخر.';
    else if (!/[\u0600-\u06ff]/.test(message)) message = status === 403 ? 'لا يُسمح بهذا الإجراء. تحقّق من الصداقة والخصوصية.' : 'تعذّر تنفيذ الطلب. تحقّق من الاتصال ثم أعد المحاولة.';
    return Object.assign(new Error(message), { status, code, setup, signIn: status === 401 });
  }
  async function session() {
    const s = await Auth.validSession();
    if (!s || !s.access_token || !s.user || s.user.guest || !UUID.test(s.user.id || '')) throw Object.assign(new Error('هذه المساحة لأصحاب الحسابات. سجّل الدخول للمتابعة.'), { signIn: true });
    if (!cfg().url || !cfg().anonKey || !Auth.enabled()) throw failure({}, 404);
    return s;
  }
  async function request(path, options) {
    options = options || {};
    const s = await session();
    const controller = new AbortController();
    const signal = options.signal;
    let timer, onAbort;
    try {
      return await Promise.race([
        (async () => {
          if (signal && signal.aborted) throw Object.assign(new Error('أُلغي الطلب'), { name: 'AbortError' });
          const headers = Object.assign({ apikey: cfg().anonKey, Authorization: 'Bearer ' + s.access_token }, options.headers || {});
          if (!options.binary) headers['Content-Type'] = 'application/json';
          const response = await fetch(cfg().url.replace(/\/$/, '') + path, {
            method: options.method || 'POST', headers, cache: 'no-store', signal: controller.signal,
            /* keepalive: يجعل طلب «إنهاء المكالمة» يصل حتّى عند إغلاق الصفحة */
            keepalive: !!options.keepalive,
            body: options.body == null ? undefined : options.binary ? options.body : JSON.stringify(options.body)
          });
          let data = null;
          try { data = await response.json(); } catch (_) { if (response.ok && response.status !== 204) throw new Error('تعذّر قراءة استجابة الخادم'); }
          if ((Auth.accountUser() || {}).id !== s.user.id) throw Object.assign(new Error('تغيّر الحساب؛ أعد فتح الصفحة.'), { signIn: true });
          if (!response.ok) throw failure(data, response.status);
          return data;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new Error('انتهت مهلة الاتصال. مسودتك باقية؛ حاول مجددًا.')); controller.abort(); }, 8500);
          if (signal) {
            onAbort = () => { reject(Object.assign(new Error('أُلغي الطلب'), { name: 'AbortError' })); controller.abort(); };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }
        })
      ]);
    } catch (error) {
      if (error.name === 'AbortError' || error.setup || error.signIn || /[\u0600-\u06ff]/.test(error.message || '')) throw error;
      throw new Error('تعذّر الاتصال بالخادم. تحقّق من الشبكة ثم أعد المحاولة.');
    } finally { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
  }
  const METHODS = new Set(['bootstrap','profile','save_profile','search','friends','friend_action','open_thread','threads','messages','send','edit_message','mark_read','typing',
    'calls_pref','call_start','call_answer','call_end','call_state','call_signal_put','call_signal_get','call_incoming',
    'call_current','call_reset']);
  function call(method, args, signal, extra) {
    if (!METHODS.has(method)) return Promise.reject(new Error('طلب غير مدعوم'));
    return request('/rest/v1/rpc/wt_social_' + method, Object.assign({ body: args || {}, signal }, extra || {}));
  }
  function remember(profile) {
    if (!profile || !UUID.test(profile.user_id || '') || profile.user_id !== (Auth.accountUser() || {}).id) throw new Error('استجابة حساب غير صالحة');
    me = profile;
    if (Auth.cacheProfile) Auth.cacheProfile(profile);
    global.dispatchEvent(new CustomEvent('wt:profile', { detail: profile }));
    return profile;
  }
  function bootstrap(force) {
    if (!bootPromise || force) bootPromise = call('bootstrap').then(data => {
      if (!data || !data.profile || !data.counts) throw new Error('استجابة غير صالحة');
      remember(data.profile); return data;
    }).catch(error => { bootPromise = null; throw error; });
    return bootPromise;
  }
  async function saveProfile(patch) { return remember(await call('save_profile', { p_patch: patch })); }
  function ownPath(path, id) { return new RegExp('^' + id + '/[a-f0-9]{48}\\.webp$').test(path || ''); }
  async function deleteImage(path) {
    const s = await session();
    if (!ownPath(path, s.user.id)) return;
    await request('/storage/v1/object/wt-avatars', { method: 'DELETE', body: { prefixes: [path] } });
  }
  async function uploadAvatar(blob) {
    if (!blob || blob.type !== 'image/webp' || blob.size > 262144 || blob.size < 12) throw new Error('الصورة النهائية يجب أن تكون WebP وأقل من 256 كيلوبايت.');
    const s = await session(), old = me && me.avatar_path;
    const path = s.user.id + '/' + U.randomToken(24) + '.webp';
    try {
      await request('/storage/v1/object/wt-avatars/' + path, { binary: true, body: blob, headers: { 'Content-Type': 'image/webp', 'x-upsert': 'false', 'cache-control': '3600' } });
    } catch (error) { await deleteImage(path).catch(() => {}); throw error; }
    let profile;
    try { profile = await saveProfile({ avatar_path: path }); }
    catch (error) { await deleteImage(path).catch(() => {}); throw error; }
    if (old && old !== path) await deleteImage(old).catch(() => {}); // Best-effort cleanup; RLS protects a current image.
    return profile;
  }
  async function removeAvatar() {
    const old = me && me.avatar_path, profile = await saveProfile({ avatar_path: null });
    if (old) await deleteImage(old).catch(() => {});
    return profile;
  }
  async function rooms() {
    const rows = await request('/rest/v1/rooms?select=room_id,title&order=created_at.desc&limit=30', { method: 'GET' });
    if (!Array.isArray(rows)) throw new Error('تعذّر تحميل الغرف');
    return rows.filter(r => /^[A-Z0-9]{4,12}$/.test(r.room_id || '')).map(r => ({ id: r.room_id, title: String(r.title || 'غرفة ' + r.room_id).slice(0, 40) }));
  }
  function validateProfile(input) {
    const p = Object.assign({}, input);
    p.display_name = String(p.display_name || '').replace(/\s+/g, ' ').trim();
    p.username = String(p.username || '').trim().toLowerCase();
    p.bio = String(p.bio || '').trim(); p.location = String(p.location || '').trim();
    if (p.display_name.length < 2 || p.display_name.length > 24) throw new Error('اسم العرض من حرفين إلى 24 حرفًا.');
    if (!/^[a-z0-9_]{3,24}$/.test(p.username)) throw new Error('المعرّف من 3 إلى 24 حرفًا لاتينيًا أو رقمًا أو _.');
    if (p.bio.length > 280 || p.location.length > 60) throw new Error('اختصر النبذة أو الموقع إلى الحد الموضّح.');
    const raw = String(p.website || '').trim();
    p.website = raw ? safeURL(raw) : '';
    if ((raw && !p.website) || p.website.length > 200) throw new Error('استخدم رابط http أو https صحيحًا دون بيانات دخول.');
    if (!Array.isArray(p.interests) || p.interests.length > 8 || p.interests.some(g => !GENRES[g])) throw new Error('اختر حتى 8 اهتمامات.');
    p.favorites = (p.favorites || []).map(v => String(v).trim()).filter(Boolean);
    if (p.favorites.length > 3 || p.favorites.some(v => v.length > 80)) throw new Error('أضف حتى 3 عناوين، كل عنوان لا يزيد على 80 حرفًا.');
    if (!MOODS[p.mood] || !ACCENTS[p.accent] || !['orbit','prism','ripple'].includes(p.cover)) throw new Error('اختر المظهر والمزاج من الخيارات المتاحة.');
    return p;
  }
  global.WTSocial = { call, bootstrap, saveProfile, uploadAvatar, removeAvatar, rooms, avatarURL, safeURL, validateProfile,
    GENRES, MOODS, ACCENTS, UUID, me: () => me, session };
})(window);

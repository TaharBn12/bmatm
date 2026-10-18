/* Personal room lobby: floating create panel and persistent room cards. */
(function () {
  'use strict';
  const U = window.WTUtil, IC = window.WTIcons, Auth = window.WTAuth, Rooms = window.WTRooms;
  const $ = id => document.getElementById(id);
  const el = {
    panel: $('creator'), toggle: $('createToggle'), toggleIcon: $('createToggleIcon'),
    form: $('createForm'), title: $('roomTitle'), url: $('videoUrl'), submit: $('createBtn'), error: $('createError'),
    list: $('roomsList'), empty: $('roomsEmpty'), emptyText: $('roomsEmptyText'), count: $('roomsCount'),
    status: $('homeStatus'), refresh: $('refreshRooms'), auth: $('navAuth')
  };
  const state = { rooms: [], mode: '', generation: 0, creating: false };
  const submitLabel = el.submit.innerHTML;
  const cards = window.WTRoomCards.create(el.list);

  function renderAuth() {
    const account = Auth.accountUser();
    const picture = Auth.avatarURL ? Auth.avatarURL(account) : '';
    el.auth.innerHTML = '<div class="home-social-links"><a class="btn btn--ghost btn--icon-sm" href="friends.html" title="الأصدقاء" aria-label="البحث عن الأصدقاء">' + IC.html('users',19) + '</a><a class="btn btn--ghost btn--icon-sm" href="messages.html" title="الرسائل الخاصة" aria-label="الرسائل الخاصة">' + IC.html('chat',19) + '</a>' + (account
      ? '<a class="user-chip" href="profile.html" aria-label="ملفي الشخصي"><span class="user-chip__av" style="background:' + U.colorFor(account.name) + '">' + (picture ? '<img src="' + U.esc(picture) + '" alt="" referrerpolicy="no-referrer">' : U.esc(U.initials(account.name))) + '</span>' + U.esc(account.name || 'حسابي') + '</a>'
      : '<a class="btn btn--sm btn--ghost" href="auth.html" aria-label="تسجيل الدخول">' + IC.html('user',17) + '<span>دخول</span></a>') + '</div>';
    const image = el.auth.querySelector('img');
    if (image) image.onerror = () => { image.parentNode.textContent = U.initials(account.name); };

  }

  function setCreatorOpen(open, restoreFocus) {
    el.panel.hidden = !open;
    el.toggle.setAttribute('aria-expanded', String(open));
    el.toggle.setAttribute('aria-label', open ? 'إغلاق إضافة الغرفة' : 'إضافة غرفة');
    el.toggle.setAttribute('title', open ? 'إغلاق' : 'إضافة غرفة');
    el.toggleIcon.innerHTML = IC.html(open ? 'x' : 'plus', 26);
    if (open) el.title.focus({ preventScroll: true });
    else if (restoreFocus !== false) el.toggle.focus({ preventScroll: true });
  }

  function showStatus(message, error) {
    el.status.textContent = message || '';
    el.status.hidden = !message;
    el.status.classList.toggle('is-error', !!error);
  }

  function renderRooms() {
    cards.update(state.rooms);
    el.count.textContent = String(state.rooms.length);
    el.empty.hidden = state.rooms.length > 0;
    el.emptyText.textContent = 'لا توجد غرف';
  }

  async function refreshRooms() {
    const generation = ++state.generation;
    el.list.setAttribute('aria-busy', 'true');
    el.refresh.disabled = true;
    try {
      const result = await Rooms.list();
      if (generation !== state.generation) return;
      state.rooms = result.rooms;
      state.mode = result.mode;
      renderRooms();
      showStatus(result.mode === 'local' ? 'الغرف محفوظة في هذا المتصفح فقط' : '');
    } catch (error) {
      if (generation !== state.generation) return;
      if (!state.rooms.length) { el.emptyText.textContent = 'تعذّر تحميل الغرف'; el.empty.hidden = false; }
      showStatus('تعذّر تحميل الغرف — اضغط زر التحديث للمحاولة', true);
    } finally {
      if (generation === state.generation) {
        el.list.setAttribute('aria-busy', 'false');
        el.refresh.disabled = false;
      }
    }
  }

  el.toggle.addEventListener('click', event => {
    event.stopPropagation(); // Replacing the SVG must not make this same click look like an outside click.
    setCreatorOpen(el.panel.hidden);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el.panel.hidden) { event.preventDefault(); setCreatorOpen(false); }
  });
  document.addEventListener('click', event => {
    if (!el.panel.hidden && !el.panel.contains(event.target) && !el.toggle.contains(event.target) &&
      !(event.target.closest && event.target.closest('.resolve-dialog'))) setCreatorOpen(false, false);
  });
  el.refresh.addEventListener('click', refreshRooms);
  let storageRefresh;
  window.addEventListener('storage', event => {
    if (event.key === 'wt:local:rooms' || (event.key && /^wt:local:(presence|state):/.test(event.key))) {
      clearTimeout(storageRefresh);
      storageRefresh = setTimeout(() => { if (!state.creating && !el.refresh.disabled) refreshRooms(); }, 180);
    }
    if (event.key === 'wt:session') renderAuth();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) { renderAuth(); refreshRooms(); } });
  window.addEventListener('focus', () => { if (!state.creating && !el.refresh.disabled) refreshRooms(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.creating && !el.refresh.disabled) refreshRooms(); });
  setInterval(() => { if (!document.hidden && !state.creating && !el.refresh.disabled) refreshRooms(); }, 5000);

  el.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.creating) return;
    el.error.textContent = '';
    const title = el.title.value.replace(/\s+/g, ' ').trim();
    if (!title) { el.error.textContent = 'أدخل اسم الغرفة'; el.title.focus(); return; }
    const raw = el.url.value.trim();
    if (raw && !U.parseWatchUrl(raw)) { el.error.textContent = 'أدخل رابط فيديو صالحاً'; el.url.focus(); return; }
    state.creating = true;
    el.submit.disabled = true;
    el.submit.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> جارٍ الإضافة…';
    try {
      let videoUrl = '';
      if (raw) {
        const media = await window.WTResolve(raw);
        videoUrl = media.parsed.src;
        if (media.parsed.kind === 'youtube' && !/^https?:\/\//i.test(videoUrl)) videoUrl = 'https://www.youtube.com/watch?v=' + media.parsed.id;
      }
      const user = Auth.accountUser();
      const room = await Rooms.create({ title, videoUrl, hostName: user ? user.name : '' });
      ++state.generation; // A request begun before creation must not erase the new card.
      state.mode = room.mode;
      state.rooms = [room].concat(state.rooms.filter(item => item.id !== room.id)).slice(0, 100);
      renderRooms();
      showStatus(room.mode === 'local' ? 'الغرف محفوظة في هذا المتصفح فقط' : '');
      el.list.setAttribute('aria-busy', 'false');
      el.refresh.disabled = false;
      el.title.value = ''; el.url.value = '';
      setCreatorOpen(false, false);
      el.list.querySelector('[data-room-id="' + room.id + '"]').focus();
    } catch (error) {
      el.error.textContent = error.message || 'تعذّرت إضافة الغرفة — أعد المحاولة';
      if (el.panel.hidden) showStatus(el.error.textContent, true);
    } finally {
      state.creating = false;
      el.submit.disabled = false;
      el.submit.innerHTML = submitLabel;
    }
  });

  renderAuth();
  const params = new URLSearchParams(location.search);
  if (params.get('id') || params.get('room')) {
    location.replace('room.html?' + params.toString());
  } else {
    refreshRooms();
  }
  if (params.get('secure') === 'required') showStatus('يلزم متصفح حديث لحفظ مفتاح الغرفة بأمان', true);
})();

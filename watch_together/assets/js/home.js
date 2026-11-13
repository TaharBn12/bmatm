/* Personal room lobby: persistent cards, swipe actions and account-only room management. */
(function () {
  'use strict';
  const U = window.WTUtil, IC = window.WTIcons, Auth = window.WTAuth, Rooms = window.WTRooms;
  const $ = id => document.getElementById(id);
  const el = {
    panel: $('creator'), toggle: $('createToggle'), toggleIcon: $('createToggleIcon'),
    form: $('createForm'), title: $('roomTitle'), url: $('videoUrl'), submit: $('createBtn'), error: $('createError'),
    resolved: $('resolvedHint'), resolvedLink: $('resolvedLink'), copyResolved: $('copyResolved'), resolvedMeta: $('resolvedMeta'),
    list: $('roomsList'), empty: $('roomsEmpty'), emptyText: $('roomsEmptyText'), count: $('roomsCount'),
    status: $('homeStatus'), refresh: $('refreshRooms'),
    dialog: $('roomActionDialog'), dialogContent: $('roomActionContent')
  };
  const state = { rooms: [], mode: '', generation: 0, creating: false, dialogBusy: false, returnFocus: null, pending: null };
  const submitLabel = el.submit.innerHTML;

  function currentAccount() {
    const user = Auth && Auth.accountUser ? Auth.accountUser() : null;
    const session = Auth && Auth.getSession ? Auth.getSession() : null;
    if (!user || !session || !session.access_token || user.guest) return null;
    if (session.expires_at && session.expires_at <= Date.now()) return null;
    return user;
  }

  function goToAuth(next) {
    const destination = next || (location.pathname + location.search || 'index.html');
    location.replace('auth.html?next=' + encodeURIComponent(destination));
  }

  function requireAccount() {
    const user = currentAccount();
    if (user) return user;
    goToAuth();
    return null;
  }

  function setCreatorOpen(open, restoreFocus) {
    if (open && !requireAccount()) return;
    el.panel.hidden = !open;
    el.toggle.setAttribute('aria-expanded', String(open));
    el.toggle.setAttribute('aria-label', open ? 'إغلاق إضافة الغرفة' : 'إضافة غرفة');
    el.toggle.setAttribute('title', open ? 'إغلاق' : 'إضافة غرفة');
    el.toggleIcon.innerHTML = IC.html(open ? 'x' : 'plus', 26);
    if (open) el.title.focus({ preventScroll: true });
    else if (restoreFocus !== false) el.toggle.focus({ preventScroll: true });
    clearResolvedPreview();
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

  function dialogShell(title, description, body, eyebrow) {
    return '<div class="room-dialog__head"><p class="room-dialog__eyebrow">' + U.esc(eyebrow || 'إدارة الغرفة') + '</p>' +
      '<h2 class="room-dialog__title" id="roomActionTitle">' + U.esc(title) + '</h2>' +
      (description ? '<p class="room-dialog__desc">' + U.esc(description) + '</p>' : '') +
      '<button class="room-dialog__close" type="button" data-dialog-close aria-label="إغلاق"><span class="ic" data-icon="x" data-size="18"></span></button></div>' + body;
  }

  function showDialog(title, description, body, eyebrow) {
    el.dialogContent.innerHTML = dialogShell(title, description, body, eyebrow);
    IC.apply(el.dialogContent);
    state.dialogBusy = false;
    if (!el.dialog.open) el.dialog.showModal();
  }

  function closeDialog() {
    if (el.dialog.open) el.dialog.close();
  }

  el.dialog.addEventListener('click', event => {
    if (event.target === el.dialog || (event.target.closest && event.target.closest('[data-dialog-close]'))) closeDialog();
  });
  el.dialog.addEventListener('close', () => {
    if (state.returnFocus && state.returnFocus.isConnected) state.returnFocus.focus({ preventScroll: true });
    else if (el.refresh && el.refresh.isConnected) el.refresh.focus({ preventScroll: true });
    state.returnFocus = null;
  });

  function setFormBusy(form, busy, label) {
    form.querySelectorAll('button').forEach(button => {
      if (busy) {
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
      } else {
        button.disabled = false;
        if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
      }
    });
    const submit = form.querySelector('[type="submit"]');
    if (busy && submit) submit.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> ' + U.esc(label || 'جارٍ الحفظ…');
  }

  function errorIn(form, message) {
    const node = form.querySelector('[data-form-error]');
    if (node) node.textContent = message || '';
  }

  function settingsForm(room) {
    const privateChecked = room.isPrivate ? ' checked' : '';
    const body = '<form class="room-dialog__form" data-room-action-form="settings">' +
      '<label class="room-dialog__choice"><input type="checkbox" name="isPrivate"' + privateChecked + '><span><strong>غرفة خاصة — رابط الدعوة فقط</strong><small>لن تظهر هذه الغرفة في قائمة الغرف العامة. يستطيع من يملك رابط الدعوة الانضمام.</small></span></label>' +
      '<p class="room-dialog__hint">التحكم بالمشاهدة متاح لجميع المشاركين المنضمّين إلى الغرفة.</p>' +
      '<p class="room-dialog__error" data-form-error role="alert"></p>' +
      '<div class="room-dialog__actions"><button class="btn btn--ghost" type="button" data-dialog-close>إلغاء</button><button class="btn btn--primary" type="submit">حفظ الإعدادات</button></div></form>';
    showDialog('إعدادات «' + room.title + '»', 'تُحفظ الخيارات على الخادم وتُطبّق على الغرفة نفسها.', body, 'إعدادات الغرفة');
  }

  function editForm(room) {
    const canChangeVideo = room.queueCount === 0;
    const videoHint = canChangeVideo
      ? 'يُستخدم هذا الرابط كفيديو الغرفة عندما لا توجد عناصر في قائمة التشغيل.'
      : room.queueCount > 0
        ? 'تحتوي قائمة التشغيل على ' + room.queueCount + ' عنصر/عناصر؛ أفرغها قبل تغيير رابط المشاهدة.'
        : 'تعذّر التحقق من قائمة التشغيل؛ تعطيل تغيير الرابط حفاظاً على العناصر الحالية.';
    const body = '<form class="room-dialog__form" data-room-action-form="edit">' +
      '<div><label class="label" for="editRoomTitle">اسم الغرفة</label><input class="input" id="editRoomTitle" name="title" type="text" maxlength="40" required value="' + U.esc(room.title) + '"></div>' +
      '<div><label class="label" for="editRoomUrl">رابط المشاهدة</label><input class="input input--ltr" id="editRoomUrl" name="videoUrl" type="url" inputmode="url" spellcheck="false" placeholder="https://…" value="' + U.esc(room.videoUrl || '') + '"' + (canChangeVideo ? '' : ' disabled') + '><p class="room-dialog__hint">' + U.esc(videoHint) + '</p></div>' +
      '<p class="room-dialog__error" data-form-error role="alert"></p>' +
      '<div class="room-dialog__actions"><button class="btn btn--ghost" type="button" data-dialog-close>إلغاء</button><button class="btn btn--primary" type="submit">حفظ التعديل</button></div></form>';
    showDialog('تعديل «' + room.title + '»', 'يمكنك تغيير الاسم ورابط المشاهدة.', body, 'تعديل الغرفة');
    const title = $('editRoomTitle');
    if (title) title.focus({ preventScroll: true });
  }

  function deleteForm(room) {
    const body = '<form class="room-dialog__form" data-room-action-form="delete">' +
      '<div class="room-dialog__danger"><strong>سيتم حذف «' + U.esc(room.title) + '» نهائياً.</strong><br>سيُحذف سجل الغرفة وحالتها وقائمة التشغيل والرسائل المرتبطة بها من قاعدة البيانات، ولا يمكن التراجع عن ذلك.</div>' +
      '<p class="room-dialog__error" data-form-error role="alert"></p>' +
      '<div class="room-dialog__actions"><button class="btn btn--ghost" type="button" data-dialog-close>إلغاء</button><button class="btn btn--danger" type="submit"><span class="ic" data-icon="trash" data-size="17"></span> حذف نهائي</button></div></form>';
    showDialog('حذف الغرفة؟', 'تأكيد الحذف النهائي.', body, 'إجراء لا يمكن التراجع عنه');
  }

  function reportForm(room) {
    const body = '<form class="room-dialog__form" data-room-action-form="report">' +
      '<div><label class="label" for="reportReason">سبب الإبلاغ</label><select class="input" id="reportReason" name="reason" required>' +
      '<option value="spam">رسائل مزعجة أو احتيال</option><option value="inappropriate">محتوى غير مناسب</option><option value="illegal">محتوى مخالف للقانون</option><option value="other">سبب آخر</option></select></div>' +
      '<div><label class="label" for="reportDetails">تفاصيل إضافية <span class="label__opt">(اختياري)</span></label><textarea class="input" id="reportDetails" name="details" rows="4" maxlength="500" placeholder="أخبرنا بما ينبغي مراجعته…"></textarea></div>' +
      '<p class="room-dialog__error" data-form-error role="alert"></p>' +
      '<div class="room-dialog__actions"><button class="btn btn--ghost" type="button" data-dialog-close>إلغاء</button><button class="btn btn--danger" type="submit"><span class="ic" data-icon="alert" data-size="17"></span> إرسال البلاغ</button></div></form>';
    showDialog('الإبلاغ عن محتوى الغرفة', 'سيُرسل البلاغ لمراجعة محتوى «' + room.title + '».', body, 'مراجعة المحتوى');
  }

  async function handleRoomAction(room, action) {
    if (!room) return;
    if (!requireAccount()) return;
    if (['settings', 'edit', 'delete'].includes(action) && !room.isOwner) return;
    const card = el.list.querySelector('[data-room-id="' + CSS.escape(room.id) + '"]');
    state.returnFocus = card && card.querySelector('.room-tile__menu-toggle');
    if (action === 'settings') { settingsForm(room); return; }
    if (action === 'delete') { deleteForm(room); return; }
    if (action === 'report') { reportForm(room); return; }
    if (action === 'edit') {
      try {
        const details = await Rooms.management(room.id);
        editForm(Object.assign({}, room, details || {}));
      } catch (error) { U.toast(error.message || 'تعذّر تحميل إعدادات الغرفة', 'error', 3000); }
    }
  }

  function showResolvedPreview(url, title) {
    if (!el.resolved) return;
    el.resolvedLink.href = url;
    el.resolvedLink.textContent = url;
    el.resolvedMeta.textContent = title ? ('العنوان: ' + U.esc(title)) : '';
    el.resolved.hidden = false;
    el.submit.disabled = false;
    el.submit.innerHTML = '<span class="ic" data-icon="plus" data-size="18"></span> إنشاء الغرفة بهذا الرابط';
    let btn = $('resetResolved');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'resetResolved';
      btn.className = 'btn btn--ghost';
      btn.textContent = 'تعديل البيانات';
      el.form.appendChild(btn);
      btn.addEventListener('click', clearResolvedPreview);
    }
    btn.hidden = false;
  }

  function clearResolvedPreview() {
    state.pending = null;
    if (el.resolved) el.resolved.hidden = true;
    const btn = $('resetResolved');
    if (btn) btn.hidden = true;
    el.submit.disabled = false;
    el.submit.innerHTML = submitLabel;
  }

  const cards = window.WTRoomCards.create(el.list, {
    isAuthenticated: () => !!currentAccount(),
    onAction: handleRoomAction
  });

  el.dialog.addEventListener('submit', async event => {
    const form = event.target.closest && event.target.closest('[data-room-action-form]');
    if (!form) return;
    event.preventDefault();
    if (state.dialogBusy) return;
    const account = requireAccount();
    if (!account) return;
    const action = form.dataset.roomActionForm;
    const card = state.returnFocus && state.returnFocus.closest('[data-room-id]');
    const roomId = card && card.dataset.roomId;
    if (!roomId) { errorIn(form, 'تعذّر تحديد الغرفة — أغلق النافذة وحاول مجدداً'); return; }
    state.dialogBusy = true;
    setFormBusy(form, true, action === 'delete' ? 'جارٍ الحذف…' : action === 'report' ? 'جارٍ الإرسال…' : 'جارٍ الحفظ…');
    errorIn(form, '');
    try {
      if (action === 'settings') {
        const data = new FormData(form);
        await Rooms.update(roomId, { isPrivate: data.has('isPrivate') });
        closeDialog();
        await refreshRooms();
        U.toast('تم حفظ إعدادات الغرفة', 'success', 2200);
      } else if (action === 'edit') {
        const data = new FormData(form);
        const title = String(data.get('title') || '').replace(/\s+/g, ' ').trim();
        if (!title) throw new Error('أدخل اسم الغرفة');
        const urlInput = form.querySelector('[name="videoUrl"]');
        const videoUrl = urlInput && !urlInput.disabled ? String(data.get('videoUrl') || '').trim() : undefined;
        const changes = { title };
        if (videoUrl !== undefined) {
          if (videoUrl && !U.parseWatchUrl(videoUrl)) throw new Error('أدخل رابط مشاهدة صالحاً');
          let normalized = '';
          if (videoUrl) {
            const media = await window.WTResolve(videoUrl);
            normalized = media.parsed.src;
            if (media.parsed.kind === 'youtube' && !/^https?:\/\//i.test(normalized)) normalized = 'https://www.youtube.com/watch?v=' + media.parsed.id;
          }
          changes.videoUrl = normalized;
        }
        await Rooms.update(roomId, changes);
        closeDialog();
        await refreshRooms();
        U.toast('تم تعديل الغرفة', 'success', 2200);
      } else if (action === 'delete') {
        await Rooms.remove(roomId);
        state.rooms = state.rooms.filter(room => room.id !== roomId);
        renderRooms();
        closeDialog();
        U.toast('حُذفت الغرفة نهائياً', 'success', 2300);
      } else if (action === 'report') {
        const data = new FormData(form);
        await Rooms.report(roomId, account.id, String(data.get('reason') || ''), String(data.get('details') || ''));
        closeDialog();
        U.toast('تم استلام بلاغك — شكراً لمساعدتنا في مراجعة المحتوى', 'success', 3000);
      }
    } catch (error) {
      errorIn(form, error.message || 'حدث خطأ — أعد المحاولة');
      setFormBusy(form, false);
    } finally { state.dialogBusy = false; }
  });

  el.toggle.addEventListener('click', event => {
    event.stopPropagation(); // Replacing the SVG must not make this same click look like an outside click.
    setCreatorOpen(el.panel.hidden);
  });
  el.title.addEventListener('input', clearResolvedPreview);
  el.url.addEventListener('input', clearResolvedPreview);
  el.copyResolved.addEventListener('click', async () => {
    const url = el.resolvedLink ? el.resolvedLink.textContent : '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      const ta = document.createElement('textarea');
      ta.value = url; ta.hidden = true; document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    el.copyResolved.textContent = 'تم النسخ';
    setTimeout(() => { if (el.copyResolved) el.copyResolved.textContent = 'نسخ الرابط'; }, 1500);
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
  });
  window.addEventListener('pageshow', event => { if (event.persisted) refreshRooms(); });
  window.addEventListener('focus', () => { if (!state.creating && !el.refresh.disabled) refreshRooms(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.creating && !el.refresh.disabled) refreshRooms(); });
  setInterval(() => { if (!document.hidden && !state.creating && !el.refresh.disabled) refreshRooms(); }, 5000);

  el.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.creating) return;
    const user = requireAccount();
    if (!user) return;
    el.error.textContent = '';
    const title = el.title.value.replace(/\s+/g, ' ').trim();
    if (!title) { el.error.textContent = 'أدخل اسم الغرفة'; el.title.focus(); return; }
    const raw = el.url.value.trim();
    if (raw && !U.parseWatchUrl(raw)) { el.error.textContent = 'أدخل رابط فيديو صالحاً'; el.url.focus(); return; }
    const quality = el.videoQuality ? el.videoQuality.value : '720';
    const importPlaylist = el.importPlaylist ? el.importPlaylist.checked : false;
    if (!state.pending && raw) {
      /* الخطوة 1: استخراج الرابط المباشر وعرضه قبل إنشاء الغرفة */
      state.creating = true;
      el.submit.disabled = true;
      el.submit.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> جارٍ استخراج الرابط…';
      let pendingPlaylist = null;
      let videoUrl = '';
      try {
        const media = await window.WTResolve(raw, { quality });
        if (media.parsed.kind === 'youtube-playlist' && importPlaylist && Array.isArray(media.playlist) && media.playlist.length) {
          const first = media.playlist[0];
          videoUrl = first.url || first.src;
          pendingPlaylist = media.playlist.slice(1).map(item => ({
            id: U.randomCode ? U.randomCode(8) : String(Math.random()),
            url: item.url || item.src,
            title: item.title || item.n || ''
          }));
        } else {
          videoUrl = media.parsed.src;
          if (media.parsed.kind === 'youtube' && !/^https?:\/\//i.test(videoUrl)) videoUrl = 'https://www.youtube.com/watch?v=' + media.parsed.id;
        }
        state.pending = { title, videoUrl, pendingPlaylist };
        showResolvedPreview(videoUrl, media.title || '');
        return;
      } catch (error) {
        el.error.textContent = error.message || 'تعذّرت إضافة الغرفة — أعد المحاولة';
        if (el.panel.hidden) showStatus(el.error.textContent, true);
      } finally {
        state.creating = false;
        el.submit.disabled = false;
        el.submit.innerHTML = submitLabel;
      }
      return;
    }

    /* الخطوة 2: تأكيد الإنشاء بالرابط المستخرج (أو بدون رابط) */
    const pending = state.pending;
    state.creating = true;
    el.submit.disabled = true;
    el.submit.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> جارٍ الإضافة…';
    try {
      const room = await Rooms.create({ title: pending ? pending.title : title, videoUrl: pending ? pending.videoUrl : '', hostName: user.name || user.email || '' });
      if (pending && pending.pendingPlaylist && pending.pendingPlaylist.length) {
        try { sessionStorage.setItem('wt:playlist:' + room.id, JSON.stringify(pending.pendingPlaylist)); } catch (_) { }
      }
      ++state.generation; // A request begun before creation must not erase the new card.
      state.mode = room.mode;
      state.rooms = [room].concat(state.rooms.filter(item => item.id !== room.id)).slice(0, 100);
      renderRooms();
      showStatus(room.mode === 'local' ? 'الغرف محفوظة في هذا المتصفح فقط' : '');
      el.list.setAttribute('aria-busy', 'false');
      el.refresh.disabled = false;
      el.title.value = ''; el.url.value = '';
      if (el.importPlaylist) el.importPlaylist.checked = false;
      setCreatorOpen(false, false);
      const link = el.list.querySelector('[data-room-id="' + CSS.escape(room.id) + '"] .room-tile__link');
      if (link) link.focus({ preventScroll: true });
    } catch (error) {
      el.error.textContent = error.message || 'تعذّرت إضافة الغرفة — أعد المحاولة';
      if (el.panel.hidden) showStatus(el.error.textContent, true);
    } finally {
      state.creating = false;
      el.submit.disabled = false;
      el.submit.innerHTML = state.pending
        ? '<span class="ic" data-icon="plus" data-size="18"></span> إنشاء الغرفة بهذا الرابط'
        : submitLabel;
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.get('id') || params.get('room')) {
    location.replace('room.html?' + params.toString());
  } else {
    refreshRooms();
  }
  if (params.get('secure') === 'required') showStatus('يلزم متصفح حديث لحفظ مفتاح الغرفة بأمان', true);
})();

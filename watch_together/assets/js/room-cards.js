/* Quiet five-second covers. A lobby preview never joins a room or controls its playback. */
(function (global) {
  'use strict';
  const U = global.WTUtil, IC = global.WTIcons;
  const SECONDS = 5, MAX_ACTIVE = 6;
  let hlsPromise;

  function previewSpec(raw) {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      url.hash = '';
      const parsed = U.parseWatchUrl(url.href);
      if (!parsed || !['file', 'hls', 'youtube'].includes(parsed.kind)) return null;
      return { kind: parsed.kind, src: url.href, id: parsed.id || '' };
    } catch (_) { return null; }
  }

  function clipWindow(video) {
    const duration = Number(video.duration);
    if (Number.isFinite(duration) && duration > 0) return { start: 0, end: Math.min(SECONDS, duration) };
    try {
      if (video.seekable && video.seekable.length) {
        const index = video.seekable.length - 1, end = video.seekable.end(index);
        return { start: Math.max(video.seekable.start(index), end - SECONDS), end };
      }
    } catch (_) { /* Live seek windows may change between reads. */ }
    return { start: 0, end: SECONDS };
  }

  function peopleMarkup(room) {
    if (!room.presenceKnown || !Number.isSafeInteger(room.participantCount)) {
      return '<span class="room-tile__people is-unknown" title="تعذّر تحديث الحضور" aria-label="الحضور غير متاح">' + IC.html('users', 16) + '<span aria-hidden="true">—</span></span>';
    }
    const people = (room.participants || []).slice(0, 5);
    const count = Math.max(people.length, room.participantCount), rest = count - people.length;
    const label = count ? count + ' منضم الآن' : 'لا يوجد منضمون الآن';
    let html = people.map(person => '<span class="room-tile__avatar" title="' + U.esc(person.name) + '" style="background:' + U.colorFor(person.name) + '" aria-hidden="true">' + U.esc(U.initials(person.name)) + '</span>').join('');
    if (rest) html += '<span class="room-tile__more" dir="ltr" title="' + rest + ' آخرون" aria-hidden="true">+' + rest + '</span>';
    if (!count) html = IC.html('users', 16) + '<span aria-hidden="true">0</span>';
    return '<span class="room-tile__people" role="group" aria-label="' + label + '">' + html + '</span>';
  }

  function loadHls() {
    if (global.Hls) return Promise.resolve(global.Hls);
    if (!hlsPromise) hlsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('HLS timeout')); }, 7000);
      script.src = 'assets/vendor/hls.min.js?v=2.7.1';
      script.onload = () => { clearTimeout(timer); global.Hls ? resolve(global.Hls) : reject(new Error('HLS unavailable')); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('HLS unavailable')); };
      document.head.appendChild(script);
    }).catch(error => { hlsPromise = null; throw error; });
    return hlsPromise;
  }

  function create(container, options) {
    options = options || {};
    const items = new Map();
    const motion = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    let disposed = false, frame = 0, openItem = null;
    const observer = global.IntersectionObserver ? new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const item = items.get(entry.target.dataset.roomId);
        if (item) item.visible = entry.isIntersecting;
      });
      schedule();
    }, { threshold: 0.05 }) : null;

    function release(item) {
      const media = item.media;
      item.media = null;
      item.active = false;
      if (media) media.close();
      item.node.classList.remove('has-preview');
    }

    function failed(item) {
      item.failedAt = Date.now();
      item.cover.title = 'معاينة الفيديو غير متاحة';
      release(item);
      schedule();
    }

    function poster(item) {
      if (item.poster || item.spec.kind !== 'youtube') return;
      const image = document.createElement('img');
      image.className = 'room-tile__poster'; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.src = 'https://i.ytimg.com/vi/' + item.spec.id + '/hqdefault.jpg';
      image.onerror = () => image.remove();
      item.poster = image;
      item.cover.appendChild(image);
    }

    function nativePreview(item) {
      const video = document.createElement('video');
      video.className = 'room-tile__preview';
      video.muted = true; video.defaultMuted = true; video.volume = 0;
      video.playsInline = true; video.preload = 'metadata'; video.controls = false;
      video.disablePictureInPicture = true; video.disableRemotePlayback = true;
      video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true'); video.setAttribute('tabindex', '-1');
      let hls = null, ready = false, loading = false, callback = 0, clip = { start: 0, end: SECONDS };
      const current = () => !disposed && item.media === media;
      const play = () => {
        if (!current() || !item.active) return;
        video.muted = true; video.volume = 0;
        const result = video.play();
        if (result && result.catch) result.catch(() => { /* Autoplay denied: the decoded frame is still a cover. */ });
      };
      const rewind = () => {
        if (!current() || !ready) return;
        try { video.currentTime = clip.start; } catch (_) { }
        play();
      };
      const enforce = () => {
        if (!Number.isFinite(video.duration) && video.seekable && video.seekable.length) {
          try { if (video.seekable.start(video.seekable.length - 1) > clip.start + 0.1) clip = clipWindow(video); } catch (_) { }
        }
        if (video.currentTime >= clip.end - 0.02 && clip.end > clip.start) rewind();
      };
      const tick = () => {
        if (!current() || !item.active || video.paused) return;
        enforce();
        callback = video.requestVideoFrameCallback(tick);
      };
      const timer = setTimeout(() => { if (current() && !ready) failed(item); }, 10000);
      const media = {
        type: 'video', element: video,
        start() { if (hls && !loading) { hls.startLoad(); loading = true; } play(); },
        pause() { video.pause(); if (hls && loading) { hls.stopLoad(); loading = false; } },
        close() {
          clearTimeout(timer);
          if (callback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
          if (hls) hls.destroy();
          video.pause(); video.removeAttribute('src'); video.load(); video.remove();
        }
      };
      item.media = media;
      video.addEventListener('loadedmetadata', () => {
        if (!current()) return;
        clip = clipWindow(video);
        if (clip.start) { try { video.currentTime = clip.start; } catch (_) { } }
        play();
      });
      video.addEventListener('loadeddata', () => {
        if (!current()) return;
        ready = true; clearTimeout(timer); item.node.classList.add('has-preview');
        if (!item.active) media.pause();
      });
      video.addEventListener('playing', () => {
        if (callback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
        if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(tick);
      });
      video.addEventListener('timeupdate', enforce);
      video.addEventListener('ended', rewind);
      video.addEventListener('error', () => { if (current()) failed(item); });
      item.cover.appendChild(video);
      if (item.spec.kind !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = item.spec.src;
        play();
      } else loadHls().then(Hls => {
        if (!current()) return;
        if (!Hls.isSupported()) { failed(item); return; }
        hls = new Hls({ autoStartLoad: false, capLevelToPlayerSize: true, maxBufferLength: 5, maxMaxBufferLength: 10, backBufferLength: 5 });
        hls.on(Hls.Events.ERROR, (_, data) => { if (current() && data.fatal) failed(item); });
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (current()) { hls.loadSource(item.spec.src); hls.startLoad(); loading = true; } });
        hls.attachMedia(video);
      }).catch(() => { if (current()) failed(item); });
    }

    function youtubePreview(item) {
      const iframe = document.createElement('iframe');
      const origin = 'https://www.youtube-nocookie.com';
      const query = new URLSearchParams({ autoplay: '1', mute: '1', controls: '0', playsinline: '1',
        start: '0', end: String(SECONDS), loop: '1', playlist: item.spec.id, enablejsapi: '1',
        disablekb: '1', fs: '0', rel: '0', origin: location.origin });
      iframe.src = origin + '/embed/' + item.spec.id + '?' + query;
      iframe.className = 'room-tile__youtube'; iframe.title = 'معاينة فيديو صامتة';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.setAttribute('tabindex', '-1'); iframe.setAttribute('aria-hidden', 'true');
      let handshake = 0;
      const post = (func, args) => { try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [], id: 'preview-' + item.node.dataset.roomId }), origin); } catch (_) { } };
      const listen = () => {
        try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'preview-' + item.node.dataset.roomId }), origin); } catch (_) { }
        post('addEventListener', ['onReady']); post('addEventListener', ['onStateChange']); post('addEventListener', ['onError']);
        post('mute'); post('playVideo');
      };
      const timer = setTimeout(() => { if (item.media === media) failed(item); }, 12000);
      const onMessage = event => {
        if (event.source !== iframe.contentWindow || ![origin, 'https://www.youtube.com'].includes(event.origin)) return;
        let message;
        try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (_) { return; }
        if (!message || typeof message !== 'object') return;
        if (message.event === 'onError') { failed(item); return; }
        if (message.event === 'onReady' || message.event === 'infoDelivery' || message.event === 'initialDelivery' || message.event === 'onStateChange') {
          clearTimeout(timer); clearInterval(handshake);
          item.node.classList.add('has-preview');
          post('mute');
          if (message.event === 'onReady') { post('seekTo', [0, true]); post('playVideo'); }
          const info = message.info || {};
          if ((Number(info.currentTime) >= SECONDS) || (message.event === 'onStateChange' && message.info === 0)) {
            post('seekTo', [0, true]); post('playVideo');
          }
        }
      };
      const media = { type: 'youtube', element: iframe, start() {}, pause() { post('pauseVideo'); }, close() {
        clearTimeout(timer); clearInterval(handshake); global.removeEventListener('message', onMessage);
        iframe.onload = null; iframe.src = 'about:blank'; iframe.remove();
      } };
      item.media = media;
      iframe.onload = () => { listen(); clearInterval(handshake); handshake = setInterval(listen, 500); };
      global.addEventListener('message', onMessage);
      item.cover.appendChild(iframe);
    }

    function reconcile() {
      frame = 0;
      if (disposed) return;
      const now = Date.now(), list = Array.from(items.values());
      if (!observer) list.forEach(item => { const rect = item.node.getBoundingClientRect(); item.visible = rect.bottom > 0 && rect.top < innerHeight; });
      const candidates = document.hidden || (navigator.connection && navigator.connection.saveData) ? [] :
        list.filter(item => item.visible && item.spec && (!item.failedAt || now - item.failedAt > 30000)).sort((a, b) => Number(b.priority) - Number(a.priority)).slice(0, MAX_ACTIVE);
      const selected = new Set(candidates);
      list.forEach(item => {
        if (!selected.has(item)) { release(item); return; }
        item.active = !motion.matches;
        if (item.spec.kind === 'youtube') {
          poster(item);
          if (!item.active) { release(item); return; }
        }
        if (!item.media) item.spec.kind === 'youtube' ? youtubePreview(item) : nativePreview(item);
        if (item.active) item.media.start();
        else if (item.node.classList.contains('has-preview')) item.media.pause();
      });
    }
    function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(reconcile); }
    const actionLabels = {
      settings: ['الإعدادات', 'sliders'], edit: ['التعديل', 'pencil'],
      delete: ['الحذف', 'trash'], report: ['الإبلاغ عن محتوى الغرفة', 'alert']
    };
    function closeMenu(item) {
      if (!item) return;
      item.node.classList.remove('is-actions-open');
      item.menu.hidden = true;
      item.toggle.setAttribute('aria-expanded', 'false');
      if (openItem === item) openItem = null;
    }
    function openMenu(item) {
      if (openItem && openItem !== item) closeMenu(openItem);
      item.node.classList.add('is-actions-open');
      item.menu.hidden = false;
      item.toggle.setAttribute('aria-expanded', 'true');
      openItem = item;
    }
    function toggleMenu(item) {
      item.node.classList.contains('is-actions-open') ? closeMenu(item) : openMenu(item);
    }
    function renderActions(item, room) {
      const signedIn = typeof options.isAuthenticated === 'function' ? !!options.isAuthenticated() : true;
      const owner = !!room.isOwner && signedIn;
      const actions = owner ? ['settings', 'edit', 'delete'] : ['report'];
      item.menu.innerHTML = actions.map(action => {
        const [label, icon] = actionLabels[action];
        return '<button class="room-tile__action room-tile__action--' + action + '" type="button" role="menuitem" data-room-action="' + action + '"><span class="ic" data-icon="' + icon + '" data-size="17"></span><span>' + label + '</span></button>';
      }).join('');
      item.toggle.setAttribute('aria-label', 'إجراءات ' + room.title);
      item.toggle.title = 'إجراءات الغرفة';
      item.menu.setAttribute('aria-label', owner ? 'إدارة الغرفة' : 'الإبلاغ عن الغرفة');
      IC.apply(item.menu);
    }
    function make(room) {
      const node = document.createElement('article');
      node.className = 'room-tile'; node.dataset.roomId = room.id;
      node.innerHTML = '<a class="room-tile__link"><span class="room-tile__cover" aria-hidden="true"><span class="room-tile__fallback">' + IC.html('film', 26) + '</span><span class="room-tile__duration">0:05</span></span>' +
        '<span class="room-tile__body"><strong class="room-tile__title"></strong><span class="room-tile__attendance"></span></span></a>' +
        '<button class="room-tile__menu-toggle" type="button" aria-haspopup="menu" aria-expanded="false"><span class="ic" data-icon="more" data-size="19"></span></button>' +
        '<div class="room-tile__menu" role="menu" hidden></div>';
      const item = { node, link: node.querySelector('.room-tile__link'), cover: node.querySelector('.room-tile__cover'),
        title: node.querySelector('.room-tile__title'), people: node.querySelector('.room-tile__attendance'),
        toggle: node.querySelector('.room-tile__menu-toggle'), menu: node.querySelector('.room-tile__menu'),
        visible: false, priority: false, source: null, spec: null, media: null, poster: null, failedAt: 0,
        pointer: null, suppressClick: false, actionSignature: '' };
      item.toggle.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); toggleMenu(item);
      });
      item.menu.addEventListener('click', event => {
        const button = event.target.closest && event.target.closest('[data-room-action]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        const action = button.dataset.roomAction;
        closeMenu(item);
        if (typeof options.onAction === 'function') options.onAction(item.room, action);
      });
      node.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target.closest && event.target.closest('button, video, iframe')) return;
        item.pointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
      }, { passive: true });
      node.addEventListener('pointerup', event => {
        if (!item.pointer || item.pointer.id !== event.pointerId) return;
        const dx = event.clientX - item.pointer.x, dy = event.clientY - item.pointer.y;
        item.pointer = null;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        toggleMenu(item);
        item.suppressClick = true;
        setTimeout(() => { item.suppressClick = false; }, 650);
      }, { passive: true });
      node.addEventListener('pointercancel', () => { item.pointer = null; }, { passive: true });
      node.addEventListener('click', event => {
        if (!item.suppressClick || (event.target.closest && event.target.closest('button, [data-room-action]'))) return;
        event.preventDefault(); event.stopPropagation();
      }, true);
      node.addEventListener('pointerenter', () => { item.priority = true; schedule(); });
      node.addEventListener('pointerleave', () => { item.priority = false; schedule(); });
      node.addEventListener('focusin', () => { item.priority = true; schedule(); });
      node.addEventListener('focusout', () => { item.priority = false; schedule(); });
      return item;
    }
    function outsideClick(event) {
      if (openItem && !openItem.node.contains(event.target)) closeMenu(openItem);
    }
    function escapeMenu(event) {
      if (event.key === 'Escape' && openItem) { const item = openItem; closeMenu(item); item.toggle.focus({ preventScroll: true }); }
    }
    document.addEventListener('click', outsideClick, true);
    document.addEventListener('keydown', escapeMenu);
    function update(rooms) {
      if (disposed) return;
      const keep = new Set(rooms.map(room => room.id));
      items.forEach((item, id) => { if (!keep.has(id)) { release(item); if (observer) observer.unobserve(item.node); item.node.remove(); items.delete(id); } });
      rooms.forEach((room, index) => {
        let item = items.get(room.id);
        if (!item) { item = make(room); items.set(room.id, item); if (observer) observer.observe(item.node); }
        item.room = room;
        item.link.href = global.WTRooms.href(room);
        item.link.setAttribute('aria-label', 'دخول ' + room.title + (room.presenceKnown ? ' — ' + room.participantCount + ' منضم الآن' : ''));
        item.title.textContent = room.title;
        const actionSignature = (room.isOwner ? 'owner' : 'viewer') + ':' + (typeof options.isAuthenticated === 'function' ? !!options.isAuthenticated() : true);
        if (item.actionSignature !== actionSignature) { renderActions(item, room); item.actionSignature = actionSignature; }
        item.node.classList.toggle('is-private-room', !!room.isPrivate);
        item.node.setAttribute('data-control-mode', room.controlMode || 'owner');
        const people = peopleMarkup(room);
        if (people !== item.people.innerHTML) item.people.innerHTML = people;
        if (item.source !== room.videoUrl) {
          release(item); if (item.poster) item.poster.remove(); item.poster = null; item.failedAt = 0;
          item.source = room.videoUrl; item.spec = previewSpec(room.videoUrl);
          item.cover.title = item.spec ? 'معاينة صامتة لمدة 5 ثوانٍ' : room.videoUrl ? 'معاينة هذا الرابط غير متاحة' : 'لم يُضف فيديو بعد';
          item.node.classList.toggle('has-video', !!item.spec);
        }
        // Do not move unchanged nodes: moving an iframe restarts its player and steals focus.
        if (container.children[index] !== item.node) container.insertBefore(item.node, container.children[index] || null);
      });
      schedule();
    }
    function dispose() {
      disposed = true; if (frame) cancelAnimationFrame(frame);
      if (observer) observer.disconnect();
      if (openItem) closeMenu(openItem);
      document.removeEventListener('click', outsideClick, true);
      document.removeEventListener('keydown', escapeMenu);
      items.forEach(release); items.clear();
      document.removeEventListener('visibilitychange', schedule);
      global.removeEventListener('resize', schedule); global.removeEventListener('scroll', schedule);
      global.removeEventListener('pagehide', onHide); global.removeEventListener('pageshow', schedule);
      if (motion.removeEventListener) motion.removeEventListener('change', schedule);
    }
    function onHide(event) { if (!event.persisted) dispose(); else items.forEach(release); }
    document.addEventListener('visibilitychange', schedule);
    global.addEventListener('resize', schedule); if (!observer) global.addEventListener('scroll', schedule, { passive: true });
    global.addEventListener('pagehide', onHide); global.addEventListener('pageshow', schedule);
    if (motion.addEventListener) motion.addEventListener('change', schedule);
    return { update, dispose };
  }
  global.WTRoomCards = { create, previewSpec, clipWindow, peopleMarkup };
})(window);

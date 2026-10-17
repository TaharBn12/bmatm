/* =========================================================
   WatchTogether — مشغّل موحّد (player.js)
   يدعم: YouTube • ملفات MP4/WebM • بث HLS (.m3u8) • روابط مضمَّنة (iframe)
   واجهة واحدة لكل الأنواع حتى تعمل المزامنة بنفس الطريقة.
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;
  let ytApiPromise = null;

  function loadYouTubeApi() {
    if (global.YT && global.YT.Player) return Promise.resolve(global.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = global.onYouTubeIframeAPIReady;
      const s = document.createElement('script');
      let timer;
      const finish = (err) => {
        clearTimeout(timer);
        if (global.onYouTubeIframeAPIReady === ready) global.onYouTubeIframeAPIReady = prev;
        s.onerror = null;
        if (err) { s.remove(); reject(err); }
        else resolve(global.YT);
      };
      const ready = () => {
        try { prev && prev(); } catch (e) { }
        if (global.YT && global.YT.Player) finish();
      };
      global.onYouTubeIframeAPIReady = ready;
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => finish(new Error('تعذّر تحميل مشغّل يوتيوب (تحقق من الاتصال)'));
      timer = setTimeout(() => {
        finish(global.YT && global.YT.Player ? null : new Error('انتهت مهلة تحميل يوتيوب — أعد المحاولة'));
      }, 12000);
      document.head.appendChild(s);
    }).catch((err) => {
      ytApiPromise = null;       /* الفشل المؤقت لا يمنع المحاولة التالية */
      throw err;
    });
    return ytApiPromise;
  }

  const S = { IDLE: 0, LOADING: 1, READY: 2, ERROR: 3 };

  /** @param {object} opts { onReady, onStateChange, onTime, onEvent(type) } */
  function UnifiedPlayer(container, opts) {
    this.el = container;
    this.opts = opts || {};
    this.kind = null;
    this.target = null;
    this.state = S.IDLE;
    this._yt = null;
    this._video = null;
    this._hls = null;
    this._iframe = null;
    this._muted = false;
    this._loadVersion = 0;
    this._pendingLoad = null;
    this._cancelLoad = null;
  }

  UnifiedPlayer.prototype.isReady = function () { return this.state === S.READY; };
  UnifiedPlayer.prototype.canSync = function () {
    return this.kind === 'youtube' || this.kind === 'html5' || this.kind === 'file' || this.kind === 'hls';
  };

  UnifiedPlayer.prototype._fire = function (name, data) {
    const fn = this.opts[name];
    if (fn) { try { fn(data); } catch (e) { console.error(e); } }
  };

  UnifiedPlayer.prototype._setLoading = function (show, text, error) {
    /* منفصلة عن طبقة السماح بالتشغيل التلقائي التي تنشئها صفحة الغرفة. */
    let ov = this.el.querySelector('.player__overlay--loading');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'player__overlay player__overlay--loading';
      ov.innerHTML = '<div class="player__overlay-box"><span class="spinner"></span>' +
        '<p class="player__overlay-text" role="status"></p>' +
        '<button type="button" class="btn btn--primary player__retry" hidden>إعادة المحاولة</button></div>';
      ov.querySelector('.player__retry').addEventListener('click', (e) => {
        e.stopPropagation();
        this._fire('onEvent', { type: 'retry', source: 'player' });
      });
      this.el.appendChild(ov);
    }
    ov.querySelector('.player__overlay-text').textContent = text || '';
    ov.querySelector('.spinner').hidden = !!error;
    ov.querySelector('.player__retry').hidden = !error;
    ov.classList.toggle('is-hidden', !show);
  };

  UnifiedPlayer.prototype._clear = function () {
    this._loadVersion++;
    if (this._cancelLoad) this._cancelLoad();
    this._pendingLoad = null;
    const video = this._video;
    this._video = null;          /* تجاهل أحداث pause/error المتأخرة للمصدر السابق */
    try { this._hls && this._hls.destroy(); } catch (e) { }
    this._hls = null;
    try { this._yt && this._yt.destroy && this._yt.destroy(); } catch (e) { }
    this._yt = null;
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { }
    }
    this._iframe = null;
    this.el.querySelectorAll('.player__frame, .player__placeholder').forEach(n => n.remove());
    this.state = S.IDLE;
  };

  /** تحميل واحد مشترك للمصدر نفسه؛ كل محاولة لها مهلة وتجاهل لأحداث المصدر السابق. */
  UnifiedPlayer.prototype.load = function (parsed, opts) {
    opts = opts || {};
    if (!parsed) return Promise.reject(new Error('رابط غير صالح'));
    const target = parsed.kind === 'youtube' ? parsed.id : parsed.src;
    if (this.kind === parsed.kind && this.target === target) {
      if (this.state === S.READY) return Promise.resolve(this);
      if (this.state === S.LOADING && this._pendingLoad) return this._pendingLoad;
    }

    this._clear();
    this.kind = parsed.kind;
    this.target = target;
    this.state = S.LOADING;
    this._setLoading(true, 'جارٍ تحميل المشغّل…');
    const version = this._loadVersion;
    const current = () => version === this._loadVersion;

    this._pendingLoad = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => { clearTimeout(timer); this._cancelLoad = null; };
      this._cancelLoad = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error('تم تغيير مصدر الفيديو');
        err.code = 'load-cancelled';
        reject(err);
      };
      const ready = () => {
        if (!current() || settled) return;
        settled = true;
        cleanup();
        this.state = S.READY;
        this._setLoading(false);
        this._fire('onReady', { kind: this.kind });
        resolve(this);
      };
      const fail = (err) => {
        if (!current() || this.state === S.ERROR) return;
        this.state = S.ERROR;
        this._setLoading(true, err.message || 'تعذّر تحميل الفيديو', true);
        this._fire('onEvent', { type: 'error', source: 'player', message: err.message });
        if (!settled) { settled = true; cleanup(); reject(err); }
      };
      timer = setTimeout(() => fail(new Error('انتهت مهلة تحميل الفيديو — تحقق من الرابط أو أعد المحاولة')), opts.timeoutMs || 15000);
      const load = { current, ready, fail };
      try {
        if (parsed.kind === 'youtube') this._loadYouTube(parsed, opts, load);
        else if (parsed.kind === 'file') this._buildVideo(parsed.src, opts, load);
        else if (parsed.kind === 'hls') this._loadHls(parsed, opts, load);
        else this._loadEmbed(parsed, load);
      } catch (err) { fail(err); }
    });
    return this._pendingLoad;
  };

  /* ---------- YouTube ---------- */
  UnifiedPlayer.prototype._loadYouTube = function (parsed, opts, load) {
    loadYouTubeApi().then((YT) => {
      if (!load.current() || this.state !== S.LOADING) return;
      const holder = document.createElement('div');
      holder.className = 'player__frame';
      this.el.appendChild(holder);
      this._yt = new YT.Player(holder, {
        videoId: parsed.id,
        playerVars: {
          autoplay: opts.autoplay ? 1 : 0,
          controls: opts.controls === false ? 0 : 1,
          rel: 0, modestbranding: 1, playsinline: 1,
          origin: location.origin, enablejsapi: 1
        },
        events: {
          onReady: () => {
            if (!load.current()) return;
            this.setMuted(this._muted);
            load.ready();
          },
          onStateChange: (e) => {
            if (!load.current() || !this.isReady()) return;
            const map = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
            this._fire('onEvent', { type: map[e.data] || 'unknown', source: 'player' });
            if (e.data === 1) this._fire('onStateChange', { playing: true });
            if (e.data === 2) this._fire('onStateChange', { playing: false });
            if (e.data === 0) this._fire('onStateChange', { playing: false, ended: true });
          },
          onAutoplayBlocked: () => {
            if (load.current()) this._fire('onEvent', { type: 'autoplay-blocked', source: 'player' });
          },
          onError: (e) => load.fail(new Error('تعذّر تشغيل فيديو يوتيوب (رمز ' + e.data + ') — قد يكون خاصاً أو يمنع التضمين'))
        }
      });
    }).catch(load.fail);
  };

  /* ---------- HTML5 (MP4/WebM) ---------- */
  UnifiedPlayer.prototype._makeVideoEl = function (opts) {
    const wrap = document.createElement('div');
    wrap.className = 'player__frame';
    const v = document.createElement('video');
    v.className = 'player__video';
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.controls = opts.controls !== false;
    v.muted = this._muted;
    /* تشغيل ملف بعيد لا يحتاج CORS. فرض crossOrigin=anonymous كان يمنع
       ملفات MP4 صالحة؛ CORS مطلوب فقط لطلبات HLS عبر hls.js. */
    wrap.appendChild(v);
    this.el.appendChild(wrap);
    this._video = v;
    this._wireVideo(v);
    return v;
  };

  UnifiedPlayer.prototype._watchVideo = function (video, load) {
    video.addEventListener('loadedmetadata', load.ready, { once: true });
    video.addEventListener('error', () => load.fail(new Error('تعذّر تحميل ملف الفيديو — تحقق من الرابط وصيغة الفيديو')), { once: true });
  };

  UnifiedPlayer.prototype._buildVideo = function (src, opts, load) {
    const v = this._makeVideoEl(opts);
    this._watchVideo(v, load);       /* اربط الأحداث قبل src/load حتى للملفات المخزنة */
    v.src = src;
    v.load();
  };

  /* ---------- HLS ---------- */
  UnifiedPlayer.prototype._loadHls = function (parsed, opts, load) {
    const video = this._makeVideoEl(opts);
    this._watchVideo(video, load);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = parsed.src;         /* Safari: مشغّل أصلي، عنصر فيديو واحد فقط */
      video.load();
      return;
    }
    const Hls = global.Hls;
    if (!Hls || !Hls.isSupported || !Hls.isSupported()) {
      load.fail(new Error('متصفحك لا يدعم بث HLS — جرّب متصفحاً حديثاً'));
      return;
    }
    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 60 });
    this._hls = hls;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data && data.fatal) load.fail(new Error('تعذّر تحميل البث — تحقق من الرابط وسماح الخادم بـ CORS (' + (data.details || data.type) + ')'));
    });
    hls.attachMedia(video);
    hls.loadSource(parsed.src);
  };

  UnifiedPlayer.prototype._wireVideo = function (v) {
    const fire = (name, data) => { if (this._video === v) this._fire(name, data); };
    v.addEventListener('play', () => fire('onStateChange', { playing: true }));
    v.addEventListener('playing', () => fire('onEvent', { type: 'playing', source: 'player' }));
    v.addEventListener('pause', () => { if (!v.ended) fire('onStateChange', { playing: false }); });
    v.addEventListener('ended', () => fire('onStateChange', { playing: false, ended: true }));
    v.addEventListener('waiting', () => fire('onEvent', { type: 'buffering', source: 'player' }));
    v.addEventListener('seeked', () => fire('onEvent', { type: 'seeked', source: 'player' }));
    v.addEventListener('timeupdate', () => fire('onTime', { t: v.currentTime }));
  };

  /* ---------- iframe ---------- */
  UnifiedPlayer.prototype._loadEmbed = function (parsed, load) {
    const wrap = document.createElement('div');
    wrap.className = 'player__frame';
    const f = document.createElement('iframe');
    f.className = 'player__iframe';
    f.title = 'مشغّل الفيديو المضمّن';
    f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.addEventListener('load', load.ready, { once: true });
    f.addEventListener('error', () => load.fail(new Error('تعذّر تحميل المشغّل المضمّن — قد يمنع الموقع التضمين')), { once: true });
    f.src = parsed.src;
    wrap.appendChild(f);
    this.el.appendChild(wrap);
    this._iframe = f;
  };

  /* ---------- واجهة التحكم الموحّدة ---------- */
  UnifiedPlayer.prototype.play = function () {
    try {
      if (this._yt && this._yt.playVideo) this._yt.playVideo();
      else if (this._video) {
        const video = this._video;
        return Promise.resolve(video.play()).then(() => true, (err) => {
          if (this._video === video) this._fire('onEvent', {
            type: err.name === 'NotAllowedError' ? 'autoplay-blocked' : 'error', source: 'player', message: err.message
          });
          return false;
        });
      }
    } catch (e) { this._fire('onEvent', { type: 'error', source: 'player', message: e.message }); }
  };
  UnifiedPlayer.prototype.pause = function () {
    try {
      if (this._yt && this._yt.pauseVideo) this._yt.pauseVideo();
      else if (this._video) this._video.pause();
    } catch (e) { }
  };
  UnifiedPlayer.prototype.seek = function (sec) {
    try {
      if (this._yt && this._yt.seekTo) this._yt.seekTo(Math.max(0, sec), true);
      else if (this._video) this._video.currentTime = Math.max(0, sec);
    } catch (e) { }
  };
  UnifiedPlayer.prototype.getCurrentTime = function () {
    try {
      if (this._yt && this._yt.getCurrentTime) return this._yt.getCurrentTime() || 0;
      if (this._video) return this._video.currentTime || 0;
    } catch (e) { }
    return 0;
  };
  UnifiedPlayer.prototype.getDuration = function () {
    try {
      if (this._yt && this._yt.getDuration) return this._yt.getDuration() || 0;
      if (this._video) return this._video.duration || 0;
    } catch (e) { }
    return 0;
  };
  UnifiedPlayer.prototype.isPlaying = function () {
    try {
      if (this._yt && this._yt.getPlayerState) return this._yt.getPlayerState() === 1;
      if (this._video) return !this._video.paused && !this._video.ended;
    } catch (e) { }
    return false;
  };
  UnifiedPlayer.prototype.setMuted = function (m) {
    this._muted = !!m;
    try {
      if (this._yt) m ? this._yt.mute() : this._yt.unMute();
      if (this._video) this._video.muted = !!m;
    } catch (e) { }
  };
  UnifiedPlayer.prototype.isMuted = function () { return this._muted; };
  UnifiedPlayer.prototype.setVolume = function (v) {
    try {
      if (this._yt && this._yt.setVolume) this._yt.setVolume(Math.round(U.clamp(v, 0, 1) * 100));
      if (this._video) this._video.volume = U.clamp(v, 0, 1);
    } catch (e) { }
  };

  UnifiedPlayer.thumbFor = function (ytId) {
    return ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null;
  };

  global.WTPlayer = { UnifiedPlayer, loadYouTubeApi, STATE: S };
})(window);

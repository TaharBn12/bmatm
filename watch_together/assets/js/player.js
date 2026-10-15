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
      global.onYouTubeIframeAPIReady = function () {
        try { prev && prev(); } catch (e) { }
        resolve(global.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => reject(new Error('تعذّر تحميل مشغّل يوتيوب (تحقق من الاتصال)'));
      document.head.appendChild(s);
      setTimeout(() => {
        (global.YT && global.YT.Player) ? resolve(global.YT) : reject(new Error('انتهت مهلة تحميل يوتيوب'));
      }, 12000);
    });
    return ytApiPromise;
  }

  /* حالة المشغّل الموحّدة */
  const S = { IDLE: 0, LOADING: 1, READY: 2, ERROR: 3 };

  /**
   * @param {HTMLElement} container  عنصر الحاوية (يُملأ بالمشغّل)
   * @param {object} opts { onReady, onStateChange, onTime, onEvent(type) }
   */
  function UnifiedPlayer(container, opts) {
    this.el = container;
    this.opts = opts || {};
    this.kind = null;          /* youtube | html5 | hls | embed */
    this.target = null;        /* رابط/معرّف当前 */
    this.state = S.IDLE;
    this._yt = null;
    this._video = null;
    this._hls = null;
    this._iframe = null;
    this._muted = false;
    this._eventsWired = false;
  }

  UnifiedPlayer.prototype.isReady = function () { return this.state === S.READY; };
  /* ملاحظة مهمة: `file` هو اسم النوع الذي يأتي من util.parseWatchUrl لملفات
     mp4/webm، وهو يُحمَّل عبر مشغّل HTML5 — فلابد أن يُعتبر قابلاً للمزامنة،
     وإلا توقّفت مزامنة الموضع تماماً لكل من يشارك رابط ملف فيديو مباشر. */
  UnifiedPlayer.prototype.canSync = function () {
    return this.kind === 'youtube' || this.kind === 'html5' || this.kind === 'file' || this.kind === 'hls';
  };

  UnifiedPlayer.prototype._fire = function (name, data) {
    const fn = this.opts[name];
    if (fn) { try { fn(data); } catch (e) { console.error(e); } }
  };

  UnifiedPlayer.prototype._setLoading = function (show, text) {
    let ov = this.el.querySelector('.player__overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'player__overlay';
      ov.innerHTML = `<div class="player__overlay-box"><span class="spinner"></span><p class="player__overlay-text"></p></div>`;
      this.el.appendChild(ov);
    }
    ov.querySelector('.player__overlay-text').textContent = text || '';
    ov.classList.toggle('is-hidden', !show);
  };

  UnifiedPlayer.prototype._clear = function () {
    try { this._hls && this._hls.destroy(); } catch (e) { }
    this._hls = null;
    try { this._yt && this._yt.destroy && this._yt.destroy(); } catch (e) { }
    this._yt = null;
    if (this._video) { try { this._video.pause(); } catch (e) { } this._video.remove(); this._video = null; }
    if (this._iframe) { this._iframe.remove(); this._iframe = null; }
    this.el.querySelectorAll('.player__placeholder').forEach(n => n.remove());
    this.state = S.IDLE;
  };

  /** تحميل مصدر جديد */
  UnifiedPlayer.prototype.load = function (parsed, opts) {
    opts = opts || {};
    if (!parsed) return Promise.reject(new Error('رابط غير صالح'));
    const sameTarget = this.kind === parsed.kind &&
      this.target === (parsed.kind === 'youtube' ? parsed.id : parsed.src);
    if (sameTarget && this.state !== S.ERROR) return Promise.resolve(this);

    this._clear();
    this.kind = parsed.kind;
    this.target = parsed.kind === 'youtube' ? parsed.id : parsed.src;
    this._setLoading(true, 'جارٍ تحميل المشغّل…');

    if (parsed.kind === 'youtube') return this._loadYouTube(parsed, opts);
    if (parsed.kind === 'file') return this._loadHtml5(parsed, opts);
    if (parsed.kind === 'hls') return this._loadHls(parsed, opts);
    return this._loadEmbed(parsed, opts);
  };

  /* ---------- YouTube ---------- */
  UnifiedPlayer.prototype._loadYouTube = function (parsed, opts) {
    const self = this;
    this.state = S.LOADING;
    return loadYouTubeApi().then((YT) => new Promise((resolve, reject) => {
      const holder = document.createElement('div');
      holder.className = 'player__frame';
      self.el.appendChild(holder);

      self._yt = new YT.Player(holder, {
        videoId: parsed.id,
        playerVars: {
          autoplay: opts.autoplay ? 1 : 0,
          controls: opts.controls === false ? 0 : 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: location.origin,
          enablejsapi: 1
        },
        events: {
          onReady: () => {
            self.state = S.READY;
            self._setLoading(false);
            self._fire('onReady', { kind: 'youtube' });
            resolve(self);
          },
          onStateChange: (e) => {
            const map = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
            self._fire('onEvent', { type: map[e.data] || 'unknown', source: 'player' });
            if (map[e.data] === 'playing') self._fire('onStateChange', { playing: true });
            if (map[e.data] === 'paused') self._fire('onStateChange', { playing: false });
            if (map[e.data] === 'ended') self._fire('onStateChange', { playing: false, ended: true });
          },
          onError: (e) => {
            self.state = S.ERROR;
            self._setLoading(true, 'تعذّر تشغيل هذا الفيديو على يوتيوب (رمز ' + e.data + ') — قد يكون خاصاً أو محذوفاً');
            self._fire('onEvent', { type: 'error', source: 'player', code: e.data });
            reject(new Error('yt-error-' + e.data));
          }
        }
      });
    })).catch((err) => {
      self.state = S.ERROR;
      self._setLoading(true, String(err && err.message || 'فشل تحميل يوتيوب'));
      throw err;
    });
  };

  /* ---------- HTML5 (mp4/webm) ---------- */
  UnifiedPlayer.prototype._loadHtml5 = function (parsed, opts) {
    return this._buildVideo(parsed.src, opts);
  };

  /* ---------- HLS ---------- */
  UnifiedPlayer.prototype._loadHls = function (parsed, opts) {
    const self = this;
    const ensureHls = (global.Hls && global.Hls.isSupported && global.Hls.isSupported())
      ? Promise.resolve(global.Hls)
      : Promise.reject(new Error('hls-unavailable'));

    return ensureHls.then((Hls) => new Promise((resolve, reject) => {
      const video = self._makeVideoEl(opts);
      const hls = new Hls({ lowLatencyMode: true, backBufferLength: 60 });
      self._hls = hls;
      hls.loadSource(parsed.src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        self.state = S.READY;
        self._setLoading(false);
        self._fire('onReady', { kind: 'hls' });
        resolve(self);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal) return;
        self.state = S.ERROR;
        self._setLoading(true, 'خطأ في البث: ' + (data.details || data.type));
        reject(new Error('hls-error'));
      });
    })).catch(() => {
      /* Safari يشغّل HLS أصلياً */
      const v = document.createElement('video');
      if (v.canPlayType('application/vnd.apple.mpegurl')) return self._buildVideo(parsed.src, opts);
      self.state = S.ERROR;
      self._setLoading(true, 'متصفحك لا يدعم بث HLS — جرّب Chrome أو سيرفر Java');
      return Promise.reject(new Error('hls-unsupported'));
    });
  };

  UnifiedPlayer.prototype._makeVideoEl = function (opts) {
    const self = this;
    const wrap = document.createElement('div');
    wrap.className = 'player__frame';
    const v = document.createElement('video');
    v.className = 'player__video';
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.controls = opts.controls !== false;
    v.crossOrigin = 'anonymous';
    wrap.appendChild(v);
    self.el.appendChild(wrap);
    self._video = v;
    self._wireVideo(v);
    return v;
  };

  UnifiedPlayer.prototype._buildVideo = function (src, opts) {
    const self = this;
    this.state = S.LOADING;
    return new Promise((resolve, reject) => {
      const v = self._makeVideoEl(opts);
      v.src = src;
      v.load();
      const ok = () => {
        self.state = S.READY;
        self._setLoading(false);
        self._fire('onReady', { kind: self.kind });
        resolve(self);
      };
      v.addEventListener('loadedmetadata', ok, { once: true });
      v.addEventListener('error', () => {
        self.state = S.ERROR;
        self._setLoading(true, 'تعذّر تحميل ملف الفيديو — تحقق من الرابط أو من سماح الموقع بـ CORS');
        reject(new Error('video-error'));
      }, { once: true });
      setTimeout(() => { if (self.state === S.LOADING) ok(); }, 8000);
    });
  };

  UnifiedPlayer.prototype._wireVideo = function (v) {
    if (this._eventsWired === v) return;
    this._eventsWired = v;
    const self = this;
    v.addEventListener('play', () => self._fire('onStateChange', { playing: true }));
    v.addEventListener('playing', () => self._fire('onEvent', { type: 'playing', source: 'player' }));
    v.addEventListener('pause', () => { if (!v.ended) self._fire('onStateChange', { playing: false }); });
    v.addEventListener('ended', () => self._fire('onStateChange', { playing: false, ended: true }));
    v.addEventListener('waiting', () => self._fire('onEvent', { type: 'buffering', source: 'player' }));
    v.addEventListener('seeked', () => self._fire('onEvent', { type: 'seeked', source: 'player' }));
    v.addEventListener('timeupdate', () => self._fire('onTime', { t: v.currentTime }));
  };

  /* ---------- iframe (روابط مضمّنة) ---------- */
  UnifiedPlayer.prototype._loadEmbed = function (parsed) {
    const self = this;
    this.state = S.LOADING;
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'player__frame';
      const f = document.createElement('iframe');
      f.src = parsed.src;
      f.className = 'player__iframe';
      f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.addEventListener('load', () => {
        self.state = S.READY;
        self._setLoading(false);
        self._fire('onReady', { kind: 'embed' });
        resolve(self);
      });
      setTimeout(() => { if (self.state !== S.READY) { self.state = S.READY; self._setLoading(false); resolve(self); } }, 6000);
      wrap.appendChild(f);
      self.el.appendChild(wrap);
      self._iframe = f;
    });
  };

  /* ---------- واجهة التحكم الموحّدة ---------- */
  UnifiedPlayer.prototype.play = function () {
    try {
      if (this._yt && this._yt.playVideo) this._yt.playVideo();
      else if (this._video) { const p = this._video.play(); if (p && p.catch) p.catch(() => { }); }
    } catch (e) { }
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

  /* صورة مصغّرة لليوتيوب */
  UnifiedPlayer.thumbFor = function (ytId) {
    return ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null;
  };

  global.WTPlayer = { UnifiedPlayer, loadYouTubeApi, STATE: S };
})(window);

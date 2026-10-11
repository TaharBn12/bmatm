/* =========================================================
   WatchTogether — أدوات عامة (util.js)
   ========================================================= */
(function (global) {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* بدون أحرف/أرقام ملتبسة */

  const Util = {
    /* ---------- معرفات ---------- */
    randomCode(len) {
      len = len || (global.WT_CONFIG && WT_CONFIG.room.codeLength) || 6;
      const a = new Uint32Array(len);
      (global.crypto || {}).getRandomValues
        ? crypto.getRandomValues(a)
        : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 4294967295)));
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[a[i] % ALPHABET.length];
      return s;
    },

    uid(prefix) {
      return (prefix || 'id') + '-' + Util.randomCode(10) + Date.now().toString(36).slice(-4);
    },

    /* ---------- تخزين محلي آمن ---------- */
    store: {
      get(key, fallback) {
        try {
          const v = localStorage.getItem('wt:' + key);
          return v === null ? fallback : JSON.parse(v);
        } catch (e) { return fallback; }
      },
      set(key, value) {
        try { localStorage.setItem('wt:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
      },
      del(key) { try { localStorage.removeItem('wt:' + key); } catch (e) { /* ignore */ } }
    },

    /* ---------- وقت ---------- */
    now() { return Date.now(); },

    fmtTime(sec) {
      if (!isFinite(sec) || sec < 0) sec = 0;
      sec = Math.floor(sec);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const p = (n) => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
    },

    fmtClock(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' });
    },

    /* ---------- نص ---------- */
    esc(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* تحويل الروابط داخل الرسائل إلى روابط قابلة للنقر (بعد التهريب) */
    linkify(escaped) {
      return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?"')\]])/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    },

    initials(name) {
      const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
      return parts.map(p => p[0] ? p[0].toUpperCase() : '').join('') || '?';
    },

    /* لون ثابت لكل اسم (لصور المشاركين والرسائل) */
    colorFor(seed) {
      const palette = ['#7c5cff', '#00d4ff', '#ff4d8d', '#ffb020', '#2dd4a7', '#ff6b4a', '#a78bfa', '#4ade80'];
      let h = 0;
      const s = String(seed || 'x');
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return palette[h % palette.length];
    },

    /* ---------- روابط المشاهدة ---------- */
    /* يعيد: {kind, id?, src?, provider, label} */
    parseWatchUrl(raw) {
      const url = String(raw || '').trim();
      if (!url) return null;

      /* 1) YouTube */
      const yt = Util.parseYouTube(url);
      if (yt) return { kind: 'youtube', id: yt, src: url, provider: 'YouTube', label: 'يوتيوب' };

      /* 2) HLS */
      if (/\.m3u8(\?|$)/i.test(url)) return { kind: 'hls', src: url, provider: 'HLS', label: 'بث HLS' };

      /* 3) ملفات فيديو مباشرة */
      if (/\.(mp4|webm|ogv|ogg|mov|m4v)(\?|$)/i.test(url)) return { kind: 'file', src: url, provider: 'MP4', label: 'ملف فيديو' };

      /* 4) روابط تضمين جاهزة (iframe) — تويتش/ديلي موشن/فيميو/أي embed */
      if (/^https?:\/\//i.test(url) && /(player\.|\/embed\/|embed\.|clips\.twitch|dailymotion|vimeo|kick\.com\/.*\/embed)/i.test(url)) {
        return { kind: 'embed', src: url, provider: 'Embed', label: 'مشغّل مضمَّن' };
      }

      /* 5) أي رابط http آخر → نحاول تضمينه كـ iframe */
      if (/^https?:\/\//i.test(url)) return { kind: 'embed', src: url, provider: 'Link', label: 'رابط خارجي' };

      return null;
    },

    parseYouTube(url) {
      const s = String(url || '').trim();
      if (!s) return null;
      /* معرف مباشر: 11 حرفاً */
      if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
      let m;
      m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/i);
      if (m) return m[1];
      m = s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
      if (m) return m[1];
      return null;
    },

    /* ---------- الحافظة ---------- */
    async copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fallback */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    },

    /* ---------- واجهة ---------- */
    toast(msg, type, ms) {
      type = type || 'info';
      let host = document.getElementById('toastHost');
      if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.className = 'toast-host';
        document.body.appendChild(host);
      }
      const el = document.createElement('div');
      el.className = 'toast toast--' + type;
      el.innerHTML = `<span class="toast__icon">${
        type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warn' ? '!' : 'i'
      }</span><span class="toast__text">${Util.esc(msg)}</span>`;
      host.appendChild(el);
      requestAnimationFrame(() => el.classList.add('is-in'));
      setTimeout(() => {
        el.classList.remove('is-in');
        setTimeout(() => el.remove(), 320);
      }, ms || 3200);
    },

    qs(name) {
      return new URLSearchParams(location.search).get(name);
    },

    debounce(fn, wait) {
      let t; return function () {
        const args = arguments, ctx = this;
        clearTimeout(t); t = setTimeout(() => fn.apply(ctx, args), wait);
      };
    },

    clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },

    /* تنظيف اسم المستخدم */
    cleanName(name) {
      return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    }
  };

  global.WTUtil = Util;
})(window);

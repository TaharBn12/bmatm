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

    /** مفتاح عشوائي عالي العشوائية لصلاحية الغرفة، لا يوضع في رابط الدعوة */
    randomToken(bytes) {
      const n = Math.max(24, Math.min(64, Number(bytes) || 32));
      const data = new Uint8Array(n);
      if (!global.crypto || typeof global.crypto.getRandomValues !== 'function') {
        throw new Error('يلزم مولّد عشوائي آمن لإنشاء مفتاح الغرفة');
      }
      global.crypto.getRandomValues(data);
      return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
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
      const palette = ['#c5a572', '#b67a3b', '#d4a574', '#e8b86a', '#8fa8c4', '#d47a7a', '#a99bd4', '#7fc0a0'];
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

    /**
     * الوقت المتوقع «الآن» انطلاقاً من آخر حالة مزامنة محفوظة.
     * بهذه الطريقة من ينضم متأخراً (أو من يعود بعد غياب) يأخذ وقت الموجودين
     * ولا يبدأ من الصفر.
     *
     * @param {number} pos   الموضع المحفوظ (ثوانٍ)
     * @param {boolean} playing هل كان الفيديو يعمل؟
     * @param {number} stateT الختم الزمني للحالة المحفوظة (مللي ثانية)
     * @param {number} now    الوقت الحالي (مللي ثانية)
     * @param {number} [maxAgeSec] أقصى انقضاء يُحتسب (افتراضي 3 ساعات)
     * @returns {number} الموضع المتوقع بالثواني
     */
    expectedPosition(pos, playing, stateT, now, maxAgeSec) {
      const p0 = Math.max(0, Number.isFinite(+pos) ? +pos : 0);
      if (!playing) return p0;
      const cap = Number.isFinite(+maxAgeSec) ? +maxAgeSec : 3 * 3600;
      const ageSec = Math.max(0, ((+now || 0) - (+stateT || 0)) / 1000);
      return p0 + Math.min(ageSec, cap);
    },

    /* تنظيف اسم المستخدم */
    cleanName(name) {
      return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    },

    /* =========================================================
       ترتيب تحديثات المزامنة (ساعة منطقية — Lamport clock)
       ---------------------------------------------------------
       المشكلة التي تحلّها: كل عميل كان يزيد `rev` انطلاقاً من
       نسخته الخاصة، فإذا بثّ عميلان حالةً في نفس اللحظة ينتج
       عنهما نفس الرقم التسلسلي → يرفض كلٌّ منهما تحديث الآخر
       للأبد، فيبدو الوضع وكأن كل واحد «في غرفة لوحده».

       الحل: ترتيب حتمي يتّفق عليه الجميع:
         1) الرقم التسلسلي الأكبر يفوز
         2) عند التساوي يفوز صاحب المعرّف (updatedBy) الأكبر
         3) نفس المرسل بنفس الرقم = تحديث مكرّر ← يُرفض
       ========================================================= */

    /** الرقم التسلسلي التالي: دائماً أكبر من كل ما رآه العميل */
    nextRev() {
      let max = 0;
      for (let i = 0; i < arguments.length; i++) {
        const v = +arguments[i];
        if (Number.isFinite(v) && v > max) max = v;
      }
      return max + 1;
    },

    /**
     * هل الحالة «الواردة» أحدث من الحالة «الحالية»؟
     * @param {{rev:number, updatedBy?:string}} incoming
     * @param {{rev:number, updatedBy?:string}} current
     */
    stateWins(incoming, current) {
      const a = incoming || {}, b = current || {};
      if (!Number.isFinite(+a.rev)) return false;
      const ra = +a.rev, rb = Number.isFinite(+b.rev) ? +b.rev : -1;
      if (ra !== rb) return ra > rb;
      const ua = String(a.updatedBy || a.hostId || '');
      const ub = String(b.updatedBy || b.hostId || '');
      if (ua === ub) return false;          /* نفس المرسل = مكرّر */
      return ua > ub;                       /* كسر تعادل حتمي */
    },

    /** بصمة خفيفة للمقارنة: هل تغيّرت الحالة فعلاً؟ (تفادي إعادة بثّ نفس الحالة) */
    stateSig(s) {
      s = s || {};
      return [
        Number.isFinite(+s.rev) ? +s.rev : 0,
        s.updatedBy || s.hostId || '',
        s.playing ? '1' : '0',
        (Number.isFinite(+s.pos) ? +s.pos : 0).toFixed(2),
        s.url || ''
      ].join('|');
    }
  };

  global.WTUtil = Util;
})(window);

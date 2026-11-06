/* =========================================================
   WatchTogether — فحص سيرفر Java المشترك (server-probe.js)
   ---------------------------------------------------------
   المشكلة: على Render (الخطة المجانية) ينام السيرفر بعد 15 دقيقة
   خمول، وأول طلب يستغرق عشرات الثواني. كنّا نفحص السيرفر بمهلة
   2.5 ثانية، فتفشل قبل أن يستيقظ، فيسقط الموقع إلى Supabase ثم
   إلى «الوضع المحلي» — فيصير كل صديق في عالم مختلف، ولا يجتمع
   الأصدقاء في غرفة واحدة.

   الحل: فحص واحد مشترك (/healthz) بمهلة سخية ونتيجة مخزّنة،
   يستخدمة **اكتشاف الواجهة الخلفية** (rooms.js) و**اتصال الغرفة**
   (transport.js) — فيتّخذ الاثنان نفس القرار دائماً.

   لماذا /healthz تحديداً؟ لأنه:
     • أخفّ نقطة في السيرفر (نص "ok")،
     • وهو نفس الطلب الذي يوقظ النسخة النائمة على Render،
     • وجسمه "ok" فقط، فلا يخدعنا ردّ 200 من استضافة ثابتة
       تعيد index.html لأي مسار (سلوك SPA الشائع).
   ========================================================= */
(function (global) {
  'use strict';

  var cache = { value: null, at: 0, promise: null };
  var TTL = 60000;                    /* تذكّر النتيجة دقيقة واحدة */

  function privateHost() {
    try {
      var h = String(global.location.hostname || '');
      return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|\[::1\])/i.test(h);
    } catch (e) { return false; }
  }

  function forcedLocal() {
    try {
      return /[?&]local=1\b/.test(global.location.search) ||
             global.localStorage.getItem('wt:forceLocal') === '1';
    } catch (e) { return false; }
  }

  function javaEnabled() {
    var cfg = global.WT_CONFIG;
    return !!(cfg && cfg.javaServer && cfg.javaServer.enabled !== false);
  }

  /**
   * عنوان نقطة على السيرفر.
   * إن ضُبط javaServer.apiBase فالموقع على نطاق آخر (GitHub Pages مثلاً)
   * والسيرفر على Render — فنحتاج عنواناً مطلقاً، وإلا نستخدم النسبي.
   */
  function configuredBase() {
    var cfg = global.WT_CONFIG;
    var base = cfg && cfg.javaServer && cfg.javaServer.apiBase;
    if (base) return String(base);
    /* تجاوز سريع للتجربة على استضافة ثابتة (GitHub Pages) دون تعديل الملفات:
         ?api=https://watchtogether-xxxx.onrender.com
       أو: localStorage.setItem('wt:apiBase', 'https://...') */
    try {
      var q = new global.URLSearchParams(global.location.search).get('api');
      if (q && /^https?:\/\//i.test(q)) return q;
      var stored = global.localStorage.getItem('wt:apiBase');
      if (stored && /^https?:\/\//i.test(stored)) return stored;
    } catch (e) { /* تخزين أو URLSearchParams محجوب */ }
    return null;
  }

  function apiUrl(path) {
    var base = configuredBase();
    if (!base) return path;
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  /**
   * عنوان فحص «هل هناك سيرفر يستضيف **الغرف**؟».
   * الغرف عبر WebSocket على **نفس النطاق** الذي يخدم الصفحة، فالفحص يكون
   * نسبيّاً دائماً. أما `apiBase` (سيرفر بحث/استخراج على نطاق آخر) فلا يخدم
   * الغرف، فلا يجعلنا نظنّ أن هناك سيرفر غرف — وإلا أرسلنا الغرف إلى
   * WebSocket على github.io!
   * استثناء واحد: إن ضُبط `javaServer.url` (عنوان WebSocket صريح) فالغرف تذهب
   * إلى ذاك السيرفر، فنفحصه هناك.
   */
  function roomsProbeUrl() {
    var cfg = global.WT_CONFIG;
    var js = (cfg && cfg.javaServer) || {};
    if (!js.url) return 'healthz';                 /* الغرف إن وُجدت فهي على نفس النطاق */
    var base = js.apiBase ? String(js.apiBase) : '';
    if (!base) {
      try {
        var u = new global.URL(js.url, global.location.href);
        base = (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host;
      } catch (e) { base = ''; }
    }
    return base ? String(base).replace(/\/+$/, '') + '/healthz' : 'healthz';
  }

  function probeMs() {
    var cfg = global.WT_CONFIG;
    var v = cfg && cfg.javaServer && cfg.javaServer.probeMs;
    return typeof v === 'number' && v > 0 ? v : 30000;
  }

  function run(url, timeoutMs) {
    var settled = false;
    return new Promise(function (resolve) {
      var finish = function (value) {
        if (settled) return;
        settled = true;
        cache.value = value;
        cache.at = Date.now();
        cache.promise = null;
        resolve(value);
      };
      var timer = global.setTimeout(function () { finish(false); }, timeoutMs);
      var fail = function () { global.clearTimeout(timer); finish(false); };
      global.fetch(url, { cache: 'no-store', headers: { Accept: 'text/plain' } }).then(
        function (response) {
          if (!response || !response.ok) return fail();
          return response.text().then(function (text) {
            global.clearTimeout(timer);
            finish(String(text || '').trim().toLowerCase() === 'ok');
          }, fail);
        },
        fail
      );
    });
  }

  /* نبضة إبقاء: تمنع الخدمة المجانية على Render من النوم أثناء المشاهدة.
     Render ينام بعد 15 دقيقة **بلا أي حركة داخلة** — ورسائل WebSocket
     تُحسب، لكن نبضة HTTP كل 10 دقائق تضمن الحركة حتى لو خُفِّضت مؤقّتات
     التبويب في الخلفية، وهي أخفّ من أن تُذكر (نص "ok"). */
  var keepTimer = null;

  function keepAliveMs() {
    var cfg = global.WT_CONFIG;
    var v = cfg && cfg.javaServer && cfg.javaServer.keepAliveMs;
    return typeof v === 'number' && v > 0 ? v : 600000;   /* 10 دقائق */
  }

  function ping() {
    try { global.fetch(apiUrl('healthz'), { cache: 'no-store' }).catch(function () { }); } catch (e) { }
  }

  global.WTServer = {
    isPrivateHost: privateHost,

    /**
     * عنوان الـ API **الفعلي** بعد كل التجاوزات
     * (config.js ← ?api=… ← localStorage). تحتاجه الصفحات لتشرح للمستخدم
     * «أي عنوان جرّبنا فعلاً؟» بدل أن تعيد قراءة config.js وحده فتقول
     * «لا يوجد سيرفر» وهو يجرّب ?api= أمام عينيه.
     */
    apiBase: function () { return configuredBase(); },

    /**
     * نبضة إبقاء اختيارية: ابدأها بعد نجاح الاتصال بسيرفر Java على
     * استضافة عامة، وأوقفها عند مغادرة الغرفة.
     */
    keepAlive: function (on) {
      if (!on) {
        if (keepTimer) { global.clearInterval(keepTimer); keepTimer = null; }
        return;
      }
      if (keepTimer || privateHost()) return;      /* على جهازك لا داعي لها */
      ping();
      keepTimer = global.setInterval(ping, keepAliveMs());
    },

    /**
     * هل سيرفر Java يستجيب من نفس النطاق؟
     * @param {(s:{state:string,detail:string})=>void} [onStatus] لتحديث واجهة الحالة
     * @returns {Promise<boolean>}
     */
    /** عنوان نقطة API (مطلق إن كان السيرفر على نطاق آخر) */
    api: apiUrl,

    available: function (onStatus) {
      if (forcedLocal() || !javaEnabled()) return Promise.resolve(false);
      if (typeof cache.value === 'boolean' && Date.now() - cache.at < TTL) return Promise.resolve(cache.value);
      if (cache.promise) return cache.promise;
      if (onStatus) {
        onStatus({
          state: 'connecting',
          detail: privateHost()
            ? 'جارٍ فحص السيرفر…'
            : 'جارٍ إيقاظ السيرفر… قد يستغرق حتى دقيقة في الخطة المجانية'
        });
      }
      cache.promise = run(roomsProbeUrl(), probeMs());
      return cache.promise;
    },

    /** انسَ النتيجة المخزّنة (مثلاً بعد تغيير الإعدادات) */
    forget: function () { cache.value = null; cache.at = 0; cache.promise = null; }
  };
})(window);

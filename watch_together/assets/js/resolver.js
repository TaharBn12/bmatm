/* Same-origin extraction, with cancellable accessible progress dialog. */
(function () {
  'use strict';
  window.WTResolve = async function (raw, opts) {
    opts = opts || {};
    const parsed = WTUtil.parseWatchUrl(raw);
    if (!parsed) throw new Error('أدخل رابط فيديو صالحاً');
    /* قوائم التشغيل تُستخرج عبر الخادم حتى لو لم تكن من نوع embed. */
    if (parsed.kind === 'youtube-playlist') {
      const dialog = document.createElement('dialog');
      dialog.className = 'resolve-dialog glass';
      dialog.innerHTML = '<h2>تجهيز قائمة التشغيل</h2><p role="status"><span class="spinner"></span> جارٍ قراءة قائمة التشغيل…</p><p>قد يستغرق ذلك حتى 40 ثانية. لا تغلق الصفحة.</p><button type="button" class="btn btn--ghost">إلغاء</button>';
      document.body.append(dialog);
      const ctrl = new AbortController();
      const cancel = () => ctrl.abort();
      dialog.querySelector('button').onclick = cancel;
      dialog.addEventListener('cancel', cancel);
      const timer = setTimeout(cancel, 45000);
      dialog.showModal();
      try {
        const endpoint = (window.WTServer && window.WTServer.api) ? window.WTServer.api('api/resolve') : 'api/resolve';
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: raw, playlist: true, quality: opts.quality || '720' }), signal: ctrl.signal });
        if (response.status === 426) {
          throw new Error('السيرفر ' + String(endpoint).replace(/\/api\/resolve$/, '') +
            ' ردّ 426 Upgrade Required — أي أنه لا يخدم طلبات HTTP (خدمة WebSocket أو عنوان خدمة أخرى). ' +
            'انسخ عنوان خدمتك من لوحة Render وجرّبه بـ ?api=<العنوان>.');
        }
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('الاستخراج يحتاج خادم Java مع yt-dlp؛ الاستضافة الثابتة وحدها لا تكفي'); }
        if (!response.ok || !data.playlist || !Array.isArray(data.items) || !data.items.length) throw new Error(data.error || 'تعذّر قراءة قائمة التشغيل');
        return { parsed: { kind: 'youtube-playlist', id: parsed.id, src: raw, provider: 'YouTube', label: 'قائمة تشغيل يوتيوب' }, playlist: data.items, sourceUrl: raw, count: data.count };
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('أُلغي الطلب أو انتهت مهلة الانتظار؛ يمكنك إعادة المحاولة');
        throw e;
      } finally { clearTimeout(timer); dialog.close(); dialog.remove(); }
    }
    if (parsed.kind !== 'embed') return { parsed, title: '' };
    const dialog = document.createElement('dialog');
    dialog.className = 'resolve-dialog glass';
    dialog.innerHTML = '<h2>تجهيز المشاهدة</h2><p role="status"><span class="spinner"></span> جارٍ استخراج رابط الفيديو…</p><p>قد يستغرق ذلك حتى 40 ثانية. لا تغلق الصفحة.</p><button type="button" class="btn btn--ghost">إلغاء</button>';
    document.body.append(dialog);
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    dialog.querySelector('button').onclick = cancel;
    dialog.addEventListener('cancel', cancel);
    const timer = setTimeout(cancel, 45000);
    dialog.showModal();
    try {
      const endpoint = (window.WTServer && window.WTServer.api) ? window.WTServer.api('api/resolve') : 'api/resolve';
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: raw, quality: opts.quality || '720' }), signal: ctrl.signal });
      if (response.status === 426) {   /* العنوان لا يخدم HTTP: ليس سيرفر API */
        throw new Error('السيرفر ' + String(endpoint).replace(/\/api\/resolve$/, '') +
          ' ردّ 426 Upgrade Required — أي أنه لا يخدم طلبات HTTP (خدمة WebSocket أو عنوان خدمة أخرى). ' +
          'انسخ عنوان خدمتك من لوحة Render وجرّبه بـ ?api=<العنوان>.');  
      }
      let data;
      try { data = await response.json(); } catch (_) {
        const js = window.WT_CONFIG && window.WT_CONFIG.javaServer;
        const host = String(location.hostname || '');
        const mine = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
        throw new Error('الاستخراج يحتاج خادم Java مع yt-dlp؛ الاستضافة الثابتة وحدها لا تكفي' +
          (!mine && !(js && js.apiBase) ? ' — اضبط javaServer.apiBase بعنوان سيرفر Render في assets/js/config.js' : ''));
      }
      if (!response.ok || !data.url) throw new Error(data.error || 'تعذّر تجهيز الفيديو');
      const url = new URL(data.url);
      if (url.protocol !== 'https:') throw new Error('رابط تشغيل غير آمن');
      // Signed CDN links without extensions are still media, not iframe pages.
      if (!/\.(mp4|webm|m3u8)(\?|$)/i.test(url.href)) url.hash = 'video.mp4';
      return { parsed: { src: url.href }, title: data.title || '', sourceUrl: raw };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('أُلغي الطلب أو انتهت مهلة الانتظار؛ يمكنك إعادة المحاولة');
      throw e;
    } finally { clearTimeout(timer); dialog.close(); dialog.remove(); }
  };
})();

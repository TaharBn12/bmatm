/* Same-origin extraction, with cancellable accessible progress dialog. */
(function () {
  'use strict';
  window.WTResolve = async function (raw) {
    const parsed = WTUtil.parseWatchUrl(raw);
    if (!parsed) throw new Error('أدخل رابط فيديو صالحاً');
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
      const response = await fetch('api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: raw }), signal: ctrl.signal });
      let data;
      try { data = await response.json(); } catch (_) { throw new Error('الاستخراج يحتاج خادم Java مع yt-dlp؛ الاستضافة الثابتة وحدها لا تكفي'); }
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

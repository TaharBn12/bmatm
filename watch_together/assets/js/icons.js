/* =========================================================
   WatchTogether — نظام الأيقونات (icons.js)
   أيقونات SVG مرسومة داخلياً (بدون أي مكتبة أو CDN أو خطوط)
   الاستخدام في HTML:  <span class="ic" data-icon="play" data-size="20"></span>
   أو من JS:            WTIcons.apply(rootEl)
   ========================================================= */
(function (global) {
  'use strict';

  /* مسارات بأسلوب outline (stroke) — 24×24 */
  const OUTLINE = {
    /* ---- مشغّل ---- */
    back10: '<path d="M11.5 5.5 8 9l3.5 3.5"/><path d="M8 9h6.5a5.5 5.5 0 1 1 0 11H12"/><text x="12" y="17.4" text-anchor="middle" font-size="6.5" font-weight="700" stroke="none" fill="currentColor" font-family="inherit">10</text>',
    fwd10: '<path d="M12.5 5.5 16 9l-3.5 3.5"/><path d="M16 9H9.5a5.5 5.5 0 1 0 0 11H12"/><text x="12" y="17.4" text-anchor="middle" font-size="6.5" font-weight="700" stroke="none" fill="currentColor" font-family="inherit">10</text>',
    volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.8a4.4 4.4 0 0 1 0 6.4"/><path d="M18.3 6a8.2 8.2 0 0 1 0 12"/>',
    mute: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
    collapse: '<path d="M3 8h5V3M21 8h-5V3M21 16h-5v5M3 16h5v5"/>',
    film: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M2.5 12h19M2.5 8h5M2.5 16h5M16.5 8h5M16.5 16h5"/>',
    broadcast: '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.4 2"/>',
    sync: '<path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9M3.5 12a8.5 8.5 0 0 1 14.6-5.9"/><path d="M18.1 2.9v3.6h-3.6M5.9 21.1v-3.6h3.6"/>',

    /* ---- غرفة / مشاركون ---- */
    users: '<path d="M16 20v-1.6a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.4V20"/><circle cx="9.5" cy="7.6" r="3.4"/><path d="M21 20v-1.6a3.6 3.6 0 0 0-2.7-3.48M15.8 4.3a3.6 3.6 0 0 1 0 6.98"/>',
    user: '<path d="M19 20v-1.8a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20"/><circle cx="12" cy="7.5" r="3.8"/>',
    userPlus: '<path d="M15 20v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="8.5" cy="7.5" r="3.8"/><path d="M18.5 7.5v6M21.5 10.5h-6"/>',
    crown: '<path d="m3 8 3.6 2.8L12 4l5.4 6.8L21 8l-1.7 10.2H4.7L3 8Z"/><path d="M4.7 21h14.6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',

    /* ---- دردشة ---- */
    chat: '<path d="M21 11.6a8.4 8.4 0 0 1-8.4 8.4 9 9 0 0 1-3.9-.9L3.5 20.5l1.4-4.6A8.2 8.2 0 0 1 4.2 11.6 8.4 8.4 0 0 1 12.6 3.2 8.4 8.4 0 0 1 21 11.6Z"/>',
    chatDown: '<path d="M21 11.6a8.4 8.4 0 0 1-8.4 8.4 9 9 0 0 1-3.9-.9L3.5 20.5l1.4-4.6A8.2 8.2 0 0 1 4.2 11.6 8.4 8.4 0 0 1 12.6 3.2 8.4 8.4 0 0 1 21 11.6Z"/><path d="M12.5 7v9m-3-3 3 3 3-3"/>',
    chatUp: '<path d="M21 11.6a8.4 8.4 0 0 1-8.4 8.4 9 9 0 0 1-3.9-.9L3.5 20.5l1.4-4.6A8.2 8.2 0 0 1 4.2 11.6 8.4 8.4 0 0 1 12.6 3.2 8.4 8.4 0 0 1 21 11.6Z"/><path d="M12.5 16V7m-3 3 3-3 3 3"/>',
    send: '<path d="M21.5 2.5 11 13M21.5 2.5l-6.8 19-3.7-8.5-8.5-3.7 19-6.8Z"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.4 14.2a4.4 4.4 0 0 0 7.2 0"/><path d="M9.2 9.4h.01M14.8 9.4h.01" stroke-width="2.6" stroke-linecap="round"/>',
    trash: '<path d="M3.5 6h17M8.5 6V4.2A1.2 1.2 0 0 1 9.7 3h4.6a1.2 1.2 0 0 1 1.2 1.2V6M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6"/><path d="M10.2 10.5v6.2M13.8 10.5v6.2"/>',

    /* ---- وسائط (صور وفيديو) ---- */
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2.6"/><circle cx="8.8" cy="9" r="1.6"/><path d="m21 15.4-4.6-4.6a2 2 0 0 0-2.8 0L3.5 20.5"/>',
    video: '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.42V7.92a.5.5 0 0 0-.78-.43L16 11"/>',
    videoFull: '<rect x="2" y="6" width="14" height="12" rx="2.4"/><path d="m16 10.5 5.2 3.5a.5.5 0 0 0 .8-.42V7.92a.5.5 0 0 0-.78-.43L16 11"/>',
    download: '<path d="M12 3.5v11.8"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M4 20.5h16"/>',
    upload: '<path d="M12 20.5V8.7"/><path d="m7.5 13 4.5-4.5 4.5 4.5"/><path d="M4 3.5h16"/>',
    maximize: '<path d="M8.5 3.5H5.6A2.1 2.1 0 0 0 3.5 5.6v2.9M15.5 3.5h2.9a2.1 2.1 0 0 1 2.1 2.1v2.9M8.5 20.5H5.6a2.1 2.1 0 0 1-2.1-2.1v-2.9M15.5 20.5h2.9a2.1 2.1 0 0 0 2.1-2.1v-2.9"/>',
    cloud: '<path d="M6.8 18.5a4.6 4.6 0 0 1-.5-9.15A6.2 6.2 0 0 1 18 8.9a4.3 4.3 0 0 1-.6 9.6Z"/>',

    /* ---- مشاركة ونسخ ---- */
    copy: '<rect x="9" y="9" width="12" height="12" rx="2.2"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>',
    link: '<path d="M10.2 13.8a4.2 4.2 0 0 0 6 0l2.6-2.6a4.24 4.24 0 0 0-6-6l-1.5 1.5"/><path d="M13.8 10.2a4.2 4.2 0 0 0-6 0l-2.6 2.6a4.24 4.24 0 0 0 6 6l1.5-1.5"/>',
    share: '<circle cx="18" cy="5.2" r="2.7"/><circle cx="6" cy="12" r="2.7"/><circle cx="18" cy="18.8" r="2.7"/><path d="m8.4 10.7 7.2-4.1M8.4 13.3l7.2 4.1"/>',
    qr: '<rect x="3" y="3" width="7.2" height="7.2" rx="1.4"/><rect x="13.8" y="3" width="7.2" height="7.2" rx="1.4"/><rect x="3" y="13.8" width="7.2" height="7.2" rx="1.4"/><path d="M13.8 13.8h3.1v3.1h-3.1zM21 13.8v3.1M17.9 21H21v-3.1M13.8 21h1.6"/>',
    eye: '<path d="M2.2 12S5.8 5.4 12 5.4 21.8 12 21.8 12 18.2 18.6 12 18.6 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="3.1"/>',
    eyeOff: '<path d="M9.9 5.7A9.7 9.7 0 0 1 12 5.4c6.2 0 9.8 6.6 9.8 6.6a17 17 0 0 1-3.2 4.1M6.4 7.6A17 17 0 0 0 2.2 12S5.8 18.6 12 18.6a9.5 9.5 0 0 0 4-.86"/><path d="m9.9 9.9a3.1 3.1 0 0 0 4.3 4.3M3 3l18 18"/>',

    /* ---- المساحة الاجتماعية ---- */
    userMinus: '<path d="M15 20v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="8.5" cy="7.5" r="3.8"/><path d="M16 10.5h6"/>',
    camera: '<path d="M8 6 9.5 3.8h5L16 6h3.5A2.5 2.5 0 0 1 22 8.5v10a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-10A2.5 2.5 0 0 1 4.5 6H8Z"/><circle cx="12" cy="13" r="4"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/>',
    heart: '<path d="M20.8 5.7a5.2 5.2 0 0 0-7.3 0L12 7.2l-1.5-1.5a5.2 5.2 0 0 0-7.3 7.4L12 22l8.8-8.9a5.2 5.2 0 0 0 0-7.4Z"/>',
    reply: '<path d="m9 5-7 7 7 7M2 12h11a8 8 0 0 1 8 8"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    doubleCheck: '<path d="m2 12 5 5L18 6m-6 10 2 2L24 7"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    rotate: '<path d="M3 10a9 9 0 1 1 1 7M3 3v7h7"/>',
    bookmark: '<path d="M6 3h12v19l-6-4-6 4V3Z"/>',
    /* ---- عام ---- */
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    pencil: '<path d="M4 20h4.2L20 8.2 15.8 4 4 15.8V20Z"/><path d="m14.2 5.6 4.2 4.2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16.2v-4.6M12 8.1h.01" stroke-width="2.4" stroke-linecap="round"/>',
    alert: '<path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.2v4.1M12 16.8h.01" stroke-width="2.4" stroke-linecap="round"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
    chevronUp: '<path d="m6 14.5 6-6 6 6"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    lock: '<rect x="4.2" y="10.2" width="15.6" height="10.6" rx="2.4"/><path d="M7.8 10.2V7.4a4.2 4.2 0 0 1 8.4 0v2.8"/>',
    mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3.2 6.6 8.8 6.3 8.8-6.3"/>',
    sparkle: '<path d="M12 3.2 13.9 9 19.8 11 13.9 13 12 18.8 10.1 13 4.2 11 10.1 9 12 3.2Z"/><path d="M18.6 3.2v3.4M20.3 4.9h-3.4"/>',
    zap: '<path d="M13.2 2.5 4 13.8h6.4L9.9 21.5 20 10.2h-6.9l.1-7.7Z"/>',
    phone: '<rect x="6.2" y="2.2" width="11.6" height="19.6" rx="2.6"/><path d="M11 18.6h2"/>',
    desktop: '<rect x="2.2" y="3.6" width="19.6" height="13" rx="2.2"/><path d="M8.4 20.6h7.2M12 16.6v4"/>',
    shield: '<path d="M12 21.6s7.8-3.6 7.8-9.4V5.6L12 2.6 4.2 5.6v6.6c0 5.8 7.8 9.4 7.8 9.4Z"/><path d="m9.2 12 2 2 3.6-4"/>',
    sliders: '<path d="M4 20v-6M4 10V4M12 20v-9M12 7V4M20 20v-4M20 12V4"/><path d="M1.6 14h4.8M9.6 11h4.8M17.6 16h4.8"/>',
    keyboard: '<rect x="2.2" y="5.6" width="19.6" height="12.8" rx="2.2"/><path d="M6.2 9.6h.01M10 9.6h.01M13.8 9.6h.01M17.6 9.6h.01M6.2 13h.01M17.6 13h.01M9.4 14.6h5.2" stroke-width="2.1" stroke-linecap="round"/><path d="M9.8 12.8h4.4"/>',
    server: '<rect x="2.6" y="3.4" width="18.8" height="7" rx="2"/><rect x="2.6" y="13.6" width="18.8" height="7" rx="2"/><path d="M6.4 6.9h.01M6.4 17.1h.01" stroke-width="2.6" stroke-linecap="round"/>',
    database: '<ellipse cx="12" cy="5.6" rx="8.2" ry="3.1"/><path d="M3.8 5.6v12.8c0 1.7 3.7 3.1 8.2 3.1s8.2-1.4 8.2-3.1V5.6"/><path d="M3.8 12c0 1.7 3.7 3.1 8.2 3.1s8.2-1.4 8.2-3.1"/>',
    doc: '<path d="M14 2.6H7a2.2 2.2 0 0 0-2.2 2.2v14.4A2.2 2.2 0 0 0 7 21.4h10a2.2 2.2 0 0 0 2.2-2.2V7.8L14 2.6Z"/><path d="M14 2.6v5.2h5.2M8.8 13.4h6.4M8.8 17h6.4"/>',
    search: '<circle cx="10.8" cy="10.8" r="7.2"/><path d="m20.4 20.4-4.6-4.6"/>',
    playlist: '<path d="M4 5.5h11M4 10.5h11M4 15.5h7"/><path d="M17 11.5v8l5-2.7v-8l-5 2.7Z"/>',
    menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
    home: '<path d="m3.2 10.4 8.8-7.2 8.8 7.2"/><path d="M5.6 9v11.2h12.8V9"/><path d="M9.8 20.2v-6h4.4v6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.6h17.6M3.2 14.4h17.6"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    bolt: '<path d="M13.2 2.5 4 13.8h6.4L9.9 21.5 20 10.2h-6.9l.1-7.7Z"/>',
    puzzle: '<path d="M9 3.6h6v2.6a2 2 0 1 0 4 0V3.6h1.4v16.8H3.6V3.6H5v2.6a2 2 0 1 0 4 0V3.6Z" opacity=".35"/><path d="M4.2 8.4h15.6M8.4 8.4v11.4M15.6 8.4v11.4"/>',
    flask: '<path d="M9.4 3h5.2M10.4 3v6.1L5.3 18.2A2 2 0 0 0 7 21.2h10a2 2 0 0 0 1.7-3l-5.1-9.1V3"/><path d="M7.9 14.6h8.2"/>'
  };

  /* مسارات بأسلوب solid (fill) */
  const SOLID = {
    play: '<path d="M8 5.14v13.72c0 .8.87 1.29 1.55.88l11.02-6.86a1.03 1.03 0 0 0 0-1.76L9.55 4.26A1.03 1.03 0 0 0 8 5.14Z"/>',
    pause: '<path d="M7.2 4.4h3.4a1 1 0 0 1 1 1v13.2a1 1 0 0 1-1 1H7.2a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1ZM13.4 4.4h3.4a1 1 0 0 1 1 1v13.2a1 1 0 0 1-1 1h-3.4a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1Z"/>',
    logo: '<path d="M4.5 3.6h15A2.5 2.5 0 0 1 22 6.1v8a2.5 2.5 0 0 1-2.5 2.5H14l-4.4 3.7a.7.7 0 0 1-1.16-.54V16.6H4.5A2.5 2.5 0 0 1 2 14.1v-8A2.5 2.5 0 0 1 4.5 3.6Z"/><path d="M9.6 7.2v5.2l4.6-2.6-4.6-2.6Z" fill="#0a0715" stroke="none"/>'
  };

  function build(name, size) {
    const solid = SOLID[name];
    const inner = solid || OUTLINE[name];
    if (!inner) return '';
    const sz = size || 20;
    if (solid) {
      return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="currentColor" ' +
             'aria-hidden="true" focusable="false">' + inner + '</svg>';
    }
    return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="none" ' +
           'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
           'aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  function html(name, size) { return build(name, size); }

  /** استبدل كل <span class="ic" data-icon="…"> في الشجرة بمحتوى SVG */
  function apply(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll
      ? scope.querySelectorAll('.ic[data-icon]:empty, [data-icon]:not(svg):empty')
      : [];
    nodes.forEach((n) => {
      const name = n.getAttribute('data-icon');
      const size = n.getAttribute('data-size') || (n.dataset && n.dataset.size) || 20;
      const svg = build(name, parseInt(size, 10));
      if (svg) {
        n.innerHTML = svg;
        n.classList.add('ic--ready');
        n.removeAttribute('data-icon');
      }
    });
    return scope;
  }

  /** أنشئ عنصر أيقونة جاهزاً */
  function el(name, size, cls) {
    const span = document.createElement('span');
    span.className = 'ic' + (cls ? ' ' + cls : '');
    span.innerHTML = build(name, size || 20);
    return span;
  }

  const Icons = { html, apply, el, names: Object.keys(OUTLINE).concat(Object.keys(SOLID)) };
  global.WTIcons = Icons;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(document));
    else apply(document);
    /* راقب أي عناصر تُضاف لاحقاً */
    try {
      new MutationObserver((list) => {
        list.forEach((rec) => rec.addedNodes && rec.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            if (n.matches && n.matches('.ic[data-icon], [data-icon]')) apply(n.parentNode || n);
            else if (n.querySelectorAll) apply(n);
          }
        }));
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* MutationObserver غير مدعوم */ }
  }
})(typeof window !== 'undefined' ? window : globalThis);

(function () {
  'use strict';
  const key = 'wt:custom-sites';
  const defaults = [
    ['YouTube', 'https://www.youtube.com', '▶'], ['Google', 'https://www.google.com', 'G'],
    ['Vimeo', 'https://vimeo.com', 'V'], ['Dailymotion', 'https://www.dailymotion.com', 'D'],
    ['TikTok', 'https://www.tiktok.com', 'T'], ['Instagram', 'https://www.instagram.com', 'I'],
    ['Facebook', 'https://www.facebook.com', 'F'], ['X', 'https://x.com', 'X']
  ].map(([name, url, initial]) => ({ name, url, initial }));
  function safeUrl(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('استخدم رابط HTTPS صالحاً دون بيانات دخول');
    return u.href;
  }
  let custom = [];
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(stored)) custom = stored.slice(0, 50).filter(s => {
      try { safeUrl(s.url); if (s.icon) safeUrl(s.icon); return typeof s.name === 'string'; } catch (_) { return false; }
    });
  } catch (_) { /* corrupt or unavailable storage */ }
  function save() { localStorage.setItem(key, JSON.stringify(custom)); }
  function render() {
    const grid = document.getElementById('siteCards');
    grid.replaceChildren();
    defaults.concat(custom).forEach((site, i) => {
      const card = document.createElement('div'); card.className = 'site-card';
      const link = document.createElement('a');
      link.href = site.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', e => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); openViewer(site.name, site.url); } });
      const icon = document.createElement('span'); icon.className = 'site-icon'; icon.textContent = site.initial || site.name.slice(0, 1);
      if (site.icon) {
        const img = document.createElement('img'); img.src = site.icon; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy';
        img.onerror = () => img.remove(); icon.append(img);
      }
      const name = document.createElement('strong'); name.textContent = site.name;
      link.append(icon, name); card.append(link);
      if (i >= defaults.length) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn--ghost btn--sm'; remove.textContent = 'حذف';
        remove.setAttribute('aria-label', 'حذف ' + site.name);
        remove.onclick = () => {
          const previous = custom.slice(); custom.splice(i - defaults.length, 1);
          try { save(); render(); } catch (_) { custom = previous; WTUtil.toast('تعذّر الحفظ في المتصفح', 'error'); }
        };
        card.append(remove);
      }
      grid.append(card);
    });
  }
  document.getElementById('addSite').addEventListener('submit', e => {
    e.preventDefault(); const form = e.currentTarget;
    try {
      if (custom.length >= 50) throw new Error('وصلت إلى الحد الأقصى: 50 موقعاً');
      const data = new FormData(form), name = data.get('siteName').trim();
      if (!name) throw new Error('أدخل اسم الموقع');
      const site = { name, url: safeUrl(data.get('siteUrl')), icon: data.get('siteIcon') ? safeUrl(data.get('siteIcon')) : '' };
      custom.push(site);
      try { save(); } catch (err) { custom.pop(); throw new Error('تعذّر الحفظ في المتصفح'); }
      form.reset(); render();
    } catch (err) { WTUtil.toast(err.message, 'error'); }
  });
  document.getElementById('searchSites').addEventListener('submit', e => {
    e.preventDefault();
    const q = document.getElementById('googleQuery').value.trim();
    if (q) openViewer('Google', 'https://www.google.com/search?q=' + encodeURIComponent(q));
  });
  /* ---- عارض المواقع داخل الصفحة ---- */
  const viewer = document.getElementById('siteViewer');
  const frame = document.getElementById('svFrame');
  const external = document.getElementById('svExternal');
  let lastFocus = null;
  function openViewer(name, url) {
    let href;
    try { href = safeUrl(url); } catch (err) { WTUtil.toast(err.message, 'error'); return; }
    lastFocus = document.activeElement;
    document.getElementById('svTitle').textContent = name;
    external.href = href;
    frame.src = href;
    viewer.hidden = false;
    document.body.classList.add('site-viewer-open');
    document.getElementById('svClose').focus();
  }
  function closeViewer() {
    viewer.hidden = true;
    frame.src = 'about:blank';
    document.body.classList.remove('site-viewer-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.getElementById('svClose').addEventListener('click', closeViewer);
  document.getElementById('svReload').addEventListener('click', () => { if (frame.src) frame.src = frame.src; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !viewer.hidden) closeViewer(); });

  render();
})();

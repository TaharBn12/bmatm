/* =========================================================
   WatchTogether — «التالي» واستيراد القوائم (upnext.js)
   • عند انتهاء فيديو يوتيوب: طبقة اقتراحات فوق المشغّل،
     أول مقترح يُعرض منه 10 ثوان صامتة، ثم يكمل تلقائياً
     على جهاز واحد منسّق؛ ويظل الاختيار اليدوي متاحاً لكل عضو منضم.
   • لصق رابط قائمة يوتيوب في حقل الرابط → استيرادها كلها.
   القرارات الجماعية تمر عبر قائمة الغرفة + صلاحية العضوية،
   فلا يفرض أحد جهازاً فيديو على البقية.
   ========================================================= */
(function (global) {
  'use strict';

  const U = global.WTUtil;
  const S = global.WTSuggest;
  const CFG = () => (global.WT_CONFIG && global.WT_CONFIG.youtube) || {};

  let R = null;                 /* window.WTRoom */
  let overlay = null;           /* طبقة «التالي» */
  let preview = null;           /* مشغّل المعاينة (يوتيوب) */
  let previewHost = null;
  let items = [];               /* المقترحات المعروضة */
  let active = false;
  let tickTimer = null;
  let endTimer = null;
  let left = 0;
  let waiting = false;          /* بعد العدّ: ننتظر اكتمال الانضمام للغرفة */
  let seq = 0;                  /* يمنع تداخل الطلبات عند تبديل الفيديو بسرعة */

  const esc = (s) => U.esc(String(s == null ? '' : s));

  function room() { return R || (R = global.WTRoom || null); }
  function playerEl() { const r = room(); return r && r.el && r.el.player ? r.el.player : null; }
  function canControl() { const r = room(); return !!(r && r.canControl && r.canControl()); }
  function canAutoAdvance() { const r = room(); return !!(r && r.canAutoAdvance && r.canAutoAdvance()); }
  function seconds() { return Math.max(3, Math.min(30, Number(CFG().previewSeconds) || 10)); }

  /* ============================ الطبقة ============================ */
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    const host = playerEl();
    if (!host) return null;
    overlay = document.createElement('div');
    overlay.className = 'upnext';
    overlay.id = 'upNext';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="upnext__row">' +
      '  <span class="upnext__label" id="upNextLabel"><span class="ic" data-icon="playlist" data-size="14"></span> التالي</span>' +
      '  <div class="upnext__rail" id="upNextGrid" role="list" aria-label="مقترحات الفيديو التالي"></div>' +
      '  <button type="button" class="upnext__x" id="upNextClose" aria-label="إغلاق" title="إغلاق">' +
      '    <span class="ic" data-icon="x" data-size="15"></span>' +
      '  </button>' +
      '</div>' +
      '<span class="upnext__note" id="upNextFoot" role="status" hidden></span>';
    host.appendChild(overlay);
    overlay.querySelector('#upNextClose').addEventListener('click', hide);
    return overlay;
  }

  /* ============================ الحالة ============================ */
  function onVideoChanged() {
    hide();
  }

  function hide() {
    seq++;
    active = false;
    waiting = false;
    items = [];
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(endTimer); endTimer = null;
    destroyPreview();
    if (overlay) { overlay.hidden = true; const g = overlay.querySelector('#upNextGrid'); if (g) g.innerHTML = ''; }
  }

  function destroyPreview() {
    const dead = preview;
    preview = null;
    if (dead) { try { dead.destroy && dead.destroy(); } catch (e) { } }
    if (previewHost) { previewHost.innerHTML = ''; }
  }

  /* ============================ عند الانتهاء ============================ */
  async function onEnded() {
    const r = room();
    if (!r || !S) return;
    const parsed = r.session && r.session.videoParsed;
    if (!parsed || active) return;
    /* يوتيوب: من المتصفح. بقية الصيغ (mp4/HLS/تضمين): عبر yt-dlp على السيرفر */
    const isYt = parsed.kind === 'youtube';
    const videoId = isYt ? parsed.id : '';
    const url = (r.state && r.state.url) || parsed.src;
    if (!url) return;

    const ov = ensureOverlay();
    if (!ov) return;
    active = true;
    waiting = false;
    const my = ++seq;
    ov.hidden = false;
    ov.classList.add('is-loading');
    renderSkeleton();
    paintFoot(isYt ? 'جارٍ جلب المقترحات…' : 'جارٍ البحث عن مقترحات…', '');

    const ctx = {
      excludeIds: (r.getQueue ? r.getQueue() : []).map(q => S.parseVideoId(q && q.url)).filter(Boolean),
      playlist: isYt ? playlistContext(videoId) : null,
      channelId: '',
      budgetMs: isYt ? undefined : (CFG().serverSuggestMs || 30000)
    };
    if (isYt) {
      try {
        const meta = await S.meta([videoId]);
        if (meta && meta[0] && meta[0].channel) ctx.channelId = meta[0].channel;
      } catch (e) { /* لا يهم: الاقتراحات تعمل بدون القناة */ }
    }

    let result = { items: [], source: 'none' };
    try {
      result = await S.forUrl(url, ctx);
    } catch (e) { /* نعرض رسالة بدل الصمت */ }

    if (my !== seq || !active) return;
    ov.classList.remove('is-loading');
    items = result.items || [];
    if (!items.length) {
      renderEmpty(result.source);
      return;
    }
    render();
    startCountdown();
  }

  /* ============================ العرض ============================ */
  function renderSkeleton() {
    const g = overlay.querySelector('#upNextGrid');
    g.innerHTML = new Array(6).fill(0).map(() =>
      '<div class="upnext__thumbcard is-skeleton"></div>'
    ).join('');
  }

  function renderEmpty(source) {
    /* لا سيرفر (استضافة ثابتة) وصيغة غير يوتيوب → نشرح السبب بدل الصمت */
    if (source === 'no-server') {
      paintFoot('الاقتراحات لهذا النوع تحتاج تشغيل الغرفة من سيرفر Java مع yt-dlp — أضف فيديو من القائمة للمتابعة.', 'is-wait');
      return;
    }
    paintFoot('لا تتوفر اقتراحات الآن — أضف فيديو إلى قائمة الغرفة للمتابعة.', '');
  }

  function render() {
    const g = overlay.querySelector('#upNextGrid');
    const label = overlay.querySelector('#upNextLabel');
    const ctrl = canControl();
    const auto = canAutoAdvance();
    if (label) {
      label.title = auto
        ? 'يبدأ الأول تلقائياً بعد العدّ — أو اختر أنت الآن'
        : ctrl ? 'يمكنك اختيار أي مقترح الآن؛ التشغيل التلقائي منسّق على جهاز واحد'
          : 'انضم إلى الغرفة لبدء المقترح؛ ويمكنك إضافته إلى القائمة';
    }

    /* صور مصغّرة فقط: الشريط لا يحجب الفيديو، والاسم يظهر عند المرور/التركيز */
    g.innerHTML = items.map((it, i) => {
      const isFirst = i === 0;
      const tip = esc(it.title) + (it.author ? ' — ' + esc(it.author) : '');
      return '<button type="button" class="upnext__thumbcard' + (isFirst ? ' is-first' : '') + '" role="listitem"' +
        ' data-sug-id="' + esc(it.id) + '" title="' + tip + '" aria-label="' + tip + '">' +
        '<span class="upnext__media">' +
        (isFirst
          ? '<span class="upnext__preview" id="upNextPreview"></span>' +
            '<span class="upnext__ring" id="upNextRing" role="timer" aria-label="الثواني المتبقية">' +
            '  <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-bg" cx="22" cy="22" r="19"></circle>' +
            '  <circle class="ring-fg" id="ringFg" cx="22" cy="22" r="19"></circle></svg>' +
            '  <span id="upNextCount">' + seconds() + '</span>' +
            '</span>'
          : '<img src="' + esc(it.thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">') +
        '</span>' +
        (isFirst ? '<span class="upnext__flag">معاينة ' + seconds() + ' ث</span>' : '') +
        '</button>';
    }).join('');

    /* العضو المنضم يبدأ المقترح؛ من لم يكتمل انضمامه يستطيع إضافته للقائمة */
    g.querySelectorAll('.upnext__thumbcard').forEach(card => {
      card.addEventListener('click', () => {
        const it = items.find(x => x.id === card.getAttribute('data-sug-id'));
        if (!it) return;
        if (canControl()) playNow(it); else addToQueue(it);
      });
    });
  }

  function paintFoot(text, cls) {
    const f = overlay && overlay.querySelector('#upNextFoot');
    if (!f) return;
    f.hidden = !text;
    f.className = 'upnext__foot' + (cls ? ' ' + cls : '');
    f.textContent = text || '';
  }

  /* ============================ العدّ والمعاينة ============================ */
  async function startCountdown() {
    const first = items[0];
    if (!first) return;
    left = seconds();
    previewHost = overlay.querySelector('#upNextPreview');
    paintFoot('', '');

    if (previewHost && global.WTPlayer && global.WTPlayer.loadYouTubeApi) {
      try {
        const YT = await global.WTPlayer.loadYouTubeApi();
        if (!active) return;
        destroyPreview();
        preview = new YT.Player(previewHost, {
          videoId: first.id,
          playerVars: {
            autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, rel: 0,
            modestbranding: 1, playsinline: 1, iv_load_policy: 3, cc_load_policy: 0,
            enablejsapi: 1, origin: location.origin
          },
          events: {
            onReady: () => { try { if (preview) { preview.mute(); preview.playVideo(); } } catch (e) { } },
            onError: () => { }
          }
        });
      } catch (e) { /* المعاينة اختيارية: العدّ يستمر بدونها */ }
    }

    updateRing();
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      left -= 1;
      updateRing();
      if (left <= 0) finishCountdown();
    }, 1000);
  }

  function updateRing() {
    const count = overlay && overlay.querySelector('#upNextCount');
    const fg = overlay && overlay.querySelector('#ringFg');
    const pct = Math.max(0, left / seconds());
    if (count) count.textContent = String(Math.max(0, left));
    if (fg) {
      const c = 2 * Math.PI * 19;
      fg.style.strokeDasharray = c + ' ' + c;
      fg.style.strokeDashoffset = String(c * (1 - pct));
    }
  }

  function finishCountdown() {
    clearInterval(tickTimer); tickTimer = null;
    if (!active) return;
    destroyPreview();
    const first = items[0];
    const ring = overlay && overlay.querySelector('#upNextRing');
    if (ring) ring.hidden = true;
    if (!first) return;
    if (canAutoAdvance()) {
      paintFoot('يكمل تلقائياً الآن…', 'is-good');
      playNow(first);
    } else {
      waiting = true;
      paintFoot(canControl()
        ? 'يمكنك اختيار مقترح الآن؛ التشغيل التلقائي منسّق لتجنّب التكرار…'
        : 'انضم إلى الغرفة لتشغيل التالي…', 'is-wait');
    }
  }

  /* ============================ الإجراءات ============================ */
  async function addToQueue(it, btn) {
    const r = room();
    if (!r || !r.addQueueItems) return;
    if (btn) btn.disabled = true;
    const ok = await r.addQueueItems([{ url: it.url, title: it.title }]);
    if (btn) btn.disabled = false;
    if (ok) {
      U.toast('أُضيف إلى قائمة الغرفة: ' + it.title, 'success', 2200);
      if (!canControl()) paintFoot('أُضيف المقترح للقائمة — انضم إلى الغرفة لبدء التشغيل', 'is-good');
    }
  }

  async function playNow(it) {
    const r = room();
    if (!r) return;
    if (!canControl()) {
      U.toast('انضم إلى الغرفة للتحكم بالمشاهدة', 'warn', 2400);
      return;
    }
    seq++;                      /* أوقف أي عدّاد جارٍ */
    active = false;
    destroyPreview();
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(endTimer); endTimer = null;
    if (overlay) overlay.hidden = true;

    /* نضمن وجوده في القائمة ثم نشغّله — فيبقى الأثر ظاهراً للجميع */
    const already = (r.getQueue ? r.getQueue() : []).find(q => S.parseVideoId(q.url) === it.id);
    if (!already && r.addQueueItems) await r.addQueueItems([{ url: it.url, title: it.title }]);
    const target = (r.getQueue ? r.getQueue() : []).find(q => S.parseVideoId(q.url) === it.id);
    if (target && r.playQueueItemById) r.playQueueItemById(target.id);
    else if (r.setVideo) r.setVideo(it.url);
  }

  /* ============================ سياق القائمة المستوردة ============================ */
  function playlistContext(videoId) {
    const r = room();
    if (!r) return null;
    try {
      const ctx = U.store.get('plctx:' + r.roomId, null);
      if (ctx && Array.isArray(ctx.ids) && ctx.ids.indexOf(videoId) >= 0) return ctx;
    } catch (e) { }
    return null;
  }

  function rememberPlaylist(listId, ids) {
    const r = room();
    if (!r || !listId) return;
    U.store.set('plctx:' + r.roomId, { list: listId, ids: ids, ts: Date.now() });
  }

  /* ============================ استيراد قائمة يوتيوب ============================ */
  let importModal = null;

  function ensureImport() {
    if (importModal && importModal.isConnected) return importModal;
    importModal = document.createElement('div');
    importModal.className = 'modal';
    importModal.id = 'importModal';
    importModal.hidden = true;
    importModal.innerHTML =
      '<div class="modal__card glass modal__card--import">' +
      '  <div class="modal__head">' +
      '    <div>' +
      '      <p class="drawer__eyebrow">قائمة يوتيوب</p>' +
      '      <h2 class="modal__title"><span class="ic" data-icon="playlist" data-size="19"></span> استيراد قائمة تشغيل</h2>' +
      '    </div>' +
      '    <button type="button" class="btn btn--ghost btn--icon-sm" id="importCloseBtn" aria-label="إغلاق">' +
      '      <span class="ic" data-icon="x" data-size="18"></span></button>' +
      '  </div>' +
      '  <p class="playlist__hint" id="importHint">جارٍ قراءة القائمة من يوتيوب…</p>' +
      '  <div class="import-list" id="importList"></div>' +
      '  <div class="modal__foot">' +
      '    <span class="import-count" id="importCount"></span>' +
      '    <span class="modal__spacer"></span>' +
      '    <button type="button" class="btn btn--ghost" id="importOneBtn" hidden>الفيديو فقط</button>' +
      '    <button type="button" class="btn btn--ghost" id="importCancelBtn">إلغاء</button>' +
      '    <button type="button" class="btn btn--primary" id="importAddBtn" disabled>أضف المحددة</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(importModal);
    importModal.querySelector('#importCloseBtn').addEventListener('click', closeImport);
    importModal.querySelector('#importCancelBtn').addEventListener('click', closeImport);
    importModal.querySelector('#importAddBtn').addEventListener('click', commitImport);
    /* «الفيديو فقط» يُربط في importFromUrl لأنه يحتاج معرّف الفيديو */
    importModal.addEventListener('click', (e) => { if (e.target === importModal) closeImport(); });
    return importModal;
  }

  let importData = null;
  function closeImport() {
    if (importModal) importModal.hidden = true;
    importData = null;
  }

  /**
   * يعالج رابطاً ملصوقاً في حقل «رابط الفيديو».
   * @returns {Promise<boolean>} true إن تولّى الاستيراد (فلا يضيف رابطاً واحداً)
   */
  async function importFromUrl(raw) {
    const parsed = S && S.parseListUrl(raw);
    if (!parsed) return false;
    const r = room();
    if (!r || !r.addQueueItems) return false;

    const modal = ensureImport();
    modal.hidden = false;
    const hint = modal.querySelector('#importHint');
    const list = modal.querySelector('#importList');
    const count = modal.querySelector('#importCount');
    const addBtn = modal.querySelector('#importAddBtn');
    const oneBtn = modal.querySelector('#importOneBtn');
    const oneId = parsed.videoId || '';
    oneBtn.hidden = !oneId;
    oneBtn.onclick = () => addSingleVideo(oneId);
    hint.className = 'playlist__hint';
    hint.innerHTML = '<span class="spinner"></span> جارٍ قراءة القائمة من يوتيوب…';
    list.innerHTML = '';
    count.textContent = '';
    addBtn.disabled = true;
    addBtn.textContent = 'أضف المحددة';
    importData = null;

    let data;
    try {
      data = await S.playlistItems(parsed.list, { limit: CFG().maxImport || 60 });
    } catch (err) {
      hint.className = 'playlist__hint is-bad';
      hint.textContent = err && err.message ? err.message : 'تعذّر قراءة القائمة';
      return true;
    }
    if (!data.items.length) {
      hint.className = 'playlist__hint is-bad';
      hint.textContent = 'لم نتمكن من قراءة فيديوهات هذه القائمة — تأكد أنها عامة وقابلة للتضمين.';
      return true;
    }

    importData = data;
    const max = CFG().maxImport || 60;
    const slice = data.items.slice(0, max);
    hint.className = 'playlist__hint';
    hint.textContent = 'القائمة فيها ' + data.items.length + ' فيديو' +
      (data.items.length > max ? ' — سنضيف أول ' + max + ' فقط' : '') + ' • ألغِ تحديد ما لا تريده:';

    list.innerHTML =
      '<label class="import-row import-row--all">' +
      '  <input type="checkbox" id="importAll" checked>' +
      '  <span>تحديد الكل (<strong>' + slice.length + '</strong>)</span>' +
      '</label>' +
      slice.map((it, i) =>
        '<label class="import-row">' +
        '  <input type="checkbox" data-import-idx="' + i + '" checked>' +
        '  <img class="import-row__thumb" src="' + esc(it.thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
        '  <span class="import-row__body"><strong>' + esc(it.title) + '</strong>' +
        (it.author ? '<small>' + esc(it.author) + '</small>' : '') + '</span>' +
        '  <span class="import-row__n">' + String(i + 1).padStart(2, '0') + '</span>' +
        '</label>'
      ).join('');

    const all = list.querySelector('#importAll');
    const boxes = list.querySelectorAll('[data-import-idx]');
    const sync = () => {
      const n = Array.from(boxes).filter(b => b.checked).length;
      count.textContent = n + ' محدد';
      addBtn.disabled = n === 0;
      addBtn.textContent = 'أضف المحددة (' + n + ')';
      if (all) { all.checked = n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
    };
    all.addEventListener('change', () => { boxes.forEach(b => { b.checked = all.checked; }); sync(); });
    boxes.forEach(b => b.addEventListener('change', sync));
    sync();
    return true;
  }

  /** «الفيديو فقط»: الرابط كان watch?v=…&list=… فاخترنا تجاهل القائمة */
  async function addSingleVideo(videoId) {
    const r = room();
    const vid = String(videoId || (importData && importData.videoId) || '');
    if (!vid || !r) { closeImport(); return; }
    const title = (importData && importData.items.find(i => i.id === vid)) ? importData.items.find(i => i.id === vid).title : '';
    closeImport();
    const n = await r.addQueueItems([{ url: S.watchUrl(vid), title: title }]);
    if (n) {
      if (r.el && r.el.newUrl) r.el.newUrl.value = '';
      if (r.el && r.el.changeBar) r.el.changeBar.hidden = true;
      U.toast('أُضيف الفيديو إلى قائمة الغرفة', 'success', 2200);
    }
  }

  async function commitImport() {
    if (!importData) return;
    const r = room();
    const list = importModal.querySelector('#importList');
    const addBtn = importModal.querySelector('#importAddBtn');
    const hint = importModal.querySelector('#importHint');
    const picked = Array.from(list.querySelectorAll('[data-import-idx]'))
      .filter(b => b.checked)
      .map(b => importData.items[Number(b.getAttribute('data-import-idx'))])
      .filter(Boolean);
    if (!picked.length) return;

    addBtn.disabled = true;
    hint.className = 'playlist__hint';
    hint.innerHTML = '<span class="spinner"></span> جارٍ الإضافة 0/' + picked.length;
    let done = 0;
    await r.addQueueItems(
      picked.map(it => ({ url: it.url, title: it.title, fromPlaylist: importData.list })),
      (n) => { done = n; hint.innerHTML = '<span class="spinner"></span> جارٍ الإضافة ' + n + '/' + picked.length; }
    );
    rememberPlaylist(importData.list, importData.items.map(i => i.id));
    closeImport();
    if (r.el && r.el.newUrl) r.el.newUrl.value = '';
    if (r.el && r.el.newTitle) r.el.newTitle.value = '';
    if (r.el && r.el.changeBar) r.el.changeBar.hidden = true;
    U.toast('أُضيفت ' + done + ' فيديو إلى قائمة الغرفة', 'success', 3000);
    if (r.sysMessage) r.sysMessage('أضاف ' + r.session.name + ' ' + done + ' فيديو من قائمة يوتيوب');
  }

  global.WTUpNext = {
    onEnded,
    onVideoChanged,
    hide,
    importFromUrl,
    isPlaylistUrl(raw) { return !!(S && S.parseListUrl(raw)); },
    get active() { return active; },
    get waiting() { return waiting; },
    get items() { return items.slice(); }
  };
})(window);

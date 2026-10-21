/* =========================================================
   WatchTogether — الميزات الاحترافية (features.js)
   1) قوالب المزاج   2) ذاكرة السهرة   3) لقطة سينما
   4) ملاحظات الأريكة   5) لحظات زمنية على شريط التقدم
   6) تصويت ديمقراطي 70% على قائمة التشغيل
   التزام: Midnight Gold (#080C14 / #C5A572) + خط Cairo
   التزام: أحداث المزامنة تسير عبر رسائل الدردشة (بلا تغيير مخطط)
   ========================================================= */
(function () {
  'use strict';

  const U = window.WTUtil;
  const CFG = window.WT_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  /* ============================== أدوات عامة ============================== */
  function whenReady(cb) {
    if (window.WTRoom) cb(window.WTRoom);
    else setTimeout(() => whenReady(cb), 60);
  }

  let R = null;

  function sendEvent(kind, meta) {
    if (!R || !R.session || !R.session.ready || !R.session.transport) {
      U.toast('لم يكتمل الاتصال بعد — حاول بعد ثانية', 'warn');
      return false;
    }
    const wire = R.chat.encodeChatText('', Object.assign({ a: kind }, meta));
    const msg = { name: R.session.name, text: wire, kind: kind, client: R.session.clientId, ts: Date.now() };
    try { R.session.transport.sendChat({ name: msg.name, text: wire, kind: kind, client: msg.client }); }
    catch (e) { U.toast('تعذّر الإرسال — حاول بعد ثانية', 'error'); return false; }
    /* الصدى الذيّ محجوب في bindTransport → نطبّق محلياً فوراً (نفس نمط التفاعلات) */
    onMessage(msg, R.chat.decodeChatText(wire), { mine: true });
    return true;
  }

  function esc(s) { return U.esc(String(s == null ? '' : s)); }
  function fmtDur(ms) {
    const min = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return h + ' س ' + m + ' د';
    if (h) return h + ' ساعة';
    return m + ' د';
  }
  function titleOf(url) {
    if (!url) return '';
    const q = (R.session.queue || []).find(x => x.url === url || x.video_url === url);
    if (q && q.title) return q.title;
    try { const p = U.parseWatchUrl(url); if (p && p.label) return p.label; } catch (e) { }
    return 'فيديو';
  }

  /* ============================== الحالة ============================== */
  const MOODS = [
    { id: 'classic', e: '🎬', n: 'كلاسيكي', d: ' Midnight Gold الأصلي — الوضع الافتراضي' },
    { id: 'horror', e: '👻', n: 'رعب', d: 'توهج قرمزي خافت على العتمة' },
    { id: 'chill', e: '🌊', n: 'هادئ', d: 'فضي أزرق بارد ومريح' },
    { id: 'hype', e: '🔥', n: 'حماس', d: 'كهرماني نابض لتشجيع لا يتوقف' },
    { id: 'romance', e: '🌹', n: 'رومانسي', d: 'وردي دافئ لليلة هادئة' },
    { id: 'party', e: '🪩', n: 'حفلة', d: 'بنفسجي محتشم لسهرة جماعية' }
  ];

  const state = {
    mood: { id: 'classic', v: 0, n: '' },
    pins: new Map(),   /* id → {id,t,e,n,c,v,u} */
    notes: new Map(),  /* id → {id,t,x,n,c,v} */
    votes: new Map(),  /* itemId → Map<clientId,{v,ts,n}> */
    fired: new Set(),  /* عناصر بلغت العتبة ونُفِّذت */
    mem: { start: 0, videos: new Map(), members: new Set(), msgs: 0 }
  };
  const PINS_CAP = 40, NOTES_CAP = 60, VOTE_TTL = 30 * 60 * 1000;

  /* ============================== elements ============================== */
  const el = {};
  function grabEls() {
    el.moodChip = $('moodChip');
    el.moodBtn = $('moodBtn');
    el.pinBtn = $('pinBtn');
    el.notesBtn = $('notesBtn');
    el.snapBtn = $('snapBtn');
    el.memBtn = $('memBtn');
    el.notesBadge = $('notesBadge');
    el.momentsRail = $('momentsRail');
    el.momentsTrack = $('momentsTrack');
    el.momentsHead = $('momentsHead');
    el.momentsAdd = $('momentsAdd');
    el.pinPicker = $('pinPicker');
    el.moodModal = $('moodModal');
    el.moodGrid = $('moodGrid');
    el.notesModal = $('notesModal');
    el.noteTime = $('noteTime');
    el.noteInput = $('noteInput');
    el.noteAdd = $('noteAdd');
    el.notesList = $('notesList');
    el.notesEmpty = $('notesEmpty');
    el.notesExport = $('notesExport');
    el.memModal = $('memModal');
    el.memStats = $('memStats');
    el.memVideos = $('memVideos');
    el.memGen = $('memGen');
    el.memPreview = $('memPreview');
    el.memImg = $('memImg');
    el.memDownload = $('memDownload');
    el.snapModal = $('snapModal');
    el.snapImg = $('snapImg');
    el.snapHint = $('snapHint');
    el.snapDownload = $('snapDownload');
    el.snapShare = $('snapShare');
    el.snapSend = $('snapSend');
    el.queueList = $('queueList');
  }

  /* ============================== 1) قوالب المزاج ============================== */
  function moodKey() { return 'room:mood:' + (R && R.roomId); }  /* U.store يضيف بادئة wt: تلقائياً */

  function applyMood(meta, opts) {
    const id = String((meta && meta.m) || '');
    const v = Number(meta && meta.v) || 0;
    const who = String((meta && meta.n) || '');
    if (!MOODS.some(x => x.id === id)) return;
    if (v < state.mood.v) return;             /* آخر قيمة بالتزامن حسب الطابع الزمني */
    const changed = state.mood.id !== id;
    state.mood = { id: id, v: v, n: who };
    document.body.dataset.mood = id;
    try { U.store.set(moodKey(), { id: id, v: v, n: who }); } catch (e) { }
    paintMoodChip();
    markMoodCard();
    if (changed && !(opts && opts.silent) && who) {
      const m = MOODS.find(x => x.id === id);
      R.sysMessage(who + ' ضبط أجواء: ' + m.n + ' ' + m.e);
    }
  }

  function paintMoodChip() {
    if (!el.moodChip) return;
    const m = MOODS.find(x => x.id === state.mood.id) || MOODS[0];
    el.moodChip.textContent = m.e + ' ' + m.n;
    el.moodChip.title = 'أجواء السهرة: ' + m.n + ' — اضغط للتغيير';
    el.moodChip.hidden = false;
  }

  function markMoodCard() {
    if (!el.moodGrid) return;
    el.moodGrid.querySelectorAll('.mood-card').forEach(c => {
      c.classList.toggle('is-on', c.dataset.mood === state.mood.id);
    });
  }

  function pickMood(id) {
    const m = MOODS.find(x => x.id === id);
    if (!m) return;
    /* نطبّق فوراً (الرسالة النظامية تظهر للمرسل أيضاً — الإعادة الهوّية بلا تأثير) */
    applyMood({ m: id, v: Date.now(), n: R.session.name });
    sendEvent('mood', { m: id, v: state.mood.v, n: R.session.name });
    closeModal(el.moodModal);
    U.toast('الأجواء الآن: ' + m.n + ' ' + m.e, 'success', 2400);
  }

  /* ============================== 2) لقطة سينما ============================== */
  function snapShot() {
    if (!R.session.ready) { U.toast('لم يكتمل الاتصال بعد', 'warn'); return; }
    if (!R.state.url) { U.toast('لا يوجد فيديو لالتقاطه', 'warn'); return; }
    const v = R.player && R.player._video;
    const dur = R.player.getDuration ? R.player.getDuration() : 0;
    const cur = R.player.getCurrentTime ? R.player.getCurrentTime() : 0;
    const info = { title: titleOf(R.state.url), dur: dur, cur: cur, embed: R.state.kind === 'embed' };

    let canvas = null;
    if (v && v.readyState >= 2 && v.videoWidth > 0 && !info.embed) {
      try {
        canvas = document.createElement('canvas');
        canvas.width = 1600; canvas.height = 900;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(1600 / v.videoWidth, 900 / v.videoHeight);
        const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
        ctx.drawImage(v, (1600 - dw) / 2, (900 - dh) / 2, dw, dh);
        /* كشف تلوّث القماش (مصدر خارجي بلا CORS) — يرمي SecurityError */
        canvas.toDataURL('image/jpeg', 0.92);
      } catch (e) { canvas = null; }
    }
    const fromFrame = !!canvas;
    if (!canvas) canvas = posterCanvas(info);
    openSnap(canvas, fromFrame, info);
  }

  /* بطاقة سينما احتياطية حين يتعذّر التقاط الإطار (يوتيوب/تلوّث القماش) */
  function posterCanvas(info) {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 900;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 900);
    g.addColorStop(0, '#0F1A26'); g.addColorStop(0.5, '#080C14'); g.addColorStop(1, '#131C29');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 900);
    const r1 = x.createRadialGradient(1450, 60, 0, 1450, 60, 700);
    r1.addColorStop(0, 'rgba(197,165,114,.30)'); r1.addColorStop(1, 'rgba(197,165,114,0)');
    x.fillStyle = r1; x.fillRect(0, 0, 1600, 900);
    const r2 = x.createRadialGradient(150, 880, 0, 150, 880, 650);
    r2.addColorStop(0, 'rgba(182,122,59,.24)'); r2.addColorStop(1, 'rgba(182,122,59,0)');
    x.fillStyle = r2; x.fillRect(0, 0, 1600, 900);

    x.strokeStyle = 'rgba(197,165,114,.85)'; x.lineWidth = 4;
    x.strokeRect(40, 40, 1520, 820);
    x.strokeStyle = 'rgba(197,165,114,.35)'; x.lineWidth = 1.5;
    x.strokeRect(58, 58, 1484, 784);

    x.direction = 'rtl'; x.textAlign = 'center';
    x.fillStyle = '#6B7A8A';
    x.font = '700 30px Cairo, sans-serif';
    x.fillText('C I N E M A   S N A P', 800, 150);

    x.fillStyle = '#C5A572';
    x.font = '900 74px Cairo, sans-serif';
    x.fillText(info.title || 'لحظة سينما', 800, 300);

    x.fillStyle = '#E8DCC6';
    x.font = '800 120px ui-monospace, monospace';
    x.fillText(U.fmtTime(info.cur || 0), 800, 470);

    x.fillStyle = '#9AA8B8';
    x.font = '700 34px Cairo, sans-serif';
    x.fillText('عند ' + U.fmtTime(info.cur || 0) + ' من ' + U.fmtTime(info.dur || 0), 800, 550);

    x.fillStyle = 'rgba(232,220,198,.9)';
    x.font = '400 44px "Grand Hotel", cursive';
    x.fillText('WatchTogether', 800, 720);

    x.fillStyle = '#6B7A8A';
    x.font = '700 30px Cairo, sans-serif';
    const room = 'غرفة ' + (R.roomId || '');
    x.fillText(room + ' · ' + new Date().toLocaleDateString('ar-EG'), 800, 800);
    return c;
  }

  function openSnap(canvas, fromFrame, info) {
    const url = canvas.toDataURL('image/jpeg', 0.92);
    el.snapImg.src = url;
    el.snapHint.textContent = fromFrame
      ? 'التُقطت من إطار الفيديو مباشرة — أرسلها للدردشة أو احفظها.'
      : (info.embed
        ? 'فيديوهات اليوتيوب محمية ولا تُلتقط مباشرة — أُنشئت بطاقة سينما مصمّمة بالعنوان والوقت.'
        : 'تعذّر التقاط الإطار (مصدر خارجي) — أُنشئت بطاقة سينما مصمّمة بدلاً منه.');
    el.snapModal.hidden = false;
    el._snapCanvas = canvas;
    const canSend = R.media.mediaEnabled() &&
      (!R.media.attachments || R.media.attachments.length === 0);
    el.snapSend.hidden = !canSend;
    if (!R.media.mediaEnabled()) el.snapHint.textContent += ' الرفع معطّل — يمكنك الحفظ أو المشاركة فقط.';
    else if (!canSend) el.snapHint.textContent += ' لديك مرفقات قيد الرفع — أزلها ثم أعد اللقطة للإرسال.';
  }

  function snapFileName() {
    return 'cinema-snap-' + (R.roomId || 'room') + '-' + Date.now() + '.jpg';
  }

  /* ============================== 3) ذاكرة السهرة ============================== */
  function memTick() {
    if (!R || !R.session.ready) return;
    if (!state.mem.start) state.mem.start = Date.now();
    const url = R.state.url;
    if (url && !state.mem.videos.has(url)) state.mem.videos.set(url, titleOf(url));
    Object.values(R.session.members || {}).forEach(m => {
      if (m && m.name) state.mem.members.add(m.name);
    });
    const n = R.el.chatBody.querySelectorAll('.msg:not(.msg--system)').length;
    state.mem.msgs = Math.max(state.mem.msgs, n);
  }

  function memData() {
    memTick();
    const list = [...state.mem.videos.values()].slice(0, 6);
    return {
      dur: state.mem.start ? (Date.now() - state.mem.start) : 0,
      videos: state.mem.videos.size,
      videoList: list,
      members: [...state.mem.members],
      msgs: state.mem.msgs,
      pins: state.pins.size,
      notes: state.notes.size,
      mood: MOODS.find(x => x.id === state.mood.id) || MOODS[0]
    };
  }

  function paintMemStats() {
    const d = memData();
    const cells = [
      [fmtDur(d.dur), 'مدة الجلسة'],
      [String(d.videos), 'فيديوهات'],
      [String(d.msgs), 'رسائل'],
      [String(d.members.length), 'مشاركون'],
      [String(d.pins), 'لحظات'],
      [String(d.notes), 'ملاحظات']
    ];
    el.memStats.innerHTML = cells.map(c =>
      '<div class="mem-stat"><b>' + esc(c[0]) + '</b><small>' + esc(c[1]) + '</small></div>'
    ).join('');
    el.memVideos.innerHTML = d.videoList.length
      ? d.videoList.map(t => '<li>' + esc(t) + '</li>').join('')
      : '<li>لم يُعرض أي فيديو بعد</li>';
    el.memPreview.hidden = true;
  }

  async function generateMemoryCard() {
    const btn = el.memGen;
    btn.disabled = true;
    try {
      if (document.fonts && document.fonts.load) {
        await Promise.all([
          document.fonts.load('900 90px Cairo'),
          document.fonts.load('700 40px Cairo'),
          document.fonts.load('400 70px "Grand Hotel"')
        ]).catch(() => { });
      }
      const d = memData();
      const c = document.createElement('canvas');
      c.width = 1080; c.height = 1350;
      const x = c.getContext('2d');

      /* الخلفية: منتصف الليل + توهجات ذهبية */
      const g = x.createLinearGradient(0, 0, 1080, 1350);
      g.addColorStop(0, '#0F1A26'); g.addColorStop(0.55, '#080C14'); g.addColorStop(1, '#131C29');
      x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
      let r = x.createRadialGradient(980, 70, 0, 980, 70, 620);
      r.addColorStop(0, 'rgba(197,165,114,.34)'); r.addColorStop(1, 'rgba(197,165,114,0)');
      x.fillStyle = r; x.fillRect(0, 0, 1080, 1350);
      r = x.createRadialGradient(90, 1290, 0, 90, 1290, 640);
      r.addColorStop(0, 'rgba(182,122,59,.28)'); r.addColorStop(1, 'rgba(182,122,59,0)');
      x.fillStyle = r; x.fillRect(0, 0, 1080, 1350);

      /* إطار ذهبي */
      x.strokeStyle = '#C5A572'; x.lineWidth = 5; x.strokeRect(44, 44, 992, 1262);
      x.strokeStyle = 'rgba(197,165,114,.4)'; x.lineWidth = 1.5; x.strokeRect(62, 62, 956, 1226);

      x.direction = 'rtl'; x.textAlign = 'center';

      /* الترويسة */
      x.fillStyle = '#C5A572';
      x.font = '400 92px "Grand Hotel", cursive';
      x.fillText('WatchTogether', 540, 190);

      x.fillStyle = '#9AA8B8';
      x.font = '700 34px Cairo, sans-serif';
      x.fillText('غـرفة ' + (R.roomId || ''), 540, 250);

      /* العنوان */
      x.fillStyle = '#E8DCC6';
      x.font = '900 86px Cairo, sans-serif';
      x.fillText('ذاكرة السهرة', 540, 390);

      x.strokeStyle = 'rgba(197,165,114,.55)'; x.lineWidth = 2;
      x.beginPath(); x.moveTo(340, 430); x.lineTo(740, 430); x.stroke();

      /* الإحصاءات — شبكة 3×2 مرسومة عند مراكز ثابتة */
      const stats = [
        [fmtDur(d.dur), 'المدة'],
        [String(d.videos), 'فيديو'],
        [String(d.msgs), 'رسالة'],
        [String(d.members.length), 'مشارِك'],
        [String(d.pins), 'لحظة'],
        [d.mood.e + ' ' + d.mood.n, 'الأجواء']
      ];
      const colsX = [790, 540, 290];
      const rowsY = [560, 740];
      stats.forEach((s, i) => {
        const px = colsX[i % 3];
        const py = rowsY[Math.floor(i / 3)];
        x.fillStyle = '#C5A572';
        x.font = '900 54px Cairo, sans-serif';
        x.fillText(s[0], px, py);
        x.fillStyle = '#6B7A8A';
        x.font = '700 30px Cairo, sans-serif';
        x.fillText(s[1], px, py + 50);
      });

      /* الفيديوهات */
      let vy = 980;
      x.textAlign = 'right';
      x.fillStyle = '#9AA8B8';
      x.font = '700 34px Cairo, sans-serif';
      x.fillText('ما شاهدناه:', 940, vy);
      x.font = '700 34px Cairo, sans-serif';
      d.videoList.slice(0, 4).forEach(t => {
        vy += 56;
        x.fillStyle = '#E8DCC6';
        let txt = String(t);
        while (x.measureText(txt).width > 760 && txt.length > 4) txt = txt.slice(0, -5) + '…';
        x.fillText('◂ ' + txt, 940, vy);
      });
      if (!d.videoList.length) {
        vy += 56;
        x.fillStyle = '#6B7A8A';
        x.fillText('◂ لم يُعرض فيديو بعد', 940, vy);
      }

      /* المشاركون */
      x.textAlign = 'center';
      x.fillStyle = 'rgba(197,165,114,.9)';
      x.font = '700 32px Cairo, sans-serif';
      const names = d.members.slice(0, 6).join(' · ') || '—';
      x.fillText(names, 540, 1230);

      x.fillStyle = '#6B7A8A';
      x.font = '700 28px Cairo, sans-serif';
      x.fillText(new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) +
        ' · أُنشئت في ' + new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }), 540, 1288);

      el.memImg.src = c.toDataURL('image/png');
      el.memPreview.hidden = false;
      el.memDownload.href = el.memImg.src;
      el.memDownload.download = 'watchtogether-memory-' + (R.roomId || 'room') + '.png';
      el.memPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      console.error(e);
      U.toast('تعذّر إنشاء البطاقة', 'error');
    } finally { btn.disabled = false; }
  }

  async function shareDataUrl(dataUrl, name, text) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: text });
        return true;
      }
    } catch (e) { }
    return false;
  }

  /* ============================== 4) ملاحظات الأريكة ============================== */
  function paintNotes() {
    const list = [...state.notes.values()].sort((a, b) => a.t - b.t || a.v - b.v);
    el.notesEmpty.hidden = list.length > 0;
    el.notesList.innerHTML = list.map(n => {
      const mine = n.c === R.session.clientId;
      const canDel = mine || R.canControl();
      return '<div class="note" data-note-id="' + esc(n.id) + '">' +
        '<button type="button" class="note__t" data-note-seek="' + n.t + '" title="انتقل إلى هذه اللحظة">' + U.fmtTime(n.t) + '</button>' +
        '<span class="note__x">' + esc(n.x) + '</span>' +
        '<span class="note__by">' + esc(n.n || '') + '</span>' +
        (canDel ? '<button type="button" class="note__del" data-note-del="' + esc(n.id) + '" title="حذف الملاحظة">×</button>' : '') +
        '</div>';
    }).join('');
    const count = list.length;
    if (el.notesBadge) {
      el.notesBadge.hidden = count === 0;
      el.notesBadge.textContent = String(count);
    }
  }

  function addNote() {
    const x = String(el.noteInput.value || '').trim();
    if (!x) { U.toast('اكتب الملاحظة أولاً', 'warn'); return; }
    if (x.length > 240) { U.toast('الملاحظة أطول من 240 محرفاً', 'warn'); return; }
    const t = Math.floor((R.player.getCurrentTime && R.player.getCurrentTime()) || 0);
    const meta = { id: U.uid('n'), t: t, x: x, n: R.session.name, c: R.session.clientId, v: Date.now() };
    /* نطبّق محلياً ثم نرسل — معالِج onMessage يمرّر الحدث الهوّي بنفس المعرف (لا تكرار) */
    if (sendEvent('note', meta)) {
      el.noteInput.value = '';
      el.noteInput.focus();
    }
  }

  function delNote(id) {
    const n = state.notes.get(id);
    if (!n) return;
    if (!(n.c === R.session.clientId || R.canControl())) return;
    sendEvent('note-del', { id: id, v: Date.now() });
  }

  /* تصدير: نافذة طباعة (PDF عبر مُنظِّم الطباعة) — مع بديل تنزيل إن حُجبت النافذة */
  function exportNotes() {
    const list = [...state.notes.values()].sort((a, b) => a.t - b.t || a.v - b.v);
    if (!list.length) { U.toast('لا ملاحظات للتصدير', 'warn'); return; }
    const rows = list.map((n, i) =>
      '<tr><td class="t">' + U.fmtTime(n.t) + '</td><td class="x">' + esc(n.x) + '</td><td class="n">' + esc(n.n || '—') + '</td></tr>'
    ).join('');
    const html =
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<title>ملاحظات السهرة — ' + esc(R.roomId || '') + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">' +
      '<style>body{font-family:Cairo,sans-serif;background:#080C14;color:#E8DCC6;margin:0;padding:40px 32px}' +
      'h1{color:#C5A572;font-size:30px;margin:0 0 4px}.sub{color:#9AA8B8;font-size:13px;margin:0 0 26px}' +
      'table{width:100%;border-collapse:collapse}td,th{padding:11px 12px;border-bottom:1px solid #233044;text-align:right;font-size:14px;vertical-align:top}' +
      'th{color:#C5A572;font-size:12px;border-bottom:2px solid #C5A572}td.t{font-family:monospace;color:#C5A572;font-weight:700;white-space:nowrap;width:74px}' +
      'td.n{color:#6B7A8A;font-size:12px;white-space:nowrap;width:90px}@media print{body{background:#fff;color:#111}' +
      'h1{color:#8a6a2e}th{color:#8a6a2e;border-color:#8a6a2e}td.t{color:#8a6a2e}td,th{border-color:#ddd}td.n{color:#888}}' +
      '</style></head><body>' +
      '<h1>ملاحظات السهرة 📝</h1>' +
      '<p class="sub">غرفة ' + esc(R.roomId || '') + ' · ' + list.length + ' ملاحظة · ' +
      new Date().toLocaleDateString('ar-EG') + ' — WatchTogether</p>' +
      '<table><thead><tr><th>الوقت</th><th>الملاحظة</th><th>الكاتب</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.print()}catch(e){}},400)});<\/script>' +
      '</body></html>';
    let w = null;
    try { w = window.open('', '_blank'); } catch (e) { }
    if (w && w.document) {
      w.document.write(html);
      w.document.close();
      U.toast('فُتحت نافذة الطباعة — اختر «حفظ كـ PDF»', 'success', 3400);
    } else {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'watchtogether-notes-' + (R.roomId || 'room') + '.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      U.toast('حُجبت نافذة الطباعة — نُزّل الملف وافتحه ثم اطبعه كـ PDF', 'info', 4200);
    }
  }

  /* ============================== 5) اللحظات الزمنية ============================== */
  function pinsForUrl(url) {
    return [...state.pins.values()].filter(p => p.u === url).sort((a, b) => a.t - b.t);
  }

  function paintPins() {
    if (!el.momentsTrack) return;
    const url = R.state.url || '';
    el.momentsRail.hidden = !url;
    if (!url) return;
    const dur = (R.player.getDuration && R.player.getDuration()) || 0;
    const old = el.momentsTrack.querySelectorAll('.mpin');
    old.forEach(n => n.remove());
    pinsForUrl(url).forEach(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mpin';
      b.dataset.pinId = p.id;
      b.textContent = p.e;
      b.title = U.fmtTime(p.t) + ' — ' + (p.n || '') + (p.c === R.session.clientId ? ' (أنت)' : '');
      const pct = dur > 0 ? Math.max(0, Math.min(100, (p.t / dur) * 100)) : 50;
      b.style.insetInlineStart = pct + '%';
      el.momentsTrack.appendChild(b);
    });
    paintHead();
  }

  function paintHead() {
    if (!el.momentsHead || el.momentsRail.hidden) return;
    const dur = (R.player.getDuration && R.player.getDuration()) || 0;
    const cur = (R.player.getCurrentTime && R.player.getCurrentTime()) || 0;
    if (!dur || !R.player.isReady || !R.player.isReady()) { el.momentsHead.hidden = true; return; }
    el.momentsHead.hidden = false;
    el.momentsHead.style.insetInlineStart = Math.max(0, Math.min(100, (cur / dur) * 100)) + '%';
  }

  function openPinPicker(anchor) {
    const pick = el.pinPicker;
    pick.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const pw = pick.offsetWidth, ph = pick.offsetHeight;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
    let top = rect.top - ph - 10;
    if (top < 10) top = rect.bottom + 10;
    pick.style.left = left + 'px';
    pick.style.top = top + 'px';
    pick.dataset.anchor = anchor.id || '';
    document.querySelectorAll('.fbtn.is-on[data-pin-open]').forEach(b => b.classList.remove('is-on'));
    if (anchor.classList.contains('fbtn')) anchor.classList.add('is-on');
  }

  function closePinPicker() {
    if (!el.pinPicker) return;
    el.pinPicker.hidden = true;
    document.querySelectorAll('.fbtn.is-on[data-pin-open]').forEach(b => b.classList.remove('is-on'));
    if (el.momentsAdd) { /* لا شيء */ }
  }

  function pinWith(emoji) {
    closePinPicker();
    if (!R.state.url) { U.toast('لا يوجد فيديو لربط اللحظة به', 'warn'); return; }
    const t = Math.floor((R.player.getCurrentTime && R.player.getCurrentTime()) || 0);
    sendEvent('pin', {
      id: U.uid('p'), t: t, e: emoji, n: R.session.name,
      c: R.session.clientId, v: Date.now(), u: R.state.url
    });
    U.toast('ثُبّت التفاعل عند ' + U.fmtTime(t), 'success', 2000);
  }

  /* ============================== 6) التصويت الديمقراطي 70% ============================== */
  function presentCount() {
    const n = Object.keys(R.session.members || {}).length;
    return Math.max(1, n);
  }
  function voteNeed() { return Math.max(1, Math.ceil(0.7 * presentCount())); }

  function tally(qid) {
    const m = state.votes.get(qid);
    let yes = 0;
    if (m) {
      const now = Date.now();
      m.forEach((e, cid) => {
        if (now - e.ts > VOTE_TTL) m.delete(cid);
        else if (e.v === 1) yes++;
      });
      if (!m.size) state.votes.delete(qid);
    }
    return { yes: yes, need: voteNeed(), present: presentCount() };
  }

  function executeVote(qid) {
    const item = (R.session.queue || []).find(x => String(x.id) === String(qid));
    if (!item) return;
    if (R.state.url === item.url && R.state.playing) return; /* سبق لغيرك التنفيذ */
    if (R.canControl()) {
      R.playQueueItemById(qid);
    } else {
      U.toast('أقرّ التصويت ✓ — بانتظار تنفيذ المنظّم', 'success', 3600);
    }
  }

  function checkVote(qid, live) {
    const t = tally(qid);
    if (t.yes < t.need) { if (t.yes === 0) state.fired.delete(qid); return false; }
    if (!live) return true;    /* من السجل الهوّي: نعرض «أقرّ» فقط بلا تنفّذ مفاجئ */
    if (state.fired.has(qid)) return true;
    state.fired.add(qid);
    executeVote(qid);
    return true;
  }

  function toggleVote(qid) {
    if (!R.session.ready) { U.toast('لم يكتمل الاتصال بعد', 'warn'); return; }
    const m = state.votes.get(qid) || new Map();
    const mine = m.get(R.session.clientId);
    const v = mine && mine.v === 1 ? 0 : 1;
    sendEvent('vote', { q: qid, v: v, n: R.session.name, c: R.session.clientId, ts: Date.now() });
  }

  /* رسم/تحديث شريط التصويت داخل عنصر القائمة */
  function decorateQueue() {
    if (!el.queueList || !R.session.queue) return;
    const ids = new Set((R.session.queue || []).map(x => String(x.id)));
    state.votes.forEach((_, qid) => { if (!ids.has(qid)) { state.votes.delete(qid); state.fired.delete(qid); } });
    el.queueList.querySelectorAll('.queue-item').forEach(item => {
      const qid = String(item.dataset.queueId || '');
      if (!qid) return;
      let qv = item.querySelector('.qv');
      if (!qv) {
        item.classList.add('has-vote');
        qv = document.createElement('div');
        qv.className = 'qv';
        item.appendChild(qv);
      }
      updateQv(qv, qid);
    });
  }

  function updateQv(qv, qid) {
    const t = tally(qid);
    const passed = t.yes >= t.need;
    const pct = Math.max(0, Math.min(100, (t.yes / Math.max(1, t.need)) * 100));
    const showBtn = !R.canControl();
    let html =
      '<span class="qv__row"><i class="qv__fill' + (passed ? ' is-pass' : '') + '" style="width:' + pct + '%"></i></span>' +
      '<span class="qv__count">' + t.yes + '/' + t.need + ' <small>· يلزم 70٪ من ' + t.present + '</small></span>';
    if (passed) html += '<span class="qv__pass">✓ أقرّ التصويت</span>';
    else if (showBtn) {
      const m = state.votes.get(qid);
      const mine = m && m.get(R.session.clientId);
      const on = mine && mine.v === 1;
      html += '<button type="button" class="qv__btn' + (on ? ' is-on' : '') + '" data-vote-q="' + esc(qid) + '">' +
        (on ? '✓ موافق — تراجع' : 'اقترح التشغيل 👍') + '</button>';
    }
    if (qv.dataset.sig !== html) { qv.innerHTML = html; qv.dataset.sig = html; }
  }

  function refreshVotes() {
    if (!el.queueList) return;
    el.queueList.querySelectorAll('.queue-item').forEach(item => {
      const qid = String(item.dataset.queueId || '');
      const qv = item.querySelector('.qv');
      if (qid && qv) updateQv(qv, qid);
    });
  }

  /* ============================== ناقل الأحداث Incoming ============================== */
  function onMessage(m, d, opts) {
    if (!m) return false;
    const meta = (d && d.meta) || {};
    const kind = m.kind || meta.a || '';
    if (['mood', 'pin', 'note', 'note-del', 'vote'].indexOf(kind) === -1) return false;
    const silent = !!(opts && opts.silent);
    try {
      if (kind === 'mood') {
        applyMood({ m: meta.m, v: Number(meta.v) || 0, n: meta.n }, opts);
      } else if (kind === 'pin') {
        const id = String(meta.id || '');
        if (!id) return true;
        state.pins.set(id, {
          id: id, t: Math.max(0, Number(meta.t) || 0), e: String(meta.e || '📌').slice(0, 4),
          n: String(meta.n || '').slice(0, 30), c: String(meta.c || ''),
          v: Number(meta.v) || 0, u: String(meta.u || '')
        });
        while (state.pins.size > PINS_CAP) {
          let oldest = null;
          state.pins.forEach(p => { if (!oldest || p.v < oldest.v) oldest = p; });
          if (oldest) state.pins.delete(oldest.id); else break;
        }
        paintPins();
      } else if (kind === 'note') {
        const id = String(meta.id || '');
        if (!id) return true;
        state.notes.set(id, {
          id: id, t: Math.max(0, Number(meta.t) || 0), x: String(meta.x || '').slice(0, 240),
          n: String(meta.n || '').slice(0, 30), c: String(meta.c || ''), v: Number(meta.v) || 0
        });
        while (state.notes.size > NOTES_CAP) {
          let oldest = null;
          state.notes.forEach(n => { if (!oldest || n.v < oldest.v) oldest = n; });
          if (oldest) state.notes.delete(oldest.id); else break;
        }
        if (!el.notesModal || !el.notesModal.hidden) paintNotes();
        else if (el.notesBadge) {
          el.notesBadge.hidden = false;
          el.notesBadge.textContent = String(state.notes.size);
        }
      } else if (kind === 'note-del') {
        state.notes.delete(String(meta.id || ''));
        if (!el.notesModal || !el.notesModal.hidden) paintNotes();
        else if (el.notesBadge) {
          const n = state.notes.size;
          el.notesBadge.hidden = n === 0;
          el.notesBadge.textContent = String(n);
        }
      } else if (kind === 'vote') {
        const qid = String(meta.q || '');
        if (!qid) return true;
        let m2 = state.votes.get(qid);
        if (!m2) { m2 = new Map(); state.votes.set(qid, m2); }
        const cid = String(meta.c || m.client || '');
        if (!cid) return true;
        const prev = m2.get(cid);
        const v = Number(meta.v) === 1 ? 1 : 0;
        const ts = Number(meta.ts) || Date.now();
        if (prev && prev.ts >= ts) return true;
        if (v === 0) m2.delete(cid);
        else m2.set(cid, { v: 1, ts: ts, n: String(meta.n || '') });
        if (!v && state.fired.has(qid) && tally(qid).yes < voteNeed()) state.fired.delete(qid);
        checkVote(qid, !silent);
        refreshVotes();
      }
    } catch (e) { console.warn('[WTFeatures] حدث ميزات', e); }
    return true;
  }
  window.WTFeatures = { onMessage: onMessage };

  /* ============================== النوافذ ============================== */
  function openModal(m) {
    [el.moodModal, el.notesModal, el.memModal, el.snapModal].forEach(x => {
      if (x && x !== m) x.hidden = true;
    });
    /* إسكات نوافذ الغرفة حتى لا يُغلق اثنتان بمفتاح Escape واحد */
    ['playlistModal', 'qrModal', 'meModal', 'diagModal'].forEach(id => {
      const x = document.getElementById(id);
      if (x) x.hidden = true;
    });
    if (m) m.hidden = false;
    closePinPicker();
  }
  function closeModal(m) { if (m) m.hidden = true; }
  function anyFeatureOpen() {
    return [el.moodModal, el.notesModal, el.memModal, el.snapModal].some(m => m && !m.hidden) ||
      (el.pinPicker && !el.pinPicker.hidden);
  }
  function closeTopFeature() {
    if (el.pinPicker && !el.pinPicker.hidden) { closePinPicker(); return true; }
    const open = [el.moodModal, el.notesModal, el.memModal, el.snapModal].find(m => m && !m.hidden);
    if (open) { open.hidden = true; return true; }
    return false;
  }

  /* ============================== الربط ============================== */
  function wire() {
    /* شريط الميزات */
    el.moodBtn.addEventListener('click', () => { markMoodCard(); openModal(el.moodModal); });
    el.pinBtn.addEventListener('click', () => { dataPinOpen(el.pinBtn); });
    el.notesBtn.addEventListener('click', () => { paintNotes(); syncNoteTime(); openModal(el.notesModal); el.noteInput.focus(); });
    el.snapBtn.addEventListener('click', snapShot);
    el.memBtn.addEventListener('click', () => { paintMemStats(); openModal(el.memModal); });
    el.moodChip.addEventListener('click', () => { markMoodCard(); openModal(el.moodModal); });

    function dataPinOpen(btn) {
      if (el.pinPicker && !el.pinPicker.hidden) { closePinPicker(); return; }
      if (!R.state.url) { U.toast('شغّل فيديو أولاً ثم ثبّت لحظتك', 'warn'); return; }
      btn.dataset.pinOpen = '1';
      openPinPicker(btn);
    }

    /* منتقي الإيموجي — يُبنى من قائمة تفاعلات الدردشة نفسها */
    const reactions = (CFG.chat && Array.isArray(CFG.chat.reactions) && CFG.chat.reactions.length)
      ? CFG.chat.reactions.slice(0, 14)
      : ['👍', '❤️', '😂', '😮', '🔥', '👏', '🍿'];
    el.pinPicker.innerHTML = reactions.map(e =>
      '<button type="button" class="pin-picker__btn" data-e="' + esc(e) + '" title="ثبّت ' + esc(e) + ' عند الوقت الحالي">' + esc(e) + '</button>'
    ).join('');
    el.pinPicker.querySelectorAll('.pin-picker__btn').forEach(b => {
      b.addEventListener('click', () => pinWith(b.dataset.e));
    });
    el.momentsAdd.addEventListener('click', () => dataPinOpen(el.momentsAdd));

    /* نقر على لحظة مثبتة → انتقال (ببوابة التحكم) */
    el.momentsTrack.addEventListener('click', (e) => {
      const b = e.target.closest('.mpin');
      if (!b) return;
      const p = state.pins.get(b.dataset.pinId);
      if (!p) return;
      if (!R.seekTo(p.t)) return; /* requireControl يُظهر رسالة الصلاحية داخل seekTo */
    });

    /* الأجواء */
    el.moodGrid.addEventListener('click', (e) => {
      const c = e.target.closest('.mood-card');
      if (c) pickMood(c.dataset.mood);
    });

    /* الملاحظات */
    el.noteAdd.addEventListener('click', addNote);
    el.noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } });
    el.notesList.addEventListener('click', (e) => {
      const seek = e.target.closest('[data-note-seek]');
      if (seek) { R.seekTo(Number(seek.dataset.noteSeek) || 0); return; }
      const del = e.target.closest('[data-note-del]');
      if (del) delNote(del.dataset.noteDel);
    });
    el.notesExport.addEventListener('click', exportNotes);

    /* الذاكرة */
    el.memGen.addEventListener('click', generateMemoryCard);

    /* اللقطة */
    el.snapDownload.addEventListener('click', (e) => {
      e.preventDefault();
      const a = document.createElement('a');
      a.href = el.snapImg.src; a.download = snapFileName(); a.click();
    });
    el.snapShare.addEventListener('click', async () => {
      const ok = await shareDataUrl(el.snapImg.src, snapFileName(), 'لحظة من سهرتنا 🎬');
      if (!ok) { U.toast('المشاركة غير مدعومة هنا — استخدم الحفظ', 'warn'); }
    });
    el.snapSend.addEventListener('click', async () => {
      const canvas = el._snapCanvas;
      if (!canvas) return;
      try {
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
        if (!blob) throw new Error('no blob');
        const file = new File([blob], snapFileName(), { type: 'image/jpeg' });
        el.snapModal.hidden = true;
        R.media.handleFiles([file]);
        const ok = await R.media.sendWithMedia('📷 لقطة سينما عند ' +
          U.fmtTime((R.player.getCurrentTime && R.player.getCurrentTime()) || 0));
        if (ok) U.toast('أُرسلت اللقطة إلى الدردشة', 'success', 2600);
      } catch (e) {
        console.error(e);
        U.toast('تعذّر إرسال اللقطة — جرّب الحفظ', 'error');
      }
    });

    /* إغلاق النوافذ: خلفية + أزرار الإغلاق */
    [el.moodModal, el.notesModal, el.memModal, el.snapModal].forEach(m => {
      if (!m) return;
      m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
      const close = m.querySelector('[data-close]');
      if (close) close.addEventListener('click', () => { m.hidden = true; });
    });

    /* Escape للأدوات + نقر خارج المنتقي — مرحلة الأسراف حتى نسبق مُعالج الغرفة */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && anyFeatureOpen()) { e.preventDefault(); e.stopPropagation(); closeTopFeature(); }
    }, true);
    document.addEventListener('pointerdown', (e) => {
      if (!el.pinPicker || el.pinPicker.hidden) return;
      if (e.target.closest('#pinPicker') || e.target.closest('#momentsAdd') || e.target.closest('#pinBtn')) return;
      closePinPicker();
    });

    /* تصويت القائمة — نفَض عبر الحاوية (يصمد أمام إعادة الرسم) */
    if (el.queueList) {
      el.queueList.addEventListener('click', (e) => {
        const b = e.target.closest('[data-vote-q]');
        if (b) toggleVote(b.dataset.voteQ);
      });
      if (window.MutationObserver) {
        const obs = new MutationObserver(() => decorateQueue());
        obs.observe(el.queueList, { childList: true });
      }
    }
  }

  /* ============================== الحلقة الرئيسية ============================== */
  let tickN = 0, lastUrl = '';
  function tick() {
    if (!R) return;
    tickN++;
    const url = R.state.url || '';
    if (url !== lastUrl) { lastUrl = url; paintPins(); }  /* تبديل الفيديو → رسم فوري للشريط */
    paintHead();
    if (!el.notesModal || !el.notesModal.hidden) syncNoteTime();
    if (tickN % 2 === 0) { memTick(); refreshVotes(); }
    if (tickN % 10 === 0) paintPins(); /* موضع الدبوس يتبدّل مع مدة جديدة */
  }

  function syncNoteTime() {
    if (!el.noteTime || (el.notesModal && el.notesModal.hidden)) return;
    const cur = (R.player.getCurrentTime && R.player.getCurrentTime()) || 0;
    el.noteTime.textContent = U.fmtTime(cur);
  }

  /* ============================== الإقلاع ============================== */
  whenReady((room) => {
    R = room;
    grabEls();
    /* المزاج المحفوظ: رسم فوري قبل وصول سجل الغرفة */
    try {
      const saved = U.store.get(moodKey(), null);
      if (saved && saved.id) applyMood({ m: saved.id, v: saved.v || 0, n: saved.n }, { silent: true });
      else applyMood({ m: 'classic', v: 0, n: '' }, { silent: true });
    } catch (e) { }
    wire();
    paintNotes();
    decorateQueue();
    paintPins();
    memTick();
    setInterval(tick, 1000);
  });
})();

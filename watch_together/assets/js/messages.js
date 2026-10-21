/* Private friend messaging. Account-scoped drafts/outbox; real monotonic change cursors.
   Polling is bounded, non-overlapping, pauses off-screen, and never invents online/delivery status. */
(function () {
  'use strict';
  const S = window.WTSocial, C = window.WTSocialUI, U = window.WTUtil, A = window.WTAuth, { $, esc, icon } = C;
  const numeric = value => /^\d{1,19}$/.test(String(value || ''));
  const nonceOK = value => /^[a-f0-9]{48,128}$/.test(value || '');
  const newer = (a,b) => BigInt(a || '0') > BigInt(b || '0');
  const G = window.WTDMGestures;
  const state = { uid:null,threads:[],threadOffset:0,threadMore:false,threadBusy:false,threadPromise:null,threadKey:'',listController:null,
    active:null,contexts:new Map(),selection:0,timer:null,ticking:false,stopped:false,lastList:0,newFriends:[],friendOffset:0,friendBusy:false,
    showArchived:false,hiddenArchived:0,threadMenu:null };
  let storageAvailable = false;
  try { localStorage.setItem('wt:dm-storage-check','1'); localStorage.removeItem('wt:dm-storage-check'); storageAvailable = true; } catch (_) { /* memory-only mode is labelled below */ }
  const ownsContext = ctx => !!ctx && ctx.uid === state.uid && (A.accountUser() || {}).id === ctx.uid;
  const draftKey = ctx => 'dm-draft:' + ctx.uid + ':' + ctx.id;
  const outboxKey = (ctx,nonce) => 'dm-outbox:' + ctx.uid + ':' + ctx.id + ':' + nonce;
  function savedDraft(ctx) {
    const d = U.store.get(draftKey(ctx),{}) || {};
    return { text:String(d.text || '').slice(0,2000),replyId:numeric(d.replyId) ? String(d.replyId) : null,editId:numeric(d.editId) ? String(d.editId) : null,
      beforeEdit: d.beforeEdit ? {text:String(d.beforeEdit.text || '').slice(0,2000),replyId:numeric(d.beforeEdit.replyId) ? String(d.beforeEdit.replyId) : null} : null };
  }
  function persistDraft(ctx) {
    if (!ownsContext(ctx)) return; // pagehide/late replies must not resurrect data after logout.
    if (ctx.draft.text || ctx.draft.replyId || ctx.draft.editId) U.store.set(draftKey(ctx),ctx.draft); else U.store.del(draftKey(ctx));
  }
  function getOutbox(ctx) {
    const prefix = 'wt:' + outboxKey(ctx,'');
    try {
      Object.keys(localStorage).filter(key => key.startsWith(prefix)).slice(0,20).forEach(key => {
        const nonce = key.slice(prefix.length), item = U.store.get(key.slice(3),null);
        if (!nonceOK(nonce) || !item || typeof item.body !== 'string' || item.body.length > 2000) return;
        if (ctx.outbox.has(nonce)) return;
        ctx.outbox.set(nonce,{nonce,body:item.body,replyId:numeric(item.replyId) ? String(item.replyId) : null,
          roomId:/^[A-Z0-9]{4,12}$/.test(item.roomId || '') ? item.roomId : null,roomTitle:String(item.roomTitle || '').slice(0,120),
          createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date().toISOString(),status:'failed',error:'لم يصل تأكيد الإرسال. يمكنك إعادة المحاولة بأمان.'});
      });
    } catch (_) { /* blocked storage */ }
  }
  function persistPending(ctx,item) { if (ownsContext(ctx)) U.store.set(outboxKey(ctx,item.nonce),item); }
  function forgetPending(ctx,nonce) { ctx.outbox.delete(nonce); U.store.del(outboxKey(ctx,nonce)); }
  function context(id,seed) {
    let ctx = state.contexts.get(id);
    if (!ctx) {
      ctx = { id,uid:state.uid,peer:seed && seed.peer,canSend:!!(seed && seed.can_send),messages:new Map(),ids:new Set(),cursor:null,oldest:null,more:false,initialized:false,
        controller:new AbortController(),loadToken:0,loading:false,sendBusy:false,editBusy:false,readBusy:false,lastRead:'0',peerRead:null,typing:false,lastTyping:0,outbox:new Map(),draft:null,renderKey:'',scrollTop:null };
      ctx.draft = savedDraft(ctx); getOutbox(ctx); state.contexts.set(id,ctx);
    }
    return ctx;
  }
  function time(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ar-DZ',{hour:'2-digit',minute:'2-digit'}) : ''; }
  function visibleChat(ctx) { return ownsContext(ctx) && ctx === state.active && document.visibilityState !== 'hidden' && !$('socialContent').hidden && !$('chatActive').hidden && $('chatScroll').clientHeight > 0 && !document.querySelector('dialog[open]') && (!matchMedia('(max-width:600px)').matches || document.body.classList.contains('chat-open')); }
  function atBottom() { const el = $('chatScroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 100; }
  function scrollBottom() { $('chatScroll').scrollTop = $('chatScroll').scrollHeight; $('chatNewMessages').hidden = true; }
  function listRender() {
    const query = $('threadQuery').value.trim().toLocaleLowerCase();
    const rows = state.threads.filter(t => ((t.peer && t.peer.display_name) || '').toLocaleLowerCase().includes(query) || ((t.peer && t.peer.username) || '').toLocaleLowerCase().includes(query));
    const key = JSON.stringify([rows,state.active && state.active.id,query]); if (key === state.threadKey) return; state.threadKey = key;
    const focus = document.activeElement && document.activeElement.closest('[data-thread]'); const focusId = focus && focus.dataset.thread;
    $('threadList').innerHTML = rows.length ? rows.map(t => {
      const p = t.peer || {}, m = t.preview, prefs = t.prefs || {};
      const preview = !m ? 'ابدأ أول رسالة' : m.deleted_at ? 'رسالة محذوفة' : (m.sender_id === state.uid ? 'أنت: ' : '') + (m.kind === 'call' ? '📞 ' : m.kind === 'room' ? 'دعوة: ' : '') + m.body;
      const flags = (prefs.pinned ? '<span class="thread-flag" title="مثبّتة" aria-label="مثبّتة">' + icon('pin',12) + '</span>' : '') +
        (prefs.muted ? '<span class="thread-flag thread-flag--muted" title="مكتومة" aria-label="مكتومة">' + icon('mute',12) + '</span>' : '');
      /* الكتم يخفي شارة العدّاد فقط؛ الرسائل تُقرأ كالعادة ولا نخفي شيئاً */
      const unread = t.unread && !prefs.muted ? '<b class="thread-unread" aria-label="' + Number(t.unread) + ' غير مقروءة">' + Math.min(99,Number(t.unread)) + '</b>' : '';
      return '<div class="thread-row' + (state.active && state.active.id === t.id ? ' is-active' : '') + '">' +
        '<button type="button" class="thread-item" data-thread="' + esc(t.id) + '"' + (state.active && state.active.id === t.id ? ' aria-current="true"' : '') + '>' + C.avatar(p,'sm') +
        '<span class="thread-item-main"><span class="thread-item-title"><strong>' + esc(p.display_name || 'عضو') + flags + '</strong><time datetime="' + esc(t.updated_at) + '">' + esc(C.date(t.updated_at)) + '</time></span>' +
        '<span class="thread-item-bottom"><span class="thread-item-preview">' + esc(preview) + '</span>' + unread + '</span></span></button>' +
        '<button type="button" class="thread-more-btn" data-thread-menu="' + esc(t.id) + '" aria-label="خيارات محادثة ' + esc(p.display_name || 'عضو') + '" title="خيارات المحادثة">⋯</button>' +
        '</div>';
    }).join('') : C.empty('chat',query ? 'لا محادثة بهذا الاسم' : (state.showArchived ? 'لا محادثة مؤرشفة' : 'لا محادثات بعد'),query ? 'جرّب اسمًا آخر ضمن المحادثات المحمّلة.' : (state.showArchived ? 'الأرشفة تُخفي المحادثة من القائمة، ويمكنك فكّها من هنا في أي وقت.' : 'ابدأ حديثًا مع أحد أصدقائك.'));
    if (focusId) { const b = $('threadList').querySelector('[data-thread="' + focusId + '"]'); if (b) b.focus({preventScroll:true}); }
    $('threadsMore').hidden = !state.threadMore;
    const archivedBtn = $('threadArchived'), archivedCount = $('threadArchivedCount');
    archivedBtn.setAttribute('aria-pressed', String(!!state.showArchived));
    archivedBtn.classList.toggle('is-active', !!state.showArchived);
    archivedBtn.title = state.showArchived ? 'العودة إلى المحادثات النشطة' : 'إظهار المحادثات المؤرشفة';
    archivedCount.hidden = !!state.showArchived || !state.hiddenArchived;
    archivedCount.textContent = state.showArchived ? '' : String(state.hiddenArchived || '');
  }
  async function loadThreads(append,quiet) {
    if (state.threadBusy) return state.threadPromise;
    state.threadBusy = true; $('threadsMore').disabled = true; state.listController = new AbortController();
    state.threadPromise = (async () => {
      try {
        const data = await S.call('threads',{p_offset:append ? state.threadOffset : 0,p_archived:!!state.showArchived},state.listController.signal);
        if (!data || !Array.isArray(data.threads)) throw new Error('تعذّر قراءة قائمة المحادثات.');
        const rows = data.threads.filter(t => S.UUID.test(t.id || ''));
        state.threads = append ? [...new Map([...state.threads,...rows].map(t => [t.id,t])).values()] : [...rows,...state.threads.filter(old => !rows.some(t => t.id === old.id))];
        state.threads.sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        if (append) state.threadOffset += data.threads.length; else if (!quiet || !state.threadOffset) state.threadOffset = data.threads.length;
        if (append || state.threadOffset <= 30) state.threadMore = !!data.has_more;
        if (data.counts) C.setCounts(data.counts);
        if (data.hidden_archived != null) state.hiddenArchived = Number(data.hidden_archived) || 0;
        if (data.archived != null && !!data.archived !== !!state.showArchived) state.showArchived = !!data.archived;
        state.lastList = Date.now(); listRender();
        C.error('messagesError',null);
      } catch (err) { if (err.name !== 'AbortError') C.error('messagesError',err,() => loadThreads(false,false)); }
      finally { state.threadBusy = false; $('threadsMore').disabled = false; }
    })();
    return state.threadPromise;
  }
  function merge(ctx,rows,history) {
    let incoming = false;
    for (const m of rows || []) {
      if (!m || !numeric(m.id) || m.thread_id !== ctx.id || !numeric(m.version)) continue;
      const old = ctx.messages.get(String(m.id));
      if (old && newer(old.version,m.version)) continue;
      ctx.messages.set(String(m.id),m);
      if (history || ctx.ids.has(String(m.id)) || !ctx.oldest || !newer(ctx.oldest,m.id)) ctx.ids.add(String(m.id));
      if (!old && m.sender_id !== state.uid && !m.deleted_at) incoming = true;
      if (m.sender_id === state.uid && ctx.outbox.has(m.nonce)) forgetPending(ctx,m.nonce);
    }
    const ids = [...ctx.ids].sort((a,b) => newer(a,b) ? 1 : a === b ? 0 : -1); ctx.oldest = ids[0] || null;
    return incoming;
  }
  function quote(ctx,m) {
    if (!m.reply_id) return '';
    const r = ctx.messages.get(String(m.reply_id)) || m.reply;
    if (!r) return '';
    const name = r.sender_id === state.uid ? 'أنت' : (ctx.peer && ctx.peer.display_name) || 'الطرف الآخر';
    return '<button type="button" class="dm-quote" data-msg-jump="' + esc(m.reply_id) + '" title="انتقل إلى الرسالة الأصلية">' + esc(name) + ' · ' + esc(r.deleted_at ? 'رسالة محذوفة' : (r.kind === 'room' ? 'دعوة: ' : '') + String(r.body || '').slice(0,120)) + '</button>';
  }
  function messageHTML(ctx,m) {
    const own = m.sender_id === state.uid, deleted = !!m.deleted_at, read = own && numeric(ctx.peerRead) && !newer(m.id,ctx.peerRead);
    const room = !deleted && m.kind === 'room' && /^[A-Z0-9]{4,12}$/.test(m.room_id || '');
    const callLog = !deleted && m.kind === 'call';
    const reaction = !deleted && m.reaction && (!G || G.reactionAllowed(m.reaction))
      ? '<span class="dm-reaction" role="img" aria-label="تفاعل ' + esc(m.reaction) + '">' + esc(m.reaction) + '</span>' : '';
    const content = deleted ? '<p class="dm-text">حُذفت هذه الرسالة</p>' : callLog ? '<div class="dm-call-log"><span class="dm-call-log__ic" aria-hidden="true">' + icon('phoneCall',16) + '</span><span dir="auto">' + esc(m.body) + '</span></div>' : room ? '<a class="dm-invite" href="room.html?id=' + encodeURIComponent(m.room_id) + '">' + icon('film',26) + '<span><small>دعوة إلى غرفة مشاهدة</small><strong>' + esc(m.body) + '</strong></span><span class="dm-invite-arrow">' + icon('arrowLeft',16) + '</span></a>' : '<p class="dm-text" dir="auto">' + esc(m.body) + '</p>';
    let actions = '';
    if (!deleted) actions = callLog
      ? '<button type="button" data-msg-action="copy" title="نسخ" aria-label="نسخ نص المكالمة">' + icon('copy',14) + '</button>' + (own ? '<button type="button" data-msg-action="delete" title="حذف للجميع" aria-label="حذف سجل المكالمة">' + icon('trash',14) + '</button>' : '')
      : (ctx.canSend ? '<button type="button" data-msg-action="react" title="تفاعل ❤️" aria-label="تفاعل سريع على الرسالة">' + icon('heart',14) + '</button>' +
          '<button type="button" data-msg-action="reply" title="رد" aria-label="رد على الرسالة">' + icon('reply',14) + '</button>' : '') + '<button type="button" data-msg-action="copy" title="نسخ" aria-label="نسخ الرسالة">' + icon('copy',14) + '</button>' + (own && ctx.canSend && m.kind === 'text' ? '<button type="button" data-msg-action="edit" title="تعديل" aria-label="تعديل الرسالة">' + icon('pencil',14) + '</button>' : '') + (own ? '<button type="button" data-msg-action="delete" title="حذف للجميع" aria-label="حذف رسالتك للجميع">' + icon('trash',14) + '</button>' : '');
    if (ctx.editBusy) actions = actions.replace(/<button /g,'<button disabled ');
    return '<article class="dm-row' + (own ? '' : ' dm-row--other') + (deleted ? ' is-deleted' : '') + '" data-message="' + esc(m.id) + '" role="listitem" aria-label="' + (own ? 'رسالتك' : 'رسالة من ' + esc((ctx.peer && ctx.peer.display_name) || 'الطرف الآخر')) + '"><div class="dm-bubble">' + (deleted ? '' : quote(ctx,m)) + content + reaction + '<div class="dm-meta"><time datetime="' + esc(m.created_at) + '">' + esc(time(m.created_at)) + '</time>' + (m.edited_at && !deleted ? '<span>عُدّلت</span>' : '') + (own && !deleted ? '<span class="' + (read ? 'is-read' : '') + '" title="' + (read ? 'قُرئت' : 'حُفظت على الخادم') + '">' + icon(read ? 'doubleCheck' : 'check',13) + '</span>' : '') + '</div></div>' + (actions ? '<div class="dm-actions">' + actions + '</div>' : '') + '</article>';
  }
  function startReply(ctx,m) {
    if (!ctx || !ctx.canSend || !m || m.deleted_at) return;
    if (ctx.draft.editId) cancelReply(ctx);
    ctx.draft.replyId = m.id; persistDraft(ctx); composer(ctx,true); $('chatInput').focus();
  }
  async function reactTo(ctx,m) {
    if (!ctx || !ctx.canSend || !m || m.deleted_at || ctx.reactBusy) return;
    const next = G ? G.toggleReaction(m.reaction, G.QUICK) : null;
    ctx.reactBusy = true;
    try {
      const updated = await S.call('react',{p_message:m.id,p_reaction:next});
      merge(ctx,[updated],false); render(ctx,'',false);
    } catch (err) {
      const missing = err && (err.setup || err.status === 404 || err.code === 'PGRST202' || err.code === '42883');
      C.error('chatError', missing ? new Error('التفاعلات تحتاج تنفيذ docs/sql/11-dm-reactions.sql أولاً.') : err);
    } finally { ctx.reactBusy = false; }
  }
  function pendingHTML(ctx,item) {
    return '<article class="dm-row" role="listitem" data-pending="' + esc(item.nonce) + '"><div class="dm-bubble"><p class="dm-text" dir="auto">' + esc(item.roomId ? 'دعوة: ' + item.roomTitle : item.body) + '</p><div class="dm-meta">' + (item.status === 'sending' ? '<span class="s-loader s-loader--sm"></span> جارٍ الإرسال' : 'لم يُؤكَّد الإرسال') + '</div></div>' + (item.status === 'failed' ? '<div class="dm-failed"><span>' + esc(item.error || 'تعذّر الإرسال') + '</span><button class="s-text-link" type="button" data-pending-action="retry"' + (!ctx.canSend || ctx.sendBusy ? ' disabled' : '') + '>إعادة المحاولة</button><button class="s-text-link" type="button" data-pending-action="discard">إزالة المسودة</button></div>' : '') + '</article>';
  }
  function composer(ctx,restore) {
    if (ctx !== state.active) return;
    if (restore) $('chatInput').value = ctx.draft.text;
    $('chatRestriction').hidden = ctx.canSend; $('chatComposeArea').hidden = !ctx.canSend;
    $('chatInput').disabled = !ctx.canSend || ctx.editBusy; $('chatSend').disabled = !ctx.canSend || ctx.sendBusy;
    $('chatInvite').disabled = !ctx.canSend || ctx.sendBusy || !!ctx.draft.editId;
    $('cancelReply').disabled = ctx.editBusy;
    $('chatReplyBar').hidden = !ctx.draft.replyId && !ctx.draft.editId;
    $('chatReplyTitle').textContent = ctx.draft.editId ? 'تعديل رسالتك' : 'رد على رسالة';
    const r = ctx.messages.get(ctx.draft.replyId);
    $('chatReplyText').textContent = ctx.draft.editId ? 'تعدّل رسالة محفوظة، ولن تُرسل نسخة جديدة.' : r ? (r.deleted_at ? 'رسالة محذوفة' : r.body) : 'رسالة سابقة';
    $('chatCounter').textContent = $('chatInput').value.length + ' / 2000';
    $('chatInput').style.height = 'auto'; $('chatInput').style.height = Math.min(130,$('chatInput').scrollHeight || 44) + 'px';
  }
  function header(ctx) {
    const p = ctx.peer;
    $('chatPeer').innerHTML = p ? C.avatar(p,'sm') + '<span class="chat-peer-info"><strong>' + esc(p.display_name) + '</strong><small>' + (p.unavailable ? 'المحادثة السابقة متاحة للقراءة' : 'محادثة خاصة · ' + esc(S.MOODS[p.mood] || 'على مهل')) + '</small></span>' : '<span class="s-muted">جارٍ فتح المحادثة…</span>';
    $('chatProfile').hidden = !p || !!p.unavailable; $('chatBlock').hidden = !p || !!p.unavailable;
    $('chatTyping').hidden = !ctx.typing || !ctx.canSend;
    /* المكالمات: الحالة تُشتق من الخادم؛ الزر يظهر للأصدقاء المقبولين فقط */
    if (window.WTCalls) { window.WTCalls.attach({id:ctx.id,peer:p,canSend:ctx.canSend}); window.WTCalls.syncButton(); }
  }
  function render(ctx,mode,incoming) {
    if (ctx !== state.active) return;
    const el = $('chatScroll'), bottom = atBottom(), oldTop = el.scrollTop, oldHeight = el.scrollHeight;
    const firstVisible = [...$('chatMessages').querySelectorAll('[data-message]')].find(n => n.getBoundingClientRect().bottom >= el.getBoundingClientRect().top);
    const anchor = firstVisible && {id:firstVisible.dataset.message,top:firstVisible.getBoundingClientRect().top};
    const focused = document.activeElement && document.activeElement.closest('[data-msg-action]');
    const focusInfo = focused && {id:focused.closest('[data-message]').dataset.message,action:focused.dataset.msgAction};
    const rows = [...ctx.ids].sort((a,b) => newer(a,b) ? 1 : a === b ? 0 : -1).map(id => ctx.messages.get(id));
    const key = JSON.stringify([rows,[...ctx.messages.values()].filter(m => !ctx.ids.has(m.id)),[...ctx.outbox.values()],ctx.peerRead,ctx.canSend,ctx.sendBusy,ctx.editBusy]);
    if (key !== ctx.renderKey) {
      ctx.renderKey = key; let lastDay = '';
      $('chatMessages').innerHTML = rows.map(m => { const day = C.date(m.created_at), divider = day !== lastDay ? '<div class="chat-day" role="presentation">' + esc(day) + '</div>' : ''; lastDay = day; return divider + messageHTML(ctx,m); }).join('') + [...ctx.outbox.values()].map(item => pendingHTML(ctx,item)).join('');
      if (!rows.length && !ctx.outbox.size) $('chatMessages').innerHTML = '<p class="chat-history-note">أول رسالة لم تُكتب بعد. ابدأ بتحية أو دعوة إلى غرفة.</p>';
      if (mode === 'bottom' || (bottom && mode !== 'prepend')) scrollBottom();
      else if (mode === 'prepend') el.scrollTop = oldTop + (el.scrollHeight - oldHeight);
      else if (anchor) { const node = $('chatMessages').querySelector('[data-message="' + anchor.id + '"]'); if (node) el.scrollTop += node.getBoundingClientRect().top - anchor.top; }
      if (incoming && !bottom && mode !== 'bottom') $('chatNewMessages').hidden = false;
      if (incoming && visibleChat(ctx)) $('chatAnnouncement').textContent = 'رسالة جديدة من ' + ((ctx.peer && ctx.peer.display_name) || 'رفيقك');
      if (focusInfo) { const button = $('chatMessages').querySelector('[data-message="' + focusInfo.id + '"] [data-msg-action="' + focusInfo.action + '"]'); if (button) button.focus({preventScroll:true}); }
    } else if (mode === 'bottom') scrollBottom();
    $('messagesMore').hidden = !ctx.more; header(ctx); composer(ctx,false);
    maybeRead(ctx);
  }
  async function maybeRead(ctx) {
    if (!visibleChat(ctx) || !ctx.initialized || !atBottom() || ctx.readBusy) return;
    const ids = [...ctx.ids].sort((a,b) => newer(a,b) ? -1 : 1), latest = ids[0];
    if (!latest || !newer(latest,ctx.lastRead)) return;
    ctx.readBusy = true; const controller = ctx.controller;
    try {
      const data = await S.call('mark_read',{p_thread:ctx.id,p_message:latest},controller.signal);
      if (controller !== ctx.controller || controller.signal.aborted) return;
      ctx.lastRead = latest;
      const thread = state.threads.find(t => t.id === ctx.id); if (thread && data.unread != null) thread.unread = data.unread;
      if (data.counts) C.setCounts(data.counts); listRender();
    } catch (_) { /* no fake read receipt; retry on the next visible poll/scroll */ }
    finally { if (controller === ctx.controller) ctx.readBusy = false; }
  }
  async function loadMessages(ctx,older) {
    if (ctx.loading) return;
    ctx.loading = true; const loadToken = ++ctx.loadToken, controller = ctx.controller; if (older) $('messagesMore').disabled = true;
    try {
      let rounds = 0, data;
      do {
        const initial = !ctx.initialized;
        const args = {p_thread:ctx.id};
        if (older) args.p_before = ctx.oldest; else if (!initial) args.p_cursor = ctx.cursor;
        data = await S.call('messages',args,controller.signal);
        if (loadToken !== ctx.loadToken || controller.signal.aborted) return;
        if (!data || !Array.isArray(data.messages) || !numeric(data.cursor)) throw new Error('تعذّر قراءة رسائل المحادثة.');
        const incoming = merge(ctx,data.messages,initial || older);
        ctx.peer = data.peer; ctx.canSend = !!data.can_send; ctx.peerRead = numeric(data.peer_read_id) ? String(data.peer_read_id) : null; ctx.typing = !!data.typing;
        if (initial || older) ctx.more = !!data.has_more;
        if (!older) ctx.cursor = String(data.cursor);
        ctx.initialized = true;
        render(ctx,older ? 'prepend' : initial ? 'bottom' : '',!older && !initial && incoming);
      } while (!older && data.has_more_changes && ++rounds < 3 && ctx === state.active);
      if (ctx === state.active) { $('chatConnection').hidden = true; if (ctx.loadError) { ctx.loadError = false; C.error('chatError',null); } }
    } catch (err) {
      if (ctx === state.active && loadToken === ctx.loadToken && err.name !== 'AbortError') {
        $('chatConnection').textContent = navigator.onLine === false ? 'أنت دون اتصال. الرسائل المحمّلة ومسودتك باقية على هذا الجهاز.' : 'تعذّرت المزامنة الآن؛ سنعيد المحاولة تلقائيًا.'; $('chatConnection').hidden = false;
        if (!ctx.initialized || err.signIn || err.setup) { ctx.loadError = true; if (!ctx.initialized) $('chatMessages').innerHTML = ''; C.error('chatError',err,() => loadMessages(ctx,false)); }
      }
    } finally { if (loadToken === ctx.loadToken) { ctx.loading = false; if (ctx === state.active) $('messagesMore').disabled = false; } }
  }
  async function selectThread(id,seed) {
    if (!S.UUID.test(id || '')) return; id = id.toLowerCase();
    const ticket = ++state.selection;
    if (state.active) { state.active.scrollTop = $('chatScroll').scrollTop; persistDraft(state.active); stopTyping(state.active); state.active.loadToken++; state.active.controller.abort(); }
    const ctx = context(id,seed || state.threads.find(t => t.id === id));
    ctx.controller = new AbortController(); ctx.loading = false; ctx.readBusy = false; ctx.renderKey = '';
    state.active = ctx;
    $('chatIdle').hidden = true; $('chatActive').hidden = false; document.body.classList.add('chat-open');
    history.replaceState(null,'','messages.html?thread=' + encodeURIComponent(id));
    C.error('chatError',null); $('chatNewMessages').hidden = true; $('chatConnection').hidden = true;
    $('chatEmojis').hidden = true; $('chatEmojiToggle').setAttribute('aria-expanded','false');
    header(ctx); composer(ctx,true); listRender();
    if (ctx.initialized) { render(ctx,'',false); if (ctx.scrollTop != null) $('chatScroll').scrollTop = ctx.scrollTop; }
    else $('chatMessages').innerHTML = C.loading('نفتح الحديث…');
    await loadMessages(ctx,false);
    if (ticket === state.selection && ctx === state.active) { if (ctx.scrollTop == null) scrollBottom(); maybeRead(ctx); }
  }
  function stopTyping(ctx) {
    if (!ctx || !ctx.lastTyping) return; ctx.lastTyping = 0;
    S.call('typing',{p_thread:ctx.id,p_active:false}).catch(() => {});
  }
  function typing(ctx) {
    if (!ctx.canSend || !ctx.draft.text.trim() || ctx.draft.editId || Date.now() - ctx.lastTyping < 3200 || !visibleChat(ctx)) return;
    ctx.lastTyping = Date.now(); S.call('typing',{p_thread:ctx.id,p_active:true}).catch(() => {});
  }
  function cancelReply(ctx) {
    if (ctx.draft.editId) {
      const original = ctx.draft.beforeEdit || {text:'',replyId:null}; ctx.draft.text = original.text; ctx.draft.replyId = original.replyId;
    } else ctx.draft.replyId = null;
    ctx.draft.editId = null; ctx.draft.beforeEdit = null; persistDraft(ctx); composer(ctx,true);
  }
  async function pendingSend(ctx,item) {
    if (ctx.sendBusy || !ctx.canSend) return;
    ctx.sendBusy = true; item.status = 'sending'; item.error = ''; persistPending(ctx,item); render(ctx,'',false);
    try {
      const message = await S.call('send',{p_thread:ctx.id,p_body:item.body,p_nonce:item.nonce,p_reply:item.replyId,p_room:item.roomId});
      merge(ctx,[message],false); forgetPending(ctx,item.nonce);
      const thread = state.threads.find(t => t.id === ctx.id); if (thread) { thread.preview = message; thread.updated_at = message.created_at; state.threads.sort((a,b) => Date.parse(b.updated_at)-Date.parse(a.updated_at)); }
      listRender();
    } catch (err) {
      const confirmed = [...ctx.messages.values()].some(m => m.sender_id === state.uid && m.nonce === item.nonce);
      if (confirmed) forgetPending(ctx,item.nonce);
      else { item.status = 'failed'; item.error = err.message || 'تعذّر الإرسال'; persistPending(ctx,item); }
    }
    finally { ctx.sendBusy = false; render(ctx,'',false); }
  }
  function queueSend(ctx,room) {
    if (!ctx || !ctx.canSend || ctx.sendBusy || ctx.outbox.size >= 10) { if (ctx && ctx.outbox.size >= 10) C.error('chatError',new Error('أعد إرسال المسودات المعلّقة أو احذف بعضها أولاً.')); return; }
    const body = room ? room.title : ctx.draft.text.trim(); if (!body || body.length > 2000) return;
    const item = {nonce:U.randomToken(24),body,replyId:room ? null : ctx.draft.replyId,roomId:room ? room.id : null,roomTitle:room ? room.title : '',createdAt:new Date().toISOString(),status:'sending',error:''};
    ctx.outbox.set(item.nonce,item); persistPending(ctx,item);
    if (!room) { ctx.draft.text = ''; ctx.draft.replyId = null; persistDraft(ctx); composer(ctx,true); }
    stopTyping(ctx); render(ctx,'bottom',false); pendingSend(ctx,item);
  }
  async function submitEdit(ctx) {
    if (ctx.sendBusy) return;
    const body = ctx.draft.text.trim(); if (!body || body.length > 2000) return;
    ctx.sendBusy = true; ctx.editBusy = true; render(ctx,'',false); C.error('chatError',null);
    try { const message = await S.call('edit_message',{p_message:ctx.draft.editId,p_body:body}); merge(ctx,[message],false); cancelReply(ctx); }
    catch (err) { if (ctx === state.active) C.error('chatError',err); }
    finally { ctx.sendBusy = false; ctx.editBusy = false; render(ctx,'',false); }
  }
  async function tick() {
    clearTimeout(state.timer); if (state.stopped || state.ticking) return;
    state.ticking = true;
    try {
      if (document.visibilityState !== 'hidden' && navigator.onLine !== false) {
        const tasks = [];
        if (Date.now()-state.lastList > 12000) tasks.push(loadThreads(false,true));
        if (state.active && visibleChat(state.active)) tasks.push(loadMessages(state.active,false));
        /* فحص المكالمات الواردة دائماً — لا فقط عند فتح محادثة */
        if (window.WTCalls) window.WTCalls.pollIncoming();
        await Promise.all(tasks);
      }
    } finally { state.ticking = false; if (!state.stopped) state.timer = setTimeout(tick,4000); }
  }
  /* ============================== البثّ الحيّ (Realtime) ==============================
     شبكة أولى للتحديث الفوري، والاستطلاع الدوري (tick) يبقى شبكة أمان.
     نستقبل «إشارة تغيير» فقط ثم نقرأ عبر RPC المحمي — فلا نعتمد على RLS الجداول. */
  let realtime = null, liveChatTimer = null, liveListTimer = null;

  function liveChat(ctx) {
    if (!ctx || !ownsContext(ctx)) return;
    if (liveChatTimer) window.clearTimeout(liveChatTimer);
    liveChatTimer = setTimeout(() => {
      liveChatTimer = null;
      if (state.stopped || !ctx || ctx !== state.active || !ownsContext(ctx)) return;
      loadMessages(ctx, false);
    }, 220);
  }
  function liveList() {
    if (liveListTimer || state.stopped) return;
    liveListTimer = setTimeout(() => {
      liveListTimer = null;
      if (!state.stopped) loadThreads(false, true);
    }, 400);
  }
  function liveTyping(ctx, payload) {
    if (!ctx || String(payload.user) === state.uid) return;
    const active = payload.active !== false;
    ctx.typing = active;
    if (ctx.typingTimer) { window.clearTimeout(ctx.typingTimer); ctx.typingTimer = null; }
    if (active) {
      const until = Date.parse(payload.until);
      const wait = Number.isFinite(until) ? Math.max(1200, Math.min(8000, until - Date.now())) : 5000;
      /* المؤشّر ينتهي وحده كما ينتهي سجلّ wt_dm_typing — لا «يكتب الآن» أبدية */
      ctx.typingTimer = window.setTimeout(() => {
        ctx.typingTimer = null;
        if (!ctx.typing) return;
        ctx.typing = false;
        if (ctx === state.active) header(ctx);
      }, wait);
    }
    if (ctx === state.active) header(ctx);
  }
  function startRealtime() {
    if (realtime || state.stopped || !window.WTDMRealtime || !state.uid) return;
    realtime = window.WTDMRealtime.create({
      uid: state.uid,
      getToken: async () => {
        try { const session = await A.validSession(); return (session && session.access_token) || ''; }
        catch (_) { return ''; }
      }
    });
    realtime.on('message', (payload) => {
      const thread = String((payload && payload.thread) || '').toLowerCase();
      if (!S.UUID.test(thread)) return;
      const ctx = state.contexts.get(thread);
      if (ctx && ctx === state.active) liveChat(ctx);
      liveList();
    });
    realtime.on('read', (payload) => {
      const thread = String((payload && payload.thread) || '').toLowerCase();
      if (!S.UUID.test(thread) || String(payload.user) === state.uid) return;
      const ctx = state.contexts.get(thread);
      if (!ctx || !numeric(payload.last_read)) return;
      if (newer(payload.last_read, ctx.peerRead || '0')) {
        ctx.peerRead = String(payload.last_read);
        if (ctx === state.active) render(ctx, '', false);
      }
    });
    realtime.on('typing', (payload) => {
      const thread = String((payload && payload.thread) || '').toLowerCase();
      if (!S.UUID.test(thread)) return;
      const ctx = state.contexts.get(thread);
      if (ctx) liveTyping(ctx, payload);
    });
  }
  function stopRealtime() {
    if (liveChatTimer) { window.clearTimeout(liveChatTimer); liveChatTimer = null; }
    if (liveListTimer) { window.clearTimeout(liveListTimer); liveListTimer = null; }
    if (realtime) { try { realtime.close(); } catch (_) { /* تجاهل */ } realtime = null; }
  }

  async function newFriends(append) {
    if (state.friendBusy) return; state.friendBusy = true; $('newChatMore').disabled = true;
    C.error('newChatError',null);
    if (!append) { state.newFriends = []; state.friendOffset = 0; $('newChatFriends').innerHTML = C.loading('نحمّل أصدقاءك…'); }
    try {
      const data = await S.call('friends',{p_tab:'friends',p_offset:state.friendOffset});
      state.newFriends = append ? [...state.newFriends,...data.people] : data.people; state.friendOffset += data.people.length;
      $('newChatFriends').innerHTML = state.newFriends.length ? state.newFriends.filter(p => S.UUID.test(p.user_id || '')).map(p => '<button type="button" class="s-newchat-person" data-new-peer="' + esc(p.user_id) + '">' + C.avatar(p,'sm') + '<span>' + esc(p.display_name) + '</span></button>').join('') : C.empty('users','رفيقك الأول ينتظرك','أضف صديقًا من صفحة البحث، ثم ابدأ محادثتك بعد قبول الصداقة.');
      $('newChatMore').hidden = !data.has_more;
    } catch (err) { C.error('newChatError',err,() => newFriends(append)); if (!append) $('newChatFriends').innerHTML = ''; }
    finally { state.friendBusy = false; $('newChatMore').disabled = false; }
  }
  function newChat() { C.error('newChatError',null); $('newChatDialog').showModal(); newFriends(false); }
  $('newChat').onclick = newChat; $('idleNewChat').onclick = newChat; $('closeNewChat').onclick = () => $('newChatDialog').close(); $('newChatMore').onclick = () => newFriends(true);
  $('newChatFriends').onclick = async event => {
    const button = event.target.closest('[data-new-peer]'); if (!button || state.friendBusy) return;
    state.friendBusy = true; const buttons = [...$('newChatFriends').querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
    try { const thread = await S.call('open_thread',{p_user:button.dataset.newPeer}); if (!$('newChatDialog').open) return; $('newChatDialog').close(); await selectThread(thread.id,thread); loadThreads(false,true); }
    catch (err) { C.error('newChatError',err); }
    finally { state.friendBusy = false; buttons.forEach(b => { b.disabled = false; }); }
  };
  /* ---------------- قائمة خيارات المحادثة: تثبيت · كتم · أرشفة ---------------- */
  function closeThreadMenu() {
    if (state.threadMenu) { state.threadMenu.remove(); state.threadMenu = null; }
  }
  function threadMenuItem(key,on,label) {
    return '<button type="button" role="menuitemcheckbox" aria-checked="' + String(!!on) + '" data-pref="' + key + '">' +
      '<span class="dm-menu-check">' + (on ? icon('check',14) : '') + '</span>' + esc(label) + '</button>';
  }
  function openThreadMenu(id,anchor) {
    closeThreadMenu();
    const thread = state.threads.find(t => t.id === id); if (!thread || !anchor) return;
    const prefs = Object.assign({pinned:false,muted:false,archived:false}, thread.prefs || {});
    const menu = document.createElement('div');
    menu.className = 'dm-thread-menu';
    menu.setAttribute('role','menu');
    menu.setAttribute('aria-label','خيارات المحادثة');
    menu.innerHTML = threadMenuItem('pinned',prefs.pinned,'تثبيت في الأعلى') +
      threadMenuItem('muted',prefs.muted,'كتم إشعارات العدّاد') +
      threadMenuItem('archived',prefs.archived,state.showArchived ? 'إخراج من الأرشيف' : 'أرشفة (إخفاء من القائمة)') +
      '<p class="dm-menu-note">' + (state.showArchived ? 'الأرشفة تُخفي المحادثة فقط؛ لا تحذف أي رسالة.' : 'لا حذف ولا إخفاء دائم — كل شيء قابل للتراجع.') + '</p>';
    document.body.appendChild(menu);
    const box = anchor.getBoundingClientRect();
    menu.style.top = Math.min(window.innerHeight - 40, box.bottom + 6) + 'px';
    menu.style.insetInlineStart = Math.max(8, Math.min(box.left, window.innerWidth - 240)) + 'px';
    state.threadMenu = menu;
    menu.onclick = async event => {
      const item = event.target.closest('[data-pref]'); if (!item) return;
      const key = item.dataset.pref;
      await setThreadPref(thread, key, !prefs[key]);
      closeThreadMenu();
    };
    const first = menu.querySelector('[data-pref]'); if (first) first.focus({preventScroll:true});
  }
  async function setThreadPref(thread,key,value) {
    const args = { p_thread: thread.id };
    args['p_' + key] = !!value;
    try {
      const data = await S.call('thread_pref',args);
      thread.prefs = Object.assign({pinned:false,muted:false,archived:false},thread.prefs||{},(data && data.prefs) || args);
      state.threadKey = '';
      if (key === 'archived') {
        /* أرشفة/فكّ أرشفة تُغيّر أي قائمة نعرضها — نعيد التحميل لا نخمّن */
        await loadThreads(false,true);
        U.toast(value ? 'أُضيفت إلى الأرشيف' : 'أُعيدت إلى المحادثات','success');
      } else {
        listRender();
        U.toast(key === 'pinned' ? (value ? 'ثُبّتت المحادثة' : 'أُلغي التثبيت')
          : (value ? 'كُتم عدّاد المحادثة' : 'أُلغي الكتم'),'success');
        if (key === 'pinned') loadThreads(false,true);
      }
    } catch (err) {
      const missing = err && (err.setup || err.status === 404 || err.code === 'PGRST202' || err.code === '42883');
      C.error('messagesError', missing ? new Error('خيارات المحادثة تحتاج تنفيذ docs/sql/12-dm-thread-prefs.sql أولاً.') : err);
    }
  }
  document.addEventListener('click', event => { if (state.threadMenu && !event.target.closest('.dm-thread-menu') && !event.target.closest('[data-thread-menu]')) closeThreadMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.threadMenu) { closeThreadMenu(); } });
  $('threadArchived').onclick = () => {
    closeThreadMenu();
    state.showArchived = !state.showArchived;
    state.threads = []; state.threadOffset = 0; state.threadMore = false; state.threadKey = '';
    loadThreads(false,false);
  };
  $('threadList').onclick = event => {
    const menuBtn = event.target.closest('[data-thread-menu]');
    if (menuBtn) { event.stopPropagation(); openThreadMenu(menuBtn.dataset.threadMenu,menuBtn); return; }
    const b = event.target.closest('[data-thread]'); if (b) selectThread(b.dataset.thread);
  };
  $('threadQuery').oninput = listRender; $('threadsMore').onclick = () => loadThreads(true,false);
  $('chatBack').onclick = () => { if (state.active) stopTyping(state.active); document.body.classList.remove('chat-open'); history.replaceState(null,'','messages.html'); $('threadQuery').focus({preventScroll:true}); };
  $('chatCall').onclick = () => { if (window.WTCalls) window.WTCalls.start(); };
  document.addEventListener('wt:call-logged', () => { setTimeout(() => { if (state.active) loadMessages(state.active,false); loadThreads(false,true); }, 700); });
  $('chatProfile').onclick = () => { if (state.active && state.active.peer && !state.active.peer.unavailable) location.href = 'profile.html?u=' + encodeURIComponent(state.active.peer.user_id); };
  $('chatBlock').onclick = async () => {
    const ctx = state.active; if (!ctx || !ctx.peer) return;
    try { const result = await C.friendAction(ctx.peer.user_id,'block',$('chatBlock')); if (result) { await loadMessages(ctx,false); loadThreads(false,true); } }
    catch (err) { C.error('chatError',err); }
  };
  /* نقر مزدوج = ❤️ مباشرة، والنقر على أزرار الإجراءات لا يُحسب */
  $('chatMessages').addEventListener('dblclick', event => {
    const ctx = state.active; if (!ctx || !ctx.canSend) return;
    if (event.target.closest('[data-msg-action]') || event.target.closest('[data-msg-jump]')) return;
    const row = event.target.closest('[data-message]'); if (!row) return;
    const m = ctx.messages.get(row.dataset.message); if (!m) return;
    reactTo(ctx,m);
  });
  let swipe = null;
  $('chatMessages').addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { swipe = null; return; }
    const row = event.target.closest('[data-message]');
    if (!row || !G) { swipe = null; return; }
    swipe = { row, x:event.touches[0].clientX, y:event.touches[0].clientY, dx:0, ready:false };
  },{passive:true});
  $('chatMessages').addEventListener('touchmove', event => {
    if (!swipe || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - swipe.x, dy = event.touches[0].clientY - swipe.y;
    const intent = G.swipeIntent(dx,dy);
    if (intent.vertical) { swipe = null; return; }
    if (!intent.active) return;
    swipe.dx = dx; swipe.ready = intent.trigger;
    swipe.row.classList.add('is-swiping');
    swipe.row.classList.toggle('is-ready', intent.trigger);
    swipe.row.style.transform = 'translateX(' + intent.offset + 'px)';
  },{passive:true});
  const endSwipe = () => {
    if (!swipe) return;
    const row = swipe.row, ready = swipe.ready;
    swipe = null;
    row.classList.remove('is-swiping','is-ready'); row.style.transform = '';
    if (!ready) return;
    const ctx = state.active; if (!ctx) return;
    const m = ctx.messages.get(row.dataset.message);
    if (m) startReply(ctx,m);
  };
  $('chatMessages').addEventListener('touchend', endSwipe);
  $('chatMessages').addEventListener('touchcancel', endSwipe);
  $('chatInput').oninput = () => { const ctx = state.active; if (!ctx) return; ctx.draft.text = $('chatInput').value; persistDraft(ctx); composer(ctx,false); typing(ctx); if (!ctx.draft.text.trim()) stopTyping(ctx); };
  $('chatInput').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer:coarse)').matches) { event.preventDefault(); $('chatForm').requestSubmit(); } };
  $('chatInput').onblur = () => { if (state.active) stopTyping(state.active); };
  $('chatForm').onsubmit = event => { event.preventDefault(); const ctx = state.active; if (!ctx || !ctx.canSend) return; C.error('chatError',null); if (ctx.draft.editId) submitEdit(ctx); else queueSend(ctx,null); };
  $('cancelReply').onclick = () => { if (state.active) { cancelReply(state.active); $('chatInput').focus(); } };
  $('chatScroll').addEventListener('scroll', () => { if (atBottom()) { $('chatNewMessages').hidden = true; if (state.active) maybeRead(state.active); } },{passive:true});
  $('chatNewMessages').onclick = () => { scrollBottom(); if (state.active) maybeRead(state.active); };
  $('messagesMore').onclick = () => { if (state.active) loadMessages(state.active,true); };
  $('chatMessages').onclick = async event => {
    const ctx = state.active; if (!ctx) return;
    const pending = event.target.closest('[data-pending-action]');
    if (pending) {
      const item = ctx.outbox.get(pending.closest('[data-pending]').dataset.pending); if (!item) return;
      if (pending.dataset.pendingAction === 'retry') pendingSend(ctx,item);
      else if (await C.confirm({title:'إزالة هذه المسودة؟',body:'إن وصل الإرسال إلى الخادم قبل انقطاع الاتصال، لن يحذف هذا الإجراء الرسالة المحفوظة هناك.',label:'إزالة المسودة'})) { forgetPending(ctx,item.nonce); render(ctx,'',false); }
      return;
    }
    const jump = event.target.closest('[data-msg-jump]');
    if (jump) {
      const id = jump.dataset.msgJump;
      for (let i=0;i<5 && !ctx.ids.has(id) && ctx.more;i++) await loadMessages(ctx,true);
      const node = $('chatMessages').querySelector('[data-message="' + id + '"]');
      if (node) { node.scrollIntoView({block:'center'}); node.style.outline = '1px solid var(--s-accent)'; setTimeout(() => { node.style.outline = ''; },1800); }
      else C.error('chatError',new Error('الرسالة أقدم من الجزء المحمّل. اضغط «رسائل أقدم» للوصول إليها.'));
      return;
    }
    const b = event.target.closest('[data-msg-action]'); if (!b) return;
    const m = ctx.messages.get(b.closest('[data-message]').dataset.message); if (!m || m.deleted_at) return;
    const action = b.dataset.msgAction; if (ctx.editBusy) return;
    if (action === 'react') { reactTo(ctx,m); }
    if (action === 'reply') { startReply(ctx,m); }
    if (action === 'edit') { if (!ctx.draft.editId) ctx.draft.beforeEdit = {text:ctx.draft.text,replyId:ctx.draft.replyId}; ctx.draft.editId = m.id; ctx.draft.replyId = null; ctx.draft.text = m.body; persistDraft(ctx); composer(ctx,true); $('chatInput').focus(); }
    if (action === 'copy') { try { const copied = await U.copyText(m.kind === 'room' ? new URL('room.html?id=' + encodeURIComponent(m.room_id),location.href).href : m.body); if (copied === false) throw new Error('copy'); U.toast('نُسخت الرسالة','success'); } catch (_) { C.error('chatError',new Error('تعذّر النسخ في هذا المتصفح.')); } }
    if (action === 'delete' && await C.confirm({title:'حذف رسالتك للجميع؟',body:'سيُزال نص الرسالة ودعوة الغرفة إن وجدت. يبقى مكانها تنبيه بالحذف.',label:'حذف الرسالة',danger:true})) {
      b.disabled = true;
      try { const deleted = await S.call('edit_message',{p_message:m.id,p_delete:true}); merge(ctx,[deleted],false); render(ctx,'',false); }
      catch (err) { C.error('chatError',err); if (b.isConnected) b.disabled = false; }
    }
  };
  $('chatEmojis').innerHTML = ['🍿','🎬','✨','❤️','😂','🙌','👀','🔥','👍','🤍','🌙','🎧'].map(e => '<button type="button" aria-label="إضافة ' + e + '">' + e + '</button>').join('');
  $('chatEmojiToggle').onclick = () => { $('chatEmojis').hidden = !$('chatEmojis').hidden; $('chatEmojiToggle').setAttribute('aria-expanded',String(!$('chatEmojis').hidden)); };
  $('chatEmojis').onclick = event => { const b = event.target.closest('button'), ctx = state.active; if (!b || !ctx) return; const input = $('chatInput'), emoji = b.textContent; if (input.value.length + emoji.length > 2000) return; input.setRangeText(emoji,input.selectionStart,input.selectionEnd,'end'); ctx.draft.text = input.value; persistDraft(ctx); composer(ctx,false); input.focus(); typing(ctx); };
  $('closeInvite').onclick = () => $('inviteDialog').close();
  $('chatInvite').onclick = async () => {
    const ctx = state.active; if (!ctx || !ctx.canSend || ctx.sendBusy) return;
    $('inviteDialog').showModal(); C.error('inviteError',null); $('inviteRooms').innerHTML = C.loading('نحمّل الغرف المتاحة…');
    try { const rooms = await S.rooms(); $('inviteRooms').innerHTML = rooms.length ? rooms.map(r => '<button class="s-room-option" type="button" data-invite-room="' + esc(r.id) + '">' + icon('film',24) + '<span>' + esc(r.title) + '<small dir="ltr">' + esc(r.id) + '</small></span>' + icon('send',17) + '</button>').join('') : C.empty('film','لا غرف على Supabase الآن','أضف غرفة أولاً. غرف التخزين المحلي أو خادم Java لا يمكن التحقق منها هنا.'); }
    catch (err) { $('inviteRooms').innerHTML = ''; C.error('inviteError',err); }
  };
  $('inviteRooms').onclick = event => { const b = event.target.closest('[data-invite-room]'), ctx = state.active; if (!b || !ctx || !ctx.canSend) return; const title = b.querySelector('span').childNodes[0].textContent; $('inviteDialog').close(); queueSend(ctx,{id:b.dataset.inviteRoom,title}); };
  $('chatKeyboardHint').textContent = !storageAvailable ? 'التخزين المحلي غير متاح؛ لا تغلق الصفحة قبل الحفظ.' : matchMedia('(pointer:coarse)').matches ? 'مسودة محلية لحسابك على هذا الجهاز' : 'Enter للإرسال · Shift + Enter لسطر جديد';
  function viewportSize() {
    const viewport = window.visualViewport;
    const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
    const wasBottom = state.active && atBottom();
    document.body.style.setProperty('--s-mobile-vh',Math.round(height) + 'px');
    document.body.classList.toggle('s-keyboard-open',document.body.classList.contains('chat-open') && window.innerHeight-height>140);
    if (wasBottom) requestAnimationFrame(() => { if (state.active) scrollBottom(); });
  }
  window.addEventListener('resize',viewportSize,{passive:true});
  if (window.visualViewport) window.visualViewport.addEventListener('resize',viewportSize,{passive:true});
  viewportSize();
  window.addEventListener('online',tick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { if (state.active) stopTyping(state.active); } else { tick(); if (state.active) maybeRead(state.active); } });
  window.addEventListener('pagehide', () => { state.stopped = true; clearTimeout(state.timer); if (state.active) { persistDraft(state.active); state.active.controller.abort(); } if (state.listController) state.listController.abort(); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    state.stopped = false;
    if (state.active) state.active.controller = new AbortController();
    if (realtime) realtime.retryNow(); else startRealtime();
    tick();
  });
  window.addEventListener('beforeunload', event => { if (!storageAvailable && [...state.contexts.values()].some(ctx => ctx.draft.text || ctx.outbox.size)) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', event => { if (!event.persisted) stopRealtime(); });
  C.boot(async data => {
    if (state.uid && state.uid !== data.profile.user_id) { state.stopped=true; clearTimeout(state.timer); state.contexts.forEach(ctx=>ctx.controller.abort()); if(state.listController) state.listController.abort(); location.reload(); throw new Error('تغيّر الحساب؛ نعيد فتح مساحته الخاصة.'); }
    state.uid = data.profile.user_id; state.stopped = false; C.setCounts(data.counts);
    /* استعادة مكالمة قائمة (رنين/جارية) بعد تحديث الصفحة — كي لا تبقى بلا زرّ إنهاء */
    if (window.WTCalls && window.WTCalls.reconcile) window.WTCalls.reconcile();
    await loadThreads(false,false);
    startRealtime();
    const params = new URLSearchParams(location.search), peer = params.get('with'), id = params.get('thread');
    try {
      if (peer) { if (!S.UUID.test(peer)) throw new Error('رابط الصديق غير صالح.'); const thread = await S.call('open_thread',{p_user:peer}); await selectThread(thread.id,thread); loadThreads(false,true); }
      else if (id) { if (!S.UUID.test(id)) throw new Error('رابط المحادثة غير صالح.'); await selectThread(id); }
    } catch (err) { C.error('messagesError',err); }
    setTimeout(() => { if (state.active) { scrollBottom(); maybeRead(state.active); } tick(); },0);
  });
})();

/* Shared original RTL community shell, accessible states and friend controls. */
(function (global) {
  'use strict';
  const S = global.WTSocial, U = global.WTUtil, A = global.WTAuth, IC = global.WTIcons;
  const $ = id => document.getElementById(id), esc = U.esc, icon = (name, size) => IC.html(name, size || 20);
  const page = document.body.dataset.page;
  const titles = { profile: 'الملف الشخصي', friends: 'الأصدقاء', messages: 'الرسائل الخاصة' };
  let counts = {}, confirmResolve, starter, navKey = '';
  function avatar(p, size) {
    p = p || {};
    const url = S.avatarURL(p), color = S.ACCENTS[p.accent] || S.ACCENTS.mint;
    return '<span class="s-avatar s-avatar--' + (size || 'md') + '" style="--avatar-color:' + color + '"><span>' + esc(U.initials(p.display_name || p.name || 'عضو')) + '</span>' + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') + '</span>';
  }
  // Broken/deleted images reveal initials, never a broken-image placeholder.
  document.addEventListener('error', event => { if (event.target.matches && event.target.matches('.s-avatar img')) event.target.remove(); }, true);
  function nav() {
    const user = A.accountUser(), saved = S.me();
    const me = user ? (saved && saved.user_id === user.id ? saved : { user_id:user.id,display_name:user.name,avatar_path:user.avatar_path }) : null;
    const key = JSON.stringify([user && user.id,me && me.display_name,me && me.avatar_path,counts.incoming,counts.unread]);
    if (key === navKey) return; navKey = key;
    $('socialNav').innerHTML = '<a class="s-brand" href="index.html" aria-label="WatchTogether — الغرف"><span class="s-brand-mark">' + icon('play', 21) + '</span><span>Watch<span class="s-brand-light">Together</span><small>المساحة المشتركة</small></span></a>' +
      '<div class="s-nav-caption">مساحتك</div><nav class="s-nav-links" aria-label="التنقل الرئيسي">' +
      [['index','home','الغرف','index.html'],['profile','user','ملفي','profile.html'],['friends','users','الأصدقاء','friends.html'],['messages','chat','الرسائل','messages.html']].map(([key, i, label, href]) => '<a href="' + href + '" class="s-nav-link' + (page === key ? ' is-current' : '') + '"' + (page === key ? ' aria-current="page"' : '') + '>' + icon(i, 21) + '<span>' + label + '</span>' + ((key === 'friends' && counts.incoming) || (key === 'messages' && counts.unread) ? '<b class="s-nav-count">' + Math.min(99, Number(key === 'friends' ? counts.incoming : counts.unread)) + '</b>' : '') + '</a>').join('') + '</nav>' +
      '<div class="s-nav-bottom">' + (me ? '<a class="s-mini-profile" href="profile.html">' + avatar(me, 'sm') + '<span><strong>' + esc(me.display_name) + '</strong><small>مساحتك الشخصية</small></span></a><button type="button" class="s-icon-btn" id="socialLogout" title="تسجيل الخروج" aria-label="تسجيل الخروج">' + icon('logout', 18) + '</button>' : '<a class="s-btn s-btn--primary" href="' + authLink() + '">' + icon('login', 18) + ' تسجيل الدخول</a>') + '</div>';
    if ($('socialLogout')) $('socialLogout').onclick = async () => {
      if (!await confirm({ title: 'تسجيل الخروج؟', body: 'ستُحذف مسودات الدردشة المحلية من هذا الجهاز. تبقى الرسائل المحفوظة في حسابك.', label: 'تسجيل الخروج' })) return;
      $('socialLogout').disabled = true; await A.signOut(); location.href = 'index.html';
    };
    const header = $('socialHeader');
    if (header) header.innerHTML = '<a class="s-mobile-brand" href="index.html" aria-label="الغرف">' + icon('play', 20) + '</a><span class="s-breadcrumb">مساحتي <span>/</span> <strong>' + titles[page] + '</strong></span><a class="s-icon-btn s-header-avatar" href="profile.html" aria-label="ملفي">' + avatar(me || {}, 'xs') + '</a>';
  }
  function authLink() {
    return 'auth.html?reauth=1&next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search);
  }
  function error(node, err, retry) {
    if (typeof node === 'string') node = $(node);
    if (!node) return;
    node.hidden = !err;
    node.replaceChildren();
    if (!err) return;
    node.setAttribute('role', 'alert');
    const text = document.createElement('span'); text.textContent = err.message || String(err); node.append(text);
    if (err.signIn) { const link = document.createElement('a'); link.href = authLink(); link.textContent = 'تسجيل الدخول'; link.className = 's-text-link'; node.append(link); }
    if (retry) { const button = document.createElement('button'); button.type = 'button'; button.className = 's-text-link'; button.textContent = 'أعد المحاولة'; button.onclick = retry; node.append(button); }
  }
  function loading(text) { return '<div class="s-state"><span class="s-loader" aria-hidden="true"></span><p role="status">' + esc(text || 'نجهّز مساحتك…') + '</p></div>'; }
  function empty(i, heading, text, action) {
    return '<div class="s-empty"><span class="s-empty-icon">' + icon(i, 31) + '</span><h2>' + esc(heading) + '</h2><p>' + esc(text) + '</p>' + (action || '') + '</div>';
  }
  async function boot(fn) {
    starter = fn;
    $('socialContent').hidden = true; $('socialState').hidden = false; $('socialState').innerHTML = loading(); nav();
    await A.validSession(); nav();
    if (!A.accountUser()) {
      $('socialState').innerHTML = empty('lock', 'لك مساحة هنا أيضًا', 'سجّل الدخول لتخصّص ملفك، وتجد رفاق المشاهدة، وتبدأ محادثاتك الخاصة.', '<a class="s-btn s-btn--primary" href="' + authLink() + '">' + icon('login', 18) + ' تسجيل الدخول</a><a class="s-text-link" href="index.html">متابعة إلى الغرف كضيف</a>');
      return false;
    }
    try {
      const data = await S.bootstrap(true); counts = data.counts; document.body.dataset.accent = data.profile.accent; nav();
      await fn(data);
      $('socialState').hidden = true; $('socialContent').hidden = false;
      return true;
    } catch (err) {
      $('socialContent').hidden = true; $('socialState').hidden = false;
      $('socialState').innerHTML = empty('info', err.setup ? 'خطوة تفعيل واحدة' : 'تعذّر فتح المساحة', err.message || 'تحقّق من الاتصال ثم حاول مجددًا.', '<button class="s-btn s-btn--primary" type="button" id="socialRetry">' + icon('sync', 18) + ' إعادة المحاولة</button>' + (err.signIn ? '<a class="s-text-link" href="' + authLink() + '">تسجيل الدخول</a>' : ''));
      $('socialRetry').onclick = () => boot(starter);
      return false;
    }
  }
  function setCounts(value) { counts = Object.assign({},counts,value || {}); nav(); }
  async function refreshCounts() {
    try { const data = await S.bootstrap(true); counts = data.counts; nav(); return counts; } catch (_) { return counts; }
  }
  function confirm(options) {
    const dialog = $('socialConfirm');
    if (confirmResolve) confirmResolve(false);
    $('confirmTitle').textContent = options.title;
    $('confirmBody').textContent = options.body || '';
    $('confirmYes').textContent = options.label || 'تأكيد';
    $('confirmYes').classList.toggle('s-btn--danger', !!options.danger);
    if (!dialog.open) dialog.showModal();
    $('confirmNo').focus();
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  function closeConfirm(accepted) {
    const resolve = confirmResolve; confirmResolve = null;
    $('socialConfirm').close(); if (resolve) resolve(accepted);
  }
  async function friendAction(user, action, button) {
    const sensitive = { block: ['حظر هذا العضو؟','ستتوقف طلبات الصداقة والرسائل بينكما. إلغاء الحظر لا يعيد الصداقة تلقائيًا.','حظر العضو'], remove: ['إزالة الصداقة؟','ستبقى المحادثة السابقة، ولن تُرسل رسائل جديدة إلا بعد قبول الصداقة مرة أخرى.','إزالة الصداقة'] };
    if (sensitive[action] && !await confirm({ title: sensitive[action][0], body: sensitive[action][1], label: sensitive[action][2], danger: true })) return null;
    if (button) button.disabled = true;
    try { const result = await S.call('friend_action', { p_user: user, p_action: action }); if (result.counts) setCounts(result.counts); else refreshCounts(); return result; }
    finally { if (button && button.isConnected) button.disabled = false; }
  }
  function relationButtons(p, compact) {
    const id = esc(p.user_id);
    if (p.relation === 'blocked') return '<button class="s-btn s-btn--soft" data-friend-action="unblock" data-user="' + id + '">' + icon('shield', 16) + ' إلغاء الحظر</button>';
    if (p.relation === 'friends') return '<a class="s-btn s-btn--primary' + (compact ? ' s-btn--sm' : '') + '" href="messages.html?with=' + id + '">' + icon('chat', 17) + ' رسالة</a><button class="s-icon-btn" data-friend-action="remove" data-user="' + id + '" aria-label="إزالة الصداقة" title="إزالة الصداقة">' + icon('userMinus', 17) + '</button>' + (p.allow_calls === false ? '<span class="s-muted s-small">المكالمات متوقفة</span>' : '');
    if (p.relation === 'outgoing') return '<button class="s-btn s-btn--soft" data-friend-action="cancel" data-user="' + id + '">' + icon('clock', 16) + ' إلغاء الطلب</button>';
    if (p.relation === 'incoming') return '<button class="s-btn s-btn--primary" data-friend-action="accept" data-user="' + id + '">' + icon('check', 17) + ' قبول</button><button class="s-icon-btn" data-friend-action="reject" data-user="' + id + '" aria-label="رفض الطلب" title="رفض الطلب">' + icon('x', 17) + '</button>';
    if (p.relation === 'unavailable') return '';
    return p.allow_requests ? '<button class="s-btn s-btn--soft" data-friend-action="request" data-user="' + id + '">' + icon('userPlus', 17) + ' إضافة صديق</button>' : '<span class="s-muted s-small">طلبات الصداقة متوقفة</span>';
  }
  function mood(p) { return '<span class="s-mood s-mood--' + (S.MOODS[p.mood] ? p.mood : 'none') + '"><i></i>' + esc(S.MOODS[p.mood] || S.MOODS.none) + '</span>'; }
  function genres(list) { return (list || []).filter(k => S.GENRES[k]).map(k => '<span class="s-tag">' + esc(S.GENRES[k]) + '</span>').join(''); }
  function date(value, mode) {
    const d = new Date(value); if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString('ar-DZ', mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short' });
  }
  function busy(button, value, text) {
    if (!button) return;
    if (value) { button.dataset.previous = button.innerHTML; button.disabled = true; button.innerHTML = '<span class="s-loader s-loader--sm"></span>' + esc(text || 'جارٍ الحفظ…'); }
    else { button.disabled = false; if (button.dataset.previous) button.innerHTML = button.dataset.previous; delete button.dataset.previous; }
  }
  $('socialConfirm').addEventListener('cancel', event => { event.preventDefault(); closeConfirm(false); });
  $('confirmNo').onclick = () => closeConfirm(false); $('confirmYes').onclick = () => closeConfirm(true);
  global.addEventListener('wt:profile', () => nav());
  global.addEventListener('storage', event => { if (event.key === 'wt:session' && S.me() && (A.accountUser() || {}).id !== S.me().user_id) location.reload(); });
  nav();
  global.WTSocialUI = { $, esc, icon, avatar, nav, boot, error, loading, empty, confirm, refreshCounts, setCounts, friendAction, relationButtons, mood, genres, date, busy };
})(window);

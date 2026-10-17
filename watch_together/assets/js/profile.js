/* A real account profile: personal details, watch fingerprint, privacy and phone photos. */
(function () {
  'use strict';
  const S = window.WTSocial, C = window.WTSocialUI, A = window.WTAuth, U = window.WTUtil;
  const { $, esc, icon } = C, params = new URLSearchParams(location.search);
  const state = { p: null, me: null, own: false, preview: false, editing: false, dirty: false, saving: false, genres: new Set(), accent: 'mint', cover: 'orbit' };
  const prefs = { discoverable: 'prefDiscoverable', allow_requests: 'prefRequests', read_receipts: 'prefReceipts', show_friend_count: 'prefFriendCount' };
  function dirty(value) { state.dirty = value; $('profileDirty').hidden = !value; if (value) $('profileSaved').textContent = ''; }
  function render() {
    const p = state.p, own = state.own && !state.preview;
    document.body.dataset.accent = S.ACCENTS[p.accent] ? p.accent : 'mint';
    document.title = p.display_name + ' — WatchTogether';
    $('profileName').textContent = p.display_name; $('profileUsername').textContent = '@' + p.username;
    $('profileAvatar').innerHTML = C.avatar(p, 'hero');
    $('photoBadge').hidden = !own; $('photoOpen').disabled = !own;
    $('photoOpen').setAttribute('aria-label', own ? 'إضافة أو تغيير الصورة الشخصية من الجهاز' : 'الصورة الشخصية');
    $('profileCover').dataset.cover = ['orbit','prism','ripple'].includes(p.cover) ? p.cover : 'orbit';
    $('publicPreviewNote').hidden = !state.preview;
    let actions = '';
    if (own) actions = '<button class="s-btn s-btn--primary" type="button" data-profile-action="edit">' + icon('pencil',17) + ' تعديل الملف</button><button class="s-icon-btn" type="button" data-profile-action="preview" aria-label="معاينة الملف كما يراه عضو آخر" title="معاينة للزائر">' + icon('eye',19) + '</button>' + (p.avatar_path ? '<button class="s-icon-btn" type="button" data-profile-action="remove-photo" aria-label="إزالة الصورة الشخصية" title="إزالة الصورة">' + icon('trash',18) + '</button>' : '');
    else if (!state.own) actions = C.relationButtons(p) + '<button class="s-icon-btn" type="button" data-friend-action="block" data-user="' + esc(p.user_id) + '" aria-label="حظر العضو" title="حظر العضو">' + icon('block',18) + '</button>';
    actions += '<button class="s-icon-btn" type="button" data-profile-action="share" aria-label="مشاركة رابط الملف" title="مشاركة الملف">' + icon('share',19) + '</button>';
    $('profileActions').innerHTML = actions;
    const website = S.safeURL(p.website);
    $('profileMeta').innerHTML = (p.location ? '<span>' + icon('pin',15) + esc(p.location) + '</span>' : '') + (website ? '<a href="' + esc(website) + '" target="_blank" rel="noopener noreferrer nofollow">' + icon('link',14) + esc(new URL(website).hostname) + '</a>' : '') + '<span>' + icon('clock',14) + 'انضم في ' + esc(C.date(p.created_at,'month')) + '</span>';
    $('profileBio').textContent = p.bio || (own ? 'مساحة لجملة تشبهك. أضف نبذة من تعديل الملف.' : 'لم تُكتب نبذة بعد.');
    $('profileBio').classList.toggle('is-empty', !p.bio);
    const interests = (p.interests || []).filter(g => S.GENRES[g]);
    $('tasteMap').innerHTML = '<span class="taste-core">' + icon('film',20) + '</span>' + interests.map((g,i) => { const a = i / interests.length * 2 * Math.PI - Math.PI / 2; return '<span class="taste-dot" title="' + esc(S.GENRES[g]) + '" style="right:' + (50 + Math.cos(a)*46).toFixed(2) + '%;top:' + (50 + Math.sin(a)*46).toFixed(2) + '%"></span>'; }).join('');
    $('profileInterests').innerHTML = interests.length ? C.genres(interests) : '<span class="s-small s-muted">لم تُحدَّد اهتمامات بعد.</span>';
    const shared = (p.shared_interests || []).filter(g => S.GENRES[g]);
    $('sharedTastes').textContent = !state.own && shared.length ? 'تجمعكما: ' + shared.map(g => S.GENRES[g]).join('، ') : own ? 'بصمتك تساعدك على إيجاد رفاق بذائقة قريبة.' : '';
    $('sharedTastes').classList.toggle('shared-note', !state.own && !!shared.length);
    $('profileFavorites').innerHTML = (p.favorites || []).length ? p.favorites.map((title,i) => '<div class="favorite-item"><b>0' + (i+1) + '</b><span>' + esc(title) + '</span>' + icon('bookmark',16) + '</div>').join('') : '<p class="s-muted s-small">' + (own ? 'رفّك ينتظر عناوينك المفضلة. أضف حتى ثلاثة في قسم الذائقة.' : 'هذا الرفّ لا يزال فارغًا.') + '</p>';
    $('profileMood').innerHTML = C.mood(p); $('quickMood').value = p.mood;
    ['quickMood','quickMoodLabel','moodHint'].forEach(id => { $(id).hidden = !own; });
    const friendCount = state.preview && !p.show_friend_count ? null : p.friend_count;
    $('profileStats').innerHTML = '<div class="s-panel-title"><h2>لمحة صغيرة</h2>' + icon('sparkle',17) + '</div>' + (friendCount == null ? '' : '<div class="s-stat"><span>الأصدقاء' + (own && !p.show_friend_count ? '<small class="s-hint"> · خاص بك</small>' : '') + '</span><b>' + esc(friendCount) + '</b></div>') + '<div class="s-stat"><span>اهتمامات المشاهدة</span><b>' + interests.length + '</b></div><div class="s-stat"><span>عناوين على الرفّ</span><b>' + (p.favorites || []).length + '</b></div>';
    $('profileCompletion').hidden = !own; $('profilePrivacy').hidden = !own;
    if (own) {
      const total = [p.avatar_path,p.bio,p.username !== 'u_' + p.user_id.replace(/-/g,'').slice(0,20),interests.length,(p.favorites || []).length,p.location,p.website].filter(Boolean).length;
      $('profileCompletion').innerHTML = '<h3>تفاصيل تُشبهك <span class="s-hint" dir="ltr">' + total + ' / 7</span></h3><div class="completion-rail" role="progressbar" aria-label="تفاصيل الملف المضافة" aria-valuenow="' + total + '" aria-valuemin="0" aria-valuemax="7"><span style="width:' + (total/7*100).toFixed(1) + '%"></span></div><p>ليست كل التفاصيل ضرورية. اختر ما يعبّر عنك فقط.</p><button class="s-text-link" type="button" data-open-editor="details">أضف لمستك ' + icon('arrowLeft',14) + '</button>';
      $('profilePrivacy').innerHTML = '<h3>' + icon(p.discoverable ? 'eye' : 'eyeOff',17) + ' ' + (p.discoverable ? 'يمكن العثور عليك' : 'خارج نتائج البحث') + '</h3><p style="margin-top:10px">' + (p.discoverable ? 'اخترت أن يظهر ملفك للأعضاء في البحث. يمكنك تغيير ذلك متى شئت.' : 'الظهور في البحث متوقف. ملفك متاح للأعضاء الذين يعرفون رابطه فقط.') + '</p><button class="s-text-link" type="button" data-open-editor="privacy">تحكّم في خصوصيتك ' + icon('arrowLeft',14) + '</button>';
    }
  }
  function editTab(tab, focus) {
    if (!['details','taste','privacy'].includes(tab)) tab = 'details';
    document.querySelectorAll('[data-edit-tab]').forEach(b => { const yes = b.dataset.editTab === tab; b.classList.toggle('is-active',yes); b.setAttribute('aria-selected',String(yes)); b.tabIndex = yes ? 0 : -1; if (yes && focus) b.focus(); });
    ['details','taste','privacy'].forEach(t => { $('edit-' + t).hidden = t !== tab; });
  }
  function fill() {
    const p = state.p;
    for (const [key,id] of Object.entries({display_name:'editName',username:'editUsername',bio:'editBio',location:'editLocation',website:'editWebsite'})) $(id).value = p[key] || '';
    $('profileEmail').value = (A.accountUser() || {}).email || '';
    Object.entries(prefs).forEach(([key,id]) => { $(id).checked = !!p[key]; });
    [0,1,2].forEach(i => { $('favorite'+i).value = (p.favorites || [])[i] || ''; });
    state.genres = new Set(p.interests || []); state.accent = p.accent; state.cover = p.cover;
    $('genreChoices').innerHTML = Object.entries(S.GENRES).map(([key,label]) => '<button type="button" class="s-choice-chip" data-genre="' + key + '" aria-pressed="' + state.genres.has(key) + '">' + esc(label) + '</button>').join('');
    $('accentChoices').innerHTML = Object.entries(S.ACCENTS).map(([key,color]) => '<button type="button" class="s-accent-option" style="background:' + color + '" data-accent-choice="' + key + '" aria-label="' + ({mint:'نعناعي',violet:'بنفسجي',amber:'كهرماني',rose:'وردي'})[key] + '" aria-pressed="' + (key === p.accent) + '">' + (key === p.accent ? icon('check',18) : '') + '</button>').join('');
    $('coverChoices').innerHTML = Object.entries({orbit:'مدار',prism:'منشور',ripple:'تموّج'}).map(([key,label]) => '<button type="button" class="s-cover-option" data-cover-choice="' + key + '" aria-pressed="' + (key === p.cover) + '"><span class="profile-cover" data-cover="' + key + '" style="display:block"><span class="cover-orb"></span></span>' + label + '</button>').join('');
    $('bioCounter').textContent = $('editBio').value.length + ' / 280';
    dirty(false); C.error('profileSaveError',null);
  }
  function openEditor(tab) {
    if (!state.own) return;
    state.editing = true; fill(); editTab(tab || 'details',false);
    $('profileView').hidden = true; $('profileEditor').hidden = false; $('editorTitle').scrollIntoView({block:'start'});
    $('tab-' + (['details','taste','privacy'].includes(tab) ? tab : 'details')).focus({preventScroll:true});
  }
  async function closeEditor() {
    if (state.saving) return;
    if (state.dirty && !await C.confirm({title:'تجاهل التغييرات؟',body:'التعديلات الحالية لم تُحفظ بعد. يمكنك العودة لإكمالها.',label:'تجاهل التغييرات'})) return;
    state.editing = false; dirty(false); $('profileEditor').hidden = true; $('profileView').hidden = false; render();
    const button = $('profileActions').querySelector('[data-profile-action="edit"]'); if (button) button.focus({preventScroll:true});
  }
  function readForm() {
    const result = { display_name:$('editName').value,username:$('editUsername').value,bio:$('editBio').value,location:$('editLocation').value,website:$('editWebsite').value,
      interests:[...state.genres],favorites:[0,1,2].map(i => $('favorite'+i).value),mood:state.p.mood,accent:state.accent,cover:state.cover };
    Object.entries(prefs).forEach(([key,id]) => { result[key] = $(id).checked; });
    const valid = S.validateProfile(result); delete valid.mood; return valid;
  }
  $('profileForm').addEventListener('input', () => { dirty(true); $('bioCounter').textContent = $('editBio').value.length + ' / 280'; });
  $('profileForm').addEventListener('change', () => dirty(true));
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault(); if (state.saving) return; C.error('profileSaveError',null);
    let values; try { values = readForm(); } catch (err) { C.error('profileSaveError',err); return; }
    state.saving = true; C.busy($('saveProfile'),true);
    const controls = [...$('profileForm').querySelectorAll('input,textarea,button'),$('closeEditor')]; controls.forEach(b => { b.disabled = true; });
    try { state.p = state.me = await S.saveProfile(values); render(); fill(); $('profileSaved').textContent = 'تم حفظ التغييرات.'; }
    catch (err) { C.error('profileSaveError',err); }
    finally { state.saving = false; controls.forEach(b => { b.disabled = false; }); C.busy($('saveProfile'),false); }
  });
  $('genreChoices').onclick = event => {
    const b = event.target.closest('[data-genre]'); if (!b || state.saving) return;
    const key = b.dataset.genre;
    if (state.genres.has(key)) state.genres.delete(key);
    else { if (state.genres.size >= 8) { C.error('profileSaveError',new Error('يمكنك اختيار 8 اهتمامات كحد أقصى.')); return; } state.genres.add(key); }
    b.setAttribute('aria-pressed',String(state.genres.has(key))); dirty(true);
  };
  $('accentChoices').onclick = event => {
    const b = event.target.closest('[data-accent-choice]'); if (!b || state.saving) return;
    state.accent = b.dataset.accentChoice; document.body.dataset.accent = state.accent;
    $('accentChoices').querySelectorAll('button').forEach(button => { const yes = button === b; button.setAttribute('aria-pressed',String(yes)); button.innerHTML = yes ? icon('check',18) : ''; }); dirty(true);
  };
  $('coverChoices').onclick = event => { const b = event.target.closest('[data-cover-choice]'); if (!b || state.saving) return; state.cover = b.dataset.coverChoice; $('coverChoices').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(button === b))); dirty(true); };
  $('profileEditTabs').onclick = event => { const b = event.target.closest('[data-edit-tab]'); if (b) editTab(b.dataset.editTab,false); };
  $('profileEditTabs').onkeydown = event => {
    const buttons = [...$('profileEditTabs').querySelectorAll('[role="tab"]')], index = buttons.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (event.key === 'ArrowLeft' ? 1 : -1) + buttons.length) % buttons.length; editTab(buttons[next].dataset.editTab,true);
  };
  $('closeEditor').onclick = closeEditor;
  $('resetProfile').onclick = async () => { if (!state.dirty || await C.confirm({title:'التراجع عن التعديلات؟',body:'ستعود الحقول إلى آخر نسخة محفوظة.',label:'إعادة الحقول'})) { fill(); document.body.dataset.accent = state.p.accent; } };
  $('endPreview').onclick = () => { state.preview = false; render(); };
  $('quickMood').onchange = async () => {
    const select = $('quickMood'); select.disabled = true; C.error('profileError',null);
    try { state.p = state.me = await S.saveProfile({mood:select.value}); render(); }
    catch (err) { select.value = state.p.mood; C.error('profileError',err); }
    finally { select.disabled = false; }
  };
  $('socialContent').addEventListener('click', async event => {
    const opener = event.target.closest('[data-open-editor]'); if (opener) { openEditor(opener.dataset.openEditor); return; }
    const friend = event.target.closest('[data-friend-action]');
    if (friend) {
      C.error('profileError',null);
      try { const result = await C.friendAction(friend.dataset.user,friend.dataset.friendAction,friend); if (!result) return; if (friend.dataset.friendAction === 'block') { location.href='friends.html?tab=blocked'; return; } state.p = await S.call('profile',{p_user:state.p.user_id}); render(); }
      catch (err) { C.error('profileError',err); }
      return;
    }
    const button = event.target.closest('[data-profile-action]'); if (!button || !state.p) return;
    const action = button.dataset.profileAction;
    if (action === 'edit') openEditor('details');
    if (action === 'preview') { state.preview = true; render(); }
    if (action === 'share') {
      const url = new URL('profile.html',location.href); url.searchParams.set('u',state.p.user_id);
      try {
        if (navigator.share) await navigator.share({title:state.p.display_name + ' — WatchTogether',url:url.href});
        else { const copied = await U.copyText(url.href); if (copied === false) throw new Error('copy'); U.toast('نُسخ رابط الملف','success'); }
      } catch (err) { if (err.name !== 'AbortError') C.error('profileError',new Error('تعذّرت المشاركة. جرّب نسخ رابط الصفحة من المتصفح.')); }
    }
    if (action === 'remove-photo' && state.own && await C.confirm({title:'إزالة صورتك الشخصية؟',body:'ستظهر الأحرف الأولى من اسمك بدلاً منها.',label:'إزالة الصورة',danger:true})) {
      C.busy(button,true,'');
      try { state.p = state.me = await S.removeAvatar(); render(); U.toast('تمت إزالة الصورة','success'); }
      catch (err) { C.error('profileError',err); C.busy(button,false); }
    }
  });
  window.WTPhotoEditor.create({ input:$('photoInput'),button:$('photoOpen'),onSaved:profile => { state.p = state.me = profile; render(); } });
  window.addEventListener('beforeunload', event => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
  C.boot(async data => {
    state.me = data.profile;
    const id = (params.get('u') || '').toLowerCase(); if (id && !S.UUID.test(id)) throw new Error('رابط الملف غير صالح.');
    state.own = !id || id === data.profile.user_id;
    state.p = state.own ? data.profile : await S.call('profile',{p_user:id});
    if (!state.p || !S.UUID.test(state.p.user_id || '')) throw new Error('الملف غير متاح.');
    render();
    if (state.own && params.has('edit')) openEditor(params.get('edit'));
  });
})();

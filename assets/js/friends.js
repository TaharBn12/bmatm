/* Opt-in people search and server-authorized friendship/blocked-list management. */
(function () {
  'use strict';
  const S = window.WTSocial, C = window.WTSocialUI, U = window.WTUtil, { $, esc, icon } = C;
  const params = new URLSearchParams(location.search), tabs = ['discover','friends','incoming','outgoing','blocked'];
  const state = { tab: tabs.includes(params.get('tab')) ? params.get('tab') : 'discover', genre: null, query: '', people: [], offset: 0, more: false, generation: 0, controller: null, loading: false, timer: null };
  const headings = { discover:'رفاق محتملون',friends:'رفاق المشاهدة',incoming:'طلبات تنتظر قرارك',outgoing:'الخطوة الأولى منك',blocked:'قائمة الحظر الخاصة بك' };
  function counters(counts) {
    if (!counts) return; C.setCounts(counts);
    document.querySelectorAll('[data-count]').forEach(node => { const n = Number(counts[node.dataset.count]) || 0; node.textContent = n ? String(n) : ''; node.className = n ? 's-tab-count' : ''; });
  }
  function card(p) {
    const blocked = state.tab === 'blocked', interests = (p.interests || []).filter(g => S.GENRES[g]), shared = (p.shared_interests || []).filter(g => S.GENRES[g]);
    const link = 'profile.html?u=' + encodeURIComponent(p.user_id);
    return '<article class="friend-card" data-person="' + esc(p.user_id) + '"><div class="friend-card-top">' + (blocked ? C.avatar(p,'lg') : '<a href="' + link + '" aria-label="ملف ' + esc(p.display_name) + '">' + C.avatar(p,'lg') + '</a>') + (blocked ? '<span class="s-mood">محظور</span>' : C.mood(p)) + '</div><h3>' + (blocked ? esc(p.display_name) : '<a href="' + link + '">' + esc(p.display_name) + '</a>') + '</h3><div class="profile-username">@' + esc(p.username || '') + '</div><p class="friend-card-bio">' + esc(blocked ? 'إلغاء الحظر لا يعيد الصداقة تلقائيًا.' : p.bio || 'لم تُضف نبذة بعد.') + '</p><div class="s-tags">' + C.genres(interests.slice(0,3)) + (interests.length > 3 ? '<span class="s-tag" dir="ltr">+' + (interests.length-3) + '</span>' : '') + '</div><div class="friend-common' + (!shared.length ? ' is-neutral' : '') + '">' + icon(shared.length ? 'sparkle' : 'film',15) + (shared.length ? shared.length + ' اهتمامات مشتركة' : blocked ? 'لا رسائل أو طلبات أثناء الحظر' : 'مساحة لاكتشاف ذائقة جديدة') + '</div><div class="friend-card-actions">' + C.relationButtons(p,true) + (blocked ? '' : '<a class="s-icon-btn" href="' + link + '" aria-label="فتح الملف الشخصي" title="فتح الملف">' + icon('arrowLeft',17) + '</a>') + '</div></article>';
  }
  function view() {
    $('friendGrid').innerHTML = state.people.map(card).join('');
    $('friendGrid').hidden = !state.people.length;
    $('friendsEmpty').hidden = !!state.people.length;
    if (!state.people.length) {
      const copy = state.query || state.genre ? ['لم نعثر على تطابق هذه المرة','جرّب اسمًا آخر أو أزل فلتر الذائقة.'] : {
        discover:['الرفاق الجدد سيظهرون هنا','يظهر في البحث فقط من فعّل ظهور ملفه. تستطيع مشاركة رابطك أو تفعيل ظهورك من الخصوصية.'],
        friends:['أول رفيق، بداية جميلة','ابحث عن ذائقة قريبة، وأرسل طلب صداقة. تبدأ المراسلة بعد قبوله.'],
        incoming:['لا طلبات تنتظر الآن','أي طلب جديد سيظهر هنا، ويمكنك قبوله أو رفضه.'],
        outgoing:['لم تُرسل طلبات معلّقة','اختر رفيقًا من قسم اكتشف، وابدأ الخطوة الأولى.'],
        blocked:['قائمة هادئة وفارغة','لم تحظر أي عضو. إن احتجت، تجد خيار الحظر في الملف أو المحادثة.']
      }[state.tab];
      $('friendsEmpty').innerHTML = C.empty(state.tab === 'blocked' ? 'shield' : 'users',copy[0],copy[1],state.tab === 'friends' ? '<button class="s-btn s-btn--soft" type="button" data-discover>اكتشف أعضاء الموقع</button>' : '');
    }
    $('friendsMore').hidden = !state.more;
    $('friendResults').setAttribute('aria-busy','false');
  }
  async function load(append) {
    clearTimeout(state.timer);
    if (state.controller) state.controller.abort();
    state.controller = new AbortController(); const ticket = ++state.generation;
    const offset = append ? state.offset : 0;
    state.loading = true; C.error('friendsError',null); $('friendResults').setAttribute('aria-busy','true'); $('friendsMore').disabled = true;
    if (!append) { state.people = []; $('friendGrid').hidden = true; $('friendsEmpty').hidden = false; $('friendsEmpty').innerHTML = C.loading('نبحث عن رفاق الذائقة…'); $('friendsMore').hidden = true; }
    try {
      const args = state.tab === 'discover' ? {p_query:state.query,p_genre:state.genre,p_offset:offset} : {p_tab:state.tab,p_query:state.query,p_offset:offset};
      const data = await S.call(state.tab === 'discover' ? 'search' : 'friends',args,state.controller.signal);
      if (ticket !== state.generation) return;
      if (!data || !Array.isArray(data.people)) throw new Error('استجابة البحث غير صالحة.');
      const people = data.people.filter(p => p && S.UUID.test(p.user_id || ''));
      state.people = append ? [...new Map([...state.people,...people].map(p => [p.user_id,p])).values()] : people;
      state.offset = offset + data.people.length; state.more = !!data.has_more;
      counters(data.counts); view();
    } catch (err) {
      if (ticket !== state.generation || err.name === 'AbortError') return;
      C.error('friendsError',err,() => load(append));
      if (!append) { $('friendsEmpty').hidden = true; $('friendGrid').hidden = true; }
    } finally {
      if (ticket === state.generation) { state.loading = false; $('friendsMore').disabled = false; $('friendResults').setAttribute('aria-busy','false'); }
    }
  }
  function setTab(tab, focus) {
    if (!tabs.includes(tab)) return;
    state.tab = tab;
    document.querySelectorAll('[data-friend-tab]').forEach(button => { const yes = button.dataset.friendTab === tab; button.classList.toggle('is-active',yes); button.setAttribute('aria-selected',String(yes)); button.tabIndex = yes ? 0 : -1; if (yes && focus) button.focus(); });
    $('friendResults').setAttribute('aria-labelledby','friend-tab-' + tab);
    $('friendResultsTitle').textContent = headings[tab]; $('friendGenreFilters').hidden = tab !== 'discover';
    $('friendResultsHint').textContent = tab === 'discover' ? 'الاهتمامات المشتركة أولاً، بلا نسب توافق وهمية.' : tab === 'blocked' ? 'لا يطّلع أي عضو آخر على هذه القائمة.' : 'الصداقات المقبولة تفتح لكما مساحة مراسلة خاصة.';
    $('friendQuery').placeholder = tab === 'discover' ? 'اسم أو @معرّف…' : 'ابحث في هذه القائمة…';
    history.replaceState(null,'','friends.html' + (tab === 'discover' ? '' : '?tab=' + tab));
    load(false);
  }
  $('friendSearchForm').onsubmit = event => { event.preventDefault(); state.query = $('friendQuery').value.trim().slice(0,60); load(false); };
  $('friendQuery').addEventListener('input', () => { state.query = $('friendQuery').value.trim().slice(0,60); state.generation++; if (state.controller) state.controller.abort(); clearTimeout(state.timer); state.timer = setTimeout(() => load(false),350); });
  $('friendTabs').onclick = event => { const button = event.target.closest('[data-friend-tab]'); if (button) setTab(button.dataset.friendTab,false); };
  $('friendTabs').onkeydown = event => {
    const buttons = [...$('friendTabs').querySelectorAll('[role="tab"]')], index = buttons.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (event.key === 'ArrowLeft' ? 1 : -1) + buttons.length) % buttons.length; setTab(buttons[next].dataset.friendTab,true);
  };
  $('friendGenreFilters').onclick = event => { const button = event.target.closest('[data-filter-genre]'); if (!button) return; state.genre = button.dataset.filterGenre || null; $('friendGenreFilters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed',String(b === button))); load(false); };
  $('friendsMore').onclick = () => { if (!state.loading) load(true); };
  $('friendsEmpty').onclick = event => { if (event.target.closest('[data-discover]')) setTab('discover',true); };
  $('friendGrid').onclick = async event => {
    const button = event.target.closest('[data-friend-action]'); if (!button) return;
    const tab = state.tab;
    try {
      C.error('friendsError',null); const result = await C.friendAction(button.dataset.user,button.dataset.friendAction,button); if (!result) return;
      counters(result.counts);
      U.toast(({request:'أُرسل طلب الصداقة',accept:'أصبحتما صديقين',reject:'رُفض الطلب',cancel:'أُلغي الطلب',remove:'أُزيلت الصداقة',unblock:'أُلغي الحظر'})[button.dataset.friendAction] || 'تم التحديث','success');
      if (state.tab === tab) await load(false);
    } catch (err) { C.error('friendsError',err); }
  };
  window.addEventListener('pagehide', () => { clearTimeout(state.timer); if (state.controller) state.controller.abort(); });
  C.boot(async data => {
    counters(data.counts);
    $('friendGenreFilters').innerHTML = '<button class="s-choice-chip" data-filter-genre="" type="button" aria-pressed="true">كل الذائقات</button>' + Object.entries(S.GENRES).map(([key,label]) => '<button class="s-choice-chip" data-filter-genre="' + key + '" type="button" aria-pressed="false">' + esc(label) + '</button>').join('');
    setTab(state.tab,false);
  });
})();

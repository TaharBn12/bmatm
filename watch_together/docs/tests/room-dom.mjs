/* =========================================================
   WatchTogether — اختبار واجهة الغرفة بدون متصفح (DOM وهمي)
   التشغيل: node docs/tests/room-dom.mjs
   ========================================================= */
import fs from 'fs';
import path from 'path';
import { createRoomEnv, wait, base, setAccountName } from './harness.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name} ${extra}`); }
};
const ownerToken = 'a'.repeat(64);
const env = createRoomEnv({
  search: '?id=ABC123&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4',
  store: { 'wt:owner:ABC123': JSON.stringify(ownerToken) }
});
const { sandbox, documentStub, byId, store, html } = env;
env.sandbox.WT_CONFIG.javaServer.enabled = false;
env.sandbox.WT_CONFIG.supabase.ready = false;
setAccountName(env, 'أمين بن علي');

env.loaded.forEach(l => t(`تحميل ${path.basename(l.file)}`, l.ok, l.ok ? '' : l.error.message));
env.loaded.filter(l => !l.ok).forEach(l => console.log(l.error && l.error.stack));

const run = async () => {
  await wait(100);

  setAccountName(env, 'أمين بن علي');
  const needed = [
    'authStatus', 'room', 'roomSub', 'roomCodeText', 'copyCodeBtn', 'statusBadge', 'statusText',
    'copyLinkBtn', 'shareBtn', 'qrBtn', 'diagBtn', 'leaveBtn', 'drawerOpenBtn', 'drawerCloseBtn',
    'drawerScrim', 'roomDrawer', 'organizerList', 'organizerCount', 'membersList', 'membersCount',
    'sideMembersCount', 'stage', 'player', 'playerPlaceholder', 'ctrlbar', 'videoFullscreenBtn',
    'centerPlayBtn',
    'progressBar', 'progressFill', 'progressBuffer', 'progressKnob', 'progressTip',
    'addVideoBtn', 'messagesBtn', 'messagesCount', 'playlistBtn', 'playlistCount',
    'changeBar', 'newUrl', 'newTitle', 'applyUrlBtn', 'cancelUrlBtn', 'roomMain', 'chatWidget', 'chatFab',
    'chatFabCount', 'chatCloseBtn', 'chat', 'chatBody', 'chatEmpty', 'chatCount', 'clearChatBtn', 'chatForm', 'chatInput', 'chatSend',
    'typing', 'messagesIcon', 'playlistModal', 'playlistCloseBtn', 'queueList', 'queueEmpty',
    'sbMeBtn', 'qrModal', 'qrBox', 'qrUrl', 'qrClose', 'qrCopy', 'meModal', 'meClose',
    'meAvatar', 'meName', 'meMail', 'meNameInput', 'meSave', 'meSignout', 'diagModal',
    'diagBody', 'diagReconnectBtn', 'diagRunBtn', 'diagCopyBtn', 'diagCloseBtn'
  ];
  const missing = needed.filter(id => !byId.has(id));
  t('كل عناصر الواجهة الجديدة موجودة', missing.length === 0, missing.join(','));

  t('إزالة العنوان والشعار وأزرار الفيديو الزائدة وشريط الإيموجي العلوي', !/id="(roomTitle|collapseBtn|backToVideoBtn|reactRow)"|rtopbar__brand/.test(html));

  const roomJs = fs.readFileSync(path.join(base, 'assets/js/room.js'), 'utf8');
  const refs = [...roomJs.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const missingRefs = [...new Set(refs)].filter(id => !byId.has(id));
  t('كل مراجع DOM في room.js موجودة أو اختيارية', missingRefs.length === 0, missingRefs.join(','));

  const order = ['id="roomBar"', 'id="changeBar"', 'id="mediaShell"', 'id="stage"', 'id="ctrlbar"', 'id="chat"']
    .map(s => html.indexOf(s));
  t('الترتيب: رأس الغرفة ← إضافة الرابط ← المشغّل ← شريط التحكم ← الرسائل',
    order.every((n, i) => n >= 0 && (!i || n > order[i - 1])), order.join(','));

  /* الفقاعة خارج تدفّق المشغّل، واللوحة داخلها ولا تحجز مساحة أسفل الفيديو. */
  const mainSlice = html.slice(html.indexOf('id="roomMain"'), html.indexOf('<!-- ===== سكربتات'));
  const widgetTag = mainSlice.indexOf('id="chatWidget"');
  const chatTag = mainSlice.indexOf('<section class="chat');
  const between = mainSlice.slice(mainSlice.indexOf('id="mediaShell"'), widgetTag);
  /* كل ما داخل بطاقة المشغّل مسموح؛ فقاعة الدردشة تبدأ بعدها كعنصر عائم مستقل. */
  const allowedIds = new Set(['mediaShell', 'stage', 'player', 'playerPlaceholder', 'centerPlayBtn', 'videoFullscreenBtn', 'clickLayer',
    'ctrlbar', 'videoFullscreenBtn', 'iconPlay', 'iconPause', 'curTime', 'durTime', 'progressBar', 'progressBuffer',
    'progressFill', 'progressKnob', 'progressTip', 'muteBtn', 'iconSound', 'iconMuted']);
  const strayIds = [...between.matchAll(/id="([^"]+)"/g)].map(m => m[1]).filter(id => !allowedIds.has(id));
  const strayClasses = [...between.matchAll(/class="([^"]+)"/g)].map(m => m[1])
    .flatMap(c => c.split(/\s+/)).filter(c => ['room-bar', 'player-actions', 'change-bar', 'chat', 'player-action', 'rtopbar', 'drawer-open'].includes(c));
  t('فقاعة الدردشة العائمة تأتي بعد المشغّل دون إدخال لوحة في تدفّق الصفحة',
    widgetTag > 0 && strayIds.length === 0 && strayClasses.length === 0,
    `ids=${strayIds.join(',')} classes=${strayClasses.join(',')}`);
  t('لوحة Messenger داخل فقاعة الدردشة وتبدأ مغلقة',
    widgetTag > 0 && chatTag > widgetTag && /id="chat"[^>]*hidden/.test(mainSlice.slice(chatTag, chatTag + 180)));
  t('أدوات الغرفة (إضافة فيديو · رسائل · تشغيل) في الرأس أعلى المشغّل',
    mainSlice.indexOf('id="roomBar"') < mainSlice.indexOf('id="mediaShell"') &&
    mainSlice.indexOf('id="addVideoBtn"') < mainSlice.indexOf('id="mediaShell"'), '');
  t('نموذج إضافة الرابط تحت الرأس ويظهر عند الطلب (مخفيّ افتراضياً)',
    mainSlice.indexOf('id="roomBar"') < mainSlice.indexOf('id="changeBar"') &&
    /<section class="change-bar glass" id="changeBar"\s+hidden>/.test(html), '');
  t('شريط التحكم أسفل الفيديو (بعد إغلاق المشغّل)',
    html.indexOf('id="player"') < html.indexOf('id="ctrlbar"') &&
    html.indexOf('id="ctrlbar"') < html.indexOf('</section>', html.indexOf('id="stage"')));
  t('المشاركون في القائمة الجانبية والرسائل خارجها',
    html.indexOf('id="membersPanel"') < html.indexOf('id="roomMain"') &&
    html.indexOf('id="membersPanel"') < html.indexOf('id="chat"'));
  t('الشاشة بلا شريط صوت أو ملء شاشة أو تقديم/ترجيع',
    !/id="(volRange|playPauseBtn|muteBtn|curTime|durTime|skipBackBtn|skipFwdBtn)"/.test(html));
  t('أزرار الأدوات الثلاثة تحت المشغّل',
    html.indexOf('id="addVideoBtn"') < html.indexOf('id="messagesBtn"') && html.indexOf('id="messagesBtn"') < html.indexOf('id="playlistBtn"'));
  t('شبكة معلومات المشاركين القديمة محذوفة', !/id="info(Grid|Transport|Provider|Controller|Role|Sync|Code)"/.test(html));
  t('مفتاح المنشئ ليس ضمن رابط الدعوة', !/ownerToken|owner_token/i.test(html));
  t('أيقونات SVG مستخدمة', (html.match(/data-icon="/g) || []).length >= 35);

  t('بوابة الاسم ونموذج الضيف محذوفان نهائياً', !byId.has('gate') && !byId.has('gateForm') && !/id="guestForm"/.test(html));
  t('شاشة التحقق لا تطلب اسماً ولا تمنع الدخول بالحساب', !!byId.get('authStatus') && /جارٍ التحقق من الحساب/.test(html));
  t('كود الغرفة ظاهر في الدرّاور', byId.get('roomCodeText').textContent === 'ABC123');

  await wait(450);
  t('الحساب يدخل مباشرةً دون بوابة اسم', !byId.get('room').hidden && byId.get('authStatus').hidden);
  t('الهوية تأتي من الحساب المسجّل', sandbox.WTRoom.session.name === 'أمين بن علي');
  t('مؤشر الاتصال المحلي ظاهر', byId.get('statusText').textContent === 'محلي فقط', byId.get('statusText').textContent);
  t('مؤشر اتصال صغير فقط في رأس الغرفة', !!byId.get('statusBadge').querySelector('.dot'));
  t('المستخدم الحالي منشئ ويملك التحكم', sandbox.WTRoom.session.role === 'owner' && !byId.get('centerPlayBtn').disabled, sandbox.WTRoom.session.role);

  await wait(80);
  t('أنا في قائمة المشاركين', byId.get('membersList').innerHTML.includes('أمين بن علي'));
  t('شارة «أنت» ظاهرة', byId.get('membersList').innerHTML.includes('(أنت)'));
  t('المنشئ يظهر بقائمة المنظّمين', byId.get('organizerList').innerHTML.includes('أمين بن علي'));
  t('عداد المشاركين يساوي 1', byId.get('membersCount').textContent === '1' && byId.get('sideMembersCount').textContent === '1');
  env.sandbox.WTRoom.session.transport.emit('settings', { controlMode: 'owner' });
  t('إعداد خادم قديم لا يعيد قفل التحكم', env.sandbox.WTRoom.session.controlMode === 'everyone' && !byId.get('centerPlayBtn').disabled);
  env.sandbox.WTRoom.session.transport.emit('members', [
    { id: env.sandbox.WTRoom.session.clientId, name: 'أمين بن علي', role: 'owner', userKey: 'account-a' },
    { id: 'same-account-other-tab', name: 'أمين بن علي', role: 'viewer', userKey: 'account-a' },
    { id: 'another-account', name: 'مشارك آخر', role: 'viewer', userKey: 'account-b' }
  ]);
  const visibleCards = (byId.get('membersList').innerHTML.match(/class="member-card(?:\s|")/g) || []).length;
  t('الحساب نفسه في تبويبين يظهر مرة واحدة', visibleCards === 2 && byId.get('membersCount').textContent === '2', 'cards=' + visibleCards);
  t('سجل الاتصالات يحتفظ بكلا التبويبين للإدارة', Object.keys(env.sandbox.WTRoom.session.members).length === 3);
  const selfId = env.sandbox.WTRoom.session.clientId;
  const otherActiveId = Object.keys(env.sandbox.WTRoom.session.members).find(id => id !== selfId);
  env.sandbox.WTRoom.state.updatedBy = selfId;
  t('كاتب الحالة الحالي ينسّق الانتقال التلقائي', env.sandbox.WTRoom.canAutoAdvance());
  env.sandbox.WTRoom.state.updatedBy = otherActiveId;
  t('تبويب آخر يظل المتحكم الوحيد في الانتقال التلقائي', !env.sandbox.WTRoom.canAutoAdvance());
  env.sandbox.WTRoom.state.updatedBy = 'offline-controller';
  const electedLeader = Object.keys(env.sandbox.WTRoom.session.members).sort()[0];
  t('غياب كاتب الحالة ينتخب جهازاً نشطاً واحداً بصورة حتمية', env.sandbox.WTRoom.canAutoAdvance() === (selfId === electedLeader));

  const drawer = byId.get('roomDrawer');
  byId.get('drawerOpenBtn').dispatch('click', {});
  t('زر القائمة يفتح الدرّاور', drawer.classList.contains('is-open') && byId.get('drawerScrim').hidden === false);
  t('حالة الوصول للدرّاور تُحدّث', byId.get('drawerOpenBtn').getAttribute('aria-expanded') === 'true');
  byId.get('drawerCloseBtn').dispatch('click', {});
  t('زر الإغلاق يغلق الدرّاور', !drawer.classList.contains('is-open') && byId.get('drawerScrim').hidden === true);

  const chatBody = byId.get('chatBody');
  const before = chatBody.children.length;
  byId.get('chatInput').value = 'أهلاً بالجميع';
  byId.get('chatForm').dispatch('submit', {});
  await wait(50);
  t('الرسالة أُضيفت وحقل الإدخال فُرّغ', chatBody.children.length > before && byId.get('chatInput').value === '');
  t('عداد الرسائل يتحدث', /رسالة|رسائل/.test(byId.get('chatCount').textContent));
  t('رسائل الانضمام محصورة في نافذة الرسائل', chatBody.children.some(c => String(c._className).includes('msg--system')));
  t('المحادثة مغلقة ابتدائياً والعدادان مخفيان عند عدم وجود رسائل غير مقروءة',
    byId.get('chat').hidden && byId.get('chatFabCount').hidden && byId.get('messagesCount').hidden);
  const sentMsg = chatBody.children.at(-1);
  t('إزالة شريط الإيموجي فوق حقل الكتابة', !byId.has('reactRow'));
  t('الرسالة المدمجة بلا اسم ظاهر وبلا أيقونة تفاعل داخل الفقاعة',
    !!sentMsg && !sentMsg.querySelector('.msg__name') && !sentMsg.querySelector('.msg__react-add') && !!sentMsg.querySelector('.msg__time'));
  chatBody.dispatch('pointerdown', { clientX: 100, clientY: 200, pointerId: 1, target: sentMsg });
  await wait(500);
  chatBody.dispatch('pointerup', { clientX: 100, clientY: 200, pointerId: 1, target: sentMsg });
  const msgMenu = documentStub.body.querySelector('.msg-menu');
  t('الضغط المطوّل يظهر إيموجي التفاعل للرسالة', !!msgMenu && !msgMenu.hidden && (msgMenu.querySelectorAll('.msg-menu__reaction') || []).length >= 5);
  msgMenu.hidden = true;

  byId.get('messagesBtn').dispatch('click', {});
  await wait(40);
  t('زر الرسائل يفتح لوحة Messenger دون إخفاء الفيديو', sandbox.WTRoom.session.chatOpen && !byId.get('chat').hidden &&
    !byId.get('stage').hidden && byId.get('messagesBtn').getAttribute('aria-expanded') === 'true' &&
    byId.get('messagesIcon').innerHTML === sandbox.WTIcons.html('chatUp', 19));
  byId.get('chatCloseBtn').dispatch('click', {});
  t('زر التصغير يغلق اللوحة ويبقي المشغّل ظاهراً', !sandbox.WTRoom.session.chatOpen && byId.get('chat').hidden &&
    !byId.get('stage').hidden && byId.get('messagesBtn').getAttribute('aria-expanded') === 'false');
  byId.get('chatFab').dispatch('click', {});
  t('فقاعة الدردشة تفتح المحادثة', sandbox.WTRoom.session.chatOpen && !byId.get('chat').hidden &&
    byId.get('chatFab').getAttribute('aria-expanded') === 'true');
  byId.get('chatFab').dispatch('click', {});
  t('الفقاعة نفسها تغلق اللوحة', !sandbox.WTRoom.session.chatOpen && byId.get('chat').hidden);
  sandbox.WTRoom.session.transport.emit('chat', { id: 'unread-1', client: 'remote-unread', name: 'مشارك', text: 'رسالة جديدة', kind: 'chat' });
  t('تظهر شارة غير المقروء على الفقاعة وزر الرأس', sandbox.WTRoom.session.unread === 1 &&
    byId.get('chatFabCount').textContent === '1' && byId.get('messagesCount').textContent === '1');
  byId.get('chatFab').dispatch('click', {});
  t('فتح المحادثة يصفّر عداد غير المقروء', sandbox.WTRoom.session.unread === 0 &&
    byId.get('chatFabCount').hidden && byId.get('messagesCount').hidden);
  byId.get('chatFab').dispatch('click', {});
  documentStub.fullscreenElement = byId.get('stage');
  documentStub.dispatch('fullscreenchange', {});
  t('فقاعة الدردشة تنتقل إلى عنصر الفيديو كي تبقى داخل ملء الشاشة', byId.get('chatWidget').parentNode === byId.get('stage') &&
    byId.get('chatWidget').classList.contains('is-fullscreen'));
  documentStub.fullscreenElement = null;
  documentStub.dispatch('fullscreenchange', {});
  t('بعد الخروج من ملء الشاشة تعود الفقاعة إلى تخطيط الغرفة', byId.get('chatWidget').parentNode === byId.get('roomMain') &&
    !byId.get('chatWidget').classList.contains('is-fullscreen'));

  byId.get('addVideoBtn').dispatch('click', {});
  t('إضافة فيديو تفتح حقل الرابط', !byId.get('changeBar').hidden);
  byId.get('newUrl').value = 'not a url';
  byId.get('applyUrlBtn').dispatch('click', {});
  t('يرفض رابط فيديو غير صالح', !byId.get('changeBar').hidden);
  byId.get('newUrl').value = 'https://example.com/next.mp4';
  byId.get('newTitle').value = 'الفيديو التالي';
  byId.get('applyUrlBtn').dispatch('click', {});
  await wait(40);
  t('إضافة فيديو صالح إلى القائمة المشتركة', sandbox.WTRoom.session.queue.length === 1 && byId.get('playlistCount').textContent === '1');
  byId.get('playlistBtn').dispatch('click', {});
  t('زر القائمة يفتح نافذة التشغيل', !byId.get('playlistModal').hidden && byId.get('queueList').innerHTML.includes('الفيديو التالي'));
  byId.get('playlistCloseBtn').dispatch('click', {});
  t('زر إغلاق قائمة التشغيل يعمل', byId.get('playlistModal').hidden);

  const clickIds = ['videoFullscreenBtn', 'centerPlayBtn', 'progressBar', 'addVideoBtn', 'messagesBtn', 'playlistBtn', 'chatFab', 'chatCloseBtn',
    'drawerOpenBtn', 'drawerCloseBtn', 'copyCodeBtn', 'copyLinkBtn', 'qrBtn', 'leaveBtn', 'clearChatBtn',
    'sbMeBtn', 'meClose', 'meSave', 'meSignout', 'cancelUrlBtn', 'applyUrlBtn', 'playlistCloseBtn'];
  clickIds.forEach(id => {
    const node = byId.get(id);
    const count = node ? ((node._handlers.click || []).length + (node._handlers.pointerdown || []).length) : 0;
    t(`ربط الحدث ${id}`, count > 0, `handlers=${count}`);
  });

  byId.get('qrBtn').dispatch('click', {});
  t('نافذة QR تفتح برابط الغرفة', !byId.get('qrModal').hidden && byId.get('qrUrl').textContent.includes('room.html?id=ABC123'));
  byId.get('qrClose').dispatch('click', {});
  byId.get('sbMeBtn').dispatch('click', {});
  t('نافذة الحساب تفتح باسم المستخدم', !byId.get('meModal').hidden && byId.get('meName').textContent === 'أمين بن علي');
  byId.get('meClose').dispatch('click', {});

  documentStub.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY', isContentEditable: false } });
  t('Escape لا يترك نافذة قائمة التشغيل مفتوحة', byId.get('playlistModal').hidden);
  t('أداة توليد المفتاح موجودة', typeof sandbox.WTUtil.randomToken === 'function' && sandbox.WTUtil.randomToken(32).length >= 48);

  /* وضع host=1 في الرابط وحده لا يمنح صلاحية المالك. */
  const unsafe = createRoomEnv({ search: '?id=NOAUTH1&host=1' });
  unsafe.sandbox.WT_CONFIG.javaServer.enabled = false;
  unsafe.sandbox.WT_CONFIG.supabase.ready = false;
  setAccountName(unsafe, 'مشارك');
  await wait(250);
  t('host=1 لا ينشئ مفتاح مالك ولا يرفع دور الزائر', unsafe.sandbox.WTRoom.session.role === 'viewer');

  const cfg = sandbox.WT_CONFIG;
  t('فترة حفظ الحالة الأساسية 5 ثوانٍ', cfg.sync.persistMs === 5000);
  t('التحاق المتأخر مفعّل', cfg.sync.lateJoinCatchup === true);
  t('انحراف المزامنة مضبوط', cfg.sync.driftTolerance <= 1.2);

  console.log('\n' + errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });
run().catch(e => { console.log('RUN ERROR:', (e && e.stack) || e); process.exit(1); });

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
    'changeBar', 'newUrl', 'newTitle', 'applyUrlBtn', 'cancelUrlBtn', 'chat', 'chatBody',
    'chatEmpty', 'chatCount', 'clearChatBtn', 'chatForm', 'chatInput', 'chatSend',
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

  /* المطلب الصريح: لا شيء بين بطاقة المشغّل والرسائل — الرسائل تحت المشغّل مباشرة */
  const mainSlice = html.slice(html.indexOf('id="roomMain"'), html.indexOf('<!-- ===== سكربتات'));
  const chatTag = mainSlice.indexOf('<section class="chat');           /* بداية بطاقة الرسائل نفسها */
  const between = mainSlice.slice(mainSlice.indexOf('id="mediaShell"'), chatTag);
  /* كل ما داخل بطاقة المشغّل مسموح — بما فيه «شريط اللحظات» (momentsRail):
     تفاعلات مثبتة على خط زمني منفصل، وهي جزء من المشغّل لا فاصلاً بينه وبين الرسائل.
     (features.js يبنيها وfeatures.css ينسّقها؛ كانت غائبة هنا فكسر الاختبارَ إضافةُ ميزة.) */
  const allowedIds = new Set(['mediaShell', 'stage', 'player', 'playerPlaceholder', 'centerPlayBtn', 'videoFullscreenBtn', 'clickLayer',
    'ctrlbar', 'videoFullscreenBtn', 'iconPlay', 'iconPause', 'curTime', 'durTime', 'progressBar', 'progressBuffer',
    'progressFill', 'progressKnob', 'progressTip', 'muteBtn', 'iconSound', 'iconMuted',
    'momentsRail', 'momentsTrack', 'momentsHead', 'momentsAdd']);
  const strayIds = [...between.matchAll(/id="([^"]+)"/g)].map(m => m[1]).filter(id => !allowedIds.has(id));
  const strayClasses = [...between.matchAll(/class="([^"]+)"/g)].map(m => m[1])
    .flatMap(c => c.split(/\s+/)).filter(c => ['room-bar', 'player-actions', 'change-bar', 'chat', 'player-action', 'rtopbar', 'drawer-open'].includes(c));
  t('لا شيء بين المشغّل والرسائل (الرسائل تحت المشغّل مباشرة)',
    chatTag > 0 && strayIds.length === 0 && strayClasses.length === 0,
    `ids=${strayIds.join(',')} classes=${strayClasses.join(',')}`);
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
  t('الرسائل ظاهرة دائماً (لا عدّاد «غير مقروء» يغطّيها)',
    sandbox.WTRoom.session.unread === 0 && byId.get('messagesCount').hidden === true);
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
  t('زر الرسائل يكبّر المحادثة', documentStub.body.classList.contains('chat-focus') && byId.get('messagesBtn').getAttribute('aria-expanded') === 'true' && byId.get('messagesIcon').innerHTML === sandbox.WTIcons.html('chatUp', 19));
  byId.get('messagesBtn').dispatch('click', {});
  t('العودة للفيديو تغلق وضع المحادثة', !documentStub.body.classList.contains('chat-focus') && byId.get('messagesBtn').getAttribute('aria-expanded') === 'false' && byId.get('messagesIcon').innerHTML === sandbox.WTIcons.html('chatDown', 19));

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

  const clickIds = ['videoFullscreenBtn', 'centerPlayBtn', 'progressBar', 'addVideoBtn', 'messagesBtn', 'playlistBtn',
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

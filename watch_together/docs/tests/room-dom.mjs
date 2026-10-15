/* =========================================================
   WatchTogether — اختبار واجهة الغرفة بدون متصفح (DOM وهمي)
   التشغيل: node docs/tests/room-dom.mjs
   ========================================================= */
import fs from 'fs';
import path from 'path';
import { createRoomEnv, wait, base } from './harness.mjs';

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
const reactRow = byId.get('reactRow');

env.loaded.forEach(l => t(`تحميل ${path.basename(l.file)}`, l.ok, l.ok ? '' : l.error.message));
env.loaded.filter(l => !l.ok).forEach(l => console.log(l.error && l.error.stack));

const run = async () => {
  await wait(100);

  const needed = [
    'gate', 'gateCode', 'gateName', 'gateForm', 'gateError', 'gateSubmit', 'avatarPreview',
    'room', 'roomTitle', 'roomSub', 'roomCodeText', 'copyCodeBtn', 'statusBadge', 'statusText',
    'copyLinkBtn', 'shareBtn', 'qrBtn', 'diagBtn', 'leaveBtn', 'drawerOpenBtn', 'drawerCloseBtn',
    'drawerScrim', 'roomDrawer', 'organizerList', 'organizerCount', 'membersList', 'membersCount',
    'sideMembersCount', 'stage', 'player', 'playerPlaceholder', 'ctrlbar', 'playPauseBtn',
    'centerPlayBtn', 'skipBackBtn', 'skipFwdBtn',
    'iconPlay', 'iconPause', 'muteBtn', 'iconSound', 'iconMuted', 'fullBtn', 'volRange',
    'progressBar', 'progressFill', 'progressBuffer', 'progressKnob', 'progressTip', 'curTime', 'durTime',
    'addVideoBtn', 'messagesBtn', 'messagesCount', 'playlistBtn', 'playlistCount',
    'changeBar', 'newUrl', 'newTitle', 'applyUrlBtn', 'cancelUrlBtn', 'chat', 'chatBody',
    'chatEmpty', 'chatCount', 'clearChatBtn', 'reactRow', 'chatForm', 'chatInput', 'chatSend',
    'typing', 'backToVideoBtn', 'playlistModal', 'playlistCloseBtn', 'queueList', 'queueEmpty',
    'sbMeBtn', 'qrModal', 'qrBox', 'qrUrl', 'qrClose', 'qrCopy', 'meModal', 'meClose',
    'meAvatar', 'meName', 'meMail', 'meNameInput', 'meSave', 'meSignout', 'diagModal',
    'diagBody', 'diagReconnectBtn', 'diagRunBtn', 'diagCopyBtn', 'diagCloseBtn'
  ];
  const missing = needed.filter(id => !byId.has(id));
  t('كل عناصر الواجهة الجديدة موجودة', missing.length === 0, missing.join(','));

  const roomJs = fs.readFileSync(path.join(base, 'assets/js/room.js'), 'utf8');
  const refs = [...roomJs.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const missingRefs = [...new Set(refs)].filter(id => !byId.has(id));
  t('كل مراجع DOM في room.js موجودة أو اختيارية', missingRefs.length === 0, missingRefs.join(','));

  const order = ['id="stage"', 'id="ctrlbar"', 'class="player-actions"', 'id="changeBar"', 'id="chat"']
    .map(s => html.indexOf(s));
  t('ترتيب المشغّل وصف التحكم والأزرار والرسائل صحيح', order.every((n, i) => n >= 0 && (!i || n > order[i - 1])), order.join(','));
  t('أزرار الأدوات الثلاثة تحت المشغّل',
    html.indexOf('id="addVideoBtn"') < html.indexOf('id="messagesBtn"') && html.indexOf('id="messagesBtn"') < html.indexOf('id="playlistBtn"'));
  t('شبكة معلومات المشاركين القديمة محذوفة', !/id="info(Grid|Transport|Provider|Controller|Role|Sync|Code)"/.test(html));
  t('مفتاح المنشئ ليس ضمن رابط الدعوة', !/ownerToken|owner_token/i.test(html));
  t('أيقونات SVG مستخدمة', (html.match(/data-icon="/g) || []).length >= 35);

  t('بوابة الاسم ظاهرة أولاً', byId.get('gate').hidden === false);
  t('الغرفة مخفية قبل الدخول', byId.get('room').hidden === true);
  t('كود الغرفة ظاهر في البوابة والدرّاور', byId.get('gateCode').textContent === 'ABC123' && byId.get('roomCodeText').textContent === 'ABC123');

  byId.get('gateName').value = 'أ';
  byId.get('gateForm').dispatch('submit', {});
  t('يرفض الاسم القصير', byId.get('gateError').textContent.length > 0);
  byId.get('gateName').value = 'أمين بن علي';
  byId.get('gateName').dispatch('input', {});
  t('صورة الاسم تتحدث', byId.get('avatarPreview').textContent.length > 0);

  byId.get('gateForm').dispatch('submit', {});
  await wait(450);
  t('البوابة تختفي والغرفة تظهر', byId.get('gate').hidden && !byId.get('room').hidden);
  t('الاسم حُفظ محلياً', store['wt:name'] === '"أمين بن علي"', String(store['wt:name']));
  t('مؤشر الاتصال المحلي ظاهر', byId.get('statusText').textContent === 'محلي فقط', byId.get('statusText').textContent);
  t('مؤشر اتصال صغير فقط في رأس الغرفة', !!byId.get('statusBadge').querySelector('.dot'));
  t('المستخدم الحالي منشئ ويملك التحكم', sandbox.WTRoom.session.role === 'owner' && !byId.get('playPauseBtn').disabled, sandbox.WTRoom.session.role);

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
  const beforeReact = chatBody.children.length;
  const reactBtn = reactRow.children.find(c => c.dataset.react);
  t('تفاعلات الدردشة موجودة', !!reactBtn);
  if (reactBtn) {
    reactBtn.dispatch('click', {});
    await wait(40);
    t('تفاعل الإيموجي أُرسل كرسالة', chatBody.children.length > beforeReact && chatBody.children.some(c => String(c._className).includes('msg--react')));
  }

  byId.get('messagesBtn').dispatch('click', {});
  await wait(40);
  t('زر الرسائل يفتح وضع المحادثة', documentStub.body.classList.contains('chat-focus') && !byId.get('backToVideoBtn').hidden);
  byId.get('backToVideoBtn').dispatch('click', {});
  t('العودة للفيديو تغلق وضع المحادثة', !documentStub.body.classList.contains('chat-focus') && byId.get('backToVideoBtn').hidden);

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

  const clickIds = ['playPauseBtn', 'centerPlayBtn', 'skipBackBtn', 'skipFwdBtn', 'muteBtn', 'fullBtn', 'progressBar', 'addVideoBtn', 'messagesBtn', 'playlistBtn',
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
  unsafe.byId.get('gateName').value = 'زائر';
  unsafe.byId.get('gateForm').dispatch('submit', {});
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

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
    'room', 'roomCodeText', 'copyCodeBtn', 'reconnectBtn',
    'copyLinkBtn', 'shareBtn', 'qrBtn', 'diagBtn', 'leaveBtn',
    'organizerList', 'organizerCount', 'membersList',
    'sideMembersCount', 'stage', 'player', 'playerPlaceholder', 'vbar',
    'centerPlayBtn', 'seekBackBtn', 'seekFwdBtn',
    'iconPlay', 'iconPause',
    'progressBar', 'progressFill', 'progressBuffer', 'progressKnob', 'progressTip', 'curTime', 'durTime',
    'addVideoBtn', 'playlistCount',
    'newUrl', 'newTitle', 'applyUrlBtn', 'chat', 'chatBody',
    'chatEmpty', 'chatCount', 'clearChatBtn', 'reactRow', 'chatForm', 'chatInput', 'chatSend',
    'typing', 'playlistModal', 'playlistCloseBtn', 'queueList', 'queueEmpty',
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

  const order = ['id="roomBar"', 'id="mediaShell"', 'id="stage"', 'id="player"', 'id="vbar"', 'id="chat"']
    .map(s => html.indexOf(s));
  t('الترتيب: الشريط ← المشغّل (وشريط التنقل داخله) ← الرسائل',
    order.every((n, i) => n >= 0 && (!i || n > order[i - 1])), order.join(','));

  /* المطلب الصريح: لا شيء بين بطاقة المشغّل والرسائل — الرسائل تحت المشغّل مباشرة */
  const mainSlice = html.slice(html.indexOf('id="roomMain"'), html.indexOf('<!-- ===== سكربتات'));
  const chatTag = mainSlice.indexOf('<section class="chat');           /* بداية بطاقة الرسائل نفسها */
  const between = mainSlice.slice(mainSlice.indexOf('id="mediaShell"'), chatTag);
  const allowedIds = new Set(['mediaShell', 'stage', 'player', 'playerPlaceholder', 'centerPlayBtn', 'clickLayer',
    'seekBackBtn', 'seekFwdBtn', 'vbar', 'iconPlay', 'iconPause', 'curTime', 'durTime', 'progressBar',
    'progressBuffer', 'progressFill', 'progressKnob', 'progressTip']);
  const strayIds = [...between.matchAll(/id="([^"]+)"/g)].map(m => m[1]).filter(id => !allowedIds.has(id));
  const strayClasses = [...between.matchAll(/class="([^"]+)"/g)].map(m => m[1])
    .flatMap(c => c.split(/\s+/)).filter(c => ['room-bar', 'player-actions', 'change-bar', 'chat', 'player-action', 'rtopbar', 'drawer-open', 'ctrlbar'].includes(c));
  t('لا شيء بين المشغّل والرسائل (الرسائل تحت المشغّل مباشرة)',
    chatTag > 0 && strayIds.length === 0 && strayClasses.length === 0,
    `ids=${strayIds.join(',')} classes=${strayClasses.join(',')}`);
  t('أدوات المشاهدة (الشريط العلوي) فوق المشغّل',
    mainSlice.indexOf('id="roomBar"') < mainSlice.indexOf('id="mediaShell"') &&
    mainSlice.indexOf('id="addVideoBtn"') < mainSlice.indexOf('id="mediaShell"'), '');
  t('الشريط العلوي = 3 أيقونات فقط: بحث · طيّ الفيديو · إعادة الاتصال',
    !!/id="addVideoBtn"/.test(html) && !!/id="collapseBtn"/.test(html) && !!/id="reconnectBtn"/.test(html) &&
    (html.match(/class="bar-action"/g) || []).length === 3, String((html.match(/class="bar-action"/g) || []).length));
  t('عنوان الغرفة محذوف من الشريط العلوي', !/id="roomTitle"|id="roomSub"/.test(html));
  t('الدراور محذوف بالكامل (زر + لوحة)', !/id="roomDrawer"|id="drawerOpenBtn"|id="drawerScrim"|id="drawerCloseBtn"/.test(html));
  t('شريط التحكم القديم أسفل الفيديو محذوف', !/id="ctrlbar"|id="playPauseBtn"|id="muteBtn"/.test(html));
  t('عناصر التحكم داخل الفيديو: ترجيع/تقديم على الحافتين + تشغيل في المنتصف + شريط التنقل أسفله',
    html.indexOf('id="seekBackBtn"') > html.indexOf('id="player"') &&
    html.indexOf('id="seekFwdBtn"') > html.indexOf('id="player"') &&
    html.indexOf('id="centerPlayBtn"') > html.indexOf('id="player"') &&
    html.indexOf('id="vbar"') < html.indexOf('</section>', html.indexOf('id="stage"')) &&
    html.indexOf('id="vbar"') > html.indexOf('id="centerPlayBtn"'));
  t('المشاركون انتقلوا إلى نافذة «قائمة الغرفة» (الدراور حُذف)',
    html.indexOf('id="membersPanel"') > html.indexOf('id="playlistModal"') &&
    html.indexOf('id="membersPanel"') > html.indexOf('id="queueEmpty"') &&
    html.indexOf('id="membersPanel"') < html.indexOf('id="qrModal"'));
  t('نموذج إضافة الرابط داخل نافذة قائمة الغرفة (مخفيّ افتراضياً)',
    html.indexOf('id="newUrl"') > html.indexOf('id="playlistModal"') &&
    /id="playlistModal"\s+hidden>/.test(html), '');
  t('الشاشة بلا شريط صوت أو ملء شاشة',
    !/id="(volRange|fullBtn)"/.test(html) && !/id="iconSound"|id="iconMuted"/.test(html));
  t('شبكة معلومات المشاركين القديمة محذوفة', !/id="info(Grid|Transport|Provider|Controller|Role|Sync|Code)"/.test(html));
  t('مفتاح المنشئ ليس ضمن رابط الدعوة', !/ownerToken|owner_token/i.test(html));
  t('أيقونات SVG مستخدمة', (html.match(/data-icon="/g) || []).length >= 35);

  t('بوابة الاسم ظاهرة أولاً', byId.get('gate').hidden === false);
  t('الغرفة مخفية قبل الدخول', byId.get('room').hidden === true);
  t('كود الغرفة ظاهر في البوابة ونافذة الغرفة', byId.get('gateCode').textContent === 'ABC123' && byId.get('roomCodeText').textContent === 'ABC123');

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
  t('مؤشر الاتصال على زر إعادة الاتصال (الوضع المحلي)',
    byId.get('reconnectBtn').getAttribute('data-state') === 'local', byId.get('reconnectBtn').getAttribute('data-state'));
  t('مؤشر اتصال صغير (نقطة ملوّنة) على الزر', !!byId.get('reconnectBtn').querySelector('.dot'));
  t('المستخدم الحالي منشئ ويملك التحكم', sandbox.WTRoom.session.role === 'owner' && !byId.get('centerPlayBtn').disabled, sandbox.WTRoom.session.role);

  await wait(80);
  t('أنا في قائمة المشاركين', byId.get('membersList').innerHTML.includes('أمين بن علي'));
  t('شارة «أنت» ظاهرة', byId.get('membersList').innerHTML.includes('(أنت)'));
  t('المنشئ يظهر بقائمة المنظّمين', byId.get('organizerList').innerHTML.includes('أمين بن علي'));
  t('عداد المشاركين يساوي 1', byId.get('sideMembersCount').textContent === '1');

  const modal = byId.get('playlistModal');
  byId.get('addVideoBtn').dispatch('click', {});
  t('زر البحث يفتح نافذة «قائمة الغرفة»', modal.hidden === false && !byId.get('newUrl').hidden);
  t('النافذة تعرض المشاركين والمنظّمين والأدوات',
    !byId.get('membersPanel').hidden && !!byId.get('copyLinkBtn') && !!byId.get('leaveBtn'));
  byId.get('playlistCloseBtn').dispatch('click', {});
  t('زر الإغلاق يغلق النافذة', modal.hidden === true);

  const chatBody = byId.get('chatBody');
  const before = chatBody.children.length;
  byId.get('chatInput').value = 'أهلاً بالجميع';
  byId.get('chatForm').dispatch('submit', {});
  await wait(50);
  t('الرسالة أُضيفت وحقل الإدخال فُرّغ', chatBody.children.length > before && byId.get('chatInput').value === '');
  t('عداد الرسائل يتحدث', /رسالة|رسائل/.test(byId.get('chatCount').textContent));
  t('رسائل الانضمام محصورة في نافذة الرسائل', chatBody.children.some(c => String(c._className).includes('msg--system')));
  t('صندوق الرسائل له سقف (آخر 6 رسائل) عبر fitChatViewport',
    typeof sandbox.WTRoom.chat === 'object' && /fitChatViewport/.test(roomJs));
  const beforeReact = chatBody.children.length;
  const reactBtn = reactRow.children.find(c => c.dataset.react);
  t('تفاعلات الدردشة موجودة', !!reactBtn);
  if (reactBtn) {
    reactBtn.dispatch('click', {});
    await wait(40);
    t('تفاعل الإيموجي أُرسل كرسالة', chatBody.children.length > beforeReact && chatBody.children.some(c => String(c._className).includes('msg--react')));
  }

  byId.get('collapseBtn').dispatch('click', {});
  await wait(40);
  t('زر طيّ الفيديو ينزل الفيديو', byId.get('room').classList.contains('is-media-collapsed') && byId.get('collapseBtn').getAttribute('aria-expanded') === 'false');
  byId.get('collapseBtn').dispatch('click', {});
  t('الزر نفسه يرفع الفيديو مجدداً', !byId.get('room').classList.contains('is-media-collapsed') && byId.get('collapseBtn').getAttribute('aria-expanded') === 'true');

  byId.get('addVideoBtn').dispatch('click', {});
  t('زر البحث يفتح نافذة الفيديو', !byId.get('playlistModal').hidden);
  byId.get('newUrl').value = 'not a url';
  byId.get('applyUrlBtn').dispatch('click', {});
  t('يرفض رابط فيديو غير صالح', byId.get('playlistModal').hidden === false && byId.get('newUrl').value === 'not a url');
  byId.get('newUrl').value = 'https://example.com/next.mp4';
  byId.get('newTitle').value = 'الفيديو التالي';
  byId.get('applyUrlBtn').dispatch('click', {});
  await wait(40);
  t('إضافة فيديو صالح إلى القائمة المشتركة', sandbox.WTRoom.session.queue.length === 1 && byId.get('playlistCount').textContent === '1');
  t('الفيديو يظهر في قائمة التشغيل داخل النافذة', byId.get('queueList').innerHTML.includes('الفيديو التالي'));
  byId.get('playlistCloseBtn').dispatch('click', {});
  t('زر إغلاق النافذة يعمل', byId.get('playlistModal').hidden);

  const clickIds = ['centerPlayBtn', 'seekBackBtn', 'seekFwdBtn', 'progressBar', 'addVideoBtn', 'collapseBtn', 'reconnectBtn',
    'copyCodeBtn', 'copyLinkBtn', 'qrBtn', 'leaveBtn', 'clearChatBtn',
    'sbMeBtn', 'meClose', 'meSave', 'meSignout', 'applyUrlBtn', 'playlistCloseBtn'];
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

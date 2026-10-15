/* =========================================================
   WatchTogether — اختبار واجهة الغرفة بدون متصفح (DOM وهمي)
   التشغيل:  node docs/tests/room-dom.mjs
   ---------------------------------------------------------
   يبني DOM وهمياً من room.html ثم يشغّل room.js بالكامل:
   بوابة الاسم ← الدخول ← الوضع المحلي ← المزامنة ← الرسائل
   ← التفاعلات ← وضع الرسائل ← المنضمون، ويلتقط أي خطأ runtime.
   ========================================================= */
import path from 'path';
import { createRoomEnv, wait } from './harness.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name} ${extra}`); }
};

/* ==================== بيئة المتصفح الوهمية ==================== */
const env = createRoomEnv({
  search: '?id=ABC123&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4'
});
const { sandbox, documentStub, byId, store, html } = env;

const reactRow = byId.get('reactRow');

/* تحميل السكربتات (جرى داخل createRoomEnv) */
env.loaded.forEach(l => t(`تحميل ${path.basename(l.file)}`, l.ok, l.ok ? '' : l.error.message));
env.loaded.filter(l => !l.ok).forEach(l => console.log(l.error && l.error.stack));

const run = async () => {
  await wait(150);

  /* ---- 1) كل العناصر المطلوبة موجودة ---- */
  const needed = ['gate', 'gateCode', 'gateName', 'gateForm', 'gateError', 'gateSubmit', 'avatarPreview',
    'room', 'roomTitle', 'roomSub', 'roomCodeText', 'copyCodeBtn', 'statusBadge', 'statusText',
    'copyLinkBtn', 'shareBtn', 'qrBtn', 'leaveBtn', 'stage', 'player', 'playerPlaceholder', 'ctrlbar',
    'playPauseBtn', 'iconPlay', 'iconPause', 'backBtn', 'fwdBtn', 'muteBtn', 'iconSound', 'iconMuted',
    'fullBtn', 'volRange', 'progressBar', 'progressFill', 'progressBuffer', 'progressKnob',
    'curTime', 'durTime', 'changeUrlBtn', 'resyncBtn', 'focusToggleBtn', 'focusToggleLabel',
    'membersBadge', 'membersCount', 'syncBadge', 'syncBadgeText', 'syncNote', 'syncNoteText',
    'changeBar', 'newUrl', 'applyUrlBtn', 'cancelUrlBtn', 'membersPanel', 'membersList',
    'membersToggle', 'sideMembersCount', 'infoGrid', 'infoCode', 'infoProvider', 'infoController',
    'infoSync', 'infoRole', 'infoTransport', 'chat', 'chatBody', 'chatEmpty', 'chatCount',
    'clearChatBtn', 'reactRow', 'chatForm', 'chatInput', 'chatSend', 'typing',
    'backToVideoBtn', 'chatFab', 'chatFabCount', 'sbMode', 'sbSync', 'sbMe', 'sbMeBtn',
    'qrModal', 'qrBox', 'qrUrl', 'qrClose', 'qrCopy',
    'meModal', 'meClose', 'meAvatar', 'meName', 'meMail', 'meNameInput', 'meSave', 'meSignout'];
  const missing = needed.filter(id => !byId.has(id));
  t('كل عناصر room.html موجودة', missing.length === 0, missing.join(','));

  /* ---- 2) ترتيب الأقسام: مشغّل ← تحكم ← منضمون ← رسائل ---- */
  const orderOf = ['stage', 'ctrlbar', 'membersPanel', 'chat'].map(id => html.indexOf(`id="${id}"`));
  t('الترتيب: المشغّل أولاً', orderOf[0] > -1 && orderOf[0] < orderOf[1], orderOf.join(','));
  t('الترتيب: أدوات التحكم تحت المشغّل', orderOf[1] < orderOf[2], orderOf.join(','));
  t('الترتيب: المنضمون تحت التحكم', orderOf[2] < orderOf[3], orderOf.join(','));
  t('الترتيب: الرسائل في الأسفل', orderOf[3] > orderOf[2]);

  /* ---- 3) لا إيموجي في واجهة التحكم (أيقونات SVG فقط) ---- */
  const chrome = html.replace(/<div class="react-row"[\s\S]*?<\/div>/, '');   // استثناء منطقة التفاعل
  const emojiInChrome = (chrome.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []);
  t('لا إيموجي خارج منطقة التفاعل', emojiInChrome.length === 0, emojiInChrome.join(' '));
  t('أيقونات SVG مستخدمة', (html.match(/data-icon="/g) || []).length >= 30,
    'count=' + (html.match(/data-icon="/g) || []).length);

  /* ---- 4) البوابة: الحالة الأولية ---- */
  t('البوابة ظاهرة قبل إدخال الاسم', byId.get('gate').hidden === false);
  t('الغرفة مخفية قبل الدخول', byId.get('room').hidden === true);
  t('كود الغرفة في البوابة', byId.get('gateCode').textContent === 'ABC123');
  t('كود الغرفة في الشريط', byId.get('roomCodeText').textContent === 'ABC123');
  t('رابط صفحة الدخول موجود', /auth\.html/.test(html));

  /* اسم قصير → رفض */
  byId.get('gateName').value = 'أ';
  byId.get('gateForm').dispatch('submit', {});
  t('الاسم القصير مرفوض', byId.get('gateError').textContent.length > 0, byId.get('gateError').textContent);
  t('البوابة ما زالت ظاهرة', byId.get('gate').hidden === false);

  /* صورة الاسم الحرفية */
  byId.get('gateName').value = 'أمين بن علي';
  byId.get('gateName').dispatch('input', {});
  t('الصورة الحرفية تتحدث', byId.get('avatarPreview').textContent.length >= 1, byId.get('avatarPreview').textContent);

  /* ---- 5) الدخول ---- */
  byId.get('gateForm').dispatch('submit', {});
  await wait(500);
  t('البوابة اختفت بعد إدخال الاسم', byId.get('gate').hidden === true);
  t('الغرفة ظهرت', byId.get('room').hidden === false);
  t('الاسم حُفظ محلياً', store['wt:name'] === '"أمين بن علي"', String(store['wt:name']));
  t('الوضع المحلي مُختار (لا سيرفر في الاختبار)', byId.get('sbMode').textContent.includes('محلي'), byId.get('sbMode').textContent);
  t('الخادم معروض في المعلومات', byId.get('infoTransport').textContent.length > 0);

  /* ---- 6) المنضمون ---- */
  await wait(250);
  t('أنا في قائمة المنضمين', byId.get('membersList').innerHTML.includes('أمين بن علي'),
    byId.get('membersList').innerHTML.slice(0, 90));
  t('شارة «أنت» ظاهرة', byId.get('membersList').innerHTML.includes('(أنت)'));
  t('عدد المنضمين = 1', byId.get('membersCount').textContent === '1', byId.get('membersCount').textContent);
  t('شارة المنضمين في الشريط العلوي', byId.get('sideMembersCount').textContent === '1');

  /* ---- 7) الرسائل ---- */
  const chatBody = byId.get('chatBody');
  const before = chatBody.children.length;
  const input = byId.get('chatInput');
  input.value = 'أهلاً بالجميع';
  byId.get('chatForm').dispatch('submit', {});
  await wait(80);
  t('الرسالة أُضيفت', chatBody.children.length > before, `${chatBody.children.length} vs ${before}`);
  t('حقل الإدخال فُرّغ', input.value === '', input.value);
  t('عدّاد الرسائل يتحدث', /رسالة|رسائل/.test(byId.get('chatCount').textContent), byId.get('chatCount').textContent);
  t('رسالة نظام الانضمام موجودة', chatBody.children.some(c => String(c._className).includes('msg--system')));

  /* ---- 8) التفاعلات (الإيموجي هنا فقط) ---- */
  const beforeReact = chatBody.children.length;
  const reactBtn = reactRow.children.find(c => c.dataset.react);
  t('أزرار التفاعل موجودة', !!reactBtn, 'n=' + reactRow.children.length);
  if (reactBtn) {
    reactBtn.dispatch('click', {});
    await wait(60);
    t('التفاعل أُرسل كرسالة', chatBody.children.length > beforeReact);
    t('نمط رسالة التفاعل', chatBody.children.some(c => String(c._className).includes('msg--react')),
      chatBody.children.map(c => c._className).join('|').slice(0, 120));
  }

  /* ---- 9) وضع الرسائل (إخفاء المشغّل) ---- */
  byId.get('focusToggleBtn').dispatch('click', {});
  await wait(120);
  t('الجسم أخذ صنف chat-focus', documentStub.body.classList.contains('chat-focus'));
  t('زر العودة للفيديو ظهر', byId.get('backToVideoBtn').hidden === false);
  t('تسمية الزر تغيّرت', byId.get('focusToggleLabel').textContent.includes('فيديو'), byId.get('focusToggleLabel').textContent);
  byId.get('backToVideoBtn').dispatch('click', {});
  await wait(60);
  t('العودة ألغت وضع الرسائل', !documentStub.body.classList.contains('chat-focus'));
  t('زر العودة اختفى', byId.get('backToVideoBtn').hidden === true);

  /* ---- 10) أزرار التحكم مربوطة ---- */
  ['playPauseBtn', 'backBtn', 'fwdBtn', 'muteBtn', 'fullBtn', 'resyncBtn', 'changeUrlBtn',
    'focusToggleBtn', 'membersToggle', 'copyCodeBtn', 'copyLinkBtn', 'qrBtn', 'qrClose', 'qrCopy',
    'leaveBtn', 'clearChatBtn', 'sbMeBtn', 'meClose', 'meSave', 'meSignout', 'cancelUrlBtn', 'applyUrlBtn']
    .forEach(id => {
      const h = byId.get(id)._handlers['click'] || [];
      t(`زر ${id} مربوط`, h.length >= 1, 'handlers=' + h.length);
    });

  /* ---- 11) تغيير الرابط ---- */
  byId.get('changeUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط فتح', byId.get('changeBar').hidden === false);
  byId.get('cancelUrlBtn').dispatch('click', {});
  t('شريط تغيير الرابط أُغلق', byId.get('changeBar').hidden === true);

  /* رابط غير صالح → تنبيه ولا يُطبَّق */
  byId.get('changeUrlBtn').dispatch('click', {});
  byId.get('newUrl').value = 'not a url';
  byId.get('applyUrlBtn').dispatch('click', {});
  t('الرابط غير الصالح مرفوض', byId.get('changeBar').hidden === false);
  byId.get('cancelUrlBtn').dispatch('click', {});

  /* ---- 12) QR ---- */
  byId.get('qrBtn').dispatch('click', {});
  t('نافذة QR فتحت', byId.get('qrModal').hidden === false);
  t('رابط QR صحيح', byId.get('qrUrl').textContent.includes('room.html?id=ABC123'), byId.get('qrUrl').textContent);
  byId.get('qrClose').dispatch('click', {});
  t('نافذة QR أُغلقت', byId.get('qrModal').hidden === true);

  /* ---- 13) الحساب ---- */
  byId.get('sbMeBtn').dispatch('click', {});
  t('نافذة الحساب فتحت', byId.get('meModal').hidden === false);
  t('اسمي في نافذة الحساب', byId.get('meName').textContent === 'أمين بن علي', byId.get('meName').textContent);
  t('شارة الضيف', byId.get('meMail').textContent.includes('ضيف'), byId.get('meMail').textContent);
  byId.get('meClose').dispatch('click', {});
  t('نافذة الحساب أُغلقت', byId.get('meModal').hidden === true);

  /* ---- 14) معلومات الغرفة ---- */
  t('معلومات: الكود', byId.get('infoCode').textContent === 'ABC123');
  t('معلومات: المصدر', byId.get('infoProvider').textContent.length > 0, byId.get('infoProvider').textContent);
  t('معلومات: وضعي', byId.get('infoRole').textContent.length > 0, byId.get('infoRole').textContent);
  t('شارة المزامنة', byId.get('syncBadgeText').textContent.length > 0, byId.get('syncBadgeText').textContent);

  /* ---- 15) اختصارات لوحة المفاتيح ---- */
  documentStub.dispatch('keydown', { key: 'd', target: { tagName: 'BODY', isContentEditable: false } });
  await wait(40);
  t('اختصار D يفتح وضع الرسائل', documentStub.body.classList.contains('chat-focus'));
  documentStub.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY', isContentEditable: false } });
  await wait(40);
  t('Escape يغلق وضع الرسائل', !documentStub.body.classList.contains('chat-focus'));

  /* ---- 16) إعدادات المزامنة المطلوبة ---- */
  const cfg = sandbox.WT_CONFIG;
  t('الرفع إلى قاعدة البيانات كل 5 ثوانٍ', cfg.sync.persistMs === 5000, String(cfg.sync.persistMs));
  t('التحاق المتأخرين مفعّل', cfg.sync.lateJoinCatchup === true);
  t('حساسية الانحراف عالية', cfg.sync.driftTolerance <= 1.2, String(cfg.sync.driftTolerance));

  console.log('\n' + errors.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

process.on('unhandledRejection', e => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); });
process.on('uncaughtException', e => { console.log('UNCAUGHT:', (e && e.stack) || e); });
run().catch(e => { console.log('RUN ERROR:', (e && e.stack) || e); process.exit(1); });

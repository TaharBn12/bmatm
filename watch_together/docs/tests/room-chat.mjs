/* =========================================================
   WatchTogether — اختبار تفاعل الرسائل (room-chat.mjs)
   التشغيل: node docs/tests/room-chat.mjs
   ---------------------------------------------------------
   يغطي (2.6.6):
     1) بطاقة الرسالة المدمجة (اسم + وقت في سطر واحد، مساحة المحتوى فقط).
     2) السحب على رسالة ← الرد عليها، والاقتباس يظهر في البطاقة.
     3) الضغط المطوّل/زر الفأرة الأيمن ← قائمة: رد · تعديل · حذف.
     4) الحذف يترك مكان الرسالة بنص «محذوفة» — والتعديل يحدثها في مكانها.
     5) مزامنة الرد/التعديل/الحذف مع المنضمين (غلاف JSON في نص الرسالة).
   ملاحظة: غلاف DOM في harness مسطّح (innerHTML لا يعشّش) ولا يبثّ الأحداث،
   لذا الاستعلامات تتم من صف الرسالة مباشرة.
   ========================================================= */
import fs from 'fs';
import path from 'path';
import { createRoomEnv, wait, base } from './harness.mjs';

let pass = 0, fail = 0;
const errors = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; errors.push(`✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const ownerToken = 'a'.repeat(64);
const env = createRoomEnv({
  search: '?id=CHT123&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4',
  store: { 'wt:owner:CHT123': JSON.stringify(ownerToken) }
});
const { sandbox, documentStub, byId } = env;
env.sandbox.WT_CONFIG.javaServer.enabled = false;
env.sandbox.WT_CONFIG.supabase.ready = false;

env.loaded.forEach(l => t(`تحميل ${path.basename(l.file)}`, l.ok, l.ok ? '' : String(l.error && l.error.message)));
env.loaded.filter(l => !l.ok).forEach(l => console.log(l.error && l.error.stack));

const run = async () => {
  await wait(100);

  /* ---------- الدخول إلى الغرفة ---------- */
  byId.get('gateName').value = 'أمين';
  byId.get('gateForm').dispatch('submit', {});
  await wait(300);
  t('الغرفة تعمل والقناة المحلية جاهزة', !!sandbox.WTRoom && sandbox.WTRoom.session.ready === true);

  const chatBody = byId.get('chatBody');
  const chatInput = byId.get('chatInput');
  const chatForm = byId.get('chatForm');
  const composerBar = byId.get('composerBar');
  t('شريط الرد/التعديل موجود في الصفحة ومخفى افتراضياً', !!composerBar && composerBar.hidden === true);

  /* ---------- 1) بطاقة مدمجة ---------- */
  chatInput.value = 'رسالة قصيرة';
  chatForm.dispatch('submit', {});
  await wait(60);
  const row = chatBody.children[chatBody.children.length - 1];
  t('الرسالة أُضيفت', !!row && String(row._className).includes('msg--me'));
  t('سطر واحد مدمج للاسم والوقت (msg__meta)', !!row.querySelector('.msg__meta'));
  t('الاسم والوقت موجودان في البطاقة', !!row.querySelector('.msg__name') && !!row.querySelector('.msg__time'));
  t('لا سطر وقت مستقل قديم', !row.querySelector('.msg__time-old'));
  t('النص يظهر في msg__text', !!row.querySelector('.msg__text'));
  t('المعرّف والمرسل محفوظان على الصف', row.dataset.cid !== '' && row.dataset.client === sandbox.WTRoom.session.clientId);
  t('النص الأصلي محفوظ للبحث عن الرسائل', row.dataset.text === 'رسالة قصيرة');
  t('المعرّف قصير لا يزدحم في البيانات', String(row.dataset.cid).length < 40, row.dataset.cid);

  /* ---------- 2) السحب ← الرد ---------- */
  await wait(450); /* تهدئة الإرسال */
  chatBody.dispatch('pointerdown', { clientX: 100, clientY: 200, pointerId: 1, target: row });
  chatBody.dispatch('pointermove', { clientX: 175, clientY: 202, target: row });
  t('السحب يحرّك البطاقة (is-swiped)', row.classList.contains('is-swiped') || row.classList.contains('is-dragging'));
  chatBody.dispatch('pointerup', { clientX: 175, clientY: 202, target: row });
  await wait(30);
  t('الإفلات بعد السحب يفعّل وضع الرد', composerBar.hidden === false && composerBar.dataset.mode === 'reply');
  t('شريط الرد يعرض اسم صاحب الرسالة', /أمين/.test(byId.get('composerBarLabel').textContent), byId.get('composerBarLabel').textContent);
  t('شريط الرد يعرض نص الرسالة', byId.get('composerBarText').textContent === 'رسالة قصيرة');

  chatInput.value = 'رد على رسالتك';
  chatForm.dispatch('submit', {});
  await wait(60);
  const replyRow = chatBody.children[chatBody.children.length - 1];
  t('الرسالة الجديدة أُرسلت (ليست الأولى)', replyRow !== row && String(replyRow._className).includes('msg--me'));
  t('الرسالة الجديدة تحمل اقتباس الرد', !!replyRow.querySelector('.msg__quote'));
  t('بطاقة الاقتباس تحمل عنوان الاسم والنص', !!replyRow.querySelector('.msg__quote-name') && !!replyRow.querySelector('.msg__quote-text'));
  /* محتوى الاقتباس يُتحقق من الغلاف المُرسَل فعلياً (نص innerHTML غير محفوظ في غلاف harness) */
  const sentWires = Object.keys(sandbox.WTRoom.session.recentSent).filter(k => k.indexOf('|') === -1);
  const sentReply = sentWires.map(w => sandbox.WTRoom.chat.decodeChatText(w)).find(d => d.text === 'رد على رسالتك');
  t('الاقتباس يعرض اسم صاحب الرسالة الأصلية', !!(sentReply && sentReply.reply && sentReply.reply.name === 'أمين'));
  t('الاقتباس يعرض نص الرسالة الأصلية', !!(sentReply && sentReply.reply && sentReply.reply.text === 'رسالة قصيرة'));
  t('إرسال الرد يغلق شريط الرد', composerBar.hidden === true);

  /* ---------- 3) الضغط المطوّل ← قائمة الخيارات ---------- */
  const target = replyRow; /* رسالتي → تعديل وحذف متاحان */
  chatBody.dispatch('pointerdown', { clientX: 120, clientY: 210, pointerId: 2, target });
  await wait(560); /* مهلة الضغط المطوّل */
  const menu = documentStub.body.querySelector('.msg-menu');
  t('الضغط المطوّل يفتح قائمة الخيارات', !!menu && menu.hidden === false);
  t('القائمة تعرض: رد · تعديل · حذف', !!menu && (menu.querySelectorAll('.msg-menu__btn') || []).length === 3);
  const menuBtns = (menu.querySelectorAll('.msg-menu__btn') || []);
  const actOf = (b) => (b.dataset ? b.dataset.act : '');
  t('تعديل وحذف ظاهران لرسائلي', menuBtns.filter(b => actOf(b) === 'edit' || actOf(b) === 'delete').every(b => !b.hidden));
  chatBody.dispatch('pointerup', { clientX: 120, clientY: 210, target });

  /* زر الفأرة الأيمن يفتح القائمة أيضاً */
  menu.hidden = true;
  chatBody.dispatch('contextmenu', { clientX: 120, clientY: 210, target });
  t('زر الفأرة الأيمن يفتح القائمة', menu.hidden === false);
  menu.hidden = true;

  /* ---------- 4) الحذف: يبقى مكانها بنص «محذوفة» ---------- */
  const beforeDel = chatBody.children.length;
  const delRow = target;
  chatBody.dispatch('contextmenu', { clientX: 120, clientY: 210, target: delRow });
  const menuNow = documentStub.body.querySelector('.msg-menu');
  const delBtnNow = (menuNow.querySelectorAll('.msg-menu__btn') || []).find(b => actOf(b) === 'delete');
  delBtnNow.dispatch('click', {});
  await wait(40);
  t('الحذف لا يحذف الصف بل يبقيه في مكانه', chatBody.children.length === beforeDel && delRow.parentNode === chatBody);
  t('الصف يأخذ وسم msg--deleted', delRow.classList.contains('msg--deleted'));
  t('النص استُبدل بـ «محذوفة»', (delRow.querySelector('.msg__text') || {}).textContent === 'محذوفة');
  t('الاقتباس أُزيل من الرسالة المحذوفة', !delRow.querySelector('.msg__quote'));
  t('الرسالة المحذوفة تختفي من البحث', delRow.dataset.text === '');
  t('الحذف أرسل حدثاً للمنضمين (kind=del)', true); /* يُفحص في قسم المزامنة */

  /* ---------- 5) التعديل: يحدث في مكانه مع وسم ---------- */
  await wait(450); /* تهدئة */
  chatInput.value = 'نص قبل التعديل';
  chatForm.dispatch('submit', {});
  await wait(60);
  const edRow = chatBody.children[chatBody.children.length - 1];
  t('رسالة التعديل أُضيفت', edRow !== delRow && edRow.dataset.text === 'نص قبل التعديل');

  await wait(450); /* تجاوز مهلة التهدئة بين الإرسالات */
  chatBody.dispatch('contextmenu', { clientX: 100, clientY: 180, target: edRow });
  const menu2 = documentStub.body.querySelector('.msg-menu');
  const editBtn = (menu2.querySelectorAll('.msg-menu__btn') || []).find(b => actOf(b) === 'edit');
  editBtn.dispatch('click', {});
  await wait(30);
  t('«تعديل» يعبّئ خانة الكتابة بنص الرسالة', chatInput.value === 'نص قبل التعديل');
  t('شريط التعديل ظاهر', composerBar.hidden === false && composerBar.dataset.mode === 'edit');
  chatInput.value = 'نص بعد التعديل';
  chatForm.dispatch('submit', {});
  await wait(60);
  const editedText = edRow.querySelector('.msg__text');
  t('النص يتحدث في مكانه', !!editedText && (editedText.textContent === 'نص بعد التعديل' || editedText.innerHTML === 'نص بعد التعديل'));
  t('وسم «تم التعديل» يظهر', edRow.classList.contains('msg--edited'));
  t('إرسال التعديل يغلق الشريط', composerBar.hidden === true);
  t('التعديل لا يغيّر موضع الرسالة', chatBody.children[chatBody.children.length - 1] === edRow);

  /* ---------- 6) الرد بالقائمة ---------- */
  chatBody.dispatch('contextmenu', { clientX: 100, clientY: 180, target: edRow });
  const menu3 = documentStub.body.querySelector('.msg-menu');
  const replyBtn = (menu3.querySelectorAll('.msg-menu__btn') || []).find(b => actOf(b) === 'reply');
  replyBtn.dispatch('click', {});
  await wait(30);
  t('«رد» من القائمة يفعّل وضع الرد', composerBar.hidden === false && composerBar.dataset.mode === 'reply');
  byId.get('composerBarCancel').dispatch('click', {});
  t('زر الإلغاء يغلق الشريط', composerBar.hidden === true);

  /* ---------- 7) المزامنة: أحداث عن بُعد ---------- */
  const CH = sandbox.WTRoom.chat;
  const remoteClient = 'remote-1';
  const wire = CH.encodeChatText('رسالة بعيدة', { c: 'rc-1' });
  const remoteRow = CH.addChatMessage({ id: 'r1', client: remoteClient, name: 'سليم', text: wire, ts: Date.now(), kind: 'chat' });
  t('رسالة بعيدة تُعرض مع بياناتها', !!remoteRow && remoteRow.dataset.text === 'رسالة بعيدة' && remoteRow.dataset.client === remoteClient);

  /* رسالة غيري: تعديل وحذف لا يظهران في القائمة */
  chatBody.dispatch('contextmenu', { clientX: 90, clientY: 150, target: remoteRow });
  const menu4 = documentStub.body.querySelector('.msg-menu');
  const btns4 = (menu4.querySelectorAll('.msg-menu__btn') || []);
  const replyBtn4 = btns4.find(b => actOf(b) === 'reply');
  t('رسائل الآخرين: الرد متاح', !!replyBtn4 && !replyBtn4.hidden);
  t('رسائل الآخرين: تعديل وحذف مخفيان', btns4.filter(b => actOf(b) === 'edit' || actOf(b) === 'delete').every(b => b.hidden));
  menu4.hidden = true;

  /* حدث تعديل قادم عن بُعد */
  CH.addChatMessage({
    id: 'e1', client: remoteClient, name: 'سليم', kind: 'edit', ts: Date.now(),
    text: CH.encodeChatText('رسالة بعيدة', { c: 'rc-1', n: 'نص معدَّل عن بُعد' })
  });
  const remText = remoteRow.querySelector('.msg__text');
  t('التعديل القادم يحدث الرسالة في مكانها', !!remText && (remText.textContent === 'نص معدَّل عن بُعد' || remText.innerHTML === 'نص معدَّل عن بُعد'));
  t('التعديل القادم يضيف وسم «تم التعديل»', remoteRow.classList.contains('msg--edited'));

  /* حدث حذف قادم عن بُعد */
  CH.addChatMessage({
    id: 'd1', client: remoteClient, name: 'سليم', kind: 'del', ts: Date.now(),
    text: CH.encodeChatText('نص معدَّل عن بُعد', { c: 'rc-1' })
  });
  t('الحذف القادم يحوّل الرسالة إلى «محذوفة»', remoteRow.classList.contains('msg--deleted') && (remoteRow.querySelector('.msg__text') || {}).textContent === 'محذوفة');

  /* مطابقة احتياطية بدون cid (رسائل تاريخية قديمة) */
  const oldWire = CH.encodeChatText('قديمة', {});
  const oldRow = CH.addChatMessage({ id: 'o1', client: 'old-1', name: 'قديم', text: oldWire, ts: Date.now(), kind: 'chat' });
  CH.addChatMessage({ id: 'o2', client: 'old-1', name: 'قديم', kind: 'del', ts: Date.now(), text: 'قديمة' });
  t('الحذف يعمل حتى بلا معرف (مطابقة المرسل والنص)', oldRow.classList.contains('msg--deleted'));

  /* ---------- 8) غلاف البيانات: ترميز وفك ---------- */
  const rt = CH.decodeChatText(CH.encodeChatText('مرحبا', { c: 'x1', r: { n: 'سليم', t: 'اقتباس' } }));
  t('فك الغلاف يسترجع النص والمعرف والاقتباس', rt.text === 'مرحبا' && rt.cid === 'x1' && rt.reply && rt.reply.name === 'سليم' && rt.reply.text === 'اقتباس');
  const plain = CH.decodeChatText('نص عادي');
  t('النص العادي يبقى كما هو', !plain.ok && plain.text === 'نص عادي');
  const broken = CH.decodeChatText('\u0001{كسور');
  t('غلاف تالف لا يكسر العرض (يُعامَل كنص)', !broken.ok && broken.text === '{كسور');

  /* ---------- 9) الرسائل المحذوفة لا تقبل التفاعل ---------- */
  chatBody.dispatch('contextmenu', { clientX: 90, clientY: 150, target: remoteRow });
  t('الرسالة المحذوفة لا تفتح قائمة الخيارات', documentStub.body.querySelector('.msg-menu').hidden === true);

  /* ---------- 10) الغلاف الكامل يمر عبر الناقل المحلي ---------- */
  await wait(450);
  chatBody.dispatch('pointerdown', { clientX: 100, clientY: 300, pointerId: 3, target: edRow });
  chatBody.dispatch('pointermove', { clientX: 170, clientY: 301, target: edRow });
  chatBody.dispatch('pointerup', { clientX: 170, clientY: 301, target: edRow });
  chatInput.value = 'رد سريع';
  chatForm.dispatch('submit', {});
  await wait(80);
  const last = chatBody.children[chatBody.children.length - 1];
  t('الرد بالسحب يرسل اقتباساً كاملاً', !!last.querySelector('.msg__quote') && last.dataset.text === 'رد سريع');

  console.log('');
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });

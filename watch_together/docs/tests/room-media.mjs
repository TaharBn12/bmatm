/* =========================================================
   WatchTogether — اختبار وسائط الغرفة (room-media.mjs)
   التشغيل: node docs/tests/room-media.mjs
   ---------------------------------------------------------
   يغطي:
     1) واجهة الإرفاق (زر · اختيار ملفات · شريط المرفقات · طبقة الإفلات).
     2) الرفع إلى موقع تخزين مجاني (سلسلة مزوّدين مع بديل تلقائي).
     3) إرسال الرابط إلى قاعدة البيانات مع الرسالة.
     4) عرض الصورة/الفيديو كبطاقة داخل الدردشة + العارض المكبّر.
     5) الأمان: رفض الملفات غير المدعومة والكبيرة، وروابط غير http/https.
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

/* ==================== شبكة وهمية (XHR + FormData) ==================== */
const requests = [];
let plan = [];

class FakeFormData {
  constructor() { this.fields = {}; }
  append(key, value) { this.fields[key] = value; }
}

class FakeXHR {
  constructor() {
    this.upload = { onprogress: null };
    this.status = 0;
    this.responseText = '';
    this.onload = null; this.onerror = null; this.ontimeout = null; this.onabort = null;
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() { }
  send(body) {
    requests.push({ method: this.method, url: this.url, body });
    const next = plan.shift() || { status: 200, text: '' };
    setTimeout(() => {
      if (next.fail) { if (this.onerror) this.onerror(); return; }
      this.status = next.status === undefined ? 200 : next.status;
      this.responseText = next.text === undefined ? '' : next.text;
      if (this.onload) this.onload();
    }, 0);
  }
}

const ownerToken = 'a'.repeat(64);
const env = createRoomEnv({
  search: '?id=MDIA01&host=1&v=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fsample.mp4',
  store: { 'wt:owner:MDIA01': JSON.stringify(ownerToken) },
  globals: { FormData: FakeFormData, XMLHttpRequest: FakeXHR }
});
const { sandbox, documentStub, byId } = env;
env.sandbox.WT_CONFIG.javaServer.enabled = false;
env.sandbox.WT_CONFIG.supabase.ready = false;

env.loaded.forEach(l => t(`تحميل ${path.basename(l.file)}`, l.ok, l.ok ? '' : String(l.error && l.error.message)));
env.loaded.filter(l => !l.ok).forEach(l => console.log(l.error && l.error.stack));

const image = { name: 'holiday.png', type: 'image/png', size: 24576 };
const video = { name: 'clip.mp4', type: 'video/mp4', size: 5242880 };

/** ينتظر تحقق شرط (بدل ثوابت عشوائية) */
const until = async (fn, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await wait(25);
  }
  return false;
};

const run = async () => {
  await wait(100);

  /* ---------- 1) الواجهة ---------- */
  t('زر الإرفاق موجود', !!byId.get('attachBtn'));
  t('حقل اختيار الملفات موجود ويقبل الصور والفيديو',
    !!byId.get('mediaInput') && /image/.test(byId.get('mediaInput').attrs.accept || '') && /video/.test(byId.get('mediaInput').attrs.accept || ''));
  t('شريط المرفقات موجود ومخفيّ افتراضياً', !!byId.get('mediaTray') && byId.get('mediaTray').hidden === true);
  t('طبقة الإفلات موجودة ومخفية', !!byId.get('mediaDrop') && byId.get('mediaDrop').hidden === true);
  t('العارض المكبّر موجود ومخفي', !!byId.get('mediaLightbox') && byId.get('mediaLightbox').hidden === true);
  t('وحدة الوسائط محمّلة', typeof sandbox.WTMedia === 'object' && typeof sandbox.WTMedia.upload === 'function');
  t('سلسلة مزوّدي التخزين المجاني مرتّبة', sandbox.WTMedia.providerOrder().join(',') === 'supabase,catbox,litterbox,tmpfiles,uguu',
    sandbox.WTMedia.providerOrder().join(','));

  /* ---------- 2) الدخول إلى الغرفة ---------- */
  byId.get('gateName').value = 'أمين';
  byId.get('gateForm').dispatch('submit', {});
  await wait(300);
  t('الغرفة جاهزة', sandbox.WTRoom.session.ready === true);

  const chatBody = byId.get('chatBody');
  const sent = [];
  const transport = sandbox.WTRoom.session.transport;
  const originalSend = transport.sendChat.bind(transport);
  transport.sendChat = (m) => { sent.push(m); return originalSend(m); };

  /* ---------- 3) الإرفاق والرفع ---------- */
  plan = [{ status: 200, text: '' }];   /* Supabase Storage يردّ 200 */
  byId.get('mediaInput').files = [image];
  byId.get('mediaInput').dispatch('change', {});
  await until(() => sandbox.WTRoom.media.attachments.length === 1 &&
    sandbox.WTRoom.media.attachments[0].status === 'done');

  const atts = sandbox.WTRoom.media.attachments;
  t('المرفق أُضيف إلى القائمة', atts.length === 1 && atts[0].kind === 'image');
  t('اكتمل الرفع', atts[0].status === 'done', atts[0].status + ' / ' + atts[0].error);
  t('الرابط من موقع التخزين المجاني صالح', /^https:\/\//.test(atts[0].media.url), atts[0].media && atts[0].media.url);
  t('الرابط يشير إلى دلو وسائط الغرفة', /wt-room-media/.test(atts[0].media.url), atts[0].media && atts[0].media.url);
  t('اسم المزوّد محفوظ', atts[0].media.provider === 'supabase', atts[0].media.provider);
  t('شريط المرفقات يظهر بطاقة الملف', byId.get('mediaTray').hidden === false && byId.get('mediaTray').children.length === 1);
  t('الطلب ذهب إلى واجهة التخزين', requests.length === 1 && /storage\/v1\/object/.test(requests[0].url), requests[0] && requests[0].url);

  /* اسم الملف يجب أن يطابق سياسة دلو Supabase في docs/sql/08-room-media.sql
     (وإلا ترفض السياسة الرفع ويُسقط الطلب إلى مواقع البدائل) */
  const storedName = String((requests[0] && requests[0].url) || '').split('/').pop();
  t('اسم ملف التخزين يطابق سياسة الدلو (وقت + hex حتى 40 + امتداد)',
    /^[0-9]{10,16}-[a-f0-9]{8,40}\.(jpg|jpeg|png|webp|gif|avif|bmp|mp4|webm|mov|m4v|mkv|ogv|3gp)$/.test(storedName), storedName);
  t('معرّف الملف hex فقط (أحرف a-f0-9)', /^[a-f0-9]+$/.test(storedName.split('-')[1].split('.')[0]),
    storedName.split('-')[1]);

  /* ---------- 4) الإرسال: الرابط إلى قاعدة البيانات ---------- */
  byId.get('chatInput').value = 'صورة من الرحلة';
  byId.get('chatForm').dispatch('submit', {});
  await until(() => sent.length === 1);

  t('أُرسلت رسالة واحدة', sent.length === 1, String(sent.length));
  t('الرابط أُرسل إلى قاعدة البيانات', sent[0].media && sent[0].media.url === atts[0].media.url, JSON.stringify(sent[0].media));
  t('نوع الوسيط مُرسَل', sent[0].media && sent[0].media.type === 'image');
  t('الغلاف يحمل الرابط', sent[0].text.indexOf(atts[0].media.url) > 0);
  const decoded = sandbox.WTRoom.chat.decodeChatText(sent[0].text);
  t('فك الغلاف يسترجع الوسيط', decoded.media.length === 1 && decoded.media[0].u === atts[0].media.url);
  t('نص الرسالة باقٍ', decoded.text === 'صورة من الرحلة');
  t('الغلاف لا يتجاوز حد التخزين (1000 محرف)', sent[0].text.length < 1000, String(sent[0].text.length));
  t('شريط المرفقات أُفرغ بعد الإرسال', sandbox.WTRoom.media.attachments.length === 0 && byId.get('mediaTray').hidden === true);
  t('خانة الكتابة أُفرغت', byId.get('chatInput').value === '');

  /* ---------- 5) العرض داخل الدردشة ---------- */
  const card = chatBody.querySelector('.msg-media');
  t('بطاقة وسائط داخل الرسالة', !!card);
  t('بطاقة الصورة تحمل صنف msg-media--image', card.classList.contains('msg-media--image'));
  const cardImg = card.querySelector('.msg-media__img');
  t('الصورة معروضة من الرابط المخزّن في قاعدة البيانات', !!cardImg && cardImg.src === atts[0].media.url,
    cardImg && cardImg.src);
  t('لا توجد أيقونات أو أدوات فوق المعاينة',
    card.querySelectorAll('.msg-media__tool').length === 0 && card.querySelectorAll('.msg-media__zoom').length === 0);
  t('معاينة الصورة بنسبة 16:4', card.getAttribute('data-orient') === 'wt-16x4');
  t('النص يظهر مع الوسائط', !!chatBody.querySelector('.msg__text'));
  t('الرسالة مُعلَّمة كرسالة وسائط', !!chatBody.querySelector('.msg--media'));

  /* معاينة ثابتة 16:4، مع إبقاء أدوات حساب الأبعاد متاحة للمزوّد */
  t('حساب اتجاه الصورة الأفقية (landscape)', sandbox.WTMedia.orientationOf(1600, 900) === 'landscape');
  t('حساب اتجاه الصورة العمودية (portrait)', sandbox.WTMedia.orientationOf(900, 1600) === 'portrait');
  t('حساب اتجاه الصورة المربعة (square)', sandbox.WTMedia.orientationOf(1000, 1000) === 'square');
  const boxLand = sandbox.WTMedia.previewBox(1600, 900, 200, 148);
  t('تصغير المعاينة مع الحفاظ على نسبة العرض للارتفاع',
    boxLand && boxLand.w === 200 && boxLand.h === 113 && boxLand.orient === 'landscape', JSON.stringify(boxLand));
  cardImg.naturalWidth = 1280;
  cardImg.naturalHeight = 720;
  if (typeof cardImg.onload === 'function') cardImg.onload();
  t('اكتمال تحميل الصورة لا يغيّر تنسيق 16:4',
    card.classList.contains('is-loaded') && card.getAttribute('data-orient') === 'wt-16x4');

  const mediaCss = fs.readFileSync(path.join(base, 'assets/css/media.css'), 'utf8');
  t('تصميم المعاينة يفرض نسبة 16:4 مستقلة لكل بطاقة',
    /\.msg-media\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*4/.test(mediaCss));
  t('الصورة داخل المعاينة تغطي الشريط بلا أيقونة تحميل',
    /\.msg-media__img,[\s\S]*?object-fit:\s*cover/.test(mediaCss) &&
    /\.msg-media--image:not\(\.is-loaded\):not\(\.is-error\)[\s\S]*?display:\s*none/.test(mediaCss));
  t('العارض المكبّر يعرض الصورة كاملة بلا قصّ (object-fit: contain)',
    /\.media-lightbox__img[\s\S]*?object-fit:\s*contain/.test(mediaCss));

  /* ---------- 6) العارض المكبّر: الضغط على الصورة نفسها يظهرها كاملة ---------- */
  card.dispatch('click', { target: cardImg });
  await wait(40);
  t('الضغط على صورة المعاينة مباشرة يفتح العارض الكامل', byId.get('mediaLightbox').hidden === false);
  const fullImg = byId.get('mediaStage').querySelector('.media-lightbox__img');
  t('العارض يعرض الصورة كاملة', !!fullImg && fullImg.src === atts[0].media.url);
  fullImg.dispatch('click', { target: fullImg });
  t('الضغط على الصورة الكاملة يبدّل التكبير الإضافي (is-zoomed)', fullImg.classList.contains('is-zoomed'));
  byId.get('mediaLightbox').dispatch('click', { target: byId.get('mediaStage') });
  t('الضغط حول الصورة في الخلفية يغلق العارض', byId.get('mediaLightbox').hidden === true);

  t('لا يوجد زر تكبير منفصل في البطاقة', !card.querySelector('[data-act="expand"]'));
  card.dispatch('click', { target: card });
  await wait(40);
  t('العارض يفتح بالنقر على البطاقة نفسها', byId.get('mediaLightbox').hidden === false);
  t('زر الحفظ يظهر داخل العارض ويشير إلى رابط قاعدة البيانات',
    byId.get('mediaDownload').hidden === false && byId.get('mediaDownload').getAttribute('href') === atts[0].media.url);
  byId.get('mediaClose').dispatch('click', {});
  t('زر الإغلاق يغلق العارض', byId.get('mediaLightbox').hidden === true);

  /* ---------- 7) عدة صور: كل صورة بطاقة مستقلة وبالترتيب ---------- */
  const multiItems = [
    { u: 'https://cdn.example/one.jpg', k: 'image', n: 'one.jpg' },
    { u: 'https://cdn.example/two.jpg', k: 'image', n: 'two.jpg' },
    { u: 'https://cdn.example/three.jpg', k: 'image', n: 'three.jpg' }
  ];
  const multiText = sandbox.WTRoom.chat.encodeChatText('ثلاث صور', { c: 'multi-media', m: { list: multiItems } });
  const multiRow = sandbox.WTRoom.chat.addChatMessage({
    id: 'multi-media', client: 'remote', name: 'مشارك', kind: 'chat', ts: Date.now(), text: multiText
  });
  const multiCards = multiRow.querySelectorAll('.msg-media');
  t('كل صورة متعددة تظهر كبطاقة مستقلة', multiCards.length === 3, String(multiCards.length));
  t('البطاقات المتعددة تحافظ على ترتيب قاعدة البيانات',
    multiCards.map(cardItem => cardItem.getAttribute('data-media-url')).join('|') === multiItems.map(item => item.u).join('|'));
  t('كل بطاقة متعددة تحمل تنسيق 16:4 ولا تعرض أدوات',
    multiCards.every(cardItem => cardItem.getAttribute('data-orient') === 'wt-16x4' &&
      cardItem.querySelectorAll('.msg-media__tool').length === 0 && cardItem.querySelectorAll('.msg-media__zoom').length === 0));

  /* ---------- 8) فيديو ---------- */
  plan = [{ status: 200, text: '' }];
  byId.get('mediaInput').files = [video];
  byId.get('mediaInput').dispatch('change', {});
  await until(() => sandbox.WTRoom.media.attachments.length === 1 &&
    sandbox.WTRoom.media.attachments[0].status === 'done');
  t('الفيديو رُفع', sandbox.WTRoom.media.attachments[0] && sandbox.WTRoom.media.attachments[0].kind === 'video');
  const videoUrl = sandbox.WTRoom.media.attachments[0].media.url;
  await wait(450);   /* تهدئة الإرسال بين رسالتين */
  byId.get('chatForm').dispatch('submit', {});
  await until(() => !!chatBody.querySelector('.msg-media--video'));
  const videoCard = chatBody.querySelector('.msg-media--video');
  t('بطاقة فيديو داخل الرسالة', !!videoCard);
  t('مشغّل الفيديو يعرض رابط الملف', !!videoCard.querySelector('.msg-media__video') && videoCard.querySelector('.msg-media__video').src === videoUrl,
    videoCard.querySelector('.msg-media__video') && videoCard.querySelector('.msg-media__video').src);
  t('نوع الوسائط في قاعدة البيانات فيديو', sent[sent.length - 1].media.type === 'video');

  /* ---------- 8) سلسلة البدائل: فشل المزوّد الأول ---------- */
  plan = [
    { fail: true },                                                       /* Supabase: فشل */
    { status: 200, text: 'https://files.catbox.moe/abc123.png' }          /* Catbox: نجح */
  ];
  byId.get('mediaInput').files = [image];
  byId.get('mediaInput').dispatch('change', {});
  await until(() => sandbox.WTRoom.media.attachments.length === 1 &&
    sandbox.WTRoom.media.attachments[0].status === 'done');
  const fallback = sandbox.WTRoom.media.attachments[0];
  t('انتقل إلى المزوّد البديل تلقائياً', fallback && fallback.status === 'done' && fallback.media.provider === 'catbox',
    fallback && (fallback.media.provider + ' ' + fallback.status));
  t('الرابط من الموقع البديل', fallback && fallback.media.url === 'https://files.catbox.moe/abc123.png');
  t('جرّب مزوّدين قبل النجاح', requests.length === 4, String(requests.length));
  sandbox.WTRoom.media.clearAttachments();

  /* ---------- 8b) مزوّدو البدائل الجدد: Litterbox و Tmpfiles ---------- */
  plan = [{ status: 200, text: 'https://litter.catbox.moe/xyz789.png' }];
  const litUrl = await sandbox.WTMedia.providers.litterbox.upload(image, {}, () => { });
  t('Litterbox يعيد الرابط المباشر', litUrl === 'https://litter.catbox.moe/xyz789.png', litUrl);
  t('Litterbox يُعلَّم مؤقّتاً (72 ساعة)', sandbox.WTMedia.providers.litterbox.temporary === true);

  plan = [{ status: 200, text: '{"status":"success","data":{"url":"https://tmpfiles.org/1234567/holiday.png"}}' }];
  const tmpUrl = await sandbox.WTMedia.providers.tmpfiles.upload(image, {}, () => { });
  t('Tmpfiles يحوّل رابط الصفحة إلى رابط مباشر /dl/', tmpUrl === 'https://tmpfiles.org/dl/1234567/holiday.png', tmpUrl);

  plan = [{ status: 200, text: 'Uploads paused, please wait!' }];
  let catRefused = '';
  try { await sandbox.WTMedia.providers.catbox.upload(image, {}, () => { }); }
  catch (e) { catRefused = e.message; }
  t('رفض Catbox (رسالة نصية بلا رابط) يُنتج خطأ ينتقل منه للبديل', /Catbox/.test(catRefused), catRefused);

  /* ---------- 9) الإفلات واللصق ---------- */
  byId.get('chat').dispatch('dragenter', { dataTransfer: { types: ['Files'], files: [image] } });
  t('طبقة الإفلات تظهر عند السحب', byId.get('mediaDrop').hidden === false);
  byId.get('chat').dispatch('drop', { dataTransfer: { types: ['Files'], files: [image] } });
  await until(() => sandbox.WTRoom.media.attachments.length === 1);
  t('طبقة الإفلات تختفي بعد الإفلات', byId.get('mediaDrop').hidden === true);
  t('الملف المُفلَت أُرفق', sandbox.WTRoom.media.attachments.length === 1);

  byId.get('chatInput').dispatch('paste', { clipboardData: { files: [image] } });
  await until(() => sandbox.WTRoom.media.attachments.length === 2);
  t('اللصق يضيف الملف', sandbox.WTRoom.media.attachments.length === 2);

  /* ---------- 10) رفض الملفات غير الصالحة ---------- */
  plan = [{ status: 200, text: '' }];
  byId.get('mediaInput').files = [{ name: 'doc.pdf', type: 'application/pdf', size: 1000 }];
  byId.get('mediaInput').dispatch('change', {});
  await wait(60);
  t('الملف غير المدعوم يُرفض', sandbox.WTRoom.media.attachments.length === 2, String(sandbox.WTRoom.media.attachments.length));

  byId.get('mediaInput').files = [{ name: 'huge.png', type: 'image/png', size: 90 * 1048576 }];
  byId.get('mediaInput').dispatch('change', {});
  await wait(60);
  t('الصورة الأكبر من الحد تُرفض', sandbox.WTRoom.media.attachments.length === 2, String(sandbox.WTRoom.media.attachments.length));

  /* ---------- 11) الأمان: رابط غير آمن ---------- */
  t('رابط javascript: مرفوض', sandbox.WTMedia.safeURL('javascript:alert(1)') === '');
  t('رابط ببيانات دخول مرفوض', sandbox.WTMedia.safeURL('https://user:pass@example.com/a.png') === '');
  t('رابط http/https مقبول', sandbox.WTMedia.safeURL('https://example.com/a.png') === 'https://example.com/a.png');
  const badCard = sandbox.WTRoom.chat.addChatMessage({
    id: 'bad-media', client: 'x', name: 'مخترق', kind: 'chat', ts: Date.now(),
    text: sandbox.WTRoom.chat.encodeChatText('', { c: 'bad-media', m: { u: 'javascript:alert(1)', k: 'image' } })
  });
  t('رسالة برابط خبيث لا تعرض وسائط', !badCard.querySelector('.msg-media'));

  /* ---------- 12) الرد على رسالة وسائط والحذف ---------- */
  const mediaRow = chatBody.children.find(r => r.classList.contains('msg--media'));
  sandbox.WTRoom.chat.setReplyTo(mediaRow);
  t('الرد على رسالة وسائط يذكر نوعها', sandbox.WTRoom.session.replyTo.text.indexOf('صورة') >= 0,
    sandbox.WTRoom.session.replyTo.text);
  sandbox.WTRoom.chat.clearComposer();

  const before = chatBody.children.length;
  sandbox.WTRoom.chat.deleteMessage(mediaRow);
  await wait(30);
  t('حذف رسالة الوسائط يُبقي مكانها', chatBody.children.length === before);
  t('حذف رسالة الوسائط يزيل البطاقة', !mediaRow.querySelector('.msg-media'));

  /* ---------- 13) حدّ الملفات في الرسالة الواحدة ---------- */
  const max = sandbox.WT_CONFIG.media.maxPerMessage;
  sandbox.WTRoom.media.clearAttachments();
  const many = [];
  for (let i = 0; i < max + 3; i++) many.push({ name: 'f' + i + '.png', type: 'image/png', size: 1000 });
  plan = many.map(() => ({ status: 200, text: '' }));
  sandbox.WTRoom.media.handleFiles(many);
  await until(() => sandbox.WTRoom.media.attachments.length >= 1);
  t('الحد الأقصى للملفات في الرسالة الواحدة مُطبَّق', sandbox.WTRoom.media.attachments.length === max,
    String(sandbox.WTRoom.media.attachments.length));

  env.dispose();
  console.log('');
  if (errors.length) errors.forEach(e => console.log('  ' + e));
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });

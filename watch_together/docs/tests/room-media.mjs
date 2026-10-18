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
import { createRoomEnv, wait, base, setAccountName } from './harness.mjs';

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
class PreviewURL extends URL {
  static createObjectURL(file) { return 'blob:wt-preview-' + String((file && file.name) || 'image'); }
}
sandbox.URL = PreviewURL;
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
  t('سلسلة مزوّدي التخزين المجاني مرتّبة', sandbox.WTMedia.providerOrder().join(',') === 'supabase,0x0,pixeldrain,catbox,gofile,oshi,litterbox,tmpfiles,fileio,uguu',
    sandbox.WTMedia.providerOrder().join(','));

  /* ---------- 2) الدخول إلى الغرفة ---------- */
  setAccountName(env, 'أمين');
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
  t('الصورة معروضة من رابط موقع الرفع', !!cardImg && cardImg.src === atts[0].media.url,
    cardImg && cardImg.src);
  t('أدوات البطاقة موجودة (تكبير · فتح · تنزيل)', card.querySelectorAll('.msg-media__tool').length >= 2);
  t('النص يظهر مع الوسائط', !!chatBody.querySelector('.msg__text'));
  t('الرسالة مُعلَّمة كرسالة وسائط', !!chatBody.querySelector('.msg--media'));

  /* معاينة حسب أبعاد الصورة (أفقية / عمودية / مربعة) ومصغّرة قليلاً */
  t('حساب اتجاه الصورة الأفقية (landscape)', sandbox.WTMedia.orientationOf(1600, 900) === 'landscape');
  t('حساب اتجاه الصورة العمودية (portrait)', sandbox.WTMedia.orientationOf(900, 1600) === 'portrait');
  t('حساب اتجاه الصورة المربعة (square)', sandbox.WTMedia.orientationOf(1000, 1000) === 'square');
  const boxLand = sandbox.WTMedia.previewBox(1600, 900, 200, 148);
  t('تصغير المعاينة مع الحفاظ على نسبة العرض للارتفاع',
    boxLand && boxLand.w === 200 && boxLand.h === 113 && boxLand.orient === 'landscape', JSON.stringify(boxLand));
  cardImg.naturalWidth = 1280;
  cardImg.naturalHeight = 720;
  if (typeof cardImg.onload === 'function') cardImg.onload();
  t('اكتمال تحميل الصورة يضبط is-loaded واتجاه المعاينة حسب الصورة',
    card.classList.contains('is-loaded') && card.getAttribute('data-orient') === 'landscape' && card.getAttribute('data-dims') === '1280x720');

  const mediaCss = fs.readFileSync(path.join(base, 'assets/css/media.css'), 'utf8');
  t('معاينة الدردشة تملأ عرض الرسالة (6/6) وتحافظ على نسبة الصورة',
    /\.msg-media__frame[\s\S]*?width:\s*100%[\s\S]*?aspect-ratio:\s*var\(--media-ar/.test(mediaCss) &&
    /\.msg-media__img[\s\S]*?object-fit:\s*contain/.test(mediaCss) &&
    !/max-width:\s*200px/.test(mediaCss));
  t('العارض المكبّر يعرض الصورة كاملة بلا قصّ (object-fit: contain)',
    /\.media-lightbox__img[\s\S]*?object-fit:\s*contain/.test(mediaCss));
  const zoomRule = (mediaCss.match(/\.media-lightbox__img\.is-zoomed\s*\{[^}]*\}/) || [''])[0];
  t('تكبير العارض حقيقي (بلا transform: scale المشوّش) والصورة قابلة للتمرير',
    /max-width:\s*none/.test(zoomRule) && /max-height:\s*none/.test(zoomRule) &&
    !/transform:\s*scale/.test(zoomRule) &&
    /\.media-lightbox__stage[\s\S]*?overflow:\s*auto/.test(mediaCss));
  t('مسرح العارض بارتفاع محدّد حتى لا تُقصّ الصورة المكبّرة',
    /\.media-lightbox__frame[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/.test(mediaCss) &&
    /\.media-lightbox__stage[\s\S]*?align-self:\s*stretch/.test(mediaCss));
  t('نسخ الملفات محدّثة (تفادياً لنسخة المتصفح القديمة)',
    /media\.css\?v=3\.1\.5/.test(fs.readFileSync(path.join(base, 'room.html'), 'utf8')) &&
    /media\.js\?v=3\.1\.5/.test(fs.readFileSync(path.join(base, 'room.html'), 'utf8')) &&
    /room\.js\?v=3\.2\.1/.test(fs.readFileSync(path.join(base, 'room.html'), 'utf8')));
  t('تنسيق بديل واضح عند فشل تحميل الصورة بدلاً من أيقونة Safari المكسورة',
    /\.media-lightbox__img\[hidden\][\s\S]*?display:\s*none\s*!important/.test(mediaCss) &&
    /\.media-lightbox__error\[hidden\][\s\S]*?display:\s*none\s*!important/.test(mediaCss) &&
    /\.media-lightbox__error-retry/.test(mediaCss));

  /* ---------- 6) العارض المكبّر: الضغط على الصورة أو زر التكبير يظهرها كاملة ---------- */
  cardImg.dispatch('click', { target: cardImg });
  await wait(40);
  t('الضغط على صورة المعاينة مباشرة يفتح العارض الكامل', byId.get('mediaLightbox').hidden === false);
  const fullImg = byId.get('mediaStage').querySelector('.media-lightbox__img');
  t('العارض يعرض الصورة كاملة', !!fullImg && fullImg.src === atts[0].media.url);
  t('الصورة داخل لوحة عرض قابلة للتمرير عند التكبير',
    !!byId.get('mediaStage').querySelector('.media-lightbox__canvas'));
  /* الصورة تأخذ حجمها الكامل بالبكسل (لا تحجيم مُموَّه) */
  fullImg.naturalWidth = 1280;
  fullImg.naturalHeight = 720;
  fullImg.dispatch('click', { target: fullImg });
  t('الضغط على الصورة الكاملة يبدّل التكبير الإضافي (is-zoomed)', fullImg.classList.contains('is-zoomed'));
  t('مؤشّر التكبير يعرض الحجم الحقيقي 100%', byId.get('mediaZoomLevel').textContent === '100%',
    byId.get('mediaZoomLevel').textContent);
  t('الصورة المكبّرة تُعرض بأبعادها الأصلية بالبكسل',
    fullImg.style.width === '1280px' && fullImg.style.height === '720px',
    fullImg.style.width + '×' + fullImg.style.height);

  byId.get('mediaZoomIn').dispatch('click', {});
  t('زر التكبير يرفع المستوى إلى 150%', byId.get('mediaZoomLevel').textContent === '150%' &&
    fullImg.style.width === '1920px', byId.get('mediaZoomLevel').textContent + ' ' + fullImg.style.width);
  sandbox.WTMedia.resetViewerZoom();
  t('إعادة الضبط تُعيد الصورة إلى ملء الشاشة',
    !fullImg.classList.contains('is-zoomed') && byId.get('mediaZoomLevel').textContent === 'ملء');

  fullImg.dispatch('error', {});
  t('فشل رابط التخزين ينتقل تلقائياً إلى المعاينة المحلية على الجهاز',
    fullImg.src === atts[0].preview && !!atts[0].preview, String(fullImg.src));
  fullImg.dispatch('error', {});
  const imageError = byId.get('mediaStage').querySelector('.media-lightbox__error');
  t('إذا فشل الرابط والمعاينة لا تظهر أيقونة صورة مكسورة',
    !!imageError && imageError.hidden === false && fullImg.hidden === true &&
    imageError.textContent.includes('تعذّر تحميل الصورة'));
  t('عند فشل التحميل تُعطّل أدوات التكبير', byId.get('mediaZoomLevel').disabled === true);
  const retryImage = imageError && imageError.querySelector('.media-lightbox__error-retry');
  if (retryImage) retryImage.dispatch('click', {});
  t('زر إعادة المحاولة يعيد الصورة والرابط الأصلي',
    !!retryImage && imageError.hidden === true && fullImg.hidden === false &&
    fullImg.src === atts[0].media.url && byId.get('mediaZoomLevel').disabled === false);

  byId.get('mediaLightbox').dispatch('click', { target: byId.get('mediaStage') });
  t('الضغط حول الصورة في الخلفية يغلق العارض', byId.get('mediaLightbox').hidden === true);

  const zoom = card.querySelector('[data-act="expand"]');
  t('زر التكبير موجود', !!zoom);
  zoom.dispatch('click', { target: zoom });
  await wait(40);
  t('العارض المكبّر يفتح بزر التكبير أيضاً', byId.get('mediaLightbox').hidden === false);
  t('زر التنزيل يشير إلى الرابط', byId.get('mediaDownload').getAttribute('href') === atts[0].media.url);
  byId.get('mediaClose').dispatch('click', {});
  t('زر الإغلاق يغلق العارض', byId.get('mediaLightbox').hidden === true);

  /* ---------- 7) فيديو ---------- */
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
    { status: 200, text: 'https://0x0.st/abc123.png' }                      /* 0x0.st: نجح */
  ];
  byId.get('mediaInput').files = [image];
  byId.get('mediaInput').dispatch('change', {});
  await until(() => sandbox.WTRoom.media.attachments.length === 1 &&
    sandbox.WTRoom.media.attachments[0].status === 'done');
  const fallback = sandbox.WTRoom.media.attachments[0];
  t('انتقل إلى المزوّد البديل تلقائياً', fallback && fallback.status === 'done' && fallback.media.provider === '0x0',
    fallback && (fallback.media.provider + ' ' + fallback.status));
  t('الرابط من الموقع البديل', fallback && fallback.media.url === 'https://0x0.st/abc123.png');
  t('جرّب مزوّدين قبل النجاح', requests.length === 4, String(requests.length));
  sandbox.WTRoom.media.clearAttachments();

  /* ---------- 8b) مزوّدو البدائل الجدد: 0x0.st و PixelDrain و Gofile و Oshi و Litterbox و Tmpfiles ---------- */
  plan = [{ status: 200, text: 'https://0x0.st/xyz.png' }];
  const zeroUrl = await sandbox.WTMedia.providers['0x0'].upload(image, {}, () => { });
  t('0x0.st يعيد الرابط المباشر', zeroUrl === 'https://0x0.st/xyz.png', zeroUrl);
  t('0x0.st غير مؤقّت (دائم)', sandbox.WTMedia.providers['0x0'].temporary !== true);

  plan = [{ status: 200, text: '{"id":"abc123","url":"https://pixeldrain.com/u/abc123"}' }];
  const pixUrl = await sandbox.WTMedia.providers.pixeldrain.upload(image, {}, () => { });
  t('PixelDrain يبني رابطاً مباشراً من المعرّف', pixUrl === 'https://pixeldrain.com/api/file/abc123', pixUrl);

  plan = [{ status: 200, text: '{"status":"success","data":{"servers":[{"name":"store1"}]}}' }, { status: 200, text: '{"status":"success","data":{"downloadPage":"https://gofile.io/d/xyz","directLink":"https://store1.gofile.io/download/xyz/file.png"}}' }];
  const gofileUrl = await sandbox.WTMedia.providers.gofile.upload(image, {}, () => { });
  t('Gofile يحصل على السيرفر ويرفع ويرجع رابطاً مباشراً', gofileUrl === 'https://store1.gofile.io/download/xyz/file.png', gofileUrl);

  plan = [{ status: 200, text: 'https://oshi.at/ABC/holiday.png' }];
  const oshiUrl = await sandbox.WTMedia.providers.oshi.upload(image, {}, () => { });
  t('Oshi يعيد الرابط المباشر', oshiUrl === 'https://oshi.at/ABC/holiday.png', oshiUrl);

  plan = [{ status: 200, text: '{"status":"success","link":"https://file.io/xyz123","key":"xyz123"}' }];
  const fileioUrl = await sandbox.WTMedia.providers.fileio.upload(image, {}, () => { });
  t('File.io يعيد الرابط المباشر من JSON', fileioUrl === 'https://file.io/xyz123', fileioUrl);

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

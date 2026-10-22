/* =========================================================
   WatchTogether — طبقة الموقع المشتركة (site features)
   اختبارات بلا اعتماديات: تتحقّق من ربط كل الصفحات، وصلاحية
   manifest وservice worker، ومنطق لوحة الأوامر والتفضيلات.

   التشغيل:  node docs/tests/site-features.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(base, file));

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : detail);
}

/* ==================== 1) كل صفحة تحمل الطبقة ==================== */
const PAGES = ['index.html', 'room.html', 'auth.html', 'profile.html', 'friends.html', 'messages.html'];
for (const page of PAGES) {
  const html = read(page);
  t(`${page}: prefs.js مبكر قبل أي CSS`, html.indexOf('assets/js/prefs.js') > 0 &&
    html.indexOf('assets/js/prefs.js') < html.indexOf('assets/css/'), '');
  t(`${page}: site.css بعد كل أوراق الأنماط`, (() => {
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="assets\/css\/[^"]+">/g)];
    const last = sheets[sheets.length - 1];
    return !!last && last[0].includes('site.css');
  })(), '');
  t(`${page}: site.js آخر سكربت في الصفحة`, (() => {
    const scripts = [...html.matchAll(/<script src="assets\/js\/[^"]+"><\/script>/g)];
    const last = scripts[scripts.length - 1];
    return !!last && last[0].includes('site.js');
  })(), '');
  t(`${page}: manifest + meta description + OG`, /rel="manifest" href="manifest\.webmanifest"/.test(html) &&
    /name="description"/.test(html) && /property="og:title"/.test(html) && /property="og:image"/.test(html), '');
  t(`${page}: apple-touch-icon حقيقي (PNG) لا data-URI`, /rel="apple-touch-icon" href="assets\/icons\/apple-touch-icon\.png"/.test(html) &&
    !/rel="apple-touch-icon" href="data:/.test(html), '');
  t(`${page}: color-scheme داكن`, /name="color-scheme" content="dark"/.test(html), '');

  /* معرّفات فريدة */
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  t(`${page}: معرّفات DOM فريدة`, duplicates.length === 0, duplicates.join(','));

  /* روابط داخلية موجودة */
  const links = [...html.matchAll(/href="([^"#:]+\.html)(?:\?[^"]*)?"/g)].map((m) => m[1]);
  const missing = [...new Set(links)].filter((href) => !exists(href));
  t(`${page}: كل روابط الصفحات الداخلية موجودة`, missing.length === 0, missing.join(','));
}

/* ==================== 2) prefs.js — تطبيق التفضيلات مبكراً ==================== */
function prefsEnv(stored, reduced) {
  const attrs = {};
  const sandbox = {
    console,
    JSON,
    String,
    Boolean,
    localStorage: { getItem: (key) => (key === 'wt:prefs' ? stored : null) },
    matchMedia: () => ({ matches: !!reduced }),
    document: { documentElement: { setAttribute: (key, value) => { attrs[key] = String(value); }, removeAttribute: (key) => { delete attrs[key]; } } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/prefs.js'), sandbox, { filename: 'prefs.js' });
  return { attrs, api: sandbox.WTPrefs };
}

{
  const gold = prefsEnv(null, false);
  t('prefs: الافتراضي بلا سمة لون', !('data-wt-accent' in gold.attrs), JSON.stringify(gold.attrs));
  t('prefs: الوضع الافتراضي يتبع النظام (حركة كاملة)', gold.attrs['data-wt-motion'] === 'full', gold.attrs['data-wt-motion']);

  const mint = prefsEnv(JSON.stringify({ accent: 'mint', motion: 'reduce', contrast: 'high', compact: true }), false);
  t('prefs: اللون المختار يُطبَّق', mint.attrs['data-wt-accent'] === 'mint', mint.attrs['data-wt-accent']);
  t('prefs: تقليل الحركة يُطبَّق', mint.attrs['data-wt-motion'] === 'reduce', mint.attrs['data-wt-motion']);
  t('prefs: التباين العالي يُطبَّق', mint.attrs['data-wt-contrast'] === 'high', mint.attrs['data-wt-contrast']);
  t('prefs: الواجهة المضغوطة تُطبَّق', mint.attrs['data-wt-compact'] === '1', mint.attrs['data-wt-compact']);

  const autoReduced = prefsEnv(JSON.stringify({ motion: 'auto' }), true);
  t('prefs: «تلقائي» يحترم رغبة النظام', autoReduced.attrs['data-wt-motion'] === 'reduce', autoReduced.attrs['data-wt-motion']);

  const broken = prefsEnv('{ليست JSON', false);
  t('prefs: تخزين تالف لا يعطّل الصفحة', broken.attrs['data-wt-motion'] === 'full' && !('data-wt-accent' in broken.attrs), JSON.stringify(broken.attrs));

  const unknown = prefsEnv(JSON.stringify({ accent: 'neon', contrast: 'ultra', motion: 'warp' }), false);
  t('prefs: قيم غير معروفة تعود للافتراضي', unknown.api.get().accent === 'gold' &&
    unknown.api.get().contrast === 'normal' && unknown.api.get().motion === 'auto', JSON.stringify(unknown.api.get()));
}

/* ==================== 3) site.js — المنطق النقي ==================== */
function siteEnv() {
  const sandbox = {
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, URL,
    setTimeout, clearTimeout,
    encodeURIComponent, decodeURIComponent,
    localStorage: {
      getItem: (key) => (key === 'wt:prefs' ? JSON.stringify({ accent: 'azure' }) : null),
      setItem: () => {}, removeItem: () => {}
    },
    navigator: { onLine: true },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    location: { pathname: '/index.html', href: 'http://localhost/index.html', protocol: 'http:', hostname: 'localhost', search: '', origin: 'http://localhost' },
    addEventListener: () => {}, removeEventListener: () => {},
    document: {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      documentElement: null,
      body: null
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('assets/js/site.js'), sandbox, { filename: 'site.js' });
  return sandbox;
}

let siteTests = 0;
try {
  const env = siteEnv();
  const Site = env.WTSite;
  t('site.js: يُحمَّل ويُنشئ WTSite', !!Site && Site.version === '1.0.0', Site && Site.version);
  t('site.js: قرأ تفضيلات المستخدم', Site.prefs().accent === 'azure', Site.prefs().accent);
  t('site.js: واجهة عامة قابلة للاستدعاء', typeof Site.openPalette === 'function' &&
    typeof Site.openSettings === 'function' && typeof Site.openHelp === 'function', '');
  const inner = Site._internal;
  t('site.js: تطبيع عربي يوحّد الهمزات والتاء', inner.normalize('الأصدقاء') === inner.normalize('الاصدقاء') &&
    inner.normalize('الأصدقاء') === 'الاصدقاء', inner.normalize('الأصدقاء'));
  t('site.js: تطبيع يحذف التشكيل والمسافات الزائدة', inner.normalize('  مُشَاهَدَة  ') === 'مشاهده', inner.normalize('  مُشَاهَدَة  '));
  t('site.js: بحث يطابق الاسم الجزئي', inner.rank([{ id: 'a', title: 'الغرف' }, { id: 'b', title: 'الأصدقاء' }], 'صدق')[0].id === 'b', '');
  t('site.js: بحث يرجّح بداية العنوان', inner.score({ title: 'الرسائل', sub: 'محادثات' }, 'رسائل') >
    inner.score({ title: 'الرسائل', sub: 'رسائل' }, 'محادثات'), '');
  t('site.js: بحث يطابق الوصف أيضاً', inner.score({ title: 'ملفي', sub: 'حسابك وخصوصيتك' }, 'حسابك') > 0, '');
  t('site.js: بلا استعلام يعيد كل الأوامر بالترتيب', inner.rank([{ id: 'a', title: 'أ' }, { id: 'b', title: 'ب' }], '').length === 2, '');
  t('site.js: كود الغرفة يُقبل فقط بأحرف وأرقام', inner.looksLikeRoomCode('AB12') &&
    !inner.looksLikeRoomCode('مرحبا') && !inner.looksLikeRoomCode('ABCD') && !inner.looksLikeRoomCode('1234') &&
    !inner.looksLikeRoomCode('AB 12'), '');
  t('site.js: يقبل كوداً من 4 إلى 10 خانات', inner.looksLikeRoomCode('ROOM42') && !inner.looksLikeRoomCode('A1') && !inner.looksLikeRoomCode('A123456789B'), '');
  siteTests++;
} catch (error) {
  t('site.js: لا يرمي عند التحميل', false, error && error.message);
}

/* فحوص بِنْيَوية للملف (حماية من الانحدار في الأمان والوصولية) */
{
  const source = read('assets/js/site.js');
  t('site.js: صياغة صحيحة (vm)', (() => {
    try { new vm.Script(source); return true; } catch (e) { return false; }
  })(), '');
  t('site.js: كل عنوان أمر يُهرَّب قبل الإدراج', /esc\(item\.title\)/.test(source) && /esc\(item\.sub\)/.test(source), '');
  t('site.js: لا مكتبات أو خطوط خارجية', !/https?:\/\/(?!fonts|localhost)/.test(source.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')), '');
  t('site.js: لوحة الأوامر وصولية (combobox + listbox)', /role="combobox"/.test(source) &&
    /role="listbox"/.test(source) && /aria-activedescendant/.test(source), '');
  t('site.js: نوافذ حوارية بسمة aria-modal', /aria-modal="true"/.test(source), '');
  t('site.js: احترام تقليل الحركة في التنقّل', /prefers-reduced-motion/.test(source), '');
  t('site.js: المناطق الحسّاسة لا تُلمس (لا تعديل على Supabase)', !/supabase/i.test(source), '');
  t('site.js: يسجّل الخدمة العاملة بمسار نسبي', /serviceWorker\.register\('sw\.js'/.test(source), '');
  /* على الهاتف لا يوجد Ctrl+Shift+R: التحديث يُطبَّق وحده، ولا يقطع مكالمة */
  t('site.js: يُفعّل النسخة الجديدة بـSKIP_WAITING', /SKIP_WAITING/.test(source) && /function applyUpdate/.test(source));
  t('site.js: يعيد التحميل مرة واحدة فقط', /function reloadOnce/.test(source) && /updateState\.applied/.test(source));
  t('site.js: لا يعيد التحميل أثناء مكالمة', /function callInProgress/.test(source) &&
    /if \(!updateState\.ready \|\| callInProgress\(\)\) return;/.test(source));
  t('site.js: يؤجّل التحديث حتى تنتهي المكالمة', /wt:call-logged/.test(source));
  t('site.js: أمر «تحديث التطبيق ومسح الكاش» في لوحة الأوامر', /sys-update/.test(source) &&
    /CLEAR_CACHES/.test(source) && /clearCachesAndReload/.test(source));
  t('sw.js: يستجيب لـCLEAR_CACHES وSKIP_WAITING', /CLEAR_CACHES/.test(read('sw.js')) && /SKIP_WAITING/.test(read('sw.js')));
  t('site.js: زر الصعود لا يظهر داخل الغرفة عند عدم التمرير', /scrollHeight - global\.innerHeight/.test(source), '');
  t('site.js: إدارة الأخطاء محدودة التكرار', /lastErrorAt/.test(source) && /20000/.test(source), '');
  t('site.js: لا يستخدم eval أو new Function', !/\beval\s*\(|new Function\s*\(/.test(source), '');
}

/* ==================== 4) site.css ==================== */
{
  const css = read('assets/css/site.css');
  for (const selector of ['.wt-palette', '.wt-sheet', '.wt-progress', '.wt-net', '.wt-top', '.wt-skip', '.wt-cmd', '.wt-switch']) {
    t(`site.css: يعرّف ${selector}`, css.includes(selector), '');
  }
  t('site.css: لوحة الألوان الأربعة', ['mint', 'rose', 'azure', 'violet'].every((id) => css.includes(`data-wt-accent="${id}"`)), '');
  t('site.css: تباين عالٍ', /data-wt-contrast="high"/.test(css), '');
  t('site.css: احترام تقليل الحركة', /data-wt-motion="reduce"/.test(css) && /prefers-reduced-motion/.test(css), '');
  t('site.css: تصميم جوال من الأسفل', /max-width: 640px/.test(css) && /border-radius: 22px 22px 0 0/.test(css), '');
  t('site.css: لا استيراد خارجي', !/@import/.test(css), '');
  t('site.css: لا يخفي المحتوى افتراضياً', !/html:not\(\[data-wt-ready\]\)\s+body\s*\{\s*opacity:\s*0/.test(css), '');
}

/* ==================== 5) manifest وأيقونات التطبيق ==================== */
{
  const manifest = JSON.parse(read('manifest.webmanifest'));
  t('manifest: JSON صالح', !!manifest.name && !!manifest.short_name, '');
  t('manifest: عربي واتجاه RTL', manifest.lang === 'ar' && manifest.dir === 'rtl', '');
  t('manifest: تشغيل مستقل', manifest.display === 'standalone', manifest.display);
  t('manifest: نطاق وبداية نسبيان', String(manifest.start_url).startsWith('./') && manifest.scope === './', '');
  t('manifest: ألوان الواجهة', manifest.background_color === '#080C14' && manifest.theme_color === '#080C14', '');
  t('manifest: أيقونة 192 وأيقونة 512 وقناع', ['192x192', '512x512'].every((size) =>
    manifest.icons.some((icon) => icon.sizes === size && icon.purpose === 'any')) &&
    manifest.icons.some((icon) => icon.purpose === 'maskable'), JSON.stringify(manifest.icons));
  t('manifest: اختصارات للتطبيق', Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 2, '');
  const missingIcons = manifest.icons.map((icon) => icon.src).filter((src) => !exists(src));
  t('manifest: ملفات الأيقونات موجودة', missingIcons.length === 0, missingIcons.join(','));

  /* أبعاد PNG من ترويسة IHDR */
  for (const [file, size] of [['assets/icons/icon-192.png', 192], ['assets/icons/icon-512.png', 512], ['assets/icons/apple-touch-icon.png', 180]]) {
    const buffer = fs.readFileSync(path.join(base, file));
    const signature = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    t(`أيقونة ${file}: PNG ${size}×${size}`, signature && width === size && height === size, `${width}×${height}`);
  }
}

/* ==================== 6) service worker وصفحة عدم الاتصال ==================== */
{
  const sw = read('sw.js');
  t('sw.js: صياغة صحيحة (vm)', (() => {
    try { new vm.Script(sw); return true; } catch (e) { return false; }
  })(), '');
  t('sw.js: إصدار كاش مسمّى', /const VERSION = 'wt-v/.test(sw), '');
  t('sw.js: يخزّن كل صفحات الموقع', PAGES.every((page) => sw.includes(`'${page}'`)), '');
  t('sw.js: يخزّن الطبقة المشتركة', sw.includes("'assets/js/site.js'") && sw.includes("'assets/css/site.css'"), '');
  t('sw.js: صفحة عدم الاتصال', sw.includes("'offline.html'") && exists('offline.html'), '');
  t('sw.js: لا يخزّن طلبات غير GET', /request\.method !== 'GET'/.test(sw), '');
  t('sw.js: يتجاوز النطاقات الخارجية (Supabase/الخطوط)', /url\.origin !== self\.location\.origin/.test(sw), '');
  t('sw.js: يحذف الكاش القديم عند التفعيل', /caches\.keys\(\)/.test(sw) && /caches\.delete/.test(sw), '');
  t('sw.js: لا يخزّن ملفات docs أو .mjs', /docs\\\//.test(sw) && /mjs/.test(sw), '');

  const offline = read('offline.html');
  t('offline.html: عربي RTL', /lang="ar"/.test(offline) && /dir="rtl"/.test(offline), '');
  t('offline.html: بلا موارد خارجية', !/(src|href)="https?:/.test(offline), '');
  t('offline.html: زر إعادة المحاولة والعودة', /offlineRetry/.test(offline) && /href="index\.html"/.test(offline), '');
  t('offline.html: يعود تلقائياً عند الاتصال', /addEventListener\('online'/.test(offline) && /location\.href = 'index\.html'/.test(offline), '');
  t('offline.html: يحمل الطبقة المشتركة', /assets\/css\/site\.css/.test(offline), '');
  t('offline.html: لا يُفهرس', /name="robots" content="noindex"/.test(offline), '');
}

/* ==================== 7) لا تعارض مع الخصوصية ==================== */
{
  const site = read('assets/js/site.js');
  t('لا مفاتيح وصول في الطبقة', !/(anonKey|service_role|access_token)\s*[:=]/.test(site), '');
  t('لا تخزين لبيانات شخصية داخل التفضيلات', !/display_name|avatar_path|access_token|user_id/i.test(site), '');
  t('التفضيلات محلية فقط', /localStorage/.test(site) && !/fetch\(/.test(site), '');
  t('بدون تعديل على مخطط قاعدة البيانات', !/(from\(|rpc\(|supabase)/i.test(site), '');
}

/* ==================== 8) التحديث يظهر بعد النشر ==================== */
{
  const sw = read('sw.js');
  const config = read('assets/js/config.js');
  const site = read('assets/js/site.js');
  const pages = fs.readdirSync(base).filter(name => name.endsWith('.html'));

  t('sw.js: الكود يُطلب من الشبكة أولاً', /function isCodeAsset/.test(sw) &&
    /fetch\(request, \{ cache: 'no-cache' \}\)/.test(sw), '');
  t('sw.js: الكاش بديل فقط عند انقطاع الشبكة', /await caches\.match\(request, \{ ignoreSearch: true \}\)/.test(sw) &&
    /status: 504/.test(sw), '');
  t('sw.js: الصور ما زالت من الكاش أولاً', /const cached = await caches\.match\(request\);/.test(sw), '');
  t('sw.js: نسخة الكاش مرفوعة مع هذا التغيير', /VERSION = 'wt-v1\.0\.[2-9]'/.test(sw), '');
  t('config.js: بصمة نشر قابلة للقراءة', /build:\s*'20\d\d-\d\d-\d\d/.test(config), '');
  t('site.js: يعرض بصمة النشر للمستخدم', /buildTag\(\)/.test(site) && /WT_CONFIG\.build/.test(site), '');
  t('لا صفحات تشير إلى نسخة قديمة من config.js', pages.every(name => !read(name).includes('config.js?v=3.1.2')), '');
  t('لا صفحات تشير إلى نسخة قديمة من site.js', pages.every(name => !read(name).includes('site.js?v=1.0.0')), '');
  t('كل صفحة تحمّل config.js تحمّله قبل site.js', pages.filter(name => read(name).includes('config.js')).every(name => {
    const page = read(name);
    return page.indexOf('config.js') < page.indexOf('site.js');
  }), '');
}

console.log(`Site features: ${pass} passed, ${fail} failed${siteTests ? '' : ' (site.js logic skipped)'}`);
if (fail) process.exitCode = 1;

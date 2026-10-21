/* =========================================================
   WatchTogether — service worker (sw.js)
   الغرض: فتح التطبيق بسرعة، وصفحة واضحة عند انقطاع الشبكة.
   المبدأ: الشبكة أولاً دائماً للصفحات — لا محتوى قديم يخدعك.
   لا تُخزَّن أي طلبات مصادقة أو قاعدة بيانات أو وسائط مرفوعة.
   ========================================================= */
'use strict';

const VERSION = 'wt-v1.0.0';
const SHELL = VERSION + '-shell';
const RUNTIME = VERSION + '-runtime';
const OFFLINE_URL = 'offline.html';

const PRECACHE = [
  'index.html',
  'room.html',
  'auth.html',
  'profile.html',
  'friends.html',
  'messages.html',
  OFFLINE_URL,
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/css/site.css',
  'assets/css/home.css',
  'assets/css/social.css',
  'assets/css/media.css',
  'assets/css/features.css',
  'assets/js/prefs.js',
  'assets/js/site.js',
  'assets/js/config.js',
  'assets/js/util.js',
  'assets/js/icons.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /* كل ملف على حدة: ملف مفقود لا يُفشل التثبيت بأكمله */
    await Promise.all(PRECACHE.map(async (file) => {
      try {
        const response = await fetch(new Request(file, { cache: 'reload' }));
        if (response && response.ok) await cache.put(file, response);
      } catch (e) { /* نتجاهل المفقود */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== SHELL && name !== RUNTIME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (/\/docs\//.test(url.pathname)) return false;
  if (/\.(sql|mjs|sh|bat|md)$/i.test(url.pathname)) return false;
  return /\.(css|js|png|jpg|jpeg|webp|svg|woff2?|ttf|json|webmanifest)$/i.test(url.pathname);
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;                       /* لا نلمس أي إرسال/تعديل */
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            /* Supabase والخطوط والوسائط تمر مباشرة */
  if (url.pathname.endsWith('/sw.js')) return;

  if (isNavigation(request)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME);
        cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch (e) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await caches.match(OFFLINE_URL, { ignoreSearch: true });
        if (shell) return shell;
        return new Response(
          '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">' +
          '<title>غير متصل — WatchTogether</title>' +
          '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080C14;color:#E8DCC6;font-family:Cairo,system-ui,sans-serif;text-align:center;padding:24px">' +
          '<div><h1 style="font-size:20px">لا يوجد اتصال بالإنترنت</h1>' +
          '<p style="color:#9AA8B8;font-size:14px">تحقّق من الشبكة ثم أعد المحاولة.</p>' +
          '<a href="index.html" style="display:inline-block;margin-top:12px;padding:10px 18px;border-radius:12px;background:#C5A572;color:#141006;font-weight:800;text-decoration:none">العودة للغرف</a></div></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (!isCacheableAsset(url)) return;

  /* الأصول الثابتة: أعطِ الكاش فوراً ثم حدّثه في الخلفية.
     الكاش بالمفتاح الكامل (مع ?v=) حتى يظهر أي إصدار جديد فوراً. */
  const network = fetch(request).then((response) => {
    if (response && response.ok) {
      caches.open(RUNTIME).then((cache) => cache.put(request, response.clone())).catch(() => {});
    }
    return response;
  }).catch(() => null);
  event.waitUntil(network.then(() => {}));
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fresh = await network;
    if (fresh) return fresh;
    return new Response('', { status: 504, statusText: 'غير متصل' });
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))));
  }
});

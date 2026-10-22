// =========================================================
// WatchTogether — وسيط TURN على Supabase Edge Functions (wt-turn)
//
// ⚠️ هذا الملف هو **نفسه** المنشور على المشروع cazwkhcbkzhnsluuafwz
//    باسم wt-turn (verify_jwt = false). عدّله هنا ثم أعد النشر:
//      supabase functions deploy wt-turn --no-verify-jwt
//    أو عبر API (موصل Supabase): update_edge_function.
//
// الغاية: أن يأخذ المتصفح بيانات TURN من خادمك أنت، فلا يظهر أي مفتاح
// في ملف يُشحن للزوّار (config.js / turn.local.js).
//
// الأسرار — Supabase → Edge Functions → Secrets (لا في المستودع أبداً):
//   ALLOWED_ORIGIN = أصول مفصولة بفاصلة، بلا / في الآخر.
//                    قائمة فارغة = رفض الكل (لا «*» في الإنتاج).
//   ── الوضع 1 (الأفضل: بيانات مؤقتة تنتهي صلاحيتها) ──
//   METERED_APP    = اسم تطبيقك في Metered
//   METERED_KEY    = مفتاح API من لوحة Metered
//   ── الوضع 2 (بديل إن لم يكن عندك مفتاح API) ──
//   TURN_STATIC    = [{"urls":"turn:global.relay.metered.ca:80","username":"…","credential":"…"}]
//
// ترتيب القراءة: الوضع 1 ثم الوضع 2 ثم 503 بخطأ واضح (لا نجاح فارغ).
// بيانات العميل:  calls.turnFetchUrl =
//   'https://<project-ref>.supabase.co/functions/v1/wt-turn'
// =========================================================

const ALLOW_HEADERS = 'content-type, authorization, apikey, x-client-info';
const ALLOW_METHODS = 'POST, OPTIONS';

/** الأصول المسموح لها بالطلب. قائمة فارغة = ارفض الكل (لا «*» في الإنتاج). */
function allowedOrigins() {
  return String(Deno.env.get('ALLOWED_ORIGIN') || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** أصل الاستجابة: نردّ بأصل الطالب نفسه إن كان في القائمة، وإلا فلا ترويسة. */
function corsHeaders(request) {
  const list = allowedOrigins();
  const origin = request.headers.get('origin') || '';
  const ok = !!origin && list.indexOf(origin.replace(/\/+$/, '')) >= 0;
  const headers = {
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (ok) headers['Access-Control-Allow-Origin'] = origin;
  return { headers, ok };
}

function json(request, payload, status) {
  const cors = corsHeaders(request);
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors.headers);
  return new Response(JSON.stringify(payload), { status: status || 200, headers });
}

/** حدّ بسيط لكل IP في الذاكرة (يكفي للنسخة الأولى) */
const hits = new Map();
function rateLimited(ip, limit, windowMs) {
  limit = limit || 30; windowMs = windowMs || 60000;
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count += 1;
  hits.set(ip, entry);
  if (hits.size > 5000) hits.clear();
  return entry.count > limit;
}

/** تطبيع أي صيغة إلى مصفوفة {urls,username,credential} — نفس ما يقبله calls.js */
function normalize(raw) {
  const entries = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray(raw.iceServers)) ? raw.iceServers
    : raw ? [raw] : [];
  return entries.map((entry) => {
    const e = entry || {};
    const urls = e.urls || e.url;
    if (!urls) return null;
    return { urls, username: String(e.username || ''), credential: String(e.credential || e.password || '') };
  }).filter(Boolean);
}

/** كاش 60 ثانية للوضع 1: يقلّل ضغط المزوّد ويُسرّع بدء المكالمة */
let cache = null;
const CACHE_MS = 60000;

async function fromMetered() {
  const app = Deno.env.get('METERED_APP');
  const key = Deno.env.get('METERED_KEY');
  if (!app || !key) return { status: 0, body: null };
  if (cache && Date.now() - cache.at < CACHE_MS) return { status: 200, body: cache.body };

  const url = 'https://' + encodeURIComponent(app) + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(key);
  let upstream;
  try {
    upstream = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (_) {
    return { status: 502, body: { error: 'turn provider unreachable' } };
  }
  if (!upstream.ok) return { status: 502, body: { error: 'turn provider rejected' } };

  let parsed;
  try { parsed = await upstream.json(); } catch (_) { return { status: 502, body: { error: 'invalid provider response' } }; }
  const list = normalize(parsed);
  if (!list.length) return { status: 502, body: { error: 'provider returned no servers' } };
  cache = { at: Date.now(), body: list };
  return { status: 200, body: list };
}

function fromStatic() {
  const raw = Deno.env.get('TURN_STATIC');
  if (!raw) return { status: 0, body: null };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { status: 500, body: { error: 'TURN_STATIC is not valid JSON' } }; }
  const list = normalize(parsed);
  if (!list.length) return { status: 500, body: { error: 'TURN_STATIC has no usable servers' } };
  return { status: 200, body: list };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    const cors = corsHeaders(request);
    return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
  }
  if (request.method !== 'POST') return json(request, { error: 'method not allowed' }, 405);

  /* الأصل أولاً: بلا أصل معروف لا نصل إلى المزوّد أصلاً */
  const cors = corsHeaders(request);
  if (!cors.ok) return json(request, { error: 'origin not allowed' }, 403);

  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (rateLimited(ip)) return json(request, { error: 'too many requests' }, 429);

  const metered = await fromMetered();
  if (metered.status === 200) return json(request, metered.body, 200);
  if (metered.status >= 500) return json(request, metered.body, metered.status);

  const stat = fromStatic();
  if (stat.status === 200) return json(request, stat.body, 200);
  if (stat.status >= 500) return json(request, stat.body, stat.status);

  /* لا مفتاح API ولا بيانات ثابتة: نقولها بصراحة بدل حالة نجاح فارغة */
  return json(request, {
    error: 'server not configured',
    hint: 'اضبط METERED_APP + METERED_KEY، أو TURN_STATIC، في أسرار Edge Functions'
  }, 503);
});

// =========================================================
// WatchTogether — وسيط TURN على Supabase Edge Functions
// النشر:
//   supabase functions deploy turn --no-verify-jwt
//   supabase secrets set METERED_APP=yourapp METERED_KEY=xxxx ALLOWED_ORIGIN=https://your-site.com
// بيانات العميل:  calls.turnFetchUrl = 'https://<project-ref>.supabase.co/functions/v1/turn'
// لا تضع المفتاح في config.js — هذا الملف يبقى على الخادم.
// =========================================================

const ALLOW_HEADERS = 'content-type, authorization, apikey, x-client-info';
const ALLOW_METHODS = 'POST, OPTIONS';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders())
  });
}

/** حدّ بسيط لكل IP في الذاكرة (يكفي للنسخة الأولى) */
const hits = new Map();
function rateLimited(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count += 1;
  hits.set(ip, entry);
  if (hits.size > 5000) hits.clear();
  return entry.count > limit;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (rateLimited(ip)) return json({ error: 'too many requests' }, 429);

  const app = Deno.env.get('METERED_APP');
  const key = Deno.env.get('METERED_KEY');
  if (!app || !key) return json({ error: 'server not configured' }, 500);

  const url = `https://${encodeURIComponent(app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;
  let upstream;
  try {
    upstream = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (_) {
    return json({ error: 'turn provider unreachable' }, 502);
  }
  if (!upstream.ok) return json({ error: 'turn provider rejected' }, 502);

  const text = await upstream.text();
  return new Response(text, {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders())
  });
});

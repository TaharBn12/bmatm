// =========================================================
// WatchTogether — وسيط TURN على Cloudflare Workers
// النشر:
//   wrangler secret put METERED_APP       # اسم التطبيق من لوحة Metered
//   wrangler secret put METERED_KEY       # مفتاح TURN REST API
//   wrangler secret put ALLOWED_ORIGIN    # https://your-site.com
//   wrangler deploy
// بيانات العميل: calls.turnFetchUrl = 'https://<worker>.workers.dev/turn'
// =========================================================

const HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'Vary': 'Origin'
};

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin || '*'
    }, HEADERS)
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Origin': origin }, HEADERS) });
    }
    if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405, origin);
    if (!env.METERED_APP || !env.METERED_KEY) return reply({ error: 'server not configured' }, 500, origin);

    const url = 'https://' + encodeURIComponent(env.METERED_APP) + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(env.METERED_KEY);
    let upstream;
    try { upstream = await fetch(url, { headers: { Accept: 'application/json' } }); }
    catch (e) { return reply({ error: 'turn provider unreachable' }, 502, origin); }
    if (!upstream.ok) return reply({ error: 'turn provider rejected' }, 502, origin);

    return new Response(await upstream.text(), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin }, HEADERS)
    });
  }
};

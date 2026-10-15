#!/usr/bin/env node
/* =========================================================
   WatchTogether — أداة سيرفر Supabase (sbctl)
   ---------------------------------------------------------
   الغرض: إنشاء «سيرفر جديد» على Supabase، فحصه، وربطه بالموقع بأمر واحد.

   الأوامر:
     node tools/sbctl.mjs status
         حالة السيرفر المهيّأ حالياً في assets/js/config.js

     node tools/sbctl.mjs doctor [--url U] [--key K] [--json]
         فحص شامل: REST + الجداول + RLS + Realtime + اختبار كتابة/قراءة

     node tools/sbctl.mjs set --url U --key K
         تبديل المشروع في config.js + رفع رقم الكاش (?v=) في الصفحات

     node tools/sbctl.mjs create --name N --org-id ID --db-password PW
                        [--region R] [--plan free] [--dry-run] [--no-sql]
         إنشاء مشروع Supabase جديد عبر Management API، تنفيذ مخطط القاعدة،
         جلب مفتاح anon، وربطه بالموقع تلقائياً.
         (يحتاج: SUPABASE_ACCESS_TOKEN في متغيّر البيئة)

     node tools/sbctl.mjs sql [--out FILE]
         طباعة (أو حفظ) ملف SQL الجاهز لمشروع جديد

     node tools/sbctl.mjs smoke [--room CODE] [--url U] [--key K]
         اختبار حي: ينشئ غرفة، يكتب حالة، يقرأها، يحذفها

   لا تحتاج أي مكتبة خارجية — Node 18+ فقط.
   ========================================================= */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'assets/js/config.js');
const HTML_FILES = ['index.html', 'room.html', 'auth.html'];
const API = 'https://api.supabase.com/v1';

/* =========================================================
   أدوات مساعدة
   ========================================================= */
const C = {
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  b: s => `\x1b[36m${s}\x1b[0m`,
  d: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`
};

export function log(...a) { console.log(...a); }
function ok(t) { return C.g('✓ ' + t); }
function bad(t) { return C.r('✗ ' + t); }
function warn(t) { return C.y('! ' + t); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/** استخراج إعداد Supabase من config.js بدون تنفيذ الملف */
export function readConfig(file = CONFIG_PATH) {
  const src = fs.readFileSync(file, 'utf8');
  const block = (src.match(/supabase:\s*\{([\s\S]*?)\n\s*\}/) || [, ''])[1];
  const pick = (re) => (block.match(re) || [, ''])[1].trim();
  return {
    url: pick(/url:\s*'([^']*)'/),
    anonKey: pick(/anonKey:\s*'([^']*)'/),
    ready: !/ready:\s*false/.test(block),
    auth: !/auth:\s*false/.test(block),
    raw: src
  };
}

/** كتابة الإعدادات الجديدة في config.js (بشكل آمن — نعدّل نصوصاً فقط) */
export function writeConfig({ url, anonKey, ready = true }, file = CONFIG_PATH) {
  let src = fs.readFileSync(file, 'utf8');
  if (url) {
    src = src.replace(/(supabase:\s*\{[\s\S]*?url:\s*)'[^']*'/,
      (_m, p1) => `${p1}'${url}'`);
  }
  if (anonKey) {
    src = src.replace(/(supabase:\s*\{[\s\S]*?anonKey:\s*)'[^']*'/,
      (_m, p1) => `${p1}'${anonKey}'`);
  }
  if (ready === true) src = src.replace(/(supabase:\s*\{[\s\S]*?ready:\s*)false/, '$1true');
  fs.writeFileSync(file, src, 'utf8');
  return readConfig(file);
}

/** رفع رقم إصدار الكاش (?v=) في كل الصفحات حتى لا يعرض المتصفح نسخة قديمة */
export function bumpVersion(version, root = ROOT) {
  const changed = [];
  HTML_FILES.forEach((f) => {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) return;
    const before = fs.readFileSync(p, 'utf8');
    const after = before.replace(/\?v=\d+\.\d+\.\d+/g, `?v=${version}`);
    if (after !== before) { fs.writeFileSync(p, after, 'utf8'); changed.push(f); }
  });
  return changed;
}

/** نسخة المشروع بدون تشويش */
export function shortRef(url) {
  const m = String(url || '').match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : (url || '—');
}

/* =========================================================
   الفحص (doctor)
   ========================================================= */
async function restGet(url, key, pathStr, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url.replace(/\/$/, '') + pathStr, {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      signal: ctrl.signal
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    return { ok: r.ok, status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function restPost(url, key, pathStr, payload, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url.replace(/\/$/, '') + pathStr, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    return { ok: r.ok, status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

/** هل ردّ الخادم بسبب الجداول أم بسبب المفتاح؟ */
function explain(r) {
  if (r.ok) return null;
  const code = r.body && r.body.code ? String(r.body.code) : '';
  const msg = (r.body && (r.body.message || r.body.error)) || r.error || ('HTTP ' + r.status);
  /* عمود مفقود (PGRST204): «Could not find the 'body' column of 'messages' in the schema cache» */
  const missCol = String(msg).match(/could not find the '([^']+)' column of '([^']+)'/i);
  if (missCol || code === 'PGRST204') {
    const col = missCol ? missCol[1] : '؟';
    const tbl = missCol ? missCol[2] : 'messages';
    return {
      code: 'schema-mismatch', column: col, table: tbl,
      title: 'عمود «' + col + '» غير موجود في جدول ' + tbl,
      detail: 'جدول موجود بنسخة قديمة من المخطط (أو كاش PostgREST قديم).',
      fix: 'نفّذ docs/repair-messages.sql في SQL Editor، ثم: NOTIFY pgrst, \'reload schema\';'
    };
  }
  if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(String(msg))) {
    return { code: 'missing-table', title: 'الجداول غير موجودة', fix: 'نفّذ docs/bootstrap.sql في SQL Editor' };
  }
  if (code === '42501') {
    return { code: 'rls', title: 'صلاحيات RLS ناقصة', fix: 'أعد تنفيذ docs/bootstrap.sql (منح الصلاحيات + السياسات)' };
  }
  if (r.status === 401 || r.status === 403 || /invalid api key|jwt/i.test(String(msg))) {
    return { code: 'bad-key', title: 'مفتاح anon غير صالح', fix: 'انسخ anon public key الجديد من Project Settings → API' };
  }
  if (r.status === 404) {
    return { code: 'bad-url', title: 'عنوان المشروع غير صحيح', fix: 'تأكد من Project URL' };
  }
  if (r.status >= 500) {
    return { code: 'project-down', title: 'المشروع متوقف أو مشغول', fix: 'Resume من Dashboard أو أنشئ مشروعاً جديداً' };
  }
  if (r.status === 0) {
    return { code: 'network', title: 'لا يوجد اتصال', fix: 'تحقق من الإنترنت/الوكيل/البلوك' };
  }
  return { code: 'unknown', title: 'خطأ غير معروف', fix: String(msg) };
}

/** مصافحة Realtime (نفس ما يفعله المتصفح) */
async function probeRealtime(url, key, timeoutMs = 6000) {
  if (typeof WebSocket === 'undefined') {
    return { ok: false, error: 'WebSocket غير متاح في هذا Node', skipped: true };
  }
  const wsUrl = url.replace(/\/$/, '').replace(/^http/, 'ws') +
    '/realtime/v1/websocket?apikey=' + encodeURIComponent(key) + '&vsn=1.0.0';
  const t0 = Date.now();
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) { return resolve({ ok: false, error: String(e && e.message || e), ms: 0 }); }
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch (e) { } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'انتهت المهلة', ms: Date.now() - t0 }), timeoutMs);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          topic: 'wt:diag', event: 'phx_join', ref: '1',
          payload: { config: { broadcast: { self: false }, presence: { key: 'diag' } } }
        }));
      } catch (e) { }
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === 'phx_reply' && msg.payload) {
        clearTimeout(timer);
        if (msg.payload.status === 'ok') finish({ ok: true, ms: Date.now() - t0, error: null });
        else finish({
          ok: false, ms: Date.now() - t0,
          error: (msg.payload.response && msg.payload.response.message) || 'رُفض الانضمام'
        });
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'فشل اتصال Realtime', ms: Date.now() - t0 }); };
    ws.onclose = () => { clearTimeout(timer); finish({ ok: false, error: 'أُغلق اتصال Realtime', ms: Date.now() - t0 }); };
  });
}

/**
 * فحص شامل لمشروع Supabase.
 * @returns {Promise<object>} تقرير
 */
export async function doctorProject({ url, anonKey, realtime = true, write = false }) {
  const report = {
    url, ref: shortRef(url),
    at: new Date().toISOString(),
    rest: null, tables: {}, realtime: null, write: null,
    problems: [], warnings: [], ok: false
  };

  if (!url || !anonKey) {
    report.problems.push({
      code: 'not-configured', title: 'لا يوجد مشروع مهيّأ',
      fix: 'شغّل: node tools/sbctl.mjs set --url <URL> --key <KEY>'
    });
    return report;
  }

  /* 1) REST + جدول الغرف */
  const r1 = await restGet(url, anonKey, '/rest/v1/rooms?select=room_id&limit=1');
  report.rest = { ok: r1.ok, status: r1.status, ms: r1.ms };
  report.tables.rooms = r1.ok;
  if (!r1.ok) {
    const e = explain(r1);
    report.problems.push(e);
    report.rest.error = e;
    report.coreOk = false;
    report.ok = false;
    return report;
  }

  /* 2) بقية الجداول */
  for (const t of ['messages', 'presence', 'room_members', 'room_queue']) {
    const r = await restGet(url, anonKey, `/rest/v1/${t}?select=*&limit=1`);
    report.tables[t] = r.ok;
    if (!r.ok) {
      const e = explain(r);
      (t === 'presence' ? report.warnings : report.problems).push(
        Object.assign({ table: t }, e)
      );
    }
  }

  /* 2ب) عمود نصّ الرسالة: أشهر سبب لتعطّل الدردشة (PGRST204 — body column missing) */
  if (report.tables.messages) {
    const field = await restGet(url, anonKey, '/rest/v1/messages?select=body&limit=1');
    if (field.ok) {
      report.messageField = 'body';
    } else {
      /* العمود اسمه غير body؟ اكتشف الاسم الفعلي من صفّ حقيقي */
      const probe = await restGet(url, anonKey, '/rest/v1/messages?select=*&limit=1');
      const cols = Array.isArray(probe.body) && probe.body[0] ? Object.keys(probe.body[0]) : [];
      const alt = cols.find(c => ['text', 'message', 'content', 'msg'].includes(String(c).toLowerCase())) || null;
      report.messageField = alt;
      report.problems.push(Object.assign({}, explain(field), {
        code: 'schema-mismatch', column: 'body', table: 'messages',
        title: alt
          ? 'جدول messages قديم: العمود «' + alt + '» بدل «body»'
          : 'عمود body مفقود في جدول messages',
        detail: alt
          ? 'الدردشة في الموقع لن تعمل حتى يتطابق الجدول مع المخطط (العميل يتكيّف مؤقتاً لكن الأفضل الإصلاح).'
          : 'لا يمكن للدردشة الكتابة في الجدول بلا عمود نصّ مطابق.',
        fix: 'نفّذ docs/repair-messages.sql في SQL Editor (يُعيد تسمية/يضيف العمود ثم NOTIFY pgrst, \'reload schema\')'
      }));
    }
  }

  /* 3) Realtime */
  if (realtime) {
    const rt = await probeRealtime(url, anonKey);
    report.realtime = rt;
    if (!rt.ok) {
      report.warnings.push({
        code: 'realtime-down', title: 'Realtime لا يستجيب',
        detail: rt.error || '',
        fix: 'تأكد أن rooms و messages و room_members و room_queue مُضافة إلى منشور supabase_realtime (docs/bootstrap.sql).'
      });
    }
  } else {
    report.realtime = { skipped: true };
  }

  /* 4) اختبار كتابة/قراءة عبر واجهة RPC الآمنة، ثم حذف غرفة الاختبار */
  if (write) {
    const code = 'TEST' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const ownerToken = randomBytes(32).toString('hex');
    const clientId = 'sbctl-' + code;
    const state = { url: '', kind: '', playing: false, pos: 42.5, t: Date.now(), rev: 0, updatedBy: clientId, updatedByName: 'فحص' };
    const created = await restPost(url, anonKey, '/rest/v1/rpc/wt_create_room', {
      p_room_id: code, p_title: 'فحص اتصال', p_video_url: null, p_owner_token: ownerToken, p_owner_name: 'فحص'
    });
    let joined = { ok: false, status: 0, body: null };
    let applied = { ok: false, status: 0, body: null };
    if (created.ok) {
      joined = await restPost(url, anonKey, '/rest/v1/rpc/wt_join_room', {
        p_room_id: code, p_client_id: clientId, p_member_token: ownerToken, p_display_name: 'فحص'
      });
      if (joined.ok) applied = await restPost(url, anonKey, '/rest/v1/rpc/wt_apply_room_state', {
        p_room_id: code, p_client_id: clientId, p_member_token: ownerToken, p_state: state
      });
    }
    const back = await restGet(url, anonKey, `/rest/v1/rooms?room_id=eq.${code}&select=room_id,state`);
    const row = Array.isArray(back.body) ? back.body[0] : null;
    const removed = created.ok ? await restPost(url, anonKey, '/rest/v1/rpc/wt_delete_room', {
      p_room_id: code, p_owner_token: ownerToken
    }) : { ok: false, status: created.status };
    const stateOk = !!(row && row.state && Number(row.state.pos) === 42.5);
    const ok = created.ok && joined.ok && applied.ok && stateOk && removed.ok;
    const firstError = !created.ok ? created : !joined.ok ? joined : !applied.ok ? applied : !stateOk ? back : !removed.ok ? removed : null;
    report.write = {
      ok, room: code, status: (firstError || created).status,
      cleanupOk: removed.ok,
      detail: ok ? 'إنشاء الغرفة والتحقق من الدور وكتابة الحالة وقراءتها وحذفها تعمل ✓'
        : (firstError ? (explain(firstError) || {}).title || 'فشل جزء من اختبار RPC' : 'حالة الاختبار لم تُقرأ كما كُتبت')
    };
    if (!report.write.ok) {
      report.problems.push({
        code: 'write-failed', title: 'اختبار RPC الكتابة/القراءة فشل',
        detail: report.write.detail,
        fix: 'نفّذ docs/bootstrap.sql وتأكد من صلاحيات anon على دوال wt_create_room و wt_join_room و wt_apply_room_state و wt_delete_room.'
      });
    }
  }

  report.coreOk = report.rest.ok === true && report.tables.rooms === true && report.tables.room_members === true;
  report.ok = report.coreOk && report.problems.length === 0;
  return report;
}

/** عرض التقرير بالعربية */
export function renderReport(r) {
  const lines = [];
  lines.push('');
  lines.push(C.bold('  🔎 تقرير فحص Supabase'));
  lines.push('  ' + C.d('المشروع: ' + r.ref + '   ' + r.at));
  lines.push('  ' + C.d('العنوان: ' + r.url));
  lines.push('');
  lines.push('  ' + (r.rest && r.rest.ok
    ? ok(`REST يستجيب (${r.rest.ms}ms)`)
    : bad('REST لا يستجيب' + (r.rest && r.rest.error ? ' — ' + r.rest.error.title : ''))));
  lines.push('  ' + (r.tables.rooms ? ok('جدول rooms موجود') : bad('جدول rooms مفقود')));
  lines.push('  ' + (r.tables.messages
    ? (r.messageField === 'body'
      ? ok('جدول messages موجود (العمود body سليم)')
      : warn('جدول messages موجود لكن العمود «' + (r.messageField || 'body') + '» غير مطابق للمخطط'))
    : bad('جدول messages مفقود (الدردشة لن تعمل)')));
  lines.push('  ' + (r.tables.room_members ? ok('جدول room_members موجود (الأدوار)') : bad('جدول room_members مفقود (التحكم الآمن لن يعمل)')));
  lines.push('  ' + (r.tables.room_queue ? ok('جدول room_queue موجود (القائمة المشتركة)') : bad('جدول room_queue مفقود')));
  lines.push('  ' + (r.tables.presence ? ok('جدول presence موجود') : warn('جدول presence القديم مفقود (اختياري)')));
  if (r.realtime && !r.realtime.skipped) {
    lines.push('  ' + (r.realtime.ok ? ok(`Realtime يعمل (${r.realtime.ms}ms)`) : warn('Realtime لا يعمل — ' + (r.realtime.error || ''))));
  }
  if (r.write) {
    lines.push('  ' + (r.write.ok ? ok('الكتابة والقراءة في القاعدة تعملان ✓') : bad('الكتابة فشلت — ' + r.write.detail)));
  }
  lines.push('');
  if (r.problems.length) {
    lines.push(C.r('  المشاكل:'));
    r.problems.forEach(p => {
      lines.push('   • ' + C.bold(p.title) + (p.detail ? C.d(' — ' + p.detail) : ''));
      if (p.fix) lines.push('     ' + C.g('الحل: ' + p.fix));
    });
    lines.push('');
  }
  if (r.warnings.length) {
    lines.push(C.y('  تحذيرات:'));
    r.warnings.forEach(p => {
      lines.push('   • ' + C.bold(p.title) + (p.detail ? C.d(' — ' + p.detail) : ''));
      if (p.fix) lines.push('     ' + C.g('الحل: ' + p.fix));
    });
    lines.push('');
  }
  if (r.ok) lines.push('  ' + C.g('النتيجة: المشروع صالح ✓ (كل الميزات تعمل)'));
  else if (r.coreOk) lines.push('  ' + C.y('النتيجة: المشروع يعمل (المزامنة ✓) لكن ينقصه إصلاح بسيط — انظر الملاحظات'));
  else lines.push('  ' + C.r('النتيجة: المشروع لا يعمل ✗ (الغرفة لن تتصل)'));
  lines.push('');
  return lines.join('\n');
}

/* =========================================================
   إنشاء مشروع جديد (Management API)
   ========================================================= */
function mgmtHeaders(token) {
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}

async function mgmt(method, p, token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(API + p, {
      method,
      headers: mgmtHeaders(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) {
      const msg = (data && (data.message || data.error_description || data.error)) || ('HTTP ' + r.status);
      const e = new Error('Management API: ' + msg);
      e.status = r.status; e.data = data;
      throw e;
    }
    return data;
  } finally { clearTimeout(timer); }
}

/** جلب مفتاح anon من استجابة api-keys (صيغتان مختلفتان بين الإصدارات) */
export function pickAnonKey(data) {
  if (!data) return null;
  const list = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : [data]);
  for (const k of list) {
    if (!k) continue;
    const type = String(k.type || k.name || '').toLowerCase();
    if (type === 'anon' || type === 'anon public') return k.api_key || k.key || k.anon_key || null;
  }
  for (const k of list) {
    if (k && (k.anon_key || k.anonKey)) return k.anon_key || k.anonKey;
  }
  return null;
}

export function bootstrapSql(root = ROOT) {
  const p = path.join(root, 'docs/bootstrap.sql');
  return fs.readFileSync(p, 'utf8');
}

/** ملف إصلاح جدول الرسائل (خطأ PGRST204: العمود body غير موجود) */
export function repairSql(root = ROOT) {
  const p = path.join(root, 'docs/repair-messages.sql');
  return fs.readFileSync(p, 'utf8');
}

async function cmdCreate(args) {
  const token = process.env.SUPABASE_ACCESS_TOKEN || args.token;
  const name = args.name || 'watchtogether-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const orgId = args['org-id'] || args.org;
  const dbPass = args['db-password'] || args.pass;
  const region = args.region || 'eu-central-1';
  const plan = args.plan || 'free';

  log('');
  log(C.bold('  🚀 إنشاء سيرفر Supabase جديد'));
  log('  ' + C.d('الاسم: ' + name + '   المنطقة: ' + region + '   الخطة: ' + plan));
  log('');

  if (!token) {
    log(C.r('  ✗ لا يوجد رمز وصول (SUPABASE_ACCESS_TOKEN).'));
    log('');
    log('  لإنشاء الرمز: supabase.com → Account → Access Tokens → Generate New Token');
    log('  ثم:');
    log('');
    log('     export SUPABASE_ACCESS_TOKEN="sbp_..."');
    log('     node tools/sbctl.mjs create --name "' + name + '" \\');
    log('        --org-id <ORGANIZATION_ID> --db-password "<كلمة مرور قوية>"');
    log('');
    log('  ' + C.d('بدون رمز؟ اتبع المسار اليدوي: docs/new-supabase-server.md'));
    log('');
    return 1;
  }
  if (!orgId) { log(C.r('  ✗ حدّد --org-id (معرّف المؤسسة من supabase.com/dashboard/organizations).')); return 1; }
  if (!dbPass) { log(C.r('  ✗ حدّد --db-password (كلمة مرور قاعدة البيانات، 8 أحرف على الأقل).')); return 1; }

  if (args['dry-run']) {
    log(C.y('  (وضع التجربة — لن يُنشأ شيء)'));
    log(C.d('  POST ' + API + '/projects  { name, organization_id, region, plan, db_pass }'));
    log(C.d('  ثم:  POST ' + API + '/projects/{ref}/database/query  (bootstrap.sql)'));
    log(C.d('  ثم:  GET  ' + API + '/projects/{ref}/api-keys  → anon key'));
    log(C.d('  ثم:  كتابة assets/js/config.js + رفع ?v= في الصفحات'));
    log('');
    return 0;
  }

  /* 1) إنشاء المشروع */
  log('  … إنشاء المشروع (قد يستغرق دقيقة)');
  let project;
  try {
    project = await mgmt('POST', '/projects', token, {
      organization_id: orgId, name, db_pass: dbPass, region, plan
    });
  } catch (e) {
    log(C.r('  ✗ فشل إنشاء المشروع: ' + e.message));
    return 1;
  }
  const ref = project.ref || project.id;
  log(ok('أُنشئ المشروع: ' + ref));

  /* 2) انتظار جهوزية المشروع */
  log('  … انتظار جهوزية قاعدة البيانات');
  let status = project.status;
  for (let i = 0; i < 40; i++) {
    if (status === 'ACTIVE' || status === 'active' || status === 'HEALTHY') break;
    await new Promise(r => setTimeout(r, 3000));
    try {
      const p = await mgmt('GET', '/projects/' + ref, token);
      status = p.status;
      if (p.database && p.database.version) { /* جاهز */ }
    } catch (e) { /* لا بأس */ }
  }
  if (status && !/ACTIVE|HEALTHY/i.test(String(status))) {
    log(warn('المشروع ما زال بحالة: ' + status + ' — قد يستغرق وقتاً. أعد الفحص لاحقاً: sbctl.mjs doctor'));
  }

  /* 3) تنفيذ مخطط القاعدة */
  const url = 'https://' + ref + '.supabase.co';
  if (!args['no-sql']) {
    log('  … تنفيذ docs/bootstrap.sql');
    try {
      await mgmt('POST', `/projects/${ref}/database/query`, token, { query: bootstrapSql() });
      log(ok('تم إنشاء الجداول والسياسات وربط Realtime'));
    } catch (e) {
      log(C.r('  ✗ فشل تنفيذ المخطط: ' + e.message));
      log(C.d('    نفّذ docs/bootstrap.sql يدوياً من SQL Editor.'));
    }
  }

  /* 4) جلب مفتاح anon */
  let anonKey = null;
  for (let i = 0; i < 10; i++) {
    try {
      const keys = await mgmt('GET', `/projects/${ref}/api-keys`, token);
      anonKey = pickAnonKey(keys);
    } catch (e) { /* لا بأس */ }
    if (anonKey) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!anonKey) {
    log(C.r('  ✗ لم أجد مفتاح anon — انسخه يدوياً من Project Settings → API'));
    return 1;
  }

  /* 5) ربط المشروع بالموقع */
  writeConfig({ url, anonKey, ready: true });
  const changed = bumpVersion(args.version || DEFAULT_VERSION);
  log(ok('تم تحديث assets/js/config.js'));
  log(C.d('    ' + url));
  log(C.d('    anon: ' + anonKey.slice(0, 12) + '…' + anonKey.slice(-6)));
  if (changed.length) log(C.d('    رقم الكاش: ' + changed.join('، ')));

  /* 6) فحص نهائي */
  const report = await doctorProject({ url, anonKey, write: true });
  log(renderReport(report));
  return report.ok ? 0 : 1;
}

/* =========================================================
   الأوامر
   ========================================================= */
async function cmdStatus(args) {
  const cfg = readConfig();
  log('');
  log(C.bold('  ⚙️  السيرفر المهيّأ حالياً'));
  log('  ' + C.d('الملف: assets/js/config.js'));
  log('  ' + (cfg.url ? ok('العنوان: ' + cfg.url) : bad('العنوان: —')));
  log('  ' + (cfg.anonKey ? ok('المفتاح: ' + cfg.anonKey.slice(0, 12) + '…' + cfg.anonKey.slice(-6)) : bad('المفتاح: —')));
  log('  ' + (cfg.ready ? ok('ready: true (محاولة الاتصال)') : warn('ready: false (المزامنة معطّلة)')));
  log('  ' + (cfg.auth ? ok('auth: true (صفحة الدخول مفعّلة)') : warn('auth: false')));
  log('');
  log(C.d('  لتبديل المشروع:  node tools/sbctl.mjs set --url <URL> --key <KEY>'));
  log(C.d('  لفحصه:          node tools/sbctl.mjs doctor'));
  log('');
  return 0;
}

async function cmdDoctor(args) {
  const cfg = readConfig();
  const url = args.url || cfg.url;
  const key = args.key || cfg.anonKey;
  const report = await doctorProject({
    url, anonKey: key,
    realtime: args.realtime !== 'false' && args['no-realtime'] !== true,
    write: args.write !== 'false' && args['no-write'] !== true
  });
  if (args.json) log(JSON.stringify(report, null, 2));
  else log(renderReport(report));
  return report.ok ? 0 : 1;
}

async function cmdSet(args) {
  const url = args.url;
  const key = args.key;
  if (!url || !key) {
    log(C.r('  ✗ الاستعمال: node tools/sbctl.mjs set --url <Project URL> --key <anon public key>'));
    return 1;
  }
  const cfg = writeConfig({ url, anonKey: key, ready: true });
  const changed = bumpVersion(args.version || DEFAULT_VERSION);
  log('');
  log(ok('تم تحديث assets/js/config.js'));
  log('  ' + C.d('العنوان: ' + cfg.url));
  log('  ' + C.d('المفتاح: ' + cfg.anonKey.slice(0, 12) + '…' + cfg.anonKey.slice(-6)));
  if (changed.length) log('  ' + C.d('رُفع رقم الكاش في: ' + changed.join('، ')));
  log('');
  log(C.d('  الخطوة التالية: node tools/sbctl.mjs doctor'));
  log('');
  return 0;
}

async function cmdSql(args) {
  const sql = (args.repair || args['repair-messages']) ? repairSql() : bootstrapSql();
  if (args.out) {
    fs.writeFileSync(args.out, sql, 'utf8');
    log(ok('حُفظ الملف: ' + args.out));
  } else {
    process.stdout.write(sql);
  }
  return 0;
}

async function cmdSmoke(args) {
  const cfg = readConfig();
  const url = args.url || cfg.url;
  const key = args.key || cfg.anonKey;
  if (!url || !key) { log(C.r('  ✗ لا يوجد مشروع مهيّأ')); return 1; }
  const code = (args.room || ('SB' + Math.random().toString(36).slice(2, 8))).toUpperCase();
  const ownerToken = randomBytes(32).toString('hex');
  const clientId = 'sbctl-' + code;
  log('');
  log(C.bold('  🧪 اختبار حي على ' + shortRef(url)));
  const created = await restPost(url, key, '/rest/v1/rpc/wt_create_room', {
    p_room_id: code, p_title: 'فحص الاتصال', p_video_url: 'https://example.com/video.mp4',
    p_owner_token: ownerToken, p_owner_name: 'فحص'
  });
  if (!created.ok) { log(bad('إنشاء الغرفة عبر RPC فشل: ' + JSON.stringify(explain(created)))); return 1; }
  const joined = await restPost(url, key, '/rest/v1/rpc/wt_join_room', {
    p_room_id: code, p_client_id: clientId, p_member_token: ownerToken, p_display_name: 'فحص'
  });
  const state = {
    url: 'https://example.com/video.mp4', kind: 'file', playing: true, pos: 42.5,
    t: Date.now(), rev: 0, updatedBy: clientId, updatedByName: 'فحص'
  };
  const applied = joined.ok ? await restPost(url, key, '/rest/v1/rpc/wt_apply_room_state', {
    p_room_id: code, p_client_id: clientId, p_member_token: ownerToken, p_state: state
  }) : joined;
  if (!applied.ok) { log(bad('كتابة الحالة عبر RPC فشلت: ' + JSON.stringify(explain(applied)))); }
  else log(ok('كُتبت حالة الغرفة عبر تحقق المالك: ' + code));

  const back = await restGet(url, key, `/rest/v1/rooms?room_id=eq.${code}&select=room_id,state,host_name`);
  const row = Array.isArray(back.body) ? back.body[0] : null;
  if (row && row.state) log(ok('قُرئت الحالة من القاعدة: pos=' + row.state.pos + ' playing=' + row.state.playing));
  else log(bad('لم تُقرأ الغرفة أو حالتها'));

  let m = await restPost(url, key, '/rest/v1/messages', {
    room_id: code, name: 'فحص', body: 'رسالة اختبار', kind: 'chat', client_id: clientId
  });
  if (!m.ok) {
    /* جدول قديم؟ اكتشف عمود النصّ الفعلي وأعد المحاولة (نفس ما يفعله المتصفح) */
    const missCol = String((m.body && m.body.message) || '').match(/could not find the '([^']+)' column of 'messages'/i);
    const probe = await restGet(url, key, '/rest/v1/messages?select=*&limit=1');
    const cols = Array.isArray(probe.body) && probe.body[0] ? Object.keys(probe.body[0]) : [];
    const alt = missCol && cols.find(c => ['text', 'message', 'content', 'msg'].includes(String(c).toLowerCase()));
    if (missCol && missCol[1] === 'body' && alt) {
      m = await restPost(url, key, '/rest/v1/messages', {
        room_id: code, name: 'فحص', [alt]: 'رسالة اختبار', client_id: clientId
      });
      if (m.ok) {
        log(warn('الدردشة تعمل بالعمود القديم «' + alt + '» بدل body'));
        log('  ' + C.g('الحل: نفّذ docs/repair-messages.sql في SQL Editor، ثم NOTIFY pgrst, \'reload schema\';'));
      }
    }
  }
  log(m.ok ? ok('الدردشة تعمل (أُضيفت رسالة)') : warn('الدردشة لا تعمل: ' + JSON.stringify(explain(m))));

  const del = await restPost(url, key, '/rest/v1/rpc/wt_delete_room', { p_room_id: code, p_owner_token: ownerToken });
  log(del.ok ? ok('حُذفت غرفة الاختبار بأمان') : warn('تعذّر حذف غرفة الاختبار: ' + JSON.stringify(explain(del))));
  log('');
  return applied.ok && !!row && del.ok ? 0 : 1;
}

/* =========================================================
   نقطة الدخول
   ========================================================= */
const DEFAULT_VERSION = '2.5.0';

const HELP = `
  ${C.bold('أداة سيرفر Supabase — WatchTogether')}

  ${C.b('status')}   حالة المشروع المهيّأ في config.js
  ${C.b('doctor')}   فحص شامل (REST + الجداول + Realtime + كتابة/قراءة)
  ${C.b('set')}      تبديل المشروع:  --url <URL> --key <anon key>
  ${C.b('create')}   إنشاء مشروع جديد + تنفيذ المخطط + الربط التلقائي
                    --name <اسم> --org-id <id> --db-password <كلمة مرور>
                    [--region eu-central-1] [--plan free] [--dry-run]
  ${C.b('sql')}      طباعة مخطط القاعدة الجاهز  [--out ملف.sql] [--repair]
                    --repair يطبع إصلاح جدول الرسائل (خطأ العمود body / PGRST204)
  ${C.b('smoke')}    اختبار حي (ينشئ غرفة، يكتب، يقرأ، يحذف)
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = (args._[0] || 'status').toLowerCase();
  switch (cmd) {
    case 'status': return cmdStatus(args);
    case 'doctor': case 'check': return cmdDoctor(args);
    case 'set': case 'switch': return cmdSet(args);
    case 'create': case 'new': return cmdCreate(args);
    case 'sql': return cmdSql(args);
    case 'smoke': case 'test': return cmdSmoke(args);
    case 'help': case '--help': case '-h': log(HELP); return 0;
    default:
      log(C.r('  ✗ أمر غير معروف: ' + cmd));
      log(HELP);
      return 1;
  }
}

/* تشغيل مباشر (ولا يُنفَّذ عند الاستيراد في الاختبارات) */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; });
}

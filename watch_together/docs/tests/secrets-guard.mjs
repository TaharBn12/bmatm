/* =========================================================
   WatchTogether — حارس الأسرار + دليل المفاتيح
   • يمنع دخول أي مفتاح سرّي حقيقي إلى المستودع (أو إلى config.js).
   • يتحقّق أن المفتاح العام في config.js دوره anon لا service_role.
   • يتحقّق أن دليل المفاتيح يشرح الخطوات الحرجة.

   التشغيل: node docs/tests/secrets-guard.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '../..');
const read = (file) => fs.readFileSync(path.join(base, file), 'utf8');

let pass = 0;
let fail = 0;
function t(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  console.log('  ✗ FAIL:', name, detail == null ? '' : String(detail));
}

/* ---------------- 1) جرد الملفات النصية ---------------- */
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs/tests/fixtures']);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(rel)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(js|mjs|html|css|json|md|sql|ts|php|htaccess|webmanifest)$/.test(entry.name) || entry.name === '.htaccess') {
      if (/logo-.*\.png$/.test(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}
const files = walk(base);

/* ---------------- 2) أنماط المفاتيح السرّية ---------------- */
const notPlaceholder = (match) => {
  const value = String(match || '');
  if (/x{6,}|\*{4,}|\.\.\.|YOUR|your|example|placeholder|redact|سري|مثال/i.test(value)) return false;
  return true;
};

const RULES = [
  { name: 'sk_secret_ (مفتاح بوابة سري)', re: /sk_secret_[A-Za-z0-9_\-]{12,}/g },
  { name: 'sk_live_ / sk_test_', re: /\bsk_(live|test)_[A-Za-z0-9]{12,}/g },
  { name: 'whsec_ (توقيع webhook)', re: /\bwhsec_[A-Za-z0-9]{12,}/g },
  { name: 'sk_id_ (معرّف مفتاح سري)', re: /\bsk_id_[A-Za-z0-9]{12,}/g },
  { name: 'service_role في JWT', re: /"role"\s*:\s*"service_role"/g },
  { name: 'apiKey بقيمة حقيقية', re: /apiKey=(?!<|\$|\{|your|YOUR)[A-Za-z0-9]{16,}/g },
  { name: 'METERED_KEY بقيمة حقيقية', re: /METERED_KEY=["']?[A-Za-z0-9]{16,}/g },
  { name: 'مفتاح Supabase سري (sb_secret)', re: /\bsb_secret_[A-Za-z0-9_\-]{12,}/g }
];

for (const rule of RULES) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    const matches = text.match(rule.re) || [];
    matches.filter(notPlaceholder).forEach((m) => hits.push(file + ' → ' + m.slice(0, 24) + '…'));
  }
  t('لا يوجد ' + rule.name + ' في المستودع', hits.length === 0, hits.slice(0, 3).join(' | '));
}

/* ---------------- 3) مفتاح config.js العام دوره anon ---------------- */
{
  const config = read('assets/js/config.js');
  const match = config.match(/anonKey:\s*'([^']+)'/);
  t('config.js: يوجد anonKey', !!match);
  if (match) {
    let payload = {};
    try { payload = JSON.parse(Buffer.from(match[1].split('.')[1] || '', 'base64url').toString('utf8')); }
    catch (_) { payload = {}; }
    t('config.js: نوع المفتاح إمّا anon أو publishable', payload.role === 'anon' || !match[1].includes('.'), payload.role);
    t('config.js: ليس service_role', payload.role !== 'service_role');
    t('config.js: لا يحتوي مفتاحاً سرياً آخر', !/service_role|sk_secret|sk_live|whsec_/.test(config));
  }
  t('config.js: TURN غير مضمّن ببيانات اعتماد', /turn:\s*null/.test(config) && !/credential:\s*'[^']+'/.test(config.replace(/\/\*[\s\S]*?\*\//g, '')));
}

/* ---------------- 4) لا أسرار في سكربتات الصفحات ---------------- */
{
  const pages = fs.readdirSync(base).filter((name) => name.endsWith('.html'));
  const inline = pages.filter((page) => {
    const html = read(page);
    return /sk_(secret|live|test|id)_|whsec_|service_role/.test(html);
  });
  t('لا مفاتيح سرّية داخل أي صفحة HTML', inline.length === 0, inline.join(', '));
}

/* ---------------- 5) دليل المفاتيح موجود ويغطّي الحالات ---------------- */
{
  const doc = read('docs/credentials.md');
  t('الدليل موجود', doc.length > 1200);
  t('يفرّق بين العام والسرّي', /عام \(public\)/.test(doc) && /سري \(secret\)/.test(doc));
  t('يشرح `sbctl set` لكتابة الإعدادات', /tools\/sbctl\.mjs set --url/.test(doc));
  t('يحذّر من service_role', /service_role/.test(doc) && /اخطر خطأ|أخطر خطأ/.test(doc) &&
    /لا تضعه في `config\.js`/.test(doc));
  t('يشرح كيف يتحقّق من دور المفتاح', /base64url/.test(doc));
  t('يشرح TURN عبر Secrets', /supabase secrets set/.test(doc) && /wrangler secret put/.test(doc));
  t('يشرح الويب هوك للدفع', /Webhook/.test(doc) && /whsec_/.test(doc));
  t('يحتوي جدول «أين تنتهي كل قيمة»', /الجدول النهائي/.test(doc));
  t('يحتوي قائمة «لا تفعل»', /لا تفعل/.test(doc));
  t('يُشار إليه من README', /credentials\.md/.test(read('README.md')));
  t('يُشار إليه من دليل المشاكل', /credentials\.md/.test(read('docs/troubleshooting.md')));
}

console.log(`Secrets guard: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

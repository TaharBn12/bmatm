/* Verifies that every SQL function in docs/sql matches the live database byte-for-byte
   (whitespace-normalised). Prints a diff list. Usage:
     node tools/sql-drift.mjs <functions.json>
   where functions.json is the output of the pg_proc query. */
import fs from 'fs';
import crypto from 'crypto';

const files = process.argv[3]
  ? process.argv[3].split(',')
  : fs.readdirSync('docs/sql').filter((f) => /^\d\d.*\.sql$/.test(f)).sort();

const norm = (text) => String(text || '').replace(/\s+/g, '');
const keyOf = (schema, name, args) => {
  const types = String(args || '')
    .replace(/\binteger\b/g, 'int').replace(/\bbigint\b/g, 'int8').replace(/\bboolean\b/g, 'bool')
    .replace(/\btext\b/g, 'text').replace(/\bjsonb\b/g, 'jsonb').replace(/\buuid\b/g, 'uuid')
    .replace(/\bdouble precision\b/g, 'float8');
  return (schema + '.' + name + '(' + types.replace(/\s+/g, '').replace(/\bpublic\./g, '') + ')').toLowerCase();
};
const hash = (text) => crypto.createHash('md5').update(norm(text), 'utf8').digest('hex');

/* يقسّم ملف SQL إلى تعريفات دوال: create [or replace] function schema.name(args) ... $$ body $$ */
function parseFunctions(sql, file) {
  const out = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\s/gim;
  let match;
  while ((match = re.exec(sql))) {
    const [head, schema, name, rawArgs] = match;
    const bodyStart = sql.indexOf('$$', re.lastIndex - 1);
    if (bodyStart < 0) continue;
    /* نبحث عن إغلاق $$ مع تجاوز $$ المُضمَّنة في نصّ الدالة (لا توجد عملياً) */
    const bodyEnd = sql.indexOf('$$', bodyStart + 2);
    if (bodyEnd < 0) continue;
    const body = sql.slice(bodyStart + 2, bodyEnd);
    const args = rawArgs
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.replace(/\s+default\s+[\s\S]*$/i, '').replace(/\s+/g, ' ').trim())
      /* types written as public.wt_dm_calls come back as wt_dm_calls from pg */
      .map((part) => part.replace(/\bpublic\./g, ''))
      .join(',');
    out.push({ key: keyOf(schema, name, args), file, body, head: head.trim() });
  }
  return out;
}

const repo = new Map();
for (const file of files) {
  const sql = fs.readFileSync('docs/sql/' + file, 'utf8');
  for (const fn of parseFunctions(sql, file)) {
    /* الملفات 00–04 تُنشئ نفس الدوال؛ نحتفظ بآخر تعريف (الأحدث رقماً) */
    repo.set(fn.key, fn);
  }
}

const live = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const liveMap = new Map();
for (const row of live) {
  liveMap.set(keyOf(row.schema, row.name, row.args), row);
}

let same = 0;
const missing = [], extra = [], differ = [];
for (const [key, fn] of repo) {
  const db = liveMap.get(key);
  if (!db) { missing.push(fn); continue; }
  if (hash(fn.body) === String(db.hash).toLowerCase()) same++;
  else differ.push({ ...fn, liveHash: db.hash, repoHash: hash(fn.body) });
}
for (const [key, row] of liveMap) {
  if (!repo.has(key) && /^wt_/.test(row.name)) extra.push(row);
}

console.log(`functions in repo: ${repo.size} | live (wt_*): ${[...liveMap.keys()].filter((k) => /wt_/.test(k)).length}`);
console.log(`match: ${same}`);
console.log(`missing in db: ${missing.length}`);
missing.forEach((fn) => console.log('  MISSING ' + fn.key + '   (' + fn.file + ')'));
console.log(`different body: ${differ.length}`);
differ.forEach((fn) => console.log('  DIFFER  ' + fn.key + '   (' + fn.file + ')'));
console.log(`extra in db (not in repo): ${extra.length}`);
extra.forEach((row) => console.log('  EXTRA   ' + row.schema + '.' + row.name + '(' + (row.args || '') + ')'));
process.exitCode = (missing.length || differ.length) ? 1 : 0;

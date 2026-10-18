import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../assets/js/resolver.js', import.meta.url), 'utf8');
let fetches = 0, removed = 0;
let response = { ok: true, json: async () => ({ url: 'https://cdn.example/video?token=abc', title: 'فيديو' }) };
const context = {
  window: {}, URL, AbortController, setTimeout, clearTimeout,
  WTUtil: { parseWatchUrl: raw => !raw ? null : ({ kind: raw === 'youtube' ? 'youtube' : raw === 'direct' ? 'file' : 'embed', src: raw }) },
  document: { body: { append() {} }, createElement() { return { querySelector: () => ({}), addEventListener() {}, showModal() {}, close() {}, remove() { removed++; } }; } },
  fetch: async () => { fetches++; return response; }
};
vm.runInNewContext(source, context);
const resolve = context.window.WTResolve;
await assert.rejects(resolve(''), /صالحاً/);
assert.equal((await resolve('youtube')).parsed.src, 'youtube');
assert.equal((await resolve('direct')).parsed.src, 'direct');
assert.equal(fetches, 0);
const media = await resolve('page');
assert.equal(media.title, 'فيديو');
assert.equal(media.parsed.src, 'https://cdn.example/video?token=abc#video.mp4');
response = { ok: false, json: async () => ({ error: 'غير مدعوم' }) };
await assert.rejects(resolve('page'), /غير مدعوم/);
response = { ok: true, json: async () => ({ url: 'javascript:alert(1)' }) };
await assert.rejects(resolve('page'), /غير آمن/);
response = { json: async () => { throw Error('HTML'); } };
await assert.rejects(resolve('page'), /خادم Java/);
assert.equal(removed, 4);
console.log('Resolver tests passed: bypass, signed media, errors, unsafe URL, static hosting, cleanup');

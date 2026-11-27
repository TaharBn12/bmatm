/* Eporner API v2 contract: source document, browser paths, proxy paths and adult gate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const specPath = new URL('../api/eporner-api-v2.openapi.json', import.meta.url);
const specBytes = fs.readFileSync(specPath);
const expectedSha256 = '95d6987b678bccbae5c4180b38a1f01b8c828ef27d338282b7a6bd0d9ccfd2b1';
assert.equal(createHash('sha256').update(specBytes).digest('hex'), expectedSha256,
  'the provided OpenAPI document remains byte-for-byte unchanged');
const spec = JSON.parse(specBytes.toString('utf8'));
const specPaths = Object.keys(spec.paths).sort();
assert.equal(specPaths.length, 8, 'the source specification defines eight operations');

const operationPaths = {
  search: '/video/search/',
  video: '/video/id/',
  removed: '/video/removed/',
  status: '/video/status/',
  categories: '/categories/',
  pornstars: '/pornstars/',
  oembed: '/oembed/',
  openapi: '/openapi/'
};
assert.deepEqual(specPaths, Object.values(operationPaths).sort(), 'the browser operation list exactly matches the OpenAPI paths');

const resolver = fs.readFileSync(new URL('../../java-server/src/com/watchtogether/EpornerResolver.java', import.meta.url), 'utf8');
const declarations = [...resolver.matchAll(/out\.put\("([^\"]+)",\s*new Operation\("([^\"]+)"([^)]*)\)\);/g)];
assert.equal(declarations.length, 8, 'the Java resolver exposes exactly the eight documented paths');
const resolverOperations = new Map(declarations.map(([, path, upstreamPath, rawParams]) => {
  const parameters = [...rawParams.matchAll(/"([^\"]+)"/g)].map(([, name]) => name);
  return [path, { upstreamPath, parameters }];
}));
assert.deepEqual([...resolverOperations.keys()].sort(), specPaths, 'the proxy has no undocumented or missing API paths');
for (const [path, operation] of Object.entries(spec.paths)) {
  const serverOperation = resolverOperations.get(path);
  assert.equal(serverOperation.upstreamPath, path, `${path} forwards to its documented upstream path`);
  const documented = (operation.get.parameters || []).map(parameter => parameter.name).sort();
  assert.deepEqual(serverOperation.parameters.slice().sort(), documented, `${path} forwards exactly its documented query parameters`);
}
assert.match(resolver, /if \(!"1"\.equals\(parameters\.remove\("adult_confirmed"\)\)\)/,
  'the server requires an explicit 18+ attestation');
assert.match(resolver, /API_ROOT = "https:\/\/www\.eporner\.com\/api\/v2"/,
  'the proxy uses a fixed Eporner API root rather than a browser-supplied host');
assert.match(resolver, /getHeaderField\("Retry-After"\)/,
  'the proxy preserves the documented 503 retry delay');
assert.match(resolver, /Access-Control-Expose-Headers", "Retry-After"/,
  'the browser can read the documented retry delay on a cross-origin API deployment');
assert.match(resolver, /normalized\.equals\("eporner\.com"\) \|\| normalized\.endsWith\("\.eporner\.com"\)/,
  'upstream redirects are limited to HTTPS Eporner hosts');
assert.doesNotMatch(resolver, /integer\(parameters, "page", 1, Long\.MAX_VALUE\)/,
  'the proxy does not invent a maximum for search page numbers');
assert.match(resolver, /Search and video\/id parameters pass through/,
  'search parameters are left to Eporner so documented defaults and clamping remain intact');
assert.match(resolver, /"\/pornstars\/"\.equals\(path\)\) \{\s*integer\(parameters, "page", 1, 100000\)/,
  'pornstars page enforces the documented 100000 maximum');
assert.match(resolver, /parts\.length > 100/,
  'status requests follow the documented one-to-one-hundred id limit');
assert.match(resolver, /integerMinimum\(parameters, "maxwidth", 1\)/);
assert.match(resolver, /integerMinimum\(parameters, "maxheight", 1\)/,
  'oEmbed dimensions have the documented minimum without an invented maximum');

const main = fs.readFileSync(new URL('../../java-server/src/com/watchtogether/Main.java', import.meta.url), 'utf8');
assert.match(main, /path\.startsWith\("\/api\/eporner\/"\)\) \{ EpornerResolver\.handle\(ex\); return; \}/,
  'Main routes same-origin Eporner requests to the resolver');

const clientSource = fs.readFileSync(new URL('../../assets/js/eporner.js', import.meta.url), 'utf8');
const calls = [];
const sandbox = {
  URLSearchParams,
  sessionStorage: { getItem: () => 'yes' },
  WTServer: { api: path => 'https://api.example.test/' + path },
  fetch: async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
      text: async () => '{"ok":true}'
    };
  }
};
sandbox.window = sandbox;
vm.runInNewContext(clientSource, sandbox, { filename: 'eporner.js' });
assert.deepEqual(Object.keys(sandbox.WTEpornerApi.operations).sort(), Object.keys(operationPaths).sort(),
  'the browser client exports all eight named operations');
for (const [name, operationPath] of Object.entries(operationPaths)) {
  const params = name === 'video' ? { id: 'AbCdEfGhIjK' }
    : name === 'status' ? { id: ['AbCdEfGhIjK', 'LmNoPqRsTuV'] }
      : name === 'oembed' ? { url: 'https://www.eporner.com/video-AbCdEfGhIjK/sample-title/' }
        : name === 'removed' ? { since: '2026-11-12' }
          : {};
  await sandbox.WTEpornerApi.run(name, params);
  const call = calls.at(-1);
  const url = new URL(call.url);
  assert.equal(url.pathname, '/api/eporner' + operationPath, `${name} targets the matching proxy route`);
  assert.equal(url.searchParams.get('adult_confirmed'), '1', `${name} includes the age attestation`);
  for (const [key, value] of Object.entries(params)) assert.equal(url.searchParams.get(key), String(value), `${name} preserves ${key}`);
  assert.equal(call.options.cache, 'no-store');
}
sandbox.fetch = async () => ({
  ok: false,
  status: 503,
  headers: { get: name => name.toLowerCase() === 'retry-after' ? '30' : 'application/problem+json' },
  text: async () => '{"detail":"Temporarily unavailable","status":503}'
});
await assert.rejects(sandbox.WTEpornerApi.search({}), error =>
  error.status === 503 && error.serverDown === true && error.retryAfter === '30',
  'the client exposes the documented Retry-After value on unavailable responses');

const noConsentCalls = [];
const noConsent = {
  URLSearchParams,
  sessionStorage: { getItem: () => null },
  fetch: async url => { noConsentCalls.push(url); throw new Error('should not fetch'); }
};
noConsent.window = noConsent;
vm.runInNewContext(clientSource, noConsent, { filename: 'eporner-no-consent.js' });
await assert.rejects(noConsent.WTEpornerApi.categories({}), /18\+/,
  'the browser client refuses all operations without session consent');
assert.equal(noConsentCalls.length, 0, 'no network request is made before 18+ consent');

console.log('ePorner API contract passed (unchanged OpenAPI, exact eight-operation parity, proxy routing and age gate)');

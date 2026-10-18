/* Run every dependency-free suite, and preserve a non-zero status on any failure. */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = new URL('./', import.meta.url);
const tests = readdirSync(directory).filter(name => name.endsWith('.mjs') &&
  !['harness.mjs', 'run.mjs', 'room-browser.mjs'].includes(name)).sort();
let failed = 0;
for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(test, directory))], {
    stdio: 'inherit', timeout: 60000
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed++;
}
console.log(`\n${tests.length - failed}/${tests.length} test suites passed`);
process.exitCode = failed ? 1 : 0;

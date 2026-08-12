#!/usr/bin/env node
// Runs every test in this directory.
//
// Auto-discovery rather than a hardcoded list in package.json: the point of the
// suite is that a feature added later cannot silently break an earlier one, and
// a test that has to be manually registered is a test someone eventually
// forgets to register. Drop a `*.js` file in test/ and it runs.
//
// Each test file is a standalone Node script that exits non-zero on failure
// (the convention test/smoke.js already established). They run in separate
// processes so one crashing cannot take the run down with it, and in sorted
// order so output is stable.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SELF = path.basename(__filename);

const tests = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && f !== SELF && !f.startsWith('_'))
  .sort();

if (!tests.length) {
  console.error('No test files found in ' + DIR);
  process.exit(1);
}

const failed = [];
for (const file of tests) {
  console.log('\n' + '━'.repeat(60));
  console.log('▶ ' + file);
  console.log('━'.repeat(60));
  const r = spawnSync(process.execPath, [path.join(DIR, file)], { stdio: 'inherit' });
  // A signal (crash, OOM) leaves status null; treat anything but a clean 0 as
  // a failure so a segfaulting test cannot pass by accident.
  if (r.status !== 0) failed.push(file + (r.status === null ? ' (crashed)' : ''));
}

console.log('\n' + '═'.repeat(60));
if (failed.length) {
  console.log(`FAILED: ${failed.length} of ${tests.length} suite(s)`);
  failed.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`ALL ${tests.length} SUITE(S) PASSED`);

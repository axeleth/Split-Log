// Test for storage-shim.js — the localStorage-backed window.storage used when
// the app is self-hosted rather than run on the Claude.ai artifact host.
//
// Deliberately injects NO storage mock: test/smoke.js already covers the app
// against a mock, so the thing left untested is whether the real shim satisfies
// the same contract. Scripts are appended by hand instead of letting jsdom
// fetch them, which keeps the load order explicit and avoids the resource
// loader entirely.
//
// The contract, taken from the mock in smoke.js which mirrors the real host:
//   get(key)        -> { value: <string> } when present, null when absent
//   set(key, value) -> truthy on success
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://splitlog.example.test/';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); failures++; }
}

// index.html loads its scripts with <script src>; strip those and inject the
// same files directly so this test controls the order.
function pageHtml() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
}

function newPage(vc) {
  const dom = new JSDOM(pageHtml(), {
    runScripts: 'dangerously', url: ORIGIN,
    virtualConsole: vc, pretendToBeVisual: true,
  });
  // jsdom has no canvas, so renderCharts() would throw on real Chart.js.
  dom.window.Chart = function () { return { destroy() {}, update() {} }; };
  return dom.window;
}

function runScript(win, file) {
  const el = win.document.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
  win.document.head.appendChild(el);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const vc = new VirtualConsole();
  vc.on('error', m => console.log('  [console.error] ' + m));

  const w = newPage(vc);

  console.log('-- load order --');
  check('no window.storage before the shim', typeof w.storage === 'undefined');
  runScript(w, 'storage-shim.js');
  check('shim defines window.storage', typeof w.storage === 'object' && w.storage !== null);
  if (!w.storage) { console.log('\nFATAL: shim did not install'); process.exit(1); }

  console.log('\n-- contract matches the artifact host --');
  // A missing key must be null, not {value:null}: loadAll() branches on the
  // falsy result to decide whether to migrate or seed defaults.
  check('missing key -> null', (await w.storage.get('no-such-key')) === null);
  // The hardened save handlers do `if(!ok) throw`, so this must be truthy.
  check('set() returns truthy', !!(await w.storage.set('k', 'hello')));
  const got = await w.storage.get('k');
  check('get() returns {value}', got && got.value === 'hello', JSON.stringify(got));

  console.log('\n-- keys are namespaced --');
  check('stored under splitlog: prefix', w.localStorage.getItem('splitlog:k') === 'hello');
  check('bare key not written', w.localStorage.getItem('k') === null);

  console.log('\n-- the real app boots on the shim --');
  runScript(w, 'app.js');
  await wait(700);
  const settings = w.localStorage.getItem('splitlog:settings');
  check('app persisted settings through the shim', !!settings);
  check('persisted settings are valid JSON',
        (() => { try { JSON.parse(settings); return true; } catch (e) { return false; } })());
  const hr = w.document.querySelector('#race5kHrInput');
  check('settings rendered into the DOM', hr && hr.value === '180', hr && hr.value);
  check('today view rendered', w.document.querySelector('#view-today').innerHTML.includes('Log this run'));

  console.log('\n-- data survives a reload --');
  // The actual point of the shim: on the artifact host this came free, and
  // without it a self-hosted page renders empty on every load.
  const carried = {
    settings: w.localStorage.getItem('splitlog:settings'),
    plans: w.localStorage.getItem('splitlog:plans'),
  };
  const w2 = newPage(vc);
  for (const [k, v] of Object.entries(carried)) {
    if (v) w2.localStorage.setItem('splitlog:' + k, v);
  }
  runScript(w2, 'storage-shim.js');
  runScript(w2, 'app.js');
  await wait(700);
  const hr2 = w2.document.querySelector('#race5kHrInput');
  check('settings restored after reload', hr2 && hr2.value === '180', hr2 && hr2.value);

  console.log('\n-- a real host wins --');
  // On the artifact host window.storage already exists; the shim must leave it
  // alone or self-hosting would break the hosted version.
  const w3 = newPage(vc);
  const hostStorage = { async get() { return { value: 'HOST' }; }, async set() { return true; }, __host: true };
  w3.storage = hostStorage;
  runScript(w3, 'storage-shim.js');
  check('existing window.storage untouched', w3.storage === hostStorage);
  check('host implementation still intact', w3.storage.__host === true);

  console.log('\n' + '='.repeat(50));
  if (failures) { console.log(`FAILURES (${failures})`); process.exit(1); }
  console.log('ALL SHIM CHECKS PASSED');
  process.exit(0);
})();

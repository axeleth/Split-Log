// A save that reached storage must never be reported as a failure.
//
// Regression test for the bug where logging a run showed
//   "Could not save — undefined is not an object (evaluating 'window.storage.set')"
// while the run was in fact written to storage (it reappeared on tab switch).
//
// Cause: the save handlers wrapped the write AND the post-write re-renders in
// one try/catch, so a throw from a renderer was reported as a save failure and
// overwrote the already-correct success toast.
//
// These tests inject a throwing renderer and assert the two halves separately:
// the data is persisted, and the toast tells the truth about that. They also
// pin the inverse — a genuine write failure must still report failure — so the
// fix cannot be "swallow everything".
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const failures = [];

function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); failures.push(name); }
}

// Same Chart stub as smoke.js: jsdom has no canvas, so real Chart.js throws.
// Non-configurable with a no-op setter so the CDN script cannot replace it.
function installChartStub(window) {
  const built = [];
  window.__charts = built;
  const Stub = class {
    constructor(canvas, cfg) { this.canvas = canvas; this.cfg = cfg; this.destroyed = false; built.push(this); }
    destroy() { this.destroyed = true; }
  };
  Object.defineProperty(window, 'Chart', {
    configurable: false,
    get() { return Stub; },
    set() { /* ignore the CDN's attempt to replace us */ },
  });
}

// Boot a fresh page. `storageSet` lets a case override the write half of the
// storage contract; everything else mirrors the smoke harness.
//
// Unlike smoke.js this collects console.error instead of failing on it: these
// tests deliberately provoke renderer errors, and the fix is *expected* to log
// them. Cases assert on `errors` rather than being failed by it.
function boot({ storageSet } = {}) {
  const store = new Map();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'dangerously',
    resources: 'usable',
    interceptors: [requestInterceptor(request => {
      if (request.url.startsWith('file:')) return undefined;   // local files pass through
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    })],
    url: 'file://' + ROOT + '/index.html',
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.storage = {
        async get(key) { return store.has(key) ? { value: store.get(key) } : null; },
        async set(key, value) {
          if (storageSet) return storageSet(key, value, store);
          store.set(key, value);
          return true;
        },
      };
      installChartStub(window);
    },
  });

  const w = dom.window;
  const d = w.document;
  return {
    w, d, store, errors,
    $: s => d.querySelector(s),
    $$: s => Array.from(d.querySelectorAll(s)),
    ready: async () => {
      await new Promise(r => w.addEventListener('load', r));
      await new Promise(r => setTimeout(r, 150));
    },
  };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Make one of the renderers blow up, the way a real rendering fault would.
// Patching the target element's innerHTML setter breaks the renderer from the
// outside without reaching into the app's IIFE — app.js stays untouched, which
// is the point: the test must not know how the fix is implemented.
function breakRenderer(w, d, selector, message) {
  const el = d.querySelector(selector);
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return ''; },
    set() { throw new w.TypeError(message); },
  });
  return el;
}

(async () => {
  // ---------------------------------------------------------------------
  console.log('\n-- quick log: renderer throws after a successful write --');
  {
    const { w, d, store, errors, $, ready } = boot();
    await ready();

    // #planList is written by renderPlanList(), which runs after the save.
    breakRenderer(w, d, '#planList',
      "undefined is not an object (evaluating 'window.storage.set')");

    $('#qlDist').value = '5';
    $('#qlDist').dispatchEvent(new w.Event('input'));
    $('#qlDur').value = '32:30';
    $('#qlDur').dispatchEvent(new w.Event('input'));
    $('#btnLog').click();
    await wait(150);

    const raw = store.get('plans');
    const plans = raw ? JSON.parse(raw) : [];
    const adhoc = plans.find(p => p.id === '__adhoc__');
    const logged = adhoc && Object.values(adhoc.days)[0];

    check('run is actually persisted despite the render fault', !!logged,
          JSON.stringify(plans).slice(0, 140));
    check('pace still derived correctly', logged && Math.abs(logged.actual.pace - 6.5) < 1e-9,
          logged && logged.actual.pace);

    // The bug: this reads "Could not save — undefined is not an object ..."
    check('toast reports success, not failure', $('#toast').textContent === 'Run logged',
          JSON.stringify($('#toast').textContent));
    check('toast never claims the save failed',
          !$('#toast').textContent.includes('Could not save'),
          JSON.stringify($('#toast').textContent));
    check('the real render error is logged for diagnosis',
          errors.some(e => e.includes('Redraw failed')), errors.join(' | ').slice(0, 200));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- ledger editor: renderer throws after a successful write --');
  {
    const { w, d, store, errors, $, $$, ready } = boot();
    await ready();

    $('#fivekStartInput').value = '2026-08-12';
    $('#raceDateInput').value = '2026-08-31';
    $('#btnGen5k').click();
    await wait(120);

    $('#planList .plan-card').click();
    await wait(60);
    $('#ledger .day-row').click();
    await wait(60);
    check('editor opened', !!$('.editor #edSave'));

    $('#edDist').value = '4';
    $('#edDist').dispatchEvent(new w.Event('input'));
    $('#edDur').value = '28:00';
    $('#edDur').dispatchEvent(new w.Event('input'));

    // #todayMain is written by renderToday(), which runs after the save.
    // (#view-today is now a static shell holding the chart canvases, so
    // patching it would no longer intercept the renderer at all.)
    breakRenderer(w, d, '#todayMain',
      "undefined is not an object (evaluating 'window.storage.set')");

    $('#edSave').click();
    await wait(150);

    const plans = JSON.parse(store.get('plans'));
    const p5k = plans.find(p => p.type === '5k');
    const firstDay = p5k.days[Object.keys(p5k.days).sort()[0]];

    check('edited day is actually persisted despite the render fault',
          firstDay.status === 'done' && Math.abs(firstDay.actual.pace - 7) < 1e-9,
          JSON.stringify(firstDay.actual));
    check('editor toast reports success, not failure', $('#toast').textContent === 'Saved',
          JSON.stringify($('#toast').textContent));
    check('editor toast never claims the save failed',
          !$('#toast').textContent.includes('Could not save'),
          JSON.stringify($('#toast').textContent));
    check('the real render error is logged for diagnosis',
          errors.some(e => e.includes('Redraw failed')), errors.join(' | ').slice(0, 200));
  }

  // ---------------------------------------------------------------------
  // The inverse guard: the fix must not turn every failure into a success.
  console.log('\n-- a genuine write failure still reports failure --');
  {
    const { w, store, $, ready } = boot({ storageSet: () => false });
    await ready();

    $('#qlDist').value = '5';
    $('#qlDist').dispatchEvent(new w.Event('input'));
    $('#qlDur').value = '32:30';
    $('#qlDur').dispatchEvent(new w.Event('input'));
    $('#btnLog').click();
    await wait(150);

    check('failed write is reported to the user',
          $('#toast').textContent.startsWith('Could not save'),
          JSON.stringify($('#toast').textContent));
    check('nothing was persisted', !store.has('plans'), String(store.get('plans')).slice(0, 80));
    check('button re-enabled so the user can retry', $('#btnLog').disabled === false);
  }

  // A write that throws outright, not merely returns falsy.
  {
    const { w, $, ready } = boot({ storageSet: () => { throw new Error('quota exceeded'); } });
    await ready();

    $('#qlDist').value = '5';
    $('#qlDist').dispatchEvent(new w.Event('input'));
    $('#qlDur').value = '30:00';
    $('#qlDur').dispatchEvent(new w.Event('input'));
    $('#btnLog').click();
    await wait(150);

    check('a throwing write is reported to the user',
          $('#toast').textContent.startsWith('Could not save'),
          JSON.stringify($('#toast').textContent));
    check('the underlying reason is surfaced', $('#toast').textContent.includes('quota exceeded'),
          JSON.stringify($('#toast').textContent));
  }

  // ---------------------------------------------------------------------
  // The happy path must be untouched by all of the above.
  console.log('\n-- happy path unchanged --');
  {
    const { w, store, errors, $, ready } = boot();
    await ready();

    $('#qlDist').value = '5';
    $('#qlDist').dispatchEvent(new w.Event('input'));
    $('#qlDur').value = '32:30';
    $('#qlDur').dispatchEvent(new w.Event('input'));
    $('#qlNotes').value = 'felt good';
    $('#btnLog').click();
    await wait(150);

    const plans = JSON.parse(store.get('plans'));
    const adhoc = plans.find(p => p.id === '__adhoc__');
    const logged = adhoc && Object.values(adhoc.days)[0];

    check('run saved', !!logged);
    check('notes kept', logged && logged.actual.notes === 'felt good');
    check('success toast shown', $('#toast').textContent === 'Run logged',
          JSON.stringify($('#toast').textContent));
    check('toast is visible', $('#toast').classList.contains('show'));
    check('today re-rendered with metrics', $('#view-today').innerHTML.includes('metric-value'));
    check('no errors logged on a clean save', errors.length === 0, errors.join(' | ').slice(0, 200));
  }

  if (failures.length) {
    console.log('\nFAILURES (' + failures.length + '):');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

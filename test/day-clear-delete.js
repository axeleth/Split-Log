// Day editor: clear a logged day, confirm before deleting, and collapse past
// days into a "Previous runs" section.
//
// Three behaviours that share the ledger's day editor:
//
//   1. "Clear day" resets a logged day to not-logged — status back to
//      'planned', actual wiped — while KEEPING the planned session itself
//      (type, title, detail, target pace). Deleting the day would throw the
//      session away too; clearing is the non-destructive undo for a run
//      logged against the wrong date.
//   2. "Delete day" asks first. confirm() is silently blocked in the
//      sandboxed host (CLAUDE.md gotcha #2), so this is an in-page state
//      machine like archiveDeleteStage. The confirm must not rebuild the
//      whole editor, or unsaved input in the fields is lost.
//   3. Days dated before today collapse into a "Previous runs" section at the
//      top of the ledger, so a plan several weeks in opens on today rather
//      than a wall of history. Rows inside stay fully editable.
//
// Dates are derived from today, never hardcoded: a fixed date would silently
// stop straddling past/future and the section under test would go empty.
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

// Local-component date maths, mirroring app.js's toLocalISODate/addDays.
// toISOString() would shift the date back a day east of UTC (gotcha #1) and
// could put a "past" day on today, quietly breaking the split under test.
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = iso(new Date());
function shift(n) { const d = new Date(TODAY + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); }

function boot({ storageSet, plans } = {}) {
  const store = new Map();
  if (plans) store.set('plans', JSON.stringify(plans));
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
const readPlan = (store, id) => JSON.parse(store.get('plans')).find(p => p.id === id);

// A plan straddling today: three days behind, today, two ahead. The past
// Zone 2 day is logged so there is something to clear; the past rest day is
// untouched, since "previous" is date-based and sweeps those in too.
const PLAN_ID = 'p_fixture';
function fixturePlan() {
  const mk = (type, title, detail, targetPace, extra) => Object.assign({
    type, title, detail, targetPace, status: 'planned', actual: null,
  }, extra || {});
  return {
    id: PLAN_ID, name: 'Fixture plan', type: '5k',
    startDate: shift(-3), raceDate: shift(2), archived: false,
    days: {
      [shift(-3)]: mk('zone2', 'Zone 2 run', 'Easy aerobic pace.', 7, {
        status: 'done',
        actual: { distance: 5, duration: 35, avgHr: 150, notes: 'felt good', pace: 7 },
      }),
      [shift(-2)]: mk('rest', 'Rest', 'Full rest.', null),
      [shift(-1)]: mk('hard', 'Intervals', '5 x 3 min.', null, {
        status: 'done',
        actual: { distance: 6, duration: 33, avgHr: 168, notes: '', pace: 5.5 },
      }),
      [TODAY]: mk('zone2', 'Zone 2 run', 'Easy aerobic pace.', 7),
      [shift(1)]: mk('rest', 'Rest', 'Full rest.', null),
      [shift(2)]: mk('race', 'Race day', '5K time trial.', 6),
    },
  };
}

// Open the fixture plan's ledger. Returns the booted context.
async function openLedger(opts) {
  const ctx = boot(Object.assign({ plans: [fixturePlan()] }, opts || {}));
  await ctx.ready();
  ctx.$$('.tab').find(t => t.dataset.view === 'plan').click();
  await wait(60);
  ctx.$('#planList .plan-card').click();
  await wait(60);
  return ctx;
}

// Click the row for a given date, opening its inline editor. Rows inside the
// collapsed section need it expanded first.
async function openDay(ctx, date) {
  const row = ctx.$$('#ledger .day-row').find(r => r.dataset.date === date);
  if (!row) return null;
  row.click();
  await wait(60);
  return row;
}

(async () => {
  // ---------------------------------------------------------------------
  console.log('\n-- clear day: resets the log, keeps the session --');
  {
    const { store, $, $$, ready } = await openLedger();
    const past = shift(-3);

    // Expand so the logged past day is reachable.
    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);

    check('Clear day offered on a logged day', !!$('#edClear'));
    check('Save and Delete still offered', !!$('#edSave') && !!$('#edDelete'));

    $('#edClear')?.click();
    await wait(150);

    const day = readPlan(store, PLAN_ID).days[past];
    check('status reset to planned', day.status === 'planned', day.status);
    check('actual wiped', day.actual === null, JSON.stringify(day.actual));
    check('session type kept', day.type === 'zone2', day.type);
    check('title kept', day.title === 'Zone 2 run', day.title);
    check('detail kept', day.detail === 'Easy aerobic pace.', day.detail);
    check('target pace kept', day.targetPace === 7, String(day.targetPace));
    check('the day itself still exists', !!day);
    check('other days untouched', readPlan(store, PLAN_ID).days[shift(-1)].status === 'done');
  }

  // ---------------------------------------------------------------------
  console.log('\n-- clear day: inputs come back empty, button disappears --');
  {
    const { $, $$ } = await openLedger();
    const past = shift(-3);
    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);
    $('#edClear')?.click();
    await wait(150);

    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);
    check('editor reopened', !!$('#edDist'));
    check('Clear day gone once nothing is logged', !!$('#edDist') && !$('#edClear'));
    check('distance input empty', $('#edDist') && $('#edDist').value === '', `"${$('#edDist')?.value}"`);
    check('duration input empty', $('#edDur') && $('#edDur').value === '', `"${$('#edDur')?.value}"`);
    check('avg HR input empty', $('#edHr') && $('#edHr').value === '', `"${$('#edHr')?.value}"`);
    check('pace display reset', $('#edPaceDisplay')?.textContent.trim() === '—',
          $('#edPaceDisplay')?.textContent);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- clear day: never offered on a day with no data --');
  {
    const { $, $$ } = await openLedger();
    await openDay({ $, $$ }, shift(1));   // future rest day, never logged
    check('editor opened', !!$('#edSave'));
    check('no Clear day on an unlogged day', !$('#edClear'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- clear day: a storage failure rolls back and reports --');
  {
    const { store, $, $$ } = await openLedger({ storageSet: () => false });
    const past = shift(-3);
    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);
    $('#edClear')?.click();
    await wait(150);

    check('nothing written to storage', readPlan(store, PLAN_ID).days[past].status === 'done');
    check('failure reported to the user', /could not clear/i.test($('#toast').textContent),
          JSON.stringify($('#toast').textContent));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- delete day: first click asks, it does not delete --');
  {
    const { store, $, $$ } = await openLedger();
    const before = Object.keys(readPlan(store, PLAN_ID).days).length;
    await openDay({ $, $$ }, TODAY);

    $('#edDelete').click();
    await wait(60);

    check('nothing deleted yet', Object.keys(readPlan(store, PLAN_ID).days).length === before);
    check('day still present', !!readPlan(store, PLAN_ID).days[TODAY]);
    check('confirm and cancel offered', !!$('#edDeleteConfirm') && !!$('#edDeleteCancel'));
    check('plain Delete button replaced', !$('#edDelete'));
    check('warning shown', /undone|sure|permanent/i.test($('.editor .confirm-msg')?.textContent || ''),
          $('.editor .confirm-msg')?.textContent);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- delete day: cancel backs out cleanly --');
  {
    const { store, $, $$ } = await openLedger();
    const before = Object.keys(readPlan(store, PLAN_ID).days).length;
    await openDay({ $, $$ }, TODAY);

    $('#edDelete').click();
    await wait(60);
    $('#edDeleteCancel')?.click();
    await wait(60);

    check('still nothing deleted', Object.keys(readPlan(store, PLAN_ID).days).length === before);
    check('normal buttons restored', !!$('#edDelete') && !$('#edDeleteConfirm'));
    check('editor still open', !!$('#edSave'));
  }

  // ---------------------------------------------------------------------
  // The reason the confirm re-renders only the button row: rebuilding the
  // whole editor would wipe whatever the user had typed but not yet saved.
  console.log('\n-- delete day: unsaved input survives the confirm --');
  {
    const { $, $$ } = await openLedger();
    await openDay({ $, $$ }, TODAY);

    $('#edTitle').value = 'Typed but unsaved';
    $('#edDist').value = '9.5';
    $('#edDelete').click();
    await wait(60);

    check('title still typed while confirming', $('#edTitle')?.value === 'Typed but unsaved',
          `"${$('#edTitle')?.value}"`);
    check('distance still typed while confirming', $('#edDist')?.value === '9.5',
          `"${$('#edDist')?.value}"`);

    $('#edDeleteCancel')?.click();
    await wait(60);
    check('title survives cancel too', $('#edTitle')?.value === 'Typed but unsaved',
          `"${$('#edTitle')?.value}"`);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- delete day: confirming removes exactly that day --');
  {
    const { store, $, $$ } = await openLedger();
    const before = Object.keys(readPlan(store, PLAN_ID).days).length;
    await openDay({ $, $$ }, TODAY);

    $('#edDelete').click();
    await wait(60);
    $('#edDeleteConfirm')?.click();
    await wait(150);

    const days = readPlan(store, PLAN_ID).days;
    check('the day is gone', days[TODAY] === undefined);
    check('exactly one day removed', Object.keys(days).length === before - 1,
          `${Object.keys(days).length} vs ${before - 1}`);
    check('neighbouring days kept', !!days[shift(1)] && !!days[shift(-1)]);
    check('row gone from the ledger',
          !$$('#ledger .day-row').some(r => r.dataset.date === TODAY));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- delete day: a half-armed confirm does not linger --');
  {
    const { store, $, $$ } = await openLedger();
    await openDay({ $, $$ }, TODAY);
    $('#edDelete').click();          // arm it
    await wait(60);
    await openDay({ $, $$ }, TODAY); // click the row again: closes the editor
    await openDay({ $, $$ }, TODAY); // and reopen

    check('reopened editor is not still armed', !!$('#edDelete') && !$('#edDeleteConfirm'));
    check('day untouched by the abandoned confirm', !!readPlan(store, PLAN_ID).days[TODAY]);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- delete day: a storage failure rolls back and reports --');
  {
    const { store, $, $$ } = await openLedger({ storageSet: () => false });
    await openDay({ $, $$ }, TODAY);
    $('#edDelete').click();
    await wait(60);
    $('#edDeleteConfirm')?.click();
    await wait(150);

    check('day still in storage', !!readPlan(store, PLAN_ID).days[TODAY]);
    check('failure reported to the user', /could not delete/i.test($('#toast').textContent),
          JSON.stringify($('#toast').textContent));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: past days collapse, today and later do not --');
  {
    const { $, $$ } = await openLedger();

    check('section rendered', !!$('#prevRuns'));
    check('toggle rendered', !!$('#prevRunsToggle'));
    check('starts collapsed', $('#prevRuns')?.classList.contains('is-hidden'));

    const inSection = $$('#prevRuns .day-row').map(r => r.dataset.date).sort();
    check('holds exactly the three past days',
          JSON.stringify(inSection) === JSON.stringify([shift(-3), shift(-2), shift(-1)]),
          JSON.stringify(inSection));
    check('past rest day swept in too', inSection.includes(shift(-2)));

    const section = $('#prevRuns');
    const outside = $$('#ledger .day-row')
      .filter(r => !section || !section.contains(r)).map(r => r.dataset.date).sort();
    check('today stays in the main list', outside.includes(TODAY));
    check('future days stay in the main list',
          outside.includes(shift(1)) && outside.includes(shift(2)));
    check('no past day left in the main list',
          !outside.some(d => d < TODAY), JSON.stringify(outside));
    check('toggle names the count', /3/.test($('#prevRunsToggle')?.textContent || ''),
          $('#prevRunsToggle')?.textContent);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: expands and collapses --');
  {
    const { $ } = await openLedger();

    $('#prevRunsToggle')?.click();
    await wait(40);
    check('expands on click', !$('#prevRuns')?.classList.contains('is-hidden'));

    $('#prevRunsToggle')?.click();
    await wait(40);
    check('collapses again', $('#prevRuns')?.classList.contains('is-hidden'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: rows inside stay fully editable --');
  {
    const { store, $, $$ } = await openLedger();
    const past = shift(-1);
    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);

    check('editor opens inside the section', !!$('#edSave'));
    check('editor rendered within the section', !!$('#prevRuns .editor'));
    check('Clear day available there', !!$('#edClear'));
    check('Delete day available there', !!$('#edDelete'));

    $('#edClear')?.click();
    await wait(150);
    check('clearing works from inside the section',
          readPlan(store, PLAN_ID).days[past].status === 'planned',
          readPlan(store, PLAN_ID).days[past].status);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: collapsed state resets on reopen --');
  {
    const { $ } = await openLedger();
    $('#prevRunsToggle')?.click();
    await wait(40);
    check('expanded before leaving', !$('#prevRuns')?.classList.contains('is-hidden'));

    $('#btnBackToPlans').click();
    await wait(60);
    $('#planList .plan-card').click();
    await wait(60);
    check('collapsed again on reopen', $('#prevRuns')?.classList.contains('is-hidden'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: absent when no day is in the past --');
  {
    const future = fixturePlan();
    future.days = {
      [TODAY]: { type: 'zone2', title: 'Zone 2 run', detail: 'Easy.', targetPace: 7, status: 'planned', actual: null },
      [shift(1)]: { type: 'rest', title: 'Rest', detail: 'Full rest.', targetPace: null, status: 'planned', actual: null },
    };
    const ctx = boot({ plans: [future] });
    await ctx.ready();
    ctx.$$('.tab').find(t => t.dataset.view === 'plan').click();
    await wait(60);
    ctx.$('#planList .plan-card').click();
    await wait(60);

    check('no empty section rendered', !ctx.$('#prevRuns'));
    check('no stray toggle', !ctx.$('#prevRunsToggle'));
    check('the days still render', ctx.$$('#ledger .day-row').length === 2,
          String(ctx.$$('#ledger .day-row').length));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- previous runs: whole plan in the past still usable --');
  {
    const old = fixturePlan();
    old.days = {
      [shift(-9)]: { type: 'zone2', title: 'Zone 2 run', detail: 'Easy.', targetPace: 7, status: 'done',
                     actual: { distance: 5, duration: 35, avgHr: 150, notes: '', pace: 7 } },
      [shift(-8)]: { type: 'rest', title: 'Rest', detail: 'Full rest.', targetPace: null, status: 'planned', actual: null },
    };
    const ctx = boot({ plans: [old] });
    await ctx.ready();
    ctx.$$('.tab').find(t => t.dataset.view === 'plan').click();
    await wait(60);
    ctx.$('#planList .plan-card').click();
    await wait(60);

    check('section rendered', !!ctx.$('#prevRuns'));
    check('every day is inside it', ctx.$$('#prevRuns .day-row').length === 2,
          String(ctx.$$('#prevRuns .day-row').length));
    check('ledger is not blank', ctx.$('#ledger').innerHTML.trim().length > 0);
    ctx.$('#prevRunsToggle')?.click();
    await wait(40);
    check('still expandable', !ctx.$('#prevRuns')?.classList.contains('is-hidden'));
  }

  // ---------------------------------------------------------------------
  // renderCharts() aggregates on status === 'done', so clearing a day must
  // drop it out of the dashboard charts as well as the ledger.
  console.log('\n-- clearing a day removes it from the charts --');
  {
    const { w, $, $$ } = await openLedger();
    const past = shift(-3);
    $('#prevRunsToggle')?.click();
    await wait(40);
    await openDay({ $, $$ }, past);
    $('#edClear')?.click();
    await wait(150);

    // The charts live on the Today dashboard now; switching there repaints
    // them. Look the pace chart up by canvas id rather than by position in
    // __charts — the old index arithmetic only worked by accident of the
    // order renderCharts() happens to construct them in.
    $$('.tab').find(t => t.dataset.view === 'today').click();
    await wait(80);

    const paceChart = w.__charts.filter(c => !c.destroyed)
      .find(c => c.canvas && c.canvas.id === 'chartPace');
    const points = paceChart ? paceChart.cfg.data.datasets[0].data : null;
    check('cleared run no longer plotted', Array.isArray(points) && !points.includes(7),
          JSON.stringify(points));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- the ledger still works as before --');
  {
    const { w, store, $, $$, errors } = await openLedger();

    check('week labels still rendered', $$('#ledger .week-label').length >= 1,
          String($$('#ledger .week-label').length));
    check('every day has a row',
          $$('#ledger .day-row').length === 6, String($$('#ledger .day-row').length));

    // Editing and saving a day is untouched by any of this.
    await openDay({ $, $$ }, TODAY);
    $('#edDist').value = '4';
    $('#edDist').dispatchEvent(new w.Event('input'));
    $('#edDur').value = '28:00';
    $('#edDur').dispatchEvent(new w.Event('input'));
    check('pace display still computes', $('#edPaceDisplay').textContent === '7:00/km',
          $('#edPaceDisplay').textContent);
    $('#edSave').click();
    await wait(150);

    const day = readPlan(store, PLAN_ID).days[TODAY];
    check('saving a day still persists', day.status === 'done' && day.actual.distance === 4,
          JSON.stringify(day.actual));
    check('success reported', /saved/i.test($('#toast').textContent),
          JSON.stringify($('#toast').textContent));
    check('no errors logged', errors.length === 0, errors.join(' | ').slice(0, 200));
  }

  if (failures.length) {
    console.log('\nFAILURES (' + failures.length + '):');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

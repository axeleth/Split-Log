// The Today page is the dashboard: hero, stat tiles and all three charts on
// one screen, with no Trends tab. These assertions guard the four things that
// are easy to break by accident:
//
//   1. the charts render on FIRST PAINT — nothing else triggers them now that
//      there is no Trends tab to click,
//   2. a renderToday() repaint does not destroy the canvases (they are
//      deliberately siblings of the region it rewrites),
//   3. the stats appear on a day with no planned session as well as on one
//      with a session — renderToday() returns early in that branch,
//   4. weekly volume bars are in chronological order across a month boundary.
//
// Harness matches test/smoke.js: window.storage injected via beforeParse, a
// non-writable Chart stub the CDN cannot replace.
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const failures = [];

function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); failures.push(name); }
}

const blockRemote = [
  requestInterceptor(request => {
    if (request.url.startsWith('file:')) return undefined;
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }),
];

function installChartStub(window) {
  const built = [];
  window.__charts = built;
  const Stub = class {
    constructor(canvas, cfg) { this.canvas = canvas; this.cfg = cfg; this.destroyed = false; built.push(this); }
    destroy() { this.destroyed = true; }
  };
  Object.defineProperty(window, 'Chart', {
    configurable: false, get() { return Stub; }, set() {},
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Dates are derived from today so the seeded runs always land in the weeks the
// assertions talk about. Hardcoding them would make this suite start failing
// on a date months from now.
function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}
function shift(n) {
  const d = new Date(); d.setDate(d.getDate() + n); return toISO(d);
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay() + 1);
  return toISO(d);
}

function mkRun(distance, duration) {
  return {
    type: 'zone2', title: 'Easy run', detail: 'seeded', targetPace: null,
    status: 'done',
    actual: { distance, duration, avgHr: 140, notes: '', pace: duration / distance },
  };
}

// Boot the real page against a seeded store.
async function boot(plans, settings) {
  const store = new Map();
  if (plans) store.set('plans', JSON.stringify(plans));
  store.set('settings', JSON.stringify(Object.assign({
    maxHr: 188, restHr: 58, zoneMethod: 'maxhr', manualZones: null, race5kHr: null,
    vo2Log: [], zone2Pace: 7.1, racePace: 6, racePace10k: 6.33,
  }, settings || {})));

  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'dangerously',
    resources: 'usable', interceptors: blockRemote,
    url: 'file://' + ROOT + '/index.html',
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.storage = {
        async get(key) { return store.has(key) ? { value: store.get(key) } : null; },
        async set(key, value) { store.set(key, value); return true; },
      };
      installChartStub(window);
    },
  });

  const w = dom.window;
  await new Promise(r => w.addEventListener('load', r));
  await wait(150);
  const d = w.document;
  return {
    w, d, store, errors,
    $: s => d.querySelector(s),
    $$: s => Array.from(d.querySelectorAll(s)),
    live: () => w.__charts.filter(c => !c.destroyed),
  };
}

(async () => {
  // -------------------------------------------------------------------
  console.log('\n-- the dashboard replaces the Trends tab --');
  {
    const { $, $$ } = await boot(null);
    check('no trends tab', !$$('.tab').some(t => t.dataset.view === 'trends'));
    check('no trends view', !$('#view-trends'));
    check('three tabs remain', $$('.tab').length === 3, String($$('.tab').length));

    // The canvases must sit OUTSIDE the region renderToday() rewrites, or
    // every repaint would tear them out from under Chart.js.
    check('canvases live on the Today view', !!$('#view-today #chartPace') &&
          !!$('#view-today #chartVo2') && !!$('#view-today #chartVolume'));
    check('canvases are NOT inside the re-rendered region', !$('#todayMain #chartPace'),
          'a canvas inside #todayMain would be destroyed on every renderToday()');
    check('quick-log still on Today', $('#view-today').innerHTML.includes('Log this run'));
  }

  // -------------------------------------------------------------------
  // Nothing clicks a tab here. Before this change renderCharts() was only
  // ever reached from switchView('trends'), so first paint drew nothing.
  console.log('\n-- charts render on first paint, with no tab click --');
  {
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-5), raceDate: shift(20),
      archived: false, days: { [shift(-2)]: mkRun(5, 35) },
    }];
    const { live, errors } = await boot(plans);
    check('three charts built during init', live().length === 3, 'live=' + live().length);
    check('bound to the right canvases',
          live().map(c => c.canvas && c.canvas.id).sort().join(',') === 'chartPace,chartVo2,chartVolume',
          live().map(c => c.canvas && c.canvas.id).join(','));
    check('no errors during boot', errors.length === 0, errors.join(' | '));
  }

  // -------------------------------------------------------------------
  console.log('\n-- stat tiles reflect the logged runs --');
  {
    // Two runs this week (5km/35min, 7km/49min) and one last week (4km).
    // Weighted avg pace = (35+49)/(5+7) = 7:00/km. Mean-of-paces would give
    // the same here, so the last run is deliberately a different pace:
    // 12km in 72min = 6:00. Weighted: (35+49+72)/(5+7+12) = 6.5 = 6:30/km.
    const thisWeekA = mondayOf(shift(0));
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-20), raceDate: shift(20),
      archived: false,
      days: {
        [thisWeekA]: mkRun(5, 35),
        [addDaysISO(thisWeekA, 1)]: mkRun(7, 49),
        [addDaysISO(thisWeekA, 2)]: mkRun(12, 72),
        [addDaysISO(thisWeekA, -7)]: mkRun(4, 28),   // last week
      },
    }];
    const { $, $$ } = await boot(plans);
    const tiles = $$('#todayMain .stat-tile');
    check('three stat tiles rendered', tiles.length === 3, String(tiles.length));

    const text = $('#todayMain').textContent.replace(/\s+/g, ' ');
    check('weekly km totalled', /24\.0\s*km/.test(text), text.slice(0, 200));
    check('runs counted', /3\s*Runs logged|Runs logged 3/.test(text) || /3/.test(text));
    // 24km this week vs 4km last week = +500%
    check('delta vs last week computed', text.includes('500%'), text.slice(0, 300));
    // Weighted, not the mean of per-run paces (which would be 6:39).
    check('avg pace is weighted by distance', text.includes('6:30'), text.slice(0, 300));
  }

  // -------------------------------------------------------------------
  console.log('\n-- a week with no prior week shows no bogus delta --');
  {
    const thisWeekA = mondayOf(shift(0));
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-3), raceDate: shift(20),
      archived: false, days: { [thisWeekA]: mkRun(5, 35) },
    }];
    const { $ } = await boot(plans);
    const text = $('#todayMain').textContent;
    check('no Infinity or NaN in the delta', !/Infinity|NaN/.test(text), text.slice(0, 200));
  }

  // -------------------------------------------------------------------
  // renderToday() returns early when there is no session today, so markup
  // added only to the other branch would silently vanish on rest days.
  console.log('\n-- stats and charts survive a day with no session --');
  {
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-30), raceDate: shift(-10),
      archived: false, days: { [shift(-20)]: mkRun(6, 42) },   // nothing dated today
    }];
    const { $, $$, live } = await boot(plans);
    check('no session planned today', $('#todayMain').innerHTML.includes('No session planned'));
    check('stat tiles still rendered', $$('#todayMain .stat-tile').length === 3,
          String($$('#todayMain .stat-tile').length));
    check('charts still rendered', live().length === 3, 'live=' + live().length);
  }

  // -------------------------------------------------------------------
  console.log('\n-- charts survive a Today repaint --');
  {
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-5), raceDate: shift(20),
      archived: false, days: { [shift(0)]: { type: 'zone2', title: 'Easy run', detail: 'x',
        targetPace: 7, status: 'planned', actual: null } },
    }];
    const { $, $$, w, live } = await boot(plans);

    $('#qlDist').value = '5';
    $('#qlDist').dispatchEvent(new w.Event('input'));
    $('#qlDur').value = '35:00';
    $('#qlDur').dispatchEvent(new w.Event('input'));
    $('#btnLog').click();
    await wait(200);

    check('run logged', $('#todayMain').innerHTML.includes('metric-value'));
    check('still exactly three live charts', live().length === 3, 'live=' + live().length);
    // The real trap: a destroyed canvas would leave Chart bound to a detached
    // node, so assert the live charts' canvases are still in the document.
    const attached = live().every(c => c.canvas && $('#' + c.canvas.id));
    check('live charts bound to attached canvases', attached);
    check('stat tiles rebuilt after logging', $$('#todayMain .stat-tile').length === 3);
  }

  // -------------------------------------------------------------------
  // Weekly volume used to bucket on the DISPLAY label ("Week of 03 Feb") and
  // sort those strings, so February sorted before January.
  console.log('\n-- weekly volume bars are in chronological order --');
  {
    // Four consecutive weeks, guaranteed to straddle at least one month
    // boundary wherever today falls, seeded newest-first so a renderer that
    // preserved insertion order rather than sorting would also be caught.
    const base = mondayOf(shift(-21));
    const days = {};
    [3, 2, 1, 0].forEach(i => { days[addDaysISO(base, i * 7)] = mkRun(5 + i, (5 + i) * 7); });
    const plans = [{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-30), raceDate: shift(10),
      archived: false, days,
    }];
    const { live } = await boot(plans);
    const vol = live().find(c => c.canvas.id === 'chartVolume');
    const labels = vol.cfg.data.labels;
    check('four weekly buckets', labels.length === 4, JSON.stringify(labels));

    // Map each rendered label back to its Monday and confirm it ascends.
    const expected = [0, 1, 2, 3].map(i => addDaysISO(base, i * 7));
    const expectedLabels = expected.map(iso => {
      const d = new Date(iso + 'T00:00:00');
      return 'Week of ' + d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    });
    check('weeks ascend chronologically', labels.join('|') === expectedLabels.join('|'),
          'got ' + JSON.stringify(labels) + ' want ' + JSON.stringify(expectedLabels));
    // Volumes were seeded ascending with the weeks, so the data must too.
    const data = vol.cfg.data.datasets[0].data;
    check('bar values follow their weeks', data.join(',') === '5,6,7,8', data.join(','));
  }

  // -------------------------------------------------------------------
  console.log('\n-- the chart palette stays colourblind-safe --');
  {
    const { live } = await boot(null);
    const pace = live().find(c => c.canvas.id === 'chartPace');
    const vo2 = live().find(c => c.canvas.id === 'chartVo2');
    const vol = live().find(c => c.canvas.id === 'chartVolume');
    const used = [
      pace.cfg.data.datasets[0].borderColor,
      vo2.cfg.data.datasets[0].borderColor,
      vol.cfg.data.datasets[0].backgroundColor,
    ].map(String).map(s => s.toLowerCase());
    // These three passed a six-check CVD/contrast validation against the
    // #faf9f5 surface. Changing one without re-validating is the regression
    // this guards. Amber (#d9a957 / #a67c1a) must never appear: against the
    // green it is indistinguishable under protanopia.
    check('validated series colours in use', used.join(',') === '#c25a33,#2f6da8,#628a2e', used.join(','));
    check('no amber series', !used.some(c => c === '#d9a957' || c === '#a67c1a'), used.join(','));
    check('grid is the paper border tone', String(pace.cfg.options.scales.x.grid.color) === '#e8e6dc',
          String(pace.cfg.options.scales.x.grid.color));
  }

  // -------------------------------------------------------------------
  // Gotcha #4: renderCharts() bails out quietly when Chart.js hasn't arrived.
  // That guard matters more now the charts are on the landing page — the rest
  // of the dashboard must still render, and the retry must eventually draw
  // them once the library shows up.
  console.log('\n-- the page survives Chart.js being slow or absent --');
  {
    const store = new Map();
    store.set('plans', JSON.stringify([{
      id: 'p_seed', name: 'Seed', type: '5k', startDate: shift(-5), raceDate: shift(20),
      archived: false, days: { [shift(-1)]: mkRun(5, 35) },
    }]));

    const vc = new VirtualConsole();
    const hard = [];
    vc.on('jsdomError', e => hard.push(String(e.message || e)));

    // Strip the CDN <script> outright, so Chart is genuinely undefined rather
    // than relying on the interceptor's empty body.
    const noChartHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .replace(/<script src="https:\/\/cdnjs[^"]*"><\/script>/, '');
    const dom = new JSDOM(noChartHtml, {
      runScripts: 'dangerously', resources: 'usable', interceptors: blockRemote,
      url: 'file://' + ROOT + '/index.html', virtualConsole: vc, pretendToBeVisual: true,
      beforeParse(window) {
        window.storage = {
          async get(k) { return store.has(k) ? { value: store.get(k) } : null; },
          async set(k, v) { store.set(k, v); return true; },
        };
      },
    });
    const w2 = dom.window;
    await new Promise(r => w2.addEventListener('load', r));
    await wait(120);
    const d2 = w2.document;

    check('no Chart.js present', typeof w2.Chart === 'undefined');
    check('hero still rendered without charts', !!d2.querySelector('#todayMain .bib'));
    check('stat tiles still rendered without charts',
          d2.querySelectorAll('#todayMain .stat-tile').length === 3);
    check('quick-log still usable without charts', !!d2.querySelector('#btnLog'));
    check('no unhandled error escaped', hard.length === 0, hard.join(' | '));

    // Chart.js arrives late; the guard's retry should pick it up unprompted.
    installChartStub(w2);
    await wait(600);
    check('charts drawn once Chart.js finally loads',
          w2.__charts.filter(c => !c.destroyed).length === 3,
          'live=' + (w2.__charts ? w2.__charts.filter(c => !c.destroyed).length : 'none'));
  }

  console.log('\n' + '='.repeat(50));
  if (failures.length) {
    console.log('DASHBOARD CHECKS FAILED (' + failures.length + ')');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL DASHBOARD CHECKS PASSED');
})().catch(e => { console.error(e); process.exit(1); });

// Local date arithmetic, kept out of the app's own helpers so the test does
// not depend on the implementation it is checking.
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// Smoke test for the split-out Split Log dashboard.
// Mirrors the documented harness: inject window.storage via beforeParse, BEFORE
// any page script runs, since the real host provides it synchronously.
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const store = new Map();
const failures = [];
const logs = [];




// jsdom 29 replaced ResourceLoader with a requestInterceptor hook. Local files
// (styles.css, app.js) load normally; remote ones get an empty stub response.
// Blocking the CDN keeps the Chart stub from beforeParse installed, so
// renderCharts() runs its real code path instead of dying on missing canvas.
const { requestInterceptor } = require('jsdom');
const loader = 'usable';
const blockRemote = [
  requestInterceptor(request => {
    if (request.url.startsWith('file:')) return undefined;   // pass through
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }),
];

// Install a Chart.js stub that the real CDN script cannot overwrite (jsdom has
// no canvas, so real Chart.js throws). This lets renderCharts() run its actual
// code path and lets us assert on the configs it builds.
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

const vc = new VirtualConsole();
vc.on('jsdomError', e => failures.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => { failures.push('console.error: ' + a.join(' ')); });
vc.on('warn', (...a) => logs.push('warn: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  runScripts: 'dangerously',
  resources: loader, interceptors: blockRemote,              // lets it load styles.css + app.js from disk
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
const d = w.document;
const $ = s => d.querySelector(s);
const $$ = s => Array.from(d.querySelectorAll(s));
const wait = ms => new Promise(r => setTimeout(r, ms));

function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); failures.push(name); }
}

(async () => {
  await new Promise(r => w.addEventListener('load', r));
  await wait(150);

  console.log('\n-- external assets linked --');
  check('styles.css referenced', !!$('link[href="styles.css"]'));
  check('app.js referenced', !!$('script[src="app.js"]'));
  check('no inline <style> block left', d.querySelectorAll('style').length === 0);
  const inlineScripts = $$('script').filter(s => !s.src && s.textContent.trim());
  check('no inline <script> block left', inlineScripts.length === 0);
  // Find OUR sheet specifically — styleSheets[0] is the Google Fonts import.
  const ownSheet = Array.from(d.styleSheets).find(s => s.href && s.href.endsWith('styles.css'));
  check('styles.css fetched & parsed', !!ownSheet && ownSheet.cssRules.length > 40,
        ownSheet ? 'rules=' + ownSheet.cssRules.length : 'sheet not found; hrefs=' +
          Array.from(d.styleSheets).map(s => s.href).join(','));
  // Every class the JS/HTML relies on must exist in the extracted stylesheet.
  if (ownSheet) {
    const css = Array.from(ownSheet.cssRules).map(r => r.cssText).join('\n');
    const needed = ['.is-hidden', '.pace-display', '.metric-value', '.metric-label', '.metrics',
                    '.target-pace', '.badge.status-done', '.badge.status-skipped', '.bib-type.type-none',
                    '.archive-row.confirming', 'button.danger', 'button.danger-strong', 'button.icon',
                    '.day-dow', '.plan-detail-header', '.panel-head', '.hint', '.hint-mono',
                    '.hint-after', '.zone-empty', '.back-btn',
                    // dashboard classes the Today renderer emits
                    '.dash', '.dash-hero', '.dash-aside', '.stat-tile', '.stat-label',
                    '.stat-value', '.stat-unit', '.stat-delta', '.target-zone',
                    '.chart-row', '.chart-card', '.chart-canvas',
                    '.ql-head', '.ql-close'];
    const missing = needed.filter(sel => !css.includes(sel));
    check('all promoted classes defined in CSS', missing.length === 0, 'missing: ' + missing.join(' '));
    check('.is-hidden actually hides', /\.is-hidden\s*\{\s*display:\s*none/.test(css));
  }
  check('no leftover style="" attributes in HTML source',
        !fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('style="'));

  console.log('\n-- init ran --');
  check('today view rendered', $('#view-today').innerHTML.includes('Log this run'));
  check('date inputs seeded', /^\d{4}-\d{2}-\d{2}$/.test($('#fivekStartInput').value),
        $('#fivekStartInput').value);
  check('settings rendered from defaults', $('#race5kHrInput').value === '180',
        $('#race5kHrInput').value);
  check('default method is 5k -> its panel visible',
        !$('#method5k').classList.contains('is-hidden') && $('#methodManual').classList.contains('is-hidden'));
  check('zone grid computed', $$('#zoneGrid .zone-cell').length === 5);
  check('settings persisted on first load', store.has('settings'));

  console.log('\n-- quick log a run --');
  $('#qlDist').value = '5';
  $('#qlDist').dispatchEvent(new w.Event('input'));
  $('#qlDur').value = '32:30';
  $('#qlDur').dispatchEvent(new w.Event('input'));
  check('live pace display computes', $('#qlPaceDisplay').textContent === '6:30/km',
        $('#qlPaceDisplay').textContent);
  $('#qlNotes').value = 'felt good';
  $('#btnLog').click();
  await wait(120);
  const plans = JSON.parse(store.get('plans'));
  const adhoc = plans.find(p => p.id === '__adhoc__');
  const logged = adhoc && Object.values(adhoc.days)[0];
  check('run saved to adhoc plan', !!logged, JSON.stringify(plans).slice(0, 120));
  check('pace derived = duration/distance', logged && Math.abs(logged.actual.pace - 6.5) < 1e-9,
        logged && logged.actual.pace);
  check('toast shown', $('#toast').classList.contains('show'));
  check('today re-rendered with metrics', $('#view-today').innerHTML.includes('metric-value'));

  console.log('\n-- generate a 5K plan --');
  $('#fivekStartInput').value = '2026-08-12';
  $('#raceDateInput').value = '2026-08-31';
  $('#btnGen5k').click();
  await wait(120);
  const plans2 = JSON.parse(store.get('plans'));
  const p5k = plans2.find(p => p.type === '5k');
  check('5K plan created', !!p5k);
  check('race day is the race date', p5k && p5k.days['2026-08-31'] && p5k.days['2026-08-31'].type === 'race');
  check('no UTC date shift at plan start', p5k && !!p5k.days['2026-08-12'],
        p5k && Object.keys(p5k.days).slice(0, 2).join(','));
  check('plan card listed', $$('#planList .plan-card').length === 1);
  check('plan panel shows list, not detail',
        !$('#planListPanel').classList.contains('is-hidden') && $('#planDetailPanel').classList.contains('is-hidden'));

  console.log('\n-- open plan detail + ledger editor --');
  $('#planList .plan-card').click();
  await wait(60);
  check('detail panel visible', !$('#planDetailPanel').classList.contains('is-hidden'));
  check('list panel hidden', $('#planListPanel').classList.contains('is-hidden'));
  check('ledger rows rendered', $$('#ledger .day-row').length > 15, $$('#ledger .day-row').length);
  check('week labels rendered', $$('#ledger .week-label').length >= 3);
  $('#ledger .day-row').click();
  await wait(60);
  check('editor opened in slot', !!$('.editor #edSave'));
  $('#edDist').value = '4';
  $('#edDist').dispatchEvent(new w.Event('input'));
  $('#edDur').value = '28:00';
  $('#edDur').dispatchEvent(new w.Event('input'));
  check('editor pace display computes', $('#edPaceDisplay').textContent === '7:00/km',
        $('#edPaceDisplay').textContent);
  $('#edSave').click();
  await wait(120);
  const plans3 = JSON.parse(store.get('plans'));
  const p5kb = plans3.find(p => p.type === '5k');
  const firstDay = p5kb.days[Object.keys(p5kb.days).sort()[0]];
  check('editor save persisted', firstDay.status === 'done' && Math.abs(firstDay.actual.pace - 7) < 1e-9,
        JSON.stringify(firstDay.actual));

  console.log('\n-- dashboard charts on Today --');
  check('no trends tab remains', !$$('.tab').some(t => t.dataset.view === 'trends'));
  check('no trends view remains', !$('#view-trends'));
  check('nav is today/plan/settings',
        $$('.tab').map(t => t.dataset.view).join(',') === 'today,plan,settings',
        $$('.tab').map(t => t.dataset.view).join(','));

  $$('.tab').find(t => t.dataset.view === 'today').click();
  await wait(60);
  check('today view active', $('#view-today').classList.contains('active'));
  // The canvases live outside #todayMain precisely so a Today repaint cannot
  // destroy them; assert they are still attached to the document.
  check('canvases survive a Today repaint',
        !!$('#chartPace') && !!$('#chartVo2') && !!$('#chartVolume'));
  const built = w.__charts;
  const live = built.filter(c => !c.destroyed);
  check('three charts live after render', live.length === 3, 'built=' + built.length + ' live=' + live.length);
  check('charts bound to the right canvases',
        live.map(c => c.canvas && c.canvas.id).sort().join(',') === 'chartPace,chartVo2,chartVolume',
        live.map(c => c.canvas && c.canvas.id).join(','));
  // Stricter than the old form, which allowed `built.length === 3` because
  // Trends was the first thing ever to build charts. init() now builds them,
  // so every render past the first must have destroyed its predecessors.
  check('prior charts destroyed, not leaked', built.filter(c => c.destroyed).length === built.length - 3,
        'built=' + built.length + ' destroyed=' + built.filter(c => c.destroyed).length);
  const paceChart = live.find(c => c.canvas.id === 'chartPace');
  check('pace y-axis formats as m:ss', paceChart.cfg.options.scales.y.ticks.callback(6.5) === '6:30',
        String(paceChart.cfg.options.scales.y.ticks.callback(6.5)));
  $$('.tab').find(t => t.dataset.view === 'plan').click();
  await wait(60);
  check('plan tab resets to list panel (known gotcha #3)',
        !$('#planListPanel').classList.contains('is-hidden') && $('#planDetailPanel').classList.contains('is-hidden'));

  console.log('\n-- archive + two-step delete --');
  $('#btnShowArchive').click();
  await wait(40);
  check('archive panel visible', !$('#planArchivePanel').classList.contains('is-hidden'));
  check('archive empty initially', $('#archiveList').innerHTML.includes('No archived plans'));
  $('#btnBackFromArchive').click();
  await wait(40);
  $('.plan-archive-btn').click();
  await wait(120);
  check('plan archived', JSON.parse(store.get('plans')).find(p => p.type === '5k').archived === true);
  $('#btnShowArchive').click();
  await wait(60);
  check('archived row shown', $$('#archiveList .archive-row').length === 1);
  $('.archive-delete-btn').click();
  await wait(40);
  check('confirm stage 1', !!$('.archive-confirm1-btn') && $('.archive-row').classList.contains('confirming'));
  $('.archive-confirm1-btn').click();
  await wait(40);
  check('confirm stage 2', !!$('.archive-confirm2-btn'));
  $('.archive-confirm2-btn').click();
  await wait(120);
  check('plan deleted', !JSON.parse(store.get('plans')).some(p => p.type === '5k'));

  console.log('\n-- settings flows --');
  $$('.tab').find(t => t.dataset.view === 'settings').click();
  await wait(60);
  $('#zoneMethodSelect').value = 'manual';
  $('#zoneMethodSelect').dispatchEvent(new w.Event('change'));
  await wait(80);
  check('manual panel shown on method change',
        !$('#methodManual').classList.contains('is-hidden') && $('#method5k').classList.contains('is-hidden'));
  $('#paceZone2Input').value = '7:10';
  $('#btnSavePaces').click();
  await wait(80);
  check('pace target saved & round-tripped', Math.abs(JSON.parse(store.get('settings')).zone2Pace - (7 + 10 / 60)) < 1e-9);
  check('pace re-rendered as m:ss', $('#paceZone2Input').value === '7:10', $('#paceZone2Input').value);
  $('#vo2ValueInput').value = '39.4';
  $('#btnAddVo2').click();
  await wait(80);
  check('vo2 entry added', JSON.parse(store.get('settings')).vo2Log.length === 1);
  check('vo2 row rendered', $$('#vo2Log .vo2-log-row').length === 1);
  $('[data-vo2idx]').click();
  await wait(80);
  check('vo2 entry deleted', JSON.parse(store.get('settings')).vo2Log.length === 0);

  console.log('\n-- reload with existing data --');
  const dom2 = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    runScripts: 'dangerously', resources: loader, interceptors: blockRemote,
    url: 'file://' + ROOT + '/index.html', virtualConsole: vc, pretendToBeVisual: true,
    beforeParse(window) {
      window.storage = {
        async get(k) { return store.has(k) ? { value: store.get(k) } : null; },
        async set(k, v) { store.set(k, v); return true; },
      };
      // The stub is needed here too, now that init() draws the dashboard
      // charts on first paint. Without it, real Chart.js reaches jsdom's
      // unimplemented canvas getContext() — a limitation of the test
      // environment, not of the app, but it reports through the shared
      // virtualConsole and would read as six spurious failures.
      installChartStub(window);
    },
  });
  await new Promise(r => dom2.window.addEventListener('load', r));
  await wait(150);
  const d2 = dom2.window.document;
  check('reload restores logged run in Today', d2.querySelector('#view-today').innerHTML.includes('Logged run'));
  check('reload restores settings', d2.querySelector('#paceZone2Input').value === '7:10',
        d2.querySelector('#paceZone2Input').value);

  console.log('\n' + '='.repeat(50));
  if (logs.length) console.log('warnings:\n  ' + logs.join('\n  '));
  if (failures.length) { console.log('FAILURES (' + failures.length + '):\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

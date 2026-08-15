// Calendar export: turn a plan into an iCalendar (.ics) file for Apple Calendar.
//
// What the export has to get right, and why each is worth a test:
//
//   1. Rest days are left out. They are nothing to do, so putting them in the
//      calendar is pure noise.
//   2. Completed and skipped sessions ARE included, as ordinary sessions with
//      no status marker. The export is normally taken when a plan is created,
//      so it should describe the plan, not its progress.
//   3. All-day DTEND is EXCLUSIVE in RFC 5545: a one-day event ends on the
//      NEXT day. Emitting DTEND == DTSTART produces a zero-length event that
//      calendars either drop or render wrong. This is the classic off-by-one.
//   4. UIDs are deterministic, so re-importing an updated plan updates the
//      existing events instead of duplicating every session.
//   5. Dates come straight off the stored 'YYYY-MM-DD' keys with the dashes
//      removed — never via a Date round-trip, which is what shifted dates a
//      day west in CLAUDE.md gotcha #1.
//   6. Text is escaped and folded per RFC 5545, or a comma in a session's
//      detail silently truncates the description in the importing calendar.
//
// Dates are derived from today, never hardcoded: a fixed fixture would stop
// straddling past/future and the "previous runs" split would go empty, taking
// the past-day assertions with it.
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const failures = [];

function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); failures.push(name); }
}

// Same Chart stub as the other suites: jsdom has no canvas, so real Chart.js
// throws. Non-configurable with a no-op setter so the CDN script cannot replace it.
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

// app.js exports nothing to window, so the only way to see the generated file
// is to intercept the download. Capturing the Blob's bytes at
// createObjectURL time gives us the real string the real click path produced,
// rather than a re-implementation of it. Blob.text() is async and the app
// revokes the URL immediately, so the text is read synchronously here.
function installDownloadCapture(window) {
  const captured = [];
  window.__downloads = captured;
  const realCreate = window.URL.createObjectURL ? window.URL.createObjectURL.bind(window.URL) : null;
  window.URL.createObjectURL = function (blob) {
    captured.push({ type: blob && blob.type, blob });
    return 'blob:mock/' + captured.length;
  };
  window.URL.revokeObjectURL = function () { /* no-op */ };
  window.__realCreateObjectURL = realCreate;

  // Record the filename the anchor asked for, and stop jsdom from complaining
  // about "not implemented: navigation" when the synthetic click fires.
  const proto = window.HTMLAnchorElement.prototype;
  const realClick = proto.click;
  proto.click = function () {
    if (this.download) {
      captured.push({ filename: this.download, href: this.href });
      return;
    }
    return realClick.apply(this, arguments);
  };
}

// Local-component date maths, mirroring app.js's toLocalISODate/addDays.
// toISOString() would shift the date back a day east of UTC (gotcha #1).
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = iso(new Date());
function shift(n) { const d = new Date(TODAY + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); }

function boot({ plans, settings } = {}) {
  const store = new Map();
  if (plans) store.set('plans', JSON.stringify(plans));
  if (settings) store.set('settings', JSON.stringify(settings));
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
        async set(key, value) { store.set(key, value); return true; },
      };
      installChartStub(window);
      installDownloadCapture(window);
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

// A plan straddling today, covering every case the export has to decide about:
// a done day, a skipped day, two rest days (one past, one future), a plain
// planned day, and a race. One detail carries the punctuation that RFC 5545
// escaping exists for; another is long enough to force line folding.
const PLAN_ID = 'p_fixture';
const LONG_DETAIL = 'Warm up gently for fifteen minutes, then run eight repetitions of ninety seconds at threshold effort with equal recovery, then cool down for another fifteen minutes.';
const PUNCT_DETAIL = 'Easy, conversational; keep it slow.\nWalk if needed.';

function fixturePlan() {
  const mk = (type, title, detail, targetPace, extra) => Object.assign({
    type, title, detail, targetPace, status: 'planned', actual: null,
  }, extra || {});
  return {
    id: PLAN_ID, name: 'Fixture 5K', type: '5k',
    startDate: shift(-3), raceDate: shift(3), archived: false,
    days: {
      [shift(-3)]: mk('zone2', 'Zone 2 run', PUNCT_DETAIL, 7, {
        status: 'done',
        actual: { distance: 5, duration: 35, avgHr: 150, notes: 'felt good', pace: 7 },
      }),
      [shift(-2)]: mk('rest', 'Rest', 'Full rest.', null),
      [shift(-1)]: mk('hard', 'Intervals', LONG_DETAIL, null, { status: 'skipped' }),
      [TODAY]: mk('zone2', 'Zone 2 run', 'Easy aerobic pace.', 7),
      [shift(1)]: mk('rest', 'Rest', 'Full rest.', null),
      [shift(3)]: mk('race', 'Race day', '5K time trial.', 6),
    },
  };
}

// Open the fixture plan's ledger, ready to click Export.
async function openLedger(opts) {
  const ctx = boot(Object.assign({ plans: [fixturePlan()] }, opts || {}));
  await ctx.ready();
  ctx.$$('.tab').find(t => t.dataset.view === 'plan').click();
  await wait(60);
  ctx.$('#planList .plan-card').click();
  await wait(60);
  return ctx;
}

// Click Export and return the generated .ics text.
async function exportIcs(ctx) {
  ctx.$('#btnExportIcs').click();
  await wait(80);
  const blobEntry = ctx.w.__downloads.find(e => e.blob);
  if (!blobEntry) return null;
  return Buffer.from(await blobEntry.blob.arrayBuffer()).toString('utf8');
}

// Split an .ics into its VEVENT blocks, unfolding continuation lines first so
// property lookups do not have to care where the folding fell.
function unfold(text) { return text.replace(/\r\n /g, ''); }
function events(text) {
  return unfold(text).split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
}
function prop(block, name) {
  const line = block.split('\r\n').find(l => l.startsWith(name));
  return line ? line.slice(line.indexOf(':') + 1) : null;
}

(async () => {
  // ---------------------------------------------------------------------
  console.log('\n-- the export control exists in a plan ledger --');
  {
    const ctx = await openLedger();
    check('Export button present in plan detail header', !!ctx.$('#btnExportIcs'));
    check('Archive button still present alongside it', !!ctx.$('#btnArchivePlan'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- a well-formed iCalendar file is produced --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);

    check('a file was generated', !!ics);
    check('opens with BEGIN:VCALENDAR', !!ics && ics.startsWith('BEGIN:VCALENDAR\r\n'), ics && ics.slice(0, 30));
    check('closes with END:VCALENDAR', !!ics && ics.trimEnd().endsWith('END:VCALENDAR'));
    check('declares VERSION:2.0', !!ics && ics.includes('VERSION:2.0'));
    check('declares a PRODID', !!ics && /PRODID:-\/\/Split Log/.test(ics));
    check('names the calendar after the plan', !!ics && ics.includes('X-WR-CALNAME:Fixture 5K'));
    check('uses CRLF line endings', !!ics && ics.includes('\r\n') && !/[^\r]\n/.test(ics));
    check('every VEVENT is closed', !!ics
      && (ics.match(/BEGIN:VEVENT/g) || []).length === (ics.match(/END:VEVENT/g) || []).length);
    check('every event carries a DTSTAMP', events(ics).every(e => !!prop(e, 'DTSTAMP')));

    const blobEntry = ctx.w.__downloads.find(e => e.blob);
    check('served as text/calendar', !!blobEntry && /text\/calendar/.test(blobEntry.type), blobEntry && blobEntry.type);
    const named = ctx.w.__downloads.find(e => e.filename);
    check('downloaded with an .ics filename', !!named && named.filename.endsWith('.ics'), named && named.filename);
    check('filename slugged from the plan name', !!named && named.filename === 'fixture-5k.ics', named && named.filename);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- rest days are excluded, every other session is included --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);
    const evs = events(ics);

    check('one event per non-rest day', evs.length === 4, 'got ' + evs.length);
    check('rest days are not exported', !unfold(ics).includes('SUMMARY:Rest'));
    check('no event falls on a rest day date', !evs.some(e => {
      const s = prop(e, 'DTSTART;VALUE=DATE');
      return s === shift(-2).replace(/-/g, '') || s === shift(1).replace(/-/g, '');
    }));

    const summaries = evs.map(e => prop(e, 'SUMMARY'));
    check('the planned session is included', summaries.includes('Zone 2 run'));
    check('the race is included', summaries.includes('Race day'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- done and skipped sessions export as ordinary sessions --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);
    const evs = events(ics);

    const done = evs.find(e => prop(e, 'DTSTART;VALUE=DATE') === shift(-3).replace(/-/g, ''));
    const skipped = evs.find(e => prop(e, 'DTSTART;VALUE=DATE') === shift(-1).replace(/-/g, ''));

    check('the completed session is exported', !!done);
    check('the skipped session is exported', !!skipped);
    check('no status marker anywhere in the file',
      !/\b(Done|Skipped|STATUS:)/i.test(unfold(ics).replace(/PRODID:[^\r]*/g, '')));
    check('completed session keeps its planned title', done && prop(done, 'SUMMARY') === 'Zone 2 run');
    check('completed session does not carry its logged actuals',
      done && !prop(done, 'DESCRIPTION').includes('felt good'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- all-day events: DTEND is exclusive (the off-by-one) --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);
    const evs = events(ics);

    check('DTSTART is a VALUE=DATE property', evs.every(e => !!prop(e, 'DTSTART;VALUE=DATE')));
    check('no timed DTSTART sneaks in', !/DTSTART:\d{8}T/.test(unfold(ics)));

    const race = evs.find(e => prop(e, 'SUMMARY') === 'Race day');
    check('race DTSTART is its own date', race && prop(race, 'DTSTART;VALUE=DATE') === shift(3).replace(/-/g, ''),
      race && prop(race, 'DTSTART;VALUE=DATE'));
    check('race DTEND is the NEXT day, not the same day',
      race && prop(race, 'DTEND;VALUE=DATE') === shift(4).replace(/-/g, ''),
      race && prop(race, 'DTEND;VALUE=DATE'));
    check('no event is zero-length',
      evs.every(e => prop(e, 'DTEND;VALUE=DATE') !== prop(e, 'DTSTART;VALUE=DATE')));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- dates match the stored keys exactly (no timezone drift) --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);
    const evs = events(ics);

    // Every DTSTART must equal its own storage key with the dashes stripped.
    // A Date round-trip anywhere in the chain shows up here as an off-by-one.
    const expected = Object.keys(fixturePlan().days)
      .filter(d => fixturePlan().days[d].type !== 'rest')
      .sort()
      .map(d => d.replace(/-/g, ''));
    const actual = evs.map(e => prop(e, 'DTSTART;VALUE=DATE'));
    check('DTSTARTs equal the stored dates, in order',
      JSON.stringify(actual) === JSON.stringify(expected),
      JSON.stringify(actual) + ' vs ' + JSON.stringify(expected));
    check('all dates are 8-digit basic-format', actual.every(a => /^\d{8}$/.test(a)));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- UIDs are stable across exports, so re-import updates --');
  {
    const first = await exportIcs(await openLedger());
    const second = await exportIcs(await openLedger());

    const uids = t => events(t).map(e => prop(e, 'UID'));
    check('UIDs are identical between two exports',
      JSON.stringify(uids(first)) === JSON.stringify(uids(second)),
      JSON.stringify(uids(first)) + ' vs ' + JSON.stringify(uids(second)));
    check('UID is derived from plan id and date',
      uids(first).includes(`${PLAN_ID}-${TODAY}@splitlog`), uids(first).join(','));
    check('UIDs are unique within the file', new Set(uids(first)).size === uids(first).length);
    check('no random ids leaked into UIDs', !uids(first).some(u => /p_[a-z0-9]+_[a-z0-9]{5}-/.test(u.replace(PLAN_ID, ''))));
    check('every event declares SEQUENCE', events(first).every(e => prop(e, 'SEQUENCE') !== null));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- RFC 5545 escaping and folding --');
  {
    const ctx = await openLedger();
    const ics = await exportIcs(ctx);

    const done = events(ics).find(e => prop(e, 'DTSTART;VALUE=DATE') === shift(-3).replace(/-/g, ''));
    const desc = prop(done, 'DESCRIPTION');
    check('commas are escaped', desc.includes('Easy\\, conversational'), desc);
    check('semicolons are escaped', desc.includes('conversational\\; keep'), desc);
    check('newlines become literal \\n', desc.includes('\\nWalk if needed'), desc);
    // The raw newline in the fixture's detail must not survive as a line break:
    // every line of the unfolded block has to be a real NAME:value property, or
    // the description has silently split into a broken property the importer
    // will reject.
    const bodyLines = done.split('\r\n').filter(Boolean);
    check('no raw newline breaks the property',
      bodyLines.every(l => /^[A-Z][A-Z-]*[;:]/.test(l)),
      bodyLines.find(l => !/^[A-Z][A-Z-]*[;:]/.test(l)));
    check('the description survives as a single property',
      bodyLines.filter(l => l.startsWith('DESCRIPTION')).length === 1);

    // Folding: RFC 5545 caps a content line at 75 octets, continuing with a
    // leading space. The long-detail session is what forces it.
    const rawLines = ics.split('\r\n');
    const over = rawLines.filter(l => Buffer.byteLength(l, 'utf8') > 75);
    check('no line exceeds 75 octets', over.length === 0, over[0]);
    check('folding actually happened', rawLines.some(l => l.startsWith(' ')));
    check('unfolding recovers the long detail',
      unfold(ics).includes('eight repetitions of ninety seconds at threshold effort'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- descriptions carry the training targets --');
  {
    const ctx = await openLedger({
      settings: { maxHr: null, restHr: null, vo2Log: [], manualZones: null,
                  zoneMethod: '5k', race5kHr: 180, zone2Pace: 7, racePace: 6, racePace10k: null },
    });
    const ics = await exportIcs(ctx);
    const evs = events(ics);

    const today = evs.find(e => prop(e, 'DTSTART;VALUE=DATE') === TODAY.replace(/-/g, ''));
    check('target pace is in the description', prop(today, 'DESCRIPTION').includes('7:00/km'),
      prop(today, 'DESCRIPTION'));
    check('target HR zone is in the description', /Z2 \d+-\d+ bpm/.test(prop(today, 'DESCRIPTION')),
      prop(today, 'DESCRIPTION'));
    check('session type is categorised', prop(today, 'CATEGORIES') === 'Zone 2', prop(today, 'CATEGORIES'));
    check('the detail prose is kept', prop(today, 'DESCRIPTION').includes('Easy aerobic pace.'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- a plan with nothing exportable does not emit a file --');
  {
    const restOnly = fixturePlan();
    restOnly.days = {
      [TODAY]: { type: 'rest', title: 'Rest', detail: 'Full rest.', targetPace: null, status: 'planned', actual: null },
      [shift(1)]: { type: 'rest', title: 'Rest', detail: 'Full rest.', targetPace: null, status: 'planned', actual: null },
    };
    const ctx = boot({ plans: [restOnly] });
    await ctx.ready();
    ctx.$$('.tab').find(t => t.dataset.view === 'plan').click();
    await wait(60);
    ctx.$('#planList .plan-card').click();
    await wait(60);
    ctx.$('#btnExportIcs').click();
    await wait(80);

    check('no download is triggered', ctx.w.__downloads.length === 0, JSON.stringify(ctx.w.__downloads));
    check('the user is told why', /nothing to export/i.test(ctx.$('#toast').textContent),
      ctx.$('#toast').textContent);
  }

  // ---------------------------------------------------------------------
  console.log('\n-- the export button does not disturb the rest of the ledger --');
  {
    // The export button shares the detail header with Archive, and that header
    // is re-rendered wholesale, so a broken listener re-attach would show up
    // as Archive silently doing nothing.
    const ctx = await openLedger();
    await exportIcs(ctx);

    check('ledger still rendered after export', ctx.$$('#ledger .day-row').length > 0);

    // Day rows still open their editor.
    const row = ctx.$$('#ledger .day-row').find(r => r.dataset.date === TODAY);
    row.click();
    await wait(60);
    check('day editor still opens after an export', !!ctx.$('#edSave'));

    // And Archive still works from the same header.
    ctx.$('#btnArchivePlan').click();
    await wait(150);
    const stored = JSON.parse(ctx.store.get('plans')).find(p => p.id === PLAN_ID);
    check('Archive plan still archives', stored.archived === true, JSON.stringify(stored.archived));
    check('returned to the plan list', !ctx.$('#planListPanel').classList.contains('is-hidden'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- the fallback surface exists for hosts that block downloads --');
  {
    // The artifact host sandboxes the app and may block a Blob download the
    // same way it blocks confirm() (gotcha #2). When that happens the text has
    // to be recoverable in-page rather than silently lost.
    const ctx = await openLedger();
    ctx.w.URL.createObjectURL = () => { throw new Error('blocked by sandbox'); };

    ctx.$('#btnExportIcs').click();
    await wait(80);

    const box = ctx.$('#icsFallback');
    check('fallback panel is shown', !!box && !box.classList.contains('is-hidden'));
    const ta = ctx.$('#icsText');
    check('the .ics text is recoverable in-page', !!ta && ta.value.startsWith('BEGIN:VCALENDAR'),
      ta && ta.value.slice(0, 20));
    check('a copy control is offered', !!ctx.$('#btnIcsCopy'));

    ctx.$('#btnIcsClose').click();
    await wait(40);
    check('fallback can be dismissed', ctx.$('#icsFallback').classList.contains('is-hidden'));
  }

  // ---------------------------------------------------------------------
  console.log('\n-- no console errors during any of the above --');
  {
    const ctx = await openLedger();
    await exportIcs(ctx);
    check('no page errors', ctx.errors.length === 0, ctx.errors.join(' | '));
  }

  console.log('\n' + '='.repeat(50));
  if (failures.length) {
    console.log('FAILURES (' + failures.length + '):\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

# Split Log — Running Training Tracker

A static HTML/JS/CSS training dashboard for planning and logging runs
(5K/10K training blocks, zone-based heart rate targets, pace tracking,
VO2max trends). Originally built as a Claude.ai artifact using the
`window.storage` persistence API.

## Files

```
index.html         markup only — no inline <style> or <script>
styles.css         all styling, incl. the design tokens in :root
app.js             all behaviour, wrapped in an IIFE, loaded with `defer`
storage-shim.js    window.storage over localStorage, for self-hosting
public/            what gets deployed: login.html + symlinks to the above
deploy.sh          check / deploy / status / provision / rollback
test/smoke.js      jsdom smoke test of the app  — `npm run test:smoke`
test/storage-shim.js  jsdom test of the shim    — `npm run test:shim`
```

`npm test` runs both suites.

`index.html` links `styles.css` in `<head>` and `app.js` with `defer`, so
the script runs after parsing but before `DOMContentLoaded`. `app.js`
guards on `document.readyState` anyway, so load order is not fragile.

**Serving:** because it now loads sibling files, `index.html` needs to be
served over HTTP rather than opened via `file://` (browsers block some
relative fetches from `file://`, and the artifact host serves a single
document). `npm run serve` starts a static server on :8080. To go back to
a single pasteable artifact file, inline the two files into one document.

## Stack

- **No framework.** Vanilla HTML + CSS + JS, no build step.
- **Chart.js** (loaded via `<script src="https://cdnjs.cloudflare.com/...">`) for
  the three Trends charts (pace, VO2max, weekly volume).
- **Fonts:** Bebas Neue (display/headers), IBM Plex Mono (stats/data/labels),
  Inter (body text) — loaded from Google Fonts.
- **Persistence:** `window.storage.get/set(key, value, shared?)`, a
  key-value async API injected by the Claude.ai artifact host. **App code
  must keep using `window.storage`** — never call localStorage or
  sessionStorage directly from `app.js`, since neither exists on the
  artifact host.

  When self-hosted, `storage-shim.js` supplies the same API backed by
  `localStorage` (keys namespaced `splitlog:`). `index.html` loads it
  immediately before `app.js`; both are `defer`, and deferred scripts run
  in document order, so the shim always installs first. It no-ops when a
  real `window.storage` is already present, so `app.js` runs unmodified in
  both environments. The contract is
  `get -> {value}|null`, `set -> truthy`, and both halves are load-bearing:
  `loadAll()` reads `.value` and branches on null, and the hardened save
  handlers do `if(!ok) throw`.

`app.js` therefore stays host-agnostic: the shim is the only integration
point, and it is a separate file precisely so `app.js` need not change.

## Storage schema

Two top-level keys, both JSON-stringified:

- **`plans`** → array of plan objects:
  ```js
  {
    id: string,            // genId(), e.g. "p_abc123_xy"
    name: string,          // e.g. "5K — 29 Aug"
    type: '5k' | '10k' | 'legacy' | 'adhoc',
    startDate: 'YYYY-MM-DD' | null,
    raceDate: 'YYYY-MM-DD' | null,
    archived: boolean,
    days: {
      'YYYY-MM-DD': {
        type: 'zone2' | 'hard' | 'rest' | 'race',
        title: string,
        detail: string,
        targetPace: number|null,   // decimal min/km, e.g. 6.5 = 6:30/km
        status: 'planned' | 'done' | 'skipped',
        actual: {
          distance: number,        // km
          duration: number,        // decimal minutes (e.g. 31.5 = 31:30)
          avgHr: number|null,
          notes: string,
          pace: number|null        // decimal min/km, always = duration/distance
        } | null
      }
    }
  }
  ```
  There's always a special plan with `id: '__adhoc__'` (constant `ADHOC_ID`,
  name "Logged runs") that holds any logged day not covered by a real
  generated plan. It's excluded from the Plan tab's card list and archive
  list, but included in trend/chart aggregation.

- **`settings`** → single object:
  ```js
  {
    maxHr, restHr,              // used by the 'maxhr' zone method
    zoneMethod: 'manual' | '5k' | 'maxhr',
    manualZones: {z1, z2lo, z2hi, z3lo, z3hi, z4lo, z4hi, z5lo} | null,
    race5kHr: number|null,      // all-out 5K avg HR, used by the '5k' zone method
    vo2Log: [{date, value}],
    zone2Pace, racePace, racePace10k   // decimal min/km target paces
  }
  ```

**Migration:** `loadAll()` checks for a legacy flat `plan-days` key (an
earlier data shape, pre-multi-plan redesign) and wraps it into a single
`type: 'legacy'` plan if found, on first load only.

## Key functions (all in `app.js`, which is organised into numbered sections)

- `todayStr()` / `addDays()` / `fmtDate()` / `dow()` / `isoWeekLabel()` —
  **always use `toLocalISODate()`-based helpers, never `.toISOString()`**
  for date-only strings. `toISOString()` converts to UTC, which silently
  shifts dates back a day for any timezone ahead of UTC (this was a real
  bug — see Known Gotchas).
- `fmtPace()` / `parsePace()` — convert between decimal minutes and
  `M:SS` strings (paces).
- `fmtDuration()` / `parseDuration()` — same idea for durations, but also
  accepts `H:MM:SS` for runs over an hour.
- `generate5kPlan(startDate, raceDate)` / `generate10kPlan(startDate)` —
  pure functions that return a new plan object (don't mutate global
  state). The 5K generator **resamples** an 18-step prep pattern
  proportionally across however many days exist between start and race,
  so a 10-day gap and a 40-day gap both produce a sensibly-paced plan.
- `findDayEntry(date)` — searches all plans (including archived ones) for
  a day matching `date`, returns `{plan, day}` or `null`. Used by Today's
  view and quick-log to find/attribute today's session.
- `computeZones()` — branches on `SETTINGS.zoneMethod` to return the
  5-zone HR table from either manual ranges, the "% of all-out 5K HR"
  formula, or the classic max-HR-percentage method.
- `renderToday()` / `renderPlanList()` / `renderPlanLedger()` /
  `renderCharts()` / `renderSettings()` — full-innerHTML re-renders, not
  incremental DOM patches. Simple but means event listeners must be
  re-attached after every render (see `attachQuickLog`, `attachEditor`).

## UI structure

Four tabs: **Today**, **Plan**, **Trends**, **Settings**.

Plan tab has three panels toggled via `display:none/block` (not separate
routes): `#planListPanel` (card list), `#planDetailPanel` (one plan's
day-by-day ledger, opened by clicking a card), `#planArchivePanel`
(archived plans, each with Unarchive/Delete). `switchView()` always resets
Plan tab to the list panel — it deliberately does **not** remember which
plan detail was open, since that caused a confusing bug where the tab
looked "stuck" on a flat list (see Known Gotchas).

Inside a plan's ledger, days dated before today are grouped into a
collapsed `#prevRuns` section ("Previous runs (N)"), so the ledger opens on
today rather than on weeks of history. Rows inside it are ordinary
`.day-row`s and stay fully editable. The collapsed state is deliberately
**not** persisted — reopening a plan always starts collapsed, matching how
`switchView()` resets the Plan tab.

The day editor has three actions: **Save**, **Clear day** (resets a logged
day to `planned` and drops `actual`, keeping the planned session's type,
title, detail and target pace — only shown when the day has data) and
**Delete day** (removes the day entirely, behind an in-page confirm).

## Design language

Dark "race bib / split-timer" theme — CSS variables in `:root` (`--bg`,
`--surface`, `--z2` chartreuse for easy/zone2, `--hard` coral for
intensity, `--rest` slate, `--gold` for race/target-pace accents). The
"Today" hero card mimics a race bib. Keep new UI consistent with this
rather than introducing new colors/fonts ad hoc.

## Known gotchas (already fixed once, don't reintroduce)

1. **Timezone date bug:** never build date strings with
   `date.toISOString().slice(0,10)`. Use the local-component-based
   `toLocalISODate()`. This bit us once — plans generated a day early for
   users in UTC+ timezones.
2. **`window.confirm()` / `alert()` don't work** — the artifact runs in a
   sandboxed iframe that silently blocks native dialogs. All confirmations
   (e.g. deleting an archived plan) use in-page state machines
   (`archiveDeleteStage`) instead, not `confirm()`.
3. **`switchView('plan')` always calls `closePlanDetail()`** — don't
   change this to "remember" the last open plan detail; that's the exact
   regression that made the Plan tab look broken before.
4. Chart.js loads via external `<script src>`; `renderCharts()` guards
   with `typeof Chart === 'undefined'` in case it hasn't loaded yet —
   keep that guard if touching chart code.
5. Pace and duration are **computed, not manually entered** — distance +
   duration always derive pace (`pace = duration/distance`); there's no
   editable pace input anymore, only a live read-only display
   (`updateQlPaceDisplay`/`updateEdPaceDisplay`). Don't reintroduce a
   manual pace override field; it was removed intentionally.
6. **`test/serve-check.sh` waits, then falls back to another port** if its
   default is busy. That looks like over-engineering until you run
   `npm run verify` twice in quick succession: the previous run's server
   can still hold the port for a moment, and the old behaviour — refuse
   and exit 1 — made the suite fail roughly one run in three. Keep the
   retry-then-fallback. It must still refuse to test a port held by
   something else, or it would check a stranger's server and pass.
7. **The day editor's delete confirm re-renders only `.close-row`**, via
   `refreshEditorActions()` — not the whole editor. Rebuilding the editor
   from `editorHtml()` there looks like the obvious simplification and
   silently throws away anything the user has typed but not saved: arming
   the confirm would blank the fields behind it. `dayDeleteStage` is also
   reset whenever an editor opens or closes, so a half-armed confirm can't
   linger and catch a later click on a different day.

## Testing

```bash
npm test            # every suite in test/ (auto-discovered)
npm run verify      # npm test, then the real-HTTP serve check
npm run test:serve  # serve locally and check over HTTP
```

`test/run-all.js` **discovers** every `*.js` in `test/` and runs each in its
own process, so a new suite needs no registration anywhere — drop the file
in and it runs. It exits non-zero if any suite does. This is deliberate:
a test that must be manually registered is one that eventually gets
forgotten, and the point of the suite is that a later feature cannot
silently break an earlier one.

`test/serve-check.sh` covers what jsdom structurally cannot — it boots
`python3 -m http.server` and checks over real HTTP that every asset is
reachable, that scripts are served with a JavaScript content type, and
that `storage-shim.js` is loaded before `app.js`. Missing files, wrong
paths and MIME problems show up here, never in jsdom.

Current suites:

- `test/smoke.js` — drives the real `index.html` end to end in jsdom
  against a mocked `window.storage`: init, quick-log, plan generation,
  ledger editing, tab switching, the two-step archive delete, settings
  flows, and a second page load to confirm data round-trips. It also
  asserts the CSS/JS load and that every class the templates reference
  exists in `styles.css`.
- `test/storage-shim.js` — drives the real `storage-shim.js` against a
  real `localStorage`: the `get -> {value}|null` / `set -> truthy`
  contract, key namespacing, a reload round-trip, and that an existing
  `window.storage` is left untouched.

Use `/develop` to add a feature: it builds in a git worktree and requires
a test that fails before the feature exists.

Two things the harness has to work around, both jsdom limitations rather
than app issues:

- `window.storage` is injected via the `beforeParse` hook, *before* any
  page script runs — the real host provides it synchronously.
- jsdom has no canvas, so real Chart.js throws. The harness installs a
  non-writable `window.Chart` stub that the CDN script can't overwrite,
  which lets `renderCharts()` run its real code path and lets the test
  assert on the chart configs it builds.

## Conventions to follow when extending this

- Keep the three-file split: markup in `index.html`, styling in
  `styles.css`, behaviour in `app.js`. No inline `style=""` attributes
  and no inline `<script>`/`<style>` blocks — add a class instead.
- All persistence goes through `savePlans()` / `saveSettings()` (or the
  more granular `window.storage.set('plans', ...)` calls used in the
  hardened save handlers) — never introduce a second source of truth.
- Every destructive action needs an in-page confirm flow, not `confirm()`.
- New day/session fields go on the day object inside a plan's `days{}`,
  not as a separate parallel structure — `findDayEntry()` is the one
  lookup path the rest of the app relies on.

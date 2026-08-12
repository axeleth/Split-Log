# Split Log — Running Training Tracker

A static HTML/JS/CSS training dashboard for planning and logging runs
(5K/10K training blocks, zone-based heart rate targets, pace tracking,
VO2max trends). Originally built as a Claude.ai artifact using the
`window.storage` persistence API.

## Files

```
index.html    markup only — no inline <style> or <script>
styles.css    all styling, incl. the design tokens in :root
app.js        all behaviour, wrapped in an IIFE, loaded with `defer`
test/smoke.js jsdom smoke test — `npm test`
tracker.html.bak   the original single-file version, kept for reference
```

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
  key-value async API injected by the Claude.ai artifact host. This is
  **not** localStorage — do not use localStorage/sessionStorage, they don't
  work in this environment.

If you move this off the Claude.ai artifact host (e.g. into a normal web
app), the `window.storage` calls in `loadAll()`, `savePlans()`, and
`saveSettings()` are the only integration points that need replacing —
everything else is independent of the host.

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

## Testing

`npm test` runs `test/smoke.js` — a jsdom harness (no test framework)
that drives the real `index.html` end to end: init, quick-log, plan
generation, ledger editing, tab switching, the two-step archive delete,
settings flows, and a second page load to confirm data round-trips
through storage. It also asserts the CSS/JS actually load and that every
class the templates reference exists in `styles.css`.

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

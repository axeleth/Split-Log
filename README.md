# Split Log

A running training tracker — generate a 5K or 10K training block, log each
run, and watch pace, VO2max, and weekly volume trend over time.

Vanilla HTML, CSS, and JavaScript. No framework, no build step, no
bundler. Open it in a browser and it runs.

---

## Quick start

```bash
npm run serve      # static server on http://localhost:8080
```

Then open <http://localhost:8080>.

Serve it over HTTP rather than double-clicking `index.html` — the page
loads `styles.css` and `app.js` as separate files, and browsers block
some relative requests from `file://` URLs. Any static server works;
`npm run serve` just wraps Python's built-in one.

### Persistence — read this before first run

The app saves through `window.storage`, an async key-value API that the
**host page is expected to provide**. It is deliberately *not*
localStorage. If you open the page without a host that injects
`window.storage`, the app renders but nothing persists across reloads.

To run it standalone, provide the shim yourself. Add this to `<head>` in
`index.html`, **above the Chart.js `<script>` tag** — that tag is
render-blocking, so a shim placed below it won't run if the CDN is slow
or unreachable:

```html
<script>
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      return v === null ? null : { value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return true;
    },
  };
</script>
```

That is the whole integration surface. Swapping those two methods for a
backend API is all it takes to move storage server-side; nothing else in
the app touches persistence directly. A shared or multi-device setup
would need a real backend rather than this shim.

The same gap applies to the deployed site — see
[DEPLOY.md](DEPLOY.md#known-gap-persistence-does-not-work-on-this-host-yet).

---

## The four tabs

**Today** — a race-bib hero card showing the day's session, a countdown
to the next race across all plans, and a quick-log form. Logging a run on
a day with no planned session files it under a catch-all "Logged runs"
plan, so nothing is ever lost.

**Plan** — generate a block, then browse plans as cards. Opening a card
shows a day-by-day ledger grouped by week; clicking any day expands an
inline editor for that session. Plans can be archived, and archived plans
can be restored or deleted.

**Trends** — three Chart.js charts: zone 2 pace (should trend *down*),
VO2max, and weekly volume.

**Settings** — zone calculation, pace targets, and the VO2max log.

### Plan generators

**5K** takes a start date and a race date, then resamples an 18-step prep
pattern proportionally across however many days sit between them — a
10-day gap and a 40-day gap both produce a sensibly-paced block rather
than a truncated or padded one.

**10K** takes a start date and builds a fixed 8-week arc: a recovery
week, five base weeks with the long run growing 10% each week, two
sharpening weeks, then a taper into race day.

Both are pure functions. Generating a plan never modifies existing ones.

### Heart rate zones

Three methods, switchable in Settings:

| Method | Basis |
|---|---|
| `manual` | Type the five zone boundaries yourself |
| `5k` | % of average HR from an all-out 5K — Z1 ≤85%, Z2 85–89%, Z3 90–94%, Z4 95–99%, Z5 ≥100% |
| `maxhr` | Classic 50/60/70/80/90% of max HR |

First run seeds the `5k` method with placeholder numbers so the UI has
something to display. **They are illustrative, not a recommendation** —
replace them in Settings with your own figures.

### Pace and duration

Both are stored as decimal minutes (`6.5` = 6:30) and displayed as
`M:SS`. Durations over an hour also accept `H:MM:SS` on input.

Pace is always **derived**, never typed: enter distance and duration and
the pace readout updates live. There is no manual pace override — it was
removed on purpose, so pace can never disagree with the numbers it comes
from.

---

## Project layout

```
index.html      markup only — no inline <style> or <script>
styles.css      all styling; design tokens live in :root
app.js          all behaviour, in an IIFE, loaded with defer
test/smoke.js   jsdom smoke test
public/         what gets deployed — login gate + symlinks to the three files
deploy.sh       check / deploy / status / provision / rollback
CLAUDE.md       architecture notes and gotchas for contributors
DEPLOY.md       hosting, the Caddy cookie gate, and deploy commands
```

`app.js` is organised into eleven numbered sections — state, date
helpers, formatters, persistence, plan generators, zone maths, the five
renderers, and event wiring — with a map of them in the file header.

Rendering is deliberately simple: each renderer rewrites its subtree via
`innerHTML` rather than patching the DOM incrementally. The tradeoff is
that **event listeners must be re-attached after every render**, which is
what the `attach*` functions are for.

---

## Data model

Two `window.storage` keys, both JSON strings.

`plans` is an array of plan objects:

```js
{
  id: 'p_abc123_xy',
  name: '5K — 29 Aug',
  type: '5k' | '10k' | 'legacy' | 'adhoc',
  startDate: 'YYYY-MM-DD' | null,
  raceDate:  'YYYY-MM-DD' | null,
  archived: false,
  days: {
    'YYYY-MM-DD': {
      type: 'zone2' | 'hard' | 'rest' | 'race',
      title: string,
      detail: string,
      targetPace: number | null,     // decimal min/km
      status: 'planned' | 'done' | 'skipped',
      actual: {
        distance: number,            // km
        duration: number,            // decimal minutes
        avgHr: number | null,
        notes: string,
        pace: number | null          // always duration / distance
      } | null
    }
  }
}
```

`settings` is a single object holding zone configuration, pace targets,
and the VO2max log.

A reserved plan with `id: '__adhoc__'` collects logged runs that don't
belong to a generated plan. It's hidden from the Plan tab's card list but
counted in every chart.

`findDayEntry(date)` is the single lookup path for "what's on this date",
searching all plans including archived ones. New per-session fields
belong on the day object inside `days{}` — not in a parallel structure
beside it.

---

## Testing

```bash
npm install
npm test
```

`test/smoke.js` drives the real `index.html` in jsdom end to end: first
load, quick-logging a run, generating a plan, editing a ledger day, tab
switching, the two-step archive delete, settings round-trips, and a
second page load to confirm data survives. It also asserts that the CSS
and JS actually load and that every class the templates reference exists
in `styles.css`.

No test framework — it's a plain Node script with a `check()` helper,
and it exits non-zero on failure.

Two jsdom workarounds live in the harness, both environment limitations
rather than app behaviour:

- `window.storage` is injected via `beforeParse`, before any page script
  runs, mirroring how a real host provides it synchronously.
- jsdom has no canvas, so real Chart.js throws. The harness defines a
  non-writable `window.Chart` stub the CDN script can't overwrite, so
  `renderCharts()` still runs its real code path and the test can assert
  on the chart configs it produces.

---

## Notes for contributors

Full architecture notes are in [CLAUDE.md](CLAUDE.md). The short version:

- **Never build date strings with `toISOString()`.** It converts to UTC
  and silently shifts the date back a day in any timezone ahead of UTC.
  Use the local-component `toLocalISODate()` helper. This was a real bug.
- **`confirm()` and `alert()` may be silently blocked** depending on the
  host. Destructive actions use in-page confirmation flows instead — see
  the two-step archive delete.
- **Keep the three-file split.** No inline `style=""`, no inline
  `<script>`/`<style>`. Add a class.
- **All persistence goes through `savePlans()` / `saveSettings()`.**
  Never introduce a second source of truth.

### Known rough edge

`restHr` is stored and editable but unused — the max-HR zone method
ignores it, so it isn't a true Karvonen (heart-rate-reserve) calculation.
Either wire it up or drop the field; it's left alone for now because
changing it would shift existing zone numbers.

---

## Deployment

`./deploy.sh` ships the contents of `public/` to a static host behind a
Caddy password gate, with `X-Robots-Tag: noindex` — it holds personal
training data and isn't meant to be public or indexed. `public/` contains
symlinks to `index.html`, `styles.css`, and `app.js`, so there's one
source of truth: edit those files in place and deploy.

See [DEPLOY.md](DEPLOY.md) for configuration and the full command set.

## Dependencies

Chart.js and Google Fonts load from CDNs at runtime. jsdom is the only
npm dependency, and only for tests. The app itself ships nothing.

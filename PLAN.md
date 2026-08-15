# Split Log — Change Plan

Running list of planned changes to the dashboard. Each item has a scope,
an approach, the files it touches, and its open questions. This is the spec,
not a changelog — items carry a status note once something ships, but the
detail below describes the intent rather than what the code currently does.

**Read `CLAUDE.md` first.** The gotchas listed there (timezone dates, no
`confirm()`, no `localStorage`, derived pace) constrain everything below.

## Current state of the repo

Worth recording, because `CLAUDE.md` still describes the single-file layout:

- The app has already been **split into three files** — `index.html`
  (markup + CDN links), `styles.css` (theme + layout), `app.js` (all logic,
  wrapped in an IIFE, organised into 11 numbered sections).
- `tracker.html` and `tracker.html.bak` were the pre-split single-file
  original. **Both have now been deleted** — superseded by the split files, and
  the `.bak` was the last file carrying real heart-rate defaults, which had to
  go before the repo could be published.
- `CLAUDE.md`'s "Single file. Keep it that way" convention is therefore
  already superseded and should be updated as part of the first change that
  lands.

---

# 1. Automated calendar syncing

> **Status: Tier A1 built.** A plan's detail header has an "Export to
> calendar" button that downloads an `.ics` of that plan — all-day events,
> rest days excluded, stable UIDs. Covered by `test/calendar-export.js`.
>
> **A2 (subscribable feed) was deliberately not built**, which closes open
> questions 2 and 3: the deployed site sits behind a Caddy cookie gate that
> 401s anything without the login cookie, and a calendar client polling a
> feed sends no cookies — so a feed would mean publishing training data at an
> unauthenticated public URL. Q4 answered: rest days excluded. Q5: no `rev`
> field was added; `SEQUENCE:0` is emitted and stable UIDs carry re-imports.
> Q6: downloads work when self-hosted, and a copy-to-clipboard fallback
> covers hosts that block them. A3 was narrowed to a per-plan button rather
> than a Settings card.

## Goal

Planned sessions show up in the user's real calendar (Google Calendar /
Apple Calendar) automatically, so training is visible alongside everything
else in the day, without manual re-entry.

## The architectural constraint (read before designing this)

This app is a **static client-side page with no server and no build step**.
Its only persistence is `window.storage`, a host-injected key-value API.

That rules out real Google Calendar API sync in the current architecture:

- Google's Calendar API needs OAuth 2.0. The authorization-code flow needs a
  **client secret held server-side**; the browser-only PKCE flow avoids the
  secret but still yields a token that expires in ~1 hour, with refresh
  tokens that a static page cannot store safely or renew unattended.
- "Automated" (i.e. sync happens without the app being open) fundamentally
  requires something running when the app is closed. A static page cannot do
  that.
- CORS and the artifact-host sandbox may block direct calls to Google's
  endpoints regardless.

So this feature splits into two tiers. **Tier A is the recommended first
build** — it delivers the actual user-facing outcome (sessions appear in the
calendar, and update when the plan changes) with zero infrastructure.

## Tier A — `.ics` export + subscribable feed (no backend)

### A1. One-off `.ics` download

Generate an iCalendar file client-side and trigger a download. Any calendar
app can import it.

- New section in `app.js` (say, section 12 — "Calendar export"), keeping the
  existing numbered-section convention.
- `buildICS(plans, opts)` — pure function, no state mutation, mirroring the
  style of `generate5kPlan` / `generate10kPlan`.
- One `VEVENT` per day entry across the selected plans.
- **All-day events** (`DTSTART;VALUE=DATE`) are the right default — the app
  stores dates only, never times. Note that in iCalendar an all-day `DTEND`
  is **exclusive**, so a single-day event needs `DTEND` = date + 1. Getting
  this wrong is the classic off-by-one, and it must use the existing
  `addDays()` helper, never `toISOString()` (gotcha #1).
- Optional "preferred session time" setting to emit timed events instead;
  that needs a real IANA timezone (`Europe/London`) and a `VTIMEZONE` block,
  so treat it as a follow-up, not v1.
- `UID` must be **stable and deterministic** — e.g. `${plan.id}-${date}@splitlog`.
  Re-importing must update the existing event, not duplicate it. Do not use
  `genId()` here; it is random and would break that.
- `SUMMARY` from `day.title`; `DESCRIPTION` from `day.detail`, plus target
  pace and target HR zone when available.
- `SEQUENCE` increments when a day is edited, so importers accept the update.
  This means storing a per-day revision counter — see Open questions.
- Escaping: commas, semicolons, backslashes and newlines all need escaping
  per RFC 5545, and lines fold at 75 octets. This is the fiddly part; write
  it once, carefully, and unit-test it.
- Download without a server: `Blob` + `URL.createObjectURL` + a synthetic
  `<a download>` click. **Verify this is not blocked by the artifact host's
  sandboxed iframe** — same class of restriction that kills `confirm()`
  (gotcha #2). If downloads are blocked, fall back to rendering the `.ics`
  text in a copyable `<textarea>` with a "Copy" button.

### A2. Subscribable feed (the part that makes it "automated")

A one-off import goes stale the moment a plan is regenerated. A subscription
URL, which the calendar re-polls on its own, is what makes this automatic.

- Requires the `.ics` to be reachable at a **stable public URL** — the one
  piece of hosting this tier needs (a static file host, a gist, an object
  store; no application server, no secrets).
- Calendar clients poll subscribed feeds on **their own schedule** — Google
  can take up to ~24h. Set expectations in the UI copy; do not promise
  instant propagation.
- Needs a decision on how the file gets published on change. Open question.

### A3. UI surface

- New **Calendar** card in the Settings tab, matching existing card markup.
- Controls: which plans to include (active only / include archived /
  specific plan), whether to include rest days, whether to include completed
  sessions, and an export button.
- Show the subscription URL with a copy button once A2 exists.

## Tier B — true Google Calendar two-way sync (needs infrastructure)

Only worth doing if you want events **written into** Google Calendar and
edits flowing back. Requires accepting a backend.

- A small OAuth broker service holding the client secret, doing the token
  exchange and refresh, and storing refresh tokens per user.
- Google Cloud project, Calendar API enabled, consent screen configured. An
  app requesting `calendar.events` that is used beyond your own account
  needs Google verification.
- Scope: request `calendar.events` (per-event access), not full `calendar` —
  least privilege.
- Sync engine decisions: a dedicated "Split Log" calendar rather than
  polluting the primary; map `plan.id + date` → Google `eventId` in a
  persisted table; use `syncToken` for incremental pulls; define conflict
  resolution when both sides changed a session.
- Genuine background sync (fires while the app is closed) means a scheduled
  job in that same backend.

**Recommendation:** build Tier A fully, live with it, and only take on
Tier B if the pull-based feed proves insufficient in practice. Tier B is
substantially more work and adds an operational surface — a service, secrets,
and a Google verification review — to what is currently a static page.

## Files touched

| File | Change |
| --- | --- |
| `app.js` | New section 12: `buildICS()`, escaping/folding helpers, export handler |
| `index.html` | Calendar card markup in the Settings view |
| `styles.css` | Styling for the calendar card (reuse existing card/field classes) |
| `CLAUDE.md` | Document the export path and the stable-UID rule |

## Open questions

1. **Which tier?** Confirm Tier A is enough before any Tier B work starts.
2. **Where would a feed be hosted?** A2 is blocked without an answer.
3. **How does the hosted file get refreshed** when a plan changes — manual
   re-upload, or something automated?
4. **Do rest days belong in the calendar?** They are arguably noise. Default
   proposal: off, with a toggle.
5. **`SEQUENCE` tracking** needs a new per-day field (e.g. `rev`). Per
   `CLAUDE.md`, it goes **on the day object** inside `days{}`, never in a
   parallel structure. Confirm before adding.
6. **Are Blob downloads allowed** in the artifact sandbox? Determines whether
   A1 ships as a download or a copy-to-clipboard fallback.

---

# 2. Plan generation does not scale — and does not know the runner

## Goal

Two problems, one root cause. The generator emits a **fixed session pattern**
that neither stretches sensibly to longer blocks nor reflects anything about
the runner it is planning for. It should produce a structurally sound plan for
any distance and any timeframe, and it should get better at that the more the
runner logs.

Nothing here is built. This is the spec.

## 2.1 The immediate bug: resampling duplicates sessions

`generate5kPlan()` holds an 18-step `prep` array and resamples it across
however many days lie between start and race (`app.js` §5):

```js
const srcIdx = Math.min(prep.length-1, Math.floor(i*prep.length/totalPrepDays));
```

That is **nearest-neighbour resampling**. It works when the block is about 18
days. Longer than that and every step repeats, because each source entry gets
stretched over `totalPrepDays / 18` consecutive days.

Simulating the current code, counting the longest unbroken run of each type:

| Block length | Longest hard streak | Longest zone 2 streak | Rest days |
| --- | --- | --- | --- |
| 18 days (designed for) | 1 | 2 | 5 (28%) |
| 20 days | 1 | 3 | 5 (25%) |
| **45 days** (e.g. 15 Aug → 29 Sept) | **3** | **5** | 14 (31%) |

The 45-day block expands to:

```
z2 z2 z2 z2 z2 rest rest rest HARD HARD z2 z2 z2 z2 z2 rest rest rest z2 z2
HARD HARD HARD z2 z2 rest rest rest HARD HARD z2 z2 z2 rest rest z2 z2 z2
HARD HARD rest rest rest z2 z2
```

Three interval days back to back, five consecutive zone 2 runs, and three-day
rest blocks. Physiologically wrong: consecutive hard days give no recovery
window, and long unbroken easy stretches waste training weeks.

The subtle part, and the reason this was not obvious: the **proportions stay
correct** (~31% rest either way). Only the *sequencing* degrades. Any fix has
to be judged on ordering and spacing, not on session-type ratios — a test
asserting "25-30% rest days" would pass on the broken output above.

`generate10kPlan()` has the opposite failure: it is hardcoded to
7 + 5×7 + 2×7 + 7 = **63 days**, ignoring `startDate`'s relationship to any
race date entirely. It cannot be asked for a 10K in 4 months, or in 3 weeks.

### Direction (not yet decided)

Stop resampling a fixed list. Build the plan from **rules** instead:

- Lay down a weekly microcycle (one quality session, one long run, easy days,
  rest) and repeat it, rather than stretching a day-by-day array.
- Enforce **invariants**: never two hard days consecutively; at least one rest
  or easy day after every quality session; a long run once per week.
- Scale by adjusting *what fills* the weeks — mesocycle progression, volume
  ramp, intensity mix — not by duplicating days.
- Add a **taper** proportional to block length, and a base/build phase before
  it when there is room.
- Cap weekly volume growth (the ~10%/week rule the 10K generator already uses
  via `longRun*1.10`).

Whatever replaces it, the invariants above are the testable contract, and they
are what the current implementation violates.

## 2.2 Goal ambition should scale with available time

A race four months out and a race in three weeks are different problems, and
the app currently treats them the same — the target pace comes from a single
`SETTINGS.racePace` regardless of when the race is.

The relationship the app should encode: **a more ambitious goal requires more
weeks**. Concretely:

- Ask for the goal at plan creation (goal time / goal pace) rather than reading
  one global setting, so different plans can have different ambitions.
- Sanity-check goal against timeframe using current fitness, and say so plainly
  when the ask is unrealistic — "that is a 45s/km improvement in 3 weeks;
  typical is 10-15s/km" — rather than silently generating a plan that cannot
  work.
- Let the runner choose: keep the goal and extend the block, or keep the date
  and moderate the goal.
- Derive session paces from the goal (interval pace, tempo pace, easy pace are
  all functions of current and target fitness), not from a single stored number.

## 2.3 Know the runner

The data to personalise plans is largely **already being collected** — it is
just not being read back. Every logged day stores `distance`, `duration`,
derived `pace`, `avgHr` and `notes`; `SETTINGS` holds zone ranges and a
`vo2Log`. Nothing in `generate5kPlan()` / `generate10kPlan()` consults any of it
beyond three static pace targets.

What a plan should be able to use:

- **Current fitness** from recent logged runs — actual easy pace, actual
  threshold pace, not the aspirational numbers typed into Settings once.
- **Aerobic drift / pace at HR** — the app already charts zone 2 pace at a
  given HR over time. Improvement there is the clearest signal that training is
  working, and it should feed the next block's targets.
- **Adherence** — how many planned sessions were actually completed. A plan
  finished 60% of the time is too aggressive and the next one should be easier,
  not identical.
- **Volume history** — do not jump someone from 20km/week to 45km/week because
  the template says so.

The intent: after a handful of logged runs the app understands this runner well
enough to plan for *them*, and a plan generated in month three should look
materially different from one generated on day one.

## 2.4 Perceived effort — the missing input

Pace and heart rate do not capture how hard a session actually felt. The same
6:30/km at 150bpm is an easy day when fresh and a grind at the end of a heavy
week, and only the runner knows which.

- Add a **manual effort rating** on each logged run — RPE 1-10 is the standard,
  or a coarser 3-5 point scale if that is less friction.
- Per `CLAUDE.md`, this goes **on the day object** inside `days{}` alongside the
  rest of `actual`, never in a parallel structure — `findDayEntry()` stays the
  single lookup path.
- Optional, and absent on every existing logged run, so everything reading it
  must tolerate `null`. Do not backfill a guessed value.
- What it unlocks: effort trending up while pace stays flat is the classic
  overreaching signal, and it is the input that lets the app tell "this plan is
  too hard" from "this plan is working".

## Files touched

| File | Change |
| --- | --- |
| `app.js` | §5 rewritten: rule-based generation, fitness inputs, invariants |
| `app.js` | Day editor + quick-log gain an effort field; `actual` gains `rpe` |
| `index.html` | Goal/ambition inputs at plan creation; effort input |
| `CLAUDE.md` | Document the new day field and the generation invariants |
| `test/` | New suite asserting the invariants (see below) |

## Open questions

1. **Rewrite or evolve?** A rule-based generator is a rewrite of §5, not a
   patch. Worth confirming before starting, since the current generators are
   pure functions with no callers to migrate — the blast radius is small.
2. **How much personalisation before it is creepy or wrong?** A plan that
   silently changes because of one bad run would be worse than a static one.
   Where is the line between adaptive and unpredictable?
3. **Effort scale**: RPE 1-10, or something coarser? More granularity is only
   useful if it is used consistently.
4. **Does an existing plan adapt mid-block**, or is adaptation only applied when
   the next plan is generated? Rewriting days underneath someone is a different
   product than planning well up front.
5. **Minimum data before personalising.** With two logged runs the app knows
   almost nothing; asserting otherwise would produce worse plans than the
   template. What is the threshold, and what does it do below it?

## Testing note

The bug in 2.1 is a **sequencing** bug that proportion-based assertions miss
entirely (see the table above — rest-day share barely moves). Any test has to
assert on ordering:

- no two `hard` days adjacent, at any block length
- no more than N consecutive days of the same type
- a rest or easy day follows every quality session
- generate across a **range** of block lengths (14, 21, 45, 90 days) rather
  than one — the current bug only appears past ~18 days, which is exactly why
  it shipped.

---

# 3. UI overhaul

## Goal

Modernise the interface while keeping the "race bib / split-timer" identity.
This is a **refinement of the existing dark theme, not a re-theme** — the
chartreuse/coral/gold semantics and the Bebas/IBM Plex Mono/Inter type stack
stay.

## Scoping note

"UI overhaul" is the vaguest item here and the easiest to let sprawl. The
sub-items below are ordered so each is independently shippable; agree which
are in scope before starting rather than treating the list as one unit.

### 3.1 Design-token pass (foundation — do this first)

`styles.css` already has a good token block, but values are hardcoded
throughout the rest of the file (spacing, radii, font sizes).

- Add tokens for **spacing** (`--sp-1`…`--sp-6`), **radii**, **shadows** and
  a **type scale**; replace hardcoded values with them.
- Purely mechanical, no visual change if done right — which makes it a safe
  first step and makes every later step cheaper.
- **Keep `CHART_COLORS` in `app.js` in sync.** Chart.js cannot read CSS
  custom properties, so the duplication is deliberate; if the palette moves,
  both places change. Alternatively read the computed values via
  `getComputedStyle(document.documentElement).getPropertyValue('--z2')` at
  chart-render time and delete the duplication — worth considering.

### 3.2 Today / bib hero

The strongest piece of the design. Sharpen rather than rebuild.

- Give the countdown more presence — it is currently a small muted line, but
  it is the most emotionally important number on the screen.
- Better empty state: today's "No session planned" is a dead end. Offer the
  next upcoming session and a one-tap "log a run anyway".
- Show the target HR zone next to target pace — `computeZones()` already
  provides it and the bib doesn't surface it.
- Logged-state treatment: a completed session should read as visually
  "stamped", reinforcing the race-bib metaphor.

### 3.3 Plan ledger density and rhythm

- Week grouping is currently a flat run of rows; `isoWeekLabel()` already
  exists, so sticky week headers are cheap.
- Clearer status affordance per row (planned / done / skipped) without
  adding new colours outside the token set.
- Make the today row unmistakable in the ledger.

### 3.4 Charts

- Consult the `dataviz` skill before touching chart code — it covers palette,
  axis and tooltip conventions.
- Empty states: an axis with no data currently renders as a blank box.
- Consistent tooltip formatting — pace should read `5:42/km` everywhere,
  which the pace chart does but the others don't follow as a pattern.
- Keep the `typeof Chart === 'undefined'` guard (gotcha #4).

### 3.5 Motion and feedback

- Transitions on tab switches and panel toggles. Note the Plan tab's panels
  are `display:none/block` toggles, which **cannot be CSS-transitioned** —
  needs a visibility/opacity approach or a small JS class dance.
- Toast is functional but plain; align it with the theme.
- Respect `prefers-reduced-motion` on everything added here.

### 3.6 Responsive and accessibility

- Verify the layout below 400px — the `.row3` grids are the likely breakage.
- Focus-visible styles on all interactive elements; the current dark theme
  gives keyboard users little to work with.
- Check contrast ratios for `--text-muted` on `--surface`. Muted grey-green
  on dark green is the most likely WCAG AA failure in the palette.
- Inputs need programmatic labels throughout; several rely on visual
  proximity only.

## Constraint that shapes all of the above

Every renderer (`renderToday`, `renderPlanList`, `renderPlanLedger`,
`renderSettings`) is a **full `innerHTML` re-render**, and listeners are
re-attached after each one. Consequences:

- Any animation on re-rendered content restarts from scratch on every render.
- Focus is lost on re-render — relevant to 2.6.
- Adding richer interactivity increases the re-attachment burden.

If the UI work starts fighting this, the honest fix is incremental DOM
updates for the hot paths — a **structural change**, and one to decide on
deliberately rather than drift into.

## Files touched

| File | Change |
| --- | --- |
| `styles.css` | Bulk of the work — tokens, components, responsive, motion |
| `index.html` | Markup changes where new structure is needed |
| `app.js` | Renderer template strings; `CHART_COLORS` sync; chart options |

## Open questions

1. **Which sub-items are in scope?** 2.1 is the prerequisite; the rest are
   independent.
2. **Is the current colour palette settled**, or is a palette change on the
   table? Changes the size of 2.1 considerably.
3. **Light mode — wanted?** Not currently supported. The token pass in 2.1 is
   the moment to make it cheap later, if so.
4. **Any reference screenshots** or apps whose feel you're aiming at?

---

# Cross-cutting work

Neither feature strictly requires these, but both are made harder by their
absence.

### Test harness

There is no test framework. Prior verification was throwaway `jsdom` scripts
using a `beforeParse` hook to inject a mock `window.storage` before the
inline script runs.

The `.ics` builder is **pure, string-in/string-out, and full of fiddly
escaping and date-arithmetic rules** — exactly the kind of code that should
be tested rather than eyeballed. If any test suite gets written, this is the
strongest candidate to start with.

### Repo housekeeping

- ~~Decide the fate of `tracker.html` / `tracker.html.bak`~~ — done, both
  deleted.
- Update `CLAUDE.md`: the single-file convention is stale, and the file list
  and integration points should reflect the split.
- The repo is **not currently a git repository**. Worth `git init`-ing before
  a change of this size — an overhaul without version control means no way
  back from a bad direction.

---

## Suggested order

1. Repo housekeeping + `git init` — cheap, and makes everything after it
   reversible.
2. UI 2.1 (token pass) — no visual change, unblocks the rest.
3. Calendar Tier A1 (`.ics` export) — self-contained, delivers real value,
   answers the sandbox-download question early.
4. Remaining UI sub-items, in agreed scope order.
5. Calendar A2 (feed) — once hosting is decided.
6. Calendar Tier B — only if A proves insufficient.

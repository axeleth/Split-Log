---
name: develop
description: Plan, build and test a Split Log feature — plan mode first with questions answered and the plan approved, then an isolated git worktree, regression tests that persist after merge, and a locally served site to click through. Use when the user wants to add, build, implement, or change a feature in the Run Planner / Split Log tracker — especially when they say "develop", "add a feature", or want work kept off their current branch until it is tested.
---

# develop

Builds one feature at a time in a throwaway git worktree, with tests that
outlive it. The worktree is scaffolding; **the tests are the deliverable that
persists** — every feature added later must keep them green, so old behaviour
cannot quietly break.

The shape of a run:

```
                            ┌──────────┐
                            ▼          │ still failing
plan -> ask -> approve -> build -> verify -> click around -> hand over
                                       │
                                    all green
```

Nothing is written until the plan is approved. Nothing is demoed until the whole
suite passes. Nothing is merged until the user asks.

Work in the order below, and do not skip the test step because a change looks
trivial: an untested feature is one nobody will notice breaking.

## 1. Plan before touching anything

**Call `EnterPlanMode` first**, before writing any code. This applies to
essentially every feature request — the exceptions are a typo or a one-line
fix the user has specified exactly.

In plan mode, explore rather than assume:

- Read `CLAUDE.md`. It lists gotchas that constrain every change (timezone-safe
  dates, no `confirm()`, no direct `localStorage` in `app.js`, derived pace).
  A plan that violates one of these is wrong before it starts.
- Read the code the feature touches. `renderToday()`, `renderPlanList()` and the
  other renderers do full innerHTML re-renders, so anything interactive needs
  its listeners re-attached — know which renderer owns your surface.
- Check `PLAN.md`. The feature may already be specified there, with decisions
  already made.
- Work out what could break. Which existing behaviour shares state, storage
  keys, or DOM with the new thing?

## 2. Ask about anything genuinely uncertain

While still in plan mode, use `AskUserQuestion` for anything where two readings
would lead to materially different work:

- ambiguity in what was asked ("show my pace" — per run, per week, rolling?)
- a choice the user should own (where it lives in the UI, what the default is)
- a trade-off with real consequences (extra storage key vs. deriving on the fly)
- anything touching their real training data or the storage schema

Ask these **before** presenting the plan, so the plan reflects the answers.
Batch related questions into one call rather than drip-feeding them.

Do **not** ask about things you can settle yourself by reading the code, and do
not ask permission to follow the conventions in `CLAUDE.md` — those are already
decided. Judgement calls with an obvious default: make the call, state it in the
plan, and move on.

## 3. Present the plan and wait

Write the plan, then call `ExitPlanMode` to request approval. `ExitPlanMode`
**is** the approval request — never also ask "is this plan okay?" via
`AskUserQuestion`, which would prompt twice for one decision.

A good plan here says:

- what will change, file by file
- what the new tests will assert, including the one that must fail first
- which existing behaviour is at risk, and how the tests cover it
- anything deliberately out of scope

Do not create the worktree or edit a file until the plan is approved. If the
user changes the plan on approval, follow what they actually said.

## 4. Isolate

Create a worktree so the user's branch is untouched while you work:

```
EnterWorktree with name: feature-<short-slug>
```

Everything below happens inside it. If `EnterWorktree` fails, say so and stop
rather than editing the user's checkout.

A worktree has no `node_modules` of its own. Because worktrees live under
`.claude/worktrees/` inside the repo, Node still resolves `jsdom` by walking up
to the main checkout, so `npm test` works without installing anything. If it
ever reports a missing module, run `npm install` in the worktree rather than
concluding the tests are broken.

## 5. Build the feature

Match the surrounding code — its naming, its comment density, its idiom. The
conventions in `CLAUDE.md` are binding:

- **Single source of truth for persistence.** All reads and writes go through
  `window.storage` (`savePlans()` / `saveSettings()`), never `localStorage`
  directly. `storage-shim.js` is what makes that work when self-hosted; app code
  must not know it exists.
- **Dates** use the `toLocalISODate()` helpers, never `.toISOString()`.
- **Destructive actions** need an in-page confirm flow, never `confirm()`.
- **New day/session fields** go on the day object inside a plan's `days{}`, so
  `findDayEntry()` stays the single lookup path.
- **Pace is derived** from distance and duration — never a manual input.

## 6. Write the tests — the part that persists

Add a test file for the feature at `test/<feature-slug>.js`. `npm test`
auto-discovers everything in `test/`, so there is no list to register it in, and
no way to forget.

Follow the existing harness:

- `test/smoke.js` — drives the app in jsdom with a mocked `window.storage`
- `test/storage-shim.js` — drives the real shim against a real `localStorage`

Copy whichever fits. Both are standalone Node scripts that print `PASS`/`FAIL`
lines and **exit non-zero on failure** — the runner depends on that exit code,
so keep it.

Test the behaviour a user would notice, not the implementation:

- the feature does what was asked, including its edge cases
- data it writes survives a reload
- the adjacent features it could plausibly break still work

Write at least one test that **fails before the feature exists**. A test that
passes against the old code is testing nothing. Verify this by stashing the
change, running the test, and seeing it fail.

## 7. Verify — loop until everything passes

```bash
npm run verify        # jsdom suites, then the real-HTTP serve check
```

`npm test` runs every suite in `test/`. `npm run test:serve` boots
`python3 -m http.server` and checks over real HTTP that each asset is reachable,
scripts are served as JavaScript, and `storage-shim.js` is loaded before
`app.js` — things jsdom cannot catch because it never makes a request.

**Run it, fix what fails, run it again. Repeat until the whole suite is green.**
A single failing check means the feature is not finished — do not move on to the
demo, and do not report the work as done with a caveat attached. `npm run
verify` exiting 0 is the gate.

Each time round the loop:

1. Read the actual failure. The suites print a `FAIL` line naming the assertion;
   `test/run-all.js` lists which suites failed at the end.
2. Work out whether the **code** or the **test** is wrong. Default to the code
   being wrong. A test that fails is doing its job.
3. Fix it, then re-run the **full** `npm run verify`, not just the suite you
   touched — fixing one thing frequently breaks another, and only the full run
   proves otherwise.

Rules that hold however many times round you go:

- A **pre-existing** test failing is a regression from your change. Fix the
  change, not the test.
- Only edit an existing test when the feature deliberately changes the behaviour
  it asserts — and say so explicitly when you report back, since that is a
  change to the contract, not a fix.
- Never weaken an assertion, delete a test, or skip a suite to get to green.
  That is not passing; it is removing the thing that would have told you.
- If a test looks wrong, say why before changing it.

If you get genuinely stuck — the same failure survives a few real attempts, or
the fix would need a decision the user should own — stop and report the failure
with what you tried. A blocked loop is worth surfacing; a silently loosened test
is not.

### When a bug is worth writing down

There is no bug log in this repo, deliberately. A fixed bug leaves three
records already: the test that now guards it, the commit that explains it, and
`git log` if anyone needs the history. A prose log of everything ever fixed goes
stale and stops being read, which is worse than not having one.

The exception is a bug whose **fix does not explain itself**. If the code now
looks odd, redundant, or gratuitously defensive, the next person to read it will
tidy it away and reintroduce the bug — and a test will catch that only after
they have done the work. Those go in the **Known gotchas** list in `CLAUDE.md`,
as a short "don't do this, here's what broke" entry.

Gotcha #3 there is the pattern: `switchView('plan')` calling `closePlanDetail()`
reads like a pointless extra call, so the note exists to stop someone deleting
it.

Rule of thumb: if the test alone would leave the next reader puzzled about *why*
the code is shaped that way, add the gotcha. Otherwise the test and the commit
message are enough — do not narrate routine fixes into a document nobody reads.

## 8. Hand over a site they can click

**Only once `npm run verify` is fully green.** Tests prove the logic; they do
not show whether the thing feels right. Finish by serving the worktree so the
user can actually use it.

Start the server **in the background from inside the worktree**, so the page
they load is the new version and not their working copy:

```bash
npm run serve            # python3 -m http.server 8080, from the worktree root
```

Run it with `run_in_background: true` — a foreground server blocks the session.
If 8080 is taken (their own `npm run serve`, or a previous run), use the next
free port and say which:

```bash
python3 -m http.server 8081
```

Confirm it actually answers before handing over the link — `curl -s -o /dev/null
-w '%{http_code}' http://127.0.0.1:8080/` should be 200. Then tell them:

- **the URL**, e.g. http://127.0.0.1:8080/
- **what to click** to exercise the new feature, in order
- **what they should see** if it works
- that it is served from the worktree, so their own checkout is untouched

Storage is per-origin, so `localhost:8080` has its own `splitlog:` data,
separate from the deployed site. Say so if the feature involves saved data —
their real runs will not be there, and that is expected rather than a bug.

Leave the server running while they look. Stop it when they are done, or when
the work is merged or abandoned.

## 9. Report, then let the user decide

Commit inside the worktree, then report:

- what changed, and which files
- the new tests and what they cover
- confirmation that `npm run verify` is green, with the suite count
- if it took more than one pass, what failed on the way and what fixed it —
  that is the useful part, not noise to tidy away
- the local URL from step 8
- anything deliberately left out

**Do not merge to the user's branch without being asked.** They have merged
their own work throughout this project; offer the branch name and wait. When
they do ask, use a fast-forward merge and never force-push.

## Repo facts (do not re-derive)

- Vanilla HTML/CSS/JS, no framework, no build step. Chart.js and the fonts come
  from CDNs; everything else is local.
- `public/` is what deploys: `login.html` is a real file, the rest are symlinks
  to the repo root, so there is one source of truth.
- **A new asset must be added to the `ASSETS` array in `deploy.sh`** and
  symlinked into `public/`, or it will not ship. This is the easiest thing to
  forget.
- Deploys are `./deploy.sh deploy`. Config lives in `.env` (gitignored) — never
  commit the server address or the site password.
- `.env` holds real secrets. Never print it, commit it, or copy values from it
  into tracked files.

---
name: develop
description: Build a new Split Log feature in an isolated git worktree with regression tests that persist after merge. Use when the user wants to add, build, implement, or change a feature in the Run Planner / Split Log tracker — especially when they say "develop", "add a feature", or want work kept off their current branch until it is tested.
---

# develop

Builds one feature at a time in a throwaway git worktree, with tests that
outlive it. The worktree is scaffolding; **the tests are the deliverable that
persists** — every feature added later must keep them green, so old behaviour
cannot quietly break.

Work in the order below. Do not skip the test step because a change looks
trivial: an untested feature is one nobody will notice breaking.

## 1. Understand before building

Read `CLAUDE.md` first — it lists gotchas that constrain every change
(timezone-safe dates, no `confirm()`, no direct `localStorage` in `app.js`,
derived pace). Then read the code you are about to touch. `PLAN.md` holds the
running spec; check whether the feature is already described there.

If the request is ambiguous in a way that changes what you build, ask before
writing code, not after.

## 2. Isolate

Create a worktree so the user's branch is untouched while you work:

```
EnterWorktree with name: feature-<short-slug>
```

Everything below happens inside it. If `EnterWorktree` fails, say so and stop
rather than editing the user's checkout.

## 3. Build the feature

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

## 4. Write the tests — the part that persists

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

## 5. Verify

```bash
npm run verify        # jsdom suites, then the real-HTTP serve check
```

`npm test` runs every suite in `test/`. `npm run test:serve` boots
`python3 -m http.server` and checks over real HTTP that each asset is reachable,
scripts are served as JavaScript, and `storage-shim.js` is loaded before
`app.js` — things jsdom cannot catch because it never makes a request.

Both must pass. If a **pre-existing** test fails, that is a regression from your
change: fix the change, not the test. Only edit an existing test when the
feature deliberately changes the behaviour it asserts, and say so explicitly
when you report back.

## 6. Report, then let the user decide

Commit inside the worktree, then report:

- what changed, and which files
- the new tests and what they cover
- the full verify output
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

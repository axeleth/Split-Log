# Deploying Split Log

A static site behind a Caddy cookie gate, with `X-Robots-Tag: noindex` — it
holds personal training data, so it is not meant to be public or indexed.

```
Run Planner/
├── index.html        the app
├── styles.css
├── app.js
├── public/           everything uploaded to the server
│   ├── login.html    themed password gate (real file)
│   ├── index.html -> ../index.html   (symlink)
│   ├── styles.css -> ../styles.css   (symlink)
│   └── app.js     -> ../app.js       (symlink)
├── .env.example      template for the deploy config
└── deploy.sh         check / deploy / status / provision / rollback
```

`public/` is symlinks rather than copies, so there is one source of truth: edit
`index.html`/`styles.css`/`app.js` in place and deploy. `scp` reads through the
links, so the server receives real files. Git stores them as symlinks (mode
`120000`), so a fresh clone reproduces the layout.

## Configuration

Server details live in `.env`, which is gitignored, so this repo can be
published without advertising the host:

```bash
cp .env.example .env
```

Then set at least:

```
SPLITLOG_SERVER=root@your.server.ip
SPLITLOG_HOST=splitlog.example.com
```

`deploy.sh` refuses to run if these are unset rather than falling back to a
default. Any variable can also be overridden per-invocation:

```bash
SPLITLOG_HOST=staging.example.com ./deploy.sh status
```

## First-time setup

**1. Point DNS at the box** — an `A` record for your hostname at the server's
IP. If the domain is on Cloudflare, use **DNS-only** (grey cloud): behind the
proxy, Caddy's ACME challenge can fail unless the SSL mode is Full (strict),
and the edge cache interacts badly with `Cache-Control: private, no-store` and
the 401 gate. `deploy.sh` detects a proxied record and says so rather than
reporting a false failure.

**2. Provision the server** (one time):

```bash
./deploy.sh provision
```

Creates the web root, appends a Caddy site block, generates a random password
and **prints it once** — save it immediately. Safe to re-run: if the block
already exists it leaves it alone and does not change the password.

**3. Deploy:**

```bash
./deploy.sh deploy
```

## Everyday use

```bash
./deploy.sh check     # diff local vs live, per file (read-only)
./deploy.sh deploy    # back up, upload, verify checksums + HTTP
./deploy.sh status    # DNS, Caddy, files, HTTP (read-only)
./deploy.sh rollback  # restore the previous upload
```

Requires passwordless SSH to the server.

`deploy` verifies by comparing SHA-256 of every asset against the server, then
checks the URL. The checksum comparison is the authoritative one — an
occasional HTTP `000` with matching checksums means the upload was fine and the
probe flaked on a TLS handshake. `probe()` retries three times before reporting
a failure.

The server keeps the last 10 uploads in `$WEBROOT/.backups/`, each a timestamped
folder holding the whole asset set, so a rollback restores a coherent site
rather than mixing a new `index.html` with an old `app.js`.

## How the password gate works

There is **no backend process** — Caddy serves the folder and does the checking:

1. Any request without a valid `splitlog` cookie gets **HTTP 401** with
   `login.html` as the body.
2. `/login` is always reachable so the page can render.
3. `login.html` sets the cookie from the password field, then fetches `/` to see
   whether Caddy accepts it. A 401 means a wrong password, reported inline.
4. With the right cookie, Caddy serves the app.

The password lives **only** in the server's Caddyfile (in the `@authed`
`header_regexp` matcher) and is never committed here. To rotate it, edit that
matcher and `systemctl reload caddy`.

401 is therefore the **healthy** response for content pages without
credentials — `status` reports it as expected, not as an error.

## Persistence when self-hosted

`app.js` persists through `window.storage.get/set`, a key-value API injected by
the **Claude.ai artifact host**. That object does not exist on a plain web
server, so without help `loadAll()` would find no storage and the page would
render empty, saving nothing between reloads.

`storage-shim.js` fills that gap. It provides the same API backed by
`localStorage`, and `index.html` loads it immediately before `app.js` — both
`defer`, and deferred scripts run in document order, so the shim is guaranteed
to install first. `app.js` is untouched, so it still runs unmodified on the
artifact host: the shim no-ops when a real `window.storage` already exists.

The contract it implements, taken from the mock in `test/smoke.js`:

```
get(key)        -> { value: <string> } when present, null when absent
set(key, value) -> truthy on success
```

Both shapes matter. `loadAll()` reads `.value` off the result and branches on a
null for the migration path, and the hardened save handlers do `if(!ok) throw`.

Keys are namespaced `splitlog:` so they cannot collide with anything else on the
origin. If `localStorage` is unavailable — Safari private browsing, or a page
opened via `file://` — the shim falls back to an in-memory store and warns on
the console: the app still runs, but data is lost on reload.

`npm test` covers both the app (`test/smoke.js`, against a mock) and the shim
itself (`test/storage-shim.js`, against a real `localStorage`, including a
reload round-trip and the no-op-on-a-real-host case).

**This is per-browser storage.** Runs logged on your laptop do not appear on
your phone, and clearing site data erases them. A shared or multi-device setup
would need a real backend, which is a bigger change than this static-file
topology assumes.

#!/usr/bin/env bash
# Serve the site locally and check it over real HTTP.
#
# The jsdom suites boot the app but never make an HTTP request, so they cannot
# catch a missing file, a wrong path, or a MIME type that stops a browser
# executing a script. This does: it starts `npm run serve`, fetches every asset
# the page references, and tears the server down again.
#
# Exits non-zero on any failure, so it composes with `npm test` in a chain.
#
# Usage: ./test/serve-check.sh [port]     (default 8080)

set -uo pipefail

PORT="${1:-8080}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="http://127.0.0.1:$PORT"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_rst=$'\033[0m'
fails=0
ok()   { printf '  %sPASS%s  %s\n' "$c_grn" "$c_rst" "$1"; }
bad()  { printf '  %sFAIL%s  %s\n' "$c_red" "$c_rst" "$1"; fails=$((fails+1)); }

# Refuse to start if something already holds the port: we would otherwise test
# whatever that is and report a false pass.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop it, or pass another port:" >&2
  echo "  ./test/serve-check.sh 8081" >&2
  exit 1
fi

cd "$ROOT"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
# Always take the server down, including on Ctrl-C or an early exit.
cleanup() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

# Wait for it to accept connections rather than sleeping a fixed guess.
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
  sleep 0.25
done

echo "Serving $ROOT on $BASE"
echo
echo "-- assets reachable --"
# Every file the page needs. A 404 here is a broken deploy that jsdom misses.
for f in / /index.html /styles.css /app.js /storage-shim.js; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$f")"
  [[ "$code" == "200" ]] && ok "$f -> 200" || bad "$f -> $code (expected 200)"
done

echo
echo "-- scripts served as JavaScript --"
# A browser refuses to execute a script served as text/plain under nosniff, and
# python's http.server gets this right only if the extension is known.
for f in /app.js /storage-shim.js; do
  ct="$(curl -s -o /dev/null -w '%{content_type}' --max-time 10 "$BASE$f")"
  case "$ct" in
    *javascript*) ok "$f -> $ct" ;;
    *)            bad "$f -> $ct (expected a javascript type)" ;;
  esac
done

echo
echo "-- page wiring --"
html="$(curl -s --max-time 10 "$BASE/")"
grep -q 'src="storage-shim.js"' <<<"$html" \
  && ok "index.html loads storage-shim.js" \
  || bad "index.html does not reference storage-shim.js"
grep -q 'src="app.js"' <<<"$html" \
  && ok "index.html loads app.js" \
  || bad "index.html does not reference app.js"
# Order matters: app.js calls window.storage during load, so the shim must be
# parsed first. Both are defer, and defer preserves document order.
shim_at="$(grep -n 'src="storage-shim.js"' <<<"$html" | head -1 | cut -d: -f1)"
app_at="$(grep -n 'src="app.js"' <<<"$html" | head -1 | cut -d: -f1)"
if [[ -n "$shim_at" && -n "$app_at" && "$shim_at" -lt "$app_at" ]]; then
  ok "shim is loaded before app.js (lines $shim_at < $app_at)"
else
  bad "shim must appear before app.js (shim: ${shim_at:-none}, app: ${app_at:-none})"
fi

echo
echo "════════════════════════════════════════════════"
if (( fails )); then
  printf '%sFAILED: %d check(s)%s\n' "$c_red" "$fails" "$c_rst"
  exit 1
fi
printf '%sALL SERVE CHECKS PASSED%s\n' "$c_grn" "$c_rst"

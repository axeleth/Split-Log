#!/usr/bin/env bash
# deploy.sh -- publish Split Log to a static host behind a Caddy cookie gate
#
# Static site, so there is no backend service and nothing to restart: Caddy
# serves the folder directly and handles TLS. One structural note: this site
# ships CSS and JS as well as HTML, so the upload and the integrity check cover
# every asset rather than just index.html. A stale styles.css next to a fresh
# index.html is the failure mode worth designing against.
#
# CONFIGURATION lives in .env (gitignored), not in this file, so the repo can be
# published without advertising the server. Copy .env.example to .env and fill
# in:
#   SPLITLOG_SERVER   ssh target, e.g. root@203.0.113.10
#   SPLITLOG_HOST     public hostname, e.g. splitlog.example.com
#   SPLITLOG_SERVER_IP  optional; defaults to the host part of SPLITLOG_SERVER
#   SPLITLOG_WEBROOT    optional; defaults to /var/www/splitlog
# The script refuses to run if the required two are unset, rather than falling
# back to a default that would deploy someone else's box.
#
# The site is PASSWORD-PROTECTED (Caddy cookie gate) and sends X-Robots-Tag
# noindex, because it carries personal training data. The password lives ONLY in
# the server's Caddyfile, in the @authed header_regexp matcher -- never in this
# repo. To rotate it, edit that matcher and `systemctl reload caddy`.
#
# public/ holds login.html plus symlinks to the app files in the repo root, so
# there is one source of truth: edit index.html/styles.css/app.js in place and
# deploy. scp reads through the symlinks, so the server receives real files.
#
# Usage:
#   ./deploy.sh check      diff local vs live (read-only)
#   ./deploy.sh deploy     upload, then verify the URL responds
#   ./deploy.sh status     DNS + Caddy + file + HTTP status (read-only)
#   ./deploy.sh provision  one-time: create web root + Caddy block
#   ./deploy.sh rollback   restore the previous uploaded copy

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env if present. Only KEY=value lines are read and the values are never
# eval'd, so a stray shell construct in .env cannot execute. Existing environment
# variables win, which keeps one-off overrides working:
#   SPLITLOG_HOST=staging.example.com ./deploy.sh status
if [[ -f "$HERE/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue   # skip blanks/comments
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"    # strip optional quotes
    [[ -n "${!k:-}" ]] || printf -v "$k" '%s' "$v"
  done < "$HERE/.env"
fi

usage_config() {
  cat >&2 <<'CFG'
Missing configuration. Copy .env.example to .env and set:

  SPLITLOG_SERVER=root@your.server.ip
  SPLITLOG_HOST=splitlog.example.com

.env is gitignored, so these stay out of the published repo.
CFG
  exit 1
}

SERVER="${SPLITLOG_SERVER:-}"
HOST="${SPLITLOG_HOST:-}"
[[ -n "$SERVER" && -n "$HOST" ]] || usage_config

# Default the IP to whatever follows the @ in the ssh target, so the common case
# (an ssh target that is already an IP) needs no second variable.
SERVER_IP="${SPLITLOG_SERVER_IP:-${SERVER##*@}}"
WEBROOT="${SPLITLOG_WEBROOT:-/var/www/splitlog}"
BACKUP_DIR="$WEBROOT/.backups"

PUBLIC_DIR="${SPLITLOG_PUBLIC:-$HERE/public}"

# Everything the site is made of. Kept explicit rather than globbed: a stray
# file in public/ should not silently become part of the deployed site, and the
# integrity check needs a definite list to compare against.
ASSETS=(index.html login.html styles.css app.js)

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_rst=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$c_red" "$*" "$c_rst" >&2; exit 1; }

require_local() {
  [[ -d "$PUBLIC_DIR" ]] || die "Site folder not found: $PUBLIC_DIR"
  local missing=()
  local f
  for f in "${ASSETS[@]}"; do
    # -e follows symlinks, so a dangling link counts as missing, which is what
    # we want: public/ is symlinks to the repo root and a renamed source file
    # should fail loudly here rather than deploy a 404.
    [[ -e "$PUBLIC_DIR/$f" ]] || missing+=("$f")
  done
  if (( ${#missing[@]} )); then
    die "Missing from $PUBLIC_DIR: ${missing[*]}
public/ should contain login.html plus symlinks to the app files:
  ln -s ../index.html  $PUBLIC_DIR/index.html
  ln -s ../styles.css  $PUBLIC_DIR/styles.css
  ln -s ../app.js      $PUBLIC_DIR/app.js"
  fi
}

require_ssh() {
  ssh -o ConnectTimeout=8 -o BatchMode=yes "$SERVER" true 2>/dev/null \
    || die "Cannot SSH to $SERVER.
This needs passwordless (key-based) SSH to the server, and SPLITLOG_SERVER in
.env must name the right host."
}

dns_ok() {
  local got
  got="$(dig +short "$HOST" A | head -1)"
  [[ -n "$got" ]]
}

# curl the live site, retrying on transport-level failures. The Mac<->Hetzner
# link intermittently drops TLS handshakes (curl exit 35), which shows up as
# HTTP 000 and reads as an outage when the site is fine. Three tries with a
# pause tells a real fault from a flaky handshake. --resolve pins the hostname
# to the server so a stale local NXDOMAIN, cached from before the DNS record
# existed, cannot report the site as down.
probe() {
  local path="${1:-/}" code="" i
  # Pin the hostname to the server only when DNS actually points there. That
  # defeats a stale local NXDOMAIN cached from before the record existed. But if
  # the record is proxied (Cloudflare's orange cloud), DNS resolves to the proxy
  # and pinning would bypass it -- testing a different path than real visitors
  # take. In that case follow DNS and test the route users get.
  # Two curl invocations rather than an array of flags: macOS ships bash 3.2,
  # where `${empty[@]}` under `set -u` is an "unbound variable" error rather
  # than an empty expansion.
  local pinned=0
  [[ "$(dig +short "$HOST" A | head -1)" == "$SERVER_IP" ]] && pinned=1
  for i in 1 2 3; do
    # No `|| echo 000` fallback here: on a transport failure curl already prints
    # its own 000 via -w, and a second one concatenates into "000000". Let the
    # non-zero exit fall through to the ${code:-000} default instead.
    if (( pinned )); then
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
              --resolve "$HOST:443:$SERVER_IP" "https://$HOST$path" 2>/dev/null)" || code=""
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
              "https://$HOST$path" 2>/dev/null)" || code=""
    fi
    [[ -n "$code" && "$code" != "000" ]] && break
    code=""
    [[ $i -lt 3 ]] && sleep 2
  done
  printf '%s' "${code:-000}"
}

# 200 = served, 401 = the cookie gate answering without credentials. Both mean
# Caddy is up and serving this site.
code_ok() { [[ "$1" == "200" || "$1" == "301" || "$1" == "302" || "$1" == "401" ]]; }

cmd_provision() {
  require_ssh
  say "Provisioning $HOST on $SERVER..."
  say ""

  # The shared secret is generated here and printed once, then written straight
  # into the Caddyfile. It is never stored in this repo.
  # `tr < /dev/urandom | head -c 20` makes head close the pipe while tr is still
  # writing, so tr dies of SIGPIPE and pipefail turns that into a fatal 141.
  # Read a bounded chunk and trim it instead -- no pipe left open to break.
  local secret
  secret="$(LC_ALL=C dd if=/dev/urandom bs=256 count=1 2>/dev/null \
            | LC_ALL=C tr -dc 'A-Za-z0-9')"
  secret="${secret:0:20}"
  [[ ${#secret} -eq 20 ]] || die "Could not generate a password."

  ssh "$SERVER" bash -s <<REMOTE
set -euo pipefail
mkdir -p "$WEBROOT" "$BACKUP_DIR"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true

if grep -q "^$HOST" /etc/caddy/Caddyfile; then
  echo "  Caddy block for $HOST already present -- leaving it alone."
  echo "  (To rotate the password, edit the @authed matcher by hand.)"
else
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.\$(date +%Y%m%d-%H%M%S)"
  cat >> /etc/caddy/Caddyfile <<BLOCK

# Split Log training tracker (static, cookie-gated, noindex)
$HOST {
    root * $WEBROOT
    encode gzip

    header {
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer-when-downgrade
        X-Robots-Tag "noindex, nofollow"
        Cache-Control "private, no-store"
    }

    # The login page is always reachable, cookie or not.
    @login path /login /login.html
    handle @login {
        rewrite * /login.html
        file_server
    }

    # Everything else needs the shared-secret cookie set by the login page.
    @authed header_regexp Cookie "(^|;[ ]*)splitlog=$secret(;|\$)"
    handle @authed {
        file_server
    }

    # No valid cookie -> 401 with the login page as the body. The login page's
    # fetch() probe reads that status to tell a wrong password from a right one.
    handle {
        rewrite * /login.html
        file_server {
            status 401
        }
    }
}
BLOCK
  echo "  Appended Caddy site block for $HOST."
fi

caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || { echo "Caddyfile failed validation -- NOT reloading"; exit 1; }
systemctl reload caddy
echo "  Caddy reloaded."
REMOTE

  say ""
  say "${c_grn}Provisioned.${c_rst}"
  say ""
  say "  ${c_ylw}Password: $secret${c_rst}"
  say ""
  say "  Save it in your password manager now -- this is the only time it is"
  say "  printed. It lives only in the server's Caddyfile, never in this repo."
  say "  (If the block already existed, the password is unchanged and the value"
  say "  above is not in use -- check the @authed matcher on the server.)"
  say ""
  say "Caddy will obtain a TLS certificate on the first request once DNS for"
  say "$HOST points at $SERVER_IP."
}

cmd_check() {
  require_local; require_ssh
  say "Local : $PUBLIC_DIR"
  say "Remote: $SERVER:$WEBROOT"
  say ""
  if ! ssh "$SERVER" "test -d '$WEBROOT'" 2>/dev/null; then
    say "${c_ylw}Not provisioned yet.${c_rst} Run: ./deploy.sh provision"
    return 0
  fi

  # Compare every asset, not just index.html: the whole point of a multi-file
  # site is that any one of them can be the stale one.
  local remote_sums f lsum rsum drift=0
  remote_sums="$(ssh "$SERVER" "cd '$WEBROOT' 2>/dev/null && sha256sum ${ASSETS[*]} 2>/dev/null" || true)"
  for f in "${ASSETS[@]}"; do
    lsum="$(shasum -a 256 "$PUBLIC_DIR/$f" | awk '{print $1}')"
    rsum="$(printf '%s\n' "$remote_sums" | awk -v n="$f" '$2==n{print $1}')"
    if [[ -z "$rsum" ]]; then
      printf '  %-14s %snot deployed%s\n' "$f" "$c_ylw" "$c_rst"; drift=1
    elif [[ "$lsum" == "$rsum" ]]; then
      printf '  %-14s %sup to date%s\n' "$f" "$c_grn" "$c_rst"
    else
      printf '  %-14s %sdiffers%s  %slocal %s / live %s%s\n' \
        "$f" "$c_ylw" "$c_rst" "$c_dim" "${lsum:0:12}" "${rsum:0:12}" "$c_rst"; drift=1
    fi
  done
  say ""
  (( drift )) && say "Run ./deploy.sh deploy to publish." \
              || say "${c_grn}Live site matches local.${c_rst}"
}

cmd_deploy() {
  require_local; require_ssh

  if ! dns_ok; then
    say "${c_ylw}Warning:${c_rst} $HOST does not resolve yet."
    say "Add an A record  splitlog -> $SERVER_IP  at your DNS provider."
    say "Uploading anyway; the site goes live once DNS propagates."
    say ""
  fi

  if ! ssh "$SERVER" "test -d '$WEBROOT'" 2>/dev/null; then
    die "$WEBROOT does not exist on the server.
Run ./deploy.sh provision first."
  fi

  # Back up the whole asset set as one timestamped generation, so a rollback
  # restores a coherent site rather than mixing a new index.html with an old
  # app.js. Keep the last 10 generations.
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  ssh "$SERVER" "set -e
    mkdir -p '$BACKUP_DIR'
    if [ -f '$WEBROOT/index.html' ]; then
      mkdir -p '$BACKUP_DIR/$stamp'
      for f in ${ASSETS[*]}; do
        [ -f \"$WEBROOT/\$f\" ] && cp \"$WEBROOT/\$f\" '$BACKUP_DIR/$stamp/' || true
      done
      ls -1dt '$BACKUP_DIR'/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf --
    fi"

  say "Uploading ${#ASSETS[@]} files from $PUBLIC_DIR ..."
  # scp reads through the symlinks in public/ and sends file contents, so the
  # server gets real files, not links. (No -L: macOS scp doesn't have that flag,
  # and it isn't needed -- following is the default for a named source file.)
  local f
  for f in "${ASSETS[@]}"; do
    scp -q "$PUBLIC_DIR/$f" "$SERVER:$WEBROOT/$f"
  done
  ssh "$SERVER" "chown -R www-data:www-data '$WEBROOT' 2>/dev/null || true
                 chmod 644 $(printf "'$WEBROOT/%s' " "${ASSETS[@]}")"

  # Prove the bytes landed. This is the check that actually matters -- HTTP
  # codes can flake on this link, but a SHA match is unambiguous.
  say "Verifying upload..."
  local remote_sums lsum rsum bad=0
  remote_sums="$(ssh "$SERVER" "cd '$WEBROOT' && sha256sum ${ASSETS[*]} 2>/dev/null" || true)"
  for f in "${ASSETS[@]}"; do
    lsum="$(shasum -a 256 "$PUBLIC_DIR/$f" | awk '{print $1}')"
    rsum="$(printf '%s\n' "$remote_sums" | awk -v n="$f" '$2==n{print $1}')"
    if [[ "$lsum" == "$rsum" ]]; then
      printf '  %-14s %s✓%s\n' "$f" "$c_grn" "$c_rst"
    else
      printf '  %-14s %s✗ checksum mismatch%s\n' "$f" "$c_red" "$c_rst"; bad=1
    fi
  done
  (( bad )) && die "Upload did not verify. The live site may be inconsistent -- \
re-run, or ./deploy.sh rollback."

  say ""
  say "Checking the live URL..."
  local code
  code="$(probe /)"
  if code_ok "$code"; then
    say "${c_grn}Live: https://$HOST/  (HTTP $code -- 401 = login gate, expected)${c_rst}"
  elif ! dns_ok; then
    say "${c_ylw}Uploaded.${c_rst} Not reachable yet -- DNS for $HOST is not set."
    say "Add the A record, then run: ./deploy.sh status"
  else
    say "${c_ylw}Uploaded and checksum-verified, but the URL returned HTTP $code.${c_rst}"
    say "Files are correct on disk, so this is a serving/TLS issue, not a bad upload."
    say "TLS issuance can take a minute on the first request. Re-check with:"
    say "  ./deploy.sh status"
  fi
}

cmd_status() {
  require_ssh
  local ip
  ip="$(dig +short "$HOST" A | head -1)"
  if [[ "$ip" == "$SERVER_IP" ]]; then
    say "DNS   $HOST -> $ip  (direct)"
  elif [[ -n "$ip" ]]; then
    # Anything that resolves but isn't the box is a proxy in front (Cloudflare's
    # orange cloud). Worth naming: it changes who terminates TLS, so a 5xx here
    # can be the proxy's rather than Caddy's, and Caddy's own certificate cannot
    # be issued unless the proxy is set to Full (strict).
    say "DNS   $HOST -> $ip  ${c_ylw}(proxied, not the server IP)${c_rst}"
    say "      TLS terminates at the proxy. If the site 5xx's, check the proxy's"
    say "      SSL mode is Full (strict), or switch the record to DNS-only."
  else
    say "DNS   $HOST -> ${c_red}not set${c_rst}  (add an A record to $SERVER_IP)"
  fi
  say "Caddy $(ssh "$SERVER" 'systemctl is-active caddy' 2>/dev/null || echo unknown)"

  if ssh "$SERVER" "test -f '$WEBROOT/index.html'" 2>/dev/null; then
    say "Files $(ssh "$SERVER" "cd '$WEBROOT' && ls -1 *.html *.css *.js 2>/dev/null | tr '\n' ' '" 2>/dev/null)"
    say "      $(ssh "$SERVER" "stat -c 'index.html: %s bytes, modified %y' '$WEBROOT/index.html'" 2>/dev/null)"
  else
    say "Files ${c_ylw}not deployed${c_rst}"
  fi

  # Check the gate both ways: content should be 401 without a cookie, and the
  # login page must be reachable or nobody can get in.
  local croot clogin
  croot="$(probe /)"
  clogin="$(probe /login)"
  if code_ok "$croot"; then
    say "HTTP  ${c_grn}/       $croot${c_rst}  (401 = login gate, expected)"
  else
    say "HTTP  ${c_ylw}/       $croot${c_rst}"
  fi
  if [[ "$clogin" == "200" ]]; then
    say "      ${c_grn}/login  200${c_rst}"
  else
    say "      ${c_ylw}/login  $clogin${c_rst}  (should be 200 -- the gate needs this to render)"
  fi
}

cmd_rollback() {
  require_ssh
  local latest
  latest="$(ssh "$SERVER" "ls -1dt '$BACKUP_DIR'/*/ 2>/dev/null | head -1")"
  [[ -n "$latest" ]] || die "No backups found in $BACKUP_DIR."
  say "Restoring $latest ..."
  ssh "$SERVER" "cp '$latest'/* '$WEBROOT/' && chmod 644 '$WEBROOT'/*.html '$WEBROOT'/*.css '$WEBROOT'/*.js 2>/dev/null || true"
  say "${c_grn}Restored.${c_rst} HTTP $(probe /)"
}

case "${1:-}" in
  check)     cmd_check ;;
  deploy)    cmd_deploy ;;
  status)    cmd_status ;;
  provision) cmd_provision ;;
  rollback)  cmd_rollback ;;
  *) cat <<USAGE
deploy.sh -- publish Split Log to https://$HOST/

  check      diff the local build against the live copy (read-only)
  deploy     back up, upload, verify checksums + HTTP
  status     DNS, Caddy, files and HTTP status (read-only)
  provision  one-time: create the web root and Caddy site block
  rollback   restore the most recent backup

Site source: $PUBLIC_DIR
Override with SPLITLOG_PUBLIC=/path/to/public
USAGE
     exit 1 ;;
esac

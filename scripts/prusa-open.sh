#!/usr/bin/env bash
#
# ppp → PrusaSlicer bridge. Handles a `ppp://slice/<id>` link by fetching the
# model from a Pretty Please Print instance and opening it in a local slicer.
#
# Runs ON THE PERSON'S OWN MACHINE — the one with the printer, PrusaSlicer, and
# a browser — not on the server. It is the whole reason "Open in PrusaSlicer"
# can exist at all: PrusaSlicer's own `prusaslicer://open?file=` refuses any
# URL that is not printables.com/thingiverse.com/cults3d.com, and there is no
# setting to add a self-hosted host to that list. So instead of asking the
# slicer to download, this downloads the bytes itself and hands the slicer a
# *local file*, which has no domain to check. See docs/prusaslicer.md.
#
# Installed as the handler for the `ppp://` scheme by install-slicer-handler.sh.
# Invoked by the desktop environment with one argument: the clicked URL.
#
# Config lives at $PPP_SLICER_CONF (default ~/.config/ppp/slicer.conf) and sets:
#   PPP_BASE          the instance, e.g. https://print.example         (required)
#   PPP_TOKEN         a bearer token from a sign-in response            (required)
#   PPP_SLICER        the slicer binary            (default: prusa-slicer)
#   PPP_DOWNLOAD_DIR  where fetched models land    (default: ~/.cache/ppp/models)
#
# The token IS the session token — signing out of the app revokes it. Get one
# with, and keep it out of your shell history:
#   curl -si $PPP_BASE/api/auth/sign-in/username \
#     -H 'content-type: application/json' \
#     -d '{"username":"you","password":"..."}' | grep -i '^set-auth-token:'
#
# Failures are made loud rather than swallowed: a protocol handler has no
# terminal, so every error goes to a log AND a desktop notification (when
# notify-send exists), because a click that silently does nothing is the worst
# possible outcome — indistinguishable from "not installed".

set -euo pipefail

CONF="${PPP_SLICER_CONF:-$HOME/.config/ppp/slicer.conf}"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ppp"
LOG="$LOG_DIR/slicer.log"
mkdir -p "$LOG_DIR"

# --- loud failure -----------------------------------------------------------
# Log with a timestamp, pop a desktop notification if we can, and leave a copy
# on stderr for the case where this was run from a terminal to debug it.
note() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG"
}
fail() {
  note "ERROR: $1"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Open in PrusaSlicer failed" "$1" || true
  fi
  printf 'prusa-open: %s\n' "$1" >&2
  exit 1
}

# --- config -----------------------------------------------------------------
[ -f "$CONF" ] || fail "no config at $CONF — run install-slicer-handler.sh first"

# A token in a world-readable file is a credential anyone on the box can read.
# Warn rather than refuse: on a single-user workstation it is a papercut, not a
# breach, and refusing outright would strand somebody mid-print.
if command -v stat >/dev/null 2>&1; then
  # GNU stat, then BSD/macOS stat. The last two octal digits are the group and
  # other bits; any non-zero there means someone besides the owner can read it.
  perms="$(stat -c '%a' "$CONF" 2>/dev/null || stat -f '%Lp' "$CONF" 2>/dev/null || echo '')"
  case "$perms" in
    *[1-7][0-7] | *[0-7][1-7]) note "WARNING: $CONF is group/world-readable ($perms) — chmod 600 it" ;;
  esac
fi

# shellcheck disable=SC1090
. "$CONF"

: "${PPP_BASE:?PPP_BASE is not set in $CONF}"
: "${PPP_TOKEN:?PPP_TOKEN is not set in $CONF}"
SLICER="${PPP_SLICER:-prusa-slicer}"
DOWNLOAD_DIR="${PPP_DOWNLOAD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ppp/models}"

# --- parse the link ---------------------------------------------------------
# Accept ppp://slice/<id>, with or without a trailing slash. The id is the ONLY
# thing taken from the URL, and it is validated to digits before it is ever put
# in a request path — so a hostile link cannot smuggle anything into the fetch.
url="${1:-}"
[ -n "$url" ] || fail "no URL given — this is invoked by clicking a ppp:// link"

id="${url#ppp://slice/}"
id="${id%/}"
case "$id" in
  "" | *[!0-9]*) fail "not a model link: $url (expected ppp://slice/<number>)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v "$SLICER" >/dev/null 2>&1 ||
  fail "slicer '$SLICER' not found on PATH — set PPP_SLICER in $CONF (AppImage users: give the full path)"

# --- fetch ------------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
hdr="$tmp/headers"
body="$tmp/body"

note "fetching story $id from $PPP_BASE"
# No --fail: let curl succeed on any HTTP status and read the code from -w, so
# the `case` below can answer 401 and 404 in words rather than "curl (22)". A
# non-zero exit here is a real transport failure — DNS, connection refused —
# and that is what the `|| fail` catches.
code="$(
  curl -sS \
    -o "$body" -D "$hdr" -w '%{http_code}' \
    -H "Authorization: Bearer $PPP_TOKEN" \
    "$PPP_BASE/api/models/$id" 2>"$tmp/err"
)" || fail "could not reach $PPP_BASE: $(tr -d '\r' <"$tmp/err" | tail -n1)"

case "$code" in
  200) : ;;
  401) fail "not authorised (HTTP 401) — the token in $CONF is missing, expired, or was revoked by signing out" ;;
  404) fail "story $id is not there, or not one this account may see (HTTP 404)" ;;
  *)   fail "server returned HTTP $code for story $id" ;;
esac

# The download route sets Content-Disposition with the original filename; take
# it from there. `basename` is the traversal guard — even a hostile header can
# only name a file, never a path.
name="$(
  grep -i '^content-disposition:' "$hdr" | tr -d '\r' |
    sed -n 's/.*filename="\([^"]*\)".*/\1/p' | head -n1
)"
name="$(basename "${name:-model-$id.stl}")"
case "$name" in "" | .*) name="model-$id.stl" ;; esac

mkdir -p "$DOWNLOAD_DIR"
# Prune anything older than a day so the cache cannot grow without bound. Done
# before the move so the file we are about to open is never a prune target.
find "$DOWNLOAD_DIR" -maxdepth 1 -type f -mtime +1 -delete 2>/dev/null || true

out="$DOWNLOAD_DIR/PPP-$((100 + id))-$name"
mv "$body" "$out"
note "saved $out"

# --- open -------------------------------------------------------------------
# --single-instance so a second click loads the model into the window already
# open rather than starting a race between two PrusaSlicers over the same file.
note "opening in $SLICER"
setsid "$SLICER" --single-instance "$out" >>"$LOG" 2>&1 &
note "handed off story $id"

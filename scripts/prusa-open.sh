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
#   PPP_SLICER        the slicer binary            (default: prusa-slicer)
#   PPP_DOWNLOAD_DIR  where fetched models land    (default: ~/.cache/ppp/models)
#   PPP_TOKEN         DEPRECATED — see below                          (optional)
#
# THE CONFIG NO LONGER HOLDS A CREDENTIAL. The clicked link carries its own:
# `ppp://slice/<id>?t=<token>`, minted by the app for the person who was looking
# at that ticket, good for half an hour and for that one model. Nothing secret
# is written to disk, so there is nothing here to leak or to rotate.
#
# It used to be PPP_TOKEN, a bearer token pasted in once — which was the session
# token, so when sessions came down from thirty days to twenty idle minutes it
# stopped working and every click answered HTTP 401. PPP_TOKEN is still honoured
# when a link carries no `t` (an old bookmark, say), but it is on the way out:
# delete it from the config and click the button again.
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

# Only worth saying when the file still holds the deprecated credential — with
# `t` in the link there is nothing in here anybody could misuse. Warn rather
# than refuse either way: on a single-user workstation it is a papercut, not a
# breach, and refusing outright would strand somebody mid-print.
if grep -q '^[[:space:]]*PPP_TOKEN=' "$CONF" 2>/dev/null && command -v stat >/dev/null 2>&1; then
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
DOWNLOAD_DIR="${PPP_DOWNLOAD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ppp/models}"

# --- locate the slicer ------------------------------------------------------
# There is no one name for "PrusaSlicer on Linux": a distro package is
# `prusa-slicer`, the official download is an AppImage nobody puts on PATH, and
# Flathub installs it as an app id you reach through `flatpak run`. Defaulting
# to a single binary name meant the common cases all failed with "not found".
#
# PPP_SLICER may therefore be a bare name, a full path to an AppImage, or a
# multi-word command like "flatpak run com.prusa3d.PrusaSlicer" — it is split
# on whitespace into a command + args. Left unset, the cases above are probed
# in turn. (A path containing spaces is the one thing this cannot express; put
# the AppImage somewhere without them.)
if [ -n "${PPP_SLICER:-}" ]; then
  read -r -a SLICER_CMD <<<"$PPP_SLICER"
else
  SLICER_CMD=()
  # 1. a binary on PATH, under the names distros and builds actually use.
  for cand in prusa-slicer prusaslicer PrusaSlicer prusa-slicer-gui; do
    if command -v "$cand" >/dev/null 2>&1; then SLICER_CMD=("$cand"); break; fi
  done
  # 2. a Flatpak install.
  if [ "${#SLICER_CMD[@]}" -eq 0 ] && command -v flatpak >/dev/null 2>&1 &&
    flatpak info com.prusa3d.PrusaSlicer >/dev/null 2>&1; then
    SLICER_CMD=(flatpak run com.prusa3d.PrusaSlicer)
  fi
  # 3. an AppImage in the usual spots. A glob that matches nothing stays a
  #    literal with a `*` in it, which is never -x, so it is simply skipped.
  if [ "${#SLICER_CMD[@]}" -eq 0 ]; then
    for g in \
      "$HOME"/Applications/*[Pp]rusa*[Ss]licer*.AppImage \
      "$HOME"/Downloads/*[Pp]rusa*[Ss]licer*.AppImage \
      "$HOME"/.local/bin/*[Pp]rusa*[Ss]licer*.AppImage \
      /opt/*[Pp]rusa*[Ss]licer*/*.AppImage; do
      [ -x "$g" ] && { SLICER_CMD=("$g"); break; }
    done
  fi
fi

[ "${#SLICER_CMD[@]}" -gt 0 ] || fail \
  "could not find PrusaSlicer. Set PPP_SLICER in $CONF — a binary name, the full path to an AppImage, or 'flatpak run com.prusa3d.PrusaSlicer'."

# --- parse the link ---------------------------------------------------------
# Accept ppp://slice/<id>, with or without a trailing slash. The id is the ONLY
# thing taken from the URL, and it is validated to digits before it is ever put
# in a request path — so a hostile link cannot smuggle anything into the fetch.
url="${1:-}"
[ -n "$url" ] || fail "no URL given — this is invoked by clicking a ppp:// link"

# Split `<id>` from an optional `?t=<token>`. The id is still validated to
# digits before it goes anywhere near a request path, and the token to the
# base64url alphabet plus the dot that separates its two halves — so neither
# can smuggle anything into the fetch below.
rest="${url#ppp://slice/}"
id="${rest%%\?*}"
id="${id%/}"
case "$id" in
  "" | *[!0-9]*) fail "not a model link: $url (expected ppp://slice/<number>)" ;;
esac

link_token=""
if [ "$rest" != "${rest#*\?}" ]; then
  query="${rest#*\?}"
  case "$query" in
    *t=*)
      link_token="${query##*t=}"
      link_token="${link_token%%&*}"
      ;;
  esac
fi
case "$link_token" in
  "") : ;;
  *[!A-Za-z0-9._-]*) fail "the credential in that link is malformed — open the ticket again and re-click" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is not installed"
# The head of the command has to be runnable — a binary on PATH, or a file we
# can execute (an AppImage). Everything after it is arguments to that.
slicer_head="${SLICER_CMD[0]}"
command -v "$slicer_head" >/dev/null 2>&1 || [ -x "$slicer_head" ] ||
  fail "slicer '$slicer_head' is not runnable — fix PPP_SLICER in $CONF (a name on PATH, an AppImage path, or 'flatpak run com.prusa3d.PrusaSlicer')"

# --- fetch ------------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
hdr="$tmp/headers"
body="$tmp/body"

# Prefer the link's own credential; fall back to the deprecated config token so
# an old bookmark still works. One or the other has to be present.
fetch_args=(-sS -o "$body" -D "$hdr" -w '%{http_code}')
if [ -n "$link_token" ]; then
  # --get --data-urlencode rather than pasting into the URL: curl does the
  # escaping, so the shell never has to be trusted with it.
  fetch_args+=(--get --data-urlencode "t=$link_token")
elif [ -n "${PPP_TOKEN:-}" ]; then
  note "no credential in the link — falling back to the deprecated PPP_TOKEN"
  fetch_args+=(-H "Authorization: Bearer $PPP_TOKEN")
else
  fail "that link carries no credential and $CONF sets no PPP_TOKEN — open the ticket in the app and click the button there"
fi

note "fetching story $id from $PPP_BASE"
# No --fail: let curl succeed on any HTTP status and read the code from -w, so
# the `case` below can answer 401 and 404 in words rather than "curl (22)". A
# non-zero exit here is a real transport failure — DNS, connection refused —
# and that is what the `|| fail` catches.
code="$(
  curl "${fetch_args[@]}" "$PPP_BASE/api/models/$id" 2>"$tmp/err"
)" || fail "could not reach $PPP_BASE: $(tr -d '\r' <"$tmp/err" | tail -n1)"

case "$code" in
  200) : ;;
  401)
    if [ -n "$link_token" ]; then
      fail "that link has expired (HTTP 401). They last half an hour — open the ticket again and click the button."
    else
      fail "not authorised (HTTP 401) — the PPP_TOKEN in $CONF is expired or was revoked. Delete it and click the button in the app instead; links now carry their own credential."
    fi
    ;;
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
# Make the on-disk name safe for every launcher. This is only the local temp
# file's name — the app keeps the real display name — so we can be strict:
# spaces to underscores (Flatpak's entrypoint splits its argument on spaces and
# mangles a path that contains one), and nothing outside a conservative set.
name="$(printf '%s' "$name" | tr ' ' '_' | tr -cd 'A-Za-z0-9._-')"
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
note "opening with: ${SLICER_CMD[*]}"
setsid "${SLICER_CMD[@]}" --single-instance "$out" >>"$LOG" 2>&1 &
note "handed off story $id"

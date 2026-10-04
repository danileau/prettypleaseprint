#!/usr/bin/env bash
#
# ppp deploy wizard — the single entry point for deploying Pretty Please Print.
#
# Runs ON THE NAS, in the directory holding docker-compose.prod.yml and
# .env.docker. That placement is the whole design: the NAS has no source tree,
# no git and no toolchain — it consumes images CI built, signed and scanned —
# so the wizard asks the registry what exists rather than asking a checkout.
#
# It answers the questions a bare `sed PPP_TAG && docker compose up -d` does
# not:
#   1. WHICH image?   → lists what is actually published to ghcr.io, newest
#      first, with publish dates and the live one marked, showing a release
#      version where one exists and the commit SHA otherwise. You pick from a
#      menu instead of copying a tag out of a CI log. A version that is a
#      GitHub release carries its title, so "which one was that?" is answered
#      in the menu.
#   2. IS IT PUBLISHED YET? → a version tag exists a few minutes before its
#      images do. A version is refused until every image exists at that tag,
#      instead of failing halfway through the pull.
#   3. WHAT DOES UPGRADING NEED? → shows the "Upgrading" notes of every
#      release between what is running and what was chosen, and asks. They
#      come from the GitHub release bodies because there is no checkout here
#      to read a changelog from. A SHA build is placed among the releases by
#      git ancestry (GitHub's compare API), not by date. When the wizard
#      cannot tell what lies in between it says so and still asks — it never
#      treats "could not find out" as "nothing to read".
#   4. IS IT INTACT?  → cosign-verifies the image against the identity of the
#      release-images workflow on this repo before anything is swapped. If
#      cosign is absent it says so loudly rather than quietly skipping.
#   5. DID IT WORK?   → polls the public health URL after the swap, and rolls
#      back to the previous tag automatically if it does not come good.
#
# 2 and 3 only read: one releases request, a handful of compare requests for a
# SHA, one `docker manifest inspect` per image. Deploying from one SHA build to
# a newer one with no release in between prints and asks exactly what it did
# before they existed.
#
# The images are public, so no registry credential is needed to pull one. A
# token is optional and buys only a longer menu: GitHub gates the package
# *listing* API even for public packages, so without one the wizard lists
# releases instead — which is the right list for most deployments anyway.
#
# When a token IS given (a fork with private packages, or someone following
# main by SHA) it is borrowed and returned: read from a hidden prompt, used for
# the pull, then `docker logout` on exit including on failure. Nothing
# long-lived is left behind.
#
# Usage:
#   ./deploy-wizard.sh              # interactive
#   ./deploy-wizard.sh -n 25        # widen the candidate window
#   ./deploy-wizard.sh --status     # read-only: what is live, and what is new
#
# Nothing is pulled or swapped without an explicit menu choice and a y/N.

set -euo pipefail

# ----- config ---------------------------------------------------------------
# Overridable from the environment or from ./deploy.conf, so a second
# deployment does not need the script edited.
PROJECT_DIR="${PPP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
[ -f "$PROJECT_DIR/deploy.conf" ] && . "$PROJECT_DIR/deploy.conf"

# Derived from APP_URL below, not defaulted to a hostname. It used to default to
# this project's own deployment, which meant a stranger running the wizard saw
# somebody else's host reported as "Live health: healthy", gated their post-swap
# health loop on it, and could have a perfectly good deploy rolled back because
# an unrelated machine blipped. PPP_HEALTH_URL still overrides.
HEALTH_URL="${PPP_HEALTH_URL:-}"
REGISTRY_OWNER="${PPP_REGISTRY_OWNER:-danileau}"
REPO="${PPP_REPO:-danileau/prettypleaseprint}"
IMAGES="${PPP_IMAGES:-ppp-app ppp-migrate}"
WINDOW="${PPP_WINDOW:-15}"
HEALTH_TIMEOUT="${PPP_HEALTH_TIMEOUT:-300}"

# ----- pretty ---------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
  RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; CYN=$'\e[36m'
else
  B=""; DIM=""; R=""; RED=""; GRN=""; YLW=""; CYN=""
fi
die() { echo "${RED}✗ $*${R}" >&2; exit 1; }
hr()  { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────────${R}"; }

compose() { ( cd "$PROJECT_DIR" && docker compose --env-file .env.docker $COMPOSE_FILES "$@" ); }

# ----- prompts --------------------------------------------------------------
# Every y/N goes through here. A bare `read` under `set -e` exits silently when
# stdin ends — a wizard that stops mid-question without a word, with whoever
# piped the answers left guessing how far it got. So the two ways of not saying
# yes are told apart: an answer that is not yes is a decision (exit 0), and no
# answer at all is a failure (exit 1). `|| [ -n "$ans" ]` keeps a last line
# that has no newline after it.
no_input() { echo; echo "${RED}aborted (no input).${R}" >&2; exit 1; }
ask() {
  local ans=""
  printf '%s' "$1"
  read -r ans || [ -n "$ans" ] || no_input
  case "$ans" in y|Y|yes|YES) return 0 ;; esac
  echo "aborted."; exit 0
}

# ----- GitHub's public API ---------------------------------------------------
# api_get <path> fetches https://api.github.com/repos/$REPO/<path>, leaving the
# body in API_BODY and the HTTP status in API_CODE; it returns 1 on anything
# but a 200. Globals rather than stdout, because a caller needs the status as
# well: a 403 is the rate limit, and that deserves a different sentence from
# "not found".
#
# With a token it asks with the token first and, if that fails, once more
# without. The token was given for the registry; one scoped to packages only,
# or expired, is refused by the repository API — and must not hide a public
# repository that would have answered a stranger.
API_BODY=""; API_CODE=""
api_get() {
  local url="https://api.github.com/repos/${REPO}/$1" out
  API_BODY=""; API_CODE="000"
  if [ -n "${TOKEN:-}" ] && out="$(curl -fsSL --max-time 30 -w '\n%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" "$url" 2>/dev/null)"; then
    API_BODY="${out%$'\n'*}"; API_CODE="200"; return 0
  fi
  if out="$(curl -fsSL --max-time 30 -w '\n%{http_code}' \
      -H "Accept: application/vnd.github+json" "$url" 2>/dev/null)"; then
    API_BODY="${out%$'\n'*}"; API_CODE="200"; return 0
  fi
  API_CODE="${out##*$'\n'}"
  return 1
}

# A version, as opposed to a SHA build or a moving tag: v1.2.3 or v1.2.3-rc1.
# Narrower than what the menu lists (which admits `v1.2.3abc`), because the two
# steps that use it — "is it published" and "what lies in between" — reason
# about order, and only this shape has one.
VERSION_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

# Shared by the two python programs below, which is why it is a variable: the
# rules for text that came from GitHub must not exist in two copies.
#
# A release title or body is remote input printed to a terminal. Anyone who can
# edit a release could otherwise send escape sequences — retitle the window,
# hide a line, rewrite what the upgrade notes appear to say — so control
# characters are removed before anything is shown: C0 and C1 controls, DEL, and
# the bidirectional overrides that reorder text on screen. A body keeps its
# newlines and tabs; a title keeps neither, because it is one field on one row.
#
# (Double quotes only in here and in the programs that use it, because they sit
# inside shell single quotes; and ASCII only, with \u escapes for the dash and
# the bar, so the source does not depend on the locale python starts in.)
PY_GITHUB='
import json, re, sys
VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$")
CONTROLS = "\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069"

def clean_body(text):
    return re.sub("[" + CONTROLS + "]", "", text if isinstance(text, str) else "")

def clean_title(text):
    return re.sub("[\t\n" + CONTROLS + "]", "", text if isinstance(text, str) else "")

def title_of(tag, release, limit):
    # A release is titled "v0.2.0", or the tag, a dash and some words. The tag
    # is already in its own column, so only the words are the title; a title
    # that is only the tag is none.
    name = clean_title(release.get("name"))
    if name.startswith(tag):
        name = name[len(tag):]
        for sep in (" \u2014 ", " - ", ": "):
            if name.startswith(sep):
                name = name[len(sep):]
                break
    name = name.strip()
    return name if len(name) <= limit else name[:limit - 1] + "\u2026"

def version_key(tag):
    # Numeric triple first. A suffix sorts BELOW the same triple without one
    # (v1.0.0-rc1 comes before v1.0.0), and suffixes compare naturally, so
    # rc2 < rc10.
    major, minor, patch, suffix = VERSION.match(tag).groups()
    natural = [(0, int(p), "") if p.isdigit() else (1, 0, p)
               for p in re.findall(r"\d+|\D+", suffix or "")]
    return (int(major), int(minor), int(patch), 0 if suffix else 1, natural)

def published(text):
    # Maps tag to release for every release that is not a draft, or None when the
    # list could not be read. An empty string is "could not be read", not "no
    # releases": it must never reach json.loads and it must never look like [].
    if not text.strip():
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    return {r["tag_name"]: r for r in data
            if isinstance(r, dict) and isinstance(r.get("tag_name"), str) and not r.get("draft")}

def read_stdin():
    # Bytes, decoded here: a NAS with LANG=C would otherwise decode a title as
    # ASCII and die on the first dash.
    return sys.stdin.buffer.read().decode("utf-8", "replace")

def emit(lines):
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
'

# ----- args -----------------------------------------------------------------
STATUS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) WINDOW="${2:?-n needs a number}"; shift 2 ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,54p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

# ----- preflight ------------------------------------------------------------
command -v docker  >/dev/null || die "docker required"
command -v curl    >/dev/null || die "curl required"
command -v python3 >/dev/null || die "python3 required (for reading the registry's JSON)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
# The usual way to get here is running the wizard from a source checkout, where
# it lives in scripts/ and the deployment's files do not. The old message asked
# "is PPP_DIR right?" of someone who had never set it, so say what the wizard
# expects and the two ways to give it that.
if [ ! -f "$PROJECT_DIR/.env.docker" ]; then
  echo "${RED}✗ no .env.docker in $PROJECT_DIR${R}" >&2
  echo "  The wizard deploys the stack in the directory that holds" >&2
  echo "  docker-compose.prod.yml and .env.docker — on the host that runs it," >&2
  echo "  not in a source checkout. Either copy this script next to those two" >&2
  echo "  files and run it there, or point it at them:" >&2
  echo "      PPP_DIR=/path/to/deployment $0" >&2
  exit 1
fi

CURRENT="$(sed -n 's/^PPP_TAG="\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$PROJECT_DIR/.env.docker" | head -1)"
[ -n "$CURRENT" ] || die "PPP_TAG not found in .env.docker (see .env.docker.example)"

# The health check follows this deployment, read from the same file as the tag.
if [ -z "$HEALTH_URL" ]; then
  APP_URL_CFG="$(sed -n 's/^APP_URL="\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$PROJECT_DIR/.env.docker" | head -1)"
  [ -n "$APP_URL_CFG" ] || die "APP_URL not found in .env.docker, and PPP_HEALTH_URL is unset — refusing to guess which host to health-check"
  HEALTH_URL="${APP_URL_CFG%/}/api/health"
fi

# ----- which compose files? -------------------------------------------------
# Asked of the running stack, not assumed. Guessing here is not a cosmetic
# error: bringing the project up with a different overlay set silently changes
# its topology — drop the overlay that publishes a host port and a proxy
# forwarding to that port gets a connection refused, which surfaces as a 502
# with nothing wrong in the app's own logs. `docker compose ls` reports the
# exact files a project was raised with, so use those.
discover_compose_files() {
  docker compose ls --all --format json 2>/dev/null | python3 -c '
import json, os, sys
target = os.path.realpath(sys.argv[1])
try:
    projects = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in projects if isinstance(projects, list) else []:
    files = [f for f in (p.get("ConfigFiles") or "").split(",") if f]
    # Absolute only. dirname("docker-compose.yml") is "", and realpath("") is
    # the CURRENT directory — so a stale project entry holding a relative path
    # would match whatever directory you happen to be standing in, and hand
    # back an unrelated overlay set.
    if not files or not os.path.isabs(files[0]):
        continue
    if os.path.realpath(os.path.dirname(files[0])) == target:
        print(" ".join("-f " + os.path.basename(f) for f in files))
        break
' "$PROJECT_DIR" 2>/dev/null || true
}

if [ -n "${PPP_COMPOSE_FILES:-}" ]; then
  COMPOSE_FILES="$PPP_COMPOSE_FILES"
  COMPOSE_SOURCE="PPP_COMPOSE_FILES"
else
  COMPOSE_FILES="$(discover_compose_files)"
  COMPOSE_SOURCE="the running stack"
fi

if [ -z "$COMPOSE_FILES" ]; then
  # Nothing running and nothing configured. Refuse rather than pick: deploying
  # with the wrong overlay set is exactly the failure this block exists to
  # prevent, and it fails silently as a 502 rather than as an error.
  echo "${RED}✗ cannot tell which compose files this deployment uses.${R}" >&2
  echo "  Nothing is running here, so there is nothing to read it from." >&2
  echo >&2
  echo "  Overlays present in ${PROJECT_DIR}:" >&2
  ls -1 "$PROJECT_DIR"/docker-compose*.yml 2>/dev/null | sed 's|.*/|      |' >&2 \
    || echo "      (none)" >&2
  echo >&2
  echo "  Bring the stack up once by hand, or write deploy.conf:" >&2
  echo "      PPP_COMPOSE_FILES=\"-f docker-compose.prod.yml -f docker-compose.proxy.yml\"" >&2
  echo >&2
  echo "  A running stack reports its own file list, if one is up elsewhere:" >&2
  echo "      docker inspect ppp-app --format '{{index .Config.Labels \"com.docker.compose.project.config_files\"}}'" >&2
  exit 1
fi

echo "${B}ppp deploy wizard${R}  ${DIM}· ${PROJECT_DIR}${R}"
hr

# ----- live state -----------------------------------------------------------
HEALTH="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null || echo '000')"
if [ "$HEALTH" = "200" ]; then HSTR="${GRN}healthy (200)${R}"; else HSTR="${RED}not 200 (${HEALTH})${R}"; fi

echo "${B}Currently deployed:${R} ${CYN}${CURRENT}${R}"
echo "${B}Compose files:${R}      ${COMPOSE_FILES}  ${DIM}(from ${COMPOSE_SOURCE})${R}"
echo "${B}Live health:${R}        ${HSTR}  ${DIM}${HEALTH_URL}${R}"
printf "${B}Containers:${R}         "
docker ps --filter 'name=ppp-' --format '{{.Names}} ({{.Status}})' \
  | sed 's/ (Up[^)]*(healthy))/ ok/' | paste -sd, - | sed 's/,/, /g' || true
hr

# ----- candidates -----------------------------------------------------------
# Asked of the registry, not of a checkout: the NAS has no git, and "what is
# published" is the honest definition of what is deployable anyway.
# A token is OPTIONAL, and what it buys is a longer list rather than access.
#
# The images are public, so pulling one needs no credential at all. What is
# still gated is GitHub's package *listing* API, which returns 401 even for a
# public package — so without a token the wizard lists releases instead, from
# the public Releases API. That is the better list for most deployments
# anyway: named versions with dates, rather than every commit.
#
# With a token it lists every published image, SHA builds included, which is
# what you want when following main closely.
read_token() {
  if [ -n "${PPP_TOKEN:-}" ]; then TOKEN="$PPP_TOKEN"; return; fi
  printf 'ghcr.io token for the full image list, or press enter for releases only: '
  stty -echo 2>/dev/null || true
  # No input here means "no token", not "abort": `--status </dev/null` should
  # still print the table.
  read -r TOKEN || true
  stty echo 2>/dev/null || true
  printf '\n'
}
read_token

if [ -n "$TOKEN" ]; then
  echo "${DIM}→ asking ghcr.io what is published…${R}"
  SOURCE_LABEL="every published image"
  # -L because a renamed repository answers 301 here, and an unfollowed
  # redirect returns an empty body that looks exactly like "nothing published".
  VERSIONS="$(curl -sSL --max-time 20 \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/user/packages/container/ppp-app/versions?per_page=100" 2>/dev/null || true)"
  # The release list is wanted here too, for the titles in the menu and the
  # upgrade notes later. Losing it costs those, not the menu.
  if api_get "releases?per_page=100"; then
    RELEASES="$API_BODY"
  else
    RELEASES=""
    echo "${DIM}release titles unavailable (could not read the releases list)${R}"
  fi
else
  echo "${DIM}→ asking GitHub what has been released…${R}"
  SOURCE_LABEL="releases only (no token given)"
  # One request serves as both the menu and the release list.
  api_get "releases?per_page=100" || true
  RELEASES="$API_BODY"
  VERSIONS="$RELEASES"
fi
# The newest hundred releases, one page: the list is not paginated. Past a
# hundred, older ones lose their title and a deploy that reaches back that far
# is told the wizard could not place it, rather than shown a partial answer.

# Two things this filtering has to get right, both learned the hard way:
#   - release-images publishes cosign signatures and SBOM attestations to the
#     same package, tagged `sha256-<digest>.sig` / `.att`. Those are not
#     runnable images; only a 7-hex-char tag is one.
#   - sort by created_at, NOT updated_at. Re-pointing `latest` on a new
#     release touches the OLD version's updated_at too, so ordering by it
#     reshuffles history and shows a build's date as the day it was
#     superseded.
#
# Two JSON documents go in on stdin, the image list and the release list,
# separated by \x1e — a byte JSON cannot contain unescaped. Not an argument or
# an environment variable: a release list with its bodies passes the kernel's
# 128 KB limit on a single string, and the wizard would die with "Argument
# list too long" on the day the project had written enough release notes.
#
# Rows come back with \x1f between fields, not a tab. A tab is whitespace to
# `read`, which collapses an empty field — and `moving` is empty on most rows,
# so everything after it would shift one column left.
CANDIDATES="$(printf '%s\n\x1e\n%s' "$VERSIONS" "$RELEASES" | python3 -c "$PY_GITHUB"'
# A 7-char commit SHA, or a release like v0.1.0 / v1.2.3-rc1. Everything else
# in this package is machinery: cosign publishes `sha256-<digest>.sig` and the
# SBOM publishes `.att`, and neither is a runnable image.
DEPLOYABLE = re.compile(r"^([0-9a-f]{7}|v\d+\.\d+\.\d+[0-9A-Za-z.\-]*)$")
versions, _, release_list = read_stdin().partition("\x1e")
try:
    data = json.loads(versions)
except Exception:
    sys.exit(1)
if not isinstance(data, list):
    sys.exit(1)
releases = published(release_list)
rows = []
for v in data:
    # Two shapes: a package version carries its tags under metadata.container,
    # a release is simply its tag_name. Both give a date.
    if "tag_name" in v:
        if v.get("draft"):
            continue
        tag = v["tag_name"]
        if DEPLOYABLE.match(tag):
            rows.append((v.get("published_at") or v.get("created_at") or "", tag, False))
        continue
    tags = (v.get("metadata") or {}).get("container", {}).get("tags", []) or []
    # Prefer a version tag when the same image carries both, because that is
    # the name a person will recognise in the menu.
    sha = next((t for t in tags if t.startswith("v") and DEPLOYABLE.match(t)), None) \
          or next((t for t in tags if DEPLOYABLE.match(t)), None)
    if not sha:
        continue
    rows.append((v.get("created_at") or "", sha, "latest" in tags))
rows.sort(reverse=True)
out = []
for when, sha, is_latest in rows:
    # What GitHub says about this tag as a release. Empty for a SHA build, and
    # empty for everything when the release list could not be read: "tagged,
    # not released" is a claim, and without the list it would be a guess.
    kind = title = ""
    if releases is not None and sha.startswith("v"):
        release = releases.get(sha)
        if release is None:
            kind = "tag"
        else:
            kind = "pre-release" if release.get("prerelease") else "release"
            title = title_of(sha, release, 44)
    out.append("\x1f".join([sha, when[:16].replace("T", " "), "latest" if is_latest else "", kind, title]))
emit(out)
' 2>/dev/null || true)"

if [ -z "$CANDIDATES" ]; then
  echo "${YLW}⚠ could not read the list.${R}"
  echo "  ${DIM}With a token, the most likely cause is that it lacks read:packages or expired."
  echo "  Verify with:  curl -sSI -H \"Authorization: Bearer \$TOKEN\" https://api.github.com/user | grep -i x-oauth-scopes${R}"
  exit 1
fi

echo
echo "${B}Deployable${R} ${DIM}— ${SOURCE_LABEL}, newest first:${R}"
echo
printf "  ${DIM} %-3s %-10s %-18s %-8s %s${R}\n" "#" "tag" "published" "moving" "state release"

declare -a IDX_SHA
i=0; DEFAULT=""
while IFS=$'\x1f' read -r sha when islatest kind title; do
  [ -n "$sha" ] || continue
  i=$((i+1)); [ "$i" -gt "$WINDOW" ] && break
  IDX_SHA[$i]="$sha"
  # `pad` brings the state to four visible columns. printf cannot do it: the
  # state carries colour codes, which it would count as width.
  if [ "$sha" = "$CURRENT" ]; then
    state="${CYN}LIVE${R}"; pad=""
  else
    state="${DIM}-${R}"; pad="   "
  fi
  case "$kind" in
    release|pre-release) release="${kind}${title:+  $title}" ;;
    tag) release="${DIM}tagged, not released${R}" ;;
    *) release="" ;;
  esac
  # Recommend the newest published image that is not already live, and only
  # when it is NEWER than what is live — never point the default backwards at
  # something old that simply never shipped; that would read as a regression.
  if [ -z "$DEFAULT" ] && [ "$sha" != "$CURRENT" ] && [ "$i" -eq 1 ]; then
    DEFAULT="$i"; mark="${B}${GRN}»${R}"
  else
    mark=" "
  fi
  # A row with nothing to say about a release prints exactly as it always has,
  # with no trailing padding. The title is %s, never %b: it is GitHub's text.
  if [ -n "$release" ]; then
    printf " %b %-3s ${CYN}%-10s${R} %-18s %-8s %b%s  %s\n" "$mark" "$i" "$sha" "$when" "${islatest:-}" "$state" "$pad" "$release"
  else
    printf " %b %-3s ${CYN}%-10s${R} %-18s %-8s %b\n" "$mark" "$i" "$sha" "$when" "${islatest:-}" "$state"
  fi
done <<< "$CANDIDATES"
echo

if [ -n "$DEFAULT" ]; then
  echo "${DIM}» = recommended (newest published image, not yet live)${R}"
else
  echo "${GRN}✓ up to date — the newest published image is already live.${R}"
  echo "${DIM}  (You can still redeploy or roll back by number.)${R}"
fi
hr

[ "$STATUS_ONLY" -eq 1 ] && exit 0

# ----- selection ------------------------------------------------------------
echo "${B}Choose an action:${R}"
echo "   ${B}<number>${R}  deploy that image"
[ -n "$DEFAULT" ] && echo "   ${B}<enter>${R}   deploy the recommended image (${CYN}${IDX_SHA[$DEFAULT]}${R})"
echo "   ${B}q${R}         quit"
printf "> "
# An empty line is an answer here (the recommended image), so only stdin
# ending without one is "no input".
read -r choice || [ -n "$choice" ] || no_input

if [ -z "$choice" ]; then
  [ -n "$DEFAULT" ] || { echo "aborted."; exit 0; }
  choice="$DEFAULT"
fi
case "$choice" in q|Q) echo "aborted."; exit 0 ;; esac
[[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$i" ] \
  || die "invalid selection: $choice"

TARGET="${IDX_SHA[$choice]}"
[ "$TARGET" = "$CURRENT" ] && echo "${YLW}note: ${TARGET} is already live — this is a redeploy.${R}"

# ----- is it published yet? -------------------------------------------------
# Pushing a version tag is what STARTS the image build, so for a few minutes
# the release list offers a version the registry does not have. Chosen then,
# the pull fails partway — one image there, the next not — and the message is
# docker's, about a manifest. Ask the registry first and say it plainly.
#
# Only for a version: a SHA build is listed BY the registry, so it exists.
#
# Three answers, not two. "Missing" is only what the registry says is missing.
# `denied`, a network error, or a docker too old to have `manifest` mean the
# wizard could not find out — what a private fork sees here, before the login
# further down — and refusing on those would lock out a deployment that works.
# The pull is the safety net for them, as it always was.
if [[ "$TARGET" =~ $VERSION_RE ]]; then
  missing=""; unknown=""
  for img in $IMAGES; do
    if out="$(docker manifest inspect "ghcr.io/${REGISTRY_OWNER}/${img}:${TARGET}" 2>&1)"; then
      continue
    fi
    case "$(printf '%s' "$out" | tr 'A-Z' 'a-z')" in
      *"manifest unknown"*|*"not found"*|*"no such manifest"*)
        missing="${missing}${missing:+, }${img}:${TARGET}" ;;
      *)
        # The first line only, and without control characters: it is the
        # registry's text.
        why="$(printf '%s' "${out%%$'\n'*}" | tr -d '\000-\037\177')"
        unknown="${unknown}${DIM}could not check whether ${img}:${TARGET} is published (${why:0:160}) — the pull will tell.${R}"$'\n' ;;
    esac
  done
  if [ -n "$missing" ]; then
    echo "${RED}✗ ${TARGET} is not fully published yet — missing: ${missing}${R}" >&2
    echo "  A version tag exists a few minutes before its images do. Wait for the build:" >&2
    echo "      https://github.com/${REPO}/actions/workflows/release-images.yml" >&2
    echo "  then run the wizard again. Nothing was changed." >&2
    exit 1
  fi
  printf '%s' "$unknown"
fi

# ----- what does upgrading need? --------------------------------------------
# A release can need something done BEFORE its image starts: a snapshot, a
# one-shot migration container, a variable that changed meaning. That is
# written in the release notes under an "Upgrading" heading, and nobody reads
# release notes on a NAS. So show the Upgrading section of every release
# between what is running and what was chosen — every one, because going from
# v0.1.0 to v0.4.0 crosses the steps of v0.2.0 and v0.3.0 too — and ask.
#
# "Between" is decided by git ancestry, not by dates. Each end is given a base,
# the newest release it contains: a version is its own base; a SHA build is
# placed by asking GitHub's compare API whether it contains a release. The
# releases strictly after the lower base, up to and including the higher one,
# are the ones crossed. Going back crosses the same ones, and shows them too:
# they say what each release changed and whether there is a way back.
#
# The rule that matters most: "could not find out" is never "nothing to
# read". Every way of not knowing — no release list, a tag that is neither a
# version nor a SHA, a version GitHub has no release for, a compare call that
# fails — says so, says the notes were NOT shown, and asks.
PY_NOTES='
releases = published(read_stdin())
if releases is None:
    sys.exit(3)
ordered = sorted((t for t in releases if VERSION.match(t)), key=version_key)
if sys.argv[1] == "list":
    emit(ordered)
    sys.exit(0)

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
UPGRADING = re.compile(r"^upgrading\b", re.I)

def upgrading(body):
    # Every section whose heading starts with "Upgrading", at any level (the
    # changelog writes it as ###, the hand-written v0.2.0 notes as ##), up to
    # the next heading of the same or a higher level. Fenced blocks are
    # tracked so that a `# comment` in a shell example is not taken for a
    # heading, which would end the section early or start one in the middle
    # of a code block.
    out, level, fenced = [], 0, False
    for line in clean_body(body).split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced:
            m = HEADING.match(line)
            if m and level and len(m.group(1)) <= level:
                level = 0
            if m and not level and UPGRADING.match(m.group(2)):
                level = len(m.group(1))
                while out and not out[-1]:
                    out.pop()
                if out:
                    out.append("")
                out.append(m.group(2).rstrip("# ").strip())
                continue
        if level:
            out.append(line.rstrip())
    while out and not out[-1]:
        out.pop()
    return out

# argv: "notes", then the first and last index into `ordered` of the releases
# crossed. The first line out is how many of them have notes; the rest is what
# to show.
lines, with_notes = [], 0
for tag in ordered[int(sys.argv[2]):int(sys.argv[3]) + 1]:
    release = releases[tag]
    title = title_of(tag, release, 72)
    date = clean_title(release.get("published_at") or release.get("created_at"))[:10]
    lines.append("  " + tag + (" \u2014 " + title if title else "") + ("  (" + date + ")" if date else ""))
    notes = upgrading(release.get("body"))
    with_notes += 1 if notes else 0
    for note in notes or ["(no upgrade notes)"]:
        lines.append(("    \u2502 " + note).rstrip())
    lines.append("")
emit([str(with_notes)] + lines)
'

# base_of <tag> sets BASE to the index in RLIST of the newest release the tag
# contains (-1: older than every release), or returns 1 with WHY_NOT set.
RLIST=(); BASE=0; WHY_NOT=""
base_of() {
  local x="$1" n="${#RLIST[@]}" i lo hi mid status
  if [[ "$x" =~ $VERSION_RE ]]; then
    for (( i = 0; i < n; i++ )); do
      if [ "${RLIST[$i]}" = "$x" ]; then BASE="$i"; return 0; fi
    done
    # A version tag with no release (or only a draft) cannot be ordered among
    # the releases by anything the wizard has, and guessing "nothing in
    # between" is the dangerous guess.
    WHY_NOT="$x has no published GitHub release"; return 1
  fi
  BASE=-1
  # No releases at all: nothing can lie in between, whatever the tag is.
  [ "$n" -gt 0 ] || return 0
  if ! [[ "$x" =~ ^[0-9a-f]{7,40}$ ]]; then
    WHY_NOT="$x is neither a version nor a commit SHA"; return 1
  fi
  # Binary search. main is linear and every release is a commit on it, so "this
  # commit contains release r" is true up to some release and false after it —
  # two or three questions for a dozen releases instead of a dozen, which
  # matters at 60 unauthenticated requests an hour. `?per_page=1&page=2` asks
  # for the verdict without the megabyte of commits and diffs that comes with
  # it by default; `status` is the same either way.
  lo=0; hi=$((n - 1))
  while [ "$lo" -le "$hi" ]; do
    mid=$(( (lo + hi) / 2 ))
    if ! api_get "compare/${RLIST[$mid]}...${x}?per_page=1&page=2"; then
      case "$API_CODE" in
        403|429) WHY_NOT="GitHub rate limit reached (60 requests an hour without a token)" ;;
        *) WHY_NOT="GitHub could not place $x relative to ${RLIST[$mid]}" ;;
      esac
      return 1
    fi
    status="$(printf '%s' "$API_BODY" | python3 -c '
import json, sys
try:
    print(json.loads(sys.stdin.buffer.read().decode("utf-8", "replace")).get("status") or "")
except Exception:
    pass
' 2>/dev/null || true)"
    case "$status" in
      # The commit is the release, or has it in its history.
      ahead|identical) BASE="$mid"; lo=$((mid + 1)) ;;
      # The release is newer than the commit, or on a line it never joined.
      behind|diverged) hi=$((mid - 1)) ;;
      *) WHY_NOT="GitHub could not place $x relative to ${RLIST[$mid]}"; return 1 ;;
    esac
  done
  return 0
}

# A redeploy crosses nothing by definition, so it asks GitHub nothing.
if [ "$TARGET" != "$CURRENT" ]; then
  NOTES=""; crossed=0
  if ! rlist="$(printf '%s' "$RELEASES" | python3 -c "$PY_GITHUB$PY_NOTES" list 2>/dev/null)"; then
    WHY_NOT="could not read the release list from GitHub"
  else
    while IFS= read -r r; do
      if [ -n "$r" ]; then RLIST+=("$r"); fi
    done <<< "$rlist"
    if base_of "$CURRENT"; then
      base_current="$BASE"
      if base_of "$TARGET"; then
        base_target="$BASE"
        if [ "$base_target" -gt "$base_current" ]; then
          first=$((base_current + 1)); last="$base_target"
        else
          first=$((base_target + 1)); last="$base_current"
        fi
        crossed=$((last - first + 1))
        if [ "$crossed" -gt 0 ]; then
          NOTES="$(printf '%s' "$RELEASES" | python3 -c "$PY_GITHUB$PY_NOTES" notes "$first" "$last" 2>/dev/null)" \
            || WHY_NOT="could not read the release notes GitHub returned"
        fi
      fi
    fi
  fi

  if [ -n "$WHY_NOT" ]; then
    echo
    echo "${YLW}⚠ could not work out which releases lie between ${CURRENT} and ${TARGET}: ${WHY_NOT}.${R}"
    echo "  Upgrade notes were NOT shown. Read them before continuing:"
    echo "      https://github.com/${REPO}/releases"
    ask "Continue without having seen them? [y/N] "
  elif [ "$crossed" -gt 0 ] && [ "${NOTES%%$'\n'*}" = "0" ]; then
    echo
    echo "${DIM}No upgrade notes in the ${crossed} release(s) between ${CURRENT} and ${TARGET}.${R}"
  elif [ "$crossed" -gt 0 ]; then
    echo
    if [ "$base_target" -gt "$base_current" ]; then
      echo "${B}Upgrade notes — ${CURRENT} → ${TARGET} crosses ${crossed} release(s):${R}"
    else
      echo "${B}${YLW}Going BACK from ${CURRENT} to ${TARGET} undoes ${crossed} release(s). Their upgrade notes say what they changed and whether there is a way back:${R}"
    fi
    echo
    printf '%s\n' "${NOTES#*$'\n'}"
    echo
    echo "All release notes: https://github.com/${REPO}/releases"
    ask "I have read the upgrade notes above. Continue? [y/N] "
  fi
  # Nothing crossed — one SHA build to the next, with no release in between —
  # prints nothing and asks nothing: that deploy is as it always was.
fi

echo
if [ "$HEALTH" != "200" ]; then
  echo "${YLW}⚠ ${HEALTH_URL} is already answering ${HEALTH}, before any change.${R}"
  echo "  ${DIM}Whatever is wrong is not this image, and the automatic rollback"
  echo "  cannot help — it rolls back to the version that is failing now."
  echo "  Worth fixing the current breakage first.${R}"
  ask "Deploy anyway? [y/N] "
  echo
fi

if [ "$TARGET" = "$CURRENT" ]; then
  ask "Redeploy ${TARGET}? [y/N] "
else
  ask "Deploy ${CYN}${TARGET}${R} (replacing ${CURRENT})? [y/N] "
fi

# ----- signature ------------------------------------------------------------
# CI signs both images with cosign keyless, pinning the identity of the
# release-images workflow on this repo. That signature is what protects the
# registry-to-NAS link against a substituted or tampered image, so it is
# checked BEFORE anything is swapped — and its absence is reported, never
# silently skipped.
# TrueNAS and friends replace the OS filesystem on update, taking anything
# installed into it. So look beside the project as well as on PATH: a binary on
# the data dataset survives, and one in /usr/local/bin does not.
COSIGN="$(command -v cosign 2>/dev/null || true)"
[ -z "$COSIGN" ] && [ -x "$PROJECT_DIR/bin/cosign" ] && COSIGN="$PROJECT_DIR/bin/cosign"

if [ -n "$COSIGN" ]; then
  echo "${DIM}→ verifying signatures with ${COSIGN}…${R}"
  # Keyless signing embeds the workflow's identity, and that identity contains
  # the repository PATH — so renaming the repository splits the published
  # images in two: everything built before it carries the old path, everything
  # after carries the new one. Verifying against only one of them means either
  # today's image or every rollback target fails, and the wizard refuses to
  # deploy a perfectly good image.
  #
  # The signature itself is unaffected: it is over the digest, and the old ones
  # remain valid. Only the pattern has to admit both names. Drop the old
  # alternative once nothing you would roll back to predates the rename.
  # Two alternations, both learned by verifying a real signature rather than
  # by reading the workflow.
  #
  # The REF: a tag build signs with refs/tags/<tag>, not refs/heads/main. So
  # every release image — the thing a deployment is meant to pin — failed
  # verification, while branch builds passed. The bug was invisible until
  # cosign was actually installed somewhere, because without it the wizard
  # skips the check and says so.
  #
  # The REPO NAME: keyless signing embeds the repository path, so images built
  # before the rename carry the old one. Both are admitted; a fork, another
  # workflow, another branch and a non-version tag are not.
  IDENTITY="^https://github\.com/danileau/(prettypleaseprint|ppp)/\.github/workflows/release-images\.yml@refs/(heads/main|tags/v[0-9][0-9A-Za-z.\-]*)$"
  for img in $IMAGES; do
    if "$COSIGN" verify \
        --certificate-identity-regexp "$IDENTITY" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        "ghcr.io/${REGISTRY_OWNER}/${img}:${TARGET}" >/dev/null 2>&1; then
      echo "  ${GRN}✓${R} ${img}:${TARGET} signed by release-images on ${REPO}"
    else
      die "${img}:${TARGET} failed signature verification — refusing to deploy."
    fi
  done
else
  echo "${YLW}⚠ cosign was not found — signatures were NOT checked.${R}"
  echo "  ${DIM}The images are still pulled by tag over TLS, but nothing proves they"
  echo "  came from this repo's workflow. One static binary closes that gap, and"
  echo "  on a host whose OS is replaced by updates it belongs beside the"
  echo "  project rather than in /usr/local/bin:"
  echo
  echo "      mkdir -p ${PROJECT_DIR}/bin"
  echo "      curl -fsSL -o ${PROJECT_DIR}/bin/cosign \\"
  echo "        https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64"
  echo "      chmod +x ${PROJECT_DIR}/bin/cosign"
  echo
  echo "  This wizard looks there as well as on PATH.${R}"
  ask "Continue without verification? [y/N] "
fi

# ----- deploy ---------------------------------------------------------------
cleanup() { docker logout ghcr.io >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -n "$TOKEN" ]; then
  # Only needed if the packages are private. Public images pull anonymously,
  # and logging in would leave a credential on disk for nothing.
  echo "${DIM}→ authenticating to ghcr.io…${R}"
  printf '%s' "$TOKEN" | docker login ghcr.io -u "$REGISTRY_OWNER" --password-stdin >/dev/null \
    || die "docker login failed — check the token's read:packages scope"
fi

echo "${DIM}→ pulling ${TARGET}…${R}"
( cd "$PROJECT_DIR" && sed -i "s|^PPP_TAG=.*|PPP_TAG=\"$TARGET\"|" .env.docker )
if ! compose pull; then
  ( cd "$PROJECT_DIR" && sed -i "s|^PPP_TAG=.*|PPP_TAG=\"$CURRENT\"|" .env.docker )
  die "pull failed — .env.docker restored to ${CURRENT}, nothing was restarted"
fi

echo "${DIM}→ starting…${R}"
if ! compose up -d; then
  echo "${RED}✗ docker compose up failed — rolling the tag back to ${CURRENT}.${R}" >&2
  ( cd "$PROJECT_DIR" && sed -i "s|^PPP_TAG=.*|PPP_TAG=\"$CURRENT\"|" .env.docker )
  compose up -d || true
  die "the stack was not swapped; .env.docker is back on ${CURRENT}"
fi

# ----- health, with automatic rollback --------------------------------------
echo "${DIM}→ waiting for health (polling ${HEALTH_URL}, up to $((HEALTH_TIMEOUT/60)) min)…${R}"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT )); ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)"
  if [ "$code" = "200" ]; then ok=$((ok+1)); [ "$ok" -ge 2 ] && break; else ok=0; fi
  sleep 10
done

if [ "$ok" -ge 2 ]; then
  echo "  ${GRN}✓${R} ${HEALTH_URL} → 200 (stable)"
  echo "${GRN}✓ ${TARGET} is live and healthy.${R}"
  compose ps
  exit 0
fi

echo "${RED}✗ health did not stabilise — rolling back to ${CURRENT}.${R}" >&2
( cd "$PROJECT_DIR" && sed -i "s|^PPP_TAG=.*|PPP_TAG=\"$CURRENT\"|" .env.docker )
compose up -d
sleep 10
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" || true)"
if [ "$code" = "200" ]; then
  echo "${YLW}⚠ rolled back to ${CURRENT}, which is healthy again.${R}" >&2
  echo "  ${DIM}Check what went wrong:  docker compose logs app --tail=100${R}" >&2
else
  echo "${RED}✗ rollback to ${CURRENT} is ALSO unhealthy (${code}).${R}" >&2
  echo "  ${DIM}This is not the image — look at the proxy, the database, or the tunnel."
  echo "  docker compose ps ; docker compose logs --tail=100${R}" >&2
fi
exit 1

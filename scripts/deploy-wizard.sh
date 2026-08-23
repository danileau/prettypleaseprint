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
#      menu instead of copying a tag out of a CI log.
#   2. IS IT INTACT?  → cosign-verifies the image against the identity of the
#      release-images workflow on this repo before anything is swapped. If
#      cosign is absent it says so loudly rather than quietly skipping.
#   3. DID IT WORK?   → polls the public health URL after the swap, and rolls
#      back to the previous tag automatically if it does not come good.
#
# The registry token is borrowed and returned: read from a hidden prompt,
# used for the pull, then `docker logout`. Nothing long-lived is left behind,
# which matters because the images are local afterwards and reboots need no
# registry access at all.
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

HEALTH_URL="${PPP_HEALTH_URL:-https://ppp.danileau.com/api/health}"
REGISTRY_OWNER="${PPP_REGISTRY_OWNER:-danileau}"
REPO="${PPP_REPO:-danileau/ppp}"
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

# ----- args -----------------------------------------------------------------
STATUS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) WINDOW="${2:?-n needs a number}"; shift 2 ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

# ----- preflight ------------------------------------------------------------
command -v docker  >/dev/null || die "docker required"
command -v curl    >/dev/null || die "curl required"
command -v python3 >/dev/null || die "python3 required (for reading the registry's JSON)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
[ -f "$PROJECT_DIR/.env.docker" ] || die "no .env.docker in $PROJECT_DIR — is PPP_DIR right?"

CURRENT="$(sed -n 's/^PPP_TAG="\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$PROJECT_DIR/.env.docker" | head -1)"
[ -n "$CURRENT" ] || die "PPP_TAG not found in .env.docker"

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
  echo "      PPP_COMPOSE_FILES=\"-f docker-compose.prod.yml -f docker-compose.nas.yml\"" >&2
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
read_token() {
  if [ -n "${PPP_TOKEN:-}" ]; then TOKEN="$PPP_TOKEN"; return; fi
  printf 'ghcr.io token (read:packages, hidden): '
  stty -echo 2>/dev/null || true
  read -r TOKEN
  stty echo 2>/dev/null || true
  printf '\n'
  [ -n "$TOKEN" ] || die "no token given"
}
read_token

echo "${DIM}→ asking ghcr.io what is published…${R}"
VERSIONS="$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/user/packages/container/ppp-app/versions?per_page=100" 2>/dev/null || true)"

# Two things this filtering has to get right, both learned the hard way:
#   - release-images publishes cosign signatures and SBOM attestations to the
#     same package, tagged `sha256-<digest>.sig` / `.att`. Those are not
#     runnable images; only a 7-hex-char tag is one.
#   - sort by created_at, NOT updated_at. Re-pointing `latest` on a new
#     release touches the OLD version's updated_at too, so ordering by it
#     reshuffles history and shows a build's date as the day it was
#     superseded.
CANDIDATES="$(printf '%s' "$VERSIONS" | python3 -c '
import json, re, sys
# A 7-char commit SHA, or a release like v0.1.0 / v1.2.3-rc1. Everything else
# in this package is machinery: cosign publishes `sha256-<digest>.sig` and the
# SBOM publishes `.att`, and neither is a runnable image.
DEPLOYABLE = re.compile(r"^([0-9a-f]{7}|v\d+\.\d+\.\d+[0-9A-Za-z.\-]*)$")
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(data, list):
    sys.exit(1)
rows = []
for v in data:
    tags = (v.get("metadata") or {}).get("container", {}).get("tags", []) or []
    # Prefer a version tag when the same image carries both, because that is
    # the name a person will recognise in the menu.
    sha = next((t for t in tags if t.startswith("v") and DEPLOYABLE.match(t)), None) \
          or next((t for t in tags if DEPLOYABLE.match(t)), None)
    if not sha:
        continue
    rows.append((v.get("created_at") or "", sha, "latest" in tags))
rows.sort(reverse=True)
for when, sha, is_latest in rows:
    print("\t".join([sha, when[:16].replace("T", " "), "latest" if is_latest else ""]))
' 2>/dev/null || true)"

if [ -z "$CANDIDATES" ]; then
  echo "${YLW}⚠ could not read the package list.${R}"
  echo "  ${DIM}Most likely the token lacks read:packages, or it expired."
  echo "  Verify with:  curl -sSI -H \"Authorization: Bearer \$TOKEN\" https://api.github.com/user | grep -i x-oauth-scopes${R}"
  exit 1
fi

echo
echo "${B}Published images${R} ${DIM}(newest first):${R}"
echo
printf "  ${DIM} %-3s %-10s %-18s %-8s %s${R}\n" "#" "tag" "published" "moving" "state"

declare -a IDX_SHA
i=0; DEFAULT=""
while IFS=$'\t' read -r sha when islatest; do
  [ -n "$sha" ] || continue
  i=$((i+1)); [ "$i" -gt "$WINDOW" ] && break
  IDX_SHA[$i]="$sha"
  if [ "$sha" = "$CURRENT" ]; then
    state="${CYN}LIVE${R}"
  else
    state="${DIM}-${R}"
  fi
  # Recommend the newest published image that is not already live, and only
  # when it is NEWER than what is live — never point the default backwards at
  # something old that simply never shipped; that would read as a regression.
  if [ -z "$DEFAULT" ] && [ "$sha" != "$CURRENT" ] && [ "$i" -eq 1 ]; then
    DEFAULT="$i"; mark="${B}${GRN}»${R}"
  else
    mark=" "
  fi
  printf " %b %-3s ${CYN}%-10s${R} %-18s %-8s %b\n" "$mark" "$i" "$sha" "$when" "${islatest:-}" "$state"
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
read -r choice

if [ -z "$choice" ]; then
  [ -n "$DEFAULT" ] || { echo "aborted."; exit 0; }
  choice="$DEFAULT"
fi
case "$choice" in q|Q) echo "aborted."; exit 0 ;; esac
[[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$i" ] \
  || die "invalid selection: $choice"

TARGET="${IDX_SHA[$choice]}"
[ "$TARGET" = "$CURRENT" ] && echo "${YLW}note: ${TARGET} is already live — this is a redeploy.${R}"

echo
if [ "$HEALTH" != "200" ]; then
  echo "${YLW}⚠ ${HEALTH_URL} is already answering ${HEALTH}, before any change.${R}"
  echo "  ${DIM}Whatever is wrong is not this image, and the automatic rollback"
  echo "  cannot help — it rolls back to the version that is failing now."
  echo "  Worth fixing the current breakage first.${R}"
  printf "Deploy anyway? [y/N] "
  read -r ans; case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 0 ;; esac
  echo
fi

if [ "$TARGET" = "$CURRENT" ]; then
  printf "Redeploy %s? [y/N] " "$TARGET"
else
  printf "Deploy ${CYN}%s${R} (replacing %s)? [y/N] " "$TARGET" "$CURRENT"
fi
read -r ans; case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 0 ;; esac

# ----- signature ------------------------------------------------------------
# CI signs both images with cosign keyless, pinning the identity of the
# release-images workflow on this repo. That signature is what protects the
# registry-to-NAS link against a substituted or tampered image, so it is
# checked BEFORE anything is swapped — and its absence is reported, never
# silently skipped.
if command -v cosign >/dev/null; then
  echo "${DIM}→ verifying signatures…${R}"
  for img in $IMAGES; do
    if cosign verify \
        --certificate-identity-regexp "^https://github\.com/${REPO}/\.github/workflows/release-images\.yml@refs/heads/main$" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        "ghcr.io/${REGISTRY_OWNER}/${img}:${TARGET}" >/dev/null 2>&1; then
      echo "  ${GRN}✓${R} ${img}:${TARGET} signed by release-images on ${REPO}"
    else
      die "${img}:${TARGET} failed signature verification — refusing to deploy."
    fi
  done
else
  echo "${YLW}⚠ cosign is not installed — signatures were NOT checked.${R}"
  echo "  ${DIM}The images are still pulled by tag over TLS, but nothing proves they"
  echo "  came from this repo's workflow. Install cosign to close that gap:"
  echo "  https://docs.sigstore.dev/cosign/installation/${R}"
  printf "Continue without verification? [y/N] "
  read -r ans; case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 0 ;; esac
fi

# ----- deploy ---------------------------------------------------------------
cleanup() { docker logout ghcr.io >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "${DIM}→ authenticating to ghcr.io…${R}"
printf '%s' "$TOKEN" | docker login ghcr.io -u "$REGISTRY_OWNER" --password-stdin >/dev/null \
  || die "docker login failed — check the token's read:packages scope"

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

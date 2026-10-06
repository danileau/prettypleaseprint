#!/usr/bin/env bash
#
# ppp full local test — everything CI gates on, run against this working copy.
#
# "Green CI is not enough" is this project's own rule: a change is merged after
# the whole stack has been raised from the working copy on a FRESH data
# directory and every suite has run against the built image. Doing that by hand
# is nine commands, three env files and a teardown, and each of them has been
# got wrong at least once. This script is that run, the same every time.
#
# What it does, in order:
#   1. Refuses to start if it could hurt something that is already here: a ppp
#      stack of any kind (the container names are fixed, so there can only be
#      one), a port the stack needs, or env files a killed run left saved.
#   2. The static gates — typecheck, links, secrets, trivy, the upload
#      validator — BEFORE touching any env file, so the secret scanner sees
#      your real .env* and not a generated one.
#   3. Saves .env, .env.backup and .env.docker, writes a throwaway .env.docker
#      and raises the stack under its own project name on a data directory
#      outside the repository.
#   4. The nine integration suites in CI's order, all of them even after one
#      fails, then the two image pins CI keeps.
#   5. Takes the stack down, removes its data and puts the three env files
#      back exactly as they were — on success, on failure and on Ctrl-C.
#
# Two things it deliberately does not do:
#   - It never removes a stack it did not raise. The project is `ppp-fulltest`,
#     not `ppp`, so `down` cannot reach yours; and before the first suite it
#     checks that the app container answering on :3000 belongs to this run.
#     The suites wipe users and tickets.
#   - It does not itself interrupt a suite that is running. A signal sent to
#     this script alone (`kill <pid>`) is acted on once the current step has
#     returned. Ctrl-C in a terminal is different: it goes to the whole
#     foreground group, so the suite gets it too and usually ends at once.
#     Either way the cleanup then runs in full, and a second Ctrl-C during it
#     is ignored so the env files are always put back.
#
# It is CI's `verify` job in what matters — the same three compose files, the
# same profile, the same suites in the same order — and differs where a
# developer's machine has to be protected: the project is `ppp-fulltest`, the
# images are tagged `full-test-local`, DATA_ROOT is a throwaway directory, and
# the health wait is longer (120 s against CI's 90).
#
# What it leaves behind: the images it built, tagged `:full-test-local` (so a
# pulled `:latest` is never overwritten), and the logs.
#
# Usage:
#   scripts/full-test.sh                 # everything; exit 0 only if all passed
#   scripts/full-test.sh --no-build      # raise the stack without rebuilding
#   scripts/full-test.sh --only "verify:auth verify:api"   # a subset of suites
#   scripts/full-test.sh --preflight     # only the refusals in step 1, then exit
#   scripts/full-test.sh --restore       # undo what a killed run left behind
#
# --no-build and --only are for iterating; both print PARTIAL RUN, and neither
# is a release gate.
#
# Environment:
#   PPP_FULLTEST_OUT             where logs and the data directory go
#                                (default: a fresh directory under $TMPDIR)
#   PPP_FULLTEST_HEALTH_TIMEOUT  seconds to wait for /api/health (default 120)
#   CHROME_PATH                  passed through to verify:passkey

set -euo pipefail

# ----- pretty ---------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
  RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'
else
  B=""; DIM=""; R=""; RED=""; GRN=""; YLW=""
fi
die() { echo "${RED}✗ $*${R}" >&2; exit 1; }

# ----- args -----------------------------------------------------------------
BUILD=1; ONLY=""; ONLY_GIVEN=0; MODE="run"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --only) [ $# -ge 2 ] || die "--only needs a quoted list of suites"; ONLY="$2"; ONLY_GIVEN=1; shift 2 ;;
    --restore) MODE="restore"; shift ;;
    --preflight) MODE="preflight"; shift ;;
    -h|--help) sed -n '2,61p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

# ----- constants ------------------------------------------------------------
command -v git >/dev/null || die "git required"
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)" \
  || die "this script has to live in a checkout of the repository"
cd "$ROOT"

# Deliberately not `ppp`. `down -v` removes whatever project it is pointed at,
# and a developer's own stack is the project `ppp`: with a name of its own this
# script cannot reach a project it did not create.
PROJECT="ppp-fulltest"
COMPOSE=(docker compose -p "$PROJECT" --env-file .env.docker
  -f docker-compose.prod.yml -f docker-compose.build.yml
  -f docker-compose.test.yml --profile mailcatcher)
COMPOSE_FILES_NEEDED="docker-compose.prod.yml docker-compose.build.yml docker-compose.test.yml"

# The names docker-compose.prod.yml pins with container_name. They are why
# only one stack can exist on a machine, whatever its project is called.
# and docker-compose.test.yml adds the Printables stand-in.
STACK_NAMES="ppp-app ppp-db ppp-migrate ppp-mailpit ppp-printables-stub"

# What docker-compose.test.yml publishes on the host. APP_PORT,
# MAILPIT_UI_PORT and PRINTABLES_STUB_PORT could move three of them, but this
# script unsets them all, so the five are fixed. PPP_FULLTEST_PORTS exists for this script's own tests, which
# have to run on machines where 3000 is taken.
PORTS="${PPP_FULLTEST_PORTS:-3000 5432 1025 8025 4010}"

# In CI's order (the `verify` job of .github/workflows/ci.yml). A test pins
# this list to that file, because the hand-rolled predecessor of this script
# had quietly lost verify:catalog.
SUITES="verify:auth verify:upload verify:import verify:queue verify:frr verify:benefits verify:catalog verify:api verify:passkey probe:security"

ENV_FILES=".env .env.backup .env.docker"

# Where the developer's env files wait while the generated ones are in place.
# Inside the git directory because that is fixed per checkout (a second run can
# find what a killed one left), never tracked, outside the build context
# (.dockerignore excludes .git) and not read by check:secrets, which looks at
# .env* in the root.
SAVED="$(git rev-parse --absolute-git-dir)/ppp-full-test-saved"

HEALTH_TIMEOUT="${PPP_FULLTEST_HEALTH_TIMEOUT:-120}"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] \
  || die "PPP_FULLTEST_HEALTH_TIMEOUT must be a whole number of seconds, not '$HEALTH_TIMEOUT'"
# An empty list would otherwise run no suite at all and report that as a pass.
if [ "$ONLY_GIVEN" -eq 1 ]; then
  # shellcheck disable=SC2086
  set -- $ONLY
  [ $# -gt 0 ] || die "--only needs at least one suite: $SUITES"
  for s in "$@"; do
    case " $SUITES " in *" $s "*) ;; *) die "--only: $s is not one of: $SUITES" ;; esac
  done
fi
LOCAL_TAG="full-test-local"

# ----- env files: save and restore ------------------------------------------
# Each copy is written under a temporary name and renamed into place, so a
# copy that fails halfway (a full disk) can never leave a truncated file under
# the name restore_env trusts.
save_env() {
  local f
  mkdir "$SAVED" || return 1
  for f in $ENV_FILES; do
    if [ -e "$f" ]; then
      cp -p "$f" "$SAVED/$f.part" && mv "$SAVED/$f.part" "$SAVED/$f" || return 1
    else
      touch "$SAVED/$f.absent" || return 1
    fi
  done
}

# Returns 1, and keeps the saved copies, if anything could not be put back.
# A file with neither a copy nor an `.absent` marker was never reached by
# save_env (the run died in the middle of it), so it is still the developer's
# own and is left alone.
restore_env() {
  local f bad=0
  [ -d "$SAVED" ] || return 0
  for f in $ENV_FILES; do
    if [ -e "$SAVED/$f" ]; then
      # -f: a developer's env file may be read-only (0400 is a sensible mode
      # for a file of credentials), and cp cannot open that for writing; with
      # -f it removes the target and writes a new one, which the directory
      # permits. Without it the restore would fail the same way for ever.
      cp -pf "$SAVED/$f" "$f" || bad=1
    elif [ -e "$SAVED/$f.absent" ]; then
      rm -f "$f" || bad=1
    fi
  done
  if [ "$bad" -ne 0 ]; then
    echo "${RED}✗ could not put every env file back — your originals are still in:${R}" >&2
    echo "${RED}    $SAVED${R}" >&2
    return 1
  fi
  rm -rf "$SAVED"
}

# ----- --restore ------------------------------------------------------------
# For the run that was killed with -9 or lost its terminal: the trap never
# fired, so the stack may still be up and the env files are still the
# generated ones.
if [ "$MODE" = "restore" ]; then
  # By label and without compose: `compose down` interpolates the generated
  # .env.docker, and that file may be exactly what went missing.
  if command -v docker >/dev/null; then
    ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" || true)"
    if [ -n "$ids" ]; then
      echo "removing the containers of project $PROJECT"
      # shellcheck disable=SC2086
      docker rm -f -v $ids >/dev/null || die "could not remove the $PROJECT containers"
    fi
    nets="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" || true)"
    if [ -n "$nets" ]; then
      # shellcheck disable=SC2086
      docker network rm $nets >/dev/null || die "could not remove the $PROJECT network"
    fi
  else
    echo "${YLW}⚠ docker not found — only the env files are restored.${R}"
  fi
  if [ ! -d "$SAVED" ]; then echo "nothing to restore"; exit 0; fi
  restore_env || exit 1
  echo "restored .env, .env.backup, .env.docker"
  exit 0
fi

# ----- preflight ------------------------------------------------------------
# Every refusal here happens before the trap is installed and before any file
# is touched, so refusing never tears anything down.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

preflight() {
  local t f p listing mine=0 lines=""
  for t in docker npm curl openssl; do
    command -v "$t" >/dev/null || die "$t required"
  done
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
  [ -d node_modules ] || die "no node_modules — run npm ci first"
  for f in .env.docker.example $COMPOSE_FILES_NEEDED; do
    [ -f "$f" ] || die "$f is missing — is this a complete checkout?"
  done
  if [ -e "$SAVED" ]; then
    echo "${RED}✗ a previous run did not restore your env files; they are in $SAVED.${R}" >&2
    echo "  Run: scripts/full-test.sh --restore" >&2
    exit 1
  fi

  # Running or stopped: a stopped ppp-db still owns the name, and `up` would
  # fail on it halfway through. Filtered in awk, not grep, because "no stack"
  # is the normal case and must not be an error under pipefail.
  listing="$(docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}')" \
    || die "docker ps failed — is the docker daemon running, and may you talk to it?"
  lines="$(printf '%s\n' "$listing" | awk -F'\t' -v names="$STACK_NAMES" '
    BEGIN { n = split(names, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
    ($1 in want) { printf "    %s  (%s, project %s)\n", $1, $2, ($3 == "" ? "none" : $3) }')"
  if [ -n "$lines" ]; then
    mine="$(printf '%s\n' "$listing" | awk -F'\t' -v names="$STACK_NAMES" -v p="$PROJECT" '
      BEGIN { n = split(names, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1; other = 0; seen = 0 }
      ($1 in want) { seen = 1; if ($3 != p) other = 1 }
      END { print (seen && !other) ? 1 : 0 }')"
    echo "${RED}✗ a ppp stack already exists on this machine:${R}" >&2
    printf '%s\n' "$lines" >&2
    if [ "$mine" = "1" ]; then
      echo "  It is what an earlier run of this test left behind. Remove it with:" >&2
      echo "      scripts/full-test.sh --restore" >&2
    else
      echo "  Container names are fixed, so only one stack can exist, and this test" >&2
      echo "  would have to remove yours. It will not. Take it down yourself, then run again." >&2
    fi
    exit 1
  fi

  # A data directory left in a reused PPP_FULLTEST_OUT is last run's database,
  # and "fresh" is the whole point of the run.
  if [ -n "${PPP_FULLTEST_OUT:-}" ] && [ -e "$PPP_FULLTEST_OUT/data" ]; then
    echo "${RED}✗ $PPP_FULLTEST_OUT/data already exists — the test needs a fresh data directory.${R}" >&2
    echo "  It is owned by container uids; remove it with:" >&2
    echo "      docker run --rm -v \"$PPP_FULLTEST_OUT:/o\" postgres:17-alpine rm -rf /o/data" >&2
    exit 1
  fi

  [ -z "${PPP_FULLTEST_PORTS:-}" ] \
    || echo "${YLW}⚠ port check replaced by PPP_FULLTEST_PORTS=$PPP_FULLTEST_PORTS${R}"
  for p in $PORTS; do
    if port_in_use "$p"; then
      die "port $p is in use — the test stack publishes it. Stop whatever holds it, then run again."
    fi
  done
}

preflight
if [ "$MODE" = "preflight" ]; then
  echo "${GRN}✓ nothing in the way of a full test${R}"
  exit 0
fi

# ----- a clean environment --------------------------------------------------
# The shell wins over --env-file in compose, over .env.docker in
# use-container-env.ts and over .env in _env.ts ("Real environment variables
# always win"). So a DB_PASSWORD or a PPP_TAG exported in the terminal this
# was started from would silently replace the generated one, or point the
# suites somewhere else entirely.
unset DB_PASSWORD APP_URL APP_PORT BETTER_AUTH_SECRET BETTER_AUTH_URL \
  ADMIN_EMAIL ADMIN_NAME MAIL_FROM SMTP_URL DATABASE_URL MODELS_ROOT PPP_TAG \
  PPP_REGISTRY PPP_ENV_FILE MAILPIT_UI_PORT TRUST_PROXY_HEADERS MAILPIT_URL \
  PRINTABLES_STUB_PORT PRINTABLES_STUB_URL IMPORT_SOURCES IMPORT_PRINTABLES_BASE \
  RESEND_API_KEY PASSKEY_RP_ID PASSKEY_RP_NAME COMPOSE_PROFILES COMPOSE_FILE \
  COMPOSE_PROJECT_NAME DATA_ROOT HIBP_DISABLED

# Outside the repository on purpose: the data tree ends up owned by container
# uids, and inside the checkout it would be walked into the next build context.
OUT="${PPP_FULLTEST_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ppp-full-test.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
: >"$OUT/summary.txt"

FAILED=0
STACK_RAISED=0
ENV_SAVED="no"

# step <name> <command…> — one line of verdict, the output in a log.
step() {
  local name=$1 rc=0
  shift
  "$@" >"$OUT/$name.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "${GRN}PASS${R} $name" | tee -a "$OUT/summary.txt"
  else
    echo "${RED}FAIL${R} $name (exit $rc)" | tee -a "$OUT/summary.txt"
    FAILED=1
  fi
  return "$rc"
}
skip() { echo "${YLW}SKIP${R} $*" | tee -a "$OUT/summary.txt"; }

# ----- cleanup --------------------------------------------------------------
cleanup() {
  # First, before anything slow: `down` takes several seconds, and a second
  # Ctrl-C landing in it would otherwise end the script with the generated env
  # files still in place.
  trap '' INT TERM
  set +e
  local ok=1
  if [ "$STACK_RAISED" -eq 1 ]; then
    "${COMPOSE[@]}" logs --tail=300 >"$OUT/compose.log" 2>&1
    # Before the env files go back: `down` interpolates ${DB_PASSWORD:?} from
    # the generated .env.docker, and fails outright against a file without it.
    if ! "${COMPOSE[@]}" down -v --remove-orphans >"$OUT/down.log" 2>&1; then
      ok=0
      echo "${RED}✗ taking the stack down failed — see $OUT/down.log, then: scripts/full-test.sh --restore${R}" >&2
    fi
    # The tree is owned by the containers' uids, so this user cannot remove
    # it. The Postgres image is the one the stack just ran: no pull.
    if [ -e "$OUT/data" ]; then
      if ! docker run --rm -v "$OUT:/o" postgres:17-alpine rm -rf /o/data >/dev/null 2>&1; then
        ok=0
        echo "${YLW}⚠ could not remove the test data in $OUT/data. Remove it with:${R}" >&2
        echo "      docker run --rm -v \"$OUT:/o\" postgres:17-alpine rm -rf /o/data" >&2
      fi
    fi
  fi
  case "$ENV_SAVED" in
    saving)
      # The save itself did not finish, so no env file was touched and no
      # stack was raised. The half-made copies are of no use to anyone.
      rm -rf "$SAVED"
      echo "${RED}✗ could not save the env files — nothing was changed and no stack was raised.${R}" >&2 ;;
    saved)
      if restore_env; then
        if [ "$STACK_RAISED" -eq 1 ] && [ "$ok" -eq 1 ]; then
          echo "restored .env, .env.backup, .env.docker; stack down; logs in $OUT"
        else
          echo "restored .env, .env.backup, .env.docker; logs in $OUT"
        fi
      else
        FAILED=1
      fi ;;
  esac
  set -e
}

# ----- static gates ---------------------------------------------------------
echo "${B}ppp full test${R}  ${DIM}· $ROOT · logs in $OUT${R}"

step typecheck npm run -s typecheck || true
step check-links npm run -s check:links || true
step check-secrets npm run -s check:secrets -- --all || true
if command -v trivy >/dev/null; then
  step trivy-fs trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL \
    --exit-code 1 --ignore-unfixed --skip-dirs node_modules --skip-dirs .next \
    --skip-dirs data --skip-dirs .claude . || true
else
  skip "trivy-fs (trivy not installed; CI's trivy job still gates it)"
fi
step verify-models npm run -s verify:models || true

# ----- the stack ------------------------------------------------------------
# The trap goes in before the first copy, so there is no moment at which a
# file has been moved aside and nothing is registered to bring it back.
ENV_SAVED="saving"
trap cleanup EXIT
trap 'exit 130' INT TERM
save_env || exit 1
ENV_SAVED="saved"

# The originals are safe, so take them out of the way rather than write over
# them: a read-only .env would refuse the redirect below, and would refuse
# `npm run env:container` later, after the stack is already up.
# shellcheck disable=SC2086
rm -f $ENV_FILES

# As CI does it (the "Compose environment" step).
{
  cat .env.docker.example
  echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
  echo "DB_PASSWORD=$(openssl rand -hex 24)"
  echo "ADMIN_EMAIL=ci-admin@example.test"
  echo "ADMIN_NAME=Ruben Haas"
  # The build overlay tags what it builds ${PPP_REGISTRY}/ppp-app:${PPP_TAG}.
  # Left at `latest`, a local build would overwrite the image this developer
  # pulled, and the next `docker compose up` of their own stack would run it.
  echo "PPP_TAG=$LOCAL_TAG"
} >.env.docker
export DATA_ROOT="$OUT/data"

STACK_RAISED=1
UP=(up -d)
[ "$BUILD" -eq 1 ] && UP+=(--build)

healthy=0
if step stack-up "${COMPOSE[@]}" "${UP[@]}"; then
  started=$(date +%s); deadline=$(( started + HEALTH_TIMEOUT ))
  while :; do
    if curl -fsS -m 3 http://localhost:3000/api/health >/dev/null 2>&1; then healthy=1; break; fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    echo "${GRN}PASS${R} health ($(( $(date +%s) - started ))s)" | tee -a "$OUT/summary.txt"
  else
    echo "${RED}FAIL${R} health" | tee -a "$OUT/summary.txt"; FAILED=1
    skip "suites (stack not healthy)"
  fi
else
  # Never fall through to the health check here: something answering on :3000
  # after a failed `up` is by definition not what this run built.
  skip "suites (stack did not come up)"
fi

# Whatever answers on :3000 has to be the container this run raised. The
# suites delete every user and ticket in the database they are pointed at.
owns_the_stack() {
  local owner
  owner="$(docker inspect ppp-app --format '{{index .Config.Labels "com.docker.compose.project"}}')" || return 1
  echo "ppp-app belongs to project: ${owner:-none}"
  [ "$owner" = "$PROJECT" ]
}

# The two regression pins CI keeps after the suites: neither runtime image
# ships npm (it bundles a vulnerable sigstore), and the migrator still finds
# prisma and tsx without it.
image_prefix() {
  sed -n 's/^PPP_REGISTRY="\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' .env.docker | tail -1
}
no_npm_in_images() {
  local img prefix
  prefix="$(image_prefix)"
  for img in ppp-app ppp-migrate; do
    if docker run --rm --entrypoint sh "$prefix/$img:$LOCAL_TAG" -c 'command -v npm' >/dev/null 2>&1; then
      echo "npm is back in $img — it re-adds the vulnerable bundled sigstore"
      return 1
    fi
  done
  echo "neither image ships npm"
}
migrator_runs() {
  docker run --rm --entrypoint sh "$(image_prefix)/ppp-migrate:$LOCAL_TAG" \
    -c './node_modules/.bin/prisma --version >/dev/null && ./node_modules/.bin/tsx --version >/dev/null'
}

if [ "$healthy" -eq 1 ]; then
  if ! step stack-ownership owns_the_stack; then
    skip "suites (the app on :3000 is not the one this run raised)"
  elif ! step env-container npm run -s env:container; then
    # Without it .env still describes the developer's own stack, and the
    # suites would be aimed at whatever that file names.
    skip "suites (.env does not point at the test stack)"
  else
    for suite in ${ONLY:-$SUITES}; do
      step "${suite/:/-}" npm run -s "$suite" || true
    done
    step no-npm-in-images no_npm_in_images || true
    step migrator-runs migrator_runs || true
  fi
fi

# ----- done -----------------------------------------------------------------
# Called here rather than left to the trap, so the summary is the last thing
# on the screen and the exit status can still take a failed restore into
# account.
cleanup
trap - EXIT

echo
if [ "$FAILED" -ne 0 ]; then
  echo "${RED}Failed:${R}"
  awk '/FAIL/ { print "  " $0 }' "$OUT/summary.txt"
fi
if [ "$BUILD" -eq 0 ] || [ "$ONLY_GIVEN" -eq 1 ]; then
  echo "${YLW}PARTIAL RUN — not a release gate${R}" | tee -a "$OUT/summary.txt"
fi
echo "DONE failed=$FAILED" | tee -a "$OUT/summary.txt"
exit "$FAILED"

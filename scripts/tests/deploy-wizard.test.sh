#!/usr/bin/env bash
#
# Tests for scripts/deploy-wizard.sh.
#
#   bash scripts/tests/deploy-wizard.test.sh
#
# Prints one line per case (`ok   <name>` / `FAIL <name>` with the reason and
# the wizard's output) and a final count; exits 0 only if every case passed.
#
# The wizard's whole job is to run `docker compose pull` and `up -d` against a
# live deployment, so the one thing this file must never do is reach a real
# docker. Three things make that structural rather than a matter of care:
#
#   - PATH, for the wizard AND for this file, is two directories and nothing
#     else: a directory of stubs (docker, curl, cosign, sleep) and a directory
#     of symlinks to an allow-list of ordinary tools. /usr/bin and /bin are not
#     on it, because that is where the real, logged-in docker lives.
#   - Every stub answers only the calls it was told to expect. Anything else
#     exits 99 and leaves a file behind, and every case fails if that file
#     exists — so a new call the wizard grows cannot pass unnoticed.
#   - The wizard runs under `env -i`, in a `mktemp -d` deployment directory, so
#     nothing leaks in from the shell that started the tests.
#
# No network either: curl is a stub that serves fixtures by URL. The release
# list is built from fixtures/deploy/releases-real.json — the two releases as
# GitHub actually serves them — plus synthetic later ones, so the "Upgrading"
# extraction is tested against what is really published and against the shapes
# that are not published yet (CRLF, a fenced `# Upgrading`, a draft).
#
# The golden-* fixtures were captured from the wizard as it stood at 1612bf3,
# BEFORE release marks, the published check and the upgrade notes existed, by
#   PPP_WIZARD_UNDER_TEST=<that script> bash deploy-wizard.test.sh --capture-golden <dir>
# They pin "a SHA-to-SHA deploy that crosses no release behaves as it always
# did". Re-capturing them from a later wizard would make that case compare the
# script with itself, so do not.

set -uo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/fixtures/deploy"
WIZARD="${PPP_WIZARD_UNDER_TEST:-$HERE/../deploy-wizard.sh}"
[ -f "$WIZARD" ] || { echo "no wizard at $WIZARD" >&2; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ppp-deploy-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ----- the only PATH there is ------------------------------------------------
# `sleep` is deliberately absent (it is a stub), and so are docker, curl and
# cosign. `paste` is here because the wizard's container line pipes through it.
TOOLS="$ROOT/tools"; mkdir "$TOOLS"
for tool in bash sh env git node npm python3 sed awk grep sort tail head cat cp \
            mv rm mkdir mktemp date diff tr cut wc printf chmod touch ls dirname \
            basename readlink timeout tee cmp stat id find xargs uname true \
            false kill paste; do
  real="$(type -P "$tool" || true)"
  [ -n "$real" ] && ln -s "$real" "$TOOLS/$tool"
done
PATH="$TOOLS"

# ----- stubs -----------------------------------------------------------------
TEMPLATE="$ROOT/stub-template"; mkdir "$TEMPLATE"

cat >"$TEMPLATE/docker" <<'STUB'
#!/usr/bin/env bash
# Logs argv, answers the calls the wizard is known to make, refuses the rest.
S="$STUB_STATE"
printf '%s\n' "$*" >>"$S/docker.log"
unexpected() { echo "unexpected: docker $*" >&2; echo "docker $*" >>"$S/unexpected"; exit 99; }
COMPOSE="compose --env-file .env.docker -f docker-compose.prod.yml"
case "$*" in
  "compose version") echo "Docker Compose version v2.stub" ;;
  "compose ls --all --format json") echo "[]" ;;
  "ps --filter name=ppp- --format {{.Names}} ({{.Status}})")
    printf 'ppp-app (Up 3 hours (healthy))\nppp-db (Up 3 hours (healthy))\n' ;;
  "$COMPOSE pull")
    # Record which tag the pull would have fetched: the wizard rewrites
    # .env.docker first, and that ordering is part of what is pinned.
    printf '  pull saw %s\n' "$(grep '^PPP_TAG=' .env.docker)" >>"$S/docker.log"
    echo "stub: pulled"
    exit "$(cat "$S/pull-exit" 2>/dev/null || echo 0)" ;;
  "$COMPOSE up -d")
    n=$(( $(cat "$S/up-count" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$S/up-count"
    printf '  up saw %s\n' "$(grep '^PPP_TAG=' .env.docker)" >>"$S/docker.log"
    # Lets a case make the app unhealthy after the swap and healthy again
    # after the rollback.
    [ -f "$S/health-after-up-$n" ] && cp "$S/health-after-up-$n" "$S/health"
    echo "stub: started" ;;
  "$COMPOSE ps") echo "stub: ppp-app running" ;;
  "login ghcr.io -u "*" --password-stdin") cat >/dev/null; echo "Login Succeeded" ;;
  "logout ghcr.io") echo "Removing login credentials for ghcr.io" ;;
  "manifest inspect ghcr.io/"*)
    ref="$3"; f="$S/manifests/${ref##*/}"
    [ -f "$f" ] || unexpected "$@"
    case "$(cat "$f")" in
      ok) echo '{"schemaVersion": 2, "manifests": []}' ;;
      # The three answers below are what docker 24 really prints.
      unknown) echo "manifest unknown" >&2; exit 1 ;;
      denied) echo "Get \"https://ghcr.io/v2/${ref#ghcr.io/}\": denied" >&2; exit 1 ;;
      *) unexpected "$@" ;;
    esac ;;
  *) unexpected "$@" ;;
esac
STUB

cat >"$TEMPLATE/curl" <<'STUB'
#!/usr/bin/env bash
# Serves fixtures by URL. Honours -f (exit 22 on an HTTP error, no body) and
# -w with %{http_code}; logs `auth <url>` or `anon <url>` for every call.
S="$STUB_STATE"
unexpected() { echo "unexpected: curl $*" >&2; echo "curl $*" >>"$S/unexpected"; exit 99; }
url=""; wfmt=""; failflag=0; who=anon; skip=""
for a in "$@"; do
  if [ -n "$skip" ]; then
    case "$skip" in
      -w) wfmt="$a" ;;
      -H) case "$a" in Authorization:*) who=auth ;; esac ;;
    esac
    skip=""; continue
  fi
  case "$a" in
    -w|-H|-o|--max-time) skip="$a" ;;
    http://*|https://*) url="$a" ;;
    --*) unexpected "$@" ;;
    -*) case "$a" in *f*) failflag=1 ;; esac ;;
    *) unexpected "$@" ;;
  esac
done
[ -n "$url" ] || unexpected "$@"
printf '%s %s\n' "$who" "$url" >>"$S/curl.log"

# respond <key> <body>: the status is 200 unless $S/http/<key>.<who> or
# $S/http/<key> says otherwise.
respond() {
  local key="$1" body="$2" code=200
  if [ -f "$S/http/$key.$who" ]; then code="$(cat "$S/http/$key.$who")"
  elif [ -f "$S/http/$key" ]; then code="$(cat "$S/http/$key")"; fi
  if [ "$code" = 200 ]; then printf '%s' "$body"
  elif [ "$failflag" = 0 ]; then printf '{"message": "stub error", "status": "%s"}' "$code"; fi
  if [ -n "$wfmt" ]; then
    wfmt="${wfmt//\\n/$'\n'}"; printf '%s' "${wfmt//%\{http_code\}/$code}"
  fi
  if [ "$code" != 200 ] && [ "$failflag" = 1 ]; then exit 22; fi
  exit 0
}

case "$url" in
  https://print.example.test/api/health)
    [ -n "$wfmt" ] || unexpected "$@"
    printf '%s' "$(cat "$S/health")"; exit 0 ;;
  "https://api.github.com/user/packages/container/ppp-app/versions?per_page=100")
    respond packages "$(cat "$S/packages.json")" ;;
  "https://api.github.com/repos/danileau/prettypleaseprint/releases?per_page=100")
    respond releases "$(cat "$S/releases.json")" ;;
  https://api.github.com/repos/danileau/prettypleaseprint/compare/*"?per_page=1&page=2")
    # Only the cheap form is served: without the paging suffix the real answer
    # is megabytes, so asking for it is a bug worth failing on.
    pair="${url##*/compare/}"; pair="${pair%%\?*}"
    [ -f "$S/compare/$pair" ] || unexpected "$@"
    status="$(cat "$S/compare/$pair")"
    case "$status" in
      ahead|behind|identical|diverged)
        respond "compare-$pair" "{\"url\": \"stub\", \"status\": \"$status\", \"commits\": []}" ;;
      nostatus) respond "compare-$pair" '{"url": "stub"}' ;;
      [0-9][0-9][0-9]) echo "$status" >"$S/http/compare-$pair"; respond "compare-$pair" "" ;;
      *) unexpected "$@" ;;
    esac ;;
  *) unexpected "$@" ;;
esac
STUB

cat >"$TEMPLATE/cosign" <<'STUB'
#!/usr/bin/env bash
S="$STUB_STATE"
printf '%s\n' "$*" >>"$S/cosign.log"
case "$*" in
  "verify --certificate-identity-regexp "*" --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/"*)
    exit "$(cat "$S/cosign-exit" 2>/dev/null || echo 0)" ;;
  *) echo "unexpected: cosign $*" >&2; echo "cosign $*" >>"$S/unexpected"; exit 99 ;;
esac
STUB

cat >"$TEMPLATE/sleep" <<'STUB'
#!/usr/bin/env bash
# The health loop sleeps 10 s between polls; the tests do not have that long.
case "$*" in
  10) exit 0 ;;
  *) echo "unexpected: sleep $*" >&2; echo "sleep $*" >>"$STUB_STATE/unexpected"; exit 99 ;;
esac
STUB
chmod +x "$TEMPLATE"/*

# ----- the release list ------------------------------------------------------
# v0.1.0 and v0.2.0 are the real ones, bodies untouched except that v0.2.0 is
# given CRLF line endings (what GitHub stores when notes are edited in the
# browser). The rest are the shapes not published yet.
cat >"$ROOT/mkreleases.py" <<'PY'
import json, sys

real = {r["tag_name"]: r for r in json.load(open(sys.argv[1], encoding="utf-8"))}
mode = sys.argv[2] if len(sys.argv) > 2 else ""

def rel(tag, name, date, body, **extra):
    r = {"tag_name": tag, "name": name, "draft": False, "prerelease": False,
         "created_at": date, "published_at": date, "body": body}
    r.update(extra)
    return r

BODY_04 = """Thumbnails.

~~~
## Upgrading inside tildes
TILDE-FENCED-TEXT
~~~

## Changes

### Upgrading from v0.3.0

Set `THUMBS=1` first:

```bash
# Upgrading now
export THUMBS=1
```

Then deploy.

### Fixed

- NOT-AN-UPGRADE-NOTE
"""

v01 = real["v0.1.0"]
v02 = dict(real["v0.2.0"])
v02["body"] = v02["body"].replace("\n", "\r\n")
v03 = rel("v0.3.0", "v0.3.0", "2026-11-01T10:00:00Z",
          "A quiet one.\n\n## What is new\n\n- Nothing that needs a hand.\n")
v04 = rel("v0.4.0", "v0.4.0: thumbnails", "2026-11-20T10:00:00Z", BODY_04)
draft = rel("v0.5.0", "v0.5.0 — DRAFT-TITLE", "2026-12-01T10:00:00Z",
            "## Upgrading\n\nDRAFT-ONLY-TEXT\n", draft=True, published_at=None)

if mode == "ctrl":
    # What a hostile or merely careless release could send to a terminal.
    v04["name"] = "v0.4.0 — \x1b[31mred\tink\u202e\x9b\x1f!"
    v04["body"] = BODY_04.replace("Then deploy.", "Then \x1b]0;pwned\x07deploy\u2066.")
    v03["name"] = "v0.3.0 - " + "x" * 100
if mode == "big":
    # Past the kernel's 128 KB limit on a single argument or environment string.
    v03["body"] += "\n" + "padding so the list cannot travel as an argument\n" * 6000

out = [draft, v04, v03, v02, v01]
if mode == "semver":
    def up(tag):
        return "## Upgrading\n\nNOTE-FOR-" + tag + ".\n"
    out = [
        rel("v1.0.0", "v1.0.0", "2027-01-04T10:00:00Z", up("v1.0.0")),
        rel("v1.0.0-rc2", "v1.0.0-rc2", "2027-01-02T10:00:00Z", up("v1.0.0-rc2"), prerelease=True),
        rel("v1.0.0-rc10", "v1.0.0-rc10 — last call", "2027-01-03T10:00:00Z", up("v1.0.0-rc10"), prerelease=True),
        rel("v0.9.0", "v0.9.0", "2027-01-01T10:00:00Z", up("v0.9.0")),
    ]
if mode == "none":
    out = []
sys.stdout.buffer.write(json.dumps(out).encode("utf-8"))
PY

# ----- harness ---------------------------------------------------------------
SB=""; ST=""; RC=0; FAILS=""; PASS=0; FAILED=0
EXTRA_ENV=()

# new_sandbox <currently deployed tag> [release-list mode]
new_sandbox() {
  SB="$(mktemp -d "$ROOT/sb.XXXXXX")"; ST="$SB/state"
  mkdir -p "$SB/stub" "$SB/deploy" "$ST/manifests" "$ST/compare" "$ST/http"
  cp "$TEMPLATE"/* "$SB/stub/"
  cp "$FIX/packages.json" "$ST/packages.json"
  python3 "$ROOT/mkreleases.py" "$FIX/releases-real.json" "${2:-}" >"$ST/releases.json"
  echo 200 >"$ST/health"
  local v img
  for v in v0.1.0 v0.2.0 v0.3.0 v0.4.0; do
    for img in ppp-app ppp-migrate; do echo ok >"$ST/manifests/$img:$v"; done
  done
  printf 'PPP_TAG="%s"\nAPP_URL="https://print.example.test"\n' "$1" >"$SB/deploy/.env.docker"
  cp "$SB/deploy/.env.docker" "$SB/env.before"
  : >"$ST/docker.log"; : >"$ST/curl.log"; : >"$ST/cosign.log"
  EXTRA_ENV=()
}

# place <sha> <n>: the commit contains the n oldest of the four releases. This
# writes the answer the compare API would give for each of them.
place() {
  local i=0 v
  for v in v0.1.0 v0.2.0 v0.3.0 v0.4.0; do
    if [ "$i" -lt "$2" ]; then echo ahead; else echo behind; fi >"$ST/compare/$v...$1"
    i=$((i+1))
  done
}

# run <everything typed on stdin> [wizard arguments]
run() {
  local input="$1"; shift
  printf '%s' "$input" | env -i PATH="$SB/stub:$TOOLS" HOME="$SB" STUB_STATE="$ST" \
      PPP_DIR="$SB/deploy" PPP_COMPOSE_FILES="-f docker-compose.prod.yml" \
      PPP_HEALTH_TIMEOUT=30 ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
      timeout 60 bash "$WIZARD" "$@" >"$SB/out" 2>&1
  RC=$?
}

fail()        { FAILS="${FAILS}     $*"$'\n'; }
rc_is()       { [ "$RC" = "$1" ] || fail "exit code $RC, wanted $1"; }
has()         { grep -qF -- "$1" "$SB/out" || fail "output lacks: $1"; }
hasnt()       { if grep -qF -- "$1" "$SB/out"; then fail "output should not have: $1"; fi; }
has_line()    { grep -qxF -- "$1" "$SB/out" || fail "output lacks the exact line: [$1]"; }
count_is()    { local n; n="$(grep -oF -- "$1" "$SB/out" | wc -l)"; [ "$n" -eq "$2" ] || fail "output has '$1' $n time(s), wanted $2"; }
log_has()     { grep -qF -- "$2" "$ST/$1" || fail "$1 lacks: $2"; }
log_hasnt()   { if grep -qF -- "$2" "$ST/$1"; then fail "$1 should not have: $2"; fi; }
log_count()   { local n; n="$(grep -cF -- "$2" "$ST/$1" || true)"; [ "$n" -eq "$3" ] || fail "$1 has '$2' $n time(s), wanted $3"; }
tag_is()      { grep -qxF -- "PPP_TAG=\"$1\"" "$SB/deploy/.env.docker" || fail ".env.docker is not on $1: $(head -1 "$SB/deploy/.env.docker")"; }
env_untouched() { cmp -s "$SB/deploy/.env.docker" "$SB/env.before" || fail ".env.docker changed"; }
not_pulled()  { log_hasnt docker.log " pull"; log_hasnt docker.log " up -d"; }
deployed()    { rc_is 0; log_has docker.log "pull saw PPP_TAG=\"$1\""; log_has docker.log "up saw PPP_TAG=\"$1\""; tag_is "$1"; has "✓ $1 is live and healthy."; }
# in_order a b c: each appears, on a later line than the one before.
in_order() {
  local prev=0 n s
  for s in "$@"; do
    n="$(grep -nF -- "$s" "$SB/out" | head -1 | cut -d: -f1)"
    if [ -z "$n" ]; then fail "output lacks: $s"; return; fi
    [ "$n" -gt "$prev" ] || fail "out of order: $s"
    prev="$n"
  done
}
# The row the menu prints for a tag with nothing in the release column — the
# format the wizard has always used — and the one with a release mark.
plain_row()   { printf ' %s %-3s %-10s %-18s %-8s %s' "$@"; }
marked_row()  { printf ' %s %-3s %-10s %-18s %-8s %-4s  %s' "$@"; }

t() {
  local name="$1"; shift
  FAILS=""; SB=""
  "$@"
  [ -n "$SB" ] && [ -e "$ST/unexpected" ] && fail "a stub refused an unexpected call: $(cat "$ST/unexpected")"
  if [ -z "$FAILS" ]; then
    PASS=$((PASS+1)); echo "ok   $name"
  else
    FAILED=$((FAILED+1)); echo "FAIL $name"; printf '%s' "$FAILS"
    if [ -n "$SB" ] && [ -f "$SB/out" ]; then
      echo "     ---- the wizard's output in the last run ----"
      tail -n 60 "$SB/out" | sed 's/^/     | /'
    fi
  fi
}

REPO_URL="https://api.github.com/repos/danileau/prettypleaseprint"
NOTES_PROMPT="I have read the upgrade notes above. Continue? [y/N]"
BLIND_PROMPT="Continue without having seen them? [y/N]"

# ----- the golden scenario ---------------------------------------------------
# A token, a deployment on one SHA build, a deploy of a newer SHA build, and no
# release between the two: the newest release is contained in both.
golden_run() {
  new_sandbox abc1234
  place abc1234 4; place c0ffee1 4
  EXTRA_ENV=(PPP_WINDOW=3)
  run $'test-token\n1\ny\n'
  sed "s|$SB|<SANDBOX>|g" "$SB/out" >"$SB/out.norm"
}

if [ "${1:-}" = "--capture-golden" ]; then
  dest="${2:?--capture-golden needs a directory}"
  golden_run
  cp "$SB/out.norm" "$dest/golden-sha-to-sha.stdout"
  cp "$ST/docker.log" "$dest/golden-sha-to-sha.docker-log"
  cp "$SB/deploy/.env.docker" "$dest/golden-sha-to-sha.env-docker"
  echo "captured from $WIZARD (exit $RC) into $dest"
  exit 0
fi

# ----- (a) the menu ----------------------------------------------------------
case_01_releases_marked() {
  new_sandbox v0.1.0
  run $'\n' --status
  rc_is 0
  has "releases only (no token given)"
  has_line "$(marked_row '»' 1 v0.4.0 '2026-11-20 10:00' '' - 'release  thumbnails')"
  has_line "$(marked_row ' ' 2 v0.3.0 '2026-11-01 10:00' '' - 'release')"
  has_line "$(marked_row ' ' 3 v0.2.0 '2026-10-04 08:39' '' - 'release  priorities, a catalogue, an API, and no obj…')"
  hasnt "release  v0."
  hasnt "v0.5.0"; hasnt "DRAFT-TITLE"
  log_count curl.log "/releases?per_page=100" 1
  log_count curl.log "api.github.com" 1
}

case_02_token_menu() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  run "" --status
  rc_is 0
  has "every published image"
  has_line "$(plain_row '»' 1 c0ffee1 '2026-12-03 09:00' latest -)"
  has_line "$(plain_row ' ' 3 abc1234 '2026-12-01 09:00' '' LIVE)"
  has_line "$(marked_row ' ' 4 v0.4.0 '2026-11-20 10:00' '' - 'release  thumbnails')"
  has_line "$(marked_row ' ' 6 v0.2.5 '2026-10-20 10:00' '' - 'tagged, not released')"
  has_line "$(plain_row ' ' 8 9539af6 '2026-10-03 20:00' '' -)"
  hasnt ".sig"; hasnt ".att"
  log_has curl.log "auth $REPO_URL/releases?per_page=100"
}

case_03_titles_unavailable() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  echo 500 >"$ST/http/releases"
  run "" --status
  rc_is 0
  has "release titles unavailable (could not read the releases list)"
  has_line "$(plain_row '»' 1 c0ffee1 '2026-12-03 09:00' latest -)"
  # With no release list, a version tag is not called "not released" — the
  # wizard does not know.
  has_line "$(plain_row ' ' 4 v0.4.0 '2026-11-20 10:00' '' -)"
  hasnt "tagged, not released"
}

case_04_empty_moving_column() {
  # `moving` is empty on every release row. Had the fields been tab-separated,
  # `read` would have collapsed the empty one and put "release" under `moving`.
  new_sandbox v0.1.0
  run $'\n' --status
  has_line "$(marked_row ' ' 4 v0.1.0 '2026-08-23 18:14' '' LIVE 'release  invite-only 3D print requests, self-hostable')"
}

case_05_control_characters() {
  new_sandbox v0.1.0 ctrl
  run $'\n1\nn\n'
  rc_is 0
  has "release  [31mredink!"
  # 44 characters in the menu: 43 of the title and the ellipsis.
  has_line "$(marked_row ' ' 2 v0.3.0 '2026-11-01 10:00' '' - 'release  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…')"
  has "│ Then ]0;pwneddeploy."
  # stdout is not a terminal here, so the wizard prints no colour of its own:
  # any control byte in the output came from GitHub.
  local n
  n="$(LC_ALL=C tr -d '\11\12\40-\176\200-\377' <"$SB/out" | wc -c)"
  [ "$n" -eq 0 ] || fail "$n C0 control byte(s) reached the output"
  n="$(python3 -c 'import re,sys; print(len(re.findall("[\u0080-\u009f\u202a-\u202e\u2066-\u2069]", open(sys.argv[1], encoding="utf-8").read())))' "$SB/out")"
  [ "$n" -eq 0 ] || fail "$n C1 or bidi control character(s) reached the output"
}

case_06_status_is_read_only() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4
  run "" --status
  rc_is 0
  has "Deployable"
  log_hasnt docker.log "manifest"
  log_hasnt curl.log "/compare/"
  hasnt "[y/N]"
  not_pulled; env_untouched
}

# ----- (c) is it published? --------------------------------------------------
case_07_unpublished_refused() {
  new_sandbox v0.1.0
  echo unknown >"$ST/manifests/ppp-migrate:v0.4.0"
  run $'\n1\ny\ny\n'
  rc_is 1
  has "✗ v0.4.0 is not fully published yet — missing: ppp-migrate:v0.4.0"
  has "A version tag exists a few minutes before its images do. Wait for the build:"
  has "https://github.com/danileau/prettypleaseprint/actions/workflows/release-images.yml"
  has "then run the wizard again. Nothing was changed."
  hasnt "[y/N]"; hasnt "Upgrade notes"
  log_has docker.log "manifest inspect ghcr.io/danileau/ppp-app:v0.4.0"
  not_pulled; env_untouched
  log_hasnt docker.log "login"
}

case_08_published_proceeds() {
  new_sandbox v0.1.0
  run $'\n1\ny\ny\n'
  deployed v0.4.0
  log_count docker.log "manifest inspect" 2
  log_has docker.log "manifest inspect ghcr.io/danileau/ppp-migrate:v0.4.0"
  hasnt "could not check"
}

case_09_denied_is_not_missing() {
  new_sandbox v0.1.0
  echo denied >"$ST/manifests/ppp-app:v0.4.0"
  run $'\n1\ny\ny\n'
  has 'could not check whether ppp-app:v0.4.0 is published (Get "https://ghcr.io/v2/danileau/ppp-app:v0.4.0": denied) — the pull will tell.'
  count_is "[y/N]" 2
  deployed v0.4.0
}

case_10_sha_target_makes_no_manifest_call() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4; place c0ffee1 4
  run $'1\ny\n'
  deployed c0ffee1
  log_hasnt docker.log "manifest"
}

# ----- (b) upgrade notes -----------------------------------------------------
notes_v01_to_v04() {
  has "Upgrade notes — v0.1.0 → v0.4.0 crosses 3 release(s):"
  in_order "  v0.2.0 — priorities, a catalogue, an API, and no object store  (2026-10-04)" \
           "    │ Upgrading from v0.1.0" \
           "    │ 1. **Snapshot** the data directory." \
           "    │ 3. **Deploy** with \`PPP_TAG=v0.2.0\`. Eleven database migrations run by themselves." \
           "    │ There is no rolling back to v0.1.0 afterwards except from the snapshot." \
           "  v0.3.0  (2026-11-01)" \
           "    │ (no upgrade notes)" \
           "  v0.4.0 — thumbnails  (2026-11-20)" \
           "    │ Upgrading from v0.3.0" \
           "    │ # Upgrading now" \
           "    │ export THUMBS=1" \
           "    │ Then deploy." \
           "All release notes: https://github.com/danileau/prettypleaseprint/releases" \
           "$NOTES_PROMPT"
  # Nothing outside an Upgrading section, nothing a fence was hiding, nothing
  # from a draft.
  hasnt "Owner-managed materials"; hasnt "Ten suites"
  hasnt "NOT-AN-UPGRADE-NOTE"; hasnt "TILDE-FENCED-TEXT"; hasnt "DRAFT-ONLY-TEXT"
  count_is $'\r' 0
}

case_11_notes_shown_and_n_aborts() {
  new_sandbox v0.1.0
  run $'\n1\nn\n'
  notes_v01_to_v04
  rc_is 0; has "aborted."
  hasnt "Deploy v0.4.0"
  not_pulled; env_untouched
  log_hasnt curl.log "/compare/"
}

case_11b_notes_then_y_reaches_the_deploy_prompt() {
  new_sandbox v0.1.0
  run $'\n1\ny\nn\n'
  notes_v01_to_v04
  in_order "$NOTES_PROMPT" "Deploy v0.4.0 (replacing v0.1.0)? [y/N] aborted."
  rc_is 0; not_pulled; env_untouched
}

case_11c_the_published_release_as_it_is() {
  # The release list exactly as GitHub serves it today, no synthetic entries.
  new_sandbox v0.1.0
  cp "$FIX/releases-real.json" "$ST/releases.json"
  run $'\n1\ny\ny\n'
  in_order "Upgrade notes — v0.1.0 → v0.2.0 crosses 1 release(s):" \
           "  v0.2.0 — priorities, a catalogue, an API, and no object store  (2026-10-04)" \
           "    │ Upgrading from v0.1.0" \
           "    │ 2. **Move the models out of MinIO first**" \
           "    │ There is no rolling back to v0.1.0 afterwards except from the snapshot." \
           "$NOTES_PROMPT"
  hasnt "Ten suites"; hasnt "This is not a drop-in upgrade"
  deployed v0.2.0
}

case_12_no_notes_no_prompt() {
  new_sandbox v0.2.0
  run $'\n2\nn\n'
  has "No upgrade notes in the 1 release(s) between v0.2.0 and v0.3.0."
  count_is "[y/N]" 1
  has "Deploy v0.3.0 (replacing v0.2.0)? [y/N]"
  rc_is 0; not_pulled
}

case_13_sha_to_sha_matches_the_golden_transcript() {
  golden_run
  # The table header is the one line allowed to differ: it gained a column.
  local golden="$FIX/golden-sha-to-sha.stdout"
  grep -v '^   *#   tag ' "$SB/out.norm" >"$SB/now.txt"
  grep -v '^   *#   tag ' "$golden" >"$SB/then.txt"
  [ "$(wc -l <"$SB/then.txt")" -eq "$(( $(wc -l <"$golden") - 1 ))" ] \
    || fail "the header filter did not remove exactly one line of the golden transcript"
  cmp -s "$SB/now.txt" "$SB/then.txt" \
    || fail "stdout differs from the golden transcript:"$'\n'"$(diff "$SB/then.txt" "$SB/now.txt" | sed 's/^/       /')"
  cmp -s "$ST/docker.log" "$FIX/golden-sha-to-sha.docker-log" \
    || fail "docker calls differ from the golden log:"$'\n'"$(diff "$FIX/golden-sha-to-sha.docker-log" "$ST/docker.log" | sed 's/^/       /')"
  cmp -s "$SB/deploy/.env.docker" "$FIX/golden-sha-to-sha.env-docker" \
    || fail ".env.docker differs from the golden one"
  rc_is 0
  count_is "[y/N]" 1
  # It did look: the notes step placed both SHAs before deciding to say nothing.
  log_has curl.log "/compare/v0.4.0...abc1234?per_page=1&page=2"
  log_has curl.log "/compare/v0.4.0...c0ffee1?per_page=1&page=2"
}

case_14_sha_behind_a_release_then_that_release() {
  new_sandbox 9539af6; EXTRA_ENV=(PPP_TOKEN=test-token)
  place 9539af6 1
  run $'7\ny\nn\n'
  in_order "Upgrade notes — 9539af6 → v0.2.0 crosses 1 release(s):" "    │ Upgrading from v0.1.0" "$NOTES_PROMPT" "Deploy v0.2.0"
  hasnt "v0.3.0  ("
  # Binary search: two questions for four releases, not four.
  log_count curl.log "/compare/" 2
}

case_15_sha_to_sha_across_releases() {
  new_sandbox beefed2; EXTRA_ENV=(PPP_TOKEN=test-token)
  place beefed2 2; place c0ffee1 4
  run $'1\nn\n'
  in_order "Upgrade notes — beefed2 → c0ffee1 crosses 2 release(s):" "  v0.3.0  (2026-11-01)" \
           "    │ (no upgrade notes)" "  v0.4.0 — thumbnails" "    │ Upgrading from v0.3.0" "$NOTES_PROMPT"
  hasnt "v0.2.0 —"
  rc_is 0; not_pulled
}

case_16_diverged_from_the_newest() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 3; echo diverged >"$ST/compare/v0.4.0...abc1234"
  run $'4\nn\n'
  in_order "Upgrade notes — abc1234 → v0.4.0 crosses 1 release(s):" "  v0.4.0 — thumbnails" "$NOTES_PROMPT"
  hasnt "v0.3.0  ("
}

case_16b_identical_counts_as_contained() {
  new_sandbox d4d4d4d; EXTRA_ENV=(PPP_TOKEN=test-token)
  place d4d4d4d 4; echo identical >"$ST/compare/v0.4.0...d4d4d4d"
  place c0ffee1 4
  run $'1\nn\n'
  hasnt "pgrade notes"
  count_is "[y/N]" 1
  has "Deploy c0ffee1 (replacing d4d4d4d)? [y/N]"
}

case_17_sha_older_than_every_release() {
  new_sandbox 0000aaa; EXTRA_ENV=(PPP_TOKEN=test-token)
  place 0000aaa 0
  run $'9\nn\n'
  has "No upgrade notes in the 1 release(s) between 0000aaa and v0.1.0."
  count_is "[y/N]" 1
}

undetermined() {  # <current> <target> <reason>
  in_order "⚠ could not work out which releases lie between $1 and $2: $3." \
           "Upgrade notes were NOT shown. Read them before continuing:" \
           "https://github.com/danileau/prettypleaseprint/releases" \
           "$BLIND_PROMPT"
  hasnt "$NOTES_PROMPT"
}

case_18_compare_fails_n_aborts() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4; echo 404 >"$ST/compare/v0.2.0...abc1234"; place c0ffee1 4
  run $'1\nn\n'
  undetermined abc1234 c0ffee1 "GitHub could not place abc1234 relative to v0.2.0"
  rc_is 0; has "aborted."; hasnt "Deploy c0ffee1"
  not_pulled; env_untouched
}

case_18b_compare_fails_y_continues() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4; echo nostatus >"$ST/compare/v0.2.0...abc1234"; place c0ffee1 4
  run $'1\ny\ny\n'
  undetermined abc1234 c0ffee1 "GitHub could not place abc1234 relative to v0.2.0"
  in_order "$BLIND_PROMPT" "Deploy c0ffee1 (replacing abc1234)? [y/N]"
  deployed c0ffee1
}

case_18c_rate_limit_is_named() {
  new_sandbox abc1234
  place abc1234 4; echo 403 >"$ST/compare/v0.2.0...abc1234"
  run $'\n1\nn\n'
  undetermined abc1234 v0.4.0 "GitHub rate limit reached (60 requests an hour without a token)"
  rc_is 0; not_pulled
}

case_19_latest_is_undetermined() {
  new_sandbox latest
  run $'\n1\nn\n'
  undetermined latest v0.4.0 "latest is neither a version nor a commit SHA"
  rc_is 0; not_pulled
  log_hasnt curl.log "/compare/"
}

case_20_no_release_list_is_undetermined() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  echo 500 >"$ST/http/releases"
  run $'1\nn\n'
  undetermined abc1234 c0ffee1 "could not read the release list from GitHub"
  rc_is 0; not_pulled
}

case_20b_version_without_a_release_is_undetermined() {
  new_sandbox v0.2.0; EXTRA_ENV=(PPP_TOKEN=test-token)
  echo ok >"$ST/manifests/ppp-app:v0.2.5"; echo ok >"$ST/manifests/ppp-migrate:v0.2.5"
  run $'6\nn\n'
  undetermined v0.2.0 v0.2.5 "v0.2.5 has no published GitHub release"
  rc_is 0; not_pulled
}

case_20c_no_releases_at_all_says_nothing() {
  new_sandbox abc1234 none; EXTRA_ENV=(PPP_TOKEN=test-token)
  run $'1\nn\n'
  hasnt "pgrade notes"; hasnt "could not work out"
  count_is "[y/N]" 1
  log_hasnt curl.log "/compare/"
}

case_21_rollback() {
  new_sandbox v0.4.0
  run $'\n4\nn\n'
  in_order "Going BACK from v0.4.0 to v0.1.0 undoes 3 release(s). Their upgrade notes say what they changed and whether there is a way back:" \
           "  v0.2.0 — priorities" "    │ Upgrading from v0.1.0" "  v0.3.0  (2026-11-01)" \
           "  v0.4.0 — thumbnails" "    │ Upgrading from v0.3.0" "$NOTES_PROMPT"
  hasnt "Upgrade notes —"
  rc_is 0; has "aborted."; not_pulled
}

case_22_redeploy_asks_nothing_new() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  run $'3\ny\n'
  has "note: abc1234 is already live — this is a redeploy."
  has "Redeploy abc1234? [y/N]"
  count_is "[y/N]" 1
  hasnt "pgrade notes"
  log_hasnt curl.log "/compare/"
  deployed abc1234
}

case_23_compare_retries_without_the_token() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4; place c0ffee1 4
  # A packages-only token is refused by the repository API.
  echo 401 >"$ST/http/compare-v0.2.0...abc1234.auth"
  run $'1\ny\n'
  log_has curl.log "auth $REPO_URL/compare/v0.2.0...abc1234?per_page=1&page=2"
  log_has curl.log "anon $REPO_URL/compare/v0.2.0...abc1234?per_page=1&page=2"
  log_has curl.log "auth $REPO_URL/compare/v0.3.0...abc1234?per_page=1&page=2"
  log_hasnt curl.log "anon $REPO_URL/compare/v0.3.0...abc1234"
  hasnt "could not work out"
  count_is "[y/N]" 1
  deployed c0ffee1
}

no_input() { rc_is 1; has "aborted (no input)."; not_pulled; env_untouched; }

case_24_eof_at_the_token_prompt_means_no_token() {
  new_sandbox v0.1.0
  run "" --status
  rc_is 0
  has "releases only (no token given)"
  has "release  thumbnails"
}
case_24b_eof_at_the_menu()         { new_sandbox v0.1.0; run $'\n';         has "> "; hasnt "[y/N]"; no_input; }
case_24c_eof_at_the_notes_prompt() { new_sandbox v0.1.0; run $'\n1\n';      has "$NOTES_PROMPT"; hasnt "Deploy v0.4.0"; no_input; }
case_24d_eof_at_the_deploy_prompt(){ new_sandbox v0.1.0; run $'\n1\ny\n';   has "Deploy v0.4.0 (replacing v0.1.0)? [y/N]"; no_input; }
case_24e_eof_at_the_cosign_prompt() {
  new_sandbox v0.1.0; rm "$SB/stub/cosign"
  run $'\n1\ny\ny\n'
  has "Continue without verification? [y/N]"; no_input
}
case_24f_eof_at_the_blind_prompt() { new_sandbox latest; run $'\n1\n'; has "$BLIND_PROMPT"; no_input; }
case_24g_eof_at_the_unhealthy_prompt() {
  new_sandbox v0.1.0; echo 503 >"$ST/health"
  run $'\n1\ny\n'
  has "Deploy anyway? [y/N]"; no_input
}
case_24h_an_explicit_no_is_not_a_failure() {
  new_sandbox v0.1.0; rm "$SB/stub/cosign"
  run $'\n1\ny\ny\nn\n'
  has "Continue without verification? [y/N]"
  rc_is 0; has "aborted."; hasnt "aborted (no input)."; not_pulled; env_untouched
}
case_24i_a_last_line_without_a_newline_counts() {
  new_sandbox v0.1.0
  run $'\n1\ny\ny'
  deployed v0.4.0
}

case_25_a_release_list_too_big_for_an_argument() {
  new_sandbox v0.1.0 big
  [ "$(wc -c <"$ST/releases.json")" -gt 200000 ] || fail "the fixture is not over 200 KB"
  run $'\n1\nn\n'
  has "release  thumbnails"
  notes_v01_to_v04
  rc_is 0
}

# ----- what must not have changed --------------------------------------------
case_26_unhealthy_swap_rolls_back() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token PPP_HEALTH_TIMEOUT=1)
  place abc1234 4; place c0ffee1 4
  echo 500 >"$ST/health-after-up-1"; echo 200 >"$ST/health-after-up-2"
  run $'1\ny\n'
  rc_is 1
  has "✗ health did not stabilise — rolling back to abc1234."
  has "⚠ rolled back to abc1234, which is healthy again."
  log_has docker.log "up saw PPP_TAG=\"c0ffee1\""
  log_has docker.log "up saw PPP_TAG=\"abc1234\""
  log_count docker.log " up -d" 2
  log_has docker.log "logout ghcr.io"
  tag_is abc1234
}

case_26b_failed_pull_restores_the_tag() {
  new_sandbox abc1234; EXTRA_ENV=(PPP_TOKEN=test-token)
  place abc1234 4; place c0ffee1 4
  echo 1 >"$ST/pull-exit"
  run $'1\ny\n'
  rc_is 1
  has "✗ pull failed — .env.docker restored to abc1234, nothing was restarted"
  log_has docker.log "pull saw PPP_TAG=\"c0ffee1\""
  log_hasnt docker.log " up -d"
  log_has docker.log "login ghcr.io -u danileau --password-stdin"
  log_has docker.log "logout ghcr.io"
  env_untouched
}

case_26c_a_bad_signature_still_refuses() {
  new_sandbox v0.1.0; echo 1 >"$ST/cosign-exit"
  run $'\n1\ny\ny\n'
  rc_is 1
  has "✗ ppp-app:v0.4.0 failed signature verification — refusing to deploy."
  not_pulled; env_untouched
}

case_27_prereleases_sort_below_their_release() {
  new_sandbox v0.9.0 semver
  for tag in v1.0.0 v1.0.0-rc10 v1.0.0-rc2; do
    echo ok >"$ST/manifests/ppp-app:$tag"; echo ok >"$ST/manifests/ppp-migrate:$tag"
  done
  # Menu, newest first: 1 v1.0.0, 2 v1.0.0-rc10, 3 v1.0.0-rc2, 4 v0.9.0.
  run $'\n2\nn\n'
  has_line "$(marked_row ' ' 2 v1.0.0-rc10 '2027-01-03 10:00' '' - 'pre-release  last call')"
  has_line "$(marked_row ' ' 3 v1.0.0-rc2 '2027-01-02 10:00' '' - 'pre-release')"
  # rc2 < rc10 < the release itself: natural order, not alphabetical.
  in_order "Upgrade notes — v0.9.0 → v1.0.0-rc10 crosses 2 release(s):" \
           "    │ NOTE-FOR-v1.0.0-rc2." "    │ NOTE-FOR-v1.0.0-rc10." "$NOTES_PROMPT"
  hasnt "NOTE-FOR-v1.0.0."; hasnt "NOTE-FOR-v0.9.0."
}

t "01 no token: releases are marked with their title, the draft is absent, one request" case_01_releases_marked
t "02 token: SHA rows unmarked, releases titled, an unreleased tag says so, no .sig/.att" case_02_token_menu
t "03 token, release list unreadable: the menu still works and says titles are unavailable" case_03_titles_unavailable
t "04 an empty 'moving' column does not shift the title left" case_04_empty_moving_column
t "05 control characters from GitHub never reach the terminal; long titles are cut" case_05_control_characters
t "06 --status makes no manifest or compare call and changes nothing" case_06_status_is_read_only
t "07 a version with an unpublished image is refused before any pull" case_07_unpublished_refused
t "08 a fully published version deploys" case_08_published_proceeds
t "09 'denied' is unknown, not missing: one dim line, no extra prompt" case_09_denied_is_not_missing
t "10 a SHA target makes no manifest call" case_10_sha_target_makes_no_manifest_call
t "11 v0.1.0 to v0.4.0 shows the notes in order; n aborts before any pull" case_11_notes_shown_and_n_aborts
t "11b after y at the notes, the usual Deploy prompt follows" case_11b_notes_then_y_reaches_the_deploy_prompt
t "11c the release list exactly as published: v0.1.0 to v0.2.0" case_11c_the_published_release_as_it_is
t "12 releases crossed but none has notes: one line, no extra prompt" case_12_no_notes_no_prompt
t "13 SHA to SHA, no release crossed: same transcript, docker calls and .env.docker as before" case_13_sha_to_sha_matches_the_golden_transcript
t "14 a SHA behind v0.2.0, deploying v0.2.0: its notes" case_14_sha_behind_a_release_then_that_release
t "15 SHA to SHA across two releases" case_15_sha_to_sha_across_releases
t "16 a SHA diverged from the newest release is based on the older one" case_16_diverged_from_the_newest
t "16b a SHA identical to a release contains it" case_16b_identical_counts_as_contained
t "17 a SHA older than every release, deploying the first" case_17_sha_older_than_every_release
t "18 compare fails: says it could not tell, and n aborts before any pull" case_18_compare_fails_n_aborts
t "18b compare answers without a status: asks, and y continues to the deploy" case_18b_compare_fails_y_continues
t "18c a 403 from compare is reported as the rate limit" case_18c_rate_limit_is_named
t "19 PPP_TAG=latest: neither a version nor a SHA, so it asks" case_19_latest_is_undetermined
t "20 token, release list unreadable: it asks" case_20_no_release_list_is_undetermined
t "20b a version tag with no published release: it asks" case_20b_version_without_a_release_is_undetermined
t "20c a repository with no releases at all: nothing shown, nothing asked" case_20c_no_releases_at_all_says_nothing
t "21 a rollback shows the same notes under 'Going BACK'" case_21_rollback
t "22 a redeploy makes no compare call and adds no prompt" case_22_redeploy_asks_nothing_new
t "23 compare is sent with the token and retried without it" case_23_compare_retries_without_the_token
t "24 EOF at the token prompt means no token" case_24_eof_at_the_token_prompt_means_no_token
t "24b EOF at the menu: aborted (no input), exit 1" case_24b_eof_at_the_menu
t "24c EOF at the notes prompt" case_24c_eof_at_the_notes_prompt
t "24d EOF at the deploy prompt" case_24d_eof_at_the_deploy_prompt
t "24e EOF at the cosign prompt" case_24e_eof_at_the_cosign_prompt
t "24f EOF at the 'without having seen them' prompt" case_24f_eof_at_the_blind_prompt
t "24g EOF at the 'Deploy anyway' prompt" case_24g_eof_at_the_unhealthy_prompt
t "24h an explicit n prints 'aborted.' and exits 0" case_24h_an_explicit_no_is_not_a_failure
t "24i a final answer with no newline is still an answer" case_24i_a_last_line_without_a_newline_counts
t "25 a release list over 200 KB still works" case_25_a_release_list_too_big_for_an_argument
t "26 an unhealthy swap still rolls back" case_26_unhealthy_swap_rolls_back
t "26b a failed pull still restores the tag and logs out" case_26b_failed_pull_restores_the_tag
t "26c a bad signature still refuses" case_26c_a_bad_signature_still_refuses
t "27 pre-releases are marked, and rc2 < rc10 < the release" case_27_prereleases_sort_below_their_release

echo
echo "$PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

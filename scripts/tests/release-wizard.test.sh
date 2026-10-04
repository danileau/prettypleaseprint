#!/usr/bin/env bash
#
# Tests for scripts/release-wizard.sh.     bash scripts/tests/release-wizard.test.sh
#
# No network, no GitHub and no docker. Every case runs the real script in a
# sandbox under one temp directory: a bare repository stands in for the remote,
# a clone of it for the developer's checkout, and `gh`, `docker` and `sleep`
# are stubs that answer from files and write what they were asked to a log.
# git, npm and python3 are real.
#
# The wizard's PATH is exactly two directories — the stubs, and symlinks to an
# allow-list of real tools. /usr/bin and /bin are deliberately NOT on it: the
# real, authenticated gh and docker live there, and a test that reached them
# would be operating on the real repository. A stub that is asked for
# something it was not told to expect logs UNEXPECTED and exits 99, and the
# last case fails if that ever happened.
#
# PPP_TEST_SCRIPT points the suite at another copy of the script, which is how
# a deliberately broken one is shown to fail.

set -uo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
FIX="$HERE/fixtures/release"
WIZARD="${PPP_TEST_SCRIPT:-$REPO_ROOT/scripts/release-wizard.sh}"

BASE="$(mktemp -d "${TMPDIR:-/tmp}/ppp-release-test.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

# ----- the two PATH directories ------------------------------------------------
ALLOW="bash sh env git node npm python3 sed awk grep sort tail head cat cp mv rm
  mkdir mktemp date diff tr cut wc printf chmod touch ls dirname basename readlink
  timeout tee cmp stat id find xargs uname true false kill"
mkdir -p "$BASE/bin" "$BASE/stubs" "$BASE/stubs-nogh" "$BASE/helpers"
for tool in $ALLOW; do
  p="$(type -P "$tool")" || { echo "cannot run: $tool is not installed" >&2; exit 1; }
  ln -s "$p" "$BASE/bin/$tool"
done

cat >"$BASE/stubs/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$STUB/log"
S="$STUB/state"
arg() { # arg --flag "$@" — the value after --flag
  local want=$1; shift
  while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "${2:-}"; return 0; }; shift; done
}
case "${1:-} ${2:-}" in
  "auth status") [ ! -e "$S/no-auth" ] || exit 1; exit 0 ;;
  "repo view") cat "$S/repo.json"; exit 0 ;;
  "pr list")
    case " $* " in
      *" --head "*) if [ -f "$S/pr-list.json" ]; then cat "$S/pr-list.json"; else echo "[]"; fi ;;
      *) if [ -f "$S/pr-open.json" ]; then cat "$S/pr-open.json"; else echo "[]"; fi ;;
    esac
    exit 0 ;;
  "pr create")
    [ ! -e "$S/pr-create-fail" ] || { rm -f "$S/pr-create-fail"; echo "pull request create failed" >&2; exit 1; }
    head="$(arg --head "$@")"
    cp "$(arg --body-file "$@")" "$S/pr-body"
    oid="$(git --git-dir="$STUB/../remote.git" rev-parse "refs/heads/$head")" || exit 1
    printf '[{"number":7,"state":"OPEN","url":"https://github.invalid/pull/7","mergeCommit":null,"headRefOid":"%s","baseRefName":"main","isCrossRepository":false}]\n' "$oid" >"$S/pr-list.json"
    echo "https://github.invalid/pull/7"
    exit 0 ;;
  "release view")
    [ -f "$S/release-$3.json" ] || { echo "release not found" >&2; exit 1; }
    cat "$S/release-$3.json"; exit 0 ;;
  "release create")
    cp "$(arg --notes-file "$@")" "$S/notes-captured"
    arg --title "$@" >"$S/title-captured"
    printf '{"name":"%s","isDraft":false,"tagName":"%s"}\n' "$3" "$3" >"$S/release-$3.json"
    exit 0 ;;
  "run list")
    f="$S/runs-$(arg --workflow "$@").json"
    if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi
    exit 0 ;;
esac
echo "unexpected: gh $*" >&2
printf 'UNEXPECTED gh %s\n' "$*" >>"$STUB/log"
exit 99
STUB

cat >"$BASE/stubs/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$STUB/log"
if [ "${1:-} ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  if grep -qxF "$4" "$STUB/state/images" 2>/dev/null; then
    echo '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"sha256:0123abcd","size":1609}'
    exit 0
  fi
  echo "ERROR: $4: not found" >&2
  exit 1
fi
echo "unexpected: docker $*" >&2
printf 'UNEXPECTED docker %s\n' "$*" >>"$STUB/log"
exit 99
STUB

# Never sleeps. Counts the calls and runs the sandbox's on-sleep hook, which is
# how a test makes "the owner merges" or "the image appears" happen after a
# given number of polls.
cat >"$BASE/stubs/sleep" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STUB/sleeps" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$STUB/sleeps"
if [ -x "$STUB/on-sleep" ]; then "$STUB/on-sleep" "$n"; fi
exit 0
STUB

# What the owner does in the browser: squash-merge the release branch into
# main, and tell the gh stub. "later" adds a commit on top afterwards, so the
# merge commit is no longer the tip of main; "moved" lands one first, so the
# merged tree is not the tested one.
cat >"$BASE/helpers/merge-pr" <<'STUB'
#!/usr/bin/env bash
set -e
T="$(cd "$STUB/.." && pwd)"
branch="${MERGE_BRANCH:-release-0.2.0}"
rm -rf "$T/merger"
git clone -q "$T/remote.git" "$T/merger"
cd "$T/merger"
git config user.name "The Owner"; git config user.email "owner@example.test"
case " $* " in *" moved "*)
  echo "moved" >moved.txt; git add moved.txt; git commit -q -m "Something else first (#6)" ;;
esac
head="$(git rev-parse "origin/$branch")"
git merge -q --squash "origin/$branch" >/dev/null
git commit -q -m "Prepare v${branch#release-} (#7)"
oid="$(git rev-parse HEAD)"
case " $* " in *" later "*)
  echo "later" >later.txt; git add later.txt; git commit -q -m "Something later (#8)" ;;
esac
git push -q origin main
printf '[{"number":7,"state":"MERGED","url":"https://github.invalid/pull/7","mergeCommit":{"oid":"%s"},"headRefOid":"%s","baseRefName":"main","isCrossRepository":false}]\n' "$oid" "$head" >"$STUB/state/pr-list.json"
STUB

# An editor that does the one thing asked of a person: deletes the TODO line.
cat >"$BASE/stubs/fix-todo" <<'STUB'
#!/usr/bin/env bash
printf 'fix-todo %s\n' "$*" >>"$STUB/log"
for f in "$@"; do :; done
sed -i '/TODO(release)/d' "$f"
STUB
# An editor that throws the notes away.
cat >"$BASE/stubs/gut-notes" <<'STUB'
#!/usr/bin/env bash
echo "Short and useless." >"$1"
STUB
# Stand-ins for the full test that leave something behind.
cat >"$BASE/stubs/leave-stray" <<'STUB'
#!/usr/bin/env bash
echo "edited during the test" >>docs/other.txt
STUB
cat >"$BASE/stubs/leave-stray-space" <<'STUB'
#!/usr/bin/env bash
echo "edited during the test" >>"docs/other file.txt"
STUB
cat >"$BASE/stubs/leave-untracked" <<'STUB'
#!/usr/bin/env bash
echo "scratch" >scratch.txt
STUB
chmod +x "$BASE"/stubs/* "$BASE"/helpers/*
cp -p "$BASE/stubs/docker" "$BASE/stubs/sleep" "$BASE/stubs/fix-todo" "$BASE/stubs-nogh/"

# ----- the template sandbox ----------------------------------------------------
# Built once and copied per case: a remote with v0.1.0 tagged and one commit of
# unreleased work on top, and a clone of it.
TPL="$BASE/template"
mkdir -p "$TPL"
git init -q --bare -b main "$TPL/remote.git"
git init -q -b main "$TPL/work"
(
  cd "$TPL/work" || exit 1
  git config user.name "A Developer"; git config user.email "dev@example.test"
  mkdir -p docs scripts .github/workflows prisma/migrations/20260801000000_init
  cp "$FIX/readme.txt" README.md
  cp "$FIX/deployment.txt" docs/deployment.md
  echo "another tracked file" >docs/other.txt
  echo "a tracked file with a space in its name" >"docs/other file.txt"
  echo "CREATE TABLE t (id int);" >prisma/migrations/20260801000000_init/migration.sql
  cp "$REPO_ROOT/.github/workflows/release-images.yml" .github/workflows/release-images.yml
  cp "$WIZARD" scripts/release-wizard.sh
  # The full test, as the wizard sees it: something that is called and answers.
  cat >scripts/full-test.sh <<'FT'
#!/usr/bin/env bash
printf 'full-test %s\n' "$*" >>"$STUB/log"
case "$*" in
  "") exit 0 ;;
  "--preflight")
    [ ! -e "$STUB/state/preflight-fail" ] || { echo "✗ a ppp stack already exists on this machine:" >&2; exit 1; }
    exit 0 ;;
esac
echo "unexpected: full-test $*" >&2
printf 'UNEXPECTED full-test %s\n' "$*" >>"$STUB/log"
exit 99
FT
  chmod +x scripts/release-wizard.sh scripts/full-test.sh
  printf '{\n  "name": "fixture",\n  "version": "0.1.0",\n  "private": true\n}\n' >package.json
  printf '{\n  "name": "fixture",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "fixture",\n      "version": "0.1.0"\n    }\n  }\n}\n' >package-lock.json
  sed 's/^A fixture release.*/Nothing yet./; /^\[an absolute link\]/d; /^### Added$/,/^## v0.1.0$/{/^## v0.1.0$/!d}' \
    "$FIX/changelog.txt" >CHANGELOG.md
  git add -A; git commit -q -m "The first release"
  git tag -a v0.1.0 -m v0.1.0
  cp "$FIX/changelog.txt" CHANGELOG.md
  git add -A; git commit -q -m "Add a thing (#2)"
  git remote add origin "$TPL/remote.git"
  git push -q -u origin main v0.1.0
) || { echo "could not build the template sandbox" >&2; exit 1; }

# ----- per-case sandbox -------------------------------------------------------
T=""; N=0
new_sandbox() {
  [ -z "$T" ] || cat "$T/stub/log" >>"$BASE/all-logs" 2>/dev/null
  N=$((N + 1)); T="$BASE/s$N"
  cp -a "$TPL" "$T"
  git -C "$T/work" remote set-url origin "$T/remote.git"
  mkdir -p "$T/stub/state" "$T/home" "$T/tmp"
  : >"$T/stub/log"
  echo '{"nameWithOwner":"octo/widgets"}' >"$T/stub/state/repo.json"
  printf '%s\n' ghcr.io/octo/ppp-app:v0.2.0 ghcr.io/octo/ppp-migrate:v0.2.0 \
    ghcr.io/octo/ppp-storage-migrate:v0.2.0 >"$T/stub/state/images"
  echo '[{"status":"completed","conclusion":"success","url":"https://github.invalid/runs/1","createdAt":"2026-11-01T10:00:00Z"}]' \
    >"$T/stub/state/runs-ci.yml.json"
  echo '[{"status":"completed","conclusion":"success","headBranch":"v0.2.0","event":"push","url":"https://github.invalid/runs/2","createdAt":"2026-11-01T10:05:00Z"},
         {"status":"completed","conclusion":"success","headBranch":"main","event":"push","url":"https://github.invalid/runs/3","createdAt":"2026-11-01T10:06:00Z"}]' \
    >"$T/stub/state/runs-release-images.yml.json"
  on_sleep 'if [ "$1" -ge 2 ] && [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; fi'
  STUBS="$BASE/stubs"; SEAM="true"; EXTRA=()
  MAIN0="$(git -C "$T/remote.git" rev-parse main)"
}
# on_sleep '<bash>' — what happens on each poll; $1 is the number of the sleep.
on_sleep() {
  printf '#!/usr/bin/env bash\nHELPERS=%q\n%s\nexit 0\n' "$BASE/helpers" "$1" >"$T/stub/on-sleep"
  chmod +x "$T/stub/on-sleep"
}
# Emptying the log mid-case must not lose an UNEXPECTED line: what is there
# goes to the collected log first, which the last case reads.
clear_log() { cat "$T/stub/log" >>"$BASE/all-logs"; : >"$T/stub/log"; }
# Go back to an earlier sandbox, keeping the log of the one being left.
use_sandbox() { cat "$T/stub/log" >>"$BASE/all-logs" 2>/dev/null; T="$1"; STUBS="$BASE/stubs"; SEAM="true"; EXTRA=(); }

# wiz '<stdin>' [args…] — run the wizard; the transcript lands in $OUT, the
# exit status in $RC. SEAM is PPP_FULL_TEST_CMD ("" leaves it unset), EXTRA
# holds more VAR=value pairs.
wiz() {
  local input=$1; shift
  local envv=(PATH="$STUBS:$BASE/bin" HOME="$T/home" TMPDIR="$T/tmp" STUB="$T/stub"
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    npm_config_update_notifier=false npm_config_cache="$T/home/.npm" npm_config_offline=true
    PPP_POLL_INTERVAL=0 PPP_IMAGES_TIMEOUT=30 PPP_RELEASE_DATE=2026-11-01
    PPP_RELEASE_TITLE="A fixture release" EDITOR=true)
  [ -z "$SEAM" ] || envv+=(PPP_FULL_TEST_CMD="$SEAM")
  ( cd "$T/work" && printf '%b' "$input" \
      | timeout 60 env -i "${envv[@]}" "${EXTRA[@]}" bash scripts/release-wizard.sh "$@" ) >"$T/out" 2>&1
  RC=$?
  OUT="$(cat "$T/out")"
}

# The answers, in order, for a release with nothing unusual about it:
# prepare / open the changelog / commit+push+PR / tag / edit notes / publish.
HAPPY='y\nn\ny\ny\nn\ny\n'

snap() { # everything a read-only command must leave alone
  git -C "$T/remote.git" for-each-ref
  git -C "$T/work" for-each-ref
  git -C "$T/work" status --porcelain
  git -C "$T/work" symbolic-ref HEAD
  ( cd "$T/work" && cat CHANGELOG.md package.json package-lock.json README.md docs/deployment.md | cksum )
}
remote_has() { git -C "$T/remote.git" rev-parse -q --verify "$1" >/dev/null 2>&1; }
work_has() { git -C "$T/work" rev-parse -q --verify "$1" >/dev/null 2>&1; }
merge_oid() { python3 -c 'import json,sys; print((json.load(open(sys.argv[1]))[0].get("mergeCommit") or {}).get("oid") or "")' "$T/stub/state/pr-list.json"; }
commit_main() { # commit_main <message> — commit what is staged in work, and push it
  git -C "$T/work" commit -q -m "$1" && git -C "$T/work" push -q origin main
  MAIN0="$(git -C "$T/remote.git" rev-parse main)"
}
add_migration() {
  mkdir -p "$T/work/prisma/migrations/20261001000000_add_priority"
  echo "ALTER TABLE t ADD p int;" >"$T/work/prisma/migrations/20261001000000_add_priority/migration.sql"
  git -C "$T/work" add -A; commit_main "Give a request a priority (#3)"
}
use_upgrading_changelog() {
  cp "$FIX/changelog-upgrading.txt" "$T/work/CHANGELOG.md"
  git -C "$T/work" add -A; commit_main "Say how to upgrade (#4)"
}

# ----- assertions ---------------------------------------------------------------
PASSED=0; FAILED=0; CASE=""; CASE_OK=1; DETAIL=""
t() {
  end_case
  CASE="$1"; CASE_OK=1; DETAIL=""
}
end_case() {
  [ -n "$CASE" ] || return 0
  if [ "$CASE_OK" -eq 1 ]; then
    PASSED=$((PASSED + 1)); echo "ok   $CASE"
  else
    FAILED=$((FAILED + 1)); echo "FAIL $CASE"; printf '%b' "$DETAIL"
    echo "     --- last output ---"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/     /'
  fi
  CASE=""
}
no() { CASE_OK=0; DETAIL+="     - $1\n"; }
rc() { [ "$RC" -eq "$1" ] || no "exit status $RC, wanted $1"; }
out() { case "$OUT" in *"$1"*) ;; *) no "output lacks: $1" ;; esac; }
no_out() { case "$OUT" in *"$1"*) no "output has: $1" ;; esac; }
logged() { grep -Eq -- "$1" "$T/stub/log" || no "log lacks: $1"; }
not_logged() { if grep -Eq -- "$1" "$T/stub/log"; then no "log has: $1"; fi; }
eq() { [ "$2" = "$3" ] || no "$1: got '$2', wanted '$3'"; }
ok() { local what=$1; shift; "$@" >/dev/null 2>&1 || no "$what"; }
nok() { local what=$1; shift; if "$@" >/dev/null 2>&1; then no "$what"; fi; }

# ============================================================================
# 1–4. preflight
# ============================================================================
t "01 a modified tracked file refuses, and nothing moves"
new_sandbox; echo "x" >>"$T/work/README.md"; before="$(snap)"
wiz "$HAPPY" 0.2.0
rc 1; out "working tree is not clean"; eq "refs and files" "$(snap)" "$before"

t "01 an untracked file refuses too"
new_sandbox; echo "x" >"$T/work/notes.txt"; before="$(snap)"
wiz "$HAPPY" 0.2.0
rc 1; out "working tree is not clean"; out "notes.txt"; eq "refs and files" "$(snap)" "$before"

t "02 not on main refuses"
new_sandbox; git -C "$T/work" switch -q -c feature
wiz "$HAPPY" 0.2.0
rc 1; out "on feature; a release starts from main"; nok "a release branch exists" work_has refs/heads/release-0.2.0

t "03 local main ahead of the remote refuses"
new_sandbox; echo "x" >>"$T/work/docs/other.txt"; git -C "$T/work" commit -q -am "Not pushed"
wiz "$HAPPY" 0.2.0
rc 1; out "is not origin/main"; out "pull or push first"

t "03 local main behind the remote refuses"
new_sandbox
git clone -q "$T/remote.git" "$T/other"
( cd "$T/other" && git config user.name O && git config user.email o@example.test \
  && echo x >>docs/other.txt && git commit -q -am "Somebody else (#5)" && git push -q origin main )
wiz "$HAPPY" 0.2.0
rc 1; out "is not origin/main"; nok "a release branch exists" work_has refs/heads/release-0.2.0

t "04 gh missing from PATH says so"
new_sandbox; STUBS="$BASE/stubs-nogh"
wiz "$HAPPY" 0.2.0
rc 1; out "gh required"

t "04 gh not signed in says how to fix it"
new_sandbox; touch "$T/stub/state/no-auth"
wiz "$HAPPY" 0.2.0
rc 1; out "gh is not authenticated — run: gh auth login"

t "R8 the full test's preflight runs first, and its refusal stops before a branch exists"
new_sandbox; SEAM=""; touch "$T/stub/state/preflight-fail"; before="$(snap)"
wiz "$HAPPY" 0.2.0
rc 1; logged '^full-test --preflight$'; out "nothing was touched"; eq "refs and files" "$(snap)" "$before"

# ============================================================================
# 5–7. version
# ============================================================================
t "05 no new migration: the default is a patch"
new_sandbox
wiz '\nn\n' ; rc 0; out "Prepare release-0.1.1 from main"; out "aborted."

t "05 a new migration: the default is a minor"
new_sandbox; add_migration
wiz '\nn\n'; rc 0; out "Prepare release-0.2.0 from main"; out "1 new migration"

t "05 upgrade notes in Unreleased: the default is a minor"
new_sandbox; use_upgrading_changelog
wiz '\nn\n'; rc 0; out "Prepare release-0.2.0 from main"

t "06 a typed 1.2 is not a version"
new_sandbox
wiz '1.2\n'; rc 1; out "not a version: 1.2"; out "pre-releases are cut by hand"

t "06 a version with a leading zero is not a version"
new_sandbox; before="$(snap)"
wiz "$HAPPY" 0.03.0; rc 1; out "not a version: 0.03.0"; eq "refs and files" "$(snap)" "$before"
wiz '' --continue 0.2.00; rc 1; out "not a version: 0.2.00"

t "the three timings have to be whole numbers"
new_sandbox; EXTRA=(PPP_PR_TIMEOUT=soon)
wiz "$HAPPY" 0.2.0; rc 1; out "PPP_PR_TIMEOUT must be a whole number of seconds, not 'soon'"
EXTRA=(PPP_IMAGES_TIMEOUT=-5); wiz "$HAPPY" 0.2.0; rc 1; out "PPP_IMAGES_TIMEOUT must be a whole number"
EXTRA=(PPP_POLL_INTERVAL=1.5); wiz "$HAPPY" 0.2.0; rc 1; out "PPP_POLL_INTERVAL must be a whole number"
eq "calls made" "$(wc -l <"$T/stub/log" | tr -d ' ')" "0"

t "R2 a changelog section on main with no bump is for a person, not for --continue"
new_sandbox
( cd "$T/work" && cp "$FIX/changelog-golden.txt" CHANGELOG.md && sed -i 's/^Nothing yet\.$/Something new./' CHANGELOG.md && git add -A )
commit_main "A section ahead of its release (#9)"
wiz "$HAPPY" 0.2.0
rc 1; out "CHANGELOG.md on main already has a ## v0.2.0 section"; out "sort it out by hand"; no_out "resume with"

t "06 a version at or below the last is refused"
new_sandbox
wiz '' 0.1.0; rc 1; out "v0.1.0 is not above the last release (v0.1.0)"
wiz '' v0.0.9; rc 1; out "v0.0.9 is not above the last release (v0.1.0)"

t "06 a tag that exists only locally is refused"
new_sandbox; git -C "$T/work" tag -a v0.2.0 -m v0.2.0
wiz "$HAPPY" 0.2.0
rc 1; out "v0.2.0 is not above the last release (v0.2.0)"; nok "a release branch exists" work_has refs/heads/release-0.2.0

t "06 a tag that exists only on the remote is refused"
new_sandbox; git -C "$T/remote.git" tag v0.2.0 main
wiz "$HAPPY" 0.2.0
rc 1; out "v0.2.0 is not above the last release (v0.2.0)"; nok "a release branch exists" work_has refs/heads/release-0.2.0

t "06 an existing local release branch points at --continue"
new_sandbox; git -C "$T/work" branch release-0.2.0
wiz "$HAPPY" 0.2.0
rc 1; out "release-0.2.0 already exists"; out "release-wizard.sh --continue 0.2.0"

t "06 a release branch that exists only on the remote points at --continue"
new_sandbox; git -C "$T/remote.git" branch release-0.2.0 main
wiz "$HAPPY" 0.2.0
rc 1; out "release-0.2.0 already exists"; out "--continue 0.2.0"; nok "a local branch was made" work_has refs/heads/release-0.2.0

t "R2 a pull request for this version in ANY state means it is never prepared again"
new_sandbox
echo '[{"number":4,"state":"CLOSED","url":"https://github.invalid/pull/4","mergeCommit":null,"headRefOid":"0000000000000000000000000000000000000000","baseRefName":"main","isCrossRepository":false}]' >"$T/stub/state/pr-list.json"
before="$(snap)"
wiz "$HAPPY" 0.2.0
rc 1; out "pull request #4 (CLOSED) already has the head release-0.2.0"; out "--continue 0.2.0"
eq "refs and files" "$(snap)" "$before"; not_logged 'pr create'

t "R2 a pull request from a fork with the same branch name is not this release"
new_sandbox
echo '[{"number":4,"state":"OPEN","url":"https://github.invalid/pull/4","mergeCommit":null,"headRefOid":"0000000000000000000000000000000000000000","baseRefName":"main","isCrossRepository":true}]' >"$T/stub/state/pr-list.json"
wiz 'n\n' 0.2.0
rc 0; out "Prepare release-0.2.0 from main"; out "aborted."

t "R2 a main that already carries the version is refused, pointing at --continue"
new_sandbox
( cd "$T/work" && cp "$FIX/changelog-golden.txt" CHANGELOG.md \
  && sed -i 's/"version": "0.1.0"/"version": "0.2.0"/' package.json package-lock.json && git add -A )
commit_main "Prepare v0.2.0 (#7)"; before="$(snap)"
wiz "$HAPPY" 0.2.0
rc 1; out "main is already at 0.2.0"; out "--continue 0.2.0"; eq "refs and files" "$(snap)" "$before"
wiz "$HAPPY" 0.3.0
rc 1; out "--continue 0.2.0"; eq "refs and files, asking for the next version" "$(snap)" "$before"

t "07 an empty Unreleased is refused"
new_sandbox
( cd "$T/work" && sed -i '/^## Unreleased$/,/^## v0.1.0$/{/^## /!d}' CHANGELOG.md \
  && sed -i 's/^## Unreleased$/## Unreleased\n\nNothing yet.\n/' CHANGELOG.md && git add -A )
commit_main "Empty it (#9)"
wiz "$HAPPY" 0.2.0
rc 1; out "## Unreleased is empty — there is nothing to release"

# ============================================================================
# 8–11. prepare
# ============================================================================
new_sandbox
wiz 'y\nn\nn\n' 0.2.0

t "08 the changelog matches the golden file byte for byte"
rc 0; ok "CHANGELOG.md differs from changelog-golden.txt" cmp "$T/work/CHANGELOG.md" "$FIX/changelog-golden.txt"

t "09 package.json and both version fields of the lockfile read 0.2.0"
eq "package.json" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$T/work/package.json")" "0.2.0"
eq "package-lock.json" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["version"], d["packages"][""]["version"])' "$T/work/package-lock.json")" "0.2.0 0.2.0"

t "10 example tags move; the same version in a sentence does not"
ok "README PPP_TAG line" grep -q 'Pin `PPP_TAG` to a release (`v0.2.0`)' "$T/work/README.md"
ok "README image line" grep -q 'ghcr.io/octo/ppp-app:v0.2.0' "$T/work/README.md"
ok "README prose was rewritten" grep -q 'still there in v0.1.0, which is history' "$T/work/README.md"
ok "deployment image line" grep -q '  ghcr.io/octo/ppp-app:v0.2.0' "$T/work/docs/deployment.md"
ok "deployment prose was rewritten" grep -q 'started on v0.1.0 kept' "$T/work/docs/deployment.md"
out "README.md: 2 example tag(s) moved to v0.2.0"

t "10 a file with no example tag is asked about, and no stops there"
new_sandbox
( cd "$T/work" && echo "# Deployment" >docs/deployment.md && git add -A ); commit_main "Drop the example (#9)"
wiz 'y\nn\n' 0.2.0
rc 0; out "no example tag found in docs/deployment.md"; out "aborted."

t "11 a new migration with no upgrade notes gets a stub that names it, and an editor run"
new_sandbox; add_migration; EXTRA=(EDITOR="fix-todo --wait")
wiz 'y\nn\n' 0.2.0
rc 0
ok "the Upgrading heading" grep -q '^### Upgrading from v0.1.0$' "$T/work/CHANGELOG.md"
ok "the migration directory" grep -q '`20261001000000_add_priority`' "$T/work/CHANGELOG.md"
ok "the migration count" grep -q '1 database migration runs by itself' "$T/work/CHANGELOG.md"
nok "the TODO is still there" grep -q 'TODO(release)' "$T/work/CHANGELOG.md"
logged '^fix-todo --wait CHANGELOG.md$'

t "11 an editor that leaves the TODO is refused"
new_sandbox; add_migration
wiz 'y\nn\n' 0.2.0
rc 0; out "the Upgrading stub is still a TODO"; out "aborted."
eq "commits on the branch" "$(git -C "$T/work" rev-list --count main..release-0.2.0)" "0"

t "11 a body that already has an Upgrading section gets no stub"
new_sandbox; use_upgrading_changelog; add_migration
wiz 'y\nn\nn\n' 0.2.0
rc 0; nok "a TODO was inserted" grep -q 'TODO(release)' "$T/work/CHANGELOG.md"
eq "Upgrading headings" "$(grep -c '^### Upgrading' "$T/work/CHANGELOG.md")" "1"

# ============================================================================
# 12–14. test, commit, pull request
# ============================================================================
t "12 a failing full test stops everything: no commit, no push, no pull request"
new_sandbox; SEAM="false"
wiz "$HAPPY" 0.2.0
rc 1; out "the full test failed — nothing was committed or pushed"; out "--continue 0.2.0"
eq "commits on the branch" "$(git -C "$T/work" rev-list --count main..release-0.2.0)" "0"
nok "the branch was pushed" remote_has refs/heads/release-0.2.0; not_logged 'pr create'

new_sandbox
wiz "$HAPPY" 0.2.0
HAPPY_OUT="$OUT"; HAPPY_RC=$RC; HAPPY_T="$T"

t "13 the happy path pushes one commit touching exactly the five files, and opens the pull request"
rc 0
eq "commits on the branch" "$(git -C "$T/remote.git" rev-list --count "$MAIN0..release-0.2.0")" "1"
eq "files in it" "$(git -C "$T/remote.git" diff --name-only "$MAIN0" release-0.2.0 | LC_ALL=C sort | tr '\n' ' ')" \
  "CHANGELOG.md README.md docs/deployment.md package-lock.json package.json "
eq "its subject" "$(git -C "$T/remote.git" log -1 --format=%s release-0.2.0)" "Prepare v0.2.0"
logged '^gh pr create --base main --head release-0\.2\.0 --title Prepare v0\.2\.0 --body-file [^ ]+ --repo octo/widgets$'
ok "the pull request body says merging releases nothing" grep -q 'Merging this does not release anything' "$T/stub/state/pr-body"
ok "the pull request body has the section" grep -q '^### Added$' "$T/stub/state/pr-body"

t "15 the pull request is polled while open, and the wizard goes on once it is merged"
eq "polls of the pull request, at least 3" "$([ "$(grep -c '^gh pr list .*--head release-0.2.0' "$T/stub/log")" -ge 3 ] && echo yes)" "yes"
out "waiting for #7 to be merged — the owner merges, this tool never does."; out "#7 is merged"

t "30 the images waited for are exactly the three the real workflow publishes"
eq "images" "$(grep '^docker buildx imagetools inspect' "$T/stub/log" | awk '{print $5}' | sort -u | tr '\n' ' ')" \
  "ghcr.io/octo/ppp-app:v0.2.0 ghcr.io/octo/ppp-migrate:v0.2.0 ghcr.io/octo/ppp-storage-migrate:v0.2.0 "

t "14 a tracked file changed besides the five is asked about; no stops with nothing pushed"
new_sandbox; SEAM="leave-stray"
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; out "changed besides the release files"; out "docs/other.txt"; out "aborted."; out "resume with: scripts/release-wizard.sh --continue 0.2.0"
nok "the branch was pushed" remote_has refs/heads/release-0.2.0; not_logged 'pr create'

t "14 yes takes it into the release commit"
new_sandbox; SEAM="leave-stray"
wiz 'y\nn\ny\ny\ny\nn\ny\n' 0.2.0
rc 0
eq "files in the commit" "$(git -C "$T/remote.git" diff --name-only "$MAIN0" release-0.2.0 | LC_ALL=C sort | tr '\n' ' ')" \
  "CHANGELOG.md README.md docs/deployment.md docs/other.txt package-lock.json package.json "

t "14 a stray file with a space in its name can be taken along"
new_sandbox; SEAM="leave-stray-space"
wiz 'y\nn\ny\ny\ny\nn\ny\n' 0.2.0
rc 0; out "    docs/other file.txt"
eq "files in the commit" "$(git -C "$T/remote.git" -c core.quotePath=false diff --name-only "$MAIN0" release-0.2.0 | LC_ALL=C sort | tr '\n' '|')" \
  "CHANGELOG.md|README.md|docs/deployment.md|docs/other file.txt|package-lock.json|package.json|"

t "14 an untracked file is never swept into a release commit"
new_sandbox; SEAM="leave-untracked"
wiz "$HAPPY" 0.2.0
rc 1; out "untracked files"; out "scratch.txt"
nok "the branch was pushed" remote_has refs/heads/release-0.2.0; not_logged 'pr create'

t "16 a pull request closed without merging stops the wizard"
new_sandbox
on_sleep 'sed -i "s/\"OPEN\"/\"CLOSED\"/" "$STUB/state/pr-list.json"'
wiz "$HAPPY" 0.2.0
rc 1; out "#7 was closed without merging"; nok "a tag was pushed" remote_has refs/tags/v0.2.0

t "PR_TIMEOUT a pull request nobody merges times out with the resume line"
new_sandbox; on_sleep ':'; EXTRA=(PPP_PR_TIMEOUT=1)
wiz "$HAPPY" 0.2.0
rc 1; out "#7 was not merged within 1s"; out "resume with: scripts/release-wizard.sh --continue 0.2.0"

# ============================================================================
# 17–20. tagging
# ============================================================================
t "17 the tag goes on the merge commit by SHA, with main moved on and the local main stale"
new_sandbox
on_sleep 'if [ "$1" -ge 2 ] && [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr" later; fi'
wiz "$HAPPY" 0.2.0
rc 0
tagged="$(git -C "$T/remote.git" rev-parse -q --verify 'refs/tags/v0.2.0^{commit}' 2>/dev/null)"
eq "the tagged commit" "$tagged" "$(merge_oid)"
[ "$tagged" != "$(git -C "$T/remote.git" rev-parse main)" ] || no "the tag is on the tip of the remote main"
[ "$tagged" != "$(git -C "$T/work" rev-parse main)" ] || no "the tag is on the local main"
[ "$tagged" != "$(git -C "$T/work" rev-parse HEAD)" ] || no "the tag is on the local HEAD"
eq "the local main, untouched" "$(git -C "$T/work" rev-parse main)" "$MAIN0"
eq "the kind of tag" "$(git -C "$T/remote.git" cat-file -t refs/tags/v0.2.0 2>/dev/null)" "tag"

t "18 a merge commit without the bump is never tagged"
new_sandbox
on_sleep "sed -i 's/\"OPEN\"/\"MERGED\"/; s/\"mergeCommit\":null/\"mergeCommit\":{\"oid\":\"$MAIN0\"}/' \"\$STUB/state/pr-list.json\""
wiz "$HAPPY" 0.2.0
rc 1; out "does not contain the v0.2.0 bump — refusing to tag it"
nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "19 a merge commit that is not on the remote main is never tagged"
new_sandbox
on_sleep 'oid="$(git --git-dir="$STUB/../remote.git" rev-parse release-0.2.0)"; sed -i "s/\"OPEN\"/\"MERGED\"/; s/\"mergeCommit\":null/\"mergeCommit\":{\"oid\":\"$oid\"}/" "$STUB/state/pr-list.json"'
wiz "$HAPPY" 0.2.0
rc 1; out "is not on origin/main — refusing to tag"
nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "19 a merged pull request with no merge commit is not guessed at"
new_sandbox
on_sleep 'sed -i "s/\"OPEN\"/\"MERGED\"/" "$STUB/state/pr-list.json"'
wiz "$HAPPY" 0.2.0
rc 1; out "gave no merge commit — refusing to guess one"; nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "19 a pull request merged into another branch is not tagged"
new_sandbox
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; sed -i "s/\"baseRefName\":\"main\"/\"baseRefName\":\"develop\"/" "$STUB/state/pr-list.json"; fi'
wiz "$HAPPY" 0.2.0
rc 1; out "#7 was merged into develop, not main — refusing to tag it"
nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "20 a tag that is not where it was pushed, straight after the push, stops everything"
new_sandbox
mkdir -p "$T/remote.git/hooks"
printf '#!/usr/bin/env bash\nwhile read -r old new ref; do\n  if [ "$ref" = "refs/tags/v0.2.0" ]; then git update-ref refs/tags/v0.2.0 %s; fi\ndone\nexit 0\n' "$MAIN0" >"$T/remote.git/hooks/post-receive"
chmod +x "$T/remote.git/hooks/post-receive"
wiz "$HAPPY" 0.2.0
rc 1; out "after the push, v0.2.0 on origin is not"; not_logged 'release create'; not_logged 'run list .*release-images'

t "20 a lightweight local tag at the merge commit is refused, not pushed"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
git -C "$T/work" tag v0.2.0 "$(merge_oid)"
wiz 'y\nn\ny\n' --continue 0.2.0
rc 1; out "the local tag v0.2.0 is a lightweight tag — delete it (git tag -d v0.2.0)"
nok "a tag on the remote" remote_has refs/tags/v0.2.0; not_logged 'release create'

t "20 a remote tag already at another commit is not moved"
new_sandbox
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; git --git-dir="$STUB/../remote.git" tag v0.2.0 '"$MAIN0"'; fi'
wiz "$HAPPY" 0.2.0
rc 1; out "v0.2.0 already exists on origin at"; out "a pushed tag is not moved"
eq "the remote tag" "$(git -C "$T/remote.git" rev-parse 'refs/tags/v0.2.0^{commit}')" "$MAIN0"; not_logged 'release create'

t "20 a local tag at another commit is refused"
new_sandbox
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; git -C "$STUB/../work" tag v0.2.0 '"$MAIN0"'; fi'
wiz "$HAPPY" 0.2.0
rc 1; out "a local tag v0.2.0 exists at"; nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "20 a local tag already at the merge commit is pushed, not made again"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; out "aborted."; nok "a tag on the remote after answering no" remote_has refs/tags/v0.2.0
git -C "$T/work" tag -a v0.2.0 -m "made by hand" "$(merge_oid)"
mine="$(git -C "$T/work" rev-parse refs/tags/v0.2.0)"
wiz 'y\nn\ny\n' --continue 0.2.0
rc 0; eq "the tag object on the remote" "$(git -C "$T/remote.git" rev-parse -q --verify refs/tags/v0.2.0 2>/dev/null)" "$mine"
logged 'release create v0\.2\.0'

t "R5 a lightweight tag on the remote is read through its plain ref"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
git -C "$T/remote.git" tag v0.2.0 "$(merge_oid)"
wiz 'n\ny\n' --continue 0.2.0
rc 0; out "v0.2.0 is tagged at"; logged 'release create v0\.2\.0'

t "R6 a merged tree that is not the tested one is asked about, and no does not tag"
new_sandbox
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr" moved; fi'
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; out "something else merged in between; the merged tree is not byte-identical to what was tested"; out "aborted."
nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "R6 a branch tip that is not in this clone is a warning, not a refusal"
new_sandbox
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; sed -i "s/\"headRefOid\":\"[0-9a-f]*\"/\"headRefOid\":\"1111111111111111111111111111111111111111\"/" "$STUB/state/pr-list.json"; fi'
wiz "$HAPPY" 0.2.0
rc 0; out "could not compare the merge with what was tested"; ok "the tag on the remote" remote_has refs/tags/v0.2.0

# ============================================================================
# R4 (replaces 21). CI on the merge commit gates the tag
# ============================================================================
t "R4 CI failed on the merge commit: no tag"
new_sandbox
echo '[{"status":"completed","conclusion":"failure","url":"https://github.invalid/runs/9","createdAt":"2026-11-01T10:00:00Z"}]' >"$T/stub/state/runs-ci.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "CI failed on"; out "https://github.invalid/runs/9 — refusing to tag"
nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "R4 a cancelled CI run is called cancelled, not failed, and still does not tag"
new_sandbox
echo '[{"status":"completed","conclusion":"cancelled","url":"https://github.invalid/runs/9","createdAt":"2026-11-01T10:00:00Z"}]' >"$T/stub/state/runs-ci.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "CI was cancelled on"; out "re-run it, then: scripts/release-wizard.sh --continue 0.2.0"; no_out "CI failed"
nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "R4 CI still running is waited for, then the tag goes on"
new_sandbox
echo '[{"status":"in_progress","conclusion":"","url":"https://github.invalid/runs/9","createdAt":"2026-11-01T10:00:00Z"}]' >"$T/stub/state/runs-ci.yml.json"
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; elif [ "$1" -ge 4 ]; then sed -i "s/in_progress/completed/; s/\"conclusion\":\"\"/\"conclusion\":\"success\"/" "$STUB/state/runs-ci.yml.json"; fi'
wiz "$HAPPY" 0.2.0
rc 0; out "waiting for CI on"; out "CI passed on"; ok "the tag on the remote" remote_has refs/tags/v0.2.0

t "R4 CI that never finishes times out with nothing tagged"
new_sandbox; EXTRA=(PPP_IMAGES_TIMEOUT=1)
echo '[{"status":"queued","conclusion":"","url":"https://github.invalid/runs/9","createdAt":"2026-11-01T10:00:00Z"}]' >"$T/stub/state/runs-ci.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "has not finished"; out "Nothing was tagged."; nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "R4 no CI run at all is said and asked; no does not tag"
new_sandbox; echo '[]' >"$T/stub/state/runs-ci.yml.json"
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; out "no CI run was found for"; out "aborted."; nok "a tag on the remote" remote_has refs/tags/v0.2.0

t "R4 the newest CI run decides, not the first in the list"
new_sandbox
echo '[{"status":"completed","conclusion":"success","url":"https://github.invalid/runs/8","createdAt":"2026-11-01T09:00:00Z"},
       {"status":"completed","conclusion":"failure","url":"https://github.invalid/runs/9","createdAt":"2026-11-01T10:00:00Z"}]' >"$T/stub/state/runs-ci.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "https://github.invalid/runs/9 — refusing to tag"; nok "a tag on the remote" remote_has refs/tags/v0.2.0

# ============================================================================
# 22–24. images and publishing
# ============================================================================
t "22 an image that is not there yet is waited for, then the release is published"
new_sandbox; sed -i '/ppp-migrate/d' "$T/stub/state/images"
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; elif [ "$1" -ge 4 ]; then echo ghcr.io/octo/ppp-migrate:v0.2.0 >>"$STUB/state/images"; fi'
wiz "$HAPPY" 0.2.0
rc 0; out "ppp-app ✓  ppp-migrate ✗  ppp-storage-migrate ✓"; out "every image is published at :v0.2.0"; logged 'release create v0\.2\.0'

t "22 an image that never appears times out: tag pushed, nothing published"
new_sandbox; sed -i '/ppp-migrate/d' "$T/stub/state/images"; EXTRA=(PPP_IMAGES_TIMEOUT=1)
wiz "$HAPPY" 0.2.0
rc 1; out "ppp-migrate ✗"; out "The tag is pushed; the release is not published."; out "--continue 0.2.0"
ok "the tag on the remote" remote_has refs/tags/v0.2.0; not_logged 'release create'

t "22 images published but the run still signing: waited for"
new_sandbox
sed -i '0,/"completed","conclusion":"success"/s//"in_progress","conclusion":""/' "$T/stub/state/runs-release-images.yml.json"
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; elif [ "$1" -ge 4 ]; then sed -i "s/\"in_progress\",\"conclusion\":\"\"/\"completed\",\"conclusion\":\"success\"/" "$STUB/state/runs-release-images.yml.json"; fi'
wiz "$HAPPY" 0.2.0
rc 0; out "run: in_progress"; out "run: success"; logged 'release create v0\.2\.0'

t "22 a run for the tag that has not been created yet is waited for, not mistaken for main's"
new_sandbox; EXTRA=(PPP_IMAGES_TIMEOUT=1)
echo '[{"status":"completed","conclusion":"success","headBranch":"main","event":"push","url":"https://github.invalid/runs/3","createdAt":"2026-11-01T10:06:00Z"}]' >"$T/stub/state/runs-release-images.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "run: not started"; not_logged 'release create'

t "23 a failed release-images run stops with its URL, and nothing is published"
new_sandbox
sed -i '0,/"conclusion":"success"/s//"conclusion":"failure"/' "$T/stub/state/runs-release-images.yml.json"
wiz "$HAPPY" 0.2.0
rc 1; out "release-images failed for v0.2.0: https://github.invalid/runs/2"; out "The release was NOT published."; not_logged 'release create'

t "23 a re-run that succeeded outranks the earlier failure"
new_sandbox
echo '[{"status":"completed","conclusion":"failure","headBranch":"v0.2.0","event":"push","url":"https://github.invalid/runs/2","createdAt":"2026-11-01T10:05:00Z"},
       {"status":"completed","conclusion":"success","headBranch":"v0.2.0","event":"push","url":"https://github.invalid/runs/4","createdAt":"2026-11-01T11:00:00Z"}]' >"$T/stub/state/runs-release-images.yml.json"
wiz "$HAPPY" 0.2.0
rc 0; logged 'release create v0\.2\.0'

t "24 the release is created from the tag, with short notes cut from the merge commit"
new_sandbox; use_upgrading_changelog
wiz "$HAPPY" 0.2.0
rc 0
logged '^gh release create v0\.2\.0 --verify-tag --title v0\.2\.0 — A fixture release --notes-file [^ ]+ --repo octo/widgets$'
ok "the notes differ from notes-golden.txt" cmp "$T/stub/state/notes-captured" "$FIX/notes-golden.txt"
ok "the Upgrading heading" grep -q '^### Upgrading from v0.1.0$' "$T/stub/state/notes-captured"
ok "the rewritten link" grep -qF '](https://github.com/octo/widgets/blob/v0.2.0/docs/x.md#a)' "$T/stub/state/notes-captured"
nok "the entry-by-entry sections came along" grep -q '^### Added$' "$T/stub/state/notes-captured"
out "v0.2.0 is released."; out "./deploy-wizard.sh          # choose v0.2.0"
out "git switch main && git pull --ff-only && git branch -d release-0.2.0"

t "24 notes edited until the Upgrading section is gone are warned about; no publishes nothing"
new_sandbox; use_upgrading_changelog; EXTRA=(EDITOR=gut-notes)
wiz 'y\nn\ny\ny\ny\nn\n' 0.2.0
rc 0; out "the Upgrading section is gone; the deploy wizard shows it to whoever upgrades"; out "aborted."
not_logged 'release create'

t "24 without PPP_RELEASE_TITLE the title is asked for, and empty means the bare version"
new_sandbox
( cd "$T/work" && printf 'y\nn\ny\ny\nn\n\ny\n' | timeout 60 env -i PATH="$BASE/stubs:$BASE/bin" HOME="$T/home" \
    TMPDIR="$T/tmp" STUB="$T/stub" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm_config_offline=true \
    npm_config_update_notifier=false PPP_POLL_INTERVAL=0 PPP_FULL_TEST_CMD=true EDITOR=true \
    bash scripts/release-wizard.sh 0.2.0 ) >"$T/out" 2>&1; RC=$?; OUT="$(cat "$T/out")"
rc 0; eq "the title" "$(cat "$T/stub/state/title-captured" 2>/dev/null)" "v0.2.0"

# ============================================================================
# 25. --continue
# ============================================================================
t "25 --continue with nothing to continue says so"
new_sandbox; before="$(snap)"
wiz '' --continue 0.3.0
rc 1; out "nothing to continue for 0.3.0"; eq "refs and files" "$(snap)" "$before"

t "25 --continue from a prepared, uncommitted branch tests, commits, pushes and releases"
new_sandbox; SEAM=""
wiz 'y\nn\nn\n' 0.2.0
rc 0; out "aborted."; clear_log
git -C "$T/work" stash -q; git -C "$T/work" switch -q main; git -C "$T/work" switch -q release-0.2.0; git -C "$T/work" stash pop -q
wiz 'y\ny\nn\ny\n' --continue 0.2.0
rc 0; logged '^full-test $'; not_logged '^full-test .*--(no-build|only)'
eq "commits on the branch" "$(git -C "$T/remote.git" rev-list --count "$MAIN0..release-0.2.0")" "1"
logged 'pr create'; logged 'release create v0\.2\.0'

t "25 --continue from a branch that is not prepared refuses"
new_sandbox; git -C "$T/work" branch release-0.2.0
wiz 'y\n' --continue 0.2.0
rc 1; out "release-0.2.0 exists but is not prepared — delete it and start again"

t "25 --continue after a push with no pull request neither commits nor pushes again"
new_sandbox; touch "$T/stub/state/pr-create-fail"
wiz "$HAPPY" 0.2.0
rc 1; ok "the branch on the remote" remote_has refs/heads/release-0.2.0
pushed="$(git -C "$T/remote.git" rev-parse release-0.2.0)"
wiz 'y\ny\nn\ny\n' --continue 0.2.0
rc 0; out "nothing to commit"; out "release-0.2.0 is already on origin"
eq "the pushed commit" "$(git -C "$T/remote.git" rev-parse release-0.2.0)" "$pushed"; logged 'release create v0\.2\.0'

t "R3 --continue finds a release branch that exists only on the remote"
new_sandbox; touch "$T/stub/state/pr-create-fail"
wiz "$HAPPY" 0.2.0
git -C "$T/work" switch -q main; git -C "$T/work" branch -q -D release-0.2.0
git -C "$T/work" update-ref -d refs/remotes/origin/release-0.2.0
wiz 'y\ny\nn\ny\n' --continue 0.2.0
rc 0; eq "the branch checked out" "$(git -C "$T/work" symbolic-ref --short HEAD)" "release-0.2.0"; logged 'release create v0\.2\.0'

t "25 --continue with the pull request open waits for the merge"
new_sandbox; on_sleep ':'; EXTRA=(PPP_PR_TIMEOUT=1)
wiz "$HAPPY" 0.2.0
rc 1; EXTRA=(); clear_log
on_sleep 'if [ ! -e "$STUB/merged" ]; then touch "$STUB/merged"; "$HELPERS/merge-pr"; fi'
git -C "$T/work" switch -q main
wiz 'y\nn\ny\n' --continue 0.2.0
rc 0; out "waiting for #7 to be merged"; logged 'release create v0\.2\.0'; not_logged 'pr create'; not_logged '^full-test'

t "25 --continue with the pull request merged tags it"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; clear_log
wiz 'y\nn\ny\n' --continue 0.2.0
rc 0; eq "the tagged commit" "$(git -C "$T/remote.git" rev-parse -q --verify 'refs/tags/v0.2.0^{commit}' 2>/dev/null)" "$(merge_oid)"
logged 'release create v0\.2\.0'; not_logged 'pr create'

t "25 --continue with only a closed pull request stops"
new_sandbox
echo '[{"number":4,"state":"CLOSED","url":"https://github.invalid/pull/4","mergeCommit":null,"headRefOid":"0000000000000000000000000000000000000000","baseRefName":"main","isCrossRepository":false}]' >"$T/stub/state/pr-list.json"
wiz "$HAPPY" --continue 0.2.0
rc 1; out "#4 was closed without merging"

t "R3 --continue ignores a closed pull request when a merged one exists; two live ones stop it"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
python3 - "$T/stub/state/pr-list.json" <<'PYEOF'
import json, sys
prs = json.load(open(sys.argv[1]))
prs.insert(0, dict(prs[0], number=3, state="CLOSED", mergeCommit=None))
json.dump(prs, open(sys.argv[1], "w"))
PYEOF
wiz 'y\nn\ny\n' --continue 0.2.0
rc 0; logged 'release create v0\.2\.0'
new_sandbox
echo '[{"number":4,"state":"OPEN","url":"u","mergeCommit":null,"headRefOid":"a","baseRefName":"main","isCrossRepository":false},
       {"number":5,"state":"OPEN","url":"u","mergeCommit":null,"headRefOid":"a","baseRefName":"main","isCrossRepository":false}]' >"$T/stub/state/pr-list.json"
wiz '' --continue 0.2.0
rc 1; out "more than one open or merged pull request has the head release-0.2.0: #4,#5"

t "25 --continue with the tag pushed and no release waits for the images and publishes"
new_sandbox; : >"$T/stub/state/images"; EXTRA=(PPP_IMAGES_TIMEOUT=1)
wiz "$HAPPY" 0.2.0
rc 1; ok "the tag on the remote" remote_has refs/tags/v0.2.0
tag0="$(git -C "$T/remote.git" rev-parse refs/tags/v0.2.0)"; EXTRA=(); clear_log
printf '%s\n' ghcr.io/octo/ppp-app:v0.2.0 ghcr.io/octo/ppp-migrate:v0.2.0 ghcr.io/octo/ppp-storage-migrate:v0.2.0 >"$T/stub/state/images"
git -C "$T/work" switch -q main
wiz 'n\ny\n' --continue 0.2.0
rc 0; logged 'release create v0\.2\.0'; not_logged 'pr create'
eq "the tag object" "$(git -C "$T/remote.git" rev-parse refs/tags/v0.2.0)" "$tag0"

t "25 --continue refuses a tag that is not on the merge commit"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
git -C "$T/remote.git" tag v0.2.0 "$MAIN0"
wiz 'n\ny\n' --continue 0.2.0
rc 1; out "the tag is not on the release commit"; not_logged 'release create'

t "25 --continue never publishes for a tag that is not on main"
new_sandbox; on_sleep ':'; EXTRA=(PPP_PR_TIMEOUT=1)
wiz "$HAPPY" 0.2.0
rc 1; EXTRA=(); git -C "$T/remote.git" tag v0.2.0 release-0.2.0
wiz 'n\ny\n' --continue 0.2.0
rc 1; out "is not on origin/main — refusing to publish"; not_logged 'release create'
sed -i 's/"OPEN"/"MERGED"/' "$T/stub/state/pr-list.json"
wiz 'n\ny\n' --continue 0.2.0
rc 1; out "gave no merge commit"; not_logged 'release create'

t "25 --continue never publishes for a tag on a commit without the bump"
new_sandbox; git -C "$T/remote.git" tag v0.2.0 main
wiz 'n\ny\n' --continue 0.2.0
rc 1; out "does not contain the v0.2.0 bump — refusing to publish it"; not_logged 'release create'

t "25 --continue from another branch with work in progress leaves both alone"
new_sandbox; touch "$T/stub/state/pr-create-fail"
wiz "$HAPPY" 0.2.0
git -C "$T/work" switch -q main; echo "work in progress" >>"$T/work/docs/other.txt"; clear_log
wiz 'y\ny\ny\nn\ny\n' --continue 0.2.0
rc 1; out "with uncommitted changes"
eq "the branch checked out" "$(git -C "$T/work" symbolic-ref --short HEAD)" "main"
ok "the work in progress" grep -q 'work in progress' "$T/work/docs/other.txt"; not_logged 'pr create'

t "R3 --continue treats a draft release as not released, and does not overwrite it"
new_sandbox
wiz 'y\nn\ny\ny\nn\nn\n' 0.2.0
rc 0; echo '{"name":"v0.2.0","isDraft":true,"tagName":"v0.2.0"}' >"$T/stub/state/release-v0.2.0.json"
wiz 'n\ny\n' --continue 0.2.0
rc 1; no_out "already released"; out "a draft release v0.2.0 already exists"; not_logged 'release create'

t "25 --continue on a finished release changes nothing"
use_sandbox "$HAPPY_T"; clear_log; before="$(snap)"
wiz '' --continue 0.2.0
rc 0; out "already released."; out "./deploy-wizard.sh          # choose v0.2.0"
eq "refs and files" "$(snap)" "$before"; not_logged 'create'

# ============================================================================
# 26. the four prompts
# ============================================================================
t "26 no at the first prompt: nothing exists"
new_sandbox; before="$(snap)"
wiz 'n\n' 0.2.0
rc 0; out "aborted."; eq "refs and files" "$(snap)" "$before"

t "26 no at the second prompt: a local branch, and nothing on the remote"
new_sandbox
wiz 'y\nn\nn\n' 0.2.0
rc 0; out "aborted."; out "resume with: scripts/release-wizard.sh --continue 0.2.0"
eq "the remote" "$(git -C "$T/remote.git" for-each-ref | cksum)" "$(git -C "$TPL/remote.git" for-each-ref | cksum)"; not_logged 'pr create'

t "26 no at the third prompt: no tag anywhere"
new_sandbox
wiz 'y\nn\ny\nn\n' 0.2.0
rc 0; out "Tag $(merge_oid) as v0.2.0 and push the tag? This starts the image build."; out "aborted."
nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "26 no at the fourth prompt: tagged, not published"
new_sandbox
wiz 'y\nn\ny\ny\nn\nn\n' 0.2.0
rc 0; out "aborted."; ok "the tag on the remote" remote_has refs/tags/v0.2.0; not_logged 'release create'

t "26 end of input at each prompt is said out loud, exit 1, and does nothing more"
new_sandbox; before="$(snap)"
wiz '' 0.2.0
rc 1; out "aborted (no input)."; eq "refs and files at the first" "$(snap)" "$before"
new_sandbox
wiz 'y\nn\n' 0.2.0
rc 1; out "aborted (no input)."; nok "pushed at the second" remote_has refs/heads/release-0.2.0; not_logged 'pr create'
new_sandbox
wiz 'y\nn\ny\n' 0.2.0
rc 1; out "aborted (no input)."; nok "tagged at the third" remote_has refs/tags/v0.2.0
new_sandbox
wiz 'y\nn\ny\ny\nn\n' 0.2.0
rc 1; out "aborted (no input)."; not_logged 'release create'

t "A1 a bare enter at the first gate is a no"
new_sandbox; before="$(snap)"
wiz '\n' 0.2.0
rc 0; out "aborted."; eq "refs and files" "$(snap)" "$before"

t "A1 a bare enter at the second gate is a no"
new_sandbox
wiz 'y\nn\n\n' 0.2.0
rc 0; out "aborted."; nok "the branch was pushed" remote_has refs/heads/release-0.2.0; not_logged 'pr create'

t "A1 a bare enter at the third gate is a no"
new_sandbox
wiz 'y\nn\ny\n\n' 0.2.0
rc 0; out "aborted."; nok "a tag on the remote" remote_has refs/tags/v0.2.0; nok "a tag in the clone" work_has refs/tags/v0.2.0

t "A1 a bare enter at the fourth gate is a no"
new_sandbox
wiz 'y\nn\ny\ny\nn\n\n' 0.2.0
rc 0; out "aborted."; ok "the tag on the remote" remote_has refs/tags/v0.2.0; not_logged 'release create'

t "A1 a last answer with no newline still counts"
new_sandbox
wiz 'y\nn\ny\ny\nn\ny' 0.2.0
rc 0; logged 'release create v0\.2\.0'

# ============================================================================
# 27–30. the read-only modes, and what is not hard-coded
# ============================================================================
t "27 --status changes nothing, asks only read-only questions, and reports each thing"
new_sandbox
echo ghcr.io/octo/ppp-app:v0.1.0 >"$T/stub/state/images"
printf '{"name":"v0.1.0 \\u2014 First\\u001b[31m light","isDraft":false,"tagName":"v0.1.0"}\n' >"$T/stub/state/release-v0.1.0.json"
echo '[{"number":7,"headRefName":"release-0.2.0","url":"https://github.invalid/pull/7","isCrossRepository":false},
       {"number":8,"headRefName":"release-9.9.9","url":"https://github.invalid/pull/8","isCrossRepository":true},
       {"number":9,"headRefName":"feature","url":"https://github.invalid/pull/9","isCrossRepository":false}]' >"$T/stub/state/pr-open.json"
before="$(snap)"
wiz '' --status
rc 0; eq "refs and files" "$(snap)" "$before"
eq "calls outside the read-only list" \
  "$(grep -Evc '^(gh (auth status|repo view|pr list|release view)|docker buildx imagetools inspect)( |$)' "$T/stub/log")" "0"
out "v0.1.0 at $(git -C "$T/remote.git" rev-parse --short=7 'v0.1.0^{commit}')"
out "has entries (CHANGELOG.md on main)"
out "ppp-app:v0.1.0 published"; out "ppp-migrate:v0.1.0 not published"; out "ppp-storage-migrate:v0.1.0 not published"
out "v0.1.0 — First[31m light"; no_out $'\e[31m'
out "#7 release-0.2.0"; out "scripts/release-wizard.sh --continue 0.2.0"; no_out "9.9.9"; no_out "#9"

t "27 --status does not fetch: a commit and a tag that are only on the remote stay there"
new_sandbox
git clone -q "$T/remote.git" "$T/other"
( cd "$T/other" && git config user.name O && git config user.email o@example.test \
  && echo x >>docs/other.txt && git commit -q -am "Somebody else (#5)" && git tag -a v0.3.0 -m v0.3.0 \
  && git push -q origin main v0.3.0 )
before="$(git -C "$T/work" for-each-ref)"
wiz '' --status
rc 0; out "v0.3.0 at $(git -C "$T/remote.git" rev-parse --short=7 'v0.3.0^{commit}')"
eq "every ref in the clone" "$(git -C "$T/work" for-each-ref)" "$before"
nok "the remote's tag arrived in the clone" work_has refs/tags/v0.3.0

t "28 --dry-run changes nothing anywhere and prints every mutation it would make"
new_sandbox; before="$(snap)"
wiz '' --dry-run 0.2.0
rc 0; eq "refs and files" "$(snap)" "$before"; not_logged 'create'; not_logged '^full-test'
out "DRY-RUN would run: git switch -q -c release-0.2.0"
out "DRY-RUN would run: npm version 0.2.0 --no-git-tag-version"
out "DRY-RUN would rewrite CHANGELOG.md:"; out "+## v0.2.0"
out "DRY-RUN would run: git commit -q -m Prepare\\ v0.2.0"
out "DRY-RUN would run: git push -q -u origin release-0.2.0"
out "DRY-RUN would run: gh pr create --base main --head release-0.2.0"
out "DRY-RUN would run: git tag -a v0.2.0 -m v0.2.0 <merge-sha>"
out "DRY-RUN would run: git push origin refs/tags/v0.2.0"
out "DRY-RUN would run: gh release create v0.2.0 --verify-tag"

t "28 --dry-run on a dirty tree says WOULD REFUSE, carries on, and exits 1"
new_sandbox; echo x >>"$T/work/docs/other.txt"; before="$(snap)"
wiz '' --dry-run 0.2.0
rc 1; out "WOULD REFUSE: working tree is not clean"; out "DRY-RUN would run: gh release create v0.2.0"
eq "refs and files" "$(snap)" "$before"

t "R10 --dry-run with --continue is refused"
new_sandbox
wiz '' --dry-run --continue 0.2.0
rc 1; out "--dry-run is for a fresh start only"

t "29 nothing about the repository is hard-coded"
new_sandbox
echo '{"nameWithOwner":"SomeOne/fork"}' >"$T/stub/state/repo.json"
printf '%s\n' ghcr.io/someone/ppp-app:v0.2.0 ghcr.io/someone/ppp-migrate:v0.2.0 ghcr.io/someone/ppp-storage-migrate:v0.2.0 >"$T/stub/state/images"
wiz "$HAPPY" 0.2.0
rc 0
eq "gh calls without --repo SomeOne/fork" \
  "$(grep '^gh ' "$T/stub/log" | grep -Ev '^gh (auth status|repo view)' | grep -vc -- '--repo SomeOne/fork')" "0"
eq "image references outside ghcr.io/someone/" \
  "$(grep '^docker buildx imagetools inspect' "$T/stub/log" | grep -vc ' ghcr.io/someone/ppp-')" "0"
ok "the notes link to the fork" grep -qF 'https://github.com/SomeOne/fork/blob/v0.2.0/CHANGELOG.md' "$T/stub/state/notes-captured"
eq "the owner's name in the script" "$(grep -c 'danileau' "$WIZARD")" "0"
eq "the repository's name in the script" "$(grep -c 'prettypleaseprint' "$WIZARD")" "0"

t "29 PPP_REPO is used without asking gh which repository this is"
new_sandbox; EXTRA=(PPP_REPO=octo/widgets)
wiz 'n\n' 0.2.0
rc 0; not_logged '^gh repo view'

t "-h prints the header and touches nothing"
new_sandbox
wiz '' --help
rc 0; out "ppp release wizard"; out "VISUAL / EDITOR"; no_out "set -euo pipefail"
eq "calls made" "$(wc -l <"$T/stub/log" | tr -d ' ')" "0"

t "an unknown argument is refused"
wiz '' --force
rc 1; out "unknown arg: --force"

# ============================================================================
# 15 (the other half). Across every case above
# ============================================================================
new_sandbox
t "15 across every case: the wizard never merges, and no stub was asked for something unexpected"
OUT="$(grep -n 'UNEXPECTED\|pr merge' "$BASE/all-logs" | head -5)"
ok "no log was collected" test -s "$BASE/all-logs"
eq "gh pr merge calls" "$(grep -c 'pr merge' "$BASE/all-logs")" "0"
eq "unexpected stub calls" "$(grep -c 'UNEXPECTED' "$BASE/all-logs")" "0"
eq "'pr merge' in the script" "$(grep -c 'pr merge' "$WIZARD")" "0"
eq "the happy path's exit status" "$HAPPY_RC" "0"
end_case

echo
echo "release-wizard: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

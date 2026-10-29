#!/usr/bin/env bash
#
# Tests for scripts/prusa-open.sh.          bash scripts/tests/prusa-open.test.sh
#
# The helper runs on somebody's desktop: it fetches a model over HTTP and
# starts a slicer. Neither is allowed to be real here. Each case runs the real
# script with HOME, its config, its log and its download directory inside one
# temp directory, and `curl`, the slicer, `setsid`, `nohup` and `uname`
# replaced by stubs that write what they were asked to a log.
#
# PATH is exactly two directories — the stubs a case wants, and symlinks to an
# allow-list of real tools. /usr/bin and /bin are NOT on it, so whether this
# machine has setsid decides nothing: a case has it only if it puts the stub
# there. A stub that is asked for something it was not told to expect logs
# UNEXPECTED and exits 99, and the last case fails if that ever happened.
#
# PPP_TEST_SCRIPT points the suite at another copy of the script, which is how
# a deliberately broken one is shown to fail.

set -uo pipefail
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
HELPER="${PPP_TEST_SCRIPT:-$REPO_ROOT/scripts/prusa-open.sh}"

BASE="$(mktemp -d "${TMPDIR:-/tmp}/ppp-slicer-test.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

# ----- the PATH directories -----------------------------------------------------
ALLOW="bash env sed tr grep date mkdir mktemp rm mv cat head tail printf find
  basename dirname stat chmod sleep touch"
mkdir -p "$BASE/bin" "$BASE/stubs"
for tool in $ALLOW; do
  p="$(type -P "$tool")" || { echo "cannot run: $tool is not installed" >&2; exit 1; }
  ln -s "$p" "$BASE/bin/$tool"
done

# curl: answers from files in $STUB/state — the status code, the headers, the
# body — exactly the way the helper calls it (-o body -D headers -w code).
cat >"$BASE/stubs/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STUB/log"
body="" hdr=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) body="$2"; shift ;;
    -D) hdr="$2"; shift ;;
  esac
  shift
done
[ -n "$body" ] && [ -n "$hdr" ] || { echo "UNEXPECTED curl call" >>"$STUB/log"; exit 99; }
cat "$STUB/state/body" >"$body"
printf 'HTTP/1.1 %s\r\ncontent-disposition: attachment; filename="%s"\r\n\r\n' \
  "$(cat "$STUB/state/code")" "$(cat "$STUB/state/filename")" >"$hdr"
cat "$STUB/state/code"
STUB

# The slicer: records its arguments, takes a moment like a real one, then says
# it is done — so a case can tell whether the helper waited for it.
cat >"$BASE/stubs/slicer" <<'STUB'
#!/usr/bin/env bash
printf 'slicer %s\n' "$*" >>"$STUB/log"
sleep 0.3
printf 'slicer done\n' >>"$STUB/log"
exit "$(cat "$STUB/state/slicer-rc" 2>/dev/null || echo 0)"
STUB

for tool in setsid nohup; do
  cat >"$BASE/stubs/$tool" <<STUB
#!/usr/bin/env bash
printf '$tool %s\n' "\$*" >>"\$STUB/log"
exec "\$@"
STUB
done

cat >"$BASE/stubs/uname" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-s" ] || { echo "UNEXPECTED uname $*" >>"$STUB/log"; exit 99; }
cat "$STUB/state/uname"
STUB

# What puts a failure on screen, one per platform. Each records what it was
# given, one line per argument; PowerShell's message arrives in the environment,
# so its stub records that too.
for tool in notify-send osascript powershell.exe; do
  cat >"$BASE/stubs/$tool" <<STUB
#!/usr/bin/env bash
printf '$tool\n' >>"\$STUB/log"
for a in "\$@"; do printf '  arg %s\n' "\$a" >>"\$STUB/log"; done
[ -z "\${PPP_ALERT_TITLE:-}" ] || printf '  env title %s\n' "\$PPP_ALERT_TITLE" >>"\$STUB/log"
[ -z "\${PPP_ALERT_TEXT:-}" ] || printf '  env text %s\n' "\$PPP_ALERT_TEXT" >>"\$STUB/log"
STUB
done
chmod +x "$BASE"/stubs/*

# ----- one sandbox per case -----------------------------------------------------
# with=…  the stubs this case puts on PATH besides curl, the slicer and uname.
new_sandbox() {
  T="$(mktemp -d "$BASE/case.XXXXXX")"
  mkdir -p "$T/home/.config/ppp" "$T/path" "$T/stub/state"
  : >"$T/stub/log"
  for tool in curl slicer uname "$@"; do ln -s "$BASE/stubs/$tool" "$T/path/$tool"; done
  printf 'PPP_BASE="https://print.invalid"\nPPP_SLICER="slicer"\n' >"$T/home/.config/ppp/slicer.conf"
  printf '200' >"$T/stub/state/code"
  printf 'Linux\n' >"$T/stub/state/uname"
  printf 'clip.stl' >"$T/stub/state/filename"
  printf 'solid clip\nendsolid clip\n' >"$T/stub/state/body"
}
open_link() {
  OUT="$(
    env -i HOME="$T/home" PATH="$T/path:$BASE/bin" STUB="$T/stub" TMPDIR="$T" \
      bash "$HELPER" "$1" 2>&1 </dev/null
  )"
  RC=$?
  HLOG="$(cat "$T/home/.local/state/ppp/slicer.log" 2>/dev/null)"
}
saved_model() { find "$T/home/.cache/ppp/models" -type f 2>/dev/null | head -1; }
settle() { sleep 0.6; } # long enough for a detached slicer stub to finish

# ----- assertions ---------------------------------------------------------------
PASSED=0; FAILED=0; CASE=""; CASE_OK=1; DETAIL=""; OUT=""; HLOG=""
t() { end_case; CASE="$1"; CASE_OK=1; DETAIL=""; }
end_case() {
  [ -n "$CASE" ] || return 0
  cat "$T/stub/log" >>"$BASE/all-logs" 2>/dev/null
  if [ "$CASE_OK" -eq 1 ]; then
    PASSED=$((PASSED + 1)); echo "ok   $CASE"
  else
    FAILED=$((FAILED + 1)); echo "FAIL $CASE"; printf '%b' "$DETAIL"
    echo "     --- helper log ---"; printf '%s\n' "$HLOG" | tail -8 | sed 's/^/     /'
    echo "     --- helper stderr ---"; printf '%s\n' "$OUT" | tail -4 | sed 's/^/     /'
  fi
  CASE=""
}
no() { CASE_OK=0; DETAIL+="     - $1\n"; }
rc() { [ "$RC" -eq "$1" ] || no "exit status $RC, wanted $1"; }
called() { grep -Eq -- "$1" "$T/stub/log" || no "stub log lacks: $1"; }
not_called() { if grep -Eq -- "$1" "$T/stub/log"; then no "stub log has: $1"; fi; }
noted() { case "$HLOG" in *"$1"*) ;; *) no "helper log lacks: $1" ;; esac; }
not_noted() { case "$HLOG" in *"$1"*) no "helper log has: $1" ;; esac; }
eq() { [ "$2" = "$3" ] || no "$1: got '$2', wanted '$3'"; }

LINK='ppp://slice/4?t=abc.DEF-_1'

# ============================================================================
# how the slicer is started
# ============================================================================
t "with setsid: the slicer is detached with it, --single-instance and the saved file"
new_sandbox setsid
open_link "$LINK"; settle
rc 0; called '^setsid slicer --single-instance .*/PPP-104-clip\.stl$'; not_called '^nohup '
noted "handed off story 4"; eq "the saved model" "$(basename "$(saved_model)")" "PPP-104-clip.stl"

t "Git Bash without setsid: the slicer runs in the foreground, and has finished when the helper returns"
new_sandbox; printf 'MINGW64_NT-10.0-26200\n' >"$T/stub/state/uname"
open_link "$LINK"
rc 0; called '^slicer --single-instance .*/PPP-104-clip\.stl$'; called '^slicer done$'
not_called '^(setsid|nohup) '; noted "running the slicer in the foreground"; noted "handed off story 4"

t "Git Bash: a slicer that fails in the foreground is a loud failure, not 'handed off'"
new_sandbox; printf 'MSYS_NT-10.0\n' >"$T/stub/state/uname"; printf '3' >"$T/stub/state/slicer-rc"
open_link "$LINK"
rc 1; noted "ERROR: the slicer exited with status 3"; not_noted "handed off"

t "macOS without setsid: the slicer is detached with nohup"
new_sandbox nohup; printf 'Darwin\n' >"$T/stub/state/uname"
open_link "$LINK"; settle
rc 0; called '^nohup slicer --single-instance .*/PPP-104-clip\.stl$'; called '^slicer done$'
noted "detaching the slicer with nohup"; noted "handed off story 4"

# ============================================================================
# which slicer
# ============================================================================
# conf …  replaces the config with PPP_BASE and the given lines.
conf() { { printf 'PPP_BASE="https://print.invalid"\n'; printf '%s\n' "$@"; } >"$T/home/.config/ppp/slicer.conf"; }
# A slicer installed where Windows puts them: under a directory with a space.
spaced_slicer() {
  mkdir -p "$T/Program Files/ElegooSlicer"
  cp "$BASE/stubs/slicer" "$T/Program Files/ElegooSlicer/elegoo-slicer.exe"
  SPACED="$T/Program Files/ElegooSlicer/elegoo-slicer.exe"
}

t "elegoo, by a path with spaces: the slicer gets the file alone, without --single-instance"
new_sandbox setsid; spaced_slicer
conf 'PPP_SLICER_PROFILE=elegoo' "PPP_SLICER_PATH=\"$SPACED\""
open_link "$LINK"; settle
rc 0; called '^setsid .*/Program Files/ElegooSlicer/elegoo-slicer\.exe .*/PPP-104-clip\.stl$'
called '^slicer .*/PPP-104-clip\.stl$'; not_called 'single-instance'; noted "handed off story 4"

t "elegoo under Git Bash: the foreground run passes no empty argument and no --single-instance"
new_sandbox; spaced_slicer; printf 'MINGW64_NT-10.0\n' >"$T/stub/state/uname"
conf 'PPP_SLICER_PROFILE=elegoo' "PPP_SLICER_PATH=\"$SPACED\""
open_link "$LINK"
rc 0; called '^slicer /.*/PPP-104-clip\.stl$'; called '^slicer done$'; not_called 'single-instance'

t "a profile nobody knows is refused by name, before anything is fetched"
new_sandbox setsid; conf 'PPP_SLICER_PROFILE=prussa' 'PPP_SLICER="slicer"'
open_link "$LINK"
rc 1; noted "PPP_SLICER_PROFILE=prussa"; noted "Known: prusa, orca, elegoo, bambu, cura"
not_called '^curl '; not_called '^(setsid|slicer) '

t "orca with no location says which setting to fill in, rather than guessing"
new_sandbox setsid; conf 'PPP_SLICER_PROFILE=orca'
open_link "$LINK"
rc 1; noted "where is OrcaSlicer? Set PPP_SLICER_PATH"; not_called '^curl '

t "PPP_SLICER and PPP_SLICER_PATH together are refused"
new_sandbox setsid; spaced_slicer; conf 'PPP_SLICER="slicer"' "PPP_SLICER_PATH=\"$SPACED\""
open_link "$LINK"
rc 1; noted "sets both PPP_SLICER and PPP_SLICER_PATH"; not_called '^curl '

# ============================================================================
# a failure reaches the screen
# ============================================================================
t "Linux: a failure is a notify-send notification, and notify-send wins over the others"
new_sandbox setsid notify-send osascript powershell.exe; printf '401' >"$T/stub/state/code"
open_link "$LINK"
rc 1; called '^notify-send$'; called '^  arg Open in PrusaSlicer failed$'
called '^  arg that link has expired \(HTTP 401\)'; not_called '^(osascript|powershell\.exe)$'

t "macOS: osascript, with the title and the message as arguments of their own"
new_sandbox nohup osascript powershell.exe; conf 'PPP_SLICER_PROFILE=elegoo' 'PPP_SLICER="slicer"'
printf '401' >"$T/stub/state/code"
open_link "$LINK"
rc 1; called '^osascript$'; called '^  arg Open in ElegooSlicer failed$'
called '^  arg that link has expired'; not_called '^powershell\.exe$'
# Nobody here has a Mac, so the AppleScript is pinned as written: item 1 is
# the title, item 2 the message, in that order after the script.
eq "osascript's arguments" "$(sed -n '/^osascript$/,$p' "$T/stub/log" | sed -n '2,7p' | cut -c1-60)" \
"  arg -e
  arg on run argv
  arg -e
  arg display notification (item 2 of argv) with title (item
  arg -e
  arg end run"
eq "the two after it" "$(sed -n '/^  arg end run$/{n;p;n;p;}' "$T/stub/log" | cut -c1-38)" \
"  arg Open in ElegooSlicer failed
  arg that link has expired (HTTP 401)"

t "Windows: a PowerShell message box, and a hostile link reaches it only through the environment"
new_sandbox powershell.exe; printf 'MINGW64_NT-10.0\n' >"$T/stub/state/uname"
# shellcheck disable=SC2016 # the $( … ) is the hostile text, meant literally
open_link 'ppp://slice/4;$(touch pwned)";Start-Process calc;"?t=x'
rc 1; called '^powershell\.exe$'; called '^  env title Open in PrusaSlicer failed$'
called '^  env text not a model link: ppp://slice/4;\$\(touch pwned\)";Start-Process calc'
# shellcheck disable=SC2016 # PowerShell's $variables, not bash's
called '^  arg .*\.Popup\(\$env:PPP_ALERT_TEXT, 0, \$env:PPP_ALERT_TITLE, 0x1010\)$'
not_called '^  arg .*(ppp://|pwned|calc)'; not_called '^(setsid|slicer) '

t "no PPP_BASE: said in the log and on screen, not on stderr alone"
new_sandbox setsid notify-send; printf 'PPP_SLICER="slicer"\n' >"$T/home/.config/ppp/slicer.conf"
open_link "$LINK"
rc 1; noted "ERROR: PPP_BASE is not set in"; called '^  arg PPP_BASE is not set in'; not_called '^curl '

# ============================================================================
# what this change must not have moved
# ============================================================================
t "a link that is not a model id opens nothing and fetches nothing"
new_sandbox setsid
open_link 'ppp://slice/4;rm?t=x'
rc 1; noted "not a model link"; not_called '^curl '; not_called '^(setsid|slicer) '

t "an expired link is said in words, and no slicer starts"
new_sandbox setsid; printf '401' >"$T/stub/state/code"
open_link "$LINK"
rc 1; noted "that link has expired (HTTP 401)"; not_called '^(setsid|slicer) '

# ============================================================================
# the checkout itself
# ============================================================================
t "every shell script in the repository is LF, and .gitattributes keeps it so"
bad="$(cd "$REPO_ROOT" && grep -lI $'\r' scripts/*.sh scripts/tests/*.sh .githooks/pre-commit 2>/dev/null)"
eq "scripts with CRLF" "$bad" ""
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  for f in scripts/prusa-open.sh scripts/tests/prusa-open.test.sh .githooks/pre-commit; do
    eq "eol attribute of $f" "$(git -C "$REPO_ROOT" check-attr eol -- "$f" | sed 's/.*: //')" "lf"
  done
fi

t "the scripts people run directly are still executable in the index"
# A file rewritten by an editor on another OS comes back 0644, and git records
# that as a change like any other — the installer's own instruction,
# ./scripts/install-slicer-handler.sh, then fails with "permission denied".
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  for f in scripts/prusa-open.sh scripts/install-slicer-handler.sh; do
    eq "index mode of $f" "$(git -C "$REPO_ROOT" ls-files -s -- "$f" | cut -d' ' -f1)" "100755"
  done
fi

t "across every case: no stub was asked for something it did not expect"
[ -s "$BASE/all-logs" ] || no "no stub log was collected"
eq "unexpected stub calls" "$(grep -c 'UNEXPECTED' "$BASE/all-logs")" "0"
end_case

echo
echo "prusa-open: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

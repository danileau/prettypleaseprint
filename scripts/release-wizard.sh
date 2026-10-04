#!/usr/bin/env bash
#
# ppp release wizard — cuts a release from a checkout, one confirmed step at a
# time.
#
# Runs ON A DEVELOPER MACHINE, in a clone of the repository. A release here is
# a name for a commit that is already on main, so nothing is built: the wizard
# prepares a pull request, waits for a person to merge it, names the merge
# commit and publishes the notes. The deploy wizard is its counterpart on the
# host and picks up where this one stops.
#
# The steps, and what each one is there to prevent:
#   1. PREFLIGHT   clean tree, on main, main level with the remote, and nothing
#      in the way of the full test — found out before a branch exists, not
#      after the changelog has been rewritten.
#   2. VERSION     suggests patch or minor from what is in `## Unreleased`, and
#      refuses a version that has been started before: a tag, a branch, a pull
#      request in any state, or a main that already carries it. One version is
#      prepared once; anything else is `--continue`.
#   3. PREPARE     the release branch, the changelog section, the version in
#      package.json and the lockfile, the example tag in the README and the
#      deployment guide.
#   4. TEST        scripts/full-test.sh, the whole of it.
#   5. PULL REQUEST  commit, push, open it, then WAIT. This tool never merges:
#      the owner does, in the browser, after reading it.
#   6. TAG         the merge commit BY ITS SHA, as GitHub reports it — never
#      "main", which may have moved, and never a local branch, which may be
#      stale. Only once CI is green on that commit.
#   7. IMAGES      waits for the tag's release-images run to finish
#      successfully and for every image to exist under the version. The run,
#      not just the images: they are pushed a minute before they are signed,
#      and the deploy wizard refuses an unsigned image.
#   8. PUBLISH     the GitHub release, with notes cut from the changelog: the
#      summary, the Upgrading section, and a link to the rest. The Upgrading
#      heading matters — the deploy wizard shows it to whoever upgrades.
#
# There is no state file. Where a release has got to is read from git and
# GitHub every time, so `--continue` works from another clone, after a reboot,
# or a week later, and cannot disagree with reality.
#
# Usage:
#   scripts/release-wizard.sh [X.Y.Z]            # start a release
#   scripts/release-wizard.sh --continue X.Y.Z   # resume wherever X.Y.Z got to
#   scripts/release-wizard.sh --status           # read-only: where things stand
#   scripts/release-wizard.sh --dry-run [X.Y.Z]  # print what a fresh start would do
#
# Four things are asked before they happen: preparing the branch; committing,
# pushing and opening the pull request; pushing the tag; publishing the
# release. Anything but "y" stops there, and Ctrl-C while it waits is safe.
#
# Environment:
#   PPP_REMOTE          git remote NAME to release to (default origin)
#   PPP_REPO            owner/name on GitHub (default: asked of gh)
#   PPP_POLL_INTERVAL   seconds between polls (default 30)
#   PPP_PR_TIMEOUT      seconds to wait for the merge; 0 waits forever (default)
#   PPP_IMAGES_TIMEOUT  seconds to wait for CI, and again for the images (1800)
#   PPP_RELEASE_TITLE   the text after "vX.Y.Z — " in the release title
#   VISUAL / EDITOR     for the changelog and the notes (default vi)

set -euo pipefail

# ----- config ---------------------------------------------------------------
REMOTE="${PPP_REMOTE:-origin}"
REPO="${PPP_REPO:-}"
POLL="${PPP_POLL_INTERVAL:-30}"
PR_TIMEOUT="${PPP_PR_TIMEOUT:-0}"
IMAGES_TIMEOUT="${PPP_IMAGES_TIMEOUT:-1800}"
# Test seams. PPP_FULL_TEST_CMD replaces the full test, and says so every time
# it does, because a release cut on `true` has not been tested.
TODAY="${PPP_RELEASE_DATE:-$(date +%Y-%m-%d)}"
FULL_TEST_CMD="${PPP_FULL_TEST_CMD:-}"

# The only files a release commit is expected to touch.
RELEASE_FILES="CHANGELOG.md package.json package-lock.json README.md docs/deployment.md"
EXAMPLE_FILES="README.md docs/deployment.md"
WORKFLOW=".github/workflows/release-images.yml"

# ----- pretty ---------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
  RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; CYN=$'\e[36m'
else
  B=""; DIM=""; R=""; RED=""; GRN=""; YLW=""; CYN=""
fi
die()  { echo "${RED}✗ $*${R}" >&2; exit 1; }
warn() { echo "${YLW}⚠ $*${R}"; }
hr()   { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────────${R}"; }

# ----- args -----------------------------------------------------------------
MODE="start"; DRY_RUN=0; VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --continue) MODE="continue"; VERSION="${2:?--continue needs a version}"; shift 2 ;;
    --status) MODE="status"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,58p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown arg: $1" ;;
    *) [ -z "$VERSION" ] || die "one version at a time: $VERSION, $1"; VERSION="$1"; shift ;;
  esac
done
# A dry run of a resume would have to pretend about state it reads from
# GitHub. --status answers that question honestly instead.
[ "$DRY_RUN" -eq 1 ] && [ "$MODE" != "start" ] \
  && die "--dry-run is for a fresh start only; --status shows where a release stands"
VERSION="${VERSION#v}"

# ----- the four primitives ---------------------------------------------------
# Everything that changes anything goes through run() or write_file(), so a
# dry run cannot drift from the real thing: it is the same code path, printed.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN would run:'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

# write_file <path> <new content in a temp file>
write_file() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN would rewrite $1:"
    diff -u "$1" "$2" || true
    return 0
  fi
  cat "$2" >"$1"
}

RESUME=""
resume_hint() { [ -z "$RESUME" ] || echo "resume with: $RESUME"; }
abort() { echo "aborted."; resume_hint; exit 0; }

# ask "<question>" — the answer lands in $ans. End of input is not an answer:
# under `set -e` a bare `read` at EOF ends the script with no message at all,
# which is the failure CONTRIBUTING.md names. So it is said, and it is exit 1,
# because a wizard that ran out of input did not do what it was started for.
ans=""
ask() {
  printf '%s ' "$1"
  ans=""
  if ! { read -r ans || [ -n "$ans" ]; }; then
    echo
    echo "aborted (no input)."
    resume_hint
    exit 1
  fi
}
said_yes() { case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac; }
# confirm "<question>" — one of the gates. Anything but yes stops, exit 0.
confirm() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "$1 ${DIM}(dry run: assuming yes)${R}"; return 0; fi
  ask "$1"
  said_yes || abort
}

# In a dry run a preflight failure is reported and the walk continues, so one
# run shows everything that is in the way; the exit status still says no.
REFUSED=0
refuse() {
  if [ "$DRY_RUN" -eq 1 ]; then echo "${YLW}WOULD REFUSE: $*${R}"; REFUSED=1; return 0; fi
  die "$@"
}

# ----- reading JSON and markdown ---------------------------------------------
# gh is always asked for --json and never for --jq, and docker for its JSON
# manifest, so everything that interprets a reply is here, in one place, and
# the tests can stand in for both tools with canned files.
read -r -d '' PY <<'PYEOF' || true
import json, re, sys

UPGRADING = re.compile(r"^(#{1,6})[ \t]+Upgrading\b", re.I)
HEADING = re.compile(r"^(#{1,6})[ \t]+\S")
FENCE = re.compile(r"^(```|~~~)")
SEP = "\x1f"

def fail(msg, code=1):
    sys.stderr.write(msg + "\n")
    sys.exit(code)

def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()

def trim(lines):
    lines = list(lines)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines

def split_unreleased(text):
    lines = text.split("\n")
    at = [i for i, l in enumerate(lines) if l == "## Unreleased"]
    if len(at) != 1:
        fail("CHANGELOG.md has %d '## Unreleased' headings; exactly one is needed" % len(at), 2)
    start, end = at[0], len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(r"^## v[0-9]", lines[i]):
            end = i
            break
    return lines[:start], trim(lines[start + 1:end]), lines[end:]

def headings(lines):
    # (index, level, line) for every heading that is not inside a code fence:
    # a "# comment" in a shell example is not a heading.
    fenced = False
    for i, l in enumerate(lines):
        if FENCE.match(l):
            fenced = not fenced
            continue
        if not fenced:
            m = HEADING.match(l)
            if m:
                yield i, len(m.group(1)), l

def upgrading(lines):
    # Every section opened by a heading that starts with "Upgrading", at any
    # level, up to the next heading of the same or a higher level.
    out, hs = [], list(headings(lines))
    for n, (i, level, l) in enumerate(hs):
        if not UPGRADING.match(l):
            continue
        end = len(lines)
        for j, lv, _ in hs[n + 1:]:
            if lv <= level:
                end = j
                break
        if out:
            out.append("")
        out.extend(trim(lines[i:end]))
    return out

def section(text, version):
    lines = text.split("\n")
    for i, l in enumerate(lines):
        if l == "## v" + version:
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if lines[j].startswith("## "):
                    end = j
                    break
            return trim(lines[i + 1:end])
    return None

def cmd_unreleased(path):
    _, body, _ = split_unreleased(read(path))
    if not body or body == ["Nothing yet."]:
        sys.exit(3)
    sys.stdout.write("\n".join(body) + "\n")

def cmd_has_upgrading():
    sys.exit(0 if upgrading(sys.stdin.read().split("\n")) else 1)

def cmd_prepare(path, version, date, last, *migrations):
    head, body, tail = split_unreleased(read(path))
    stub = []
    if migrations and not upgrading(body):
        n = len(migrations)
        stub = [
            "### Upgrading from " + last,
            "",
            "<!-- TODO(release): say what someone deploying this must do, then delete this line. -->",
            "",
            ("- **%d database migration%s**, in the `migrate` container:"
             % (n, " runs by itself" if n == 1 else "s run by themselves")),
            "  " + ", ".join("`%s`" % m for m in migrations) + ".",
            "",
        ]
    new = head + ["## Unreleased", "", "Nothing yet.", "", "## v" + version, "", date + ".", ""]
    new += stub + body + [""] + tail
    sys.stdout.write("\n".join(new))

def cmd_examples(path, last, new, out):
    # Only where the old version is plainly an example to copy: an image
    # reference, or a line about PPP_TAG. A sentence that mentions the last
    # release by name is history and stays as it is.
    old = re.compile(re.escape(last) + r"(?![\w.-]*\w)")
    image = re.compile(r"ppp-[a-z-]*:" + re.escape(last) + r"(?![\w.-]*\w)")
    count, lines = 0, read(path).split("\n")
    for i, l in enumerate(lines):
        if image.search(l) or "PPP_TAG" in l:
            lines[i], n = old.subn(new, l)
            count += n
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(lines))
    print(count)

def cmd_section(version):
    sec = section(sys.stdin.read(), version)
    if sec is None:
        sys.exit(1)
    sys.stdout.write("\n".join(sec) + "\n")

def cmd_notes(version, repo):
    sec = section(sys.stdin.read(), version)
    if sec is None:
        fail("no '## v%s' section in the changelog" % version)
    first = next((i for i, _, _ in headings(sec)), len(sec))
    out = trim(sec[:first])
    up = upgrading(sec)
    if up:
        out += [""] + up
    base = "https://github.com/%s/blob/v%s/" % (repo, version)
    def absolute(m):
        target = m.group(1)
        if target.startswith("#") or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
            return m.group(0)
        return "](" + base + re.sub(r"^(\./|/)+", "", target) + ")"
    text = re.sub(r"\]\(([^()\s]+)\)", absolute, "\n".join(out))
    sys.stdout.write(text + "\n\nEverything, entry by entry: " + base + "CHANGELOG.md\n")

def cmd_pkg_version():
    print(json.load(sys.stdin).get("version", ""))

def cmd_field(name):
    v = json.load(sys.stdin).get(name)
    if isinstance(v, bool):
        v = "true" if v else "false"
    print("" if v is None else v)

def cmd_pr_pick():
    # Pull requests from forks are skipped: anyone can open one from a branch
    # that happens to be called release-X.Y.Z, and it is not this release.
    prs = [p for p in json.load(sys.stdin) if not p.get("isCrossRepository")]
    live = [p for p in prs if p.get("state") in ("OPEN", "MERGED")]
    if len(live) > 1:
        print(SEP.join(["MULTIPLE", ",".join("#%s" % p.get("number") for p in live), "", "", "", ""]))
        return
    pick = live[0] if live else (max(prs, key=lambda p: p.get("number") or 0) if prs else None)
    if pick is None:
        print(SEP.join(["NONE", "", "", "", "", ""]))
        return
    print(SEP.join(str(x) for x in [
        pick.get("state") or "", pick.get("number") or "", pick.get("url") or "",
        (pick.get("mergeCommit") or {}).get("oid") or "", pick.get("headRefOid") or "",
        pick.get("baseRefName") or ""]))

def cmd_run_pick(branch=None):
    runs = json.load(sys.stdin)
    if branch is not None:
        runs = [r for r in runs if r.get("headBranch") == branch]
    if not runs:
        print(SEP.join(["none", "", ""]))
        return
    r = max(runs, key=lambda r: r.get("createdAt") or "")
    print(SEP.join([r.get("status") or "", r.get("conclusion") or "", r.get("url") or ""]))

def cmd_open_prs():
    for p in json.load(sys.stdin):
        head = p.get("headRefName") or ""
        if p.get("isCrossRepository") or not re.match(r"^release-[0-9]+\.[0-9]+\.[0-9]+$", head):
            continue
        print(SEP.join(str(x) for x in [p.get("number") or "", head, p.get("url") or ""]))

def cmd_clean_title():
    # A release title is remote input on its way to a terminal: no control
    # characters, no bidi overrides.
    t = sys.stdin.read()
    print("".join(c for c in t if not (ord(c) < 0x20 or 0x7f <= ord(c) <= 0x9f
          or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069)))

cmd = sys.argv[1].replace("-", "_")
globals()["cmd_" + cmd](*sys.argv[2:])
PYEOF
py() { python3 -c "$PY" "$@"; }

# ----- git and registry helpers ----------------------------------------------
# Remote truth comes from ls-remote, never from refs/remotes/*: a tracking ref
# is this clone's memory of the remote, and a release must not be cut from a
# memory.
remote_ref() {
  local out
  out="$(git ls-remote "$REMOTE" "$1")" || die "could not reach the remote $REMOTE"
  printf '%s\n' "$out" | awk 'NR == 1 { print $1 }'
}
# The commit a remote tag names: the peeled value of an annotated tag, or the
# plain ref of a lightweight one. Empty when there is no such tag.
remote_tag_commit() {
  local out
  out="$(git ls-remote "$REMOTE" "refs/tags/$1" "refs/tags/$1^{}")" || die "could not reach the remote $REMOTE"
  printf '%s\n' "$out" | awk '$2 ~ /\^\{\}$/ { peeled = $1 } $2 !~ /\^\{\}$/ { plain = $1 }
    END { print (peeled != "" ? peeled : plain) }'
}
# highest_tag [remote-only] — the highest vX.Y.Z. Filtered in awk: no tags at
# all is a case with a message of its own, not a pipeline failure.
highest_tag() {
  local out
  out="$(git ls-remote --tags "$REMOTE")" || die "could not reach the remote $REMOTE"
  {
    printf '%s\n' "$out" | awk '{ sub("refs/tags/", "", $2); sub(/\^\{\}$/, "", $2); print $2 }'
    [ "${1:-}" = "remote-only" ] || git tag -l
  } | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/' | sort -V -u | tail -1
}
ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
short() { printf '%s' "${1:0:7}"; }

# Asked of the workflow as it was at the commit being released, so the list
# cannot drift from what that commit actually publishes.
images_at() {
  local list
  list="$(git show "$1:$WORKFLOW" 2>/dev/null | sed -n 's/^ *- name: \(ppp-[a-z0-9-]*\) *$/\1/p' | tr '\n' ' ')" || true
  list="${list% }"
  [ -n "$list" ] || die "could not read the image names from $WORKFLOW at $(short "$1")"
  printf '%s\n' "$list"
}
image_exists() {
  local out
  out="$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null)" || return 1
  [ -n "$(printf '%s' "$out" | py field digest 2>/dev/null || true)" ]
}

# pr_lookup — the pull request for $BRANCH, into PR_*. PR_STATE is NONE when
# there is none; a closed one is only reported when nothing open or merged
# exists, so an abandoned first attempt does not shadow the real one.
pr_lookup() {
  local json line
  json="$(gh pr list --repo "$REPO" --head "$BRANCH" --state all \
    --json number,state,url,mergeCommit,headRefOid,baseRefName,isCrossRepository)" \
    || die "could not list pull requests on $REPO"
  line="$(printf '%s' "$json" | py pr-pick)" || die "could not read gh's pull request list"
  IFS=$'\x1f' read -r PR_STATE PR_NUMBER PR_URL PR_MERGE PR_HEAD PR_BASE <<<"$line"
  [ "$PR_STATE" != "MULTIPLE" ] \
    || die "more than one open or merged pull request has the head $BRANCH: $PR_NUMBER — sort that out by hand"
}
# release_state — none, draft or published.
release_state() {
  local json
  json="$(gh release view "$1" --repo "$REPO" --json name,isDraft,tagName 2>/dev/null)" || { echo none; return 0; }
  if [ "$(printf '%s' "$json" | py field isDraft)" = "true" ]; then echo draft; else echo published; fi
}

edit() {
  # Deliberately word-split: EDITOR="code -w" is a command and an argument.
  # shellcheck disable=SC2086
  ${VISUAL:-${EDITOR:-vi}} "$1"
}

nas_line() {
  echo "${GRN}✓ $TAG is released.${R}"
  echo "On the NAS, in the deployment directory:"
  echo "    ./deploy-wizard.sh          # choose $TAG"
}

# ----- common preflight -------------------------------------------------------
NEEDED="git gh docker node npm python3"
[ "$MODE" = "status" ] && NEEDED="git gh docker python3"
for t in $NEEDED; do
  command -v "$t" >/dev/null || die "$t required"
done
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)" \
  || die "this script has to live in a checkout of the repository"
cd "$ROOT"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
git remote get-url "$REMOTE" >/dev/null 2>&1 \
  || die "no git remote called $REMOTE — PPP_REMOTE takes a remote name, not a URL"
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner | py field nameWithOwner)" \
    || die "could not ask gh which repository this is — set PPP_REPO=owner/name"
fi
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "not a repository: '$REPO' (want owner/name)"
# ghcr.io names are lower case whatever the account is called.
REGISTRY="ghcr.io/$(printf '%s' "${REPO%%/*}" | tr '[:upper:]' '[:lower:]')"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ppp-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ============================================================================
# --status
# ============================================================================
# Reads only: no fetch, no file written. It is what to run when unsure whether
# a release finished.
do_status() {
  local last commit branch rc=0 img state title json line n head url any=0
  echo "${B}ppp release status${R}  ${DIM}· $REPO${R}"
  hr
  last="$(highest_tag remote-only)"
  if [ -z "$last" ]; then
    echo "${B}Last tag:${R}      none on $REMOTE yet"
  else
    commit="$(remote_tag_commit "$last")"
    echo "${B}Last tag:${R}      ${CYN}$last${R} at $(short "$commit")"
  fi

  branch="$(git symbolic-ref --short -q HEAD || echo "a detached HEAD")"
  py unreleased CHANGELOG.md >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) echo "${B}Unreleased:${R}    has entries ${DIM}(CHANGELOG.md on $branch)${R}" ;;
    3) echo "${B}Unreleased:${R}    nothing yet ${DIM}(CHANGELOG.md on $branch)${R}" ;;
    *) echo "${B}Unreleased:${R}    ${YLW}could not read the section in CHANGELOG.md${R}" ;;
  esac

  if [ -n "$last" ]; then
    # The workflow as it stood at the tag, if this clone has that commit;
    # otherwise as it stands here. --status does not fetch to find out.
    local at="HEAD"
    git cat-file -e "$commit^{commit}" 2>/dev/null && at="$commit"
    for img in $(images_at "$at"); do
      if image_exists "$REGISTRY/$img:$last"; then
        echo "${B}Image:${R}         $img:$last ${GRN}published${R}"
      else
        echo "${B}Image:${R}         $img:$last ${YLW}not published${R}"
      fi
    done
    json="$(gh release view "$last" --repo "$REPO" --json name,isDraft,tagName 2>/dev/null)" || json=""
    if [ -z "$json" ]; then
      echo "${B}Release:${R}       ${YLW}no GitHub release for $last${R} — scripts/release-wizard.sh --continue ${last#v}"
    else
      title="$(printf '%s' "$json" | py field name | py clean-title)"
      state=""
      [ "$(printf '%s' "$json" | py field isDraft)" = "true" ] && state=" ${YLW}(still a draft)${R}"
      echo "${B}Release:${R}       $title$state"
    fi
  fi

  json="$(gh pr list --repo "$REPO" --state open --json number,headRefName,url,isCrossRepository)" \
    || die "could not list pull requests on $REPO"
  while IFS=$'\x1f' read -r n head url; do
    [ -n "$n" ] || continue
    any=1
    echo "${B}In progress:${R}   #$n $head  $url"
    echo "               scripts/release-wizard.sh --continue ${head#release-}"
  done <<<"$(printf '%s' "$json" | py open-prs)"
  [ "$any" -eq 1 ] || echo "${B}In progress:${R}   no open release pull request"
}

if [ "$MODE" = "status" ]; then
  do_status
  exit 0
fi

# ============================================================================
# The steps
# ============================================================================

# ----- 1. preflight (fresh start only) ---------------------------------------
step_preflight() {
  local dirty branch local_main remote_main
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    refuse "working tree is not clean:"$'\n'"$dirty"
  fi
  branch="$(git symbolic-ref --short -q HEAD || echo "a detached HEAD")"
  [ "$branch" = "main" ] || refuse "on $branch; a release starts from main"

  # The tags too: the last release is worked out from them, and the diff since
  # it needs the tagged commit to be here. Skipped in a dry run, because even
  # a fetch writes refs.
  run git fetch -q --tags "$REMOTE" "+refs/heads/main:refs/remotes/$REMOTE/main" \
    || die "git fetch from $REMOTE failed"
  remote_main="$(remote_ref refs/heads/main)"
  local_main="$(git rev-parse -q --verify refs/heads/main || true)"
  [ -n "$remote_main" ] || die "$REMOTE has no main branch"
  if [ "$local_main" != "$remote_main" ]; then
    refuse "local main ($(short "${local_main:-none}")) is not $REMOTE/main ($(short "$remote_main")) — pull or push first"
  fi

  # Asked now rather than at step 4: a stack that is in the way is in the way
  # before a branch exists and the changelog has been rewritten, too.
  if [ -n "$FULL_TEST_CMD" ]; then
    warn "full test replaced by PPP_FULL_TEST_CMD=$FULL_TEST_CMD — its preflight was skipped"
  elif ! scripts/full-test.sh --preflight </dev/null; then
    refuse "the full test could not run here (see above) — nothing was touched"
  fi
}

# ----- 2. version -------------------------------------------------------------
step_version() {
  local main_pkg rc=0 count default patch minor major rest why=""
  LAST="$(highest_tag)"
  [ -n "$LAST" ] || die "no v* tag found — the first release is cut by hand"
  LAST_SHA="$(git rev-parse -q --verify "refs/tags/$LAST^{commit}" || true)"
  [ -n "$LAST_SHA" ] || LAST_SHA="$(remote_tag_commit "$LAST")"
  git cat-file -e "$LAST_SHA^{commit}" 2>/dev/null \
    || die "$LAST is not in this clone — run: git fetch $REMOTE --tags"

  # A main that is ahead of every tag is a release that was prepared and
  # merged but never tagged. Starting another on top of it would publish two
  # versions' worth of changes under one name and leave the first forever
  # untagged.
  main_pkg="$(git show "HEAD:package.json" | py pkg-version)" || die "could not read package.json"
  if ver_gt "v$main_pkg" "$LAST"; then
    die "main is already at $main_pkg (package.json) and there is no v$main_pkg tag — that release was started and not finished. Resume with: release-wizard.sh --continue $main_pkg"
  fi

  UNRELEASED="$(py unreleased CHANGELOG.md)" || rc=$?
  case "$rc" in
    0) ;;
    3) die "## Unreleased is empty — there is nothing to release" ;;
    *) die "could not read ## Unreleased in CHANGELOG.md" ;;
  esac

  NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$LAST_SHA" HEAD -- prisma/migrations \
    | awk -F/ 'NF >= 4 { print $3 }' | sort -u | tr '\n' ' ')"
  NEW_MIGRATIONS="${NEW_MIGRATIONS% }"
  HAS_UPGRADING=0
  printf '%s\n' "$UNRELEASED" | py has-upgrading && HAS_UPGRADING=1
  count="$(git rev-list --count "$LAST_SHA..HEAD")"
  set -- $NEW_MIGRATIONS
  echo "${B}Last release:${R} ${CYN}$LAST${R}  ${DIM}· $count commit(s) since · $# new migration(s)${R}"

  if [ -z "$VERSION" ]; then
    major="${LAST#v}"; major="${major%%.*}"
    rest="${LAST#v*.}"; minor="${rest%%.*}"; patch="${rest#*.}"
    # The project's own rule: a minor bump means "read the upgrade notes", a
    # patch bump means "change PPP_TAG".
    default=1
    if [ -n "$NEW_MIGRATIONS" ]; then default=2; why="there are new migrations"
    elif [ "$HAS_UPGRADING" -eq 1 ]; then default=2; why="the changelog has upgrade notes"; fi
    patch="$major.$minor.$((patch + 1))"; minor="$major.$((minor + 1)).0"
    echo "   ${B}1${R}  patch  $patch"
    echo "   ${B}2${R}  minor  $minor"
    echo "   or type a version (X.Y.Z); q to quit"
    [ -z "$why" ] || echo "${DIM}   suggested: minor, because $why${R}"
    ask "Version [$default]:"
    case "${ans:-$default}" in
      1) VERSION="$patch" ;;
      2) VERSION="$minor" ;;
      q|Q) abort ;;
      *) VERSION="${ans#v}" ;;
    esac
  fi

  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "not a version: $VERSION (want X.Y.Z; pre-releases are cut by hand)"
  TAG="v$VERSION"; BRANCH="release-$VERSION"
  local again="resume with: release-wizard.sh --continue $VERSION"
  ver_gt "$TAG" "$LAST" || die "$TAG is not above the last release ($LAST)"
  # Every trace an earlier attempt at this version can have left. Preparing
  # it a second time would open a second pull request for the same name.
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "the tag $TAG already exists in this clone — $again"
  [ -z "$(remote_tag_commit "$TAG")" ] || die "the tag $TAG already exists on $REMOTE — $again"
  if git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null || [ -n "$(remote_ref "refs/heads/$BRANCH")" ]; then
    die "$BRANCH already exists — $again"
  fi
  pr_lookup
  [ "$PR_STATE" = "NONE" ] \
    || die "pull request #$PR_NUMBER ($PR_STATE) already has the head $BRANCH — $again"
  if git show "HEAD:CHANGELOG.md" | awk -v h="## $TAG" '$0 == h { found = 1 } END { exit !found }'; then
    die "CHANGELOG.md on main already has a ## $TAG section — $again"
  fi
  ver_gt "$TAG" "v$main_pkg" || die "package.json on main is already at $main_pkg — $again"
  [ "$(release_state "$TAG")" = "none" ] || die "a GitHub release $TAG already exists — $again"
}

# The stub is only a prompt for a person. A release that ships it has upgrade
# notes that say nothing, shown by the deploy wizard to whoever upgrades.
ensure_no_todo() {
  while grep -q 'TODO(release)' CHANGELOG.md; do
    echo "${RED}✗ the Upgrading stub is still a TODO${R}"
    ask "Open CHANGELOG.md again? [y/N]"
    said_yes || abort
    edit CHANGELOG.md
  done
}

# ----- 3. prepare --------------------------------------------------------------
step_prepare() {
  local f count stub=0
  confirm "Prepare $BRANCH from main ($(short "$(git rev-parse HEAD)"))? [y/N]"
  run git switch -q -c "$BRANCH"
  [ "$DRY_RUN" -eq 1 ] || RESUME="scripts/release-wizard.sh --continue $VERSION"

  # shellcheck disable=SC2086
  py prepare CHANGELOG.md "$VERSION" "$TODAY" "$LAST" $NEW_MIGRATIONS >"$TMP/CHANGELOG.md" \
    || die "could not rewrite CHANGELOG.md"
  [ -n "$NEW_MIGRATIONS" ] && [ "$HAS_UPGRADING" -eq 0 ] && stub=1
  write_file CHANGELOG.md "$TMP/CHANGELOG.md"
  PREPARED_CHANGELOG="CHANGELOG.md"
  [ "$DRY_RUN" -eq 1 ] && PREPARED_CHANGELOG="$TMP/CHANGELOG.md"

  run npm version "$VERSION" --no-git-tag-version

  for f in $EXAMPLE_FILES; do
    count=0
    [ ! -f "$f" ] || count="$(py examples "$f" "$LAST" "$TAG" "$TMP/example")"
    if [ "$count" -gt 0 ]; then
      write_file "$f" "$TMP/example"
      echo "  $f: $count example tag(s) moved to $TAG"
    else
      warn "no example tag found in $f — nothing there says $LAST where an image tag is expected"
      if [ "$DRY_RUN" -eq 0 ]; then
        ask "Continue without changing $f? [y/N]"
        said_yes || abort
      fi
    fi
  done

  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "$stub" -eq 1 ]; then
      echo "New migrations and no upgrade notes: an ${B}Upgrading from $LAST${R} stub was added. Opening CHANGELOG.md to fill it in."
      edit CHANGELOG.md
    else
      ask "Open CHANGELOG.md to write the summary line? [y/N]"
      if said_yes; then edit CHANGELOG.md; fi
    fi
    ensure_no_todo
    git --no-pager diff --stat
  fi
}

# ----- 4. test -----------------------------------------------------------------
step_test() {
  local rc=0
  if [ -n "$FULL_TEST_CMD" ]; then
    warn "full test replaced by PPP_FULL_TEST_CMD=$FULL_TEST_CMD"
    # Word-split on purpose: it is a command line. stdin is closed to it so it
    # cannot swallow answers typed ahead for the prompts that follow.
    # shellcheck disable=SC2086
    run $FULL_TEST_CMD </dev/null || rc=$?
  else
    # No flags, ever: --no-build and --only make a partial run, and a partial
    # run is not a release gate.
    run scripts/full-test.sh </dev/null || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "${RED}✗ the full test failed — nothing was committed or pushed.${R}" >&2
    echo "  Fix it on this branch, then: scripts/release-wizard.sh --continue $VERSION" >&2
    exit 1
  fi
}

# ----- 5. commit, push, pull request --------------------------------------------
step_commit_pr() {
  local status untracked strays f files=() body remote_head
  confirm "Commit, push $BRANCH and open the pull request? [y/N]"

  if [ "$DRY_RUN" -eq 0 ]; then
    grep -q 'TODO(release)' CHANGELOG.md && die "the Upgrading stub in CHANGELOG.md is still a TODO"
    status="$(git status --porcelain)"
    untracked="$(printf '%s\n' "$status" | awk '/^\?\? /')"
    [ -z "$untracked" ] || die "untracked files — a release commit takes nothing it was not shown:"$'\n'"$untracked"
    strays="$(printf '%s\n' "$status" | awk -v keep="$RELEASE_FILES" '
      BEGIN { n = split(keep, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1 }
      NF { p = substr($0, 4); if (!(p in ok)) print p }')"
    if [ -n "$strays" ]; then
      warn "changed besides the release files:"
      printf '%s\n' "$strays" | sed 's/^/    /'
      ask "Include these in the release commit? [y/N]"
      said_yes || abort
      while IFS= read -r f; do files+=("$f"); done <<<"$strays"
    fi
  fi
  for f in $RELEASE_FILES; do [ ! -e "$f" ] || files+=("$f"); done

  run git add -- "${files[@]}"
  if [ "$DRY_RUN" -eq 0 ] && git diff --cached --quiet; then
    echo "${DIM}nothing to commit — $BRANCH already holds the release commit${R}"
  else
    run git commit -q -m "Prepare $TAG"
  fi
  remote_head="$(remote_ref "refs/heads/$BRANCH")"
  if [ "$DRY_RUN" -eq 0 ] && [ "$remote_head" = "$(git rev-parse HEAD)" ]; then
    echo "${DIM}$BRANCH is already on $REMOTE${R}"
  else
    run git push -q -u "$REMOTE" "$BRANCH"
  fi

  # The whole section when it fits. GitHub refuses a body over 65,536
  # characters, and a release that took six weeks has a section longer than
  # that — then the pull request gets what the release notes get.
  body="$TMP/pr-body"
  py section "$VERSION" <"$PREPARED_CHANGELOG" >"$body" || die "CHANGELOG.md has no ## $TAG section"
  if [ "$(wc -c <"$body")" -gt 60000 ]; then
    py notes "$VERSION" "$REPO" <"$PREPARED_CHANGELOG" >"$body"
  fi
  printf '\n%s\n' "Merging this does not release anything; the wizard tags the merge commit afterwards." >>"$body"
  run gh pr create --base main --head "$BRANCH" --title "Prepare $TAG" --body-file "$body" --repo "$REPO"
}

dry_run_plan() {
  echo
  echo "DRY-RUN then it would wait for the pull request to be merged — by the owner, never by this tool — and:"
  echo "DRY-RUN would run: git fetch $REMOTE +refs/heads/main:refs/remotes/$REMOTE/main"
  echo "DRY-RUN would wait for CI to pass on <merge-sha>"
  echo "DRY-RUN would run: git tag -a $TAG -m $TAG <merge-sha>"
  echo "DRY-RUN would run: git push $REMOTE refs/tags/$TAG"
  echo "DRY-RUN would wait for the release-images run of $TAG and for every image at :$TAG"
  echo "DRY-RUN would run: gh release create $TAG --verify-tag --title <title> --notes-file <notes> --repo $REPO"
}

wait_for_merge() {
  local deadline=0 said=0
  [ "$PR_TIMEOUT" -gt 0 ] && deadline=$(( $(date +%s) + PR_TIMEOUT ))
  while :; do
    pr_lookup
    case "$PR_STATE" in
      MERGED) echo "${GRN}✓${R} #$PR_NUMBER is merged"; return 0 ;;
      CLOSED) die "#$PR_NUMBER was closed without merging — reopen it, or cut $TAG by hand (docs/development.md)" ;;
      NONE) die "no pull request with the head $BRANCH was found on $REPO — resume with: $RESUME" ;;
    esac
    if [ "$said" -eq 0 ]; then
      said=1
      echo "waiting for #$PR_NUMBER to be merged — the owner merges, this tool never does."
      echo "  $PR_URL"
      echo "  Ctrl-C is safe; resume with: $RESUME"
    fi
    if [ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      echo "${RED}✗ #$PR_NUMBER was not merged within ${PR_TIMEOUT}s.${R}" >&2
      echo "  resume with: $RESUME" >&2
      exit 1
    fi
    sleep "$POLL"
  done
}

# ----- 6. tag, by SHA -----------------------------------------------------------
step_tag() {
  local local_tag remote_tag line status conclusion url deadline said=0
  SHA="$PR_MERGE"
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "GitHub reports #$PR_NUMBER as merged but gave no merge commit — refusing to guess one"
  [ "$PR_BASE" = "main" ] || die "#$PR_NUMBER was merged into $PR_BASE, not main — refusing to tag it"

  run git fetch -q "$REMOTE" "+refs/heads/main:refs/remotes/$REMOTE/main" || die "git fetch from $REMOTE failed"
  git cat-file -e "$SHA^{commit}" 2>/dev/null || die "merge commit $SHA is not on $REMOTE/main — refusing to tag"
  git merge-base --is-ancestor "$SHA" "refs/remotes/$REMOTE/main" \
    || die "merge commit $SHA is not on $REMOTE/main — refusing to tag"
  if [ "$(git show "$SHA:package.json" | py pkg-version)" != "$VERSION" ] \
    || ! git show "$SHA:CHANGELOG.md" | awk -v h="## $TAG" '$0 == h { found = 1 } END { exit !found }'; then
    die "$SHA does not contain the $TAG bump — refusing to tag it"
  fi

  remote_tag="$(remote_tag_commit "$TAG")"
  if [ -n "$remote_tag" ]; then
    [ "$remote_tag" = "$SHA" ] || die "$TAG already exists on $REMOTE at $(short "$remote_tag"), not at the merge commit $(short "$SHA") — a pushed tag is not moved; sort it out by hand"
    echo "${DIM}$TAG is already on $REMOTE at $(short "$SHA")${R}"
    return 0
  fi
  local_tag="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}" || true)"
  [ -z "$local_tag" ] || [ "$local_tag" = "$SHA" ] \
    || die "a local tag $TAG exists at $(short "$local_tag"), not at the merge commit $(short "$SHA") — delete it (git tag -d $TAG) and resume"

  # What was tested is the release branch; what is tagged is the merge. They
  # are the same tree unless something else was merged in between. The branch
  # tip may not be in this clone (another machine prepared it), and that is
  # worth a line, not a refusal.
  git fetch -q "$REMOTE" "refs/pull/$PR_NUMBER/head" 2>/dev/null || true
  if ! git cat-file -e "$PR_HEAD^{commit}" 2>/dev/null; then
    warn "could not compare the merge with what was tested: the branch tip $(short "$PR_HEAD") is not in this clone"
  elif [ "$(git rev-parse "$SHA^{tree}")" != "$(git rev-parse "$PR_HEAD^{tree}")" ]; then
    warn "something else merged in between; the merged tree is not byte-identical to what was tested."
    ask "Tag it anyway? [y/N]"
    said_yes || abort
  fi

  # CI on the merge commit itself. The pull request was green, but that was
  # the branch; main is what gets the name.
  deadline=$(( $(date +%s) + IMAGES_TIMEOUT ))
  while :; do
    line="$(gh run list --repo "$REPO" --workflow ci.yml --commit "$SHA" --json status,conclusion,url,createdAt | py run-pick)" \
      || die "could not list CI runs on $REPO"
    IFS=$'\x1f' read -r status conclusion url <<<"$line"
    if [ "$status" = "none" ]; then
      warn "no CI run was found for $(short "$SHA") — it may not have started, or CI does not run on main."
      ask "Tag it without a CI result? [y/N]"
      said_yes || abort
      break
    elif [ "$status" = "completed" ]; then
      [ "$conclusion" = "success" ] || die "CI failed on $(short "$SHA"): $url — refusing to tag"
      echo "${GRN}✓${R} CI passed on $(short "$SHA")"
      break
    fi
    [ "$said" -eq 1 ] || { said=1; echo "waiting for CI on $(short "$SHA") — $url"; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "${RED}✗ CI on $(short "$SHA") has not finished after $((IMAGES_TIMEOUT / 60)) min. Nothing was tagged.${R}" >&2
      echo "  resume with: $RESUME" >&2
      exit 1
    fi
    sleep "$POLL"
  done

  confirm "Tag $SHA as $TAG and push the tag? This starts the image build. [y/N]"
  [ -n "$local_tag" ] || run git tag -a "$TAG" -m "$TAG" "$SHA"
  run git push -q "$REMOTE" "refs/tags/$TAG"
  [ "$(remote_tag_commit "$TAG")" = "$SHA" ] \
    || die "after the push, $TAG on $REMOTE is not $SHA — stop and look before doing anything else"
  echo "${GRN}✓${R} $TAG is on $REMOTE at $(short "$SHA")"
}

# ----- 7. wait for the images ----------------------------------------------------
# Not "the images exist" alone. The workflow pushes, then signs, then scans;
# an image is pullable a minute before it is signed, and the deploy wizard
# refuses unsigned images. And not digest equality with the SHA tag either: a
# queued main build can be cancelled so that tag never appears, and a later
# rebuild re-points it. The tag's own run finishing green is the signal.
step_wait_images() {
  local images img line status conclusion url deadline state all
  images="$(images_at "$SHA")"
  echo "waiting for release-images to publish and sign $TAG: $images"
  deadline=$(( $(date +%s) + IMAGES_TIMEOUT ))
  while :; do
    line="$(gh run list --repo "$REPO" --workflow release-images.yml --commit "$SHA" \
      --json status,conclusion,headBranch,event,url,createdAt | py run-pick "$TAG")" \
      || die "could not list release-images runs on $REPO"
    IFS=$'\x1f' read -r status conclusion url <<<"$line"
    state=""; all=1
    for img in $images; do
      if image_exists "$REGISTRY/$img:$TAG"; then state="$state$img ✓  "; else state="$state$img ✗  "; all=0; fi
    done
    case "$status" in
      none) state="${state}run: not started" ;;
      completed) state="${state}run: $conclusion" ;;
      *) state="${state}run: $status" ;;
    esac
    echo "  $state"
    if [ "$status" = "completed" ] && [ "$conclusion" != "success" ]; then
      echo "${RED}✗ release-images failed for $TAG: $url${R}" >&2
      echo "  The images may be published but unsigned or failing the scan." >&2
      echo "  The release was NOT published. Re-run the workflow, then: $RESUME" >&2
      exit 1
    fi
    if [ "$status" = "completed" ] && [ "$all" -eq 1 ]; then
      echo "${GRN}✓${R} every image is published at :$TAG and the run succeeded"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "${RED}✗ after $((IMAGES_TIMEOUT / 60)) min: $state${R}" >&2
      echo "  The tag is pushed; the release is not published. Resume with: $RESUME" >&2
      exit 1
    fi
    sleep "$POLL"
  done
}

# ----- 8. publish ------------------------------------------------------------------
step_publish() {
  local notes="$TMP/notes" title state
  state="$(release_state "$TAG")"
  [ "$state" != "draft" ] \
    || die "a draft release $TAG already exists on GitHub — publish or delete it there; this tool does not overwrite it"

  # Short on purpose. The changelog section is the record, entry by entry; the
  # release is what someone reads before upgrading.
  git show "$SHA:CHANGELOG.md" | py notes "$VERSION" "$REPO" >"$notes" \
    || die "could not cut the release notes from CHANGELOG.md at $(short "$SHA")"
  hr; cat "$notes"; hr
  ask "Edit the release notes before publishing? [y/N]"
  if said_yes; then edit "$notes"; fi
  if git show "$SHA:CHANGELOG.md" | py section "$VERSION" | py has-upgrading && ! py has-upgrading <"$notes"; then
    warn "the Upgrading section is gone; the deploy wizard shows it to whoever upgrades"
    ask "Publish without it? [y/N]"
    said_yes || abort
  fi

  if [ -n "${PPP_RELEASE_TITLE+set}" ]; then
    title="$PPP_RELEASE_TITLE"
  else
    ask "Release title — the text after \"$TAG — \" (enter for none):"
    title="$ans"
  fi
  if [ -n "$title" ]; then title="$TAG — $title"; else title="$TAG"; fi

  confirm "Publish the GitHub release \"$title\"? [y/N]"
  run gh release create "$TAG" --verify-tag --title "$title" --notes-file "$notes" --repo "$REPO"
  nas_line
  echo "${DIM}To tidy up here:  git switch main && git pull --ff-only && git branch -d $BRANCH${R}"
}

# ============================================================================
# --continue
# ============================================================================
# The position is worked out from the outside in: the furthest thing that
# exists decides. States 1 to 3 never read the working tree, so they need
# neither a clean tree nor a particular branch.
do_continue() {
  local remote_tag here
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version: $VERSION (want X.Y.Z)"
  TAG="v$VERSION"; BRANCH="release-$VERSION"
  RESUME="scripts/release-wizard.sh --continue $VERSION"

  remote_tag="$(remote_tag_commit "$TAG")"
  if [ -n "$remote_tag" ]; then
    # A draft is not a release: nobody can see it and the deploy wizard does
    # not list it.
    if [ "$(release_state "$TAG")" = "published" ]; then
      echo "already released."
      nas_line
      return 0
    fi
    echo "${DIM}$TAG is tagged at $(short "$remote_tag"); the release is not published yet${R}"
    # The tagged commit has to be here before anything is read out of it.
    git fetch -q "$REMOTE" "refs/tags/$TAG:refs/tags/$TAG" \
      || die "could not fetch $TAG from $REMOTE (a different local tag of that name?)"
    SHA="$remote_tag"
    pr_lookup
    if [ "$PR_STATE" = "MERGED" ] && [ -n "$PR_MERGE" ] && [ "$PR_MERGE" != "$SHA" ]; then
      die "$TAG is at $(short "$SHA") but #$PR_NUMBER was merged as $(short "$PR_MERGE") — the tag is not on the release commit; stop and look"
    fi
    step_wait_images
    step_publish
    return 0
  fi

  pr_lookup
  case "$PR_STATE" in
    MERGED) step_tag; step_wait_images; step_publish; return 0 ;;
    OPEN) wait_for_merge; step_tag; step_wait_images; step_publish; return 0 ;;
    CLOSED) die "#$PR_NUMBER was closed without merging — reopen it, or cut $TAG by hand (docs/development.md)" ;;
  esac

  # No pull request yet: the branch is all there is, here or on the remote.
  if ! git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
    [ -n "$(remote_ref "refs/heads/$BRANCH")" ] || die "nothing to continue for $VERSION"
    [ -z "$(git status --porcelain)" ] || die "working tree is not clean — $BRANCH is on $REMOTE and has to be checked out"
    git fetch -q "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" || die "could not fetch $BRANCH"
    git switch -q -c "$BRANCH" --track "$REMOTE/$BRANCH"
  fi
  here="$(git symbolic-ref --short -q HEAD || true)"
  if [ "$here" != "$BRANCH" ]; then
    [ -z "$(git status --porcelain)" ] || die "on ${here:-a detached HEAD} with uncommitted changes — commit or stash them, or switch to $BRANCH yourself"
    git switch -q "$BRANCH"
  fi
  if [ "$(py pkg-version <package.json)" != "$VERSION" ] || ! grep -q "^## $TAG\$" CHANGELOG.md; then
    die "$BRANCH exists but is not prepared — delete it and start again"
  fi
  PREPARED_CHANGELOG="CHANGELOG.md"
  ensure_no_todo
  step_test
  step_commit_pr
  wait_for_merge
  step_tag
  step_wait_images
  step_publish
}

# ============================================================================
# main
# ============================================================================
if [ "$MODE" = "continue" ]; then
  do_continue
  exit 0
fi

echo "${B}ppp release wizard${R}  ${DIM}· $REPO · $REMOTE${R}"
[ "$DRY_RUN" -eq 0 ] || echo "${YLW}DRY RUN — nothing is changed, here or on GitHub.${R}"
hr
step_preflight
step_version
step_prepare
step_test
step_commit_pr
if [ "$DRY_RUN" -eq 1 ]; then
  dry_run_plan
  exit "$REFUSED"
fi
wait_for_merge
step_tag
step_wait_images
step_publish

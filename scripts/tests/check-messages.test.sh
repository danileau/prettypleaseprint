#!/usr/bin/env bash
# What `npm run check:messages` lets through and what it refuses, against
# made-up translations beside the real en.json. Run from the repository root:
#
#   bash scripts/tests/check-messages.test.sh
#
# The cases are the ones a reader of a regular expression gets wrong: a
# select's branch words are translated text, not arguments; a rich-text tag
# dropped from a translation loses whatever the template put in it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
TSX="$ROOT/node_modules/.bin/tsx"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
pass=0 fail=0

# $1 name, $2 translation JSON, $3 wanted exit (0 or 1), $4 text the output must have (optional)
case_() {
  local dir="$BASE/$pass$fail" out rc
  mkdir -p "$dir"
  cp messages/en.json "$dir/en.json"
  printf '%s\n' "$2" >"$dir/xx.json"
  out="$(MESSAGES_DIR="$dir" GITHUB_ACTIONS= "$TSX" scripts/check-messages.ts 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && rc=1
  if [ "$rc" = "$3" ] && { [ -z "${4:-}" ] || grep -qF -- "$4" <<<"$out"; }; then
    echo "ok   $1"; pass=$((pass + 1))
  else
    echo "FAIL $1 (exit $rc, wanted $3${4:+, output with: $4})"; echo "$out" | sed 's/^/     /' | tail -12
    fail=$((fail + 1))
  fi
}

case_ "a select whose branches are translated passes" \
  '{"notification":{"storyMoved":"{actor} a déplacé « {title} » vers {status, select, Printing {Impression} Done {Terminé} other {{status}}}."}}' \
  0 "0 error(s)"
case_ "a renamed argument is refused" \
  '{"notification":{"storyDeclined":"{acteur} a refusé « {title} »."}}' \
  1 "notification.storyDeclined  (English has {actor, title}, xx has {acteur, title})"
case_ "a dropped <link> is refused" \
  '{"mail":{"notification":{"aside":"Aussi dans votre panneau. Désactivez-les sur votre profil."}}}' \
  1 "mail.notification.aside  (English has <link>, xx has <>)"
case_ "a renamed tag is refused" \
  '{"mail":{"invite":{"lead":"<b>{inviter}</b> vous a ajouté. Déposez un <mono>.stl</mono> ou un <mono>.3mf</mono>."}}}' \
  1 "English has <mono, strong>, xx has <b, mono>"
case_ "a translation that keeps every tag and argument passes" \
  '{"mail":{"notification":{"aside":"Aussi dans votre panneau. <link>Désactivez-les</link>."},"invite":{"pill":"UN USAGE · EXPIRE DANS {days, plural, one {# JOUR} other {# JOURS}}"}}}' \
  0 "0 error(s)"

echo
echo "check-messages: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

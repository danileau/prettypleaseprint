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

# $1 name, $2 translation JSON, $3 wanted exit (0 or 1), $4 text the output must have (optional),
# $5 the translation's file name without .json (default fr: the strings below are French)
case_() {
  local dir="$BASE/$pass$fail" out rc
  mkdir -p "$dir"
  cp messages/en.json "$dir/en.json"
  printf '%s\n' "$2" >"$dir/${5:-fr}.json"
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
  1 "notification.storyDeclined  (English has {actor, title}, fr has {acteur, title})"
case_ "a dropped <link> is refused" \
  '{"mail":{"notification":{"aside":"Aussi dans votre panneau. Désactivez-les sur votre profil."}}}' \
  1 "mail.notification.aside  (English has <link>, fr has <>)"
case_ "a renamed tag is refused" \
  '{"mail":{"invite":{"lead":"<b>{inviter}</b> vous a ajouté. Déposez un <mono>.stl</mono> ou un <mono>.3mf</mono>."}}}' \
  1 "English has <mono, strong>, fr has <b, mono>"
case_ "a translation that keeps every tag and argument passes" \
  '{"mail":{"notification":{"aside":"Aussi dans votre panneau. <link>Désactivez-les</link>."},"invite":{"pill":"UN USAGE · EXPIRE DANS {days, plural, one {# JOUR} other {# JOURS}}"}}}' \
  0 "0 error(s)"

# The file name is the language: the app offers it under that code, by the
# name Intl gives it in itself.
case_ "a file named as a language passes, and is listed by its own name" \
  '{}' 0 "1 translation(s): pt-BR (Português (Brasil))" pt-BR
case_ "a file whose name is not a language tag is refused" \
  '{}' 1 '"notes_fr" is not a BCP 47 language tag' notes_fr
case_ "a tag spelt another way than Intl writes it is refused, naming the spelling" \
  '{}' 1 'rename the file pt-BR.json' pt-br
case_ "a tag Intl has no name for is refused" \
  '{}' 1 'Intl.DisplayNames has no name for "qaa"' qaa
case_ "a word that is a well-formed tag but no language is refused" \
  '{}' 1 'Intl.DisplayNames has no name for "notes"' notes
case_ "the code for an undetermined language is refused" \
  '{}' 1 '"und" is a code for no particular language' und
case_ "so is the code for multiple languages, which Intl does name" \
  '{}' 1 '"mul" is a code for no particular language' mul

# A message next-intl cannot format, whatever its arguments: the app would
# show English for it, so it is an error here rather than found on a page.
case_ "an unclosed brace is refused" \
  '{"mail":{"notification":{"greeting":"SALUT {name"}}}' \
  1 "mail.notification.greeting  (INVALID_MESSAGE)"
case_ "a plural with no other is refused" \
  '{"mail":{"invite":{"pill":"UN USAGE · EXPIRE DANS {days, plural, one {# JOUR}}"}}}' \
  1 "mail.invite.pill  (INVALID_MESSAGE)"
case_ "a tag never closed is refused" \
  '{"mail":{"notification":{"aside":"Aussi dans votre panneau. <link>Désactivez-les."}}}' \
  1 "mail.notification.aside  (INVALID_MESSAGE)"

# And the app applies the same rule to the same files: from a messages/
# holding all of them, it offers only the languages, and says why for each
# of the others.
dir="$BASE/app"; mkdir -p "$dir/messages"
for f in en fr pt-BR notes backup und mul pt-br qaa; do printf '{}\n' >"$dir/messages/$f.json"; done
offered="$(cd "$dir" && "$TSX" -e "import('$ROOT/src/i18n/catalogue.ts').then((m) => console.log(m.offeredLocales().join(' ')))" 2>"$dir/log")"
if [ "$offered" = "en fr pt-BR" ] && [ "$(grep -c 'is not offered' "$dir/log")" -eq 6 ]; then
  echo "ok   the app offers only the files check:messages accepts, warning once for each other"; pass=$((pass + 1))
else
  echo "FAIL the app offers \"$offered\" (wanted \"en fr pt-BR\")"; sed 's/^/     /' "$dir/log"; fail=$((fail + 1))
fi

echo
echo "check-messages: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

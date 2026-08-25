#!/usr/bin/env bash
#
# Register prusa-open.sh as the handler for `ppp://` links on this Linux
# desktop, and lay down a config skeleton for it to read.
#
# Run it once, on the machine that has the printer and PrusaSlicer:
#   ./scripts/install-slicer-handler.sh
#
# What it does, all under your own home directory — nothing system-wide, no
# sudo:
#   1. writes a .desktop entry into ~/.local/share/applications that points at
#      this checkout's prusa-open.sh by absolute path;
#   2. makes it the default handler for the x-scheme-handler/ppp MIME type;
#   3. creates ~/.config/ppp/slicer.conf (mode 600) for you to fill in, if it
#      is not already there.
#
# macOS and Windows register a scheme differently (a .app/Info.plist and a
# registry key respectively) — docs/prusaslicer.md has both. This installer is
# Linux/XDG only, and says so rather than pretending to work elsewhere.

set -euo pipefail

case "$(uname -s)" in
  Linux) : ;;
  *) echo "This installer is Linux/XDG only. See docs/prusaslicer.md for macOS and Windows." >&2
     exit 1 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
handler="$here/prusa-open.sh"
[ -f "$handler" ] || { echo "prusa-open.sh is not beside this installer ($handler)" >&2; exit 1; }
chmod +x "$handler"

apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
desktop="$apps_dir/ppp-slicer.desktop"
mkdir -p "$apps_dir"

# %u is the clicked URL, passed through to the handler as its one argument.
cat >"$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Pretty Please Print → PrusaSlicer
Comment=Open a ppp:// model link in PrusaSlicer
Exec=$handler %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/ppp;
DESKTOP

echo "wrote $desktop"

# Make it the default for the scheme. xdg-mime is the portable way; if it is
# absent, fall back to editing mimeapps.list directly so this still works on a
# minimal install.
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default ppp-slicer.desktop x-scheme-handler/ppp
  echo "registered ppp:// via xdg-mime"
else
  mimeapps="${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list"
  touch "$mimeapps"
  if ! grep -q '^x-scheme-handler/ppp=' "$mimeapps" 2>/dev/null; then
    grep -q '^\[Default Applications\]' "$mimeapps" 2>/dev/null || printf '[Default Applications]\n' >>"$mimeapps"
    # Insert the mapping under the Default Applications header.
    tmp="$(mktemp)"
    awk '/^\[Default Applications\]/ { print; print "x-scheme-handler/ppp=ppp-slicer.desktop"; next } { print }' \
      "$mimeapps" >"$tmp" && mv "$tmp" "$mimeapps"
  fi
  echo "registered ppp:// in $mimeapps (xdg-mime not found)"
fi

command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database "$apps_dir" 2>/dev/null || true

# Config skeleton — never overwrite an existing one, and lock it down, because
# it is about to hold a bearer token.
conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/ppp"
conf="$conf_dir/slicer.conf"
mkdir -p "$conf_dir"
if [ -f "$conf" ]; then
  echo "left your existing config alone: $conf"
else
  umask 077
  cat >"$conf" <<'CONF'
# Pretty Please Print → PrusaSlicer bridge config. Read by prusa-open.sh.
# This file holds a credential: keep it mode 600 (this file was created so).

# The instance, no trailing slash.
PPP_BASE="https://print.example"

# A bearer token. It is your session token, so signing out of the app revokes
# it. Mint one — and keep it out of your shell history:
#   curl -si "$PPP_BASE/api/auth/sign-in/username" \
#     -H 'content-type: application/json' \
#     -d '{"username":"you","password":"..."}' | grep -i '^set-auth-token:'
PPP_TOKEN="paste-the-set-auth-token-value-here"

# Optional. The slicer binary; give a full path for an AppImage.
# PPP_SLICER="prusa-slicer"

# Optional. Where fetched models are cached (pruned after a day).
# PPP_DOWNLOAD_DIR="$HOME/.cache/ppp/models"
CONF
  chmod 600 "$conf"
  echo "created $conf (mode 600) — edit PPP_BASE and PPP_TOKEN"
fi

echo
echo "Done. Set PPP_BASE and PPP_TOKEN in $conf, then click 'Open in PrusaSlicer'"
echo "on any ticket. Trouble? tail -f \"\${XDG_STATE_HOME:-\$HOME/.local/state}/ppp/slicer.log\""

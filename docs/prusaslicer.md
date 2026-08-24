# Open in PrusaSlicer

[← back to the README](../README.md)

Every ticket has an **Open in PrusaSlicer** control. Clicking it fetches the
model and opens it in PrusaSlicer on the machine you clicked from. This page is
how to set that up once, and why it works the way it does.

## Why it is not a one-line deep link

PrusaSlicer has its own scheme — `prusaslicer://open?file=<url>` — and it would
have been two lines to emit. It does not work here, and cannot be made to:

> PrusaSlicer only downloads from a **hardcoded allowlist**: `printables.com`,
> `thingiverse.com`, `cults3d.com`. There is no setting to add a domain. The
> requests to make it configurable were closed as *not planned*
> ([#13752](https://github.com/prusa3d/PrusaSlicer/issues/13752),
> [#14313](https://github.com/prusa3d/PrusaSlicer/issues/14313)); Prusa adds
> domains one at a time after a security review, on request.

A self-hosted instance on your own hostname can never be on that list. And the
allowlist is checked against the **URL string** PrusaSlicer is handed, before
it makes any request — so there is no header on any request to us that could
be set to look like Printables. (Trying to disguise the URL to slip past the
check is a parser-confusion trick: brittle, it breaks the next time Prusa
tightens the check, and it re-opens for you the exact hole the allowlist
exists to close.)

So the model is fetched by **a small helper on your own machine**, which hands
PrusaSlicer a **local file**. A local file has no domain to check, so the
allowlist never applies — that is the design, not a loophole. The helper is the
only new moving part, and it talks to nothing but this app's own API.

```
 Browser                 Helper on your machine            This app
 ───────                 ──────────────────────            ────────
 click  ──ppp://slice/104──▶ prusa-open.sh
                            GET /api/models/104  ───────────▶  (bearer token)
                            ◀───────────────────── the .stl bytes
                            writes /tmp/…/PPP-104-clip.stl
                            prusa-slicer --single-instance <that file>
```

## Setup (Linux)

On the machine with the printer, PrusaSlicer and your browser, from a checkout
of this repo:

```bash
./scripts/install-slicer-handler.sh
```

That registers `ppp://` links to open with
[`scripts/prusa-open.sh`](../scripts/prusa-open.sh), and creates
`~/.config/ppp/slicer.conf` (mode `600`) for you to fill in:

```sh
PPP_BASE="https://print.example"      # your instance, no trailing slash
PPP_TOKEN="…"                          # a bearer token — see below
# PPP_SLICER="prusa-slicer"            # or the full path to an AppImage
# PPP_DOWNLOAD_DIR="$HOME/.cache/ppp/models"
```

Get a token by signing in — and keep it out of your shell history:

```bash
curl -si https://print.example/api/auth/sign-in/username \
  -H 'content-type: application/json' \
  -d '{"username":"you","password":"…"}' | grep -i '^set-auth-token:'
```

The token **is** your session token: it carries your account's access and no
more, and signing out of the app revokes it. That is also why the config file
is `600` — it holds a credential. See [the API](api.md#authentication) for the
full picture on bearer tokens.

Now click **Open in PrusaSlicer** on any ticket. Nothing to paste — the link
carries only the ticket number; the address and the token live in the config.

## When it does not work

A `ppp://` link with no handler installed does **nothing** — that is the
browser, not a bug, and it is why the button says as much. Everything the
helper does, and every refusal, is logged:

```bash
tail -f "${XDG_STATE_HOME:-$HOME/.local/state}/ppp/slicer.log"
```

Failures also raise a desktop notification where `notify-send` exists, because
a protocol handler has no terminal and a click that silently fails is
indistinguishable from one that was never wired up. Common lines:

| It says | Means |
| --- | --- |
| `no config at …` | The installer has not run, or `$PPP_SLICER_CONF` points elsewhere. |
| `not authorised (HTTP 401)` | The token is wrong, expired, or was revoked by signing out. Mint a new one. |
| `story N … not one this account may see (HTTP 404)` | That ticket is not yours, or does not exist. |
| `slicer '…' not found on PATH` | Set `PPP_SLICER` to the binary — an AppImage needs its full path. |
| `WARNING: … is group/world-readable` | `chmod 600 ~/.config/ppp/slicer.conf`. |

## macOS and Windows

The installer is Linux/XDG only. The helper script itself is portable (`bash` +
`curl`); only the scheme registration differs.

**macOS** — register `ppp://` with a tiny app wrapper. In *Script Editor*, save
an application that runs:

```applescript
on open location this_URL
  do shell script "/path/to/prusa-open.sh " & quoted form of this_URL
end open location
```

and add `CFBundleURLSchemes` = `ppp` to its `Info.plist`. Set `PPP_SLICER` to
`/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer`.

**Windows** — the helper needs a `bash` (Git Bash / WSL). Register the scheme
with a `.reg` file:

```reg
Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\ppp]
@="URL:Pretty Please Print"
"URL Protocol"=""
[HKEY_CLASSES_ROOT\ppp\shell\open\command]
@="\"C:\\Program Files\\Git\\bin\\bash.exe\" \"C:/path/to/prusa-open.sh\" \"%1\""
```

Both are untested here and offered as starting points — the Linux path is the
supported one, matching the app's own "one printer, one office" shape.

## OrcaSlicer, and other slicers

The helper opens whatever `PPP_SLICER` points at — it is not tied to Prusa.
OrcaSlicer, for instance, opens `.stl`/`.3mf` from the command line the same
way, so `PPP_SLICER="orca-slicer"` (or the AppImage path) works unchanged.

OrcaSlicer also has its own `orcaslicer://open?file=` scheme, and unlike
PrusaSlicer it is not obviously locked to an allowlist — if a future version
accepts arbitrary hosts, a direct deep link becomes possible for Orca users and
this helper stays the fallback. Nothing here depends on that.

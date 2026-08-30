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
 click ─ppp://slice/104?t=…─▶ prusa-open.sh
                            GET /api/models/104?t=…  ───────▶  (link credential)
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
# PPP_SLICER=…                         # only if auto-detect misses — see below
# PPP_DOWNLOAD_DIR="$HOME/.cache/ppp/models"
```

That is the whole config: **there is no token to paste.** The clicked link
carries its own credential.

### Finding the slicer

Left unset, the helper looks for PrusaSlicer in the places it usually is, in
order: a binary on `PATH` (`prusa-slicer`, `prusaslicer`, `PrusaSlicer`), a
Flatpak install, then an AppImage in `~/Applications`, `~/Downloads` or
`~/.local/bin`. On most machines that just works — including a Flathub install,
which nothing puts on `PATH`.

Set `PPP_SLICER` only when that misses, in whichever form matches your install:

```sh
PPP_SLICER="prusa-slicer"                             # a binary name
PPP_SLICER="$HOME/Applications/PrusaSlicer-2.9.0.AppImage"  # an AppImage
PPP_SLICER="flatpak run com.prusa3d.PrusaSlicer"      # a Flatpak
PPP_SLICER="orca-slicer"                              # or any other slicer
```

A multi-word command (the Flatpak form) is split on spaces and run as-is, so
a path that itself contains spaces is the one thing this cannot express — put
the AppImage somewhere without them.

**Flatpak note:** the slicer must be allowed to read the downloaded file. The
default `PPP_DOWNLOAD_DIR` is under `~/.cache`, which a Flatpak with home access
can see; if yours is sandboxed tighter, grant it with
`flatpak override --user --filesystem=xdg-cache/ppp com.prusa3d.PrusaSlicer`.

### The credential is in the link

Click **Open in PrusaSlicer** on any ticket and it works. The link is
`ppp://slice/<id>?t=<token>`, and that token is minted by the app when the
ticket is rendered — for **you**, for **that model**, for **half an hour**.

It is deliberately not much of a secret, because it cannot do much: it names
who you are, and the server decides the rest. Your account is loaded and
refused if it has been suspended, and the same `storyScope` rule the pages use
is re-applied — so a link cannot reach a model you have lost access to, and
cannot be edited to fetch a different one. If it expires, open the ticket again
and click; there is nothing to rotate.

Two consequences worth stating plainly:

- **Nothing secret is on your disk.** `slicer.conf` holds an address. It is
  still created `600`, but there is nothing in it to steal.
- **Signing out does not kill an outstanding link.** Nothing is stored, so
  there is nothing to revoke — the half hour has to elapse. Suspending the
  account *does* stop it. For read access to one model you could already open,
  that is the right side of the trade.

#### If you set this up before

Earlier versions put a `PPP_TOKEN` in that file — a bearer token, which is the
session token. When sessions came down from thirty days to twenty idle minutes
it stopped working, and every click began answering `HTTP 401`. That is the bug
this replaced.

The helper still honours `PPP_TOKEN` when a link carries no `t`, so an old
bookmark keeps working, but there is no reason to keep one:

```bash
sed -i '/^PPP_TOKEN=/d' ~/.config/ppp/slicer.conf
```

### Just want the file?

Every ticket also has a plain **Download** button next to this one. Same bytes,
same permissions, no helper and no setup — for a machine without PrusaSlicer,
or a slicer that is not PrusaSlicer.

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
| `that link has expired (HTTP 401)` | Links last half an hour. Open the ticket again and click the button. |
| `the PPP_TOKEN in … is expired` | You are on the old config-token path. Delete the line and click the button in the app — see *If you set this up before*. |
| `that link carries no credential and … sets no PPP_TOKEN` | An old bookmark, on a config with no token. Open the ticket in the app and click there. |
| `the credential in that link is malformed` | The URL was edited or truncated in transit. Re-click from the ticket. |
| `story N … not one this account may see (HTTP 404)` | That ticket is not yours, or does not exist. |
| `could not find PrusaSlicer` | Auto-detect missed it. Set `PPP_SLICER` — see *Finding the slicer* above. |
| `slicer '…' is not runnable` | `PPP_SLICER` points at something that is not a command or an executable file. |
| loads then says *empty file* / *loading failed* | The bytes did arrive; the slicer could not read them (a truncated or non-model file). Check the ticket's file. |
| `WARNING: … is group/world-readable` | Only raised while the file still holds a `PPP_TOKEN`. Delete the line, or `chmod 600 ~/.config/ppp/slicer.conf`. |

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

# Handoff: Print That For Me

## Overview

"Print That For Me" is an invite-only web app for a small office / makerspace. One person (the **admin**) owns a 3D printer. Invited friends and colleagues upload a model file (`.stl` / `.3mf`), which creates a **Story**. Stories live on a backlog board and move through print stages. The uploader can attach a wish (material, colour, quantity) and an optional thank-you (a beer, a coffee, filament, nerd stuff).

Two roles:

- **Client** (invited user, e.g. "Ayla") — uploads models, sees **only her own stories**, follows their progress, comments.
- **Admin / printer owner** (e.g. "Ruben") — sees **every story with the user who created it**, accepts or declines, moves stages, comments, flags model problems.

Notifications: every upload notifies the admin; every status change, flag or comment notifies the other side.

## About the Design Files

The files in this bundle are **design references created in HTML** — a clickable prototype that shows intended look and behaviour. They are **not production code to copy directly**.

- `Pretty Please Print v2.dc.html` — the full prototype. It is a single-file component with an HTML template (inline styles) and a JavaScript logic class. `support.js` is only the runtime that renders that authoring format in the browser; **do not port it**.
- The task is to **recreate these designs in the target codebase's existing environment** (React/Next, Vue/Nuxt, Svelte, Rails+Hotwire, native — whatever the project uses) with its established patterns, router, form and data libraries.
- If no codebase exists yet, see "Suggested stack" below.

## Fidelity

**High-fidelity.** Colours, typography, spacing, radii and copy in the prototype are final and are listed exactly under Design Tokens. Recreate the UI faithfully using the codebase's own component primitives; keep the token values.

Two things in the prototype are deliberately faked and must be built for real:

1. **Authentication** is implied, not designed. There is a role switcher in the header purely so a reviewer can see both perspectives. Real app: invite-only auth, no public sign-up (see Auth & authorisation).
2. **The 3D viewer** renders a stand-in primitive per story (three.js box/cylinder/torus knot) because the prototype cannot parse real geometry. Real app: load and render the uploaded `.stl` / `.3mf`.

There is **no live print progress**. Without a printer API there is no telemetry, so a story in *Printing* shows only `on the bed · est. 1 h 10 m`. Status is advanced manually by the admin. If a printer API (PrusaLink / PrusaConnect / OctoPrint / Moonraker) is wired up later, that is the place to add real progress.

---

## Data model

```
User
  id
  name                     e.g. "Ayla Berg"
  initials                 e.g. "AY"          (avatar fallback)
  role                     "client" | "admin"
  invitedBy                User.id | null

Story
  id
  ref                      display key, "PTFM-" + (100 + id), e.g. "PTFM-104"
  title                    string, user-supplied ("Hook for the monitor arm")
  file                     uploaded asset: filename, size, mime, storage key
                           accepted: .stl, .3mf   max 50 MB
  uploaderId               User.id  (owner of the story)
  status                   "Requested" | "Accepted" | "Printing" | "Done" | "Delivery" | "Declined"
  quantity                 int >= 1, default 1
  material                 "PLA" | "PETG" | "TPU" | "Resin"
  colorName                "Teal" | "Slate" | "Bone white" | "Graphite" | "Whatever's on"
  colorHex                 the swatch hex (see Design Tokens → Filament swatches)
  tip                      "A beer" | "A coffee" | "A spool of filament" | "Nerd stuff" | "Nothing, sorry"
  note                     free text from the uploader
  flagged                  boolean — admin marked a model problem
  createdAt
  meta (derived from the file, display-only in the prototype)
      dims                 "78 × 40 × 22 mm"
      filesize             "2.4 MB"
      estimate             "~1 h 10 m"

Comment
  id, storyId, authorId, body, createdAt

Notification
  id, recipientId, storyId, text, read, createdAt
```

### Status flow

`Requested → Accepted → Printing → Done → Delivery`, plus the terminal branch `Declined` (only from *Requested*).

Only the admin changes status. Transitions are strictly forward along the flow (no skipping, no going back in the prototype). Each transition writes a Notification to the story's uploader.

### Authorisation rules (important — this is the core of this iteration)

| Actor | Sees |
| --- | --- |
| Client | Only stories where `uploaderId == self`. On board cards the uploader name is omitted (it is always them). |
| Admin | All stories, each showing the creating user's name and initials. |

- Enforce this **server-side**, not just in the UI: list endpoints scope by `uploaderId` unless the caller is admin; the story detail endpoint 404s for a client requesting someone else's story.
- Notifications are per recipient: uploads → admin; status change / flag / admin comment → uploader; client comment → admin.
- Stats on the profile screen are scoped the same way.

### Auth & authorisation (to build)

- **Invite-only.** The admin invites by email; no public registration. A magic-link / OTP email flow is enough for a group this size; OAuth is fine if the office already has an identity provider.
- Roles: exactly one `admin` (the printer owner) plus `client` users. Role lives on the user record.
- Sessions: httpOnly cookie. Every API route checks role + ownership as above.
- File uploads: validate extension and magic bytes, cap at 50 MB, store outside the web root (S3-compatible object storage), serve through a signed URL that the ownership check gates.

---

## Screens / Views

All screens share one header and a max content width of **1180px**, horizontal padding **26.4px**, top padding **35.2px**.

### 1. Header (all screens)

- Sticky, `top: 0`, `z-index: 40`, background `rgba(244,245,246,0.9)` with `backdrop-filter: blur(8px)`, bottom border `1px solid rgba(20,24,28,0.16)`.
- Row: `display:flex; align-items:center; gap:26.4px; flex-wrap:wrap; padding:14px 26.4px`.
- **Brand**: 34px teal (`#12645f`) circle + wordmark "print that for me", IBM Plex Sans 600, 20px, `letter-spacing:-0.01em`. Click → home (client: Backlog, admin: Queue).
- **Nav** pills, 8px radius, `padding:8.8px 17.6px`, 15px. Active = teal fill `#12645f` on `#eef6f5` text, weight 700. Inactive = transparent, `#333b42`, weight 600, hover `background:#d9ebe9; color:#0b4340`.
  - Client: Backlog · Upload · My prints
  - Admin: Queue · Board · Ruben's prints
- **Activity button**: bordered pill (`1px solid rgba(20,24,28,0.16)`, background `#ffffff`, radius 8px) with an unread count badge — 22px min-width, radius 999px, teal fill when unread (`#12645f` / `#eef6f5`), otherwise `#d7dbdf` / `#4d565e`. Opens a 360px dropdown panel (radius 14px, `box-shadow: 0 12px 32px rgba(19,24,30,0.22)`, `animation: 160ms ease-out` fade+rise). Rows: 8px status dot (unread `#12645f` on `#eef6f5` row background, read `#b6bcc2` on transparent), text 14px, relative time 12px `#6b747c`; clicking a row marks it read and opens the story. "Mark all read" ghost link, 13px, `#0b4340`.
- **Role switcher** — *prototype only, drop it in production.* Replace with the signed-in user's avatar + menu.

### 2. Backlog board (`/board`) — client's home, also available to admin

- Kicker (12–13px, 700, uppercase, `letter-spacing:0.08em`, IBM Plex Mono, `#0b4340`):
  - client "Private to you and Ruben" · admin "Admin view · every request, with who asked"
- H1 "The backlog", IBM Plex Sans 600, 42px, `line-height:1.05`, `letter-spacing:-0.02em`.
- Intro paragraph 17px `#333b42`, `text-wrap: pretty`:
  - client: "Every request is a story. Only you and Ruben see yours — other people's requests stay theirs."
  - admin: "Every story from the group, wherever it sits. Open one to comment or move it along."
- Primary action right-aligned on the same block: **"Upload a model"** — teal fill, `#eef6f5` text, radius 8px, `padding:15px 28px`, 16px/700, `box-shadow: 0 3px 10px rgba(19,24,30,0.16)`; hover `#0e5551`, active `#0b4340`.
- **Columns**: `display:grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap:17.6px; align-items:start`. One column per status in flow order; alternating backgrounds `#eceef0` / `#eaecee`, radius 14px, padding 17.6px, `min-height:180px`. Column header: label 14px/800 uppercase `letter-spacing:0.04em` (`#333b42`, or `#79541a` for *Printing*) + count 13px `#6b747c`. Empty column: "Nothing here." 13px `#6b747c`.
- **Story card**: white, radius 10px, `padding:15px 17.6px` (compact variant `11px 13.2px`), `box-shadow: 0 1px 2px rgba(19,24,30,0.14)`; hover lifts to `0 3px 10px rgba(19,24,30,0.16)` + `translateY(-1px)`. Click → story detail. Contents, in order:
  1. Ref, 11.5px/700, mono, `letter-spacing:0.06em`, `#6b747c` — plus, if flagged, an amber chip "needs a look" (11px/700, `#f7ecd4` bg, `#79541a` text, radius 999px, `padding:2px 8px`).
  2. Title 15.5px/700, `line-height:1.25`; if `quantity > 1` a mono badge `4×` on the right (12.5px/600, `#d9ebe9` bg, `#0b4340`, radius 6px).
  3. Chips row (`gap:4.4px`): material chip — 10px colour dot (inset ring `rgba(20,24,28,0.2)`) + material name, 12px/600 `#333b42` on `#eaecee`, radius 999px, `padding:3px 9px`; then the tip chip, 12px/600 `#3e5069` on `#dde3ec`.
  4. If status is *Printing*: one mono line 11.5px `#6b747c` — `on the bed · est. 1 h 10 m`.
  5. Footer row: 20px avatar circle (`#c3cddb` bg, `#2c3a4d`, 10.5px/800 initials) + text 12px `#6b747c`. Admin sees `Uploader · relative time`; client sees the relative time only.

### 3. Upload / new request (`/upload`) — client

Single column, `max-width: 780px`.

- Kicker "New request"; H1 "Print that for me" (42px); intro "Drop an .stl or .3mf. Ruben gets a ping, and your request shows up in the backlog as a story you can follow."
- **Dropzone**: full-width label, `2px dashed #b6bcc2`, radius 14px, white, `padding:35.2px 26.4px`, centred; hover border `#12645f`, background `#eef6f5`. Contains a 56px `#d9ebe9` circle, then 17px/700 label ("Drop your .stl or .3mf here" → the filename once chosen) and a 13.5px `#6b747c` hint ("or click to choose a file · 50 MB max" → a validation line once chosen). Hidden `<input type="file">`. Real implementation: drag-and-drop + click, extension/size validation, upload progress, and a parse pass that fills the meta (dims, size, estimate) — the prototype's "Looks fine — 1 shell, no open edges." is a placeholder for a real mesh check.
- Two-up grid (`repeat(auto-fit, minmax(280px, 1fr))`, gap 22px): **"What is it?"** text input (white, `1px solid rgba(20,24,28,0.16)`, radius 8px, `padding:13.2px 17.6px`, 15px; placeholder "Hook for the monitor arm") and **"Material you'd like"** segmented control (track `#eaecee`, radius 8px, 3px inset; options PLA / PETG / TPU / Resin, selected = teal fill / `#eef6f5`, radius 6px, `padding:10px 4px`, 13.5px/700). Default PETG.
- **"How many do you need?"** — same segmented control, mono labels, options 1 / 2 / 3 / 4 / 6, default 1, `max-width:320px`. Real implementation should also allow a typed number.
- **"Colour you're hoping for"** — swatch row, `gap:13.2px`, each option a 78px column: 46px circle with `inset 0 0 0 1px rgba(20,24,28,0.2)` (selected adds `0 0 0 3px #12645f`) + 12.5px/600 label (`#0b4340` when selected, else `#4d565e`). Options: Teal `#12645f`, Slate `#4a5d78`, Bone white `#eaecee`, Graphite `#1b2126`, Whatever's on `#b6bcc2`. Caption "Ruben confirms what's actually on the spool."
- **Tip block** — `#dde3ec` panel, radius 14px, padding 22px. Heading "And what's in it for Ruben?" (600, 19px), sub "Optional. Nobody is counting. Ruben is counting a little." 14px `#2c3a4d`. Pills: A beer / A coffee / A spool of filament / Nerd stuff / Nothing, sorry — selected = `#4a5d78` fill, `#eef1f5` text; unselected = transparent, `1px solid rgba(20,24,28,0.16)`, `#2c3a4d`. Radius 8px, `padding:11px 20px`, 14.5px/700.
- **"Anything he should know"** — textarea, 3 rows, radius 10px, same field styling, placeholder "No rush — needs to survive a bit of pulling."
- Actions: **"Send it to Ruben"** primary (`padding:15px 30px`) + **"Cancel"** ghost (`#4d565e`). Submit creates the story with status *Requested*, notifies the admin, shows the toast "Sent · Ruben has been notified", and navigates to the new story's detail view.

### 4. Story detail (`/story/:id`)

- Back link: `← Back to the backlog / the queue / my prints` (14px/600 `#4d565e`, hover `#0b4340`) — returns to whichever list you came from.
- Two columns, `grid-template-columns: repeat(auto-fit, minmax(330px, 1fr))`, gap 26.4px, `align-items:start`.
- **Left column**
  - **3D viewer**: 380px tall, radius 14px, background `#eceef0`, `box-shadow: 0 3px 10px rgba(19,24,30,0.16)`. Drag to rotate (pointer events, ~0.008 rad/px), idle auto-spin at 0.004 rad/frame that stops on first drag. Scene in the prototype: hemisphere light `#ffffff`/`#6b747c` 1.1, directional key `#ffffff` 1.5 at (3,5,4), rim `#dfe6ee` 0.6 at (-4,1,-3), a `MeshStandardMaterial` in the wished colour (roughness 0.62, metalness 0.05), a 16% black edge overlay, and a `GridHelper(9,18)` in `#b6bcc2`/`#ced3d8` at `y=-1.5`. Camera: perspective 38°, at (0, 1.4, 5.4). **Production: swap the primitive for a real STL/3MF loader** (`STLLoader`; 3MF via `ThreeMFLoader`), auto-frame the loaded mesh, and keep the same lighting/material/grid treatment. Overlay pill bottom-left: `drag to rotate · <filename>`, 12px/600 `#4d565e` on `rgba(255,255,255,0.88)`.
  - Meta line under the viewer: dimensions · file size · `est. <time>`, 13.5px `#4d565e`, `gap:17.6px`.
  - **Conversation**: heading "Conversation" (600, 20px). Each comment: 30px avatar circle (admin `#f7ecd4`/`#79541a`… see note — prototype uses `#d9ebe9`/`#0b4340` for the printer and `#c3cddb`/`#2c3a4d` for clients) + white bubble, radius 10px, `padding:13.2px 17.6px`, `shadow 0 1px 2px rgba(19,24,30,0.14)`; author 13px/700 `#333b42` with `· relative time` in 500 `#6b747c`; body 15px, `line-height:1.45`. Composer: text input (`flex:1 1 220px`) + **Send** button in slate `#4a5d78` / `#eef1f5`, radius 8px, `padding:13.2px 24px`. Placeholder differs by role ("Reply to Ruben…" / "Ask a question or say what you changed…"). Sending notifies the other party.
- **Right column**
  - Chip row: mono ref 12px/700 `#6b747c`; status chip (see token table); if flagged, amber chip "flagged: thin walls" → in production, the flag reason the admin entered.
  - H1 story title, 600, 32px, `line-height:1.1`.
  - Uploader note, 16px `#333b42`, `line-height:1.5`.
  - **Wish card**: white, radius 14px, padding 22px, `grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))`, gap 17.6px. Fields, each a mono uppercase 12px/700 `#6b747c` label (`letter-spacing:0.06em`) over a 15.5px/700 value: **Asked by**, **Quantity** ("4 prints" / "1 print"), **Material**, **Colour wish** (18px swatch dot + name), **On offer** (tip, `#3e5069`).
  - **Progress timeline**: heading "Progress" (600, 20px). One row per status: 18px dot + 2px connector (26px tall, none on the last row) + label 15.5px/700 and a 13px `#6b747c` sub-line. Done = dot `#4a5d78`, connector `#93a3b8`, sub "cleared". Current = dot `#12645f` with `0 0 0 5px #d9ebe9` ring, sub "now". Future = `#d7dbdf`, label `#6b747c`, sub "waiting". Production: put the real timestamp in the sub-line.
  - **Admin action panel** (admin only): `#d9ebe9` panel, radius 14px, padding 22px. Heading "This one needs a yes" when *Requested*, otherwise "Move it along". Buttons: primary "Accept it" / "Move to <next status>"; secondary "Flag a model problem" (bordered ghost); "Decline" (plain ghost, *Requested* only). Every one of them notifies the uploader.

### 5. Queue (`/queue`) — admin home

- Kicker "Printer view — Prusa MK4, desk by the window" (adapt to the real printer), H1 "Your queue", sub line "N requests waiting for a yes." / "Nothing waiting. Enjoy the quiet."
- **Waiting on you** panel (only when there are *Requested* stories): `#d9ebe9`, radius 14px, padding 22px, heading 600/19px. Each row: white card, radius 10px, padding 17.6px, flex with wrap — left side ref + filename (mono 11.5px `#6b747c`), title 18px/700 (click → detail), wish line 13.5px `#4d565e` (`2 prints · PETG · Slate · offers A beer`); right side buttons **Accept** (teal), **Flag the model** (bordered ghost), **Decline** (plain ghost).
- **Rest of the queue**: white panel, radius 14px, `padding:8.8px 22px 22px`. Rows separated by `1px solid rgba(20,24,28,0.1)`, `padding:17.6px 0`, flex-wrap: 44px colour circle · title + `filename · uploader · relative time` (13px `#6b747c`) · status chip · tip (13px/600 `#3e5069`, 110px) · **"Move to <next>"** outlined teal button (radius 8px, `padding:9px 18px`, 14px/700, hover `#d9ebe9`).

### 6. Profile / my prints (`/me`)

- Header block: 96px avatar circle (`#c3cddb`/`#2c3a4d`, 32px/800 initials) + name H1 (600, 38px) + sub line ("Invited by Ruben · sees only her own stories" / "Admin · owns the printer, sees every story").
- **Stat cards**: `repeat(auto-fit, minmax(180px, 1fr))`, gap 17.6px, radius 14px, padding 22px; value 600/40px, label 14px/600 `#333b42`.
  - Client: Requests made (`#dde3ec`) · In your hands (`#d9ebe9`) · Beers owed to Ruben (`#f7ecd4`) · Your usual material (`#eaecee`)
  - Admin: Printed for the group (`#dde3ec`) · Waiting on you (`#f7ecd4`) · Printer time given (`#eceef0`) · Beers owed to you (`#eaecee`)
- **List**: heading 600/24px ("Your requests" / "Everything the group has sent you") over a white panel with the same row pattern as the queue (40px swatch · title + sub · status chip · tip). Client rows are scoped to their own stories.

---

## Interactions & Behavior

- **Navigation**: nav pills switch view; brand goes home (client → Backlog, admin → Queue). Story detail remembers the list you arrived from for its back link.
- **Toasts**: fixed, bottom-centre, `#1b2126` background, `#ffffff` text, radius 10px, `padding:14px 26.4px`, 15px/600, `box-shadow: 0 12px 32px rgba(19,24,30,0.22)`, 200ms fade+rise in, auto-dismiss after 3.2s. Used for every action that notifies someone: `Sent · Ruben has been notified`, `"<title>" → Printing · Ayla notified`, `Declined · Ayla notified`, `Flagged · Ayla notified`, `Sent · Ruben notified`.
- **Animations**: only the two above (160ms panel, 200ms toast) plus the 1px card hover lift. Keep motion this restrained.
- **Notifications**: in-app Activity panel is the minimum. Add email (or a Slack/Matrix webhook for an office) for: new upload → admin; accepted / declined / status change / flag / new comment → the other party. Respect `prefers-reduced-motion` for the animations above.
- **Empty states**: "Nothing here." per column; "Nothing waiting. Enjoy the quiet." on the queue. A brand-new client account needs a real empty state for the whole board — not designed yet, ask before inventing one.
- **Error / loading states**: not designed. Needed for upload failure, file too large, unsupported format, viewer failing to parse geometry, and optimistic status changes that fail. Follow the codebase's conventions.
- **Responsive**: every grid uses `auto-fit` + `minmax` and every flex row wraps, so the layout collapses to one column without media queries. Below ~700px the board becomes a single stacked column — if a mobile-first board is wanted, design it deliberately (a status filter row over a single list works better than a squeezed kanban).
- **Accessibility**: focus ring is `2px solid #12645f` with 2px offset, on every interactive element. Status is never colour-only (the chip carries its label). Cards are clickable `div`s in the prototype — use real links/buttons. Colour swatches need accessible names ("Teal filament"). The 3D canvas needs a text alternative (filename + dimensions).

## State Management

Prototype state, and what it maps to:

| Prototype state | Production |
| --- | --- |
| `role` | signed-in user's role from the session |
| `view`, `storyId`, `back` | router: `/board`, `/upload`, `/story/:id`, `/queue`, `/me` |
| `stories` | server data, scoped by the authorisation rules |
| `feed`, unread count | notifications table, per recipient |
| `draft` (title, file, material, colorName, tip, note, qty) | upload form state; the file goes to object storage first |
| `commentDraft` | comment composer |
| `bellOpen`, `toast` | local UI state |

Mutations, each of which writes a notification: create story · accept (Requested→Accepted) · advance status · decline · flag · add comment.

## Design Tokens

**Type** — IBM Plex Sans (400/500/600/700) for everything; IBM Plex Mono (400/500/600) for refs, filenames, uppercase micro-labels, quantity badges and numeric pickers.

| Role | Value |
| --- | --- |
| H1 (board/queue/upload) | 600, 42px, `line-height:1.05`, `letter-spacing:-0.02em` |
| H1 (profile) | 600, 38px |
| H1 (story) | 600, 32px, `line-height:1.1` |
| Section heading | 600, 20px (24px on profile list), `letter-spacing:-0.012em` |
| Stat value | 600, 40px, `line-height:1` |
| Body / intro | 400, 17px, `line-height:1.5` |
| Body small | 15–16px |
| Card title | 700, 15.5–18px |
| Meta | 12–13.5px, `#6b747c` or `#4d565e` |
| Micro label | mono, 700, 12px, uppercase, `letter-spacing:0.06em` |
| Kicker | mono, 700, 13px, uppercase, `letter-spacing:0.08em`, `#0b4340` |

**Neutrals** — bg `#f4f5f6` · surface `#eceef0` · surface-2 `#eaecee` · card `#ffffff` · border `rgba(20,24,28,0.16)` · rule `rgba(20,24,28,0.1)` · line `#d7dbdf` · `#b6bcc2` · `#8f979e` · muted text `#6b747c` · `#4d565e` · `#333b42` · near-black `#1b2126` · text `#14181c`

**Teal (primary)** — 100 `#eef6f5` · 200 `#d9ebe9` · 300 `#b6d8d5` · 400 `#6aa9a4` · 500 `#2c807a` · base `#12645f` · 600 `#0e5551` · 700 `#0b4340` · 800 `#08322f` · 900 `#062220`

**Slate (secondary)** — 100 `#eef1f5` · 200 `#dde3ec` · 300 `#c3cddb` · 400 `#93a3b8` · 500 `#6b7f99` · base `#4a5d78` · 600 `#556982` · 700 `#3e5069` · 800 `#2c3a4d` · 900 `#1c2733`

**Amber (warning / in-progress only)** — fill `#f7ecd4`, text `#79541a`

**Status chips** — 12.5px/700, radius 999px, `padding:5px 12px`:

| Status | Background | Text |
| --- | --- | --- |
| Requested | `#eaecee` | `#4d565e` |
| Accepted | `#dde3ec` | `#2c3a4d` |
| Printing | `#f7ecd4` | `#79541a` |
| Done | `#d9ebe9` | `#0b4340` |
| Delivery | `#e2e6ea` | `#1b2126` |
| Declined | `#e2e6ea` | `#6b747c` |

**Filament swatches** — Teal `#12645f` · Slate `#4a5d78` · Bone white `#eaecee` · Graphite `#1b2126` · Whatever's on `#b6bcc2`. Always with `inset 0 0 0 1px rgba(20,24,28,0.2)` so light swatches stay visible.

**Spacing scale** (px): 4.4 · 8.8 · 13.2 · 17.6 · 22 · 26.4 · 35.2 · 80 (page bottom)

**Radii**: 6px small controls (segmented options, badges) · 8px buttons and inputs · 10px cards and bubbles · 14px containers and panels · 999px avatars, dots and status chips only

**Shadows**: sm `0 1px 2px rgba(19,24,30,0.14)` · md `0 3px 10px rgba(19,24,30,0.16)` · lg `0 12px 32px rgba(19,24,30,0.22)`

## Assets

None to hand over. No images or icon set are used — avatars are initials in tinted circles, and every shape is CSS. If you add icons, a light outline set at a consistent stroke width fits; keep them at the muted text colours.

The 3D viewer uses **three.js** (`0.160.0` in the prototype, loaded from a CDN). Production needs three.js plus `STLLoader` and `ThreeMFLoader` from its examples.

## Suggested stack (only if the project has no codebase yet)

React + TypeScript with a file-based router (Next.js or Remix), a Postgres database, S3-compatible object storage for model files, magic-link auth, three.js for the viewer, and server-side authorisation middleware that implements the ownership rules above. Any equivalent stack the team already knows is a better choice than this one.

## Files

- `Pretty Please Print v2.dc.html` — the design reference (current). Open it in a browser: the role switcher in the header lets you see both the client and admin perspectives; the header nav reaches every screen.
- `support.js` — runtime needed only to open that file locally. Not part of the design and not to be ported.

## Definition of done

- Invite-only auth; no public sign-up; one admin.
- A client can upload a `.stl`/`.3mf` with title, quantity, material, colour wish, tip and note, and sees the story appear as *Requested*.
- A client sees only their own stories, on the board and in their profile — enforced server-side.
- The admin sees every story with its creator, and can accept, decline, advance the status, comment and flag.
- Every one of those actions produces a notification for the right person, visible in the Activity panel.
- Story detail renders the actual uploaded geometry, rotatable, with the wish and the stage timeline beside it.
- No fake progress anywhere: nothing claims to know what the printer is doing.

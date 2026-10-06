# Architecture and design decisions

[← back to the README](../README.md)

How the pieces work, and the places where this app deliberately departs from
the design handoff it was built from.

## The viewer

Story detail renders the actual uploaded geometry with three.js — `STLLoader`
for `.stl`, `ThreeMFLoader` for `.3mf` — auto-framed, drag to rotate, with an
idle spin that stops on first touch and never starts under
`prefers-reduced-motion`.

The handoff's lighting rig is kept exactly: hemisphere, a key at (3,5,4) and a
cool rim behind. It reads well on filament colours from near-black to bone
white, which is the whole job. The ground and grid moved to this palette,
because the print bed should look like the app it sits in.

It declines anything over **50 MB** (`VIEWER_MAX_BYTES`) and says so, with the
model's size drawn against that limit so "180 MB" means something. That is not
a limit on what may be uploaded — the cap is 250 MB — it is a limit on what a
laptop can be asked to rebuild: the viewer downloads the whole file and expands
every triangle into typed arrays, and past that size the tab stops answering
for long enough that people assume the app has broken.

The decision is made from the stored `fileSize`, **before anything is fetched**.
That ordering is the point: a check after the download would still have pulled
a quarter of a gigabyte across the office and only then given up. The refusal
is amber rather than red because nothing has failed — the file is whole, it
prints, and Download and Open in PrusaSlicer are both built for meshes this
size where a browser is not.

Three details worth knowing:

- **The bytes come through the app.** `/api/models/[id]` streams the file from
  disk. There is nothing else it could do — files are not in the web root and
  there is no storage service to hand out a URL for — but it was the right shape
  even when an object store was in the way, because it keeps `connect-src` at
  `'self'` and the viewer needs no CSP relaxation. Verified with zero violations
  in a real browser.
- **It is scoped like the story.** Same `storyScope` fragment, so a client
  asking for someone else's model gets 404, not 403.
- **three.js is imported dynamically**, inside the effect. It is fetched when
  someone opens a ticket and never on the board or the queue.

The trade: every viewer load moves the whole file through Next. At 250 MB and a
handful of people that is fine. If this ever faces a wider audience, serve
`$DATA_ROOT/uploads` from the reverse proxy directly and widen `connect-src` to
that origin — but note that the ownership check in `authz.ts` is what makes a
model private, so anything bypassing the route has to carry that check with it.

## Uploads

`POST /api/upload` is a route handler rather than a server action, so the
browser can watch a real XHR progress bar — a large model over office wifi is
too long for a spinner.

Nothing is written to disk until the bytes have been inspected, and no story row
exists until the file is in place: a rejected upload leaves nothing behind, and a
story never points at a file that was not written. The write itself is atomic —
temp file, `fsync`, rename, `fsync` the directory — because the row created
immediately afterwards claims the file is whole, and a filesystem gives none of
that away for free.

`src/lib/models.ts` decides what is acceptable, against the bytes rather than
the filename:

- **Binary STL is identified structurally** — 80-byte header, uint32 triangle
  count, exactly 50 bytes per triangle. If `84 + count × 50` does not equal
  the file length it is not a binary STL. This check runs *first*, because
  some tools write the word `solid` into a binary STL's header and a naive
  sniffer reads that as the ASCII format.
- **3MF must be a zip containing a model part**, and the archive is guarded
  against inflating to an implausible size.
- **Extension and content must agree.** An STL renamed `.3mf` is refused even
  though both are printable.
- **Storage keys are generated, never derived from the filename** — that is
  how path traversal and object overwrites happen. The display name lives in
  a database column.

Bounding boxes are measured from the actual mesh, honouring the 3MF `unit`
attribute. Nothing is inferred beyond that — see the estimate decision above.

`npm run verify:models` covers all of this with 32 checks, including a PDF and
an ELF binary renamed `.stl`, an STL that lies about its triangle count, a
traversal path inside a 3MF, and a zip bomb.

### How big a model may be, and the limit that was not real

The cap is **250 MB**, raised from the handoff's 50 MB because real work went
past it — multi-object plates and scanned meshes — and the app's answer was
"decimate the mesh", which is asking somebody to damage their model to fit an
arbitrary number.

Raising it turned up something worse: **the 50 MB was never real either.** Next
truncates a request body at 10 MB whenever middleware is in play, and this app
runs middleware on every route to mint the CSP nonce. Anything past 10 MB
arrived short, `request.formData()` threw on the truncated body, and the
uploader was told *"That upload did not arrive intact"* — which reads like a
network fault and sends people to look in the wrong place. It survived the
whole life of the app because every fixture in every suite is a few hundred
bytes; nothing had ever uploaded a big file. `verify:upload` now sends a 12 MB
model on every run, which is the cheapest thing that would have caught it.

Three numbers, in `src/lib/upload-limits.ts`, deliberately in one place because
the form, the validator, the OpenAPI document and the framework config all need
to agree:

| | |
| --- | --- |
| `MAX_UPLOAD_BYTES` | 250 MB — the file itself |
| `MAX_REQUEST_BYTES` | `× 1.2` — the whole multipart body, and the transport ceiling. It has to be the more generous of the two, or a file just over the cap gets truncated into a parse error instead of an honest "too large" |
| `MAX_INFLATED_BYTES` | `× 3` — what a 3MF may inflate to, scaled off the cap so raising one cannot leave the other behind |

### Why the memory is bounded by a queue rather than a stream

`request.formData()` buffers the entire body before a line of this app's code
runs, so peak memory is decided by how many large uploads overlap — not by
anything the validator does. The security audit named the two answers: a
streaming parse, or a size-based queue. This is the queue: at most two uploads
are handled at once (`MAX_CONCURRENT_UPLOADS`), a third waits rather than being
refused, and only a long queue gets a `503`.

The streaming parse is the better answer and it is not reachable from here. It
needs the file to stop arriving as multipart at all — a raw body with the wish
in a header, or a two-phase upload — because by the time a route handler can
see the request, the framework has already buffered it. That is a protocol
change touching the form, the API, the OpenAPI document and two suites, and it
is worth doing the day the queue is the thing that hurts.

## Storage is a directory

Model files live in `$DATA_ROOT/uploads`, at the path their `storageKey` names.
`src/lib/storage.ts` is six operations — `mkdir`, an atomic write, a read
stream, `unlink`, `copyFile`, and a path resolver — and that is the whole of it.

It used to be MinIO behind the S3 API, and the S3 part was never doing any work.
Every byte was already proxied through the app, because the deployment published
no port for storage and a signed URL would have pointed somewhere the browser
could not reach. The app made six calls. Those six calls are the six operations
above.

What the object store cost in exchange was a container, a credential pair, a
healthcheck, two AWS SDK packages, and eventually a supply-chain problem: MinIO
withdrew its community images *and* binaries, so the project mirrored one image
and then compiled its own, which still carried 63 HIGH/CRITICAL advisories that
no upgrade fixed because upstream's newest release shipped byte-identical
vulnerable dependencies. For five people and one printer, putting a few hundred
megabytes of STL onto a disk the app already had mounted, that was a great deal
of machinery to keep alive. [Deployment](deployment.md) tells that story from the
operator's side.

Three decisions inside it are worth knowing:

- **Writes are atomic, deliberately.** Temp file, `fsync`, rename, `fsync` the
  directory. S3 gave that away for free — an object appeared whole or not at all
  — and a filesystem does not, while the story row created immediately afterwards
  claims the file is complete.
- **Mode 644 under 755 directories**, not owner-only. Postgres' data directory
  being mode 700 is why the README carries a paragraph explaining you cannot back
  it up as yourself; one such trap is enough. Models are not secret at rest —
  they are gated at the route by `storyScope`. The cost is that *removing* the
  tree needs root or a container, which is the lesser annoyance: backups happen
  often and deletions once. Both modes live in `storage-layout.ts` because the
  app and the one-shot migration have to agree and once did not.
- **Keys are resolved, not prefix-matched.** `storageKey` comes from a database
  column, so `pathFor` resolves it and refuses anything that lands outside the
  root — the same reasoning `safe-redirect.ts` sets out at length. Keys are
  generated UUIDs, so it should never fire; the cost of being wrong is writing
  outside the volume.

## Importing from a link

Where a deployment switches it on, a request can start from a link to a model
on Printables instead of from a file on the requester's disk. The server lists
the model's `.stl` and `.3mf` files, the requester picks one, and the server
fetches it. [Deployment](deployment.md#importing-from-a-link) covers switching
it on; this is how it is built.

**It is a second door onto the same room.** Everything that turns bytes into a
ticket — inspecting them, the atomic write, the row, the notification, the
audit event — used to live in the upload route, because that was the only way
a model arrived. It moved to `src/lib/intake.ts`, and both doors now hand it a
name and some bytes. The reasoning is the service layer's, unchanged: a rule
that lives in the caller holds only for the caller that remembered it. An
imported file is refused for exactly the reasons an uploaded one is, by the
same lines of code, and what the site *called* the file counts for nothing.

**The requester chooses the model; the code chooses the host.** This is the one
place the app makes a request to somebody else's server because a signed-in
person asked, so the question that shapes it is whose choice the address is:

1. The pasted link is parsed for a model id and thrown away
   (`src/lib/import-source.ts`). Only digits survive. The host is compared
   whole, after parsing — `printables.com.evil.example` and
   `printables.com@evil.example` both contain the right letters.
2. The listing is asked of one fixed endpoint, with the id as a GraphQL
   variable rather than part of a URL.
3. The download link comes back from that endpoint and is fetched only if it
   is on the one origin Printables serves files from. Anything else is refused
   before a connection is opened.
4. Redirects are an error. A redirect is the far end choosing a new address,
   which is the thing being prevented.

The listing is fetched again at import time rather than trusted from the
browser, so a client can name a file only by id, and only one that belongs to
the model it named. The download is cut off at the size the listing gave —
which was already held to the upload cap — so a file larger than advertised is
refused as it arrives rather than after it has been buffered.

**Two things it shares with an upload, on purpose.** The wish is validated
before anything is fetched: a colour that is off the shelf should not cost a
200 MB download to discover. And the fetch takes one of the same two slots an
upload does (`src/lib/upload-slots.ts`), because it holds the same memory; two
gates of two would have been a gate of four.

**The browser never talks to Printables.** It posts the link to this app and
gets the listing back, which is why `connect-src 'self'` did not have to move.

**It is off by default, and the API is not a published one.** Printables has no
documented public API; this speaks the GraphQL endpoint its own website uses.
That is the honest weak point, and it is handled by failing in words: the
answer is parsed against a schema, and a shape that does not match is a `502`
saying the API may have changed and to upload the file instead. Nothing falls
back to guessing. `Story.sourceUrl` records the model's page — rebuilt from
the API's own id and slug, never copied from what was typed — and is checked
again before it is rendered, because it becomes an `href`.

Only Printables. MakerWorld answers a server's request for a model page with a
browser challenge, and by the account of the tools that do fetch from it, hands
files only to a signed-in session. Thingiverse's API answers `401` without a
token the operator would have to register for. The first is not something a
server can do on a requester's behalf without pretending to be a browser; the
second is a possible later source.

`npm run verify:import` drives all of it against a stand-in
(`scripts/stubs/printables-stub.mjs`), because most of the above is refusals
and a refusal can only be tested against a far end willing to misbehave.

## Decisions taken against the handoff

The handoff contradicts itself in two places and leaves three things open.
All five are settled, and recorded here so nobody has to re-derive them:

| Question | Decision |
| --- | --- |
| Tip pill radius — README §3 says `8px`, the prototype renders `999px` | **8px.** The tokens reserve `999px` for "avatars, dots and status chips only", so two written sources beat the render. |
| *Printing* column label — README §2 says amber `#79541a`, the prototype uses teal `#0b4340` | **Amber.** The tokens call amber "warning / in-progress only", and Printing is the in-progress state. It also makes the live column findable. |
| Where declined stories go — `Declined` is not in the flow, so it has no column | **Off the board entirely.** The board is for work that is still moving; the profile at `/me` carries the whole history, declined included. |
| The whole-board empty state, which the handoff says to ask about | **Minimal.** One quiet panel saying what is true, with the Upload button already above it. No invented onboarding. |
| Print-time estimates | **Dropped.** See below. |

### The one stat that changed

The handoff's admin profile card is "Printer time given". There is no honest
number behind it once print-time estimates are gone, so rather than invent
one it counts something real — how much geometry has actually come off the
plate, in bytes. Swap it back the day a slicer is wired in and the hours are
known rather than assumed.

### Why there is no print-time estimate

A figure derived from the bounding box is a guess dressed as a measurement —
it cannot know infill, layer height, wall count or the printer's speeds, and
it is worst on exactly the models people care about. The handoff's definition
of done says nothing should claim to know what the printer is doing, and a
number someone might plan their afternoon around is the kind of claim it warns
about.

So the app shows only what it measured: **dimensions and file size**. A story
in *Printing* says `on the bed` and nothing more.

To add a real one, run `prusa-slicer --export-gcode` in a background job after
upload and read `; estimated printing time` out of the G-code. `src/lib/models.ts`
says so at the point where the old heuristic used to live.

## The API, and why there is a service layer

Everything the queue can do is reachable over JSON as well as through the
forms — see [the API](api.md). Adding that changed the shape of the code in
one significant way, and it is the part worth knowing about.

The admin actions used to live entirely in `src/app/actions/stories.ts`: read
the `FormData`, check the role, check the transition, write the row, notify the
uploader, write the audit event, redirect. Copying that into a route handler
would have meant two implementations of four rules, and the second one only has
to forget once. So the operations moved to **`src/lib/stories.ts`**, which
takes an `Actor` and decides for itself who may do what. The server actions
became adapters — `FormData` in, redirect out — and the route handlers are
adapters too: JSON in, status code out.

The practical test of that is `npm run verify:api`, which drives the JSON
surface against every rule `npm run verify:queue` drives through the forms, and
gets the same answers.

Three decisions inside it that look odd on purpose:

- **The API answers 403 where a page answers 404.** Everywhere else, a surface
  you may not reach returns 404 so that a 403 cannot confirm it exists. That
  reasoning does not survive publishing an OpenAPI document:
  `/api/stories/{id}/advance` is listed at `/api/openapi.json`, so hiding it is
  theatre — and it would tell an honest client their ticket had vanished when
  the truth is that they are not the printer owner. Whether a *ticket* exists
  is still hidden, through the same `storyScope` fragment.
- **There is no endpoint that sets a status.** `advance` derives the next state
  rather than accepting one. An endpoint taking a target status is an
  invitation to skip a step, and the board's whole claim is that it shows where
  work actually is.
- **Nothing spreads a database row onto the wire.** `src/lib/api.ts` names
  every field it emits. That is what keeps `storageKey` — the file's path under
  `MODELS_ROOT` — out of every response without anyone having to remember to
  strip it, and it is what makes a column added tomorrow private by default.

The document at `/api/openapi.json` is assembled per request from two halves:
the app's own paths, written out, with request bodies converted from the same
Zod schemas the handlers validate with; and Better Auth's, generated by the
library so they cannot drift when a plugin is added or a version bumped.

The console at `/docs` is a plain HTML route rather than a page, because
Swagger UI's stylesheet expects to own the document and the root layout owns
this one — four self-hosted webfonts, a diner palette and a paper texture.
Swagger UI itself is copied out of `node_modules` at build time by
`scripts/vendor-swagger.ts`: a CDN would be refused by `script-src 'self'`,
would be unreachable on a NAS with no outbound internet, and would put a third
party in the request path of an otherwise entirely first-party tool.

## The audit page, and why it grew panels

`/admin/audit` was always defended with the same argument: for one printer and
five colleagues, a screen the owner glances at beats threshold alerts nobody
tunes and everybody learns to ignore. That argument has a hole in it — it only
works if somebody looks, and a reverse-chronological wall of rows is not
something anyone opens twice.

So three panels sit above the log, in `src/lib/dashboard.ts`. They answer the
questions a person arrives with, none of which a log answers by being scrolled:
**is anything being refused**, **where is work piling up**, and **what should I
buy**.

Two rules held while building them, and they are the interesting part:

- **Aggregation only.** No column exists because of this page, and nothing is
  recorded for it. Everything is derived from rows that were already there — the
  stage medians, for instance, are reconstructed from the `from` field every
  `story.status_changed` was already carrying. A dashboard that needs its own
  schema has stopped being a view and started being a feature.
- **Events from the trail, work from the tables.** The refusals panel reads
  `AuditEvent`; the material, colour and size panel reads `Story`. The audit
  trail is a log, not a warehouse, and querying it for things the domain tables
  already know is how a log slowly turns into a schema nobody meant to design.

No charting library. A CDN would be refused by `script-src 'self'`, would be
unreachable on a NAS with no outbound internet, and it is four bars — the same
reasoning that vendored Swagger UI rather than linking it.

## The feature-request track ('frr')

A second backlog lives at `/frr`: anyone files a feature request, and the owner
triages it through the same board, queue, status flow, conversation,
notifications and audit trail as a print — see
[Feature requests](feature-requests.md).

It is built as a deliberate **parallel** of the print backlog, not folded into
it. There is a `FeatureRequest`/`FeatureComment` pair of tables and a
`src/lib/features.ts` service that mirrors `stories.ts` operation-for-operation;
`Story`, the upload, the viewer and the JSON API are untouched, with no `kind`
flag threading feature logic through them. The pure rules sit beside the print
ones in `scope.ts` — `featureScope`, `FEATURE_FLOW`, `assertFeatureTransition`,
`featureRef` — and are kept parallel rather than merged into one generic helper
on purpose: the print rules are load-bearing and exercised directly by the
suites, so a shared cleverness a change to one backlog could bend for the other
is a worse trade than a little duplication. The *shape* is identical, which is
what makes the owner handle a request exactly as they handle a print.

Where the two backlogs meet is shared infrastructure, extended additively: one
`Notification` row can point at a story or a feature (a nullable `featureId`,
and the Activity feed routes to `/story` or `/frr` on whichever is set), and the
audit trail gained `feature.*` verbs. Neither change alters how a print behaves.
`npm run verify:frr` drives the whole track the way `verify:queue` drives the
print one.

## Later additions, kept thin

Several features that came after are deliberately additions on top of the two
backlogs rather than new subsystems, each covered by the verify suite for its
side:

- **Withdraw reaches `Accepted`, and a past print can be re-queued.** The
  withdraw window widened from `Requested`/`Declined` to include `Accepted`
  (before the bed is committed). `requeueStory` clones an old ticket into a
  fresh `Requested` one, copying the file server-side (`copyModel`) to a new
  object so the two own independent bytes. The wish can be changed on the
  way: the control leads to `/story/{id}/again`, the request form filled in
  with the old ticket, and `POST /api/stories/{id}/requeue` takes the changed
  fields and validates the merged wish exactly as an upload's.
- **`/history`** is a scoped read of the finished prints (`Delivery`/`Done`/
  `Declined`) through the same `storyScope`, filtered by status/material/date,
  with the re-queue control on each row. `/board` and `/me` are untouched.
- **The benefits (tips) are owner-managed data**, not a constant: a `Benefit`
  table the owner edits at `/admin/benefits`, seeded with the original five.
  `Story.tip` stays a plain string so a past request survives an edit, and the
  upload endpoint validates the tip against the current *active* list — the
  catalogue, not the form, is authoritative.
- **Materials and colours are owner-managed data**, with ordered
  `CatalogMaterial` and `CatalogColor` rows. The upload page reads only active
  combinations and the upload endpoint repeats that lookup authoritatively.
  A story snapshots the labels, representative hex, CSS swatch, and swatch
  mode so later catalogue edits or deletion do not rewrite history. Swatch
  mode is explicit data (`solid`, `gradient`, or `whatever`), never inferred
  from an editable label.
- **A feature request's priority is editable in any status, and both `/frr`
  views filter** by priority/status/category. The filter is ANDed onto
  `featureScope`, so it can only ever narrow a caller's own set.
- **A print request has a priority**, as a feature request has had since
  FRR-104 — and built as the parallel of that, not a shared piece: its own
  `StoryPriority` enum and `changeStoryPriority` in `stories.ts`, drawn with
  the same `PRIORITY_CHIP`. Set on the request form, changeable on the ticket
  by the requester or the owner, and over `POST /api/stories/{id}/priority`.
  Two deliberate differences from the feature side: it is only editable while
  the ticket is on the rail (a finished print has nothing left to order, and
  editing it afterwards would rewrite what was asked for), and the board card
  marks it only when it is *not* medium, so the mark means something. The
  queue's *Waiting on you* reads high first, oldest first within a priority.
- **Prints by person** (`/admin/prints`) is the owner's answer to "what has
  this person sent me". It adds no new read: the list is `listStories` with an
  `uploaderIds` filter ANDed onto `storyScope` like every other filter, so the
  same parameter on `GET /api/stories` gives a client their own tickets or
  nothing. The roster with a count per person (`listPeopleWithPrints`) is the
  one new query, and it refuses anyone but the owner in the service — a count
  beside each colleague's name is a view into other people's work. The
  selection is a query string of ids, each person a link that toggles itself,
  so there is no form control and nothing to hydrate.
- **An optional free-text print-settings field** rides along on a request and
  shows on the ticket for the owner. The structured / access-gated "advanced
  mode" is deferred.

## What is deliberately not built

- **Email/Slack notification delivery.** `Notification` rows and the `notify()`
  helper exist and the Activity panel reads them; only the in-app record is
  written so far.
- **A designed whole-board empty state.** There is a minimal one that says what
  is true rather than showing a blank page, but the handoff asks for a design
  decision here — treat it as a placeholder.

## Layout

```
prisma/
  schema.prisma          auth tables (Better Auth's shapes) + domain models
  migrations/            one directory per change; each must leave the previous image working
  seed.ts                bootstraps the single admin, prints its setup link
  reset-token.ts         set-password token format, shared with the app
src/lib/
  auth.ts                Better Auth config — the invite gate lives here
  auth-client.ts         browser client (username, passkey, admin)
  auth-rules.ts          username and password rules, shared with the forms
  auth-methods.ts        which ways in are on, and who may be given an account
  authz.ts               requireUser/requireAdmin, notify, the printer owner
  scope.ts               pure authorisation rules: scopes, the two status flows
  reauth.ts              "sign in again" before handing out access
  invites.ts             invite lifecycle, and the claim an account is opened under
  password-reset.ts      minting, reading and restoring set-password links
  tokens.ts              CSPRNG tokens, digests, initials
  email.ts               Resend → SMTP → nothing, plus the templates
  audit.ts               the append-only trail
  dashboard.ts           the three panels above the audit log
  stories.ts             every operation on a print ticket — the rules, once
  features.ts            every operation on a feature request — the 'frr' track
  benefits.ts            the owner-managed benefits (tip) catalogue
  catalog.ts             request schemas, priorities and catalogue types, shared with the browser
  catalog-data.ts        live material/colour reads and the authoritative lookup
  models.ts              upload validation + mesh measurement
  intake.ts              bytes into a ticket — shared by upload and import
  import.ts              fetching a model from Printables, and what it refuses
  import-source.ts       what counts as a link, and which sources are on
  upload-slots.ts        how many models are held in memory at once
  upload-limits.ts       the three size limits, in one place
  storage.ts             model files on disk: atomic writes, generated keys
  storage-layout.ts      file and directory modes, shared with the migration
  slicer-token.ts        the short-lived credential in an "Open in PrusaSlicer" link
  notifications.ts       the Activity feed, scoped by recipient
  api.ts                 the JSON boundary: 401/403, Origin, wire format
  openapi.ts             the OpenAPI 3.1 document, app half + Better Auth half
  csp.ts                 Content-Security-Policy builder + nonce
  safe-redirect.ts       redirect targets, decided by a URL parser
  client-ip.ts           whose address the audit trail believes
  db.ts, runtime.ts      the Prisma client; build-phase detection
src/app/
  signin/  reauth/       sign-in; the re-authentication prompt
  invite/[token]/        the registration page and its server action
  set-password/          where a reset link lands; sets no session
  welcome/               passkey enrolment after registration
  board/                 the rail: tickets still moving, scoped per role
  queue/                 the printer owner's queue, urgent first
  upload/                the request form: dropzone, wish, XHR progress
  story/[id]/            a ticket: viewer, facts, priority, conversation
  story/[id]/again/      the request form again, filled in from an old ticket
  history/               finished prints, filterable, with "Print again"
  me/                    your own tickets and the profile card
  frr/                   the feature-request track: board, new, queue, [id]
  docs/                  the Swagger console (a route, not a page)
  actions/               server actions — thin adapters over src/lib
src/app/admin/           the printer owner's pages; 404 for anyone else
  invites/               the guest list: invite, reset, suspend
  prints/                prints by person
  catalog/               materials and colours on the shelf
  benefits/              the benefits catalogue
  audit/                 the dashboard and the log
src/app/api/
  auth/[...all]/         every Better Auth endpoint
  upload/                the multipart door onto intake.ts
  import/                the link door: list a model's files, import one
  stories/               list, read, withdraw
  stories/[id]/…         advance, decline, flag, comments, priority, requeue
  catalog/               what can be asked for right now
  models/[id]/           the model's bytes, scoped like the ticket
  notifications/         the Activity feed
  openapi.json/          the document
  health/                the only endpoint with no session
src/components/          shared pieces: cards, chips, the viewer, the pickers
scripts/
  deploy-wizard.sh       on the host: pick an image, read the upgrade notes, verify, deploy, roll back
  release-wizard.sh      in a checkout: a release from the changelog to the published images
  full-test.sh           the whole local run: gates, a fresh stack, every suite
  tests/                 the three shell scripts above, tested in sandboxes
  verify-models.ts       validator vs. hostile fixtures
  verify-auth.ts         registration, sign-in and password reset
  verify-sso.ts          single sign-on, and everything a provider can get wrong
  verify-upload.ts       upload -> board -> ticket, and printing again
  verify-import.ts       a model from a link, and every way the far end can misbehave
  stubs/                 stand-ins for Printables and for an OIDC provider
  verify-queue.ts        the queue, the flow, priority, prints by person
  verify-frr.ts          the feature-request track, filed and triaged
  verify-benefits.ts     the owner-managed benefits catalogue
  verify-catalog.ts      the owner-managed material/colour catalogue
  verify-api.ts          the JSON API, the document and the console
  verify-passkey.ts      WebAuthn in a real browser
  security-probe.ts      OWASP-mapped security probes
  check-secrets.ts       credential shapes in tracked files; also the pre-commit hook
  check-links.ts         internal markdown links and anchors
  use-container-env.ts   points the host-side suites at the running stack
  vendor-swagger.ts      copies Swagger UI into public/docs at build time
  export-storage.ts      the one-shot copy of models out of the old object store
  install-slicer-handler.sh, prusa-open.sh   the "Open in PrusaSlicer" helper
  screenshot.ts          the main screens to PNG
```

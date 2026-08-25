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

Three details worth knowing:

- **The bytes are proxied, not signed.** `/api/models/[id]` streams from
  object storage through the app. That is not the elegant option, it is the
  only correct one here: the deployment publishes no port for MinIO, so a
  signed URL would point at something the browser cannot reach. Proxying also
  keeps `connect-src` at `'self'`, so the viewer needs no CSP relaxation —
  verified with zero violations in a real browser.
- **It is scoped like the story.** Same `storyScope` fragment, so a client
  asking for someone else's model gets 404, not 403.
- **three.js is imported dynamically**, inside the effect. It is fetched when
  someone opens a ticket and never on the board or the queue.

The trade: every viewer load moves the whole file through Next. At 50 MB and a
handful of people that is fine. If this ever faces a wider audience, put
storage behind the same reverse proxy, hand out a signed URL, and widen
`connect-src` to that origin.

## Uploads

`POST /api/upload` is a route handler rather than a server action, so the
browser can watch a real XHR progress bar — a 50 MB model over office wifi is
too long for a spinner.

Nothing is written to storage until the bytes have been inspected, and no
story row exists until the object is in place: a rejected file leaves nothing
behind, and a story never points at an object that was not stored.

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

`npm run verify:models` covers all of this with 29 checks, including a PDF and
an ELF binary renamed `.stl`, an STL that lies about its triangle count, a
traversal path inside a 3MF, and a zip bomb.

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
  every field it emits. That is what keeps `storageKey` — the object's name in
  the bucket — out of every response without anyone having to remember to strip
  it, and it is what makes a column added tomorrow private by default.

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
  seed.ts                bootstraps the single admin, prints its setup link
  reset-token.ts         set-password token format, shared with the app
src/lib/
  auth.ts                Better Auth config — the invite gate lives here
  auth-client.ts         browser client (username, passkey, admin)
  auth-rules.ts          username and password rules, shared with the forms
  password-reset.ts      minting, reading and restoring set-password links
  authz.ts               requireUser/requireAdmin/storyScope + status flow
  invites.ts             invite lifecycle: mint, resend, revoke, consume
  email.ts               Resend → SMTP → console, plus templates
  tokens.ts              CSPRNG tokens, digests, initials
src/app/
  signin/                passkey button over a username/password form
  invite/[token]/        the registration page and its server action
  set-password/          where a reset link lands; sets no session
  welcome/               passkey enrolment after registration
  admin/invites/         the guest list (admin only)
  scope.ts               pure authorisation predicates (no server-only)
  csp.ts                 Content-Security-Policy builder + nonce
  audit.ts               the append-only trail
  models.ts              upload validation + mesh measurement
  storage.ts             S3/MinIO, signed URLs, generated keys
  catalog.ts             the fixed choices a request is made from
  stories.ts             every operation on a ticket — the rules, once
  notifications.ts       the Activity feed, scoped by recipient
  api.ts                 the JSON boundary: 401/403, Origin, wire format
  openapi.ts             the OpenAPI 3.1 document, app half + Better Auth half
  features.ts            every operation on a feature request — the 'frr' track
src/app/
  board/                 the kanban backlog, scoped per role
  upload/                dropzone, wish form, XHR progress
  story/[id]/            story detail (read half)
  api/upload/            validation, storage, story creation
  api/stories/           the tickets, the flow, the conversation
  api/notifications/     the Activity feed
  api/openapi.json/      the document
  docs/                  the Swagger console (a route, not a page)
  frr/                   the feature-request track: board, new, queue, [id]
scripts/
  deploy-wizard.sh       pick an image, verify it, deploy, auto-rollback
  vendor-swagger.ts      copies Swagger UI into public/docs at build time
  verify-models.ts       validator vs. hostile fixtures
  verify-auth.ts         registration, sign-in and password reset
  verify-upload.ts       upload -> board -> story
  verify-passkey.ts      WebAuthn in a real browser
  verify-api.ts          the JSON API, the document and the console
  verify-frr.ts          the feature-request track, filed and triaged
  security-probe.ts      OWASP-mapped security probes
src/app/admin/
  invites/               the guest list
  audit/                 the audit log, admin only
```

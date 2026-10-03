# Changelog

Notable changes. Every entry names a released version; deployments pin
`PPP_TAG` to one of these, or to a commit SHA if they follow `main` closely.

## Unreleased

### Added

- **Materials and colours are owner-managed.** `/admin/catalog` replaces the
  fixed compile-time list with an ordered catalogue. The owner can add, rename,
  temporarily hide, remove, and reorder materials and their colours. Swatches
  can be solid, a two-colour gradient, or an explicit “whatever” rainbow with
  a question mark. Uploads validate against the live catalogue on the server;
  old tickets retain label, representative colour, rendered swatch, and mode
  snapshots when catalogue entries later change. `npm run verify:catalog`
  covers the owner-only forms, ordering, validation, and snapshot contract.

  Five things were put right in review, each of them found by running it
  against a database that already had tickets rather than a fresh one:

  - **A rollback could not file a request.** The migration dropped the
    `Material` enum, which the previous image's client still casts every insert
    to. Rolled back onto the migrated database, every page rendered and every
    upload answered 500. A follow-up migration puts the type back, unused.
  - **The colour band on every board card had vanished**, and "whatever"
    tickets showed a clipped question mark in the corner instead. The swatch
    component and its caller disagreed about `display`.
  - **Printing a ticket again lost its swatch and ignored the shelf.** The copy
    came back solid, and it worked for a colour the owner had just retired
    while a fresh upload of the same colour was refused. A re-queue now makes
    the same catalogue lookup an upload does.
  - **Old "Whatever's on" tickets had been repainted** from grey to purple in
    the viewer and the audit tally. Their representative colour is back to
    what they were filed with; the rainbow stays in the swatch.
  - **The catalogue page ran off the side of a phone**, and `/history` drew
    gradients as flat dots.

  `GET /api/catalog` is new: once the choices stopped being a fixed list the
  OpenAPI document could no longer enumerate them, and reading the upload
  page's HTML was the only way for an API client to learn a valid pair. A
  ticket's `color` now carries `style` and `mode` beside `hex`.

- **Rocket Loader has to be off, and the docs now say so.** Reported by NelsonFx
  on the pull request that added the tunnel overlay, and it is the first thing an
  orange-clouded deployment hits. Cloudflare's Rocket Loader rewrites every
  `<script>` to load through its own deferred loader, and the rewritten tags do
  not carry the per-request nonce that `script-src 'self' 'nonce-…'
  'strict-dynamic'` requires — so hydration never happens and no client-side code
  runs at all.

  The failure is quieter than an error: every page renders from server HTML and
  looks right, and simply does nothing. Sign-in is where it shows first, because
  `/signin` is a client component and both the passkey and password paths go
  through the auth client, but it takes the upload progress bar, the viewer and
  the Activity menu with it. CSP violations appear in the browser console and
  nothing appears in the app's logs, because the requests never arrive.

  There is no way to keep both: the alternative is `unsafe-inline`, which throws
  away what the nonce is for. Documented in the README's troubleshooting list and
  in the Cloudflare section of [deployment](docs/deployment.md), with Auto Minify
  and Brotli noted as safe.

- **`npm run migrate:storage` — copy every model out of MinIO, and prove the
  copy is complete.** The first step of removing the object store, and it
  changes nothing about how the app runs: the app keeps reading from MinIO, and
  rolling back is deleting what the script wrote.

  It exists as code rather than a documented `mc` command because of one fact
  about MinIO's on-disk format. Objects are not files — each is a directory
  named after the key, and anything under the inline threshold lives *inside*
  `xl.meta` rather than beside it. On the dataset this was written against, 160
  of 179. So `cp -r` recovers the nineteen that have a separate part file and
  silently loses the rest: the tree is there, the filenames are there, every
  ticket page renders, and the only symptom is that opening a model fails. The
  bytes come out through the S3 API or not at all.

  The verification is the half that matters, and it interrogates the
  **database**, not MinIO — asking the object store whether it exported
  everything is asking the wrong witness, since it would confirm all 179 while
  160 arrived empty. Every `Story` row must have a readable file of the size the
  row records, whose first bytes are still the model it claims to be: a binary
  STL states its own triangle count, and `84 + count × 50` has to equal the file
  length, which is the same structural check the upload validator makes. A
  zero-filled file of the right size passes a size comparison and fails this.

  It refuses to exit 0 with a single row unaccounted for, and it refuses to run
  at all if pointed at MinIO's own data directory — the one mistake that would
  not be recoverable, so it is blocked in code rather than in prose. Writes are
  atomic (temp file, `fsync`, rename, `fsync` the directory), because S3 gave
  that for free and a database row will claim the file is whole. Re-running
  skips what is already correct, so it can be run now and again just before the
  switch to pick up anything uploaded in between.

  Verified by breaking it on purpose: truncating one exported file and deleting
  another makes it exit 1 and name both, and a re-run repairs exactly those two
  and nothing else. A verifier nobody has watched fail is not a verifier.

- **`/admin/audit` is a dashboard now, not just a log.** The page was built on
  the argument that a screen somebody glances at beats alerts nobody tunes —
  which only holds if somebody actually looks, and a wall of rows is not
  something anyone opens twice. Three panels sit above the log, answering the
  questions a person arrives with rather than the one a log answers:

  - **Anything being refused** — a fortnight of `upload.rejected`,
    `invite.rejected` and `file.refused`, by day and by verb, with the most
    recent few and why. A run of `file.refused` from one account walking
    consecutive story ids is the shape of somebody looking around, and it is
    now the first thing on the page.
  - **Where the work is sitting** — queue depth per stage, the longest wait in
    each, and the median that stage has *historically* taken. Depth alone
    cannot say whether three in *Requested* means slow triage or a busy
    morning; a median beside it can. Reconstructed from the trail, which was
    already recording the stage each move came `from`.
  - **What gets asked for** — material and colour, which turn into a shopping
    list, and file size in buckets, which is the panel that says whether the
    250 MB cap and the 50 MB viewer threshold were set at the right numbers.

  Pure aggregation: no new column, nothing recorded for it, and no charting
  library — a CDN would be refused by `script-src 'self'` and it is four bars.

- **A Cloudflare Tunnel overlay, for a deployment whose public address is not
  its own to keep.** `docker-compose.tunnel.yml` runs a `cloudflared` connector
  beside the app, and is used *instead of* `docker-compose.proxy.yml`. The
  origin dials outward, so there is no port to forward, no `A` record to keep
  current, and an address the ISP can take back stops being able to take the
  site down. That is the failure it was written for: a DSL-to-cable migration
  handed the old address back, the record went on pointing at an IP that no
  longer routed, and Cloudflare answered 522 while the app stayed healthy, its
  certificate valid and its own logs entirely quiet — because from the app's
  side nothing was wrong.

  It publishes no host port, which is the condition that keeps
  `TRUST_PROXY_HEADERS=cloudflare` honest rather than merely set, and it
  deliberately declares no `environment:` of its own: a service-level value
  beats `env_file:`, so an overlay that hard-codes one overrules `.env.docker`
  in silence. That is the trap `docker-compose.proxy.yml` already carries a
  paragraph about, and repeating it here would have been the same bug twice.

  Documented beside the Nginx Proxy Manager route, along with the limit
  Cloudflare imposes either way: its request-body cap is 100 MB on Free and
  Pro against this app's own 250 MB, and over it the edge answers 413 before
  the app is reached at all. Any orange-clouded deployment already has that
  ceiling, tunnel or not.

- **Models up to 250 MB, from 50 MB.** Real work went past the old cap —
  multi-object plates and scanned meshes — and the app's answer was "decimate
  the mesh", which is asking somebody to damage their model to fit an arbitrary
  number. The size, the multipart allowance, the zip-inflation guard and the
  triangle ceiling now live together in `src/lib/upload-limits.ts`, because the
  form, the validator, the OpenAPI document and the framework config all have
  to agree — the upload form had grown its own copy of the limit, the extension
  list *and* `formatBytes`, so raising the cap used to mean finding five places.

  The cap is made safe by a **queue rather than a stream**: at most two uploads
  are handled at once, a third waits rather than being refused, and only a long
  queue gets a 503. `request.formData()` buffers the whole body before this
  app's code runs, so overlap is what sets peak memory and bounding the overlap
  is what bounds it. That is one of the two answers the security audit named;
  the other, a streaming parse, needs the file to stop arriving as multipart
  and is written up in `docs/architecture.md`.

  Deployments behind a reverse proxy need `client_max_body_size` raised to
  match — see `docs/deployment.md`. That had never bitten before, because
  nothing large enough had ever reached the proxy.

- **The viewer declines models it cannot rebuild, and explains itself.** A
  250 MB cap makes it possible to store a model five times larger than a
  browser can handle, and the viewer's first act is to download the whole
  thing — so opening such a ticket would have pulled a quarter of a gigabyte
  across the office and then frozen the tab. Past 50 MB (`VIEWER_MAX_BYTES`)
  it now shows why instead: what the viewer downloads and rebuilds, why that
  does not finish at this size, and the model drawn to scale against the limit
  with the multiple spelled out, so the number means something. Decided from
  the stored size **before any fetch is made**. Amber rather than red, because
  nothing has failed — the file is whole, it prints, and Download and Open in
  PrusaSlicer are both better suited to a mesh this size than a browser was
  ever going to be.

- **Download the model.** Every ticket now has a plain **Download** button
  beside *Open in PrusaSlicer* — the same bytes with no helper and no setup,
  for the printer owner who is not sitting at the machine with the slicer on
  it, or who uses a different slicer. There is no new server surface behind it:
  `/api/models/[id]` already streamed the file with
  `Content-Disposition: attachment`, already scoped it with `storyScope`, and
  already recorded `file.downloaded` whenever bytes go to somebody other than
  the uploader. Shown to anyone who can see the ticket, and kept *above* the
  slicer disclosure so the simple answer is the visible one.

- **Re-authentication before handing out access.** Inviting somebody,
  re-sending an invitation, minting a password-reset link and revoking or
  restoring access now require a sign-in from the last five minutes; an older
  session is sent to a new `/reauth` screen to confirm with a passkey or a
  password. A shorter session limits how long a captured cookie is useful, but
  these four actions outlive any session — an invitation mints an account, a
  reset link is the ability to become somebody else — and asking for the
  credential again is the one control a copied cookie cannot satisfy.
  Withdrawing an unaccepted invitation is deliberately not gated, and neither
  is `/admin/benefits`. `/reauth` offers the password as well as the passkey,
  because requiring a passkey would leave an admin without one unable to revoke
  access. Freshness is the age of the session itself: Better Auth has no
  assert-without-signing-in primitive, so re-authenticating mints a new session
  and the superseded row is left to expire — which is cheap now that a session
  is twenty minutes rather than a month. Three probes cover it, and two of them
  drive the same form submission differing only in session age.

- **Optional print settings on a request (FRR-103).** A free-text field where a
  requester can note the slicer specifics that come with some files — layer
  height, infill, supports, temperatures. Stored on the ticket and shown to the
  printer owner, so those specifics live on the request rather than turning into
  a chat thread, and a re-queue carries them onto the re-print. This is the
  minimal, always-available shape (option A); the mooted gated
  "advanced/professional mode by access rights" is deliberately deferred.
- **Feature requests are filterable.** A filter bar on the `/frr` board and the
  `/frr/queue` triage view narrows by priority, status and category. The choices
  live in the URL and are applied server-side, ANDed onto `featureScope`, so a
  filter can only ever narrow what a caller may already see — never widen it —
  and a filtered view is link- and bookmark-able. An unrecognised value degrades
  to "any" rather than erroring.

- **The benefits (tip options) are owner-managed.** What used to be a hardcoded
  list of tips ("A beer", "A coffee", …) is now data the printer owner edits at
  `/admin/benefits`: add, rename, retire/restore, and mark which they currently
  **prefer** — the preferred ones are starred on the upload form under a
  "*Danilo currently prefers: …*" line so people pick what the owner actually
  wants. `Story.tip` stays a plain string, so editing or retiring a benefit
  never rewrites a request that already offered it; a retired one is kept rather
  than deleted. The upload endpoint validates the tip against the current
  *active* list server-side, so the managed catalogue — not the form — is
  authoritative. New `Benefit` table, seeded with the previous five tips on
  first run (idempotently, never clobbering the owner's edits). `verify:benefits`
  covers it (19 checks); every change is audited (`benefit.created`,
  `benefit.updated`).

- **A feature request's priority can be changed after it is filed** (FRR-104).
  Requirements shift, so a request's priority is a knob rather than a
  one-shot: the requester may re-set the priority of their own request while it
  is still live (not `Done`/`Declined`), and the printer owner may re-set any,
  any time, since triaging by priority is their job. The change notifies the
  other side, is written to the audit trail (`feature.priority_changed`), and
  is refused for a request that is not yours or is already closed. Priority
  lives only on feature requests; prints are unaffected.
- **A History Prints view (`/history`).** A dedicated home for the prints that
  have left the active rail — `Delivery`, `Done` and `Declined` — separate from
  the profile at `/me`. Filter by status, material and how recently it was
  filed; every row you own carries a **Print again** that re-queues it from the
  same file (FRR-102). Scoped exactly like the board: a client sees only their
  own, the owner sees the group. New nav entry for both roles.

- **Print an old request again (FRR-102).** Re-queue any of your past tickets —
  a test print that worked, a declined one you have since fixed — as a fresh
  `Requested` request, without finding and re-uploading the file. The stored
  model is copied server-side to a new object (`copyModel`), so the new ticket
  and the original own independent files: withdrawing one never touches the
  other's. A "Print again" control on the story page; audited as
  `story.requeued`; the owner is notified as for any new request.

- **A feature-request track — the 'frr' backlog.** Anyone can file a feature
  request (title, description, priority, category) at `/frr`, and the printer
  owner triages it exactly as they triage a print: the same board, an
  owner-only queue, a forward-only status flow (Requested → Accepted → In
  progress → Shipped → Done, or Declined), the conversation, notifications and
  the audit trail. The requester can withdraw their own while nobody has
  started on it.

  It is a deliberate parallel of the print backlog, not a fold into it. New
  tables (`featureRequest`, `featureComment`) and a `src/lib/features.ts`
  service that mirrors `stories.ts`; the print flow, upload, viewer and API are
  untouched. The pure rules (`featureScope`, `FEATURE_FLOW`,
  `assertFeatureTransition`, `featureRef`) sit beside the print ones in
  `scope.ts`, kept separate on purpose so a change to one backlog cannot
  quietly bend the other. Shared infrastructure is extended additively: a
  notification can now reference a feature (`featureId`) and the Activity feed
  routes to `/frr` or `/story` accordingly; the audit trail gains `feature.*`
  verbs. `npm run verify:frr` (51 checks) drives the real forms end to end and
  runs in CI. There is no JSON API for it yet — see
  [`docs/feature-requests.md`](docs/feature-requests.md).

- **Open a model straight in PrusaSlicer**, from a control on every ticket. A
  click hands the model to a slicer running on the person's own machine.

  The obvious route does not exist: PrusaSlicer's `prusaslicer://open?file=`
  deep link only downloads from a hardcoded allowlist — Printables, Thingiverse,
  Cults — with no setting to add a self-hosted host, and the requests to make it
  configurable were closed as not planned. So instead of asking the slicer to
  download, a small helper the printer owner installs once
  (`scripts/prusa-open.sh`, registered for a `ppp://` scheme by
  `scripts/install-slicer-handler.sh`) fetches the bytes through the API added
  below and hands the slicer a *local file* — which has no domain to check. It
  adds nothing to the server and needs no client bundle: a `ppp://` link invokes
  the OS handler rather than making a request, so the CSP does not govern it.
  The helper finds PrusaSlicer across the ways Linux installs it — a binary on
  `PATH`, a Flatpak, or an AppImage in the usual folders — and takes an explicit
  `PPP_SLICER` (a name, an AppImage path, or `flatpak run …`) when it cannot.
  Docs at [`docs/prusaslicer.md`](docs/prusaslicer.md); works with OrcaSlicer or
  any slicer that opens a file from the command line.

- **A JSON API, an OpenAPI document, and a console at `/docs`.** Everything the
  board and the queue can do is now reachable over HTTP: list and read tickets,
  move one along, decline, flag and unflag, comment, withdraw, read and clear
  notifications. `/api/openapi.json` describes the whole surface — the app's
  own paths plus every Better Auth endpoint, generated by the library so they
  cannot drift — and `/docs` renders it with your session already attached.
  Linked from the account menu. [`docs/api.md`](docs/api.md) is the reading
  version.

  Three things about it are deliberate and will otherwise surprise you:

  - **The rules moved, rather than being copied.** The admin actions used to
    live inside the server actions; who may move a ticket, from which state,
    who is told and what goes in the trail now lives in `src/lib/stories.ts`,
    and both the forms and the API call it. A rule that holds only for the
    caller that remembered it is not a rule — `npm run verify:api` drives the
    JSON surface against everything `npm run verify:queue` drives through the
    forms.
  - **There is no endpoint that sets a status.** `advance` derives the next
    step rather than taking one, so nothing can skip one.
  - **The API answers 403 where a page answers 404.** These paths are published
    in the document, so hiding their existence would be theatre — and would
    tell an honest client their ticket had vanished when the truth is that they
    are not the printer owner. Whether a *ticket* exists is still hidden.

- **Bearer tokens.** Any sign-in response carries `set-auth-token`; send it back
  as `Authorization: Bearer …` and `curl` works without a cookie jar. It is the
  session token rather than a new kind of credential — signing out revokes it,
  and so does revoking access or resetting a password. It is not
  `SameSite`-protected, which is why writes are Origin-checked as well, and why
  `docs/api.md` says to sign a script in fresh rather than reuse the token from
  the browser you are sitting in.

- **`npm run verify:api`** — 99 checks over the API, the document and the
  console, including one that asks for every path the document lists and fails
  on a 404. A published description that has drifted from the thing it
  describes is worse than none. The security probes grew from 62 to 91, most of
  them re-asking the A01 questions of the second front door.

  Two things the work turned up that were not the feature:

  - **Enabling the OpenAPI generator mounts an unauthenticated endpoint.**
    Better Auth's `openAPI()` plugin serves `/api/auth/open-api/generate-schema`
    to anybody with no session, listing which auth plugins a deployment runs
    and every path they expose. It is only ever called in process here, so
    middleware answers 404 for it — to signed-in callers too, since nothing
    legitimate reaches for it.
  - **An inline `<style>` block is dropped by this app's CSP, and the page
    still renders.** `style-src` is `'self'` with no nonce for styles, so the
    console's own layout simply did not apply — a policy violation that looks
    like a design bug. Its stylesheet is a file now, and `verify:api` fails if
    an inline block comes back.

- **`Done` is now the end of the flow**, and a ticket marked Done leaves the
  board. The order was Requested → Accepted → Printing → Done → Delivery, where
  `Done` meant "off the plate" and `Delivery` was terminal — which left nowhere
  to put finished work, so delivered tickets stayed on the rail forever and the
  rail stopped meaning "what is still moving". It is now Requested → Accepted →
  Printing → Delivery → Done. Finished work remains in *My orders*.

  Existing rows swap, because their meaning is preserved by swapping and not by
  leaving them alone: old `Done` ("printed, not yet with you") becomes
  `Delivery`, old `Delivery` ("with you, finished") becomes `Done`. One
  migration, one statement.

- **The person who asked for a print can withdraw it**, while it is still
  `Requested` or has been `Declined` — nobody has committed time to it at that
  point. The ticket, its conversation and the uploaded file all go. Past
  `Requested` it is the printer owner's record too, and no longer the
  requester's call to make.

### Changed

- **Printing a ticket again opens the request form, so the second go can be
  different.** "Print again" used to be one click that cloned the old ticket
  exactly. But a second print is rarely the first one repeated — the test came
  out too weak, or the wrong colour, or one was not enough — so the requester
  filed a ticket they already knew was wrong and explained the difference in a
  comment. It now leads to `/story/{id}/again`: the request form without the
  dropzone, filled in with the old wish. Title, material, colour, quantity,
  benefit, note and print settings can all be changed; the file cannot, because
  a different model is a different request. Nothing is created until the form
  is sent, and the old ticket is never touched.

  A choice that has left the shelf since — a retired material, colour or
  benefit — is replaced by the default and **said out loud** above the form,
  rather than silently swapped or left to fail on submit.

  Behind it is `POST /api/stories/{id}/requeue`, which the API did not have at
  all before. The body is the wish with every field optional: `{}` repeats the
  ticket, `{ "quantity": 4 }` asks for four. The merged wish goes through the
  same schema, the same catalogue lookup and the same benefit check as an
  upload. The audit row records *which* fields changed, not what they said.
  The old server action is gone, so there is one implementation.

  What this costs: the old control was a plain form that worked with
  JavaScript off. The request form never did, and printing again now shares
  that. `verify:upload` covers the page, the tuned copy, the refusals and both
  ownership rules.

- **The documentation caught up with the code.** A sweep after the object store
  came out, because several documents were describing a stack that no longer
  exists rather than being wrong in small ways.

  `docs/architecture.md` gained a **Storage is a directory** section — it is the
  design document and had nothing to say about the largest structural change in
  the project, while still describing `storage.ts` as "S3/MinIO, signed URLs".
  The viewer's byte-path reasoning, the upload ordering, the wire-format note and
  the file layout all now describe files rather than objects.

  `docs/development.md`'s stack table and dev-compose line still promised MinIO
  on `:9000`, and its reason for preferring `docker compose` over GitHub
  `services:` was half about MinIO needing a command override — which left with
  the object store, so the sentence now keeps the reason that survived and notes
  which one did not. `release-images.yml` also publishes a third image now.

  Counts that had drifted: **nine** suites, not eight, in both the README and
  CONTRIBUTING — and CONTRIBUTING's claim that all of them run against the built
  image was never quite true, since `verify:models` is a pure-function test in its
  own gate. `probe:security` is **120** probes, not 103; `verify:models` is 32
  checks, not 29; `verify` runs eight integration suites, not five; and `guard`
  runs three cheap gates, not two.


- **The object store is gone. Model files are files.** MinIO served an S3 API
  that this app never needed: every byte was already proxied through
  `/api/models/[id]` — the deployment publishes no port for storage, so a
  signed URL would have pointed at something the browser cannot reach — and
  the whole surface was six calls. Head and create a bucket, put, get, delete,
  copy. Those are `stat`, `mkdir`, a write, a read, `unlink` and `copyFile`.

  What it cost in exchange was a container, a credential pair, a healthcheck,
  two AWS SDK packages, and finally a supply-chain problem: MinIO withdrew its
  community images *and* binaries, so the project ended up mirroring one and
  then compiling its own, which still carried 63 HIGH/CRITICAL advisories no
  upgrade fixes. For five people and one printer, putting a few hundred
  megabytes of STL onto a disk the app already has mounted, that was a great
  deal of machinery to keep alive.

  Files land in `$DATA_ROOT/uploads`, mode 644 under 755 directories —
  deliberately readable, so a backup needs no root. Postgres' data directory
  being mode 700 is why the README carries a paragraph about backing up from
  inside a container; one such trap is enough, and models are not secret at
  rest, they are gated at the route. Writes are atomic (temp file, `fsync`,
  rename, `fsync` the directory), because S3 gave that away for free and the
  database row created straight afterwards claims the file is whole.

  **Upgrading needs the migration first** — `npm run migrate:storage`, see
  [deployment](docs/deployment.md). The bytes cannot be copied with `cp`: MinIO
  inlines most objects into their metadata. Nothing here deletes anything, and
  the old directory stays until you remove it yourself.

  The `verify:upload` assertions that read storage from outside the app moved
  with it rather than being dropped. They are the ones that would notice if
  `putModel` or `copyModel` quietly stopped writing, and they caught a path
  mistake during this very change.


- **The Requirements table promised a Pi 5, and never delivered one.** It listed
  "a NAS, a Pi 5, a VPS, a spare laptop" as hosts. A Pi 5 is arm64, and
  `ppp-app` and `ppp-migrate` have only ever been published for `linux/amd64` —
  `release-images.yml` sets no `platforms:`, so buildx quietly built for the
  runner it happened to be on. An arm64 host has always failed at
  `docker compose pull`, and nothing said so.

  The row now says amd64 and explains why, rather than naming a board that
  cannot run it. The previous wording — added alongside the MinIO mirror — blamed
  that mirror's single architecture, which was wrong in a more interesting way:
  the mirror was amd64-only, but so were the app images, so MinIO was never the
  binding constraint. Both statements were made without checking the manifest
  that would have settled it.

  Building for arm64 is a reasonable thing to want, and it is not what this
  fixes. A second architecture that the suites never run against is a platform
  shipped on faith, which is the same mistake as a registry nobody tried
  anonymously; and running them twice is not a commitment this project makes.
  Correcting the sentence is the honest half of the fix, and it is the half that
  costs nobody anything.


- **The object store is built from source, runs as uid 1000, and needs one
  chown to move to.** This is the only upgrade step in this project that is not
  pull-and-restart, so it is first in the list.

  MinIO withdrew its community distribution while the previous change sat
  unmerged: Docker Hub 404s, quay.io refuses an anonymous pull, and dl.min.io
  answers 410 for the server binary *and* for `mc`, on every architecture —
  which also kills upstream's own release Dockerfile, since it is a downloader.
  The source is still public and AGPL-3.0, so `docker/minio/Dockerfile` compiles
  it: the same `RELEASE.2025-09-07T16-13-09Z` the deployment already runs, plus
  `mc` because the healthcheck is `mc ready local`. Same release means the same
  on-disk format, so the bytes need no migration.

  The **ownership** does. Building our own image made the scanner able to see
  what upstream's image had always done — run as root — and rather than record
  an exception for it, the image now runs as 1000:1000. `/data` is a bind mount,
  so the host directory decides, and existing model storage is owned by root.
  Stop the stack, `docker run --rm -v "$DATA_ROOT/models:/data" alpine chown -R
  1000:1000 /data`, start it again. Skip it and MinIO exits with
  *"Unable to write to the backend"* rather than starting half-working, which is
  the right failure. Postgres is untouched.

  Doing it inside a container is not fussiness: the files are root-owned so
  doing it as yourself fails, and `sudo chown` on a host where your uid is not
  1000 is how the wrong number gets written. Full instructions in
  [deployment](docs/deployment.md).

  This also restores arm64. The mirror that unblocked CI was amd64 only because
  it was copied from a cached image; a source build is not limited that way, and
  the image is published for `linux/amd64` and `linux/arm64`.


- **"Feature requests" in the nav, and it goes to the board.** The owner's nav
  item was labelled *Requests* and pointed at `/frr/queue`, the triage view —
  so the owner's way in was the work list while everyone else's was the board.
  It now reads **Feature requests** for both roles and points at `/frr`, which
  is the print track's shape (the board is the shared view; triage is a step
  off it). Triage did not become unreachable: `/frr` grows a **Triage** button
  for the owner, since nothing else in the app linked to it, and the nav item
  stays lit while you are there.

- **A session is now worth twenty idle minutes, not a renewing month.**
  `session.expiresIn` was 30 days with `updateAge` at a day — and because
  `expiresIn` is an *idle* window that Better Auth pushes back out on use, a
  session touched once a month renewed itself indefinitely. "Thirty days" was
  the number in the config; *forever* was the behaviour, on a cookie written to
  the browser profile with `Max-Age=2592000`. On the shared office desktop this
  app is built for, that is the wrong shape: the threat is somebody sitting
  down after you, and the only thing that helps against a captured cookie is
  how long it stays worth something. It is twenty minutes now, sliding every
  minute so it never expires under somebody mid-task. Bearer tokens inherit it,
  which closes the "long-lived credential in a shell history" item in the
  security audit. Deliberately *not* done: a JWT session (it would put
  revocation back on a delay — the same bug cookie caching was turned off for),
  moving the token out of a cookie (a cookie is the only credential a browser
  attaches to a top-level navigation, and this app is server-rendered), and
  forcing a non-persistent cookie via `rememberMe: false` (Better Auth reads
  that as a *fixed* 24-hour session with the sliding refresh off — worse than
  what it buys).

  **Everyone signs in once on upgrade.** The new window cannot reach the
  sessions that already exist — Better Auth reads a stored `expiresAt` as
  though it had been written under the current `expiresIn`, so a row minted
  under the old config looks freshly updated and is never shortened (measured:
  a planted thirty-day session was still thirty days out after use). A
  migration retires them. It matches on the window rather than truncating the
  table, so it touches nothing a session created under the new config owns, and
  it is a no-op if re-run. No user, story, feature request, comment, invitation
  or audit row is affected, and nothing cascades: no foreign key in the
  database references `session`.

- **A feature request's priority is editable in every status.** The requester
  could only re-rank their own request while it was still live; now a closed
  one — `Done` or `Declined` — can be re-prioritised too, because hindsight
  keeps changing after the fact. The owner could always change any. Every
  change is still audited (`feature.priority_changed`) and tells the other side.

- **Withdraw now reaches Accepted (FRR-101).** A requester could only withdraw
  a `Requested` or `Declined` ticket; the window now also includes `Accepted`,
  so plans can still change after the owner has said yes but before the print
  reaches the bed. `Printing`/`Delivery`/`Done` are still refused — the
  material is committed by then — and the owner is notified when an accepted
  request is pulled. The `DELETE /api/stories/{id}` route inherits the wider
  window automatically.

- **The repository is now `danileau/prettypleaseprint`.** GitHub redirects the
  old path — web, git remotes and the API — so clones and links keep working.
  Two things redirects do not cover, both handled here:

  - **Keyless signatures embed the repository path.** Images built before the
    rename carry `…/danileau/ppp/…` in their certificate identity and images
    built after carry the new one, so verifying against a single name would
    make either today's image or every rollback target fail. The deploy wizard
    now accepts both, and rejects everything else — a fork, another workflow,
    another branch. Drop the old alternative once nothing you would roll back
    to predates the rename.
  - **The wizard did not follow redirects.** `curl` without `-L` against a
    renamed repository returns an empty body that looks exactly like "nothing
    published". It follows them now, which also makes it survive the next
    rename.

  **The container images keep their names** — `ppp-app` and `ppp-migrate`.
  They are named by the release workflow, not by the repository, so nothing
  deployed has to change. Renaming them would break every pinned `PPP_TAG`
  and orphan `v0.1.0` in exchange for tidiness.

### Removed

- **The MinIO furniture, all of it.** `docker/minio/Dockerfile`,
  `.github/workflows/minio-image.yml`, and the dead `S3_ACCESS_KEY` allowance in
  the secret scanner. Nothing builds, publishes, signs or scans an object-store
  image any more, because nothing runs one — which also takes the permanently
  red `MinIO image` run off `main`.

  What that thread cost, for the record: a mirror after Docker Hub started
  answering 404, a digest pin, a tag collision that made the pin's two halves
  name different images, a multi-architecture build from AGPL source, a uid-1000
  migration, a Trivy exception that was argued for and then not taken, and 63
  HIGH/CRITICAL advisories that no upgrade could fix because upstream's newest
  release shipped byte-identical vulnerable dependencies. None of it survives
  not having an object store.

  **Deliberately kept:** `scripts/export-storage.ts`,
  `docker-compose.storage-migration.yml` and their documentation. Anyone
  upgrading from a release that had MinIO still needs to get their models out,
  and that cannot happen if the tooling left in the same change. The overlay
  pins the mirror image by digest, so the `ghcr.io/danileau/minio` package has
  to stay published too — both go a release or two from now, once nobody
  plausibly has a MinIO data directory left.

### Fixed

- **An invited address could be registered without its invite link.** The
  invite gate checked that a pending invitation existed for the address, and
  Better Auth's sign-up endpoint answers anybody — so while an invitation was
  open, whoever knew the address could post it with their own password and be
  given the account and a session, without the link. It now takes both: a
  pending invitation, and a request that is redeeming that invitation's link.
  `acceptInvite` checks the token and marks the sign-up as a redemption; the
  gate refuses everything else, with the same answer an uninvited address gets.

  Two suites had been proving the hole worked. `verify:auth` and
  `probe:security` each registered an invited address by posting it straight to
  the endpoint, as a convenient way to test something else, and passed. Those
  checks now assert the refusal, and `A04-invitelink` / `A04-inviteoracle` are
  new. Written up as finding 10 in [the security audit](docs/security-audit.md).

  **If you run a deployment:** an account opened this way is indistinguishable
  afterwards from one opened with the link. If an invitee ever reported that
  their link said "already accepted" before they had used it, look at that
  account.

- **The quantity box could not be cleared.** "Or type a number" coerced every
  keystroke to a quantity, so emptying it snapped straight back to `1` and
  typing a 3 gave 13 — the only way to enter a number was to select the digit
  first. The box now keeps what is being typed apart from the quantity: it can
  be empty mid-edit, a whole number of one or more takes effect as it is typed,
  and leaving the box with anything else in it falls back to the last quantity.
  It mattered little while the box started at 1 on a new request, and more once
  printing a ticket again opened the form with an old quantity to change.

- **Better Auth 1.7.1 → 1.7.7, and the migration that upgrade needs.** The
  weekly dependency group had been failing `verify` since 2026-09-27 and looked,
  from the first failing check, like a broken invite gate: sign-up with no
  pending invitation answered 500 instead of 403. The gate was fine. Better Auth
  1.7.0–1.7.2 required an `account.issuer` column, and this app added it as
  `NOT NULL` when it gained passwords; 1.7.3 withdrew the requirement, stopped
  writing the column, and went back to recognising an account by
  `(providerId, accountId)`. Against a required column that makes every insert
  into `account` fail — nobody can be given a password — and the library now
  checks for exactly that and refuses each request with *"Prisma schema
  mismatch"*.

  The migration makes `issuer` nullable and moves the unique index back to
  `(providerId, accountId)`, where it was before. It does **not** drop the
  column, and that is deliberate: the deploy wizard rolls back to the previous
  image when a deploy fails its health check, and that image's client still
  selects `issuer`. Dropping it would turn a failed deploy into a rollback that
  cannot read an account.

  That claim was tested rather than reasoned, on one database carried across
  both images. Accounts made under 1.7.1 sign in under 1.7.7. After rolling back
  onto the migrated database the old migrator finds nothing to do and does not
  object to a migration it has never heard of, existing accounts sign in, and
  new ones can be created. The one thing a rollback does not get for free is
  written into the migration: a password *first set* under 1.7.7 has a NULL
  issuer, and 1.7.1 answers that account 401 until
  `UPDATE "account" SET "issuer" = 'local:' || "providerId" WHERE "issuer" IS NULL`
  is run — which was also tried, and fixes it.

  1.7.7 rather than the 1.7.6 the group proposed, because `@better-auth/passkey`
  1.7.6 resolves `@better-auth/core` to 1.7.7 while `better-auth` 1.7.6 pins its
  own 1.7.6, leaving two copies of the core in one process. 1.7.7 also carries a
  critical fix (GHSA-965c-763c-88jm) for the Magic Link plugin, which this app
  does not use.

  The rest of the group rides along, none of it needing a code change: `next`
  15.5.25 → 15.5.26, `react` and `react-dom` 19.0.8 → 19.3.0, `zod` 4.4.3 →
  4.6.5, `resend` 6.22.0 → 6.29.0, `three` to 0.186, and the development-only
  `@aws-sdk/client-s3`, `puppeteer-core`, `swagger-ui-dist`, `tsx` and type
  packages.

- **Two high advisories in `nodemailer`, found by the daily scan.** 9.1.1 →
  10.0.14, for GHSA-prgh-xp8r-p3m5 and GHSA-v53p-9fqp-m79j: both are quadratic
  time in the address parser, a denial of service by a crafted address. The
  scheduled `Security scan` had been red since 2026-09-30, in the repository and
  in the published `ppp-app` image, and the `trivy` gate would have failed every
  pull request opened after it.

  The exposure here was small and the bump is not: the only addresses that reach
  the parser are `MAIL_FROM` and an invitation or reset recipient — typed by the
  owner, and validated when the invitation was made. But 10 is a major
  version. It needs Node 20 (the images run 22), and the package was rewritten in
  TypeScript and now ships from `dist/` with separate ES-module and CommonJS
  builds — which matters because `nodemailer` is one of the two
  `serverExternalPackages`, traced into the standalone output rather than
  bundled. A typecheck cannot see whether that trace still finds the files, so
  the evidence is `verify:auth` against the built image: an invitation and a
  reset link both sent through SMTP and read back out of Mailpit.

- **The board and the header at phone width.** A card title long enough to wrap
  overflowed its card on `/board`, and the shared header did not fit a narrow
  viewport. Shipped in August and never written down here — found while checking
  the changelog covered every commit since v0.1.0, which it now does. Reproduced
  in a headless browser at 360, 390, 430, 768 and 1180 for both roles, before and
  after.


- **Seven places where the documentation would have walked a stranger into a
  wall.** Found by reviewing the repo against itself rather than reading it.

  - **`scripts/deploy-wizard.sh` health-checked this project's own deployment
    by default.** `PPP_HEALTH_URL` defaulted to `https://ppp.danileau.com/api/health`,
    and neither that variable nor `deploy.conf` appears in any `.md` or
    `.example` file — so somebody else's run printed *our* host as "Live health:
    healthy", gated its post-swap health loop on it, and could roll back a
    perfectly good deploy because an unrelated machine blipped. It now derives
    from `APP_URL` in the same `.env.docker` it already reads the tag from, and
    refuses to guess if neither that nor `PPP_HEALTH_URL` is set. This is the
    only script in the repo that changes production.
  - **The documented bootstrap command errored out as written.** Both
    `.env.docker.example` and a comment in `docker-compose.prod.yml` gave
    `docker compose -f docker-compose.prod.yml logs migrate` without
    `--env-file`, which dies on `required variable DB_PASSWORD is missing`. That
    is the command that prints the one-use admin link — the single thing a fresh
    deployment cannot proceed without.
  - **Quick start handed you a stack you could not sign into.** It said to set
    `APP_URL` and `PASSKEY_RP_ID` to a public hostname, then to raise the
    build-and-test stack on `http://localhost:3000`. Better Auth derives its
    trusted origin and cookie prefix from those, so the browser sent an untrusted
    origin and threw away a `__Secure-` cookie over plain HTTP. It now says to
    leave the localhost values until you deploy, and why.
  - **`PPP_TAG` and `PPP_REGISTRY` were undocumented in the file every user
    copies**, while the wizard refuses to run without the first and the README
    calls that file "the full file with commentary".
  - **Two compose files that have not existed since #18** were still cited in
    `.env.docker.example` (in the guidance for when `TRUST_PROXY_HEADERS` is
    safe) and in a source comment. `check:links` cannot catch these: it reads
    markdown only.
  - **Three `S3_*` rows and one `S3_SECRET_KEY` in Quick start** outlived the
    object store by a change, describing variables nothing reads.


- **Every build depended on Google answering, and the failure did not say so.**
  The four faces came from `next/font/google`, which downloads them at build
  time. So CI's `verify` gate, `release-images.yml` and the README's own
  build-from-source quick start all needed fonts.googleapis.com reachable and
  willing — and when it was not, the build died with a webpack stack trace
  pointing at `@next/font/dist/google/loader.js`, which is nowhere near where
  anyone would look. Caught by it happening, not by reasoning about it.

  The woff2 files now live in `src/app/fonts/` and load through
  `next/font/local`. Latin subset, the same faces, 124 kB in total; Archivo is a
  single variable file covering the four weights it used to fetch separately.
  Nothing is fetched at build or at runtime, which is also why `font-src` can
  stay `'self'`.

  It was an inconsistency as much as a fragility: Swagger UI is copied out of
  `node_modules` at build time precisely because "a CDN would be unreachable on
  a NAS with no outbound internet", and the app's own typefaces were exempt from
  that reasoning for no reason anybody had written down.

  Verified by building the image with `fonts.googleapis.com` and
  `fonts.gstatic.com` pointed at 127.0.0.1 — the build that used to need them
  now completes without them. All four are SIL OFL 1.1; the licence and the
  per-family copyright notices travel with the files in
  `src/app/fonts/README.md`.


- **The stack could not be pulled any more, and nothing said so.** MinIO
  stopped publishing its community image to Docker Hub — `minio/minio` answers
  404 — and its quay.io repository now refuses an anonymous pull at every tag,
  so neither registry is a route for CI or for a fresh deployment. A running
  deployment kept serving from its cached copy, which is what made it quiet: CI
  could no longer raise the stack, so every pull request's `verify` failed
  before a single suite ran, and the deploy wizard would have stopped at
  `compose pull` on the next deploy.

  Both of MinIO's public routes closed in sequence, which is the part worth
  keeping. quay.io genuinely worked: CI pulled `quay.io/minio/minio`
  anonymously on 2026-09-16 and brought the stack up healthy. Eleven days later
  the same tag answers `unauthorized`. So the fix is not a better MinIO
  registry — the next one closes too — it is holding the bytes ourselves.

  Both compose files now pull the last community release,
  `RELEASE.2025-09-07T16-13-09Z`, from this project's own registry at
  `ghcr.io/danileau/minio`, pinned by digest. It is a mirror of exactly what
  `minio/minio:latest` resolved to, not an upgrade: same release label, and
  MinIO is AGPL-3.0, so redistributing it is permitted — its source for that
  release is `minio/minio` at `32d8e52`. Mirroring is what keeps the stack
  pullable without a credential now that neither upstream registry serves it.
  The mirror is **`linux/amd64` only**, because that is the platform the
  original was cached on; an arm64 host — a Pi 5, say — needs its own mirror
  until a replacement lands.

  MinIO's community edition is no longer maintained, so this keeps the stack
  deployable rather than current. What replaces it — a maintained fork, Garage,
  SeaweedFS — is a separate decision with a data migration attached, and is
  deliberately not made here.

- **Two critical and five high advisories, found by the daily scan.** `next`
  15.5.23 → 15.5.25 (unauthenticated remote code execution in the image
  optimiser, which is on by default and which the middleware matcher skips —
  plus a Windows-only one), `nodemailer` 9.0.5 → 9.1.1, and the `sharp`
  override ^0.35.3 → ^0.35.4 (libheif).

  Nodemailer's list grew while this sat unmerged, and now runs to four:
  quadratic address parsing (a denial of service), a `resolveContent()` legacy
  signature that bypasses `disableFileAccess` / `disableUrlAccess`, and two
  recipient-domain validation bypasses — an IDN/punycode allow-list escape and
  an RFC 5322 comment mis-parse — either of which delivers mail to a domain the
  attacker chose. 9.1.1 covers all four, so the bump did not change; what it
  fixes did.

  The scheduled `Security scan` had been red since 2026-09-09; patch-level
  bumps only, so the wider dependabot group stays its own change.

- **Four `verify:frr` checks passed without exercising the rule they named.**
  They posted a bare `FormData` at a page URL carrying nothing but an id. A
  server action needs an action id in the body, so Next never routed those
  requests — it logged *"Failed to find Server Action"* and nothing ran, which
  meant the row survived whether or not the service guarded anything. "The
  owner cannot withdraw somebody's request", "a started request cannot be
  withdrawn", "an accepted request cannot be declined" and "another client
  cannot comment on a request they cannot see" would all have passed against a
  service with no ownership check, no status check and no scope check at all.
  They asserted the framework, not the app — and `docs/feature-requests.md` and
  the security audit's A01 verdict both cite them as evidence.

  The rules themselves are all present and correct; this was a hole in the
  evidence, not in the app. Each check now replays the **real** form — scraped
  from a page where it is rendered, then re-posted with a different id or a
  different account — so it reaches the service and asserts the refusal it
  gets back. Confirmed discriminating by removing the ownership guard and
  watching the check fail. The 'frr' track was the exposed one because it has
  no JSON API; the print track's equivalent rule is covered by `verify:api`
  asserting a 403, through the same shared service. The two remaining bare-POST
  checks are renamed to say what they actually demonstrate — that a stray POST
  at a page URL is inert. `verify:frr` is 74.

- **`file.refused` was not counted as a refusal.** The audit page tinted and
  counted `invite.rejected` and `upload.rejected` but not the verb that fires
  when an account asks for a model it may not see — which is the refusal most
  worth noticing and the one least likely to be spotted by eye. The list now
  lives in one place, so the count at the top, the tint in the table and the
  new panel cannot drift apart.

- **Uploads over 10 MB never worked, whatever the app said.** Next truncates a
  request body at 10 MB whenever middleware is in play, and this app runs
  middleware on every route to mint the CSP nonce. So anything past 10 MB
  arrived short, `request.formData()` threw on the truncated body, and the
  person uploading was told *"That upload did not arrive intact"* — which reads
  like a network fault, while the form and the API documentation both promised
  50 MB. It survived the whole life of the app because every fixture in every
  suite is a few hundred bytes, so nothing had ever sent a large file.
  `middlewareClientMaxBodySize` is now kept in step with the app's own cap, and
  `verify:upload` sends a 12 MB model on every run so the ceiling cannot come
  back quietly.

- **"Open in PrusaSlicer" no longer depends on which branch is checked out.**
  The `.desktop` entry named `scripts/prusa-open.sh` where it sits in the git
  working tree, so the button quietly broke whenever that path stopped
  resolving to the current handler — check out anything cut before the handler
  landed and the file is gone, the click does nothing, and nothing says why.
  It bit twice. The installer now copies the helper to `~/.local/bin/ppp-open`
  and points the entry at that, which severs the dependency for one `cp`. The
  trade is that the copy does not update itself: re-run the installer after a
  `git pull`, which is safe at any time and leaves an existing config alone.
  Existing setups are fixed by re-running it.
- **The last three controls that looked like text.** After the withdraw button
  on a ticket was made visible, three siblings were left drawn the old way —
  a transparent border and muted grey, or a plain underline — so they read as
  captions rather than controls. All three are now buttons in the shapes the
  app already uses, and each carries the weight of what it does: the
  feature-request **Withdraw** is now identical to the print one it shares a
  label with (an underlined link before, which made the two backlogs look
  different for no reason); **Forgotten password?** on the guest list is
  neutral, because it mints a recovery link and takes nothing away, and the
  list draws one per member; **Revoke access?** carries the same cherry as the
  other destructive controls, while its **Suspended** state takes the amber the
  tokens reserve for warnings — it reports a state *and* is the way back, and
  red would read as a threat rather than a flag. Confirmation steps and wording
  are unchanged throughout: these actions should be hard to fire by accident,
  not hard to find.

- **"Open in PrusaSlicer" stopped working, and the fix removes a credential
  from disk.** The helper authenticated with `PPP_TOKEN` — a bearer token
  pasted once into `~/.config/ppp/slicer.conf`. A bearer token *is* the session
  token, so shortening sessions to twenty idle minutes killed it and every
  click began answering `HTTP 401`. That file had been holding a thirty-day,
  full-authority credential at rest; the feature was depending on the weakness
  the session change removed. The link now carries its own credential instead —
  `ppp://slice/<id>?t=…`, minted when the ticket renders, for that person and
  that model, expiring in half an hour — and `slicer.conf` holds nothing but
  the address of the instance. The token asserts an identity and a subject and
  never an authorisation: the route still loads the account, refuses a
  suspended one, and re-applies `storyScope`, so a link cannot reach a model
  its holder has lost access to or be edited to fetch a different one. Old
  installs keep working (`PPP_TOKEN` is still honoured when a link carries no
  `t`) but the line can now be deleted. Six new probes; the suite is 103.

- **Nobody could find how to withdraw a request.** The control on a ticket was
  drawn with a transparent border and muted grey text, growing an outline only
  on hover — so at rest it read as a caption rather than a button, and it sat
  directly above *Print again*, which is a full enamel button. Next to its own
  neighbour it looked like that button's label. It is now a button in the same
  shape as *Decline* and *Flag*, tinted cherry-wash with cherry-dark text and
  going solid red on hover, which keeps the two steps legible as an escalation:
  an outlined red button opens the drawer, a filled red one commits. The
  confirmation step and its wording are unchanged — a destructive action should
  be hard to fire by accident, not hard to locate.

- **The session cookie did not slide on a page render.** Better Auth extends a
  live session in two places, and only one survives a React Server Component
  render: the database row is pushed out, but Next forbids writing a cookie
  during a render, so browsing pages kept the session row alive while the
  browser's copy of the cookie counted down from whenever a route handler last
  wrote it. Measured rather than assumed — `GET /board` returned no
  `Set-Cookie` at all where `GET /api/stories` returned `Max-Age=1200`. At
  thirty days nobody would have noticed; at twenty minutes it signs an active
  person out with a perfectly live session behind them. `src/middleware.ts` now
  re-stamps the cookie on page navigations, and only there — `/api/*` responses
  set it themselves, and re-stamping there would resurrect the cookie that
  `/api/auth/sign-out` had just deleted. Three new probes
  (`A07-session-window`, `A07-session-cookie-maxage`, `A07-session-slides`)
  hold the window, the cookie and the re-stamp in place; the suite is 97.

- **3MF files with geometry in a separate part were refused.** The validator
  read only the archive's root `3D/3dmodel.model` and counted vertices there,
  so a 3MF written in the *production extension* shape — each object's mesh in
  its own `3D/Objects/*.model`, the root merely referencing them — looked empty
  and was rejected as "not a model". That shape is what Bambu Studio, OrcaSlicer
  multi-object plates and several CAD exporters emit, so a lot of perfectly
  printable files bounced. It now reads every `*.model` part in the archive
  (which also covers exporters that name the root part something other than
  `3dmodel.model`), with the zip-bomb guard still applied to the total.

- **3MF dimensions were wrong when the size lived in a transform** — a Cura
  export measured `0 × 0 × 0 mm`. A 3MF places geometry through the transform
  matrices on the `<build>` `<item>` and on each `<component>`, and Cura in
  particular stores the mesh in a scaled-down space with the true size in that
  matrix; the validator read the raw vertices and so reported a box a thousandth
  of the real thing. It now walks the build → component tree, composes the
  transforms and measures the geometry in its placed position — so a single
  model reads its true size, and a multi-object plate reads the footprint of the
  whole arrangement (the number that says whether it fits the bed). Both this
  and the production-extension case above were reproduced against a shelf of
  real Bambu, OrcaSlicer and Cura files; regression tests cover a
  production-extension 3MF and a scaled build-item 3MF.

## v0.1.0

The first release worth naming. Everything the design handoff asked for is
built, and the deployment path has been walked end to end on real hardware.

### What it does

- **Invite-only registration.** No public sign-up; a `User` row cannot exist
  without a pending invitation, enforced in a single hook that every
  authentication method goes through.
- **Username and password sign-in**, with passkeys as an optional and stronger
  second method. Passwords are at least ten characters and refused if they
  appear in a known breach corpus.
- **Upload → board → story.** `.stl` and `.3mf` validated against their bytes
  rather than their filename, measured for a bounding box, stored in object
  storage and never in the web root.
- **The admin queue and the status flow** — Requested → Accepted → Printing →
  Done → Delivery, forwards only, one step at a time. Or Declined, with a
  reason.
- **A conversation per ticket**, and **the real geometry** rendered in the
  browser.
- **Access control you can undo.** Invitations withdrawn before they are
  accepted; access revoked afterwards, which signs the person out everywhere
  and refuses new sign-ins while keeping their history.
- **An append-only audit trail** of everything that changes who can get in or
  what happens to someone's model.

### Deploying it

- Published, signed and scanned container images; the host needs no source
  tree and no toolchain.
- `scripts/deploy-wizard.sh` — lists what is published, cosign-verifies before
  swapping, health-checks after, and rolls back on its own if the new image
  does not come good.
- **Mail is genuinely optional.** Nothing in the running system needs it.
- The admin bootstraps from a one-use link the migrator prints; there is
  deliberately no `ADMIN_PASSWORD`.

### Verified

Six suites, all running in CI against the built container image rather than a
dev server: registration and sign-in, upload and board, the admin queue,
the upload validator against hostile fixtures, WebAuthn ceremonies in a real
browser, and OWASP-mapped security probes.

Assessed against the OWASP Top 10 (2021) with SAST, SCA and DAST — see
[docs/security-audit.md](docs/security-audit.md), including the residual risk
that was knowingly accepted.

### Licence

AGPL-3.0-or-later.

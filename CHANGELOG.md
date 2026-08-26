# Changelog

Notable changes. Every entry names a released version; deployments pin
`PPP_TAG` to one of these, or to a commit SHA if they follow `main` closely.

## Unreleased

### Added

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

### Changed

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

### Added

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


### Fixed

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

### Added

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

### Changed

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

### Added

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

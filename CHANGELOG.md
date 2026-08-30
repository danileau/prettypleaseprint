# Changelog

Notable changes. Every entry names a released version; deployments pin
`PPP_TAG` to one of these, or to a commit SHA if they follow `main` closely.

## Unreleased

### Added

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

### Fixed

- **`file.refused` was not counted as a refusal.** The audit page tinted and
  counted `invite.rejected` and `upload.rejected` but not the verb that fires
  when an account asks for a model it may not see — which is the refusal most
  worth noticing and the one least likely to be spotted by eye. The list now
  lives in one place, so the count at the top, the tint in the table and the
  new panel cannot drift apart.

### Changed

- **"Feature requests" in the nav, and it goes to the board.** The owner's nav
  item was labelled *Requests* and pointed at `/frr/queue`, the triage view —
  so the owner's way in was the work list while everyone else's was the board.
  It now reads **Feature requests** for both roles and points at `/frr`, which
  is the print track's shape (the board is the shared view; triage is a step
  off it). Triage did not become unreachable: `/frr` grows a **Triage** button
  for the owner, since nothing else in the app linked to it, and the nav item
  stays lit while you are there.
### Fixed

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

### Added

- **Download the model.** Every ticket now has a plain **Download** button
  beside *Open in PrusaSlicer* — the same bytes with no helper and no setup,
  for the printer owner who is not sitting at the machine with the slicer on
  it, or who uses a different slicer. There is no new server surface behind it:
  `/api/models/[id]` already streamed the file with
  `Content-Disposition: attachment`, already scoped it with `storyScope`, and
  already recorded `file.downloaded` whenever bytes go to somebody other than
  the uploader. Shown to anyone who can see the ticket, and kept *above* the
  slicer disclosure so the simple answer is the visible one.

### Fixed

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
### Fixed

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

### Changed

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

### Added

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

### Fixed

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

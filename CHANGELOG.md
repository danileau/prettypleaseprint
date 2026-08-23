# Changelog

Notable changes. Every entry names a released version; deployments pin
`PPP_TAG` to one of these, or to a commit SHA if they follow `main` closely.

## Unreleased

### Fixed

- **Release images could never pass signature verification.** A tag-triggered
  build signs with `refs/tags/<tag>`, not `refs/heads/main`, so the deploy
  wizard's identity pattern — written for branch builds — rejected exactly the
  images a deployment is supposed to pin. The bug was invisible because
  without cosign installed the wizard skips the check and says so; it would
  have surfaced the first time anyone installed it. Found by verifying a real
  signature rather than by reading the workflow.

  The wizard also looks for `cosign` beside the project now, not only on PATH.
  On a host whose OS filesystem is replaced by updates, a binary in
  `/usr/local/bin` disappears and the check stops happening silently — which
  is worse than never having had it.

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

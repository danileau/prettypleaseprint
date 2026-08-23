# Changelog

Notable changes. Every entry names a released version; deployments pin
`PPP_TAG` to one of these, or to a commit SHA if they follow `main` closely.

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

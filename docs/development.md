# Development

[← back to the README](../README.md)

## Stack

| | |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Auth | [Better Auth](https://better-auth.com) 1.7 — username/password, passkeys, breach check, admin plugin |
| Data | Prisma 6 → PostgreSQL 17 |
| Styling | Tailwind v4, design tokens from the handoff as CSS variables |
| Local infra | Docker Compose: Postgres, Mailpit (mail). Model files go to `./data/uploads` — there is no storage service |

Chosen to match the existing house style (`huere-siech` is Next 15 + Prisma,
`danileau.com` is React + TS + Tailwind) and the handoff's own suggested stack.

## Getting started

```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose up -d          # postgres :5432, mailpit :8025
npm install
npm run db:migrate
npm run db:seed               # creates the one admin from ADMIN_EMAIL/ADMIN_NAME
npm run dev
```

`npm run db:seed` prints a one-use link for the admin to choose a username and
a password — open it, then invite people from `/admin/invites`. In development
every outgoing email is caught by **Mailpit at http://localhost:8025**, so
invitation and reset links are clickable there.

```bash
npm run verify:models         # upload validator vs. hostile fixtures (no server needed)
npm run verify:auth           # registration, sign-in and password reset, end to end
npm run verify:upload         # upload -> board -> story, end to end
npm run verify:queue          # the admin queue, status flow and conversation
npm run verify:frr            # the feature-request track (file, triage, the flow)
npm run verify:benefits       # the owner-managed benefits (tip) catalogue
npm run verify:catalog        # the owner-managed material/colour catalogue
npm run verify:api            # the JSON API, the OpenAPI document and the console
npm run verify:passkey        # WebAuthn ceremonies in a real browser
npm run probe:security        # 122 OWASP-mapped security probes
```

## Verifying it

`npm run verify:auth` drives the real HTTP surface — including submitting the
server-action forms the way a browser with JavaScript disabled does — and reads
delivered mail out of Mailpit. Nothing is stubbed. It checks that:

1. An uninvited address gets an identical response, a link, and **no account**.
2. The admin can invite through the UI and the mail arrives.
3. The invitee registers through the link, lands signed in, and the account is
   stamped from the invite (role, initials, inviter) rather than the request.
4. The link is single-use.
5. A client gets 404 on the admin surface and cannot drive its actions.
6. Posted `role`/`initials` are ignored.
7. The database itself rejects a second admin.

It is destructive — point it at a development database only.

**Not covered**: the WebAuthn ceremonies themselves, which need a real
authenticator. The endpoints are live and return correct options (right rpID,
rpName and `userVerification`), but registering and signing in with a passkey
has only been exercised at the protocol boundary, not with a device.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to main,
as four gates that can be required by name in branch protection:

| Gate | What it does |
| --- | --- |
| `guard` | typecheck, the secret scanner over every tracked file, and the markdown link check |
| `models` | the upload validator against hostile fixtures — no server needed |
| `verify` | raises the real compose stack and runs all nine integration suites against the built image, **including the WebAuthn ceremonies in a headless Chrome** |
| `trivy` | filesystem scan for vulnerabilities, secrets and misconfiguration; HIGH/CRITICAL fail |

`verify` uses docker compose rather than GitHub `services:` so that running the
same command a developer runs puts **the compose files themselves under test**. A
broken overlay fails in CI rather than on the NAS. (It used to have a second
reason — `services:` cannot override a container's command, which MinIO needed —
and that one left with the object store.)

Two more workflows:

- **`release-images.yml`** — every merge to main builds `ppp-app`,
  `ppp-migrate` and `ppp-storage-migrate` (the one-shot that copies models out of
  the old object store), pushes them to ghcr.io tagged with the commit SHA and
  `latest`, signs them with cosign (keyless, via GitHub OIDC), and scans the
  *published* image. A base image can carry a CVE that no scan of this
  checkout would ever see.
- **`security-scan.yml`** — daily, against a fresh scanner and a fresh
  database, over the repo *and* the published images. This closes the gap the
  PR gate cannot: a CVE published after the last commit still lands in the
  committed lockfile and in the base layers already running on the NAS.

## The cheap gates

Three checks that need no server and run in seconds, all of them in CI's
`guard` job:

```bash
npm run typecheck                  # tsc --noEmit
npm run check:secrets -- --all     # credential shapes across every tracked file
npm run check:links                # internal markdown links and heading anchors
```

`check:links` exists because documentation links rot silently — no test, build
or typecheck notices — and this repo has proved it twice: once when the
narrative moved into `docs/` and every `src/…` link became `docs/src/…`, and
once when a directory was renamed out from under references pointing into it.
It resolves anchors with GitHub's own slug rules rather than an approximation,
and deliberately does not fetch external URLs: a gate that depends on somebody
else's uptime fails for reasons unrelated to the change and gets ignored.

## Cutting a release

A release is a name for a commit that is already on `main`. Every merge
publishes signed images under the commit SHA; a `v*` tag republishes the same
commit under a version a person can say out loud, and deliberately does not
move `latest`.

1. **A release pull request.** In `CHANGELOG.md`, the `## Unreleased` section
   becomes `## vX.Y.Z` with the date and — if anything about deploying it
   differs from the last release — an *Upgrading from* section, and a fresh
   empty `## Unreleased` goes above it. `package.json` and the lockfile take the
   version (`npm version X.Y.Z --no-git-tag-version`). The image tag used as an
   example in the README and the deployment guide moves to the new version.
2. **Merge it** like any other change, with the full local run.
3. **Tag that merge commit and publish the release:**

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" <merge commit> && git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — …" --notes-file notes.md
   ```

   The tag push runs `release-images.yml`, which publishes `ppp-app`,
   `ppp-migrate` and `ppp-storage-migrate` as `:vX.Y.Z`. Wait for it before
   telling anyone to pin `PPP_TAG` to the version — the tag exists a few
   minutes before the images do.

The version is `0.y.z` while a release can still need hands on the host, as
v0.2.0's storage migration did. A minor bump is "read the upgrade notes"; a
patch bump is "change `PPP_TAG`".

## Traffic

Clone and view counts are owner-only analytics with a **14-day** window and no
public badge. `.github/workflows/traffic.yml` snapshots them daily into
`docs/traffic/*.csv` so the history survives. Its commit is excluded by path
from CI and from the image release, so a row of numbers does not rebuild the
stack.

Note that once the repository is public those numbers are public with it.
Delete the workflow if that is not wanted; the data is anodyne but it is a
choice.

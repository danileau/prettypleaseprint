# Development

[← back to the README](../README.md)

## Stack

| | |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Auth | [Better Auth](https://better-auth.com) 1.7 — username/password, passkeys, breach check, admin plugin |
| Data | Prisma 6 → PostgreSQL 17 |
| Styling | Tailwind v4, design tokens from the handoff as CSS variables |
| Local infra | Docker Compose: Postgres, MinIO (model files), Mailpit (mail) |

Chosen to match the existing house style (`huere-siech` is Next 15 + Prisma,
`danileau.com` is React + TS + Tailwind) and the handoff's own suggested stack.

## Getting started

```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose up -d          # postgres :5432, minio :9000, mailpit :8025
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
npm run verify:api            # the JSON API, the OpenAPI document and the console
npm run verify:passkey        # WebAuthn ceremonies in a real browser
npm run probe:security        # 103 OWASP-mapped security probes
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
| `guard` | typecheck, and the secret scanner over every tracked file |
| `models` | the upload validator against hostile fixtures — no server needed |
| `verify` | raises the real compose stack and runs all five integration suites against the built image, **including the WebAuthn ceremonies in a headless Chrome** |
| `trivy` | filesystem scan for vulnerabilities, secrets and misconfiguration; HIGH/CRITICAL fail |

`verify` uses docker compose rather than GitHub `services:` for two reasons:
`services:` cannot override a container's command, which MinIO needs, and
running the same command a developer runs puts **the compose files themselves
under test**. A broken overlay fails in CI rather than on the NAS.

Two more workflows:

- **`release-images.yml`** — every merge to main builds `ppp-app` and
  `ppp-migrate`, pushes them to ghcr.io tagged with the commit SHA and
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

## Traffic

Clone and view counts are owner-only analytics with a **14-day** window and no
public badge. `.github/workflows/traffic.yml` snapshots them daily into
`docs/traffic/*.csv` so the history survives. Its commit is excluded by path
from CI and from the image release, so a row of numbers does not rebuild the
stack.

Note that once the repository is public those numbers are public with it.
Delete the workflow if that is not wanted; the data is anodyne but it is a
choice.

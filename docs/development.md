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

1. An uninvited address is refused, with **no account** and a row in the
   audit trail.
2. The admin can invite through the UI and the mail arrives — and posting the
   invited address at the sign-up endpoint **without the link** is refused with
   the same answer a stranger gets.
3. The invitee registers through the link, lands signed in, and the account is
   stamped from the invite (role, initials, inviter) rather than the request.
4. The link is single-use.
5. A client gets 404 on the admin surface and cannot drive its actions.
6. Posted `role`/`initials` are ignored.
7. The database itself rejects a second admin.

It is destructive — point it at a development database only.

The WebAuthn ceremonies are `verify:passkey`'s: a headless Chrome with a
virtual authenticator attached over the DevTools protocol registers a passkey
and signs in with it, so the browser half is real. **Not covered** is a
physical authenticator — a phone, a security key, a platform's own prompt.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to main,
as four gates that can be required by name in branch protection:

| Gate | What it does |
| --- | --- |
| `guard` | typecheck, the secret scanner over every tracked file, the markdown link check, and the wizards' own tests (`scripts/tests/*.test.sh`, each in a sandbox with stubbed `docker`, `gh` and `curl`) |
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

Checks that need no server, all of them in CI's `guard` job:

```bash
npm run typecheck                  # tsc --noEmit
npm run check:secrets -- --all     # credential shapes across every tracked file
npm run check:links                # internal markdown links and heading anchors
for t in scripts/tests/*.test.sh; do bash "$t"; done   # the three shell tools, sandboxed
```

The last line is the tests for `deploy-wizard.sh`, `release-wizard.sh` and
`full-test.sh`. Each runs its script in a temp directory against stub
executables and a local bare repository, with a `PATH` that holds only those
stubs and an allow-list, so it cannot reach your real `gh` or `docker`.

`check:links` exists because documentation links rot silently — no test, build
or typecheck notices — and this repo has proved it twice: once when the
narrative moved into `docs/` and every `src/…` link became `docs/src/…`, and
once when a directory was renamed out from under references pointing into it.
It resolves anchors with GitHub's own slug rules rather than an approximation,
and deliberately does not fetch external URLs: a gate that depends on somebody
else's uptime fails for reasons unrelated to the change and gets ignored.

### The full local run

Green CI is not enough to merge on: the whole stack is raised from the working
copy on a fresh data directory, and every suite is run against the built image.
One script does that the same way every time:

```bash
scripts/full-test.sh                              # everything; exit 0 only if all of it passed
scripts/full-test.sh --only "verify:auth verify:api"   # a subset, while iterating
scripts/full-test.sh --no-build                   # reuse the images of the last run
scripts/full-test.sh --restore                    # undo what a killed run left behind
```

It runs the three cheap gates, a `trivy` filesystem scan if `trivy` is
installed, and `verify:models`; then raises the stack, waits for
`/api/health`, runs the nine integration suites — all of them, even after one
fails — and the two image pins CI keeps (no npm in the runtime images; the
migrator still runs without it).

It is CI's `verify` job in what matters: the same three compose files, the
same `mailcatcher` profile, the same suites in the same order. It differs
where a developer's machine has to be protected: the compose project is
`ppp-fulltest` rather than the default, the images are tagged
`full-test-local` rather than `latest`, `DATA_ROOT` is a throwaway directory
outside the checkout, and the health wait is 120 seconds rather than 90.

- **It refuses to start if a ppp stack exists on the machine**, running or
  stopped. The compose file pins the container names, so only one stack can
  exist, and the test would have to remove yours to raise its own. It will not:
  take yours down first. It also refuses if port 3000, 5432, 1025 or 8025 is
  taken. `--preflight` runs only these checks.
- **It raises its own compose project, `ppp-fulltest`**, never `ppp`, so the
  teardown cannot reach a project it did not create; and before the first suite
  it checks that the app container belongs to that project. The suites delete
  every user and ticket in the database they are pointed at.
- **It puts `.env`, `.env.backup` and `.env.docker` back exactly as they
  were** — on success, on failure and on Ctrl-C — including removing one that
  was not there before. The suites read `.env`, so for the length of the run
  those files describe the test stack. If the run is killed outright, the
  originals wait in the git directory and the next run says so: `--restore`
  puts them back and removes the leftover containers.
- **Interrupting it always ends in the teardown.** Ctrl-C in a terminal goes
  to the suite that is running as well as to the script, so the suite usually
  stops at once; a signal sent to the script alone (`kill <pid>`) is acted on
  when the current step returns. Either way the stack then comes down and the
  env files go back, and a second Ctrl-C during that is ignored. It also
  refuses a `PPP_FULLTEST_OUT` that still holds a `data` directory from an
  earlier run, because the data directory has to be fresh.
- **Logs** go to a fresh directory under `$TMPDIR` (or `PPP_FULLTEST_OUT`),
  one file per step, with `summary.txt` and the containers' own output in
  `compose.log`. The path is printed first and last.
- **It leaves the images it built**, tagged `:full-test-local` so that a
  pulled `:latest` is never overwritten. `docker image rm` them when the disk
  matters.

`--only` and `--no-build` print `PARTIAL RUN`; neither is what a merge or a
release is gated on.

## Cutting a release

A release is a name for a commit that is already on `main`. Every merge
publishes signed images under the commit SHA; a `v*` tag republishes the same
commit under a version a person can say out loud, and deliberately does not
move `latest`.

The release wizard does it, one confirmed step at a time:

```bash
scripts/release-wizard.sh [X.Y.Z]            # start one; it suggests the version
scripts/release-wizard.sh --continue X.Y.Z   # resume wherever X.Y.Z got to
scripts/release-wizard.sh --status           # read-only: where things stand
scripts/release-wizard.sh --dry-run [X.Y.Z]  # print what a fresh start would do
```

It asks before each of the four things that cannot be taken back quietly —
preparing the branch; committing, pushing and opening the pull request; pushing
the tag; publishing the release — and anything but `y` stops there. It keeps no
state file: where a release has got to is read from git and GitHub each time,
so `--continue` works after a reboot or from another clone. **It never merges
the pull request.** It waits, the owner merges in the browser, and it carries
on; Ctrl-C while it waits is safe.

What it does, which is also how to do it by hand:

1. **A release pull request.** In `CHANGELOG.md`, the `## Unreleased` section
   becomes `## vX.Y.Z` with the date and — if anything about deploying it
   differs from the last release — an *Upgrading from* section, and a fresh
   empty `## Unreleased` goes above it. `package.json` and the lockfile take the
   version (`npm version X.Y.Z --no-git-tag-version`). The image tag used as an
   example in the README and the deployment guide moves to the new version.
   The wizard starts from a clean `main` that is level with the remote, adds a
   stub for the *Upgrading from* section when there are new migrations and no
   notes yet, and opens the editor on it.
2. **Merge it** like any other change, with [the full local run](#the-full-local-run).
3. **Tag that merge commit and publish the release:**

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" <merge commit> && git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — …" --notes-file notes.md
   ```

   The tag push runs `release-images.yml`, which publishes `ppp-app`,
   `ppp-migrate` and `ppp-storage-migrate` as `:vX.Y.Z`.

Four rules the wizard holds to, and that a release by hand should too:

- **Tag the merge commit by its SHA** — the one GitHub reports for the pull
  request — never `main` and never a local branch. `main` may have moved on by
  the time the tag is cut, and a local branch may be stale; either puts the
  version's name on a commit that is not the release.
- **Tag only once CI has passed on that commit.** The pull request was green,
  but that was the branch; `main` is what gets the name.
- **Publish only once the tag's `release-images` run has finished
  successfully**, not as soon as the images can be pulled. The workflow pushes,
  then signs, then scans, so an image exists a minute before its signature
  does — and the deploy wizard refuses an unsigned image. A release announced
  in that minute fails for the first person who deploys it.
- **Keep an "Upgrading" heading in the release notes** whenever the changelog
  section has one. The notes are short on purpose — the summary, the
  *Upgrading from* section, and a link to the full changelog — and that
  section is the part someone needs before changing `PPP_TAG`.

A version is prepared once. If anything already carries it — a tag, a
`release-X.Y.Z` branch, a pull request in any state, or `main` itself — the
wizard refuses to start it again and points at `--continue`. Pre-releases and
the very first release are cut by hand.

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

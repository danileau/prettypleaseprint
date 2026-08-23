# Pretty Please Print

Invite-only 3D print requests for a small office. One person owns the printer;
everyone else uploads a model and follows it through the print stages.

Previously *Print That For Me*, the name the design handoff uses. The handoff
is unchanged in `Print That for Me/`; everything in the app reads
*Pretty Please Print*, story refs included (`PPP-104`).

Built from `Print That for Me/design_handoff_print_that_for_me/`. Built so far:

- **Authentication and invitation-link registration** — username and password,
  passkeys, invite-only with no public sign-up.
- **Upload → board → story detail** — real file validation, object storage,
  mesh measurement, the kanban board, and the read half of story detail.
- **An audit trail** covering access and story events, readable at
  `/admin/audit`.

Not built: the admin queue and status transitions, the conversation thread,
the 3D viewer, the profile screen, and notification delivery by email.

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
npm run verify:passkey        # WebAuthn ceremonies in a real browser
npm run probe:security        # 62 OWASP-mapped security probes
```

## How authentication works

**An invitation link registers you; after that you sign in with a username and
a password.** No inbox round trip, and nothing in the running system depends on
a mail server.

Two ways in:

- **Username and password** — the way in, and the one that always works. At
  least 10 characters, capped at 128, and refused outright if the password
  already appears in a known breach corpus.
- **Passkey** (WebAuthn) — optional, stronger, and faster. Offered through
  browser conditional UI, so it can sign someone in from the username field
  with no click at all.

The passkey is an accelerator, not the way in. That is the correction this
model makes over the one before it: an emailed link was doing the job of a
password while being harder to use and impossible to use at all when mail was
down.

### Why ten characters, and why a breach check

Length is the control that does the work. Composition rules — a digit, a
symbol, a capital — mostly move people to `Password1!`, which is in every
corpus there is. So the rules here are: ten characters minimum, and
[Have I Been Pwned](https://haveibeenpwned.com) says no.

The breach lookup is k-anonymity: five characters of a SHA-1 prefix go to
`api.pwnedpasswords.com`, and the password itself never leaves the machine. It
**fails closed** — if that service cannot be reached, setting a password fails
rather than quietly skipping the check. Only registration and reset set a
password, so an outage cannot lock out anybody who already has one.

`HIBP_DISABLED=true` turns it off, and exists for exactly one case: a
deployment with no outbound internet at all, where failing closed would mean
nobody could ever register.

### Getting people onto passkeys

The thing that decides whether people get there is not the technology, it is
whether anyone ever asks them twice. Registration offers a passkey once; the
first version let people tap "Skip for now" and then never mentioned it again,
which left them typing a password every time without having chosen that.

So there are three prompts, and two tests holding them in place:

- A banner for anyone with zero passkeys, dismissible **for the session only** —
  closing it means "not right now", not "never".
- A line in the account menu saying how you currently sign in, with a way to
  change it.
- Honest copy on the skip: "Not now — keep typing my password", rather than
  implying it is a postponement.

All three disappear the moment a passkey exists.

### Mail is optional — genuinely

**Nothing in the running system needs a mail server.** People sign in with a
password, and notifications are in-app, written by `notify()` and read by the
Activity panel. Mail is called in exactly three places, and every one of them
is delivering a *link*: sending an invitation, resending one, and sending a
password reset.

With `SMTP_URL` or `RESEND_API_KEY` set, those links are emailed. With neither,
the admin gets the link on screen to hand over directly, and the app boots
normally rather than refusing to start. Same token, same single use, same
expiry either way.

For a group that shares an office, handing a link over is arguably the safer
channel: a token in an inbox sits there indefinitely and can be forwarded,
where one passed over in person cannot. When mail *is* configured the raw
token is still withheld from the admin — it exists only inside the message —
because that property is worth keeping wherever it can be kept.

### Forgotten passwords

**"Forgotten password?"** sits against each member on the guest list. The admin
presses it; a single-use, thirty-minute token is minted, emailed if there is a
transport and shown to the admin to hand over if there is not.

The link opens a set-password form. It does **not** sign anyone in — that is
the whole difference from the sign-in link it replaces, which signed whoever
held it in *as* that person. Here they choose a password and then have to use
it, and setting it revokes every session the old password opened. Both halves
are audited: `password.reset_requested` names the admin, `password.reset_completed`
names the member.

There is no self-service "forgot password" form. With no `sendResetPassword`
configured, Better Auth's `/request-password-reset` refuses outright — resets
are admin-minted so the flow cannot depend on a mail server that may not exist.

One detail worth knowing, because it is a deliberate deviation: Better Auth
consumes the reset token *before* it hashes the new password, so a password
refused by the breach check would burn the link on its way out and send someone
back to the admin over a password they were about to correct. `setPassword`
puts the row back — with its original expiry — when the failure happened after
consumption. The link is spent when a password is actually set, which is what
"single use" was ever meant to mean.

### Bootstrapping the admin

The printer owner is the one account nobody invites, so `prisma/seed.ts` writes
the row directly. A row cannot sign in on its own, so when the admin has no
password the seed mints a set-password link and **prints it**:

```bash
docker compose --env-file .env.docker -f docker-compose.prod.yml logs migrate
```

Open it within thirty minutes to choose a username and a password. Lost it?
Re-run the migrator and it prints a fresh one — but only while no password has
been set. Re-seeding never resets an existing one.

There is deliberately no `ADMIN_PASSWORD`. It would sit in `.env.docker`, in
`docker inspect`, in the shell history that wrote the file and in every backup
of the host, still valid months later. A link that expires in half an hour is a
smaller thing to leak.

### Invite-only, enforced in one place

A `User` row can only come into existence when a pending invite matches the
address. That decision lives in a single hook, `user.validateUserInfo` in
[`src/lib/auth.ts`](src/lib/auth.ts):

```ts
async validateUserInfo({ user, source }) {
  if (source.action !== "create-user") return;
  if (!(await pendingInviteFor(user.email)))
    return { error: "invite_required", ... };
}
```

Better Auth calls it before provisioning an identity **by any method**, from
`internalAdapter.createUser`. Password sign-up goes through that path with
`{ method: "email-password" }` exactly as passkey enrolment does, so adding
passwords neither moved this rule nor added a second copy of it in a route
handler to drift out of sync. `verify:auth` asserts it directly: registering an
address with no pending invite is answered 403 and leaves no row.

### The invitation link

1. The admin submits an address at `/admin/invites`.
2. `createInvite` mints 32 bytes of CSPRNG output, stores **only its SHA-256
   digest**, and emails the raw token inside the link. The raw token is never
   returned to the admin either — it exists in the email and nowhere else.
3. The invitee opens `/invite/<token>`, sees who invited them and which
   address the invite is bound to, and picks a display name, a **username** and
   a **password**.
4. Submitting calls Better Auth's sign-up, which runs the invite gate and the
   stamping hook, creates the account and returns a session. They land on
   `/welcome`, which offers a passkey.
5. `databaseHooks.user.create.after` burns every open invite for that address,
   so the link cannot mint a second account.

Invites expire after 7 days, can be withdrawn, and can be re-sent — re-sending
**rotates the token**, so a previously leaked email stops working.

#### Why registering does not send a second email

The invite token was delivered to that mailbox and nowhere else, so following
the link already proves control of it. Making someone read a *second* email to
finish registering adds a hop without adding assurance — and it would put a
mail server back on the critical path for getting in, which is precisely what
this model exists to remove.

So registration creates the session directly. There is no in-process link to
redeem and no `AsyncLocalStorage` machinery holding one; the previous version
had both, and they existed only to work around the absence of a password.

#### Usernames

3–32 characters of letters, digits, `-` and `_`. Case is accepted but not kept:
the value is folded to lower case on write and looked up folded, so `Ayla_B` is
stored as `ayla_b`, signs in as either, and cannot be registered twice in
different clothes. `displayUsername` keeps whatever was typed.

Matching case-insensitively rather than refusing capitals is the friendlier
half of that: somebody whose phone capitalises the first letter should be told
the username is taken, not that it is malformed.

### Privileged fields cannot be set over the wire

`role`, `initials` and `invitedById` are declared `input: false`. Better Auth
does not quietly strip them — it **refuses the whole request** with
`FIELD_NOT_ALLOWED`, which is the better failure: a sign-up that half-worked
would be harder to notice than one that did not. They are written server-side
in `databaseHooks.user.create.before`, read out of the invite row.

Fields that are not declared at all — a chosen `id`, a posted `emailVerified` —
reach the endpoint and are simply overruled. There are tests for both halves.

### Exactly one admin

Application code refuses to seed a second admin, but application code is one
bug away from being wrong, so the storage layer enforces it too:

```sql
CREATE UNIQUE INDEX "user_single_admin" ON "user" (role) WHERE role = 'admin';
```

The index covers only admin rows, so it permits any number of clients and
exactly one admin.

### Authorisation

[`src/lib/authz.ts`](src/lib/authz.ts) holds the handoff's core rule as one
exported fragment that every query composes:

```ts
export function storyScope(actor: Actor): Prisma.StoryWhereInput {
  return actor.role === "admin" ? {} : { uploaderId: actor.id };
}
```

`getStoryOr404` answers **404, not 403**, for a client asking after somebody
else's story — a 403 would confirm the story exists. `requireAdmin` does the
same for admin-only routes.

`src/middleware.ts` only checks that a session cookie is *present*, to redirect
early instead of flashing a shell. It is deliberately not the boundary: a
forged cookie gets past it and no further. The real checks run in every page
and every server action.

### Other decisions worth knowing

- **Cookies** are `HttpOnly`, `SameSite=Lax`, `__Secure-` prefixed, and keyed
  on the *URL scheme* rather than `NODE_ENV` — a production boot over plain
  HTTP throws unless it is loopback, and an HTTPS deployment always gets the
  flag regardless of how the env is set.
- **Session cookie caching is off.** It would trust a signed snapshot without
  a database lookup, which makes sign-out lag by the cache lifetime. A DAST
  probe caught exactly that; see [SECURITY.md](SECURITY.md).
- **CSP carries a per-request nonce** minted in `src/middleware.ts`, so
  `script-src` needs no `'unsafe-inline'`. Every script tag on a rendered page
  carries it.
- **Rate limiting** is on, in Postgres, with the password paths capped well
  below the blanket rule: `/sign-in/username`, `/sign-up/email` and
  `/reset-password` get 10 a minute per IP. Ten rather than three *because an
  office sits behind one NAT address* — a tighter limit would lock out the
  colleague at the next desk. Ten a minute still puts online guessing several
  thousand years away from a ten-character password, which is the number that
  matters.
- **No user enumeration**: a wrong password and an invented username get
  byte-identical responses, and an unknown username still pays for a password
  hash so the wall clock does not answer either. Both are probed.
- `SameSite=Lax`, not `Strict`, because `Strict` would drop the cookie on the
  hop from a set-password link and the sign-in would appear to silently fail.
- **Reset tokens are hashed at rest.** `verification.storeIdentifier: "hashed"`
  means the table holds a digest, not a link anyone could paste into a URL.
  `prisma/reset-token.ts` reproduces that digest for the two places that mint a
  row directly — the admin control and the seed — and is the single definition
  of the format, because the migrator image ships `prisma/` and nothing else.

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

## What is deliberately not built

- **Email/Slack notification delivery.** `Notification` rows and the `notify()`
  helper exist and the Activity panel reads them; only the in-app record is
  written so far.
- **A designed whole-board empty state.** There is a minimal one that says what
  is true rather than showing a blank page, but the handoff asks for a design
  decision here — treat it as a placeholder.

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

## Running it in containers

The dev stack (`docker-compose.yml`) runs Postgres, MinIO and Mailpit while the
app runs on the host under `npm run dev`. That is the loop for building.

`docker-compose.prod.yml` runs **everything**, including the app, and is also
the basis for deployment:

```bash
cp .env.docker.example .env.docker      # then fill in the secrets
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.build.yml \
  -f docker-compose.test.yml --profile mailcatcher up -d --build
```

App on :3000, Mailpit on :8025 — every invitation and sign-in link lands there,
so the whole flow is clickable without a mail server.

Five compose files, each with one job:

| File | Job |
| --- | --- |
| `docker-compose.yml` | dev infrastructure only — the app runs on the host under `npm run dev` |
| `docker-compose.prod.yml` | the full stack, **consuming published images**. Publishes no host ports. |
| `docker-compose.build.yml` | puts the build context back, for local work and CI |
| `docker-compose.test.yml` | publishes the ports a local run and the host-side suites need |
| `docker-compose.truenas.yml` | the proxy network, for a deployment behind Nginx Proxy Manager alone |
| `docker-compose.cf.yml` | the same, but with Cloudflare proxying in front of NPM |

`prod` consumes rather than builds on purpose: a deployment then needs no
source tree and no toolchain, and what runs there is byte-for-byte what CI
tested. It also publishes **no host ports at all** — each context adds only
what it needs, so nothing is exposed by default.

`--env-file` is not optional — compose reads `.env` for `${...}` interpolation,
and `.env` here belongs to the host-side dev workflow.

Three images come out of one `Dockerfile`. The **migrator** runs
`prisma migrate deploy` and the seed, then exits; the app waits on
`service_completed_successfully`, so a deploy can never serve against an
unmigrated schema. The **runner** is the slim runtime — standalone Next output,
non-root, with a healthcheck.

To run the verification suites against the containerised app, add
`-f docker-compose.test.yml`, which publishes Postgres, MinIO and Mailpit's
SMTP port so the host-side scripts can reach them. **Never apply that overlay
on a deployed host** — those are internal services.

## Deploying to TrueNAS SCALE, behind Nginx Proxy Manager

Bind mounts under a dataset rather than named volumes, following the pattern
already used by `manyfold-truenas`, so snapshots and replication see ordinary
files.

**One-time**, so the proxy and the app can see each other:

```bash
docker network create npm-proxy
docker network connect npm-proxy <your-nginx-proxy-manager-container>
```

**Authenticate to the registry once**, so the NAS can pull what CI publishes:

```bash
docker login ghcr.io -u <your-github-user> -p <PAT with read:packages>
```

**In `.env.docker`:**

```bash
DATA_ROOT=/mnt/tank/ppp
APP_URL=https://print.example.org
PASSKEY_RP_ID=print.example.org        # permanent — see below
TRUST_PROXY_HEADERS=true
SMTP_URL=smtp://user:pass@mail.example.org:587

PPP_REGISTRY=ghcr.io/danileau
PPP_TAG=a1b2c3d                        # a commit SHA, not `latest`
```

Pin `PPP_TAG` to a SHA rather than `latest`. It is what makes a deploy
reproducible, and **it is also how you roll back** — set the previous SHA and
bring the stack up again.

**Bring it up** — without `--profile mailcatcher`, which exists to catch mail
in development and has no business on a deployed host:

```bash
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.truenas.yml pull
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.truenas.yml up -d
```

Deploying is a human action by design. Nothing in CI reaches into the NAS.

### The deploy wizard

`scripts/deploy-wizard.sh` is the single entry point for a deploy. Copy it next
to `docker-compose.prod.yml` on the NAS and run it there — it needs `docker`,
`curl` and `python3`, and deliberately not `git`, `gh` or a checkout, because
the NAS is a consumer of images and should stay one.

```bash
./deploy-wizard.sh            # interactive
./deploy-wizard.sh --status   # read-only: what is live, and what is newer
```

It answers what a bare `sed PPP_TAG && docker compose up -d` does not:

1. **Which image?** It asks ghcr.io what is actually published, newest first,
   with build dates and the live one marked, so you pick from a menu instead of
   copying a SHA out of a CI log. It filters to 7-hex-char tags — the cosign
   `.sig` and SBOM `.att` tags live in the same package and are not runnable
   images — and sorts by `created_at`, because re-pointing `latest` touches the
   *previous* version's `updated_at` and would otherwise reshuffle history.
2. **Is it intact?** It `cosign verify`s both images against the identity of
   this repo's `release-images` workflow before anything is swapped. If cosign
   is missing it says so and asks, rather than skipping quietly.
3. **Did it work?** It polls the public health URL after the swap and **rolls
   back to the previous tag automatically** if health does not stabilise —
   then tells you whether the rollback is healthy, which distinguishes "bad
   image" from "the proxy or the database is down".

The registry token is borrowed and returned: read from a hidden prompt, used
for the pull, then `docker logout` on exit including on failure. Nothing
long-lived is left on the NAS, which costs nothing — the images are local
afterwards, and `restart: unless-stopped` brings them back after a reboot with
no registry access at all.

Rollback is the same menu: pick the older tag.

**In Nginx Proxy Manager**, add a Proxy Host:

| | |
| --- | --- |
| Domain Names | `print.example.org` |
| Scheme | `http` |
| Forward Hostname | `ppp-app` — the container name, not an IP |
| Forward Port | `3000` |
| Block Common Exploits | on |
| Websockets Support | off — this app opens none |
| SSL | request a Let's Encrypt certificate, **Force SSL** on, HTTP/2 on |
| HSTS | off — the app sends its own |

The app publishes no host port, so `ppp-app:3000` over the shared network is
the only way in. Nothing on the LAN can reach it in cleartext and bypass TLS.

### Why `TRUST_PROXY_HEADERS` is a separate switch

The audit trail records the client address, and that address comes from
`X-Forwarded-For` — a header set by whoever spoke to us last. Behind a proxy
that is the proxy, and the value is real. Reachable directly, it is whatever
the caller typed, and believing it would let someone put chosen strings in the
audit log and pin their own refused attempts on another address.

So it is off by default, and the trail records *no* address rather than a
fictional one. `docker-compose.truenas.yml` turns it on, and is also the file
that makes it true by keeping the app off every host port.

**Put Cloudflare in front and it has to go off again**, which is why
`docker-compose.cf.yml` exists as a separate overlay. Cloudflare *appends* to
`X-Forwarded-For` instead of replacing it, and NPM appends after that, so the
left-most entry — the one `clientIp()` reads — is whatever the client chose to
send. `CF-Connecting-IP` is the header that cannot be spoofed there, and the
app does not read it yet. Until it does, a Cloudflare-fronted deployment
records no address, which is the honest answer rather than an attacker-chosen
one. The `cf` overlay is identical to the `truenas` one except that it leaves
the setting to `.env.docker`, where it must be `false`.

### HTTPS is not optional, and here is why

Two independent reasons:

1. **WebAuthn requires a secure context.** Browsers refuse to create or use a
   passkey over plain HTTP, with the single exception of `localhost`. On
   `http://nas.local:3000`, passkeys simply do not work — everyone falls back
   to a username and a password, which still function.
2. **The app refuses to start.** `src/lib/auth.ts` throws in production when
   `BETTER_AUTH_URL` is not `https://`, unless it is loopback. Session cookies
   carry `Secure`, and a cookie the browser discards is an app nobody can sign
   in to — failing at boot is better than failing mysteriously at sign-in.

Put it behind whatever already terminates TLS for you, and make sure the proxy
forwards the original `Host` and sets `X-Forwarded-For` — the audit trail
records that address.

### `PASSKEY_RP_ID` is permanent

It is the registrable domain with no scheme and no port
(`print.example.org`, not `https://print.example.org:443`). Passkeys are bound
to it cryptographically. **Change it later and every passkey already
registered stops working**, with no migration path — everyone signs in with
their password and re-enrols. Pick the hostname you intend to keep.

### First run

`migrate` seeds exactly one admin from `ADMIN_EMAIL` / `ADMIN_NAME` and prints
a one-use link for setting a username and a password:

```bash
docker compose --env-file .env.docker -f docker-compose.prod.yml logs migrate
```

Open it within thirty minutes, then invite the office from `/admin/invites`.
The seed is an upsert, so it is safe on every start and keeps the admin's name
in step with the environment — but it will refuse to create a *second* admin,
and so will the database, and it never resets a password that already exists.

### What to back up

Everything is under `DATA_ROOT`: `db/` (Postgres) and `models/` (the uploaded
files). A ZFS snapshot of the dataset captures both. `.env.docker` holds the
secrets and is not in the repo — keep it somewhere you will still have it after
a rebuild, because losing `BETTER_AUTH_SECRET` invalidates every session and
losing `DB_PASSWORD` locks you out of the database.

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

## Security

Validated against the OWASP Top 10 (2021) with SAST (Semgrep), SCA (npm audit,
Trivy, Syft+Grype) and DAST (OWASP ZAP plus 50 app-specific probes). Findings,
fixes and the remaining gaps — including an honest **A09 logging gap** — are
in [SECURITY.md](SECURITY.md).

`package.json` carries `overrides` for `postcss`, `sharp` and `deepmerge-ts`.
They are not cosmetic: they clear six high-severity advisories without a
Next.js major bump or a Prisma downgrade. Re-check them when you next move
framework versions, and drop any that upstream has caught up with.

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
src/app/
  board/                 the kanban backlog, scoped per role
  upload/                dropzone, wish form, XHR progress
  story/[id]/            story detail (read half)
  api/upload/            validation, storage, story creation
scripts/
  deploy-wizard.sh       pick an image, verify it, deploy, auto-rollback
  verify-models.ts       validator vs. hostile fixtures
  verify-auth.ts         registration, sign-in and password reset
  verify-upload.ts       upload -> board -> story
  verify-passkey.ts      WebAuthn in a real browser
  security-probe.ts      OWASP-mapped security probes
src/app/admin/
  invites/               the guest list
  audit/                 the audit log, admin only
```

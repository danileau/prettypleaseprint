# Running and deploying

[← back to the README](../README.md)

## Running it in containers

The dev stack (`docker-compose.yml`) runs Postgres and Mailpit while the app runs
on the host under `npm run dev`. That is the loop for building. Model files go to
`./data/uploads`; there is no storage service to run.

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

Six compose files, each with one job:

| File | Job |
| --- | --- |
| `docker-compose.yml` | dev infrastructure only — the app runs on the host under `npm run dev` |
| `docker-compose.prod.yml` | the full stack, **consuming published images**. Publishes no host ports. |
| `docker-compose.build.yml` | puts the build context back, for local work and CI |
| `docker-compose.test.yml` | publishes the ports a local run and the host-side suites need |
| `docker-compose.proxy.yml` | the proxy network, for any deployment behind a reverse proxy |
| `docker-compose.tunnel.yml` | a Cloudflare Tunnel connector, for a deployment with no inbound path at all |

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
`-f docker-compose.test.yml`, which publishes Postgres and Mailpit's SMTP port so
the host-side scripts can reach them. **Never apply that overlay on a deployed
host** — those are internal services.

## Deploying to TrueNAS SCALE, behind Nginx Proxy Manager

Bind mounts under a dataset rather than named volumes, following the pattern
already used by `manyfold-truenas`, so snapshots and replication see ordinary
files.

**One-time**, so the proxy and the app can see each other:

```bash
docker network create npm-proxy
docker network connect npm-proxy <your-nginx-proxy-manager-container>
```

**No registry credential is needed.** The images are public, so the host pulls
them anonymously — nothing to create, store or rotate. Forks that keep their
packages private need a one-off login instead:

```bash
docker login ghcr.io -u <your-github-user> -p <classic PAT with read:packages>
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
  -f docker-compose.prod.yml -f docker-compose.proxy.yml pull
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.proxy.yml up -d
```

Deploying is a human action by design. Nothing in CI reaches into the NAS.


### Verifying signatures (and where cosign has to live)

CI signs every image with cosign keyless, which is what protects the
registry-to-host link against a substituted image. The wizard checks that
before it swaps anything — but only if it can find `cosign`, and it says so
loudly when it cannot rather than skipping quietly.

**Do not install it into the OS.** TrueNAS and similar appliances replace the
system filesystem on update, taking `/usr/local/bin` with it — the check would
silently stop happening at the next upgrade, which is worse than never having
had it. Put the binary on the same dataset as the deployment, where the wizard
also looks:

```bash
cd /mnt/<pool>/applications/ppp/app
mkdir -p bin
curl -fsSL -o bin/cosign \
  https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x bin/cosign
./bin/cosign version
```

It is a single statically linked binary with no runtime dependencies, so there
is nothing else to install.

Verify by hand if you want to see it work:

```bash
./bin/cosign verify \
  --certificate-identity-regexp '^https://github\.com/danileau/(prettypleaseprint|ppp)/\.github/workflows/release-images\.yml@refs/(heads/main|tags/v[0-9][0-9A-Za-z.\-]*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/danileau/ppp-app:v0.3.0
```

Two things that alternation is carrying, both found by verifying a real
signature rather than by reading the workflow:

- **A tag build signs with `refs/tags/<tag>`, not `refs/heads/main`.** Release
  images — the thing a deployment is meant to pin — therefore fail a pattern
  written only for branch builds.
- **Keyless signing embeds the repository path**, so images built before the
  repository was renamed carry the old one and stay verifiable.

### The deploy wizard

`scripts/deploy-wizard.sh` is the single entry point for a deploy. Copy it next
to `docker-compose.prod.yml` on the NAS and run it there — it needs `docker`,
`curl` and `python3`, and deliberately not `git`, `gh` or a checkout, because
the NAS is a consumer of images and should stay one.

```bash
./deploy-wizard.sh            # interactive
./deploy-wizard.sh --status   # read-only: what is live, and what is newer
```

The wizard is not part of any image and does not update itself. The copy on
the host is whatever you put there, so take the new one when you upgrade:
`https://raw.githubusercontent.com/danileau/prettypleaseprint/<tag>/scripts/deploy-wizard.sh`.
A copy from before v0.3.0 still deploys, but shows no upgrade notes.

It answers what a bare `sed PPP_TAG && docker compose up -d` does not:

1. **Which image?** It lists what can be deployed, newest first, with dates and
   the live one marked, so you pick from a menu instead of copying a tag out of
   a CI log. Without a token the list is the GitHub releases, which is the
   right list for most deployments. With one it is every published image:
   releases by their version, builds of `main` by their 7-character SHA. The
   cosign `.sig` and SBOM `.att` tags live in the same package and are left
   out, because they are not runnable images; the order is by `created_at`,
   because re-pointing `latest` touches the *previous* version's `updated_at`
   and would otherwise reshuffle history. A version that is a GitHub release is
   marked `release` with its title, and a version tag nobody has published a
   release for says `tagged, not released`.
2. **Is it published yet?** Pushing a version tag is what starts the image
   build, so for a few minutes a version is on offer that the registry does not
   have. A version is refused until every image in `PPP_IMAGES` exists at that
   tag, with a link to the build to wait for, and nothing is changed. If the
   registry will not say (a private package before the login, a network
   error) the wizard says it could not check and lets the pull decide.
3. **What does upgrading need?** Before swapping, it shows the "Upgrading"
   notes of every release between what is running and what you chose, and asks
   whether you have read them. Going from v0.1.0 to v0.4.0 shows the notes of
   v0.2.0, v0.3.0 and v0.4.0; going back shows the same ones, because they say
   whether there is a way back. They come from the GitHub releases, since the
   NAS has no checkout to read a changelog from. A SHA build is placed among
   the releases by git ancestry (which releases that commit contains, asked of
   GitHub's compare API), not by date. When the wizard cannot tell what lies
   in between — `PPP_TAG` is `latest`, the version has no published release,
   GitHub does not answer, the commit is on a branch that left the line the
   releases are on, the notes mention upgrading in a form it cannot parse —
   it says so, says the notes were *not* shown, and still asks. When releases
   are crossed and none of them has upgrade notes, it prints one line saying
   so and does not ask. A deploy from one SHA build to the next with no
   release in between shows nothing and asks nothing extra.
4. **Is it intact?** It `cosign verify`s both images against the identity of
   this repo's `release-images` workflow before anything is swapped. If cosign
   is missing it says so and asks, rather than skipping quietly.
5. **Did it work?** It polls the public health URL after the swap and **rolls
   back to the previous tag automatically** if health does not stabilise —
   then tells you whether the rollback is healthy, which distinguishes "bad
   image" from "the proxy or the database is down".

For the wizard to find them, a release's notes must keep a heading that starts
with "Upgrading" (any level, as in `## Upgrading from v0.1.0`); everything up
to the next heading of the same or a higher level is shown, cut at 200 lines
with a pointer to the release. Only the newest hundred releases are read. A
version older than those is treated as having no published release, so the
wizard says it cannot tell and asks; a SHA build older than all of them is
shown the notes of the hundred it can see and not of the ones before.

Answers can be piped in. A "no" stops the wizard with exit 0; stdin ending
before a question is answered stops it with `aborted (no input).` and exit 1,
so a script cannot mistake one for the other. The token prompt is the
exception: no input there means "no token", not an abort, so
`./deploy-wizard.sh --status </dev/null` still prints the release list.

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

### Your proxy has to allow the upload size too

The app accepts models up to **250 MB**, and a reverse proxy in front of it has
its own opinion about request bodies. Nginx Proxy Manager's default
`client_max_body_size` is small, and when it bites, the upload fails at the
proxy — so the app logs nothing at all and the browser shows a generic error.

In NPM: the proxy host → *Advanced* → add

```nginx
client_max_body_size 300m;
```

300, not 250: a multipart body is the file plus its boundaries and the form
fields, so a maximum-sized model arrives as a slightly larger request. The app
uses the same allowance internally (`MAX_REQUEST_BYTES`).

Worth knowing that this was never exercised before: the framework itself capped
bodies at 10 MB until that was raised, so no upload large enough to reach the
proxy's limit had ever been sent. If uploads used to work and large ones now
fail with nothing in the app log, this is the first place to look.

### Why `TRUST_PROXY_HEADERS` is a separate switch

The audit trail records the client address, and that address comes from
`X-Forwarded-For` — a header set by whoever spoke to us last. Behind a proxy
that is the proxy, and the value is real. Reachable directly, it is whatever
the caller typed, and believing it would let someone put chosen strings in the
audit log and pin their own refused attempts on another address.

So it is off by default, and the trail records *no* address rather than a
fictional one.

It is a **named source rather than a boolean**, because which header to
believe depends on what is actually in front of the app — and getting that
wrong does not fail loudly, it quietly fills the trail with addresses the
client picked:

| value | header read | when |
| --- | --- | --- |
| unset / `false` | none | default; correct whenever the app is reachable without the proxy |
| `true` | left-most `X-Forwarded-For` | a proxy that **replaces** the header — Nginx Proxy Manager alone |
| `cloudflare` | `CF-Connecting-IP` | behind Cloudflare |

**Cloudflare needs its own mode** because it *appends* to `X-Forwarded-For`
instead of replacing it, and a proxy behind it appends again — so the
left-most entry is whatever the client sent, with the real address buried
after it. `CF-Connecting-IP` is written at Cloudflare's edge and cannot be
spoofed through it.

The two modes never fall back to one another. Under `cloudflare`, a request
arriving with no `CF-Connecting-IP` did not come through Cloudflare, and
reading `X-Forwarded-For` instead would reopen exactly the hole the mode
exists to close — so it records nothing.

`docker-compose.proxy.yml` is what makes any of these honest, by keeping the
app off every host port so the proxy really is the only way in. It sets no
value itself, deliberately: a service-level `environment:` beats `env_file:`,
so an overlay that hard-codes one silently overrules your configuration. That
is not hypothetical — an earlier version of this file forced `true`, and a
Cloudflare-fronted deployment editing `.env.docker` found it had no effect
while its audit trail filled with client-chosen addresses.

**Publish a host port and the guarantee goes.** If your proxy cannot reach
containers by name and needs `<host-ip>:<port>` instead, add a small overlay of
your own:

```yaml
# docker-compose.published-port.yml
services:
  app:
    ports:
      - "30222:3000"
```

and understand what it costs: anyone on the LAN can then reach the app
directly and send whatever header `TRUST_PROXY_HEADERS` is set to believe.
Binding to the Docker bridge (`172.17.0.1:30222:3000`) keeps containers able to
reach it while the LAN cannot.

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

### There is no object store

Model files are files, in `$DATA_ROOT/uploads`. The compose files define no
storage service, nothing holds an S3 credential, and there is no image to keep
current.

Getting here took a while and the route is worth knowing, because it is the
reason this section exists at all rather than a paragraph about buckets. MinIO
withdrew its community distribution mid-2026: the Docker Hub repository began
answering 404, quay.io stopped serving anonymous pulls, and dl.min.io answered
410 for the server binary *and* for `mc` on every architecture — which also
killed upstream's own release Dockerfile, since it is a downloader. This project
mirrored the last release, then compiled its own from the AGPL source for two
architectures, and that image still carried 63 HIGH/CRITICAL advisories which no
upgrade fixed, because the newest upstream release shipped byte-identical
vulnerable dependencies.

At which point the honest question was not which registry to chase but why a
five-person office needed an S3 API to put a few hundred megabytes of STL on a
disk the app already had mounted. It did not. The app made six calls — head and
create a bucket, put, get, delete, copy — and every byte was already proxied
through the app because the deployment never published a port for storage.

If you are upgrading from a release that had one, the next section is the step
that matters.

### Moving the models onto the filesystem

The object store is being removed — see the reasoning above. The first step is
to copy every model out of MinIO and prove the copy is complete. **It changes
nothing about how the app runs.** The app keeps reading from MinIO afterwards,
and rolling this back is deleting what it wrote.

**Stop the stack first.** This is the one step in the migration that can lose
data, and it is not obvious: the overlay brings its own MinIO, and a deployment
that has not been upgraded yet is still running the previous release's one
against the same `$DATA_ROOT/models`. The container names differ, so Compose
starts the second quite happily — two MinIO processes on one data directory,
which is not supported and is exactly the data you are trying to rescue. The
ordinary path walks straight into it: pull the release, run the migration, then
deploy. The old container survives the `git pull`.

```bash
# 1. snapshot, if you are on ZFS
zfs snapshot -r storage/applications/ppp@pre-storage-migration

# 2. stop everything
docker compose --env-file .env.docker -f docker-compose.prod.yml down

# 3. migrate, and read the verification before going further
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.storage-migration.yml \
  run --rm migrate-storage

# 4. only once it says every model is accounted for
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d
```

It runs as a one-shot container named `ppp-storage-migration`, built from the
Dockerfile's `builder` stage and hidden behind a `migration` profile so no `up`
can start it by accident. Add whatever overlay your deployment normally uses
(`docker-compose.tunnel.yml`, `docker-compose.proxy.yml`) to steps 2 and 4 —
step 3 needs only these two.

It gets its own overlay and its own service because neither existing image can
run it: the runner carries only the Next standalone bundle, and the migrator
deliberately installs three packages and copies only `prisma/`. That overlay
builds from source, runs inside the compose network (production publishes no
port for MinIO, so the host cannot reach it), and hands the files it writes to
uid 1001 — the app's user — so the app can read them afterwards.

Take a snapshot first if you are on ZFS. One recursive snapshot makes the whole
exercise reversible, and it costs nothing:

```bash
zfs snapshot -r storage/applications/ppp@pre-storage-migration
```

**Do not copy the directory instead.** MinIO does not store objects as files.
Each one is a directory named after the key, and anything under its inline
threshold lives *inside* `xl.meta` rather than beside it — on the dataset this
was written against, 160 of 179 objects. A `cp -r` recovers the handful that
have a separate part file and silently loses the rest: the tree is there, the
filenames are there, every ticket page renders, and the only symptom is that
opening a model fails. The bytes come out through the S3 API or not at all.
The script refuses to run at all if you point it at MinIO's own directory.

What it reports, and what to do about it:

| | |
| --- | --- |
| `verified N / N` and exit 0 | every row in the database has a readable file of the right size. Done. |
| exit 1, with `MISSING` / `SIZE` / `CONTENT` rows | some models did not arrive. Nothing has been removed and the app is unaffected — fix the cause and run it again. |
| exit 2 | you pointed `MODELS_ROOT` at MinIO's data directory. It refused rather than mixing plain files into the object store's layout. |

It verifies against **the database**, not against MinIO: every `Story` row must
have a file, of the size the row records, whose first bytes are still the model
they claim to be. Asking MinIO whether it exported everything is asking the
wrong witness.

Re-running is safe and cheap — it skips whatever is already correct — so run it
once now and again immediately before the app is switched over, to pick up
anything uploaded in between.

### Removing the old object store's directory

Once the app is on the filesystem and you are satisfied, `$DATA_ROOT/models`
is the object store's leftovers and can go. It will not delete as yourself:
MinIO ran as root, so the tree is root-owned, and the same is true in reverse
of `uploads/`, which belongs to the app's uid 1001.

```bash
docker run --rm -v "$DATA_ROOT:/data" alpine rm -rf /data/models
```

From inside a container, for exactly the reason the backup instructions are:
your own account does not own these files. Reading them does work — `uploads/`
is mode 644 with 755 directories on purpose, so a `tar` or a snapshot needs no
root. It is only removal that does.

Take the snapshot first, and do this last. Nothing else in the migration is
irreversible; this is.

### Setting up mail

Optional — see [Mail is optional](authentication.md#mail-is-optional--genuinely)
for what the app does without it. With it, invitations and password resets are
emailed rather than handed over, and people get their notifications in their
inbox as well as in the app unless they switch that off.

Put the SMTP account in `.env.docker`:

```sh
MAIL_FROM="Pretty Please Print <print@yourdomain.example>"
SMTP_URL="smtps://user:pass@smtp.yourprovider.example:465"
```

- **`smtps://…:465`** connects over TLS from the first byte. **`smtp://…:587`**
  connects in the clear and upgrades with STARTTLS when the server offers it,
  which every real submission server does. Use whichever your provider names.
- **URL-encode the username and the password.** They sit inside a URL, so an
  `@` in a username is `%40`, and `#`, `/`, `:`, `?` and `%` in a password
  must be encoded too. An unencoded `@` is the usual reason a correct password
  is "rejected" — the host name is being read out of the middle of it.
- **`MAIL_FROM` has to be an address that account may send as.** Most providers
  refuse or rewrite anything else, and a domain you do not control will fail
  SPF at the recipient and land in spam.
- **Gmail, Microsoft 365 and similar need an app password**, not the account
  password, and usually two-step verification to create one.
- Remove the `mailpit` address the example file ships with; it only exists
  inside the local test stack.

Restart the app, sign in as the owner, open **Mail**, and press **Send me a
test message**. It goes to the owner's own address and nowhere else, and the
page reports what the server said — `Invalid login`, a refused connection, a
timeout — rather than leaving you to find it in the logs. It never shows the
connection string. If the page says it was sent and nothing arrives, look in
spam before looking at the settings: that is a reputation problem
(`MAIL_FROM`, SPF, DKIM), not a connection one.

The same page shows each message the app sends, with stand-in data, so you can
read what goes out under your name before anybody receives it.

Two things that are not failures:

- **Somebody is not getting notification emails.** They may have switched them
  off on their profile, or their access may have been revoked — a suspended
  account is sent nothing.
- **A notification email failed and nothing looked wrong.** By design: it is a
  copy of something already in the Activity panel, so a failed send is logged
  (`[mail] a notification could not be emailed`) and the action carries on.

### Importing from a link

Off by default. Add this to `.env.docker` and restart the app:

```sh
IMPORT_SOURCES="printables"
```

The request form then offers *or paste a Printables link* under the dropzone.
Someone pastes the address of a model's page, the app lists that model's
`.stl` and `.3mf` files, they pick one, and the server fetches it — nobody
downloads a model only to upload it again. From there it is an upload in every
respect, and the ticket links back to the model's page.

Four things to know before switching it on:

- **It needs outbound HTTPS** from the app container to `api.printables.com`
  and `files.printables.com`, and nowhere else. On a host with no route out it
  fails with a message saying Printables could not be reached; uploading is
  unaffected.
- **It speaks an API Printables has not published.** There is no documented
  public one, so this uses the endpoint the Printables website itself uses,
  and identifies itself honestly when it does (`PrettyPleasePrint (+<your
  SOURCE_URL>)`). It can change without notice. When it does, importing
  answers that the API may have changed and to upload the file instead — it
  does not half-work. Whether that use suits you under their terms is your
  call to make as the operator; this project has not been told either way.
- **It is not bound by your proxy's upload limit.** The file comes *in* from
  Printables rather than up through Cloudflare or Nginx, so the 100 MB edge cap
  described below does not apply; the app's own 250 MB limit does.
- **A misspelt value stops the app, on purpose.** `IMPORT_SOURCES="printable"`
  makes sign-in and the API answer 500 with a log line naming the variable,
  rather than quietly meaning "off". `/api/health` only checks the database and keeps
  answering 200, so the deploy wizard will not roll this back for you — sign
  in once after changing it.

Only Printables. MakerWorld and Thingiverse are not supported, and
[the architecture notes](architecture.md#importing-from-a-link) say why.

What a signed-in person can make the server do with this is narrow by
construction — they choose a model, never an address — and the
[security notes](security-audit.md#importing-from-a-link) set out what was
checked and what is accepted.

### What to back up

Everything is under `DATA_ROOT`: `db/` (Postgres) and `uploads/` (the uploaded
files). A ZFS snapshot of the dataset captures both. `.env.docker` holds the
secrets and is not in the repo — keep it somewhere you will still have it after
a rebuild, because losing `BETTER_AUTH_SECRET` invalidates every session and
losing `DB_PASSWORD` locks you out of the database.

## Deploying behind a Cloudflare Tunnel

The alternative to the section above, and the better answer on a connection
whose public address is not yours to keep. `docker-compose.tunnel.yml` runs a
`cloudflared` connector beside the app:

```bash
docker compose --env-file .env.docker \
  -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d
```

Use it **instead of** `docker-compose.proxy.yml`, not alongside it. Running
both leaves two ways in, and the second one is the one nobody remembers.

The difference is direction. A proxy deployment waits to be connected to, so it
needs a public address, an `A` record pointing at it, and 80/443 forwarded to
the host — three things that must all stay true. A tunnel deployment connects
outward: `cloudflared` opens the connection to Cloudflare and requests arrive
back down it. Nothing needs to be reachable from the internet.

That removes a whole class of outage. The deployment this file was written for
was migrated by its ISP from DSL to cable; the old address was handed back, the
`A` record went on pointing at an IP that no longer routed, and Cloudflare
answered **522** for as long as it took someone to notice — with the app
healthy, the certificate valid and the origin serving correctly the entire
time. Nothing in the app's own logs said anything was wrong, because from the
app's point of view nothing was.

It also retires this hostname's origin certificate. Cloudflare terminates TLS
at the edge and the tunnel itself is encrypted, so the app needs no Let's
Encrypt certificate at all — one fewer thing with an expiry date. (Only *its*
certificate: a wildcard that other hostnames still use stays; see below.)

`APP_URL` and `PASSKEY_RP_ID` do not change, because the hostname does not.
That matters more than it looks: passkeys are bound to the RP ID permanently,
so a migration that altered it would silently invalidate every passkey already
registered.

### Setting it up

**In the Cloudflare dashboard**, Zero Trust → Networks → Tunnels → *Create a
tunnel* → *Cloudflared*. Name it, then copy the connector token it shows.

**In `.env.docker`:**

```bash
CF_TUNNEL_TOKEN=eyJhIjoi...        # the connector token, a credential
TRUST_PROXY_HEADERS=cloudflare     # CF-Connecting-IP; see below
```

**Back in the dashboard**, on that tunnel, add one Public Hostname:

| | |
| --- | --- |
| Subdomain / Domain | `ppp` · `example.org` |
| Type | `HTTP` |
| URL | `ppp-app:3000` — the container name, not an IP, and not `localhost` |

`localhost` there would be the connector's own container, which is the mistake
this table exists to prevent. Adding the hostname writes the proxied `CNAME`
for you; **delete the old `A` record afterwards** rather than leaving it as a
second, wrong answer.

Then bring the stack up with the overlay, and once it serves, dismantle **this
app's** old way in: delete its Proxy Host in Nginx Proxy Manager, and stop
passing `docker-compose.proxy.yml`, so `ppp-app` is no longer on the proxy
network. Until you do, the app is still directly reachable — and
`TRUST_PROXY_HEADERS=cloudflare` is only honest while it is not.

**Stop there if anything else is served from the same host.** The 80/443 port
forwards on the router, the proxy itself and a wildcard certificate are
usually shared: every other hostname still proxied the old way arrives through
them. Remove them and those sites go down with **522** — Cloudflare cannot
reach an origin that no longer answers — while ppp, on its tunnel, stays up and
makes the cause harder to see. The forwards and the certificate can only go
once the *last* hostname behind them has moved to a tunnel too; adding each one
as another Public Hostname on a tunnel is how they get there.

### Turn Rocket Loader off, or nobody can sign in

Reported by NelsonFx on the pull request that added this overlay, and it is the
first thing an orange-clouded deployment is likely to hit.

Rocket Loader (Cloudflare dashboard → Speed → Optimization) rewrites every
`<script>` on the page to load through its own deferred loader. This app's
production CSP is:

```
script-src 'self' 'nonce-<per request>' 'strict-dynamic'
```

— with no `unsafe-inline`, on purpose. Next hydrates from an inline bootstrap
script carrying that request's nonce, and `strict-dynamic` lets it pull in the
rest of the chunk graph. Rocket Loader's rewritten scripts **do not carry the
nonce**, so the browser refuses them, hydration never happens, and no client-side
code runs at all.

What you see is worse than an error. Every page renders correctly, because the
server sent the HTML — the board, the ticket, the sign-in form all look right.
They simply do nothing. Sign-in is where it bites first, because `/signin` is a
client component and the passkey and password paths both go through the auth
client, but it takes the upload progress bar, the 3D viewer and the Activity menu
with it. The console shows CSP violations; nothing in the app's own logs does,
because the requests never arrive.

**Fix:** turn Rocket Loader off, either globally or with a Configuration Rule
scoped to this hostname.

There is no way to keep both. The alternative is adding `unsafe-inline` to
`script-src`, which discards what the nonce is there for — see
[the security audit](security-audit.md), where the nonce-and-`strict-dynamic`
policy is the whole answer to "no Content-Security-Policy". A page-speed feature
is not worth that trade on an invite-only app used by five people.

Auto Minify and Brotli are fine; they do not move script tags.

### Cloudflare refuses the upload before the app sees it

The app accepts models up to **250 MB**. Cloudflare's proxy caps request bodies
well below that, and the cap is per plan:

| plan | maximum request body |
| --- | --- |
| Free | 100 MB |
| Pro | 100 MB |
| Business | 200 MB |
| Enterprise | 500 MB by default |

Over the limit, Cloudflare answers **413** at the edge. The request never
reaches the tunnel, so the app logs nothing — the same silent shape as the
Nginx `client_max_body_size` problem above, one hop further out.

This is **not** something the tunnel introduces: it applies to any
orange-clouded hostname, so a deployment already proxied by Cloudflare has the
cap today. There is no setting below Enterprise that raises it. On a Free plan
the effective ceiling is 100 MB, not 250 MB, and `MAX_REQUEST_BYTES` cannot
change that — so either say 100 MB to the people uploading, or move the upload
path off the proxied hostname.

### How it fails, and where to look

A tunnel fails differently from a port forward, which is worth knowing before
you are reading an error at speed:

| symptom | meaning |
| --- | --- |
| **error 1033** | Cloudflare has the hostname but no healthy connector — `cloudflared` is down, cannot find the edge (below), or the token is wrong |
| **502** | the connector is up but cannot reach `ppp-app:3000` — wrong service URL, or the app is unhealthy |
| **413** | the upload cap above |
| **522** | should stop happening; it means something is still resolving to an origin IP |

`docker logs ppp-cloudflared` and the tunnel's own health in the Zero Trust
dashboard are the checks. The dashboard is the authoritative one, because it
knows whether the edge can see the connector — which nothing on the host can.

#### 1033 with a connector that restarts every minute: it is DNS

The connector does not have Cloudflare's addresses built in. It finds the edge
by looking up an SRV record, `_v2-origintunneld._tcp.argotunnel.com`, through
Docker's embedded resolver — which forwards to the host's nameservers **in
order**. If that lookup keeps failing, `cloudflared` retries for about a
minute, exits, and `restart: unless-stopped` starts it again, forever. The
dashboard shows the tunnel *Down* with no active replicas; the app is healthy
throughout.

This is what took the reference deployment down. The host's first nameserver
— a Pi-hole on the LAN — was accepting connections on port 53 but answering
nothing, and the second one was unreachable from that line. The host itself still resolved names, slowly, by falling through to the
third; the connector's lookup timed out before Docker got that far. So every
check made *from the host* looked fine, which is exactly why it is worth
knowing:

- the connector process keeps a fresh start time (`ps -eo pid,lstart,args |
  grep cloudflared`) while the app's does not;
- it never opens a connection to port **7844**, the edge's — only DNS queries;
- asking each of the host's nameservers directly shows which one is dead:

```bash
grep nameserver /etc/resolv.conf
dig SRV _v2-origintunneld._tcp.argotunnel.com @<nameserver>   # each in turn
```

Fix the dead resolver, or move a working one to the front of the host's list;
the next restart picks it up with no change to the stack. A token problem looks
different in `docker logs ppp-cloudflared` — the edge is reached and refuses
it — so read the log before rotating a token that was never the problem.

The connector image is distroless and has neither a shell nor `curl`, so it
carries no compose healthcheck; there is nothing in it to run one with.

`scripts/deploy-wizard.sh` needs no change. It polls the public health URL,
which is still `https://<your hostname>/api/health`, and rolls back on the same
signal as before.

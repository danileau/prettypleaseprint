# Running and deploying

[← back to the README](../README.md)

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
| `docker-compose.proxy.yml` | the proxy network, for any deployment behind a reverse proxy |

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
  ghcr.io/danileau/ppp-app:v0.1.0
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

### What to back up

Everything is under `DATA_ROOT`: `db/` (Postgres) and `models/` (the uploaded
files). A ZFS snapshot of the dataset captures both. `.env.docker` holds the
secrets and is not in the repo — keep it somewhere you will still have it after
a rebuild, because losing `BETTER_AUTH_SECRET` invalidates every session and
losing `DB_PASSWORD` locks you out of the database.

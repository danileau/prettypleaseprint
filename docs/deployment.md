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

### What to back up

Everything is under `DATA_ROOT`: `db/` (Postgres) and `models/` (the uploaded
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

# Security validation

Scope: Pretty Please Print, assessed against the **OWASP Top 10 (2021)** with
SAST, SCA and DAST. Everything below was run against the production build
(`npm run build && npm start`) on 2026-08-23.

Covers the authentication and invitation slice and the upload → board → story
slice. Re-run after every slice; the numbers below are current.

**Re-run on 2026-08-23** after authentication changed shape: invitation links
now *register* an account with a username and a password, and people sign in
with those. A07 is the category that moves — see
[A07 with passwords in the picture](#a07-with-passwords-in-the-picture) below,
which is the honest accounting of what got better and what got worse.

Reproduce with:

```bash
npm audit                                  # SCA
trivy fs --scanners vuln,secret,misconfig .
docker run --rm -v "$PWD:/src:ro" semgrep/semgrep semgrep scan \
  --config=p/owasp-top-ten --config=p/security-audit --config=p/nextjs /src/src
docker run --rm --network host ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://localhost:3000        # DAST
npm run probe:security                     # DAST, app-specific (103 probes)
```

## Result

| Tool | Coverage | Before | After |
| --- | --- | --- | --- |
| `npm audit` | dependency advisories | **6 high** | 0 |
| Trivy | vulns, secrets, misconfig | 0 | 0 |
| Syft + Grype | SBOM, binary contents | **92 (2 crit, 46 high)** | 0 |
| Semgrep | 153 rules, 37 files | 1 (false positive) | 0 |
| OWASP ZAP baseline | passive DAST | **1 medium, 3 low** | 0 fail / 63 pass |
| `probe:security` | 103 app-specific probes | **2 real, 4 artifacts** | 103 pass |
| `verify:models` | 29 upload-validator checks | — | 29 pass |
| `verify:passkey` | WebAuthn in a real browser | *unverified* | 13 pass |

A generic scanner cannot reason about *this* app's authority model, so the
probe suite in [`scripts/security-probe.ts`](../scripts/security-probe.ts) covers
what ZAP structurally cannot: whether a client can call the admin API, whether
an invite is single-use, whether a role can be set from outside, whether a
captured cookie survives sign-out, and — since the JSON API landed — whether
the same authority model holds when the caller is not a browser.

## Findings that were real

### 1. Session revocation lagged sign-out — *moderate, fixed*

`session.cookieCache` was enabled with a 60-second lifetime. It stores a
signed snapshot of the session in a second cookie and trusts it **without
touching the database**. Sign-out deleted the session row correctly — a
captured `session_token` alone was properly rejected — but a captured
`session_data` cookie kept authenticating until the snapshot expired.

On a shared office machine that is precisely the case sign-out exists to
cover. Cookie caching is now off; the cost is one indexed lookup per request,
which for a handful of users is not a trade worth making.

Caught by probe `A07-logout`. Worth noting *how* it was caught: an earlier
probe run had this passing, because the same cache was serving a stale display
name and masking a second probe too. Turning the cache off made both probes
meaningful.

### 2. No Content-Security-Policy — *medium, fixed*

ZAP flagged the missing header. Adding one naively would have been decorative:
Next.js hydrates from an inline bootstrap script, so a nonce-less policy has
to allow `'unsafe-inline'` in `script-src`.

Instead [`src/middleware.ts`](../src/middleware.ts) mints a per-request nonce and
Next stamps it onto its own scripts. Verified on the built output: **every
`<script>` tag carries the nonce, zero do not, and the nonce differs per
request.**

`style-src` needs no `'unsafe-inline'` either — `next/font` self-hosts its
webfonts into `/_next/static` at build time, so the page has no inline
`<style>` block and makes no request to `fonts.googleapis.com`. The inline
`style=""` attributes that do exist are handled by a separate
`style-src-attr`.

```
default-src 'self'; script-src 'self' 'nonce-<per-request>' 'strict-dynamic';
style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self';
img-src 'self' data: blob:; connect-src 'self'; form-action 'self';
frame-ancestors 'none'; base-uri 'none'; object-src 'none';
worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests
```

### 3. Missing cross-origin isolation headers — *low, fixed*

COOP, COEP and CORP were absent. Now `same-origin`, `credentialless` and
`same-origin` respectively. COEP is `credentialless` rather than
`require-corp` deliberately — model files will be fetched from object storage
over signed URLs, and `require-corp` would demand CORP headers on every one.

### 4. Six dependency advisories — *high, fixed*

`postcss` (4 advisories, incl. two path-traversal CVSS 7.5), `sharp`
(libvips CVEs) and `deepmerge-ts` (stack exhaustion), reached through `next`
and `prisma`.

npm's suggested remedy was a Next.js major bump and a Prisma *downgrade*.
Neither was necessary: the top-level `postcss` was already patched and only
Next's pinned `8.4.31` was vulnerable, so `overrides` in `package.json` lift
all three without moving frameworks. Verified afterwards that the Prisma CLI,
the typecheck, the build and both test suites still pass.

### 5. 92 CVEs inside the `esbuild` binary — *not shipped, fixed anyway*

Grype found 2 critical and 46 high Go stdlib CVEs — all inside the prebuilt
`esbuild` binary pulled in by `tsx`. Confirmed **not** in the production
dependency tree (`npm ls esbuild --omit=dev` is empty) and not referenced in
`.next/server`, so it was never exposed. Bumping `tsx` cleared it regardless.

### 6. API routes redirected instead of answering — *low, fixed*

Middleware redirected any request without a session cookie to `/signin`,
including `POST /api/upload`. An unauthenticated API call therefore got a
**307 to an HTML page** rather than a 401 with a JSON body — an XHR upload
following that redirect would have reported a mystifying success instead of
an auth failure.

Middleware now redirects pages only and lets `/api/*` through, which means
every route handler owes its own check. `currentUser()` / `requireAdmin()` is
how, and probe `A01-anon-api` asserts that an unauthenticated upload comes
back 401.

Nothing was exposed by this — the request was still blocked — but the wrong
answer to the wrong audience is how auth bugs hide.

### 7. `*.tsbuildinfo` was not gitignored — *hygiene, fixed*

A build artifact would have been committed. Found indirectly: Semgrep's only
hit was a false positive *inside* that generated file.

## Findings correctly dismissed

- **Semgrep "Facebook OAuth detected"** in `tsconfig.tsbuildinfo` — a regex
  matching hex hashes in a TypeScript build cache. This app has no OAuth.
- **ZAP "Sensitive Information in URL"** — ZAP's own injected
  `?email=zaproxy@example.com`. The app never puts an address in a URL.
- **ZAP "Content-Type Header Missing"** — on 307 redirects, which have no body.
- **My own probe's stored-XSS check** reported a false positive: it matched
  `onerror=alert(1)` inside an already-escaped string. React escapes the name
  to `&lt;img …` in the DOM, and Next encodes the `<` as a `\u003c` escape in
  the RSC flight payload, so it cannot break out of the script tag. `<script>alert(2)</script>`
  appears zero times raw. The probe now asserts escaping positively.

## OWASP Top 10 (2021) verdicts

| | Category | Verdict |
| --- | --- | --- |
| **A01** | Broken Access Control | **Pass.** Client refused on the admin page (404, not 403 — a 403 confirms existence) and on all six admin-plugin endpoints (`list-users`, `set-role`, `create-user`, `impersonate-user`, `remove-user`, `list-user-sessions`). Role unchanged after escalation attempts; no back-door account. `storyScope` hides another client's story. A forged session cookie reaches nothing. The JSON API is probed as a second front door onto the same operations: a client is refused `advance`, `decline`, `flag` and `clear-flag` (403, and the ticket does not move); another client's ticket, thread and model are each 404 rather than 403; and the printer owner — the widest scope in the app — still cannot withdraw somebody else's request. The feature-request track ('frr') is the same authorisation model on its own tables: `featureScope` hides another client's request (404, not 403), `/frr/queue` is owner-only, and the owner cannot withdraw a request that is not theirs — all exercised by `verify:frr`. The later filter bars on `/frr` and the `/history` view of finished prints are scoped the same way: the filters are ANDed onto `featureScope`/`storyScope`, so they can only narrow a caller's own set, never widen it. |
| **A02** | Cryptographic Failures | **Pass.** Session cookie `HttpOnly`, `SameSite=Lax`, `Secure`, `__Secure-` prefixed. Invite tokens stored as SHA-256 only; set-password tokens hashed at rest (`verification.storeIdentifier: "hashed"`) — both verified against the live database. Passwords are stored as Better Auth's scrypt digest, asserted against the live `account` row rather than assumed. |
| **A03** | Injection | **Pass.** SQL metacharacters in the username field handled (Prisma parameterises); no 5xx, table intact. Stored XSS via display name escaped in both DOM and flight payload. Reflected XSS via `?error=` and via the invite-token path segment both escaped. CRLF in the email field does not reach the mailer. Uploads are validated against their bytes, not their filename — a PDF, an ELF binary and an HTML page renamed `.stl` are all refused, as is an STL that lies about its triangle count. |
| **A04** | Insecure Design | **Pass.** No public registration route: `/signup` and `/register` do not exist, and the sign-up endpoint that *does* exist — the one an invitation link posts to — answers 403 to anybody without a pending invite, leaving no row. Invite-only enforced in one hook across every auth method. Invites single-use, expiring, revocable, rotated on resend. Password guessing rate-limited and confirmed firing. |
| **A05** | Security Misconfiguration | **Pass, after fixes 2 and 3.** Full header set; `X-Powered-By` suppressed; `.env`, `.git/config`, `package.json` and the Prisma schema all unreachable; malformed input returns no stack trace. A write to the API carrying a foreign `Origin` is refused. Neither `/api/openapi.json` nor the console at `/docs` is served to a stranger, and the console loads no subresource from another origin — Swagger UI is vendored into `public/` at build time rather than pulled from a CDN, so the CSP needed no relaxation. |
| **A06** | Vulnerable Components | **Pass, after fixes 4 and 5.** Zero across three independent scanners. |
| **A07** | Auth Failures | **Pass, after fix 1.** Passwords: ≥10 characters, breach-checked against HIBP by k-anonymity, guessing capped at 10/min per IP. No user enumeration — a wrong password and an invented username give byte-identical responses, and an unknown username still pays for a hash so the wall clock does not answer either. Set-password links single-use, 30-minute TTL, hashed at rest, and they establish **no session**. Setting a password revokes the sessions the old one opened. Off-site and protocol-relative redirect targets refused, both via `?next=` and via the API's `callbackURL`. Sign-out kills the session server-side. A bearer token is the session token rather than a separate credential: an invented one grants nothing, and sign-out revokes the token at the same instant it revokes the cookie — probed, because a token that outlived sign-out would be a way back into an account whose owner believes they have left. See the section below. |
| **A08** | Integrity Failures | **Pass.** `role`, `initials` and `invitedById` cannot be set from the request body: declared `input: false`, and Better Auth refuses the whole sign-up with `FIELD_NOT_ALLOWED` rather than silently trimming it. A chosen `id` and a posted `emailVerified` reach the endpoint undeclared and are overruled server-side from the invite. Both halves probed. On upload, `uploaderId` comes from the session and a posted `status` is ignored, both probed. Storage keys are generated, never derived from the filename. Lockfile committed. |
| **A09** | Logging & Monitoring | **Pass.** An append-only `AuditEvent` table records invitations sent, resent, revoked, accepted and *rejected*; access revoked and restored; password resets requested and completed; sign-in and sign-out; story creation and refused uploads. The client address is recorded only from a header the deployment has explicitly named as trustworthy (`TRUST_PROXY_HEADERS`), and no address at all otherwise — a blank rather than a fiction. Rows are denormalised (`actorEmail`, `subject`) so the trail still reads correctly after the user or story it refers to is deleted, and a probe asserts no token or secret reaches `detail`. |
| **A10** | SSRF | **Pass (low exposure).** The app makes no outbound request from user input. A link-local `callbackURL` (`169.254.169.254`) is refused. |

## A07 with passwords in the picture

The previous version of this report leaned on a sentence that is no longer
true: *"No passwords exist to mishandle."* That was a real property and it is
worth being honest about giving it up, so here is what actually changed.

**What got worse.** There is now a secret people choose, which means there is
something to guess, something to reuse across sites, and something to phish.
None of those existed before. Specifically:

- **Online guessing** is a live attack surface where it was not. Mitigated by a
  10-character floor, a breach-corpus refusal, and a 10/min per-IP cap on
  `/sign-in/username` — probed by `A04-ratelimit`. Ten a minute against ten
  characters is not a threat; ten a minute against `hunter2` would be, which is
  why the breach check matters more than the rate limit does.
- **Reuse.** A password chosen here may already be a password somewhere else.
  The HIBP check catches the ones already published; it cannot catch a fresh
  reuse. The passkey nudge is the real answer, and it is why enrolment is
  pushed at three separate points.
- **Phishing.** A password can be typed into a fake page; a magic link could
  also be forwarded to one, so this is less of a regression than it looks, but
  it is not nothing. Passkeys are unphishable and remain one click away.
- **Storage.** There is now a credential at rest. scrypt, `N=16384, r=16, p=1,
  dkLen=64`, per-password salt, stored `salt:hash` — Better Auth's default via
  `node:crypto`. `A02-password-hash` asserts against the live row that what is
  stored is not the password.

**What got better.** Not a consolation prize — these are real:

- **Recovery no longer means impersonation.** The old "Lost access?" minted a
  link that signed its holder in *as* that person. The replacement mints a link
  that lets them *set a password*, which they then have to use. An admin who
  keeps the link is locking someone out, not quietly becoming them. `A07-reset-nosession`
  asserts the link establishes no session.
- **The mail server left the critical path.** Sign-in used to depend on message
  delivery. A mail outage is now a nuisance for invitations, not a lockout for
  the whole office — and a token that sits in an inbox indefinitely is a
  standing key that no longer exists.
- **The enumeration oracle got narrower.** The old form had to answer
  identically whether or not an address existed *and still send mail*, which
  made "did a message arrive" the oracle. Now a wrong password and an invented
  username produce byte-identical responses (`A07-enum`), and the unknown
  username still pays for a scrypt hash so the wall clock does not answer
  either (`A07-enum-timing`).
- **Session revocation on reset.** Setting a password kills every session the
  old one opened (`A07-reset-revokes`). The old model had no equivalent —
  a compromised account stayed compromised until someone deleted rows by hand.
- **One less piece of machinery.** The `AsyncLocalStorage` trick that redeemed
  a magic link in-process at invite acceptance is gone. It was sound but it
  existed only to paper over the absence of a password, and code that does not
  exist cannot be got wrong.

**Net.** A07 stays a pass, on a broader base of evidence: 11 probes where there
were 7, plus the registration, login, duplicate-username, breached-password,
rate-limit and full reset cycle checks in `verify:auth`.

### Reset tokens, and one deliberate deviation

Reset tokens live in `verification` under a **digest** of their identifier
(`verification.storeIdentifier: "hashed"`), so a database reader gets no link
they can paste into a URL — `A02-reset-hash` checks that against the live
table. They last 30 minutes and work once.

The deviation: Better Auth consumes the token *before* it hashes the new
password, so a password rejected by the breach check would spend the link on
its way out. `setPassword` puts the row back — same identifier, same original
expiry — when the failure happened after consumption. This extends nothing and
weakens nothing: whoever is retrying already held the token. It makes the link
spent when a password is actually set, which is what "single use" is for.
`verify:auth` asserts both halves: a refused password leaves the link working,
and a successful one kills it.

### The session window

The window used to be `expiresIn: 30 days` with `updateAge: 1 day`, and the
second number is what made the first one wrong. `expiresIn` is an **idle**
window, not an absolute one: Better Auth pushes `expiresAt` back out to
`now + expiresIn` whenever a session is used and the last push was more than
`updateAge` ago. So a session used once a month renewed itself forever. Thirty
days was the number in the config; *indefinitely* was the behaviour, on a
cookie written into the browser profile with `Max-Age=2592000`.

On the shared office desktop this app is built for, that is the wrong shape:
the threat is somebody sitting down after you, and against a captured cookie
the only thing that helps is how long it stays worth something.

It is now **twenty idle minutes**, sliding every minute
(`SESSION_IDLE_SECONDS` in [`src/lib/auth-rules.ts`](../src/lib/auth-rules.ts)).
Twenty minutes is only humane because passkeys are here — conditional UI signs
a returning holder back in with no click — and it does make the passkey nudge
load-bearing rather than decorative.

Three things were considered and deliberately **not** done:

- **A JWT session.** A JWT is a signed snapshot the server trusts without
  touching the database, which is exactly finding 1 above with a longer fuse:
  revocation — sign-out, access revoked, a password reset — would go back to
  lagging by the token's lifetime. The session token stays an opaque row.
- **Moving the token out of a cookie.** A cookie is the only credential a
  browser attaches to a top-level navigation, and this app is server-rendered:
  `requireUser` and `storyScope` run on the navigation itself. A token in
  `localStorage` would also trade `HttpOnly` away for nothing.
- **Forcing a non-persistent cookie** via `rememberMe: false`. At `Max-Age=1200`
  the cookie no longer outlives the browser in any way that matters, and Better
  Auth reads that flag as a *fixed* 24-hour session with the sliding refresh
  switched off — strictly worse than what it would buy.

#### One thing this broke, and how it was caught

Better Auth slides a session in two places at once, and only one of them
survives a React Server Component render. The database row is pushed out
normally; the **cookie is not**, because Next forbids writing a cookie during a
render. Measured rather than reasoned about: before the fix, `GET /board`
returned no `Set-Cookie` at all where `GET /api/stories` returned
`Max-Age=1200`.

At thirty days nobody would ever have noticed. At twenty minutes it signs
people out mid-task with a live session behind them — the kind of failure that
gets "fixed" by asking for the window to be made long again.
[`src/middleware.ts`](../src/middleware.ts) now re-stamps the cookie on page
navigations (and only there — `/api/*` responses set it themselves, and
re-stamping there would resurrect the cookie `/api/auth/sign-out` had just
deleted). This is safe because the cookie is not the authority: it carries a
token whose validity is the `session` row, so keeping the browser's copy longer
cannot extend a session by a second. The invariant it buys is that the cookie
never dies before the row it names.

Three probes hold all of this: `A07-session-window` (the row spans twenty
minutes), `A07-session-cookie-maxage` (the cookie expires with it) and
`A07-session-slides` (a page render pushes the cookie out too).

#### Re-authentication, for what outlives a session

Shortening the window limits how long a captured cookie is worth something. It
does not stop it being worth something *now*, and some of what an admin can do
outlives any session: an invitation mints a whole new account, a reset link is
the ability to become somebody else, and revoking access locks a colleague out.

Those four actions — `sendInvite`, `resendInvite`, `resetPassword`,
`setMemberAccess` — now require a sign-in from the last five minutes
(`FRESH_AUTH_SECONDS`), and send the caller to `/reauth` when it is older. It
is the one control on the list a copied cookie cannot satisfy: the thief has
the session, not the passkey and not the password.

`revokeInvite` is deliberately **not** gated — withdrawing an unaccepted invite
only ever removes reach — and neither is `/admin/benefits`, which decides what
tips the upload form offers and grants nobody anything.

Two implementation notes, both of which look odd on purpose:

- **Freshness is the age of the session itself**, not a separate marker. Better
  Auth 1.7.1 has no "prove it is you" primitive: `/passkey/verify-authentication`
  and `/sign-in/username` both mint a *new* session rather than annotating the
  one you hold. So re-authenticating means signing in again, and a session
  created moments ago is the evidence. A normal sign-in is therefore fresh for
  its first five minutes, which is correct — somebody who just typed their
  password should not be asked for it twice.
- **The cost is one superseded session row per re-auth.** That would have been
  a poor trade when a row lived thirty days; at twenty idle minutes the orphan
  is gone before anyone would notice, which is what makes this cheaper than
  hand-rolling WebAuthn verification against the `passkey` table in app code.

`/reauth` offers the passkey *and* the password. Gating on a passkey alone
would leave an admin who has not enrolled one unable to revoke access — a
lockout on the most safety-critical control in the app.

Three probes: `A07-reauth-stale` (a session backdated an hour cannot create an
invitation), `A07-reauth-redirect` (it is sent to `/reauth` instead) and
`A07-reauth-fresh` (a sign-in from moments ago still can). The first and third
drive the *same* form submission and differ only in the age of the session, so
the pair fails if the gate stops discriminating in either direction.

#### The slicer link credential, and the token it replaced

Shortening the session broke "Open in PrusaSlicer", and the way it broke is
worth recording because the feature had been quietly depending on the weakness.

The helper runs on somebody's own machine and holds no cookie, so it
authenticated with `PPP_TOKEN` — a bearer token pasted once into
`~/.config/ppp/slicer.conf`. A bearer token is the session token, so that file
held a **thirty-day, full-authority credential at rest**, revocable only by
signing out. At twenty idle minutes it simply stopped working: every click
answered `HTTP 401`.

The fix is not a longer-lived credential in the same place. The link carries
its own instead — `ppp://slice/<id>?t=…`, minted when the ticket renders, for
that person and that model, expiring in half an hour
(`src/lib/slicer-token.ts`). `PPP_TOKEN` is gone from the installer's template
and the config now holds nothing but an address.

What the token is, precisely: an HMAC over `version.storyId.userId.expiry`,
keyed on `BETTER_AUTH_SECRET`. It asserts an **identity and a subject, never an
authorisation** — the route loads the account, refuses a suspended one, and
re-applies `storyScope` against the database exactly as it does for a session.
So a link cannot outlive the access it was minted under, and cannot be edited
to fetch a different model.

Stateless on purpose, and the cost is stated rather than hidden: an outstanding
link is **not** revoked by signing out, because nothing is stored to revoke. It
is revoked by suspending the account, by the scope check, and by half an hour
passing. The alternative writes a `verification` row on every render of every
ticket to be read at most once. For read access to one model the holder could
already open, this is the right side of the trade — it would not be for
anything that writes.

Net against what it replaced: a thirty-day credential for the whole account, in
a file, became a thirty-minute credential for one model, in a URL. Six probes
hold it — that a ticket carries one at all, that an anonymous fetch is still
401, that a minted one works, that it cannot be pointed at another model, and
that a tampered or malformed one is refused. The binding probe aims the token at
a story the printer owner *can* read by session, so it fails if the binding ever
stops being enforced independently of scope.

### Residual risk accepted

- **A trusted-proxy misconfiguration is silent.** `TRUST_PROXY_HEADERS` now
  names which header to believe (`false` / `true` / `cloudflare`) rather than
  being a boolean, because the right answer depends on what is in front of the
  app and the wrong answer does not fail loudly — it fills the audit trail
  with client-chosen addresses. The modes never fall back to one another, and
  the default trusts nothing. What remains is that nothing *verifies* the
  claim: set `cloudflare` on an origin that is reachable directly and anyone
  can send `CF-Connecting-IP` themselves. Checking the peer against
  Cloudflare's published ranges would close that; the compose overlays close it
  instead by keeping the app off every host port.

- **The breach check is an outbound dependency.** It fails closed, so if
  `api.pwnedpasswords.com` is unreachable, nobody can *set* a password —
  registration and reset stop, sign-in does not. `HIBP_DISABLED=true` exists
  for an air-gapped deployment and is off by default. This is a deliberate
  availability-for-integrity trade at this size; a cached local corpus would be
  the answer if it ever bit.
- **No second factor.** A password plus an optional passkey is the whole set.
  Re-authentication on the access-moving actions (above) covers the case a
  second factor would matter most for here — a captured session being used to
  hand out access — but it is a sudo gate, not a second factor: it asks for the
  same credential again rather than a different kind. TOTP would be the next
  thing to add if this were ever exposed beyond an office, and Better Auth's
  `twoFactor` plugin is the path.
- **No password-change screen for a signed-in user.** Today changing a password
  means asking the admin for a reset link. That is a gap in convenience rather
  than in security, and `/api/auth/change-password` is already served by the
  catch-all if it is ever wired to a form.

## Closed since the first pass

- **A09** now has an audit trail (`src/lib/audit.ts`) *and* a place to read it:
  `/admin/audit`, admin-only, with a count of refusals in the last day called
  out at the top. A page a human glances at was chosen over threshold alerts
  on the grounds that one printer and five colleagues do not generate enough
  traffic to tune a threshold against — and an untuned alert is one people
  learn to ignore. Two probes assert a client gets 404 there and that no audit
  rows leak.
- **The WebAuthn ceremonies are verified.** `npm run verify:passkey` drives a
  real Chromium with a CDP virtual authenticator: it signs in with a username
  and a password, registers a passkey, confirms the credential persists with a
  public key and no private material, signs out, and signs back in. Conditional
  UI signs the returning user in with no click at all, which is the intended
  experience. Passwords and passkeys are verified working side by side, which
  is the whole point of keeping both.
- **Recovery stopped being impersonation.** `access.reissued` — a link that
  signed its holder in as somebody else — is gone, replaced by
  `password.reset_requested` / `password.reset_completed` and a link that sets
  a password and nothing more.

## Restore, exercised

The backup and restore procedure used to be documented from reasoning. It has
now been executed against a running stack: both paths taken, the data destroyed
in between, and the result compared row for row.

- **File-level restore** — stack down, data directory deleted outright,
  archive extracted, stack up. Users, stories, comments, invitations and the
  audit trail all returned identical, including a canary story and its comment
  planted specifically to detect a partial restore.
- **Logical restore** — a row deleted, then `pg_restore --clean --if-exists`
  from a `pg_dump`, which brought it back with exit 0 and no errors.
- **`DB_PASSWORD` mismatch** — confirmed to refuse rather than damage. The
  documentation now names where the error actually surfaces, because the
  obvious places are all silent: the database reports healthy, the app never
  starts so logs nothing, and the only message is `P1000` in the migrator.
- **`BETTER_AUTH_SECRET` loss** — confirmed to cost exactly one sign-in. A
  held session cookie went from 200 to a 307 at the sign-in page, and signing
  in again worked immediately.

One finding worth the exercise on its own: the Postgres data directory is mode
`700` owned by uid `70`, so a file-level backup taken as an ordinary user
cannot read it, and one taken with `sudo` that flattens ownership produces an
archive Postgres refuses to start from. On ZFS a snapshot sidesteps this
entirely; elsewhere the copy has to be made from inside a container, which the
README now says.

## Open items

- **Nothing alerts automatically.** `/admin/audit` surfaces refusals but
  someone has to look. That is a deliberate choice at this size, not an
  oversight — revisit if the group grows or the app is ever exposed beyond
  the office.
- **No authenticated active scan.** ZAP ran a passive baseline against the
  unauthenticated surface. The authenticated surface is covered by the 91
  custom probes instead, which is better for authorisation logic and worse for
  generic injection classes. Once the board and upload screens land, an
  authenticated ZAP active scan is worth configuring.
- **CSP verified against served markup, not a live browser** — except at
  `/docs`, which was. Building the API console forced the issue: its stylesheet
  had to move out of an inline `<style>` block and into a file, because
  `style-src 'self'` drops the block and the page renders *unstyled* rather
  than failing. That is the failure mode this item is about — a policy
  violation that looks like a design bug. The rest of the app still deserves
  the same browser check.
- **Signed model URLs are minted but nothing serves them yet.**
  `signedModelUrl` exists with a 10-minute expiry and the ownership check
  gates it, but the download route lands with the 3D viewer. When it does,
  `connect-src` has to widen to the storage origin — it is `'self'` today,
  which will block the fetch.
- **The upload buffers the whole file in memory**, and now at a 250 MB cap
  rather than 50 MB. The buffering is not the validator's doing —
  `request.formData()` has already read the whole body before the route handler
  runs — so peak memory is set by how many large uploads overlap. Of the two
  answers named here originally, the **size-based queue** is now in place: at
  most two uploads are handled at once, a third waits, and only a long queue is
  refused. That bounds the exposure at roughly two concurrent uploads' worth
  rather than however many arrive together. The streaming parse remains
  unbuilt, and cannot be built without changing how the file arrives — see
  [architecture](architecture.md#why-the-memory-is-bounded-by-a-queue-rather-than-a-stream).

  Raising the cap also uncovered that the old one was never enforced as
  advertised: Next truncates a request body at 10 MB when middleware is
  present, so uploads between 10 and 50 MB had been failing with a parse error
  dressed as a network fault. `verify:upload` now sends a 12 MB model on every
  run.
- ~~Print-time estimates~~ — removed rather than kept. The app now shows only
  what it measured. See the README for the reasoning and the path to a real
  slicer-derived figure.
- **CSRF rests on Origin checking plus `SameSite=Lax`**, which is Better
  Auth's model and is sound for this threat profile. There are no
  per-form tokens; if the app ever needs to accept cross-site POSTs, that
  changes. The JSON API keeps to the same model: a write arriving with an
  `Origin` naming somewhere else is refused, while one with no `Origin` at all
  is allowed — that is `curl`, not a browser being driven by somebody else's
  page. A bearer token cannot be attached cross-origin at all, because the app
  serves no CORS headers and the preflight fails.
- **A bearer token is a credential in a shell history.** It carries the full
  authority of the account and — unlike the cookie — is neither `HttpOnly` nor
  `SameSite`-protected. It is revocable by signing out, by an admin revoking
  access and by a password reset, and since the session window came down to
  twenty idle minutes it also simply stops working shortly after the job that
  used it finishes. There is still no scoped or read-only variant, and adding
  one would mean a credential store this app does not otherwise need.
  [`docs/api.md`](api.md) says to sign in fresh for a script rather than
  reusing the browser's token — which is now the only thing that works for
  anything long-running.
- **No second factor, and no self-service password change.** Both are in
  [Residual risk accepted](#residual-risk-accepted) above with the reasoning.

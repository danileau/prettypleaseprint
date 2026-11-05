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
npm run probe:security                     # DAST, app-specific (122 probes)
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
`require-corp` deliberately. The reasons given at the time — signed storage
URLs and a third-party font host — have both since gone: models are streamed by
the app and the fonts are vendored. `require-corp` is now reachable and is left
for a change of its own; `next.config.ts` says why.

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

### 8. Open redirect via a backslash — *moderate, fixed*

`safeNext` on the sign-in and re-auth pages, and the `from` guards in the two
server-action helpers, all asked the same question the same way:

```ts
raw.startsWith("/") && !raw.startsWith("//")
```

`/\evil.example` answers yes to both halves. The WHATWG URL parser treats `\`
as `/` in the relative-slash state, so the browser resolved it to
`https://evil.example/`; `/\/` and `/\\` did the same. The value was handed to
`window.location.assign` after a **successful** sign-in, so the victim
authenticated on the real origin, with the real passkey, and was then delivered
to a lookalike — which is the whole shape of the attack the code comment already
warned about.

`/reauth` was the worse of the two. That page exists to be the "confirm it's
you" moment before access changes hands, so it is the page a person is least
likely to re-read the address bar on.

The fix is one helper, `src/lib/safe-redirect.ts`, used by all four call sites.
It resolves the target against an origin that cannot exist and keeps it only if
it stayed there. The point is not that backslashes are now also rejected — it is
that prefix matching cannot answer the question, because the question is what a
URL parser will do, so the check asks one.

Caught by review, not by the suite: `A07-protorel` tested `//evil.example`
only, and the bug sat directly behind the one case a person thinks of.
`A07-offsite-signin` and `A07-offsite-reauth` now assert the parser's five
spellings against both pages.

### 9. The admin plugin's HTTP surface was open — *moderate, fixed*

`admin()` is enabled in `src/lib/auth.ts` for what it adds to the schema and to
sign-in — the `role` and `banned` fields, and the refusal to create a session for
a suspended account. It also mounts a dozen endpoints under
`/api/auth/admin/`, and this app uses none of them: every admin screen goes
through Prisma directly, and `authClient.admin` is never called from the browser.

Measured with an admin session before closing them, which is worth recording
because the first assessment of this was wrong. Most of the surface already
refused: `set-user-password`, `remove-user`, `ban-user`, `update-user`,
`list-user-sessions` and `revoke-user-sessions` all answered **403** from Better
Auth's own permission statements, and `create-user` answered 403 from this app's
invite hook — confirming the invite gate holds even against the plugin's own
back door. Two did not:

| endpoint | with an admin cookie |
| --- | --- |
| `impersonate-user` | **200**, with a session token for another account |
| `list-users` | **200**, with every account's name, e-mail and verified flag |

`set-role` answered 500, which is an unhandled path rather than a refusal.

The impersonation is not theoretical. The probe that called it had its own
browser become the impersonated user, and the next check found `/admin/invites`
rendering an error page because the caller was no longer an admin. This is the
primitive that recovery deliberately stopped using — the "Closed since the first
pass" section below says `access.reissued` "is gone", and the capability was
still mounted.

Closed as a whole prefix rather than as two paths, because the 403s are not this
app's doing. They come from the plugin's default permission statements, so they
can widen on a version bump with nothing in this repository changing — and a new
endpoint in a future release is then closed by default instead of newly exposed.
404, not 403, so the paths do not confirm their own existence.

Twenty probes assert it, for an admin as well as a client. The previous probes
here asserted 401/403 for a client only, and had to be changed by this fix, which
is the honest signal that behaviour changed rather than an assertion being
widened to fit.

### 10. An invited address could be registered without its link — *high, fixed*

The invite gate asked one question: is there a pending invitation for this
address. Better Auth's `POST /api/auth/sign-up/email` is reachable by anyone,
and the invite page was only ever one caller of it. So for the seven days an
invitation was open, anybody who knew or guessed the invited address could post
it to that endpoint with a password of their own and receive the account and a
session. The token in the link — the only thing that proves the mailbox —
took no part. `emailVerified` was then stamped true "by construction".

What it gave: a client account under somebody else's address, and the real
invitee locked out of an invitation already marked accepted. Not the admin
role; invitations are client-role and the single-admin index holds regardless.

Found by reading the gate while planning single sign-on, which would have
leaned on the same address-only rule, and confirmed against a running instance
before anything was changed: a control address with no invitation got 403, an
invited one got a session.

It survived because the suites encoded it. `verify:auth` registered "Bob" by
posting his invited address straight to the endpoint to prove that privileged
fields are stamped from the invite, and `probe:security` did the same for
`A08-massassign`. Both passed, and both were demonstrations of the hole. The
only gate probe, `A04-invitegate`, used an address with no invitation at all.

Fixed in the gate rather than by hiding the route. An account is opened only
by a request that is redeeming a checked invite link: `acceptInvite` verifies
the token and runs the sign-up inside `claimingInvite`, and the gate refuses
anything outside it. Closing the route in middleware would also have worked,
and would have lost two things — the refusal in the audit trail, which is how
somebody trying invited addresses becomes visible, and the rule living in the
one hook every method goes through. Both refusals answer identically, so the
endpoint is not a way to ask who has been invited.

Probed as `A04-invitelink` and `A04-inviteoracle`, and in `verify:auth`
section 2b.

## Findings correctly dismissed

- **Semgrep "Facebook OAuth detected"** in `tsconfig.tsbuildinfo` — a regex
  matching hex hashes in a TypeScript build cache. This app had no OAuth at
  the time; the single sign-on it has since gained is OpenID Connect against
  a provider the host names, and is covered [below](#single-sign-on).
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
| **A04** | Insecure Design | **Pass.** No public registration route: `/signup` and `/register` do not exist, and the sign-up endpoint that *does* exist — the one an invitation link posts to — answers 403 to anybody without a pending invite, and to anybody with one who is not redeeming its link (finding 10), leaving no row. Invite-only enforced in one hook across every auth method. Invites single-use, expiring, revocable, rotated on resend. Password guessing rate-limited and confirmed firing. |
| **A05** | Security Misconfiguration | **Pass, after fixes 2 and 3.** Full header set; `X-Powered-By` suppressed; `.env`, `.git/config`, `package.json` and the Prisma schema all unreachable; malformed input returns no stack trace. A write to the API carrying a foreign `Origin` is refused. Neither `/api/openapi.json` nor the console at `/docs` is served to a stranger, and the console loads no subresource from another origin — Swagger UI is vendored into `public/` at build time rather than pulled from a CDN, so the CSP needed no relaxation. |
| **A06** | Vulnerable Components | **Pass, after fixes 4 and 5.** Zero across three independent scanners. |
| **A07** | Auth Failures | **Pass, after fix 1.** Passwords: ≥10 characters, breach-checked against HIBP by k-anonymity, guessing capped at 10/min per IP. No user enumeration — a wrong password and an invented username give byte-identical responses, and an unknown username still pays for a hash so the wall clock does not answer either. Set-password links single-use, 30-minute TTL, hashed at rest, and they establish **no session**. Setting a password revokes the sessions the old one opened. Off-site redirect targets refused, both via `?next=` and via the API's `callbackURL` — decided by resolving the target against a sentinel origin rather than by matching its prefix, because `/\evil.example` passes “starts with / and not //” and then resolves off-site. That is fix 8 below. Sign-out kills the session server-side. A bearer token is the session token rather than a separate credential: an invented one grants nothing, and sign-out revokes the token at the same instant it revokes the cookie — probed, because a token that outlived sign-out would be a way back into an account whose owner believes they have left. See the section below. |
| **A08** | Integrity Failures | **Pass.** `role`, `initials` and `invitedById` cannot be set from the request body: declared `input: false`, and Better Auth refuses the whole sign-up with `FIELD_NOT_ALLOWED` rather than silently trimming it. A chosen `id` and a posted `emailVerified` reach the endpoint undeclared and are overruled server-side from the invite. Both halves probed. On upload, `uploaderId` comes from the session and a posted `status` is ignored, both probed. Storage keys are generated, never derived from the filename. Lockfile committed. |
| **A09** | Logging & Monitoring | **Pass.** An append-only `AuditEvent` table records invitations sent, resent, revoked, accepted and *rejected*; access revoked and restored; password resets requested and completed; sign-in and sign-out; story creation and refused uploads. The client address is recorded only from a header the deployment has explicitly named as trustworthy (`TRUST_PROXY_HEADERS`), and no address at all otherwise — a blank rather than a fiction. Rows are denormalised (`actorEmail`, `subject`) so the trail still reads correctly after the user or story it refers to is deleted, and a probe asserts no token or secret reaches `detail`. |
| **A10** | SSRF | **Pass.** A link-local `callbackURL` (`169.254.169.254`) is refused. One feature makes an outbound request because a requester asked — importing a model from a link, off by default — and the requester never chooses its address: see [Importing from a link](#importing-from-a-link). |

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
only ever removes reach — and neither are `/admin/benefits` and
`/admin/catalog`, which decide what tips, materials and colours the upload form
offers and grant nobody anything.

Two implementation notes, both of which look odd on purpose:

- **Freshness is the age of the session itself**, not a separate marker. Better
  Auth has no way to mark the session you hold as re-proven (true at 1.7.1 when
  this was built, and still at 1.7.7): `/passkey/verify-authentication` and
  `/sign-in/username` both mint a *new* session rather than annotating the one
  you hold. A server-side `verifyPassword` exists, but it only answers yes or
  no, has no passkey counterpart, and leaves nothing on the session. So re-authenticating means signing in again, and a session
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

#### The helper off Linux

Since v0.4.0 the helper also runs on Windows, through
`install-slicer-handler.ps1`, and reports failures on screen on macOS and
Windows. Both add a place where text from a web page meets an interpreter, and
both are handled the same way: as data, never as code.

- **The clicked link.** Any page can write a `ppp://` link, so the helper's
  first argument is hostile until proven otherwise. The Windows handler is
  registered under `HKCU` (per user, no admin rights) as
  `mintty -w hide -e /usr/bin/bash -l <helper> "%1"`. The link is the last
  argument and is quoted; even one that escaped its quotes would only become
  more arguments to the helper, never options to `mintty` or `bash`. The helper
  then accepts a numeric id and a token from a fixed character set and nothing
  else, as it does on Linux.
- **The failure message.** It can quote that link. `osascript` receives it as
  an argument to a fixed script (`on run argv`), and PowerShell reads it from
  an environment variable inside a fixed command string, so the message is
  never part of the code either one parses.

Neither path is covered by CI, which has no macOS or PowerShell: the helper's
own test (`scripts/tests/prusa-open.test.sh`) stubs both, and the installer was
reviewed line by line and tried by hand on Windows 11.

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

## Single sign-on

Added after the audit above: an optional second way in, through an OpenID
Connect provider, off unless `AUTH_METHODS` names it. It makes a second party
able to say who somebody is, so what was checked is what the app does when that
party is wrong. Every row is asserted by `npm run verify:sso` against a
stand-in provider, except where the row says otherwise; the starred rows are
guards this app adds itself. Seven guards of the first version — the strict
`email_verified` mapping, the gate's verified-address check, the invitation
requirement, the refusal to link on an unverified address, nonce binding,
token stripping and the closed `/link-social` — were each removed in turn and
watched failing before the checks were believed. The fixes from the two
reviews, [below](#what-the-two-reviews-found), each name the check that holds
them.

| The risk | What stops it |
| --- | --- |
| A forged or misdirected ID token | Verified against the provider's published keys, with issuer, audience, expiry and a per-request nonce — and `requireIdTokenVerification` makes that a condition of the provider being registered at all. A wrong signature, issuer, audience or nonce, or an expired token, signs nobody in. ★ (nonce) |
| A genuine ID token replayed on its own | Better Auth's `/sign-in/social` will sign somebody in on a posted ID token with no state, no PKCE and the nonce optional, looking up userinfo with a caller-supplied access token. That branch is refused for every provider (404); only the redirect flow, where the nonce is bound, signs anybody in. ★ |
| The discovery document names another issuer, or sends keys or tokens over plain HTTP | Its `issuer` must be `OIDC_ISSUER`, every endpoint must be `https://` when the issuer is, and it is re-read and re-checked each time a sign-in starts. The ID token's `iss` is held to `OIDC_ISSUER` too, not to whatever the document said. ★ |
| Userinfo answers for somebody else | When the ID token carries no address and userinfo is asked, userinfo's `sub` must be the token's. ★ |
| A new provider's subjects overlap the old one's | Identities are filed under issuer and subject together, so a subject at a different issuer opens nothing. ★ |
| "Confirm it is you" is a click on a provider session left open | The re-authentication asks for `prompt=login` and `max_age=0` and is refused unless the ID token says the person authenticated under two minutes before it was issued (`iat − auth_time`, both on the provider's clock, with `iat` within ten minutes of this server's) — or does not say. A session opened through the provider dates from its `auth_time`, so an ordinary sign-in on an old provider session is not fresh either. ★ |
| The provider vouches for a stranger | A pending invitation is still required unless the host set `OIDC_SIGNUP=open`. ★ |
| An address the provider has not verified opens an account | `email_verified` must be the boolean `true` — not the string, not absent — both where the profile is mapped and again in the gate. ★ ★ |
| …or takes over an existing account | Linking requires the same claim; the provider is deliberately not a "trusted provider", which would link on its say-so alone. ★ |
| …or takes over the printer owner's | The owner is never linked implicitly, verified address or not; the answer is a stranger's, word for word. The owner connects the provider from `/me`: only the owner, only on a session under five minutes old, only to their own verified address, and only to the account signed in in the browser the flow returns to. ★ ★ |
| The refusal says who is a member | Better Auth answers an unverified address with `account_not_linked` when somebody has it and `email_not_verified` when nobody does. The browser is told the second in both cases, and the page says the same sentence for either. ★ |
| The provider's picture is fetched by every browser | `picture` never reaches `image`. ★ |
| A claim makes somebody the owner | No claim reaches `role`. Asserted with `role`, `groups` and `is_admin` all sent. |
| A replayed or borrowed callback | State is bound to the browser that started the flow and the code is single-use: a second browser, a second use and an invented state are all refused. |
| The flow is used as an open redirect | A `callbackURL` on another origin is refused before the provider is contacted. |
| Somebody at the owner's open browser removes their single sign-on | Better Auth's `/unlink-account` is closed in every mode. Disconnecting is on `/me`: a fresh sign-in, refused with passwords off, and on the trail. ★ |
| Provider tokens arrive on a re-link | Re-linking a connected owner is refused, and an account update hook strips tokens as the create hook does. ★ |
| A signed-in person attaches an arbitrary identity | `/link-social` answers the owner alone, on a fresh session, for an identity with the owner's own verified address; a member gets 403, and it is closed where single sign-on is off. ★ |
| Provider tokens leak from the database | None are stored. ★ |
| A method that is "off" is only hidden | Its endpoints answer 404 — checked by hand in single-sign-on-only mode, and by a pure check of the list in every mode. Called in process, the same endpoints are refused by a hook, and the server actions that take a password refuse before writing — driven in a child process with `AUTH_METHODS=oidc`. ★ |
| A suspended account comes back through the provider | Refused; no session is created. |

### What the two reviews found

Single sign-on was reviewed twice before it merged: once as written, and again
after the first round of fixes and the decision about the printer owner. Each
finding below says what an attacker could have done, how it was closed, and
which section of `verify:sso` holds it closed. Severity is for this app as
deployed — an office, one printer owner, a provider the host runs.

#### S1. A posted ID token signed somebody in — *high, fixed*

Better Auth's `/sign-in/social` has a second branch besides the redirect flow:
post an ID token and be signed in on it. There is no state and no PKCE, the
nonce is checked only if the caller offers one, and when the token carries no
address the userinfo lookup uses whatever access token the caller sends with
it. Anybody who ever held an ID token this provider issued for this client —
from a log, a proxy, a browser extension — could replay it and be signed in as that person for as long as it was unexpired,
without going near the provider. `/link-social` has the same branch for
attaching an identity.

Closed in `hooks.before`: a request to either endpoint carrying `idToken` is
answered 404, for every provider. The redirect flow, where state, PKCE and the
nonce are all bound to the browser that started it, is the only way in.
*verify:sso: "an ID token on its own signs nobody in".*

#### S2. Re-authentication through the provider was a click — *high, fixed*

`/reauth` stands between a captured session and the actions that hand out
access: inviting, minting a reset link, revoking. Through the provider it
asked for nothing — the provider answered from the session it already held, so
anybody at a browser left signed in to the provider passed it with one click.
Worse, *any* sign-in through the provider produced a brand-new session, which
`/reauth` reads as fresh, so signing in again was a way round the question
altogether.

Closed in two halves. Confirming through the provider is marked as a
re-authentication in the flow's server-side state, and the server — not the
page — sends `prompt=login` and `max_age=0`; the answer is refused unless its
ID token says the person authenticated no more than 120 seconds before it was
issued. And every session opened through the provider is dated from that
`auth_time` rather than from when the row was written, so a provider waving
through an hour-old session produces an hour-old session here.
*verify:sso: "confirming it is still you means signing in again", and the pure
checks under "an identity is filed under its issuer, and dated by it".*

#### S3. Passwords could still be set with passwords off — *moderate, fixed*

`AUTH_METHODS=oidc` closed the password endpoints with Better Auth's
`disabledPaths` — which the library enforces for HTTP requests only. The
app's own server actions call the same endpoints in process. Accepting an
invitation with a password, setting one from a reset link, and the owner
minting a reset link all still worked, so an invitation could be redeemed with
a password on an instance that had none, and the password would come back to
life the day `local` was switched on again.

Closed in three places: the first rule in `hooks.before` refuses a disabled
path however it is called; the three server actions refuse before writing
anything (not even the name chosen on the form); and `issuePasswordSetupUrl`
throws rather than mint a link.
*verify:sso: "with passwords off, the server refuses them too", driven by
`scripts/passwords-off-probe.ts` in a child process with `AUTH_METHODS=oidc`.*

#### S4. Identities were keyed on the subject alone — *moderate, fixed*

A link was filed under the provider's `sub` only. A subject is unique only at
its issuer, and many providers use small integers or usernames. Point
`OIDC_ISSUER` at a different provider — a migration, a second realm — and
whoever held subject `42` there landed in the account linked to subject `42` at
the old one.

Closed by filing identities as `<issuer>|<sub>`, the issuer spelt one way
(`ssoAccountId`, `normalIssuer`). A subject at another issuer opens nothing.
*verify:sso: "a different provider is not the old one", and the pure checks
under "an identity is filed under its issuer, and dated by it".*

#### S5. The error code said who is a member — *low, fixed*

For an address the provider has not verified, Better Auth answers
`account_not_linked` when somebody here has that address and
`email_not_verified` when nobody does. Anybody who could get an unverified
address through a provider — their own, at a provider that lets them set it —
could ask whether a given person is a member.

Closed in two places: the sign-in page maps both codes to the same sentence,
and the auth route rewrites the first into the second (`sameAnswerForUnverified`).
*verify:sso: "the answer is the very one an address nobody here has gets",
under "somebody with a password signs in through the provider".*

#### S6. …and so did the error description — *low, fixed*

After S5, the redirect still differed: only the app's own refusal carried an
`error_description`, so the URL alone told the two cases apart even though the
page said the same thing. The rewrite now drops the description too, and the
browser is sent to the same URL, character for character, either way.
*verify:sso: the same check, which compares the two redirect URLs whole.*

#### S7. The provider chose a picture for every browser to fetch — *low, fixed*

The plugin copies the provider's `picture` claim into `user.image`: a URL of
the provider's choosing — or of whoever can set a profile picture there —
stored for any page that ever renders it, and fetched by every browser that
does. A tracking pixel at best.

Closed in `mapProfileToUser`: `image` is always unset. Nothing reaches a user
row from the provider but the address, its verification and, for a new
account, a name. *verify:sso: "the provider's picture is not kept".*

#### S8. The discovery document was taken as found — *moderate, fixed*

The plugin trusted whatever discovery document the issuer URL served: an
`issuer` naming somebody else, keys or a token endpoint over plain HTTP behind
an `https://` issuer. The ID token was then checked against whatever issuer the
document named. And when the token carried no address, the plugin merged
whatever userinfo said for the access token, without asking whether it was
about the same subject.

Closed in `src/lib/oidc-flow.ts`: the document must name `OIDC_ISSUER`, name
the authorization and token endpoints and the keys, and with an `https://`
issuer have only `https://` endpoints; it is fetched and checked again each
time a sign-in starts, and a sign-in does not start while it fails. The ID
token's `iss` is held to `OIDC_ISSUER` itself, and userinfo's `sub` to the
token's.
*verify:sso: "a discovery document is believed only if it adds up" (pure), "a
discovery document that lies is not believed", "userinfo is about the same
person as the token".*

#### S9. A provider could make itself the printer owner — *high, fixed*

As first written, the owner's account was linked like any member's: the first
sign-in through the provider with the owner's verified address opened it. That
was a deliberate choice, and the first review put the consequence plainly —
whoever can get the provider to assert the owner's address with
`email_verified: true` (an administrator there, a self-service profile, a
compromised provider account) becomes the owner here, with no action by the
owner and nothing to see until the trail is read.

Reversed by the owner. `validateUserInfo` refuses an implicit link to the
`admin` account, with the answer a stranger gets and an
`auth.sso_link_refused` row. The owner connects the provider deliberately from
`/me`: a fresh sign-in, a fresh login at the provider, an identity with the
owner's own verified address, attached only to the account signed in in the
browser that comes back. `/link-social` answers nobody else.
*verify:sso: "the printer owner is never linked implicitly", "the owner
connects the provider on purpose, from /me", and "a signed-in member cannot
attach an identity on request".*

#### S10. `/unlink-account` was open — *moderate, fixed*

Better Auth's own unlinking asks only for a session under a day old
(`freshAge`) and that one account remain. Anybody at the owner's open browser
could remove their single sign-on: no step-up, no row on the trail, and in
`oidc`-only mode no way back in for the owner.

Closed in every mode, through `disabledAuthPaths`. Disconnecting is the server
action on `/me`, which asks for a fresh sign-in, refuses where passwords are
off, and records `auth.sso_unlinked`.
*verify:sso: "Better Auth's own unlinking is closed in every mode" (pure),
"Better Auth's own unlinking answers 404, and the link stays", and "the owner
can disconnect the provider again".*

#### S11. Changing the issuer stranded the owner, silently — *moderate, fixed*

With identities keyed on the issuer (S4), an owner connected to the old
provider is not connected to a new one. But `/me`, the guest-list warning, the
start-up warning and the seed all counted *any* link, so after `OIDC_ISSUER`
changed they said the owner was connected when nothing would let them in — and
in `oidc`-only mode the first sign of it was a locked door. `/reauth`, for its
part, offered the provider to an owner it would then refuse.

Closed by counting only links filed under the issuer configured now
(`currentIssuerAccounts`) in every one of those places, `/reauth` included,
and by documenting the order for changing the issuer.
*verify:sso: "a link to a provider this instance no longer uses does not count
as connected". The seed's copy of the rule is not covered — see below.*

#### S12. `auth_time` was measured on this server's clock — *low, fixed*

S2's first form compared `auth_time` with this server's clock. A provider
whose clock ran a few minutes ahead could make a login several minutes old look
fresh; one running behind failed honest re-authentications.

Closed by measuring the age as `iat − auth_time`, both on the provider's
clock, and holding only `iat` to this server's, within ten minutes
(`authAgeAtIssue`).
*verify:sso: "how long ago is measured on the provider's clock", and the pure
checks beside S2's.*

#### S13. Provider tokens were stored on a re-link — *low, fixed*

The account hook that discards the provider's tokens ran on create. Better
Auth's link path for an identity that is already attached updates the existing
row instead, writing the access, refresh and ID tokens onto it — so connecting
an already-connected owner a second time put them in the database.

Closed twice: an account *update* hook nulls the token fields as the create
hook does, and `/link-social` refuses an owner who is already connected (409).
*verify:sso: "connecting again once connected is refused", and "Better Auth
updating a linked account with the provider's tokens stores none of them",
under "with passwords off, the server refuses them too".*

#### S14. The start-up cross-check was skipped while discovery was pending — *low, documented*

S8 also compares the issuer the plugin built its provider from with
`OIDC_ISSUER`. When the plugin's start-up discovery failed, though, it builds
the provider in its own hook, which runs *after* this app's on the same
request, so on that request there is nothing to compare yet and the check is
skipped. The comment beside it said the check always ran.

Not closable from this app's side without replacing the plugin's retry. What
holds either way: the current document is checked on every sign-in, the
plugin verifies the ID token against the issuer of the document it built from,
and `ssoProfile` then requires the token's `iss` to be `OIDC_ISSUER` — so no
sign-in completes through a provider built from a document naming another
issuer. The comment and the docs now say what the check does and does not
cover. Accepted below. *Not pinned by a check of its own.*

#### S15. A failed connect showed an error page — *low, fixed*

The owner's *Connect* button, pressed while the discovery document failed its
checks, threw out of the server action onto the framework's error page, with
nothing to say what had happened or that nothing had changed.

Closed: a flow that does not start comes back to `/me?sso=unavailable`, which
says the provider could not be reached; a flow that fails at the provider comes
back to `/me?sso=failed`.
*verify:sso: "while the provider cannot be trusted, the button comes back to
/me and says so — not an error page".*

### Accepted, and worth knowing

- **Once the owner connects it, the provider is part of how the owner is
  authenticated.** It cannot get there by itself — the owner is never linked
  by address — but after *Connect* on `/me`, whoever controls the owner's
  identity at the provider is the owner here. Recorded as `auth.sso_linked`
  with `how: "connected"` and the role.
- **A provider that lies about `auth_time` is believed.** One that ignores
  `prompt=login` but reports an honest `auth_time` is refused; one that reports
  a false one passes re-authentication. That is the provider being wrong about
  the one thing it is there to say, and the same trust as everything else
  here. `OIDC_PROMPT=login` additionally asks the provider to prompt on every
  ordinary sign-in, for a shared machine; it is a request, not a check, and it
  is not the default.
- **An address the provider calls verified is believed.** If people can set
  their own address there and have it reported verified, they can claim an
  invited address or a member's. The app cannot see how the provider decided;
  [the deployment guide](deployment.md#what-has-to-be-true-at-the-provider)
  says what to check.
- **A second identity can link to one account.** Two subjects at the provider
  that both carry the same verified address both open that account. That is
  what trusting the provider's word for an address means.
- **The pending-discovery window (S14).** After a failed start-up discovery,
  the plugin's endpoints are the ones from the document its own retry reads,
  a moment after this app checked one. Its token and userinfo endpoints are not
  exposed to compare, so a document that changed them between the two reads is
  trusted that far; the issuer is not, because the token's `iss` is held to
  `OIDC_ISSUER`. Once set up, the plugin keeps the endpoints it read until the
  app restarts.
- **A provider that is down means nobody signs in through it**, with the
  button still shown; in `oidc`-only mode that is nobody at all. It recovers by
  itself when the provider does: Better Auth (1.7.10) retries a discovery that
  failed at start on the next request for that provider, and this app re-reads
  the document on every sign-in. Availability, not confidentiality, and loud in
  the log.
- **Only `local,oidc` runs as a full stack in CI.** The test overlay runs both
  ways in, so `oidc`-only is covered by the pure checks of the rules in every
  mode and by `scripts/passwords-off-probe.ts`, which drives the server side —
  Better Auth called in process, the password server actions, reset-link
  minting — with `AUTH_METHODS=oidc`. Its pages and HTTP endpoints were checked
  by hand, not by a suite. The default `local`-only mode was checked by running
  every other suite against it by hand before this merged.
- **The seed repeats the issuer normalisation.** `prisma/seed.ts` decides
  whether the owner is connected with its own copy of `normalIssuer`, because
  the migrator image carries `prisma/` and nothing from `src/`. No test pins
  the two together; if they drift, the seed's message is wrong — it would say
  the owner is connected, or not, when the app disagrees. The app's own
  start-up warning and the guest list use the real one.
- **`OIDC_ALLOW_INSECURE_ISSUER`** lets the issuer be plain `http://`. It
  exists for the suites, whose stand-in has no certificate, and must never be
  set in a deployment.

## Importing from a link

Added after the audit above, and the first thing in the app that makes a
request to another server on a requester's say-so. It is off unless
`IMPORT_SOURCES` names a source. What follows is what it was built to refuse.
Every row but the last is asserted by `npm run verify:import`, and the four
that are new code rather than reuse — the link parse, the download origin and
redirect, the size cut-off, and the stored link — were each watched failing
with the guard removed before the check was believed.

| The risk | What stops it |
| --- | --- |
| A pasted link makes the server request an address of the requester's choosing — an internal service, the metadata endpoint, `localhost` | The link is never fetched. It is parsed for a numeric model id, compared against the Printables hostnames *as a parsed host*, and discarded. Twenty-one look-alike links are refused with no outbound request made at all. |
| The far end names somewhere else to connect to | The download link is fetched only on the one file origin, compared after parsing; redirects are an error rather than followed. A stand-in serving a perfectly good model from a second origin is never connected to. |
| The far end sends something other than a model | The bytes go through the same `inspectModel` an upload does. A web page named `.stl` is `422`, recorded as `upload.rejected` with its source, and nothing is stored. |
| The far end sends more than it said | The download is cut off at the listed size, which is already held to the upload cap — with or without a `Content-Length` admitting it. |
| A client names a file from a different model, or lies about its size | The listing is re-fetched server-side at import time. The client supplies two ids and nothing else is taken from it. |
| A cross-site page drives it with a signed-in person's cookie | Both endpoints are `POST` and sit behind the same Origin check as every write — including the listing, which changes nothing but does make the server call out. |
| The stored link becomes a `javascript:` URL on a ticket | `sourceUrl` is built from the API's id and slug, never from input, and is validated again on the way out. A hostile value written straight into the column renders as nothing. |
| Memory | An import takes one of the same two slots an upload does, and fills one pre-sized buffer rather than joining chunks. |

**Accepted, and worth knowing:**

- **The API is undocumented.** It is the endpoint the Printables website uses,
  not a published contract. The response is parsed against a schema and a
  mismatch fails by name. That bounds the damage of a change to "importing
  stops, with a sentence saying why"; it does not make the dependency stable.
- **No per-person rate limit on listing.** A signed-in colleague could make the
  server ask Printables about models in a loop. Everyone who can sign in was
  invited, each request is a few kilobytes, and the slot gate bounds the
  expensive half. Revisit if the group grows.
- **`IMPORT_PRINTABLES_BASE` moves the allowlist.** It points the importer at a
  stand-in so the suite can run without calling Printables, and with it set the
  stand-in is the *only* host the importer talks to. It is operator
  environment, unreachable from any request, and should never be set in a
  deployment — but it is a knob that exists, and this is where that is written
  down.
- **DNS is trusted.** The allowlist is hostnames, not addresses. Someone who
  can answer DNS for `printables.com` on your network can already do worse.

## Open items

- **Nothing alerts automatically.** `/admin/audit` surfaces refusals but
  someone has to look. That is a deliberate choice at this size, not an
  oversight — revisit if the group grows or the app is ever exposed beyond
  the office.
- **No authenticated active scan.** ZAP ran a passive baseline against the
  unauthenticated surface. The authenticated surface is covered by the 91
  custom probes instead, which is better for authorisation logic and worse for
  generic injection classes. The board and upload screens have long since
  landed, so an authenticated ZAP active scan is worth configuring.
- **CSP verified against served markup, not a live browser** — except at
  `/docs`, which was. Building the API console forced the issue: its stylesheet
  had to move out of an inline `<style>` block and into a file, because
  `style-src 'self'` drops the block and the page renders *unstyled* rather
  than failing. That is the failure mode this item is about — a policy
  violation that looks like a design bug. The rest of the app still deserves
  the same browser check.
- ~~Signed model URLs are minted but nothing serves them yet~~ — closed by
  removal. There is no storage service and no signed URL: `/api/models/[id]`
  streams the file from disk behind the ownership check, and `connect-src`
  stays `'self'`.
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

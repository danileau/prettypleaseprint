# Security validation

Scope: Pretty Please Print (formerly Print That For Me), assessed against the **OWASP Top 10 (2021)** with
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
npm run probe:security                     # DAST, app-specific (62 probes)
```

## Result

| Tool | Coverage | Before | After |
| --- | --- | --- | --- |
| `npm audit` | dependency advisories | **6 high** | 0 |
| Trivy | vulns, secrets, misconfig | 0 | 0 |
| Syft + Grype | SBOM, binary contents | **92 (2 crit, 46 high)** | 0 |
| Semgrep | 153 rules, 37 files | 1 (false positive) | 0 |
| OWASP ZAP baseline | passive DAST | **1 medium, 3 low** | 0 fail / 63 pass |
| `probe:security` | 62 app-specific probes | **2 real, 4 artifacts** | 62 pass |
| `verify:models` | 29 upload-validator checks | — | 29 pass |
| `verify:passkey` | WebAuthn in a real browser | *unverified* | 13 pass |

A generic scanner cannot reason about *this* app's authority model, so the
probe suite in [`scripts/security-probe.ts`](../scripts/security-probe.ts) covers
what ZAP structurally cannot: whether a client can call the admin API, whether
an invite is single-use, whether a role can be set from outside, whether a
captured cookie survives sign-out.

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
| **A01** | Broken Access Control | **Pass.** Client refused on the admin page (404, not 403 — a 403 confirms existence) and on all six admin-plugin endpoints (`list-users`, `set-role`, `create-user`, `impersonate-user`, `remove-user`, `list-user-sessions`). Role unchanged after escalation attempts; no back-door account. `storyScope` hides another client's story. A forged session cookie reaches nothing. |
| **A02** | Cryptographic Failures | **Pass.** Session cookie `HttpOnly`, `SameSite=Lax`, `Secure`, `__Secure-` prefixed. Invite tokens stored as SHA-256 only; set-password tokens hashed at rest (`verification.storeIdentifier: "hashed"`) — both verified against the live database. Passwords are stored as Better Auth's scrypt digest, asserted against the live `account` row rather than assumed. |
| **A03** | Injection | **Pass.** SQL metacharacters in the username field handled (Prisma parameterises); no 5xx, table intact. Stored XSS via display name escaped in both DOM and flight payload. Reflected XSS via `?error=` and via the invite-token path segment both escaped. CRLF in the email field does not reach the mailer. Uploads are validated against their bytes, not their filename — a PDF, an ELF binary and an HTML page renamed `.stl` are all refused, as is an STL that lies about its triangle count. |
| **A04** | Insecure Design | **Pass.** No public registration route: `/signup` and `/register` do not exist, and the sign-up endpoint that *does* exist — the one an invitation link posts to — answers 403 to anybody without a pending invite, leaving no row. Invite-only enforced in one hook across every auth method. Invites single-use, expiring, revocable, rotated on resend. Password guessing rate-limited and confirmed firing. |
| **A05** | Security Misconfiguration | **Pass, after fixes 2 and 3.** Full header set; `X-Powered-By` suppressed; `.env`, `.git/config`, `package.json` and the Prisma schema all unreachable; malformed input returns no stack trace. |
| **A06** | Vulnerable Components | **Pass, after fixes 4 and 5.** Zero across three independent scanners. |
| **A07** | Auth Failures | **Pass, after fix 1.** Passwords: ≥10 characters, breach-checked against HIBP by k-anonymity, guessing capped at 10/min per IP. No user enumeration — a wrong password and an invented username give byte-identical responses, and an unknown username still pays for a hash so the wall clock does not answer either. Set-password links single-use, 30-minute TTL, hashed at rest, and they establish **no session**. Setting a password revokes the sessions the old one opened. Off-site and protocol-relative redirect targets refused, both via `?next=` and via the API's `callbackURL`. Sign-out kills the session server-side. See the section below. |
| **A08** | Integrity Failures | **Pass.** `role`, `initials` and `invitedById` cannot be set from the request body: declared `input: false`, and Better Auth refuses the whole sign-up with `FIELD_NOT_ALLOWED` rather than silently trimming it. A chosen `id` and a posted `emailVerified` reach the endpoint undeclared and are overruled server-side from the invite. Both halves probed. On upload, `uploaderId` comes from the session and a posted `status` is ignored, both probed. Storage keys are generated, never derived from the filename. Lockfile committed. |
| **A09** | Logging & Monitoring | **Pass.** An append-only `AuditEvent` table records invitations sent, resent, revoked, accepted and *rejected*; password resets requested and completed; sign-in and sign-out; story creation and refused uploads. Rows are denormalised (`actorEmail`, `subject`) so the trail still reads correctly after the user or story it refers to is deleted, and a probe asserts no token or secret reaches `detail`. |
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

### Residual risk accepted

- **The breach check is an outbound dependency.** It fails closed, so if
  `api.pwnedpasswords.com` is unreachable, nobody can *set* a password —
  registration and reset stop, sign-in does not. `HIBP_DISABLED=true` exists
  for an air-gapped deployment and is off by default. This is a deliberate
  availability-for-integrity trade at this size; a cached local corpus would be
  the answer if it ever bit.
- **No second factor.** A password plus an optional passkey is the whole set.
  TOTP would be the next thing to add if this were ever exposed beyond an
  office, and Better Auth's `twoFactor` plugin is the path.
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

## Open items

- **Nothing alerts automatically.** `/admin/audit` surfaces refusals but
  someone has to look. That is a deliberate choice at this size, not an
  oversight — revisit if the group grows or the app is ever exposed beyond
  the office.
- **No authenticated active scan.** ZAP ran a passive baseline against the
  unauthenticated surface. The authenticated surface is covered by the 62
  custom probes instead, which is better for authorisation logic and worse for
  generic injection classes. Once the board and upload screens land, an
  authenticated ZAP active scan is worth configuring.
- **CSP verified against served markup, not a live browser.** Every script is
  nonced and there are no external subresources, but a browser smoke test
  should confirm nothing is blocked at runtime.
- **Signed model URLs are minted but nothing serves them yet.**
  `signedModelUrl` exists with a 10-minute expiry and the ownership check
  gates it, but the download route lands with the 3D viewer. When it does,
  `connect-src` has to widen to the storage origin — it is `'self'` today,
  which will block the fetch.
- **The upload buffers the whole file in memory** to measure its bounding
  box. That is inherent to computing the box, and fine at 50 MB for five
  people, but it is a denial-of-service lever if this ever faces a wider
  audience. A streaming parse, or a size-based queue, is the answer then.
- ~~Print-time estimates~~ — removed rather than kept. The app now shows only
  what it measured. See the README for the reasoning and the path to a real
  slicer-derived figure.
- **CSRF rests on Origin checking plus `SameSite=Lax`**, which is Better
  Auth's model and is sound for this threat profile. There are no
  per-form tokens; if the app ever needs to accept cross-site POSTs, that
  changes.
- **No second factor, and no self-service password change.** Both are in
  [Residual risk accepted](#residual-risk-accepted) above with the reasoning.

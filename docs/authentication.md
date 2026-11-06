# How authentication works

[← back to the README](../README.md)

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

A deployment can add a third, or use it alone: **single sign-on** through an
OpenID Connect provider it already runs. Off unless `AUTH_METHODS` names it;
see [Single sign-on](#single-sign-on) below.

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
password, and notifications are in the Activity panel, written by `notify()`.
Mail does two jobs, and the app is whole without either. It delivers a *link* —
an invitation, a resent one, a password reset. And it sends a *copy* of each
notification to anybody who has not switched that off on their profile.

With `SMTP_URL` or `RESEND_API_KEY` set, both happen. With neither, the admin
gets each link on screen to hand over directly, notifications stay in the
panel, and the app boots normally rather than refusing to start. Same token,
same single use, same expiry either way.

A notification email is sent without being waited for: the row in the Activity
panel is the notification, and somebody accepting a print should not wait on a
mail server to be told so, nor have the action fail because one is having a
bad afternoon. A failed send is logged and nothing else. The owner's **Mail**
page (`/admin/mail`) is where to find out whether mail is actually arriving —
it sends a test message and reports the server's own answer — and it shows
every message the app can send, as it is sent.

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

Where `AUTH_METHODS` leaves `local` out there is no password to set, so the
seed prints no link. It says instead whether the owner has connected the
single sign-on provider — and, if not, that nobody can sign in as the owner
and how to put that right. See
[Going `oidc`-only](deployment.md#going-oidc-only).

There is deliberately no `ADMIN_PASSWORD`. It would sit in `.env.docker`, in
`docker inspect`, in the shell history that wrote the file and in every backup
of the host, still valid months later. A link that expires in half an hour is a
smaller thing to leak.

### Invite-only, enforced in one place

A `User` row can only come into existence when a pending invite matches the
address. That decision lives in a single hook, `user.validateUserInfo` in
[`src/lib/auth.ts`](../src/lib/auth.ts):

```ts
async validateUserInfo({ user, source }) {
  if (source.action !== "create-user") return;
  const invited = Boolean(await pendingInviteFor(user.email));
  if (!invited || !isClaimingInvite(user.email))
    return { error: "invite_required", ... };
}
```

Two conditions. A pending invitation for the address is necessary, and for a
while it was treated as sufficient — which, because Better Auth's
`/sign-up/email` answers anybody, made the *address* the credential: whoever
knew an invited address could post it with their own password and be given the
account. So the request must also be the redemption of that invitation's link.
`acceptInvite` checks the token and runs the sign-up inside `claimingInvite`
(`src/lib/invites.ts`), an `AsyncLocalStorage` scope the gate reads back. It
cannot be set from a request body, and a request that arrives at the endpoint
by itself is refused exactly as an address with no invitation is — same status,
same words, so the endpoint cannot be used to ask who has been invited. The
audit trail tells the two apart (`reason: "no_link"` / `"no_invitation"`).

Better Auth calls it before provisioning an identity **by any method**, from
`internalAdapter.createUser`. Password sign-up goes through that path with
`{ method: "email-password" }` exactly as passkey enrolment does, so adding
passwords neither moved this rule nor added a second copy of it in a route
handler to drift out of sync. `verify:auth` asserts both halves directly:
registering an address with no pending invite is answered 403 and leaves no
row, and so is registering an invited address without its link.

A sign-in through a single sign-on provider goes through the same hook, with
the provider's verified address standing in for the link — see
[The invite gate, for a provider sign-in](#the-invite-gate-for-a-provider-sign-in).

### The invitation link

1. The admin submits an address at `/admin/invites`.
2. `createInvite` mints 32 bytes of CSPRNG output, stores **only its SHA-256
   digest**, and emails the raw token inside the link. The raw token is never
   returned to the admin either — it exists in the email and nowhere else.
3. The invitee opens `/invite/<token>`, sees who invited them and which
   address the invite is bound to, and picks a display name, a **username** and
   a **password**.
4. Submitting checks the token again and calls Better Auth's sign-up as the
   redemption of that invite, which runs the invite gate and the stamping
   hook, creates the account and returns a session. They land on
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

[`src/lib/authz.ts`](../src/lib/authz.ts) holds the handoff's core rule as one
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

### Confirming it is still you

Four things an admin can do outlive any session: inviting somebody (a whole new
account), re-sending an invitation (a fresh working link), minting a
password-reset link (the ability to become that person) and revoking or
restoring access. All four ask for the passkey or the password again if the
current sign-in is more than five minutes old, and send you to `/reauth` if it
is.

This is the sudo gate, and it exists because shortening the session window does
not help against a cookie captured *now*. It is the one control a thief holding
a copied cookie cannot satisfy.

Withdrawing an unaccepted invitation is not gated — it only ever removes reach
— and nor are `/admin/benefits` and `/admin/catalog`, which decide what the
request form offers and grant nobody anything.

`/reauth` offers both the passkey and the password on purpose. Every account
has a password by construction and only some have a passkey, so requiring a
passkey would leave an admin without one unable to revoke access.
Where single sign-on is on it offers the provider as well, held to a stricter
rule than an ordinary sign-in — see
[Confirming it is still you, through the provider](#confirming-it-is-still-you-through-the-provider).

One thing worth knowing, because it explains a spare row in `session`: Better
Auth has no way to assert an identity without creating a session, so
re-authenticating signs you in again and the gate reads the age of the session
that comes back. The session it replaces is left to expire, which at twenty
minutes is not long.

### Single sign-on

A deployment can sign people in through an OpenID Connect provider — Authelia,
Authentik, Keycloak, VoidAuth, a cloud one — instead of, or alongside, the
username and password. [Deployment](deployment.md#single-sign-on) covers
setting it up; this is what it does and does not change.

#### Three modes

`AUTH_METHODS` names which ways in are on, read once when the app starts
(`authMethods` in [`src/lib/auth-methods.ts`](../src/lib/auth-methods.ts)):

| `AUTH_METHODS` | Ways in |
| --- | --- |
| `local` — the default, and what unset or empty means | username and password, and passkeys. What every existing instance keeps doing. |
| `local,oidc` | both, side by side: the provider's button first, then the passkey and the password form. |
| `oidc` | the provider alone. Nobody has a password or a passkey that works. |

A name that is not a method is an error, not a quiet "nobody can sign in".

**A method that is off is off at the endpoint**, not merely missing from the
page (`disabledAuthPaths`):

| Better Auth endpoint | `local` | `local,oidc` | `oidc` |
| --- | --- | --- | --- |
| `/sign-in/username`, `/sign-in/email`, `/sign-up/email`, `/reset-password`, `/request-password-reset`, `/change-password`, the four `/passkey/…` ceremonies | open | open | 404 |
| `/sign-in/social` — the redirect flow | 404 | open | open |
| `/sign-in/social` with a posted `idToken` | 404 | 404 | 404 |
| `/link-social` | 404 | the owner only (below) | the owner only |
| `/unlink-account` | 404 | 404 | 404 |

Better Auth enforces its `disabledPaths` list only for requests that come in
over HTTP. The same endpoints called from the app's own server code
(`auth.api.signUpEmail`, say) go straight past it, so the first rule in
`hooks.before` refuses them as well. And the server actions that take a
password — accepting an invitation, setting one from a link, the owner minting
a reset link — refuse before they write anything, while
`issuePasswordSetupUrl` throws rather than mint a link nobody could use.

#### The invite gate, for a provider sign-in

**The provider replaces the password, not the guest list.** By default a new
account still needs an invitation. What changes is the proof: locally it is the
invitation's link; through the provider it is the provider's word that the
address is verified. The whole rule is one pure function, `mayProvision`,
called from the same single `validateUserInfo` hook as before:

| | needs | refusal recorded as |
| --- | --- | --- |
| local | a pending invitation **and** its link | `no_invitation` / `no_link` |
| through the provider | a pending invitation **and** `email_verified: true` | `no_invitation` / `unverified_email` |
| through the provider, `OIDC_SIGNUP=open` | `email_verified: true` | `unverified_email` |
| through the provider, single sign-on off | — | `sso_off` |

Refusals go on the trail as `invite.rejected`, with `via: "oidc"` for the
provider's door.

That middle row is not finding 10 again. There, an address was something a
stranger typed into a request. Here it is a claim in a token signed by the
provider this deployment chose, checked against that provider's published keys
and bound by nonce to the request that asked for it, in the redirect flow that
is the only one this app accepts. The link only ever proved somebody could read
the mailbox; this is the same proof from a better witness. The claim has to be
the boolean `true` — providers have been seen sending the string `"false"`,
which is truthy — and it is checked twice, where the profile is mapped and
again in the gate. Without it the address is refused before anything is looked
up, so the refusal says nothing about who is invited.

An invited person who signs in through the provider gets the invitation's role
(the app only issues `client` ones) and is recorded as invited by whoever
invited them; the invitation is spent, exactly as redeeming its link would
spend it.

`open` hands the guest list to the provider: anybody it signs in with a
verified address gets a `client` account. That switches off the invite-only
rule this app is built around, for that door, so a host has to ask for it by
name — a misspelt value is an error, not a quiet `open`.

#### Who is linked, and how

**A member who already has an account lands in it.** Their first sign-in
through the provider with a matching, verified address links the provider
identity to the account, recorded as `auth.sso_linked` with
`how: "automatic"`. An address the provider has *not* verified links nothing,
signs nobody in, and gets the same answer whether or not anybody here has it
(below). The provider is deliberately not one of Better Auth's "trusted
providers", which are linked on their say-so even without a verified address.

**The printer owner is never linked by address.** A provider that asserts the
owner's address — verified or not — opens nothing, and is answered word for
word as a stranger would be (`invite_required`), so the refusal does not say
whose address it was. The trail records it as `auth.sso_link_refused`, and the
audit dashboard counts it among the refusals.

**The owner connects the provider on purpose, from `/me`.** The *Connect …*
button is a server action that first asks the owner to confirm it is them
(`requireFreshAuth`), then runs Better Auth's explicit link flow,
`/link-social`. That flow:

- answers the printer owner alone — a member gets 403 — on a session under
  five minutes old, and not an owner who is already connected (409);
- asks the provider for a fresh login (`prompt=login`, `max_age=0`), and holds
  the answer to the same `auth_time` rule as re-authentication, below;
- attaches only an identity whose verified address is the owner's own;
- and only to the account signed in in the browser the flow comes back to,
  which has to be the one that started it.

It is recorded as `auth.sso_linked` with `how: "connected"`. If the provider
cannot be trusted just now — its discovery document fails the checks below —
the button comes back to `/me` saying so, rather than to an error page.

**Disconnecting** is on `/me` too, after confirming it is you, and recorded as
`auth.sso_unlinked`. It is refused where passwords are off, because it would
remove the owner's only way in. Better Auth's own `/unlink-account`, which asks
only for a session under a day old and that one account remain, is closed in
every mode: anybody at the owner's open browser could otherwise have removed
it, with no step-up and nothing on the trail.

> Once connected, the provider is part of how the owner is authenticated —
> whoever controls the owner's identity there can sign in as the owner. Point
> this only at a provider you run or trust as much as the app itself.

**An identity is the issuer and the subject together.** A subject (`sub`) is
only unique at the provider that issued it, so a link is filed as
`<issuer>|<sub>`, the issuer spelt one way (`normalIssuer` in
[`src/lib/oidc-flow.ts`](../src/lib/oidc-flow.ts)). Pointing `OIDC_ISSUER` at a
different provider therefore starts afresh: no identity from the old one opens
anything; members link again by verified address; the owner connects again on
`/me`. Everything that asks "is the owner connected?" — `/me`, `/reauth`, the
guest list, the start-up warning, the seed — counts only links to the issuer
configured now. The old rows stay in the database, inert.

Once linked, the identity is what opens the account. The address the provider
reports is still required on every sign-in, but is not compared with the
account's again, and a change of address at the provider does not change it
here.

#### What the provider does not get to say

Three things reach a user row, and only when an account is created: the
address, that it is verified, and a name (`name`, else `preferred_username`,
else the invitation's, else the part of the address before `@`). Everything
else is dropped:

- **No role.** The owner was decided by the seed and an invitee's role by their
  invitation, so a `role`, `groups` or `is_admin` claim changes nothing.
- **No name change.** An existing account — a member linked automatically, the
  owner connecting — keeps its own name, username and role.
- **No picture.** Better Auth would copy `picture` into `user.image`: a URL of
  the provider's choosing that nothing here shows and that a browser would be
  sent to fetch.
- **No tokens.** The app never calls the provider on anybody's behalf — the
  sign-in is the whole of the relationship — so the access, refresh and ID
  tokens would be credentials for somebody else's system, sitting in this
  database for no reason. An account hook nulls them when a link is created,
  and a second hook does the same on update, because Better Auth's re-link
  path writes the tokens onto the existing row instead of creating one.

#### Confirming it is still you, through the provider

`/reauth` offers the provider's button wherever single sign-on is on — except
to an owner who has not connected it, for whom it would be refused. For
somebody who has only ever signed in through the provider it is the only
option: they have no password to type.

The question `/reauth` asks is how old the current session is (see
[Confirming it is still you](#confirming-it-is-still-you)). A sign-in through
the provider can be a click on a session the provider has held for hours, so
two things make that question honest:

- **Confirming asks for a fresh login.** The button marks the flow as a
  re-authentication, and the server — not the page — sends `prompt=login` and
  `max_age=0`. The answer counts only if its ID token says the person
  authenticated (`auth_time`) no more than **two minutes** before the token
  was issued (`iat`). Both are read off the provider's own clock, so a
  provider whose clock is a few minutes out is measured fairly; `iat` itself
  only has to be within **ten minutes** of this server's clock. A provider that
  answers from the session it already holds, or does not say when the person
  authenticated, is refused, no session is created, and `/reauth` says it has
  to ask again.
- **A session is dated by `auth_time`.** Every session opened through the
  provider is recorded as having started `iat − auth_time` before now, not
  when the app wrote it. An ordinary sign-in that the provider waved through
  on an hour-old session is an hour old here, so signing in again is not a way
  round the question; one with no usable `auth_time` is dated just past the
  five-minute window.

`OIDC_PROMPT=login` makes the provider ask for credentials on ordinary sign-ins
too, at the cost of the "single" in single sign-on. It is unset by default.
Every ordinary sign-in sends exactly the configured value: the server drops
whatever authorization parameters a request brings (Better Auth would lay them
over the configured `prompt`, so a hand-made `prompt=none` would otherwise win).
Whether the provider honours it is the provider's business; the dating above is
what the app relies on.

#### What the app checks beyond the library

Better Auth's `generic-oauth` plugin verifies the ID token — signature against
the published keys, issuer, audience, expiry, and the nonce that binds it to
the request — and `requireIdTokenVerification` makes that a condition of the
provider being set up at all. PKCE and state are the library's defaults and
left on. [`src/lib/oidc-flow.ts`](../src/lib/oidc-flow.ts) adds what the
plugin does not do:

- **The discovery document is checked, not just read.** Its `issuer` has to be
  `OIDC_ISSUER`, it has to name the authorization and token endpoints and the
  keys, and when the issuer is `https://` so must every endpoint in it. It is
  read again each time a sign-in starts, and a sign-in does not start while it
  fails.
- **The ID token's `iss` is held to `OIDC_ISSUER`**, not merely to whatever
  issuer the document named.
- **There has to be an ID token, naming a subject.**
- **Userinfo is about the same person.** It is asked only when the ID token
  carries no address, and its `sub` has to be the token's.
- **An ID token on its own signs nobody in.** Better Auth's `/sign-in/social`
  has a second branch that signs somebody in on a posted ID token — no state,
  no PKCE, a nonce only if the caller offers one, and a userinfo lookup with
  whatever access token the caller sends beside it. `/link-social` has the
  same branch for attaching one. Both are refused, for every provider; the
  redirect flow is the only way in.
- **An unverified address gets one answer.** Better Auth answers it with
  `account_not_linked` when somebody here has the address and
  `email_not_verified` when nobody does, and only the second carried a
  description. The auth route rewrites the first into the second and drops
  the description, so the browser is sent to the same URL, character for
  character, either way — and the sign-in page says the same sentence for
  both codes.

#### On the trail

| Event | When | Detail |
| --- | --- | --- |
| `auth.sso_linked` | an identity at the provider now opens an account | `provider` (the issuer), `role`, and `how`: `automatic` for a member's first sign-in, `connected` for the owner on `/me` |
| `auth.sso_link_refused` | a provider asserted the owner's address, and the owner has not connected it | `reason: "owner_not_connected"`, `provider` |
| `auth.sso_unlinked` | the owner disconnected it on `/me` | `provider`, `role` |
| `invite.rejected` | a provider sign-in that may not have an account | `reason`, `via: "oidc"` |
| `auth.signed_in` | every session, whichever way it was opened | — |

The three `auth.sso_*` events are in the *Who got in* view of `/admin/audit`,
and `auth.sso_link_refused` is counted with the refusals at the top of it.

#### What single sign-on does not do here

- **Sign you out of the provider.** Signing out of this app ends this app's
  session. Revoking access here is still what locks somebody out here, and a
  suspended person signing in through the provider is refused.
- **Give an SSO-only person a password.** They cannot use the bearer-token
  [API](api.md) from a script, because that starts with a username and
  password. With `local` on they can be given one from the guest list.
- **Work while the provider is down.** Nobody can sign in through it then,
  and with `oidc` alone nobody can sign in at all. It comes back by itself
  with the provider — see the deployment guide.

`npm run verify:sso` drives all of it against a stand-in provider
(`scripts/stubs/oidc-stub.mjs`) that can be told who is signing in and told to
lie: a forged signature, a wrong issuer or audience, a replayed nonce, an
expired token, an unverified address or the string `"true"`, no address, a
session it answers from when asked to log somebody in again, no `auth_time`, a
clock four minutes out, userinfo about somebody else, a discovery document
naming another issuer, a bare ID token handed out with no flow around it. The
rules in `src/lib/auth-methods.ts` and `src/lib/oidc-flow.ts` are pure and are
checked in every mode; a child process drives the server side with
`AUTH_METHODS=oidc` (`scripts/passwords-off-probe.ts`), because the stack under
test runs `local,oidc`.

### Other decisions worth knowing

- **Cookies** are `HttpOnly`, `SameSite=Lax`, `__Secure-` prefixed, and keyed
  on the *URL scheme* rather than `NODE_ENV` — a production boot over plain
  HTTP throws unless it is loopback, and an HTTPS deployment always gets the
  flag regardless of how the env is set.
- **A session is worth twenty idle minutes**, sliding every minute
  (`SESSION_IDLE_SECONDS`). It used to be thirty days with a daily slide, which
  in practice meant *forever*: `expiresIn` is an idle window that renews, so a
  session used once a month never expired at all. Twenty minutes is only
  humane because passkeys are here — which does make the passkey nudge
  load-bearing rather than decorative. The full reasoning, including why not a
  JWT and why the token stays in a cookie, is in
  [the security audit](security-audit.md#the-session-window).
- **Middleware re-stamps the session cookie on page navigations.** Better Auth
  slides the database row and the cookie together, but Next forbids writing a
  cookie during a React Server Component render, so browsing pages would keep
  the row alive while the browser's copy quietly expired. Harmless at thirty
  days; at twenty minutes it signs people out mid-task. The cookie is never the
  authority — the row is — so extending the browser's copy cannot extend a
  session, it only stops the cookie dying first.
- **Session cookie caching is off.** It would trust a signed snapshot without
  a database lookup, which makes sign-out lag by the cache lifetime. A DAST
  probe caught exactly that; see [the security audit](security-audit.md).
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

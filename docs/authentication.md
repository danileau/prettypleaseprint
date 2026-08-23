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
[`src/lib/auth.ts`](../src/lib/auth.ts):

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

### Other decisions worth knowing

- **Cookies** are `HttpOnly`, `SameSite=Lax`, `__Secure-` prefixed, and keyed
  on the *URL scheme* rather than `NODE_ENV` — a production boot over plain
  HTTP throws unless it is loopback, and an HTTPS deployment always gets the
  flag regardless of how the env is set.
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

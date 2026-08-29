# The API

[← back to the README](../README.md)

Everything the app does over HTTP, and how to drive it yourself.

There is a console at **`/docs`** — Swagger UI, served from this origin, with
your session already attached. It is linked from the account menu. This page is
the reading version: what the endpoints are for, and the handful of decisions
that will otherwise surprise you.

## The short version

```bash
# 1. Sign in. The token comes back in a response header.
TOKEN=$(curl -si https://print.example/api/auth/sign-in/username \
  -H 'content-type: application/json' \
  -d '{"username":"ayla","password":"…"}' \
  | grep -i '^set-auth-token:' | cut -d' ' -f2 | tr -d '\r')

# 2. Use it.
curl -s https://print.example/api/stories \
  -H "authorization: Bearer $TOKEN" | jq '.stories[] | {ref, title, status}'
```

## Authentication

There is **no public sign-up and no separate API key**. An account exists only
where an invitation was accepted, and the API uses the same session as the
browser. Two ways to carry it:

| | |
| --- | --- |
| **Session cookie** | What a browser already holds. `Try it out` at `/docs` works with no setup at all. |
| **Bearer token** | Any sign-in response carries `set-auth-token`. Send it back as `Authorization: Bearer <token>`. |

The bearer token **is** the session token. That has consequences worth knowing
before you paste one into a script:

- Signing out revokes it, at the same instant it revokes the cookie. So does an
  admin revoking access, and so does a password reset.
- It carries exactly the authority of the account it came from — no more, and
  no less. There is no scope, no read-only variant and no long-lived key.
- It lasts as long as a session does: **twenty minutes of inactivity**. A
  script that runs longer than that between calls has to sign in again — which
  is the intended answer for anything unattended.
- Unlike the cookie it is not `HttpOnly` and not `SameSite`-protected. It lands
  in shell history, in CI logs and in `ps` output. For anything that runs
  unattended, sign in fresh rather than reusing the token from the browser you
  are sitting in, and sign out when the job is done.

Nothing else is a way in. There is no `?token=` parameter, no basic auth, and
no header that names a user.

## What you can reach

| | | |
| --- | --- | --- |
| `GET` | `/api/health` | Can the app serve? The only endpoint with no session. |
| `GET` | `/api/stories` | Your tickets. The printer owner's is everyone's. |
| `GET` | `/api/stories/{id}` | One ticket. |
| `DELETE` | `/api/stories/{id}` | Withdraw your own request. |
| `POST` | `/api/stories/{id}/advance` | Move it one step along. *Printer owner.* |
| `POST` | `/api/stories/{id}/decline` | Say no. *Printer owner.* |
| `POST` | `/api/stories/{id}/flag` | Flag a model problem, with a reason. *Printer owner.* |
| `DELETE` | `/api/stories/{id}/flag` | Clear the flag. *Printer owner.* |
| `GET` `POST` | `/api/stories/{id}/comments` | The conversation on a ticket. |
| `GET` | `/api/notifications` | Your Activity feed. |
| `POST` | `/api/notifications/read` | Mark one read, or all of them. |
| `POST` | `/api/upload` | Upload a model and open a request. Multipart. |
| `GET` | `/api/models/{id}` | The model's bytes. |
| `GET` | `/api/openapi.json` | This surface, machine-readable. |
| | `/api/auth/*` | Every Better Auth endpoint — sign-in, passkeys, admin, reset. |

`{id}` is the numeric id — `4`, not `PPP-104`. The display ref comes back on
every ticket as `ref`.

## Five things that will otherwise surprise you

**1. There is no "set the status" endpoint.** The flow is
`Requested → Accepted → Printing → Delivery → Done`, forwards, one step at a
time, and `advance` derives the next state rather than taking one. That is the
point: an endpoint accepting a target status is an invitation to skip a step,
and the board's whole claim is that it shows where work actually is. `Declined`
is reachable only from `Requested` — once the printer owner has said yes,
saying no is a conversation rather than a state change.

**2. `404` and `403` mean different things, deliberately.** A ticket you may
not see is `404`, because a `403` would confirm it exists — the same rule the
pages follow. An *action* you may not take is `403`, because these endpoints
are listed in `/api/openapi.json` and pretending they are missing would help
nobody and confuse an honest client whose ticket is fine.

**3. Withdrawing is the requester's, and it is not the printer owner's.**
Seeing every story is the widest scope in the app and it still does not include
deleting somebody's request. And it only works while nobody has acted on it —
`Requested` or `Declined`. Past that you get `409` and the name of the person
to ask.

**4. Writes refuse a foreign `Origin`.** CSRF here rests on `SameSite=Lax` plus
an Origin check, which is Better Auth's model and the app keeps to it. A
request with *no* `Origin` header is fine — that is `curl`, and it is not a
browser being driven by somebody else's page. A request with the wrong one is
`403`.

**5. Uploads are multipart, and the bytes decide.** `.stl` and `.3mf` only, at
most 50 MB, validated against the file's actual content rather than its name —
an STL renamed `.3mf` is refused. Nothing reaches storage until the file has
been inspected and no ticket exists until the object is in place, so a rejected
upload leaves nothing behind. The uploader comes from the session: an
`uploaderId` or a `status` in the body is ignored.

```bash
curl -s https://print.example/api/upload \
  -H "authorization: Bearer $TOKEN" \
  -F file=@clip.stl \
  -F title='Cable clip' -F material=PETG -F colorName=Slate \
  -F quantity=2 -F tip='A beer' -F note='Teal if you have it'
```

## Errors

One shape, everywhere, and the message is written for a person:

```json
{ "error": "PPP-104 is already printing — ask Ruben instead." }
```

| | |
| --- | --- |
| `400` | The request did not parse, or a field failed validation. |
| `401` | No session, or the account has been suspended. |
| `403` | Authenticated, but not allowed — or a foreign `Origin` on a write. |
| `404` | No such thing, **or** not one you may see. |
| `409` | Real, yours, and not in a state where that makes sense. |
| `413` `422` | Upload too large, or not an acceptable model. |
| `500` | Our fault. The message never carries detail — no stack, no query. |

`500` bodies are deliberately uninformative. The detail is in the server log,
where it belongs.

## Paging

`GET /api/stories` returns at most 25 by default (100 maximum) and a
`nextCursor`. Feed it back as `?before=`:

```bash
curl -s "https://print.example/api/stories?status=Printing&limit=50" \
  -H "authorization: Bearer $TOKEN"
```

A cursor rather than an offset, because a ticket created mid-page makes
`skip`/`take` repeat a row or drop one. `status` may be repeated
(`?status=Requested&status=Printing`) or comma-separated.

## Where the rules actually live

Both front doors — the server-rendered forms and these endpoints — call
[`src/lib/stories.ts`](../src/lib/stories.ts). Who may move a ticket, from
which state, who gets told and what goes in the audit trail is decided there
and nowhere else, so the API cannot quietly enforce less than the UI does.
`npm run verify:api` drives the JSON surface against every rule
`npm run verify:queue` drives through the forms.

The boundary itself — 401 vs 403, the Origin check, and the list of fields that
may go on the wire — is [`src/lib/api.ts`](../src/lib/api.ts). Nothing spreads
a database row into a response: every field is named, which is why adding a
column tomorrow cannot leak it.

## The document, and the console

`/api/openapi.json` is OpenAPI 3.1, assembled per request from two halves: the
app's own paths, and Better Auth's, generated by the library so they cannot
drift when a plugin is added. Request bodies are converted from the same Zod
schemas the handlers validate with, so the document cannot promise a rule the
server does not enforce.

Both it and `/docs` need a session. They describe an invite-only tool to the
people already inside it, and an unauthenticated endpoint is not the place to
publish a map of your authority model.

Swagger UI is **vendored, not loaded from a CDN** —
`npm run vendor:swagger` copies it out of `node_modules` into `public/docs/`,
which `predev` and `prebuild` run for you. Three reasons: the app's
`script-src 'self'` would refuse a CDN, a deployment on an isolated VLAN has no
outbound internet, and a CDN is a third party in the request path of a tool
that is otherwise entirely first-party.

Generating a client is the usual thing:

```bash
curl -s https://print.example/api/openapi.json -H "authorization: Bearer $TOKEN" > openapi.json
npx @openapitools/openapi-generator-cli generate -i openapi.json -g typescript-fetch -o ./client
```

## What is not here

- **No webhooks.** Nothing calls out. If you want to know when a ticket moves,
  poll `/api/notifications`.
- **No bulk endpoints.** Five people and one printer; a loop is fine.
- **No API keys, scopes or service accounts.** Every call is made *as* a
  person, and the audit trail names them. That is the property worth keeping.
- **No CORS headers.** The API is same-origin, and a bearer token from another
  origin cannot get past the preflight. Fetching it from a page you host
  elsewhere is not a supported thing to do.

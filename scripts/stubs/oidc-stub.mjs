/**
 * A stand-in OpenID Connect provider, for `npm run verify:sso`.
 *
 * Signing in through somebody else's identity provider cannot be tested
 * against a real one: the suite needs to decide who is at the keyboard, and —
 * more to the point — it needs the provider to *lie*. Most of what the app has
 * to get right about single sign-on is what it refuses: a token signed by the
 * wrong key, one issued for a different client, one replayed with the wrong
 * nonce, an address the provider has not verified. A real provider will not
 * produce any of those on request.
 *
 * So this is a small, honest OIDC provider with a dishonest streak that is
 * switched on per person. It speaks discovery, the authorization-code flow
 * with PKCE, RS256 ID tokens, a JWKS and a userinfo endpoint. It is not a
 * place to learn how to build one: it has no consent and no refresh tokens,
 * because nothing here exercises them. It does keep a *session* per person —
 * when they last "typed their password" here — because what `auth_time` says,
 * and whether `prompt=login` / `max_age` are honoured, is what re-authentication
 * through a provider rests on.
 *
 * Plain Node with no dependencies, like the Printables stand-in beside it and
 * for the same reason — the test overlay runs it in a bare Node image.
 *
 * Who signs in:
 *
 *   - The suite appends `&as=<key>` to the authorization URL before following
 *     it, naming one of the people registered with `POST /_people`.
 *   - A person at a browser gets a page listing them, one link each. That is
 *     what makes this usable for trying the feature by hand.
 *
 * `fault` on a person makes the provider misbehave for them — see FAULTS.
 * Three more fields shape their session here:
 *
 *   - `session_age`: they already signed in here that many seconds ago, so a
 *     sign-in that does not insist on a fresh login reports that `auth_time`.
 *   - `ignores_prompt`: answer from that session even when `prompt=login` or
 *     `max_age` asked for a fresh login — a provider that waves people through.
 *   - `no_auth_time`: leave `auth_time` out of the ID token altogether.
 *
 * And two the userinfo endpoint: `userinfo_only` keeps the address out of the
 * ID token, so the app has to ask userinfo for it; `userinfo_sub` makes
 * userinfo answer for a different subject than the token names.
 *
 * `POST /_discovery` lays fields over the discovery document (`{}` puts it
 * back); `GET /_id_token?as=<key>` hands out an ID token for this client with
 * no flow around it, as anything that ever held one could replay it; and
 * `GET /_last_authorize` returns the query of the last authorization request.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 4020);
/** How the *app* reaches this — it becomes `iss` and every endpoint URL. */
const ISSUER = (process.env.STUB_ISSUER ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const CLIENT_ID = process.env.STUB_CLIENT_ID ?? "ppp";
const CLIENT_SECRET = process.env.STUB_CLIENT_SECRET ?? "ppp-stub-secret";
/** Exact matches only, as a real provider insists. */
const REDIRECT_URIS = (process.env.STUB_REDIRECT_URIS ?? "http://localhost:3000/api/auth/callback/oidc")
  .split(",").map((s) => s.trim()).filter(Boolean);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "stub-key-1";
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
/** A second key the JWKS never mentions, for forging with. */
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * The ways the provider can be made to misbehave for one person. Each is
 * something the app must refuse, and the comment says on what grounds.
 */
const FAULTS = new Set([
  "bad_signature",   // signed by a key that is not in the JWKS
  "wrong_issuer",    // `iss` names somebody else
  "wrong_audience",  // issued for a different client
  "wrong_nonce",     // not bound to the request that asked for it
  "expired",         // `exp` in the past
]);

/** key → person. Seeded for trying it by hand; the suite replaces them. */
const people = new Map();
function setPeople(list) {
  people.clear();
  for (const p of list) {
    if (p.fault && !FAULTS.has(p.fault)) throw new Error(`unknown fault ${p.fault}`);
    people.set(String(p.key), {
      key: String(p.key),
      sub: String(p.sub ?? `sub-${p.key}`),
      email: p.email,
      email_verified: p.email_verified,
      name: p.name ?? String(p.key),
      fault: p.fault ?? null,
      // Any further claims to put in the ID token — a `role`, a `groups` list.
      // The app is supposed to ignore every one of them.
      extra: p.extra ?? {},
      session_age: typeof p.session_age === "number" ? p.session_age : null,
      ignores_prompt: p.ignores_prompt === true,
      no_auth_time: p.no_auth_time === true,
      userinfo_only: p.userinfo_only === true,
      userinfo_sub: p.userinfo_sub === undefined ? null : String(p.userinfo_sub),
    });
  }
  loggedInAt.clear();
}
/** person key → when they last authenticated here, in seconds. */
const loggedInAt = new Map();

/**
 * When this person authenticated, for an authorization request: the session
 * they hold, unless the request insists on a fresh login and the person is not
 * set to have that ignored.
 */
function authenticate(person, q) {
  const now = Math.floor(Date.now() / 1000);
  let at = loggedInAt.get(person.key);
  if (at === undefined) at = person.session_age === null ? now : now - person.session_age;
  const maxAge = q.get("max_age");
  const insists = (q.get("prompt") ?? "").split(" ").includes("login") ||
    (maxAge !== null && now - at > Number(maxAge));
  if (insists && !person.ignores_prompt) at = now;
  loggedInAt.set(person.key, at);
  return at;
}
let discoveryOverrides = {};
let lastAuthorize = null;
setPeople([
  { key: "owner", email: process.env.STUB_OWNER_EMAIL ?? "ruben@example.org", email_verified: true, name: "Ruben Haas" },
  { key: "ayla", email: "ayla@office.example", email_verified: true, name: "Ayla Berg" },
  { key: "stranger", email: "stranger@elsewhere.example", email_verified: true, name: "Sam Stranger" },
  { key: "unverified", email: "jonas@office.example", email_verified: false, name: "Jonas Weiss (unverified)" },
]);

/** code → what was asked for. One use each. */
const codes = new Map();
/** access token → person key. */
const tokens = new Map();
const hits = { authorize: 0, token: 0, userinfo: 0, jwks: 0, discovery: 0 };

const b64url = (input) => Buffer.from(input).toString("base64url");

function idToken(person, nonce, authTime) {
  const now = Math.floor(Date.now() / 1000);
  const fault = person.fault;
  const claims = {
    iss: fault === "wrong_issuer" ? "https://somebody-else.example" : ISSUER,
    aud: fault === "wrong_audience" ? "some-other-client" : CLIENT_ID,
    sub: person.sub,
    iat: fault === "expired" ? now - 7200 : now,
    exp: fault === "expired" ? now - 3600 : now + 300,
    ...(nonce ? { nonce: fault === "wrong_nonce" ? "not-the-nonce-you-sent" : nonce } : {}),
    ...(person.no_auth_time || authTime === undefined ? {} : { auth_time: authTime }),
    ...(person.email === undefined || person.userinfo_only ? {} : { email: person.email }),
    ...(person.email_verified === undefined || person.userinfo_only ? {} : { email_verified: person.email_verified }),
    name: person.name,
    ...person.extra,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }))}.${b64url(JSON.stringify(claims))}`;
  const key = fault === "bad_signature" ? stranger.privateKey : privateKey;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key).toString("base64url");
  return `${signingInput}.${signature}`;
}

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const html = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Stand-in identity provider</title>
<style>body{font:16px/1.5 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem}a{display:block;margin:.5rem 0;padding:.7rem 1rem;border:2px solid #222;border-radius:.5rem;color:#222;text-decoration:none}a:hover{background:#f6c945}small{color:#666}</style>${body}`);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function authorize(url, res) {
  hits.authorize++;
  const q = url.searchParams;
  lastAuthorize = Object.fromEntries(q);
  const redirectUri = q.get("redirect_uri") ?? "";
  // Checked before anything is sent anywhere: an unregistered redirect must
  // never be redirected *to*, even with an error.
  if (q.get("client_id") !== CLIENT_ID) return html(res, 400, "<h1>Unknown client</h1>");
  if (!REDIRECT_URIS.includes(redirectUri)) {
    return html(res, 400, `<h1>Redirect not registered</h1><p><code>${esc(redirectUri)}</code> is not one of this client's redirect URIs.</p>`);
  }
  if (q.get("response_type") !== "code" || !q.get("state")) return html(res, 400, "<h1>Bad request</h1>");

  const as = q.get("as");
  if (!as) {
    const links = [...people.values()].map((p) => {
      const next = new URL(url); next.searchParams.set("as", p.key);
      return `<a href="${esc(next.pathname + next.search)}"><strong>${esc(p.name)}</strong><br><small>${esc(p.email ?? "no email")} · ${p.email_verified ? "verified" : "NOT verified"}${p.fault ? ` · fault: ${esc(p.fault)}` : ""}</small></a>`;
    }).join("");
    return html(res, 200, `<h1>Stand-in identity provider</h1><p>Not a real one — it exists for testing Pretty Please Print. Who is signing in?</p>${links}`);
  }
  const person = people.get(as);
  if (!person) return html(res, 400, "<h1>No such person</h1>");

  const code = randomBytes(24).toString("base64url");
  codes.set(code, {
    person: person.key,
    redirectUri,
    nonce: q.get("nonce"),
    challenge: q.get("code_challenge"),
    method: q.get("code_challenge_method"),
    authTime: authenticate(person, q),
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", q.get("state"));
  res.writeHead(302, { location: back.toString() });
  res.end();
}

async function token(req, res) {
  hits.token++;
  const form = new URLSearchParams(await readBody(req));
  let id = form.get("client_id"), secret = form.get("client_secret");
  const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (basic) {
    const [u, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    id = decodeURIComponent(u); secret = decodeURIComponent(rest.join(":"));
  }
  if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(res, 401, { error: "invalid_client" });

  const code = form.get("code") ?? "";
  const grant = codes.get(code);
  codes.delete(code); // one use, whether or not the rest checks out
  if (form.get("grant_type") !== "authorization_code" || !grant) return json(res, 400, { error: "invalid_grant" });
  if (form.get("redirect_uri") !== grant.redirectUri) return json(res, 400, { error: "invalid_grant" });
  if (grant.challenge) {
    const verifier = form.get("code_verifier") ?? "";
    const expected = grant.method === "plain" ? verifier : createHash("sha256").update(verifier).digest("base64url");
    if (expected !== grant.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
  }

  const person = people.get(grant.person);
  const access = randomBytes(24).toString("base64url");
  tokens.set(access, person.key);
  json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken(person, grant.nonce, grant.authTime), scope: "openid email profile" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  try {
    if (url.pathname === "/.well-known/openid-configuration") {
      hits.discovery++;
      // What the suite laid over it, if anything — a document that lies.
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        ...discoveryOverrides,
      });
    }
    if (url.pathname === "/jwks") { hits.jwks++; return json(res, 200, { keys: [JWK] }); }
    if (url.pathname === "/authorize" && req.method === "GET") return authorize(url, res);
    if (url.pathname === "/token" && req.method === "POST") return token(req, res);
    if (url.pathname === "/userinfo") {
      hits.userinfo++;
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      const person = bearer ? people.get(tokens.get(bearer[1])) : null;
      if (!person) return json(res, 401, { error: "invalid_token" });
      return json(res, 200, { sub: person.userinfo_sub ?? person.sub, email: person.email, email_verified: person.email_verified, name: person.name });
    }
    if (url.pathname === "/_people" && req.method === "POST") {
      setPeople(JSON.parse(await readBody(req)));
      return json(res, 200, { people: people.size });
    }
    if (url.pathname === "/_hits") return json(res, 200, hits);
    if (url.pathname === "/_discovery" && req.method === "POST") {
      discoveryOverrides = JSON.parse(await readBody(req));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/_last_authorize") return json(res, 200, lastAuthorize ?? {});
    if (url.pathname === "/_id_token") {
      const person = people.get(url.searchParams.get("as") ?? "");
      if (!person) return json(res, 404, { error: "no such person" });
      return json(res, 200, { id_token: idToken(person, url.searchParams.get("nonce"), authenticate(person, url.searchParams)) });
    }
    if (url.pathname === "/_reset" && req.method === "POST") {
      for (const k of Object.keys(hits)) hits[k] = 0;
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "the stand-in has nothing there" });
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, "0.0.0.0", () =>
  console.info(`oidc stand-in on :${PORT} (issuer ${ISSUER}, client ${CLIENT_ID}, redirects ${REDIRECT_URIS.join(" ")})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); process.exit(0); });

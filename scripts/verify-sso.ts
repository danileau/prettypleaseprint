/**
 * End-to-end check of single sign-on through an OpenID Connect provider.
 *
 *   npm run verify:sso
 *
 * Needs the app running with `AUTH_METHODS=local,oidc` and pointed at the
 * stand-in provider — `docker-compose.test.yml` does both, and
 * `scripts/stubs/oidc-stub.mjs` says why a stand-in rather than a real one.
 * Against a host-run app:
 *
 *   STUB_REDIRECT_URIS=http://localhost:3100/api/auth/callback/oidc \
 *     node scripts/stubs/oidc-stub.mjs &
 *   AUTH_METHODS=local,oidc OIDC_ISSUER=http://localhost:4020 OIDC_CLIENT_ID=ppp \
 *     OIDC_CLIENT_SECRET=ppp-stub-secret npm start
 *
 * Two halves. The rules in `src/lib/auth-methods.ts` are pure, so they are
 * checked in every mode a deployment can be put in — which a running stack,
 * being in exactly one, cannot do. Then the running app is driven through the
 * real redirects, and most of that is about who does *not* get in: a provider
 * is a second party with the power to say who somebody is, and what matters is
 * what the app does when it says so wrongly, unverifiably, or about a stranger.
 *
 * DESTRUCTIVE: wipes users, stories and invites. Development database only.
 */
import "./_env";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { db } from "../src/lib/db";
import {
  OIDC_CALLBACK_PATH,
  authMethods,
  disabledAuthPaths,
  mayProvision,
  oidcConfig,
} from "../src/lib/auth-methods";
import {
  CLOCK_SKEW_SECONDS,
  REAUTH_MAX_AGE_SECONDS,
  authTimeVerdict,
  normalIssuer,
  discoveryProblems,
  ssoAccountId,
  ssoAuthenticatedAt,
} from "../src/lib/oidc-flow";
import { FRESH_AUTH_SECONDS } from "../src/lib/auth-rules";
import { issuePasswordSetupUrl } from "../src/lib/password-reset";
import { seedAuthMethods, seedNormalIssuer } from "../prisma/auth-env";
import { TEST_PASSWORD, ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
/** The stand-in, as this machine reaches it. */
const STUB = process.env.OIDC_STUB_URL ?? "http://localhost:4020";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) => console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const throws = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return String((e as Error).message); }
  return "";
};

class Browser {
  jar = new Map<string, string>();
  private store(r: Response) {
    for (const line of r.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (!v || line.includes("Max-Age=0")) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async raw(url: string, init: RequestInit = {}) {
    const h: Record<string, string> = { origin: APP };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...h, ...(init.headers ?? {}) } });
    this.store(r);
    return r;
  }
  post(path: string, body: unknown) {
    return this.raw(APP + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  get signedIn() {
    return [...this.jar.keys()].some((k) => k.includes("session_token"));
  }
}

type Person = {
  key: string; sub?: string; email?: string; email_verified?: unknown; name?: string;
  fault?: string; extra?: Record<string, unknown>;
  session_age?: number; ignores_prompt?: boolean; no_auth_time?: boolean; clock_offset?: number;
  userinfo_only?: boolean; userinfo_sub?: string;
};
const setPeople = (people: Person[]) =>
  fetch(`${STUB}/_people`, { method: "POST", body: JSON.stringify(people) });

type Outcome = {
  /** Where the app sent the browser once the provider had answered. */
  landed: string;
  /** The `?error=` the sign-in page was given, if it was sent there. */
  error: string | null;
  browser: Browser;
  /** The callback URL the provider redirected to — for replaying. */
  callback: string;
  authorize: URL;
};

/**
 * Sign in through the provider as one of the people registered with it.
 *
 * Follows the three hops by hand: the app starts the flow and names the
 * provider's authorization URL, the provider redirects back with a code, and
 * the app's callback either opens a session or does not.
 */
async function sso(
  as: string, browser = new Browser(), callbackURL = "/board",
  { reauth = false }: { reauth?: boolean } = {},
): Promise<Outcome> {
  // Every run of this suite comes from one address, and the limiter counts by
  // address. It is not what is under test here; `verify:auth` owns that.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  // What the button on /reauth sends (src/components/sso-button.tsx).
  const start = await browser.post("/api/auth/sign-in/social", reauth
    ? { provider: "oidc", callbackURL, errorCallbackURL: `/reauth?next=${encodeURIComponent(callbackURL)}`, additionalData: { reauth: true } }
    : { provider: "oidc", callbackURL, errorCallbackURL: "/signin" });
  const body = await start.json().catch(() => ({}));
  if (!body.url) throw new Error(`the app would not start the flow: ${start.status} ${JSON.stringify(body)}`);

  const authorize = new URL(body.url);
  // The app knows the provider by its name on the compose network; this
  // machine reaches it on a published port. Same server, two addresses.
  const viaHost = new URL(authorize.pathname + authorize.search, STUB);
  viaHost.searchParams.set("as", as);
  const idp = await fetch(viaHost, { redirect: "manual" });
  const callback = idp.headers.get("location");
  if (!callback) throw new Error(`the stand-in did not redirect back: ${idp.status} ${(await idp.text()).slice(0, 200)}`);

  const done = await browser.raw(callback);
  const landed = done.headers.get("location") ?? `(${done.status}, no redirect)`;
  const error = landed.includes("error=") ? new URL(landed, APP).searchParams.get("error") : null;
  return { landed, error, browser, callback, authorize };
}

const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");
/** What a reader sees: no scripts (the RSC payload), no styles, no tags. */
const visibleText = (html: string) =>
  html.replace(/<script\b[\s\S]*?<\/script>/g, " ").replace(/<style\b[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function invite(email: string, adminId: string) {
  await db.invite.create({
    data: {
      email,
      tokenHash: randomBytes(32).toString("hex"),
      invitedById: adminId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
}
const setDiscovery = (overrides: Record<string, unknown>) =>
  fetch(`${STUB}/_discovery`, { method: "POST", body: JSON.stringify(overrides) });
const userByEmail = (email: string) => db.user.findUnique({ where: { email }, include: { accounts: true } });
const lastAudit = (action: string, subject: string) =>
  db.auditEvent.findFirst({ where: { action, subject }, orderBy: { at: "desc" } });

async function main() {
  // ── the rules, in every mode ─────────────────────────────────────────────
  section("which ways in are on");

  // With the variable really absent, not merely passed as undefined — that
  // would fall through to whatever this process has set.
  const configured = process.env.AUTH_METHODS;
  delete process.env.AUTH_METHODS;
  const whenUnset = JSON.stringify(authMethods());
  if (configured !== undefined) process.env.AUTH_METHODS = configured;
  check("unset is local only — an upgraded instance signs people in as it did",
        whenUnset === '{"local":true,"oidc":false}' &&
        JSON.stringify(authMethods("")) === '{"local":true,"oidc":false}', whenUnset);
  // The seed reads the same variable from an image with no src/
  // (prisma/auth-env.ts), and has to read it the same way: a blank
  // AUTH_METHODS read as single-sign-on-only would have it print a warning
  // instead of the owner's set-password link on a first deploy.
  const methodInputs = [undefined, "", "  ", "local", "oidc", " OIDC , local ", "local,oidc", "LOCAL"];
  const methodsDiffer = methodInputs.filter((v) => JSON.stringify(seedAuthMethods(v)) !== JSON.stringify(authMethods(v)));
  check("the seed reads AUTH_METHODS exactly as the app does — blank is local",
        methodsDiffer.length === 0, `differ on: ${methodsDiffer.map((v) => JSON.stringify(v)).join(", ")}`);
  check("both, in either order and any case",
        JSON.stringify(authMethods(" OIDC , local ")) === '{"local":true,"oidc":true}');
  check("single sign-on alone", JSON.stringify(authMethods("oidc")) === '{"local":false,"oidc":true}');
  const typo = throws(() => authMethods("oicd"));
  check("a misspelt method is an error naming the variable, not nobody-can-sign-in",
        typo.includes("AUTH_METHODS") && typo.includes("oicd"), typo || "no error");
  check("and so is a list with nothing in it", throws(() => authMethods(" , ")).includes("AUTH_METHODS"));

  section("a provider is configured completely or not at all");

  const full = {
    AUTH_METHODS: "local,oidc", OIDC_ISSUER: "https://id.example/realms/office/",
    OIDC_CLIENT_ID: "ppp", OIDC_CLIENT_SECRET: "s3cret",
  };
  check("off means no provider, whatever else is set", oidcConfig({ ...full, AUTH_METHODS: "local" }) === null);
  const cfg = oidcConfig(full);
  check("the discovery document is found from the issuer, trailing slash or not",
        cfg?.discoveryUrl === "https://id.example/realms/office/.well-known/openid-configuration", cfg?.discoveryUrl);
  check("new accounts need an invitation unless a host says otherwise", cfg?.signup === "invite");
  check("and the provider is not told to re-prompt unless a host says so", cfg?.prompt === undefined);
  for (const key of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const) {
    const message = throws(() => oidcConfig({ ...full, [key]: "  " }));
    check(`a missing ${key} is an error that names it`, message.includes(key), message || "no error");
  }
  check("an issuer over plain http is refused — it is where identities come from",
        throws(() => oidcConfig({ ...full, OIDC_ISSUER: "http://id.example" })).includes("https://"));
  check("loopback http is allowed, since it never leaves the machine",
        oidcConfig({ ...full, OIDC_ISSUER: "http://localhost:4020" })?.issuer === "http://localhost:4020");
  check("an issuer that is not a URL is refused by name",
        throws(() => oidcConfig({ ...full, OIDC_ISSUER: "id.example" })).includes("OIDC_ISSUER"));
  check("a misspelt sign-up mode is an error, not a quiet 'open'",
        throws(() => oidcConfig({ ...full, OIDC_SIGNUP: "opne" })).includes("OIDC_SIGNUP"));
  check("and so is a misspelt prompt", throws(() => oidcConfig({ ...full, OIDC_PROMPT: "always" })).includes("OIDC_PROMPT"));
  check("open sign-up has to be asked for by name", oidcConfig({ ...full, OIDC_SIGNUP: "open" })?.signup === "open");

  section("who may be given an account");

  const base = { invited: false, claimingLink: false, viaOidc: false, emailVerifiedByProvider: false, oidcSignup: null } as const;
  const verdict = (r: Partial<Parameters<typeof mayProvision>[0]>) => {
    const v = mayProvision({ ...base, ...r });
    return v.ok ? "ok" : v.reason;
  };
  check("local: an invitation and its link", verdict({ invited: true, claimingLink: true }) === "ok");
  check("local: an invited address without the link is refused (finding 10)",
        verdict({ invited: true }) === "no_link");
  check("local: no invitation is refused, link or not", verdict({ claimingLink: true }) === "no_invitation");
  check("sso: an invitation and a verified address",
        verdict({ invited: true, viaOidc: true, emailVerifiedByProvider: true, oidcSignup: "invite" }) === "ok");
  check("sso: an invited address the provider has not verified is refused",
        verdict({ invited: true, viaOidc: true, oidcSignup: "invite" }) === "unverified_email");
  check("sso: a verified stranger is refused while sign-up is by invitation",
        verdict({ viaOidc: true, emailVerifiedByProvider: true, oidcSignup: "invite" }) === "no_invitation");
  check("sso, open: a verified stranger is let in — that is what open means",
        verdict({ viaOidc: true, emailVerifiedByProvider: true, oidcSignup: "open" }) === "ok");
  check("sso, open: still not without a verified address",
        verdict({ invited: true, viaOidc: true, oidcSignup: "open" }) === "unverified_email");
  check("sso while it is switched off creates nobody, invited and verified or not",
        verdict({ invited: true, viaOidc: true, emailVerifiedByProvider: true, oidcSignup: null }) === "sso_off");
  check("a provider's word does not stand in for the link on the local path",
        verdict({ invited: true, emailVerifiedByProvider: true, oidcSignup: "open" }) === "no_link");

  section("a method that is off is off at the endpoint");

  const ssoOnly = disabledAuthPaths({ local: false, oidc: true });
  check("single sign-on only: passwords cannot be used, set or reset",
        ["/sign-in/username", "/sign-in/email", "/sign-up/email", "/reset-password"].every((p) => ssoOnly.includes(p)),
        ssoOnly.join(" "));
  check("nor passkeys registered or used",
        ["/passkey/verify-registration", "/passkey/verify-authentication"].every((p) => ssoOnly.includes(p)));
  check("and the provider's own endpoints stay open", !ssoOnly.includes("/sign-in/social"));
  const localOnly = disabledAuthPaths({ local: true, oidc: false });
  check("local only: the provider endpoints are closed and passwords are not",
        localOnly.includes("/sign-in/social") && !localOnly.includes("/sign-in/username"), localOnly.join(" "));
  check("Better Auth's own unlinking is closed in every mode — disconnecting is /me's, with a step-up",
        [ssoOnly, localOnly, disabledAuthPaths({ local: true, oidc: true })].every((l) => l.includes("/unlink-account")));
  check("linking an identity on request is closed where single sign-on is off",
        localOnly.includes("/link-social"));
  check("and open where it is on — for the owner alone, gated in the hook (below)",
        !ssoOnly.includes("/link-social") && !disabledAuthPaths({ local: true, oidc: true }).includes("/link-social"));

  section("a discovery document is believed only if it adds up");

  const goodDoc = {
    issuer: "https://id.example/realms/office",
    authorization_endpoint: "https://id.example/realms/office/auth",
    token_endpoint: "https://id.example/realms/office/token",
    userinfo_endpoint: "https://id.example/realms/office/userinfo",
    jwks_uri: "https://id.example/realms/office/certs",
  };
  const issuerHttps = "https://id.example/realms/office";
  check("a document for the configured issuer, all https, is fine",
        discoveryProblems(goodDoc, issuerHttps).length === 0, discoveryProblems(goodDoc, issuerHttps).join("; "));
  check("…with or without a trailing slash on either side",
        discoveryProblems({ ...goodDoc, issuer: `${issuerHttps}/` }, issuerHttps).length === 0);
  check("one naming another issuer is refused",
        discoveryProblems({ ...goodDoc, issuer: "https://elsewhere.example" }, issuerHttps).some((p) => p.includes("issuer")));
  check("and so is one naming none", discoveryProblems({ ...goodDoc, issuer: undefined }, issuerHttps).length > 0);
  for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri", "end_session_endpoint"] as const) {
    check(`an https issuer with a plain-http ${key} is refused`,
          discoveryProblems({ ...goodDoc, [key]: "http://id.example/x" }, issuerHttps).some((p) => p.includes(key)));
  }
  check("an issuer that is itself plain http (loopback, the stand-in) may have http endpoints",
        discoveryProblems({ issuer: "http://oidc-stub:4020", authorization_endpoint: "http://oidc-stub:4020/a",
                            token_endpoint: "http://oidc-stub:4020/t", jwks_uri: "http://oidc-stub:4020/j" },
                          "http://oidc-stub:4020").length === 0);
  check("a document with no keys to check tokens against is refused",
        discoveryProblems({ ...goodDoc, jwks_uri: undefined }, issuerHttps).some((p) => p.includes("jwks_uri")));

  section("an identity is filed under its issuer, and dated by it");

  check("issuer and subject together, not the subject alone",
        ssoAccountId("https://id.example/realms/office/", "42") === "https://id.example/realms/office|42");
  check("the same subject at two issuers is two identities",
        ssoAccountId("https://a.example", "42") !== ssoAccountId("https://b.example", "42"));
  check("one issuer, however it is spelt: case, default port, trailing slash",
        ssoAccountId("HTTPS://ID.Example:443/realms/office//", "42") === "https://id.example/realms/office|42" &&
        normalIssuer("http://oidc-stub:80/") === "http://oidc-stub");
  const issuerInputs = ["https://id.example/realms/office", "HTTPS://ID.Example:443/realms/office//", "http://oidc-stub:4020/",
                        "http://localhost:80", "https://id.example:8443/a/b/", "not a url/"];
  const issuersDiffer = issuerInputs.filter((v) => seedNormalIssuer(v) !== normalIssuer(v));
  check("and the seed spells an issuer exactly as the app does", issuersDiffer.length === 0, issuersDiffer.join(", "));
  check("but a different path is a different issuer",
        ssoAccountId("https://id.example/realms/other", "42") !== ssoAccountId("https://id.example/realms/office", "42"));
  const nowS = Math.floor(Date.now() / 1000);
  const at = (iat: number, authTime: unknown) => ({ iat, auth_time: authTime });
  check("a re-authentication seconds before the token was issued is fresh", authTimeVerdict(at(nowS, nowS - 5), nowS) === "fresh");
  check(`one ${REAUTH_MAX_AGE_SECONDS}+ seconds before it is not`,
        authTimeVerdict(at(nowS, nowS - REAUTH_MAX_AGE_SECONDS - 1), nowS) === "stale");
  check("measured on the provider's clock: four minutes ahead or behind, a fresh login is fresh",
        authTimeVerdict(at(nowS + 240, nowS + 238), nowS) === "fresh" && authTimeVerdict(at(nowS - 240, nowS - 242), nowS) === "fresh");
  check("and an old one on a clock running ahead is not made fresh by it",
        authTimeVerdict(at(nowS + 400, nowS), nowS) === "stale");
  check(`a token not issued within ${CLOCK_SKEW_SECONDS / 60} minutes of now by this clock is not believed`,
        authTimeVerdict(at(nowS - CLOCK_SKEW_SECONDS - 60, nowS - CLOCK_SKEW_SECONDS - 61), nowS) === "stale");
  check("nor one that says somebody authenticated after it was issued", authTimeVerdict(at(nowS, nowS + 30), nowS) === "stale");
  check("and one with no auth_time is not either — nothing to go on",
        authTimeVerdict({ iat: nowS }, nowS) === "missing" && authTimeVerdict(at(nowS, "1700000000"), nowS) === "missing");
  check("a session opened through the provider dates from how long before the token they authenticated",
        ssoAuthenticatedAt(at(nowS, nowS - 3600), nowS * 1000).getTime() === (nowS - 3600) * 1000);
  check("on the provider's clock: a login 400 s before the token, from a clock running ahead, is 400 s old",
        ssoAuthenticatedAt(at(nowS + 400, nowS), nowS * 1000).getTime() === (nowS - 400) * 1000);
  check("and without an auth_time it is too old to count as fresh",
        Date.now() - ssoAuthenticatedAt({ iat: nowS }, Date.now()).getTime() > FRESH_AUTH_SECONDS * 1000);

  // ── against the running app ──────────────────────────────────────────────
  section("setup");

  let stubUp = false;
  try { stubUp = (await fetch(`${STUB}/_hits`)).ok; } catch { /* reported below */ }
  if (!stubUp) {
    throw new Error(
      `The stand-in identity provider is not answering at ${STUB}.\n` +
        "Raise the stack with docker-compose.test.yml, or run node scripts/stubs/oidc-stub.mjs",
    );
  }

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.story.deleteMany();
  await db.verification.deleteMany();
  await db.session.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  // The owner starts as the seed leaves them: no identity at the provider.
  await db.account.deleteMany({ where: { userId: admin.id, providerId: "oidc" } });

  const signinPage = rendered(await (await new Browser().raw(`${APP}/signin`)).text());
  // The button's own text, between its tags: the page's RSC payload carries the
  // form's messages too, and "Sign in with {name}" there is not a button.
  const button = />\s*Sign in with ([^<{]+)</.exec(signinPage)?.[1]?.trim();
  if (!button || button === "a passkey") {
    throw new Error(
      "This app does not have single sign-on switched on, so there is nothing to verify.\n" +
        "Start it with AUTH_METHODS=local,oidc and the OIDC_* variables pointing at the stand-in\n" +
        "(docker-compose.test.yml sets them).",
    );
  }
  check("the sign-in page offers single sign-on, by the name the host gave it", button.length > 0, button);
  check("and still offers a password, because both are on",
        signinPage.includes('name="username"') && signinPage.includes('type="password"'));

  // Everybody the provider knows about for this run.
  const people: Person[] = [
    { key: "owner", email: admin.email, email_verified: true, name: "Somebody Else Entirely", extra: { role: "client" } },
    { key: "ayla", email: "ayla@office.example", email_verified: true, name: "Ayla Berg", extra: { role: "admin", groups: ["admins"], is_admin: true } },
    { key: "ayla-caps", sub: "sub-ayla", email: "Ayla@Office.Example", email_verified: true, name: "Ayla Berg" },
    { key: "stranger", email: "stranger@elsewhere.example", email_verified: true, name: "Sam Stranger" },
    { key: "jonas", email: "jonas@office.example", email_verified: false, name: "Jonas Weiss" },
    { key: "string-true", email: "mira@office.example", email_verified: "true", name: "Mira" },
    { key: "no-claim", email: "nils@office.example", name: "Nils" },
    { key: "no-email", email_verified: true, name: "Nobody" },
    { key: "petra", email: "petra@office.example", email_verified: true, name: "Petra From The Provider" },
    { key: "otto", email: "otto@office.example", email_verified: false, name: "Otto" },
    { key: "gone", email: "gone@office.example", email_verified: true, name: "Gone" },
    ...["bad_signature", "wrong_issuer", "wrong_audience", "wrong_nonce", "expired"].map((fault) => ({
      key: fault, email: `${fault.replace("_", "-")}@office.example`, email_verified: true, name: fault, fault,
    })),
  ];
  await setPeople(people);
  for (const email of [
    "ayla@office.example", "jonas@office.example", "mira@office.example", "nils@office.example",
    ...people.filter((p) => p.fault).map((p) => p.email!),
  ]) await invite(email, admin.id);

  // ── starting the flow ────────────────────────────────────────────────────
  section("the request the app sends to the provider");

  const first = await sso("ayla");
  const q = first.authorize.searchParams;
  check("it asks for a code, for this client", q.get("response_type") === "code" && q.get("client_id") === "ppp");
  check("to be sent back to this app's callback and nowhere else",
        q.get("redirect_uri") === APP + OIDC_CALLBACK_PATH, q.get("redirect_uri") ?? "");
  check("with a state, a nonce and a PKCE challenge",
        Boolean(q.get("state")) && Boolean(q.get("nonce")) && q.get("code_challenge_method") === "S256" && Boolean(q.get("code_challenge")),
        [...q.keys()].join(","));
  check("asking only for who somebody is", q.get("scope") === "openid email profile", q.get("scope") ?? "");

  // ── the invited ──────────────────────────────────────────────────────────
  section("an invited person signs in and has an account");

  check("they land where they were going, signed in", first.landed === "/board" && first.browser.signedIn, first.landed);
  const ayla = await userByEmail("ayla@office.example");
  check("an account exists for the invited address", Boolean(ayla));
  check("named as the provider named them", ayla?.name === "Ayla Berg" && ayla?.initials !== "??", `${ayla?.name} ${ayla?.initials}`);
  check("a client — nothing the provider claims makes anybody the owner",
        ayla?.role === "client" && (await db.user.count({ where: { role: "admin" } })) === 1, ayla?.role);
  check("recorded as invited by whoever invited them", ayla?.invitedById === admin.id);
  const link = ayla?.accounts.find((a) => a.providerId === "oidc");
  const issuer = String(((await (await fetch(`${STUB}/.well-known/openid-configuration`)).json()) as { issuer: string }).issuer);
  check("their identity at the provider — issuer and subject — is what opens it",
        link?.accountId === ssoAccountId(issuer, "sub-ayla"), link?.accountId);
  check("and none of the provider's tokens were kept",
        link !== undefined && link.accessToken === null && link.refreshToken === null && link.idToken === null,
        JSON.stringify({ a: link?.accessToken, r: link?.refreshToken, i: link?.idToken }));
  check("they have no password, and no username to be asked for",
        ayla?.username === null && !ayla?.accounts.some((a) => a.providerId === "credential"));
  const used = await db.invite.findFirst({ where: { email: "ayla@office.example" } });
  check("the invitation is spent", used?.acceptedAt !== null);
  check("the trail says the invitation was accepted",
        Boolean(await lastAudit("invite.accepted", "ayla@office.example")));
  check("and that an identity at the provider now opens the account",
        ((await lastAudit("auth.sso_linked", "ayla@office.example"))?.detail as { role?: string } | null)?.role === "client");
  const mine = await first.browser.raw(`${APP}/api/stories`);
  check("the session is a real one", mine.status === 200, `status ${mine.status}`);

  const usersBefore = await db.user.count();
  const second = await sso("ayla");
  check("signing in again is the same account, not a second one",
        second.landed === "/board" && (await db.user.count()) === usersBefore &&
        (await db.account.count({ where: { userId: ayla!.id } })) === 1);
  check("and is not recorded as a new way in",
        (await db.auditEvent.count({ where: { action: "auth.sso_linked", subject: "ayla@office.example" } })) === 1);
  const caps = await sso("ayla-caps");
  check("the same identity is the same account however the provider cases the address",
        caps.landed === "/board" && (await db.user.count()) === usersBefore);

  const deep = await sso("ayla", new Browser(), "/history");
  check("they are returned to the page they asked for", deep.landed === "/history", deep.landed);

  // ── the uninvited ────────────────────────────────────────────────────────
  section("the provider vouching for somebody does not invite them");

  const stranger = await sso("stranger");
  check("a verified stranger is sent back to sign-in", stranger.error === "invite_required" && !stranger.browser.signedIn, stranger.landed);
  check("with no account created", (await userByEmail("stranger@elsewhere.example")) === null);
  const refused = await lastAudit("invite.rejected", "stranger@elsewhere.example");
  check("and the trail says why, and by which door",
        (refused?.detail as { reason?: string; via?: string } | null)?.reason === "no_invitation" &&
        (refused?.detail as { via?: string } | null)?.via === "oidc", JSON.stringify(refused?.detail));
  const told = rendered(await (await new Browser().raw(APP + stranger.landed)).text());
  check("the page they land on says it is invite-only", told.includes("has not been invited"));

  section("an address is only as good as the provider's word for it");

  for (const [key, email, why] of [
    ["jonas", "jonas@office.example", "an invited address the provider has not verified"],
    ["string-true", "mira@office.example", 'the string "true" where a boolean belongs'],
    ["no-claim", "nils@office.example", "no verification claim at all"],
  ] as const) {
    const out = await sso(key);
    const pending = await db.invite.findFirst({ where: { email } });
    check(`${why}: nobody is signed in, no account, invitation untouched`,
          !out.browser.signedIn && out.error === "email_not_verified" && (await userByEmail(email)) === null && pending?.acceptedAt === null,
          `${out.landed} | accepted ${pending?.acceptedAt}`);
    check("…and the trail calls it unverified",
          ((await lastAudit("invite.rejected", email))?.detail as { reason?: string } | null)?.reason === "unverified_email");
  }
  const unverifiedStranger: Person = { key: "unverified-stranger", email: "nobody@elsewhere.example", email_verified: false, name: "N" };
  await setPeople([...people, unverifiedStranger]);
  const us = await sso("unverified-stranger");
  check("an uninvited unverified address gets the very same answer — it says nothing about who is invited",
        us.error === "email_not_verified" && (await userByEmail("nobody@elsewhere.example")) === null, us.landed);
  check("and the page says it is the address that needs verifying",
        rendered(await (await new Browser().raw(APP + us.landed)).text()).includes("has not confirmed your email address"));
  const noEmail = await sso("no-email");
  check("a provider that shares no address signs nobody in",
        !noEmail.browser.signedIn && noEmail.error !== null && (await db.user.count()) === usersBefore, noEmail.landed);

  // ── forged and misdirected tokens ────────────────────────────────────────
  section("a token is believed only if it checks out");

  for (const [fault, why] of [
    ["bad_signature", "signed by a key the provider never published"],
    ["wrong_issuer", "issued by somebody else"],
    ["wrong_audience", "issued for a different app"],
    ["wrong_nonce", "not bound to the request that asked for it"],
    ["expired", "already expired"],
  ] as const) {
    const email = `${fault.replace("_", "-")}@office.example`;
    const out = await sso(fault);
    check(`${why}: refused, and no account for the invited address it names`,
          !out.browser.signedIn && out.error !== null && (await userByEmail(email)) === null,
          `${out.landed} | user ${Boolean(await userByEmail(email))}`);
  }

  section("the callback cannot be replayed or borrowed");

  const fresh = await sso("ayla");
  const replay = await new Browser().raw(fresh.callback);
  const replayTo = replay.headers.get("location") ?? "";
  check("another browser replaying the provider's redirect gets no session",
        !replay.headers.getSetCookie().some((c) => c.includes("session_token=") && !c.includes("Max-Age=0")) && /error/.test(replayTo),
        `${replay.status} ${replayTo}`);
  const again = await fresh.browser.raw(fresh.callback);
  check("and the same browser cannot use it twice", /error/.test(again.headers.get("location") ?? ""),
        `${again.status} ${again.headers.get("location")}`);
  const forged = new URL(fresh.callback);
  forged.searchParams.set("state", "x".repeat(32));
  const forgedRes = await new Browser().raw(forged.toString());
  check("a callback with a state nobody issued is refused",
        /error/.test(forgedRes.headers.get("location") ?? "") || forgedRes.status >= 400,
        `${forgedRes.status} ${forgedRes.headers.get("location")}`);

  const away = await new Browser().post("/api/auth/sign-in/social", {
    provider: "oidc", callbackURL: "https://evil.example/landing", errorCallbackURL: "/signin",
  });
  check("the flow cannot be started with somewhere else to land", away.status === 403, `status ${away.status}`);
  const other = await new Browser().post("/api/auth/sign-in/social", { provider: "github", callbackURL: "/board" });
  check("nor with a provider this deployment did not configure", other.status >= 400, `status ${other.status}`);
  const linkSocial = await first.browser.post("/api/auth/link-social", { provider: "oidc", callbackURL: "/board" });
  check("a signed-in member cannot attach an identity on request", linkSocial.status === 403 && !(await linkSocial.json().catch(() => ({}))).url,
        `status ${linkSocial.status}`);

  // ── people who already have an account ───────────────────────────────────
  section("somebody with a password signs in through the provider");

  const petra = await db.user.create({
    data: { email: "petra@office.example", name: "Petra Lang", initials: "PL",
            role: "client", emailVerified: true, invitedById: admin.id },
  });
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, petra.id, usernameFor(petra.email));
  const countBefore = await db.user.count();
  const linked = await sso("petra");
  const petraNow = await userByEmail("petra@office.example");
  check("they land in the account they already had",
        linked.landed === "/board" && petraNow?.id === petra.id && (await db.user.count()) === countBefore, linked.landed);
  check("which keeps its name, username and role — the provider's are not copied over",
        petraNow?.name === "Petra Lang" && petraNow?.username === "petra" && petraNow?.role === "client",
        `${petraNow?.name} ${petraNow?.username}`);
  check("the new way in is on the trail", Boolean(await lastAudit("auth.sso_linked", "petra@office.example")));
  const pw = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  check("and their password still works", (await signInWithPassword(pw, APP, "petra", TEST_PASSWORD)).status === 200 && pw.signedIn);

  const otto = await db.user.create({
    data: { email: "otto@office.example", name: "Otto Kern", initials: "OK",
            role: "client", emailVerified: true, invitedById: admin.id },
  });
  const unlinked = await sso("otto");
  check("an existing account is NOT opened by an address the provider has not verified",
        !unlinked.browser.signedIn && unlinked.error !== null, unlinked.landed);
  check("and the answer is the very one an address nobody here has gets — it does not say who is a member",
        unlinked.error === "email_not_verified" && unlinked.landed === us.landed, `${unlinked.landed} vs ${us.landed}`);
  check("and gains no identity at the provider",
        (await db.account.count({ where: { userId: otto.id, providerId: "oidc" } })) === 0);
  const signinText = async (landed: string) => visibleText(await (await new Browser().raw(APP + landed)).text());
  check("the page says what to do about it, in the same words",
        (await signinText(unlinked.landed)).includes("has not confirmed your email address") &&
        (await signinText(unlinked.landed)) === (await signinText(us.landed)));
  const unlinkedCode = await new Browser().raw(`${APP}/signin?error=account_not_linked`);
  check("even a link that names Better Auth's other code gets the same sentence",
        (await signinText("/signin?error=account_not_linked")) === (await signinText("/signin?error=email_not_verified")),
        `status ${unlinkedCode.status}`);

  section("the printer owner is never linked implicitly");

  const ownerLinks = () => db.account.count({ where: { userId: admin.id, providerId: "oidc" } });
  const implicit = await sso("owner");
  check("a provider asserting the owner's verified address opens nothing",
        !implicit.browser.signedIn && (await ownerLinks()) === 0, implicit.landed);
  check("and is told exactly what a stranger is told — it does not say whose address it was",
        implicit.landed === stranger.landed, `${implicit.landed} vs ${stranger.landed}`);
  check("the refusal is on the trail", Boolean(await lastAudit("auth.sso_link_refused", admin.email)));

  section("the owner connects the provider on purpose, from /me");

  const ownerUsername = usernameFor(admin.email);
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, admin.id, ownerUsername);
  const deskSignIn = async () => {
    const b = new Browser();
    await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
    await signInWithPassword(b, APP, ownerUsername);
    return b;
  };
  const desk = await deskSignIn();
  check("the owner signs in with their password", desk.signedIn);

  /** The id of the server action behind the form whose button says `label`. */
  const actionIn = (html: string, label: string) => {
    const form = (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((f) => visibleText(f).includes(label));
    return form ? /name="(\$ACTION_ID_[^"]+)"/.exec(form)?.[1] ?? null : null;
  };
  const submit = (b: Browser, action: string) => {
    const fd = new FormData();
    fd.set(action, "");
    return b.raw(`${APP}/me`, { method: "POST", body: fd });
  };
  /** The provider's half of a flow the app has started, as `as`; then the callback. */
  const throughProvider = async (b: Browser, authorizeUrl: string, as: string) => {
    const authorize = new URL(authorizeUrl);
    const viaHost = new URL(authorize.pathname + authorize.search, STUB);
    viaHost.searchParams.set("as", as);
    const back = (await fetch(viaHost, { redirect: "manual" })).headers.get("location");
    const done = back ? await b.raw(back) : null;
    return { authorize, landed: done?.headers.get("location") ?? `(${done?.status ?? "no callback"})` };
  };

  const connectLabel = `Connect ${button}`;
  const mePage = await (await desk.raw(`${APP}/me`)).text();
  const connectAction = actionIn(mePage, connectLabel);
  check("/me says the provider is not connected, and offers to connect it",
        visibleText(mePage).includes("Not connected") && connectAction !== null, visibleText(mePage).slice(0, 300));

  const memberTry = await first.browser.post("/api/auth/link-social", { provider: "oidc", callbackURL: "/me" });
  check("a member asking to connect is refused", memberTry.status === 403, `status ${memberTry.status}`);

  await db.session.updateMany({ where: { userId: admin.id }, data: { createdAt: ago(30) } });
  const staleTry = await desk.post("/api/auth/link-social", { provider: "oidc", callbackURL: "/me" });
  check("the owner on a session half an hour old is refused at the endpoint", staleTry.status === 403, `status ${staleTry.status}`);
  const staleAction = connectAction ? await submit(desk, connectAction) : null;
  check("and the button sends them to confirm it is them first",
        (staleAction?.headers.get("location") ?? "").startsWith("/reauth?next=%2Fme") && (await ownerLinks()) === 0,
        `${staleAction?.status} ${staleAction?.headers.get("location")}`);

  // The flow is bound to who started it: a browser holding the owner's flow
  // but somebody else's session gets nothing linked to anybody.
  const started = await deskSignIn();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const startRes = await started.post("/api/auth/link-social", { provider: "oidc", callbackURL: "/me", errorCallbackURL: "/me?sso=failed" });
  const startUrl = ((await startRes.json().catch(() => ({}))) as { url?: string }).url;
  const swapped = new Browser();
  for (const [k, v] of first.browser.jar) swapped.jar.set(k, v);
  for (const [k, v] of started.jar) if (!k.includes("session")) swapped.jar.set(k, v);
  const swappedOut = startUrl ? await throughProvider(swapped, startUrl, "owner") : null;
  check("a connection finished in a browser signed in as somebody else links nothing",
        startUrl !== undefined && (await ownerLinks()) === 0 && /error=/.test(swappedOut?.landed ?? ""),
        `${startRes.status} ${swappedOut?.landed}`);

  await setDiscovery({ issuer: "https://somebody-else.example" });
  const whileDown = await deskSignIn();
  const downAction = actionIn(await (await whileDown.raw(`${APP}/me`)).text(), connectLabel);
  const down = downAction ? await submit(whileDown, downAction) : null;
  await setDiscovery({});
  check("while the provider cannot be trusted, the button comes back to /me and says so — not an error page",
        down?.headers.get("location") === "/me?sso=unavailable" && (await ownerLinks()) === 0,
        `${down?.status} ${down?.headers.get("location")}`);
  check("in words",
        visibleText(await (await whileDown.raw(`${APP}/me?sso=unavailable`)).text()).includes("could not be reached to connect it"));

  const fresh2 = await deskSignIn();
  const action2 = actionIn(await (await fresh2.raw(`${APP}/me`)).text(), connectLabel);
  const go = action2 ? await submit(fresh2, action2) : null;
  const toProvider = go?.headers.get("location") ?? "";
  check("on a fresh sign-in, the button goes to the provider", toProvider.includes("/authorize?"),
        `${go?.status} ${toProvider.slice(0, 120)}`);
  const connected = toProvider.includes("/authorize?") ? await throughProvider(fresh2, toProvider, "owner") : null;
  check("asking it for a fresh login", connected?.authorize.searchParams.get("prompt") === "login" &&
        connected?.authorize.searchParams.get("max_age") === "0");
  check("and comes back to /me, connected", connected?.landed === "/me?sso=connected" && (await ownerLinks()) === 1,
        connected?.landed);
  check("which the trail records as connected on purpose, with the role",
        ((await lastAudit("auth.sso_linked", admin.email))?.detail as { how?: string; role?: string } | null)?.how === "connected" &&
        ((await lastAudit("auth.sso_linked", admin.email))?.detail as { role?: string } | null)?.role === "admin");
  check("/me now says so", visibleText(await (await fresh2.raw(`${APP}/me`)).text()).includes(`Connected to ${button}`));
  const unlinkTry = await fresh2.post("/api/auth/unlink-account", { providerId: "oidc" });
  check("Better Auth's own unlinking answers 404, and the link stays",
        unlinkTry.status === 404 && (await ownerLinks()) === 1, `status ${unlinkTry.status}`);
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const relink = await fresh2.post("/api/auth/link-social", { provider: "oidc", callbackURL: "/me" });
  check("and connecting again once connected is refused", relink.status === 409, `status ${relink.status}`);

  const owner = await sso("owner");
  const adminNow = await db.user.findUnique({ where: { id: admin.id }, include: { accounts: true } });
  check("from then on the owner signs in through the provider",
        owner.landed === "/board" && owner.browser.signedIn, owner.landed);
  check("and is still the owner, under their own name — a `role` claim changes nothing",
        adminNow?.role === "admin" && adminNow?.name === admin.name, `${adminNow?.role} ${adminNow?.name}`);
  const guests = await owner.browser.raw(`${APP}/admin/invites`);
  check("a sign-in moments old is fresh enough for the guest list", guests.status === 200, `status ${guests.status}`);

  section("confirming it is still you");

  // `/reauth` passes a recent sign-in straight through and stops an old one —
  // which makes it the place to see what the app thinks of this session.
  const passes = async (b: Browser) => {
    const r = await b.raw(`${APP}/reauth?next=/admin/invites`);
    return r.status === 307 && r.headers.get("location") === "/admin/invites";
  };
  check("a sign-in through the provider moments ago needs no confirming", await passes(owner.browser));
  await db.session.updateMany({ where: { userId: admin.id }, data: { createdAt: ago(30) } });
  check("half an hour later it does", !(await passes(owner.browser)));
  const reauth = rendered(await (await owner.browser.raw(`${APP}/reauth?next=/admin/invites`)).text());
  check("and single sign-on is one of the ways to", new RegExp(`Confirm with ${button}`).test(reauth), "no SSO button on /reauth");
  // What the button on /reauth does: a re-authentication, which asks the
  // provider for a fresh login (see "confirming it is still you means signing
  // in again" below).
  const reproved = await sso("owner", owner.browser, "/admin/invites", { reauth: true });
  check("signing in again there is what makes it fresh",
        reproved.landed === "/admin/invites" && (await passes(owner.browser)), reproved.landed);

  await db.session.updateMany({ where: { userId: ayla!.id }, data: { createdAt: ago(30) } });
  const aylaReauth = rendered(await (await first.browser.raw(`${APP}/reauth?next=/board`)).text());
  check("somebody who has only ever used single sign-on is offered it to confirm with",
        new RegExp(`Confirm with ${button}`).test(aylaReauth), "no SSO button for an SSO-only account");
  check("and is not shown a password box they have no password for",
        !aylaReauth.includes('type="password"'), "password field shown to an SSO-only account");

  section("access taken away stays taken away");

  const gone = await db.user.create({
    data: { email: "gone@office.example", name: "Gone Person", initials: "GP", role: "client",
            emailVerified: true, invitedById: admin.id, banned: true, banReason: "left the office" },
  });
  const banned = await sso("gone");
  check("a suspended person is not signed in by the provider",
        !banned.browser.signedIn && (await db.session.count({ where: { userId: gone.id } })) === 0, banned.landed);

  section("the invitation page");

  const token = randomBytes(24).toString("base64url");
  const { createHash } = await import("node:crypto");
  await db.invite.create({
    data: { email: "lena@office.example", tokenHash: createHash("sha256").update(token).digest("hex"),
            invitedById: admin.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const invitePage = rendered(await (await new Browser().raw(`${APP}/invite/${token}`)).text());
  check("offers single sign-on, and says which address the invitation is for",
        new RegExp(`Continue with ${button}`).test(invitePage) && invitePage.includes("lena@office.example"),
        "no SSO option on the invitation page");
  check("alongside choosing a password, because both are on", invitePage.includes('type="password"'));

  // ── what the review of this feature found ────────────────────────────────
  section("an ID token on its own signs nobody in");

  // `/sign-in/social` will sign somebody in on a posted ID token, with no
  // state, no PKCE and no nonce unless the caller offers one. Anything that
  // ever held a token this provider issued for this app could replay it.
  const minted = ((await (await fetch(`${STUB}/_id_token?as=ayla`)).json()) as { id_token: string }).id_token;
  for (const [why, idToken] of [
    ["a valid ID token, posted", { token: minted }],
    ["…with an access token for the userinfo lookup beside it", { token: minted, accessToken: "whatever-the-caller-likes" }],
  ] as const) {
    const b = new Browser();
    await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
    const r = await b.post("/api/auth/sign-in/social", { provider: "oidc", idToken, callbackURL: "/board" });
    check(`${why}: refused, and no session`, r.status === 404 && !b.signedIn, `status ${r.status}`);
  }

  section("confirming it is still you means signing in again");

  const reauthPeople: Person[] = [
    // Signed in at the provider an hour ago, and it honours prompt=login.
    { key: "rhea", email: "rhea@office.example", email_verified: true, name: "Rhea", session_age: 3600 },
    // Signed in an hour ago, and it answers from that session whatever it is asked.
    { key: "vince", email: "vince@office.example", email_verified: true, name: "Vince", session_age: 3600, ignores_prompt: true },
    // Never says when anybody authenticated.
    { key: "nadia", email: "nadia@office.example", email_verified: true, name: "Nadia", no_auth_time: true },
  ];
  await setPeople([...people, ...reauthPeople]);
  for (const p of reauthPeople) await invite(p.email!, admin.id);

  const rhea = await sso("rhea");
  check("a sign-in the provider answers from its session signs them in",
        rhea.landed === "/board" && rhea.browser.signedIn, rhea.landed);
  const rheaRow = await db.session.findFirst({ where: { user: { email: "rhea@office.example" } }, orderBy: { updatedAt: "desc" } });
  check("but the session dates from when they really authenticated — an hour ago",
        rheaRow !== null && Date.now() - rheaRow.createdAt.getTime() > 3500_000, String(rheaRow?.createdAt));
  check("so it is not fresh enough to move access around", !(await passes(rhea.browser)));
  const rheaAgain = await sso("rhea", rhea.browser, "/admin/invites", { reauth: true });
  const asked = rheaAgain.authorize.searchParams;
  check("confirming it asks the provider for a fresh login", asked.get("prompt") === "login" && asked.get("max_age") === "0",
        `prompt=${asked.get("prompt")} max_age=${asked.get("max_age")}`);
  check("and a provider that does log them in again makes it fresh",
        rheaAgain.landed === "/admin/invites" && (await passes(rhea.browser)), rheaAgain.landed);

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const overriding = await new Browser().post("/api/auth/sign-in/social", {
    provider: "oidc", callbackURL: "/board", additionalData: { reauth: true },
    additionalParams: { prompt: "none", max_age: "86400" },
  });
  const overURL = new URL(((await overriding.json()) as { url?: string }).url ?? "http://x/");
  check("the page cannot ask for anything gentler: the server sets prompt and max_age",
        overURL.searchParams.get("prompt") === "login" && overURL.searchParams.get("max_age") === "0", overURL.search);
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const gentler = await new Browser().post("/api/auth/sign-in/social", {
    provider: "oidc", callbackURL: "/board",
    additionalParams: { prompt: "none", max_age: "86400", acr_values: "anything-goes" },
  });
  const gentlerURL = new URL(((await gentler.json()) as { url?: string }).url ?? "http://x/");
  // The stack sets no OIDC_PROMPT, so the configured prompt is none at all.
  const configuredPrompt = process.env.OIDC_PROMPT?.trim().toLowerCase() || null;
  check("nor can an ordinary sign-in: what the request asks for is dropped, and the configured prompt is what is sent",
        gentlerURL.searchParams.get("prompt") === configuredPrompt && !gentlerURL.searchParams.has("max_age") &&
        !gentlerURL.searchParams.has("acr_values"), gentlerURL.search);

  const vince = await sso("vince");
  const vinceUser = await userByEmail("vince@office.example");
  const vinceSessions = await db.session.count({ where: { userId: vinceUser!.id } });
  const vinceAgain = await sso("vince", vince.browser, "/admin/invites", { reauth: true });
  check("a provider that answers a re-authentication from its old session is refused",
        vinceAgain.landed.startsWith("/reauth?") && vinceAgain.error !== null &&
        (await db.session.count({ where: { userId: vinceUser!.id } })) === vinceSessions,
        vinceAgain.landed);
  check("and it is still not fresh", !(await passes(vince.browser)));
  const vincePage = visibleText(await (await vince.browser.raw(APP + vinceAgain.landed)).text());
  check("the page says it has to ask again, rather than nothing",
        vincePage.includes("it has to ask you to sign in there again"), vincePage.slice(0, 300));

  const nadia = await sso("nadia");
  check("a provider that never says when somebody authenticated signs them in…", nadia.browser.signedIn, nadia.landed);
  check("…but never freshly", !(await passes(nadia.browser)));
  const nadiaUser = await userByEmail("nadia@office.example");
  const nadiaSessions = await db.session.count({ where: { userId: nadiaUser!.id } });
  const nadiaAgain = await sso("nadia", nadia.browser, "/admin/invites", { reauth: true });
  check("and cannot confirm it is them: no auth_time, no confirmation",
        nadiaAgain.error !== null && (await db.session.count({ where: { userId: nadiaUser!.id } })) === nadiaSessions &&
        !(await passes(nadia.browser)), nadiaAgain.landed);

  section("how long ago is measured on the provider's clock");

  const clockPeople: Person[] = [
    { key: "clara", email: "clara@office.example", email_verified: true, name: "Clara", clock_offset: 240 },
    { key: "cleo", email: "cleo@office.example", email_verified: true, name: "Cleo", clock_offset: -240 },
    { key: "chad", email: "chad@office.example", email_verified: true, name: "Chad", clock_offset: 400, session_age: 400 },
  ];
  await setPeople([...people, ...reauthPeople, ...clockPeople]);
  for (const p of clockPeople) await invite(p.email!, admin.id);
  for (const [key, why] of [["clara", "four minutes ahead"], ["cleo", "four minutes behind"]] as const) {
    const first = await sso(key);
    const again = await sso(key, first.browser, "/admin/invites", { reauth: true });
    check(`a provider whose clock is ${why}: a fresh login confirms it is them`,
          again.landed === "/admin/invites" && (await passes(first.browser)), again.landed);
  }
  const chad = await sso("chad");
  check("and a login 400 seconds old on a clock 400 seconds ahead is not taken for a fresh one",
        chad.browser.signedIn && !(await passes(chad.browser)), chad.landed);

  section("a different provider is not the old one");

  // Linked when identities were filed under the subject alone — what a
  // previous provider's `sub-collide` would have been stored as.
  const carla = await db.user.create({
    data: { email: "carla@office.example", name: "Carla Old", initials: "CO", role: "client",
            emailVerified: true, invitedById: admin.id },
  });
  await db.account.create({ data: { userId: carla.id, providerId: "oidc", accountId: "sub-collide" } });
  await setPeople([...people, ...reauthPeople,
    { key: "collide", sub: "sub-collide", email: "newcomer@elsewhere.example", email_verified: true, name: "Newcomer" }]);
  const collide = await sso("collide");
  const carlaSessions = await db.session.count({ where: { userId: carla.id } });
  check("somebody who shares a subject with an old identity does not land in its account",
        carlaSessions === 0 && collide.error === "invite_required", `${collide.landed} | Carla's sessions ${carlaSessions}`);

  section("the provider's picture is not kept");

  await setPeople([...people, { key: "pia", email: "pia@office.example", email_verified: true, name: "Pia",
                                extra: { picture: "https://tracker.example/pixel.png" } }]);
  await invite("pia@office.example", admin.id);
  const pia = await sso("pia");
  const piaUser = await userByEmail("pia@office.example");
  check("a new account from a profile with a picture has no image", pia.browser.signedIn && piaUser?.image === null,
        `${pia.landed} | image ${piaUser?.image}`);

  section("userinfo is about the same person as the token");

  await setPeople([...people,
    { key: "uma", email: "uma@office.example", email_verified: true, name: "Uma", userinfo_only: true },
    { key: "ulf", email: "ulf@office.example", email_verified: true, name: "Ulf", userinfo_only: true, userinfo_sub: "sub-somebody-else" },
  ]);
  await invite("uma@office.example", admin.id);
  await invite("ulf@office.example", admin.id);
  const uma = await sso("uma");
  check("a provider that keeps the address to userinfo still signs people in", uma.landed === "/board" && uma.browser.signedIn, uma.landed);
  const ulf = await sso("ulf");
  check("but not when userinfo answers for another subject", !ulf.browser.signedIn && (await userByEmail("ulf@office.example")) === null,
        ulf.landed);

  section("a discovery document that lies is not believed");

  await setDiscovery({ issuer: "https://somebody-else.example" });
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const lying = await new Browser().post("/api/auth/sign-in/social", { provider: "oidc", callbackURL: "/board", errorCallbackURL: "/signin" });
  const lyingBody = (await lying.json().catch(() => ({}))) as { url?: string };
  check("a document naming another issuer: the flow does not start", lying.status === 503 && !lyingBody.url, `status ${lying.status}`);
  await setDiscovery({});
  const honest = await sso("uma");
  check("and once it is honest again, it does", honest.browser.signedIn, honest.landed);

  section("the owner can disconnect the provider again");

  const leaving = await deskSignIn();
  const disconnectLabel = `Disconnect ${button}`;
  const disconnectAction = actionIn(await (await leaving.raw(`${APP}/me`)).text(), disconnectLabel);
  check("/me offers to disconnect it", disconnectAction !== null);
  await db.session.updateMany({ where: { userId: admin.id }, data: { createdAt: ago(30) } });
  const staleOff = disconnectAction ? await submit(leaving, disconnectAction) : null;
  check("not on a stale sign-in: they confirm it is them first",
        (staleOff?.headers.get("location") ?? "").startsWith("/reauth?next=%2Fme") && (await ownerLinks()) === 1,
        `${staleOff?.status} ${staleOff?.headers.get("location")}`);
  const leaving2 = await deskSignIn();
  const off = disconnectAction ? await submit(leaving2, actionIn(await (await leaving2.raw(`${APP}/me`)).text(), disconnectLabel)!) : null;
  check("on a fresh one it is gone", off?.headers.get("location") === "/me?sso=disconnected" && (await ownerLinks()) === 0,
        `${off?.status} ${off?.headers.get("location")}`);
  check("and the trail says so", Boolean(await lastAudit("auth.sso_unlinked", admin.email)));
  const afterOff = await sso("owner");
  check("after which the provider opens nothing again", !afterOff.browser.signedIn, afterOff.landed);

  const staleOwner = await deskSignIn();
  await db.session.updateMany({ where: { userId: admin.id }, data: { createdAt: ago(30) } });
  const ownerReauth = visibleText(await (await staleOwner.raw(`${APP}/reauth?next=/admin/invites`)).text());
  check("an owner who has not connected the provider is not offered it to confirm with",
        !ownerReauth.includes(`Confirm with ${button}`) && ownerReauth.includes("Is that still you?"), ownerReauth.slice(0, 300));

  // A link from before OIDC_ISSUER changed: filed under the old issuer, it
  // opens nothing, so it must not make the owner look connected.
  await db.account.create({ data: { userId: admin.id, providerId: "oidc", accountId: "https://old-provider.example|sub-owner" } });
  const afterMove = await deskSignIn();
  const movedMe = visibleText(await (await afterMove.raw(`${APP}/me`)).text());
  check("a link to a provider this instance no longer uses does not count as connected",
        movedMe.includes("Not connected") && !movedMe.includes(`Connected to ${button}`), movedMe.slice(0, 300));
  await db.account.deleteMany({ where: { userId: admin.id, providerId: "oidc" } });

  section("with passwords off, the server refuses them too");

  // The stack runs both ways in, so the other mode's server side is driven in
  // a child process with AUTH_METHODS=oidc: scripts/passwords-off-probe.ts.
  const probeEmail = "probe@office.example";
  const probeToken = randomBytes(24).toString("base64url");
  const { createHash: sha } = await import("node:crypto");
  await db.invite.create({
    data: { email: probeEmail, tokenHash: sha("sha256").update(probeToken).digest("hex"),
            invitedById: admin.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const quinn = await db.user.create({
    data: { email: "quinn@office.example", name: "Quinn", initials: "QU", role: "client", emailVerified: true, invitedById: admin.id },
  });
  const resetToken = new URL(await issuePasswordSetupUrl(quinn.id)).searchParams.get("token")!;
  const resetRows = () => db.verification.count({ where: { value: quinn.id } });
  const quinnLink = await db.account.create({ data: { userId: quinn.id, providerId: "oidc", accountId: "probe|sub-quinn" } });
  const rowsBefore = await resetRows();
  const stdout = execFileSync("node_modules/.bin/tsx", ["--import", "./scripts/_server-only.mjs", "scripts/passwords-off-probe.ts"], {
    encoding: "utf8",
    env: {
      ...process.env, AUTH_METHODS: "oidc", OIDC_ISSUER: STUB, OIDC_CLIENT_ID: "ppp", OIDC_CLIENT_SECRET: "ppp-stub-secret",
      PROBE_ACCOUNT_ID: quinnLink.id, PROBE_INVITE_TOKEN: probeToken, PROBE_INVITE_EMAIL: probeEmail, PROBE_RESET_TOKEN: resetToken, PROBE_USER_ID: quinn.id,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const probe = JSON.parse(/^PROBE (.*)$/m.exec(stdout)?.[1] ?? "{}") as Record<string, { threw?: string; status?: unknown; returned?: unknown }>;
  check("Better Auth's sign-up, called in process, is refused", probe.signUpEmail?.status === 404, JSON.stringify(probe.signUpEmail));
  check("and so is its password reset", probe.resetPassword?.status === 404, JSON.stringify(probe.resetPassword));
  check("no link to set a password is minted", (probe.issuePasswordSetupUrl?.threw ?? "").includes("Passwords are off"),
        JSON.stringify(probe.issuePasswordSetupUrl));
  const probeInvite = await db.invite.findFirst({ where: { email: probeEmail } });
  check("accepting an invitation with a password writes nothing — not even the name chosen",
        probeInvite?.name === null && probeInvite?.acceptedAt === null && (await userByEmail(probeEmail)) === null,
        JSON.stringify({ name: probeInvite?.name, acceptInvite: probe.acceptInvite }));
  const quinnLinkNow = await db.account.findUnique({ where: { id: quinnLink.id } });
  check("Better Auth updating a linked account with the provider's tokens stores none of them",
        probe.updateAccount?.threw === undefined && quinnLinkNow !== null &&
        quinnLinkNow.accessToken === null && quinnLinkNow.refreshToken === null && quinnLinkNow.idToken === null,
        JSON.stringify({ probe: probe.updateAccount, a: quinnLinkNow?.accessToken, r: quinnLinkNow?.refreshToken, i: quinnLinkNow?.idToken }));
  const quinnNow = await db.user.findUnique({ where: { id: quinn.id } });
  check("setting a password from a link writes nothing — not the username, not the link",
        quinnNow?.username === null && (await resetRows()) === rowsBefore,
        JSON.stringify({ username: quinnNow?.username, rows: await resetRows(), setPassword: probe.setPassword }));

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

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
import { randomBytes } from "node:crypto";

import { db } from "../src/lib/db";
import {
  OIDC_CALLBACK_PATH,
  authMethods,
  disabledAuthPaths,
  mayProvision,
  oidcConfig,
} from "../src/lib/auth-methods";
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
async function sso(as: string, browser = new Browser(), callbackURL = "/board"): Promise<Outcome> {
  // Every run of this suite comes from one address, and the limiter counts by
  // address. It is not what is under test here; `verify:auth` owns that.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const start = await browser.post("/api/auth/sign-in/social", {
    provider: "oidc", callbackURL, errorCallbackURL: "/signin",
  });
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
  check("linking an identity on request is closed in every mode",
        [ssoOnly, localOnly, disabledAuthPaths({ local: true, oidc: true })].every((l) => l.includes("/link-social")));

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
  const button = /Sign in with ([^<]+)</.exec(signinPage)?.[1]?.trim();
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
  check("their identity at the provider is what opens it", link?.accountId === "sub-ayla", link?.accountId);
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
  check("a signed-in person cannot attach an identity on request", linkSocial.status === 404, `status ${linkSocial.status}`);

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
        !unlinked.browser.signedIn && unlinked.error === "account_not_linked", unlinked.landed);
  check("and gains no identity at the provider",
        (await db.account.count({ where: { userId: otto.id, providerId: "oidc" } })) === 0);
  check("the page says what to do about it",
        rendered(await (await new Browser().raw(APP + unlinked.landed)).text()).includes("has not confirmed the address"));

  section("the printer owner");

  const owner = await sso("owner");
  const adminNow = await db.user.findUnique({ where: { id: admin.id }, include: { accounts: true } });
  check("signs in to the owner's account with a verified address",
        owner.landed === "/board" && owner.browser.signedIn && adminNow?.accounts.some((a) => a.providerId === "oidc") === true, owner.landed);
  check("and is still the owner, under their own name — a `role` claim changes nothing",
        adminNow?.role === "admin" && adminNow?.name === admin.name, `${adminNow?.role} ${adminNow?.name}`);
  check("that the owner can now be reached through the provider is on the trail, with the role",
        ((await lastAudit("auth.sso_linked", admin.email))?.detail as { role?: string } | null)?.role === "admin");
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
  const reproved = await sso("owner", owner.browser, "/admin/invites");
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

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

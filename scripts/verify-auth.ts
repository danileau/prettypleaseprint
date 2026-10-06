/**
 * End-to-end check of invite-only registration, members signing in by device,
 * and the printer owner's username/password sign-in.
 *
 *   docker compose up -d db mailpit
 *   npm run build && npm start          # or npm run dev
 *   npm run verify:auth
 *
 * It drives the real HTTP surface — including submitting the server-action
 * forms exactly the way a browser with JavaScript disabled does — and reads
 * delivered mail out of Mailpit. Nothing is stubbed, so a pass means the
 * whole path works, not that the units agree with each other.
 *
 * DESTRUCTIVE: it wipes users, invites, tokens and the audit trail first.
 * Point it at a development database only.
 */
import "./_env";
import { PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { createInvite, mailConfigured } from "../src/lib/invites";
import { issuePasswordSetupUrl } from "../src/lib/password-reset";
import { issueDeviceLinkUrl } from "../src/lib/device-link";
import { DEVICE_SESSION_SECONDS, SESSION_IDLE_SECONDS } from "../src/lib/auth-rules";
import { TEST_PASSWORD, ensureCredentials, signInWithPassword } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `   [${detail}]`}`);
  if (!ok) failures.push(name);
}
const section = (t: string) => console.info(`\n== ${t} ==`);

/** Counters are per IP and every suite shares one; clear before each burst. */
const clearRateLimit = () => db.$executeRawUnsafe('DELETE FROM "rateLimit"');

// --- a cookie jar over fetch, so a "browser" persists between requests -----

class Browser {
  private jar = new Map<string, string>();
  /** The `Max-Age` each cookie was last written with, if it had one. */
  readonly maxAge = new Map<string, number>();

  get cookieNames(): string[] {
    return [...this.jar.keys()];
  }

  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const age = /;\s*Max-Age=(\d+)/i.exec(line)?.[1];
      if (age) this.maxAge.set(name, Number(age));
      // A real browser drops Secure cookies on plain HTTP; over loopback we
      // keep them so a production build can still be smoke-tested locally.
      if (value === "" || line.includes("Max-Age=0")) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private header(): Record<string, string> {
    // Better Auth rejects same-site-looking requests that carry no Origin
    // (MISSING_OR_NULL_ORIGIN) — its CSRF defence. A real browser always sends
    // one, so this client does too, otherwise we would be testing the error
    // path instead of the flow.
    const h: Record<string, string> = { origin: APP };
    if (this.jar.size > 0) {
      h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    return h;
  }

  /** Single request, redirects NOT followed. */
  async raw(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), ...this.header() },
    });
    this.store(res);
    return res;
  }

  /** Follows redirects, carrying cookies, like a browser address bar. */
  async go(url: string, init: RequestInit = {}): Promise<Response> {
    let res = await this.raw(url, init);
    for (let hop = 0; hop < 8; hop++) {
      const loc = res.headers.get("location");
      if (!loc || res.status < 300 || res.status >= 400) break;
      res = await this.raw(new URL(loc, url).toString());
    }
    return res;
  }

  /**
   * Submit a server-action form the way a browser without JavaScript does:
   * replay every hidden input React rendered, plus the visible values.
   */
  async submit(url: string, html: string, values: Record<string, string>) {
    const form = /<form\b[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    const body = new FormData();
    for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
      if (!tag.includes('type="hidden"')) continue;
      const name = /name="([^"]*)"/.exec(tag)?.[1];
      const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (name) body.append(unescapeHtml(name), unescapeHtml(value));
    }
    for (const [k, v] of Object.entries(values)) body.set(k, v);
    return this.raw(url, { method: "POST", body });
  }
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const signedIn = (b: Browser) => b.cookieNames.some((c) => c.includes("session_token"));
const sessionCookie = (b: Browser) => b.cookieNames.find((c) => c.includes("session_token"));

/** Who a browser is signed in as, according to the server. */
async function whoIs(b: Browser): Promise<string | null> {
  const body = await (await b.raw(`${APP}/api/auth/get-session`)).text();
  try {
    return (JSON.parse(body) as { user?: { email?: string } } | null)?.user?.email ?? null;
  } catch {
    return null;
  }
}

// --- mailpit ---------------------------------------------------------------

async function mailLink(to: string, pattern: RegExp): Promise<string | null> {
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
  for (const m of list.messages ?? []) {
    const addressed = (m.To ?? []).some(
      (a: { Address?: string }) => a.Address?.toLowerCase() === to,
    );
    if (!addressed) continue;
    const body = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = pattern.exec(`${body.Text ?? ""} ${body.HTML ?? ""}`);
    if (hit) return hit[0].replace(/[.,]$/, "").replace(/&amp;/g, "&");
  }
  return null;
}

const CLAIM_LINK = /http:\/\/[^\s"'<]+\/invite\/[^\s"'<]+/;
const SET_PASSWORD_LINK = /http:\/\/[^\s"'<]+\/set-password\?token=[^\s"'<]+/;
const DEVICE_LINK = /http:\/\/[^\s"'<]+\/device\/[^\s"'<]+/;

/** Registration, as the sign-up endpoint sees it. */
function signUp(browser: Browser, body: Record<string, unknown>) {
  return browser.raw(`${APP}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- the run ---------------------------------------------------------------

async function main() {
  section("reset");
  await clearRateLimit();
  await db.verification.deleteMany();
  // The trail is append-only in the app, so a suite that asserts "exactly one
  // of these happened" has to start from an empty one.
  await db.auditEvent.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin. Run `npm run db:seed` first.");
  console.info(`  admin: ${admin.name} <${admin.email}>`);

  // ------------------------------------------------------------------------
  section("1. an uninvited stranger cannot register");
  const STRANGER = "stranger@nowhere.test";
  const anon = new Browser();

  const uninvited = await signUp(anon, {
    email: STRANGER,
    name: "A Stranger",
    username: "stranger",
    password: TEST_PASSWORD,
  });
  check("sign-up with no pending invite is refused", uninvited.status === 403,
        `status ${uninvited.status}`);
  check("and it says why, without hinting at a way round it",
        (await uninvited.clone().text()).includes("invite"), "");
  check("no account was created",
        (await db.user.count({ where: { email: STRANGER } })) === 0);
  check("no session came back", !signedIn(anon));
  check("the refusal is in the audit trail",
        (await db.auditEvent.count({
          where: { action: "invite.rejected", subject: STRANGER },
        })) > 0);

  // ------------------------------------------------------------------------
  section("2. the admin invites someone through the UI");
  await ensureCredentials(APP, admin.id, "ruben");
  const ruben = new Browser();
  await clearRateLimit();
  await signInWithPassword(ruben, APP, "ruben");
  check("the admin has a session", signedIn(ruben));

  const AYLA = "ayla@office.example";
  const invitePage = await (await ruben.go(`${APP}/admin/invites`)).text();
  check("the admin can open the guest list", invitePage.includes("The guest list"));

  const sent = await ruben.submit(`${APP}/admin/invites`, invitePage, {
    email: AYLA,
    name: "Ayla B",
  });
  check("submitting the invite form is accepted", sent.status < 400, `status ${sent.status}`);
  check("an invite row exists", (await db.invite.count({ where: { email: AYLA } })) === 1);

  // ------------------------------------------------------------------------
  section("2b. an invited address is not the invitation");
  // The sign-up endpoint answers anybody. Before this was closed, posting an
  // invited address here with a password of your own choosing opened the
  // account and signed you in — no link, no mailbox. Knowing who had been
  // invited was enough.
  const thief = new Browser();
  const noLink = await signUp(thief, {
    email: AYLA,
    name: "Not Ayla",
    username: "notayla",
    password: TEST_PASSWORD,
  });
  check("signing up with an invited address but no link is refused", noLink.status === 403,
        `status ${noLink.status}`);
  check("no account was opened for it",
        (await db.user.count({ where: { email: AYLA } })) === 0);
  check("and no session came back", !signedIn(thief));
  check("the answer is the same one a stranger gets, so it does not say who is invited",
        (await noLink.clone().text()) === (await uninvited.clone().text()),
        (await noLink.clone().text()).slice(0, 120));
  check("the invitation is still there for the person it was sent to",
        (await db.invite.findFirst({ where: { email: AYLA } }))?.acceptedAt === null);
  const noLinkTrail = await db.auditEvent.findFirst({
    where: { action: "invite.rejected", subject: AYLA },
    orderBy: { at: "desc" },
  });
  check("the trail records it as an attempt without the link",
        (noLinkTrail?.detail as { reason?: string } | null)?.reason === "no_link",
        JSON.stringify(noLinkTrail?.detail));

  // ------------------------------------------------------------------------
  section("3. the invitation link registers the account");
  const claimUrl = await mailLink(AYLA, CLAIM_LINK);
  check("an invitation email with a claim link arrived", claimUrl !== null, `${claimUrl}`);
  if (!claimUrl) throw new Error("no claim link; cannot continue");

  const ayla = new Browser();
  const claimPage = await (await ayla.go(claimUrl)).text();
  check("the claim page renders", claimPage.includes("will print things for you"));
  check("it shows the address the invite is bound to", claimPage.includes(AYLA));
  check("it asks for a name and nothing else — no username, no password",
        claimPage.includes('name="name"') &&
        !claimPage.includes('name="username"') && !claimPage.includes('name="password"'));

  const claimed = await ayla.submit(claimUrl, claimPage, { name: "Ayla Berg" });
  check("registering redirects onward", claimed.status >= 300 && claimed.status < 400,
        `status ${claimed.status}`);
  check("and signs her in there and then", signedIn(ayla),
        "registration did not establish a session");

  // `/` redirects to the board, which is the client's home per the handoff.
  const home = await (await ayla.go(`${APP}/`)).text();
  check("she lands on an authenticated page", home.includes("The backlog"));
  // The client kicker names the printer owner directly, the admin one does
  // not — and the admin-only nav must be absent entirely.
  check("the page is scoped to a client, not the admin",
        home.includes(`Private to you and ${admin.name.split(" ")[0]}`) &&
        !home.includes("Admin view") &&
        !home.includes("Guest list") &&
        !home.includes("/admin/audit"));

  const account = await db.user.findUnique({ where: { email: AYLA } });
  check("the account is stamped from the invite, not the request",
        account?.role === "client" &&
        account.initials === "AY" &&
        account.invitedById === admin.id &&
        account.emailVerified === true,
        JSON.stringify({ role: account?.role, initials: account?.initials }));
  check("the name she chose beat the one the admin guessed",
        account?.name === "Ayla Berg", account?.name);
  check("the invite is marked accepted",
        (await db.invite.findFirst({ where: { email: AYLA } }))?.acceptedAt !== null);
  check("she has no password and no username — the device is her credential",
        account?.username === null &&
        (await db.account.count({ where: { userId: account.id } })) === 0,
        JSON.stringify({ username: account?.username }));

  // The device session: four hundred days in the row, and the same in the
  // cookie, or the browser would forget her long before the server did.
  const aylaSessions = await db.session.findMany({ where: { userId: account!.id } });
  const daysLeft = (aylaSessions[0]?.expiresAt.getTime() ?? 0) - Date.now();
  check("her session lasts four hundred days, not twenty minutes",
        aylaSessions.length === 1 &&
        Math.abs(daysLeft / 1000 - DEVICE_SESSION_SECONDS) < 300,
        `${(daysLeft / 86_400_000).toFixed(2)} days`);
  check("and the cookie was written to last as long",
        ayla.maxAge.get(sessionCookie(ayla) ?? "") === DEVICE_SESSION_SECONDS,
        String(ayla.maxAge.get(sessionCookie(ayla) ?? "")));
  check("with the marker that tells middleware which session it is",
        ayla.cookieNames.includes("ppp.device"));

  // Middleware cuts every other session cookie to twenty minutes on a page
  // view. Doing that to hers would sign her out of a device she has no
  // password to get back into.
  ayla.maxAge.clear();
  await ayla.go(`${APP}/board`);
  check("browsing a page does not cut her cookie to twenty minutes",
        ayla.maxAge.get(sessionCookie(ayla) ?? "") !== SESSION_IDLE_SECONDS,
        String(ayla.maxAge.get(sessionCookie(ayla) ?? "")));

  // The endpoints behind all of this are server-only. Nothing a stranger can
  // post to should have appeared under /api/auth.
  for (const path of ["register-member-device", "sign-in-member-device"]) {
    const res = await new Browser().raw(`${APP}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@nowhere.test", name: "X", userId: account!.id }),
    });
    check(`/api/auth/${path} is not reachable over HTTP`, res.status === 404,
          `status ${res.status}`);
  }

  // ------------------------------------------------------------------------
  section("4. the invitation link is single-use");
  const replay = await (await new Browser().go(claimUrl)).text();
  check("a second visit is refused", replay.includes("has been used"));

  // ------------------------------------------------------------------------
  section("5. the printer owner signs in with a username and a password");
  await clearRateLimit();
  const returning = new Browser();
  const good = await signInWithPassword(returning, APP, "ruben");
  check("the right password is accepted", good.status === 200, `status ${good.status}`);
  check("and a session cookie is set", signedIn(returning));
  check("for twenty minutes — the owner has no device session",
        returning.maxAge.get(sessionCookie(returning) ?? "") === SESSION_IDLE_SECONDS,
        String(returning.maxAge.get(sessionCookie(returning) ?? "")));

  const mixedCase = new Browser();
  await signInWithPassword(mixedCase, APP, "RuBen");
  check("the username is matched case-insensitively", signedIn(mixedCase));

  const wrongPassword = new Browser();
  const bad = await signInWithPassword(wrongPassword, APP, "ruben", "not-the-password-x9");
  check("a wrong password is refused", bad.status === 401, `status ${bad.status}`);
  check("and no session is handed out", !signedIn(wrongPassword));

  const noSuchUser = await signInWithPassword(new Browser(), APP, "nobody-here", "not-the-password-x9");
  const badBody = await bad.clone().text();
  const missingBody = await noSuchUser.clone().text();
  check("an unknown username is answered exactly like a wrong password",
        noSuchUser.status === bad.status && missingBody === badBody,
        `${noSuchUser.status} ${missingBody} vs ${bad.status} ${badBody}`);

  // ------------------------------------------------------------------------
  section("6. a name is claimed once");
  // With no username and no password, the name is the only thing telling two
  // members apart — so a second person cannot simply type somebody's name.
  const DUP = "dup@office.example";
  await createInvite({ email: DUP, invitedById: admin.id });
  const dupLink = await mailLink(DUP, CLAIM_LINK);
  if (!dupLink) throw new Error("no claim link for the duplicate invite");

  const impostor = new Browser();
  const dupPage = await (await impostor.go(dupLink)).text();
  const taken = await impostor.submit(dupLink, dupPage, { name: "AYLA BERG" });
  const takenBody = await taken.clone().text();
  check("a name somebody already has is refused, whatever its case",
        takenBody.includes("already goes by that name"),
        `status ${taken.status} ${takenBody.slice(0, 120)}`);
  check("and no account was created, and no session handed out",
        (await db.user.count({ where: { email: DUP } })) === 0 && !signedIn(impostor));

  // The same invite still works with a name of their own, which is what makes
  // the refusal a refusal rather than a broken flow.
  const survivor = new Browser();
  const dupAgain = await (await survivor.go(dupLink)).text();
  const ok = await survivor.submit(dupLink, dupAgain, { name: "Dup Licate" });
  check("a name nobody has goes straight through",
        ok.status >= 300 && ok.status < 400 && signedIn(survivor) &&
        (await db.user.count({ where: { email: DUP } })) === 1,
        `status ${ok.status}`);
  await db.user.deleteMany({ where: { email: DUP } });

  // ------------------------------------------------------------------------
  section("7. a breached password is refused");
  // The sign-up endpoint still exists, and its own validation runs before the
  // invite gate — so a corpus password is refused there whatever else is true.
  const BREACH = "breach@office.example";
  await createInvite({ email: BREACH, invitedById: admin.id });
  await clearRateLimit();
  const breached = await signUp(new Browser(), {
    email: BREACH, name: "Bree Ched", username: "breached", password: "Password123!",
  });
  const breachedBody = await breached.clone().text();
  check("a password from a known breach corpus does not get through",
        breached.status === 400 && /breach|compromis/i.test(breachedBody),
        `status ${breached.status} ${breachedBody.slice(0, 120)}`);
  check("and no account",
        (await db.user.count({ where: { email: BREACH } })) === 0);
  await db.invite.deleteMany({ where: { email: BREACH } });

  // ------------------------------------------------------------------------
  section("8. guessing is rate limited");
  await clearRateLimit();
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await signInWithPassword(new Browser(), APP, "ruben", `guess-${i}-nope`);
    if (r.status === 429) limited = true;
  }
  check("repeated wrong passwords hit the limiter", limited,
        "25 attempts in a row were all answered normally");
  await clearRateLimit();

  // ------------------------------------------------------------------------
  section("9. a client cannot reach the admin surface");
  const denied = await ayla.go(`${APP}/admin/invites`);
  check("the guest list answers 404, not 403", denied.status === 404, `status ${denied.status}`);

  await ayla.submit(`${APP}/admin/invites`, invitePage, {
    email: "gatecrasher@nowhere.test",
  });
  check("posting the invite action as a client creates nothing",
        (await db.invite.count({ where: { email: "gatecrasher@nowhere.test" } })) === 0);

  // ------------------------------------------------------------------------
  section("10. privileged fields cannot be set over the wire");
  const BOB = "bob@office.example";
  await createInvite({ email: BOB, invitedById: admin.id });

  // `input: false` is not "quietly stripped": Better Auth refuses the whole
  // request. Loud is the right failure — a sign-up that half-worked would be
  // harder to notice than one that did not.
  for (const field of ["role", "initials", "invitedById"] as const) {
    await clearRateLimit();
    const spoof = await signUp(new Browser(), {
      email: BOB,
      name: "Bob Ross",
      username: "bob",
      password: TEST_PASSWORD,
      [field]: field === "role" ? "admin" : field === "initials" ? "XX" : admin.id,
    });
    check(`posting ${field} at sign-up is refused outright`, spoof.status === 400,
          `status ${spoof.status} ${(await spoof.clone().text()).slice(0, 90)}`);
  }
  check("and none of those attempts left an account behind",
        (await db.user.count({ where: { email: BOB } })) === 0);

  // The undeclared ones — `id`, `emailVerified` — used to reach the endpoint
  // and be overruled, and this check registered Bob to prove it. That it could
  // register him at all, with an invitation and no link, was the hole. The
  // stamping itself is asserted in section 3, on the account the link opened.
  await clearRateLimit();
  const bare = await signUp(new Browser(), {
    email: BOB,
    name: "Bob Ross",
    username: "bob",
    password: TEST_PASSWORD,
    id: "chosen-by-attacker",
    emailVerified: false,
  });
  check("a sign-up with no privileged fields, and no link, is refused too", bare.status === 403,
        `status ${bare.status}`);
  check("so Bob has no account until he uses his link",
        (await db.user.count({ where: { email: BOB } })) === 0);

  // ------------------------------------------------------------------------
  section("11. the admin signs a member in on another device");
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  const guestList = await (await ruben.go(`${APP}/admin/invites`)).text();
  check("members are listed with a device-link control",
        guestList.includes("Ayla Berg") && guestList.includes("Link a device"));
  check("and no password reset for a member who has no password",
        !guestList.includes("Forgotten password?"));

  // The device-link form is the first one carrying her id; access is second.
  const linkForm = formContaining(guestList, `value="${account!.id}"`);
  check("the control targets the right member", linkForm !== null);
  const linkSent = await ruben.submit(`${APP}/admin/invites`, linkForm ?? "", {
    userId: account!.id,
  });
  check("minting it is accepted", linkSent.status < 400, `status ${linkSent.status}`);
  check("it is audited as a request, by the admin who made it",
        (await db.auditEvent.count({
          where: { action: "device.link_requested", actorId: admin.id, subject: AYLA },
        })) === 1);
  check("with mail working, the link is not handed back to the admin",
        !DEVICE_LINK.test(await linkSent.clone().text()),
        "the admin was shown a link that had already been emailed");

  const deviceUrl = await mailLink(AYLA, DEVICE_LINK);
  check("a device-link email arrived", deviceUrl !== null, String(deviceUrl));
  if (!deviceUrl) throw new Error("no device link; cannot continue");

  const phone = new Browser();
  const devicePage = await (await phone.go(deviceUrl)).text();
  // React separates adjacent text with `<!-- -->` in server-rendered HTML.
  check("the link says whose it is",
        devicePage.replace(/<!-- -->/g, "").includes("Hello again, Ayla"));
  check("and opening it signs nobody in — a link preview cannot spend it",
        !signedIn(phone));

  const linked = await phone.submit(deviceUrl, devicePage, {});
  check("pressing the button signs the new device in",
        linked.status >= 300 && linked.status < 400 && (await whoIs(phone)) === AYLA,
        `status ${linked.status}`);
  check("on a device session of its own",
        phone.maxAge.get(sessionCookie(phone) ?? "") === DEVICE_SESSION_SECONDS);
  check("it is audited as used",
        (await db.auditEvent.count({ where: { action: "device.linked", subject: AYLA } })) === 1);
  check("her first device is still signed in", (await whoIs(ayla)) === AYLA);

  const replayed = await (await new Browser().go(deviceUrl)).text();
  check("the link is spent once it has been used", replayed.includes("spent"));

  // A device link is the ability to become somebody, so it stays out of
  // circulation in the database too.
  const deviceToken = decodeURIComponent(new URL(deviceUrl).pathname.split("/").pop()!);
  const strayLink = await issueDeviceLinkUrl(account!.id);
  const strayToken = decodeURIComponent(new URL(strayLink).pathname.split("/").pop()!);
  const deviceRows = await db.verification.findMany();
  check("no verification row holds a raw device token",
        deviceRows.every((v) => !v.identifier.includes(strayToken) &&
                                !v.value.includes(strayToken) &&
                                !v.identifier.includes(deviceToken)));

  // ------------------------------------------------------------------------
  section("11b. revoking access ends every device, and every unused link");
  const accessList = await (await ruben.go(`${APP}/admin/invites`)).text();
  const accessForm = (accessList.match(/<form\b[\s\S]*?<\/form>/g) ?? [])
    .find((f) => f.includes(`value="${account!.id}"`) && f.includes('name="revoke"')) ?? "";
  const revoked = await ruben.submit(`${APP}/admin/invites`, accessForm, {
    userId: account!.id,
    revoke: "true",
  });
  check("revoking is accepted", revoked.status < 400, `status ${revoked.status}`);
  check("both of her devices are signed out",
        (await whoIs(ayla)) === null && (await whoIs(phone)) === null);
  const strayPage = await (await new Browser().go(strayLink)).text();
  check("and a link minted before the revocation no longer works",
        strayPage.includes("spent"));

  await db.user.update({
    where: { id: account!.id },
    data: { banned: false, banReason: null, banExpires: null },
  });

  // ------------------------------------------------------------------------
  section("11c. a member who still has a password can have it reset");
  // Accounts that registered before sign-in went passwordless keep their
  // password, and the guest list keeps the reset control for them alone.
  const LENA = "lena@office.example";
  const lena = await db.user.create({
    data: { email: LENA, name: "Lena Old", initials: "LE", role: "client",
            emailVerified: true, invitedById: admin.id },
  });
  await ensureCredentials(APP, lena.id, "lena");
  await clearRateLimit();
  const lenaBrowser = new Browser();
  await signInWithPassword(lenaBrowser, APP, "lena");
  check("her password still signs her in", signedIn(lenaBrowser));
  check("a password stored for her is a digest, not the password",
        await passwordIsHashed(lena.id));

  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  const legacyList = await (await ruben.go(`${APP}/admin/invites`)).text();
  check("she is listed with the reset control",
        legacyList.includes("Lena Old") && legacyList.includes("Forgotten password?"));

  const resetForm = (legacyList.match(/<form\b[\s\S]*?<\/form>/g) ?? [])
    .filter((f) => f.includes(`value="${lena.id}"`))[1] ?? null;
  check("the control targets the right member", resetForm !== null);
  const reset = await ruben.submit(`${APP}/admin/invites`, resetForm ?? "", {
    userId: lena.id,
  });
  check("triggering it is accepted", reset.status < 400, `status ${reset.status}`);
  check("it is audited as a request, by the admin who made it",
        (await db.auditEvent.count({
          where: { action: "password.reset_requested", actorId: admin.id },
        })) === 1);

  // Mail is configured in this run, so the link goes to her and NOT back to
  // the admin — the same rule invitations follow.
  const resetBody = await reset.clone().text();
  check("with mail working, the link is not handed back to the admin",
        !SET_PASSWORD_LINK.test(resetBody),
        "the admin was shown a link that had already been emailed");

  const setUrl = await mailLink(LENA, SET_PASSWORD_LINK);
  check("a set-password email arrived", setUrl !== null, String(setUrl));
  if (!setUrl) throw new Error("no set-password link; cannot continue");

  const recovering = new Browser();
  const setPage = await (await recovering.go(setUrl)).text();
  check("the link opens a set-password form", setPage.includes('name="password"'));
  check("and it does NOT sign anybody in", !signedIn(recovering),
        "following a reset link established a session");

  // A breached password is refused here too — and, crucially, does not burn
  // the link on the way out.
  const refused = await recovering.submit(setUrl, setPage, { password: "Password123!" });
  check("a breached password is refused at the set-password form",
        /breach|compromis/i.test(await refused.clone().text()),
        "a corpus password was accepted");

  const NEW_PASSWORD = "ppp-suite-second-key-parked-outside";
  const stillGood = await (await recovering.go(setUrl)).text();
  check("the link survives a refused password", stillGood.includes('name="password"'),
        "being told to pick another password spent the link");

  const done = await recovering.submit(setUrl, stillGood, { password: NEW_PASSWORD });
  check("a good password is accepted", done.status >= 300 && done.status < 400,
        `status ${done.status}`);
  check("and it is audited as completed",
        (await db.auditEvent.count({
          where: { action: "password.reset_completed", subject: LENA },
        })) === 1);

  await clearRateLimit();
  const oldTry = await signInWithPassword(new Browser(), APP, "lena", TEST_PASSWORD);
  check("the old password stops working", oldTry.status === 401, `status ${oldTry.status}`);

  const newBrowser = new Browser();
  const newTry = await signInWithPassword(newBrowser, APP, "lena", NEW_PASSWORD);
  check("the new one works", newTry.status === 200 && signedIn(newBrowser),
        `status ${newTry.status}`);

  const spent = await (await new Browser().go(setUrl)).text();
  check("and the link is spent once it has been used", spent.includes("spent"),
        "a used set-password link still opened the form");

  check("her earlier session was revoked with the password",
        (await (await lenaBrowser.raw(`${APP}/api/auth/get-session`)).text()).length < 5,
        "a session opened with the old password outlived it");

  // ------------------------------------------------------------------------
  section("12. reset tokens are not stored in a form anyone can replay");
  const rawToken = new URL(setUrl).searchParams.get("token")!;
  const rows = await db.verification.findMany();
  check("no verification row holds the raw token",
        rows.every((v) => v.identifier !== rawToken && !v.identifier.includes(rawToken)),
        "a raw set-password token was found in the verification table");

  // ------------------------------------------------------------------------
  section("mail is optional, not required");

  // With a transport configured the raw token stays inside the message: the
  // caller gets no handover URL, so the admin cannot replay the link.
  const withMail = await createInvite({
    email: "mailed@office.example",
    invitedById: admin.id,
  });
  check("with mail configured, the link is emailed and withheld from the caller",
        withMail.handoverUrl === undefined,
        "the raw token was handed back even though it was delivered");
  check("and it really was delivered",
        (await mailLink("mailed@office.example", CLAIM_LINK)) !== null);

  // With none, the same call hands the link back so it can be passed on.
  // Restored afterwards so the rest of the run is unaffected.
  const savedSmtp = process.env.SMTP_URL;
  const savedResend = process.env.RESEND_API_KEY;
  delete process.env.SMTP_URL;
  delete process.env.RESEND_API_KEY;
  check("mailConfigured() reflects the environment", mailConfigured() === false);

  const noMail = await createInvite({
    email: "handover@office.example",
    invitedById: admin.id,
  });
  check("with no transport, the admin gets a link to hand over",
        typeof noMail.handoverUrl === "string" &&
        noMail.handoverUrl.includes("/invite/"),
        String(noMail.handoverUrl));
  check("and nothing was sent",
        (await mailLink("handover@office.example", CLAIM_LINK)) === null,
        "a message went out with no transport configured");

  if (savedSmtp) process.env.SMTP_URL = savedSmtp;
  if (savedResend) process.env.RESEND_API_KEY = savedResend;
  check("the transport comes back when the environment does", mailConfigured() === true);

  // The handed-over link has to actually work, or the mode is theatre.
  const handoverBrowser = new Browser();
  const handoverPage = await (await handoverBrowser.go(noMail.handoverUrl!)).text();
  check("a handed-over invite link opens the claim page",
        handoverPage.includes("will print things for you"));

  await db.invite.deleteMany({
    where: { email: { in: ["mailed@office.example", "handover@office.example"] } },
  });

  // ------------------------------------------------------------------------
  section("14. the printer owner bootstraps from a printed link");

  // Exactly the state a fresh deploy is in: an admin row that nobody invited,
  // with no username and no password. The seed prints a link for this; here
  // the link is minted directly so the check does not depend on scraping
  // container logs.
  await db.account.deleteMany({ where: { userId: admin.id, providerId: "credential" } });
  await db.user.update({
    where: { id: admin.id },
    data: { username: null, displayUsername: null },
  });

  const bootstrapUrl = await issuePasswordSetupUrl(admin.id);
  const owner = new Browser();
  const bootstrapPage = await (await owner.go(bootstrapUrl)).text();
  check("an account with no username is asked for one",
        bootstrapPage.includes('name="username"') && bootstrapPage.includes('name="password"'),
        "the bootstrap link did not offer a username field");

  const OWNER_PASSWORD = "ppp-suite-owner-key-parked-outside";
  const bootstrapped = await owner.submit(bootstrapUrl, bootstrapPage, {
    username: "Ruben",
    password: OWNER_PASSWORD,
  });
  check("submitting it is accepted",
        bootstrapped.status >= 300 && bootstrapped.status < 400,
        `status ${bootstrapped.status}`);

  const ownerRow = await db.user.findUnique({ where: { id: admin.id } });
  check("the username is stored folded, with what was typed kept alongside",
        ownerRow?.username === "ruben" && ownerRow.displayUsername === "Ruben",
        JSON.stringify({ username: ownerRow?.username,
                         displayUsername: ownerRow?.displayUsername }));

  await clearRateLimit();
  const ownerIn = new Browser();
  const ownerSignIn = await signInWithPassword(ownerIn, APP, "ruben", OWNER_PASSWORD);
  check("and the printer owner can sign in with it",
        ownerSignIn.status === 200 && signedIn(ownerIn), `status ${ownerSignIn.status}`);

  const ownerHome = await (await ownerIn.go(`${APP}/admin/invites`)).text();
  check("as the admin, not as a client", ownerHome.includes("The guest list"));

  // --------------------------------------------------------------------------
  section("13. the database itself permits only one admin");
  check("exactly one admin exists",
        (await db.user.count({ where: { role: "admin" } })) === 1);
  // A client with logging off: the constraint violation below is the expected
  // result, and the shared client would print it as though something broke.
  const quiet = new PrismaClient({ log: [] });
  let rejected = false;
  try {
    await quiet.user.create({
      data: {
        email: "usurper@nowhere.test",
        name: "Usurper",
        initials: "US",
        role: "admin",
      },
    });
  } catch {
    rejected = true;
  } finally {
    await quiet.$disconnect();
  }
  check("a second admin row is rejected by the partial unique index", rejected);

  // ------------------------------------------------------------------------
  console.info(
    "\n" + (failures.length === 0
      ? "ALL CHECKS PASSED"
      : `${failures.length} FAILED:\n  - ${failures.join("\n  - ")}`),
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

/** A stored password must be a digest, never the password itself. */
async function passwordIsHashed(userId: string): Promise<boolean> {
  const account = await db.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  const stored = account?.password ?? "";
  return stored.length > 0 && !stored.includes(TEST_PASSWORD);
}

/** The one `<form>` on the page whose markup contains a marker. */
function formContaining(html: string, marker: string): string | null {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.find((f) => f.includes(marker)) ?? null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

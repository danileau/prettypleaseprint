/**
 * End-to-end check of the invite-only authentication flow.
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
 * DESTRUCTIVE: it wipes users, invites and verification tokens first. Point it
 * at a development database only.
 */
import { PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { createInvite } from "../src/lib/invites";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `   [${detail}]`}`);
  if (!ok) failures.push(name);
}
const section = (t: string) => console.info(`\n== ${t} ==`);

// --- a cookie jar over fetch, so a "browser" persists between requests -----

class Browser {
  private jar = new Map<string, string>();

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

const VERIFY_LINK = /http:\/\/[^\s"'<]+\/api\/auth\/magic-link\/verify[^\s"'<]*/;
const CLAIM_LINK = /http:\/\/[^\s"'<]+\/invite\/[^\s"'<]+/;

// --- the run ---------------------------------------------------------------

async function main() {
  section("reset");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.verification.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin. Run `npm run db:seed` first.");
  console.info(`  admin: ${admin.name} <${admin.email}>`);

  // ------------------------------------------------------------------------
  section("1. an uninvited stranger cannot get in");
  const STRANGER = "stranger@nowhere.test";
  const anon = new Browser();

  const req = await anon.raw(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: STRANGER, callbackURL: "/" }),
  });
  check("the request is answered identically for an unknown address", req.status === 200,
        `status ${req.status}`);

  const strangerLink = await mailLink(STRANGER, VERIFY_LINK);
  check("a link is still sent, so the form is not a membership oracle",
        strangerLink !== null);

  if (strangerLink) {
    const res = await anon.raw(strangerLink);
    const loc = res.headers.get("location") ?? "";
    check("following it does not sign the stranger in",
          loc.includes("invite_required") || loc.includes("error"), `-> ${loc}`);
  }
  check("no account was created",
        (await db.user.count({ where: { email: STRANGER } })) === 0);

  // ------------------------------------------------------------------------
  section("2. the admin invites someone through the UI");
  const ruben = new Browser();
  await ruben.raw(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: admin.email, callbackURL: "/" }),
  });
  const rubenLink = await mailLink(admin.email, VERIFY_LINK);
  if (rubenLink) await ruben.go(rubenLink);
  check("the admin has a session",
        ruben.cookieNames.some((c) => c.includes("session_token")));

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
  section("3. the invited person registers through the link");
  const claimUrl = await mailLink(AYLA, CLAIM_LINK);
  check("an invitation email with a claim link arrived", claimUrl !== null, `${claimUrl}`);
  if (!claimUrl) throw new Error("no claim link; cannot continue");

  const ayla = new Browser();
  const claimPage = await (await ayla.go(claimUrl)).text();
  check("the claim page renders", claimPage.includes("will print things for you"));
  check("it shows the address the invite is bound to", claimPage.includes(AYLA));

  const claimed = await ayla.submit(claimUrl, claimPage, { name: "Ayla Berg" });
  const grant = claimed.headers.get("location") ?? "";
  check("claiming issues a sign-in grant", grant.includes("magic-link/verify"),
        `status ${claimed.status} -> ${grant.slice(0, 70)}`);

  await ayla.go(new URL(grant, APP).toString());
  check("a session cookie is set",
        ayla.cookieNames.some((c) => c.includes("session_token")));

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

  // ------------------------------------------------------------------------
  section("4. the invitation link is single-use");
  const replay = await (await new Browser().go(claimUrl)).text();
  check("a second visit is refused", replay.includes("has been used"));

  // ------------------------------------------------------------------------
  section("5. a client cannot reach the admin surface");
  const denied = await ayla.go(`${APP}/admin/invites`);
  check("the guest list answers 404, not 403", denied.status === 404, `status ${denied.status}`);

  await ayla.submit(`${APP}/admin/invites`, invitePage, {
    email: "gatecrasher@nowhere.test",
  });
  check("posting the invite action as a client creates nothing",
        (await db.invite.count({ where: { email: "gatecrasher@nowhere.test" } })) === 0);

  // ------------------------------------------------------------------------
  section("6. privileged fields cannot be set over the wire");
  const BOB = "bob@office.example";
  await createInvite({ email: BOB, invitedById: admin.id });
  const bob = new Browser();
  await bob.raw(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: BOB, callbackURL: "/", role: "admin", initials: "XX",
    }),
  });
  const bobLink = await mailLink(BOB, VERIFY_LINK);
  if (bobLink) await bob.go(bobLink);
  const bobRow = await db.user.findUnique({ where: { email: BOB } });
  check("the posted role and initials are ignored",
        bobRow?.role === "client" && bobRow.initials === "BO",
        JSON.stringify({ role: bobRow?.role, initials: bobRow?.initials }));

  // ------------------------------------------------------------------------
  section("7. the database itself permits only one admin");
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

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

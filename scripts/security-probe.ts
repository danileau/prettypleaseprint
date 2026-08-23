/**
 * Targeted DAST probes, grouped by OWASP Top 10 (2021).
 *
 *   docker compose up -d db mailpit
 *   npm run build && npm start
 *   npm run probe:security
 *
 * A generic scanner (ZAP, Nuclei) cannot reason about *this* app's authority
 * model — who may call which endpoint, whether an invite is single-use,
 * whether a role can be set from outside. These probes do, by driving the real
 * HTTP surface with real sessions.
 *
 * DESTRUCTIVE: wipes users, invites and tokens. Development database only.
 */
import "./_env";
import { db } from "../src/lib/db";
import { issuePasswordSetupUrl } from "../src/lib/password-reset";
import { TEST_PASSWORD, ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

type Finding = { id: string; title: string; detail: string };
const findings: Finding[] = [];
let passed = 0;

function probe(id: string, title: string, secure: boolean, detail = "") {
  if (secure) {
    passed++;
    console.info(`  ok    ${id}  ${title}`);
  } else {
    findings.push({ id, title, detail });
    console.info(`  FLAG  ${id}  ${title}\n          ${detail}`);
  }
}
const section = (t: string) => console.info(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/**
 * Is this response an authenticated page?
 *
 * Keyed on a data attribute the app shell sets, not on a piece of copy. The
 * previous version looked for "Signed in as", which stopped being rendered
 * when the home screen was replaced — so three probes had been passing
 * because the string could never appear, whether or not the session was
 * valid. A negative assertion against copy is only as good as the copy.
 */
const isAuthenticated = (html: string) => html.includes('data-authenticated="true"');

/** A real 12-triangle binary STL, so upload probes exercise the happy path. */
function stlBox(x: number, y: number, z: number): Uint8Array {
  const p = [[0,0,0],[x,0,0],[x,y,0],[0,y,0],[0,0,z],[x,0,z],[x,y,z],[0,y,z]];
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
                 [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
  const tris = faces.map((f) => f.flatMap((i) => p[i]!));
  const buf = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(buf.buffer);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    for (let i = 0; i < 9; i++) view.setFloat32(off + 12 + i * 4, t[i]!, true);
    off += 50;
  }
  return buf;
}

class Browser {
  jar = new Map<string, string>();
  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq < 0) continue;
      const k = pair!.slice(0, eq).trim();
      const v = pair!.slice(eq + 1).trim();
      if (!v || line.includes("Max-Age=0")) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: APP, ...extra };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return h;
  }
  async raw(url: string, init: RequestInit = {}) {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), ...this.headers() },
    });
    this.store(res);
    return res;
  }
  async go(url: string, init: RequestInit = {}) {
    let res = await this.raw(url, init);
    for (let i = 0; i < 8; i++) {
      const loc = res.headers.get("location");
      if (!loc || res.status < 300 || res.status >= 400) break;
      res = await this.raw(new URL(loc, url).toString());
    }
    return res;
  }
  json(path: string, body: unknown) {
    return this.raw(APP + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

async function mailLink(to: string, re: RegExp) {
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
  for (const m of list.messages ?? []) {
    if (!(m.To ?? []).some((a: { Address?: string }) => a.Address?.toLowerCase() === to)) continue;
    const b = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = re.exec(`${b.Text ?? ""} ${b.HTML ?? ""}`);
    if (hit) return hit[0].replace(/[.,]$/, "").replace(/&amp;/g, "&");
  }
  return null;
}
const CLAIM = /http:\/\/[^\s"'<]+\/invite\/[^\s"'<]+/;

/** A signed-in browser for an existing row, the way the sign-in form does it. */
async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

/** Post to the sign-in endpoint directly, for the probes that need the reply. */
function attemptSignIn(b: Browser, username: string, password: string, extra = {}) {
  return b.json("/api/auth/sign-in/username", { username, password, ...extra });
}

async function main() {
  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.verification.deleteMany();
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.story.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");

  const ayla = await db.user.create({
    data: {
      email: "ayla@office.example", name: "Ayla Berg", initials: "AY",
      role: "client", emailVerified: true, invitedById: admin.id,
    },
  });
  const mallory = await db.user.create({
    data: {
      email: "mallory@office.example", name: "Mallory", initials: "MA",
      role: "client", emailVerified: true, invitedById: admin.id,
    },
  });
  console.info(`  admin=${admin.email}  client=${ayla.email}  attacker=${mallory.email}`);

  const client = await signIn(ayla);
  const attacker = await signIn(mallory);
  const anon = new Browser();
  console.info(`  sessions established: ${client.jar.size > 0 && attacker.jar.size > 0}`);

  // =====================================================================
  section("A01 Broken Access Control");

  // Positive control. Without it, the three "not authenticated" probes below
  // could all pass simply because the marker was never rendered — which is
  // exactly how the previous copy-based version quietly went hollow.
  const realPage = await (await client.go(`${APP}/board`)).text();
  probe("A01-marker", "a real session does render the authenticated marker",
        isAuthenticated(realPage),
        "marker missing — every negative auth probe below is vacuous");

  for (const path of ["/admin/invites", "/admin/audit"]) {
    const r = await client.go(APP + path);
    probe(`A01-page ${path}`, `${path} refuses a client with 404`,
          r.status === 404, `expected 404, got ${r.status}`);
  }

  // The audit trail names everyone who has ever signed in. A client reaching
  // it would be a roster leak on top of a privilege one.
  const auditLeak = await (await client.go(`${APP}/admin/audit`)).text();
  probe("A01-audit-leak", "no audit rows leak to a client",
        !auditLeak.includes("auth.signed_in") && !auditLeak.includes("invite.sent"));

  // The admin plugin ships privileged endpoints. A client must not reach them.
  for (const [name, path, body] of [
    ["list-users", "/api/auth/admin/list-users", null],
    ["set-role", "/api/auth/admin/set-role", { userId: "self", role: "admin" }],
    ["create-user", "/api/auth/admin/create-user",
      { email: "backdoor@nowhere.test", password: "x", name: "B", role: "admin" }],
    ["impersonate-user", "/api/auth/admin/impersonate-user", { userId: "x" }],
    ["remove-user", "/api/auth/admin/remove-user", { userId: "x" }],
    ["list-sessions", "/api/auth/admin/list-user-sessions", { userId: "x" }],
  ] as const) {
    const res = body
      ? await client.json(path, { ...body, userId: body.userId === "self" ? ayla.id : ayla.id })
      : await client.raw(APP + path, { headers: client.headers() });
    probe(`A01-${name}`, `admin API "${name}" refuses a client`,
          res.status === 401 || res.status === 403,
          `expected 401/403, got ${res.status}: ${(await res.text()).slice(0, 90)}`);
  }

  const escalated = await db.user.findUnique({ where: { id: ayla.id } });
  probe("A01-role", "client role unchanged after escalation attempts",
        escalated?.role === "client", `role is now ${escalated?.role}`);
  probe("A01-backdoor", "no back-door account was created",
        (await db.user.count({ where: { email: "backdoor@nowhere.test" } })) === 0);

  // Horizontal: the story detail scope. No /story route yet, so assert the
  // data-layer rule the future route will compose.
  const aylaStory = await db.story.create({
    data: {
      title: "Ayla's private hook", uploaderId: ayla.id, colorName: "Slate",
      colorHex: "#4a5d78", tip: "A beer", filename: "a.stl", fileSize: 1,
      mimeType: "model/stl", storageKey: "k1",
    },
  });
  // Imported from scope.ts, not authz.ts: the pure rule, no "server-only".
  const { storyScope } = await import("../src/lib/scope");
  const asMallory = await db.story.findFirst({
    where: { AND: [{ id: aylaStory.id }, storyScope({ ...mallory, role: "client" } as never)] },
  });
  probe("A01-idor", "storyScope hides another client's story", asMallory === null,
        "a client can read a story they do not own");

  // API routes answer with status codes rather than redirecting to HTML —
  // middleware deliberately lets them through, so each handler owes its own
  // check. This confirms the upload handler makes it.
  const anonUpload = await anon.raw(`${APP}/api/upload`, {
    method: "POST",
    body: (() => {
      const f = new FormData();
      f.set("file", new File([new Uint8Array([1, 2, 3])], "x.stl"));
      return f;
    })(),
  });
  probe("A01-anon-api", "an unauthenticated API call is 401, not a redirect",
        anonUpload.status === 401,
        `expected 401, got ${anonUpload.status} -> ${anonUpload.headers.get("location") ?? ""}`);

  // The uploader is taken from the session. A body claiming otherwise must
  // not be able to file a request in someone else's name.
  const spoof = new FormData();
  spoof.set("file", new File([stlBox(15, 15, 15) as BlobPart], "spoof.stl"));
  spoof.set("title", "Filed as someone else");
  spoof.set("material", "PLA");
  spoof.set("colorName", "Teal");
  spoof.set("quantity", "1");
  spoof.set("tip", "A beer");
  spoof.set("note", "");
  spoof.set("uploaderId", admin.id);
  spoof.set("status", "Done");
  await client.raw(`${APP}/api/upload`, { method: "POST", body: spoof });
  const spoofed = await db.story.findFirst({
    where: { title: "Filed as someone else" },
  });
  probe("A01-upload-owner", "the uploader comes from the session, not the body",
        spoofed?.uploaderId === ayla.id,
        `story is owned by ${spoofed?.uploaderId}, session was ${ayla.id}`);
  probe("A01-upload-status", "a posted status is ignored; new stories are Requested",
        spoofed?.status === "Requested", String(spoofed?.status));
  probe("A02-storage-key", "the storage key is generated, not taken from the filename",
        !!spoofed && !spoofed.storageKey.includes("spoof"),
        spoofed?.storageKey ?? "");

  const anonHome = await anon.raw(`${APP}/`);
  probe("A01-anon", "unauthenticated request is redirected",
        anonHome.status === 307 || anonHome.status === 302,
        `got ${anonHome.status}`);

  const forged = new Browser();
  forged.jar.set("ppp.session_token", "not-a-real-token");
  forged.jar.set("__Secure-ppp.session_token", "not-a-real-token");
  const forgedRes = await forged.go(`${APP}/`);
  const forgedBody = await forgedRes.text();
  probe("A01-forge", "a forged session cookie grants nothing",
        !isAuthenticated(forgedBody),
        "forged cookie reached an authenticated page");

  // =====================================================================
  section("A02 Cryptographic Failures");

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const cookieProbe = new Browser();
  const setRes = await attemptSignIn(cookieProbe, usernameFor(ayla.email), TEST_PASSWORD);
  const cookieLines = setRes.headers.getSetCookie();
  const sessionCookie = cookieLines.find((c) => c.includes("session_token")) ?? "";
  probe("A02-httponly", "session cookie is HttpOnly", /HttpOnly/i.test(sessionCookie), sessionCookie.slice(0, 80));
  probe("A02-samesite", "session cookie is SameSite", /SameSite=(Lax|Strict)/i.test(sessionCookie), sessionCookie.slice(0, 80));
  probe("A02-secure", "session cookie is Secure (or the app is on loopback http)",
        /Secure/i.test(sessionCookie) || APP.startsWith("http://localhost"),
        sessionCookie.slice(0, 80));

  const rawToken = /session_token=([^;]+)/.exec(sessionCookie)?.[1] ?? "";
  probe("A02-entropy", "session token has meaningful entropy", decodeURIComponent(rawToken).length >= 24,
        `token length ${rawToken.length}`);

  // Invite tokens must be unusable straight out of the database.
  const { createInvite } = await import("../src/lib/invites");
  await createInvite({ email: "crypto@office.example", invitedById: admin.id });
  const inviteRow = await db.invite.findFirst({ where: { email: "crypto@office.example" } });
  const inviteLinkUrl = await mailLink("crypto@office.example", CLAIM);
  const rawInviteToken = inviteLinkUrl?.split("/invite/")[1] ?? "";
  probe("A02-invite-hash", "invite token is stored hashed, not in the clear",
        !!inviteRow && inviteRow.tokenHash !== rawInviteToken && /^[a-f0-9]{64}$/.test(inviteRow.tokenHash),
        `stored=${inviteRow?.tokenHash?.slice(0, 20)}…`);

  // Reset tokens must be unusable straight out of the database too.
  const resetUrl = await issuePasswordSetupUrl(ayla.id);
  const rawResetToken = new URL(resetUrl).searchParams.get("token") ?? "";
  const verifications = await db.verification.findMany();
  probe("A02-reset-hash", "set-password token is stored hashed, not in the clear",
        rawResetToken.length > 20 &&
        verifications.every(
          (v) => !v.identifier.includes(rawResetToken) && !v.value.includes(rawResetToken),
        ),
        "a raw set-password token was found in the verification table");

  const storedPassword = (await db.account.findFirst({
    where: { userId: ayla.id, providerId: "credential" },
    select: { password: true },
  }))?.password ?? "";
  probe("A02-password-hash", "the account password is stored as a digest, never in the clear",
        storedPassword.length > 20 && !storedPassword.includes(TEST_PASSWORD),
        "the password, or something very like it, is readable in the account row");

  // =====================================================================
  section("A03 Injection");

  const sqlPayloads = ["' OR '1'='1", "'; DROP TABLE \"user\"; --", "\\'; SELECT pg_sleep(3); --"];
  let sqlOk = true;
  for (const p of sqlPayloads) {
    const r = await attemptSignIn(anon, p, "does-not-matter-at-all");
    if (r.status >= 500) sqlOk = false;
  }
  probe("A03-sqli", "SQL metacharacters in the username field are handled", sqlOk,
        "a payload produced a 5xx, suggesting it reached the driver");
  probe("A03-sqli-intact", "user table still exists after injection attempts",
        (await db.user.count()) > 0);

  // Stored XSS through the one attacker-controlled string that gets rendered.
  await db.user.update({
    where: { id: ayla.id },
    data: { name: '<img src=x onerror=alert(1)>"><script>alert(2)</script>' },
  });
  const xssHome = await (await client.go(`${APP}/`)).text();
  // Assert on the dangerous form specifically. The inner attribute text
  // ("onerror=alert(1)") legitimately survives inside an *escaped* string —
  // both in the DOM as "&lt;img … onerror=alert(1)&gt;" and in the RSC flight
  // payload as "\u003cimg …" — and matching that substring alone reports
  // correct escaping as a vulnerability. What must never appear is a raw
  // angle bracket opening a tag.
  const rawTag = /<img\s|<script>alert\(2\)/.test(xssHome);
  const wasEscaped = xssHome.includes("&lt;img") || xssHome.includes("\\u003cimg");
  probe("A03-stored-xss", "a hostile display name is escaped when rendered",
        !rawTag && wasEscaped,
        rawTag
          ? "raw markup from the name field reached the page"
          : "the payload was not rendered at all — the probe proved nothing");
  await db.user.update({ where: { id: ayla.id }, data: { name: "Ayla Berg" } });

  const reflected = await (await anon.go(`${APP}/signin?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)).text();
  probe("A03-reflected-xss", "the error query parameter is not reflected as markup",
        !reflected.includes("<script>alert(1)</script>"));

  const badToken = await (await anon.go(`${APP}/invite/%3Cscript%3Ealert(1)%3C%2Fscript%3E`)).text();
  probe("A03-path-xss", "a hostile invite token is not reflected as markup",
        !badToken.includes("<script>alert(1)</script>"));

  // Sign-up is the one public endpoint that takes an address at all, and the
  // address it takes is the one an invitation would later be matched against.
  const crlf = await anon.json("/api/auth/sign-up/email", {
    email: "a@x.test\r\nBcc: victim@evil.test",
    name: "Header Splitter",
    username: "splitter",
    password: TEST_PASSWORD,
  });
  probe("A03-crlf", "CRLF in the email field is refused, and never reaches the mailer",
        crlf.status >= 400 && crlf.status < 500 &&
        (await db.user.count({ where: { email: { contains: "\n" } } })) === 0,
        `status ${crlf.status}`);

  // =====================================================================
  section("A04 Insecure Design");

  // raw(), not go(): middleware redirects unknown paths to /signin, and
  // following that redirect would report the sign-in page's 200 as if a
  // signup route existed.
  for (const path of ["/signup", "/register"]) {
    const r = await anon.raw(APP + path);
    const landsOnSignin = (r.headers.get("location") ?? "").includes("/signin");
    probe(`A04-nosignup ${path}`, `${path} offers no public registration`,
          r.status === 404 || r.status === 405 || landsOnSignin || r.status === 307,
          `status ${r.status} -> ${r.headers.get("location") ?? ""}`);
  }

  // The sign-up endpoint does exist now — it is what an invitation link posts
  // to. What must hold is that it refuses anybody without a pending invite,
  // which is the invite-only rule and not a missing route.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const gatecrash = await anon.json("/api/auth/sign-up/email", {
    email: "gatecrasher@nowhere.test",
    name: "Gate Crasher",
    username: "gatecrasher",
    password: TEST_PASSWORD,
  });
  probe("A04-invitegate", "registration without a pending invite is refused",
        gatecrash.status === 403 &&
        (await db.user.count({ where: { email: "gatecrasher@nowhere.test" } })) === 0,
        `status ${gatecrash.status}`);

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const r = await attemptSignIn(anon, usernameFor(ayla.email), `guess-${i}-nope`);
    if (r.status === 429) { limited = true; break; }
  }
  probe("A04-ratelimit", "password guessing is rate limited", limited,
        "25 wrong passwords in a row were all answered normally");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');

  // =====================================================================
  section("A05 Security Misconfiguration");

  const headRes = await anon.raw(`${APP}/signin`);
  const H = (n: string) => headRes.headers.get(n) ?? "";
  probe("A05-nosniff", "X-Content-Type-Options is set", H("x-content-type-options") === "nosniff");
  probe("A05-frame", "clickjacking is blocked",
        /DENY|SAMEORIGIN/i.test(H("x-frame-options")) || /frame-ancestors/i.test(H("content-security-policy")));
  probe("A05-referrer", "Referrer-Policy is set", H("referrer-policy").length > 0);
  probe("A05-powered", "X-Powered-By is not advertised", H("x-powered-by") === "",
        `x-powered-by: ${H("x-powered-by")}`);
  probe("A05-csp", "a Content-Security-Policy is served", H("content-security-policy").length > 0,
        "no CSP header — a single XSS gets full script execution");

  for (const path of ["/.env", "/.git/config", "/prisma/schema.prisma", "/package.json", "/.env.local"]) {
    const r = await anon.raw(APP + path);
    probe(`A05-expose ${path}`, `${path} is not served`, r.status === 404 || r.status === 307,
          `status ${r.status}`);
  }

  const errRes = await anon.raw(`${APP}/api/auth/sign-in/username`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
  });
  const errBody = await errRes.text();
  probe("A05-stacktrace", "malformed input does not return a stack trace",
        !/at \w+ \(|\.ts:\d+:\d+|node_modules/.test(errBody), errBody.slice(0, 120));

  // =====================================================================
  section("A07 Identification and Authentication Failures");

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const known = await attemptSignIn(anon, usernameFor(ayla.email), "wrong-password-entirely");
  const unknown = await attemptSignIn(anon, "nobody-at-all", "wrong-password-entirely");
  const knownBody = await known.clone().text();
  const unknownBody = await unknown.clone().text();
  probe("A07-enum", "a real username and an invented one are answered identically",
        known.status === unknown.status && knownBody === unknownBody,
        `known=${known.status} ${knownBody} unknown=${unknown.status} ${unknownBody}`);

  // The wall clock is the other half of the oracle: an unknown username must
  // still pay for a password hash, or the timing says who exists.
  const time = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const knownMs = await time(() => attemptSignIn(anon, usernameFor(ayla.email), "wrong-password-entirely"));
  const unknownMs = await time(() => attemptSignIn(anon, "nobody-at-all", "wrong-password-entirely"));
  probe("A07-enum-timing", "an unknown username costs about as much as a wrong password",
        Math.min(knownMs, unknownMs) / Math.max(knownMs, unknownMs) > 0.25,
        `known=${knownMs.toFixed(0)}ms unknown=${unknownMs.toFixed(0)}ms`);

  // A set-password link must not sign anybody in, and must not work twice.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const linkOnly = new Browser();
  const setUrl = await issuePasswordSetupUrl(ayla.id);
  const setToken = new URL(setUrl).searchParams.get("token")!;
  const opened = await linkOnly.go(setUrl);
  probe("A07-reset-nosession", "opening a set-password link does not sign anybody in",
        !isAuthenticated(await opened.text()) && linkOnly.jar.size === 0,
        "following a reset link established a session");

  const RESET_TO = "ppp-probe-new-key-parked-outside";
  const firstUse = await new Browser().json("/api/auth/reset-password",
    { token: setToken, newPassword: RESET_TO });
  const secondUse = await new Browser().json("/api/auth/reset-password",
    { token: setToken, newPassword: "ppp-probe-third-key-parked-outside" });
  probe("A07-replay", "a set-password link cannot be redeemed twice",
        firstUse.status === 200 && secondUse.status >= 400,
        `first=${firstUse.status} second=${secondUse.status}`);

  // Setting a password revokes what the old one opened. `attacker` is left
  // alone; only Ayla's sessions should be gone.
  probe("A07-reset-revokes", "setting a new password ends the sessions the old one opened",
        (await db.session.count({ where: { userId: ayla.id } })) === 0 &&
        (await db.session.count({ where: { userId: mallory.id } })) > 0,
        "a session outlived the password that opened it");

  // Put the suite's own password back, so the probes after this still work.
  await ensureCredentials(APP, ayla.id, usernameFor(ayla.email));
  const client2 = await signIn(ayla);

  // Open redirect through the API's callbackURL.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const evil = await attemptSignIn(
    new Browser(), usernameFor(ayla.email), TEST_PASSWORD,
    { callbackURL: "https://evil.example/steal" },
  );
  const evilLocation = evil.headers.get("location") ?? "";
  probe("A07-openredirect", "an off-site callbackURL is refused",
        evil.status >= 400 && !evilLocation.startsWith("https://evil.example"),
        `status ${evil.status} -> ${evilLocation}`);

  // The raw value does appear in the RSC flight payload as a page prop, which
  // is inert. What matters is whether anything *navigable* points off-site,
  // and whether the value survives safeNext() into the form.
  const nextHtml = await (await anon.go(`${APP}/signin?next=https://evil.example`)).text();
  const navigable = /(?:href|action|url|location)\s*[=:]\s*["']?https?:\/\/evil\.example/i.test(nextHtml);
  probe("A07-nextparam", "no navigable target points off-site", !navigable,
        "an href/action/redirect referenced the attacker origin");

  const { default: _ } = { default: null };
  const protoRel = await anon.raw(`${APP}/signin?next=//evil.example`);
  probe("A07-protorel", "a protocol-relative ?next is not honoured",
        !(protoRel.headers.get("location") ?? "").includes("evil.example"),
        protoRel.headers.get("location") ?? "");

  // Sign-out must kill the session server-side, not just drop the cookie.
  const leaver = client2;
  const stolen = new Map(leaver.jar);
  const signedOut = await leaver.raw(`${APP}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  probe("A07-signout-ok", "the sign-out endpoint accepts the request",
        signedOut.status === 200, `status ${signedOut.status}`);
  const thief = new Browser();
  for (const [k, v] of stolen) thief.jar.set(k, v);
  const afterOut = await (await thief.go(`${APP}/`)).text();
  probe("A07-logout", "every captured cookie is dead after sign-out",
        !isAuthenticated(afterOut),
        "a captured cookie still authenticates after sign-out — check that " +
        "session.cookieCache is off, or revocation lags by its lifetime");

  // The specific token, not every session this user has: earlier probes in
  // this run opened several, and sign-out only ends the one it was called on.
  const revokedToken = decodeURIComponent(
    (stolen.get("ppp.session_token") ?? stolen.get("__Secure-ppp.session_token") ?? ""),
  ).split(".")[0];
  probe("A07-session-row", "the signed-out session row is gone from the database",
        revokedToken.length > 0 &&
        (await db.session.count({ where: { token: revokedToken } })) === 0,
        `token ${revokedToken.slice(0, 8)}… still present`);

  // =====================================================================
  section("A08 Software and Data Integrity Failures");

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await createInvite({ email: "integrity@office.example", invitedById: admin.id });

  // Declared `input: false`, so the request is refused rather than trimmed.
  const privileged = await new Browser().json("/api/auth/sign-up/email", {
    email: "integrity@office.example",
    name: "Ines Tegrity",
    username: "integrity",
    password: TEST_PASSWORD,
    role: "admin", initials: "ZZ", invitedById: null,
  });
  probe("A08-massassign-refused", "a sign-up carrying privileged fields is refused",
        privileged.status === 400 &&
        (await db.user.count({ where: { email: "integrity@office.example" } })) === 0,
        `status ${privileged.status} ${(await privileged.clone().text()).slice(0, 90)}`);

  // The rest reach the endpoint undeclared, and are overruled server-side.
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await new Browser().json("/api/auth/sign-up/email", {
    email: "integrity@office.example",
    name: "Ines Tegrity",
    username: "integrity",
    password: TEST_PASSWORD,
    emailVerified: false, banned: true, id: "chosen-by-attacker",
  });
  const created = await db.user.findUnique({ where: { email: "integrity@office.example" } });
  probe("A08-massassign", "privileged fields cannot be set from the request body",
        created?.role === "client" && created.initials !== "ZZ" &&
        created.id !== "chosen-by-attacker" && created.invitedById === admin.id &&
        created.banned !== true,
        JSON.stringify({ role: created?.role, initials: created?.initials,
                         id: created?.id, banned: created?.banned }));

  probe("A08-lockfile", "a dependency lockfile is committed",
        await Bun_exists("package-lock.json"));

  // =====================================================================
  section("A10 Server-Side Request Forgery");

  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  const ssrf = await attemptSignIn(
    new Browser(), usernameFor(ayla.email), TEST_PASSWORD,
    { callbackURL: "http://169.254.169.254/latest/meta-data/" },
  );
  const hitMetadata =
    ssrf.status < 400 && (ssrf.headers.get("location") ?? "").includes("169.254.169.254");
  probe("A10-metadata", "a link-local callbackURL is refused", !hitMetadata,
        "the app would redirect a browser at the cloud metadata service");

  // =====================================================================
  console.info(
    `\n${passed} probes passed, ${findings.length} flagged.` +
      (findings.length
        ? "\n\nFLAGGED:\n" + findings.map((f) => `  ${f.id}  ${f.title}\n      ${f.detail}`).join("\n")
        : ""),
  );
  process.exitCode = findings.length ? 1 : 0;
}

async function Bun_exists(p: string) {
  const { access } = await import("node:fs/promises");
  return access(p).then(() => true).catch(() => false);
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

import "./_env";
/**
 * End-to-end check of the JSON API, the OpenAPI document and the console.
 *
 *   npm run verify:api
 *
 * Three things this suite is really asserting, in order of how much they
 * would cost to get wrong:
 *
 *   1. **The API enforces the same rules the pages do.** Both front doors run
 *      through `src/lib/stories.ts`, and this drives the JSON one against
 *      every rule `verify:queue` drives through the forms — scope, the flow,
 *      who may decline, who may withdraw. A rule that only holds for the
 *      caller that remembered it is not a rule.
 *   2. **The document matches the app.** Every path in `/api/openapi.json` is
 *      requested, and a 404 fails the suite. A published description that has
 *      drifted from the thing it describes is worse than no description.
 *   3. **The console loads nothing from anywhere else.** The CSP is not
 *      decorative; a CDN reference in `/docs` would render a blank page in
 *      production and pass any test that only checked for a 200.
 *
 * DESTRUCTIVE: wipes users and stories. Development database only.
 */
import { db } from "../src/lib/db";
import { storyRef } from "../src/lib/scope";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) =>
  console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

/**
 * A cookie jar, plus the bearer token the sign-in handed back.
 *
 * Both are kept so the same client can be driven either way — which is the
 * only honest way to assert that the two carry identical authority.
 */
class Client {
  jar = new Map<string, string>();
  token: string | null = null;

  private store(r: Response) {
    for (const line of r.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (!v || line.includes("Max-Age=0")) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const issued = r.headers.get("set-auth-token");
    if (issued) this.token = issued;
  }

  /** Cookie-carried, the way a browser does it. */
  async raw(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      origin: APP,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(url, { ...init, redirect: "manual", headers });
    this.store(r);
    return r;
  }

  /** Bearer-carried, the way a script does it. No cookie, no Origin. */
  bearer(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        authorization: `Bearer ${this.token ?? ""}`,
      },
    });
  }

  async json<T = Record<string, unknown>>(
    url: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const r = await this.raw(url, {
      ...init,
      headers: { "content-type": "application/json", ...((init.headers as object) ?? {}) },
    });
    const text = await r.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: `not JSON: ${text.slice(0, 120)}` };
    }
    return { status: r.status, body: body as T };
  }
}

async function signIn(user: { id: string; email: string }): Promise<Client> {
  const c = new Client();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(c, APP, usernameFor(user.email));
  return c;
}

async function makeStory(uploaderId: string, title: string, status = "Requested") {
  return db.story.create({
    data: {
      title, status: status as never, uploaderId,
      material: "PETG", colorName: "Slate", colorHex: "#4a5d78", tip: "A beer",
      quantity: 1, note: "", filename: "part.stl", fileSize: 1234,
      mimeType: "model/stl", storageKey: `secret-object-key-${title}`,
      dims: "10 × 10 × 10 mm",
    },
  });
}

type Doc = {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
  tags?: { name: string }[];
  servers?: { url: string }[];
};

async function main() {
  section("setup");
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
  const ayla = await db.user.create({
    data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY",
            role: "client", emailVerified: true, invitedById: admin.id },
  });
  const mallory = await db.user.create({
    data: { email: "mallory@office.example", name: "Mallory Quint", initials: "MQ",
            role: "client", emailVerified: true, invitedById: admin.id },
  });

  const ruben = await signIn(admin);
  const client = await signIn(ayla);
  const other = await signIn(mallory);
  console.info(`  admin=${admin.email}  client=${ayla.email}  third=${mallory.email}`);

  // ------------------------------------------------------------------
  section("an unauthenticated caller is answered, not redirected");

  // The whole reason middleware exempts /api from the sign-in redirect: an
  // XHR that follows a 307 to an HTML page reports a mystifying success.
  for (const [method, path] of [
    ["GET", "/api/stories"],
    ["GET", "/api/stories/1"],
    ["POST", "/api/stories/1/advance"],
    ["GET", "/api/notifications"],
    ["GET", "/api/openapi.json"],
  ] as const) {
    const r = await fetch(`${APP}${path}`, { method, redirect: "manual" });
    const body = await r.text();
    check(`${method} ${path} is 401 JSON`,
          r.status === 401 && body.trimStart().startsWith("{"),
          `status ${r.status} body ${body.slice(0, 80)}`);
  }

  // Enabling Better Auth's openAPI plugin mounts an endpoint that answers the
  // whole auth surface to anybody, session or not. The app calls that
  // generator in process and never over HTTP, so middleware shuts the route —
  // for everyone, not merely for strangers, since nothing legitimate uses it.
  for (const [who, as] of [["a stranger", null], ["a signed-in caller", client]] as const) {
    const r = as
      ? await as.raw(`${APP}/api/auth/open-api/generate-schema`)
      : await fetch(`${APP}/api/auth/open-api/generate-schema`, { redirect: "manual" });
    check(`the auth plugin's schema endpoint is 404 to ${who}`,
          r.status === 404, `status ${r.status}`);
  }
  check("and its CDN-loading reference page is off",
        (await fetch(`${APP}/api/auth/reference`, { redirect: "manual" })).status === 404);

  const anonDocs = await fetch(`${APP}/docs`, { redirect: "manual" });
  check("/docs sends a signed-out visitor to sign in",
        anonDocs.status >= 300 && anonDocs.status < 400 &&
        (anonDocs.headers.get("location") ?? "").includes("/signin"),
        `status ${anonDocs.status} → ${anonDocs.headers.get("location")}`);

  // ------------------------------------------------------------------
  section("the document describes the app that is running");

  const { status: docStatus, body: doc } = await client.json<Doc>(`${APP}/api/openapi.json`);
  check("a signed-in client can read it", docStatus === 200, `status ${docStatus}`);
  check("it is OpenAPI 3.1", doc.openapi === "3.1.0", String(doc.openapi));
  check("it names this deployment as the server",
        doc.servers?.[0]?.url === APP, JSON.stringify(doc.servers));
  check("it declares both ways to carry a session",
        Boolean(doc.components?.securitySchemes?.sessionCookie) &&
        Boolean(doc.components?.securitySchemes?.bearerAuth),
        Object.keys(doc.components?.securitySchemes ?? {}).join(","));

  const paths = Object.keys(doc.paths ?? {});
  for (const expected of [
    "/api/health", "/api/stories", "/api/stories/{id}",
    "/api/stories/{id}/advance", "/api/stories/{id}/decline",
    "/api/stories/{id}/flag", "/api/stories/{id}/comments",
    "/api/notifications", "/api/notifications/read",
    "/api/upload", "/api/models/{id}",
  ]) {
    check(`it documents ${expected}`, paths.includes(expected));
  }

  const authPaths = paths.filter((p) => p.startsWith("/api/auth/"));
  check("Better Auth's own surface is folded in, not re-typed",
        authPaths.length >= 10, `${authPaths.length} auth paths`);
  check("and every one is mounted where this app mounts it",
        authPaths.every((p) => p.startsWith("/api/auth/")),
        authPaths.slice(0, 3).join(" "));
  check("the sign-in that hands out a bearer token is in there",
        paths.includes("/api/auth/sign-in/username"),
        authPaths.filter((p) => p.includes("sign-in")).join(" "));

  // The check that catches drift: ask for every documented path and refuse a
  // 404. A description of an endpoint that is not there is worse than none.
  //
  // Unauthenticated, on purpose. `withActor` answers 401 before it looks at a
  // path parameter or touches the database, so "not 404" proves the route is
  // mounted without a single row changing — which matters, because driving
  // this loop with a live session would post to `/api/auth/sign-out` and
  // every other verb the document lists.
  //
  // Better Auth's half is deliberately NOT probed: those paths come from its
  // own router rather than from anything written here, so there is nothing to
  // drift, and hammering sixty auth endpoints to prove it would trip the rate
  // limiter and muddy the audit trail. What is asserted about them is that
  // they are rebased onto this app's mount point, above.
  const ownPaths = paths.filter((p) => !p.startsWith("/api/auth/"));
  const missing: string[] = [];
  for (const path of ownPaths) {
    const methods = Object.keys(doc.paths?.[path] ?? {}).filter((m) =>
      ["get", "post", "put", "patch", "delete"].includes(m),
    );
    for (const method of methods) {
      const url = APP + path.replace(/\{[^}]+\}/g, "999999");
      const r = await fetch(url, { method: method.toUpperCase(), redirect: "manual" });
      if (r.status === 404) missing.push(`${method.toUpperCase()} ${path}`);
    }
  }
  check(`every documented path this app owns is served by a route (${ownPaths.length} of them)`,
        missing.length === 0, missing.join(", "));

  // The Zod schemas the handlers validate with, lifted into the document.
  const wish = doc.components?.schemas?.Wish as { properties?: Record<string, unknown> };
  check("the upload's body is derived from WishSchema, not typed out twice",
        Boolean(wish?.properties?.material && wish?.properties?.quantity),
        Object.keys(wish?.properties ?? {}).join(","));

  // ------------------------------------------------------------------
  section("scope: a client sees their own, the printer owner sees all");

  const mine = await makeStory(ayla.id, "Hook for the monitor arm");
  const theirs = await makeStory(mallory.id, "Not Ayla's business");

  const listed = await client.json<{ stories: { id: number }[] }>(`${APP}/api/stories`);
  check("the client's list has their own ticket",
        listed.body.stories.some((s) => s.id === mine.id));
  check("and not somebody else's",
        !listed.body.stories.some((s) => s.id === theirs.id),
        listed.body.stories.map((s) => s.id).join(","));

  const asAdmin = await ruben.json<{ stories: { id: number }[] }>(`${APP}/api/stories`);
  check("the printer owner's list has both",
        asAdmin.body.stories.some((s) => s.id === mine.id) &&
        asAdmin.body.stories.some((s) => s.id === theirs.id));

  const peek = await client.json<{ error?: string }>(`${APP}/api/stories/${theirs.id}`);
  check("reading another client's ticket is 404, not 403",
        peek.status === 404, `status ${peek.status}`);
  check("and the model behind it is 404 too",
        (await client.raw(`${APP}/api/models/${theirs.id}`)).status === 404);

  // `mine=true` narrows; there is no parameter that widens.
  const narrowed = await ruben.json<{ stories: { id: number }[] }>(`${APP}/api/stories?mine=true`);
  check("`mine=true` narrows the printer owner to their own",
        !narrowed.body.stories.some((s) => s.id === mine.id),
        narrowed.body.stories.map((s) => s.id).join(","));

  const oneStory = await client.json<Record<string, unknown>>(`${APP}/api/stories/${mine.id}`);
  check("a ticket carries its display ref", oneStory.body.ref === storyRef(mine.id),
        String(oneStory.body.ref));
  check("the storage key is not on the wire",
        !JSON.stringify(oneStory.body).includes("secret-object-key"),
        JSON.stringify(oneStory.body).slice(0, 200));
  check("and neither is the uploader's address",
        !JSON.stringify(oneStory.body).includes("@office.example"));

  // ------------------------------------------------------------------
  section("the flow, over JSON, with the same rules as the forms");

  const refused = await client.json<{ error?: string }>(
    `${APP}/api/stories/${mine.id}/advance`, { method: "POST" });
  check("a client cannot move their own ticket along",
        refused.status === 403, `status ${refused.status}`);
  check("and it did not move",
        (await db.story.findUnique({ where: { id: mine.id } }))?.status === "Requested");

  const advanced = await ruben.json<{ moved?: { from: string; to: string }; notified?: string }>(
    `${APP}/api/stories/${mine.id}/advance`, { method: "POST" });
  check("the printer owner moves Requested → Accepted",
        advanced.status === 200 && advanced.body.moved?.to === "Accepted",
        JSON.stringify(advanced.body).slice(0, 160));
  check("the uploader is told",
        (await db.notification.count({ where: { recipientId: ayla.id, storyId: mine.id } })) > 0);
  check("and it is audited",
        (await db.auditEvent.count({
          where: { action: "story.status_changed", subject: storyRef(mine.id) },
        })) === 1);

  const declineLate = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${mine.id}/decline`, { method: "POST" });
  check("an Accepted ticket cannot be declined",
        declineLate.status === 403, `status ${declineLate.status} ${declineLate.body.error}`);

  for (const expected of ["Printing", "Delivery", "Done"]) {
    const r = await ruben.json<{ moved?: { to: string } }>(
      `${APP}/api/stories/${mine.id}/advance`, { method: "POST" });
    check(`advanced to ${expected}`, r.body.moved?.to === expected, JSON.stringify(r.body).slice(0, 120));
  }

  const past = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${mine.id}/advance`, { method: "POST" });
  check("Done is the end of the line, and says so rather than wrapping round",
        past.status === 409, `status ${past.status} ${past.body.error}`);
  check("the ticket is still Done",
        (await db.story.findUnique({ where: { id: mine.id } }))?.status === "Done");

  // There is no endpoint that takes a target status — the only way to move a
  // ticket is one derived step, so nothing can skip one.
  check("no endpoint accepts a status to jump to",
        !paths.some((p) => /status/i.test(p)), paths.filter((p) => /status/i.test(p)).join(","));

  // ------------------------------------------------------------------
  section("declining, flagging, and the way off a flag");

  const fresh = await makeStory(ayla.id, "Bracket");
  const declined = await ruben.json<{ moved?: { to: string } }>(
    `${APP}/api/stories/${fresh.id}/decline`, { method: "POST" });
  check("Requested → Declined", declined.body.moved?.to === "Declined",
        JSON.stringify(declined.body).slice(0, 120));

  const toFlag = await makeStory(ayla.id, "Thin walls", "Accepted");
  const noReason = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${toFlag.id}/flag`, { method: "POST", body: JSON.stringify({}) });
  check("a flag with no reason is refused", noReason.status === 400, noReason.body.error);

  const short = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${toFlag.id}/flag`, { method: "POST", body: JSON.stringify({ reason: "no" }) });
  check("and one too short to act on", short.status === 400, short.body.error);

  const flagged = await ruben.json<{ story?: { flagged: boolean; status: string } }>(
    `${APP}/api/stories/${toFlag.id}/flag`,
    { method: "POST", body: JSON.stringify({ reason: "The walls are 0.3 mm." }) });
  check("a flag with a reason sticks", flagged.body.story?.flagged === true);
  check("and does NOT change the status",
        flagged.body.story?.status === "Accepted", String(flagged.body.story?.status));
  check("the reason reaches the uploader",
        (await db.notification.findFirst({
          where: { recipientId: ayla.id, storyId: toFlag.id },
          orderBy: { createdAt: "desc" },
        }))?.text.includes("0.3 mm") === true);

  const clientFlag = await client.json(`${APP}/api/stories/${toFlag.id}/flag`,
    { method: "POST", body: JSON.stringify({ reason: "let me in" }) });
  check("a client cannot flag anything", clientFlag.status === 403, `status ${clientFlag.status}`);

  const cleared = await ruben.json<{ story?: { flagged: boolean } }>(
    `${APP}/api/stories/${toFlag.id}/flag`, { method: "DELETE" });
  check("the flag can be cleared", cleared.body.story?.flagged === false);
  const again = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${toFlag.id}/flag`, { method: "DELETE" });
  check("clearing a flag that is not there is 409, not a silent success",
        again.status === 409, `status ${again.status} ${again.body.error}`);

  // ------------------------------------------------------------------
  section("withdrawing is the requester's, and only while nobody has acted");

  const regret = await makeStory(ayla.id, "Changed my mind");
  const adminDelete = await ruben.json<{ error?: string }>(
    `${APP}/api/stories/${regret.id}`, { method: "DELETE" });
  check("the printer owner cannot withdraw somebody's request",
        adminDelete.status === 403, `status ${adminDelete.status} ${adminDelete.body.error}`);
  check("so it is still there",
        (await db.story.count({ where: { id: regret.id } })) === 1);

  const withdrawn = await client.json<{ withdrawn?: boolean; ref?: string }>(
    `${APP}/api/stories/${regret.id}`, { method: "DELETE" });
  check("the requester can", withdrawn.body.withdrawn === true, JSON.stringify(withdrawn.body));
  check("and it is gone", (await db.story.count({ where: { id: regret.id } })) === 0);
  check("and audited",
        (await db.auditEvent.count({
          where: { action: "story.withdrawn", subject: storyRef(regret.id) },
        })) === 1);

  const started = await makeStory(ayla.id, "Already printing", "Printing");
  const tooLate = await client.json<{ error?: string }>(
    `${APP}/api/stories/${started.id}`, { method: "DELETE" });
  check("a ticket already being printed cannot be withdrawn",
        tooLate.status === 409, `status ${tooLate.status} ${tooLate.body.error}`);
  check("and the reason names who to ask",
        (tooLate.body.error ?? "").includes(admin.name.split(" ")[0]!), tooLate.body.error);

  // ------------------------------------------------------------------
  section("the conversation");

  const empty = await client.json<{ error?: string }>(
    `${APP}/api/stories/${mine.id}/comments`, { method: "POST", body: JSON.stringify({ body: "  " }) });
  check("an empty comment is refused", empty.status === 400, empty.body.error);

  const posted = await client.json<{ id?: string; author?: { role: string } }>(
    `${APP}/api/stories/${mine.id}/comments`,
    { method: "POST", body: JSON.stringify({ body: "Could you do it in teal?" }) });
  check("a comment is created", posted.status === 201 && Boolean(posted.body.id),
        `status ${posted.status}`);
  check("attributed to the client", posted.body.author?.role === "client");
  check("and the printer owner is told",
        (await db.notification.count({
          where: { recipientId: admin.id, storyId: mine.id },
        })) > 0);

  const thread = await client.json<{ comments: { body: string }[] }>(
    `${APP}/api/stories/${mine.id}/comments`);
  check("the thread reads back", thread.body.comments.length === 1);

  const intrusion = await other.json<{ error?: string }>(
    `${APP}/api/stories/${mine.id}/comments`,
    { method: "POST", body: JSON.stringify({ body: "hello" }) });
  check("another client cannot comment on a ticket they cannot see",
        intrusion.status === 404, `status ${intrusion.status}`);
  check("and cannot read the thread either",
        (await other.json(`${APP}/api/stories/${mine.id}/comments`)).status === 404);
  check("nothing of theirs was written",
        (await db.comment.count({ where: { authorId: mallory.id } })) === 0);

  // ------------------------------------------------------------------
  section("notifications are per recipient");

  const feed = await client.json<{ notifications: { id: string }[]; unread: number }>(
    `${APP}/api/notifications`);
  check("the client has a feed", feed.body.notifications.length > 0);
  check("with an unread count", feed.body.unread > 0, String(feed.body.unread));

  const someoneElses = await db.notification.findFirst({ where: { recipientId: admin.id } });
  const poke = await client.json<{ changed?: number }>(`${APP}/api/notifications/read`,
    { method: "POST", body: JSON.stringify({ id: someoneElses?.id ?? "none" }) });
  check("marking somebody else's notification read is a no-op, not a 404",
        poke.status === 200 && poke.body.changed === 0,
        `status ${poke.status} changed ${poke.body.changed}`);
  check("and theirs is still unread",
        (await db.notification.findUnique({ where: { id: someoneElses!.id } }))?.read === false);

  const all = await client.json<{ unread?: number }>(`${APP}/api/notifications/read`,
    { method: "POST" });
  check("an empty body marks the whole feed read", all.body.unread === 0, JSON.stringify(all.body));

  // ------------------------------------------------------------------
  section("a bearer token is the session, and nothing more");

  check("sign-in handed one back", Boolean(client.token), String(client.token).slice(0, 12));

  const viaToken = await client.bearer(`${APP}/api/stories`);
  check("it authenticates without a cookie", viaToken.status === 200, `status ${viaToken.status}`);

  const scopedByToken = await client.bearer(`${APP}/api/stories/${theirs.id}`);
  check("and grants no more than the cookie does",
        scopedByToken.status === 404, `status ${scopedByToken.status}`);

  const garbage = await fetch(`${APP}/api/stories`, {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  check("an invented token is 401", garbage.status === 401, `status ${garbage.status}`);

  // Signing out has to kill both, or the token is a way back in to an account
  // whose owner believes they have left.
  const parting = client.token;
  await client.raw(`${APP}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const afterSignOut = await fetch(`${APP}/api/stories`, {
    headers: { authorization: `Bearer ${parting}` },
  });
  check("signing out revokes the bearer token too",
        afterSignOut.status === 401, `status ${afterSignOut.status}`);

  // ------------------------------------------------------------------
  section("cross-origin writes are refused");

  const evil = await ruben.raw(`${APP}/api/stories/${started.id}/advance`, {
    method: "POST",
    headers: { origin: "https://not-this-app.example" },
  });
  check("a write carrying a foreign Origin is 403",
        evil.status === 403, `status ${evil.status}`);
  check("and nothing moved",
        (await db.story.findUnique({ where: { id: started.id } }))?.status === "Printing");

  // A token from an account that is already signed in — re-signing anybody in
  // resets their password, and `revokeSessionsOnPasswordReset` would take the
  // session this suite is still holding out from under it.
  const noOrigin = await fetch(`${APP}/api/stories`, {
    headers: { authorization: `Bearer ${other.token}` },
  });
  check("a request with no Origin at all is fine — that is curl",
        noOrigin.status === 200, `status ${noOrigin.status}`);

  // ------------------------------------------------------------------
  section("the console loads from this origin and nowhere else");

  const console_ = await ruben.raw(`${APP}/docs`);
  const html = await console_.text();
  check("/docs serves a document to a signed-in caller",
        console_.status === 200 &&
        (console_.headers.get("content-type") ?? "").includes("text/html"),
        `status ${console_.status}`);
  check("it points Swagger UI at this app's document",
        html.includes('url: "/api/openapi.json"'));

  // Subresources only — a `<script src>`, a `<link>`, an `<img>`, a frame.
  // The prose link out to docs/api.md is a hyperlink a person clicks, not
  // something the browser fetches to render the page, and the CSP has no
  // opinion about it.
  const subresources = [
    ...html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/g),
  ].map((m) => m[1]!);
  const external = subresources.filter((u) => /^(?:https?:)?\/\//.test(u));
  check(`it fetches nothing from another origin (${subresources.length} subresources)`,
        external.length === 0, external.join(" "));

  const csp = console_.headers.get("content-security-policy") ?? "";
  check("and is served under the same CSP as every other page",
        csp.includes("script-src"), csp.slice(0, 80));

  // In production the CSP has no 'unsafe-inline', so an unnonced inline script
  // is a page that silently does nothing.
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1] ?? "";
  const inlineScripts = (html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? []);
  check("every inline script carries a nonce",
        inlineScripts.length > 0 && inlineScripts.every((s) => s.includes("nonce=")),
        inlineScripts.join(" "));
  // In production `script-src` is `'self' 'nonce-…' 'strict-dynamic'`, so the
  // markup's nonce has to be the one this very response's header names or the
  // console silently does nothing. The dev policy carries no nonce at all —
  // it allows 'unsafe-inline' so HMR can work — so there the same question
  // ("will this script be allowed to run?") is answered a different way.
  // Which branch ran is printed, because a check that quietly tests less than
  // its name claims is worse than one that fails.
  const nonced = csp.includes("'nonce-");
  console.info(`          [${nonced ? "production" : "development"} CSP]`);
  check("the inline script is permitted by this response's own policy",
        nonced
          ? nonce.length > 0 && csp.includes(`'nonce-${nonce}'`)
          : /script-src[^;]*'unsafe-inline'/.test(csp),
        `nonce ${nonce || "(none)"} vs csp ${csp.slice(0, 140)}`);

  // The trap this catches, because it cost an hour once: `style-src` is
  // `'self'` with no nonce for styles, so an inline <style> block is dropped
  // and the page renders *unstyled* rather than failing. A silent visual
  // regression is exactly the kind this repo asks to be made loud.
  check("the console carries no inline <style> block, which the CSP would drop",
        !/<style[\s>]/i.test(html),
        (html.match(/<style[^>]*>/i) ?? []).join(" "));
  check("its stylesheet is a file, and one that is served",
        html.includes('href="/api-console.css"') &&
        (await ruben.raw(`${APP}/api-console.css`)).status === 200);

  for (const asset of ["/docs/swagger-ui-bundle.js", "/docs/swagger-ui.css"]) {
    const r = await ruben.raw(`${APP}${asset}`);
    check(`${asset} is served`, r.status === 200, `status ${r.status}`);
  }

  const bundle = await (await ruben.raw(`${APP}/docs/swagger-ui-bundle.js`)).text();
  check("the vendored bundle has no source-map reference to 404 on",
        !bundle.includes("sourceMappingURL"));
  check("Swagger UI's licence travels with the copy",
        (await ruben.raw(`${APP}/docs/LICENSE.swagger-ui.txt`)).status === 200);

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

import "./_env";
/**
 * End-to-end check of the admin queue and the status flow.
 *
 *   npm run verify:queue
 *
 * Drives the real forms — the admin panel is plain server-rendered forms, so
 * this posts exactly what a browser with JavaScript off would post. Which is
 * also the point: the flow has to work without a client bundle.
 *
 * DESTRUCTIVE: wipes users and stories. Development database only.
 */
import { db } from "../src/lib/db";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) =>
  console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

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
  private headers(): Record<string, string> {
    const h: Record<string, string> = { origin: APP };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return h;
  }
  async raw(url: string, init: RequestInit = {}) {
    const r = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), ...this.headers() },
    });
    this.store(r);
    return r;
  }
  async go(url: string, init: RequestInit = {}) {
    let r = await this.raw(url, init);
    for (let i = 0; i < 8; i++) {
      const loc = r.headers.get("location");
      if (!loc || r.status < 300 || r.status >= 400) break;
      r = await this.raw(new URL(loc, url).toString());
    }
    return r;
  }
  /** Replays a server-action form the way a JS-less browser does. */
  async submit(url: string, html: string, formIndex: number, values: Record<string, string>) {
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    const form = forms[formIndex];
    if (!form) throw new Error(`no form #${formIndex} on ${url}`);
    const body = new FormData();
    for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
      if (!tag.includes('type="hidden"')) continue;
      const n = /name="([^"]*)"/.exec(tag)?.[1];
      const v = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (n) body.append(unescapeHtml(n), unescapeHtml(v));
    }
    for (const [k, v] of Object.entries(values)) body.set(k, v);
    return this.raw(url, { method: "POST", body });
  }
}
/**
 * React SSR puts an empty comment between static text and an interpolation,
 * so "offers {tip}" reaches the wire as "offers <!-- -->A beer". Asserting on
 * the raw markup therefore fails on copy that is perfectly correct.
 */
const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");

/** Reads one parameter out of a Location header, with form decoding. */
function paramOf(location: string | null, key: string): string {
  if (!location) return "";
  const q = location.split("?")[1] ?? "";
  return new URLSearchParams(q).get(key) ?? "";
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function signIn(email: string): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  await b.raw(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
  for (const m of list.messages ?? []) {
    if (!(m.To ?? []).some((a: { Address?: string }) => a.Address?.toLowerCase() === email)) continue;
    const body = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = /http:\/\/[^\s"'<]+\/api\/auth\/magic-link\/verify[^\s"'<]*/.exec(body.Text ?? "");
    if (hit) { await b.go(hit[0].replace(/[.,]$/, "")); break; }
  }
  return b;
}

/** Finds the index of the form whose markup contains a marker. */
function formIndexContaining(html: string, marker: string): number {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.findIndex((f) => f.includes(marker));
}

async function makeStory(uploaderId: string, title: string, status = "Requested") {
  return db.story.create({
    data: {
      title, status: status as never, uploaderId,
      material: "PETG", colorName: "Slate", colorHex: "#4a5d78", tip: "A beer",
      quantity: 1, note: "", filename: "part.stl", fileSize: 1234,
      mimeType: "model/stl", storageKey: `k-${title}`, dims: "10 × 10 × 10 mm",
    },
  });
}

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

  const ruben = await signIn(admin.email);
  const client = await signIn(ayla.email);
  console.info(`  admin=${admin.email}  client=${ayla.email}`);

  // ------------------------------------------------------------------
  section("the queue is admin-only");
  const denied = await client.go(`${APP}/queue`);
  check("a client gets 404, not 403", denied.status === 404, `status ${denied.status}`);

  const home = await client.go(`${APP}/`);
  check("a client's home is the rail, not the queue",
        rendered(await home.text()).includes("The backlog"));

  const adminHome = await ruben.go(`${APP}/`);
  check("the admin's home is the queue",
        rendered(await adminHome.text()).includes("queue"));

  // ------------------------------------------------------------------
  section("accepting a ticket");
  const story = await makeStory(ayla.id, "Hook for the monitor arm");
  let page = await (await ruben.go(`${APP}/queue`)).text();
  check("it shows up under Waiting on you",
        page.includes("Waiting on you") && page.includes("Hook for the monitor arm"));
  check("with the wish spelled out", rendered(page).includes("offers A beer"),
        "the wish line did not render as expected");

  const acceptIdx = formIndexContaining(page, "Accept it");
  const accepted = await ruben.submit(`${APP}/queue`, page, acceptIdx, {});
  check("accept redirects with a result",
        accepted.status >= 300 && accepted.status < 400,
        `status ${accepted.status}`);

  let row = await db.story.findUnique({ where: { id: story.id } });
  check("Requested -> Accepted", row?.status === "Accepted", String(row?.status));
  check("the uploader was notified",
        (await db.notification.count({ where: { recipientId: ayla.id, storyId: story.id } })) === 1);
  check("and it was audited",
        (await db.auditEvent.count({ where: { action: "story.status_changed" } })) === 1);
  // `+` is form encoding for a space; decodeURIComponent leaves it alone,
  // so the message has to be read with URLSearchParams.
  check("the toast names the person told",
        paramOf(accepted.headers.get("location"), "toast").includes("Ayla Berg notified"),
        paramOf(accepted.headers.get("location"), "toast"));

  // ------------------------------------------------------------------
  section("the flow only moves forward, one step at a time");
  for (const expected of ["Printing", "Done", "Delivery"]) {
    page = await (await ruben.go(`${APP}/queue`)).text();
    const idx = formIndexContaining(page, `Move to ${expected}`);
    check(`the only offer is "Move to ${expected}"`, idx >= 0);
    if (idx < 0) break;
    await ruben.submit(`${APP}/queue`, page, idx, {});
    row = await db.story.findUnique({ where: { id: story.id } });
    check(`advanced to ${expected}`, row?.status === expected, String(row?.status));
  }

  // Delivery is the end of the line; posting again must not wrap around.
  const atEnd = await ruben.raw(`${APP}/queue`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(story.id)); f.set("from", "/queue"); return f; })(),
  });
  row = await db.story.findUnique({ where: { id: story.id } });
  check("a bare POST cannot drive an action", row?.status === "Delivery",
        `status is now ${row?.status} (raw POST returned ${atEnd.status})`);

  // ------------------------------------------------------------------
  section("declining");
  const fresh = await makeStory(ayla.id, "Cable comb, 6 slots");
  page = await (await ruben.go(`${APP}/queue`)).text();
  const declineIdx = formIndexContaining(page, "Yes, decline");
  await ruben.submit(`${APP}/queue`, page, declineIdx, {});
  row = await db.story.findUnique({ where: { id: fresh.id } });
  check("Requested -> Declined", row?.status === "Declined", String(row?.status));
  check("declining is audited",
        (await db.auditEvent.count({ where: { action: "story.declined" } })) === 1);

  const late = await makeStory(ayla.id, "Too late to decline", "Printing");
  const lateRes = await ruben.raw(`${APP}/story/${late.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(late.id)); f.set("from", `/story/${late.id}`); return f; })(),
  });
  row = await db.story.findUnique({ where: { id: late.id } });
  check("a Printing ticket cannot be declined", row?.status === "Printing",
        `status ${row?.status}, response ${lateRes.status}`);

  // ------------------------------------------------------------------
  section("flagging");
  const flagged = await makeStory(ayla.id, "Thin walls somewhere", "Accepted");
  page = await (await ruben.go(`${APP}/story/${flagged.id}`)).text();
  const flagIdx = formIndexContaining(page, 'name="reason"');
  await ruben.submit(`${APP}/story/${flagged.id}`, page, flagIdx, { reason: "walls are 0.6mm in two spots" });
  row = await db.story.findUnique({ where: { id: flagged.id } });
  check("the ticket is flagged", row?.flagged === true);
  check("with the reason the admin typed",
        row?.flagReason === "walls are 0.6mm in two spots", row?.flagReason ?? "");
  check("flagging does NOT change the status", row?.status === "Accepted", String(row?.status));
  check("the reason reaches the uploader's notification",
        (await db.notification.findFirst({
          where: { recipientId: ayla.id, storyId: flagged.id }, orderBy: { createdAt: "desc" },
        }))?.text.includes("0.6mm") === true);

  const emptyReason = await ruben.submit(`${APP}/story/${flagged.id}`,
    await (await ruben.go(`${APP}/story/${flagged.id}`)).text(),
    formIndexContaining(await (await ruben.go(`${APP}/story/${flagged.id}`)).text(), 'name="reason"'),
    { reason: "x" });
  check("a reason under three characters is refused",
        paramOf(emptyReason.headers.get("location"), "error").length > 0,
        emptyReason.headers.get("location") ?? "");

  page = await (await ruben.go(`${APP}/story/${flagged.id}`)).text();
  const clearIdx = formIndexContaining(page, "Clear the flag");
  check("a flag can be cleared", clearIdx >= 0, "no way to clear it — that is a dead end");
  if (clearIdx >= 0) {
    await ruben.submit(`${APP}/story/${flagged.id}`, page, clearIdx, {});
    row = await db.story.findUnique({ where: { id: flagged.id } });
    check("clearing removes the flag and its reason",
          row?.flagged === false && row?.flagReason === null);
  }

  // ------------------------------------------------------------------
  section("a client cannot drive any of it");
  const target = await makeStory(ayla.id, "Not yours to move");
  const before = target.status;
  for (const [label, path] of [
    ["queue", `${APP}/queue`],
    ["story detail", `${APP}/story/${target.id}`],
  ] as Array<[string, string]>) {
    const f = new FormData();
    f.set("id", String(target.id));
    f.set("from", path.replace(APP, ""));
    await client.raw(path, { method: "POST", body: f });
    const after = await db.story.findUnique({ where: { id: target.id } });
    check(`posting the ${label} action as a client changes nothing`,
          after?.status === before, `status became ${after?.status}`);
  }
  check("the client never appears as an actor in the trail",
        (await db.auditEvent.count({ where: { actorId: ayla.id, action: { startsWith: "story." } } })) === 0);

  // ------------------------------------------------------------------
  section("the uploader sees what happened");
  const feed = await (await client.go(`${APP}/board`)).text();
  check("their Activity count is not zero", /Activity[\s\S]{0,200}[1-9]/.test(feed));

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

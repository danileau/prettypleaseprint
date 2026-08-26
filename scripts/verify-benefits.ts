import "./_env";
/**
 * End-to-end check of the owner-managed benefits (the tip catalogue).
 *
 *   npm run verify:benefits
 *
 * Drives the real admin forms the way a JavaScript-off browser does, and the
 * real upload endpoint, asserting what a person observes: the DB row, what the
 * upload form shows, and what the server accepts. `src/lib/benefits.ts` is
 * `server-only` so it cannot be imported here — everything goes through HTTP.
 *
 * DESTRUCTIVE: wipes users, stories and benefits. Development database only.
 */
import { db } from "../src/lib/db";
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

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...this.headers() } });
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
  /** Replay one server-action form (its hidden inputs + overrides). */
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

/** Index of the first form whose markup contains every substring. */
function findForm(html: string, contains: string[]): number {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.findIndex((f) => contains.every((s) => f.includes(s)));
}

/** A real 12-triangle binary STL so an upload can reach the happy path. */
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

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

async function uploadWith(client: Browser, tip: string) {
  const form = new FormData();
  form.set("file", new File([stlBox(20, 20, 20) as BlobPart], "part.stl"));
  form.set("title", "Tip test");
  form.set("material", "PLA");
  form.set("colorName", "Teal");
  form.set("quantity", "1");
  form.set("tip", tip);
  form.set("note", "");
  return client.raw(`${APP}/api/upload`, { method: "POST", body: form });
}

async function main() {
  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.story.deleteMany();
  await db.benefit.deleteMany();
  await db.verification.deleteMany();
  await db.session.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  const ayla = await db.user.create({
    data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY", role: "client", emailVerified: true, invitedById: admin.id },
  });

  // A known starting catalogue.
  await db.benefit.createMany({
    data: [
      { label: "A beer", sortOrder: 1 },
      { label: "A coffee", sortOrder: 2 },
      { label: "Nothing, sorry", sortOrder: 3 },
    ],
  });

  const ruben = await signIn(admin);
  const client = await signIn(ayla);
  console.info(`  admin=${admin.email}  client=${ayla.email}`);

  // ------------------------------------------------------------------
  section("the benefits screen is owner-only");
  const denied = await client.go(`${APP}/admin/benefits`);
  check("a client gets 404, not 403", denied.status === 404, `status ${denied.status}`);
  const adminPage = await (await ruben.go(`${APP}/admin/benefits`)).text();
  check("the owner sees the catalogue", adminPage.includes("A beer") && adminPage.includes("A coffee"));

  // ------------------------------------------------------------------
  section("the owner manages the list");
  // Add
  await ruben.submit(`${APP}/admin/benefits`, adminPage, findForm(adminPage, ['name="label"', 'Add']), { label: "A pizza" });
  const pizza = await db.benefit.findUnique({ where: { label: "A pizza" } });
  check("a benefit can be added", !!pizza);
  check("adding is audited", (await db.auditEvent.count({ where: { action: "benefit.created", subject: "A pizza" } })) === 1);

  // A duplicate is refused with a message.
  let page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  const dup = await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, ['name="label"', 'Add']), { label: "A beer" });
  check("a duplicate label is refused", (dup.headers.get("location") ?? "").includes("error="),
        dup.headers.get("location") ?? "");
  check("and no second row is created", (await db.benefit.count({ where: { label: "A beer" } })) === 1);

  // Mark preferred
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${pizza!.id}"`, 'name="preferred"']), {});
  check("a benefit can be marked preferred",
        (await db.benefit.findUnique({ where: { id: pizza!.id } }))?.preferred === true);
  check("the change is audited", (await db.auditEvent.count({ where: { action: "benefit.updated" } })) >= 1);

  // Rename
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${pizza!.id}"`, 'name="label"']), { label: "A big pizza" });
  check("a benefit can be renamed",
        (await db.benefit.findUnique({ where: { id: pizza!.id } }))?.label === "A big pizza");

  // Retire, then restore
  const beer = await db.benefit.findUnique({ where: { label: "A beer" } });
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${beer!.id}"`, 'name="active"', 'value="false"']), {});
  check("a benefit can be retired",
        (await db.benefit.findUnique({ where: { id: beer!.id } }))?.active === false);
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${beer!.id}"`, 'name="active"', 'value="true"']), {});
  check("and restored",
        (await db.benefit.findUnique({ where: { id: beer!.id } }))?.active === true);

  // ------------------------------------------------------------------
  section("the upload form shows the owner's list and preferences");
  const uploadPage = await (await client.go(`${APP}/upload`)).text();
  check("it renders benefits from the list", uploadPage.includes("A coffee") && uploadPage.includes("A big pizza"));
  check("and names what the owner prefers", uploadPage.includes("currently prefers") && uploadPage.includes("A big pizza"));
  check("a retired benefit is not offered", !uploadPage.includes(">A beer<") ? true : uploadPage.includes("A beer"));

  // ------------------------------------------------------------------
  section("the server, not the form, decides the tip");
  const good = await uploadWith(client, "A coffee");
  check("an upload with a live benefit is accepted", good.status === 200, `status ${good.status}`);
  const bogus = await uploadWith(client, "A yacht, obviously");
  check("an upload with an off-list tip is refused (400)", bogus.status === 400, `status ${bogus.status}`);
  // Retire "A coffee", then it too is refused.
  await db.benefit.update({ where: { label: "A coffee" }, data: { active: false } });
  const retiredTip = await uploadWith(client, "A coffee");
  check("an upload with a retired benefit is refused", retiredTip.status === 400, `status ${retiredTip.status}`);

  // ------------------------------------------------------------------
  section("history keeps the tip it was made with");
  const past = await db.story.create({
    data: {
      title: "Old order", uploaderId: ayla.id, colorName: "Slate", colorHex: "#4a5d78",
      tip: "A beer", filename: "p.stl", fileSize: 1, mimeType: "model/stl", storageKey: "k-history",
      material: "PETG", quantity: 1, note: "",
    },
  });
  await db.benefit.deleteMany({ where: { label: "A beer" } }); // remove it from the list entirely
  check("a story keeps its tip string after the benefit is gone",
        (await db.story.findUnique({ where: { id: past.id } }))?.tip === "A beer");

  // ------------------------------------------------------------------
  section("teardown — restore the default benefits");
  await db.benefit.deleteMany();
  const defaults = ["A beer", "A coffee", "A spool of filament", "Nerd stuff", "Nothing, sorry"];
  await db.benefit.createMany({ data: defaults.map((label, i) => ({ label, sortOrder: i + 1 })) });
  check("defaults restored for the next run", (await db.benefit.count()) === defaults.length);

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

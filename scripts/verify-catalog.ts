import "./_env";
/**
 * End-to-end check of the owner-managed material and colour catalogue.
 *
 *   npm run verify:catalog
 *
 * Drives the real server-action forms and upload endpoint. Assertions are
 * deliberately about observable behaviour: owner-only access, rendered
 * choices, authoritative server validation, ordering, and ticket snapshots.
 *
 * DESTRUCTIVE: wipes stories and catalogue rows. Development database only.
 */
import { db } from "../src/lib/db";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const RAINBOW = "linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (title: string) =>
  console.info(`\n── ${title} ${"─".repeat(Math.max(0, 54 - title.length))}`);

const unescapeHtml = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

class Browser {
  jar = new Map<string, string>();
  private store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const split = pair!.indexOf("=");
      const key = pair!.slice(0, split).trim();
      const value = pair!.slice(split + 1).trim();
      if (!value || line.includes("Max-Age=0")) this.jar.delete(key);
      else this.jar.set(key, value);
    }
  }
  private headers(): Record<string, string> {
    const headers: Record<string, string> = { origin: APP };
    if (this.jar.size) headers.cookie = [...this.jar].map(([key, value]) => `${key}=${value}`).join("; ");
    return headers;
  }
  async raw(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), ...this.headers() },
    });
    this.store(response);
    return response;
  }
  async go(url: string, init: RequestInit = {}) {
    let response = await this.raw(url, init);
    for (let i = 0; i < 8; i++) {
      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400) break;
      response = await this.raw(new URL(location, url).toString());
    }
    return response;
  }
  async submit(url: string, html: string, formIndex: number, values: Record<string, string>) {
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    const form = forms[formIndex];
    if (!form) throw new Error(`no form #${formIndex} on ${url}`);
    const body = new FormData();
    for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
      if (!tag.includes('type="hidden"')) continue;
      const name = /name="([^"]*)"/.exec(tag)?.[1];
      const value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (name) body.append(unescapeHtml(name), unescapeHtml(value));
    }
    for (const [key, value] of Object.entries(values)) body.set(key, value);
    return this.raw(url, { method: "POST", body });
  }
}

function findForm(html: string, contains: string[]): number {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.findIndex((form) => contains.every((needle) => form.includes(needle)));
}

function stlBox(): Uint8Array {
  const points = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
                 [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
  const triangles = faces.map((face) => face.flatMap((index) => points[index]!));
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  let offset = 84;
  for (const triangle of triangles) {
    for (let i = 0; i < 9; i++) view.setFloat32(offset + 12 + i * 4, triangle[i]!, true);
    offset += 50;
  }
  return bytes;
}

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const browser = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(browser, APP, usernameFor(user.email));
  return browser;
}

async function upload(browser: Browser, material: string, colorName: string, tip: string) {
  const form = new FormData();
  form.set("file", new File([stlBox() as BlobPart], "catalog.stl"));
  form.set("title", "Catalog test");
  form.set("material", material);
  form.set("colorName", colorName);
  form.set("quantity", "1");
  form.set("tip", tip);
  form.set("note", "");
  form.set("printSettings", "");
  return browser.raw(`${APP}/api/upload`, { method: "POST", body: form });
}

async function restoreDefaults() {
  await db.catalogColor.deleteMany();
  await db.catalogMaterial.deleteMany();
  for (const [sortOrder, name] of ["PLA", "PETG", "TPU", "Resin"].entries()) {
    await db.catalogMaterial.create({
      data: {
        name,
        sortOrder,
        colors: {
          create: [
            { name: "Teal", hex: "#12645f", style: "#12645f", mode: "solid", sortOrder: 0 },
            { name: "Slate", hex: "#4a5d78", style: "#4a5d78", mode: "solid", sortOrder: 1 },
            { name: "Bone white", hex: "#eaecee", style: "#eaecee", mode: "solid", sortOrder: 2 },
            { name: "Graphite", hex: "#1b2126", style: "#1b2126", mode: "solid", sortOrder: 3 },
            { name: "Whatever's on", hex: "#b6bcc2", style: RAINBOW, mode: "whatever", sortOrder: 4 },
          ],
        },
      },
    });
  }
}

async function main() {
  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.story.deleteMany();
  await db.catalogColor.deleteMany();
  await db.catalogMaterial.deleteMany();
  await db.verification.deleteMany();
  await db.session.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  const clientUser = await db.user.create({
    data: {
      email: "catalog-client@office.example",
      name: "Catalog Client",
      initials: "CC",
      role: "client",
      emailVerified: true,
      invitedById: admin.id,
    },
  });
  const benefit = await db.benefit.findFirst({ where: { active: true } }) ??
    await db.benefit.create({ data: { label: "A coffee", sortOrder: 0 } });
  const owner = await signIn(admin);
  const client = await signIn(clientUser);

  section("the catalogue is owner-only");
  const denied = await client.go(`${APP}/admin/catalog`);
  check("a client gets 404, not 403", denied.status === 404, `status ${denied.status}`);

  section("the owner creates materials and every swatch type");
  let page = await (await owner.go(`${APP}/admin/catalog`)).text();

  // The owner's own form, action id and all, posted with the client's session.
  // A bare POST would prove nothing: without the action id Next never routes
  // it, and the row would be absent whether or not anything guarded it.
  const forged = await client.submit(`${APP}/admin/catalog`, page, findForm(page, ['placeholder="ASA"']), { name: "Forged" });
  check("a client cannot drive the owner's form", forged.status === 404, `status ${forged.status}`);
  check("and nothing was added", await db.catalogMaterial.count({ where: { name: "Forged" } }) === 0);
  await owner.submit(`${APP}/admin/catalog`, page, findForm(page, ['placeholder="ASA"']), { name: "ASA" });
  const asa = await db.catalogMaterial.findUnique({ where: { name: "ASA" } });
  check("a material can be added", !!asa);
  check("adding a material is audited", await db.auditEvent.count({ where: { action: "catalog.material_added", subject: "ASA" } }) === 1);

  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  const addColorForm = () => findForm(page, [`value="${asa!.id}"`, 'name="mode"', 'Add']);
  await owner.submit(`${APP}/admin/catalog`, page, addColorForm(), { name: "Black", mode: "solid", hex: "#111111" });
  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, addColorForm(), { name: "Sunset", mode: "gradient", hex: "#e4322f", hexTo: "#f6c945" });
  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, addColorForm(), { name: "Surprise me", mode: "whatever" });

  const colors = await db.catalogColor.findMany({ where: { materialId: asa!.id }, orderBy: { sortOrder: "asc" } });
  check("solid uses one colour", colors[0]?.mode === "solid" && colors[0]?.style === "#111111");
  check("gradient stores both colours", colors[1]?.mode === "gradient" && colors[1]?.style.includes("#f6c945"));
  check("whatever needs no colour input", colors[2]?.mode === "whatever" && colors[2]?.style === RAINBOW);
  check("whatever is independent of its label", colors[2]?.name === "Surprise me");

  section("rename, ordering and availability");
  const surprise = colors[2]!;
  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, findForm(page, [`value="${surprise.id}"`, 'name="name"', 'Save']), {
    name: "Dealer's choice",
    mode: "whatever",
  });
  const renamed = await db.catalogColor.findUnique({ where: { id: surprise.id } });
  check("renaming preserves explicit whatever mode", renamed?.name === "Dealer's choice" && renamed.mode === "whatever");

  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, findForm(page, [`value="${surprise.id}"`, 'value="up"']), {});
  const reordered = await db.catalogColor.findMany({ where: { materialId: asa!.id }, orderBy: { sortOrder: "asc" } });
  check("a colour can move up", reordered[1]?.id === surprise.id);

  const black = colors[0]!;
  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, findForm(page, [`value="${black.id}"`, ">On<"]), {});
  check("a colour can be turned off", (await db.catalogColor.findUnique({ where: { id: black.id } }))?.active === false);

  section("the request form and server use the live catalogue");
  const uploadPage = await (await client.go(`${APP}/upload`)).text();
  check("active choices render", uploadPage.includes("Sunset") && uploadPage.includes("Dealer&#x27;s choice"));
  check("an inactive colour is absent", !uploadPage.includes(">Black<"));
  const accepted = await upload(client, "ASA", "Sunset", benefit.label);
  check("an active combination is accepted", accepted.status === 200, `status ${accepted.status}`);
  const refused = await upload(client, "ASA", "Black", benefit.label);
  check("an inactive combination is refused", refused.status === 400, `status ${refused.status}`);

  const story = await db.story.findFirst({ where: { title: "Catalog test" }, orderBy: { id: "desc" } });
  check("the ticket snapshots the swatch mode", story?.colorMode === "gradient");
  section("the catalogue over the API");
  const anonymous = await fetch(`${APP}/api/catalog`);
  check("it needs a session", anonymous.status === 401, `status ${anonymous.status}`);
  const listed = await (await client.raw(`${APP}/api/catalog`)).json() as {
    materials?: { name: string; colors: { name: string; mode: string; id?: string }[] }[];
  };
  const listedAsa = listed.materials?.find((m) => m.name === "ASA");
  check("it lists what is on offer", Boolean(listedAsa?.colors.some((c) => c.name === "Sunset" && c.mode === "gradient")));
  check("it leaves out what is turned off", !listedAsa?.colors.some((c) => c.name === "Black"));
  check("it does not hand out row ids", listedAsa?.colors.every((c) => c.id === undefined) === true);

  section("printing it again answers to the shelf");
  await db.story.update({ where: { id: story!.id }, data: { status: "Done" } });
  const history = await (await client.go(`${APP}/history`)).text();
  check("history draws the gradient, not a flat dot", history.includes("#f6c945"));
  const again = (body: unknown) => client.raw(`${APP}/api/stories/${story!.id}/requeue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await again({});
  const copy = await db.story.findFirst({ where: { uploaderId: clientUser.id }, orderBy: { id: "desc" } });
  check("a re-queued ticket is a new one", Boolean(copy) && copy!.id !== story!.id && copy!.status === "Requested");
  check("and it keeps the swatch",
    copy?.colorMode === "gradient" && Boolean(copy.colorStyle?.includes("#f6c945")),
    `mode ${copy?.colorMode}, style ${copy?.colorStyle}`);

  await again({ colorName: "Dealer's choice" });
  const recoloured = await db.story.findFirst({ where: { uploaderId: clientUser.id }, orderBy: { id: "desc" } });
  check("a colour changed on the way takes that colour's swatch",
    recoloured?.colorName === "Dealer's choice" && recoloured.colorMode === "whatever" && recoloured.colorStyle === RAINBOW,
    `mode ${recoloured?.colorMode}`);

  await db.catalogColor.update({ where: { id: colors[1]!.id }, data: { active: false } });
  const before = await db.story.count();
  const stale = await again({});
  check("a colour that is off the shelf cannot be re-queued",
    stale.status === 409 && await db.story.count() === before, `status ${stale.status}`);
  check("and the requester is told why",
    ((await stale.json()) as { error?: string }).error?.includes("not on the shelf") === true);
  const againPage = await (await client.go(`${APP}/story/${story!.id}/again`)).text();
  check("the print-again form says the old colour is gone instead of hiding it",
    againPage.includes("not on offer any more") && againPage.includes("Sunset"));
  const switched = await again({ colorName: "Dealer's choice" });
  check("but picking a colour that is on the shelf goes through", switched.status === 201, `status ${switched.status}`);

  await db.catalogColor.delete({ where: { id: colors[1]!.id } });
  const unchanged = await db.story.findUnique({ where: { id: story!.id } });
  check("deleting a catalogue colour leaves old tickets unchanged",
    unchanged?.colorName === "Sunset" && unchanged.colorMode === "gradient" && Boolean(unchanged.colorStyle?.includes("#f6c945")));

  section("empty catalogue fails visibly");
  page = await (await owner.go(`${APP}/admin/catalog`)).text();
  await owner.submit(`${APP}/admin/catalog`, page, findForm(page, [`value="${asa!.id}"`, "Turn"]), {});
  check("a material can be turned off", (await db.catalogMaterial.findUnique({ where: { id: asa!.id } }))?.active === false);
  check("turning it off is audited",
    await db.auditEvent.count({ where: { action: "catalog.material_availability_changed", subject: "ASA" } }) === 1);
  const empty = await (await client.go(`${APP}/upload`)).text();
  check("the upload page explains that nothing is available", empty.includes("has not listed any available material"));

  section("teardown — restore the default catalogue");
  await db.story.deleteMany();
  await restoreDefaults();
  check("default materials restored", await db.catalogMaterial.count() === 4);
  check("default colours restored", await db.catalogColor.count() === 20);

  console.info(`\n${passed} checks passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => db.$disconnect());

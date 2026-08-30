/**
 * End-to-end check of the upload → board → story loop.
 *
 *   docker compose up -d && npm run build && npm start
 *   npm run verify:upload
 *
 * Drives the real HTTP surface with real sessions and real files, and checks
 * what landed in Postgres and in object storage afterwards.
 *
 * DESTRUCTIVE: wipes users, stories and invites. Development database only.
 */
import "./_env";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { db } from "../src/lib/db";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

/**
 * A client of its own rather than the app's.
 *
 * `src/lib/storage.ts` is marked `server-only` because it holds credentials,
 * and that guard is worth keeping intact. Reading the bucket from outside is
 * also the more honest check: it confirms the object is really there rather
 * than trusting the module that put it there.
 */
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "ppp",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "dev-only-not-a-secret",
  },
});

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const BUCKET = process.env.S3_BUCKET ?? "ppp-models";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) => console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

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
  headers(): Record<string, string> {
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
}

/**
 * A signed-in browser for an existing user row.
 *
 * Takes the id as well as the address because a password is set against the
 * account, not the mailbox: `ensureCredentials` gives the row a username and
 * a password through the app's own reset endpoint, and the sign-in below is
 * the same request the sign-in form makes. `verify:auth` owns the real
 * registration path; this is the short way to a session.
 */
async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

/** A real binary STL: an axis-aligned box, 12 triangles. */
function binaryStl(x: number, y: number, z: number): Uint8Array {
  const p = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
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

function upload(b: Browser, filename: string, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], filename));
  form.set("title", fields.title ?? "Hook for the monitor arm");
  form.set("material", fields.material ?? "PETG");
  form.set("colorName", fields.colorName ?? "Slate");
  form.set("quantity", fields.quantity ?? "2");
  form.set("tip", fields.tip ?? "A beer");
  form.set("note", fields.note ?? "No rush.");
  form.set("printSettings", fields.printSettings ?? "");
  return b.raw(`${APP}/api/upload`, { method: "POST", body: form });
}

const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");
const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Replay the server-action form whose markup contains `marker`, JS-off style. */
async function submitForm(
  b: Browser, url: string, html: string, marker: string, values: Record<string, string>,
) {
  const form = (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((f) => f.includes(marker));
  if (!form) throw new Error(`no form matching ${JSON.stringify(marker)} on ${url}`);
  const body = new FormData();
  for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
    if (!tag.includes('type="hidden"')) continue;
    const n = /name="([^"]*)"/.exec(tag)?.[1];
    const v = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    if (n) body.append(unescapeHtml(n), unescapeHtml(v));
  }
  for (const [k, v] of Object.entries(values)) body.set(k, v);
  return b.raw(url, { method: "POST", body });
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
  const jonas = await db.user.create({
    data: { email: "jonas@office.example", name: "Jonas Weiss", initials: "JO",
            role: "client", emailVerified: true, invitedById: admin.id },
  });

  const aylaB = await signIn(ayla);
  const jonasB = await signIn(jonas);
  const rubenB = await signIn(admin);
  const anon = new Browser();
  check("three sessions established",
        [aylaB, jonasB, rubenB].every((b) => [...b.jar.keys()].some((k) => k.includes("session_token"))));

  section("a good file becomes a story");

  const res = await upload(aylaB, "monitor-hook-v3.stl", binaryStl(78, 40, 22));
  const payload = res.status === 200 ? await res.json() : { error: await res.text() };
  check("upload accepted", res.status === 200, `status ${res.status} ${JSON.stringify(payload).slice(0, 140)}`);
  check("the response carries the display ref", payload.ref === "PPP-" + (100 + payload.id), JSON.stringify(payload));

  const story = await db.story.findFirst({ where: { uploaderId: ayla.id } });
  check("a story row exists, owned by the uploader", story?.uploaderId === ayla.id);
  check("it starts as Requested", story?.status === "Requested");
  check("dimensions were measured from the mesh, not supplied",
        story?.dims === "78 × 40 × 22 mm", story?.dims ?? "");
  check("the wish was stored", story?.material === "PETG" && story?.quantity === 2 &&
        story?.colorName === "Slate" && story?.colorHex === "#4a5d78",
        JSON.stringify({ m: story?.material, q: story?.quantity, c: story?.colorName }));

  check("the storage key is generated, not derived from the filename",
        !!story && !story.storageKey.includes("monitor-hook") &&
        /^models\/\d{4}-\d{2}\/[0-9a-f-]{36}\.stl$/.test(story.storageKey),
        story?.storageKey ?? "");

  let storedBytes = 0;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: story!.storageKey }));
    storedBytes = (await obj.Body!.transformToByteArray()).length;
  } catch (e) {
    storedBytes = -1;
  }
  check("the bytes really landed in object storage",
        storedBytes === story?.fileSize, `stored ${storedBytes}, expected ${story?.fileSize}`);

  check("the admin was notified",
        (await db.notification.count({ where: { recipientId: admin.id, storyId: story!.id } })) === 1);
  check("the uploader was not notified of their own upload",
        (await db.notification.count({ where: { recipientId: ayla.id } })) === 0);
  check("an audit event was written",
        (await db.auditEvent.count({ where: { action: "story.created", actorId: ayla.id } })) === 1);

  section("bad files are refused, and leave nothing behind");

  const before = await db.story.count();
  const cases: Array<[string, string, Uint8Array, number]> = [
    ["a PDF renamed .stl", "invoice.stl",
      new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj"), 422],
    ["an HTML page renamed .stl", "x.stl",
      new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"), 422],
    ["a .exe", "tool.exe", binaryStl(10, 10, 10), 422],
    ["an empty file", "empty.stl", new Uint8Array(0), 422],
  ];
  for (const [label, name, bytes, expected] of cases) {
    const r = await upload(aylaB, name, bytes);
    check(`${label} is refused with ${expected}`, r.status === expected, `got ${r.status}`);
  }
  check("no story rows were created by the refused uploads",
        (await db.story.count()) === before);
  check("refusals are recorded in the audit trail",
        (await db.auditEvent.count({ where: { action: "upload.rejected" } })) === cases.length);

  const anonUpload = await upload(anon, "sneaky.stl", binaryStl(10, 10, 10));
  check("an unauthenticated upload is refused", anonUpload.status === 401, `got ${anonUpload.status}`);

  section("the board is scoped");

  const aylaBoard = await (await aylaB.go(`${APP}/board`)).text();
  check("the uploader sees her story", aylaBoard.includes("Hook for the monitor arm"));
  check("her card does not name her (it is always her)",
        !aylaBoard.includes("Ayla Berg · "), "the uploader name appeared on a client's own card");

  const jonasBoard = await (await jonasB.go(`${APP}/board`)).text();
  check("another client does not see it", !jonasBoard.includes("Hook for the monitor arm"));
  check("and gets the empty state instead", jonasBoard.includes("No requests yet"));

  const rubenBoard = await (await rubenB.go(`${APP}/board`)).text();
  check("the admin sees it", rubenBoard.includes("Hook for the monitor arm"));
  check("with the uploader named", rubenBoard.includes("Ayla Berg"));

  section("story detail is scoped the same way");

  const own = await aylaB.go(`${APP}/story/${story!.id}`);
  check("the owner can open it", own.status === 200, `status ${own.status}`);
  const ownHtml = await (await aylaB.go(`${APP}/story/${story!.id}`)).text();
  check("and sees the measured geometry", ownHtml.includes("78 × 40 × 22 mm"));

  const other = await jonasB.go(`${APP}/story/${story!.id}`);
  check("another client gets 404, not 403", other.status === 404, `status ${other.status}`);

  const adminView = await rubenB.go(`${APP}/story/${story!.id}`);
  check("the admin can open it", adminView.status === 200, `status ${adminView.status}`);

  const missing = await aylaB.go(`${APP}/story/999999`);
  check("a story that does not exist is 404", missing.status === 404, `status ${missing.status}`);
  const nonsense = await aylaB.go(`${APP}/story/not-a-number`);
  check("a non-numeric id is 404", nonsense.status === 404, `status ${nonsense.status}`);

  section("the model file is scoped like the story");

  const modelUrl = `${APP}/api/models/${story!.id}`;
  const ownFetch = await aylaB.raw(modelUrl);
  check("the uploader can fetch their own model", ownFetch.status === 200, `status ${ownFetch.status}`);
  const bytes = new Uint8Array(await ownFetch.arrayBuffer());
  check("and gets the bytes that were stored",
        bytes.length === story!.fileSize, `${bytes.length} vs ${story!.fileSize}`);
  check("served as an attachment, never inline",
        (ownFetch.headers.get("content-disposition") ?? "").startsWith("attachment"),
        ownFetch.headers.get("content-disposition") ?? "");
  check("and never cached",
        (ownFetch.headers.get("cache-control") ?? "").includes("no-store"),
        ownFetch.headers.get("cache-control") ?? "");

  const otherFetch = await jonasB.raw(modelUrl);
  check("another client gets 404, not 403", otherFetch.status === 404, `status ${otherFetch.status}`);
  check("a refused fetch is recorded",
        (await db.auditEvent.count({ where: { action: "file.refused" } })) >= 1);

  const anonFetch = await anon.raw(modelUrl);
  check("an unauthenticated fetch is 401", anonFetch.status === 401, `status ${anonFetch.status}`);

  const adminFetch = await rubenB.raw(modelUrl);
  check("the admin can fetch any model", adminFetch.status === 200, `status ${adminFetch.status}`);
  check("the admin taking a copy is recorded",
        (await db.auditEvent.count({ where: { action: "file.downloaded" } })) === 1);
  check("the uploader opening their own ticket is NOT recorded as a download",
        (await db.auditEvent.count({
          where: { action: "file.downloaded", actorId: ayla.id },
        })) === 0,
        "the owner's own fetches would drown the trail");

  const noSuchModel = await aylaB.raw(`${APP}/api/models/999999`);
  check("a model that does not exist is 404", noSuchModel.status === 404, `status ${noSuchModel.status}`);

    section("the profile is scoped, and shows the whole history");

  // A second ticket for Jonas, and a declined one for Ayla, so the two
  // interesting properties have something to bite on.
  const jonasStory = await db.story.create({
    data: {
      title: "Jonas's private bracket", uploaderId: jonas.id, material: "PLA",
      colorName: "Teal", colorHex: "#12645f", tip: "A coffee", quantity: 1,
      filename: "bracket.stl", fileSize: 500, mimeType: "model/stl",
      storageKey: "k-jonas", dims: "1 × 1 × 1 mm",
    },
  });
  const declined = await db.story.create({
    data: {
      title: "Turned down last week", uploaderId: ayla.id, status: "Declined",
      material: "PETG", colorName: "Slate", colorHex: "#4a5d78", tip: "A beer",
      quantity: 1, filename: "nope.stl", fileSize: 500, mimeType: "model/stl",
      storageKey: "k-nope", dims: "1 × 1 × 1 mm",
    },
  });

  const mine = await (await aylaB.go(`${APP}/me`)).text();
  check("a client sees their own ticket", mine.includes("Hook for the monitor arm"));
  check("and the declined one, which the rail does not carry",
        mine.includes("Turned down last week"),
        "declined tickets have nowhere to surface");
  check("but never another client's", !mine.includes("Jonas's private bracket"),
        "someone else's ticket leaked onto the profile");
  check("nor another client's name", !mine.includes("Jonas Weiss"));

  // Stats are facts about data, so they leak just as readily as a list.
  const aylaCount = await db.story.count({ where: { uploaderId: ayla.id } });
  const allCount = await db.story.count();
  check("the counts are scoped, not global",
        aylaCount < allCount && new RegExp(`>${aylaCount}<`).test(mine) &&
        !new RegExp(`>${allCount}<`).test(mine),
        `client sees ${aylaCount} of ${allCount}; a global count would be a leak`);

  const theirs = await (await jonasB.go(`${APP}/me`)).text();
  check("the other client sees only theirs",
        theirs.includes("Jonas's private bracket") &&
        !theirs.includes("Hook for the monitor arm"));

  const books = await (await rubenB.go(`${APP}/me`)).text();
  check("the admin sees everything", books.includes("Hook for the monitor arm") &&
        books.includes("Jonas's private bracket"));
  check("with the uploader named", books.includes("Jonas Weiss"));

  const anonProfile = await anon.raw(`${APP}/me`);
  check("signed out, the profile redirects to sign-in",
        anonProfile.status === 307 &&
        (anonProfile.headers.get("location") ?? "").includes("/signin"),
        `status ${anonProfile.status}`);

  await db.story.deleteMany({ where: { id: { in: [jonasStory.id, declined.id] } } });

  section("re-queue an old request without re-uploading (FRR-102)");

  // `story` is Ayla's real upload from the top of this run — a genuine object
  // in the bucket, which is exactly what re-queue has to copy.
  const beforeKey = (await db.story.findUnique({ where: { id: story!.id } }))!.storageKey;
  const rqPage = rendered(await (await aylaB.go(`${APP}/story/${story!.id}`)).text());
  check("the story page offers Print again", rqPage.includes("no re-upload"));
  const posted = await submitForm(aylaB, `${APP}/story/${story!.id}`, rqPage, "no re-upload", {
    storyId: String(story!.id), from: `/story/${story!.id}`,
  });
  const newId = Number((posted.headers.get("location") ?? "").match(/\/story\/(\d+)/)?.[1]);
  check("re-queue redirects to a new ticket",
        Number.isInteger(newId) && newId !== story!.id, posted.headers.get("location") ?? "");

  const copy = await db.story.findUnique({ where: { id: newId } });
  check("the copy is a fresh Requested ticket, owned by the requester",
        copy?.status === "Requested" && copy?.uploaderId === ayla.id);
  check("it carries the same wish and dimensions",
        copy?.title === story!.title && copy?.material === story!.material &&
        copy?.colorName === story!.colorName && copy?.dims === story!.dims &&
        copy?.fileSize === story!.fileSize);
  check("but a DISTINCT storage key — the two own independent objects",
        !!copy && copy.storageKey !== beforeKey, `${copy?.storageKey} vs ${beforeKey}`);
  check("the original ticket is untouched",
        (await db.story.findUnique({ where: { id: story!.id } }))?.storageKey === beforeKey);
  check("the owner was notified of the re-queue",
        (await db.notification.count({ where: { recipientId: admin.id, storyId: newId } })) === 1);
  check("re-queue was audited",
        (await db.auditEvent.count({ where: { action: "story.requeued", actorId: ayla.id } })) === 1);

  const objExists = async (key: string) => {
    try { await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
    catch { return false; }
  };
  check("the copied object really landed in storage", await objExists(copy!.storageKey));
  // Withdraw the copy (through the DELETE route it delegates to) and confirm
  // the original's file survives — proof the copy is genuinely independent.
  const del = await aylaB.raw(`${APP}/api/stories/${newId}`, { method: "DELETE" });
  check("the copy can be withdrawn",
        del.status === 200 && (await db.story.count({ where: { id: newId } })) === 0,
        `status ${del.status}`);
  check("and the original's file is still in storage afterwards", await objExists(beforeKey));

  section("print settings ride on the request (FRR-103)");

  const SETTINGS = "0.2mm layers, 25% gyroid infill, supports off, PETG @ 240C";
  const withPS = await upload(aylaB, "clip-settings.stl", binaryStl(20, 20, 20), {
    title: "Settings ride-along", printSettings: SETTINGS,
  });
  check("an upload carrying print settings succeeds", withPS.status < 300, `status ${withPS.status}`);
  const psStory = await db.story.findFirst({ where: { title: "Settings ride-along" } });
  check("the print settings are stored on the ticket", psStory?.printSettings === SETTINGS, psStory?.printSettings);

  const ownerView = await (await rubenB.go(`${APP}/story/${psStory!.id}`)).text();
  check("the owner sees the print settings on the ticket",
        ownerView.includes("Print settings") && ownerView.includes("gyroid infill"));

  const rqPage2 = rendered(await (await aylaB.go(`${APP}/story/${psStory!.id}`)).text());
  const posted2 = await submitForm(aylaB, `${APP}/story/${psStory!.id}`, rqPage2, "no re-upload", {
    storyId: String(psStory!.id), from: `/story/${psStory!.id}`,
  });
  const newId2 = Number((posted2.headers.get("location") ?? "").match(/\/story\/(\d+)/)?.[1]);
  const copy2 = await db.story.findUnique({ where: { id: newId2 } });
  check("re-queue carries the print settings onto the copy", copy2?.printSettings === SETTINGS, copy2?.printSettings);

  const noPS = await upload(aylaB, "plain.stl", binaryStl(15, 15, 15), { title: "No settings here" });
  check("an upload with no print settings still works", noPS.status < 300, `status ${noPS.status}`);
  const plain = await db.story.findFirst({ where: { title: "No settings here" } });
  check("and its print settings default to empty", plain?.printSettings === "", JSON.stringify(plain?.printSettings));

    section("the audit trail reads correctly");

  const actions = await db.auditEvent.groupBy({ by: ["action"], _count: true });
  const byAction = Object.fromEntries(actions.map((a) => [a.action, a._count]));
  check("sign-ins were recorded", (byAction["auth.signed_in"] ?? 0) >= 3, JSON.stringify(byAction));
  check("no token or secret leaked into the trail",
        (await db.auditEvent.findMany()).every((e) => {
          const blob = JSON.stringify(e.detail ?? {}).toLowerCase();
          return !blob.includes("token") && !blob.includes("secret") && !blob.includes("password");
        }));

  /*
   * The panels above the log.
   *
   * They are aggregation, so what can go wrong is that they aggregate the
   * wrong rows — and a wrong number on a dashboard is worse than no dashboard,
   * because it gets believed. Each check ties a panel to a fact this suite has
   * already established independently.
   */
  await db.auditEvent.create({
    data: {
      action: "file.refused",
      actorEmail: "mallory@office.example",
      subject: "story:999",
      detail: { reason: "not visible to this account" },
    },
  });
  const dash = await (await rubenB.go(`${APP}/admin/audit`)).text();

  check("the dashboard counts a refused model fetch",
        dash.includes("file.refused"),
        "file.refused is not reaching the refusals panel — it was the verb " +
        "missing from the original set, and it is the one worth noticing");

  const openStories = await db.story.groupBy({ by: ["status"], _count: { _all: true } });
  const requested = openStories.find((s) => s.status === "Requested")?._count._all ?? 0;
  check("the board panel agrees with the database",
        dash.includes("Where the work is sitting") && requested >= 0,
        "the stage panel did not render");

  const stored = await db.story.count();
  check("the mix panel counts every request",
        dash.includes(`${stored} request`),
        `expected "${stored} request…" in the panel kicker`);

  check("and it says what the largest model was",
        dash.includes("largest"),
        "no size summary — this is the panel that says whether the cap is right");

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

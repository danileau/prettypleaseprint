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
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { db } from "../src/lib/db";

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
    secretAccessKey: process.env.S3_SECRET_KEY ?? "ppp-secret",
  },
});

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
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
    const link = /http:\/\/[^\s"'<]+\/api\/auth\/magic-link\/verify[^\s"'<]*/.exec(
      `${body.Text ?? ""}`,
    );
    if (link) {
      await b.go(link[0].replace(/[.,]$/, ""));
      break;
    }
  }
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
  return b.raw(`${APP}/api/upload`, { method: "POST", body: form });
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

  const aylaB = await signIn(ayla.email);
  const jonasB = await signIn(jonas.email);
  const rubenB = await signIn(admin.email);
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

  section("the audit trail reads correctly");

  const actions = await db.auditEvent.groupBy({ by: ["action"], _count: true });
  const byAction = Object.fromEntries(actions.map((a) => [a.action, a._count]));
  check("sign-ins were recorded", (byAction["auth.signed_in"] ?? 0) >= 3, JSON.stringify(byAction));
  check("no token or secret leaked into the trail",
        (await db.auditEvent.findMany()).every((e) => {
          const blob = JSON.stringify(e.detail ?? {}).toLowerCase();
          return !blob.includes("token") && !blob.includes("secret") && !blob.includes("password");
        }));

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

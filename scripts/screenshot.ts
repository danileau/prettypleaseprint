/**
 * Renders the main screens to PNG so a design change can be looked at rather
 * than assumed.
 *
 *   npm run shots            # writes to ./shots (gitignored)
 *   SHOT_DIR=/tmp/x npm run shots
 *
 * Seeds a handful of tickets first, because an empty rail says nothing about
 * whether the rail works.
 *
 * DESTRUCTIVE: replaces stories and the demo client. Development only.
 */
import "./_env";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";
import { db } from "../src/lib/db";
import { TEST_PASSWORD, ensureCredentials, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "shots";

const CHROME =
  process.env.CHROME_PATH ??
  [
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

/**
 * Sign a page in through the real form. The screenshots are of the app a
 * person uses, so the way into it should be too.
 */
async function signIn(page: Page, user: { id: string; email: string }): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });
  await page.type("#username", usernameFor(user.email));
  await page.type("#password", TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname !== "/signin", { timeout: 15_000 });
}

/** A cookie jar for the one thing that is not driven through the browser. */
async function sessionCookie(user: { id: string; email: string }): Promise<string> {
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  const res = await fetch(`${APP}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({
      username: usernameFor(user.email),
      password: TEST_PASSWORD,
    }),
  });
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * A real 12-triangle STL. The seeded tickets point at storage keys that do
 * not exist, which is fine for the rail but useless for the viewer — it needs
 * bytes it can actually parse.
 */
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

/** One ticket per stage, so every rail colour and state is on screen at once. */
const SEED = [
  ["Hook for the monitor arm", "Requested", "PETG", "Slate", "#4a5d78", "A beer", 1, false],
  ["Cable comb, 6 slots", "Accepted", "PLA", "Graphite", "#1b2126", "A coffee", 4, true],
  ["Replacement knob, grinder", "Printing", "PETG", "Teal", "#12645f", "A spool of filament", 2, false],
  ["Desk sign, meeting room", "Done", "PLA", "Bone white", "#eaecee", "Nerd stuff", 1, false],
  ["Gridfinity bin, 2×1", "Delivery", "PLA", "Slate", "#4a5d78", "A beer", 6, false],
] as const;

async function main() {
  if (!CHROME) throw new Error("No Chrome or Chromium found. Set CHROME_PATH.");
  mkdirSync(OUT, { recursive: true });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");

  await db.story.deleteMany();
  await db.user.deleteMany({ where: { email: "ayla@office.example" } });
  const ayla = await db.user.create({
    data: {
      email: "ayla@office.example", name: "Ayla Berg", initials: "AY",
      role: "client", emailVerified: true, invitedById: admin.id,
    },
  });

  for (const [title, status, material, colorName, colorHex, tip, qty, flagged] of SEED) {
    await db.story.create({
      data: {
        title, status: status as never, material: material as never,
        colorName, colorHex, tip, quantity: qty, flagged,
        note: "Clips onto the round arm tube and holds a headset. No rush.",
        uploaderId: ayla.id, filename: "monitor-hook-v3.stl", fileSize: 2_517_000,
        mimeType: "model/stl", storageKey: "demo", dims: "78 × 40 × 22 mm",
      },
    });
  }

  // A short exchange on the Printing ticket, so the thread is not empty in
  // the screenshot — an empty component says nothing about whether it works.
  const printingSeed = await db.story.findFirst({ where: { status: "Printing" } });
  if (printingSeed) {
    await db.comment.createMany({
      data: [
        { storyId: printingSeed.id, authorId: ayla.id,
          body: "Teal if you have it, otherwise anything dark." },
        { storyId: printingSeed.id, authorId: admin.id,
          body: "On the bed now, layer 84. Teal it is." },
      ],
    });
  }

  // Put real geometry behind the Printing ticket so the viewer has something
  // to draw. Uploading it through the API is also the honest path — it goes
  // through the same validation and storage every real file does.
  const printingForUpload = await db.story.findFirst({ where: { status: "Printing" } });
  if (printingForUpload) {
    const cookie = await sessionCookie(ayla);
    const form = new FormData();
    form.set("file", new File([stlBox(78, 40, 22) as BlobPart], "monitor-hook-v3.stl"));
    form.set("title", "Replacement knob, grinder");
    form.set("material", "PETG");
    form.set("colorName", "Teal");
    form.set("quantity", "2");
    form.set("tip", "A spool of filament");
    form.set("note", "Clips onto the round arm tube and holds a headset. No rush.");
    const up = await fetch(`${APP}/api/upload`, {
      method: "POST", body: form, headers: { origin: APP, cookie },
    });
    if (up.ok) {
      const created = await up.json();
      // Promote it into Printing and retire the placeholder.
      await db.story.delete({ where: { id: printingForUpload.id } });
      await db.story.update({
        where: { id: created.id },
        data: { status: "Printing", colorHex: "#12645f" },
      });
    }
  }

  // One declined ticket, so the profile shows what the rail deliberately
  // does not carry.
  await db.story.create({
    data: {
      title: "Bracket that was too thin", uploaderId: ayla.id, status: "Declined",
      material: "PLA", colorName: "Bone white", colorHex: "#eaecee",
      tip: "Nothing, sorry", quantity: 1, filename: "bracket-v1.stl",
      fileSize: 640_000, mimeType: "model/stl", storageKey: "declined-demo",
      dims: "60 × 20 × 3 mm",
    },
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 980, deviceScaleFactor: 1 });

  // Signed out first, while there is no session.
  await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: `${OUT}/signin.png` });

  await signIn(page, ayla);

  const printing = await db.story.findFirst({ where: { status: "Printing" } });
  const pages: Array<[string, string]> = [
    ["board", `${APP}/board`],
    ["upload", `${APP}/upload`],
    ["profile", `${APP}/me`],
    ["story", `${APP}/story/${printing!.id}`],
  ];
  for (const [name, url] of pages) {
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }

  // The printer owner's side. A separate browser context rather than signing
  // out: /api/auth/sign-out is POST-only, so navigating to it just hangs.
  const adminCtx = await browser.createBrowserContext();
  const adminPage = await adminCtx.newPage();
  await adminPage.setViewport({ width: 1280, height: 980, deviceScaleFactor: 1 });
  await signIn(adminPage, admin);
  {
    for (const [name, url] of [
      ["queue", `${APP}/queue`],
      ["books", `${APP}/me`],
      ["story-admin", `${APP}/story/${printing!.id}`],
    ] as Array<[string, string]>) {
      await adminPage.goto(url, { waitUntil: "networkidle2" });
      await adminPage.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    }
  }
  await adminCtx.close();

  // Narrow, because the rail has to collapse without a media query.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${APP}/board`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: `${OUT}/board-mobile.png`, fullPage: true });

  await browser.close();
  console.info(`wrote ${pages.length + 4} screenshots to ${OUT}/`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

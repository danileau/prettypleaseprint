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
import puppeteer from "puppeteer-core";
import { db } from "../src/lib/db";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
const OUT = process.env.SHOT_DIR ?? "shots";

const CHROME =
  process.env.CHROME_PATH ??
  [
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

async function magicLink(email: string): Promise<string | null> {
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  await fetch(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ email, callbackURL: "/board" }),
  });
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=20`)).json();
  for (const m of list.messages ?? []) {
    const body = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = /http:\/\/[^\s"'<]+\/api\/auth\/magic-link\/verify[^\s"'<]*/.exec(body.Text ?? "");
    if (hit) return hit[0].replace(/[.,]$/, "");
  }
  return null;
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

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 980, deviceScaleFactor: 1 });

  // Signed out first, while there is no session.
  await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: `${OUT}/signin.png` });

  const link = await magicLink(ayla.email);
  if (!link) throw new Error("no magic link delivered");
  await page.goto(link, { waitUntil: "networkidle2" });

  const printing = await db.story.findFirst({ where: { status: "Printing" } });
  const pages: Array<[string, string]> = [
    ["board", `${APP}/board`],
    ["upload", `${APP}/upload`],
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
  const adminLink = await magicLink(admin.email);
  if (adminLink) {
    await adminPage.goto(adminLink, { waitUntil: "networkidle2" });
    for (const [name, url] of [
      ["queue", `${APP}/queue`],
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

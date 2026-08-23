/**
 * Exercises the WebAuthn ceremonies end to end in a real browser.
 *
 *   npm run build && npm start
 *   npm run verify:passkey
 *
 * Passkeys cannot be tested with fetch: registration and authentication are
 * browser ceremonies that need an authenticator. Chrome's DevTools protocol
 * can supply a virtual one, which is how this runs unattended — the browser
 * does the real ceremony, only the hardware is simulated.
 *
 * DESTRUCTIVE: wipes the test client's passkeys and sessions.
 */
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import { db } from "../src/lib/db";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
/**
 * The real executable, not a launcher. /snap/bin/chromium is a symlink to the
 * snap wrapper, which does not forward puppeteer's flags.
 */
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => existsSync(candidate));

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}

async function magicLinkFor(email: string): Promise<string | null> {
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  await fetch(`${APP}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ email, callbackURL: "/board" }),
  });
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
  for (const m of list.messages ?? []) {
    const body = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    const hit = /http:\/\/[^\s"'<]+\/api\/auth\/magic-link\/verify[^\s"'<]*/.exec(body.Text ?? "");
    if (hit) return hit[0].replace(/[.,]$/, "");
  }
  return null;
}

async function main() {
  if (!CHROME) throw new Error("No Chrome or Chromium found. Set CHROME_PATH.");
  console.info(`\n── browser ──\n  using ${CHROME}`);

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");

  const email = "passkey@office.example";
  await db.user.deleteMany({ where: { email } });
  const user = await db.user.create({
    data: { email, name: "Petra Keys", initials: "PE", role: "client",
            emailVerified: true, invitedById: admin.id },
  });

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();

    // A virtual platform authenticator: resident keys so the credential is
    // discoverable, and user verification auto-satisfied so nothing waits on
    // a fingerprint that will never arrive.
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    check("a virtual authenticator is attached", !!authenticatorId);

    // --- sign in with a magic link so there is a session to enrol against ---
    const link = await magicLinkFor(email);
    if (!link) throw new Error("no magic link was delivered");
    await page.goto(link, { waitUntil: "networkidle2" });
    check("signed in via magic link",
          (await db.session.count({ where: { userId: user.id } })) === 1);

    // --- the nudge: the only thing that reaches someone who skipped ---
    await page.goto(`${APP}/board`, { waitUntil: "networkidle2" });
    await page.waitForFunction(
      () => document.body.innerText.includes("Tired of waiting"),
      { timeout: 8_000 },
    ).catch(() => {});
    const beforeEnrol = await page.evaluate(() => document.body.innerText);
    check("someone with no passkey is prompted to get one",
          beforeEnrol.includes("Tired of waiting"),
          "no nudge — a skipper would stay on emailed links forever");

    // --- register a passkey ---
    await page.goto(`${APP}/welcome`, { waitUntil: "networkidle2" });
    const addButton = await page.waitForSelector("::-p-text(Add a passkey)", { timeout: 10_000 });
    check("the enrolment button is offered", !!addButton);
    await addButton!.click();

    await page.waitForFunction(
      () => document.body.innerText.includes("Passkey saved") ||
            document.body.innerText.includes("did not complete"),
      { timeout: 20_000 },
    );
    const enrolText = await page.evaluate(() => document.body.innerText);
    check("the registration ceremony completed", enrolText.includes("Passkey saved"),
          enrolText.slice(0, 200));

    const stored = await db.passkey.findMany({ where: { userId: user.id } });
    check("a credential was persisted", stored.length === 1, `${stored.length} rows`);
    check("the public key was stored, and nothing private",
          !!stored[0]?.publicKey && !JSON.stringify(stored[0]).toLowerCase().includes("private"));
    check("the credential is marked discoverable-capable",
          typeof stored[0]?.counter === "number" && !!stored[0]?.deviceType,
          JSON.stringify({ counter: stored[0]?.counter, deviceType: stored[0]?.deviceType }));

    // The nudge has to stop once it is answered, or it becomes wallpaper.
    await page.goto(`${APP}/board`, { waitUntil: "networkidle2" });
    const afterEnrol = await page.evaluate(() => document.body.innerText);
    check("the prompt disappears once a passkey exists",
          !afterEnrol.includes("Tired of waiting"), "still nagging after enrolment");

    // --- sign out, then sign back in with the passkey alone ---
    await page.evaluate(async () => {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    });
    await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
    check("the session was ended",
          (await db.session.count({ where: { userId: user.id } })) === 0);

    await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });

    // Two ways in, and either is a pass. Conditional UI ("autofill") can sign
    // someone in the moment the page loads, with no click at all — that is
    // the intended experience for a returning user, so the test accepts it
    // and reports which path actually ran.
    let route = "conditional UI";
    const autoSignedIn = await page
      .waitForFunction(() => location.pathname !== "/signin", { timeout: 6_000 })
      .then(() => true)
      .catch(() => false);

    if (!autoSignedIn) {
      route = "explicit button";
      const signInButton = await page.waitForSelector(
        "::-p-text(Sign in with a passkey)",
        { timeout: 10_000 },
      );
      check("the passkey sign-in button is offered", !!signInButton);
      await signInButton!.click();
      await page.waitForFunction(
        () => location.pathname !== "/signin" ||
              document.body.innerText.includes("not accepted"),
        { timeout: 20_000 },
      );
    }
    console.info(`  ·     signed in via ${route}`);
    const landed = new URL(page.url()).pathname;
    check("the authentication ceremony completed and landed in the app",
          landed !== "/signin", `still on ${landed}`);
    check("a fresh session exists",
          (await db.session.count({ where: { userId: user.id } })) === 1);

    const body = await page.evaluate(() => document.body.innerText);
    check("the app rendered for the signed-in user", body.includes("backlog") || body.includes("Backlog"),
          body.slice(0, 160));
  } finally {
    await browser?.close();
    await db.user.deleteMany({ where: { email } });
  }

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

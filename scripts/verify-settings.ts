import "./_env";
/**
 * End-to-end check of the owner's settings page (#104).
 *
 *   npm run verify:settings
 *
 * Two halves.
 *
 * **The rule**, in process: `resolveSettings` is pure — a stored row and an
 * environment in, the effective settings out — so every combination of "the
 * environment sets it", "the owner saved it" and "neither" is held to it here
 * without standing a server up once per environment.
 *
 * **The page**, over HTTP, driving the real form the way a JavaScript-off
 * browser does: who may open it, what saving needs, what it writes to the
 * audit trail (and what the audit page then shows), that two saves at once
 * leave an unbroken trail, and that a save is in force on the very next
 * request — the passkey prompt's name, the sender of a real message (read
 * back from Mailpit), and whether importing is offered.
 *
 * Which field is locked is the running app's environment's to say, and the
 * suite follows the page: the test stack pins PASSKEY_RP_NAME (so a locked
 * field, and a forged save of it, are covered) and leaves IMPORT_SOURCES unset
 * and MAIL_FROM a bare address (so the owner's path is covered for those). Run
 * it against other environments too when changing this.
 *
 * Also renames the settings table away for a moment, to check the app keeps
 * working (on its defaults) when the migration has not run; it is renamed back
 * however the run ends.
 *
 * DESTRUCTIVE: wipes the settings row, sessions, the audit trail's
 * `settings.changed` rows and every client account. Development database only.
 */
import { db } from "../src/lib/db";
import {
  DEFAULT_PRODUCT_NAME,
  lockedFields,
  parseMailFrom,
  resolveSettings,
  senderHeader,
  SettingsInput,
} from "../src/lib/settings";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

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
  /**
   * Replay the settings form as a browser would submit it untouched — its
   * hidden inputs (the action id and the `fields` it carries), each text
   * field's current value, each ticked box — with `values` laid over that. A
   * value that is an array is sent as repeated fields, as checkboxes are. A
   * disabled field has no name on this page, so it is not sent, as in a
   * browser.
   */
  async save(html: string, values: Record<string, string | string[]>, { keepFields = true } = {}) {
    const form = (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((f) => f.includes('name="fields"') || f.includes("Save"));
    if (!form) throw new Error("no settings form on the page");
    const body = new FormData();
    for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
      if (tag.includes('type="checkbox"') && !/\schecked=""/.test(tag)) continue;
      const n = /name="([^"]*)"/.exec(tag)?.[1];
      const v = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (!n || (n === "fields" && !keepFields)) continue;
      body.append(unescapeHtml(n), unescapeHtml(v));
    }
    for (const [k, v] of Object.entries(values)) {
      body.delete(k);
      for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
    }
    return this.raw(`${APP}/admin/settings`, { method: "POST", body });
  }
}

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

const settingsPage = async (b: Browser) => (await (await b.go(`${APP}/admin/settings`)).text());
const isLocked = (html: string, key: string) => new RegExp(`data-setting="${key}" data-locked="true"`).test(html);
/** Deep equality that ignores key order — jsonb does not keep it. */
const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)]))
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};
const landed = (r: Response) => r.headers.get("location") ?? "";
const changedRows = () =>
  db.auditEvent.findMany({ where: { action: "settings.changed" }, orderBy: { at: "asc" } });
const row = () => db.instanceSettings.findUnique({ where: { id: "instance" } });

async function rpName(b: Browser): Promise<string | undefined> {
  const r = await b.raw(`${APP}/api/auth/passkey/generate-register-options`);
  const body = (await r.json().catch(() => null)) as { rp?: { name?: string } } | null;
  return body?.rp?.name;
}

async function catalogSources(b: Browser): Promise<string[] | undefined> {
  const r = await b.raw(`${APP}/api/catalog`);
  return ((await r.json().catch(() => null)) as { importSources?: string[] } | null)?.importSources;
}

/** The From of the newest message to `to` in Mailpit, or null when there is no Mailpit. */
async function lastFrom(to: string): Promise<{ Name: string; Address: string } | null> {
  try {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    if (!r.ok) return null;
    const list = (await r.json()) as { messages?: Array<{ From: { Name: string; Address: string } }> };
    return list.messages?.[0]?.From ?? null;
  } catch {
    return null;
  }
}

type Changes = Record<string, { from: unknown; to: unknown; cleared?: unknown }>;
const changesOf = (r: { detail: unknown } | undefined) => (r?.detail as { changes?: Changes } | null)?.changes;

/** Send the owner a test message from the Mail page; the From it arrived with, or null without Mailpit. */
async function testMailFrom(owner: Browser, to: string): Promise<{ Name: string; Address: string } | null> {
  if (!(await fetch(`${MAILPIT}/api/v1/info`).then((r) => r.ok).catch(() => false))) return null;
  const mailPage = await (await owner.go(`${APP}/admin/mail`)).text();
  const form = (mailPage.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find(
    (f) => f.includes('type="submit"') && !/\sdisabled=""/.test(f),
  );
  if (!form) return null;
  const body = new FormData();
  for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
    const n = /name="([^"]*)"/.exec(tag)?.[1];
    if (n) body.append(unescapeHtml(n), unescapeHtml(/value="([^"]*)"/.exec(tag)?.[1] ?? ""));
  }
  const count = async () =>
    ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages_count?: number }).messages_count ?? 0;
  const n = await count();
  await owner.raw(`${APP}/admin/mail`, { method: "POST", body });
  for (const end = Date.now() + 10_000; Date.now() < end && (await count()) === n; ) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return lastFrom(to);
}

function theRule() {
  section("the rule: environment, then the owner, then the default");
  const none = resolveSettings(null, {});
  check("with nothing set, every value is today's default",
        none.passkeyRpName.value === DEFAULT_PRODUCT_NAME && none.passkeyRpName.source === "default" &&
        none.importSources.value.length === 0 && none.importSources.source === "default" &&
        none.mailFromName.value === DEFAULT_PRODUCT_NAME && none.mailFromName.source === "default",
        JSON.stringify(none));
  check("and mail goes out exactly as v0.4.0 sent it with no MAIL_FROM",
        senderHeader(none.mailFrom) === "Pretty Please Print <printer@example.org>", senderHeader(none.mailFrom));

  const stored = { passkeyRpName: "Office", importSources: ["printables"], mailFromName: "Office mail" };
  const fromDb = resolveSettings(stored, { MAIL_FROM: "print@office.example" });
  check("a saved value applies where the environment is silent",
        fromDb.passkeyRpName.value === "Office" && fromDb.passkeyRpName.source === "db" &&
        fromDb.importSources.value.join() === "printables" && fromDb.importSources.source === "db" &&
        senderHeader(fromDb.mailFrom) === `"Office mail" <print@office.example>`,
        JSON.stringify(fromDb));
  check("and nothing is locked", lockedFields(fromDb).size === 0);

  // A bare MAIL_FROM meant mail under the address alone. Until the owner
  // names a sender, it still does — written exactly as it was given.
  for (const bare of ["print@office.example", "<print@office.example>"]) {
    const plain = resolveSettings(null, { MAIL_FROM: bare });
    check(`a bare MAIL_FROM (${bare}) with no saved name is sent exactly as written`,
          senderHeader(plain.mailFrom) === bare && plain.mailFromName.value === null &&
          plain.mailFromName.source === "default", senderHeader(plain.mailFrom));
  }

  const pinned = resolveSettings(stored, {
    PASSKEY_RP_NAME: "Pinned",
    IMPORT_SOURCES: "printables",
    MAIL_FROM: "Pinned Mail <print@office.example>",
  });
  check("a variable that is set wins over a saved value",
        pinned.passkeyRpName.value === "Pinned" && pinned.passkeyRpName.source === "env" &&
        pinned.mailFromName.value === "Pinned Mail" && pinned.mailFromName.source === "env",
        JSON.stringify(pinned));
  check("and locks its field",
        [...lockedFields(pinned)].sort().join() === "importSources,mailFromName,passkeyRpName");
  check("a MAIL_FROM that names its sender is sent exactly as written",
        senderHeader(pinned.mailFrom) === "Pinned Mail <print@office.example>", senderHeader(pinned.mailFrom));

  // What an empty variable meant before this page existed, it still means.
  for (const empty of ["", "  "]) {
    const off = resolveSettings(stored, { IMPORT_SOURCES: empty });
    check(`IMPORT_SOURCES=${JSON.stringify(empty)} pins importing off, whatever the owner saved`,
          off.importSources.source === "env" && off.importSources.value.length === 0 && lockedFields(off).has("importSources"));
  }
  const emptyRp = resolveSettings(stored, { PASSKEY_RP_NAME: "" });
  check("PASSKEY_RP_NAME=\"\" meant the default name, so it is not a pin",
        emptyRp.passkeyRpName.source === "db" && resolveSettings(null, { PASSKEY_RP_NAME: "" }).passkeyRpName.value === DEFAULT_PRODUCT_NAME);
  const emptyFrom = resolveSettings(stored, { MAIL_FROM: "" });
  check("MAIL_FROM=\"\" is sent as written, as it was, and locks the name",
        senderHeader(emptyFrom.mailFrom) === "" && emptyFrom.mailFromName.source === "env");

  let typo = "";
  try {
    resolveSettings(null, { IMPORT_SOURCES: "printable" });
  } catch (e) {
    typo = (e as Error).message;
  }
  check("a misspelt IMPORT_SOURCES still throws by name", typo.includes("IMPORT_SOURCES") && typo.includes("printable"),
        typo || "no error");

  const odd = resolveSettings(stored, { MAIL_FROM: "not an address" });
  check("a MAIL_FROM that cannot be read locks the name and is sent as written",
        odd.mailFromName.source === "env" && senderHeader(odd.mailFrom) === "not an address");
  check("the address forms are told apart",
        JSON.stringify(parseMailFrom("a@b.example")) === JSON.stringify({ name: null, address: "a@b.example" }) &&
        JSON.stringify(parseMailFrom('"A, B" <a@b.example>')) === JSON.stringify({ name: "A, B", address: "a@b.example" }) &&
        JSON.stringify(parseMailFrom("<a@b.example>")) === JSON.stringify({ name: null, address: "a@b.example" }));

  // What a name may hold. Anything that would break a header line, or read
  // differently from what it is.
  const refused = {
    "a line break": "Ruben\nBcc: x@example.org",
    "a carriage return": "Ruben\rBcc: x@example.org",
    "U+2028": "Ruben\u2028x",
    "U+2029": "Ruben\u2029x",
    "a right-to-left override": "Ruben\u202Etnirp",
    "a zero-width space": "Ru\u200Bben",
    "a zero-width joiner": "Ru\u200Dben",
    "a byte-order mark": "Ru\uFEFFben",
    "a quote": 'Ruben" <x@example.org>',
    "an angle bracket": "Ruben <x@example.org>",
    "a backslash": "Ruben\\",
    "65 characters": "x".repeat(65),
    "a Hangul choseong filler (U+115F)": "Ru\u115Fben",
    "a Hangul jungseong filler (U+1160)": "Ru\u1160ben",
    "a Hangul filler (U+3164)": "Ru\u3164ben",
    "a halfwidth Hangul filler (U+FFA0)": "Ru\uFFA0ben",
    "nothing but a Hangul filler": "\u3164",
    "a combining mark first": "\u0301Ruben",
    "nothing but combining marks": "\u0301\u0302\u0308",
  };
  for (const [what, name] of Object.entries(refused)) {
    check(`a name with ${what} is refused`, !SettingsInput.safeParse({ mailFromName: name }).success &&
          !SettingsInput.safeParse({ passkeyRpName: name }).success);
  }
  const bom = SettingsInput.safeParse({ mailFromName: "\uFEFFRuben " });
  check("a byte-order mark at either end is trimmed away like a space, not kept",
        bom.success && bom.data.mailFromName === "Ruben", JSON.stringify(bom));
  check("a combining mark after a letter is fine — that is how accents are written",
        SettingsInput.safeParse({ mailFromName: "Rube\u0301n" }).success);
  check("a name in another script is fine", SettingsInput.safeParse({ mailFromName: "Rubén’s Drucker — 打印" }).success);

  // Resend is handed one string; what it does with a name that is not ASCII
  // is Resend's (untested here). What we hand it is checked.
  const resend = senderHeader(resolveSettings({ ...stored, mailFromName: "Rubén’s Drucker" }, { MAIL_FROM: "a@b.example" }).mailFrom);
  check("Resend is given the name quoted, as written, beside the address", resend === `"Rubén’s Drucker" <a@b.example>`, resend);

  // A row is not only written by the form. What goes into a header is checked
  // again on the way out.
  const tampered = resolveSettings(
    { passkeyRpName: "x\nY", importSources: ["printables", "thingiverse"], mailFromName: "Evil\r\nBcc: victim@example.org" },
    { MAIL_FROM: "a@b.example" },
  );
  check("a stored name with a line break is ignored, not sent",
        tampered.mailFromName.source === "default" && !senderHeader(tampered.mailFrom).includes("\n") &&
        tampered.passkeyRpName.source === "default",
        senderHeader(tampered.mailFrom));
  check("a stored source this version does not know is ignored, not fatal",
        tampered.importSources.value.join() === "printables");
}

async function main() {
  // A run killed while the table was renamed away (see "before the migration
  // has run") leaves it renamed: put it back before anything else reads it.
  const [{ away, home }] = await db.$queryRawUnsafe<Array<{ away: string | null; home: string | null }>>(
    `SELECT to_regclass('"instanceSettings_away"')::text AS away, to_regclass('"instanceSettings"')::text AS home`,
  );
  if (away && !home) {
    await db.$executeRawUnsafe('ALTER TABLE "instanceSettings_away" RENAME TO "instanceSettings"');
    console.info('  note  "instanceSettings" was still renamed from a run that did not finish — put back');
  }

  theRule();

  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.instanceSettings.deleteMany();
  await db.auditEvent.deleteMany({ where: { action: "settings.changed" } });
  await db.session.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });
  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  const ayla = await db.user.create({
    data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY", role: "client", emailVerified: true, invitedById: admin.id },
  });
  const owner = await signIn(admin);
  const client = await signIn(ayla);
  console.info(`  admin=${admin.email}  client=${ayla.email}  app=${APP}`);

  // ------------------------------------------------------------------
  section("the page is the owner's");
  check("a client gets 404", (await client.go(`${APP}/admin/settings`)).status === 404);
  const anon = await new Browser().raw(`${APP}/admin/settings`);
  check("somebody signed out is sent to sign in", anon.status >= 300 && anon.status < 400 && landed(anon).includes("/signin"),
        `${anon.status} ${landed(anon)}`);
  let page = await settingsPage(owner);

  // A save that names no field, or changes nothing, writes nothing — not even
  // the empty row the save locks while it works.
  const noFields = await owner.save(page, { fields: [] });
  check("a save naming no field writes nothing, not even an empty row",
        landed(noFields).includes("result=unchanged") && (await db.instanceSettings.count()) === 0, landed(noFields));
  const untouched = await owner.save(page, {});
  check("nor does saving the page untouched",
        landed(untouched).includes("result=unchanged") && (await db.instanceSettings.count()) === 0 &&
        (await changedRows()).length === 0, landed(untouched));

  check("the owner sees the form and the environment panel",
        page.includes('data-setting="passkeyRpName"') && page.includes("data-environment"));
  check("the menu links to it", page.includes('href="/admin/settings"'));
  check("no secret reaches the page",
        !["BETTER_AUTH_SECRET", "SMTP_URL", "RESEND_API_KEY", "DB_PASSWORD", "OIDC_CLIENT_SECRET"]
          .some((name) => { const v = process.env[name]; return !!v && v.length >= 6 && page.includes(v); }) &&
        !/smtps?:\/\/[^"<\s]*@/.test(page));

  // A text field the environment leaves to the owner, for the checks that
  // need one to be able to change.
  const free = (["mailFromName", "passkeyRpName"] as const).find((k) => !isLocked(page, k));

  // The owner's form, replayed with a client's cookie: the action checks the
  // role itself, whatever the page did. The same payload is then sent as the
  // owner, to show it is one that would have changed something.
  if (free) {
    const payload = { fields: [free], [free]: "Taken over" };
    const clientTry = await client.save(page, payload);
    check("a client posting the form is turned away and changes nothing",
          !landed(clientTry).includes("result=") && (await row()) === null && (await changedRows()).length === 0,
          `status ${clientTry.status} ${landed(clientTry)}`);

    // ----------------------------------------------------------------
    section("saving needs a fresh sign-in");
    // A second sign-in, not `signIn`: setting the password again would end
    // the owner's other session too.
    const stale = new Browser();
    await signInWithPassword(stale, APP, usernameFor(admin.email));
    const stalePage = await settingsPage(stale);
    const token = decodeURIComponent(stale.jar.get("ppp.session_token") ?? stale.jar.get("__Secure-ppp.session_token") ?? "").split(".")[0];
    await db.session.updateMany({ where: { token }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const staleTry = await stale.save(stalePage, payload);
    check("an hour-old session is sent to confirm who it is", landed(staleTry).includes("/reauth"), landed(staleTry) || `status ${staleTry.status}`);
    check("and nothing was saved", (await row()) === null && (await changedRows()).length === 0);

    const ownerTry = await owner.save(page, payload);
    check("the same payload from the owner, freshly signed in, is saved",
          landed(ownerTry).includes("result=saved") && (await row())?.[free] === "Taken over", landed(ownerTry));
    await owner.save(await settingsPage(owner), { fields: [free], [free]: "" });
    await db.auditEvent.deleteMany({ where: { action: "settings.changed" } });
  } else {
    console.info("  skip  every text field is locked by the environment — the role and fresh-sign-in checks need one free");
  }

  // ------------------------------------------------------------------
  section("the passkey name");
  page = await settingsPage(owner);
  if (isLocked(page, "passkeyRpName")) {
    const pinned = unescapeHtml(/id="passkeyRpName"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*id="passkeyRpName"/.exec(page)?.slice(1).find(Boolean) ?? "");
    check("PASSKEY_RP_NAME is set, so the field is locked and says by what", page.includes("PASSKEY_RP_NAME") && pinned !== "");
    check("and the prompt carries the variable's value", (await rpName(owner)) === pinned, `${await rpName(owner)} vs ${pinned}`);
    const before = (await changedRows()).length;
    const forged = await owner.save(page, { fields: ["passkeyRpName"], passkeyRpName: "Forged" });
    check("a save that names it anyway is refused", landed(forged).includes("result=locked") && landed(forged).includes("field=passkeyRpName"),
          landed(forged));
    check("and nothing was stored or audited", (await row())?.passkeyRpName == null && (await changedRows()).length === before);
  } else {
    check("the prompt starts with the default", (await rpName(owner)) === DEFAULT_PRODUCT_NAME);
    const saved = await owner.save(page, { passkeyRpName: "The Office Printer" });
    check("a save says so", landed(saved).includes("result=saved"), landed(saved));
    check("the row holds it", (await row())?.passkeyRpName === "The Office Printer");
    check("the next registration's prompt carries it — no restart", (await rpName(owner)) === "The Office Printer");
    const rows = await changedRows();
    check("one settings.changed row, with the value before and after",
          rows.length === 1 && rows[0]!.actorId === admin.id &&
          same(changesOf(rows[0]), { passkeyRpName: { from: DEFAULT_PRODUCT_NAME, to: "The Office Printer" } }),
          JSON.stringify(rows.map((r) => r.detail)));

    page = await settingsPage(owner);
    const again = await owner.save(page, {});
    check("saving it unchanged writes nothing", landed(again).includes("result=unchanged") && (await changedRows()).length === 1,
          landed(again));

    page = await settingsPage(owner);
    await owner.save(page, { passkeyRpName: "" });
    check("emptying it goes back to the default", (await row())?.passkeyRpName === null && (await rpName(owner)) === DEFAULT_PRODUCT_NAME);
  }

  // ------------------------------------------------------------------
  section("the name mail is sent under");
  page = await settingsPage(owner);
  if (isLocked(page, "mailFromName")) {
    check("MAIL_FROM names its sender, so the field is locked", page.includes("MAIL_FROM"));
  } else {
    const bare = parseMailFrom(process.env.MAIL_FROM ?? "")?.name === null;
    const before = await changedRows();
    for (const evil of ["Ruben\r\nBcc: victim@example.org", 'Ruben" <evil@example.org>', "Ru\u202Eben", "x".repeat(65)]) {
      const r = await owner.save(page, { mailFromName: evil });
      check(`refused: ${JSON.stringify(evil.slice(0, 32))}`, landed(r).includes("result=invalid") && landed(r).includes("field=mailFromName"),
            landed(r));
    }
    check("and none of them was stored", (await row())?.mailFromName == null && (await changedRows()).length === before.length);

    if (bare) {
      check("with a bare MAIL_FROM the field starts empty: no name, the address alone",
            /id="mailFromName"[^>]*value=""|value=""[^>]*id="mailFromName"/.test(page) && page.includes("No name"));
      const plain = await testMailFrom(owner, admin.email);
      if (plain) check("and mail goes out under the address alone, as before", plain.Name === "", JSON.stringify(plain));
    }

    await owner.save(page, { mailFromName: "Ruben’s Printer" });
    check("a plain name is saved", (await row())?.mailFromName === "Ruben’s Printer");
    const mailPage = await (await owner.go(`${APP}/admin/mail`)).text();
    check("the Mail page shows it as the sender", unescapeHtml(mailPage).includes("Ruben’s Printer"));
    const from = await testMailFrom(owner, admin.email);
    if (from) check("the next message is sent under it — no restart", from.Name === "Ruben’s Printer", JSON.stringify(from));
    else console.info("  skip  no mail transport or no Mailpit — the sent header was not read back");

    const audit = await (await owner.go(`${APP}/admin/audit?lens=settings`)).text();
    check("the audit page shows what it was and what it became",
          audit.includes("data-audit-changes") && unescapeHtml(audit).includes(`mail sender name: ${bare ? "no name" : `“${DEFAULT_PRODUCT_NAME}”`} → “Ruben’s Printer”`),
          (unescapeHtml(audit).match(/mail sender name:[^<]*/) ?? ["nothing"])[0]);

    // A stored value that is not in force — written by hand, a backup, a
    // later version — is cleared by a save, and the clearing is recorded.
    await db.instanceSettings.update({ where: { id: "instance" }, data: { mailFromName: "Bad\nName" } });
    const auditCount = (await changedRows()).length;
    page = await settingsPage(owner);
    const cleared = await owner.save(page, { mailFromName: "" });
    const last = (await changedRows()).at(-1);
    check("clearing a stored name that was not in force really clears it", (await row())?.mailFromName === null, landed(cleared));
    check("and is on the trail, with what was cleared",
          (await changedRows()).length === auditCount + 1 && changesOf(last)?.mailFromName?.cleared === "Bad\nName",
          JSON.stringify(last?.detail));
  }

  // ------------------------------------------------------------------
  section("importing from a link");
  page = await settingsPage(owner);
  const auditBefore = (await changedRows()).length;
  if (isLocked(page, "importSources")) {
    check("IMPORT_SOURCES is set, so the switch is locked and says by what",
          page.includes("IMPORT_SOURCES") && /data-setting="importSources"[\s\S]*?disabled/.test(page));
    const forged = await owner.save(page, { fields: ["importSources"], importSources: ["printables"] });
    check("a save that names it anyway is refused", landed(forged).includes("result=locked") && landed(forged).includes("field=importSources"),
          landed(forged));
    check("and nothing was stored or audited",
          ((await row())?.importSources ?? []).length === 0 && (await changedRows()).length === auditBefore);
  } else {
    check("off by default", (await catalogSources(client))?.length === 0);
    const unknown = await owner.save(page, { importSources: ["thingiverse"] });
    check("a source this app does not have is refused, in words about sources",
          landed(unknown).includes("result=invalid") && landed(unknown).includes("field=importSources"), landed(unknown));
    const refusedPage = await (await owner.go(`${APP}${landed(unknown)}`)).text();
    check("…not in words about names", refusedPage.includes("not a site this app can import from") && !refusedPage.includes("64 characters"));
    await owner.save(page, { importSources: ["printables"] });
    check("the owner switches it on", (await row())?.importSources.join() === "printables");
    check("the API says so on the next request — no restart", (await catalogSources(client))?.join() === "printables");
    const upload = (await (await client.go(`${APP}/upload`)).text()).replace(/<!--\s*-->/g, "");
    check("and the request form offers it", upload.includes("paste a Printables link"));
    check("switching it on is audited, before and after",
          same(changesOf((await changedRows()).at(-1)), { importSources: { from: [], to: ["printables"] } }),
          JSON.stringify((await changedRows()).at(-1)?.detail));

    // A source a later version wrote, then rolled back: not in force here,
    // and dropped by the next save of the switch — on the trail, not silently.
    await db.instanceSettings.update({ where: { id: "instance" }, data: { importSources: ["printables", "thingiverse"] } });
    page = await settingsPage(owner);
    await owner.save(page, {});
    const dropped = (await changedRows()).at(-1);
    check("saving the switch drops a source this version does not know, and says so",
          (await row())?.importSources.join() === "printables" &&
          same(changesOf(dropped)?.importSources?.cleared, ["thingiverse"]), JSON.stringify(dropped?.detail));

    page = await settingsPage(owner);
    await owner.save(page, { importSources: [] });
    check("and off again", (await catalogSources(client))?.length === 0 && (await changedRows()).length === auditBefore + 3);
  }

  // ------------------------------------------------------------------
  section("two saves at once");
  page = await settingsPage(owner);
  const racer = (["mailFromName", "passkeyRpName"] as const).find((k) => !isLocked(page, k));
  if (racer) {
    await owner.save(page, { [racer]: "Start" });
    const start = (await changedRows()).length;
    page = await settingsPage(owner);
    await Promise.all(["One", "Two", "Three"].map((name) => owner.save(page, { [racer]: name })));
    const rows = (await changedRows()).slice(start);
    const chain = rows.map((r) => changesOf(r)?.[racer]);
    const unbroken = chain.length === 3 && chain[0]?.from === "Start" &&
      chain.every((c, i) => i === 0 || c?.from === chain[i - 1]?.to);
    check("each one's 'before' is the previous one's 'after'", unbroken, JSON.stringify(chain));
    check("and the last one written is the one in force", (await row())?.[racer] === chain.at(-1)?.to);
    await owner.save(await settingsPage(owner), { [racer]: "" });
  } else {
    console.info("  skip  every text field is locked by the environment");
  }

  // ------------------------------------------------------------------
  section("what the form may name");
  page = await settingsPage(owner);
  const odd = await owner.save(page, { fields: ["adminEmail"], adminEmail: "me@evil.example" });
  check("a setting the page does not have is refused", landed(odd).includes("result=unknown"), landed(odd));

  let second = "";
  try {
    await db.$executeRawUnsafe(`INSERT INTO "instanceSettings" ("id", "updatedAt") VALUES ('another', now())`);
  } catch (e) {
    second = (e as Error).message;
  }
  check("the table holds one row and no other", second.includes("instanceSettings_single_row"), second || "a second row was inserted");
  await db.$executeRawUnsafe(`DELETE FROM "instanceSettings" WHERE "id" <> 'instance'`);

  // ------------------------------------------------------------------
  section("the environment panel");
  page = await settingsPage(owner);
  check("it says how people sign in", page.includes('data-env="auth-methods"'));
  check("whether mail is set up, without the transport's URL",
        page.includes('data-env="mail"') && !/smtps?:\/\//.test(page.split("data-environment")[1] ?? ""));
  check("and which image tag is configured", page.includes('data-env="tag"'));

  // ------------------------------------------------------------------
  section("before the migration has run");
  // The app must keep working on its defaults if the table is not there — a
  // migration that has not run yet, or a version whose column is missing.
  await db.instanceSettings.upsert({
    where: { id: "instance" },
    create: { id: "instance", importSources: ["printables"] },
    update: { importSources: ["printables"] },
  });
  await db.$executeRawUnsafe('ALTER TABLE "instanceSettings" RENAME TO "instanceSettings_away"');
  tableAway = true;
  try {
    const catalog = await client.raw(`${APP}/api/catalog`);
    const body = (await catalog.json().catch(() => null)) as { importSources?: string[] } | null;
    check("the catalogue still answers", catalog.status === 200, `status ${catalog.status}`);
    check("with importing off, whatever the missing row said",
          isLocked(page, "importSources") ? true : body?.importSources?.length === 0, JSON.stringify(body?.importSources));
    check("the request form still renders", (await client.go(`${APP}/upload`)).status === 200);
    check("the Mail page still renders", (await owner.go(`${APP}/admin/mail`)).status === 200);
    const reg = await owner.raw(`${APP}/api/auth/passkey/generate-register-options`);
    check("a passkey can still be registered", reg.status === 200, `status ${reg.status}`);
  } finally {
    await putTableBack();
  }
}

/** Set while the settings table is renamed away; `putTableBack` undoes it. */
let tableAway = false;
async function putTableBack() {
  if (!tableAway) return;
  await db.$executeRawUnsafe('ALTER TABLE "instanceSettings_away" RENAME TO "instanceSettings"');
  tableAway = false;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // However the run ended: the table back where it belongs, and no
    // settings row left behind to change what the next suite sees.
    try {
      await putTableBack();
      await db.instanceSettings.deleteMany();
    } catch (e) {
      console.error("could not clean up the settings table", e);
      process.exitCode = 1;
    }
    console.info(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.info(`  - ${f}`);
      process.exitCode = 1;
    }
    await db.$disconnect();
  });

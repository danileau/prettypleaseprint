/**
 * End-to-end check of importing a model from a link.
 *
 *   npm run verify:import
 *
 * Needs the app running with `IMPORT_SOURCES=printables` and pointed at the
 * stand-in for Printables — `docker-compose.test.yml` does both, and
 * `scripts/stubs/printables-stub.mjs` says why a stand-in rather than the real
 * site. Against a host-run app:
 *
 *   node scripts/stubs/printables-stub.mjs &
 *   IMPORT_SOURCES=printables IMPORT_PRINTABLES_BASE=http://localhost:4010 npm start
 *
 * Most of this is about refusals. Importing is the one place the app makes a
 * request to somebody else's server because a requester asked, so what matters is less that a good link
 * works than that nothing a requester types — and nothing the far end answers
 * — can choose *where* that request goes. Wherever it can, a check here
 * asserts not only the status code but that no connection was made, by
 * reading the stand-in's own request counts.
 *
 * DESTRUCTIVE: wipes users, stories and invites. Development database only.
 */
import "./_env";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { db } from "../src/lib/db";
import {
  enabledSources,
  identifySource,
  parsePrintablesUrl,
  trustedSourceLink,
} from "../src/lib/import-source";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
/** The stand-in, as this machine reaches it — for its request counts only. */
const STUB = process.env.PRINTABLES_STUB_URL ?? "http://localhost:4010";
const MODELS_ROOT = resolve(process.env.MODELS_ROOT ?? "./data/uploads");

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
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    this.store(r);
    return r;
  }
  post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.raw(APP + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
}

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

type Hits = { graphql: number; files: number; elsewhere: number; lastUserAgent: string | null };
const hits = async (): Promise<Hits> => (await fetch(`${STUB}/_hits`)).json() as Promise<Hits>;
const resetHits = () => fetch(`${STUB}/_reset`, { method: "POST" });

/** Every file under the storage root — what "nothing was left behind" is measured in. */
async function storedFiles(dir = MODELS_ROOT): Promise<number> {
  let n = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) n += await storedFiles(join(dir, entry.name));
    else n++;
  }
  return n;
}

const link = (id: number, slug = "") => `https://www.printables.com/model/${id}${slug ? `-${slug}` : ""}`;
const WISH = { material: "PETG", colorName: "Slate", quantity: 1, tip: "A beer" };

const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");

async function main() {
  // ── the rules, with nothing running ───────────────────────────────────────
  section("what counts as a link");

  const good = [
    "https://www.printables.com/model/3161-3d-benchy",
    "https://www.printables.com/model/3161",
    "https://printables.com/model/3161-3d-benchy/files",
    "https://www.printables.com/de/model/3161-3d-benchy",
    "http://www.printables.com/model/3161-3d-benchy",
    "  https://www.printables.com/model/3161-3d-benchy?utm=x#comments  ",
  ];
  check("a model page is recognised, with or without slug, tab, locale or tracking",
        good.every((u) => parsePrintablesUrl(u)?.modelId === "3161"),
        good.filter((u) => parsePrintablesUrl(u)?.modelId !== "3161").join(" | "));

  // Each of these contains "printables.com" somewhere. None of them is it.
  const hostile = [
    "https://www.printables.com.evil.example/model/3161",
    "https://evil.example/www.printables.com/model/3161",
    "https://www.printables.com@evil.example/model/3161",
    "https://evil.example/model/3161?x=www.printables.com",
    "https://www.printables.com:8443/model/3161",
    "https://user:pw@www.printables.com/model/3161",
    "https://files.printables.com/model/3161",
    "https://api.printables.com/graphql/",
    "ftp://www.printables.com/model/3161",
    "javascript:alert('www.printables.com/model/3161')",
    "file:///etc/passwd",
    "http://localhost:3000/model/3161",
    "http://printables-stub:4010/model/3161",
    "http://169.254.169.254/model/3161",
    "https://www.printables.com/model/",
    "https://www.printables.com/model/abc",
    "https://www.printables.com/@PrusaResearch",
    "https://www.printables.com/model/3161%2F..%2F..%2Fadmin",
    "//www.printables.com/model/3161",
    "not a url",
    "",
  ];
  const slipped = hostile.filter((u) => parsePrintablesUrl(u) !== null);
  check(`${hostile.length} links that only look like one are refused`, slipped.length === 0, slipped.join(" | "));

  check("the id is digits and nothing else survives the parse",
        JSON.stringify(parsePrintablesUrl("https://www.printables.com/model/3161-<script>")) === '{"modelId":"3161"}');

  check("a source that is switched off recognises nothing",
        identifySource("https://www.printables.com/model/3161", []) === null);

  section("what switches it on");

  // With the variable really absent, not merely passed as undefined — that
  // would fall through to whatever this process happens to have set.
  const configured = process.env.IMPORT_SOURCES;
  delete process.env.IMPORT_SOURCES;
  const whenUnset = enabledSources();
  if (configured !== undefined) process.env.IMPORT_SOURCES = configured;
  check("unset means off", whenUnset.length === 0 && enabledSources("").length === 0, whenUnset.join());
  check("naming the source switches it on, whatever the spacing or case",
        enabledSources(" Printables ,").join() === "printables");
  let typo = "";
  try { enabledSources("printable"); } catch (e) { typo = String((e as Error).message); }
  check("a misspelt source is an error that names it, not a quiet 'off'",
        typo.includes("printable") && typo.includes("IMPORT_SOURCES"), typo || "no error was thrown");

  section("what may become a link on a ticket");

  check("a stored model page is rendered",
        trustedSourceLink("https://www.printables.com/model/3161-3d-benchy")?.label === "Printables");
  const untrusted = [
    "javascript:alert(1)",
    "https://evil.example/model/3161",
    "http://www.printables.com/model/3161",
    "https://www.printables.com.evil.example/model/3161",
    "https://www.printables.com/login?next=//evil.example",
    "data:text/html,<script>alert(1)</script>",
    "",
  ];
  check("anything else in that column is not",
        untrusted.every((u) => trustedSourceLink(u) === null) && trustedSourceLink(null) === null,
        untrusted.filter((u) => trustedSourceLink(u) !== null).join(" | "));

  // ── against the running app ──────────────────────────────────────────────
  section("setup");

  let stubUp = false;
  try { stubUp = (await fetch(`${STUB}/_hits`)).ok; } catch { /* reported below */ }
  if (!stubUp) {
    throw new Error(
      `The Printables stand-in is not answering at ${STUB}.\n` +
        "Raise the stack with docker-compose.test.yml, or run\n" +
        "  node scripts/stubs/printables-stub.mjs",
    );
  }

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

  const catalog = await (await aylaB.raw(`${APP}/api/catalog`)).json();
  if (!Array.isArray(catalog.importSources) || !catalog.importSources.includes("printables")) {
    throw new Error(
      "This app does not have importing switched on, so there is nothing to verify.\n" +
        "Start it with IMPORT_SOURCES=printables and IMPORT_PRINTABLES_BASE pointing at the stand-in\n" +
        "(docker-compose.test.yml sets both).",
    );
  }
  check("the catalogue says importing is on, and from where", catalog.importSources.join() === "printables");

  const uploadPage = rendered(await (await aylaB.raw(`${APP}/upload`)).text());
  check("the request form offers the link step", uploadPage.includes("paste a Printables link"),
        "no link field on /upload");

  // ── listing ──────────────────────────────────────────────────────────────
  section("a link lists what could be printed");

  await resetHits();
  const listedRes = await aylaB.post("/api/import/files", { url: link(3161, "3d-benchy") + "/files?utm=x" });
  const listed = await listedRes.json();
  check("the listing is answered", listedRes.status === 200, `status ${listedRes.status} ${JSON.stringify(listed).slice(0, 160)}`);
  check("it names the model, its author and its licence",
        listed.model?.name === "3D BENCHY" && listed.model?.author === "Stub Research" &&
        String(listed.model?.license).includes("Public Domain"), JSON.stringify(listed.model));
  check("the model's link is rebuilt from the site's answer, not echoed from the request",
        listed.model?.url === "https://www.printables.com/model/3161-3d-benchy", listed.model?.url);
  check("only .stl and .3mf are offered",
        listed.files?.map((f: { name: string }) => f.name).join() ===
          "benchy.stl,plate.3mf,scan-of-the-whole-harbour.stl",
        JSON.stringify(listed.files));
  check("and it says how many files were left out", listed.otherFiles === 1, String(listed.otherFiles));
  check("a file over the cap is listed as too large rather than hidden",
        listed.files?.find((f: { id: string }) => f.id === "104")?.tooLarge === true &&
        listed.files?.find((f: { id: string }) => f.id === "101")?.tooLarge === false);

  const afterList = await hits();
  check("the app introduces itself honestly to the site",
        /^PrettyPleasePrint \(\+https?:\/\//.test(afterList.lastUserAgent ?? ""), String(afterList.lastUserAgent));
  check("listing asks the API once and fetches no file", afterList.graphql === 1 && afterList.files === 0,
        JSON.stringify(afterList));

  check("without a session it is 401, not a listing",
        (await anon.post("/api/import/files", { url: link(3161) })).status === 401);
  check("a cross-origin page cannot make the server go and look",
        (await aylaB.post("/api/import/files", { url: link(3161) }, { origin: "https://evil.example" })).status === 403);
  check("…nor make it import", (await aylaB.post("/api/import", { ...WISH, url: link(3161), fileId: "101" },
        { origin: "https://evil.example" })).status === 403);

  const odd = await (await aylaB.post("/api/import/files", { url: link(4011) })).json();
  check("a slug that is not a slug is dropped from the link, not stored",
        odd.model?.url === "https://www.printables.com/model/4011", odd.model?.url);

  const none = await (await aylaB.post("/api/import/files", { url: link(4012) })).json();
  check("a model with nothing printable lists nothing, and says what was skipped",
        Array.isArray(none.files) && none.files.length === 0 && none.otherFiles === 1, JSON.stringify(none));

  // ── importing ────────────────────────────────────────────────────────────
  section("an imported file becomes a story");

  const diskBefore = await storedFiles();
  const res = await aylaB.post("/api/import", {
    ...WISH, title: "Benchy for the shelf", url: link(3161, "3d-benchy"), fileId: "101",
  });
  const payload = await res.json();
  check("import accepted", res.status === 201, `status ${res.status} ${JSON.stringify(payload).slice(0, 200)}`);

  const story = await db.story.findFirst({ where: { uploaderId: ayla.id }, orderBy: { id: "desc" } });
  check("a story row exists, owned by the person who asked", story?.uploaderId === ayla.id && story?.status === "Requested");
  check("the filename is the site's, the size is what arrived",
        story?.filename === "benchy.stl" && story?.fileSize === 684, `${story?.filename} ${story?.fileSize}`);
  check("dimensions were measured from the fetched bytes", story?.dims === "40 × 20 × 10 mm", story?.dims ?? "");
  check("the wish was stored as an upload's would be",
        story?.material === "PETG" && story?.colorName === "Slate" && story?.title === "Benchy for the shelf");
  check("where it came from is on the ticket",
        story?.sourceUrl === "https://www.printables.com/model/3161-3d-benchy", story?.sourceUrl ?? "null");

  const onDisk = story ? await stat(join(MODELS_ROOT, story.storageKey)).catch(() => null) : null;
  check("the bytes are really on disk", onDisk?.size === 684 && (await storedFiles()) === diskBefore + 1,
        `size ${onDisk?.size}, files ${await storedFiles()} (was ${diskBefore})`);

  check("the API says where it came from",
        payload.story?.source === "https://www.printables.com/model/3161-3d-benchy", JSON.stringify(payload.story?.source));
  check("and still does not say where it is stored", !JSON.stringify(payload).includes(story?.storageKey ?? "\0"));

  const note = await db.notification.findFirst({ where: { recipientId: admin.id, storyId: story?.id } });
  check("the printer owner is told, and told it was imported", note?.text.includes("imported") === true, note?.text ?? "none");

  const created = await db.auditEvent.findFirst({ where: { action: "story.created" }, orderBy: { at: "desc" } });
  const detail = (created?.detail ?? {}) as Record<string, unknown>;
  check("the trail records the source", detail.source === "printables" &&
        detail.sourceUrl === "https://www.printables.com/model/3161-3d-benchy", JSON.stringify(detail));

  const ticket = rendered(await (await aylaB.raw(`${APP}/story/${story?.id}`)).text());
  check("the ticket links back to the model's page, safely",
        /<a[^>]+href="https:\/\/www\.printables\.com\/model\/3161-3d-benchy"[^>]+rel="noreferrer noopener"/.test(ticket),
        "no source link, or one without rel");
  check("the owner sees the same link",
        rendered(await (await rubenB.raw(`${APP}/story/${story?.id}`)).text()).includes("Imported from"));
  check("a colleague cannot see the ticket at all",
        (await jonasB.raw(`${APP}/story/${story?.id}`)).status === 404);

  const bytesRes = await aylaB.raw(`${APP}/api/models/${story?.id}`);
  check("the viewer is served the imported bytes",
        bytesRes.status === 200 && (await bytesRes.arrayBuffer()).byteLength === 684, `status ${bytesRes.status}`);

  const threeRes = await aylaB.post("/api/import", { ...WISH, url: link(3161), fileId: 102 });
  const three = await threeRes.json();
  check("a 3MF imports too, and the file id may be a number",
        threeRes.status === 201 && three.story?.file?.dims === "30 × 20 × 10 mm" &&
        three.story?.file?.filename === "plate.3mf", `status ${threeRes.status} ${JSON.stringify(three).slice(0, 160)}`);
  check("with no title, it is named after the file", three.story?.title === "plate", three.story?.title);

  const againRes = await aylaB.post(`/api/stories/${story?.id}/requeue`, {});
  const again = await againRes.json();
  check("printing it again keeps where it came from",
        againRes.status === 201 && again.story?.source === "https://www.printables.com/model/3161-3d-benchy",
        `status ${againRes.status} ${JSON.stringify(again.story?.source)}`);

  // ── the wish comes first ─────────────────────────────────────────────────
  section("nothing is fetched for a request that would be refused anyway");

  await resetHits();
  const badWish = await aylaB.post("/api/import", { ...WISH, colorName: "Plaid", url: link(3161), fileId: "101" });
  check("a colour that is not on the shelf is refused", badWish.status === 400, `status ${badWish.status}`);
  const badTip = await aylaB.post("/api/import", { ...WISH, tip: "A pony", url: link(3161), fileId: "101" });
  check("and so is a benefit that is not on offer", badTip.status === 400, `status ${badTip.status}`);
  const quiet = await hits();
  check("and the site was never contacted to find that out",
        quiet.graphql === 0 && quiet.files === 0, JSON.stringify(quiet));

  // ── links that are not links ─────────────────────────────────────────────
  section("a link that is not Printables goes nowhere");

  await resetHits();
  const storiesBefore = await db.story.count();
  const filesBefore = await storedFiles();
  const refusedList: string[] = [];
  const refusedImport: string[] = [];
  for (const url of hostile) {
    const a = await aylaB.post("/api/import/files", { url });
    if (a.status !== 422) refusedList.push(`${url} → ${a.status}`);
    const b = await aylaB.post("/api/import", { ...WISH, url, fileId: "101" });
    if (b.status !== 422) refusedImport.push(`${url} → ${b.status}`);
  }
  check(`all ${hostile.length} are 422 when listing`, refusedList.length === 0, refusedList.join(" | "));
  check("and 422 when importing", refusedImport.length === 0, refusedImport.join(" | "));
  for (const url of [null, 42, ["https://www.printables.com/model/3161"], { href: "x" }]) {
    const r = await aylaB.post("/api/import/files", { url });
    if (r.status !== 422) refusedList.push(`${JSON.stringify(url)} → ${r.status}`);
  }
  check("a link that is not even a string is 422, not a crash", refusedList.length === 0, refusedList.join(" | "));
  const untouched = await hits();
  check("none of them caused a single outbound request",
        untouched.graphql === 0 && untouched.files === 0 && untouched.elsewhere === 0, JSON.stringify(untouched));

  // ── the far end misbehaving ──────────────────────────────────────────────
  section("the site cannot choose where the app connects");

  await resetHits();
  const elsewhereRes = await aylaB.post("/api/import", { ...WISH, url: link(4002), fileId: "301" });
  const elsewhereBody = await elsewhereRes.json();
  let seen = await hits();
  check("a download link on another origin is refused", elsewhereRes.status === 502,
        `status ${elsewhereRes.status} ${JSON.stringify(elsewhereBody)}`);
  check("and never connected to — a good model was waiting there",
        seen.elsewhere === 0 && seen.files === 0, JSON.stringify(seen));
  check("the refusal says what to do instead, and not where the link pointed",
        String(elsewhereBody.error).includes("upload it here instead") &&
        !/printables-stub|localhost|:401\d/.test(String(elsewhereBody.error)), elsewhereBody.error);

  await resetHits();
  const redirectRes = await aylaB.post("/api/import", { ...WISH, url: link(4003), fileId: "401" });
  seen = await hits();
  check("a redirect off the file host is an error", redirectRes.status === 502, `status ${redirectRes.status}`);
  check("and is not followed", seen.elsewhere === 0 && seen.files === 1, JSON.stringify(seen));

  section("the site cannot deliver something other than it listed");

  const cases: [string, number, string | number, number][] = [
    ["a web page named .stl is refused on its bytes", 4001, "201", 422],
    ["a file larger than it was listed, admitted in a header", 4004, "501", 502],
    ["a file larger than it was listed, sent without saying", 4009, "901", 502],
    ["a file the site will not hand over", 4008, "801", 502],
    ["a file over the cap", 3161, "104", 413],
    ["a file that belongs to a different model", 3161, "201", 404],
    ["a file that is listed but not printable", 3161, "103", 404],
    ["a model that does not exist", 999999, "101", 404],
    ["the API answering 500", 4005, "101", 502],
    ["the API changing its shape", 4006, "101", 502],
    ["the API answering about a different model", 4007, "101", 502],
    ["the API answering with a web page", 4013, "101", 502],
    ["no file named at all", 3161, "", 400],
    ["a file id that is not an id", 3161, "101; DROP TABLE story", 400],
  ];
  for (const [name, model, fileId, want] of cases) {
    const r = await aylaB.post("/api/import", { ...WISH, url: link(model), fileId });
    const body = await r.json().catch(() => ({}));
    check(`${name} → ${want}`, r.status === want && typeof body.error === "string",
          `status ${r.status} ${JSON.stringify(body).slice(0, 140)}`);
  }

  await resetHits();
  await aylaB.post("/api/import", { ...WISH, url: link(3161), fileId: "104" });
  check("the file over the cap was refused from the listing, without fetching it", (await hits()).files === 0);

  const rejected = await db.auditEvent.findFirst({ where: { action: "upload.rejected" }, orderBy: { at: "desc" } });
  const why = (rejected?.detail ?? {}) as Record<string, unknown>;
  check("the refused bytes are in the trail, with where they came from",
        rejected?.subject === "page.stl" && why.reason === "not_a_model" && why.source === "printables",
        JSON.stringify({ subject: rejected?.subject, ...why }));

  check("none of that opened a ticket", (await db.story.count()) === storiesBefore,
        `${await db.story.count()} stories, was ${storiesBefore}`);
  check("and none of it left a file behind", (await storedFiles()) === filesBefore,
        `${await storedFiles()} files, was ${filesBefore}`);

  const shapes = await aylaB.post("/api/import/files", { url: link(4006) });
  const shapeBody = await shapes.json();
  check("when the site's API changes, the message says so in words",
        shapes.status === 502 && /API may have changed/.test(String(shapeBody.error)), JSON.stringify(shapeBody));

  // ── an upload is untouched by all this ───────────────────────────────────
  section("an upload still has no source");

  const form = new FormData();
  const box = new Uint8Array(await (await fetch(`${STUB}/files/benchy.stl`)).arrayBuffer());
  form.set("file", new File([box as BlobPart], "from-my-disk.stl"));
  for (const [k, v] of Object.entries(WISH)) form.set(k, String(v));
  const up = await aylaB.raw(`${APP}/api/upload`, { method: "POST", body: form });
  const upBody = await up.json();
  const uploaded = await db.story.findUnique({ where: { id: upBody.id ?? -1 } });
  check("an upload opens a ticket as it always did", up.status === 200 && uploaded?.filename === "from-my-disk.stl",
        `status ${up.status} ${JSON.stringify(upBody)}`);
  check("with no source", uploaded?.sourceUrl === null);
  const plain = await (await aylaB.raw(`${APP}/api/stories/${uploaded?.id}`)).json();
  check("which the API reports as null", plain.source === null, JSON.stringify(plain.source));
  check("and the ticket shows no source link",
        !rendered(await (await aylaB.raw(`${APP}/story/${uploaded?.id}`)).text()).includes("Imported from"));

  // A value in the column that this app could not have written. It should
  // never be there; if it is, it must not become a link.
  await db.story.update({ where: { id: uploaded!.id }, data: { sourceUrl: "javascript:alert(document.domain)" } });
  const tampered = rendered(await (await aylaB.raw(`${APP}/story/${uploaded?.id}`)).text());
  const tamperedApi = await (await aylaB.raw(`${APP}/api/stories/${uploaded?.id}`)).json();
  check("a source that is not a model page is never rendered as a link",
        !tampered.includes("javascript:alert") && !tampered.includes("Imported from") &&
        tamperedApi.source === null, JSON.stringify(tamperedApi.source));

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => db.$disconnect());

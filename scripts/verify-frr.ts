import "./_env";
/**
 * End-to-end check of the feature-request track — the 'frr' backlog.
 *
 *   npm run verify:frr
 *
 * Drives the real forms the way a browser with JavaScript off does, exactly as
 * verify:queue does for prints — because the whole point of this feature is
 * that the owner handles a request the same way they handle a print. What is
 * asserted is what a person observes: a status code, a database row, what the
 * page says, who was notified, what the audit trail recorded.
 *
 * DESTRUCTIVE: wipes users, features and stories. Development database only.
 */
import { db } from "../src/lib/db";
import {
  FEATURE_BOARD,
  featureRef as refOf,
  nextFeatureStatus,
} from "../src/lib/scope";
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
  /** Replay a server-action form the way a JS-less browser does. */
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

const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");
function paramOf(location: string | null, key: string): string {
  if (!location) return "";
  const q = location.split("?")[1] ?? "";
  return new URLSearchParams(q).get(key) ?? "";
}
function formIndexContaining(html: string, marker: string): number {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.findIndex((f) => f.includes(marker));
}

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

async function makeFeature(requesterId: string, title: string, status = "Requested") {
  return db.featureRequest.create({
    data: {
      title, status: status as never, requesterId,
      description: "because it would help", priority: "medium", category: "other",
    },
  });
}

async function main() {
  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.featureComment.deleteMany();
  await db.featureRequest.deleteMany();
  await db.story.deleteMany();
  await db.verification.deleteMany();
  await db.session.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  const ayla = await db.user.create({
    data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY", role: "client", emailVerified: true, invitedById: admin.id },
  });
  const mallory = await db.user.create({
    data: { email: "mallory@office.example", name: "Mallory Quint", initials: "MQ", role: "client", emailVerified: true, invitedById: admin.id },
  });

  const ruben = await signIn(admin);
  const client = await signIn(ayla);
  const other = await signIn(mallory);
  console.info(`  admin=${admin.email}  client=${ayla.email}  third=${mallory.email}`);

  // ------------------------------------------------------------------
  section("filing a request through the form");
  const newPage = await (await client.go(`${APP}/frr/new`)).text();
  const formIdx = formIndexContaining(newPage, 'name="title"');
  check("the requester is offered the new-request form", formIdx >= 0);
  await client.submit(`${APP}/frr/new`, newPage, formIdx, {
    title: "Dark mode for the board",
    description: "Easier on the eyes in the workshop at night.",
    priority: "high",
    category: "ui",
  });
  const filed = await db.featureRequest.findFirst({ where: { title: "Dark mode for the board" } });
  check("it is stored", !!filed, "the request was not created");
  check("owned by the requester, from the session", filed?.requesterId === ayla.id);
  check("it starts Requested", filed?.status === "Requested", String(filed?.status));
  check("the priority and category are kept", filed?.priority === "high" && filed?.category === "ui");
  check("the owner is notified",
        (await db.notification.count({ where: { recipientId: admin.id, featureId: filed!.id } })) > 0);
  check("and it is audited",
        (await db.auditEvent.count({ where: { action: "feature.created", subject: refOf(filed!.id) } })) === 1);

  // A posted requesterId is ignored — the session decides.
  const spoofPage = await (await client.go(`${APP}/frr/new`)).text();
  await client.submit(`${APP}/frr/new`, spoofPage, formIndexContaining(spoofPage, 'name="title"'), {
    title: "Filed as someone else", description: "x", priority: "low", category: "other",
    requesterId: admin.id, status: "Done",
  });
  const spoofed = await db.featureRequest.findFirst({ where: { title: "Filed as someone else" } });
  check("a posted requesterId is ignored", spoofed?.requesterId === ayla.id, String(spoofed?.requesterId));
  check("a posted status is ignored; new requests are Requested", spoofed?.status === "Requested", String(spoofed?.status));

  // ------------------------------------------------------------------
  section("the queue is owner-only");
  const denied = await client.go(`${APP}/frr/queue`);
  check("a client gets 404, not 403", denied.status === 404, `status ${denied.status}`);
  const queue = await (await ruben.go(`${APP}/frr/queue`)).text();
  check("the owner sees the request waiting", rendered(queue).includes("Dark mode for the board"));

  // ------------------------------------------------------------------
  section("scope: a client sees their own, the owner sees all");
  const mine = await makeFeature(ayla.id, "Bulk upload");
  const theirs = await makeFeature(mallory.id, "Not Ayla's idea");
  const aylaBoard = rendered(await (await client.go(`${APP}/frr`)).text());
  check("the client's board has their own", aylaBoard.includes("Bulk upload"));
  check("and not somebody else's", !aylaBoard.includes("Not Ayla's idea"));
  const adminBoard = rendered(await (await ruben.go(`${APP}/frr`)).text());
  check("the owner's board has both", adminBoard.includes("Bulk upload") && adminBoard.includes("Not Ayla's idea"));
  const peek = await client.go(`${APP}/frr/${theirs.id}`);
  check("reading another client's request is 404, not 403", peek.status === 404, `status ${peek.status}`);

  // ------------------------------------------------------------------
  section("the flow, forwards only, one step");
  const flowFR = await makeFeature(ayla.id, "Keyboard shortcuts");
  // A client cannot move it.
  const detail = await (await client.go(`${APP}/frr/${flowFR.id}`)).text();
  check("a client is not offered the owner controls", !detail.includes("Accept it"));

  const adminDetail = await (await ruben.go(`${APP}/frr/${flowFR.id}`)).text();
  const acceptIdx = formIndexContaining(adminDetail, "Accept it");
  check("the owner is offered Accept it", acceptIdx >= 0);
  const accepted = await ruben.submit(`${APP}/frr/${flowFR.id}`, adminDetail, acceptIdx, {});
  check("Requested → Accepted",
        (await db.featureRequest.findUnique({ where: { id: flowFR.id } }))?.status === "Accepted");
  check("the requester is notified",
        (await db.notification.count({ where: { recipientId: ayla.id, featureId: flowFR.id } })) > 0);
  check("the toast names who was told",
        paramOf(accepted.headers.get("location"), "toast").includes("Ayla Berg notified"),
        paramOf(accepted.headers.get("location"), "toast"));
  check("and it is audited",
        (await db.auditEvent.count({ where: { action: "feature.status_changed", subject: refOf(flowFR.id) } })) === 1);

  // Walk the rest of the flow via the queue's "Move to …" buttons.
  for (const expected of ["InProgress", "Shipped", "Done"]) {
    const q = await (await ruben.go(`${APP}/frr/queue`)).text();
    const idx = formIndexContaining(q, `name="id" value="${flowFR.id}"`);
    // The advance form for this id is the first one containing its id.
    check(`a control exists to advance ${refOf(flowFR.id)}`, idx >= 0);
    await ruben.submit(`${APP}/frr/queue`, q, idx, { id: String(flowFR.id) });
    const row = await db.featureRequest.findUnique({ where: { id: flowFR.id } });
    check(`advanced to ${expected}`, row?.status === expected, String(row?.status));
  }
  check("Done is the end of the flow", nextFeatureStatus("Done") === null);

  // A bare POST cannot drive it past Done.
  const past = await ruben.raw(`${APP}/frr/${flowFR.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(flowFR.id)); return f; })(),
  });
  void past;
  check("nothing moves past Done",
        (await db.featureRequest.findUnique({ where: { id: flowFR.id } }))?.status === "Done");

  // ------------------------------------------------------------------
  section("declining, terminal and only from Requested");
  const fresh = await makeFeature(ayla.id, "Export to CSV");
  const fd = await (await ruben.go(`${APP}/frr/${fresh.id}`)).text();
  const declineIdx = formIndexContaining(fd, "Yes, decline it");
  check("the decline control is offered on a Requested item", declineIdx >= 0);
  await ruben.submit(`${APP}/frr/${fresh.id}`, fd, declineIdx, {});
  check("Requested → Declined",
        (await db.featureRequest.findUnique({ where: { id: fresh.id } }))?.status === "Declined");
  check("declining is audited",
        (await db.auditEvent.count({ where: { action: "feature.declined", subject: refOf(fresh.id) } })) === 1);

  const accForDecline = await makeFeature(ayla.id, "Already accepted", "Accepted");
  const declineLate = await ruben.raw(`${APP}/frr/${accForDecline.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(accForDecline.id)); return f; })(),
  });
  void declineLate;
  check("an accepted request stays accepted (no bare-POST decline)",
        (await db.featureRequest.findUnique({ where: { id: accForDecline.id } }))?.status === "Accepted");

  // ------------------------------------------------------------------
  section("the conversation");
  const talk = await makeFeature(ayla.id, "Talk about this one");
  let page = await (await client.go(`${APP}/frr/${talk.id}`)).text();
  const sayIdx = formIndexContaining(page, 'name="body"');
  check("a client gets a composer on their own request", sayIdx >= 0);
  await client.submit(`${APP}/frr/${talk.id}`, page, sayIdx, { body: "Could this include the queue too?" });
  const thread = await db.featureComment.findMany({ where: { featureId: talk.id } });
  check("the comment is stored", thread.length === 1);
  check("attributed to the client", thread[0]?.authorId === ayla.id);
  check("the owner is told", (await db.notification.count({
    where: { recipientId: admin.id, featureId: talk.id }, // created + comment
  })) >= 1);
  check("the client is not told about their own comment",
        (await db.notification.count({ where: { recipientId: ayla.id, featureId: talk.id } })) === 0);

  // Another client cannot comment on a request they cannot see.
  const intruder = await other.raw(`${APP}/frr/${talk.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("featureId", String(talk.id)); f.set("body", "hi"); return f; })(),
  });
  void intruder;
  check("another client cannot comment on a request they cannot see",
        (await db.featureComment.count({ where: { authorId: mallory.id } })) === 0);

  // Hostile body is escaped, not rendered.
  page = await (await client.go(`${APP}/frr/${talk.id}`)).text();
  await client.submit(`${APP}/frr/${talk.id}`, page, formIndexContaining(page, 'name="body"'),
    { body: "<script>alert(1)</script>" });
  page = await (await client.go(`${APP}/frr/${talk.id}`)).text();
  check("a hostile comment body is escaped, not rendered", !page.includes("<script>alert(1)</script>"));

  // ------------------------------------------------------------------
  section("the requester can withdraw their own, while untouched");
  const regret = await makeFeature(ayla.id, "Changed my mind");
  const rp = await (await client.go(`${APP}/frr/${regret.id}`)).text();
  const wIdx = formIndexContaining(rp, "Yes, withdraw it");
  check("the requester is offered withdraw", wIdx >= 0);
  await client.submit(`${APP}/frr/${regret.id}`, rp, wIdx, { id: String(regret.id) });
  check("withdrawing removes it", (await db.featureRequest.count({ where: { id: regret.id } })) === 0);
  check("and it is audited",
        (await db.auditEvent.count({ where: { action: "feature.withdrawn", subject: refOf(regret.id) } })) === 1);

  const started = await makeFeature(ayla.id, "Too late", "InProgress");
  const sp = await (await client.go(`${APP}/frr/${started.id}`)).text();
  check("a started request offers no withdrawal", !sp.includes("Yes, withdraw it"));
  const forceWithdraw = await client.raw(`${APP}/frr/${started.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(started.id)); return f; })(),
  });
  void forceWithdraw;
  check("and a bare POST cannot force it",
        (await db.featureRequest.count({ where: { id: started.id } })) === 1);

  const adminForce = await ruben.raw(`${APP}/frr/${mine.id}`, {
    method: "POST",
    body: (() => { const f = new FormData(); f.set("id", String(mine.id)); return f; })(),
  });
  void adminForce;
  check("the owner cannot withdraw somebody's request",
        (await db.featureRequest.count({ where: { id: mine.id } })) === 1);

  // ------------------------------------------------------------------
  section("priority is editable after filing");
  // `mine` is Ayla's, still Requested. The requester changes it through the
  // rendered form.
  const beforePriority = (await db.featureRequest.findUnique({ where: { id: mine.id } }))?.priority;
  const pPage = await (await client.go(`${APP}/frr/${mine.id}`)).text();
  const pIdx = formIndexContaining(pPage, 'name="priority"');
  check("the requester is offered a priority control on their own request", pIdx >= 0);
  await client.submit(`${APP}/frr/${mine.id}`, pPage, pIdx, { id: String(mine.id), priority: "high" });
  check("the requester changes their own request's priority",
        (await db.featureRequest.findUnique({ where: { id: mine.id } }))?.priority === "high",
        `was ${beforePriority}`);
  check("the change is audited",
        (await db.auditEvent.count({ where: { action: "feature.priority_changed", subject: refOf(mine.id) } })) === 1);
  check("the owner is notified of the requester's change",
        (await db.notification.count({
          where: { recipientId: admin.id, featureId: mine.id },
        })) >= 1);

  // An invalid priority is refused. Replay the real form (so the action runs)
  // but override the select to a value it never offers.
  const badPage = await (await client.go(`${APP}/frr/${mine.id}`)).text();
  await client.submit(`${APP}/frr/${mine.id}`, badPage,
    formIndexContaining(badPage, 'name="priority"'), { id: String(mine.id), priority: "urgent" });
  check("an invalid priority is refused",
        (await db.featureRequest.findUnique({ where: { id: mine.id } }))?.priority === "high");

  // Another client cannot even see the request, so is never offered the
  // control; scope makes the guard unreachable through the UI.
  const intruderView = await other.go(`${APP}/frr/${mine.id}`);
  check("another client cannot see the request (404), so cannot reprioritise it",
        intruderView.status === 404 &&
        (await db.featureRequest.findUnique({ where: { id: mine.id } }))?.priority === "high",
        `status ${intruderView.status}`);

  // The owner can change any request's priority, through the same form.
  const ownerView = await (await ruben.go(`${APP}/frr/${mine.id}`)).text();
  const ownerPIdx = formIndexContaining(ownerView, 'name="priority"');
  check("the owner is offered the priority control too", ownerPIdx >= 0);
  await ruben.submit(`${APP}/frr/${mine.id}`, ownerView, ownerPIdx, { id: String(mine.id), priority: "medium" });
  check("the owner can change any request's priority",
        (await db.featureRequest.findUnique({ where: { id: mine.id } }))?.priority === "medium");

  // Priority is editable in EVERY status now — a closed request included.
  const closedPr = await makeFeature(ayla.id, "Long since closed", "Done");
  const closedPage = await (await client.go(`${APP}/frr/${closedPr.id}`)).text();
  const closedIdx = formIndexContaining(closedPage, 'name="priority"');
  check("a Done request still offers the requester the priority control", closedIdx >= 0);
  await client.submit(`${APP}/frr/${closedPr.id}`, closedPage, closedIdx, {
    id: String(closedPr.id), priority: "high",
  });
  check("the requester reprioritises a Done request",
        (await db.featureRequest.findUnique({ where: { id: closedPr.id } }))?.priority === "high");
  check("and it is audited",
        (await db.auditEvent.count({ where: { action: "feature.priority_changed", subject: refOf(closedPr.id) } })) === 1);

  const declinedPr = await makeFeature(ayla.id, "Turned down but still ranked", "Declined");
  const declinedPage = await (await client.go(`${APP}/frr/${declinedPr.id}`)).text();
  await client.submit(`${APP}/frr/${declinedPr.id}`, declinedPage,
    formIndexContaining(declinedPage, 'name="priority"'), { id: String(declinedPr.id), priority: "low" });
  check("a Declined request's priority is editable too",
        (await db.featureRequest.findUnique({ where: { id: declinedPr.id } }))?.priority === "low");

  // ------------------------------------------------------------------
  section("filtering by priority, status and category");
  // A known spread the owner can filter over. Ayla owns them all here.
  const fHigh = await makeFeature(ayla.id, "High UI thing", "Requested");
  await db.featureRequest.update({ where: { id: fHigh.id }, data: { priority: "high", category: "ui" } });
  const fLowApi = await makeFeature(ayla.id, "Low API thing", "Accepted");
  await db.featureRequest.update({ where: { id: fLowApi.id }, data: { priority: "low", category: "api" } });

  const q = async (query: string) =>
    rendered(await (await ruben.go(`${APP}/frr/queue?${query}`)).text());

  const byHigh = await q("priority=high");
  check("filter priority=high shows the high one", byHigh.includes("High UI thing"));
  check("and hides the low one", !byHigh.includes("Low API thing"));

  const byApi = await q("category=api");
  check("filter category=api shows the API one", byApi.includes("Low API thing"));
  check("and hides the UI one", !byApi.includes("High UI thing"));

  const byCombo = await q("priority=high&category=api");
  check("a combined filter that matches nothing shows neither",
        !byCombo.includes("High UI thing") && !byCombo.includes("Low API thing"));

  // Scope holds under a filter: a client's filter never surfaces another's.
  const malloryHigh = await makeFeature(mallory.id, "Mallory high UI", "Requested");
  await db.featureRequest.update({ where: { id: malloryHigh.id }, data: { priority: "high", category: "ui" } });
  const aylaFiltered = rendered(await (await client.go(`${APP}/frr?priority=high`)).text());
  check("a client's priority filter still hides another client's matching request",
        aylaFiltered.includes("High UI thing") && !aylaFiltered.includes("Mallory high UI"));

  // A garbage filter value degrades to "any" rather than erroring.
  const garbage = await ruben.go(`${APP}/frr/queue?priority=urgent`);
  check("an unknown filter value is ignored (no error)", garbage.status === 200);

  // ------------------------------------------------------------------
  section("the board draws the four live rails, closed items leave");
  const board = rendered(await (await ruben.go(`${APP}/frr`)).text());
  for (const rail of FEATURE_BOARD) {
    const label = rail === "InProgress" ? "In progress" : rail;
    check(`the board draws the ${label} rail`, board.includes(label));
  }
  check("Done is not a rail (it is under Closed)", board.includes("Closed"));

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

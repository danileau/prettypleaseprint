import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FeatureStatus, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerName, printerOwner } from "@/lib/authz";
import {
  AuthzError,
  FEATURE_FLOW,
  assertFeatureTransition,
  featureLabel,
  featureRef,
  featureScope,
  nextFeatureStatus,
  type Actor,
} from "@/lib/scope";
import { FEATURE_CATEGORIES, FEATURE_PRIORITIES, FeatureWishSchema } from "@/lib/catalog";
import { BodySchema } from "@/lib/stories";

/**
 * Everything that can happen to a feature request — the 'frr' track.
 *
 * A deliberate mirror of `src/lib/stories.ts`: same shape, same four rules
 * (role checked every time, transitions through `assertFeatureTransition`, the
 * requester always told, an audit row after the change commits), so the owner
 * handles a feature request exactly as they handle a print. Kept parallel
 * rather than generalised because the print service is load-bearing and
 * separately tested — a shared abstraction would couple two backlogs that are
 * better off independent.
 *
 * As in `stories.ts`, nothing here knows about redirects or HTTP status pages.
 * A refusal leaves as a `FeatureProblem` carrying a sentence for a person; the
 * server action turns it into a toast.
 */

export class FeatureProblem extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FeatureProblem";
  }
}

const problem = (status: number, message: string) => new FeatureProblem(status, message);

function asProblem(error: unknown): never {
  if (error instanceof AuthzError) throw problem(403, error.message);
  throw error;
}

export const FeatureIdSchema = z.coerce.number().int().positive();

/** Parse a path segment or form field into a feature id, or refuse it. */
export function featureIdOr400(raw: unknown): number {
  const parsed = FeatureIdSchema.safeParse(raw);
  if (!parsed.success) throw problem(400, "That is not a request.");
  return parsed.data;
}

function refresh(id: number) {
  revalidatePath("/frr");
  revalidatePath("/frr/queue");
  revalidatePath(`/frr/${id}`);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every column a representation of a feature request is built from. */
export const FEATURE_FIELDS = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  category: true,
  createdAt: true,
  updatedAt: true,
  requesterId: true,
  requester: { select: { id: true, name: true, initials: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.FeatureRequestSelect;

export type FeatureRow = Prisma.FeatureRequestGetPayload<{ select: typeof FEATURE_FIELDS }>;

/**
 * The set of values a request may be filtered by. Empty/absent means "any".
 * Priority, status and category are the three enum columns; a filter can only
 * ever narrow a caller's scope, never widen it — `featureScope` stays the
 * first term of every query below.
 */
export type FeatureFilter = { priority?: string; status?: string; category?: string };

/** Every status a request can be in — the flow plus the terminal `Declined`. */
const FEATURE_STATUSES = [...FEATURE_FLOW, "Declined"] as readonly string[];

/**
 * Keep only recognised filter values; anything unknown (a stray query string,
 * a removed enum member) is dropped to "any" rather than erroring, so a
 * hand-edited URL degrades to a wider result instead of a 500.
 */
export function coerceFeatureFilter(raw: {
  priority?: string;
  status?: string;
  category?: string;
}): FeatureFilter {
  const pick = (v: string | undefined, allowed: readonly string[]) =>
    v && allowed.includes(v) ? v : undefined;
  return {
    priority: pick(raw.priority, FEATURE_PRIORITIES),
    status: pick(raw.status, FEATURE_STATUSES),
    category: pick(raw.category, FEATURE_CATEGORIES),
  };
}

/** True when at least one filter is set — for the "clear" affordance / count. */
export const hasFeatureFilter = (f: FeatureFilter): boolean =>
  Boolean(f.priority || f.status || f.category);

function featureWhere(actor: Actor, filter: FeatureFilter): Prisma.FeatureRequestWhereInput {
  const and: Prisma.FeatureRequestWhereInput[] = [featureScope(actor)];
  if (filter.priority) and.push({ priority: filter.priority as Prisma.EnumFeaturePriorityFilter });
  if (filter.status) and.push({ status: filter.status as Prisma.EnumFeatureStatusFilter });
  if (filter.category) and.push({ category: filter.category as Prisma.EnumFeatureCategoryFilter });
  return { AND: and };
}

/**
 * The requests this actor may see — their own, or all of them for the owner —
 * optionally narrowed by a filter. The scope predicate is always the first
 * term of the AND, so no combination of filters can surface a request the
 * caller is not entitled to. `order` is newest-first for the board and
 * oldest-first for the owner's triage queue.
 */
export function listFeatures(
  actor: Actor,
  filter: FeatureFilter = {},
  order: "asc" | "desc" = "desc",
): Promise<FeatureRow[]> {
  return db.featureRequest.findMany({
    where: featureWhere(actor, filter),
    select: FEATURE_FIELDS,
    orderBy: { createdAt: order },
  });
}

/** One request, under the caller's scope; null if it is not theirs to see. */
export function findFeature(actor: Actor, id: number): Promise<FeatureRow | null> {
  return db.featureRequest.findFirst({
    where: { AND: [{ id }, featureScope(actor)] },
    select: FEATURE_FIELDS,
  });
}

export async function getFeature(actor: Actor, id: number): Promise<FeatureRow> {
  const feature = await findFeature(actor, id);
  if (!feature) throw problem(404, "That request no longer exists.");
  return feature;
}

/** The owner's view of a request for an action on it. Role is the control. */
async function loadForAdmin(actor: Actor, id: number) {
  if (actor.role !== "admin") {
    throw problem(403, "Only the printer owner moves a request along.");
  }
  const feature = await db.featureRequest.findUnique({
    where: { id },
    include: { requester: { select: { id: true, name: true } } },
  });
  if (!feature) throw problem(404, "That request no longer exists.");
  return feature;
}

// ---------------------------------------------------------------------------
// The requester's actions
// ---------------------------------------------------------------------------

/**
 * File a feature request. The requester comes from the session, never the
 * body. The owner is told, and it is audited — exactly as an upload is.
 */
export async function createFeature(actor: Actor, input: unknown) {
  const parsed = FeatureWishSchema.safeParse(input);
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Check the form.");
  }
  const { title, description, priority, category } = parsed.data;

  const feature = await db.featureRequest.create({
    data: {
      title,
      description,
      priority: priority as Prisma.FeatureRequestCreateInput["priority"],
      category: category as Prisma.FeatureRequestCreateInput["category"],
      status: "Requested",
      requesterId: actor.id,
    },
    select: FEATURE_FIELDS,
  });

  const owner = await printerOwner();
  if (owner && owner.id !== actor.id) {
    await notify({
      recipientId: owner.id,
      featureId: feature.id,
      text: `${actor.name} filed a request — “${title}”.`,
    });
  }

  await record({
    action: "feature.created",
    actor,
    subject: featureRef(feature.id),
    detail: { title, priority, category },
  });

  refresh(feature.id);
  return feature;
}

/**
 * The requester withdraws their own, while nobody has acted on it —
 * `Requested` or `Declined`. Mirrors withdrawing a print, minus the file:
 * there is nothing in object storage to remove. Comments and notifications
 * cascade at the database.
 */
export async function withdrawFeature(actor: Actor, id: number) {
  const feature = await db.featureRequest.findFirst({
    where: { AND: [{ id }, featureScope(actor)] },
    select: { id: true, title: true, status: true, requesterId: true },
  });
  if (!feature) throw problem(404, "That request no longer exists.");

  if (feature.requesterId !== actor.id) {
    throw problem(403, "Only the person who asked for it can withdraw it.");
  }

  if (feature.status !== "Requested" && feature.status !== "Declined") {
    throw problem(
      409,
      `${featureRef(feature.id)} is already ${featureLabel(feature.status).toLowerCase()} — ` +
        `ask ${await printerName()} instead.`,
    );
  }

  const ref = featureRef(feature.id);
  const owner = await printerOwner();

  await db.featureRequest.delete({ where: { id: feature.id } });

  if (owner && feature.status === "Requested" && owner.id !== actor.id) {
    await notify({ recipientId: owner.id, text: `${actor.name} withdrew ${ref} — “${feature.title}”.` });
  }

  await record({
    action: "feature.withdrawn",
    actor,
    subject: ref,
    detail: { title: feature.title, wasStatus: feature.status },
  });

  refresh(feature.id);
  return { id: feature.id, ref, title: feature.title, wasStatus: feature.status };
}

/**
 * Change a request's priority after it has been filed. Requirements change,
 * so a "low" from last month may be "high" today, and re-filing to fix a
 * dropdown would be silly.
 *
 * Who may: the **requester** on their own request in **any** status — a
 * closed request can still be re-ranked, because hindsight and plans keep
 * changing after the fact — and the **owner** on any request, since triaging
 * by priority is their job. Anyone else — a client naming somebody else's id
 * — is refused, indistinguishably from "does not exist" via `featureScope`.
 */
export async function changeFeaturePriority(actor: Actor, id: number, rawPriority: unknown) {
  const priority = typeof rawPriority === "string" ? rawPriority : "";
  if (!(FEATURE_PRIORITIES as readonly string[]).includes(priority)) {
    throw problem(400, "That is not a priority.");
  }

  // Scoped read: a client asking after another's request is told it does not
  // exist, not that they may not touch it.
  const feature = await db.featureRequest.findFirst({
    where: { AND: [{ id }, featureScope(actor)] },
    select: { id: true, title: true, status: true, priority: true, requesterId: true },
  });
  if (!feature) throw problem(404, "That request no longer exists.");

  if (actor.role !== "admin" && feature.requesterId !== actor.id) {
    throw problem(403, "Only the person who asked for it, or the printer owner, can reprioritise it.");
  }

  if (priority === feature.priority) {
    // A no-op change writes nothing and tells nobody — pressing a select back
    // onto its current value is not an event.
    return { id: feature.id, ref: featureRef(feature.id), title: feature.title, from: feature.priority, to: priority, unchanged: true };
  }

  await db.featureRequest.update({
    where: { id: feature.id },
    data: { priority: priority as Prisma.FeatureRequestUpdateInput["priority"] },
  });

  // Tell the other side, the same direction a comment does: a requester's
  // change reaches the owner (who triages by it); the owner's reaches the
  // requester (whose ask it re-ranks).
  const owner = await printerOwner();
  const recipientId = actor.role === "admin" ? feature.requesterId : owner?.id;
  if (recipientId && recipientId !== actor.id) {
    await notify({
      recipientId,
      featureId: feature.id,
      text: `${firstName(actor.name)} set “${feature.title}” to ${priority} priority.`,
    });
  }

  await record({
    action: "feature.priority_changed",
    actor,
    subject: featureRef(feature.id),
    detail: { title: feature.title, from: feature.priority, to: priority },
  });

  refresh(feature.id);
  return { id: feature.id, ref: featureRef(feature.id), title: feature.title, from: feature.priority, to: priority, unchanged: false };
}

// ---------------------------------------------------------------------------
// The owner's actions
// ---------------------------------------------------------------------------

/** Move a request one step along the flow. Both "Accept it" and every later hop. */
export async function advanceFeature(actor: Actor, id: number) {
  const feature = await loadForAdmin(actor, id);

  const next = nextFeatureStatus(feature.status);
  if (!next) throw problem(409, `${featureLabel(feature.status)} is the end of the line.`);

  try {
    assertFeatureTransition(actor, feature.status, next);
  } catch (e) {
    asProblem(e);
  }

  await db.featureRequest.update({ where: { id: feature.id }, data: { status: next } });

  await notify({
    recipientId: feature.requesterId,
    featureId: feature.id,
    text: `${firstName(actor.name)} moved “${feature.title}” to ${featureLabel(next)}.`,
  });
  await record({
    action: "feature.status_changed",
    actor,
    subject: featureRef(feature.id),
    detail: { from: feature.status, to: next, title: feature.title },
  });

  refresh(feature.id);
  return {
    id: feature.id,
    ref: featureRef(feature.id),
    title: feature.title,
    from: feature.status,
    to: next,
    requesterName: feature.requester.name,
  };
}

/** Decline. Terminal, and only reachable from `Requested`. */
export async function declineFeature(actor: Actor, id: number) {
  const feature = await loadForAdmin(actor, id);

  try {
    assertFeatureTransition(actor, feature.status, "Declined");
  } catch (e) {
    asProblem(e);
  }

  await db.featureRequest.update({ where: { id: feature.id }, data: { status: "Declined" } });

  await notify({
    recipientId: feature.requesterId,
    featureId: feature.id,
    text: `${firstName(actor.name)} declined “${feature.title}”.`,
  });
  await record({
    action: "feature.declined",
    actor,
    subject: featureRef(feature.id),
    detail: { title: feature.title },
  });

  refresh(feature.id);
  return {
    id: feature.id,
    ref: featureRef(feature.id),
    title: feature.title,
    from: feature.status,
    to: "Declined" as FeatureStatus,
    requesterName: feature.requester.name,
  };
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export const FEATURE_COMMENT_FIELDS = {
  id: true,
  featureId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true, initials: true, role: true } },
} satisfies Prisma.FeatureCommentSelect;

export type FeatureCommentRow = Prisma.FeatureCommentGetPayload<{
  select: typeof FEATURE_COMMENT_FIELDS;
}>;

/** The thread on a request the caller can see. Oldest first. */
export async function listFeatureComments(actor: Actor, id: number): Promise<FeatureCommentRow[]> {
  await getFeature(actor, id); // scoped: refuses before any comment is read
  return db.featureComment.findMany({
    where: { featureId: id },
    select: FEATURE_COMMENT_FIELDS,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Say something on a request. Both sides may write; the notification goes to
 * the other side. Scoped through `featureScope`, so a client naming another
 * person's request is told it does not exist.
 */
export async function addFeatureComment(actor: Actor, id: number, rawBody: unknown) {
  const parsed = BodySchema.safeParse(typeof rawBody === "string" ? rawBody : "");
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Check that again.");
  }
  const body = parsed.data;

  const feature = await db.featureRequest.findFirst({
    where: { AND: [{ id }, featureScope(actor)] },
    select: { id: true, title: true, requesterId: true },
  });
  if (!feature) throw problem(404, "That request no longer exists.");

  const comment = await db.featureComment.create({
    data: { featureId: feature.id, authorId: actor.id, body },
    select: FEATURE_COMMENT_FIELDS,
  });

  const recipientId =
    actor.role === "admin" ? feature.requesterId : (await printerOwner())?.id;
  if (recipientId && recipientId !== actor.id) {
    await notify({
      recipientId,
      featureId: feature.id,
      text: `${firstName(actor.name)} commented on “${feature.title}”.`,
    });
  }

  await record({
    action: "feature.comment_added",
    actor,
    subject: featureRef(feature.id),
    detail: { title: feature.title, length: body.length },
  });

  revalidatePath(`/frr/${feature.id}`);
  return comment;
}

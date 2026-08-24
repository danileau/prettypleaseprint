import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma, StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerName, printerOwner } from "@/lib/authz";
import {
  AuthzError,
  FLOW,
  assertTransition,
  nextStatus,
  storyRef,
  storyScope,
  type Actor,
} from "@/lib/scope";
import { deleteModel } from "@/lib/storage";

/**
 * Everything that can happen to a ticket, in one place.
 *
 * This file exists because there are now two front doors onto the same
 * operations — the server-rendered forms in `src/app/actions/stories.ts` and
 * the JSON API under `src/app/api/stories` — and an authorisation rule that
 * lives in the caller is a rule that only holds for the caller that
 * remembered it. Everything below takes an `Actor` and decides for itself:
 * who may, from which state, what the uploader is told, and what goes in the
 * trail. A new front door gets all of that by construction.
 *
 * The four rules the admin actions have always had are unchanged, and are
 * enforced here rather than in the layer above:
 *
 *   1. Role is checked on every call. Not rendering a button is not
 *      authorisation, and neither is not documenting an endpoint.
 *   2. Transitions go through `assertTransition` — forwards, one step, and
 *      `Declined` only from `Requested`.
 *   3. The uploader is told. That is the whole point of the Activity panel.
 *   4. An audit row is written *after* the change commits, so the trail
 *      cannot claim something that did not happen.
 *
 * What is deliberately NOT here: `redirect`, `notFound`, and anything that
 * knows about a form or a status code. Failures leave as `StoryProblem`,
 * which carries an HTTP status the API can answer with and a sentence the
 * form can put in a toast. Translating one into the other is the caller's
 * job, because the right answer differs — see `src/lib/api.ts` for why the
 * API says 403 where a page says 404.
 */

/** A refusal with both a status code and something a person can read. */
export class StoryProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoryProblem";
  }
}

const problem = (status: number, message: string) => new StoryProblem(status, message);

/** `assertTransition` speaks `AuthzError`; the layers above speak status codes. */
function asProblem(error: unknown): never {
  if (error instanceof AuthzError) throw problem(403, error.message);
  throw error;
}

export const IdSchema = z.coerce.number().int().positive();

/**
 * Every status a ticket can be in, for parsing a `?status=` filter.
 *
 * Built from `FLOW` plus `Declined` rather than typed out, so a new step added
 * to the flow is filterable the day it lands. `Declined` is not in `FLOW` on
 * purpose — it is off the board, not along it.
 */
export const StatusSchema = z.enum([...FLOW, "Declined"] as [string, ...string[]])
  .transform((s) => s as StoryStatus);

export const ReasonSchema = z
  .string()
  .trim()
  .min(3, "Say what is wrong with it — that is the whole point of a flag.")
  .max(200, "Keep the reason short.");

export const BodySchema = z
  .string()
  .trim()
  .min(1, "Say something first.")
  .max(2000, "That is longer than a comment wants to be.");

/** Parse a path segment or form field into a story id, or refuse it. */
export function storyIdOr400(raw: unknown): number {
  const parsed = IdSchema.safeParse(raw);
  if (!parsed.success) throw problem(400, "That is not a ticket.");
  return parsed.data;
}

function refresh(id: number) {
  revalidatePath("/queue");
  revalidatePath("/board");
  revalidatePath("/me");
  revalidatePath(`/story/${id}`);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The columns every representation of a story is built from.
 *
 * Written out rather than selecting the whole row, and that is the security
 * control: `storageKey` is the name of an object in the bucket and it is not
 * on this list, so no caller can leak it by forgetting to strip it. Same for
 * the uploader's e-mail address — the board shows a name and initials, and so
 * does the API.
 */
export const STORY_FIELDS = {
  id: true,
  title: true,
  status: true,
  flagged: true,
  flagReason: true,
  quantity: true,
  material: true,
  colorName: true,
  colorHex: true,
  tip: true,
  note: true,
  filename: true,
  fileSize: true,
  mimeType: true,
  dims: true,
  createdAt: true,
  updatedAt: true,
  uploaderId: true,
  uploader: { select: { id: true, name: true, initials: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.StorySelect;

export type StoryRow = Prisma.StoryGetPayload<{ select: typeof STORY_FIELDS }>;

export type StoryQuery = {
  status?: StoryStatus[];
  flagged?: boolean;
  mine?: boolean;
  limit?: number;
  /** Id of the last story on the previous page. Ids descend, so this is `id <`. */
  before?: number;
};

export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;

/**
 * List the stories this actor may see, newest first.
 *
 * `storyScope` is the first term of the AND, so a client cannot widen the set
 * with any combination of the filters — the worst a hostile query does is
 * narrow its own results.
 *
 * Paging is a cursor on the id rather than an offset. Ids are autoincrement,
 * so id-descending is creation-descending, and a cursor cannot skip or repeat
 * a row when something is inserted mid-page the way `skip`/`take` can.
 */
export async function listStories(actor: Actor, query: StoryQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);

  const where: Prisma.StoryWhereInput = {
    AND: [
      storyScope(actor),
      ...(query.mine ? [{ uploaderId: actor.id }] : []),
      ...(query.status?.length ? [{ status: { in: query.status } }] : []),
      ...(query.flagged === undefined ? [] : [{ flagged: query.flagged }]),
      ...(query.before === undefined ? [] : [{ id: { lt: query.before } }]),
    ],
  };

  // One more than asked for, so "is there another page" is answered by the
  // query rather than by a second count that could disagree with it.
  const rows = await db.story.findMany({
    where,
    select: STORY_FIELDS,
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const stories = rows.slice(0, limit);
  return {
    stories,
    nextCursor: rows.length > limit ? (stories[stories.length - 1]?.id ?? null) : null,
  };
}

/**
 * One story, under the caller's scope.
 *
 * Returns null rather than throwing so the caller decides what "not visible"
 * looks like. Both callers make it indistinguishable from "does not exist",
 * which is the point: a 403 here would confirm the ticket is real.
 */
export function findStory(actor: Actor, id: number): Promise<StoryRow | null> {
  return db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: STORY_FIELDS,
  });
}

/** As `findStory`, but refuses instead of returning null. */
export async function getStory(actor: Actor, id: number): Promise<StoryRow> {
  const story = await findStory(actor, id);
  if (!story) throw problem(404, "That ticket no longer exists.");
  return story;
}

/**
 * The admin's view of a ticket for an action on it.
 *
 * Unscoped on purpose — `storyScope` is `{}` for an admin anyway, and going
 * through it here would suggest the scope is doing work it is not. The role
 * check is the control, and it is the first line.
 */
async function loadForAdmin(actor: Actor, id: number) {
  if (actor.role !== "admin") {
    throw problem(403, "Only the printer owner moves a story along.");
  }
  const story = await db.story.findUnique({
    where: { id },
    include: { uploader: { select: { id: true, name: true } } },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");
  return story;
}

// ---------------------------------------------------------------------------
// The printer owner's actions
// ---------------------------------------------------------------------------

/**
 * Move a ticket one step along the flow. This is both "Accept it" — which is
 * simply `Requested → Accepted` — and every later hop; the button label
 * differs, the operation does not.
 */
export async function advanceStory(actor: Actor, id: number) {
  const story = await loadForAdmin(actor, id);

  const next = nextStatus(story.status);
  if (!next) throw problem(409, `${story.status} is the end of the line.`);

  try {
    assertTransition(actor, story.status, next);
  } catch (e) {
    asProblem(e);
  }

  await db.story.update({ where: { id: story.id }, data: { status: next } });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} moved “${story.title}” to ${next}.`,
  });
  await record({
    action: "story.status_changed",
    actor,
    subject: storyRef(story.id),
    detail: { from: story.status, to: next, title: story.title },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    from: story.status,
    to: next,
    uploaderName: story.uploader.name,
  };
}

/**
 * Decline. Terminal, and only reachable from `Requested` — once the printer
 * owner has said yes, saying no is a conversation, not a state change.
 */
export async function declineStory(actor: Actor, id: number) {
  const story = await loadForAdmin(actor, id);

  try {
    assertTransition(actor, story.status, "Declined");
  } catch (e) {
    asProblem(e);
  }

  await db.story.update({ where: { id: story.id }, data: { status: "Declined" } });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} declined “${story.title}”.`,
  });
  await record({
    action: "story.declined",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    from: story.status,
    to: "Declined" as StoryStatus,
    uploaderName: story.uploader.name,
  };
}

/**
 * Flag a model problem.
 *
 * Deliberately does NOT change the status: a flagged ticket is still wherever
 * it was, it just has a note on it saying why it cannot proceed as-is. The
 * reason is required, because "flagged" with no explanation tells the person
 * waiting nothing they can act on.
 */
export async function flagStory(actor: Actor, id: number, rawReason: unknown) {
  const story = await loadForAdmin(actor, id);

  const parsed = ReasonSchema.safeParse(typeof rawReason === "string" ? rawReason : "");
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Give a reason.");
  }
  const reason = parsed.data;

  await db.story.update({
    where: { id: story.id },
    data: { flagged: true, flagReason: reason },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} flagged “${story.title}”: ${reason}`,
  });
  await record({
    action: "story.flagged",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, reason },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    reason,
    uploaderName: story.uploader.name,
  };
}

/**
 * Clear a flag once it has been dealt with.
 *
 * Not in the handoff, but a flag with no way off is a dead end: the ticket
 * would carry "needs a look" for the rest of its life even after the model
 * was fixed. The uploader is told, because they are the one who fixed it.
 */
export async function clearFlag(actor: Actor, id: number) {
  const story = await loadForAdmin(actor, id);
  if (!story.flagged) throw problem(409, "That ticket is not flagged.");

  await db.story.update({
    where: { id: story.id },
    data: { flagged: false, flagReason: null },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} cleared the flag on “${story.title}”.`,
  });
  await record({
    action: "story.flag_cleared",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    uploaderName: story.uploader.name,
  };
}

// ---------------------------------------------------------------------------
// The requester's action
// ---------------------------------------------------------------------------

/**
 * The person who asked for a print withdraws it.
 *
 * **Only while nobody has acted on it.** `Requested` means it is still sitting
 * in the queue untouched; `Declined` means it is already dead. Past that the
 * printer owner has committed time, filament and bed space, and a ticket
 * vanishing from under them — along with the conversation and the audit
 * trail's subject — is not the requester's call to make. They can ask.
 *
 * The stored file goes with it. Leaving 50 MB of geometry in object storage
 * for a request nobody can see any more is a slow leak and, for somebody who
 * withdrew a model on purpose, arguably not what they asked for. Comments and
 * notifications cascade at the database.
 */
export async function withdrawStory(actor: Actor, id: number) {
  // Scoped read: a client asking after somebody else's story gets the same
  // answer as one asking after a story that does not exist.
  const story = await db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: {
      id: true, title: true, status: true, storageKey: true,
      uploaderId: true, uploader: { select: { name: true } },
    },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");

  // An admin can see every story; being able to see one is not being allowed
  // to withdraw it. Only the person who asked for it may take it back.
  if (story.uploaderId !== actor.id) {
    throw problem(403, "Only the person who asked for it can withdraw it.");
  }

  if (story.status !== "Requested" && story.status !== "Declined") {
    throw problem(
      409,
      `${storyRef(story.id)} is already ${story.status.toLowerCase()} — ` +
        `ask ${await printerName()} instead.`,
    );
  }

  const ref = storyRef(story.id);
  const owner = await printerOwner();

  await db.story.delete({ where: { id: story.id } });

  // After the row is gone, so a failure here cannot leave a story pointing at
  // an object that is not there. The reverse would be worse: an orphaned
  // object is invisible, a story with no file is broken in the viewer.
  try {
    await deleteModel(story.storageKey);
  } catch (error) {
    console.error(`[withdraw] ${ref}: object ${story.storageKey} not removed`, error);
  }

  // Only worth telling the printer owner if it was still waiting on them.
  if (owner && story.status === "Requested" && owner.id !== actor.id) {
    await notify({
      recipientId: owner.id,
      text: `${actor.name} withdrew ${ref} — “${story.title}”.`,
    });
  }

  await record({
    action: "story.withdrawn",
    actor,
    subject: ref,
    detail: { title: story.title, wasStatus: story.status },
  });

  refresh(story.id);
  return { id: story.id, ref, title: story.title, wasStatus: story.status };
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export const COMMENT_FIELDS = {
  id: true,
  storyId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true, initials: true, role: true } },
} satisfies Prisma.CommentSelect;

export type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_FIELDS }>;

/** The thread on a ticket the caller can see. Oldest first, as the page reads it. */
export async function listComments(actor: Actor, id: number): Promise<CommentRow[]> {
  await getStory(actor, id); // scoped: refuses before any comment is read
  return db.comment.findMany({
    where: { storyId: id },
    select: COMMENT_FIELDS,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Say something on a ticket.
 *
 * Both sides may write here — it is the one place in the app where the client
 * has something to do besides upload and wait. Which is exactly why the
 * visibility check matters: the story is loaded through `storyScope`, so a
 * client naming another person's story id finds nothing and is told the
 * ticket does not exist. Not "you may not", which would confirm it does.
 *
 * The notification goes to the *other* side. Nobody needs telling about
 * their own comment, and a feed full of your own words is a feed people
 * stop reading.
 */
export async function addComment(actor: Actor, id: number, rawBody: unknown) {
  const parsed = BodySchema.safeParse(typeof rawBody === "string" ? rawBody : "");
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Check that again.");
  }
  const body = parsed.data;

  const story = await db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: { id: true, title: true, uploaderId: true },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");

  const comment = await db.comment.create({
    data: { storyId: story.id, authorId: actor.id, body },
    select: COMMENT_FIELDS,
  });

  // Whoever is not the author. An admin writing tells the uploader; a client
  // writing tells the printer owner.
  const recipientId =
    actor.role === "admin" ? story.uploaderId : (await printerOwner())?.id;

  if (recipientId && recipientId !== actor.id) {
    await notify({
      recipientId,
      storyId: story.id,
      text: `${firstName(actor.name)} commented on “${story.title}”.`,
    });
  }

  await record({
    action: "comment.added",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, length: body.length },
  });

  revalidatePath(`/story/${story.id}`);
  return comment;
}

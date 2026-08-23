"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import {
  AuthzError,
  assertTransition,
  nextStatus,
  notify,
  requireAdmin,
  storyRef,
} from "@/lib/authz";

/**
 * Everything the printer owner can do to a ticket.
 *
 * Four rules hold for all of them, and they are why these live in one file:
 *
 *   1. `requireAdmin()` first, every time. Rendering a button is not
 *      authorisation — a client posting this form directly must be refused
 *      here, not in the markup that did not draw it.
 *   2. The transition is checked by `assertTransition`, which is the same
 *      guard the tests exercise directly. Status can only move forward, one
 *      step, along the flow — and `Declined` only from `Requested`.
 *   3. Every one of them notifies the uploader. The handoff is explicit that
 *      the person waiting finds out, and it is the whole point of the
 *      Activity panel.
 *   4. Every one of them writes an audit event, after the change commits.
 */

const IdSchema = z.coerce.number().int().positive();

/**
 * Where to send the browser afterwards, with a message.
 *
 * These are plain forms, so there is no client state to hand a result back
 * to — the outcome travels in the query string and the page renders it as a
 * toast. That also means the whole panel works with JavaScript off.
 *
 * `from` arrives in the form body, so it is validated like any other
 * redirect target: same-origin absolute paths only. An open redirect is how
 * a phishing page borrows your domain's credibility.
 */
function back(from: FormDataEntryValue | null, params: Record<string, string>): never {
  const raw = typeof from === "string" ? from : "";
  const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw.split("?")[0]! : "/queue";
  const q = new URLSearchParams(params).toString();
  redirect(`${safe}?${q}`);
}

/** Loads a story for an admin action, or explains why it cannot proceed. */
async function loadForAction(formData: FormData) {
  const parsed = IdSchema.safeParse(formData.get("id"));
  if (!parsed.success) back(formData.get("from"), { error: "That is not a ticket." });

  const story = await db.story.findUnique({
    where: { id: parsed.data },
    include: { uploader: { select: { id: true, name: true } } },
  });
  if (!story) back(formData.get("from"), { error: "That ticket no longer exists." });
  return story;
}

function refresh(id: number) {
  revalidatePath("/queue");
  revalidatePath("/board");
  revalidatePath(`/story/${id}`);
}

/**
 * Move a ticket one step along the flow. This is both "Accept it" — which is
 * simply `Requested → Accepted` — and every later hop; the button label
 * differs, the operation does not.
 */
export async function advanceStory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const story = await loadForAction(formData);

  const next = nextStatus(story.status);
  if (!next) back(formData.get("from"), { error: `${story.status} is the end of the line.` });

  try {
    assertTransition(admin, story.status, next);
  } catch (e) {
    if (e instanceof AuthzError) back(formData.get("from"), { error: e.message });
    throw e;
  }

  await db.story.update({ where: { id: story.id }, data: { status: next } });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${admin.name.split(" ")[0]} moved “${story.title}” to ${next}.`,
  });
  await record({
    action: "story.status_changed",
    actor: admin,
    subject: storyRef(story.id),
    detail: { from: story.status, to: next, title: story.title },
  });

  refresh(story.id);
  back(formData.get("from"), {
    toast: `“${story.title}” → ${next} · ${story.uploader.name} notified`,
  });
}

/**
 * Decline. Terminal, and only reachable from `Requested` — once the printer
 * owner has said yes, saying no is a conversation, not a state change.
 */
export async function declineStory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const story = await loadForAction(formData);

  try {
    assertTransition(admin, story.status, "Declined");
  } catch (e) {
    if (e instanceof AuthzError) back(formData.get("from"), { error: e.message });
    throw e;
  }

  await db.story.update({ where: { id: story.id }, data: { status: "Declined" } });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${admin.name.split(" ")[0]} declined “${story.title}”.`,
  });
  await record({
    action: "story.declined",
    actor: admin,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  back(formData.get("from"), { toast: `Declined · ${story.uploader.name} notified` });
}

const ReasonSchema = z
  .string()
  .trim()
  .min(3, "Say what is wrong with it — that is the whole point of a flag.")
  .max(200, "Keep the reason short.");

/**
 * Flag a model problem.
 *
 * Deliberately does NOT change the status: a flagged ticket is still wherever
 * it was, it just has a note on it saying why it cannot proceed as-is. The
 * reason is required, because "flagged" with no explanation tells the person
 * waiting nothing they can act on.
 */
export async function flagStory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const story = await loadForAction(formData);

  const reason = ReasonSchema.safeParse(formData.get("reason") ?? "");
  if (!reason.success) {
    back(formData.get("from"), {
      error: reason.error.issues[0]?.message ?? "Give a reason.",
    });
  }

  await db.story.update({
    where: { id: story.id },
    data: { flagged: true, flagReason: reason.data },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${admin.name.split(" ")[0]} flagged “${story.title}”: ${reason.data}`,
  });
  await record({
    action: "story.flagged",
    actor: admin,
    subject: storyRef(story.id),
    detail: { title: story.title, reason: reason.data },
  });

  refresh(story.id);
  back(formData.get("from"), { toast: `Flagged · ${story.uploader.name} notified` });
}

/**
 * Clear a flag once it has been dealt with.
 *
 * Not in the handoff, but a flag with no way off is a dead end: the ticket
 * would carry "needs a look" for the rest of its life even after the model
 * was fixed. The uploader is told, because they are the one who fixed it.
 */
export async function clearFlag(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const story = await loadForAction(formData);

  if (!story.flagged) back(formData.get("from"), { error: "That ticket is not flagged." });

  await db.story.update({
    where: { id: story.id },
    data: { flagged: false, flagReason: null },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${admin.name.split(" ")[0]} cleared the flag on “${story.title}”.`,
  });
  await record({
    action: "story.flag_cleared",
    actor: admin,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  back(formData.get("from"), { toast: `Flag cleared · ${story.uploader.name} notified` });
}

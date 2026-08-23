import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { storyScope, type Actor } from "@/lib/scope";

// The pure rules live in `scope.ts` so they can be imported without pulling in
// `server-only`. Re-exported here so callers have one import to reach for.
export {
  storyScope,
  storyRef,
  FLOW,
  BOARD,
  isTerminal,
  nextStatus,
  assertTransition,
  AuthzError,
  type Actor,
} from "@/lib/scope";

/**
 * The signed-in user, or null. Never throws.
 *
 * Suspension is checked here as well as at sign-in, and the redundancy is the
 * point. The admin plugin refuses to *create* a session for a suspended
 * account, which stops them getting back in but does nothing about the
 * session they already hold — that one keeps working until it expires.
 * Revoking access deletes those sessions, and this is the belt to that
 * braces: a session that somehow survives still resolves to nobody.
 */
export async function currentUser(): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const u = session.user as typeof session.user & {
    initials?: string | null;
    role?: string | null;
    banned?: boolean | null;
  };

  if (u.banned) return null;

  return {
    id: u.id,
    name: u.name,
    email: u.email,
    initials: u.initials ?? "??",
    role: u.role === "admin" ? "admin" : "client",
  };
}

/**
 * Gate for any page or action that needs an account. Sends people to sign-in
 * with a return path so the invite/e-mail round trip lands where they meant
 * to go.
 */
export async function requireUser(returnTo?: string): Promise<Actor> {
  const user = await currentUser();
  if (user) return user;

  const target = returnTo
    ? `/signin?next=${encodeURIComponent(returnTo)}`
    : "/signin";
  redirect(target);
}

/**
 * Gate for admin-only surfaces (the queue, invite management).
 *
 * Answers 404 rather than 403 on purpose: a client poking at /admin/invites
 * learns nothing about whether that route exists.
 */
export async function requireAdmin(): Promise<Actor> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}

/**
 * Fetch one story under the caller's scope. A client asking for somebody
 * else's story gets a 404, not a 403 — a 403 would confirm the story exists.
 */
export async function getStoryOr404(storyId: number, actor: Actor) {
  const story = await db.story.findFirst({
    where: { AND: [{ id: storyId }, storyScope(actor)] },
    include: {
      uploader: { select: { id: true, name: true, initials: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, name: true, initials: true, role: true } },
        },
      },
    },
  });
  if (!story) notFound();
  return story;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** The admin (printer owner). Every upload notification goes here. */
export const printerOwner = cache(() =>
  db.user.findFirst({ where: { role: "admin" } }),
);

/**
 * The printer owner's first name, for copy that addresses them directly —
 * "Send it to Ruben", "what's in it for Ruben?". The handoff writes the copy
 * this way on purpose: you are asking a colleague a favour, not filing a
 * ticket against a role.
 *
 * Only ever rendered behind a session. Unauthenticated pages stay generic
 * rather than telling a stranger who runs the printer.
 */
export const printerName = cache(async (): Promise<string> => {
  const admin = await printerOwner();
  return admin?.name.trim().split(/\s+/)[0] ?? "the printer owner";
});

export async function notify(opts: {
  recipientId: string;
  storyId?: number;
  text: string;
}): Promise<void> {
  await db.notification.create({
    data: {
      recipientId: opts.recipientId,
      storyId: opts.storyId ?? null,
      text: opts.text,
    },
  });
}

/** Notifications are per recipient, and scoped the same way stories are. */
export function unreadCount(actor: Actor) {
  return db.notification.count({
    where: { recipientId: actor.id, read: false },
  });
}

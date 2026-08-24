import "server-only";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import type { Actor } from "@/lib/scope";

/**
 * The Activity feed.
 *
 * Notifications are per recipient, and every read and every write below is
 * scoped by `recipientId` — so a caller naming somebody else's notification id
 * changes nothing rather than erroring, which is both the quieter and the
 * safer failure. There is no id in this file that is trusted on its own.
 *
 * Shared by the header menu's server actions and by `/api/notifications`, so
 * the scoping rule has one home.
 */

export const NOTIFICATION_FIELDS = {
  id: true,
  storyId: true,
  text: true,
  read: true,
  createdAt: true,
} as const;

export const NOTIFICATION_LIMIT_MAX = 100;

export async function listNotifications(
  actor: Actor,
  opts: { unreadOnly?: boolean; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), NOTIFICATION_LIMIT_MAX);
  const [items, unread] = await Promise.all([
    db.notification.findMany({
      where: { recipientId: actor.id, ...(opts.unreadOnly ? { read: false } : {}) },
      select: NOTIFICATION_FIELDS,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.notification.count({ where: { recipientId: actor.id, read: false } }),
  ]);
  return { items, unread };
}

/**
 * Mark one notification read, or all of them.
 *
 * `updateMany` rather than `update` on purpose: with `recipientId` in the
 * where clause it matches nothing for somebody else's id, where `update`
 * would throw and thereby confirm the row exists.
 */
export async function markNotificationsRead(
  actor: Actor,
  id?: string,
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: { recipientId: actor.id, read: false, ...(id ? { id } : {}) },
    data: { read: true },
  });
  revalidatePath("/", "layout");
  return count;
}

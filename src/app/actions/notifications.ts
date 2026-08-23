"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/authz";

/**
 * Notifications are per recipient. Both actions scope every write by
 * `recipientId`, so a caller can only ever touch their own — passing someone
 * else's notification id changes nothing rather than erroring, which is the
 * quieter and safer failure.
 */

export async function markAllRead(): Promise<void> {
  const user = await requireUser();
  await db.notification.updateMany({
    where: { recipientId: user.id, read: false },
    data: { read: true },
  });
  revalidatePath("/", "layout");
}

export async function markRead(id: string): Promise<void> {
  const user = await requireUser();
  await db.notification.updateMany({
    where: { id, recipientId: user.id },
    data: { read: true },
  });
  revalidatePath("/", "layout");
}

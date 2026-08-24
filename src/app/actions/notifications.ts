"use server";

import { requireUser } from "@/lib/authz";
import { markNotificationsRead } from "@/lib/notifications";

/**
 * The header menu's two controls. The scoping rule they depend on — a caller
 * can only ever touch their own — lives in `src/lib/notifications.ts`, which
 * `/api/notifications/read` calls too.
 */

export async function markAllRead(): Promise<void> {
  await markNotificationsRead(await requireUser());
}

export async function markRead(id: string): Promise<void> {
  await markNotificationsRead(await requireUser(), id);
}

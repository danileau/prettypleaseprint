"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
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

/**
 * Switch your own notification emails on or off.
 *
 * Yours only: the id comes from the session, never from the form, so there is
 * no value a caller could post to change somebody else's.
 */
export async function setNotifyByEmail(formData: FormData): Promise<void> {
  const user = await requireUser("/me");
  const on = formData.get("notifyByEmail") === "on";
  await db.user.update({ where: { id: user.id }, data: { notifyByEmail: on } });
  await record({
    action: "user.mail_preference_changed",
    actor: user,
    subject: user.email,
    detail: { notifyByEmail: on },
  });
  revalidatePath("/me");
  // Back to the switch itself, which now reads the other way — that is the
  // confirmation.
  redirect("/me#email");
}

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { record } from "@/lib/audit";
import {
  createInvite,
  InviteError,
  resendInvite,
  revokeInvite,
  isUniqueViolation,
} from "@/lib/invites";

export type InviteFormState = { error?: string; sent?: string };

const InviteSchema = z.object({
  email: z.email("That does not look like an email address."),
  name: z.string().trim().max(80).optional(),
});

export async function sendInviteAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  // Every action re-checks the role. Rendering the page is not authorisation.
  const admin = await requireAdmin();

  const parsed = InviteSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    const invite = await createInvite({
      email: parsed.data.email,
      name: parsed.data.name ?? null,
      invitedById: admin.id,
    });
    await record({
      action: "invite.sent",
      actor: admin,
      subject: invite.email,
      detail: { role: invite.role, expiresAt: invite.expiresAt.toISOString() },
    });
    revalidatePath("/admin/invites");
    return { sent: invite.email };
  } catch (e) {
    if (e instanceof InviteError) return { error: e.message };
    if (isUniqueViolation(e)) {
      return { error: "That address already has an invite waiting." };
    }
    console.error("invite failed", e);
    return {
      error:
        "The invite could not be sent. Check the mail transport and try again.",
    };
  }
}

export async function resendInviteAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  try {
    const invite = await resendInvite(id);
    await record({ action: "invite.resent", actor: admin, subject: invite.email });
  } catch (e) {
    if (!(e instanceof InviteError)) throw e;
  }
  revalidatePath("/admin/invites");
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const invite = await db.invite.findUnique({ where: { id }, select: { email: true } });
  await revokeInvite(id);
  if (invite) {
    await record({ action: "invite.revoked", actor: admin, subject: invite.email });
  }
  revalidatePath("/admin/invites");
}

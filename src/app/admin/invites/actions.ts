"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { headers } from "next/headers";

import { db } from "@/lib/db";
import { issueSignInUrl } from "@/lib/auth";
import { requireAdmin } from "@/lib/authz";
import { record } from "@/lib/audit";
import {
  createInvite,
  InviteError,
  resendInvite,
  revokeInvite,
  isUniqueViolation,
} from "@/lib/invites";

export type InviteFormState = {
  error?: string;
  /** The address that was invited. */
  sent?: string;
  /**
   * Present only when there was nowhere to mail the link, so the admin has to
   * hand it over. Deliberately not returned when mail worked — see
   * CreatedInvite in src/lib/invites.ts.
   */
  handoverUrl?: string;
};

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
    const { invite, handoverUrl } = await createInvite({
      email: parsed.data.email,
      name: parsed.data.name ?? null,
      invitedById: admin.id,
    });
    await record({
      action: "invite.sent",
      actor: admin,
      subject: invite.email,
      detail: {
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        delivery: handoverUrl ? "handover" : "email",
      },
    });
    revalidatePath("/admin/invites");
    return { sent: invite.email, handoverUrl };
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
    const { invite } = await resendInvite(id);
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

/**
 * Give an existing member a fresh way in.
 *
 * The answer to "I wiped my phone and the passkey went with it", and to
 * "the mail server is down and nobody can sign in". Mints a single-use
 * ten-minute sign-in link and hands it to the admin rather than mailing it,
 * because the case this exists for is precisely the one where mail is not an
 * option.
 *
 * This is impersonation-shaped: whoever holds the link is signed in as that
 * person. It grants the printer owner nothing they did not already have —
 * they own the machine and the database — but it is recorded loudly, because
 * an audited action beats a quiet UPDATE.
 */
export async function reissueAccessAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");

  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
  if (!target) return { error: "No such member." };

  let url: string;
  try {
    url = await issueSignInUrl(target.email, await headers(), "/");
  } catch (error) {
    console.error("reissue failed", error);
    return { error: "That link could not be created. Try again." };
  }

  await record({
    action: "access.reissued",
    actor: admin,
    subject: target.email,
    detail: { forName: target.name, validMinutes: 10, singleUse: true },
  });

  revalidatePath("/admin/invites");
  return { sent: target.email, handoverUrl: url };
}

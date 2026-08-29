"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { requireFreshAuth } from "@/lib/reauth";
import { record } from "@/lib/audit";
import { passwordResetEmail, sendMail } from "@/lib/email";
import {
  createInvite,
  InviteError,
  resendInvite,
  revokeInvite,
  isUniqueViolation,
} from "@/lib/invites";
import {
  RESET_TTL_MINUTES,
  issuePasswordSetupUrl,
  revokePasswordSetupLinks,
} from "@/lib/password-reset";

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
  // An invitation mints a whole new account, which outlives any stolen
  // session. Prove it is you.
  await requireFreshAuth("/admin/invites");

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
  // Re-sending rotates the token, so it hands out a working link exactly the
  // way the first one did.
  await requireFreshAuth("/admin/invites");
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
 * Reset a member's password.
 *
 * The answer to "I have forgotten it", and to "I wiped the phone my passkey
 * lived on". Mints a single-use link that lets them choose a new password —
 * it does not sign anybody in, which is the meaningful difference from the
 * sign-in link this replaces. Whoever holds that link can set a password and
 * then has to use it; the old one stops working the moment they do.
 *
 * Mailed when there is a transport, handed to the admin when there is not,
 * which is the same split invitations use and the reason the app needs no
 * mail server at all.
 */
export async function resetPasswordAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const admin = await requireAdmin();
  // A reset link is the ability to become somebody else. This is the single
  // most valuable thing a captured admin session could be pointed at.
  await requireFreshAuth("/admin/invites");
  const userId = String(formData.get("userId") ?? "");

  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
  if (!target) return { error: "No such member." };

  let url: string;
  try {
    // Any earlier link goes first: "reset it again" should leave exactly one
    // live link, and the older one is the likelier to have gone astray.
    await revokePasswordSetupLinks(target.id);
    url = await issuePasswordSetupUrl(target.id);
  } catch (error) {
    console.error("password reset failed", error);
    return { error: "That link could not be created. Try again." };
  }

  // A transport that refuses is treated as no transport: the link already
  // exists, and showing it to the admin beats losing it to a bounced send.
  let delivered = false;
  try {
    delivered = await sendMail(
      passwordResetEmail({
        to: target.email,
        url,
        expiresInMinutes: RESET_TTL_MINUTES,
      }),
    );
  } catch (error) {
    console.error("reset mail failed; handing the link over instead", error);
  }

  await record({
    action: "password.reset_requested",
    actor: admin,
    subject: target.email,
    detail: {
      forName: target.name,
      validMinutes: RESET_TTL_MINUTES,
      delivery: delivered ? "email" : "handover",
    },
  });

  revalidatePath("/admin/invites");
  // Same rule as invitations: when the link was delivered it stays inside the
  // message, so not even the admin who triggered it can replay it.
  return delivered ? { sent: target.email } : { sent: target.email, handoverUrl: url };
}

/**
 * Revoke, or restore, a member's access.
 *
 * Suspension rather than deletion, deliberately. `Story.uploaderId` cascades,
 * so removing the row would take their whole print history with it — tickets
 * you finished, conversations you had, and the audit trail's actor links.
 * Somebody leaving the office is not a reason to lose the record of what was
 * printed for them.
 *
 * Two things have to happen together or the control is theatre. The admin
 * plugin refuses to create a session for a suspended account, which shuts the
 * door; it does nothing about the session they are already holding, which
 * would keep working until it expired. So the sessions go too, and
 * `currentUser()` refuses a suspended account besides.
 */
export async function setMemberAccessAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const admin = await requireAdmin();
  // Both directions: revoking locks a colleague out, restoring lets somebody
  // back in who was deliberately shut out.
  await requireFreshAuth("/admin/invites");
  const userId = String(formData.get("userId") ?? "");
  const revoke = String(formData.get("revoke") ?? "") === "true";

  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, banned: true },
  });
  if (!target) return { error: "No such member." };

  // The printer owner is the only way back into the admin surface. Suspending
  // them locks the app permanently, so the guard is here rather than only in
  // the UI, which renders no control for them anyway.
  if (target.role === "admin") {
    return { error: "The printer owner cannot be suspended — that would lock the app." };
  }

  await db.user.update({
    where: { id: target.id },
    data: revoke
      ? { banned: true, banReason: `Access revoked by ${admin.name}`, banExpires: null }
      : { banned: false, banReason: null, banExpires: null },
  });

  if (revoke) {
    // Shut the door they are already through, not only the one they would
    // come back to.
    await db.session.deleteMany({ where: { userId: target.id } });
  }

  await record({
    action: revoke ? "access.revoked" : "access.restored",
    actor: admin,
    subject: target.email,
    detail: { forName: target.name },
  });

  revalidatePath("/admin/invites");
  return { sent: target.email };
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/lib/db";
import { issueSignInUrl } from "@/lib/auth";
import { checkInviteToken } from "@/lib/invites";

const ClaimSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "Tell us what to call you.").max(80),
});

export type ClaimState = { error?: string };

/**
 * Turn a valid invite into an account.
 *
 * The token is re-checked here rather than trusted from the page render: the
 * page may have been sitting open while the invite was revoked or claimed
 * elsewhere.
 */
export async function acceptInvite(
  _prev: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const parsed = ClaimSchema.safeParse({
    token: formData.get("token"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const check = await checkInviteToken(parsed.data.token);
  if (!check.ok) {
    // Bounce to the same page, which renders the reason properly.
    redirect(`/invite/${encodeURIComponent(parsed.data.token)}`);
  }

  // The name the invitee chose wins over the one the admin guessed. It is read
  // back out of the invite by the `user.create.before` hook in src/lib/auth.ts.
  await db.invite.update({
    where: { id: check.invite.id },
    data: { name: parsed.data.name },
  });

  const url = await issueSignInUrl(
    check.invite.email,
    await headers(),
    "/welcome",
  );

  // Redeeming the link is what actually creates the user and the session —
  // it runs the same validation any magic link would.
  redirect(url);
}

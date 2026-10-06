"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { checkInviteToken, claimingInvite } from "@/lib/invites";

const ClaimSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "Tell us what to call you.").max(80),
});

/** `field` puts the message against the input it belongs to. */
export type ClaimState = {
  error?: string;
  field?: "name";
  /** What was typed, so a refused name is there to correct, not to retype. */
  name?: string;
};

/**
 * Is this name already somebody's?
 *
 * A name is how a member is known on every ticket, and with no username or
 * password it is the only thing that tells two people apart — so it is
 * unique, ignoring case and surrounding space. A second device for the same
 * person does not come through here: it comes through a device link from the
 * printer owner, which signs it in to the account that already has the name.
 *
 * Not exported: everything exported from a "use server" file is a server
 * action anybody can call, and this would be a free oracle for who is here.
 */
async function nameIsTaken(name: string): Promise<boolean> {
  const taken = await db.user.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" } },
    select: { id: true },
  });
  return Boolean(taken);
}

/**
 * Turn a valid invite into an account, signed in on this device.
 *
 * The token is re-checked here rather than trusted from the page render: the
 * page may have been sitting open while the invite was revoked or claimed
 * elsewhere.
 *
 * Registration goes through Better Auth's own `createUser` (by way of the
 * server-only `registerMemberDevice`) rather than a direct insert, which is
 * what keeps the two server-side rules attached to it — the
 * `user.validateUserInfo` invite gate, and the `user.create.before` hook that
 * stamps `role`, `initials` and `invitedById` from the invite row.
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
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Check the form.", field: "name" };
  }

  const check = await checkInviteToken(parsed.data.token);
  if (!check.ok) {
    // Bounce to the same page, which renders the reason properly.
    redirect(`/invite/${encodeURIComponent(parsed.data.token)}`);
  }

  // Device sign-in is for members. An invitation for any other role would be
  // a passwordless way into it, so it is refused rather than downgraded.
  if (check.invite.role !== "client") {
    return { error: "This invitation cannot be accepted here. Ask the printer owner." };
  }

  if (await nameIsTaken(parsed.data.name)) {
    return {
      error:
        "Somebody already goes by that name. If it is you on another device, ask the printer owner for a link for this one.",
      field: "name",
      name: parsed.data.name,
    };
  }

  // The name the invitee chose wins over the one the admin guessed. It is read
  // back out of the invite by the `user.create.before` hook in src/lib/auth.ts.
  await db.invite.update({
    where: { id: check.invite.id },
    data: { name: parsed.data.name },
  });

  try {
    // Inside `claimingInvite`, because the token was checked a few lines up
    // and that — not the address — is what the gate in src/lib/auth.ts admits.
    const requestHeaders = await headers();
    await claimingInvite(check.invite, () =>
      auth.api.registerMemberDevice({
        body: { email: check.invite.email, name: parsed.data.name },
        headers: requestHeaders,
      }),
    );
  } catch (error) {
    const e = error as { body?: { code?: string; message?: string }; message?: string };
    if (e.body?.code === "invite_required") {
      // The invite went away between the check above and here.
      redirect(`/invite/${encodeURIComponent(parsed.data.token)}`);
    }
    return { error: e.body?.message || e.message || "That did not go through. Try again." };
  }

  // `nextCookies()` has copied the session cookie into the response by now, so
  // the board renders for the person who just arrived.
  redirect("/board");
}

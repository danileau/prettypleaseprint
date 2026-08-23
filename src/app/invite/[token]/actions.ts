"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from "@/lib/auth-rules";
import { checkInviteToken } from "@/lib/invites";

const ClaimSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "Tell us what to call you.").max(80),
  // Passed on as typed. The username plugin folds it to lower case for
  // `username` and keeps the original in `displayUsername`, so the person
  // sees back what they wrote and still signs in either way.
  username: z
    .string()
    .trim()
    .min(USERNAME_MIN, `A username needs at least ${USERNAME_MIN} characters.`)
    .max(USERNAME_MAX, `A username can be at most ${USERNAME_MAX} characters.`)
    .regex(USERNAME_PATTERN, USERNAME_RULE),
  password: z
    .string()
    .min(PASSWORD_MIN, `A password needs at least ${PASSWORD_MIN} characters.`)
    .max(PASSWORD_MAX, `That password is longer than ${PASSWORD_MAX} characters.`),
});

/** `field` puts the message against the input it belongs to. */
export type ClaimState = {
  error?: string;
  field?: "name" | "username" | "password";
};

/** Better Auth's codes, in the words the person at the keyboard needs. */
function claimFailure(code: string | undefined, message: string): ClaimState {
  switch (code) {
    case "USERNAME_IS_ALREADY_TAKEN":
      return { error: "Somebody already has that username. Try another.", field: "username" };
    case "USERNAME_TOO_SHORT":
    case "USERNAME_TOO_LONG":
    case "INVALID_USERNAME":
      return { error: USERNAME_RULE, field: "username" };
    case "PASSWORD_COMPROMISED":
      return { error: message, field: "password" };
    case "PASSWORD_TOO_SHORT":
      return { error: `A password needs at least ${PASSWORD_MIN} characters.`, field: "password" };
    case "PASSWORD_TOO_LONG":
      return { error: `That password is longer than ${PASSWORD_MAX} characters.`, field: "password" };
    default:
      return { error: message || "That did not go through. Try again." };
  }
}

/**
 * Turn a valid invite into an account.
 *
 * The token is re-checked here rather than trusted from the page render: the
 * page may have been sitting open while the invite was revoked or claimed
 * elsewhere.
 *
 * Registration goes through Better Auth's own sign-up rather than a direct
 * insert, which is what keeps the two server-side rules attached to it — the
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
    username: formData.get("username"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue?.message ?? "Check the form.",
      field: issue?.path[0] as ClaimState["field"],
    };
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

  try {
    await auth.api.signUpEmail({
      body: {
        email: check.invite.email,
        name: parsed.data.name,
        username: parsed.data.username,
        password: parsed.data.password,
      },
      headers: await headers(),
    });
  } catch (error) {
    const e = error as { body?: { code?: string; message?: string }; message?: string };
    const code = e.body?.code;
    if (code === "invite_required") {
      // The invite went away between the check above and here.
      redirect(`/invite/${encodeURIComponent(parsed.data.token)}`);
    }
    return claimFailure(code, e.body?.message ?? e.message ?? "");
  }

  // `nextCookies()` has copied the session cookie into the response by now, so
  // /welcome renders for the person who just registered.
  redirect("/welcome");
}

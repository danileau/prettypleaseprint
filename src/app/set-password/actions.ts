"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from "@/lib/auth-rules";
import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/invites";
import { readResetToken, restorePasswordSetupLink } from "@/lib/password-reset";

const SetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(PASSWORD_MIN, `A password needs at least ${PASSWORD_MIN} characters.`)
    .max(PASSWORD_MAX, `That password is longer than ${PASSWORD_MAX} characters.`),
  /** Only asked for by an account that has none yet — the seeded admin. */
  username: z
    .string()
    .trim()
    .min(USERNAME_MIN, `A username needs at least ${USERNAME_MIN} characters.`)
    .max(USERNAME_MAX, `A username can be at most ${USERNAME_MAX} characters.`)
    .regex(USERNAME_PATTERN, USERNAME_RULE)
    .optional(),
});

export type SetPasswordState = { error?: string; field?: "username" | "password" };

const SPENT =
  "That link has already been used, or it expired. Ask the printer owner for another.";

/**
 * Redeem a set-password link.
 *
 * Better Auth's `/reset-password` does the work: it consumes the verification
 * row, refuses an expired one, enforces the length bounds, runs the breach
 * lookup, and revokes every session the old password opened. What is left for
 * us is the username an account may not have yet, the audit line, and where to
 * send the browser.
 *
 * It deliberately does not establish a session. Whoever followed the link has
 * proved they hold the link, not that they own the account — so they set a
 * password and then have to use it. That is the whole difference between this
 * and the sign-in link it replaces.
 */
export async function setPassword(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const rawUsername = formData.get("username");
  const parsed = SetPasswordSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    username: typeof rawUsername === "string" && rawUsername ? rawUsername : undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue?.message ?? "Check the form.",
      field: issue?.path[0] as SetPasswordState["field"],
    };
  }

  // Resolved before redeeming: the row is gone afterwards, and an audit line
  // that cannot name its subject is not much of an audit line.
  const resolved = await readResetToken(parsed.data.token);
  if (!resolved) return { error: SPENT };
  const { user, expiresAt } = resolved;

  // The username goes first, and on purpose. Claiming it before the password
  // means there is no moment where an account has a password and no way to
  // sign in with it; if the password is then refused, the link comes back and
  // this step is simply skipped on the retry — including when the retry posts
  // a different username, because by then the account already has one and a
  // reset link is not the place to change it.
  if (!user.username) {
    if (!parsed.data.username) {
      return { error: "Pick a username to sign in with.", field: "username" };
    }
    try {
      // Written straight through Prisma, so the folding the username plugin
      // would have done on a Better Auth path is done here instead: `username`
      // lower-cased because that is what the unique index compares, and
      // `displayUsername` as typed because that is what gets shown back.
      await db.user.update({
        where: { id: user.id },
        data: {
          username: parsed.data.username.toLowerCase(),
          displayUsername: parsed.data.username,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          error: "Somebody already has that username. Try another.",
          field: "username",
        };
      }
      throw error;
    }
  }

  try {
    await auth.api.resetPassword({
      body: { token: parsed.data.token, newPassword: parsed.data.password },
      headers: await headers(),
    });
  } catch (error) {
    const e = error as { body?: { code?: string; message?: string }; message?: string };
    const code = e.body?.code;

    if (code === "INVALID_TOKEN") return { error: SPENT };

    // Everything else happened after the token was consumed. Put it back so
    // the person can correct the password they were just told to correct.
    await restorePasswordSetupLink(parsed.data.token, user.id, expiresAt);

    switch (code) {
      case "PASSWORD_COMPROMISED":
        return { error: e.body?.message ?? "Pick a different password.", field: "password" };
      case "PASSWORD_TOO_SHORT":
        return {
          error: `A password needs at least ${PASSWORD_MIN} characters.`,
          field: "password",
        };
      case "PASSWORD_TOO_LONG":
        return {
          error: `That password is longer than ${PASSWORD_MAX} characters.`,
          field: "password",
        };
      default:
        console.error("set-password failed", error);
        return { error: "That did not go through. Try again in a moment." };
    }
  }

  await record({
    action: "password.reset_completed",
    actor: user,
    subject: user.email,
  });

  redirect("/signin?reset=1");
}

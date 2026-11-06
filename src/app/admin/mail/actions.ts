"use server";

import { redirect } from "next/navigation";

import { record } from "@/lib/audit";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { authMethods } from "@/lib/auth-methods";
import { mailConfigured, sendMail, testEmail, voiceFor } from "@/lib/email";

/**
 * Back to the page with what happened, as a code the page words. Never words
 * in the URL: a link someone else made could otherwise put any sentence they
 * liked on the owner's Mail page, under the owner's own banner. The mail
 * server's answer goes on the trail, where the page reads it back from.
 */
export type TestMailOutcome = "sent" | "none" | "refused";

function back(outcome: TestMailOutcome): never {
  redirect(`/admin/mail?test=${outcome}`);
}

/**
 * Send the owner a test message, and say plainly what happened.
 *
 * To the owner's own address and nowhere else — there is no field to type one
 * into, so this cannot be used to send mail from the instance to a stranger.
 *
 * Awaited, unlike a notification: the whole point is the answer. A failure is
 * shown with the mail server's own words, because "it did not work" is the
 * least useful thing to be told about a mail server, and the person reading it
 * is the one who configured it. Those words are recorded with the failure, and
 * the page shows them from there.
 */
export async function sendTestMailAction(): Promise<void> {
  const admin = await requireAdmin();
  if (!mailConfigured()) back("none");

  try {
    const owner = await db.user.findUnique({ where: { id: admin.id }, select: { preferredLocale: true } });
    await sendMail(
      testEmail(await voiceFor(owner?.preferredLocale), {
        to: admin.email,
        sentBy: admin.name,
        passwords: authMethods().local,
      }),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[mail] test message failed", error);
    await record({ action: "mail.test_failed", actor: admin, subject: admin.email, detail: { reason: reason.slice(0, 300) } });
    back("refused");
  }
  await record({ action: "mail.test_sent", actor: admin, subject: admin.email });
  back("sent");
}

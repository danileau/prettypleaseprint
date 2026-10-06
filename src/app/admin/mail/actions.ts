"use server";

import { redirect } from "next/navigation";

import { record } from "@/lib/audit";
import { requireAdmin } from "@/lib/authz";
import { mailConfigured, sendMail, testEmail } from "@/lib/email";

function back(params: Record<string, string>): never {
  redirect(`/admin/mail?${new URLSearchParams(params).toString()}`);
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
 * is the one who configured it.
 */
export async function sendTestMailAction(): Promise<void> {
  const admin = await requireAdmin();
  if (!mailConfigured()) back({ error: "No mail transport is configured, so there is nowhere to send it." });

  try {
    await sendMail(testEmail({ to: admin.email, sentBy: admin.name }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[mail] test message failed", error);
    await record({ action: "mail.test_failed", actor: admin, subject: admin.email, detail: { reason: reason.slice(0, 300) } });
    back({ error: `The mail server did not take it: ${reason.slice(0, 300)}` });
  }
  await record({ action: "mail.test_sent", actor: admin, subject: admin.email });
  back({ toast: `Sent to ${admin.email}. If it does not arrive, check the spam folder before the settings.` });
}

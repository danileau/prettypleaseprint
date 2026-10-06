"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { record } from "@/lib/audit";
import { consumeDeviceLink } from "@/lib/device-link";

export type DeviceState = { error?: string };

/**
 * Spend a device link and sign this browser in as the member it was for.
 *
 * A POST behind a button rather than on page load, so a chat app unfurling
 * the link — or a mail scanner following it — cannot spend it before the
 * person it was meant for gets there.
 */
export async function linkDevice(_prev: DeviceState, formData: FormData): Promise<DeviceState> {
  const token = String(formData.get("token") ?? "");
  const member = await consumeDeviceLink(token);
  if (!member) redirect(`/device/${encodeURIComponent(token)}`);

  try {
    const requestHeaders = await headers();
    // Whoever this browser was signed in as before is signed out properly,
    // rather than leaving their session row to outlive the cookie it lost.
    if (await auth.api.getSession({ headers: requestHeaders })) {
      await auth.api.signOut({ headers: requestHeaders });
    }
    await auth.api.signInMemberDevice({
      body: { userId: member.id },
      headers: requestHeaders,
    });
  } catch (error) {
    const e = error as { body?: { code?: string; message?: string }; message?: string };
    if (e.body?.code === "BANNED_USER" || e.body?.code === "banned") {
      return { error: "That account has been suspended. Ask whoever owns the printer." };
    }
    return { error: e.body?.message || "That did not go through. Ask for another link." };
  }

  await record({
    action: "device.linked",
    actor: { id: member.id, email: member.email },
    subject: member.email,
  });

  redirect("/board");
}

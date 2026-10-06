import { redirect } from "next/navigation";

import { currentUser } from "@/lib/authz";
import { readDeviceLink } from "@/lib/device-link";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { DeviceForm } from "./device-form";

export const dynamic = "force-dynamic";

/**
 * Where a device link lands.
 *
 * Reachable without a session — that is who it is for. Rendering it spends
 * nothing: the token is read here only to say whose link it is, and spent by
 * the button.
 */
export default async function DevicePage({ params }: { params: Promise<{ token: string }> }) {
  const token = decodeURIComponent((await params).token);
  const link = await readDeviceLink(token);

  if (!link || link.user.role !== "client" || link.user.banned) {
    return (
      <AuthShell>
        <Kicker>One more device</Kicker>
        <H1>That link is spent</H1>
        <Lead>
          Device links work once and expire after half an hour. Ask whoever
          owns the printer for another — it takes them a moment.
        </Lead>
      </AuthShell>
    );
  }

  // Already signed in as somebody on this browser: say so rather than quietly
  // swapping who they are.
  const signedIn = await currentUser();
  if (signedIn?.id === link.user.id) redirect("/board");
  const firstName = link.user.name.split(" ")[0] ?? link.user.name;

  return (
    <AuthShell>
      <Kicker>One more device</Kicker>
      <H1>Hello again, {firstName}</H1>
      <Lead>
        This signs this browser in as {link.user.name}, and it stays signed in.
        No password — the device is your key from here on.
      </Lead>

      {signedIn && (
        <div className="mb-[22px]">
          <Notice tone="warn">
            This browser is signed in as {signedIn.name} right now. Carrying on
            switches it to {firstName}.
          </Notice>
        </div>
      )}

      <DeviceForm token={token} firstName={firstName} />

      <div className="mt-[22px]">
        <Notice>
          Not {firstName}? Close this page — the link works once, and it is
          meant for them.
        </Notice>
      </div>
    </AuthShell>
  );
}

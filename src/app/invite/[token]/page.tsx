import Link from "next/link";
import { db } from "@/lib/db";
import { checkInviteToken, type InviteRejection } from "@/lib/invites";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { ClaimForm } from "./claim-form";

export const dynamic = "force-dynamic";

const REJECTIONS: Record<InviteRejection, { title: string; body: string }> = {
  not_found: {
    title: "That link means nothing to us",
    body: "It may have been mistyped, or the invitation was withdrawn. Ask whoever owns the printer to send a fresh one.",
  },
  expired: {
    title: "That invitation expired",
    body: "Invitations last a week. Ask for another and it will work straight away.",
  },
  revoked: {
    title: "That invitation was withdrawn",
    body: "Whoever sent it has since cancelled it. If that seems wrong, have a word with them.",
  },
  already_accepted: {
    title: "That invitation has been used",
    body: "The account already exists — sign in instead. Invitation links only work once, on purpose.",
  },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const check = await checkInviteToken(decodeURIComponent(token));

  if (!check.ok) {
    const { title, body } = REJECTIONS[check.reason];
    return (
      <AuthShell>
        <Kicker>Your table is ready</Kicker>
        <H1>{title}</H1>
        <Lead>{body}</Lead>
        <Link
          href="/signin"
          className="font-bold text-[15px] text-cherry-dk underline underline-offset-2 hover:text-cherry"
        >
          Go to sign in →
        </Link>
      </AuthShell>
    );
  }

  const inviter = await db.user.findUnique({
    where: { id: check.invite.invitedById },
    select: { name: true },
  });

  return (
    <AuthShell>
      <Kicker>Your table is ready</Kicker>
      <H1>{inviter?.name ?? "Someone"} will print things for you</H1>
      <Lead>
        Upload an <span className="font-mono">.stl</span> or{" "}
        <span className="font-mono">.3mf</span>, say what you are hoping for,
        and it lands on the backlog as a story you can follow. Pick a name to
        go by, a username and a password, and you are in.
      </Lead>

      <ClaimForm
        token={decodeURIComponent(token)}
        email={check.invite.email}
        suggestedName={check.invite.name ?? ""}
      />

      <div className="mt-[22px]">
        <Notice>
          This link registers the account — there is no second email. You are
          signed in the moment it is created, and the next screen offers a
          passkey so you can skip the password on this device.
        </Notice>
      </div>
    </AuthShell>
  );
}

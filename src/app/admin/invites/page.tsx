import Link from "next/link";
import type { Invite } from "@prisma/client";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { INVITE_TTL_DAYS } from "@/lib/invites";
import { Brand, Kicker } from "@/components/ui";
import { InviteForm } from "./invite-form";
import { resendInviteAction, revokeInviteAction } from "./actions";

export const dynamic = "force-dynamic";

type State = "Pending" | "Accepted" | "Revoked" | "Expired";

function stateOf(invite: Invite): State {
  if (invite.acceptedAt) return "Accepted";
  if (invite.revokedAt) return "Revoked";
  if (invite.expiresAt.getTime() <= Date.now()) return "Expired";
  return "Pending";
}

// Handoff status-chip tokens, reused for invite state. The chip always
// carries its own label, so colour is never the only signal.
const CHIP: Record<State, string> = {
  Pending: "bg-surface-2 text-muted-2",
  Accepted: "bg-teal-200 text-teal-700",
  Revoked: "bg-[#e2e6ea] text-muted",
  Expired: "bg-amber-fill text-amber-text",
};

function relative(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const day = 86_400_000;
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [day * 365, "year"],
    [day * 30, "month"],
    [day, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (abs >= ms) return fmt.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

export default async function InvitesPage() {
  await requireAdmin();

  const [invites, members] = await Promise.all([
    db.invite.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { invitedBy: { select: { name: true } } },
    }),
    db.user.count({ where: { role: "client" } }),
  ]);

  const open = invites.filter((i) => stateOf(i) === "Pending");

  return (
    <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
      <div className="mb-[26.4px] flex flex-wrap items-center justify-between gap-[17.6px]">
        <Link href="/" className="text-ink">
          <Brand size={30} />
        </Link>
        <Link
          href="/"
          className="text-[14px] font-semibold text-muted-2 hover:text-teal-700"
        >
          ← Back to the queue
        </Link>
      </div>

      <Kicker>Admin · who gets in</Kicker>
      <h1 className="m-0 mb-[13.2px] text-[42px] font-semibold leading-[1.05] tracking-[-0.02em]">
        The guest list
      </h1>
      <p className="m-0 mb-[26.4px] max-w-[620px] text-[17px] leading-[1.5] text-muted-3 text-pretty">
        {members} {members === 1 ? "person" : "people"} can send you models, and{" "}
        {open.length} {open.length === 1 ? "invite is" : "invites are"} still
        outstanding. Links expire after {INVITE_TTL_DAYS} days and work exactly
        once.
      </p>

      <InviteForm />

      <h2 className="mb-[13.2px] mt-[35.2px] text-[24px] font-semibold tracking-[-0.012em]">
        Everyone invited
      </h2>

      <div className="rounded-[14px] bg-card px-[22px] pb-[22px] pt-[8.8px] shadow-sm">
        {invites.length === 0 && (
          <p className="py-[17.6px] text-[13px] text-muted">
            Nobody yet. The office is very quiet.
          </p>
        )}

        {invites.map((invite) => {
          const state = stateOf(invite);
          return (
            <div
              key={invite.id}
              className="flex flex-wrap items-center gap-[17.6px] border-b border-rule py-[17.6px] last:border-b-0"
            >
              <div className="min-w-[190px] flex-[1_1_240px]">
                <div className="text-[16.5px] font-bold">{invite.email}</div>
                <div className="mt-[3px] text-[13px] text-muted">
                  {invite.name ? `${invite.name} · ` : ""}
                  invited by {invite.invitedBy.name} · {relative(invite.createdAt)}
                </div>
              </div>

              <span
                className={`rounded-full px-[12px] py-[5px] text-[12.5px] font-bold ${CHIP[state]}`}
              >
                {state}
              </span>

              <div className="w-[150px] text-[13px] text-muted">
                {state === "Pending"
                  ? `expires ${relative(invite.expiresAt)}`
                  : state === "Accepted"
                    ? `joined ${relative(invite.acceptedAt!)}`
                    : ""}
              </div>

              {state === "Pending" || state === "Expired" ? (
                <div className="flex flex-wrap gap-[8.8px]">
                  <form action={resendInviteAction}>
                    <input type="hidden" name="id" value={invite.id} />
                    <button
                      type="submit"
                      className="rounded-[8px] border border-teal px-[18px] py-[9px] text-[14px] font-bold text-teal-700 hover:bg-teal-200"
                    >
                      Send again
                    </button>
                  </form>
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="id" value={invite.id} />
                    <button
                      type="submit"
                      className="rounded-[8px] px-[15px] py-[9px] text-[14px] font-semibold text-muted-2 hover:bg-surface-2"
                    >
                      Withdraw
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}

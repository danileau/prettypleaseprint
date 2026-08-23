import Link from "next/link";
import type { Invite } from "@prisma/client";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { INVITE_TTL_DAYS } from "@/lib/invites";
import { Kicker, StatusChip } from "@/components/ui";
import { InviteForm } from "./invite-form";
import { ReissueAccess } from "@/components/reissue-access";
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
  Pending: "bg-chrome text-ink",
  Accepted: "bg-mint text-ink",
  Revoked: "bg-cream-3 text-ink-2",
  Expired: "bg-sun text-ink",
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

  const [invites, memberList] = await Promise.all([
    db.invite.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { invitedBy: { select: { name: true } } },
    }),
    db.user.findMany({
      where: { role: "client" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, initials: true },
    }),
  ]);
  const members = memberList.length;

  const open = invites.filter((i) => stateOf(i) === "Pending");

  return (
    <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
      <Kicker>Admin · who gets a table</Kicker>
      <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">
        The guest list
      </h1>
      <p className="m-0 mb-[26.4px] max-w-[620px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
        {members} {members === 1 ? "person" : "people"} can send you models, and{" "}
        {open.length} {open.length === 1 ? "invite is" : "invites are"} still
        outstanding. Links expire after {INVITE_TTL_DAYS} days and work exactly
        once.
      </p>

      <InviteForm />

      {memberList.length > 0 && (
        <>
          <h2 className="mb-[13.2px] mt-[35.2px] font-display text-[26px] text-ink">
            Who is in
          </h2>
          <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
            {memberList.map((m, i) => (
              <div
                key={m.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < memberList.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="flex h-[36px] w-[36px] flex-none items-center justify-center rounded-full border-[3px] border-ink bg-aqua font-mono text-[12px] font-bold text-ink"
                >
                  {m.initials}
                </span>
                <div className="min-w-[180px] flex-[1_1_240px]">
                  <p className="m-0 font-display text-[17px] text-ink">{m.name}</p>
                  <p className="m-0 font-mono text-[11.5px] text-ink-3">{m.email}</p>
                </div>
                <ReissueAccess userId={m.id} name={m.name.split(" ")[0] ?? m.name} />
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="mb-[13.2px] mt-[35.2px] font-display text-[26px] text-ink">
        Invitations
      </h2>

      <div className="rounded-panel border-[3px] border-ink bg-porcelain px-[22px] pb-[22px] pt-[8.8px] shadow-stamp">
        {invites.length === 0 && (
          <p className="py-[17.6px] font-mono text-[12px] uppercase text-ink-3">
            Nobody yet. The office is very quiet.
          </p>
        )}

        {invites.map((invite) => {
          const state = stateOf(invite);
          return (
            <div
              key={invite.id}
              className="flex flex-wrap items-center gap-[17.6px] border-b-2 border-dashed border-rule py-[17.6px] last:border-b-0"
            >
              <div className="min-w-[190px] flex-[1_1_240px]">
                <div className="font-mono text-[15px] font-bold text-ink">{invite.email}</div>
                <div className="mt-[3px] text-[13px] text-ink-3">
                  {invite.name ? `${invite.name} · ` : ""}
                  invited by {invite.invitedBy.name} · {relative(invite.createdAt)}
                </div>
              </div>

              <span
                className={`rounded-chip border-2 border-ink px-[11px] py-[3px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] ${CHIP[state]}`}
              >
                {state}
              </span>

              <div className="w-[150px] font-mono text-[11.5px] uppercase text-ink-3">
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
                      className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-aqua px-[15px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink hover:bg-sun"
                    >
                      Send again
                    </button>
                  </form>
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="id" value={invite.id} />
                    <button
                      type="submit"
                      className="cursor-pointer rounded-chip border-[3px] border-transparent px-[15px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink-2 hover:border-ink hover:bg-cherry-wash"
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

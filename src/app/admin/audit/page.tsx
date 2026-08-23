import Link from "next/link";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Kicker } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The audit log. Admin only.
 *
 * Deliberately a page a human reads rather than an alerting pipeline: for one
 * printer and a handful of colleagues, a screen the owner can glance at beats
 * thresholds nobody tunes and alerts everyone learns to ignore. The rows are
 * already there if that changes — recording is the part that cannot be
 * backfilled.
 */

type Lens = "all" | "access" | "uploads";

const LENSES: Array<{ key: Lens; label: string; actions?: string[] }> = [
  { key: "all", label: "Everything" },
  {
    key: "access",
    label: "Who got in",
    actions: [
      "invite.sent", "invite.resent", "invite.revoked", "invite.accepted",
      "invite.rejected", "auth.signed_in", "auth.signed_out", "user.role_changed",
    ],
  },
  {
    key: "uploads",
    label: "Models",
    actions: [
      "story.created", "upload.rejected", "story.status_changed",
      "story.declined", "story.flagged", "file.downloaded",
    ],
  },
];

/**
 * Refusals are the rows worth noticing — a run of them from one place is the
 * shape of somebody trying things. Everything else is normal traffic.
 */
const REFUSALS = new Set(["invite.rejected", "upload.rejected"]);

function tone(action: string): string {
  if (REFUSALS.has(action)) return "bg-amber-fill text-amber-text";
  if (action.startsWith("auth.")) return "bg-slate-200 text-slate-700";
  if (action.startsWith("invite.")) return "bg-teal-200 text-teal-700";
  return "bg-surface-2 text-muted-2";
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ lens?: string }>;
}) {
  const admin = await requireAdmin();
  const { lens: raw } = await searchParams;
  const lens = (LENSES.find((l) => l.key === raw)?.key ?? "all") as Lens;
  const actions = LENSES.find((l) => l.key === lens)?.actions;

  const where: Prisma.AuditEventWhereInput = actions ? { action: { in: actions } } : {};

  const [events, refusalsToday] = await Promise.all([
    db.auditEvent.findMany({ where, orderBy: { at: "desc" }, take: 200 }),
    db.auditEvent.count({
      where: {
        action: { in: [...REFUSALS] },
        at: { gt: new Date(Date.now() - 86_400_000) },
      },
    }),
  ]);

  return (
    <>
      <AppHeader user={admin} active="/admin/audit" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Admin · the record</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[42px] font-semibold leading-[1.05] tracking-[-0.02em]">
          Audit log
        </h1>
        <p className="m-0 mb-[26.4px] max-w-[620px] text-[17px] leading-[1.5] text-muted-3 text-pretty">
          Every action that changes who can get in, or what happens to
          someone&rsquo;s model. Nothing here is ever edited or removed.
          {refusalsToday > 0 && (
            <>
              {" "}
              <strong className="font-semibold text-amber-text">
                {refusalsToday} refusal{refusalsToday === 1 ? "" : "s"} in the
                last day
              </strong>{" "}
              — worth a look if that is more than you expect.
            </>
          )}
        </p>

        <nav className="mb-[17.6px] flex flex-wrap gap-[4.4px]">
          {LENSES.map((l) => (
            <Link
              key={l.key}
              href={l.key === "all" ? "/admin/audit" : `/admin/audit?lens=${l.key}`}
              aria-current={l.key === lens ? "page" : undefined}
              className={`rounded-[8px] px-[17.6px] py-[8.8px] text-[14px] ${
                l.key === lens
                  ? "bg-teal font-bold text-teal-100"
                  : "font-semibold text-muted-3 hover:bg-teal-200 hover:text-teal-700"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="overflow-x-auto rounded-[14px] bg-card shadow-sm">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr className="border-b border-rule bg-surface-2">
                {["When", "Action", "Who", "What", "From"].map((h) => (
                  <th
                    key={h}
                    className="px-[17.6px] py-[11px] text-left font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-[17.6px] py-[22px] text-[13px] text-muted">
                    Nothing recorded yet.
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b border-rule last:border-b-0">
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top text-[13px] tabular-nums text-muted">
                    <time dateTime={e.at.toISOString()} title={e.at.toISOString()}>
                      {relativeTime(e.at)}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top">
                    <span
                      className={`rounded-[6px] px-[8px] py-[3px] font-mono text-[11.5px] font-semibold ${tone(e.action)}`}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    {e.actorEmail ?? <span className="text-muted">—</span>}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    <span className="font-mono text-[12.5px]">{e.subject ?? "—"}</span>
                    {e.detail != null && (
                      <Detail detail={e.detail as Record<string, unknown>} />
                    )}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top font-mono text-[12px] text-muted">
                    {e.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="m-0 mt-[13.2px] text-[13px] text-muted">
          Showing the most recent {events.length}
          {events.length === 200 ? " of more" : ""}.
        </p>
      </main>
    </>
  );
}

/** The few fields worth showing inline; the rest stay in the database. */
function Detail({ detail }: { detail: Record<string, unknown> }) {
  const interesting = ["reason", "title", "filename", "format", "dims", "role"];
  const shown = interesting
    .filter((k) => detail[k] != null)
    .map((k) => `${k}: ${String(detail[k])}`);
  if (shown.length === 0) return null;
  return (
    <span className="mt-[3px] block text-[12.5px] text-muted">
      {shown.join(" · ")}
    </span>
  );
}

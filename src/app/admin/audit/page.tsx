import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { languageName } from "@/i18n/locales";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { AuditDashboard } from "@/components/audit-dashboard";
import { REFUSAL_ACTIONS, mix, refusals, stages } from "@/lib/dashboard";
import { Kicker } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The audit log, and the three panels above it. Admin only.
 *
 * Deliberately a page a human reads rather than an alerting pipeline: for one
 * printer and a handful of colleagues, a screen the owner can glance at beats
 * thresholds nobody tunes and alerts everyone learns to ignore. The rows are
 * already there if that changes — recording is the part that cannot be
 * backfilled.
 *
 * That argument only holds if somebody actually looks, and a wall of rows is
 * not something anybody opens twice. The panels are the answer: refusals,
 * where work is sitting, and what gets asked for — the three questions a person
 * arrives with, none of which a log can answer by being scrolled. They are pure
 * aggregation over rows that already existed (`src/lib/dashboard.ts`); nothing
 * new is recorded for them.
 */

type Lens = "all" | "access" | "uploads" | "settings";

const LENSES: Array<{ key: Lens; label: string; actions?: string[] }> = [
  { key: "all", label: "Everything" },
  {
    key: "access",
    label: "Who got in",
    actions: [
      "invite.sent", "invite.resent", "invite.revoked", "invite.accepted",
      "invite.rejected", "auth.signed_in", "auth.signed_out", "user.role_changed",
      "auth.sso_linked", "auth.sso_link_refused", "auth.sso_unlinked",
    ],
  },
  {
    key: "uploads",
    label: "Models",
    actions: [
      "story.created", "upload.rejected", "story.status_changed",
      "story.declined", "story.flagged", "story.priority_changed", "file.downloaded",
    ],
  },
  // What the owner changed about the instance itself (#104).
  { key: "settings", label: "Settings", actions: ["settings.changed"] },
];

/**
 * Refusals are the rows worth noticing — a run of them from one place is the
 * shape of somebody trying things. Everything else is normal traffic.
 *
 * The list lives in `dashboard.ts` so the count at the top, the tint in the
 * table and the panel cannot disagree. It gained `file.refused`, which had been
 * missing here: that verb fires when an account asks for a model it may not
 * see, which is the refusal most worth noticing and was the one not counted.
 */
const REFUSALS = new Set<string>(REFUSAL_ACTIONS);

function tone(action: string): string {
  if (REFUSALS.has(action)) return "bg-cherry text-ink";
  if (action.startsWith("auth.")) return "bg-aqua-wash text-ink";
  if (action.startsWith("invite.")) return "bg-mint-wash text-ink";
  return "bg-cream-2 text-ink-2";
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

  const [events, refusalsToday, refusalPanel, stagePanel, mixPanel, tSettings] = await Promise.all([
    db.auditEvent.findMany({ where, orderBy: { at: "desc" }, take: 200 }),
    db.auditEvent.count({
      where: {
        action: { in: [...REFUSALS] },
        at: { gt: new Date(Date.now() - 86_400_000) },
      },
    }),
    refusals(),
    stages(),
    mix(),
    getTranslations("auditSettings"),
  ]);

  return (
    <>
      <AppHeader user={admin} active="/admin/audit" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Admin · the record</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">
          Audit log
        </h1>
        <p className="m-0 mb-[26.4px] max-w-[620px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
          Every action that changes who can get in, or what happens to
          someone&rsquo;s model. Nothing here is ever edited or removed.
          {refusalsToday > 0 && (
            <>
              {" "}
              <strong className="font-bold text-cherry-dk">
                {refusalsToday} refusal{refusalsToday === 1 ? "" : "s"} in the
                last day
              </strong>{" "}
              — worth a look if that is more than you expect.
            </>
          )}
        </p>

        <AuditDashboard refusals={refusalPanel} stages={stagePanel} mix={mixPanel} />

        <nav className="mb-[17.6px] flex flex-wrap gap-[4.4px]">
          {LENSES.map((l) => (
            <Link
              key={l.key}
              href={l.key === "all" ? "/admin/audit" : `/admin/audit?lens=${l.key}`}
              aria-current={l.key === lens ? "page" : undefined}
              className={`stamp cursor-pointer rounded-chip border-[3px] border-ink px-[15px] py-[6px] font-mono text-[12px] font-bold uppercase tracking-[0.06em] ${
                l.key === lens ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="overflow-x-auto rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr className="border-b-[3px] border-ink bg-cream-2">
                {["When", "Action", "Who", "What", "From"].map((h) => (
                  <th
                    key={h}
                    className="px-[17.6px] py-[11px] text-left font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-[17.6px] py-[22px] font-mono text-[12px] uppercase text-ink-3">
                    Nothing recorded yet.
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b-2 border-dashed border-rule last:border-b-0">
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top font-mono text-[12px] tabular-nums text-ink-3">
                    <time dateTime={e.at.toISOString()} title={e.at.toISOString()}>
                      {relativeTime(e.at)}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top">
                    <span
                      className={`rounded-chip border-2 border-ink px-[9px] py-[2px] font-mono text-[11px] font-bold ${tone(e.action)}`}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    {e.actorEmail ?? <span className="text-ink-3">—</span>}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    <span className="font-mono text-[12.5px]">{e.subject ?? "—"}</span>
                    {e.detail != null && (
                      <Detail detail={e.detail as Record<string, unknown>} t={tSettings} />
                    )}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top font-mono text-[12px] text-ink-3">
                    {e.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="m-0 mt-[13.2px] font-mono text-[11.5px] uppercase text-ink-3">
          Showing the most recent {events.length}
          {events.length === 200 ? " of more" : ""}.
        </p>
      </main>
    </>
  );
}

/** The few fields worth showing inline; the rest stay in the database. */
function Detail({ detail, t }: { detail: Record<string, unknown>; t: SettingsTranslator }) {
  const interesting = ["reason", "title", "filename", "format", "dims", "role"];
  const shown = interesting
    .filter((k) => detail[k] != null)
    .map((k) => `${k}: ${String(detail[k])}`);
  const changes = detail.changes;
  const hasChanges = changes != null && typeof changes === "object" && !Array.isArray(changes);
  if (shown.length === 0 && !hasChanges) return null;
  return (
    <span className="mt-[3px] block text-[12.5px] text-ink-3">
      {shown.join(" · ")}
      {hasChanges && <SettingsChanges changes={changes as Record<string, unknown>} t={t} />}
    </span>
  );
}

type SettingsTranslator = Awaited<ReturnType<typeof getTranslations<"auditSettings">>>;

/**
 * A `settings.changed` row's changes, field by field: what was in force
 * before, and after. The whole point of the row (#104) is that the owner can
 * see what was switched, so the values are shown, not just the field names.
 */
function SettingsChanges({ changes, t }: { changes: Record<string, unknown>; t: SettingsTranslator }) {
  // A language by its own name, as the settings page and /me show it; nothing
  // stored is English, the built-in default.
  const language = (value: unknown): string =>
    value === null || value === undefined
      ? t("builtInLanguage")
      : `“${languageName(String(value)) ?? String(value)}”`;
  const show = (value: unknown): string =>
    value === null || value === undefined
      ? t("noName")
      : Array.isArray(value)
        ? value.length
          ? value.map(String).join(", ")
          : t("none")
        : `“${String(value)}”`;
  const label = (field: string): string =>
    field === "passkeyRpName" || field === "mailFromName" || field === "importSources" || field === "defaultLocale"
      ? t(`fields.${field}`)
      : field;
  return (
    <span className="block" data-audit-changes>
      {Object.entries(changes).map(([field, raw]) => {
        const change = (raw ?? {}) as { from?: unknown; to?: unknown; cleared?: unknown };
        const value = field === "defaultLocale" ? language : show;
        return (
          <span key={field} className="block">
            {t("change", { field: label(field), from: value(change.from), to: value(change.to) })}
            {change.cleared !== undefined && <> {t("cleared", { value: value(change.cleared) })}</>}
          </span>
        );
      })}
    </span>
  );
}

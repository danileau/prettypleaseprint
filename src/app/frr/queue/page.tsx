import Link from "next/link";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { featureLabel, featureRef } from "@/lib/scope";
import { FEATURE_FIELDS } from "@/lib/features";
import { relativeTime, PRIORITY_CHIP, CATEGORY_LABEL } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { FeatureActions } from "@/components/feature-actions";
import { Kicker, Notice, StatusChip } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * The owner's triage for feature requests — the print `/queue`'s sibling.
 * "Waiting on you" (still `Requested`) comes first and loudest and vanishes
 * when empty; everything already accepted is a list to scan with one control
 * each. Admin-only: `requireAdmin` answers 404 to a client.
 */
export default async function FeatureQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [{ toast, error }, admin] = await Promise.all([searchParams, requireAdmin()]);

  const features = await db.featureRequest.findMany({
    select: FEATURE_FIELDS,
    orderBy: { createdAt: "asc" },
  });

  // Priority order for the eye: high first. Within a priority, oldest first.
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const waiting = features
    .filter((f) => f.status === "Requested")
    .sort((a, b) => (rank[a.priority]! - rank[b.priority]!));
  const moving = features.filter(
    (f) => f.status !== "Requested" && f.status !== "Done" && f.status !== "Declined",
  );

  return (
    <>
      <AppHeader user={admin} active="/frr/queue" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Feature requests</Kicker>
        <h1 className="m-0 mt-[6px] mb-[22px] font-display text-[30px] leading-[1.05] text-ink">
          Requests to triage
        </h1>

        {error && (
          <div className="mb-[17.6px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        {waiting.length > 0 && (
          <section className="mb-[35.2px]">
            <h2 className="m-0 mb-[13.2px] font-display text-[22px] text-ink">Waiting on you</h2>
            <div className="flex flex-col gap-[13.2px]">
              {waiting.map((f) => {
                const priority = PRIORITY_CHIP[f.priority] ?? PRIORITY_CHIP.medium!;
                return (
                  <div
                    key={f.id}
                    className="rounded-panel border-[3px] border-ink bg-porcelain p-[17.6px] shadow-stamp"
                  >
                    <div className="mb-[8px] flex flex-wrap items-center gap-[8px]">
                      <Link
                        href={`/frr/${f.id}`}
                        className="font-mono text-[12px] font-bold tracking-[0.08em] text-ink-3 underline underline-offset-2 hover:text-cherry-dk"
                      >
                        {featureRef(f.id)}
                      </Link>
                      <span className={`rounded-chip border-2 border-ink px-[8px] py-[1px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink ${priority.bg}`}>
                        {priority.label}
                      </span>
                      <span className="rounded-chip border-2 border-ink bg-aqua-wash px-[8px] py-[1px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink">
                        {CATEGORY_LABEL[f.category] ?? f.category}
                      </span>
                    </div>
                    <Link href={`/frr/${f.id}`} className="font-display text-[19px] text-ink hover:text-cherry-dk">
                      {f.title}
                    </Link>
                    <p className="m-0 mt-[6px] mb-[13.2px] line-clamp-3 text-[15px] leading-[1.5] text-ink-2">
                      {f.description}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-[13.2px]">
                      <span className="font-mono text-[11.5px] text-ink-3">
                        {f.requester.name} · {relativeTime(f.createdAt)}
                      </span>
                      <FeatureActions featureId={f.id} status={f.status} from="/frr/queue" />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h2 className="m-0 mb-[13.2px] font-display text-[22px] text-ink">In flight</h2>
          {moving.length === 0 ? (
            <p className="m-0 rounded-card border-[3px] border-dashed border-ink-3 bg-cream-2 px-[15px] py-[13.2px] font-mono text-[12px] uppercase tracking-[0.05em] text-ink-3">
              Nothing accepted and in progress
            </p>
          ) : (
            <div className="flex flex-col gap-[11px]">
              {moving.map((f) => (
                <div
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-[13.2px] rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[13.2px]"
                >
                  <div className="min-w-[220px] flex-1">
                    <div className="mb-[4px] flex flex-wrap items-center gap-[8px]">
                      <Link href={`/frr/${f.id}`} className="font-mono text-[12px] font-bold text-ink-3 underline underline-offset-2 hover:text-cherry-dk">
                        {featureRef(f.id)}
                      </Link>
                      <StatusChip status={f.status} label={featureLabel(f.status)} />
                    </div>
                    <Link href={`/frr/${f.id}`} className="font-display text-[16px] text-ink hover:text-cherry-dk">
                      {f.title}
                    </Link>
                  </div>
                  <FeatureActions featureId={f.id} status={f.status} from="/frr/queue" />
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {toast && <Toast>{toast}</Toast>}
    </>
  );
}

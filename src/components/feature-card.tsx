import Link from "next/link";

import { relativeTime, PRIORITY_CHIP, CATEGORY_LABEL } from "@/lib/catalog";
import { featureRef } from "@/lib/scope";
import type { FeatureRow } from "@/lib/features";

/**
 * A feature request, as a ticket on the 'frr' rail — the print `StoryCard`'s
 * sibling. No filament stripe (there is no file); the left edge carries the
 * priority colour instead, and the category rides where the material chip does
 * on a print, so the two boards read the same at a glance.
 *
 * `showRequester` carries the scope rule into the design, exactly as
 * `showUploader` does: a client only ever sees their own, so their name on
 * every card would be noise.
 */
export function FeatureCard({
  feature,
  showRequester,
}: {
  feature: FeatureRow;
  showRequester: boolean;
}) {
  const priority = PRIORITY_CHIP[feature.priority] ?? PRIORITY_CHIP.medium!;

  return (
    <Link
      href={`/frr/${feature.id}`}
      className="ticket group block rounded-card border-[3px] border-ink bg-porcelain shadow-stamp transition-transform hover:-translate-y-[2px] hover:shadow-stamp-lg"
    >
      {/* Priority worn as the edge stripe, where a print wears its filament. */}
      <span
        aria-hidden
        className={`block h-[8px] rounded-t-[7px] border-b-[3px] border-ink ${priority.bg}`}
      />

      <div className="px-[15px] py-[13.2px]">
        <div className="mb-[8.8px] flex flex-wrap items-center gap-[6px]">
          <span className="whitespace-nowrap font-mono text-[12px] font-bold tracking-[0.08em] text-ink-3">
            {featureRef(feature.id)}
          </span>
          <span className="rounded-chip border-2 border-ink bg-cream-2 px-[8px] py-[1px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink">
            {priority.label}
          </span>
        </div>

        <div className="mb-[11px] break-words font-display text-[15.5px] leading-[1.2] text-ink">
          {feature.title}
        </div>

        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="rounded-chip border-2 border-ink bg-aqua-wash px-[9px] py-[2px] font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-ink">
            {CATEGORY_LABEL[feature.category] ?? feature.category}
          </span>
          {feature._count.comments > 0 && (
            <span className="rounded-chip border-2 border-ink bg-cream-2 px-[9px] py-[2px] font-mono text-[11px] font-bold text-ink">
              {feature._count.comments} 💬
            </span>
          )}
        </div>

        <div className="mt-[11px] flex items-center gap-[8px] border-t-2 border-dashed border-rule pt-[8px] font-mono text-[11px] text-ink-3">
          {showRequester && (
            <span
              aria-hidden
              className="inline-flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full border-2 border-ink bg-aqua text-[9.5px] font-bold text-ink"
            >
              {feature.requester.initials}
            </span>
          )}
          <span className="truncate">
            {showRequester
              ? `${feature.requester.name} · ${relativeTime(feature.createdAt)}`
              : relativeTime(feature.createdAt)}
          </span>
        </div>
      </div>
    </Link>
  );
}

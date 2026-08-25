import { advanceFeature, declineFeature } from "@/app/actions/features";
import { featureLabel, nextFeatureStatus } from "@/lib/scope";
import type { FeatureStatus } from "@prisma/client";

/**
 * The printer owner's controls for one feature request — the print
 * `AdminActions`' sibling, minus the flag (a feature has no "model problem";
 * declining or a comment covers "not like this").
 *
 * Plain forms posting to server actions, so the panel works with JavaScript
 * off. Decline sits behind a `<details>` disclosure because it is terminal.
 */
export function FeatureActions({
  featureId,
  status,
  from,
}: {
  featureId: number;
  status: FeatureStatus;
  from: string;
}) {
  const next = nextFeatureStatus(status);
  const isNew = status === "Requested";

  if (status === "Declined") {
    return (
      <p className="m-0 font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
        Declined — nothing further
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-[8px]">
      {next && (
        <form action={advanceFeature}>
          <input type="hidden" name="id" value={featureId} />
          <input type="hidden" name="from" value={from} />
          <button
            type="submit"
            className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[18px] py-[8px] text-[14px] font-bold text-cream hover:bg-cherry"
          >
            {isNew ? "Accept it" : `Move to ${featureLabel(next)}`}
          </button>
        </form>
      )}

      {isNew && (
        <details className="group">
          <summary className="stamp inline-block cursor-pointer list-none rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun">
            Decline
          </summary>
          <form action={declineFeature} className="mt-[8.8px]">
            <input type="hidden" name="id" value={featureId} />
            <input type="hidden" name="from" value={from} />
            <p className="m-0 mb-[8px] font-mono text-[11.5px] text-ink-2">
              This closes it. The requester is told.
            </p>
            <button
              type="submit"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cream-2 px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-cherry-wash"
            >
              Yes, decline it
            </button>
          </form>
        </details>
      )}
    </div>
  );
}

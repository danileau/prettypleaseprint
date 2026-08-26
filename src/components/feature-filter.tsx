import Link from "next/link";

import {
  FEATURE_PRIORITIES,
  FEATURE_CATEGORIES,
  PRIORITY_CHIP,
  CATEGORY_LABEL,
} from "@/lib/catalog";
import { FEATURE_FLOW, featureLabel } from "@/lib/scope";
import type { FeatureFilter } from "@/lib/features";
import type { FeatureStatus } from "@prisma/client";

const STATUSES = [...FEATURE_FLOW, "Declined"] as readonly FeatureStatus[];

/**
 * The filter bar over the feature-request views — priority, status, category.
 *
 * A native `method="get"` form, not a server action: submitting puts the
 * choices in the URL (`?priority=high&status=Accepted`), which the page reads
 * and applies server-side. So it works with JavaScript off, the result is
 * link-and-bookmark-able, and the narrowing happens in the query — a filter
 * can only ever shrink what `featureScope` already allows, never widen it.
 */
export function FeatureFilterBar({
  action,
  filter,
}: {
  /** The page path the form submits back to (also the "Clear" target). */
  action: string;
  filter: FeatureFilter;
}) {
  const active = Boolean(filter.priority || filter.status || filter.category);
  const selectCls =
    "rounded-card border-[3px] border-ink bg-porcelain px-[11px] py-[7px] font-mono text-[13px] text-ink";
  const labelCls =
    "font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-3";

  return (
    <form
      method="get"
      action={action}
      className="mb-[22px] flex flex-wrap items-end gap-[10px] rounded-panel border-[3px] border-ink bg-cream-2 p-[13.2px]"
    >
      <div className="flex flex-col gap-[3px]">
        <label htmlFor="f-priority" className={labelCls}>Priority</label>
        <select id="f-priority" name="priority" defaultValue={filter.priority ?? ""} className={selectCls}>
          <option value="">Any</option>
          {FEATURE_PRIORITIES.map((p) => (
            <option key={p} value={p}>{PRIORITY_CHIP[p]?.label ?? p}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-[3px]">
        <label htmlFor="f-status" className={labelCls}>Status</label>
        <select id="f-status" name="status" defaultValue={filter.status ?? ""} className={selectCls}>
          <option value="">Any</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{featureLabel(s)}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-[3px]">
        <label htmlFor="f-category" className={labelCls}>Category</label>
        <select id="f-category" name="category" defaultValue={filter.category ?? ""} className={selectCls}>
          <option value="">Any</option>
          {FEATURE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[16px] py-[8px] text-[13.5px] font-bold text-cream hover:bg-cherry"
      >
        Apply
      </button>

      {active && (
        <Link
          href={action}
          className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink-3 underline underline-offset-4 hover:text-cherry-dk"
        >
          Clear
        </Link>
      )}
    </form>
  );
}

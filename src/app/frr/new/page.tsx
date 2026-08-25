import Link from "next/link";

import { requireUser, printerName } from "@/lib/authz";
import {
  FEATURE_PRIORITIES,
  FEATURE_CATEGORIES,
  DEFAULT_FEATURE_PRIORITY,
  DEFAULT_FEATURE_CATEGORY,
  PRIORITY_CHIP,
  CATEGORY_LABEL,
} from "@/lib/catalog";
import { createFeature } from "@/app/actions/features";
import { AppHeader } from "@/components/app-header";
import { Kicker, Label, Input, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * File a feature request. A plain server-rendered form posting to the
 * `createFeature` action — no file to carry, so unlike an upload it needs no
 * client bundle and works with JavaScript off. Title, description, priority
 * and category, exactly as the catalogue defines them; the server validates
 * against the same schema the form renders from.
 */
export default async function NewFeaturePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, user] = await Promise.all([searchParams, requireUser("/frr/new")]);
  const owner = await printerName();

  return (
    <>
      <AppHeader user={user} active="/frr" />

      <main className="mx-auto w-full max-w-[780px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Link
          href="/frr"
          className="inline-block font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-ink-2 underline underline-offset-4 hover:text-cherry-dk"
        >
          ← Back to requests
        </Link>

        <div className="mt-[13.2px] mb-[22px]">
          <Kicker>New request</Kicker>
          <h1 className="m-0 mt-[6px] font-display text-[30px] leading-[1.05] text-ink">
            Ask for a feature
          </h1>
          <p className="m-0 mt-[8px] text-[15px] text-ink-2">
            Say what you are hoping for and why. {owner} sees it on the board and takes
            it from there.
          </p>
        </div>

        {error && (
          <div className="mb-[17.6px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        <form action={createFeature} className="flex flex-col gap-[17.6px]">
          <div>
            <Label htmlFor="title">Title</Label>
            <Input id="title" name="title" required maxLength={120} placeholder="A short summary" />
          </div>

          <div>
            <Label htmlFor="description">What &amp; why</Label>
            <textarea
              id="description"
              name="description"
              required
              maxLength={4000}
              rows={6}
              placeholder="What you'd like, and what it would let you do."
              className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] leading-[1.5] text-ink placeholder:text-ink-3"
            />
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[17.6px]">
            <div>
              <Label htmlFor="priority">Priority</Label>
              <select
                id="priority"
                name="priority"
                defaultValue={DEFAULT_FEATURE_PRIORITY}
                className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] text-ink"
              >
                {FEATURE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_CHIP[p]?.label ?? p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="category">Category</Label>
              <select
                id="category"
                name="category"
                defaultValue={DEFAULT_FEATURE_CATEGORY}
                className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] text-ink"
              >
                {FEATURE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <button
              type="submit"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[28px] py-[13px] text-[16px] font-bold text-cream hover:bg-cherry"
            >
              File the request
            </button>
          </div>
        </form>
      </main>
    </>
  );
}

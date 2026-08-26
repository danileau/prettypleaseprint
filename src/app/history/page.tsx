import Link from "next/link";

import { requireUser, printerName } from "@/lib/authz";
import { storyRef } from "@/lib/scope";
import { HISTORY_STATUSES, listHistory } from "@/lib/stories";
import { MATERIALS, relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Kicker, StatusChip } from "@/components/ui";
import { RequeueStory } from "@/components/requeue-story";
import type { StoryStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * History Prints.
 *
 * The prints that have left, or are leaving, the active rail — `Delivery`,
 * `Done` and `Declined`. The rail (`/board`) is for what is still moving; this
 * is where you come to find an old job and run it again. Scoped exactly like
 * the board and `/me`: a client sees only their own, the printer owner sees
 * the group.
 *
 * The whole point is re-printing without re-uploading, so every row carries a
 * "Print again" that clones the ticket and copies the file (FRR-102). Filters
 * are plain form controls driven by the query string, applied server-side, so
 * the page works with JavaScript off and no filter can widen the scope.
 */

/** "since" presets — value in days, or "all". */
const SINCE = [
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last year", days: 365 },
  { key: "all", label: "All time", days: undefined },
] as const;

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; material?: string; since?: string }>;
}) {
  const [{ status, material, since }, user] = await Promise.all([
    searchParams,
    requireUser("/history"),
  ]);
  const owner = await printerName();
  const isAdmin = user.role === "admin";

  // Only honour values we recognise; anything else falls back to "all".
  const statusFilter =
    status && (HISTORY_STATUSES as readonly string[]).includes(status)
      ? (status as StoryStatus)
      : undefined;
  const materialFilter =
    material && (MATERIALS as readonly string[]).includes(material) ? material : undefined;
  const sincePreset = SINCE.find((s) => s.key === since) ?? SINCE[3]; // default: all time

  const stories = await listHistory(user, {
    status: statusFilter,
    material: materialFilter,
    sinceDays: sincePreset.days,
  });

  const hasFilter = Boolean(statusFilter || materialFilter || sincePreset.key !== "all");

  const selectClass =
    "rounded-card border-[3px] border-ink bg-porcelain px-[13.2px] py-[8px] text-[14px] font-bold text-ink";

  return (
    <>
      <AppHeader user={user} active="/history" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>History</Kicker>
        <h1 className="m-0 mt-[6px] mb-[8px] font-display text-[30px] leading-[1.05] text-ink">
          {isAdmin ? "Everything the group has printed" : "Your print history"}
        </h1>
        <p className="m-0 mb-[22px] max-w-[62ch] text-[15px] text-ink-2">
          The jobs that have left the rail — delivered, done, or declined. Found the
          one you want again? <strong>Print again</strong> opens a fresh request from
          the same file, no re-upload.
        </p>

        {/* ---- filters: a plain GET form, so it works with JS off ---- */}
        <form
          method="get"
          className="mb-[22px] flex flex-wrap items-end gap-[13.2px] rounded-panel border-[3px] border-ink bg-cream-2 p-[17.6px] shadow-stamp"
        >
          <label className="flex flex-col gap-[4px]">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink-2">Status</span>
            <select name="status" defaultValue={statusFilter ?? ""} className={selectClass}>
              <option value="">Any</option>
              {HISTORY_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-[4px]">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink-2">Material</span>
            <select name="material" defaultValue={materialFilter ?? ""} className={selectClass}>
              <option value="">Any</option>
              {MATERIALS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-[4px]">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink-2">Filed</span>
            <select name="since" defaultValue={sincePreset.key} className={selectClass}>
              {SINCE.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[18px] py-[9px] text-[14px] font-bold text-cream hover:bg-cherry"
          >
            Filter
          </button>
          {hasFilter && (
            <Link
              href="/history"
              className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink-3 underline underline-offset-4 hover:text-cherry-dk"
            >
              Clear
            </Link>
          )}
        </form>

        <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          {stories.length === 0 ? (
            <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
              {hasFilter
                ? "Nothing matches those filters."
                : isAdmin
                  ? "Nothing has finished yet."
                  : "No finished prints yet — they land here once they're delivered, done or declined."}
            </p>
          ) : (
            stories.map((story, i) => (
              <div
                key={story.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < stories.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                } ${story.status === "Declined" ? "bg-cream-2" : ""}`}
              >
                <span
                  aria-hidden
                  className="h-[40px] w-[40px] flex-none rounded-full border-[3px] border-ink"
                  style={{ background: story.colorHex }}
                />
                <div className="min-w-[180px] flex-[1_1_240px]">
                  <Link
                    href={`/story/${story.id}`}
                    className="block font-display text-[17px] leading-[1.2] text-ink hover:text-cherry-dk"
                  >
                    {story.title}
                  </Link>
                  <p className="m-0 mt-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
                    {storyRef(story.id)} · {story.material}
                    {isAdmin ? ` · ${story.uploader.name}` : ""} · {relativeTime(story.createdAt)}
                  </p>
                </div>
                <StatusChip status={story.status} />
                {/* Only the person who filed it may re-queue it — an admin
                    seeing a ticket is not its owner (the action re-checks). */}
                {story.uploaderId === user.id && (
                  <RequeueStory storyId={story.id} label={storyRef(story.id)} from="/history" compact />
                )}
              </div>
            ))
          )}
        </div>
      </main>
    </>
  );
}

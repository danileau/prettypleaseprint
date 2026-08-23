import Link from "next/link";
import type { Story, User } from "@prisma/client";

import { relativeTime } from "@/lib/catalog";
import { storyRef } from "@/lib/scope";

export type CardStory = Story & { uploader: Pick<User, "name" | "initials"> };

/**
 * A story, as a short-order ticket torn off the rail.
 *
 * This is the hinge of the whole redesign: a request pinned to a board waiting
 * for one person to work through it *is* a docket on a kitchen rail, so it may
 * as well look like one. Typewriter face for everything the kitchen typed,
 * perforation notches at the top, and the filament colour worn as a stripe
 * down the left edge the way an order gets colour-coded.
 *
 * `showUploader` carries the authorisation rule into the design: a client only
 * ever sees their own tickets, so their name on every one would be noise.
 */
export function StoryCard({
  story,
  showUploader,
  compact = false,
}: {
  story: CardStory;
  showUploader: boolean;
  compact?: boolean;
}) {
  const printing = story.status === "Printing";

  return (
    <Link
      href={`/story/${story.id}`}
      className="ticket group block rounded-card border-[3px] border-ink bg-porcelain shadow-stamp transition-transform hover:-translate-y-[2px] hover:shadow-stamp-lg"
    >
      {/* The filament colour, worn as a stripe. */}
      <span
        aria-hidden
        className="block h-[8px] rounded-t-[7px] border-b-[3px] border-ink"
        style={{ background: story.colorHex }}
      />

      <div className={compact ? "px-[13.2px] py-[11px]" : "px-[15px] py-[13.2px]"}>
        {/* Check number, and a stamp if the kitchen flagged it. */}
        <div className="mb-[8.8px] flex flex-wrap items-center gap-[6px]">
          <span className="whitespace-nowrap font-mono text-[12px] font-bold tracking-[0.08em] text-ink-3">
            {storyRef(story.id)}
          </span>
          {story.flagged && (
            <span className="rounded-chip border-2 border-ink bg-cherry px-[8px] py-[1px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink">
              needs a look
            </span>
          )}
        </div>

        <div className="mb-[11px] flex items-start gap-[8.8px]">
          <span className="flex-1 font-display text-[15.5px] leading-[1.2] text-ink">
            {story.title}
          </span>
          {story.quantity > 1 && (
            <span className="rounded-[6px] border-2 border-ink bg-sun px-[6px] py-[1px] font-mono text-[12px] font-bold text-ink">
              ×{story.quantity}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="flex items-center gap-[5px] rounded-chip border-2 border-ink bg-cream-2 px-[9px] py-[2px] font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-ink">
            <span
              aria-hidden
              className="h-[9px] w-[9px] rounded-full border border-ink"
              style={{ background: story.colorHex }}
            />
            {story.material}
          </span>
          <span className="rounded-chip border-2 border-ink bg-aqua-wash px-[9px] py-[2px] font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-ink">
            {story.tip}
          </span>
        </div>

        {/*
         * On the griddle. Without a printer API there is no telemetry, so this
         * says where it is and nothing about how far along — the bar is a
         * marker, not a progress reading.
         */}
        {printing && (
          <div className="mt-[11px] flex items-center gap-[8px] rounded-[6px] border-2 border-ink bg-sun-wash px-[8px] py-[4px]">
            <span
              aria-hidden
              className="ppp-extrude h-[4px] w-[26px] flex-none rounded-full bg-sun-dk"
            />
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-sun-dk">
              on the bed
            </span>
          </div>
        )}

        <div className="mt-[11px] flex items-center gap-[8px] border-t-2 border-dashed border-rule pt-[8px] font-mono text-[11px] text-ink-3">
          {showUploader && (
            <span
              aria-hidden
              className="inline-flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full border-2 border-ink bg-aqua text-[9.5px] font-bold text-ink"
            >
              {story.uploader.initials}
            </span>
          )}
          <span className="truncate">
            {showUploader
              ? `${story.uploader.name} · ${relativeTime(story.createdAt)}`
              : relativeTime(story.createdAt)}
          </span>
        </div>
      </div>
    </Link>
  );
}

import Link from "next/link";
import type { Story, User } from "@prisma/client";

import { relativeTime } from "@/lib/catalog";
import { storyRef } from "@/lib/scope";

export type CardStory = Story & { uploader: Pick<User, "name" | "initials"> };

/**
 * A story on the backlog board. Handoff §2.
 *
 * `showUploader` carries the authorisation rule into the UI: a client only
 * ever sees their own stories, so naming the uploader on every card would be
 * noise. The admin sees everyone, so the name is the useful part.
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
      className={`block rounded-[10px] bg-card shadow-sm transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-md ${
        compact ? "px-[13.2px] py-[11px]" : "px-[17.6px] py-[15px]"
      }`}
    >
      {/* 1. ref, and a flag if the model needs a look */}
      <div className="mb-[8.8px] flex items-center gap-[8.8px]">
        <span className="font-mono text-[11.5px] font-bold tracking-[0.06em] text-muted">
          {storyRef(story.id)}
        </span>
        {story.flagged && (
          <span className="rounded-full bg-amber-fill px-[8px] py-[2px] text-[11px] font-bold text-amber-text">
            needs a look
          </span>
        )}
      </div>

      {/* 2. title, and the quantity when it is more than one */}
      <div className="mb-[8.8px] flex items-baseline gap-[8.8px]">
        <span className="flex-1 text-[15.5px] font-bold leading-[1.25]">
          {story.title}
        </span>
        {story.quantity > 1 && (
          <span className="rounded-[6px] bg-teal-200 px-[7px] py-[2px] font-mono text-[12.5px] font-semibold text-teal-700">
            {story.quantity}×
          </span>
        )}
      </div>

      {/* 3. material and tip */}
      <div className="flex flex-wrap items-center gap-[4.4px]">
        <span className="flex items-center gap-[6px] rounded-full bg-surface-2 px-[9px] py-[3px] text-[12px] font-semibold text-muted-3">
          <span
            aria-hidden
            className="h-[10px] w-[10px] rounded-full"
            style={{
              background: story.colorHex,
              boxShadow: "inset 0 0 0 1px rgba(20,24,28,0.2)",
            }}
          />
          {story.material}
        </span>
        <span className="rounded-full bg-slate-200 px-[9px] py-[3px] text-[12px] font-semibold text-slate-700">
          {story.tip}
        </span>
      </div>

      {/* 4. Where it is, and nothing more. Without a printer API there is no
             telemetry, and a guessed duration would be a claim the app cannot
             stand behind. */}
      {printing && (
        <p className="m-0 mt-[11px] font-mono text-[11.5px] text-muted">
          on the bed
        </p>
      )}

      {/* 5. who and when */}
      <div className="mt-[11px] flex items-center gap-[8.8px] text-[12px] text-muted">
        {showUploader && (
          <span
            aria-hidden
            className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-full bg-slate-300 text-[10.5px] font-extrabold text-slate-800"
          >
            {story.uploader.initials}
          </span>
        )}
        <span>
          {showUploader
            ? `${story.uploader.name} · ${relativeTime(story.createdAt)}`
            : relativeTime(story.createdAt)}
        </span>
      </div>
    </Link>
  );
}

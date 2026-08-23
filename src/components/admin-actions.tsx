import { advanceStory, clearFlag, declineStory, flagStory } from "@/app/actions/stories";
import { nextStatus } from "@/lib/scope";
import type { StoryStatus } from "@prisma/client";

/**
 * The printer owner's controls for one ticket.
 *
 * Every one is a plain form posting to a server action, so the whole panel
 * works with JavaScript off and there is no client bundle for it. The two
 * consequential actions — decline and flag — sit behind a `<details>`
 * disclosure rather than firing on a single click: decline is terminal, and a
 * flag without a reason is useless, so both need a second beat anyway.
 */
export function AdminActions({
  storyId,
  status,
  flagged,
  flagReason,
  from,
  compact = false,
}: {
  storyId: number;
  status: StoryStatus;
  flagged: boolean;
  flagReason?: string | null;
  /** Where to return with the result. Validated server-side. */
  from: string;
  compact?: boolean;
}) {
  const next = nextStatus(status);
  const isNew = status === "Requested";
  const declined = status === "Declined";

  if (declined) {
    return (
      <p className="m-0 font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
        Declined — nothing further
      </p>
    );
  }

  return (
    <div className={compact ? "flex flex-wrap items-start gap-[8px]" : "flex flex-col gap-[13.2px]"}>
      <div className="flex flex-wrap items-start gap-[8px]">
        {next && (
          <form action={advanceStory}>
            <input type="hidden" name="id" value={storyId} />
            <input type="hidden" name="from" value={from} />
            <button
              type="submit"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[18px] py-[8px] text-[14px] font-bold text-cream hover:bg-cherry"
            >
              {isNew ? "Accept it" : `Move to ${next}`}
            </button>
          </form>
        )}

        {/* A reason is required, so this cannot be a one-click button. */}
        <details className="group">
          <summary className="stamp inline-block cursor-pointer list-none rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun">
            {flagged ? "Change the flag" : "Flag the model"}
          </summary>
          <form
            action={flagStory}
            className="mt-[8px] flex flex-wrap items-center gap-[8px] rounded-card border-[3px] border-ink bg-sun-wash p-[11px]"
          >
            <input type="hidden" name="id" value={storyId} />
            <input type="hidden" name="from" value={from} />
            <label htmlFor={`reason-${storyId}`} className="sr-only">
              What is wrong with the model
            </label>
            <input
              id={`reason-${storyId}`}
              name="reason"
              required
              maxLength={200}
              defaultValue={flagReason ?? ""}
              placeholder="thin walls in two spots"
              className="min-w-[180px] flex-1 rounded-[8px] border-[3px] border-ink bg-porcelain px-[11px] py-[7px] text-[14px] text-ink placeholder:text-ink-3"
            />
            <button
              type="submit"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-sun px-[15px] py-[7px] text-[13.5px] font-bold text-ink"
            >
              Flag it
            </button>
          </form>
        </details>

        {flagged && (
          <form action={clearFlag}>
            <input type="hidden" name="id" value={storyId} />
            <input type="hidden" name="from" value={from} />
            <button
              type="submit"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-mint px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-mint-wash"
            >
              Clear the flag
            </button>
          </form>
        )}

        {/* Terminal, so it asks twice. */}
        {isNew && (
          <details>
            <summary className="inline-block cursor-pointer list-none rounded-chip border-[3px] border-transparent px-[15px] py-[8px] text-[14px] font-bold text-ink-2 hover:border-ink hover:bg-cherry-wash">
              Decline
            </summary>
            <form
              action={declineStory}
              className="mt-[8px] flex flex-wrap items-center gap-[11px] rounded-card border-[3px] border-ink bg-cherry-wash p-[11px]"
            >
              <input type="hidden" name="id" value={storyId} />
            <input type="hidden" name="from" value={from} />
              <span className="text-[14px] text-ink">
                Decline this one? It cannot be undone.
              </span>
              <button
                type="submit"
                className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[15px] py-[7px] text-[13.5px] font-bold text-cream"
              >
                Yes, decline
              </button>
            </form>
          </details>
        )}
      </div>
    </div>
  );
}

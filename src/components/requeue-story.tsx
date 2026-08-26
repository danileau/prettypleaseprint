import { requeueStory } from "@/app/actions/stories";

/**
 * "Print this one again." (FRR-102)
 *
 * Shown to the person who filed the request, on any of their own tickets —
 * the first print is usually a test, so re-running a finished (or declined)
 * one should not mean hunting down the model file and re-uploading it.
 *
 * A plain form, so it works with JavaScript off like the rest of the ticket
 * controls. The server action copies the file to a fresh object, opens a new
 * `Requested` ticket and sends the requester to it; the original is left
 * exactly as it was.
 */
export function RequeueStory({
  storyId,
  label,
  from,
  compact = false,
}: {
  storyId: number;
  /** The display ref, e.g. "PPP-104". Not `ref` — React reserves it. */
  label: string;
  from: string;
  /** A tight, label-free button for a list row (the History view). */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <form action={requeueStory}>
        <input type="hidden" name="storyId" value={storyId} />
        <input type="hidden" name="from" value={from} />
        <button
          type="submit"
          aria-label={`Print ${label} again`}
          title="Opens a fresh request from the same file — no re-upload"
          className="stamp inline-flex cursor-pointer items-center gap-[6px] rounded-chip border-[3px] border-ink bg-aqua px-[13.2px] py-[6px] text-[13px] font-bold text-ink hover:bg-sun"
        >
          <span aria-hidden className="font-mono text-[14px] leading-none">↻</span>
          Print again
        </button>
      </form>
    );
  }

  return (
    <form action={requeueStory} className="mt-[17.6px]">
      <input type="hidden" name="storyId" value={storyId} />
      <input type="hidden" name="from" value={from} />
      <button
        type="submit"
        className="stamp inline-flex cursor-pointer items-center gap-[8px] rounded-chip border-[3px] border-ink bg-aqua px-[17.6px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun"
      >
        {/* A plain refresh wedge, not a brand mark. */}
        <span aria-hidden className="font-mono text-[15px] leading-none">↻</span>
        Print {label} again
      </button>
      <p className="m-0 mt-[6px] font-mono text-[11px] leading-[1.5] text-ink-3">
        Opens a fresh request from the same file — no re-upload.
      </p>
    </form>
  );
}

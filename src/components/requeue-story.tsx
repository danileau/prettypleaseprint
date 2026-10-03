import Link from "next/link";

/**
 * "Print this one again." (FRR-102)
 *
 * Shown to the person who filed the request, on any of their own tickets —
 * the first print is usually a test, so re-running a finished (or declined)
 * one should not mean hunting down the model file and re-uploading it.
 *
 * A link, not a form. It used to post straight to an action that cloned the
 * ticket as it was; it now goes to `/story/{id}/again`, the request form
 * filled in with the old wish, because the second print is rarely meant to be
 * identical to the first. Nothing is created until that form is sent, and the
 * original is left exactly as it was.
 */
export function RequeueStory({
  storyId,
  label,
  compact = false,
}: {
  storyId: number;
  /** The display ref, e.g. "PPP-104". Not `ref` — React reserves it. */
  label: string;
  /** A tight, label-free button for a list row (the History view). */
  compact?: boolean;
}) {
  const href = `/story/${storyId}/again`;

  if (compact) {
    return (
      <Link
        href={href}
        aria-label={`Print ${label} again`}
        title="Opens a fresh request from the same file — no re-upload"
        className="stamp inline-flex cursor-pointer items-center gap-[6px] rounded-chip border-[3px] border-ink bg-aqua px-[13.2px] py-[6px] text-[13px] font-bold text-ink hover:bg-sun"
      >
        <span aria-hidden className="font-mono text-[14px] leading-none">↻</span>
        Print again
      </Link>
    );
  }

  return (
    <div className="mt-[17.6px]">
      <Link
        href={href}
        className="stamp inline-flex cursor-pointer items-center gap-[8px] rounded-chip border-[3px] border-ink bg-aqua px-[17.6px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun"
      >
        {/* A plain refresh wedge, not a brand mark. */}
        <span aria-hidden className="font-mono text-[15px] leading-none">↻</span>
        Print {label} again
      </Link>
      <p className="m-0 mt-[6px] font-mono text-[11px] leading-[1.5] text-ink-3">
        Opens a fresh request from the same file — no re-upload. You can change
        the material, colour, quantity and settings first.
      </p>
    </div>
  );
}

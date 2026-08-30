import { storyRef } from "@/lib/scope";

/**
 * Take a copy of the model, as uploaded.
 *
 * The printer owner needs the file, and "Open in PrusaSlicer" only helps on a
 * machine with the helper installed — their own laptop, someone else's desk, a
 * phone, or a slicer that is not PrusaSlicer, all had no answer at all. This is
 * that answer, and it is deliberately the plainest thing on the page: a link.
 *
 * There is no new server surface behind it. `/api/models/[id]` already streams
 * the bytes with `Content-Disposition: attachment` and the real filename, and
 * is already scoped by `storyScope` — so this link grants nothing that opening
 * the ticket did not already grant, and it is already audited: the route
 * records `file.downloaded` whenever bytes go to somebody other than the person
 * who uploaded them, which is exactly the printer owner taking a copy.
 *
 * Rendered for anyone who can see the ticket, which is the uploader and the
 * printer owner. Not gated on role: an uploader fetching back the file they
 * themselves put there reveals nothing, and a rule that said otherwise would be
 * strange to explain.
 */
export function DownloadModel({
  storyId,
  filename,
}: {
  storyId: number;
  filename: string;
}) {
  return (
    <div className="mt-[13.2px]">
      <a
        href={`/api/models/${storyId}`}
        className="stamp inline-flex cursor-pointer items-center gap-[8px] rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun"
      >
        <span aria-hidden className="font-mono text-[15px] leading-none">↓</span>
        Download {storyRef(storyId)}
      </a>
      <p className="m-0 mt-[6px] font-mono text-[11px] leading-[1.5] text-ink-3">
        {filename} — the file exactly as it was uploaded.
      </p>
    </div>
  );
}

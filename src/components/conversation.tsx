import { addComment } from "@/app/actions/comments";
import { relativeTime } from "@/lib/catalog";

type Author = { id: string; name: string; initials: string; role: "client" | "admin" };
export type ThreadComment = {
  id: string;
  body: string;
  createdAt: Date;
  author: Author;
};

/**
 * The thread on a ticket, and the box to add to it. Handoff §4.
 *
 * Notes clipped to an order docket: typewriter attribution, the body in
 * something you can actually read, and the two sides tinted differently so a
 * long back-and-forth is scannable without reading every name. The printer
 * owner is sun, everyone else aqua — the same pairing the header avatars use.
 *
 * A plain form, so it works with JavaScript off like the rest of the ticket
 * controls.
 */
export function Conversation({
  storyId,
  comments,
  viewerRole,
  ownerName,
}: {
  storyId: number;
  comments: ThreadComment[];
  viewerRole: "client" | "admin";
  ownerName: string;
}) {
  return (
    <section className="mt-[26.4px]">
      <h2 className="m-0 mb-[13.2px] font-display text-[22px] text-ink">
        Talk it over
      </h2>

      {comments.length === 0 ? (
        <p className="m-0 mb-[13.2px] rounded-card border-[3px] border-dashed border-ink-3 bg-cream-2 px-[15px] py-[13.2px] font-mono text-[12px] uppercase tracking-[0.05em] text-ink-3">
          Nothing said yet
        </p>
      ) : (
        <ol className="m-0 mb-[13.2px] flex list-none flex-col gap-[11px] p-0">
          {comments.map((c) => {
            const fromOwner = c.author.role === "admin";
            return (
              <li key={c.id} className="flex items-start gap-[11px]">
                <span
                  aria-hidden
                  className={`mt-[3px] inline-flex h-[32px] w-[32px] flex-none items-center justify-center rounded-full border-[3px] border-ink font-mono text-[11px] font-bold text-ink ${
                    fromOwner ? "bg-sun" : "bg-aqua"
                  }`}
                >
                  {c.author.initials}
                </span>
                <div
                  className={`flex-1 rounded-card border-[3px] border-ink p-[13.2px] shadow-stamp ${
                    fromOwner ? "bg-sun-wash" : "bg-porcelain"
                  }`}
                >
                  <p className="m-0 mb-[4px] font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink-3">
                    {c.author.name}
                    {fromOwner ? " · the printer" : ""} ·{" "}
                    {relativeTime(c.createdAt)}
                  </p>
                  {/* React escapes this; a hostile body renders as text. */}
                  <p className="m-0 whitespace-pre-wrap text-[15.5px] leading-[1.5] text-ink">
                    {c.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <form action={addComment} className="flex flex-wrap gap-[8.8px]">
        <input type="hidden" name="storyId" value={storyId} />
        <label htmlFor={`say-${storyId}`} className="sr-only">
          Add to the conversation
        </label>
        <input
          id={`say-${storyId}`}
          name="body"
          required
          maxLength={2000}
          autoComplete="off"
          placeholder={
            viewerRole === "admin"
              ? "Ask a question, or say what you changed…"
              : `Reply to ${ownerName}…`
          }
          className="min-w-[200px] flex-[1_1_260px] rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[11px] text-[16px] text-ink placeholder:text-ink-3"
        />
        <button
          type="submit"
          className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-aqua px-[24px] py-[11px] text-[15px] font-bold text-ink hover:bg-sun"
        >
          Send
        </button>
      </form>
    </section>
  );
}

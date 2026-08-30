import { withdrawStory } from "@/app/actions/stories";

/**
 * "Actually, never mind."
 *
 * Shown only to the person who asked for the print, and only before it reaches
 * the bed — `Requested` (untouched), `Accepted` (agreed, not started) or
 * `Declined` (already dead). Once it is Printing the material is committed, so
 * the control is withdrawn (FRR-101). The server action re-checks; drawing a
 * button is not authorisation.
 *
 * Behind a disclosure, and it says plainly that the file goes too, because
 * this is the one action in the app that destroys something. Everything else
 * moves a ticket along or marks it; this removes it, the conversation with it,
 * and the uploaded geometry from storage.
 *
 * The trigger is a *button*, in the same enamel shape as Decline and Flag in
 * `admin-actions.tsx`. It used to be drawn with a transparent border and muted
 * text, growing an outline only on hover — which meant it read as a caption
 * rather than a control, and read as one directly above "Print again", which
 * is a full button. People could not find it. A destructive action being the
 * quietest thing on the page is the wrong way round: hard to *fire* by
 * accident is the goal, not hard to *locate*.
 *
 * So it carries colour as well as shape — cherry-wash with cherry-dark text
 * (5.1:1), going solid on hover. That keeps the two steps legible as an
 * escalation: an outlined red button opens the drawer, a filled red one
 * commits. Tone is carried by the fill *and* by the word, never by colour
 * alone, which is the rule the notices follow.
 */
export function WithdrawStory({
  storyId,
  label,
  from,
}: {
  storyId: number;
  /** The display ref, e.g. "PPP-104". NOT named `ref` — React reserves that,
   *  and in a server component the element is dropped rather than rendered. */
  label: string;
  from: string;
}) {
  return (
    <details className="mt-[17.6px]">
      <summary className="stamp inline-block cursor-pointer list-none rounded-chip border-[3px] border-ink bg-cherry-wash px-[15px] py-[8px] text-[14px] font-bold text-cherry-dk hover:bg-cherry-dk hover:text-cream">
        Withdraw this request
      </summary>
      <form action={withdrawStory} className="mt-[8px]">
        <input type="hidden" name="storyId" value={storyId} />
        <input type="hidden" name="from" value={from} />
        <div className="rounded-card border-[3px] border-ink bg-cherry-wash p-[13.2px]">
          <p className="m-0 mb-[11px] text-[13.5px] leading-[1.45] text-ink">
            Removes {label} for good — the ticket, anything said on it,
            and the model file itself. There is no undo, and re-uploading is
            the only way back.
          </p>
          <button
            type="submit"
            className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[17.6px] py-[7px] font-mono text-[11.5px] font-bold uppercase text-cream hover:bg-cherry"
          >
            Yes, withdraw it
          </button>
        </div>
      </form>
    </details>
  );
}

import { withdrawStory } from "@/app/actions/stories";

/**
 * "Actually, never mind."
 *
 * Shown only to the person who asked for the print, and only while nobody has
 * acted on it — `Requested` (still in the queue untouched) or `Declined`
 * (already dead). The server action re-checks both; drawing a button is not
 * authorisation.
 *
 * Behind a disclosure, and it says plainly that the file goes too, because
 * this is the one action in the app that destroys something. Everything else
 * moves a ticket along or marks it; this removes it, the conversation with it,
 * and the uploaded geometry from storage.
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
      <summary className="inline-block cursor-pointer list-none rounded-chip border-[3px] border-transparent px-[13.2px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink-2 hover:border-ink hover:bg-cream-2">
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

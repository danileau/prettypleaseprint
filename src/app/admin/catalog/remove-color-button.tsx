"use client";

import { removeColorAction } from "./actions";

export function RemoveColorButton({
  id,
  name,
  materialName,
}: {
  id: string;
  name: string;
  materialName: string;
}) {
  return (
    <form
      action={removeColorAction}
      onSubmit={(event) => {
        if (!window.confirm(`Remove ${name} from ${materialName}? Old tickets will be kept.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        aria-label={`Remove ${name} from ${materialName}`}
        className="cursor-pointer rounded-chip border-2 border-ink bg-cherry-wash px-[10px] py-[4px] font-mono text-[10.5px] font-bold uppercase text-cherry-dk hover:bg-cherry hover:text-cream"
      >
        Delete
      </button>
    </form>
  );
}

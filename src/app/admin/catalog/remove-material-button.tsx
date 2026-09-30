"use client";

import { removeMaterialAction } from "./actions";

export function RemoveMaterialButton({ id, name }: { id: string; name: string }) {
  return (
    <form
      action={removeMaterialAction}
      onSubmit={(event) => {
        if (!window.confirm(`Remove ${name} and all of its colours? Old tickets will be kept.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-wash px-[13px] py-[5px] font-mono text-[11px] font-bold uppercase text-cherry-dk hover:bg-cherry hover:text-cream"
      >
        Remove
      </button>
    </form>
  );
}

"use client";

import { useState } from "react";

/**
 * A link for the admin to pass on by hand.
 *
 * Shown only when there was nowhere to mail it. Selectable text first and a
 * copy button second: `navigator.clipboard` needs a secure context and a
 * permission that can be refused, so the button is the convenience and the
 * readable field is the guarantee.
 */
export function HandoverLink({ url, note }: { url: string; note: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-[13.2px] rounded-card border-[3px] border-ink bg-sun p-[13.2px]">
      <p className="m-0 mb-[8px] font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink">
        Hand this over — {note}
      </p>
      <div className="flex flex-wrap gap-[8px]">
        <input
          readOnly
          value={url}
          aria-label="Sign-in link to pass on"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-[220px] flex-[1_1_320px] rounded-[8px] border-[3px] border-ink bg-porcelain px-[11px] py-[7px] font-mono text-[12px] text-ink"
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // No clipboard permission — the field above is still selectable.
            }
          }}
          className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[7px] text-[13.5px] font-bold text-ink hover:bg-cream-2"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="m-0 mt-[8px] text-[13px] text-ink-2">
        Nobody was emailed — there is no mail server configured. Send this to
        them however you normally would.
      </p>
    </div>
  );
}

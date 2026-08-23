"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { reissueAccessAction, type InviteFormState } from "@/app/admin/invites/actions";
import { HandoverLink } from "@/components/handover-link";
import { Notice } from "@/components/ui";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink hover:bg-sun disabled:opacity-50"
    >
      {pending ? "Minting…" : "New way in"}
    </button>
  );
}

/**
 * "I wiped my phone and the passkey went with it."
 *
 * Also the answer when the mail server is down, which is exactly when you
 * cannot email someone a link. Sits behind a disclosure because it is not an
 * everyday action and it signs whoever holds the link in as that person.
 */
export function ReissueAccess({ userId, name }: { userId: string; name: string }) {
  const [state, formAction] = useActionState<InviteFormState, FormData>(
    reissueAccessAction,
    {},
  );

  return (
    <details>
      <summary className="inline-block cursor-pointer list-none rounded-chip border-[3px] border-transparent px-[13.2px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink-2 hover:border-ink hover:bg-cream-2">
        Lost access?
      </summary>
      <form action={formAction} className="mt-[8px] max-w-[560px]">
        <input type="hidden" name="userId" value={userId} />
        <div className="rounded-card border-[3px] border-ink bg-cream-2 p-[11px]">
          <p className="m-0 mb-[8px] text-[13.5px] leading-[1.45] text-ink-2">
            Mints a single-use link that signs {name} in, valid ten minutes.
            It is recorded in the audit log.
          </p>
          <Submit />
        </div>
        {state.handoverUrl && (
          <HandoverLink url={state.handoverUrl} note="works once, expires in 10 minutes" />
        )}
        {state.error && (
          <div className="mt-[8px]">
            <Notice tone="warn">{state.error}</Notice>
          </div>
        )}
      </form>
    </details>
  );
}

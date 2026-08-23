"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { setMemberAccessAction, type InviteFormState } from "@/app/admin/invites/actions";
import { Notice } from "@/components/ui";

function Submit({ revoke, name }: { revoke: boolean; name: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        revoke
          ? "stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-wash px-[15px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-cherry-dk hover:bg-cherry hover:text-cream disabled:opacity-50"
          : "stamp cursor-pointer rounded-chip border-[3px] border-ink bg-mint px-[15px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink hover:bg-aqua disabled:opacity-50"
      }
    >
      {pending ? "Working…" : revoke ? `Revoke ${name}'s access` : `Restore ${name}'s access`}
    </button>
  );
}

/**
 * "They have left, and should not be able to get back in."
 *
 * Suspension, not deletion: their tickets, comments and audit trail stay
 * exactly where they are. Behind a disclosure because it is not an everyday
 * action, and it takes effect the moment it is pressed — including on the
 * session they are using right now.
 */
export function MemberAccess({
  userId,
  name,
  suspended,
}: {
  userId: string;
  name: string;
  suspended: boolean;
}) {
  const [state, formAction] = useActionState<InviteFormState, FormData>(
    setMemberAccessAction,
    {},
  );

  return (
    <details>
      <summary className="inline-block cursor-pointer list-none rounded-chip border-[3px] border-transparent px-[13.2px] py-[6px] font-mono text-[11.5px] font-bold uppercase text-ink-2 hover:border-ink hover:bg-cream-2">
        {suspended ? "Suspended" : "Revoke access?"}
      </summary>
      <form action={formAction} className="mt-[8px] max-w-[560px]">
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="revoke" value={suspended ? "false" : "true"} />
        <div className="rounded-card border-[3px] border-ink bg-cream-2 p-[11px]">
          <p className="m-0 mb-[8px] text-[13.5px] leading-[1.45] text-ink-2">
            {suspended ? (
              <>
                {name} cannot sign in. Restoring lets them back in with the
                password or passkey they already had — nothing was deleted.
              </>
            ) : (
              <>
                Signs {name} out everywhere and refuses any new sign-in. Their
                tickets, comments and history stay exactly as they are, and you
                can restore access at any time. Recorded in the audit log.
              </>
            )}
          </p>
          <Submit revoke={!suspended} name={name} />
        </div>
        {state.error && (
          <div className="mt-[8px]">
            <Notice tone="warn">{state.error}</Notice>
          </div>
        )}
      </form>
    </details>
  );
}

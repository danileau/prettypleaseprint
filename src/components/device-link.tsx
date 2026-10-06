"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { deviceLinkAction, type InviteFormState } from "@/app/admin/invites/actions";
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
      {pending ? "Minting…" : "Make the link"}
    </button>
  );
}

/**
 * "New phone", "cleared my cookies", "can I use the laptop too?"
 *
 * Members have no password, so this is how one more device gets in: a
 * single-use link that signs whoever opens it in as that member. Same shape
 * and same colour as the reset control it replaces for members — it mints a
 * link and takes nothing away.
 */
export function DeviceLink({
  userId,
  name,
  expiresInMinutes,
}: {
  userId: string;
  name: string;
  expiresInMinutes: number;
}) {
  const [state, formAction] = useActionState<InviteFormState, FormData>(deviceLinkAction, {});

  return (
    <details>
      <summary className="stamp inline-block cursor-pointer list-none rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun">
        Link a device
      </summary>
      <form action={formAction} className="mt-[8px] max-w-[560px]">
        <input type="hidden" name="userId" value={userId} />
        <div className="rounded-card border-[3px] border-ink bg-cream-2 p-[11px]">
          <p className="m-0 mb-[8px] text-[13.5px] leading-[1.45] text-ink-2">
            Mints a single-use link that signs one more device in as {name},
            valid {expiresInMinutes} minutes. Whoever opens it <em>becomes</em>{" "}
            {name} on that device, so hand it to them and nobody else. Their
            other devices stay signed in, and it is recorded in the audit log.
          </p>
          <Submit />
        </div>
        {state.sent && !state.handoverUrl && (
          <div className="mt-[8px]">
            <Notice tone="good">
              Sent to {state.sent}. The link is inside the message and nowhere
              else — not even here.
            </Notice>
          </div>
        )}
        {state.handoverUrl && (
          <HandoverLink
            url={state.handoverUrl}
            note={`works once, expires in ${expiresInMinutes} minutes`}
          />
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

"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { sendInviteAction, type InviteFormState } from "./actions";
import { Button, Input, Label, Notice } from "@/components/ui";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Sending…" : "Send the invite"}
    </Button>
  );
}

export function InviteForm() {
  const [state, formAction] = useActionState<InviteFormState, FormData>(
    sendInviteAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.sent) formRef.current?.reset();
  }, [state.sent]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-panel border-[3px] border-ink bg-aqua-wash p-[22px] shadow-stamp"
    >
      <h2 className="m-0 mb-[4px] font-display text-[22px] text-ink">
        Invite someone
      </h2>
      <p className="m-0 mb-[17.6px] text-[14.5px] text-ink-2">
        They get a link that works once and expires in a week. There is no other
        way in.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[17.6px]">
        <div>
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="ayla@office.example"
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="invite-name">Name (optional)</Label>
          <Input
            id="invite-name"
            name="name"
            maxLength={80}
            placeholder="Ayla Berg"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="mt-[17.6px] flex flex-wrap items-center gap-[13.2px]">
        <Submit />
        {state.sent && (
          <span className="rounded-chip border-2 border-ink bg-mint px-[11px] py-[3px] font-mono text-[11.5px] font-bold uppercase text-ink">
            Sent · {state.sent} has been emailed a link
          </span>
        )}
      </div>

      {state.error && (
        <div className="mt-[13.2px]">
          <Notice tone="warn">{state.error}</Notice>
        </div>
      )}
    </form>
  );
}

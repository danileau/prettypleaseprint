"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { acceptInvite, type ClaimState } from "./actions";
import { Button, Input, Label, Notice } from "@/components/ui";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Setting you up…" : "That's me — let me in"}
    </Button>
  );
}

export function ClaimForm({
  token,
  email,
  suggestedName,
}: {
  token: string;
  email: string;
  suggestedName: string;
}) {
  const [state, formAction] = useActionState<ClaimState, FormData>(
    acceptInvite,
    {},
  );
  const failed = state.field === "name" && state.error;

  return (
    <form action={formAction} className="flex flex-col gap-[17.6px]">
      <input type="hidden" name="token" value={token} />

      <div>
        <Label htmlFor="email">Your email</Label>
        {/* Fixed: the invite is bound to this address. Showing it disabled is
            clearer than hiding it — people want to know which inbox they are. */}
        <Input id="email" value={email} disabled readOnly />
        <p className="mt-[6px] font-mono text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
          The invite is tied to this address and cannot be moved to another.
        </p>
      </div>

      <div>
        <Label htmlFor="name">What should we call you?</Label>
        <Input
          // React resets a form after its action runs; keying on the echoed
          // name puts back what was typed when it comes back refused.
          key={state.name ?? ""}
          id="name"
          name="name"
          required
          maxLength={80}
          defaultValue={state.name ?? suggestedName}
          placeholder="Ayla Berg"
          autoComplete="name"
          autoFocus
          aria-describedby="name-hint"
          aria-invalid={failed ? true : undefined}
        />
        <p
          id="name-hint"
          className={`mt-[6px] text-[12.5px] leading-[1.4] ${
            failed ? "font-bold text-cherry-dk" : "font-mono uppercase tracking-[0.04em] text-ink-3"
          }`}
        >
          {failed ? state.error : "Shown on your tickets and in the conversation."}
        </p>
      </div>

      {/* Anything the field could not carry: a revoked invite, a server that
          fell over. */}
      {state.error && !state.field && <Notice tone="warn">{state.error}</Notice>}

      <Submit />
    </form>
  );
}

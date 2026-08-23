"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { acceptInvite, type ClaimState } from "./actions";
import { Button, Input, Label, Notice } from "@/components/ui";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Setting you up…" : "Claim your account"}
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

  return (
    <form action={formAction} className="flex flex-col gap-[17.6px]">
      <input type="hidden" name="token" value={token} />

      <div>
        <Label htmlFor="email">Your email</Label>
        {/* Fixed: the invite is bound to this address. Showing it disabled is
            clearer than hiding it — people want to know which inbox they are. */}
        <Input id="email" value={email} disabled readOnly />
        <p className="mt-[6px] text-[13px] text-muted">
          The invite is tied to this address and cannot be moved to another.
        </p>
      </div>

      <div>
        <Label htmlFor="name">What should we call you?</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={80}
          defaultValue={suggestedName}
          placeholder="Ayla Berg"
          autoComplete="name"
        />
      </div>

      {state.error && <Notice tone="warn">{state.error}</Notice>}

      <Submit />
    </form>
  );
}

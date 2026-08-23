"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { acceptInvite, type ClaimState } from "./actions";
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "@/lib/auth-rules";
import { Button, Input, Label, Notice } from "@/components/ui";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Setting you up…" : "Create your account"}
    </Button>
  );
}

/** The hint under a field, or the error if this is the field that failed. */
function Hint({
  state,
  field,
  children,
}: {
  state: ClaimState;
  field: NonNullable<ClaimState["field"]>;
  children: React.ReactNode;
}) {
  const failed = state.field === field && state.error;
  return (
    <p
      id={`${field}-hint`}
      className={`mt-[6px] text-[12.5px] leading-[1.4] ${
        failed ? "font-bold text-cherry-dk" : "font-mono uppercase tracking-[0.04em] text-ink-3"
      }`}
    >
      {failed ? state.error : children}
    </p>
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
        <p className="mt-[6px] font-mono text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
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
          aria-describedby="name-hint"
          aria-invalid={state.field === "name" || undefined}
        />
        <Hint state={state} field="name">
          Shown on your tickets and in the conversation.
        </Hint>
      </div>

      <div>
        <Label htmlFor="username">Pick a username</Label>
        <Input
          id="username"
          name="username"
          required
          minLength={USERNAME_MIN}
          maxLength={USERNAME_MAX}
          pattern="[A-Za-z0-9_\-]+"
          placeholder="ayla"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="username-hint"
          aria-invalid={state.field === "username" || undefined}
        />
        <Hint state={state} field="username">
          What you sign in with — letters, digits, - and _
        </Hint>
      </div>

      <div>
        <Label htmlFor="password">And a password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN}
          autoComplete="new-password"
          aria-describedby="password-hint"
          aria-invalid={state.field === "password" || undefined}
        />
        <Hint state={state} field="password">
          At least {PASSWORD_MIN} characters. Length beats punctuation.
        </Hint>
      </div>

      {/* Anything the fields could not carry: a revoked invite, a refused
          breach check, a server that fell over. */}
      {state.error && !state.field && <Notice tone="warn">{state.error}</Notice>}

      <Submit />
    </form>
  );
}

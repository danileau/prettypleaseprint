"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { linkDevice, type DeviceState } from "./actions";
import { Button, Notice } from "@/components/ui";

function Submit({ firstName }: { firstName: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Signing this device in…" : `I'm ${firstName} — sign this device in`}
    </Button>
  );
}

export function DeviceForm({ token, firstName }: { token: string; firstName: string }) {
  const [state, formAction] = useActionState<DeviceState, FormData>(linkDevice, {});
  return (
    <form action={formAction} className="flex flex-col gap-[17.6px]">
      <input type="hidden" name="token" value={token} />
      {state.error && <Notice tone="warn">{state.error}</Notice>}
      <Submit firstName={firstName} />
    </form>
  );
}

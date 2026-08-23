"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Input, Label, Notice } from "@/components/ui";

type Phase = "idle" | "sending" | "sent";

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    setPasskeySupported(true);

    // Conditional UI: if the browser already holds a passkey for this site it
    // offers it straight from the email field, with no click at all. Browsers
    // without support simply never resolve this, which is why it is fire and
    // forget.
    void authClient.signIn.passkey({ autoFill: true }).then((res) => {
      if (res && !res.error) window.location.assign(next);
    });
  }, [next]);

  async function signInWithPasskey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      setError(
        res.error.message ??
          "That passkey was not accepted. Try the email link instead.",
      );
      return;
    }
    window.location.assign(next);
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase("sending");

    const { error } = await authClient.signIn.magicLink({
      email: email.trim().toLowerCase(),
      callbackURL: next,
    });

    // Deliberately identical UI whether or not the address has an account.
    // Telling a stranger "no such user" turns this form into a membership
    // oracle for the office.
    if (error && error.status !== 403) {
      setPhase("idle");
      setError("Something went wrong sending that link. Try again in a moment.");
      return;
    }
    setPhase("sent");
  }

  if (phase === "sent") {
    return (
      <div className="flex flex-col gap-[17.6px]">
        <Notice tone="good">
          If <strong>{email}</strong> belongs to someone here, a sign-in link is
          on its way. It works once and expires in 10 minutes.
        </Notice>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className="self-start text-[14px] font-semibold text-muted-2 hover:text-teal-700"
        >
          ← Use a different address
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      {passkeySupported && (
        <>
          <Button type="button" onClick={signInWithPasskey} className="w-full">
            Sign in with a passkey
          </Button>
          <div className="flex items-center gap-[13.2px]">
            <span className="h-px flex-1 bg-rule" />
            <span className="text-[12.5px] font-semibold text-muted">or</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
        </>
      )}

      <form onSubmit={sendLink} className="flex flex-col gap-[13.2px]">
        <div>
          <Label htmlFor="email">Your email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username webauthn"
            placeholder="ayla@office.example"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={phase === "sending"} className="w-full">
          {phase === "sending" ? "Sending…" : "Email me a link"}
        </Button>
      </form>

      {error && <Notice tone="warn">{error}</Notice>}

      <p className="m-0 text-[13px] leading-[1.5] text-muted">
        Pretty Please Print is invite-only — there is no sign-up. If you have not
        been invited yet, ask whoever owns the printer for a link.
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Input, Label, Notice } from "@/components/ui";
import { OrRule, SsoButton } from "@/components/sso-button";

/**
 * One message for every way a sign-in can fail.
 *
 * Distinguishing "no such username" from "wrong password" turns this form
 * into a membership oracle for the office, and there is nothing the person at
 * the keyboard can do with the difference anyway.
 */
const REFUSED = "That username and password do not match. Try again.";

export function SignInForm({
  next,
  local,
  ssoName,
}: {
  next: string;
  /** Are passwords and passkeys on for this deployment? */
  local: boolean;
  /** What the single sign-on provider is called, or null when it is off. */
  ssoName: string | null;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    // No passkeys where local sign-in is off: the endpoints refuse, and a
    // browser offering one would be offering something that cannot work.
    if (!local) return;
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    setPasskeySupported(true);

    // Conditional UI: if the browser already holds a passkey for this site it
    // offers it straight from the username field, with no click at all.
    // Browsers without support simply never resolve this, which is why it is
    // fire and forget.
    void authClient.signIn.passkey({ autoFill: true }).then((res) => {
      if (res && !res.error) window.location.assign(next);
    });
  }, [next, local]);

  async function signInWithPasskey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      setError(
        res.error.message ??
          "That passkey was not accepted. Use your password instead.",
      );
      return;
    }
    window.location.assign(next);
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const { error } = await authClient.signIn.username({
      username: username.trim().toLowerCase(),
      password,
    });

    if (error) {
      setBusy(false);
      // 429 is worth saying out loud: "wrong password" would send someone
      // hunting for a typo that is not there.
      setError(
        error.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : REFUSED,
      );
      return;
    }
    window.location.assign(next);
  }

  return (
    <div className="flex flex-col gap-[22px]">
      {/* Single sign-on first where it is on: it is the way in that asks for
          nothing, and where it is the only way in it is the whole form. */}
      {ssoName && (
        <>
          <SsoButton label={`Sign in with ${ssoName}`} next={next} />
          {local && <OrRule />}
        </>
      )}

      {local && passkeySupported && (
        <>
          <Button
            type="button"
            variant={ssoName ? "secondary" : "primary"}
            onClick={signInWithPasskey}
            className="w-full"
          >
            Sign in with a passkey
          </Button>
          <OrRule />
        </>
      )}

      {local && (
      <form onSubmit={signInWithPassword} className="flex flex-col gap-[13.2px]">
        <div>
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            required
            // "webauthn" is what lets conditional UI offer a passkey from this
            // field before a single character is typed.
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="ayla"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {/* Secondary on purpose: one primary per screen, and the passkey is
            the path worth pushing people onto. */}
        <Button
          type="submit"
          variant="secondary"
          disabled={busy}
          className="w-full"
        >
          {busy ? "Checking…" : "Sign in"}
        </Button>
      </form>
      )}

      {error && <Notice tone="warn">{error}</Notice>}

      <p className="m-0 border-t-2 border-dashed border-rule pt-[13.2px] text-[13.5px] leading-[1.5] text-ink-2">
        {local
          ? "Pretty Please Print is invite-only — there is no sign-up. If you have not been invited yet, or you have forgotten your password, ask whoever owns the printer."
          : "Pretty Please Print is invite-only. If signing in tells you that you have not been invited, ask whoever owns the printer."}
      </p>
    </div>
  );
}

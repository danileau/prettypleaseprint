"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, Input, Label, Notice } from "@/components/ui";
import { OrRule, SsoButton } from "@/components/sso-button";

/**
 * The re-authentication ceremony.
 *
 * Both paths sign in again — Better Auth has no way to assert an identity
 * without minting a session — and the gate reads the age of the session that
 * comes back. See `src/lib/reauth.ts`.
 *
 * The password is offered as well as the passkey, deliberately. Every account
 * has a password by construction and only some have a passkey, so gating these
 * actions on a passkey alone would leave an admin without one unable to revoke
 * access — a lockout on the most safety-critical control in the app.
 *
 * Single sign-on is a third path where it is on, and for somebody who has only
 * ever signed in that way it is the only one: they have no password to type.
 * It is exactly as strong as the provider's willingness to ask again — a
 * provider that waves through whoever holds its session confirms nothing. See
 * `OIDC_PROMPT` in `src/lib/auth-methods.ts`.
 */
export function ReauthForm({
  next,
  username,
  displayUsername,
  local,
  ssoName,
}: {
  next: string;
  username: string;
  displayUsername: string;
  local: boolean;
  ssoName: string | null;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);
  // Somebody who came in through single sign-on and never chose a username has
  // no password to be asked for; showing them the box would be a dead end.
  const hasPassword = local && username !== "";

  useEffect(() => {
    if (local && typeof window !== "undefined" && window.PublicKeyCredential) {
      setPasskeySupported(true);
    }
  }, [local]);

  async function withPasskey() {
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

  async function withPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const { error } = await authClient.signIn.username({ username, password });
    if (error) {
      setBusy(false);
      setError(
        error.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That password does not match. Try again.",
      );
      return;
    }
    window.location.assign(next);
  }

  return (
    <div className="flex flex-col gap-[22px]">
      {ssoName && (
        <>
          <SsoButton label={`Confirm with ${ssoName}`} next={next} />
          {hasPassword && <OrRule />}
        </>
      )}

      {local && passkeySupported && (
        <>
          <Button
            type="button"
            variant={ssoName ? "secondary" : "primary"}
            onClick={withPasskey}
            className="w-full"
          >
            Confirm with a passkey
          </Button>
          {hasPassword && <OrRule />}
        </>
      )}

      {hasPassword && (
      <form onSubmit={withPassword} className="flex flex-col gap-[13.2px]">
        {/* Named and readable, so a password manager fills the right entry —
            and so it is obvious which account is being confirmed. */}
        <input type="hidden" name="username" value={username} autoComplete="username" />
        <div>
          <Label htmlFor="password">Password for {displayUsername}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={busy} className="w-full">
          {busy ? "Checking…" : "Confirm"}
        </Button>
      </form>
      )}

      {error && <Notice tone="warn">{error}</Notice>}
    </div>
  );
}

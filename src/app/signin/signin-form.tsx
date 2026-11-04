"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { Button, Input, Label, Notice } from "@/components/ui";

export function SignInForm({ next }: { next: string }) {
  const t = useTranslations("signin.form");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    setPasskeySupported(true);

    // Conditional UI: if the browser already holds a passkey for this site it
    // offers it straight from the username field, with no click at all.
    // Browsers without support simply never resolve this, which is why it is
    // fire and forget.
    void authClient.signIn.passkey({ autoFill: true }).then((res) => {
      if (res && !res.error) window.location.assign(next);
    });
  }, [next]);

  async function signInWithPasskey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      // Better Auth's own message when it has one, which is English: it comes
      // from the library, not from a catalogue this app owns.
      setError(res.error.message ?? t("passkeyRefused"));
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
      //
      // Otherwise one message for every way a sign-in can fail.
      // Distinguishing "no such username" from "wrong password" turns this
      // form into a membership oracle for the office, and there is nothing the
      // person at the keyboard can do with the difference anyway.
      setError(error.status === 429 ? t("tooManyAttempts") : t("refused"));
      return;
    }
    window.location.assign(next);
  }

  return (
    <div className="flex flex-col gap-[22px]">
      {passkeySupported && (
        <>
          <Button type="button" onClick={signInWithPasskey} className="w-full">
            {t("withPasskey")}
          </Button>
          <div className="flex items-center gap-[13.2px]">
            <span className="h-[3px] flex-1 rounded-full bg-ink" />
            <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.14em] text-ink-3">{t("or")}</span>
            <span className="h-[3px] flex-1 rounded-full bg-ink" />
          </div>
        </>
      )}

      <form onSubmit={signInWithPassword} className="flex flex-col gap-[13.2px]">
        <div>
          <Label htmlFor="username">{t("username")}</Label>
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
          <Label htmlFor="password">{t("password")}</Label>
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
          {busy ? t("checking") : t("submit")}
        </Button>
      </form>

      {error && <Notice tone="warn">{error}</Notice>}

      <p className="m-0 border-t-2 border-dashed border-rule pt-[13.2px] text-[13.5px] leading-[1.5] text-ink-2">
        {t("inviteOnly")}
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { authClient } from "@/lib/auth-client";
import { OIDC_PROVIDER_ID } from "@/lib/auth-methods";
import { Button, Notice } from "@/components/ui";

/**
 * Hand the browser to the identity provider, and come back signed in.
 *
 * One component for the three places single sign-on is offered — signing in,
 * accepting an invitation, and confirming it is still you — because they are
 * the same act: there is nothing to type here, so there is nothing to vary but
 * the words on the button and where to land afterwards.
 *
 * A failure at the provider's end comes back to `/signin`, which knows how to
 * say what went wrong. The only failure this component can see is the one
 * before the browser leaves: the app refusing to start the flow at all.
 *
 * Its words, and the rule's below, are the `waysIn` group, which every screen
 * that renders them sends (src/i18n/client-groups.ts). The label is the
 * screen's own, picked on the server.
 */
export function SsoButton({
  label,
  next,
  variant = "primary",
}: {
  label: string;
  /** Where to land once signed in. Already passed through `safeRedirect`. */
  next: string;
  variant?: "primary" | "secondary";
}) {
  const t = useTranslations("waysIn.sso");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    setBusy(true);
    const { error } = await authClient.signIn.social({
      provider: OIDC_PROVIDER_ID,
      callbackURL: next,
      errorCallbackURL: "/signin",
    });
    // On success the browser is already on its way to the provider.
    if (error) {
      setBusy(false);
      setError(error.status === 429 ? t("tooManyAttempts") : t("couldNotStart"));
    }
  }

  return (
    <div className="flex flex-col gap-[13.2px]">
      <Button type="button" variant={variant} onClick={go} disabled={busy} className="w-full">
        {busy ? t("busy") : label}
      </Button>
      {error && <Notice tone="warn">{error}</Notice>}
    </div>
  );
}

/** The "or" rule the sign-in screens put between two ways in. */
export function OrRule() {
  const t = useTranslations("waysIn");
  return (
    <div className="flex items-center gap-[13.2px]">
      <span className="h-[3px] flex-1 rounded-full bg-ink" />
      <span className="font-mono text-[11.5px] font-bold uppercase tracking-[0.14em] text-ink-3">{t("or")}</span>
      <span className="h-[3px] flex-1 rounded-full bg-ink" />
    </div>
  );
}

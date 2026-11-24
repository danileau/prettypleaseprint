import { getLocale, getMessages, getTranslations } from "next-intl/server";

/**
 * What `relativeTime` (src/lib/catalog.ts) needs to write in this request's
 * language: the locale for `Intl.RelativeTimeFormat`, and the catalogue's
 * words for the first 45 seconds. Read on the server, where the times are
 * formatted — the header hands its menu finished strings, so nothing about
 * time goes to the browser as a message.
 */
export async function relativeTimeVoice(): Promise<{ locale: string; justNow: string }> {
  const [locale, t] = await Promise.all([getLocale(), getTranslations("time")]);
  return { locale, justNow: t("justNow") };
}

/**
 * This request's messages, cut down to the groups one screen's client
 * components use — what that screen hands to its `NextIntlClientProvider`.
 * Which groups, and why not all of them: ./client-groups.ts.
 */
export async function getClientMessages(groups: readonly string[]): Promise<Record<string, unknown>> {
  const all = (await getMessages()) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const path of groups) {
    const parts = path.split(".");
    let from: unknown = all;
    let to = out;
    parts.forEach((part, i) => {
      from = (from as Record<string, unknown> | undefined)?.[part];
      if (i === parts.length - 1) to[part] = from;
      else to = (to[part] ??= {}) as Record<string, unknown>;
    });
  }
  return out;
}

import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { currentUser } from "@/lib/authz";
import { db } from "@/lib/db";
import { instanceLocale } from "@/lib/settings";
import { catalogueFor, offeredLocales, pageMessageHandling } from "./catalogue";
import { resolveLocale } from "./locales";

/**
 * next-intl's per-request configuration: which language, and its messages.
 *
 * Found by the plugin in next.config.ts. There is no locale in the URL and no
 * next-intl middleware — every link, redirect and `next=` parameter in the app
 * stays exactly what it was — so the language is decided here, for each
 * request, by the one function that knows the order of preference
 * (`resolveLocale`, ./locales.ts): the person's choice, their browser's, the
 * instance's, English. The root layout's `<html lang>`, every
 * `getTranslations`, and next-intl's date, number and plural formatting all
 * read the locale returned here, so they cannot disagree.
 *
 * The person's choice costs one query for whoever is signed in: the session
 * is the page's own (`currentUser` is cached for the request, so this and the
 * page's `requireUser` are one session read), and the column one more read.
 * Not part of the session: Better Auth's session carries only the fields it is
 * told about, and putting this one there would put it on its JSON endpoints
 * too, for one query saved. The instance's default is the settings row's
 * primary-key lookup (`instanceLocale`, src/lib/settings.ts), read per
 * request like every setting there, so a change on /admin/settings applies to
 * the next page; it is read beside the session, not after it.
 *
 * A message that fails to format shows English, never its key
 * (`pageMessageHandling`, ./catalogue.ts) — and a translated one that cannot
 * be formatted at all was already replaced by English when the catalogue was
 * loaded, so it is formatted with the page's values like any other English.
 *
 * Reading `headers()` makes the root layout dynamic. Every page already was:
 * middleware.ts mints a CSP nonce per request, and Next stamps it onto its own
 * inline scripts, which no static page could carry.
 */
export default getRequestConfig(async () => {
  const [user, requestHeaders, instanceDefault] = await Promise.all([currentUser(), headers(), instanceLocale()]);
  const row = user
    ? await db.user.findUnique({ where: { id: user.id }, select: { preferredLocale: true } })
    : null;
  const chosen = resolveLocale({
    preference: row?.preferredLocale,
    acceptLanguage: requestHeaders.get("accept-language"),
    instanceDefault,
    offered: offeredLocales(),
  });
  // The locale the catalogue turned out to be, not the one asked for: if a
  // file fails to load, the page is English and must say so in `lang`.
  const { locale, messages } = await catalogueFor(chosen);
  return { locale, messages, ...pageMessageHandling };
});

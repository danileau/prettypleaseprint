import type en from "../../messages/en.json";

/**
 * Makes every message key a type. `t("signin.titel")` — or a key that was
 * removed from en.json while a component still asks for it — fails
 * `npm run typecheck` instead of rendering the key's name on a page.
 *
 * Typed from English because English is the source of truth; a translation
 * is held to the same shape by `npm run check:messages`.
 *
 * The locale is not typed: it is any file in messages/ (./catalogue.ts), and a
 * union written here would be the list of languages in code that adding one
 * must not need. next-intl's own default, `string`, is what it is.
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof en;
  }
}

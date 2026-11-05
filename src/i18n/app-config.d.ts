import type en from "../../messages/en.json";
import type { Locale } from "./locales";

/**
 * Makes every message key a type. `t("signin.titel")` — or a key that was
 * removed from en.json while a component still asks for it — fails
 * `npm run typecheck` instead of rendering the key's name on a page.
 *
 * Typed from English because English is the source of truth; a translation
 * is held to the same shape by `npm run check:messages`.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}

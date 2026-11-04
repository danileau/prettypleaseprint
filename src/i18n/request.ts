import { getRequestConfig } from "next-intl/server";

import en from "../../messages/en.json";
import { DEFAULT_LOCALE } from "./locales";

/**
 * next-intl's per-request configuration: which language, and its messages.
 *
 * Found by the plugin in next.config.ts. There is no locale in the URL and no
 * next-intl middleware — every link, redirect and `next=` parameter in the app
 * stays exactly what it was — so the language is decided here, for each
 * request. Today that decision has one answer; the order a second language
 * would be chosen in is written down in ./locales.ts.
 */
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: en,
}));

import { createTranslator } from "next-intl";

import en from "../../messages/en.json";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales";

/**
 * A catalogue for one person rather than for one request — what an email is
 * written in. The request's language comes from ./request.ts; an email has no
 * request, only a recipient, and is written in *their* language
 * (`User.preferredLocale`), whoever caused it to be sent.
 *
 * Only a language in `LOCALES` (./locales.ts) — the one list of what the app
 * speaks, the same the pages will choose from. Anything else is English, even
 * with a catalogue for it on disk. So is any key a translation does not have
 * yet: the translation is laid over English key by key (`overlay`, the one
 * place that is done — ./request.ts uses `catalogueFor` too once it chooses),
 * and a message that is there but cannot be formatted reads in English as
 * well (`translatorFor`). Never key names.
 */

export type Messages = typeof en;

/** `over` laid onto `base`: a string from `over` wherever `base` has one there. */
export function overlay<T>(base: T, over: unknown): T {
  if (typeof base === "string") return (typeof over === "string" && over !== "" ? over : base) as T;
  if (!base || typeof base !== "object") return base;
  const from = over && typeof over === "object" ? (over as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
    out[key] = overlay(value, Object.hasOwn(from, key) ? from[key] : undefined);
  }
  return out as T;
}

/**
 * The catalogue for `wanted`, over English, and the language it turned out to
 * be. Never throws: a language not offered, or a missing or broken file, is
 * English.
 *
 * The import is dynamic over `messages/`, so the bundler packs every catalogue
 * in that directory into the build (`full-test.sh` checks the built image
 * for each); `LOCALES` says which of them may be used.
 */
export async function catalogueFor(
  wanted: string | null | undefined,
): Promise<{ locale: string; messages: Messages }> {
  // Read at call time, not captured: LOCALES is the list, wherever it is read.
  if (!wanted || wanted === DEFAULT_LOCALE || !(LOCALES as readonly string[]).includes(wanted)) {
    return { locale: DEFAULT_LOCALE, messages: en };
  }
  try {
    const file = (await import(`../../messages/${wanted}.json`)) as { default?: unknown };
    return { locale: wanted, messages: overlay(en, file.default ?? file) };
  } catch {
    return { locale: DEFAULT_LOCALE, messages: en };
  }
}

const plain = (locale: string, messages: Messages, onError?: () => void) =>
  createTranslator({
    // Typed as the locales the UI offers; the cast is for the tests' extra one.
    locale: locale as Locale,
    messages,
    ...(onError ? { onError, getMessageFallback: () => "" } : {}),
  });

/** English, synchronously — for what is stored rather than sent. */
export const english = plain(DEFAULT_LOCALE, en);

export type Translator = typeof english;

/**
 * A translator over a whole catalogue, outside any request.
 *
 * A translated message that fails to format — a brace lost, a branch broken —
 * gives the English message for that key, formatted with the same values.
 * use-intl's own fallback is the key's path (`notification.storyMoved`), which
 * in a subject line is worse than English.
 */
export function translatorFor(catalogue: { locale: string; messages: Messages }): Translator {
  if (catalogue.locale === DEFAULT_LOCALE) return english;
  let failed = false;
  const local = plain(catalogue.locale, catalogue.messages, () => {
    failed = true;
  });
  const either = <A extends unknown[], R>(mine: (...a: A) => R, theirs: (...a: A) => R) =>
    (...args: A): R => {
      failed = false;
      const out = mine(...args);
      return failed ? theirs(...args) : out;
    };
  type Loose = (...a: unknown[]) => unknown;
  const loose = (f: unknown) => f as Loose;
  const t = either(loose(local), loose(english)) as unknown as Translator;
  Object.assign(t, {
    markup: either(loose(local.markup), loose(english.markup)),
    rich: either(loose(local.rich), loose(english.rich)),
    raw: local.raw,
    has: local.has,
  });
  return t;
}

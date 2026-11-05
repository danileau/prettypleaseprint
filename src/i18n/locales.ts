/**
 * What a language is, and how one is chosen for a request.
 *
 * Pure on purpose — no `next/headers`, no next-intl, no file system — so the
 * check scripts, the suites and the types in ./app-config.d.ts can import it
 * without dragging the request machinery along. Which languages there *are*
 * is not here: it is whatever sits in messages/, found by ./catalogue.ts.
 * docs/i18n.md is the guide.
 */

/**
 * English is the source: `messages/en.json` is the catalogue every other one
 * is checked against (`npm run check:messages`) and laid over, key by key,
 * and the language of last resort when nothing else applies.
 *
 * Not called the default, because "the default" is now something an instance
 * chooses (`DEFAULT_LOCALE`, ./catalogue.ts): this is what is left when it has
 * not, or has chosen a language this build does not have.
 */
export const SOURCE_LOCALE = "en";

/**
 * A language this app offers: the name of a file in messages/, without
 * `.json`. A string rather than a union, because the list is the directory and
 * no code spells it out; what a value may be is checked against the files
 * found (`offeredLocales` in ./catalogue.ts), never against a type.
 */
export type Locale = string;

/**
 * Whether a file's basename can name a language: a well-formed BCP 47 tag,
 * written the one way `Intl` writes it — `fr`, `pt-BR`, `zh-Hant-TW`.
 *
 * The canonical spelling only, not any spelling `Intl` would accept, so that a
 * language has exactly one code: the one stored in `User.preferredLocale`,
 * written into `<html lang>` and compared against the files. `pt-br.json`
 * beside `pt-BR.json` would otherwise be two languages that are one, and a
 * stored "pt-br" would silently stop matching the day the file was renamed.
 * `check:messages` says which spelling to use.
 */
export function isLanguageTag(code: string): boolean {
  try {
    return Intl.getCanonicalLocales(code)[0] === code;
  } catch {
    return false;
  }
}

/**
 * A language's name in that language — "Français", "Deutsch", "Português
 * (Brasil)" — for the picker on /me, or null where the runtime's ICU data has
 * no name for it (which `check:messages` refuses, so it does not ship).
 *
 * In its own words rather than the page's, because somebody looking for their
 * language is looking for the word they know, whatever the page around it is
 * written in — which is also why the names are not in any catalogue. And from
 * `Intl.DisplayNames` rather than a table, so that adding a language stays one
 * file: there is no list of names to keep beside the list of files.
 *
 * ICU gives most names in lower case ("français"), which is right mid-sentence
 * and wrong alone in a list; the first letter is raised with the language's own
 * rules (`toLocaleUpperCase(code)`), since that is not the same operation in
 * every language.
 */
export function languageName(code: string): string | null {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code);
  } catch {
    return null;
  }
  // `fallback: "none"` already gives undefined for a tag ICU does not know;
  // a name that is only the code again is no name either.
  if (!name || name.toLowerCase() === code.toLowerCase()) return null;
  const first = String.fromCodePoint(name.codePointAt(0)!);
  return first.toLocaleUpperCase(code) + name.slice(first.length);
}

/**
 * The ISO 639 codes that are not a language: undetermined, multiple
 * languages, no linguistic content, uncoded. ICU names two of them ("Multiple
 * languages", "No linguistic content"), so a name alone would let them in.
 */
const NOT_A_LANGUAGE = new Set(["und", "mul", "zxx", "mis"]);

/**
 * Why `messages/<code>.json` cannot be offered as a language, or null when it
 * can — the one rule, read by the app (`offeredLocales` in ./catalogue.ts,
 * which leaves such a file out and logs this once) and by `check:messages`
 * (which fails on it), so the two cannot disagree about what a language is.
 *
 * A language is a tag `Intl` accepts, spelt the way it writes it
 * (`isLanguageTag`), that is not one of the codes above, and that
 * `Intl.DisplayNames` has a name for: the picker shows that name and has
 * nothing else to show. That last test is what keeps `notes.json` or
 * `backup.json` out — five to eight letters is a well-formed tag, and ICU
 * simply has no language by that name.
 */
export function languageProblem(code: string): string | null {
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(code)[0] ?? "";
  } catch {
    return `"${code}" is not a BCP 47 language tag`;
  }
  if (!isLanguageTag(code)) return `"${code}" is written "${canonical}" — rename the file ${canonical}.json`;
  if (NOT_A_LANGUAGE.has(code.split("-")[0]!.toLowerCase())) {
    return `"${code}" is a code for no particular language (und, mul, zxx, mis), not a language`;
  }
  if (languageName(code) === null) return `Intl.DisplayNames has no name for "${code}" to show in the picker`;
  return null;
}

/**
 * Everything a language can be chosen from, trusted in this order — written
 * down here and nowhere else:
 *
 *   1. the person's own choice — `User.preferredLocale`, set on /me;
 *   2. what the browser asks for — `Accept-Language`;
 *   3. the instance's default — `DEFAULT_LOCALE` in the environment, until
 *      the settings page (#104) has a place for it;
 *   4. English.
 *
 * A person's choice beats their browser because they made it in this app; the
 * instance default comes after the browser because it is a guess about a
 * stranger, and the browser is better placed to make that guess. A signed-out
 * page has no person, so it starts at 2.
 *
 * Each of the first three counts only if it names a language in `offered`. A
 * `preferredLocale` saved for a language this build no longer has — its file
 * removed — is passed over for the next rule rather than served or failed on,
 * and the person's picker shows "Follow my browser", which is what they are
 * then getting.
 *
 * And a browser that refused a language (`fr;q=0`) is not served it as the
 * instance default either: the default is skipped for English. If English is
 * refused too, it is English all the same — every option is one the browser
 * said no to or did not ask for, and English is the least bad of them, being
 * the one catalogue with every key.
 */
export type LocaleSources = {
  preference: string | null | undefined;
  acceptLanguage: string | null | undefined;
  instanceDefault: Locale | null;
  offered: readonly Locale[];
};

export function resolveLocale({ preference, acceptLanguage, instanceDefault, offered }: LocaleSources): Locale {
  if (preference && offered.includes(preference)) return preference;
  const { locale, refuses } = negotiate(acceptLanguage, offered);
  if (locale) return locale;
  if (instanceDefault && !refuses(instanceDefault)) return instanceDefault;
  return SOURCE_LOCALE;
}

/**
 * The best of `offered` for an `Accept-Language` header — null when the
 * browser accepts none of them — and what it refused.
 *
 * Ranges are taken by quality, highest first, and in the order given when two
 * are equal — `de, fr;q=0.5` is French where there is no German, because French
 * was the next thing asked for. Each range is matched the way RFC 4647's
 * "lookup" does it: exactly first, then with its last subtag dropped, and so on
 * — `fr-CA` is `fr-CA.json` if there is one and `fr.json` otherwise, since a
 * reader in Québec is better served by the French there is than by English.
 * Case does not matter in the header; the code returned is the file's.
 *
 * `*` and `q=0` are honoured as "anything" and "never": `*` ends the search,
 * so the instance default decides, and a range with `q=0` refuses every
 * language it matches (`fr;q=0` refuses `fr` and `fr-CA`; `*;q=0` everything
 * not asked for). A refused language is never the answer — not by lookup
 * (`fr-CA, fr;q=0` with only `fr.json` is no match), and, through `refuses`,
 * not as the instance default (`resolveLocale`). `q` is matched in any case,
 * as RFC 9110 has it. Anything that does not parse is skipped rather than
 * guessed at, and only the
 * first few dozen ranges of a header are read: it comes from whoever sends the
 * request, and a malformed or enormous one must cost nothing and mean the
 * default, never a language nobody asked for.
 *
 * Written out rather than imported. next-intl's middleware does this with
 * `negotiator` and `@formatjs/intl-localematcher`, but this app does not run
 * its middleware (there is no locale in the URL), and those two are its
 * dependencies, not ours — importing a transitive package directly is how a
 * lockfile change breaks a build nobody touched.
 */
export function negotiate(
  header: string | null | undefined,
  offered: readonly Locale[],
): { locale: Locale | null; refuses: (code: Locale) => boolean } {
  const refused: string[] = [];
  const accepted: string[] = [];
  const covers = (range: string, code: Locale) => {
    const lower = code.toLowerCase();
    return lower === range || lower.startsWith(`${range}-`);
  };
  // Refused by name: `fr;q=0`. Lookup skips these.
  const named = (code: Locale) => refused.some((r) => r !== "*" && covers(r, code));
  // …or by `*;q=0`, which refuses whatever the header does not ask for.
  const refuses = (code: Locale) =>
    named(code) || (refused.includes("*") && !accepted.some((a) => a !== "*" && covers(a, code)));
  if (!header) return { locale: null, refuses };
  const byLowerCase = new Map(offered.map((code) => [code.toLowerCase(), code]));
  const ranges: Array<{ tag: string; q: number; at: number }> = [];
  header
    .slice(0, 1024)
    .split(",")
    .slice(0, 32)
    .forEach((part, at) => {
      const [range, ...params] = part.trim().split(";");
      const tag = range?.trim().toLowerCase();
      if (!tag || !/^(\*|[a-z]{1,8}(-[a-z0-9]{1,8})*)$/.test(tag)) return;
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*(0(\.\d{0,3})?|1(\.0{0,3})?)\s*$/i.exec(p);
        if (m) q = Number(m[1]);
        else if (/^\s*q\s*=/i.test(p)) return; // a q that is not a number: skip the range
      }
      ranges.push({ tag, q, at });
    });
  for (const { tag, q } of ranges) (q === 0 ? refused : accepted).push(tag);
  ranges.sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { tag, q } of ranges) {
    if (q === 0) continue;
    if (tag === "*") return { locale: null, refuses };
    const subtags = tag.split("-");
    while (subtags.length > 0) {
      const found = byLowerCase.get(subtags.join("-"));
      if (found && !named(found)) return { locale: found, refuses };
      subtags.pop();
      // A lone single-letter subtag (`x`, an extension's key) is never a
      // language on its own: lookup drops it with the subtag after it.
      if (subtags.at(-1)?.length === 1) subtags.pop();
    }
  }
  return { locale: null, refuses };
}

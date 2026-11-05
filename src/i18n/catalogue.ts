import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTranslator } from "next-intl";

import en from "../../messages/en.json";
import { SOURCE_LOCALE, languageProblem, type Locale } from "./locales";
import { formatProblem } from "./message-parts";

/**
 * The languages there are, and a catalogue for each.
 *
 * A language is a file: `messages/<code>.json`. Whatever sits in that
 * directory when the app is built is what it offers — on the picker on /me, to
 * an `Accept-Language` header, as `DEFAULT_LOCALE`, and to mail — and there is
 * no list of codes, or of names, anywhere in the code. Adding German is adding
 * `messages/de.json`; `npm run check:messages` holds it to English's shape.
 *
 * Also a catalogue for one person rather than for one request — what an email
 * is written in. The request's language comes from ./request.ts; an email has
 * no request, only a recipient, and is written in *their* language
 * (`User.preferredLocale`), whoever caused it to be sent — or, for somebody who
 * has not chosen, in the instance's default (`instanceDefault`), since an
 * email has no browser to ask. A key a translation does not have yet is
 * English: the translation is laid over English key by key (`overlay`, the one
 * place that is done), and a message that is there but cannot be formatted
 * reads in English as well (`translatorFor`). Never key names.
 */

export type Messages = typeof en;

/**
 * `over` laid onto `base`: a string from `over` wherever `base` has one there
 * — and, given `keep`, only a string `keep` accepts for that key's path.
 */
export function overlay<T>(base: T, over: unknown, keep?: (path: string, text: string) => boolean, path = ""): T {
  if (typeof base === "string") {
    return (typeof over === "string" && over !== "" && (!keep || keep(path, over)) ? over : base) as T;
  }
  if (!base || typeof base !== "object") return base;
  const from = over && typeof over === "object" ? (over as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
    out[key] = overlay(value, Object.hasOwn(from, key) ? from[key] : undefined, keep, path ? `${path}.${key}` : key);
  }
  return out as T;
}

/*
 * Finding the files.
 *
 * The production server cannot simply read messages/: it is the `standalone`
 * bundle, and the runner image copies `.next/standalone`, `.next/static` and
 * `public/` — no messages/ directory (Dockerfile). What it has is what webpack
 * packed at build time. So the build is asked for the directory itself:
 * `import.meta.webpackContext` is webpack's own way of saying "every file in
 * this directory matching this pattern", resolved when the bundle is made. It
 * gives the file names (`keys()`, enumerable, which is what the picker needs)
 * and a loader for each (`"lazy"`: one chunk per catalogue, fetched the first
 * time it is asked for, as the dynamic `import()` this replaces did). A file
 * added to messages/ is in the next build with no other edit, in `next dev`
 * too, which watches the directory; `full-test.sh`'s `messages-bundled` step
 * checks the built image's map against messages/ file for file.
 *
 * The suites and scripts run this module under `tsx`, with no bundler, where
 * `import.meta.webpackContext` does not exist. There the directory is read
 * from disk, relative to the working directory every npm script runs in (the
 * repository root, which is also where check:messages reads it), and read on
 * every call: a probe in verify:queue adds a catalogue for the length of one
 * run, and a list kept from before it would not see it.
 *
 * Both give the same answer from the same files, and either way the list is
 * filtered through `languageProblem` (./locales.ts), the rule check:messages
 * fails on: a file whose name is not a language (`notes.json`, `und.json`,
 * `pt-br.json` for `pt-BR`) is left out, with one warning in the log, rather
 * than offered under a name nobody could match — or stopping the app over a
 * file name.
 */

type Catalogues = { names(): string[]; read(name: string): Promise<unknown> };

type WebpackContext = {
  keys(): string[];
  (request: string): Promise<{ default?: unknown }>;
};

declare global {
  interface ImportMeta {
    /** webpack's directory import; only under the bundler (see above). */
    webpackContext(
      request: string,
      options: { recursive: boolean; regExp: RegExp; mode: "lazy" },
    ): WebpackContext;
  }
}

function bundled(): Catalogues | null {
  let context: WebpackContext;
  try {
    // A literal call, as webpack has to read it at build time: the directory,
    // the pattern and the mode cannot come from variables.
    context = import.meta.webpackContext("../../messages", {
      recursive: false,
      regExp: /^\.\/[^/]+\.json$/,
      mode: "lazy",
    });
  } catch {
    return null;
  }
  return {
    names: () => context.keys().map((key) => key.slice("./".length, -".json".length)),
    read: async (name) => {
      const file = await context(`./${name}.json`);
      return file.default ?? file;
    },
  };
}

const onDisk: Catalogues = {
  names: () =>
    readdirSync(join(process.cwd(), "messages"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length)),
  read: async (name) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${name}.json`), "utf8")),
};

const catalogues = bundled() ?? onDisk;

const warned = new Set<string>();
/** Each problem once per process: a log line per request would bury it. */
export function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[i18n] ${message}`);
}

/**
 * The languages this build offers, sorted by code, English among them —
 * en.json is a file like the others, and the picker on /me lists it beside
 * them.
 */
export function offeredLocales(): Locale[] {
  const found = new Set<Locale>([SOURCE_LOCALE]);
  for (const name of catalogues.names()) {
    const problem = languageProblem(name);
    if (problem === null) found.add(name);
    else warnOnce(`messages/${name}.json is not offered: ${problem}.`);
  }
  return [...found].sort();
}

/**
 * The instance's default language, from `DEFAULT_LOCALE`, or null when it is
 * unset or names a language this build does not have.
 *
 * Read at call time, like the rest of the server's environment: the image is
 * built once and configured where it runs. Spelt any way `Intl` accepts
 * (`pt-br` is `pt-BR`), since an operator types it by hand.
 *
 * A value naming no file is ignored, with one warning in the log, rather than
 * stopping the app. It is a preference about strangers, not a setting anything
 * depends on, and the thing most likely to make it wrong is not a typo but an
 * upgrade: a language removed from a later build would otherwise turn a
 * working instance into one that does not start. The same as an unknown
 * `preferredLocale`, which falls through to the next rule.
 *
 * Temporary in this form: it moves to the owner's settings page when #104
 * makes one.
 */
export function instanceDefault(): Locale | null {
  const wanted = process.env.DEFAULT_LOCALE?.trim();
  if (!wanted) return null;
  let code: string | undefined;
  try {
    code = Intl.getCanonicalLocales(wanted)[0];
  } catch {
    code = undefined;
  }
  const offered = offeredLocales();
  if (code && offered.includes(code)) return code;
  warnOnce(
    `DEFAULT_LOCALE="${wanted}" is ignored: ` +
      (code ? `this build has no messages/${code}.json.` : "it is not a language tag.") +
      ` It offers ${offered.join(", ")}.`,
  );
  return null;
}

/**
 * The catalogue for `wanted`, over English, and the language it turned out to
 * be. Never throws.
 *
 * `wanted` is a code that should name a file: a stored `preferredLocale`, or
 * what ./request.ts chose. Anything that does not — nothing chosen, a language
 * since removed, `../en`, `EN` — is the instance default, then English. Only a
 * code in the list is ever turned into a file name, so no value reaches the
 * file system or the bundle's map that is not one of its own entries. A file
 * that cannot be read or parsed is English, logged.
 *
 * A translated message next-intl cannot format (`formatProblem`, the test
 * check:messages fails on) is replaced by English for that key as the file is
 * laid over English, logged once per key. So it is English everywhere the
 * catalogue goes — formatted with the values the page passes, like any other
 * English — and never its key's name: on pages, in the messages client
 * components are sent, and in mail. Done at load rather than when a message
 * fails, because next-intl's `getMessageFallback` is told the key but not the
 * values, and could only show English unformatted.
 *
 * In the bundle the files cannot change, so each catalogue is laid over
 * English once and kept. Under tsx it is read afresh, for the reason the list
 * is.
 */
export async function catalogueFor(
  wanted: string | null | undefined,
): Promise<{ locale: Locale; messages: Messages }> {
  const offered = offeredLocales();
  const locale = wanted && offered.includes(wanted) ? wanted : (instanceDefault() ?? SOURCE_LOCALE);
  if (locale === SOURCE_LOCALE) return { locale: SOURCE_LOCALE, messages: en };
  const kept = loaded.get(locale);
  if (kept) return { locale, messages: kept };
  try {
    const messages = layOver(locale, await catalogues.read(locale));
    if (catalogues !== onDisk) loaded.set(locale, messages);
    return { locale, messages };
  } catch (error) {
    warnOnce(`messages/${locale}.json could not be read, so English is used instead: ${(error as Error).message}`);
    return { locale: SOURCE_LOCALE, messages: en };
  }
}

const loaded = new Map<Locale, Messages>();

/** A catalogue's contents laid over English, each message that cannot be formatted left English. */
export function layOver(locale: Locale, file: unknown): Messages {
  return overlay(en, file, (path, text) => {
    const problem = formatProblem(text, locale);
    if (problem) warnOnce(`messages/${locale}.json: ${path} cannot be formatted (${problem}), so it is English.`);
    return problem === null;
  });
}

/**
 * next-intl's error handling for pages, for ./request.ts.
 *
 * `getMessageFallback` is what a page shows for a message that still fails:
 * English's text for that key, never the key. A broken translation never gets
 * here (it was replaced at load, above); what can is a message that fails with
 * the values it was given — in English too, so a bug — shown as English's
 * unformatted text, since the fallback is not given the values, and logged
 * once per key. `onError` logs whatever else next-intl reports, once each;
 * the errors about a message are left to the fallback, which knows the key.
 */
const MESSAGE_ERRORS = new Set(["MISSING_MESSAGE", "INVALID_MESSAGE", "FORMATTING_ERROR", "INVALID_KEY"]);

export const pageMessageHandling = {
  onError(error: { code: string; message: string }) {
    if (!MESSAGE_ERRORS.has(error.code)) warnOnce(`next-intl: ${error.message}`);
  },
  getMessageFallback({ namespace, key, error }: { namespace?: string; key: string; error: { code: string } }): string {
    const path = namespace ? `${namespace}.${key}` : key;
    warnOnce(`${path} could not be shown (${error.code}), so its English text is.`);
    const text = path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
    return typeof text === "string" ? text : "";
  },
};

const plain = (locale: Locale, messages: Messages, onError?: () => void) =>
  createTranslator({
    locale,
    messages,
    ...(onError ? { onError, getMessageFallback: () => "" } : {}),
  });

/** English, synchronously — for what is stored rather than sent. */
export const english = plain(SOURCE_LOCALE, en);

export type Translator = typeof english;

/**
 * A translator over a whole catalogue, outside any request.
 *
 * A translated message that fails to format — a brace lost, a branch broken —
 * gives the English message for that key, formatted with the same values.
 * use-intl's own fallback is the key's path (`notification.storyMoved`), which
 * in a subject line is worse than English.
 */
export function translatorFor(catalogue: { locale: Locale; messages: Messages }): Translator {
  if (catalogue.locale === SOURCE_LOCALE) return english;
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

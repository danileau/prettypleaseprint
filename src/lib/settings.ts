import { z } from "zod";

import { offeredLocales, warnOnce } from "@/i18n/catalogue";
import { SOURCE_LOCALE, type Locale } from "@/i18n/locales";
import { db } from "@/lib/db";
import { IMPORT_SOURCES, enabledSources, type ImportSource } from "@/lib/import-source";

/**
 * The instance's settings: what the owner can change on /admin/settings, and
 * the one place that decides what each of them currently is (#104).
 *
 * Three sources, in this order, for every field:
 *
 *   env      the environment variable is set. It wins, and the page shows the
 *            field locked, "set by X" — nobody's existing `.env` changes
 *            meaning, and an operator can still pin a value from outside.
 *   db       the owner saved one, in the single `instanceSettings` row.
 *   default  neither — and the default is exactly what the app did before
 *            this page existed.
 *
 * What "set" means is per variable, and is decided by what the variable meant
 * before this page existed — the principle being that no `.env` changes
 * meaning:
 *
 *   IMPORT_SOURCES   set if present at all. `IMPORT_SOURCES=""` meant "off"
 *                    and nobody inside the app could change that, so it still
 *                    pins importing off.
 *   MAIL_FROM        set if present at all, for the same reason: whatever it
 *                    said was sent, even an empty string. Where it is a bare
 *                    address the owner may add a name (see below).
 *   PASSKEY_RP_NAME  set if present and not the empty string. The passkey
 *                    plugin treated `""` as "no name given" and used the
 *                    default, which is what an unset variable means here too.
 *   DEFAULT_LOCALE   set if present and not blank, as it was read before this
 *                    page had a field for it (`DEFAULT_LOCALE=""` meant no
 *                    default). Set, it wins even when it names a language the
 *                    build has no file for: it is then ignored, with one line
 *                    in the log, and the field stays locked — English applies,
 *                    as it did, rather than a row the page could not show as
 *                    in force.
 *
 * Read per call, from the database, with no cache in between: a save applies
 * on the very next request without a restart, and there is no second copy to
 * fall out of step. It is one primary-key lookup.
 *
 * A stored value is validated again on the way out, with the same schema the
 * form is held to. The form is not the only way a row can be written — a
 * restored backup, a hand-edited row, a later version's value after a rollback
 * — and the mail display name goes into a header, so "it was checked when it
 * was saved" is not enough. An invalid stored value is ignored (the default
 * applies) and said so in the log.
 *
 * Not `server-only`, unlike most of `src/lib`: `email.ts` reads the sender
 * from here, and the suites import `email.ts` in process. Nothing in here is a
 * secret, and the database client is already importable from scripts.
 */

export const SETTINGS_ID = "instance";

export const DEFAULT_PRODUCT_NAME = "Pretty Please Print";
/** What mail was sent as before MAIL_FROM existed in an `.env`, exactly. */
const DEFAULT_SENDER = "Pretty Please Print <printer@example.org>";
const DEFAULT_MAIL_ADDRESS = "printer@example.org";

/**
 * Characters a display name may not hold. Line breaks (C0, C1, U+2028/9)
 * would start a mail header of somebody else's choosing; `"` `\` end or escape
 * a quoted name and `<` `>` open an address. Format characters (`\p{Cf}`) —
 * bidi overrides, zero-width joiners and spaces, the byte-order mark — let a
 * name read differently from what it is, which is exactly what a sender name
 * and an authenticator's label must not do. The Hangul fillers (U+115F,
 * U+1160, U+3164, U+FFA0) are letters to Unicode and blank to the eye, so
 * they are refused by name.
 */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u115f\u1160\u3164\uffa0"<>\\\p{Cf}]/u;

/**
 * A name may not open with a combining mark \u2014 which also refuses one made of
 * nothing else. A mark with no letter before it lands on whatever is printed
 * next to the name (a quote, an address), or on nothing at all.
 */
const LEADING_MARK = /^\p{M}/u;

/**
 * A name shown to people: by their authenticator when they add a passkey, and
 * as the sender of the instance's mail.
 */
export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((s) => !UNSAFE_NAME.test(s) && !LEADING_MARK.test(s), { message: "unsafe characters" });

const ImportSources = z
  .array(z.enum(IMPORT_SOURCES))
  .transform((list) => IMPORT_SOURCES.filter((s) => list.includes(s)));

/**
 * A language the build offers — a file in messages/ (src/i18n/catalogue.ts),
 * read when the value is checked, so a language added or removed by a new
 * image is what is accepted, with no list here. English is not stored: it is
 * what an unset field means already.
 */
const OfferedLocale = z
  .string()
  .refine((code) => code !== SOURCE_LOCALE && offeredLocales().includes(code), { message: "not a language this build offers" });

/** What the owner may save. A field left out is left as it is. */
export const SettingsInput = z
  .object({
    passkeyRpName: DisplayName.nullable(),
    importSources: ImportSources,
    mailFromName: DisplayName.nullable(),
    defaultLocale: OfferedLocale.nullable(),
  })
  .partial()
  .strict();
export type SettingsInput = z.infer<typeof SettingsInput>;

export type SettingKey = keyof z.infer<typeof SettingsInput>;
export const SETTING_KEYS: readonly SettingKey[] = ["passkeyRpName", "importSources", "mailFromName", "defaultLocale"];

export type Source = "env" | "db" | "default";
export type Effective<T> = { value: T; source: Source; envVar: string };

export type EffectiveSettings = {
  passkeyRpName: Effective<string>;
  importSources: Effective<ImportSource[]>;
  /** `null`: no name — mail goes out under the address alone. */
  mailFromName: Effective<string | null>;
  /** The sender as the transports are given it. */
  mailFrom: MailSender;
  /**
   * The language for whoever has not chosen one and whose browser asks for
   * none the app has, and for mail to them (src/i18n/request.ts, `voiceFor`).
   * `null`: English, the built-in default.
   */
  defaultLocale: Effective<Locale | null>;
};

export type MailSender =
  /** Sent exactly as written — MAIL_FROM, or the old default — as before this page existed. */
  | { kind: "verbatim"; header: string }
  /** An address from MAIL_FROM (or the default), and a name the owner saved. */
  | { kind: "named"; name: string; address: string };

/** The row as stored; `null` when the owner has never saved. */
export type SettingsRow = {
  passkeyRpName: string | null;
  importSources: string[];
  mailFromName: string | null;
  /** Optional so a row from before the field was read (or a test's) still types. */
  defaultLocale?: string | null;
} | null;

type Env = Record<string, string | undefined>;

/** The stored value if it passes the schema, otherwise nothing (and a log line). */
function stored<T>(schema: z.ZodType<T>, value: unknown, field: string): T | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(`[settings] ignoring the stored ${field}: it does not pass validation; the default applies`);
  return undefined;
}

/** Stored import sources this version knows, in a fixed order. */
export function knownSources(list: readonly string[] | null | undefined): ImportSource[] {
  return IMPORT_SOURCES.filter((s) => (list ?? []).includes(s));
}

/**
 * Split MAIL_FROM into a display name and an address, where it has the plain
 * shape `Name <address>`, `"Name" <address>`, `<address>` or a bare
 * `address`. Anything else is `null` — and is sent verbatim, exactly as before
 * this page existed, rather than reinterpreted.
 */
export function parseMailFrom(raw: string): { name: string | null; address: string } | null {
  const value = raw.trim();
  const bare = /^[^\s<>"@]+@[^\s<>"@]+$/;
  if (bare.test(value)) return { name: null, address: value };
  const named = /^(?:"([^"\\]*)"|([^"<>]*?))\s*<([^\s<>"@]+@[^\s<>"@]+)>$/.exec(value);
  if (!named) return null;
  const name = (named[1] ?? named[2] ?? "").trim();
  return { name: name || null, address: named[3]! };
}

/**
 * The rule itself, pure: a stored row and an environment in, the effective
 * settings out. Exported so the suites can hold every combination to it
 * without standing a server up once per environment.
 */
export function resolveSettings(
  row: SettingsRow,
  env: Env = process.env,
  offered: readonly Locale[] = offeredLocales(),
): EffectiveSettings {
  // --- the name an authenticator shows when a passkey is added
  const rpEnv = env.PASSKEY_RP_NAME;
  const rpStored = stored(DisplayName, row?.passkeyRpName, "passkeyRpName");
  const passkeyRpName: Effective<string> =
    rpEnv !== undefined && rpEnv !== ""
      ? { value: rpEnv, source: "env", envVar: "PASSKEY_RP_NAME" }
      : rpStored !== undefined
        ? { value: rpStored, source: "db", envVar: "PASSKEY_RP_NAME" }
        : { value: DEFAULT_PRODUCT_NAME, source: "default", envVar: "PASSKEY_RP_NAME" };

  // --- importing from a link. Present at all, the variable decides — empty
  // means off, as it always did — and keeps its loud validation: a misspelt
  // IMPORT_SOURCES throws by name rather than quietly meaning "off".
  const importEnv = env.IMPORT_SOURCES;
  let importSources: Effective<ImportSource[]>;
  if (importEnv !== undefined) {
    importSources = { value: enabledSources(importEnv), source: "env", envVar: "IMPORT_SOURCES" };
  } else {
    // A stored name this version does not know (one a later version wrote,
    // then rolled back) is ignored rather than refused: a rollback must not
    // stop the app.
    const known = knownSources(row?.importSources);
    if (known.length !== (row?.importSources ?? []).length) {
      console.error("[settings] ignoring stored import sources this version does not know");
    }
    importSources = known.length
      ? { value: known, source: "db", envVar: "IMPORT_SOURCES" }
      : { value: [], source: "default", envVar: "IMPORT_SOURCES" };
  }

  // --- the sender. The address stays with the transport, in MAIL_FROM; only
  // the name is the owner's, and only where MAIL_FROM does not give one. Until
  // the owner names a sender, mail goes out exactly as it did before.
  const mailEnv = env.MAIL_FROM;
  const nameStored = stored(DisplayName, row?.mailFromName, "mailFromName");
  let mailFromName: Effective<string | null>;
  let mailFrom: MailSender;
  if (mailEnv === undefined) {
    if (nameStored !== undefined) {
      mailFromName = { value: nameStored, source: "db", envVar: "MAIL_FROM" };
      mailFrom = { kind: "named", name: nameStored, address: DEFAULT_MAIL_ADDRESS };
    } else {
      mailFromName = { value: DEFAULT_PRODUCT_NAME, source: "default", envVar: "MAIL_FROM" };
      mailFrom = { kind: "verbatim", header: DEFAULT_SENDER };
    }
  } else {
    const parsed = parseMailFrom(mailEnv);
    if (parsed === null || parsed.name !== null) {
      // MAIL_FROM names its sender, or is something this cannot read: it is
      // sent as written, and the name is not the owner's to change.
      mailFromName = { value: parsed?.name ?? mailEnv.trim(), source: "env", envVar: "MAIL_FROM" };
      mailFrom = { kind: "verbatim", header: mailEnv };
    } else if (nameStored !== undefined) {
      mailFromName = { value: nameStored, source: "db", envVar: "MAIL_FROM" };
      mailFrom = { kind: "named", name: nameStored, address: parsed.address };
    } else {
      // A bare address meant mail with no name. It still does.
      mailFromName = { value: null, source: "default", envVar: "MAIL_FROM" };
      mailFrom = { kind: "verbatim", header: mailEnv };
    }
  }

  // --- the instance's default language (#103). Every value names a file in
  // messages/ or is passed over: a language a later image dropped, or a row
  // restored from one that had it, must not stop the app or blank its pages.
  // One warning each, not one per request, since this is read on every page.
  const localeEnv = env.DEFAULT_LOCALE?.trim();
  let defaultLocale: Effective<Locale | null>;
  if (localeEnv) {
    let code: string | undefined;
    try {
      code = Intl.getCanonicalLocales(localeEnv)[0];
    } catch {
      code = undefined;
    }
    const known = code !== undefined && offered.includes(code);
    if (!known) {
      warnOnce(
        `DEFAULT_LOCALE="${localeEnv}" is ignored: ` +
          (code ? `this build has no messages/${code}.json.` : "it is not a language tag.") +
          ` It offers ${offered.join(", ")}.`,
      );
    }
    defaultLocale = { value: known ? code! : null, source: "env", envVar: "DEFAULT_LOCALE" };
  } else {
    const saved = row?.defaultLocale ?? null;
    if (saved !== null && !offered.includes(saved)) {
      warnOnce(
        `the default language saved on the settings page, "${saved}", is ignored: this build has no ` +
          `messages/${saved}.json. It offers ${offered.join(", ")}.`,
      );
    }
    defaultLocale =
      saved !== null && offered.includes(saved)
        ? { value: saved, source: "db", envVar: "DEFAULT_LOCALE" }
        : { value: null, source: "default", envVar: "DEFAULT_LOCALE" };
  }

  return { passkeyRpName, importSources, mailFromName, mailFrom, defaultLocale };
}

/** Prisma's "the table does not exist" and "the column does not exist". */
const MISSING_SCHEMA = new Set(["P2021", "P2022"]);
let warnedMissing = false;

/**
 * The settings in force for this request.
 *
 * If the table cannot be read because it is not there — the migration has
 * not run, or a later version's column is missing — every value is its
 * default, said once in the log, rather than every page that sends mail,
 * registers a passkey or lists the catalogue answering 500. The defaults are
 * today's behaviour, so importing stays off unless IMPORT_SOURCES says
 * otherwise. Any other database error is not swallowed.
 */
export async function effectiveSettings(): Promise<EffectiveSettings> {
  let row: SettingsRow;
  try {
    row = await db.instanceSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { passkeyRpName: true, importSources: true, mailFromName: true, defaultLocale: true },
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !MISSING_SCHEMA.has(code)) throw error;
    if (!warnedMissing) {
      warnedMissing = true;
      console.error(
        `[settings] the instanceSettings table cannot be read (${code}) — has the migration run? ` +
          "Using the defaults and the environment until it can.",
      );
    }
    row = null;
  }
  return resolveSettings(row);
}

/**
 * The instance's default language, from wherever it is set — DEFAULT_LOCALE,
 * then this page, then nothing (English) — for src/i18n/request.ts and for
 * mail to somebody who has not chosen (`voiceFor` in email.ts).
 */
export async function instanceLocale(): Promise<Locale | null> {
  return (await effectiveSettings()).defaultLocale.value;
}

/** The import sources switched on, from wherever they are set. */
export async function importSources(): Promise<ImportSource[]> {
  return (await effectiveSettings()).importSources.value;
}

/**
 * A sender as one header value, for a transport that takes a string. The
 * name is quoted; `DisplayName` has already refused everything that could end
 * the quotes or the line.
 */
export function senderHeader(sender: MailSender): string {
  return sender.kind === "verbatim" ? sender.header : `"${sender.name}" <${sender.address}>`;
}

/** The fields the environment has pinned, which the page shows locked. */
export function lockedFields(settings: EffectiveSettings): Set<SettingKey> {
  return new Set(SETTING_KEYS.filter((key) => settings[key].source === "env"));
}

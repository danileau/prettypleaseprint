/**
 * Every translation held against English, key by key.
 *
 *   npm run check:messages
 *
 * `messages/en.json` is the source of truth; every other file in messages/ is
 * a translation of it (`<xx>.json`). A translation drifts silently in both
 * directions: a key added in English renders in English for that language's
 * readers (the first translation lays its catalogue over English key by key,
 * which is right for the reader and invisible to everyone else), and a key
 * removed from English lingers in <xx>.json being translated and reviewed for
 * nothing. Nothing else
 * notices either — the typecheck only knows English, and the suites only read
 * English.
 *
 * With English alone there is no translation to hold against it: the run
 * still checks en.json itself and the client groups below, and passes.
 *
 * Per language, two kinds of finding.
 *
 * WARNINGS — listed, annotated in CI, and the run still passes. Each is what
 * an English-only change leaves behind, and each costs the reader nothing but
 * some English, since the translation is laid over English key by key. Failing
 * on them would make every maintainer's English-only pull request wait for a
 * translator, which is the opposite of what a volunteer translation is for.
 *
 *   missing   in English, not in the translation — shown in English meanwhile
 *   stale     in the translation, no longer in English — delete it. A warning
 *             and not an error because removing or renaming an English key is
 *             an English-only change like any other, and the leftover is never
 *             read by anything.
 *   shape     a string where English has a group, or the reverse — English was
 *             restructured; the translated value is ignored and English
 *             shown, exactly as for a missing key.
 *
 * ERRORS — the run fails. These are broken, not merely behind:
 *
 *   empty     an empty string — a translator's slip, never an English change
 *   arguments the {placeholders} differ from English's — `{name}` renamed or
 *             dropped is a sentence that silently loses its subject
 *   tags      the rich-text <tags> differ from English's — a dropped <link>
 *             is an email without its link
 *   quote     an ASCII apostrophe right before `{`, `}` or `#`, which ICU reads
 *             as the start of a quoted literal: `l'{x}` renders "l{x}". The
 *             catalogues use the typographic ’ for exactly this reason.
 *   malformed a file that is not JSON, a key containing ".", a value that is
 *             neither a string nor a group
 *
 * And, once, for the source: every `useTranslations("…")` in a client
 * component names a group the browser is actually sent (see the end) — an
 * error, since the browser would show key names, not English.
 *
 * Under GitHub Actions each finding is also printed as a `::warning` or
 * `::error` annotation, so a warning shows on the pull request without failing
 * it. docs/i18n.md says what to do about each.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_GROUPS } from "../src/i18n/client-groups";
import { partsOf } from "../src/i18n/message-parts";

const SENT: readonly string[] = Object.values(CLIENT_GROUPS).flat();

// The catalogues; another directory only for scripts/tests/check-messages.test.sh.
const DIR = process.env.MESSAGES_DIR ?? "messages";
const SOURCE = "en";

type Leaves = Map<string, string>;

/** `{ a: { b: "x" } }` → `a.b` → "x", keeping groups apart from strings. */
function flatten(
  value: unknown,
  file: string,
  problems: string[],
  prefix = "",
  leaves: Leaves = new Map(),
  groups: Set<string> = new Set(),
): { leaves: Leaves; groups: Set<string> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${file}: the top level must be an object of groups and strings`);
    return { leaves, groups };
  }
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key.includes(".")) {
      // next-intl reads a dot as nesting, so this key can never be asked for.
      problems.push(`${file}: ${path} — a key cannot contain "."`);
    } else if (typeof v === "string") {
      leaves.set(path, v);
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      groups.add(path);
      flatten(v, file, problems, path, leaves, groups);
    } else {
      problems.push(`${file}: ${path} — only strings and groups belong here, not ${JSON.stringify(v)}`);
    }
  }
  return { leaves, groups };
}

const argumentsOf = (message: string) => partsOf(message).args;

function load(file: string, problems: string[]) {
  try {
    return flatten(JSON.parse(readFileSync(join(DIR, file), "utf8")), file, problems);
  } catch (e) {
    problems.push(`${file}: not valid JSON — ${(e as Error).message}`);
    return { leaves: new Map() as Leaves, groups: new Set<string>() };
  }
}

/**
 * A GitHub Actions annotation: it lands on the run's summary and the pull
 * request's checks, which is where a warning that does not fail the job is
 * still seen. Plain output elsewhere; the lines above it already say it all.
 */
const IN_CI = process.env.GITHUB_ACTIONS === "true";
function annotate(level: "warning" | "error", file: string, title: string, message: string) {
  if (!IN_CI) return;
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  console.info(`::${level} file=${prop(file)},title=${prop(title)}::${esc(message)}`);
}

let errors = 0;
let warnings = 0;

const fatal: string[] = [];
const source = load(`${SOURCE}.json`, fatal);
const translations = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f !== `${SOURCE}.json`)
  .sort();

console.info(
  `check:messages — ${SOURCE}: ${source.leaves.size} key(s); ` +
    `${translations.length} translation(s): ${translations.map((f) => f.replace(/\.json$/, "")).join(", ") || "none"}`,
);

for (const p of fatal) {
  console.error(`  error: ${p}`);
  annotate("error", `${DIR}/${SOURCE}.json`, "malformed catalogue", p);
  errors++;
}

const QUOTE = /'[{}#]/;
for (const [key, message] of source.leaves) {
  if (QUOTE.test(message)) {
    const text = `${key} — an ASCII apostrophe before { } or # starts an ICU quote; use ’`;
    console.error(`  error: ${SOURCE}: ${text}`);
    annotate("error", `${DIR}/${SOURCE}.json`, "ICU apostrophe", text);
    errors++;
  }
}

type Section = { title: string; level: "warning" | "error"; list: string[] };

for (const file of translations) {
  const lang = file.replace(/\.json$/, "");
  const path = `${DIR}/${file}`;
  const problems: string[] = [];
  const { leaves, groups } = load(file, problems);

  const section = (title: string, level: Section["level"]): Section => ({ title, level, list: [] });
  const missing = section("missing — shown in English until translated", "warning");
  const stale = section("stale — no longer in en.json, delete it", "warning");
  const shape = section("shape — English was restructured; shown in English meanwhile", "warning");
  const empty = section("empty — would blank the text", "error");
  const args = section("arguments — placeholders differ from English", "error");
  const tagged = section("tags — rich-text tags differ from English", "error");
  const quote = section("quote — ASCII apostrophe before { } or #, use ’", "error");
  const malformed = section("malformed", "error");
  malformed.list.push(...problems);
  const sections = [missing, stale, shape, malformed, empty, args, tagged, quote];

  for (const [key, english] of source.leaves) {
    if (groups.has(key)) shape.list.push(`${key}  (a group here, a string in English)`);
    else if (!leaves.has(key)) missing.list.push(key);
    else {
      const translated = leaves.get(key)!;
      if (translated.trim() === "") empty.list.push(key);
      const want = argumentsOf(english).join(", ");
      const got = argumentsOf(translated).join(", ");
      if (want !== got) args.list.push(`${key}  (English has {${want}}, ${lang} has {${got}})`);
      const wantTags = partsOf(english).tags.join(", ");
      const gotTags = partsOf(translated).tags.join(", ");
      if (wantTags !== gotTags) tagged.list.push(`${key}  (English has <${wantTags}>, ${lang} has <${gotTags}>)`);
      if (QUOTE.test(translated)) quote.list.push(key);
    }
  }
  for (const key of leaves.keys()) {
    if (source.groups.has(key)) shape.list.push(`${key}  (a string here, a group in English)`);
    else if (!source.leaves.has(key)) stale.list.push(key);
  }

  const count = (level: Section["level"]) =>
    sections.filter((s) => s.level === level).reduce((n, s) => n + s.list.length, 0);
  const langWarnings = count("warning");
  const langErrors = count("error");
  warnings += langWarnings;
  errors += langErrors;
  if (langWarnings + langErrors === 0) {
    console.info(`  ${lang}: every key translated, nothing stale`);
    continue;
  }
  console.info(`\n  ${lang}: ${langErrors} error(s), ${langWarnings} warning(s)`);
  for (const s of sections) {
    if (s.list.length === 0) continue;
    const log = s.level === "error" ? console.error : console.info;
    log(`    ${s.level}: ${s.title}:`);
    for (const item of s.list.sort()) {
      log(`      ${item}`);
      annotate(s.level, path, `${lang}: ${s.title.split(" — ")[0]}`, `${item} — ${s.title}`);
    }
  }
}

// --- client components ask only for groups the browser is sent -------------
//
// Each screen sends its client components the groups CLIENT_GROUPS lists for
// it, not the whole catalogue (client-groups.ts says why). A
// `useTranslations("x")` in a client file whose group no screen sends renders
// the key's name instead of the text, and the typecheck cannot see it — the
// types know every key, not which ones were sent. So it is checked here, where
// it fails loudly, rather than found by someone reading the page.
const uncovered: string[] = [];
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}
for (const file of sourceFiles("src")) {
  const text = readFileSync(file, "utf8");
  if (!/^\s*["']use client["']/.test(text)) continue;
  for (const m of text.matchAll(/useTranslations\(([^)]*)\)/g)) {
    const arg = /^\s*["']([^"']+)["']\s*$/.exec(m[1]!)?.[1];
    if (!arg) uncovered.push(`${file}: useTranslations(${m[1]}) — name the group as a string literal`);
    else if (!SENT.some((g) => arg === g || arg.startsWith(`${g}.`))) {
      uncovered.push(`${file}: "${arg}" is not sent to the browser — add it to CLIENT_GROUPS`);
    }
  }
}
if (uncovered.length) {
  errors += uncovered.length;
  console.error(`\n  client components: ${uncovered.length} error(s)`);
  for (const u of uncovered) {
    console.error(`    error: ${u}`);
    annotate("error", u.slice(0, u.indexOf(":")), "client group not sent", u);
  }
} else {
  console.info(`  client components: every group they ask for is sent (${SENT.join(", ")})`);
}

// One line, always last, in a fixed shape: scripts/full-test.sh reads it to
// put a WARN line in its summary, since a passing step would otherwise hide
// the warnings in a log nobody opens.
console.info(`\ncheck:messages — ${errors} error(s), ${warnings} warning(s)`);
if (errors > 0) process.exitCode = 1;

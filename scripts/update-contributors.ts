/**
 * Regenerates src/lib/contributors.ts — the list the /about page credits.
 *
 *   git fetch origin
 *   npm run contributors              # reads origin/main
 *   npm run contributors -- --ref main
 *
 * Why a committed file rather than reading git when the page renders: the
 * Docker build context excludes `.git` (see .dockerignore), so neither the
 * build nor the running container has any history to read. The list is
 * therefore generated here, on a machine that has a checkout and `gh`, and
 * committed like any other source file.
 *
 * Who counts: everyone who authored a commit on main, plus anyone credited
 * with a `Co-authored-by:` trailer there, mapped to a GitHub login.
 *
 *  - `<id>+<login>@users.noreply.github.com` gives the login directly.
 *  - Any other author address is asked of GitHub, once per address, via
 *    `gh api repos/{owner}/{repo}/commits/{sha}` → `.author.login`.
 *  - A co-author address is matched against the addresses already resolved
 *    from authored commits; one that cannot be matched to a GitHub account is
 *    reported on stderr and left out, because the page links every name to a
 *    profile and has nothing to link to.
 *  - Bots are dropped: a login ending in `[bot]`, or a GitHub account of type
 *    "Bot".
 *
 * The repository owner (from package.json's `repository.url`) is listed as
 * the maintainer; everyone else as a contributor.
 *
 * Email addresses are used only to resolve logins and are NEVER written out:
 * the committed file holds logins, display names and a first-contribution
 * month, nothing else.
 *
 * The output is sorted and carries no timestamps or counts that grow with
 * every merge, so re-running it with no new contributors produces no diff.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "src/lib/contributors.ts");

const refFlag = process.argv.indexOf("--ref");
const REF = refFlag >= 0 ? process.argv[refFlag + 1] : "origin/main";
if (!REF) throw new Error("--ref needs a value");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  repository?: { url?: string };
};
const slug = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? "");
if (!slug) throw new Error("package.json repository.url is not a GitHub URL");
const [, OWNER, REPO] = slug as unknown as [string, string, string];

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function gh(path: string, jq: string): string {
  try {
    return execFileSync("gh", ["api", path, "--jq", jq], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`gh api ${path} failed — is gh installed and signed in?\n${String(err)}`);
  }
}

const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;
const isBotLogin = (login: string) => /\[bot\]$/i.test(login);

// --- read history ----------------------------------------------------------

type Commit = { sha: string; email: string; date: string; coAuthors: string[] };

const US = "\x1f";
const RS = "\x1e";
const raw = git(
  "log",
  REF,
  `--format=%H${US}%ae${US}%aI${US}%(trailers:key=Co-authored-by,valueonly,separator=%x1f)${RS}`,
);

const commits: Commit[] = raw
  .split(RS)
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [sha, email, date, ...trailers] = r.split(US);
    const coAuthors = trailers
      .map((t) => /<([^>]+)>/.exec(t)?.[1]?.trim().toLowerCase())
      .filter((e): e is string => !!e);
    return { sha: sha!, email: email!.toLowerCase(), date: date!, coAuthors };
  });

// Oldest first, so "first contribution" is simply the first one seen.
commits.reverse();

// --- resolve addresses to logins -------------------------------------------

const loginByEmail = new Map<string, string | null>();

for (const c of commits) {
  if (loginByEmail.has(c.email)) continue;
  const direct = NOREPLY.exec(c.email)?.[1];
  if (direct) {
    loginByEmail.set(c.email, direct);
    continue;
  }
  const login = gh(`repos/${OWNER}/${REPO}/commits/${c.sha}`, ".author.login // empty");
  loginByEmail.set(c.email, login || null);
  if (!login) console.warn(`no GitHub account for the author of ${c.sha.slice(0, 7)}; skipped`);
}

function coAuthorLogin(email: string): string | null {
  const direct = NOREPLY.exec(email)?.[1];
  if (direct) return direct;
  return loginByEmail.get(email) ?? null;
}

// --- collect -----------------------------------------------------------------

const firstSeen = new Map<string, string>(); // login (case-folded) -> ISO date
const canonical = new Map<string, string>(); // case-folded -> login as GitHub spells it
const unresolved = new Set<string>();

function credit(login: string, date: string) {
  const key = login.toLowerCase();
  if (!canonical.has(key)) canonical.set(key, login);
  if (!firstSeen.has(key)) firstSeen.set(key, date);
}

for (const c of commits) {
  const author = loginByEmail.get(c.email);
  if (author) credit(author, c.date);
  for (const e of c.coAuthors) {
    const login = coAuthorLogin(e);
    if (login) credit(login, c.date);
    else unresolved.add(e.replace(/^[^@]*/, "…")); // domain only, never the full address
  }
}

for (const u of unresolved) {
  console.warn(`a co-author at ${u} has no GitHub account this script can find; skipped`);
}

// --- enrich from GitHub and write ------------------------------------------

type Entry = { login: string; name: string | null; since: string; role: "maintainer" | "contributor" };

const entries: Entry[] = [];
for (const [key, login] of canonical) {
  if (isBotLogin(login)) continue;
  const [type, name] = JSON.parse(gh(`users/${login}`, "[.type, .name]")) as [string, string | null];
  if (type === "Bot") continue;
  entries.push({
    login,
    name: name && name.trim() && name.trim().toLowerCase() !== key ? name.trim() : null,
    since: firstSeen.get(key)!.slice(0, 7),
    role: key === OWNER.toLowerCase() ? "maintainer" : "contributor",
  });
}

entries.sort((a, b) =>
  a.role !== b.role
    ? a.role === "maintainer" ? -1 : 1
    : a.login.toLowerCase().localeCompare(b.login.toLowerCase(), "en"),
);

const body = `/**
 * The people who built this app, as credited on /about.
 *
 * GENERATED by \`npm run contributors\` (scripts/update-contributors.ts) from
 * the commit history of main. Do not edit by hand — re-run the script. It is a
 * committed file because the Docker build has no .git to read.
 *
 * Logins and display names only; no e-mail addresses, ever.
 */
export type Contributor = {
  /** GitHub login; the profile is https://github.com/<login>. */
  login: string;
  /** Display name from the GitHub profile, when one is set and differs from the login. */
  name: string | null;
  /** Month of the first commit on main, YYYY-MM. */
  since: string;
  role: "maintainer" | "contributor";
};

export const CONTRIBUTORS: readonly Contributor[] = ${JSON.stringify(entries, null, 2)};
`;

writeFileSync(OUT, body);
console.info(`wrote ${entries.length} people to src/lib/contributors.ts (from ${REF})`);

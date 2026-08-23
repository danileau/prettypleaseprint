/**
 * Refuses to let a credential reach the repository.
 *
 *   npm run check:secrets          # what is staged for commit
 *   npm run check:secrets -- --all # every tracked file, for an audit
 *
 * Installed as a pre-commit hook by `npm run hooks:install`.
 *
 * Two passes, because the mistakes look different:
 *
 *   1. Values lifted from the local .env files. This is the one that matters:
 *      it knows *your* actual secrets and finds them wherever they landed —
 *      pasted into a README, hardcoded as a fallback, left in a compose file.
 *      A generic scanner cannot do this.
 *
 *   2. Well-known credential shapes — provider tokens, private keys — which
 *      catch secrets that never passed through a .env file at all.
 *
 * Anything matching KNOWN_DEV_VALUES is ignored: the development stack's
 * credentials are deliberately public, and are named so that using them in
 * production is unmissable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const ALL = process.argv.includes("--all");

/** Deliberately published. See docker-compose.yml. */
const KNOWN_DEV_VALUES = new Set([
  "dev-only-not-a-secret",
  "ppp",
  "localhost",
  "build-time-placeholder-never-signs-anything",
]);

/** Env keys whose values are credentials rather than configuration. */
const SECRET_KEY = /(SECRET|PASSWORD|PRIVATE|TOKEN|_KEY|APIKEY|API_KEY|DSN)$/;
/** Names that contain those words but are public identifiers. */
const NOT_SECRET = /^(PASSKEY_RP_NAME|PASSKEY_RP_ID|S3_ACCESS_KEY|NEXT_PUBLIC_)/;

const PATTERNS: Array<[string, RegExp]> = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Resend key", /\bre_[A-Za-z0-9_]{20,}\b/],
  ["Private key block", /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["Password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{8,}@/],
];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Every credential value sitting in a local, uncommitted env file. */
function localSecrets(): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(".")) {
    if (!name.startsWith(".env") || name.endsWith(".example")) continue;
    if (!existsSync(name)) continue;
    for (const line of readFileSync(name, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'\n#]*)["']?\s*$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      const value = m[2]!.trim();
      if (NOT_SECRET.test(key) || !SECRET_KEY.test(key)) continue;
      if (value.length < 12 || KNOWN_DEV_VALUES.has(value)) continue;
      if (/CHANGE-?ME|placeholder|example/i.test(value)) continue;
      found.set(`${name}:${key}`, value);
    }
  }
  return found;
}

function filesToScan(): string[] {
  const out = ALL
    ? git("ls-files")
    : git("diff", "--cached", "--name-only", "--diff-filter=ACMR");
  return out.split("\n").filter(Boolean);
}

function contentOf(path: string): string | null {
  try {
    const buf = ALL ? readFileSync(path) : execFileSync("git", ["show", `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
    // Binary files cannot hold a pasted secret in any way we could act on.
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

type Hit = { path: string; what: string; sample: string };

const secrets = localSecrets();
const files = filesToScan();
const hits: Hit[] = [];

for (const path of files) {
  if (path === "scripts/check-secrets.ts") continue; // the patterns live here
  const body = contentOf(path);
  if (body === null) continue;

  for (const [origin, value] of secrets) {
    if (body.includes(value)) {
      hits.push({ path, what: `value of ${origin}`, sample: `${value.slice(0, 8)}…` });
    }
  }
  for (const [label, re] of PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    // A shape-based match whose text is one of the deliberately-public
    // development values is not a finding — the dev connection string is
    // `postgresql://ppp:dev-only-not-a-secret@localhost`, which is a password
    // in a URL by shape and a documented placeholder in fact.
    if ([...KNOWN_DEV_VALUES].some((v) => m[0].includes(v))) continue;
    hits.push({ path, what: label, sample: `${m[0].slice(0, 16)}…` });
  }
}

const scope = ALL ? "tracked" : "staged";
if (hits.length === 0) {
  console.info(
    `check:secrets — ${files.length} ${scope} file(s), ` +
      `${secrets.size} local credential(s) cross-checked, nothing found`,
  );
  process.exit(0);
}

console.error(`\ncheck:secrets — refusing to continue, ${hits.length} finding(s):\n`);
for (const h of hits) console.error(`  ${h.path}\n      ${h.what}  (${h.sample})\n`);
console.error(
  "A credential must never enter git history — rotating it is the only\n" +
    "remedy once it has, and a private repository is not a safe place for one.\n" +
    "Move it to .env / .env.docker (both gitignored) and reference it by name.\n" +
    "\nIf a match is genuinely not a secret, add it to KNOWN_DEV_VALUES in\n" +
    "scripts/check-secrets.ts with a comment saying why.\n",
);
process.exit(1);

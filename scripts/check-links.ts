/**
 * Every internal link and heading anchor in the Markdown, checked.
 *
 *   npm run check:links
 *
 * It exists because documentation links rot silently and this repo has proved
 * it twice: once when the narrative moved into docs/ and every `src/...` link
 * became `docs/src/...`, and once when the handoff directory was renamed under
 * references that pointed into it. Neither broke a test, a build or a
 * typecheck. Both would have shipped.
 *
 * Anchors are resolved with **GitHub's** slug rules rather than an
 * approximation of them, because an approximation reports failures that are
 * not real and hides ones that are — my first attempt did both, eating the
 * underscores in `TRUST_PROXY_HEADERS` and collapsing the double hyphen an em
 * dash produces.
 *
 * External http(s) links are deliberately NOT fetched: a CI gate that depends
 * on somebody else's uptime fails for reasons that have nothing to do with the
 * change under test, and gets ignored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", "Pretty Please Print", "shots", "data"]);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, found);
    else if (entry.endsWith(".md")) found.push(normalize(full));
  }
  return found;
}

/**
 * GitHub's heading slug: strip markdown, lowercase, drop anything that is not
 * a letter, digit, space, hyphen or underscore, then replace each space with a
 * hyphen. Runs of spaces are NOT collapsed — "a — b" yields "a--b".
 */
function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*{1,2}(.*?)\*{1,2}/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 \-_]/g, "")
    .replace(/ /g, "-");
}

const files = markdownFiles(".");
const anchors = new Map<string, Set<string>>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const slugs = new Set<string>();
  for (const [, h] of text.matchAll(/^#{1,6}\s+(.*)$/gm)) slugs.add(slug(h));
  anchors.set(file, slugs);
}

const problems: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const base = dirname(file);
  for (const [, label, target] of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|tel:)/.test(target)) continue;

    if (target.startsWith("#")) {
      if (!anchors.get(file)!.has(target.slice(1))) {
        problems.push(`${file}: no heading matches ${target}  [${label}]`);
      }
      continue;
    }

    const [filePart, fragment] = target.split("#");
    const resolved = normalize(join(base, decodeURIComponent(filePart!)));
    let exists = true;
    try {
      statSync(resolved);
    } catch {
      exists = false;
    }
    if (!exists) {
      problems.push(`${file}: missing target ${target}  [${label}]`);
    } else if (fragment && anchors.has(resolved) && !anchors.get(resolved)!.has(fragment)) {
      problems.push(`${file}: no heading #${fragment} in ${relative(".", resolved)}  [${label}]`);
    }
  }
}

console.info(
  `check:links — ${files.length} markdown file(s), ` +
    `${[...anchors.values()].reduce((n, s) => n + s.size, 0)} heading(s)`,
);
if (problems.length) {
  console.error(`\n${problems.length} broken link(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
} else {
  console.info("  every internal link and anchor resolves");
}

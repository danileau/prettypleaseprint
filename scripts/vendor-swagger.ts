/**
 * Copy Swagger UI out of node_modules and into `public/docs/`.
 *
 *   npm run vendor:swagger    (and automatically before `dev` and `build`)
 *
 * The console at `/docs` could have loaded Swagger UI from a CDN in two lines.
 * It does not, for three reasons, and this script is the price of all three:
 *
 *   1. **The CSP would refuse it.** `script-src 'self' 'nonce-…'` is the header
 *      this app serves, and it is not decorative — relaxing it to allow
 *      cdn.jsdelivr.net would widen every page's policy for the benefit of one.
 *   2. **The deployment may have no outbound internet.** A NAS on an isolated
 *      VLAN is a supported way to run this, and a docs page that is blank
 *      there is a docs page that lies about being available.
 *   3. **A CDN is a third party in the request path** of a tool that is
 *      otherwise entirely first-party. The README's claim is "no accounts
 *      anywhere but your own machine"; a CDN does not break that literally,
 *      but it is the same sort of promise.
 *
 * The output is generated, not committed — it is 1.7 MB of somebody else's
 * build output and it belongs to the package manager. `.gitignore` has it.
 * The Docker builder runs this via `prebuild` while node_modules is still
 * present, and `public/` is copied into the runtime image afterwards.
 *
 * Swagger UI is Apache-2.0, so its licence travels with the copy.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const OUT = join(process.cwd(), "public", "docs");

/** Only what the console actually loads. The es-bundles and maps are 4 MB we never serve. */
const ASSETS = [
  "swagger-ui-bundle.js",
  "swagger-ui.css",
] as const;

const LICENCES = [
  ["LICENSE", "LICENSE.swagger-ui.txt"],
  ["swagger-ui-bundle.js.LICENSE.txt", "LICENSE.swagger-ui-bundle.txt"],
] as const;

function sourceDir(): string {
  try {
    return dirname(require.resolve("swagger-ui-dist/package.json"));
  } catch {
    console.error(
      "swagger-ui-dist is not installed.\n" +
        "It is a devDependency: run `npm ci` (not `npm ci --omit=dev`) before building.",
    );
    process.exit(1);
  }
}

function main() {
  const from = sourceDir();
  mkdirSync(OUT, { recursive: true });

  for (const asset of ASSETS) {
    const src = join(from, asset);
    if (!existsSync(src)) {
      console.error(`swagger-ui-dist has no ${asset} — the package layout changed.`);
      process.exit(1);
    }
    // The shipped files end with a `sourceMappingURL` comment pointing at a
    // map we deliberately do not serve. Left in, every visit to /docs logs a
    // 404 in devtools that looks exactly like a broken deploy.
    const contents = readFileSync(src, "utf8").replace(
      /\n?\/[/*]# sourceMappingURL=[^\n*]*(\*\/)?\s*$/,
      "\n",
    );
    writeFileSync(join(OUT, asset), contents);
  }

  for (const [src, dest] of LICENCES) {
    if (existsSync(join(from, src))) copyFileSync(join(from, src), join(OUT, dest));
  }

  const version: string = require("swagger-ui-dist/package.json").version;
  console.info(`vendored swagger-ui-dist ${version} → public/docs/`);
}

main();

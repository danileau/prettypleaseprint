/**
 * Lets a script outside Next import modules that start with
 * `import "server-only"`. Next resolves that package itself and it is not
 * installed, so plain Node cannot. Used by `verify:sso` for the one probe that
 * has to call the app's own server code in process (scripts/passwords-off-probe.ts):
 *
 *   tsx --import ./scripts/_server-only.mjs scripts/passwords-off-probe.ts
 */
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(
      'export async function resolve(specifier, context, next) {' +
        ' if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };' +
        " return next(specifier, context); }",
    ),
);

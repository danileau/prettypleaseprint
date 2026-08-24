import { ok, withActor } from "@/lib/api";
import { buildOpenApiDocument } from "@/lib/openapi";

/**
 * The OpenAPI document, for the console at `/docs` and for anything else that
 * wants to read the surface — a client generator, a Postman import, `jq`.
 *
 * Behind a session, like everything else here except the healthcheck. The
 * reasoning is the same as it is for the rest of the app: this describes an
 * invite-only tool for one office, and an unauthenticated endpoint is not the
 * place to enumerate what it can do or how its authorisation is shaped. The
 * people who need it are already inside.
 *
 * `/api/openapi.json` rather than `/openapi.json` so it inherits the one rule
 * that makes an API usable: middleware never redirects `/api/*`, so a caller
 * with no session is told 401 instead of being handed a sign-in page that a
 * JSON parser would choke on.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withActor(async () => ok(await buildOpenApiDocument()));

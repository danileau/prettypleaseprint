/**
 * Is this module being imported by `next build` rather than by a running
 * server?
 *
 * The build imports every route module to collect its metadata, with
 * NODE_ENV set to production but none of the deployment environment present.
 * Configuration guards describe how the app must be *run*, so they have to
 * stand down during the build — otherwise a container image cannot be built
 * without the production secrets baked into it, which is exactly what we do
 * not want.
 *
 * The guards still fire on the first request in a real deployment, which is
 * the moment that matters.
 */
export const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

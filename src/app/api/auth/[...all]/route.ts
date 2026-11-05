import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { sameAnswerForUnverified, withSsoRequest } from "@/lib/oidc-flow";

/**
 * Every Better Auth endpoint — sign-up, username sign-in, reset-password,
 * passkey register/authenticate, session, sign-out, admin — hangs off this
 * one catch-all. Nothing else in the app mints or reads credentials directly.
 *
 * Each request runs in its own `withSsoRequest`, so what a sign-in through the
 * provider learns about when somebody authenticated reaches the session it
 * opens; and its answer to an unverified address is the same whether or not
 * the address is a member's. Both are in src/lib/oidc-flow.ts.
 */
const handler = toNextJsHandler(auth.handler);

export const GET = (request: Request) => withSsoRequest(async () => sameAnswerForUnverified(await handler.GET(request)));
export const POST = (request: Request) => withSsoRequest(async () => sameAnswerForUnverified(await handler.POST(request)));

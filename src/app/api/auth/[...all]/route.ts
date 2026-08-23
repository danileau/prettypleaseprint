import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/**
 * Every Better Auth endpoint — magic link issue/verify, passkey
 * register/authenticate, session, sign-out, admin — hangs off this one
 * catch-all. Nothing else in the app mints or reads credentials directly.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);

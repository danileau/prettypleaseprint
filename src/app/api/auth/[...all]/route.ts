import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/**
 * Every Better Auth endpoint — sign-up, username sign-in, reset-password,
 * passkey register/authenticate, session, sign-out, admin — hangs off this
 * one catch-all. Nothing else in the app mints or reads credentials directly.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);

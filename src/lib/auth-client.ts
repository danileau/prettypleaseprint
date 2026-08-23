"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { adminClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? undefined,
  plugins: [magicLinkClient(), passkeyClient(), adminClient()],
});

export const { signIn, signOut, useSession, passkey } = authClient;

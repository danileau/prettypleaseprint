"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { requireFreshAuth } from "@/lib/reauth";
import { record } from "@/lib/audit";
import { OIDC_PROVIDER_ID, authMethods, oidcConfig } from "@/lib/auth-methods";

/**
 * Connect the single sign-on provider to the printer owner's account.
 *
 * The owner is never linked implicitly (`linkRule` in src/lib/auth.ts), so
 * this is the one way the provider comes to open their account: on purpose,
 * from a fresh sign-in, through Better Auth's `/link-social` — which then asks
 * the provider for a fresh login and attaches only an identity whose verified
 * address is the owner's own. The gate in `hooks.before` holds for a direct
 * request as well; this is the button.
 */
export async function connectSsoAction(): Promise<void> {
  await requireAdmin();
  if (!oidcConfig()) redirect("/me");
  await requireFreshAuth("/me");
  const res = await auth.api.linkSocialAccount({
    headers: await headers(),
    body: {
      provider: OIDC_PROVIDER_ID,
      callbackURL: "/me?sso=connected",
      errorCallbackURL: "/me?sso=failed",
      disableRedirect: true,
    },
  });
  redirect(res.url);
}

/**
 * Disconnect it again. Not where passwords are off: it would be the owner's
 * only way in, and taking it away from this page would lock them out.
 */
export async function disconnectSsoAction(): Promise<void> {
  const admin = await requireAdmin();
  await requireFreshAuth("/me");
  if (!authMethods().local) redirect("/me?sso=kept");
  const { count } = await db.account.deleteMany({ where: { userId: admin.id, providerId: OIDC_PROVIDER_ID } });
  if (count > 0) {
    await record({
      action: "auth.sso_unlinked",
      actor: admin,
      subject: admin.email,
      detail: { provider: oidcConfig()?.issuer ?? null, role: "admin" },
    });
  }
  revalidatePath("/me");
  redirect("/me?sso=disconnected");
}

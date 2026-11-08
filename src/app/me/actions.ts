"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/authz";
import { requireFreshAuth } from "@/lib/reauth";
import { record } from "@/lib/audit";
import { OIDC_PROVIDER_ID, authMethods, oidcConfig } from "@/lib/auth-methods";
import { offeredLocales } from "@/i18n/catalogue";

/**
 * Your own language, from the picker on /me: a code from messages/, or empty
 * for "Follow my browser", stored as null.
 *
 * Yours only: the id comes from the session, never from the form. And only a
 * language this build offers — the same `offeredLocales` the picker lists — so
 * a value the page never offered is refused whole, nothing saved, rather than
 * stored to be passed over on every request after. That is a crafted request,
 * or a page left open across an upgrade that removed the language; either way
 * the page says nothing changed.
 *
 * Not on the audit trail, unlike switching emails off: it changes how pages
 * read to the one person who chose it, and nothing about who can do what or
 * where their data goes.
 */
export async function setLanguageAction(formData: FormData): Promise<void> {
  const user = await requireUser("/me");
  const value = formData.get("locale");
  if (typeof value !== "string" || (value !== "" && !offeredLocales().includes(value))) {
    redirect("/me?language=refused#language");
  }
  await db.user.update({ where: { id: user.id }, data: { preferredLocale: value === "" ? null : value } });
  revalidatePath("/me");
  // Back to the picker, which the next render reads in the language just
  // chosen — that is the confirmation.
  redirect("/me#language");
}

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
  let url: string;
  try {
    const res = await auth.api.linkSocialAccount({
      headers: await headers(),
      body: {
        provider: OIDC_PROVIDER_ID,
        callbackURL: "/me?sso=connected",
        errorCallbackURL: "/me?sso=failed",
        disableRedirect: true,
      },
    });
    url = res.url;
  } catch (error) {
    // Refused before the provider is reached — it cannot be read just now
    // (503), or the gate said no (already connected, the session aged out
    // between the check above and this). Said on /me, not as an error page.
    console.error("connecting single sign-on did not start", error);
    redirect("/me?sso=unavailable");
  }
  redirect(url);
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

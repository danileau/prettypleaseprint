/**
 * How people sign in to this deployment, and how an account may come to exist.
 *
 * Pure — it reads configuration and decides; it holds no session and makes no
 * request. `auth.ts` builds Better Auth from it, the pages decide what to draw
 * from it, and the suites exercise the rules here directly, in every mode,
 * which they could not do against a stack that only runs in one.
 *
 * Two ways in:
 *
 *   local   a username and password, and passkeys — what this app has always had
 *   oidc    single sign-on through an OpenID Connect provider the host runs or
 *           trusts: Authentik, Keycloak, VoidAuth, Authelia, a cloud one
 *
 * `AUTH_METHODS` names which are on: `local` (the default), `oidc`, or
 * `local,oidc` for both side by side.
 */

export const AUTH_METHODS = ["local", "oidc"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** The one provider id. It is part of the callback URL a host registers. */
export const OIDC_PROVIDER_ID = "oidc";
/** Where the provider sends people back to. Relative to the app's origin. */
export const OIDC_CALLBACK_PATH = `/api/auth/callback/${OIDC_PROVIDER_ID}`;

type Env = Record<string, string | undefined>;

/**
 * Which methods are on.
 *
 * Unset means `local`, so an instance that is upgraded behaves exactly as it
 * did. A name that is not a method is an error rather than something to skip,
 * and so is an empty list: `AUTH_METHODS=oicd` quietly meaning "nobody can
 * sign in" is not a failure anyone should have to diagnose from a login page.
 */
export function authMethods(raw: string | undefined = process.env.AUTH_METHODS): Record<AuthMethod, boolean> {
  if (raw === undefined || raw.trim() === "") return { local: true, oidc: false };
  const names = raw.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !(AUTH_METHODS as readonly string[]).includes(n));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(
      `AUTH_METHODS is ${JSON.stringify(raw)}; it must be one or more of ` +
        `${AUTH_METHODS.join(", ")}, comma-separated.`,
    );
  }
  return { local: names.includes("local"), oidc: names.includes("oidc") };
}

/**
 * How a new person gets an account through the provider.
 *
 *   invite   the printer owner invites an address first, as ever. Signing in
 *            through the provider with that address — verified by the provider
 *            — opens the account. The provider replaces the password, not the
 *            guest list.
 *   open     anybody the provider signs in gets an account. The guest list is
 *            then the provider's, and the invite-only rule this app is built
 *            around is off for single sign-on. A host has to ask for it.
 */
export const OIDC_SIGNUP_MODES = ["invite", "open"] as const;
export type OidcSignup = (typeof OIDC_SIGNUP_MODES)[number];

export type OidcConfig = {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  /** What the button says: "Sign in with <name>". */
  name: string;
  signup: OidcSignup;
  /** Sent to the provider as `prompt`, when a host asks for one. */
  prompt: OidcPrompt | undefined;
};

/**
 * `login` makes the provider ask for credentials every time, instead of
 * waving through whoever has a session with it. On a shared machine that is
 * the difference between single sign-on and "whoever sat down last": this
 * app's own re-authentication is only as strong as the provider's willingness
 * to ask again. Unset by default, which is what most people mean by SSO.
 */
export const OIDC_PROMPTS = ["login", "select_account", "consent"] as const;
export type OidcPrompt = (typeof OIDC_PROMPTS)[number];

const isLoopbackHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/**
 * The provider's settings, or null when single sign-on is off.
 *
 * Everything missing or malformed is an error that names the variable. A
 * half-configured provider that silently leaves the button off — or worse,
 * leaves it on and failing — is the quiet kind of broken.
 */
export function oidcConfig(env: Env = process.env): OidcConfig | null {
  if (!authMethods(env.AUTH_METHODS).oidc) return null;

  const need = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`AUTH_METHODS includes oidc, so ${key} is required.`);
    return value;
  };

  const rawIssuer = need("OIDC_ISSUER");
  let issuer: URL;
  try {
    issuer = new URL(rawIssuer);
  } catch {
    throw new Error(`OIDC_ISSUER is not a URL: ${JSON.stringify(rawIssuer)}.`);
  }
  // The provider hands back the tokens that say who somebody is; over plain
  // HTTP anyone on the path can read or replace them. Loopback is exempt
  // because it never leaves the machine, and `OIDC_ALLOW_INSECURE_ISSUER`
  // exists for the suites, whose stand-in provider is a container on a private
  // compose network with no certificate. It should never be set in a deployment.
  if (
    issuer.protocol !== "https:" &&
    !(issuer.protocol === "http:" && (isLoopbackHost(issuer.hostname) || env.OIDC_ALLOW_INSECURE_ISSUER === "true"))
  ) {
    throw new Error(
      `OIDC_ISSUER must be an https:// URL (got ${JSON.stringify(rawIssuer)}). ` +
        "It is where the tokens that identify people come from.",
    );
  }

  const signup = (env.OIDC_SIGNUP?.trim().toLowerCase() || "invite") as OidcSignup;
  if (!(OIDC_SIGNUP_MODES as readonly string[]).includes(signup)) {
    throw new Error(
      `OIDC_SIGNUP is ${JSON.stringify(env.OIDC_SIGNUP)}; it must be one of ${OIDC_SIGNUP_MODES.join(", ")}.`,
    );
  }

  const prompt = env.OIDC_PROMPT?.trim().toLowerCase() || undefined;
  if (prompt !== undefined && !(OIDC_PROMPTS as readonly string[]).includes(prompt)) {
    throw new Error(
      `OIDC_PROMPT is ${JSON.stringify(env.OIDC_PROMPT)}; it must be one of ${OIDC_PROMPTS.join(", ")}, or unset.`,
    );
  }

  const base = rawIssuer.replace(/\/+$/, "");
  return {
    issuer: base,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
    clientId: need("OIDC_CLIENT_ID"),
    clientSecret: need("OIDC_CLIENT_SECRET"),
    name: env.OIDC_NAME?.trim() || "single sign-on",
    signup,
    prompt: prompt as OidcPrompt | undefined,
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type ProvisionRequest = {
  /** Is there a pending invitation for this address? */
  invited: boolean;
  /** Is this request the redemption of that invitation's link? */
  claimingLink: boolean;
  /** Did the identity arrive from the configured OIDC provider? */
  viaOidc: boolean;
  /** Did that provider say, in so many words, that it verified the address? */
  emailVerifiedByProvider: boolean;
  /** Null when single sign-on is off. */
  oidcSignup: OidcSignup | null;
};

export type ProvisionRefusal = "no_invitation" | "no_link" | "unverified_email" | "sso_off";

/**
 * May a new account be created for this request?
 *
 * The invite-only rule, for every way in. It is called from the one hook
 * Better Auth runs before provisioning anybody (`validateUserInfo` in
 * `auth.ts`), so there is still exactly one place this is decided.
 *
 * **Local.** A pending invitation *and* the redemption of its link. The
 * address alone is not enough, because the sign-up endpoint answers anybody —
 * that was finding 10 in the security audit.
 *
 * **Through the provider.** A pending invitation *and* the provider's word that
 * the address is verified. No link — and that is not finding 10 again. There,
 * the address was something a stranger typed into a request. Here it is a
 * claim in a token signed by the identity provider this deployment chose to
 * trust, bound to the request that asked for it. The link was only ever proof
 * that somebody could read the mailbox; the provider's `email_verified` is the
 * same proof from a better witness. Without that claim, exactly `true`, the
 * address is just a string again and is refused.
 *
 * **`open`.** The invitation is not required. Still verified addresses only.
 */
export function mayProvision(r: ProvisionRequest): { ok: true } | { ok: false; reason: ProvisionRefusal } {
  if (r.viaOidc) {
    if (r.oidcSignup === null) return { ok: false, reason: "sso_off" };
    if (!r.emailVerifiedByProvider) return { ok: false, reason: "unverified_email" };
    if (r.oidcSignup === "open") return { ok: true };
    return r.invited ? { ok: true } : { ok: false, reason: "no_invitation" };
  }
  if (!r.invited) return { ok: false, reason: "no_invitation" };
  if (!r.claimingLink) return { ok: false, reason: "no_link" };
  return { ok: true };
}

/**
 * The Better Auth endpoints that are switched off in each mode.
 *
 * Hiding a form is not turning a method off. With `local` out of
 * `AUTH_METHODS`, the password and passkey endpoints themselves refuse, so a
 * request sent straight at them gets nowhere.
 */
export function disabledAuthPaths(methods: Record<AuthMethod, boolean>): string[] {
  const off: string[] = [];
  if (!methods.local) {
    off.push(
      "/sign-in/username",
      "/sign-in/email",
      "/sign-up/email",
      "/reset-password",
      "/request-password-reset",
      "/change-password",
      "/passkey/generate-register-options",
      "/passkey/verify-registration",
      "/passkey/generate-authenticate-options",
      "/passkey/verify-authentication",
    );
  }
  if (methods.oidc) {
    // An identity is attached to an account one way only: by signing in with a
    // provider-verified address that matches. Linking on request, to whatever
    // identity the browser holds, is a second path this app does not offer.
    off.push("/link-social");
  } else {
    off.push("/sign-in/social", "/link-social");
  }
  return off;
}

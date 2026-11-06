/**
 * With passwords off, the app's own server code still refuses them.
 *
 * Run by `verify:sso`, never by hand, as a child process with
 * `AUTH_METHODS=oidc` — the stack under test runs `local,oidc`, so this is the
 * only way to see the other mode's server side:
 *
 *   tsx --import ./scripts/_server-only.mjs scripts/passwords-off-probe.ts
 *
 * Also the one check that needs the app's own Better Auth instance in hand:
 * that updating a linked account stores none of the provider's tokens.
 *
 * `disabledPaths` closes the HTTP endpoints. These are the doors beside them:
 * Better Auth's endpoints called in process (`auth.api.*`), and the server
 * actions that call them or write on the way. The parent sets up an invitation
 * and a set-password link, reads what this prints, and checks the database for
 * anything written.
 *
 * The actions answer outside a request here, so whatever they do after the
 * refusal — `headers()`, the message catalogue — throws instead; what matters
 * is that nothing was written before that, and the parent checks exactly that.
 */
import "./_env";

type Outcome = { returned?: unknown; threw?: string; status?: unknown };

async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { returned: await fn() };
  } catch (e) {
    const err = e as { message?: string; status?: unknown; statusCode?: unknown };
    return { threw: String(err?.message ?? e), status: err?.statusCode ?? err?.status };
  }
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function main() {
  const { auth } = await import("../src/lib/auth");
  const { acceptInvite } = await import("../src/app/invite/[token]/actions");
  const { setPassword } = await import("../src/app/set-password/actions");
  const { issuePasswordSetupUrl } = await import("../src/lib/password-reset");

  const password = "a-perfectly-long-probe-password";
  const out = {
    acceptInvite: await attempt(() =>
      acceptInvite({}, form({ token: process.env.PROBE_INVITE_TOKEN!, name: "Probe Renamed", username: "probe_claimer", password })),
    ),
    setPassword: await attempt(() =>
      setPassword({}, form({ token: process.env.PROBE_RESET_TOKEN!, password, username: "probe_squatter" })),
    ),
    issuePasswordSetupUrl: await attempt(() => issuePasswordSetupUrl(process.env.PROBE_USER_ID!)),
    signUpEmail: await attempt(() =>
      auth.api.signUpEmail({ body: { email: process.env.PROBE_INVITE_EMAIL!, password, name: "Probe" } }),
    ),
    resetPassword: await attempt(() =>
      auth.api.resetPassword({ body: { token: process.env.PROBE_RESET_TOKEN!, newPassword: password } }),
    ),
    // What Better Auth's link path does to an identity already attached: the
    // account update hook is what keeps the tokens out (not a passwords-off
    // matter, but this is where the app's own Better Auth instance is at hand).
    updateAccount: await attempt(async () => {
      const ctx = await auth.$context;
      await ctx.internalAdapter.updateAccount(process.env.PROBE_ACCOUNT_ID!, {
        accessToken: "leaked-access", refreshToken: "leaked-refresh", idToken: "leaked-id",
      });
      return "updated";
    }),
  };
  console.log(`PROBE ${JSON.stringify(out)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

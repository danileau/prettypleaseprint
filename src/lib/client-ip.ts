/**
 * Which header carries the real client address — the pure half of the audit
 * trail's provenance.
 *
 * Its own module, and free of `server-only`, for the same reason `scope.ts`
 * is: this is a decision worth testing directly, and the alternative is
 * standing the whole stack up and restarting it once per mode to check which
 * header wins.
 *
 * A forwarded address is only as trustworthy as the hop that set it, and
 * *which* header to believe depends on what is actually in front of the app —
 * so this is a named source rather than a boolean. Getting it wrong does not
 * fail loudly: it quietly fills the audit trail with addresses the client
 * chose, which is worse than no address at all.
 *
 *   unset / "false"   nothing is trusted. The trail records no address, and a
 *                     blank is honestly a blank. This is the default and the
 *                     right answer whenever the app can be reached without
 *                     passing through a proxy.
 *
 *   "true"            left-most `X-Forwarded-For`. Correct for a proxy that
 *                     *replaces* the header — Nginx Proxy Manager with
 *                     `proxy_set_header X-Forwarded-For $remote_addr`, say —
 *                     and only when the app is unreachable except through it.
 *
 *   "cloudflare"      `CF-Connecting-IP`. Required behind Cloudflare, because
 *                     Cloudflare *appends* to `X-Forwarded-For` rather than
 *                     replacing it: a client can send their own value and
 *                     Cloudflare adds the real one after it, leaving the
 *                     left-most entry attacker-chosen. `CF-Connecting-IP` is
 *                     overwritten at the edge and cannot be spoofed through
 *                     it.
 *
 * The two modes never fall back to one another. Under "cloudflare" a request
 * arriving without `CF-Connecting-IP` did not come through Cloudflare, and
 * reading `X-Forwarded-For` instead would reintroduce exactly the hole this
 * setting exists to close.
 */
export type IpSource = "none" | "forwarded" | "cloudflare";

export function ipSource(raw = process.env.TRUST_PROXY_HEADERS): IpSource {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "cloudflare":
      return "cloudflare";
    case "true":
      return "forwarded";
    default:
      return "none";
  }
}

/** Longest possible IPv6 with a zone, rounded up. Anything longer is junk. */
const MAX_IP = 64;

/**
 * Pure, so it can be tested without standing a server up and restarting it
 * once per mode — which is why the mode is a parameter rather than read here.
 */
export function clientIpFrom(h: Headers, source: IpSource): string | null {
  let value: string | null = null;

  if (source === "cloudflare") {
    value = h.get("cf-connecting-ip");
  } else if (source === "forwarded") {
    // Left-most entry is the original client as the first proxy saw it.
    value = h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? null;
  }

  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_IP) return null;
  return trimmed;
}


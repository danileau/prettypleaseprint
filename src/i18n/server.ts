import { getMessages } from "next-intl/server";

/**
 * This request's messages, cut down to the groups one screen's client
 * components use — what that screen hands to its `NextIntlClientProvider`.
 * Which groups, and why not all of them: ./client-groups.ts.
 */
export async function getClientMessages(groups: readonly string[]): Promise<Record<string, unknown>> {
  const all = (await getMessages()) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const path of groups) {
    const parts = path.split(".");
    let from: unknown = all;
    let to = out;
    parts.forEach((part, i) => {
      from = (from as Record<string, unknown> | undefined)?.[part];
      if (i === parts.length - 1) to[part] = from;
      else to = (to[part] ??= {}) as Record<string, unknown>;
    });
  }
  return out;
}

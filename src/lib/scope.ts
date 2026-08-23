/**
 * The pure authorisation rules — no session, no database, no request.
 *
 * These are deliberately separate from `authz.ts`, which is `server-only`
 * because it reads cookies. Keeping the predicates here means they can be
 * imported by tests and probes and exercised directly, rather than being
 * re-implemented (and drifting) wherever they need checking.
 */
import type { Prisma, StoryStatus } from "@prisma/client";

export type Actor = {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: "client" | "admin";
};

/**
 * The handoff's core rule:
 *
 *   Client -> only stories where uploaderId == self
 *   Admin  -> everything
 *
 * Every list query composes this. One place to audit, and a new screen
 * cannot quietly forget it.
 */
export function storyScope(actor: Actor): Prisma.StoryWhereInput {
  return actor.role === "admin" ? {} : { uploaderId: actor.id };
}

/**
 * Display key: PPP-104 for story 4.
 *
 * The handoff writes this as "PTFM-", after the product's old name. The
 * prefix exists to be recognisable when someone pastes it into chat, so it
 * tracks what the product is actually called.
 */
export const storyRef = (id: number) => `PPP-${100 + id}`;

export const FLOW = [
  "Requested",
  "Accepted",
  "Printing",
  "Done",
  "Delivery",
] as const satisfies readonly StoryStatus[];

export function nextStatus(current: StoryStatus): StoryStatus | null {
  const i = (FLOW as readonly string[]).indexOf(current);
  if (i < 0 || i === FLOW.length - 1) return null;
  return FLOW[i + 1]!;
}

export class AuthzError extends Error {}

/**
 * Only the admin moves a story, only forwards, only one step at a time.
 * `Declined` is reachable from `Requested` alone.
 */
export function assertTransition(
  actor: Actor,
  from: StoryStatus,
  to: StoryStatus,
): void {
  if (actor.role !== "admin") {
    throw new AuthzError("Only the printer owner moves a story along.");
  }
  if (to === "Declined") {
    if (from !== "Requested") {
      throw new AuthzError(`Cannot decline a story that is already ${from}.`);
    }
    return;
  }
  if (nextStatus(from) !== to) {
    throw new AuthzError(`${from} → ${to} is not a step along the flow.`);
  }
}

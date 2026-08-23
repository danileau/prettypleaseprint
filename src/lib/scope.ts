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

/**
 * The order a request moves through, and the only order it may move in.
 *
 * `Done` is the end, not the middle. It used to sit before `Delivery`, meaning
 * "off the plate" — which left the board with nowhere to put work that was
 * genuinely finished, so delivered tickets stayed on the rail forever and the
 * rail stopped meaning "what is still moving". Now `Delivery` is "printed,
 * waiting to be collected" and `Done` is "handed over", which is also how
 * people actually describe it.
 *
 * Note the enum in schema.prisma keeps its original member order: Postgres
 * cannot reorder enum values without rebuilding the type, and the order there
 * carries no meaning. This array is where the sequence lives.
 */
export const FLOW = [
  "Requested",
  "Accepted",
  "Printing",
  "Delivery",
  "Done",
] as const satisfies readonly StoryStatus[];

/**
 * The columns the board draws — the flow minus its terminal state.
 *
 * The rail carries what is still moving. A finished ticket leaves it and lives
 * on in the profile, which is the whole point of having an end state: without
 * one the board only ever grows.
 */
export const BOARD = FLOW.slice(0, -1) as readonly StoryStatus[];

/** Is this the end of the line? */
export function isTerminal(status: StoryStatus): boolean {
  return status === FLOW[FLOW.length - 1] || status === "Declined";
}

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

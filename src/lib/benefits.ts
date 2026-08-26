import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import type { Actor } from "@/lib/scope";

/**
 * The "benefits" catalogue — the tips a requester can offer the printer owner,
 * owner-managed rather than a hardcoded const.
 *
 * Reads are open (any signed-in page renders the list); mutations are
 * owner-only and re-check the role here as well as at the action, because
 * rendering a page is not authorisation. Every change is audited.
 *
 * `Story.tip` is a plain string, deliberately: editing or retiring a benefit
 * never rewrites a request that already offered it. `active` retires without
 * deleting that history; `preferred` is what the upload form highlights.
 */

export class BenefitProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenefitProblem";
  }
}

const LabelSchema = z
  .string()
  .trim()
  .min(1, "Give the benefit a name.")
  .max(80, "Keep it short — under 80 characters.");

function assertAdmin(actor: Actor) {
  if (actor.role !== "admin") {
    throw new BenefitProblem("Only the printer owner manages benefits.");
  }
}

function refresh() {
  revalidatePath("/admin/benefits");
  revalidatePath("/upload");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ORDER = [{ sortOrder: "asc" as const }, { label: "asc" as const }];

export type BenefitRow = {
  id: string;
  label: string;
  preferred: boolean;
  active: boolean;
  sortOrder: number;
};

const SELECT = { id: true, label: true, preferred: true, active: true, sortOrder: true } as const;

/** The choices the upload form offers, ordered. */
export function listActiveBenefits(): Promise<BenefitRow[]> {
  return db.benefit.findMany({ where: { active: true }, select: SELECT, orderBy: ORDER });
}

/** Everything, for the admin screen. */
export function listAllBenefits(): Promise<BenefitRow[]> {
  return db.benefit.findMany({ select: SELECT, orderBy: ORDER });
}

/** The labels an upload's tip is allowed to be. Authoritative on the server. */
export async function activeBenefitLabels(): Promise<string[]> {
  const rows = await db.benefit.findMany({ where: { active: true }, select: { label: true } });
  return rows.map((r) => r.label);
}

/** The active benefits the owner has marked preferred, for the "prefers" line. */
export async function preferredBenefitLabels(): Promise<string[]> {
  const rows = await db.benefit.findMany({
    where: { active: true, preferred: true },
    select: { label: true },
    orderBy: ORDER,
  });
  return rows.map((r) => r.label);
}

// ---------------------------------------------------------------------------
// Mutations (owner-only)
// ---------------------------------------------------------------------------

export async function createBenefit(actor: Actor, rawLabel: unknown): Promise<BenefitRow> {
  assertAdmin(actor);

  const parsed = LabelSchema.safeParse(typeof rawLabel === "string" ? rawLabel : "");
  if (!parsed.success) throw new BenefitProblem(parsed.error.issues[0]?.message ?? "Check the name.");
  const label = parsed.data;

  const last = await db.benefit.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });

  let created: BenefitRow;
  try {
    created = await db.benefit.create({
      data: { label, sortOrder: (last?.sortOrder ?? 0) + 1 },
      select: SELECT,
    });
  } catch {
    // Unique violation on label, or anything else — either way the caller gets
    // a sentence rather than a stack.
    throw new BenefitProblem(`“${label}” is already on the list.`);
  }

  await record({ action: "benefit.created", actor, subject: label });
  refresh();
  return created;
}

export async function updateBenefit(
  actor: Actor,
  id: string,
  patch: { label?: unknown; preferred?: boolean; active?: boolean },
): Promise<BenefitRow> {
  assertAdmin(actor);

  const existing = await db.benefit.findUnique({ where: { id }, select: SELECT });
  if (!existing) throw new BenefitProblem("That benefit no longer exists.");

  const data: { label?: string; preferred?: boolean; active?: boolean } = {};
  const detail: Record<string, unknown> = {};

  if (patch.label !== undefined) {
    const parsed = LabelSchema.safeParse(typeof patch.label === "string" ? patch.label : "");
    if (!parsed.success) throw new BenefitProblem(parsed.error.issues[0]?.message ?? "Check the name.");
    if (parsed.data !== existing.label) {
      data.label = parsed.data;
      detail.label = { from: existing.label, to: parsed.data };
    }
  }
  if (patch.preferred !== undefined && patch.preferred !== existing.preferred) {
    data.preferred = patch.preferred;
    detail.preferred = patch.preferred;
  }
  if (patch.active !== undefined && patch.active !== existing.active) {
    data.active = patch.active;
    detail.active = patch.active;
  }

  if (Object.keys(data).length === 0) return existing; // nothing changed

  let updated: BenefitRow;
  try {
    updated = await db.benefit.update({ where: { id }, data, select: SELECT });
  } catch {
    throw new BenefitProblem(`“${data.label}” is already on the list.`);
  }

  await record({ action: "benefit.updated", actor, subject: updated.label, detail });
  refresh();
  return updated;
}

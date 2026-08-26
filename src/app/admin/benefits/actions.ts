"use server";

import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/authz";
import { BenefitProblem, createBenefit, updateBenefit } from "@/lib/benefits";

/**
 * The owner's controls for the benefits catalogue, as plain server-action
 * forms — the rules and the audit live in `src/lib/benefits.ts`; this reads a
 * `FormData`, calls the operation and redirects with a toast. Every action
 * re-checks the role: rendering the page is not authorisation.
 */

function back(params: Record<string, string>): never {
  redirect(`/admin/benefits?${new URLSearchParams(params).toString()}`);
}

export async function createBenefitAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  try {
    const b = await createBenefit(admin, formData.get("label") ?? "");
    back({ toast: `Added “${b.label}”` });
  } catch (error) {
    if (error instanceof BenefitProblem) back({ error: error.message });
    throw error;
  }
}

export async function renameBenefitAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  try {
    const b = await updateBenefit(admin, id, { label: formData.get("label") ?? "" });
    back({ toast: `Renamed to “${b.label}”` });
  } catch (error) {
    if (error instanceof BenefitProblem) back({ error: error.message });
    throw error;
  }
}

export async function setPreferredAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const preferred = formData.get("preferred") === "true";
  try {
    const b = await updateBenefit(admin, id, { preferred });
    back({ toast: preferred ? `“${b.label}” marked preferred` : `“${b.label}” no longer preferred` });
  } catch (error) {
    if (error instanceof BenefitProblem) back({ error: error.message });
    throw error;
  }
}

export async function setActiveAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  try {
    const b = await updateBenefit(admin, id, { active });
    back({ toast: active ? `“${b.label}” back on the list` : `“${b.label}” retired` });
  } catch (error) {
    if (error instanceof BenefitProblem) back({ error: error.message });
    throw error;
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { record } from "@/lib/audit";
import { COLOR_MODES } from "@/lib/catalog";

const Name = z.string().trim().min(1).max(40).transform((value) => value.replace(/\s+/g, " "));
const Hex = z.string().regex(/^#[0-9a-f]{6}$/i).transform((value) => value.toLowerCase());
const WHATEVER_STYLE = "linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)";
const Direction = z.enum(["up", "down"]);
const Mode = z.enum(COLOR_MODES);

function colorInput(formData: FormData) {
  const parsedName = Name.safeParse(formData.get("name"));
  if (!parsedName.success) back("error", "Give the colour a name between 1 and 40 characters.");
  const name = parsedName.data;
  const parsedMode = Mode.safeParse(formData.get("mode"));
  if (!parsedMode.success) back("error", "Choose a valid swatch type.");
  const mode = parsedMode.data;
  const parsedHex = mode === "whatever" ? null : Hex.safeParse(formData.get("hex"));
  const parsedHexTo = mode !== "gradient" ? null : Hex.safeParse(formData.get("hexTo"));
  if (parsedHex && !parsedHex.success) back("error", "Choose a valid colour.");
  if (parsedHexTo && !parsedHexTo.success) back("error", "Choose a valid second gradient colour.");
  const hex = mode === "whatever" ? "#7557c7" : parsedHex!.data;
  const style = mode === "whatever"
    ? WHATEVER_STYLE
    : mode === "gradient"
      ? `linear-gradient(135deg, ${hex}, ${parsedHexTo!.data})`
      : hex;
  return { name, hex, style, mode };
}

function back(kind: "toast" | "error", message: string): never {
  redirect(`/admin/catalog?${kind}=${encodeURIComponent(message)}`);
}

function duplicate(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function addMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = Name.safeParse(formData.get("name"));
  if (!parsed.success) back("error", "Material names must be between 1 and 40 characters.");

  const last = await db.catalogMaterial.aggregate({ _max: { sortOrder: true } });
  try {
    await db.catalogMaterial.create({
      data: { name: parsed.data, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
  } catch (error) {
    if (duplicate(error)) back("error", `${parsed.data} is already in the catalog.`);
    throw error;
  }
  await record({ action: "catalog.material_added", actor: admin, subject: parsed.data });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${parsed.data} added. Give it at least one colour to offer it.`);
}

export async function toggleMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const material = await db.catalogMaterial.findUnique({ where: { id } });
  if (!material) back("error", "That material no longer exists.");
  const updated = await db.catalogMaterial.update({
    where: { id },
    data: { active: !material.active },
  });
  await record({
    action: "catalog.material_availability_changed",
    actor: admin,
    subject: material.name,
    detail: { active: updated.active },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${material.name} is now ${updated.active ? "available" : "unavailable"}.`);
}

export async function editMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const parsedName = Name.safeParse(formData.get("name"));
  if (!parsedName.success) back("error", "Material names must be between 1 and 40 characters.");
  const material = await db.catalogMaterial.findUnique({ where: { id }, select: { name: true } });
  if (!material) back("error", "That material no longer exists.");
  try {
    await db.catalogMaterial.update({ where: { id }, data: { name: parsedName.data } });
  } catch (error) {
    if (duplicate(error)) back("error", `${parsedName.data} is already in the catalog.`);
    throw error;
  }
  await record({
    action: "catalog.material_updated",
    actor: admin,
    subject: parsedName.data,
    detail: { previousName: material.name },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${material.name} renamed to ${parsedName.data}.`);
}

export async function removeMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const material = await db.catalogMaterial.findUnique({
    where: { id },
    select: { name: true, _count: { select: { colors: true } } },
  });
  if (!material) back("error", "That material no longer exists.");
  await db.catalogMaterial.delete({ where: { id } });
  await record({
    action: "catalog.material_removed",
    actor: admin,
    subject: material.name,
    detail: { colorsRemoved: material._count.colors },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${material.name} and its colours were removed. Old tickets are unchanged.`);
}

export async function moveMaterialAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const parsedDirection = Direction.safeParse(formData.get("direction"));
  if (!parsedDirection.success) back("error", "Choose a valid direction.");

  const materials = await db.catalogMaterial.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  const from = materials.findIndex((material) => material.id === id);
  if (from < 0) back("error", "That material no longer exists.");
  const to = parsedDirection.data === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= materials.length) back("error", "That material is already at the end of the list.");
  [materials[from], materials[to]] = [materials[to], materials[from]];
  await db.$transaction(
    materials.map((material, sortOrder) => db.catalogMaterial.update({
      where: { id: material.id },
      data: { sortOrder },
    })),
  );
  await record({
    action: "catalog.material_reordered",
    actor: admin,
    subject: materials[to].name,
    detail: { direction: parsedDirection.data, position: to + 1 },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${materials[to].name} moved ${parsedDirection.data}.`);
}

export async function addColorAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const materialId = String(formData.get("materialId") ?? "");
  const { name, hex, style, mode } = colorInput(formData);

  const material = await db.catalogMaterial.findUnique({
    where: { id: materialId },
    include: { colors: { select: { sortOrder: true } } },
  });
  if (!material) back("error", "That material no longer exists.");
  const sortOrder = material.colors.reduce((max, color) => Math.max(max, color.sortOrder), -1) + 1;
  try {
    await db.catalogColor.create({
      data: { materialId, name, hex, style, mode, sortOrder },
    });
  } catch (error) {
    if (duplicate(error)) back("error", `${material.name} already has a colour named ${name}.`);
    throw error;
  }
  await record({
    action: "catalog.color_added",
    actor: admin,
    subject: `${material.name} · ${name}`,
    detail: { hex, style, mode },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${name} added to ${material.name}.`);
}

export async function editColorAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const { name, hex, style, mode } = colorInput(formData);
  const color = await db.catalogColor.findUnique({
    where: { id },
    include: { material: { select: { name: true } } },
  });
  if (!color) back("error", "That colour no longer exists.");
  try {
    await db.catalogColor.update({ where: { id }, data: { name, hex, style, mode } });
  } catch (error) {
    if (duplicate(error)) back("error", `${color.material.name} already has a colour named ${name}.`);
    throw error;
  }
  await record({
    action: "catalog.color_updated",
    actor: admin,
    subject: `${color.material.name} · ${name}`,
    detail: { previousName: color.name, previousStyle: color.style, previousMode: color.mode, hex, style, mode },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${name} updated for ${color.material.name}.`);
}

export async function toggleColorAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const color = await db.catalogColor.findUnique({
    where: { id },
    include: { material: { select: { name: true } } },
  });
  if (!color) back("error", "That colour no longer exists.");
  const updated = await db.catalogColor.update({
    where: { id },
    data: { active: !color.active },
  });
  await record({
    action: "catalog.color_availability_changed",
    actor: admin,
    subject: `${color.material.name} · ${color.name}`,
    detail: { active: updated.active, hex: color.hex },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${color.name} is now ${updated.active ? "available" : "unavailable"} for ${color.material.name}.`);
}

export async function removeColorAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const color = await db.catalogColor.findUnique({
    where: { id },
    include: { material: { select: { name: true } } },
  });
  if (!color) back("error", "That colour no longer exists.");
  await db.catalogColor.delete({ where: { id } });
  await record({
    action: "catalog.color_removed",
    actor: admin,
    subject: `${color.material.name} · ${color.name}`,
    detail: { hex: color.hex, style: color.style },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${color.name} was removed from ${color.material.name}. Old tickets are unchanged.`);
}

export async function moveColorAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const parsedDirection = Direction.safeParse(formData.get("direction"));
  if (!parsedDirection.success) back("error", "Choose a valid direction.");

  const selected = await db.catalogColor.findUnique({
    where: { id },
    select: { materialId: true, material: { select: { name: true } } },
  });
  if (!selected) back("error", "That colour no longer exists.");
  const colors = await db.catalogColor.findMany({
    where: { materialId: selected.materialId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  const from = colors.findIndex((color) => color.id === id);
  const to = parsedDirection.data === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= colors.length) back("error", "That colour is already at the end of the list.");
  [colors[from], colors[to]] = [colors[to], colors[from]];
  await db.$transaction(
    colors.map((color, sortOrder) => db.catalogColor.update({
      where: { id: color.id },
      data: { sortOrder },
    })),
  );
  await record({
    action: "catalog.color_reordered",
    actor: admin,
    subject: `${selected.material.name} · ${colors[to].name}`,
    detail: { direction: parsedDirection.data, position: to + 1 },
  });
  revalidatePath("/admin/catalog");
  revalidatePath("/upload");
  back("toast", `${colors[to].name} moved ${parsedDirection.data} for ${selected.material.name}.`);
}

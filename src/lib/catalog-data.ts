import "server-only";

import { db } from "@/lib/db";
import type { CatalogMaterialChoice } from "@/lib/catalog";

/** Only materials with at least one available colour can be requested. */
export async function availableCatalog(): Promise<CatalogMaterialChoice[]> {
  const materials = await db.catalogMaterial.findMany({
    where: { active: true, colors: { some: { active: true } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      colors: {
        where: { active: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, hex: true, style: true, mode: true },
      },
    },
  });
  return materials;
}

/**
 * Material labels that can appear in history filters. This includes retired
 * or renamed catalog entries whenever an existing story still snapshots the
 * old label.
 */
export async function knownMaterialNames(): Promise<string[]> {
  const [catalogMaterials, storyMaterials] = await Promise.all([
    db.catalogMaterial.findMany({ select: { name: true } }),
    db.story.findMany({ distinct: ["material"], select: { material: true } }),
  ]);

  return [...new Set([
    ...catalogMaterials.map(({ name }) => name),
    ...storyMaterials.map(({ material }) => material),
  ])].sort((a, b) => a.localeCompare(b));
}

/** Authoritative lookup used at submission time, not the browser's copy. */
export function availableSelection(material: string, colorName: string) {
  return db.catalogColor.findFirst({
    where: {
      active: true,
      name: colorName,
      material: { active: true, name: material },
    },
    select: { hex: true, style: true, mode: true },
  });
}

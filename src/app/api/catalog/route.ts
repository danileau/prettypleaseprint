import { ok, withActor } from "@/lib/api";
import { availableCatalog } from "@/lib/catalog-data";
import { enabledSources } from "@/lib/import-source";

/**
 * What can be asked for right now: the materials on the shelf, each with the
 * colours it comes in, in the owner's order.
 *
 * It exists because the choices stopped being a fixed list. While they were,
 * the OpenAPI document could enumerate them; once the owner manages them, a
 * client of `POST /api/upload` has no way to learn a valid pair except by
 * reading the upload page's HTML. This is the same read that page makes.
 *
 * Any signed-in person may read it — it is what the request form shows them.
 * Retired entries are left out rather than flagged, exactly as on the form,
 * and nothing here says how to manage the catalogue: that is `/admin/catalog`
 * and it has no JSON door.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withActor(async () => {
  const materials = await availableCatalog();
  // Every field named, no row spread — see `storyResource` in src/lib/api.ts.
  return ok({
    // The other thing a client cannot learn any other way: whether this
    // instance imports from a link, and from where. Empty when it does not.
    importSources: enabledSources(),
    materials: materials.map((material) => ({
      name: material.name,
      colors: material.colors.map((color) => ({
        name: color.name,
        hex: color.hex,
        style: color.style,
        mode: color.mode,
      })),
    })),
  });
});

import { AppHeader } from "@/components/app-header";
import { Button, Input, Kicker, Label, Notice } from "@/components/ui";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { RemoveMaterialButton } from "./remove-material-button";
import { RemoveColorButton } from "./remove-color-button";
import { AddColorForm } from "./add-color-form";
import { EditMaterialInline } from "./edit-material-inline";
import { EditColorInline } from "./edit-color-inline";
import {
  addMaterialAction,
  moveColorAction,
  moveMaterialAction,
  toggleColorAction,
  toggleMaterialAction,
} from "./actions";

export const dynamic = "force-dynamic";

function OrderButtons({
  id,
  name,
  first,
  last,
  action,
}: {
  id: string;
  name: string;
  first: boolean;
  last: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const buttonClass = "flex h-[28px] w-[28px] items-center justify-center rounded-chip border-2 border-ink bg-porcelain font-mono text-[14px] font-bold text-ink hover:bg-aqua disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-porcelain";
  return (
    <div className="flex flex-none gap-[4px]" aria-label={`Order ${name}`}>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="direction" value="up" />
        <button type="submit" disabled={first} aria-label={`Move ${name} up`} title="Move up" className={buttonClass}>↑</button>
      </form>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="direction" value="down" />
        <button type="submit" disabled={last} aria-label={`Move ${name} down`} title="Move down" className={buttonClass}>↓</button>
      </form>
    </div>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [admin, params, materials] = await Promise.all([
    requireAdmin(),
    searchParams,
    db.catalogMaterial.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { colors: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
    }),
  ]);

  return (
    <>
      <AppHeader user={admin} active="/admin/catalog" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Admin · what is on the shelf</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">Materials &amp; colours</h1>
        <p className="m-0 mb-[22px] max-w-[680px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
          Offer only combinations you can actually print today. Use the arrows to set the order shown on the request form. Turning something off hides it temporarily; removing it deletes the catalog entry and its colours. Old tickets are unchanged either way.
        </p>

        {params.toast && <div className="mb-[17.6px] max-w-[780px]"><Notice tone="good">{params.toast}</Notice></div>}
        {params.error && <div className="mb-[17.6px] max-w-[780px]"><Notice tone="warn">{params.error}</Notice></div>}

        <form action={addMaterialAction} className="mb-[26.4px] flex max-w-[680px] flex-wrap items-end gap-[13.2px] rounded-panel border-[3px] border-ink bg-aqua-wash p-[22px] shadow-stamp">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="material-name">Add a material</Label>
            <Input id="material-name" name="name" required maxLength={40} placeholder="ASA" />
          </div>
          <Button type="submit" variant="secondary">Add material</Button>
        </form>

        <div className="grid gap-[22px] lg:grid-cols-2">
          {materials.map((material, materialIndex) => (
            <section key={material.id} className={`rounded-panel border-[3px] border-ink p-[22px] shadow-stamp ${material.active ? "bg-porcelain" : "bg-cream-2"}`}>
              <div className="mb-[17.6px] flex flex-wrap items-center gap-[11px]">
                <EditMaterialInline id={material.id} name={material.name} />
                <OrderButtons
                  id={material.id}
                  name={material.name}
                  first={materialIndex === 0}
                  last={materialIndex === materials.length - 1}
                  action={moveMaterialAction}
                />
                <span className={`rounded-chip border-2 border-ink px-[10px] py-[2px] font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] ${material.active ? "bg-mint text-ink" : "bg-cream-3 text-ink-2"}`}>
                  {material.active ? "Available" : "Off shelf"}
                </span>
                <form action={toggleMaterialAction}>
                  <input type="hidden" name="id" value={material.id} />
                  <button type="submit" className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-sun px-[13px] py-[5px] font-mono text-[11px] font-bold uppercase text-ink hover:bg-aqua">
                    Turn {material.active ? "off" : "on"}
                  </button>
                </form>
                <RemoveMaterialButton id={material.id} name={material.name} />
              </div>

              <div className="space-y-[8.8px]">
                {material.colors.map((color, colorIndex) => (
                  <div key={color.id} className="flex flex-wrap items-center gap-[11px] rounded-card border-2 border-dashed border-rule bg-cream px-[11px] py-[8.8px]">
                    <EditColorInline
                      id={color.id}
                      name={color.name}
                      hex={color.hex}
                      colorStyle={color.style}
                      colorMode={color.mode}
                      materialName={material.name}
                    />
                    <OrderButtons
                      id={color.id}
                      name={`${color.name} for ${material.name}`}
                      first={colorIndex === 0}
                      last={colorIndex === material.colors.length - 1}
                      action={moveColorAction}
                    />
                    <form action={toggleColorAction}>
                      <input type="hidden" name="id" value={color.id} />
                      <button type="submit" className={`cursor-pointer rounded-chip border-2 border-ink px-[10px] py-[4px] font-mono text-[10.5px] font-bold uppercase ${color.active ? "bg-mint text-ink" : "bg-cream-3 text-ink-2"}`}>
                        {color.active ? "On" : "Off"}
                      </button>
                    </form>
                    <RemoveColorButton id={color.id} name={color.name} materialName={material.name} />
                  </div>
                ))}
                {material.colors.length === 0 && <p className="font-mono text-[11.5px] uppercase text-ink-3">No colours yet. This material will stay off the order form.</p>}
              </div>

              <AddColorForm materialId={material.id} />
            </section>
          ))}
        </div>
      </main>
    </>
  );
}

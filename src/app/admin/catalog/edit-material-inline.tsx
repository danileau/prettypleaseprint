import { Button, Input } from "@/components/ui";
import { editMaterialAction } from "./actions";

export function EditMaterialInline({ id, name }: { id: string; name: string }) {
  return (
    <details className="group min-w-[240px] flex-1">
      <summary
        className="cursor-pointer list-none rounded-[4px] font-display text-[27px] text-ink underline decoration-transparent decoration-2 underline-offset-4 hover:decoration-aqua focus-visible:decoration-aqua [&::-webkit-details-marker]:hidden"
        aria-label={`Edit material name ${name}`}
      >
        {name}
      </summary>
      <form action={editMaterialAction} className="mt-[6px] flex items-center gap-[6px]">
        <input type="hidden" name="id" value={id} />
        <Input name="name" defaultValue={name} required maxLength={40} aria-label={`Material name for ${name}`} />
        <Button type="submit" variant="ghost" className="px-[10px] py-[7px]">Save</Button>
      </form>
    </details>
  );
}

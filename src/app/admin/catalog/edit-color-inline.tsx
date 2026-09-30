"use client";

import { useState } from "react";

import { ColorSwatch } from "@/components/color-swatch";
import { Button, Input, Label } from "@/components/ui";
import type { ColorMode } from "@/lib/catalog";
import { editColorAction } from "./actions";

export function EditColorInline({
  id,
  name,
  hex,
  colorStyle,
  colorMode,
  materialName,
}: {
  id: string;
  name: string;
  hex: string;
  colorStyle: string;
  colorMode: ColorMode;
  materialName: string;
}) {
  const matches = colorStyle.match(/#[0-9a-f]{6}/gi) ?? [];
  const [mode, setMode] = useState<ColorMode>(colorMode);

  return (
    <details className="group min-w-[220px] flex-1">
      <summary
        className="flex cursor-pointer list-none items-center gap-[11px] rounded-card text-left hover:bg-aqua-wash focus-visible:bg-aqua-wash [&::-webkit-details-marker]:hidden"
        aria-label={`Edit ${name} for ${materialName}`}
      >
        <ColorSwatch mode={colorMode} style={colorStyle} className="h-[34px] w-[34px] flex-none rounded-full border-[3px] border-ink" />
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-ink">{name}</span>
          <span className="block truncate font-mono text-[10.5px] text-ink-3" title={colorStyle}>{colorStyle}</span>
        </span>
      </summary>

      <form action={editColorAction} className="mt-[6px] rounded-card border-2 border-aqua bg-porcelain p-[8px]">
        <input type="hidden" name="id" value={id} />
        <div className="flex flex-wrap items-end gap-[7px]">
          <div className="min-w-[150px] flex-1">
            <Label htmlFor={`edit-color-${id}`}>Colour name</Label>
            <Input id={`edit-color-${id}`} name="name" defaultValue={name} required maxLength={40} />
          </div>
          <div className="w-[115px]">
            <Label htmlFor={`edit-mode-${id}`}>Swatch</Label>
            <select
              id={`edit-mode-${id}`}
              name="mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as ColorMode)}
              className="h-[49px] w-full rounded-card border-[3px] border-ink bg-porcelain px-[7px] font-mono text-[11px] font-bold uppercase text-ink"
            >
              <option value="solid">Solid</option>
              <option value="gradient">Gradient</option>
              <option value="whatever">Whatever</option>
            </select>
          </div>
          {mode !== "whatever" && (
            <>
              <label className="block text-center font-mono text-[9.5px] font-bold uppercase text-ink-3">
                {mode === "gradient" ? "From" : "Colour"}
                <input aria-label={`Colour value for ${name}`} name="hex" type="color" defaultValue={matches[0] ?? hex} className="mt-[3px] block h-[45px] w-[50px] cursor-pointer rounded-card border-[3px] border-ink bg-porcelain p-[3px]" />
              </label>
              {mode === "gradient" && (
                <label className="block text-center font-mono text-[9.5px] font-bold uppercase text-ink-3">
                  To
                  <input aria-label={`Second gradient colour for ${name}`} name="hexTo" type="color" defaultValue={matches[1] ?? hex} className="mt-[3px] block h-[45px] w-[50px] cursor-pointer rounded-card border-[3px] border-ink bg-porcelain p-[3px]" />
                </label>
              )}
            </>
          )}
          {mode === "whatever" && <span className="rounded-chip border-2 border-ink bg-aqua-wash px-[9px] py-[6px] font-mono text-[9.5px] font-bold uppercase">Rainbow automatic</span>}
          <Button type="submit" variant="ghost" className="px-[10px] py-[7px]">Save</Button>
        </div>
      </form>
    </details>
  );
}

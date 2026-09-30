"use client";

import { useState } from "react";

import { Button, Input, Label } from "@/components/ui";
import type { ColorMode } from "@/lib/catalog";
import { addColorAction } from "./actions";

export function AddColorForm({ materialId }: { materialId: string }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ColorMode>("solid");

  return (
    <form action={addColorAction} className="mt-[17.6px] flex flex-wrap items-end gap-[8.8px]">
      <input type="hidden" name="materialId" value={materialId} />
      <div className="min-w-[190px] flex-1">
        <Label htmlFor={`color-${materialId}`}>Add a colour</Label>
        <Input
          id={`color-${materialId}`}
          name="name"
          required
          maxLength={40}
          placeholder="Signal orange"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="w-[125px]">
        <Label htmlFor={`mode-${materialId}`}>Swatch</Label>
        <select
          id={`mode-${materialId}`}
          name="mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as ColorMode)}
          className="h-[49px] w-full rounded-card border-[3px] border-ink bg-porcelain px-[8px] font-mono text-[12px] font-bold uppercase text-ink"
        >
          <option value="solid">Solid</option>
          <option value="gradient">Gradient</option>
          <option value="whatever">Whatever</option>
        </select>
      </div>
      {mode !== "whatever" && (
        <>
          <label className="block text-center font-mono text-[10px] font-bold uppercase text-ink-3">
            {mode === "gradient" ? "From" : "Colour"}
            <input aria-label="Colour" name="hex" type="color" defaultValue="#e4322f" className="mt-[3px] block h-[49px] w-[54px] cursor-pointer rounded-card border-[3px] border-ink bg-porcelain p-[3px]" />
          </label>
          {mode === "gradient" && (
            <label className="block text-center font-mono text-[10px] font-bold uppercase text-ink-3">
              To
              <input aria-label="Second gradient colour" name="hexTo" type="color" defaultValue="#2787c9" className="mt-[3px] block h-[49px] w-[54px] cursor-pointer rounded-card border-[3px] border-ink bg-porcelain p-[3px]" />
            </label>
          )}
        </>
      )}

      {mode === "whatever" && (
        <p className="m-0 self-center rounded-chip border-2 border-ink bg-aqua-wash px-[11px] py-[7px] font-mono text-[10.5px] font-bold uppercase text-ink">
          Rainbow chosen automatically
        </p>
      )}
      <Button type="submit" variant="ghost" className="px-[14px] py-[10px]">Add</Button>
    </form>
  );
}

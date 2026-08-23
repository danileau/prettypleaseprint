"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  COLORS,
  DEFAULT_COLOR,
  DEFAULT_MATERIAL,
  DEFAULT_TIP,
  MATERIALS,
  QUANTITY_PRESETS,
  TIPS,
} from "@/lib/catalog";
import { Button, Label, Notice } from "@/components/ui";

const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPTED = [".stl", ".3mf"];

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number }
  | { kind: "error"; message: string };

/** Segmented control. Handoff §3: track #eaecee, 3px inset, 6px options. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  mono = false,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  mono?: boolean;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-[4.4px] rounded-[8px] border border-border bg-surface-2 p-[3px]"
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={`flex-1 rounded-[6px] px-[4px] py-[10px] text-[13.5px] font-bold transition-colors ${
              mono ? "font-mono" : ""
            } ${active ? "bg-teal text-teal-100" : "text-muted-3 hover:bg-teal-200 hover:text-teal-700"}`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function UploadForm({ owner }: { owner: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const [title, setTitle] = useState("");
  const [material, setMaterial] = useState<string>(DEFAULT_MATERIAL);
  const [quantity, setQuantity] = useState<number>(1);
  const [color, setColor] = useState<string>(DEFAULT_COLOR.name);
  const [tip, setTip] = useState<string>(DEFAULT_TIP);
  const [note, setNote] = useState("");

  /**
   * Client-side checks are for fast feedback only — the server re-runs all of
   * them against the actual bytes and is the one that decides.
   */
  const accept = useCallback((picked: File | null) => {
    setPhase({ kind: "idle" });
    if (!picked) return setFile(null);

    const ext = picked.name.slice(picked.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      setFile(null);
      return setPhase({
        kind: "error",
        message: "Only .stl and .3mf files can be printed here.",
      });
    }
    if (picked.size > MAX_BYTES) {
      setFile(null);
      return setPhase({
        kind: "error",
        message: `That file is ${formatBytes(picked.size)} — the limit is 50 MB.`,
      });
    }
    setFile(picked);
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    accept(e.dataTransfer.files?.[0] ?? null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || phase.kind === "uploading") return;

    const body = new FormData();
    body.set("file", file);
    body.set("title", title);
    body.set("material", material);
    body.set("colorName", color);
    body.set("quantity", String(quantity));
    body.set("tip", tip);
    body.set("note", note);

    // XHR rather than fetch: it is still the only way to observe upload
    // progress, and a 50 MB model over office wifi needs a real bar.
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      setPhase({
        kind: "uploading",
        percent: Math.round((event.loaded / event.total) * 100),
      });
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // Handoff §3: submitting navigates to the new story's detail view.
        let id: number | null = null;
        try {
          id = JSON.parse(xhr.responseText).id ?? null;
        } catch {
          /* fall back to the board rather than stranding them here */
        }
        router.push(id === null ? "/board" : `/story/${id}?sent=1`);
        router.refresh();
        return;
      }
      let message = "That did not go through. Try again.";
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {
        /* a non-JSON error body is not worth surfacing verbatim */
      }
      setPhase({ kind: "error", message });
    });
    xhr.addEventListener("error", () =>
      setPhase({ kind: "error", message: "The connection dropped mid-upload." }),
    );
    xhr.addEventListener("abort", () => setPhase({ kind: "idle" }));

    setPhase({ kind: "uploading", percent: 0 });
    xhr.send(body);
  }

  const busy = phase.kind === "uploading";

  return (
    <form onSubmit={submit} className="max-w-[780px]">
      {/* ---- dropzone ---- */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`block cursor-pointer rounded-[14px] border-2 border-dashed px-[26.4px] py-[35.2px] text-center transition-colors ${
          dragging
            ? "border-teal bg-teal-100"
            : "border-line-2 bg-card hover:border-teal hover:bg-teal-100"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".stl,.3mf,model/stl,model/3mf"
          className="hidden"
          disabled={busy}
          onChange={(e) => accept(e.target.files?.[0] ?? null)}
        />
        <span
          aria-hidden
          className="mx-auto mb-[13.2px] block h-[56px] w-[56px] rounded-full bg-teal-200"
        />
        <span className="block text-[17px] font-bold">
          {file ? file.name : "Drop your .stl or .3mf here"}
        </span>
        <span className="mt-[4px] block text-[13.5px] text-muted">
          {busy
            ? `Uploading… ${phase.percent}%`
            : file
              ? `${formatBytes(file.size)} · checked on the server when you send it`
              : "or click to choose a file · 50 MB max"}
        </span>

        {busy && (
          <span className="mt-[13.2px] block h-[6px] overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-teal transition-[width] duration-200"
              style={{ width: `${phase.percent}%` }}
            />
          </span>
        )}
      </label>

      {phase.kind === "error" && (
        <div className="mt-[13.2px]">
          <Notice tone="warn">{phase.message}</Notice>
        </div>
      )}

      {/* ---- title + material ---- */}
      <div className="mt-[26.4px] grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-[22px]">
        <div>
          <Label htmlFor="title">What is it?</Label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="Hook for the monitor arm"
            className="w-full rounded-[8px] border border-border bg-card px-[17.6px] py-[13.2px] text-[15px] text-ink placeholder:text-line-3"
          />
        </div>
        <div>
          <Label htmlFor="material">Material you&rsquo;d like</Label>
          <Segmented
            label="Material"
            options={MATERIALS}
            value={material}
            onChange={setMaterial}
          />
        </div>
      </div>

      {/* ---- quantity ---- */}
      <div className="mt-[22px] max-w-[320px]">
        <Label htmlFor="quantity">How many do you need?</Label>
        <Segmented
          label="Quantity"
          mono
          options={QUANTITY_PRESETS}
          value={QUANTITY_PRESETS.includes(quantity as never) ? quantity : 0}
          onChange={setQuantity}
        />
        <div className="mt-[8.8px] flex items-center gap-[8.8px]">
          <label htmlFor="quantity-other" className="text-[13px] text-muted">
            or type a number
          </label>
          <input
            id="quantity-other"
            type="number"
            min={1}
            max={24}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            className="w-[76px] rounded-[8px] border border-border bg-card px-[11px] py-[7px] font-mono text-[14px] tabular-nums"
          />
        </div>
      </div>

      {/* ---- colour ---- */}
      <fieldset className="mt-[22px] border-0 p-0">
        <legend className="mb-[8.8px] text-[13.5px] font-bold">
          Colour you&rsquo;re hoping for
        </legend>
        <div className="flex flex-wrap gap-[13.2px]">
          {COLORS.map((c) => {
            const active = c.name === color;
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${c.name} filament`}
                onClick={() => setColor(c.name)}
                className="flex w-[78px] flex-col items-center gap-[6px] border-0 bg-transparent p-0"
              >
                <span
                  aria-hidden
                  className="h-[46px] w-[46px] rounded-full"
                  style={{
                    background: c.hex,
                    boxShadow: active
                      ? "0 0 0 3px #12645f, inset 0 0 0 1px rgba(20,24,28,0.2)"
                      : "inset 0 0 0 1px rgba(20,24,28,0.2)",
                  }}
                />
                <span
                  className={`text-[12.5px] font-semibold ${
                    active ? "text-teal-700" : "text-muted-2"
                  }`}
                >
                  {c.name}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-[8.8px] text-[13px] text-muted">
          {owner} confirms what&rsquo;s actually on the spool.
        </p>
      </fieldset>

      {/* ---- tip ---- */}
      <fieldset className="mt-[26.4px] rounded-[14px] border-0 bg-slate-200 p-[22px]">
        <legend className="float-left w-full">
          <span className="mb-[4px] block text-[19px] font-semibold tracking-[-0.012em]">
            And what&rsquo;s in it for {owner}?
          </span>
          <span className="mb-[13.2px] block text-[14px] text-slate-800">
            Optional. Nobody is counting. {owner} is counting a little.
          </span>
        </legend>
        <div className="flex flex-wrap gap-[8.8px] pt-[4px]">
          {TIPS.map((t) => {
            const active = t === tip;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTip(t)}
                className={`rounded-[8px] border px-[20px] py-[11px] text-[14.5px] font-bold transition-colors ${
                  active
                    ? "border-slate bg-slate text-slate-100"
                    : "border-border bg-transparent text-slate-800 hover:bg-slate-100"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ---- note ---- */}
      <div className="mt-[22px]">
        <Label htmlFor="note">Anything he should know</Label>
        <textarea
          id="note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          placeholder="No rush — needs to survive a bit of pulling."
          className="w-full resize-y rounded-[10px] border border-border bg-card px-[17.6px] py-[13.2px] text-[15px] text-ink placeholder:text-line-3"
        />
      </div>

      {/* ---- actions ---- */}
      <div className="mt-[26.4px] flex flex-wrap items-center gap-[13.2px]">
        <Button type="submit" disabled={!file || busy} className="px-[30px]">
          {busy ? `Sending… ${phase.percent}%` : `Send it to ${owner}`}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push("/board")}>
          Cancel
        </Button>
        {!file && (
          <span className="text-[13px] text-muted">Pick a file to continue.</span>
        )}
      </div>
    </form>
  );
}

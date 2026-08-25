/**
 * Validation and measurement of uploaded model files.
 *
 * The handoff asks for extension and magic-byte validation, a 50 MB cap, and
 * a parse pass that fills in the displayed meta. Everything here runs on the
 * server against the bytes that actually arrived — a filename is a claim, not
 * evidence.
 */
import { unzipSync } from "fflate";

export const MAX_BYTES = 50 * 1024 * 1024; // 50 MB, per the handoff
export const ACCEPTED_EXTENSIONS = [".stl", ".3mf"] as const;

/** Refuse absurd meshes before allocating for them. */
const MAX_TRIANGLES = 8_000_000;
/** A 3MF is a zip; cap what we are willing to inflate (zip-bomb guard). */
const MAX_INFLATED_BYTES = 300 * 1024 * 1024;

export type ModelFormat = "stl" | "3mf";

export type Rejection =
  | "empty"
  | "too_large"
  | "bad_extension"
  | "not_a_model"
  | "corrupt"
  | "no_geometry";

export const REJECTION_COPY: Record<Rejection, string> = {
  empty: "That file is empty.",
  too_large: "That file is over 50 MB. Decimate the mesh and try again.",
  bad_extension: "Only .stl and .3mf files can be printed here.",
  not_a_model:
    "That does not look like an STL or 3MF inside, whatever it is named.",
  corrupt: "That file is damaged — it could not be read all the way through.",
  no_geometry: "There is no geometry in that file.",
};

export type Measured = {
  format: ModelFormat;
  triangles: number;
  /** Bounding box in millimetres. */
  size: { x: number; y: number; z: number };
  /** "78 × 40 × 22 mm" */
  dims: string;
};

export type Inspection =
  | ({ ok: true } & Measured)
  | { ok: false; reason: Rejection };

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

const startsWith = (b: Uint8Array, sig: number[]) =>
  sig.every((byte, i) => b[i] === byte);

/**
 * A binary STL has no magic number, so it is identified structurally: an
 * 80-byte header, a uint32 triangle count, then exactly 50 bytes per
 * triangle. If the arithmetic lands on the file length, it is a binary STL
 * and nothing else plausibly is.
 *
 * This check has to come first, because binary STLs written by some tools
 * begin with the ASCII word "solid" in their header and would otherwise be
 * mistaken for the text format.
 */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (count > MAX_TRIANGLES) return false;
  return bytes.length === 84 + count * 50;
}

function isAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .trimStart()
    .toLowerCase();
  // Both markers required: "solid" alone is too weak a signal.
  return head.startsWith("solid") && head.includes("facet normal");
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Box = { min: [number, number, number]; max: [number, number, number] };

const emptyBox = (): Box => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

function expand(box: Box, x: number, y: number, z: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const p = [x, y, z] as const;
  for (let i = 0; i < 3; i++) {
    if (p[i]! < box.min[i]!) box.min[i] = p[i]!;
    if (p[i]! > box.max[i]!) box.max[i] = p[i]!;
  }
}

function measureBinaryStl(bytes: Uint8Array): { box: Box; triangles: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const box = emptyBox();
  let offset = 84;
  for (let t = 0; t < triangles; t++) {
    // Skip the 12-byte normal; only the three vertices bound the mesh.
    for (let v = 0; v < 3; v++) {
      const base = offset + 12 + v * 12;
      expand(
        box,
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true),
      );
    }
    offset += 50;
  }
  return { box, triangles };
}

function measureAsciiStl(bytes: Uint8Array): { box: Box; triangles: number } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const box = emptyBox();
  let vertices = 0;
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    expand(box, parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
    vertices++;
  }
  return { box, triangles: Math.floor(vertices / 3) };
}

/** 3MF declares its unit on the <model> element; everything becomes mm. */
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** Pull the bounding box and triangle count out of one `<model>` part's XML. */
function measureModelPart(xml: string, box: Box): { vertices: number; triangles: number } {
  // Each part declares its own unit — a component part need not match the root.
  const unit = /<model[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(xml)?.[1]?.toLowerCase();
  const scale = UNIT_TO_MM[unit ?? "millimeter"] ?? 1;

  let vertices = 0;
  // Attribute order is not fixed by the spec, so each is matched separately
  // within the tag rather than assuming x, y, z appear in order.
  const vertexTag = /<vertex\b[^>]*\/?>/g;
  let tag: RegExpExecArray | null;
  while ((tag = vertexTag.exec(xml)) !== null) {
    const s = tag[0];
    const x = /\bx\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
    const y = /\by\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
    const z = /\bz\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
    if (x === undefined || y === undefined || z === undefined) continue;
    expand(box, parseFloat(x) * scale, parseFloat(y) * scale, parseFloat(z) * scale);
    vertices++;
  }
  return { vertices, triangles: (xml.match(/<triangle\b/g) ?? []).length };
}

function measure3mf(bytes: Uint8Array): { box: Box; triangles: number } | null {
  let files: Record<string, Uint8Array>;
  try {
    let inflated = 0;
    files = unzipSync(bytes, {
      filter: (file) => {
        // EVERY model part, not only `3dmodel.model`. The 3MF production
        // extension (Bambu, OrcaSlicer multi-object plates, several CAD
        // exporters) puts each object's geometry in its own
        // `3D/Objects/*.model` and leaves the root part merely referencing
        // them — so reading the root alone finds no geometry and the whole
        // file was being refused. Some exporters also name the root part
        // something other than `3dmodel.model`. Reading any `*.model` covers
        // both. Nothing is ever written from these names (storage keys are
        // generated), so an odd or traversal-shaped member name is harmless.
        if (!/\.model$/i.test(file.name)) return false;
        inflated += file.originalSize ?? 0;
        if (inflated > MAX_INFLATED_BYTES) {
          throw new Error("archive inflates to an implausible size");
        }
        return true;
      },
    });
  } catch {
    return null;
  }

  const box = emptyBox();
  let vertices = 0;
  let triangles = 0;
  for (const name of Object.keys(files)) {
    if (!/\.model$/i.test(name)) continue;
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(files[name]!);
    const part = measureModelPart(xml, box);
    vertices += part.vertices;
    triangles += part.triangles;
  }

  // Component transforms (<component>/<item> matrices) are deliberately not
  // applied: this measures the raw union of every part's vertices, so an
  // assembly whose components are translated or rotated may report a slightly
  // loose box. That is the right trade — the dimensions are display-only and
  // already disclaimed as approximate, and accepting the file beats refusing a
  // perfectly printable model over a bounding box that is a few mm out.
  return vertices > 0 ? { box, triangles } : null;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/*
 * There is deliberately no print-time estimate here.
 *
 * A figure derived from the bounding box is a guess dressed as a measurement:
 * it cannot know infill, layer height, wall count or the printer's speeds,
 * and it is worst on exactly the models people care about — hollow parts and
 * lattices. The handoff's definition of done says nothing should claim to
 * know what the printer is doing, and a number someone might plan their
 * afternoon around is the kind of claim it is warning about.
 *
 * So the app shows only what it actually measured: dimensions and file size.
 *
 * To add a real one, shell out to `prusa-slicer --export-gcode` after upload
 * (in a background job — slicing takes seconds) and read
 * `; estimated printing time` out of the G-code. That number is worth
 * showing; this one was not.
 */

const round = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Inspect an uploaded file. Extension, size and content must all agree before
 * anything is stored.
 */
export function inspectModel(filename: string, bytes: Uint8Array): Inspection {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_BYTES) return { ok: false, reason: "too_large" };

  const ext = extensionOf(filename);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: "bad_extension" };
  }

  let format: ModelFormat;
  let measured: { box: Box; triangles: number } | null;

  try {
    if (isBinaryStl(bytes)) {
      format = "stl";
      measured = measureBinaryStl(bytes);
    } else if (isAsciiStl(bytes)) {
      format = "stl";
      measured = measureAsciiStl(bytes);
    } else if (startsWith(bytes, ZIP_MAGIC)) {
      format = "3mf";
      measured = measure3mf(bytes);
      if (!measured) return { ok: false, reason: "not_a_model" };
    } else {
      return { ok: false, reason: "not_a_model" };
    }
  } catch {
    return { ok: false, reason: "corrupt" };
  }

  // The name has to agree with the bytes: a .3mf that is really an STL is a
  // sign something is wrong, even if both are printable.
  if ((ext === ".stl") !== (format === "stl")) {
    return { ok: false, reason: "not_a_model" };
  }

  if (!measured || measured.triangles === 0) {
    return { ok: false, reason: "no_geometry" };
  }
  if (!Number.isFinite(measured.box.min[0])) {
    return { ok: false, reason: "no_geometry" };
  }

  const size = {
    x: round(measured.box.max[0]! - measured.box.min[0]!),
    y: round(measured.box.max[1]! - measured.box.min[1]!),
    z: round(measured.box.max[2]! - measured.box.min[2]!),
  };

  return {
    ok: true,
    format,
    triangles: measured.triangles,
    size,
    dims: `${Math.round(size.x)} × ${Math.round(size.y)} × ${Math.round(size.z)} mm`,
  };
}

/**
 * A filename safe to store and echo back. The original never builds a storage
 * path — see `storageKeyFor` in storage.ts — but it is shown in the UI, so
 * strip anything path-like or controlish first.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "model";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    // Control characters, plus the set that is path-significant or
    // reserved on Windows. Spaces, unicode and digits are kept, so a
    // person's filename still looks like their filename.
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, "")
    .trim();
  return (cleaned || "model").slice(0, 120);
}

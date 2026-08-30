/**
 * Validation and measurement of uploaded model files.
 *
 * The handoff asks for extension and magic-byte validation, a size cap, and a
 * parse pass that fills in the displayed meta. Everything here runs on the
 * server against the bytes that actually arrived — a filename is a claim, not
 * evidence.
 *
 * The numbers themselves live in `upload-limits.ts`, because the upload form
 * needs the same ones and cannot import this module without dragging `fflate`
 * into the browser bundle.
 */
import { unzipSync } from "fflate";

import {
  ACCEPTED_EXTENSIONS,
  MAX_INFLATED_BYTES,
  MAX_TRIANGLES,
  MAX_UPLOAD_BYTES,
  formatBytes,
} from "@/lib/upload-limits";

/** Re-exported so existing callers keep one import to reach for. */
export { ACCEPTED_EXTENSIONS, formatBytes };
export const MAX_BYTES = MAX_UPLOAD_BYTES;

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
  too_large: `That file is over ${formatBytes(MAX_UPLOAD_BYTES)}.`,
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

// --- 3MF geometry, honouring the transform tree ------------------------------
//
// A 3MF's real size is not the raw union of its vertices. Objects carry their
// coordinates in a local space and are placed by a transform on the `<build>`
// `<item>` (and, in the production extension, by a transform on each
// `<component>`). Cura is the case that makes this non-optional: it stores the
// mesh in a scaled-down space and puts the true size in the item matrix, so
// reading the raw vertices reports a box of a fraction of a millimetre — a
// model that measured "0 × 0 × 0 mm". Applying the transforms is what turns
// that back into the real dimensions.
//
// Matrices are row-major 4×4 in the row-vector convention (a point is p·M, so
// translation lives in the last row) — the same convention the 3MF `transform`
// attribute uses.

type Mat = number[]; // length 16
const IDENTITY_MAT: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A 3MF `transform="m00 m01 m02 m10 … m30 m31 m32"` (12 values) → 4×4. */
function parseTransform(s: string | undefined): Mat {
  if (!s) return IDENTITY_MAT;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((v) => !Number.isFinite(v))) return IDENTITY_MAT;
  const [a, b, c, d, e, f, g, h, i, j, k, l] = n as number[];
  return [a!, b!, c!, 0, d!, e!, f!, 0, g!, h!, i!, 0, j!, k!, l!, 1];
}

/** Child-then-parent for row vectors: the point p·A·B, i.e. standard A·B. */
function matMul(a: Mat, b: Mat): Mat {
  const out = new Array(16).fill(0) as Mat;
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k]! * b[k * 4 + col]!;
      out[r * 4 + col] = sum;
    }
  }
  return out;
}

type Obj3mf = {
  /** Flat x,y,z triples in the part's local space. */
  verts: number[];
  components: { objectid: string; path: string | null; tf: Mat }[];
};

type Part3mf = {
  /** Multiply a local coordinate by this to reach millimetres. */
  unitScale: number;
  objects: Map<string, Obj3mf>;
  buildItems: { objectid: string; tf: Mat }[];
};

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];

/** Zip member names have no leading slash; a 3MF `p:path` usually does. */
const normalizePart = (p: string): string => p.replace(/^\/+/, "").toLowerCase();

function parsePart(xml: string): Part3mf {
  const unit = /<model[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(xml)?.[1]?.toLowerCase();
  const unitScale = UNIT_TO_MM[unit ?? "millimeter"] ?? 1;

  const objects = new Map<string, Obj3mf>();
  // Objects do not nest, so a non-greedy body match is safe. Self-closing
  // objects carry no geometry and are simply skipped.
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(xml)) !== null) {
    const id = attr(om[1]!, "id");
    if (id === undefined) continue;
    const body = om[2]!;

    const verts: number[] = [];
    const vertexTag = /<vertex\b[^>]*\/?>/g;
    let vt: RegExpExecArray | null;
    while ((vt = vertexTag.exec(body)) !== null) {
      const s = vt[0];
      // Attribute order is not fixed by the spec, so match each separately.
      const x = /\bx\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
      const y = /\by\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
      const z = /\bz\s*=\s*"(-?[\d.eE+-]+)"/.exec(s)?.[1];
      if (x === undefined || y === undefined || z === undefined) continue;
      verts.push(parseFloat(x), parseFloat(y), parseFloat(z));
    }

    const components: Obj3mf["components"] = [];
    const compTag = /<component\b[^>]*\/?>/g;
    let ct: RegExpExecArray | null;
    while ((ct = compTag.exec(body)) !== null) {
      const objectid = attr(ct[0], "objectid");
      if (objectid === undefined) continue;
      // The path attribute is namespaced (`p:path`); match it prefix-agnostically.
      const path = /\b[\w]*:?path\s*=\s*"([^"]+)"/i.exec(ct[0])?.[1] ?? null;
      components.push({ objectid, path, tf: parseTransform(attr(ct[0], "transform")) });
    }

    objects.set(id, { verts, components });
  }

  const buildItems: Part3mf["buildItems"] = [];
  const buildBlock = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(xml)?.[1] ?? "";
  const itemTag = /<item\b[^>]*\/?>/g;
  let it: RegExpExecArray | null;
  while ((it = itemTag.exec(buildBlock)) !== null) {
    const objectid = attr(it[0], "objectid");
    if (objectid === undefined) continue;
    buildItems.push({ objectid, tf: parseTransform(attr(it[0], "transform")) });
  }

  return { unitScale, objects, buildItems };
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

  const parts = new Map<string, Part3mf>();
  let triangles = 0;
  for (const name of Object.keys(files)) {
    if (!/\.model$/i.test(name)) continue;
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(files[name]!);
    parts.set(name.toLowerCase(), parsePart(xml));
    triangles += (xml.match(/<triangle\b/g) ?? []).length;
  }
  if (parts.size === 0) return null;

  const box = emptyBox();
  let placed = 0;

  // Walk from each build item down through components, composing transforms and
  // expanding the box with every mesh vertex in its final placed position. A
  // visited set (keyed by part+object at a given depth) plus a depth cap guards
  // against a malformed file whose components reference each other in a cycle.
  const walk = (partKey: string, objectId: string, m: Mat, depth: number) => {
    if (depth > 50) return;
    const part = parts.get(partKey);
    const obj = part?.objects.get(objectId);
    if (!part || !obj) return;

    const s = part.unitScale;
    for (let i = 0; i + 2 < obj.verts.length; i += 3) {
      const x = obj.verts[i]!, y = obj.verts[i + 1]!, z = obj.verts[i + 2]!;
      expand(
        box,
        (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) * s,
        (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) * s,
        (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!) * s,
      );
      placed++;
    }
    for (const c of obj.components) {
      const childKey = c.path ? normalizePart(c.path) : partKey;
      walk(childKey, c.objectid, matMul(c.tf, m), depth + 1);
    }
  };

  // The root part is the one that carries the build. Fall back to any part with
  // items, then — for a file that omits <build> entirely — to placing every
  // object at identity so such a file is still measured rather than refused.
  const roots = [...parts].filter(([, p]) => p.buildItems.length > 0);
  if (roots.length > 0) {
    for (const [key, part] of roots) {
      for (const item of part.buildItems) walk(key, item.objectid, item.tf, 0);
    }
  } else {
    for (const [key, part] of parts) {
      for (const id of part.objects.keys()) walk(key, id, IDENTITY_MAT, 0);
    }
  }

  // Last resort: if the transform walk placed nothing (an object graph we could
  // not resolve — an unusual production layout, say), fall back to the raw
  // union of every vertex so a printable file is still accepted, only with a
  // looser box. Acceptance must never regress on account of the maths above.
  if (placed === 0) {
    for (const part of parts.values()) {
      for (const obj of part.objects.values()) {
        for (let i = 0; i + 2 < obj.verts.length; i += 3) {
          expand(box, obj.verts[i]! * part.unitScale, obj.verts[i + 1]! * part.unitScale, obj.verts[i + 2]! * part.unitScale);
          placed++;
        }
      }
    }
  }

  return placed > 0 ? { box, triangles } : null;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

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

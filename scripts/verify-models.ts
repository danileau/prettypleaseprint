/**
 * Checks the upload validator against generated fixtures, including files
 * built specifically to get past it.
 *
 *   npm run verify:models
 *
 * No server and no database — this exercises `src/lib/models.ts` directly, so
 * it runs in under a second and can sit in a pre-commit hook.
 */
import { zipSync, zlibSync } from "fflate";
import {
  inspectModel,
  formatBytes,
  safeFilename,
  MAX_BYTES,
  type Rejection,
} from "../src/lib/models";

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) => console.info(`\n── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The 12 triangles of an axis-aligned box from the origin to (x, y, z). */
function boxTriangles(x: number, y: number, z: number): number[][] {
  const p = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], // bottom
    [4, 6, 5], [4, 7, 6], // top
    [0, 4, 5], [0, 5, 1], // front
    [1, 5, 6], [1, 6, 2], // right
    [2, 6, 7], [2, 7, 3], // back
    [3, 7, 4], [3, 4, 0], // left
  ];
  return faces.map((f) => f.flatMap((i) => p[i]!));
}

function binaryStl(x: number, y: number, z: number, header = "generated"): Uint8Array {
  const tris = boxTriangles(x, y, z);
  const buf = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(buf.buffer);
  new TextEncoder().encodeInto(header, buf.subarray(0, 80));
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    // normal left at 0,0,0 — slicers recompute it anyway
    for (let i = 0; i < 9; i++) view.setFloat32(off + 12 + i * 4, t[i]!, true);
    off += 50;
  }
  return buf;
}

function asciiStl(x: number, y: number, z: number): Uint8Array {
  const tris = boxTriangles(x, y, z);
  let s = "solid generated\n";
  for (const t of tris) {
    s += "  facet normal 0 0 0\n    outer loop\n";
    for (let v = 0; v < 3; v++) {
      s += `      vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}\n`;
    }
    s += "    endloop\n  endfacet\n";
  }
  return new TextEncoder().encode(s + "endsolid generated\n");
}

function threeMf(x: number, y: number, z: number, unit = "millimeter"): Uint8Array {
  const p = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="${unit}" xml:lang="en-US">\n<resources><object id="1" type="model"><mesh>\n<vertices>\n` +
    p.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("\n") +
    `\n</vertices>\n<triangles>\n` +
    boxTriangles(1, 1, 1).map((_, i) => `<triangle v1="0" v2="1" v3="2" i="${i}"/>`).join("\n") +
    `\n</triangles>\n</mesh></object></resources>\n</model>`;
  return zipSync({
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0"?><Types/>`),
    "3D/3dmodel.model": new TextEncoder().encode(model),
  });
}

/**
 * A 3MF in the shape the *production extension* emits: the root part carries no
 * geometry of its own, only a component that references a mesh in a separate
 * `3D/Objects/*.model` part. Bambu Studio, OrcaSlicer multi-object plates and
 * several CAD exporters write this — and it was being refused because the
 * validator read only the root part. Regression guard for that bug.
 */
function threeMfProduction(x: number, y: number, z: number): Uint8Array {
  const p = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const objectPart =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter">\n<resources>` +
    `<object id="2" type="model"><mesh><vertices>` +
    p.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("") +
    `</vertices><triangles>` +
    boxTriangles(1, 1, 1).map(() => `<triangle v1="0" v2="1" v3="2"/>`).join("") +
    `</triangles></mesh></object></resources>\n</model>`;
  const root =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n` +
    `<resources><object id="1" type="model"><components>` +
    `<component objectid="2" p:path="/3D/Objects/object_1.model"/>` +
    `</components></object></resources><build><item objectid="1"/></build>\n</model>`;
  return zipSync({
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0"?><Types/>`),
    "3D/3dmodel.model": new TextEncoder().encode(root),
    "3D/Objects/object_1.model": new TextEncoder().encode(objectPart),
  });
}

/**
 * A 3MF in the shape Cura writes: the mesh is stored in a scaled-down local
 * space and the real size lives in the `<build>` `<item>` transform. Reading
 * the raw vertices reports a box a thousandth of the true size — the bug that
 * showed real models as "0 × 0 × 0 mm". The item here scales by 1000, so a
 * mesh spanning `dim/1000` locally must come back as `dim` millimetres.
 */
function threeMfScaled(x: number, y: number, z: number): Uint8Array {
  const s = 1000;
  const p = [
    [0, 0, 0], [x / s, 0, 0], [x / s, y / s, 0], [0, y / s, 0],
    [0, 0, z / s], [x / s, 0, z / s], [x / s, y / s, z / s], [0, y / s, z / s],
  ];
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter">\n<resources>` +
    `<object id="1" type="model"><mesh><vertices>` +
    p.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join("") +
    `</vertices><triangles>` +
    boxTriangles(1, 1, 1).map(() => `<triangle v1="0" v2="1" v3="2"/>`).join("") +
    `</triangles></mesh></object></resources>` +
    `<build><item objectid="1" transform="${s} 0 0 0 ${s} 0 0 0 ${s} 0 0 0"/></build>\n</model>`;
  return zipSync({
    "[Content_Types].xml": new TextEncoder().encode(`<?xml version="1.0"?><Types/>`),
    "3D/3dmodel.model": new TextEncoder().encode(model),
  });
}

const ok = (r: ReturnType<typeof inspectModel>) => (r.ok ? r : null);
const why = (r: ReturnType<typeof inspectModel>): Rejection | "accepted" =>
  r.ok ? "accepted" : r.reason;

// ---------------------------------------------------------------------------

section("legitimate files are measured correctly");

const bin = inspectModel("hook.stl", binaryStl(78, 40, 22));
check("binary STL accepted", bin.ok, why(bin));
check("binary STL dimensions match the mesh", ok(bin)?.dims === "78 × 40 × 22 mm", ok(bin)?.dims);
check("binary STL triangle count is right", ok(bin)?.triangles === 12, String(ok(bin)?.triangles));

const asc = inspectModel("hook.stl", asciiStl(120, 18, 12));
check("ASCII STL accepted", asc.ok, why(asc));
check("ASCII STL dimensions match the mesh", ok(asc)?.dims === "120 × 18 × 12 mm", ok(asc)?.dims);

const mf = inspectModel("sign.3mf", threeMf(160, 60, 8));
check("3MF accepted", mf.ok, why(mf));
check("3MF dimensions match the mesh", ok(mf)?.dims === "160 × 60 × 8 mm", ok(mf)?.dims);

const inches = inspectModel("sign.3mf", threeMf(1, 2, 4, "inch"));
check("3MF unit attribute is honoured (inch -> mm)",
      ok(inches)?.dims === "25 × 51 × 102 mm", ok(inches)?.dims);

const microns = inspectModel("tiny.3mf", threeMf(10000, 20000, 5000, "micron"));
check("3MF micron unit is honoured", ok(microns)?.dims === "10 × 20 × 5 mm", ok(microns)?.dims);

// The bug this guards: a production-extension 3MF (geometry in a separate
// component part) was refused because only the root part was read.
const prod = inspectModel("plate.3mf", threeMfProduction(30, 20, 10));
check("3MF production extension accepted (geometry in a component part)", prod.ok, why(prod));
check("its dimensions come from the referenced part",
      ok(prod)?.dims === "30 × 20 × 10 mm", ok(prod)?.dims);

// The bug this guards: a Cura-style 3MF measured 0 × 0 × 0 because the size
// lived in the build item's transform, which was not applied.
const scaled = inspectModel("cura.3mf", threeMfScaled(30, 20, 10));
check("3MF build-item transform is applied (not 0 × 0 × 0)",
      ok(scaled)?.dims === "30 × 20 × 10 mm", ok(scaled)?.dims);

// A binary STL whose 80-byte header begins with the word "solid" — the classic
// way a naive sniffer misreads the format.
const trap = inspectModel("trap.stl", binaryStl(30, 30, 30, "solid but actually binary"));
check("a binary STL with a 'solid' header is not mistaken for ASCII",
      ok(trap)?.dims === "30 × 30 × 30 mm", ok(trap)?.dims);

section("hostile and malformed files are refused");

const cases: Array<[string, string, Uint8Array, Rejection]> = [
  ["an empty file", "x.stl", new Uint8Array(0), "empty"],
  ["a PDF renamed to .stl", "invoice.stl",
    new TextEncoder().encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj"), "not_a_model"],
  ["an ELF binary renamed to .stl", "payload.stl",
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...new Array(200).fill(0)]), "not_a_model"],
  ["an HTML file renamed to .stl", "page.stl",
    new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"), "not_a_model"],
  ["a .exe", "tool.exe", binaryStl(10, 10, 10), "bad_extension"],
  ["no extension at all", "model", binaryStl(10, 10, 10), "bad_extension"],
  ["a zip that is not a 3MF", "archive.3mf",
    zipSync({ "readme.txt": new TextEncoder().encode("nothing here") }), "not_a_model"],
  ["a 3MF whose model part has no vertices", "hollow.3mf",
    zipSync({ "3D/3dmodel.model": new TextEncoder().encode('<?xml version="1.0"?><model/>') }),
    "not_a_model"],
];

for (const [label, name, bytes, expected] of cases) {
  const r = inspectModel(name, bytes);
  check(`${label} is refused`, !r.ok && r.reason === expected, `got "${why(r)}", expected "${expected}"`);
}

// An STL that lies about its triangle count: the structural size check is what
// catches this, since 84 + count*50 will not equal the real length.
const liar = binaryStl(20, 20, 20);
new DataView(liar.buffer).setUint32(80, 5_000_000, true);
const liarResult = inspectModel("liar.stl", liar);
check("an STL lying about its triangle count is refused",
      !liarResult.ok && liarResult.reason === "not_a_model", why(liarResult));

// Extension and content must agree even when both are printable formats.
const mismatch = inspectModel("mislabelled.3mf", binaryStl(20, 20, 20));
check("an STL renamed to .3mf is refused", !mismatch.ok, why(mismatch));
const mismatch2 = inspectModel("mislabelled.stl", threeMf(20, 20, 20));
check("a 3MF renamed to .stl is refused", !mismatch2.ok, why(mismatch2));

// Path traversal via the archive member name must not reach the filesystem —
// nothing is ever written from the archive, but the member must not be picked
// up as the model part either.
const traversal = zipSync({
  "../../../../etc/3dmodel.model": new TextEncoder().encode('<?xml version="1.0"?><model/>'),
});
const traversalResult = inspectModel("evil.3mf", traversal);
check("a 3MF with a traversal path in its member name is refused",
      !traversalResult.ok, why(traversalResult));

section("resource limits hold");

const oversize = new Uint8Array(MAX_BYTES + 1);
oversize.set([0x50, 0x4b, 0x03, 0x04]);
const big = inspectModel("huge.stl", oversize);
check("a file over 50 MB is refused before parsing",
      !big.ok && big.reason === "too_large", why(big));

// A zip bomb: a small archive that inflates enormously. The guard has to fire
// on the declared uncompressed size, before the bytes are actually inflated.
const bombPayload = new Uint8Array(400 * 1024 * 1024);
const bomb = zipSync({ "3D/3dmodel.model": zlibSync(bombPayload, { level: 9 }) });
const t0 = Date.now();
const bombResult = inspectModel("bomb.3mf", bomb);
const elapsed = Date.now() - t0;
check("a zip bomb is refused", !bombResult.ok, why(bombResult));
check("and refused quickly, without inflating it", elapsed < 4000, `took ${elapsed}ms`);

section("presentation helpers");

check("byte formatting", formatBytes(2_517_000) === "2.4 MB", formatBytes(2_517_000));
// No print-time estimate is produced at all — the module must not grow one
// back by accident, since a guessed duration is exactly what the handoff's
// definition of done rules out.
check("nothing infers a print time",
      !Object.keys(inspectModel("x.stl", binaryStl(10, 10, 10)) as object).includes("estimate"));
check("filename traversal is stripped",
      safeFilename("../../etc/passwd.stl") === "passwd.stl");
check("unicode filenames survive",
      safeFilename("rapport été (v2).stl") === "rapport été (v2).stl");

console.info(
  `\n${passed} checks passed, ${failures.length} failed` +
    (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
);
process.exitCode = failures.length ? 1 : 0;

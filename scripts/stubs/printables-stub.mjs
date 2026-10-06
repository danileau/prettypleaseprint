/**
 * A stand-in for Printables, for `npm run verify:import`.
 *
 * The suites run against the built image, and that image cannot call the real
 * Printables on every CI run: it would make the suite depend on somebody
 * else's uptime, hammer an API nobody published, and — the real reason — leave
 * no way to make the far end *misbehave*. Most of what `src/lib/import.ts`
 * does is refuse things, and a refusal can only be tested against a server
 * willing to hand back a redirect, a link to another host, or a file larger
 * than it said.
 *
 * So this speaks just enough of the two things the importer uses — the GraphQL
 * listing and download-link calls, and a file host — and each model id is one
 * behaviour. The app is pointed here with `IMPORT_PRINTABLES_BASE`
 * (`docker-compose.test.yml` does it).
 *
 * Plain Node with no dependencies, on purpose: the test overlay runs it inside
 * the app image, which carries a Node runtime and nothing to install with.
 *
 * Two listeners:
 *
 *   MAIN       the API and the file host — the one origin the importer may use
 *   ELSEWHERE  a second origin that serves a perfectly good model. Nothing
 *              should ever be fetched from it; it exists so that "the importer
 *              followed a link off the allowlist" would *succeed* if the check
 *              were missing, rather than fail for some unrelated reason.
 *
 * `GET /_hits` reports what each has been asked for, and `POST /_reset` zeroes
 * the counts, so the suite can assert not just that a request was refused but
 * that no connection was made.
 */
import { createServer } from "node:http";
import { crc32 } from "node:zlib";

const MAIN_PORT = Number(process.env.STUB_PORT ?? 4010);
const ELSEWHERE_PORT = Number(process.env.STUB_ELSEWHERE_PORT ?? 4011);
/** How the *app* reaches the two listeners — these go into download links. */
const MAIN_ORIGIN = process.env.STUB_ORIGIN ?? `http://localhost:${MAIN_PORT}`;
const ELSEWHERE_ORIGIN = process.env.STUB_ELSEWHERE_ORIGIN ?? `http://localhost:${ELSEWHERE_PORT}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real binary STL: an axis-aligned box, 12 triangles. */
function binaryStl(x, y, z) {
  const p = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const out = Buffer.alloc(84 + faces.length * 50);
  out.write("printables-stub box", 0, "ascii");
  out.writeUInt32LE(faces.length, 80);
  let at = 84;
  for (const face of faces) {
    at += 12; // the normal, left zero
    for (const i of face) for (const c of p[i]) { out.writeFloatLE(c, at); at += 4; }
    at += 2; // attribute byte count
  }
  return out;
}

/** A zip with every member stored, which is all a 3MF needs to be read. */
function storedZip(members) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of members) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A real 3MF: one tetrahedron, 30 × 20 × 10 mm. */
const threeMf = storedZip([
  ["[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
  ["_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
  ["3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model"><mesh><vertices>' +
    '<vertex x="0" y="0" z="0"/><vertex x="30" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="10"/>' +
    '</vertices><triangles>' +
    '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/>' +
    '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'],
]);

const box = binaryStl(40, 20, 10);
const html = Buffer.from("<!doctype html><title>Just a moment…</title><p>Not a model.</p>");

/** What the file host serves, by path. */
const BLOBS = {
  "/files/benchy.stl": box,
  "/files/plate.3mf": threeMf,
  "/files/page.stl": html,
  "/files/padded.stl": Buffer.concat([box, Buffer.alloc(4096)]),
};

const file = (id, name, size) => ({ id: String(id), name, fileSize: size });
const model = (id, name, slug, stls) => ({
  id: String(id),
  name,
  slug,
  user: { publicUsername: "Stub Research" },
  license: { name: "Creative Commons — Public Domain" },
  stls,
});

/**
 * One behaviour per model id. The comment on each is what the importer is
 * expected to do about it.
 */
const MODELS = {
  // The good one: two printable files, one that is not, one over the cap.
  3161: model(3161, "3D BENCHY", "3d-benchy", [
    file(101, "benchy.stl", box.length),
    file(102, "plate.3mf", threeMf.length),
    file(103, "assembly-guide.pdf", 52_000),
    file(104, "scan-of-the-whole-harbour.stl", 300 * 1024 * 1024),
  ]),
  // Named .stl, is a web page. Fetched, inspected, refused: 422, nothing kept.
  4001: model(4001, "Not what it says", "not-what-it-says", [file(201, "page.stl", html.length)]),
  // The download link points at another origin. Refused before connecting.
  4002: model(4002, "Points elsewhere", "points-elsewhere", [file(301, "benchy.stl", box.length)]),
  // The download link is on the right origin and redirects off it. Not followed.
  4003: model(4003, "Redirects", "redirects", [file(401, "benchy.stl", box.length)]),
  // Listed at one size, delivered larger — with a Content-Length that admits it.
  4004: model(4004, "Larger than listed", "larger-than-listed", [file(501, "padded.stl", box.length)]),
  // The same, but chunked: no Content-Length, so it is caught as it arrives.
  4009: model(4009, "Larger than listed, quietly", "larger-quietly", [file(901, "padded.stl", box.length)]),
  // The site will not hand the file over (`ok: false`).
  4008: model(4008, "Will not download", "will-not-download", [file(801, "benchy.stl", box.length)]),
  // One file, so the form has nothing to ask.
  4010: model(4010, "Just the one", "just-the-one", [file(1001, "only.stl", box.length)]),
  // A slug that is not a slug. The stored link must not carry it.
  4011: model(4011, "Odd slug", '"><script>alert(1)</script>', [file(1101, "benchy.stl", box.length)]),
  // No printable files at all.
  4012: model(4012, "Photos only", "photos-only", [file(1201, "render.png", 9_000)]),
};

/** file id → the path its download link names. */
const LINKS = {
  101: `${MAIN_ORIGIN}/files/benchy.stl`,
  102: `${MAIN_ORIGIN}/files/plate.3mf`,
  201: `${MAIN_ORIGIN}/files/page.stl`,
  301: `${ELSEWHERE_ORIGIN}/files/benchy.stl`,
  401: `${MAIN_ORIGIN}/redirect`,
  501: `${MAIN_ORIGIN}/files/padded.stl`,
  901: `${MAIN_ORIGIN}/chunked/padded.stl`,
  1001: `${MAIN_ORIGIN}/files/benchy.stl`,
  1101: `${MAIN_ORIGIN}/files/benchy.stl`,
};

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const hits = { graphql: 0, files: 0, elsewhere: 0 };
/** The last request's User-Agent, so the suite can see how the app introduces itself. */
let lastUserAgent = null;

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function graphql(req, res) {
  hits.graphql++;
  lastUserAgent = req.headers["user-agent"] ?? null;
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { errors: [{ message: "not json" }] });
  }
  const query = String(body.query ?? "");
  const variables = body.variables ?? {};

  if (query.includes("getDownloadLink")) {
    const owner = MODELS[variables.printId];
    const belongs = owner?.stls.some((f) => f.id === String(variables.id));
    const link = LINKS[variables.id];
    if (!belongs || !link || String(variables.printId) === "4008") {
      return json(res, 200, {
        data: { getDownloadLink: { ok: false, errors: [{ field: "non_field_error", messages: ["files_cannot_be_downloaded"] }], output: null } },
      });
    }
    return json(res, 200, { data: { getDownloadLink: { ok: true, errors: null, output: { link, ttl: 86400 } } } });
  }

  const id = String(variables.id ?? "");
  // The API falling over.
  if (id === "4005") return json(res, 500, { errors: [{ message: "internal" }] });
  // The API changing shape under the app: `name` became `title`, `stls` went.
  if (id === "4006") return json(res, 200, { data: { print: { id: "4006", title: "Renamed fields", files: [] } } });
  // Answering about a model that was not asked for.
  if (id === "4007") return json(res, 200, { data: { print: MODELS[3161] } });
  // An answer that is not JSON at all — a challenge page, say.
  if (id === "4013") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>Just a moment…</title>");
  }
  return json(res, 200, { data: { print: MODELS[id] ?? null } });
}

const main = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", MAIN_ORIGIN);

  if (url.pathname === "/_hits") return json(res, 200, { ...hits, lastUserAgent });
  if (url.pathname === "/_reset" && req.method === "POST") {
    hits.graphql = hits.files = hits.elsewhere = 0;
    lastUserAgent = null;
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/graphql/" && req.method === "POST") return graphql(req, res);

  if (url.pathname === "/redirect") {
    hits.files++;
    res.writeHead(302, { location: `${ELSEWHERE_ORIGIN}/files/benchy.stl` });
    return res.end();
  }

  if (url.pathname === "/chunked/padded.stl") {
    hits.files++;
    // No Content-Length: Node chunks it, and the size is only knowable by reading.
    res.writeHead(200, { "content-type": "application/sla" });
    res.write(box);
    return res.end(Buffer.alloc(4096));
  }

  const blob = BLOBS[url.pathname];
  if (blob && req.method === "GET") {
    hits.files++;
    res.writeHead(200, { "content-type": "application/sla", "content-length": blob.length });
    return res.end(blob);
  }

  json(res, 404, { error: "the stub has nothing there" });
});

const elsewhere = createServer((req, res) => {
  hits.elsewhere++;
  res.writeHead(200, { "content-type": "application/sla", "content-length": box.length });
  res.end(box);
});

main.listen(MAIN_PORT, "0.0.0.0", () => console.info(`printables stub on :${MAIN_PORT} (as ${MAIN_ORIGIN})`));
elsewhere.listen(ELSEWHERE_PORT, "0.0.0.0", () => console.info(`  elsewhere on :${ELSEWHERE_PORT} (as ${ELSEWHERE_ORIGIN})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    main.close();
    elsewhere.close();
    process.exit(0);
  });
}

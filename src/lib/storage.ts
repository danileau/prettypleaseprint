import "server-only";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { isBuildPhase } from "@/lib/runtime";

/**
 * Object storage for model files.
 *
 * Bytes never touch the web root and are never served directly. A file is
 * reachable only through a signed URL minted by `signedModelUrl`, and only
 * after the caller has passed the ownership check in `authz.ts` — the
 * signature is the last step, not the authorisation.
 */

const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
export const bucket = process.env.S3_BUCKET ?? "ppp-models";

/**
 * A convenience default in development is a known password in production.
 * The dev compose sets these; anything else has to supply them, and saying so
 * at startup beats discovering it when someone finds the bucket.
 */
function storageCredential(name: "S3_ACCESS_KEY" | "S3_SECRET_KEY", devValue: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production" && !isBuildPhase) {
    throw new Error(
      `${name} is required in production. Refusing to fall back to the ` +
        "development credential, which is public in this repository.",
    );
  }
  return devValue;
}

export const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  // MinIO speaks path-style; virtual-host style needs DNS per bucket.
  forcePathStyle: true,
  credentials: {
    accessKeyId: storageCredential("S3_ACCESS_KEY", "ppp"),
    secretAccessKey: storageCredential("S3_SECRET_KEY", "dev-only-not-a-secret"),
  },
});

/**
 * Storage keys are generated, never derived from the uploaded filename.
 *
 * A key built from user input is how path traversal and object overwrites
 * happen. The display name lives in the database column instead.
 */
export function storageKeyFor(extension: string): string {
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const ext = extension === ".3mf" ? "3mf" : "stl";
  return `models/${yyyymm}/${randomUUID()}.${ext}`;
}

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putModel(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      // Browsers must never be tempted to interpret a model file.
      ContentDisposition: "attachment",
    }),
  );
}

export async function deleteModel(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Server-side copy of one stored object to a new key, for re-queueing a print
 * without re-uploading. The copy is independent: the two stories own separate
 * objects, so withdrawing one never removes the other's file. `CopySource` is
 * `bucket/key`, URL-encoded, as the S3 API wants it — MinIO honours the same.
 */
export async function copyModel(srcKey: string, destKey: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeURIComponent(`${bucket}/${srcKey}`),
      Key: destKey,
      ContentDisposition: "attachment",
      MetadataDirective: "COPY",
    }),
  );
}

/*
 * There is deliberately no signed-URL helper here any more.
 *
 * It existed for a deployment where the browser can reach object storage
 * directly. This one cannot: docker-compose.truenas.yml publishes no port for
 * MinIO, so a signed URL would point at something unreachable. The model
 * bytes are proxied by /api/models/[id] instead, which also keeps the CSP's
 * connect-src at 'self'.
 *
 * If storage is ever put behind the same reverse proxy, bring it back —
 * getSignedUrl(s3, new GetObjectCommand({...}), { expiresIn }) — and widen
 * connect-src to that origin, or the fetch is blocked.
 */

export const MIME_FOR: Record<string, string> = {
  ".stl": "model/stl",
  ".3mf": "model/3mf",
};

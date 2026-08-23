import "server-only";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
const bucket = process.env.S3_BUCKET ?? "ppp-models";

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
    secretAccessKey: storageCredential("S3_SECRET_KEY", "ppp-secret"),
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
 * A short-lived download URL. Ten minutes is long enough to fetch geometry
 * into the viewer and short enough that a URL copied out of a log or a
 * referrer header is stale before it is useful.
 */
export async function signedModelUrl(
  key: string,
  filename: string,
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
    }),
    { expiresIn: 600 },
  );
}

export const MIME_FOR: Record<string, string> = {
  ".stl": "model/stl",
  ".3mf": "model/3mf",
};

import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import { db } from "@/lib/db";
import { currentUser, storyRef } from "@/lib/authz";
import { storyScope } from "@/lib/scope";
import { record } from "@/lib/audit";
import { s3, bucket } from "@/lib/storage";

/**
 * The bytes of one model, for the viewer.
 *
 * Streamed through the app rather than handed out as a signed URL straight to
 * object storage. That is not the more elegant option, it is the only correct
 * one for this deployment: docker-compose.truenas.yml publishes no port for
 * MinIO, so a browser cannot reach it at all — a signed URL would resolve to
 * nothing. Proxying also keeps `connect-src 'self'` intact, which means the
 * viewer needs no CSP relaxation.
 *
 * The trade is real: every viewer load moves the whole file through Next. At
 * 50 MB and a handful of people that is fine. If this ever faces a wider
 * audience, expose storage behind the same reverse proxy, hand out
 * `signedModelUrl`, and widen `connect-src` to that origin.
 *
 * Scoped with `storyScope`, the same fragment the story page composes, so a
 * client asking for someone else's model gets 404 — not 403, which would
 * confirm it exists.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId)) return new NextResponse(null, { status: 404 });

  const story = await db.story.findFirst({
    where: { AND: [{ id: storyId }, storyScope(user)] },
    select: { id: true, filename: true, mimeType: true, storageKey: true, uploaderId: true },
  });

  if (!story) {
    // A refused fetch is the event worth keeping. Someone walking ids looking
    // for other people's models leaves a trail; the owner opening their own
    // ticket does not need to.
    await record({
      action: "file.refused",
      actor: user,
      subject: `story:${id}`,
      detail: { reason: "not visible to this account" },
    });
    return new NextResponse(null, { status: 404 });
  }

  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: story.storageKey }),
    );
  } catch (error) {
    console.error("[models] storage read failed", error);
    return new NextResponse(null, { status: 502 });
  }
  if (!object.Body) return new NextResponse(null, { status: 502 });

  // Worth a record when the bytes go to someone other than the person who
  // uploaded them — that is the printer owner taking a copy. The uploader
  // fetching their own file every time they open the ticket is noise that
  // would drown the trail.
  if (story.uploaderId !== user.id) {
    await record({
      action: "file.downloaded",
      actor: user,
      subject: storyRef(story.id),
      detail: { filename: story.filename },
    });
  }

  return new NextResponse(object.Body.transformToWebStream(), {
    status: 200,
    headers: {
      "content-type": story.mimeType || "application/octet-stream",
      ...(object.ContentLength ? { "content-length": String(object.ContentLength) } : {}),
      // Never let a browser decide to render a model file as something else.
      "content-disposition": `attachment; filename="${story.filename.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
}

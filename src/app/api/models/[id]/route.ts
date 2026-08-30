import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import { db } from "@/lib/db";
import { currentUser, storyRef } from "@/lib/authz";
import { storyScope, type Actor } from "@/lib/scope";
import { record } from "@/lib/audit";
import { readSlicerToken } from "@/lib/slicer-token";
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
 *
 * Two ways to be somebody here. The ordinary one is a session, cookie or
 * bearer. The other is `?t=`, the link credential minted into an
 * "Open in PrusaSlicer" link — see `src/lib/slicer-token.ts` for why a desktop
 * helper needs one and why it is not simply a long-lived token in a file.
 *
 * The token only ever answers *who*. Everything that decides *whether* runs
 * afterwards and identically for both doors: the account is loaded and refused
 * if suspended, and `storyScope` is re-applied against the database. A link
 * therefore cannot reach a model its holder has lost access to, and cannot
 * reach a different model than the one it names.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId)) return new NextResponse(null, { status: 404 });

  // A session first — a browser opening the viewer is the common case and
  // costs nothing extra. The link credential is only consulted when there is
  // no session to prefer, which is exactly the helper's situation.
  let user = await currentUser();
  let viaLink = false;

  if (!user) {
    const token = new URL(request.url).searchParams.get("t");
    const subject = token ? readSlicerToken(token, storyId) : null;
    if (subject) {
      const row = await db.user.findUnique({
        where: { id: subject },
        select: { id: true, name: true, email: true, initials: true, role: true, banned: true },
      });
      // Suspension is checked here for the same reason `currentUser()` checks
      // it: a credential minted before access was revoked must not outlive it.
      if (row && !row.banned) {
        user = {
          id: row.id,
          name: row.name,
          email: row.email,
          initials: row.initials ?? "??",
          role: row.role === "admin" ? "admin" : "client",
        } satisfies Actor;
        viaLink = true;
      }
    }
  }

  if (!user) return new NextResponse(null, { status: 401 });

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
      detail: { filename: story.filename, ...(viaLink ? { via: "slicer-link" } : {}) },
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

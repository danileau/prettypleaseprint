import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Liveness and readiness for the container healthcheck.
 *
 * Deliberately terse: it is reachable without a session, so it says whether
 * the app can serve — not what version it is, what it connects to, or why a
 * check failed. An unauthenticated endpoint is not the place to describe your
 * infrastructure.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

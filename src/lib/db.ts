import { PrismaClient } from "@prisma/client";

/**
 * Next.js dev server hot-reloads modules, which would otherwise open a new
 * connection pool on every edit until Postgres refuses new connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

-- CreateTable
CREATE TABLE "auditEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "subject" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "detail" JSONB,

    CONSTRAINT "auditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auditEvent_at_idx" ON "auditEvent"("at");

-- CreateIndex
CREATE INDEX "auditEvent_action_at_idx" ON "auditEvent"("action", "at");

-- CreateIndex
CREATE INDEX "auditEvent_actorId_idx" ON "auditEvent"("actorId");

-- AddForeignKey
ALTER TABLE "auditEvent" ADD CONSTRAINT "auditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

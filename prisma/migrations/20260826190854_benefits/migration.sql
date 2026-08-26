-- CreateTable
CREATE TABLE "benefit" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "benefit_label_key" ON "benefit"("label");

-- CreateIndex
CREATE INDEX "benefit_active_sortOrder_idx" ON "benefit"("active", "sortOrder");

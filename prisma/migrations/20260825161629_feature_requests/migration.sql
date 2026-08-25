-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('Requested', 'Accepted', 'InProgress', 'Shipped', 'Done', 'Declined');

-- CreateEnum
CREATE TYPE "FeaturePriority" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "FeatureCategory" AS ENUM ('ui', 'api', 'bug', 'other');

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "featureId" INTEGER;

-- CreateTable
CREATE TABLE "featureRequest" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "FeatureStatus" NOT NULL DEFAULT 'Requested',
    "priority" "FeaturePriority" NOT NULL DEFAULT 'medium',
    "category" "FeatureCategory" NOT NULL DEFAULT 'other',
    "requesterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "featureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "featureComment" (
    "id" TEXT NOT NULL,
    "featureId" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "featureComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "featureRequest_requesterId_idx" ON "featureRequest"("requesterId");

-- CreateIndex
CREATE INDEX "featureRequest_status_idx" ON "featureRequest"("status");

-- CreateIndex
CREATE INDEX "featureComment_featureId_idx" ON "featureComment"("featureId");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "featureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featureRequest" ADD CONSTRAINT "featureRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featureComment" ADD CONSTRAINT "featureComment_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "featureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "featureComment" ADD CONSTRAINT "featureComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

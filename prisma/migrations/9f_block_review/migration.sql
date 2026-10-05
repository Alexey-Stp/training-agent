-- AlterEnum
ALTER TYPE "CoachDecisionOrigin" ADD VALUE 'block';

-- AlterTable
ALTER TABLE "SeasonPlan" ADD COLUMN     "weakSport" "Sport",
ADD COLUMN     "weeklyHoursAvailable" DOUBLE PRECISION;

-- CreateEnum
CREATE TYPE "BlockReviewTrigger" AS ENUM ('block_end', 'race_move');

-- CreateEnum
CREATE TYPE "BlockReviewStatus" AS ENUM ('pending', 'running', 'sent', 'failed');

-- CreateTable
CREATE TABLE "BlockReviewRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonPlanId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "trigger" "BlockReviewTrigger" NOT NULL,
    "status" "BlockReviewStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "coachDecisionId" TEXT,
    "verdict" JSONB,
    "proposedBlocks" JSONB,
    "freezeThrough" TEXT,
    "seasonUpdatedAt" TIMESTAMP(3),
    "reportText" TEXT,
    "reportKeyboard" JSONB,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockReviewRun_userId_seasonPlanId_key_key" ON "BlockReviewRun"("userId", "seasonPlanId", "key");

-- CreateIndex
CREATE INDEX "BlockReviewRun_coachDecisionId_idx" ON "BlockReviewRun"("coachDecisionId");

-- AddForeignKey
ALTER TABLE "BlockReviewRun" ADD CONSTRAINT "BlockReviewRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockReviewRun" ADD CONSTRAINT "BlockReviewRun_seasonPlanId_fkey" FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

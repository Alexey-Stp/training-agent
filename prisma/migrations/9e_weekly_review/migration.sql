-- AlterEnum
ALTER TYPE "CoachAction" ADD VALUE 'adjust';

-- AlterEnum
ALTER TYPE "CoachDecisionOrigin" ADD VALUE 'weekly';

-- CreateEnum
CREATE TYPE "WeeklyReviewStatus" AS ENUM ('pending', 'running', 'sent', 'failed');

-- CreateTable
CREATE TABLE "WeeklyReviewRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isoWeek" TEXT NOT NULL,
    "status" "WeeklyReviewStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "coachDecisionId" TEXT,
    "reportText" TEXT,
    "reportKeyboard" JSONB,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyReviewRun_userId_isoWeek_key" ON "WeeklyReviewRun"("userId", "isoWeek");

-- CreateIndex
CREATE INDEX "WeeklyReviewRun_coachDecisionId_idx" ON "WeeklyReviewRun"("coachDecisionId");

-- AddForeignKey
ALTER TABLE "WeeklyReviewRun" ADD CONSTRAINT "WeeklyReviewRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

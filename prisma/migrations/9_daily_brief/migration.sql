-- CreateEnum
CREATE TYPE "DailyBriefStatus" AS ENUM ('pending', 'running', 'sent', 'failed');

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "briefTime" TEXT;

-- CreateTable
CREATE TABLE "DailyBriefRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" "DailyBriefStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "coachDecisionId" TEXT,
    "briefText" TEXT,
    "briefKeyboard" JSONB,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "dataAsOf" TIMESTAMP(3),
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyBriefRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyBriefRun_userId_date_key" ON "DailyBriefRun"("userId", "date");

-- AddForeignKey
ALTER TABLE "DailyBriefRun" ADD CONSTRAINT "DailyBriefRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


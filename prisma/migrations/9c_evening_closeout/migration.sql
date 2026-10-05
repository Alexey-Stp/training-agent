-- CreateEnum
CREATE TYPE "EveningCloseoutStatus" AS ENUM ('pending', 'running', 'quiet', 'sent', 'failed');

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "closeoutTime" TEXT,
ADD COLUMN     "lthr" INTEGER;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "closedOutAt" TIMESTAMP(3),
ADD COLUMN     "plannedSessionId" TEXT;

-- AlterTable
ALTER TABLE "PlannedSession" ADD COLUMN     "actualIntensity" "Intensity",
ADD COLUMN     "deviationPct" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "EveningCloseoutRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" "EveningCloseoutStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "messageText" TEXT,
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EveningCloseoutRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EveningCloseoutRun_userId_date_key" ON "EveningCloseoutRun"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_plannedSessionId_key" ON "Activity"("plannedSessionId");

-- CreateIndex
CREATE INDEX "Activity_userId_startDateLocal_idx" ON "Activity"("userId", "startDateLocal");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_plannedSessionId_fkey" FOREIGN KEY ("plannedSessionId") REFERENCES "PlannedSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EveningCloseoutRun" ADD CONSTRAINT "EveningCloseoutRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


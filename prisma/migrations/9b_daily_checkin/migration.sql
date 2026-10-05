-- AlterEnum
ALTER TYPE "DailyBriefStatus" ADD VALUE 'awaiting_checkin';

-- AlterTable
ALTER TABLE "DailyBriefRun" ADD COLUMN     "checkInMessageId" INTEGER,
ADD COLUMN     "checkInSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DailyBriefRun_userId_checkInMessageId_idx" ON "DailyBriefRun"("userId", "checkInMessageId");

-- CreateEnum
CREATE TYPE "CoachDecisionOrigin" AS ENUM ('daily', 'chat');

-- CreateEnum
CREATE TYPE "CoachChatRole" AS ENUM ('user', 'coach');

-- AlterTable
ALTER TABLE "CoachDecision" ADD COLUMN "answeredAt" TIMESTAMP(3),
ADD COLUMN "origin" "CoachDecisionOrigin" NOT NULL DEFAULT 'daily';

-- AlterTable
ALTER TABLE "PlannedSession" ADD COLUMN "coachDecisionId" TEXT;

-- CreateTable
CREATE TABLE "CoachChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CoachChatRole" NOT NULL,
    "text" TEXT NOT NULL,
    "telegramMessageId" INTEGER,
    "coachDecisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachChatMessage_userId_createdAt_idx" ON "CoachChatMessage"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoachChatMessage_userId_telegramMessageId_role_key" ON "CoachChatMessage"("userId", "telegramMessageId", "role");

-- AddForeignKey
ALTER TABLE "CoachChatMessage" ADD CONSTRAINT "CoachChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

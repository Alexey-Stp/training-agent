-- CreateEnum
CREATE TYPE "CoachDecisionSource" AS ENUM ('llm', 'repaired', 'fallback');

-- CreateEnum
CREATE TYPE "GuardrailVerdict" AS ENUM ('accept', 'clamp', 'reject');

-- CreateEnum
CREATE TYPE "CoachAction" AS ENUM ('keep', 'reduce', 'swap', 'move', 'rest');

-- CreateTable
CREATE TABLE "CoachDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "suggestionPromptVersion" TEXT NOT NULL,
    "contextHash" TEXT NOT NULL,
    "source" "CoachDecisionSource" NOT NULL,
    "fallbackReason" TEXT,
    "attempts" INTEGER NOT NULL,
    "rawResponses" JSONB NOT NULL,
    "suggestion" JSONB,
    "verdict" "GuardrailVerdict",
    "reasons" JSONB NOT NULL,
    "finalAction" "CoachAction" NOT NULL,
    "finalChanges" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "athleteMessage" TEXT NOT NULL,
    "accepted" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachDecision_userId_date_idx" ON "CoachDecision"("userId", "date");

-- AddForeignKey
ALTER TABLE "CoachDecision" ADD CONSTRAINT "CoachDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

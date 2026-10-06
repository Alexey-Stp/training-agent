-- CreateEnum
CREATE TYPE "RaceDebriefStatus" AS ENUM ('pending', 'running', 'sent', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "RaceDebriefTier" AS ENUM ('power', 'hr', 'none');

-- CreateTable
CREATE TABLE "RaceDebrief" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "raceId" TEXT NOT NULL,
    "raceDate" TEXT NOT NULL,
    "status" "RaceDebriefStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "activityIcuId" TEXT,
    "tier" "RaceDebriefTier",
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "narrative" TEXT,
    "takeaways" JSONB NOT NULL DEFAULT '[]',
    "debriefText" TEXT,
    "skippedReason" TEXT,
    "askedAt" TIMESTAMP(3),
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaceDebrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaceDebrief_userId_raceId_raceDate_key" ON "RaceDebrief"("userId", "raceId", "raceDate");

-- AddForeignKey
ALTER TABLE "RaceDebrief" ADD CONSTRAINT "RaceDebrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaceDebrief" ADD CONSTRAINT "RaceDebrief_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "Race"("id") ON DELETE CASCADE ON UPDATE CASCADE;

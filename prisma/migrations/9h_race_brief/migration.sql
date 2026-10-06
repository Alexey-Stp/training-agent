-- CreateEnum
CREATE TYPE "RaceBriefKind" AS ENUM ('t7', 't1');

-- CreateEnum
CREATE TYPE "RaceBriefStatus" AS ENUM ('pending', 'running', 'sent', 'failed');

-- CreateTable
CREATE TABLE "RaceBriefRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "raceId" TEXT NOT NULL,
    "kind" "RaceBriefKind" NOT NULL,
    "raceDate" TEXT NOT NULL,
    "status" "RaceBriefStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "briefText" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "stageTimings" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaceBriefRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaceBriefRun_userId_raceId_kind_raceDate_key" ON "RaceBriefRun"("userId", "raceId", "kind", "raceDate");

-- AddForeignKey
ALTER TABLE "RaceBriefRun" ADD CONSTRAINT "RaceBriefRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaceBriefRun" ADD CONSTRAINT "RaceBriefRun_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "Race"("id") ON DELETE CASCADE ON UPDATE CASCADE;

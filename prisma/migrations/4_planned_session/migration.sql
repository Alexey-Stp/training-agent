-- CreateEnum
CREATE TYPE "PlannedSessionStatus" AS ENUM ('draft', 'pushed', 'modified_externally', 'completed', 'skipped');

-- CreateTable
CREATE TABLE "PlannedSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "sport" "Sport" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationMin" INTEGER NOT NULL,
    "intensity" "Intensity" NOT NULL,
    "steps" JSONB NOT NULL,
    "status" "PlannedSessionStatus" NOT NULL DEFAULT 'draft',
    "icuEventId" INTEGER,
    "pushedHash" TEXT,
    "pushedAt" TIMESTAMP(3),
    "externalChange" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannedSession_userId_status_idx" ON "PlannedSession"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedSession_userId_date_slot_key" ON "PlannedSession"("userId", "date", "slot");

-- AddForeignKey
ALTER TABLE "PlannedSession" ADD CONSTRAINT "PlannedSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

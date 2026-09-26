-- AlterEnum
ALTER TYPE "Sport" ADD VALUE 'other';

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "icuId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sport" "Sport" NOT NULL,
    "icuType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "startDateLocal" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "distanceM" DOUBLE PRECISION,
    "load" INTEGER,
    "avgHr" INTEGER,
    "avgPower" INTEGER,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Activity_icuId_key" ON "Activity"("icuId");

-- CreateIndex
CREATE INDEX "Activity_userId_startTime_idx" ON "Activity"("userId", "startTime");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

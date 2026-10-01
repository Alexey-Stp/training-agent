-- CreateEnum
CREATE TYPE "RacePriority" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "RaceType" AS ENUM ('sprint', 'olympic', 'half', 'full', 'run', 'other');

-- CreateEnum
CREATE TYPE "SeasonPlanStatus" AS ENUM ('draft', 'active', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "TrainingBlockType" AS ENUM ('base', 'build', 'peak', 'taper', 'race', 'recovery', 'transition');

-- CreateTable
CREATE TABLE "Race" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" "RacePriority" NOT NULL,
    "type" "RaceType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Race_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "aRaceId" TEXT,
    "status" "SeasonPlanStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingBlock" (
    "id" TEXT NOT NULL,
    "seasonPlanId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "TrainingBlockType" NOT NULL,
    "startDate" TEXT NOT NULL,
    "weeks" INTEGER NOT NULL,
    "focus" TEXT NOT NULL,
    "targetWeeklyHours" DOUBLE PRECISION NOT NULL,
    "targetSwimM" INTEGER NOT NULL,
    "targetBikeH" DOUBLE PRECISION NOT NULL,
    "targetRunKm" DOUBLE PRECISION NOT NULL,
    "targetCtl" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Race_userId_date_idx" ON "Race"("userId", "date");

-- CreateIndex
CREATE INDEX "SeasonPlan_userId_status_idx" ON "SeasonPlan"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingBlock_seasonPlanId_order_key" ON "TrainingBlock"("seasonPlanId", "order");

-- AddForeignKey
ALTER TABLE "Race" ADD CONSTRAINT "Race_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPlan" ADD CONSTRAINT "SeasonPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPlan" ADD CONSTRAINT "SeasonPlan_aRaceId_fkey" FOREIGN KEY ("aRaceId") REFERENCES "Race"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingBlock" ADD CONSTRAINT "TrainingBlock_seasonPlanId_fkey" FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


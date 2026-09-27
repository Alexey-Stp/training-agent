-- Wellness replaces Fatigue. Copy + drop run in one transaction so a failure loses nothing.
BEGIN;

-- CreateTable
CREATE TABLE "Wellness" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hrv" DOUBLE PRECISION,
    "restingHr" INTEGER,
    "sleepHours" DOUBLE PRECISION,
    "sleepScore" INTEGER,
    "weightKg" DOUBLE PRECISION,
    "ctl" DOUBLE PRECISION,
    "atl" DOUBLE PRECISION,
    "tsb" DOUBLE PRECISION,
    "subjectiveReadiness" INTEGER,
    "soreness" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wellness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wellness_userId_date_key" ON "Wellness"("userId", "date");

-- AddForeignKey
ALTER TABLE "Wellness" ADD CONSTRAINT "Wellness_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: Fatigue.readiness is the athlete's check-in. Fatigue.sleepScore has no
-- subjective counterpart, so it lands in the device column and a later sync of that date
-- overwrites it with the ICU value.
INSERT INTO "Wellness" ("id", "userId", "date", "subjectiveReadiness", "sleepScore", "createdAt", "updatedAt")
SELECT "id", "userId", "date", "readiness", "sleepScore", "createdAt", CURRENT_TIMESTAMP
FROM "Fatigue";

-- DropTable
DROP TABLE "Fatigue";

COMMIT;

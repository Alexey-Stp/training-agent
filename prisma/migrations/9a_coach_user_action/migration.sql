-- CreateEnum
CREATE TYPE "CoachUserAction" AS ENUM ('apply', 'keep', 'discuss');

-- AlterTable
ALTER TABLE "CoachDecision" ADD COLUMN     "userAction" "CoachUserAction";

-- Backfill: decisions answered before the column existed
UPDATE "CoachDecision" SET "userAction" = 'apply' WHERE "accepted" = true;
UPDATE "CoachDecision" SET "userAction" = 'keep' WHERE "accepted" = false;

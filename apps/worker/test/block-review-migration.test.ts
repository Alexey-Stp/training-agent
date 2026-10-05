import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9f_block_review';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

const DECISION_COLUMNS = `"id", "userId", "date", "promptVersion", "suggestionPromptVersion",
  "contextHash", "source", "attempts", "rawResponses", "reasons", "finalAction", "finalChanges",
  "summary", "athleteMessage", "origin"`;

function insertRun(id: string, userId: string, seasonId: string, key: string): Promise<unknown> {
  return db.exec(`INSERT INTO "BlockReviewRun" ("id", "userId", "seasonPlanId", "key", "trigger", "updatedAt")
    VALUES ('${id}', '${userId}', '${seasonId}', '${key}', 'block_end', NOW())`);
}

let db: PGlite;

describe('migration 9f_block_review', () => {
  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
    await db.exec(`INSERT INTO "SeasonPlan" ("id", "userId", "startDate", "status", "updatedAt")
      VALUES ('s1', 'u1', '2026-08-17', 'active', NOW()), ('s2', 'u2', '2026-08-17', 'active', NOW())`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9e_weekly_review', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9e_weekly_review', TARGET]);
  });

  it("stores the wizard's answers on a season, both optional", async () => {
    await db.exec(`UPDATE "SeasonPlan" SET "weeklyHoursAvailable" = 12.5, "weakSport" = 'swim'
      WHERE "id" = 's1'`);
    const { rows } = await db.query<{
      weeklyHoursAvailable: number | null;
      weakSport: string | null;
    }>(`SELECT "weeklyHoursAvailable", "weakSport" FROM "SeasonPlan" ORDER BY "id"`);
    expect(rows).toEqual([
      { weeklyHoursAvailable: 12.5, weakSport: 'swim' },
      { weeklyHoursAvailable: null, weakSport: null },
    ]);
  });

  it('stores block decisions', async () => {
    await db.exec(`INSERT INTO "CoachDecision" (${DECISION_COLUMNS})
      VALUES ('d1', 'u1', '2026-10-04', 'block-v1', 'block-v1', 'h', 'llm', 1, '[]', '[]',
              'adjust', '[]', 'Re-project the remaining blocks', '70% of the volume', 'block')`);
    const { rows } = await db.query<{ origin: string }>(
      `SELECT "origin" FROM "CoachDecision" WHERE "id" = 'd1' AND "accepted" IS NULL`
    );
    expect(rows).toEqual([{ origin: 'block' }]);
  });

  it('starts a review run pending, with no proposal and empty timings', async () => {
    await insertRun('r1', 'u1', 's1', 'block:2');
    const { rows } = await db.query<{
      status: string;
      proposedBlocks: unknown;
      stale: boolean;
      stageTimings: object;
    }>(
      `SELECT "status", "proposedBlocks", "stale", "stageTimings" FROM "BlockReviewRun" WHERE "id" = 'r1'`
    );
    expect(rows).toEqual([
      { status: 'pending', proposedBlocks: null, stale: false, stageTimings: {} },
    ]);
  });

  it('keeps one run per season and key', async () => {
    await expect(insertRun('r2', 'u1', 's1', 'block:2')).rejects.toThrow(/unique/i);
    await insertRun('r3', 'u1', 's1', 'race:race1:2026-11-29');
    await insertRun('r4', 'u2', 's2', 'block:2');
  });

  it('deletes the runs with their season and with the athlete', async () => {
    await db.exec(`DELETE FROM "SeasonPlan" WHERE "id" = 's2'`);
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "BlockReviewRun"`);
    expect(rows).toEqual([]);
  });
});

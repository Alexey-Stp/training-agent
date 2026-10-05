import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9e_weekly_review';

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

describe('migration 9e_weekly_review', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9d_weekly_stats', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9d_weekly_stats', TARGET]);
  });

  it('stores weekly decisions with the adjust action', async () => {
    await db.exec(`INSERT INTO "CoachDecision" (${DECISION_COLUMNS})
      VALUES ('d1', 'u1', '2026-10-04', 'weekly-v1', 'weekly-v1', 'h', 'llm', 1, '[]', '[]',
              'adjust', '[]', 'Long ride 210 → 255 min', 'Good week', 'weekly')`);
    const { rows } = await db.query<{ origin: string; finalAction: string }>(
      `SELECT "origin", "finalAction" FROM "CoachDecision" WHERE "id" = 'd1'`
    );
    expect(rows).toEqual([{ origin: 'weekly', finalAction: 'adjust' }]);
  });

  it('starts a review run pending, with empty timings', async () => {
    await db.exec(`INSERT INTO "WeeklyReviewRun" ("id", "userId", "isoWeek", "updatedAt")
      VALUES ('r1', 'u1', '2026-W40', NOW())`);
    const { rows } = await db.query<{ status: string; stale: boolean; stageTimings: object }>(
      `SELECT "status", "stale", "stageTimings" FROM "WeeklyReviewRun" WHERE "id" = 'r1'`
    );
    expect(rows).toEqual([{ status: 'pending', stale: false, stageTimings: {} }]);
  });

  it('keeps one run per athlete and ISO week', async () => {
    await expect(
      db.exec(`INSERT INTO "WeeklyReviewRun" ("id", "userId", "isoWeek", "updatedAt")
        VALUES ('r2', 'u1', '2026-W40', NOW())`)
    ).rejects.toThrow(/unique/i);
    await db.exec(`INSERT INTO "WeeklyReviewRun" ("id", "userId", "isoWeek", "updatedAt")
      VALUES ('r3', 'u2', '2026-W40', NOW())`);
  });

  it("deletes an athlete's runs with the athlete", async () => {
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "WeeklyReviewRun"`);
    expect(rows).toEqual([{ id: 'r3' }]);
  });
});

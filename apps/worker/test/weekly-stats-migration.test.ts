import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9d_weekly_stats';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

const STATS_COLUMNS = `"id", "userId", "isoWeek", "weekStart", "weekEnd", "unplannedWeek",
  "stats", "computedAt", "updatedAt"`;

describe('migration 9d_weekly_stats', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
    await db.exec(`INSERT INTO "WeeklyStats" (${STATS_COLUMNS})
      VALUES ('w1', 'u1', '2026-W40', '2026-09-28', '2026-10-04', false,
              '{"version": 1, "total": {"compliancePct": 76}}', NOW(), NOW())`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9c_evening_closeout', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9c_evening_closeout', TARGET]);
  });

  it('stores the stats as JSON', async () => {
    const { rows } = await db.query<{ compliance: string; unplannedWeek: boolean }>(
      `SELECT "stats"->'total'->>'compliancePct' AS "compliance", "unplannedWeek"
        FROM "WeeklyStats" WHERE "id" = 'w1'`
    );
    expect(rows).toEqual([{ compliance: '76', unplannedWeek: false }]);
  });

  it('keeps one row per athlete and ISO week', async () => {
    await expect(
      db.exec(`INSERT INTO "WeeklyStats" (${STATS_COLUMNS})
        VALUES ('w2', 'u1', '2026-W40', '2026-09-28', '2026-10-04', true, '{}', NOW(), NOW())`)
    ).rejects.toThrow(/unique/i);
    await db.exec(`INSERT INTO "WeeklyStats" (${STATS_COLUMNS})
      VALUES ('w3', 'u2', '2026-W40', '2026-09-28', '2026-10-04', true, '{}', NOW(), NOW())`);
  });

  it("deletes an athlete's weeks with the athlete", async () => {
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "WeeklyStats"`);
    expect(rows).toEqual([{ id: 'w3' }]);
  });
});

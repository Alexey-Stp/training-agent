import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function insertRace(id: string, userId: string): string {
  return `INSERT INTO "Race" ("id", "userId", "date", "name", "priority", "type", "updatedAt")
    VALUES ('${id}', '${userId}', '2026-06-14', 'Challenge Prague', 'A', 'half', NOW())`;
}

function insertPlan(id: string, userId: string, aRaceId: string | null): string {
  const race = aRaceId === null ? 'NULL' : `'${aRaceId}'`;
  return `INSERT INTO "SeasonPlan" ("id", "userId", "startDate", "aRaceId", "updatedAt")
    VALUES ('${id}', '${userId}', '2026-01-26', ${race}, NOW())`;
}

function insertBlock(id: string, planId: string, order: number): string {
  return `INSERT INTO "TrainingBlock" ("id", "seasonPlanId", "order", "type", "startDate", "weeks", "focus",
      "targetWeeklyHours", "targetSwimM", "targetBikeH", "targetRunKm", "updatedAt")
    VALUES ('${id}', '${planId}', ${order.toString()}, 'base', '2026-01-26', 8, 'aerobic base', 10, 8000, 5, 30, NOW())`;
}

async function count(db: PGlite, table: string, where: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${where}`
  );
  return rows[0].n;
}

describe('migration 5_season_plan', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of allMigrations()) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('creates plans as drafts with blocks unique per plan and order', async () => {
    await db.exec(insertRace('r1', 'u1'));
    await db.exec(insertPlan('s1', 'u1', 'r1'));
    await db.exec(insertBlock('b1', 's1', 1));

    const { rows } = await db.query<{ status: string }>(
      `SELECT "status"::text AS "status" FROM "SeasonPlan" WHERE "id" = 's1'`
    );
    expect(rows).toEqual([{ status: 'draft' }]);
    await expect(db.exec(insertBlock('dup', 's1', 1))).rejects.toThrow(/unique/i);
    await db.exec(insertBlock('b2', 's1', 2));
  });

  it('rejects unknown race priorities', async () => {
    await expect(
      db.exec(
        `INSERT INTO "Race" ("id", "userId", "date", "name", "priority", "type", "updatedAt")
          VALUES ('bad', 'u1', '2026-06-14', 'x', 'D', 'half', NOW())`
      )
    ).rejects.toThrow(/enum/i);
  });

  it('clears aRaceId when the A-race is deleted', async () => {
    await db.exec(insertRace('r2', 'u1'));
    await db.exec(insertPlan('s2', 'u1', 'r2'));
    await db.exec(`DELETE FROM "Race" WHERE "id" = 'r2'`);

    const { rows } = await db.query<{ aRaceId: string | null }>(
      `SELECT "aRaceId" FROM "SeasonPlan" WHERE "id" = 's2'`
    );
    expect(rows).toEqual([{ aRaceId: null }]);
  });

  it('cascades user deletes to races, plans and blocks', async () => {
    await db.exec(insertRace('r3', 'u2'));
    await db.exec(insertPlan('s3', 'u2', 'r3'));
    await db.exec(insertBlock('b3', 's3', 1));

    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    expect(await count(db, 'Race', `"userId" = 'u2'`)).toBe(0);
    expect(await count(db, 'SeasonPlan', `"userId" = 'u2'`)).toBe(0);
    expect(await count(db, 'TrainingBlock', `"seasonPlanId" = 's3'`)).toBe(0);
    // Other users' rows are untouched
    expect(await count(db, 'TrainingBlock', `"seasonPlanId" = 's1'`)).toBe(2);
  });
});

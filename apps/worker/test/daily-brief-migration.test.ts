import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9_daily_brief';

function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) < 0);
}

function insertRun(id: string, userId: string, date: string): string {
  return `INSERT INTO "DailyBriefRun" ("id", "userId", "date", "updatedAt")
    VALUES ('${id}', '${userId}', '${date}', NOW())`;
}

describe('migration 9_daily_brief', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    // A profile stored before the migration
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
    await db.exec(`INSERT INTO "Profile" ("id", "userId", "updatedAt") VALUES ('p1', 'u1', NOW())`);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('leaves existing profiles on the default brief time', async () => {
    const { rows } = await db.query<{ briefTime: string | null }>(
      `SELECT "briefTime" FROM "Profile" WHERE "id" = 'p1'`
    );
    expect(rows).toEqual([{ briefTime: null }]);
  });

  it('creates a pending, fresh run with empty timings', async () => {
    await db.exec(insertRun('r1', 'u1', '2026-10-05'));
    const { rows } = await db.query<{ status: string; stale: boolean; stageTimings: unknown }>(
      `SELECT "status"::text AS "status", "stale", "stageTimings" FROM "DailyBriefRun" WHERE "id" = 'r1'`
    );
    expect(rows).toEqual([{ status: 'pending', stale: false, stageTimings: {} }]);
  });

  it('allows one run per athlete and local day', async () => {
    await db.exec(insertRun('r2', 'u1', '2026-10-06'));
    await db.exec(insertRun('r3', 'u2', '2026-10-06'));
    await expect(db.exec(insertRun('r4', 'u1', '2026-10-06'))).rejects.toThrow(/unique/i);
  });

  it('deletes runs with their user', async () => {
    await db.exec(insertRun('r5', 'u2', '2026-10-07'));
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "DailyBriefRun" WHERE "userId" = 'u2'`
    );
    expect(rows[0].n).toBe(0);
  });
});

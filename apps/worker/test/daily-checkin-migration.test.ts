import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9b_daily_checkin';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

describe('migration 9b_daily_checkin', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9a_coach_user_action', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9a_coach_user_action', TARGET]);
  });

  it('stores a run awaiting its check-in, found by the check-in message', async () => {
    await db.exec(`INSERT INTO "DailyBriefRun" ("id", "userId", "date", "status",
        "checkInMessageId", "checkInSentAt", "updatedAt")
      VALUES ('r1', 'u1', '2026-10-05', 'awaiting_checkin', 777, NOW(), NOW())`);
    const { rows } = await db.query<{ id: string; status: string }>(
      `SELECT "id", "status"::text AS "status" FROM "DailyBriefRun"
        WHERE "userId" = 'u1' AND "checkInMessageId" = 777`
    );
    expect(rows).toEqual([{ id: 'r1', status: 'awaiting_checkin' }]);
  });

  it('leaves the check-in columns NULL on runs without a check-in', async () => {
    await db.exec(`INSERT INTO "DailyBriefRun" ("id", "userId", "date", "updatedAt")
      VALUES ('r2', 'u1', '2026-10-06', NOW())`);
    const { rows } = await db.query<{ checkInMessageId: number | null; checkInSentAt: unknown }>(
      `SELECT "checkInMessageId", "checkInSentAt" FROM "DailyBriefRun" WHERE "id" = 'r2'`
    );
    expect(rows).toEqual([{ checkInMessageId: null, checkInSentAt: null }]);
  });
});

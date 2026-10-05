import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9c_evening_closeout';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

const SESSION_COLUMNS = `"id", "userId", "date", "slot", "sport", "title", "durationMin",
  "intensity", "steps", "updatedAt"`;
const ACTIVITY_COLUMNS = `"id", "icuId", "userId", "icuAthleteId", "sport", "icuType", "name",
  "startTime", "startDateLocal", "durationSec", "updatedAt"`;

describe('migration 9c_evening_closeout', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
    await db.exec(`INSERT INTO "PlannedSession" (${SESSION_COLUMNS})
      VALUES ('p1', 'u1', '2026-10-05', 'bike-1', 'bike', 'VO2 ride', 60, 'z5', '[]', NOW())`);
    await db.exec(`INSERT INTO "Activity" (${ACTIVITY_COLUMNS})
      VALUES ('a1', 'i1', 'u1', 'ath', 'bike', 'Ride', 'Ride', NOW(), '2026-10-05', 3600, NOW()),
             ('a2', 'i2', 'u1', 'ath', 'run', 'Run', 'Run', NOW(), '2026-10-05', 1800, NOW())`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9b_daily_checkin', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9b_daily_checkin', TARGET]);
  });

  it('stores the deviation and guessed intensity of a completed session', async () => {
    await db.exec(`UPDATE "PlannedSession"
      SET "status" = 'completed', "deviationPct" = -12.5, "actualIntensity" = 'z4'
      WHERE "id" = 'p1'`);
    const { rows } = await db.query<{ deviationPct: number; actualIntensity: string }>(
      `SELECT "deviationPct", "actualIntensity"::text AS "actualIntensity"
        FROM "PlannedSession" WHERE "id" = 'p1'`
    );
    expect(rows).toEqual([{ deviationPct: -12.5, actualIntensity: 'z4' }]);
  });

  it('links an activity to at most one session', async () => {
    await db.exec(`UPDATE "Activity" SET "plannedSessionId" = 'p1', "closedOutAt" = NOW()
      WHERE "id" = 'a1'`);
    await expect(
      db.exec(`UPDATE "Activity" SET "plannedSessionId" = 'p1' WHERE "id" = 'a2'`)
    ).rejects.toThrow();
  });

  it('finds closed-out activities without a session as unplanned', async () => {
    await db.exec(`UPDATE "Activity" SET "closedOutAt" = NOW() WHERE "id" = 'a2'`);
    const { rows } = await db.query<{ id: string }>(
      `SELECT "id" FROM "Activity"
        WHERE "userId" = 'u1' AND "closedOutAt" IS NOT NULL AND "plannedSessionId" IS NULL`
    );
    expect(rows).toEqual([{ id: 'a2' }]);
  });

  it('unlinks the activity when its session is deleted', async () => {
    await db.exec(`DELETE FROM "PlannedSession" WHERE "id" = 'p1'`);
    const { rows } = await db.query<{ plannedSessionId: string | null }>(
      `SELECT "plannedSessionId" FROM "Activity" WHERE "id" = 'a1'`
    );
    expect(rows).toEqual([{ plannedSessionId: null }]);
  });

  it('keeps one close-out run per athlete and day', async () => {
    await db.exec(`INSERT INTO "EveningCloseoutRun" ("id", "userId", "date", "status", "updatedAt")
      VALUES ('r1', 'u1', '2026-10-05', 'quiet', NOW())`);
    await expect(
      db.exec(`INSERT INTO "EveningCloseoutRun" ("id", "userId", "date", "updatedAt")
        VALUES ('r2', 'u1', '2026-10-05', NOW())`)
    ).rejects.toThrow();
  });
});

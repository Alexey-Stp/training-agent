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
    .sort();
}

function insertSession(id: string, userId: string, date: string, slot: string): string {
  return `INSERT INTO "PlannedSession" ("id", "userId", "date", "slot", "sport", "title", "durationMin", "intensity", "steps", "updatedAt")
    VALUES ('${id}', '${userId}', '${date}', '${slot}', 'bike', 'Bike Endurance', 60, 'z2', '[]', NOW())`;
}

describe('migration 4_planned_session', () => {
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

  it('creates sessions as drafts with no ICU event', async () => {
    await db.exec(insertSession('p1', 'u1', '2026-09-28', 'bike-0'));
    const { rows } = await db.query<{ status: string; icuEventId: number | null }>(
      `SELECT "status"::text AS "status", "icuEventId" FROM "PlannedSession" WHERE "id" = 'p1'`
    );
    expect(rows).toEqual([{ status: 'draft', icuEventId: null }]);
  });

  it('enforces one session per user, date and slot, and cascades user deletes', async () => {
    await expect(db.exec(insertSession('dup', 'u1', '2026-09-28', 'bike-0'))).rejects.toThrow(
      /unique/i
    );
    // Same slot for another user or another slot on the same date is fine
    await db.exec(insertSession('p2', 'u2', '2026-09-28', 'bike-0'));
    await db.exec(insertSession('p3', 'u1', '2026-09-28', 'swim-0'));

    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "PlannedSession" WHERE "userId" = 'u2'`
    );
    expect(rows[0].n).toBe(0);
  });
});

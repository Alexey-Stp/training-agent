import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9h_race_brief';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

const INSERT_RUN = (id: string, user: string, race: string, kind: string, raceDate: string) =>
  `INSERT INTO "RaceBriefRun" ("id", "userId", "raceId", "kind", "raceDate", "updatedAt")
   VALUES ('${id}', '${user}', '${race}', '${kind}', '${raceDate}', NOW())`;

describe('migration 9h_race_brief', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsUpTo(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
    await db.exec(`INSERT INTO "Race" ("id", "userId", "date", "name", "priority", "type", "updatedAt")
      VALUES ('race1', 'u1', '2026-10-17', 'Prague Half', 'A', 'half', NOW()),
             ('race2', 'u1', '2026-10-24', 'Local 10k', 'C', 'run', NOW())`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9g_race_travel', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9g_race_travel', TARGET]);
  });

  it('starts a run pending, with empty timings', async () => {
    await db.exec(INSERT_RUN('r1', 'u1', 'race1', 't7', '2026-10-17'));
    const { rows } = await db.query<{ status: string; stale: boolean; stageTimings: object }>(
      `SELECT "status", "stale", "stageTimings" FROM "RaceBriefRun" WHERE "id" = 'r1'`
    );
    expect(rows).toEqual([{ status: 'pending', stale: false, stageTimings: {} }]);
  });

  it('keeps one run per race, kind and race date', async () => {
    await expect(db.exec(INSERT_RUN('r2', 'u1', 'race1', 't7', '2026-10-17'))).rejects.toThrow(
      /unique/i
    );
    await db.exec(INSERT_RUN('r3', 'u1', 'race1', 't1', '2026-10-17'));
    // A race moved to another date is briefed again
    await db.exec(INSERT_RUN('r4', 'u1', 'race1', 't7', '2026-10-24'));
  });

  it('rejects an unknown kind', async () => {
    await expect(db.exec(INSERT_RUN('r5', 'u1', 'race1', 't3', '2026-10-17'))).rejects.toThrow();
  });

  it("deletes a race's runs with the race", async () => {
    await db.exec(INSERT_RUN('r6', 'u1', 'race2', 't1', '2026-10-24'));
    await db.exec(`DELETE FROM "Race" WHERE "id" = 'race2'`);
    const { rows } = await db.query<{ id: string }>(
      `SELECT "id" FROM "RaceBriefRun" WHERE "raceId" = 'race2'`
    );
    expect(rows).toHaveLength(0);
  });

  it("deletes an athlete's runs with the athlete", async () => {
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "RaceBriefRun"`);
    expect(rows).toHaveLength(0);
  });
});

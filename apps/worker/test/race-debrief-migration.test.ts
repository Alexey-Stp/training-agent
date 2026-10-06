import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9i_race_debrief';

function migrationsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) <= 0);
}

const INSERT_DEBRIEF = (id: string, user: string, race: string, raceDate: string) =>
  `INSERT INTO "RaceDebrief" ("id", "userId", "raceId", "raceDate", "updatedAt")
   VALUES ('${id}', '${user}', '${race}', '${raceDate}', NOW())`;

describe('migration 9i_race_debrief', () => {
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

  it('runs after 9h_race_brief', () => {
    expect(migrationsUpTo(TARGET).slice(-2)).toEqual(['9h_race_brief', TARGET]);
  });

  it('starts a debrief pending, with empty metrics and takeaways', async () => {
    await db.exec(INSERT_DEBRIEF('d1', 'u1', 'race1', '2026-10-17'));
    const { rows } = await db.query<{
      status: string;
      tier: string | null;
      metrics: object;
      takeaways: unknown[];
      stageTimings: object;
    }>(
      `SELECT "status", "tier", "metrics", "takeaways", "stageTimings" FROM "RaceDebrief" WHERE "id" = 'd1'`
    );
    expect(rows).toEqual([
      { status: 'pending', tier: null, metrics: {}, takeaways: [], stageTimings: {} },
    ]);
  });

  it('keeps one debrief per race and race date', async () => {
    await expect(db.exec(INSERT_DEBRIEF('d2', 'u1', 'race1', '2026-10-17'))).rejects.toThrow(
      /unique/i
    );
    // A race moved to another date is debriefed again
    await db.exec(INSERT_DEBRIEF('d3', 'u1', 'race1', '2026-10-24'));
  });

  it('accepts the skipped status and the tiers, and rejects unknown values', async () => {
    await db.exec(
      `UPDATE "RaceDebrief" SET "status" = 'skipped', "tier" = 'power' WHERE "id" = 'd1'`
    );
    await expect(
      db.exec(`UPDATE "RaceDebrief" SET "status" = 'lost' WHERE "id" = 'd1'`)
    ).rejects.toThrow();
    await expect(
      db.exec(`UPDATE "RaceDebrief" SET "tier" = 'gps' WHERE "id" = 'd1'`)
    ).rejects.toThrow();
  });

  it("deletes a race's debriefs with the race", async () => {
    await db.exec(INSERT_DEBRIEF('d4', 'u1', 'race2', '2026-10-24'));
    await db.exec(`DELETE FROM "Race" WHERE "id" = 'race2'`);
    const { rows } = await db.query<{ id: string }>(
      `SELECT "id" FROM "RaceDebrief" WHERE "raceId" = 'race2'`
    );
    expect(rows).toHaveLength(0);
  });

  it("deletes an athlete's debriefs with the athlete", async () => {
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const { rows } = await db.query<{ id: string }>(`SELECT "id" FROM "RaceDebrief"`);
    expect(rows).toHaveLength(0);
  });
});

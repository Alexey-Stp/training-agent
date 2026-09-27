import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const WELLNESS_MIGRATION = '3_wellness';

function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

/** Migration folders in Prisma's apply order (lexicographic). */
function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .filter((n) => n < name);
}

interface WellnessRow {
  id: string;
  userId: string;
  date: string;
  subjectiveReadiness: number | null;
  sleepScore: number | null;
  soreness: number | null;
  hrv: number | null;
  ctl: number | null;
  createdAt: string;
}

describe(`migration ${WELLNESS_MIGRATION}: Fatigue → Wellness`, () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(WELLNESS_MIGRATION)) await db.exec(migrationSql(name));

    await db.exec(`
      INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002);
      INSERT INTO "Fatigue" ("id", "userId", "date", "readiness", "sleepScore", "createdAt") VALUES
        ('f1', 'u1', '2026-09-20', 2, 71, '2026-09-20 07:00:00'),
        ('f2', 'u1', '2026-09-21', 4, NULL, '2026-09-21 07:00:00'),
        ('f3', 'u1', '2026-09-22', NULL, 88, '2026-09-22 07:00:00'),
        ('f4', 'u2', '2026-09-20', 5, 90, '2026-09-20 08:00:00');
    `);

    await db.exec(migrationSql(WELLNESS_MIGRATION));
  });

  afterAll(async () => {
    await db.close();
  });

  it('copies every Fatigue row into Wellness subjective readiness', async () => {
    const { rows } = await db.query<WellnessRow>(
      `SELECT *, "createdAt"::text AS "createdAt" FROM "Wellness" ORDER BY "userId", "date"`
    );

    expect(rows.map((r) => [r.id, r.userId, r.date, r.subjectiveReadiness, r.sleepScore])).toEqual([
      ['f1', 'u1', '2026-09-20', 2, 71],
      ['f2', 'u1', '2026-09-21', 4, null],
      ['f3', 'u1', '2026-09-22', null, 88],
      ['f4', 'u2', '2026-09-20', 5, 90],
    ]);
    // Original creation time kept (compared as text: timestamp(3) has no zone)
    expect(rows[0].createdAt).toBe('2026-09-20 07:00:00');
    // Nothing else is invented: device fields and soreness start empty
    for (const r of rows) expect([r.hrv, r.ctl, r.soreness]).toEqual([null, null, null]);
  });

  it('drops the Fatigue table', async () => {
    const { rows } = await db.query<{ table: string | null }>(
      `SELECT to_regclass('"Fatigue"')::text AS "table"`
    );
    expect(rows[0].table).toBeNull();
  });

  it('enforces one row per user and date, and cascades user deletes', async () => {
    await expect(
      db.exec(
        `INSERT INTO "Wellness" ("id", "userId", "date", "updatedAt") VALUES ('dup', 'u1', '2026-09-20', NOW())`
      )
    ).rejects.toThrow(/unique/i);

    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "Wellness" WHERE "userId" = 'u2'`
    );
    expect(rows[0].n).toBe(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { hasIndexPrefix, INDEX_ACCESS_PATHS } from '../../../scripts/db-expectations';
import {
  applyMigrations,
  applyMigrationsFrom,
  indexColumns,
  migrationNames,
  schemaModels,
} from './migration-helpers';

// TA-50: the whole migration series, applied to a fresh DB and over a legacy one
describe('migration series on a fresh database', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies in name order, so a numeric prefix past 9 needs care', () => {
    // Prisma sorts folder names as strings: `10_x` would run before `2_x`
    const numeric = migrationNames().filter((n) => /^\d+_/.test(n));
    expect(numeric.filter((n) => /^\d{2,}_/.test(n))).toEqual([]);
  });

  it('creates a table for every model in schema.prisma', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tables = new Set(rows.map((r) => r.name));
    const missing = schemaModels().filter((m) => !tables.has(m));
    expect(missing).toEqual([]);
  });

  it('no longer has the legacy Fatigue table', async () => {
    const { rows } = await db.query<{ t: string | null }>(
      `SELECT to_regclass('"Fatigue"')::text AS t`
    );
    expect(rows[0].t).toBeNull();
  });

  it.each(INDEX_ACCESS_PATHS)('%s has an index starting with %j', async (table, columns) => {
    const indexes = (await indexColumns(db)).get(table) ?? [];
    const covered = hasIndexPrefix(indexes, columns);
    expect(covered, `indexes on ${table}: ${JSON.stringify(indexes)}`).toBe(true);
  });

  it('keeps one Wellness row per user and date unique', async () => {
    const indexes = (await indexColumns(db)).get('Wellness') ?? [];
    expect(indexes).toContainEqual(['userId', 'date']);
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('ux', 7)`);
    await db.exec(
      `INSERT INTO "Wellness" ("id", "userId", "date", "updatedAt") VALUES ('w1', 'ux', '2026-10-01', NOW())`
    );
    await expect(
      db.exec(
        `INSERT INTO "Wellness" ("id", "userId", "date", "updatedAt") VALUES ('w2', 'ux', '2026-10-01', NOW())`
      )
    ).rejects.toThrow(/unique/i);
  });
});

describe('upgrade path with legacy Fatigue data', () => {
  const FIRST_WELLNESS = '3_wellness';
  let db: PGlite;
  let legacyFatigue: number;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db, FIRST_WELLNESS);
    await db.exec(`
      INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1), ('u2', 2), ('u3', 3);
      INSERT INTO "Fatigue" ("id", "userId", "date", "readiness", "sleepScore") VALUES
        ('f1', 'u1', '2026-09-01', 2, 70),
        ('f2', 'u1', '2026-09-02', NULL, NULL),
        ('f3', 'u1', '2026-09-03', 5, 91),
        ('f4', 'u2', '2026-09-01', 3, NULL),
        ('f5', 'u2', '2026-09-02', NULL, 60);
      INSERT INTO "Workout" ("id", "userId", "sport", "durationMin", "date")
        VALUES ('w1', 'u3', 'run', 45, '2026-09-01');
    `);
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Fatigue"`);
    legacyFatigue = rows[0].n;

    // Everything from the Wellness migration to the latest one, as `prisma migrate deploy` does
    await applyMigrationsFrom(db, FIRST_WELLNESS);
  });

  afterAll(async () => {
    await db.close();
  });

  it('lands every Fatigue row in Wellness (parity count)', async () => {
    const { rows } = await db.query<{ legacy: number; migrated: number }>(
      `SELECT $1::int AS legacy,
              (SELECT COUNT(*)::int FROM "Wellness") AS migrated`,
      [legacyFatigue]
    );
    expect(rows[0]).toEqual({ legacy: 5, migrated: 5 });
  });

  it('keeps the legacy values and ids', async () => {
    const { rows } = await db.query<{ id: string; r: number | null; s: number | null }>(
      `SELECT "id", "subjectiveReadiness" AS r, "sleepScore" AS s FROM "Wellness" ORDER BY "id"`
    );
    expect(rows).toEqual([
      { id: 'f1', r: 2, s: 70 },
      { id: 'f2', r: null, s: null },
      { id: 'f3', r: 5, s: 91 },
      { id: 'f4', r: 3, s: null },
      { id: 'f5', r: null, s: 60 },
    ]);
  });

  it('leaves unrelated tables alone through the later migrations', async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Workout"`);
    expect(rows[0].n).toBe(1);
  });
});

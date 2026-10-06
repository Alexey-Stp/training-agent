import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9g_race_travel';

function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) < 0);
}

async function travelDate(db: PGlite, id: string): Promise<string | null> {
  const { rows } = await db.query<{ travelDate: string | null }>(
    `SELECT "travelDate" FROM "Race" WHERE "id" = '${id}'`
  );
  return rows[0].travelDate;
}

describe('migration 9g_race_travel', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    // A race stored before the migration
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
    await db.exec(`INSERT INTO "Race" ("id", "userId", "date", "name", "priority", "type", "updatedAt")
      VALUES ('old', 'u1', '2027-06-12', 'Prague', 'A', 'half', NOW())`);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9f_block_review', () => {
    expect(migrationsBefore(TARGET).at(-1)).toBe('9f_block_review');
  });

  it('leaves existing races without a travel day and stores a new one', async () => {
    expect(await travelDate(db, 'old')).toBeNull();
    await db.exec(`UPDATE "Race" SET "travelDate" = '2027-06-11' WHERE "id" = 'old'`);
    expect(await travelDate(db, 'old')).toBe('2027-06-11');
  });
});

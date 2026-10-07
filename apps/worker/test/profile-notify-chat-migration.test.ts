import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9j_profile_notify_chat';

function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) < 0);
}

async function notifyChatId(db: PGlite, id: string): Promise<string | null> {
  const { rows } = await db.query<{ notifyChatId: string | null }>(
    `SELECT "notifyChatId"::text AS "notifyChatId" FROM "Profile" WHERE "id" = '${id}'`
  );
  return rows[0].notifyChatId;
}

describe('migration 9j_profile_notify_chat', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    // A profile stored before the migration
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
    await db.exec(`INSERT INTO "Profile" ("id", "userId", "updatedAt") VALUES ('p1', 'u1', NOW())`);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9i_race_debrief', () => {
    expect(migrationsBefore(TARGET).at(-1)).toBe('9i_race_debrief');
  });

  it('keeps existing profiles on the private chat and stores a channel id', async () => {
    expect(await notifyChatId(db, 'p1')).toBeNull();
    await db.exec(`UPDATE "Profile" SET "notifyChatId" = -1001234567890 WHERE "id" = 'p1'`);
    expect(await notifyChatId(db, 'p1')).toBe('-1001234567890');
  });
});

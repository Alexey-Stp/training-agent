import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '9a_coach_user_action';

function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) < 0);
}

function insertDecision(id: string, accepted: boolean | null): string {
  const acceptedSql = accepted === null ? 'NULL' : String(accepted);
  return `INSERT INTO "CoachDecision" ("id", "userId", "date", "promptVersion", "suggestionPromptVersion",
      "contextHash", "source", "attempts", "rawResponses", "reasons", "finalAction",
      "finalChanges", "summary", "athleteMessage", "accepted")
    VALUES ('${id}', 'u1', '2026-10-05', 'daily-v1', 'suggestion-v1', 'abc', 'fallback', 0,
      '[]', '[]', 'keep', '[]', 'No changes, plan kept', 'Keep your plan', ${acceptedSql})`;
}

async function userAction(db: PGlite, id: string): Promise<string | null> {
  const { rows } = await db.query<{ userAction: string | null }>(
    `SELECT "userAction"::text AS "userAction" FROM "CoachDecision" WHERE "id" = '${id}'`
  );
  return rows[0].userAction;
}

describe('migration 9a_coach_user_action', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    // Decisions answered (or not) before the migration
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001)`);
    await db.exec(insertDecision('applied', true));
    await db.exec(insertDecision('kept', false));
    await db.exec(insertDecision('open', null));
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('runs after 9_daily_brief', () => {
    expect(migrationsBefore(TARGET).at(-1)).toBe('9_daily_brief');
  });

  it('backfills the action of answered decisions', async () => {
    expect(await userAction(db, 'applied')).toBe('apply');
    expect(await userAction(db, 'kept')).toBe('keep');
    expect(await userAction(db, 'open')).toBeNull();
  });

  it('accepts discuss and rejects unknown actions', async () => {
    await db.exec(`UPDATE "CoachDecision" SET "userAction" = 'discuss' WHERE "id" = 'open'`);
    expect(await userAction(db, 'open')).toBe('discuss');
    await expect(
      db.exec(`UPDATE "CoachDecision" SET "userAction" = 'maybe' WHERE "id" = 'open'`)
    ).rejects.toThrow(/enum/i);
  });
});

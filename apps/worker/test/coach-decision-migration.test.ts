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
    .sort((a, b) => a.localeCompare(b));
}

function insertDecision(
  id: string,
  userId: string,
  verdict: string | null,
  action = 'keep'
): string {
  const verdictSql = verdict === null ? 'NULL' : "'" + verdict + "'";
  return `INSERT INTO "CoachDecision" ("id", "userId", "date", "promptVersion", "suggestionPromptVersion",
      "contextHash", "source", "attempts", "rawResponses", "verdict", "reasons", "finalAction",
      "finalChanges", "summary", "athleteMessage")
    VALUES ('${id}', '${userId}', '2026-10-05', 'daily-v1', 'suggestion-v1', 'abc', 'fallback', 0,
      '[]', ${verdictSql}, '[]', '${action}', '[]', 'No changes, plan kept', 'Keep your plan')`;
}

describe('migration 7_coach_decision', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Migrations must run in order
    for (const name of allMigrations()) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
  });

  afterAll(async () => {
    await db.close();
  });

  it('stores a fallback decision without a verdict and an unanswered accepted flag', async () => {
    await db.exec(insertDecision('d1', 'u1', null));
    const { rows } = await db.query<{ verdict: string | null; accepted: boolean | null }>(
      `SELECT "verdict"::text AS "verdict", "accepted" FROM "CoachDecision" WHERE "id" = 'd1'`
    );
    expect(rows).toEqual([{ verdict: null, accepted: null }]);
  });

  it('rejects unknown verdicts and actions', async () => {
    await expect(db.exec(insertDecision('bad1', 'u1', 'maybe'))).rejects.toThrow(/enum/i);
    await expect(db.exec(insertDecision('bad2', 'u1', 'accept', 'sprint'))).rejects.toThrow(
      /enum/i
    );
  });

  it("deletes a user's decisions with the user", async () => {
    await db.exec(insertDecision('d2', 'u2', 'reject'));
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "CoachDecision" WHERE "userId" = 'u2'`
    );
    expect(rows[0].n).toBe(0);
  });
});

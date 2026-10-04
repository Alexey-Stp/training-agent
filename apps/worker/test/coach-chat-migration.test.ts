import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Runs the real Prisma migration SQL in an in-process Postgres (PGlite)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../prisma/migrations');
const TARGET = '8_coach_chat';

function migrationsBefore(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((n) => n.localeCompare(name) < 0);
}

function insertMessage(id: string, userId: string, role: string, messageId: number): string {
  return `INSERT INTO "CoachChatMessage" ("id", "userId", "role", "text", "telegramMessageId")
    VALUES ('${id}', '${userId}', '${role}', 'hello', ${messageId.toString()})`;
}

describe('migration 8_coach_chat', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const name of migrationsBefore(TARGET)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    }
    // A decision stored before the migration
    await db.exec(`INSERT INTO "User" ("id", "telegramId") VALUES ('u1', 1001), ('u2', 1002)`);
    await db.exec(`INSERT INTO "CoachDecision" ("id", "userId", "date", "promptVersion",
        "suggestionPromptVersion", "contextHash", "source", "attempts", "rawResponses", "reasons",
        "finalAction", "finalChanges", "summary", "athleteMessage")
      VALUES ('d1', 'u1', '2026-10-05', 'daily-v1', 'suggestion-v1', 'abc', 'fallback', 0, '[]',
        '[]', 'keep', '[]', 'No changes, plan kept', 'Keep your plan')`);
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('marks existing decisions as daily and unanswered', async () => {
    const { rows } = await db.query<{ origin: string; answeredAt: Date | null }>(
      `SELECT "origin"::text AS "origin", "answeredAt" FROM "CoachDecision" WHERE "id" = 'd1'`
    );
    expect(rows).toEqual([{ origin: 'daily', answeredAt: null }]);
  });

  it('adds a nullable coachDecisionId to planned sessions', async () => {
    const { rows } = await db.query<{ is_nullable: string }>(
      `SELECT "is_nullable" FROM information_schema.columns
        WHERE table_name = 'PlannedSession' AND column_name = 'coachDecisionId'`
    );
    expect(rows).toEqual([{ is_nullable: 'YES' }]);
  });

  it('stores one user and one coach message per Telegram message', async () => {
    await db.exec(insertMessage('m1', 'u1', 'user', 10));
    await db.exec(insertMessage('m2', 'u1', 'coach', 10));
    await expect(db.exec(insertMessage('m3', 'u1', 'coach', 10))).rejects.toThrow(/unique/i);
    await expect(db.exec(insertMessage('m4', 'u1', 'robot', 11))).rejects.toThrow(/enum/i);
  });

  it('deletes chat messages with their user', async () => {
    await db.exec(insertMessage('m5', 'u2', 'user', 20));
    await db.exec(`DELETE FROM "User" WHERE "id" = 'u2'`);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "CoachChatMessage" WHERE "userId" = 'u2'`
    );
    expect(rows[0].n).toBe(0);
  });
});

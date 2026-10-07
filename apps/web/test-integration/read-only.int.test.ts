import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { localToday } from '@triathlon/core';
import { buildDemoData, DEMO_TELEGRAM_ID } from '../../../scripts/seed-demo-data';
import { createDashboardReadRepo, createPrismaClient, createUserRepo } from '../src/db';
import { get, signIn, startApp, type Harness } from '../test/harness';

/**
 * Read-only guarantee against a real Postgres (CI `integration` job, after `db:push`): seeds
 * the demo athlete, then loads Today and Week many times and checks that the PlannedSession,
 * Activity and Wellness row counts and newest updatedAt are unchanged.
 *
 *   DATABASE_URL=... npm -w @triathlon/web run test:integration
 */
const TABLES = ['PlannedSession', 'Activity', 'Wellness'] as const;
const LOADS = 10;

interface Snapshot {
  table: string;
  rows: number;
  newest: string | null;
}

async function snapshot(prisma: PrismaClient, userId: string): Promise<Snapshot[]> {
  return Promise.all(
    TABLES.map(async (table) => {
      const [row] = await prisma.$queryRawUnsafe<{ rows: number; newest: Date | null }[]>(
        'SELECT COUNT(*)::int AS "rows", MAX("updatedAt") AS "newest" FROM "' +
          table +
          '" WHERE "userId" = $1',
        userId
      );
      return { table, rows: row.rows, newest: row.newest?.toISOString() ?? null };
    })
  );
}

const silent = { warn: () => undefined, error: () => undefined };

describe.skipIf(!process.env.DATABASE_URL)('read-only guarantee (Postgres)', () => {
  let prisma: PrismaClient;
  let h: Harness;
  let userId: string;

  beforeAll(async () => {
    prisma = createPrismaClient(process.env.DATABASE_URL ?? '', silent);
    const today = localToday(new Date(), 'Europe/Prague');
    const data = buildDemoData(today);
    userId = data.user.id ?? '';
    await prisma.$transaction(async (tx) => {
      await tx.user.deleteMany({ where: { telegramId: DEMO_TELEGRAM_ID } });
      await tx.user.create({ data: data.user });
      await tx.profile.create({ data: data.profile });
      await tx.race.createMany({ data: data.races });
      await tx.seasonPlan.createMany({ data: data.seasonPlans });
      await tx.trainingBlock.createMany({ data: data.trainingBlocks });
      await tx.plannedSession.createMany({ data: data.plannedSessions });
      await tx.activity.createMany({ data: data.activities });
      await tx.wellness.createMany({ data: data.wellness });
    });
    h = await startApp([], {
      reads: createDashboardReadRepo(prisma),
      users: createUserRepo(prisma),
      now: () => new Date(),
    });
  });

  afterAll(async () => {
    await h.close();
    await prisma.user.deleteMany({ where: { telegramId: DEMO_TELEGRAM_ID } });
    await prisma.$disconnect();
  });

  it('leaves training rows untouched across repeated Today/Week loads', async () => {
    const before = await snapshot(prisma, userId);
    expect(before.every((s) => s.rows > 0)).toBe(true);

    const cookie = await signIn(h, userId);
    for (let i = 0; i < LOADS; i++) {
      // Sequential on purpose: round after round of reloads, like an athlete refreshing the page
      const responses = await Promise.all(
        ['/', '/week', '/week?week=2026-W01'].map((p) => get(h, p, cookie))
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    }

    expect(await snapshot(prisma, userId)).toEqual(before);
  });

  it('renders the seeded plan', async () => {
    const cookie = await signIn(h, userId);
    const html = await (await get(h, '/', cookie)).text();
    expect(html).not.toContain('No plan yet');
  });
});

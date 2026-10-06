import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildDemoData, DEMO_TELEGRAM_ID } from './seed-demo-data';

/**
 * Seeds one demo athlete with 30 days of synthetic wellness, activities and plan.
 * Re-running replaces the demo athlete (User deletes cascade), so it is safe to repeat.
 *
 *   npm run db:seed                 # anchored on today (UTC)
 *   npm run db:seed -- 2026-10-06   # anchored on a fixed date
 *
 * The demo athlete has no IcuConnection on purpose: the worker schedulers only exist per
 * connection, so nothing calls intervals.icu for it.
 */
const DATE_ARG = /^\d{4}-\d{2}-\d{2}$/;

function resolveToday(arg: string | undefined): string {
  if (arg === undefined) return new Date().toISOString().slice(0, 10);
  if (!DATE_ARG.test(arg)) throw new Error(`Expected a yyyy-MM-dd date, got "${arg}"`);
  return arg;
}

async function main(): Promise<void> {
  const today = resolveToday(process.argv[2]);
  const data = buildDemoData(today);
  const prisma = new PrismaClient();

  try {
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
  } finally {
    await prisma.$disconnect();
  }

  console.warn(
    `Seeded demo athlete (telegramId ${DEMO_TELEGRAM_ID}) as of ${today}: ` +
      `${data.wellness.length} wellness days, ${data.activities.length} activities, ` +
      `${data.plannedSessions.length} planned sessions`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

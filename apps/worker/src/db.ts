import { PrismaClient } from '@prisma/client';
import { Sport } from '@triathlon/core';
import { logger } from './logger';
import type { IcuConnectionRepo } from './icu-connect';
import type { ActivityRepo } from './activity-sync';

export const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('warn', (e) => {
  logger.warn(e, 'Prisma warning');
});

prisma.$on('error', (e) => {
  logger.error(e, 'Prisma error');
});

export async function ensureUser(telegramId: number) {
  let user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    include: { profile: true },
  });

  if (!user) {
    // Create new user with default profile
    user = await prisma.user.create({
      data: {
        telegramId: BigInt(telegramId),
        profile: {
          create: {
            ftp: 355,
            timezone: 'Europe/Prague',
            swimDays: ['Wed', 'Fri', 'Sun_optional'],
            bikeVo2Day: 'Thu',
            longBikeDay: 'Sun',
            noLongRunDay: 'Sun',
          },
        },
      },
      include: { profile: true },
    });

    logger.info({ userId: user.id, telegramId }, 'Created new user with default profile');
  }

  return user;
}

export async function checkMessageProcessed(userId: string, messageId: number): Promise<boolean> {
  const existing = await prisma.processedMessage.findUnique({
    where: {
      userId_telegramMessageId: {
        userId,
        telegramMessageId: messageId,
      },
    },
  });

  return existing !== null;
}

export async function markMessageProcessed(userId: string, messageId: number): Promise<void> {
  await prisma.processedMessage.create({
    data: {
      userId,
      telegramMessageId: messageId,
    },
  });
}

export const icuConnectionRepo: IcuConnectionRepo = {
  async upsert(data) {
    const { userId, ...fields } = data;
    await prisma.icuConnection.upsert({
      where: { userId },
      create: data,
      update: fields,
    });
  },

  findByUserId(userId) {
    return prisma.icuConnection.findUnique({ where: { userId } });
  },

  async deleteByUserId(userId) {
    const { count } = await prisma.icuConnection.deleteMany({ where: { userId } });
    return count > 0;
  },
};

const activityFields = {
  icuId: true,
  userId: true,
  sport: true,
  icuType: true,
  name: true,
  startTime: true,
  startDateLocal: true,
  durationSec: true,
  distanceM: true,
  load: true,
  avgHr: true,
  avgPower: true,
  source: true,
} as const;

export const activityRepo: ActivityRepo = {
  findConnection(userId) {
    return prisma.icuConnection.findUnique({ where: { userId } });
  },

  async findByIcuIds(userId, icuIds) {
    if (icuIds.length === 0) return [];
    const rows = await prisma.activity.findMany({
      where: { userId, icuId: { in: icuIds } },
      select: activityFields,
    });
    return rows.map((row) => ({ ...row, sport: row.sport as Sport }));
  },

  async applySync({ userId, creates, updates, cursor }) {
    return prisma.$transaction(async (tx) => {
      // skipDuplicates: a concurrent /sync and scheduled run may insert the same activity
      const { count } =
        creates.length > 0
          ? await tx.activity.createMany({ data: creates, skipDuplicates: true })
          : { count: 0 };
      for (const { icuId, ...data } of updates) {
        await tx.activity.update({ where: { icuId }, data });
      }
      await tx.icuConnection.update({ where: { userId }, data: { lastActivitySyncAt: cursor } });
      return { created: count };
    });
  },

  async listConnectedUserIds() {
    const rows = await prisma.icuConnection.findMany({ select: { userId: true } });
    return rows.map((row) => row.userId);
  },
};

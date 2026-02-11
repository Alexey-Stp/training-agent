import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

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

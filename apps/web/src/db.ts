import { PrismaClient } from '@prisma/client';
import type { UserRepo } from './auth/guard';
import { logger } from './logger';

/**
 * The web app reads training data and writes only Profile settings. Every repo method takes
 * the session's userId and scopes its query by it.
 */
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

export function createUserRepo(client: PrismaClient): UserRepo {
  return {
    async exists(userId) {
      const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } });
      return user !== null;
    },
  };
}

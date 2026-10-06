import { PrismaClient } from '@prisma/client';
import type { UserRepo } from './auth/guard';
import type { SettingsRepo } from './settings/store';
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function createSettingsRepo(client: PrismaClient): SettingsRepo {
  return {
    async load(userId) {
      const user = await client.user.findUnique({
        where: { id: userId },
        select: { telegramId: true, profile: true },
      });
      if (!user?.profile) return null;
      const p = user.profile;
      return {
        ftp: p.ftp,
        lthr: p.lthr,
        timezone: p.timezone,
        briefTime: p.briefTime,
        closeoutTime: p.closeoutTime,
        swimDays: asStringArray(p.swimDays),
        bikeVo2Day: p.bikeVo2Day,
        longBikeDay: p.longBikeDay,
        noLongRunDay: p.noLongRunDay,
        notifyChatId: p.notifyChatId === null ? null : p.notifyChatId.toString(),
        telegramId: user.telegramId.toString(),
      };
    },

    async save(userId, s) {
      await client.profile.update({
        where: { userId },
        data: {
          ftp: s.ftp,
          lthr: s.lthr,
          timezone: s.timezone,
          briefTime: s.briefTime,
          closeoutTime: s.closeoutTime,
          swimDays: s.swimDays,
          bikeVo2Day: s.bikeVo2Day,
          longBikeDay: s.longBikeDay,
          noLongRunDay: s.noLongRunDay,
          notifyChatId: s.notifyChatId === null ? null : BigInt(s.notifyChatId),
        },
      });
    },
  };
}

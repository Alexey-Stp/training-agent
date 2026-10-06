import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { Logger } from 'pino';
import type { Intensity, Sport } from '@triathlon/core';
import type { UserRepo } from './auth/guard';
import type { SettingsRepo } from './settings/store';
import type { DashboardReadRepo, DaySession } from './plan/read-store';
import { parseSteps } from './plan/steps';

/**
 * The web app reads training data and writes only Profile settings. Every repo method takes
 * the session's userId and scopes its query by it.
 *
 * Prisma 7 has no built-in driver, so the client connects through the pg adapter.
 */
export function createPrismaClient(
  connectionString: string,
  logger: Pick<Logger, 'warn' | 'error'>
): PrismaClient {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });
  client.$on('warn', (e) => {
    logger.warn(e, 'Prisma warning');
  });
  client.$on('error', (e) => {
    logger.error(e, 'Prisma error');
  });
  return client;
}

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

function toDaySession(row: PlannedSessionWithActivity): DaySession {
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    sport: row.sport as Sport,
    title: row.title,
    description: row.description,
    durationMin: row.durationMin,
    intensity: row.intensity as Intensity,
    steps: parseSteps(row.steps),
    status: row.status,
    externalChange: row.externalChange,
    deviationPct: row.deviationPct,
    actualIntensity: row.actualIntensity as Intensity | null,
    activity: row.activity,
  };
}

const ACTIVITY_SELECT = {
  name: true,
  startTime: true,
  durationSec: true,
  distanceM: true,
  avgHr: true,
  avgPower: true,
} as const;

type PlannedSessionWithActivity = Prisma.PlannedSessionGetPayload<{
  include: { activity: { select: typeof ACTIVITY_SELECT } };
}>;

/** Read-only queries for Today/Week: findFirst/findMany/findUnique only, all by userId. */
export function createDashboardReadRepo(client: PrismaClient): DashboardReadRepo {
  return {
    async findTimezone(userId) {
      const profile = await client.profile.findUnique({
        where: { userId },
        select: { timezone: true },
      });
      return profile?.timezone ?? null;
    },

    async findSessions(userId, from, to) {
      const rows = await client.plannedSession.findMany({
        where: { userId, date: { gte: from, lte: to }, deletedAt: null },
        include: { activity: { select: ACTIVITY_SELECT } },
        orderBy: [{ date: 'asc' }, { slot: 'asc' }],
      });
      return rows.map(toDaySession);
    },

    async hasActiveSeason(userId) {
      const season = await client.seasonPlan.findFirst({
        where: { userId, status: 'active' },
        select: { id: true },
      });
      return season !== null;
    },

    findWellness(userId, from, to) {
      return client.wellness.findMany({
        where: { userId, date: { gte: from, lte: to } },
        select: {
          date: true,
          hrv: true,
          restingHr: true,
          sleepHours: true,
          tsb: true,
          subjectiveReadiness: true,
          soreness: true,
        },
        orderBy: { date: 'asc' },
      });
    },
  };
}

import { PrismaClient, type PlannedSession, type Prisma } from '@prisma/client';
import { Intensity, Sport } from '@triathlon/core';
import type { PlannedSessionDraft, WorkoutBlock } from '@triathlon/core';
import { logger } from './logger';
import type { IcuConnectionRepo } from './icu-connect';
import type { ActivityRepo } from './activity-sync';
import type { PlannedSessionRecord, PlanStoreRepo } from './plan-store';
import type { PlanPushRepo } from './plan-push';
import type { PlanReconcileRepo } from './plan-reconcile';
import {
  WELLNESS_DEVICE_FIELDS,
  type WellnessDeviceField,
  type WellnessRepo,
} from './wellness-sync';

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

/** Every wellness device field set to null: clears synced data, keeps check-ins. */
const clearedWellnessDeviceFields = Object.fromEntries(
  WELLNESS_DEVICE_FIELDS.map((field) => [field, null])
) as Record<WellnessDeviceField, null>;

export const icuConnectionRepo: IcuConnectionRepo = {
  async upsert(data, { resetSync }) {
    const { userId, ...fields } = data;
    await prisma.$transaction([
      prisma.icuConnection.upsert({
        where: { userId },
        create: data,
        update: resetSync
          ? { ...fields, lastActivitySyncAt: null, lastWellnessSyncAt: null }
          : fields,
      }),
      // Activities of a previously linked athlete don't belong to this link
      prisma.activity.deleteMany({ where: { userId, icuAthleteId: { not: data.icuAthleteId } } }),
      // Neither does their device wellness. The athlete's own check-ins stay
      ...(resetSync
        ? [prisma.wellness.updateMany({ where: { userId }, data: clearedWellnessDeviceFields })]
        : []),
    ]);
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
  icuAthleteId: true,
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
        await tx.activity.update({ where: { userId_icuId: { userId, icuId } }, data });
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

const wellnessDeviceSelect = {
  userId: true,
  date: true,
  ...(Object.fromEntries(WELLNESS_DEVICE_FIELDS.map((field) => [field, true])) as Record<
    WellnessDeviceField,
    true
  >),
};

export const wellnessRepo: WellnessRepo = {
  findConnection(userId) {
    return prisma.icuConnection.findUnique({ where: { userId } });
  },

  async findByDates(userId, dates) {
    if (dates.length === 0) return [];
    const rows = await prisma.wellness.findMany({
      where: { userId, date: { in: dates } },
      select: wellnessDeviceSelect,
    });
    return rows;
  },

  async applySync({ userId, upserts, cursor }) {
    await prisma.$transaction(async (tx) => {
      for (const row of upserts) {
        // Built from the field list so nothing else can reach the subjective check-in columns
        const deviceFields = Object.fromEntries(
          WELLNESS_DEVICE_FIELDS.map((field) => [field, row[field]])
        ) as Record<WellnessDeviceField, number | null>;
        // Upsert, not createMany: a check-in may have created the day since findByDates
        await tx.wellness.upsert({
          where: { userId_date: { userId, date: row.date } },
          create: { userId, date: row.date, ...deviceFields },
          update: deviceFields,
        });
      }
      await tx.icuConnection.update({ where: { userId }, data: { lastWellnessSyncAt: cursor } });
    });
  },
};

function toPlannedSessionRecord(row: PlannedSession): PlannedSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    date: row.date,
    slot: row.slot,
    sport: row.sport as Sport,
    title: row.title,
    description: row.description,
    durationMin: row.durationMin,
    intensity: row.intensity as Intensity,
    steps: row.steps as unknown as WorkoutBlock[],
    status: row.status,
    icuEventId: row.icuEventId,
    pushedHash: row.pushedHash,
    externalChange: row.externalChange,
    deletedAt: row.deletedAt,
    updatedAt: row.updatedAt,
  };
}

function plannedSessionContent(d: PlannedSessionDraft) {
  return {
    sport: d.sport,
    title: d.title,
    description: d.description,
    durationMin: d.durationMin,
    intensity: d.intensity,
    steps: d.steps as unknown as Prisma.InputJsonValue,
  };
}

export const plannedSessionRepo: PlanStoreRepo & PlanPushRepo & PlanReconcileRepo = {
  findConnection(userId) {
    return prisma.icuConnection.findUnique({ where: { userId } });
  },

  async listWindow(userId, from, to) {
    const rows = await prisma.plannedSession.findMany({
      where: { userId, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { slot: 'asc' }],
    });
    return rows.map(toPlannedSessionRecord);
  },

  async applyPlan(userId, { creates, updates, softDeletes, hardDeletes }, now) {
    await prisma.$transaction(async (tx) => {
      if (creates.length > 0) {
        // skipDuplicates: a concurrent /plan may have created the same (date, slot)
        await tx.plannedSession.createMany({
          data: creates.map((d) => ({
            userId,
            date: d.date,
            slot: d.slot,
            ...plannedSessionContent(d),
          })),
          skipDuplicates: true,
        });
      }
      for (const { id, data } of updates) {
        await tx.plannedSession.update({
          where: { id },
          data: { ...plannedSessionContent(data), status: 'draft', deletedAt: null },
        });
      }
      if (softDeletes.length > 0) {
        await tx.plannedSession.updateMany({
          where: { userId, id: { in: softDeletes } },
          data: { deletedAt: now },
        });
      }
      if (hardDeletes.length > 0) {
        await tx.plannedSession.deleteMany({ where: { userId, id: { in: hardDeletes } } });
      }
    });
  },

  async listPending(userId, fromDate) {
    const rows = await prisma.plannedSession.findMany({
      where: {
        userId,
        date: { gte: fromDate },
        OR: [{ deletedAt: { not: null } }, { status: 'draft' }],
      },
      orderBy: [{ date: 'asc' }, { slot: 'asc' }],
    });
    return rows.map(toPlannedSessionRecord);
  },

  async markPushed(row, { icuEventId, pushedHash, pushedAt }) {
    // Only if unchanged since read: a concurrent /plan may have written newer content
    const { count } = await prisma.plannedSession.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { status: 'pushed', icuEventId, pushedHash, pushedAt, externalChange: null },
    });
    if (count === 0) {
      await prisma.plannedSession.updateMany({ where: { id: row.id }, data: { icuEventId } });
    }
  },

  async remove(row) {
    const { count } = await prisma.plannedSession.deleteMany({
      where: { id: row.id, deletedAt: { not: null } },
    });
    if (count === 0) {
      // Revived by a concurrent /plan: its old event is gone, the next push creates a new one
      await prisma.plannedSession.updateMany({
        where: { id: row.id },
        data: { icuEventId: null, pushedHash: null },
      });
    }
  },

  async flagExternal(id, expectedHash, reason) {
    const { count } = await prisma.plannedSession.updateMany({
      where: { id, pushedHash: expectedHash, deletedAt: null },
      data: { status: 'modified_externally', externalChange: reason },
    });
    return count > 0;
  },

  async listPushed(userId, fromDate) {
    const rows = await prisma.plannedSession.findMany({
      where: {
        userId,
        status: 'pushed',
        icuEventId: { not: null },
        deletedAt: null,
        date: { gte: fromDate },
      },
      orderBy: [{ date: 'asc' }, { slot: 'asc' }],
    });
    return rows.map(toPlannedSessionRecord);
  },

  async listModifiedExternally(userId, fromDate) {
    const rows = await prisma.plannedSession.findMany({
      where: { userId, status: 'modified_externally', date: { gte: fromDate } },
      orderBy: [{ date: 'asc' }, { slot: 'asc' }],
    });
    return rows.map(toPlannedSessionRecord);
  },
};

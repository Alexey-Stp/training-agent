import {
  PrismaClient,
  type DailyBriefRun as DailyBriefRunRow,
  type PlannedSession,
  type Prisma,
} from '@prisma/client';
import {
  Intensity,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
} from '@triathlon/core';
import type { PlannedSessionDraft, WorkoutBlock } from '@triathlon/core';
import type {
  ActivitySummary,
  CoachDecision,
  CoachDecisionSink,
  DailyContextDeps,
  LlmCallLogSink,
  PlannedSessionSummary,
  SessionDiff,
  WellnessDay,
} from '@triathlon/ai';
import { logger } from './logger';
import type { IcuConnectionRepo } from './icu-connect';
import type { ActivityRepo } from './activity-sync';
import type { PlannedSessionRecord, PlanStoreRepo } from './plan-store';
import type { PlanPushRepo } from './plan-push';
import type { PlanReconcileRepo } from './plan-reconcile';
import type { RaceRecord, RaceRepo } from './race-command';
import type { ActivateDraftResult, SeasonStoreRepo } from './season-command';
import type { ProfileRepo } from './season-publish';
import { toUserProfile } from './profile';
import type { CoachChatRepo } from './coach-chat-command';
import type { CoachAnswerRepo } from './coach-apply';
import type { CoachPatch } from './coach-plan';
import type { InlineButton } from './reply';
import type { DailyBriefRun, DailyBriefRunRepo, StageTimings } from './daily-loop/run-store';
import type { BriefProfileRepo } from './daily-loop/scheduler';
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
    coachDecisionId: row.coachDecisionId,
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
        OR: [
          // A coach tombstone keeps its row; once its event is gone it needs no push
          {
            deletedAt: { not: null },
            OR: [{ coachDecisionId: null }, { icuEventId: { not: null } }],
          },
          { deletedAt: null, status: 'draft' },
        ],
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
      where: { id: row.id, deletedAt: { not: null }, coachDecisionId: null },
    });
    if (count === 0) {
      // A coach tombstone stays so the plan generator doesn't recreate the session. A row
      // revived by a concurrent /plan: its old event is gone, the next push creates a new one
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

function toRaceRecord(row: Prisma.RaceGetPayload<object>): RaceRecord {
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    priority: row.priority as RacePriority,
    type: row.type as RaceType,
  };
}

export const raceRepo: RaceRepo = {
  async create(userId, race) {
    const row = await prisma.race.create({ data: { userId, ...race } });
    return toRaceRecord(row);
  },

  async listUpcoming(userId, fromDate) {
    const rows = await prisma.race.findMany({
      where: { userId, date: { gte: fromDate } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRaceRecord);
  },
};

export const seasonRepo: SeasonStoreRepo = {
  async findActiveSeason(userId) {
    const row = await prisma.seasonPlan.findFirst({
      where: { userId, status: 'active' },
      orderBy: { updatedAt: 'desc' },
      include: { blocks: { orderBy: { order: 'asc' } }, aRace: true },
    });
    if (!row) return null;
    return {
      startDate: row.startDate,
      status: row.status as SeasonPlanStatus,
      aRace: row.aRace ? toRaceRecord(row.aRace) : null,
      blocks: row.blocks.map((b) => ({
        order: b.order,
        type: b.type as TrainingBlockType,
        startDate: b.startDate,
        weeks: b.weeks,
        focus: b.focus,
        targetWeeklyHours: b.targetWeeklyHours,
        targetSwimM: b.targetSwimM,
        targetBikeH: b.targetBikeH,
        targetRunKm: b.targetRunKm,
        targetCtl: b.targetCtl,
      })),
    };
  },

  replaceDraft(userId, draft) {
    return prisma.$transaction(async (tx) => {
      // Blocks cascade with their plan
      await tx.seasonPlan.deleteMany({ where: { userId, status: 'draft' } });
      const plan = await tx.seasonPlan.create({
        data: {
          userId,
          startDate: draft.startDate,
          aRaceId: draft.aRaceId,
          status: 'draft',
          blocks: { create: draft.blocks.map((b) => ({ ...b })) },
        },
        select: { id: true },
      });
      return plan.id;
    });
  },

  activateDraft(userId, draftId, { replace }) {
    return prisma.$transaction(async (tx): Promise<ActivateDraftResult> => {
      const plan = await tx.seasonPlan.findFirst({
        where: { id: draftId, userId },
        select: { status: true },
      });
      if (plan?.status === 'active') return { status: 'already_active' };
      if (plan?.status !== 'draft') return { status: 'not_found' };

      const active = { userId, status: 'active' as const, id: { not: draftId } };
      const replaced = (await tx.seasonPlan.count({ where: active })) > 0;
      if (replaced && !replace) return { status: 'needs_replace' };

      // Conditional: a concurrent confirm or cancel of the same draft wins, nothing changes here
      const { count } = await tx.seasonPlan.updateMany({
        where: { id: draftId, userId, status: 'draft' },
        data: { status: 'active' },
      });
      if (count === 0) return { status: 'not_found' };
      await tx.seasonPlan.updateMany({ where: active, data: { status: 'archived' } });
      return { status: 'activated', replaced };
    });
  },

  async deleteDraft(userId, draftId) {
    const { count } = await prisma.seasonPlan.deleteMany({
      where: { id: draftId, userId, status: 'draft' },
    });
    return count > 0;
  },
};

export const profileRepo: ProfileRepo = {
  async findProfile(userId) {
    const row = await prisma.profile.findUnique({ where: { userId } });
    return row ? toUserProfile(row) : null;
  },
};

export const llmCallLogRepo: LlmCallLogSink = {
  async write(entry) {
    await prisma.llmCallLog.create({ data: entry });
  },
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface CoachDecisionRepo extends CoachDecisionSink {
  /** The latest `limit` decisions dated on or before `upTo`, as the daily context shows them */
  listRecent(userId: string, upTo: string, limit: number): Promise<CoachDecision[]>;
}

export const coachDecisionRepo: CoachDecisionRepo = {
  async write(record) {
    const { id } = await prisma.coachDecision.create({
      data: {
        ...record,
        rawResponses: toJson(record.rawResponses),
        // undefined leaves the column NULL; Prisma rejects a plain null for Json
        suggestion: record.suggestion === null ? undefined : toJson(record.suggestion),
        reasons: toJson(record.reasons),
        finalChanges: toJson(record.finalChanges),
      },
      select: { id: true },
    });
    return id;
  },

  async listRecent(userId, upTo, limit) {
    const rows = await prisma.coachDecision.findMany({
      where: { userId, date: { lte: upTo } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: { date: true, finalAction: true, summary: true, accepted: true },
    });
    return rows.map((r) => ({
      date: r.date,
      kind: r.finalAction,
      summary: r.summary,
      accepted: r.accepted,
    }));
  },
};

/** Reads of the daily coaching context (packages/ai `buildDailyContext`). */
export const dailyContextDeps: DailyContextDeps = {
  profiles: profileRepo,
  seasons: seasonRepo,
  races: raceRepo,
  decisions: coachDecisionRepo,

  wellness: {
    listRange(userId, from, to): Promise<WellnessDay[]> {
      return prisma.wellness.findMany({
        where: { userId, date: { gte: from, lte: to } },
        orderBy: { date: 'asc' },
        select: {
          date: true,
          hrv: true,
          restingHr: true,
          sleepHours: true,
          sleepScore: true,
          weightKg: true,
          ctl: true,
          atl: true,
          tsb: true,
          subjectiveReadiness: true,
          soreness: true,
        },
      });
    },
  },

  activities: {
    async listRange(userId, from, to): Promise<ActivitySummary[]> {
      const rows = await prisma.activity.findMany({
        where: { userId, startDateLocal: { gte: from, lte: to } },
        orderBy: [{ startDateLocal: 'asc' }, { startTime: 'asc' }],
        select: { startDateLocal: true, sport: true, name: true, durationSec: true, load: true },
      });
      return rows.map((r) => ({ ...r, sport: r.sport as Sport }));
    },
  },

  planned: {
    async listRange(userId, from, to): Promise<PlannedSessionSummary[]> {
      const rows = await prisma.plannedSession.findMany({
        where: { userId, date: { gte: from, lte: to }, deletedAt: null },
        orderBy: [{ date: 'asc' }, { slot: 'asc' }],
        select: {
          date: true,
          slot: true,
          sport: true,
          title: true,
          durationMin: true,
          intensity: true,
          status: true,
          externalChange: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        sport: r.sport as Sport,
        intensity: r.intensity as Intensity,
      }));
    },
  },
};

export const coachChatRepo: CoachChatRepo = {
  async saveMessage(userId, { role, text, telegramMessageId, coachDecisionId }) {
    // A retried job finds its own row: keep the first
    await prisma.coachChatMessage.upsert({
      where: { userId_telegramMessageId_role: { userId, telegramMessageId, role } },
      create: { userId, role, text, telegramMessageId, coachDecisionId },
      update: {},
    });
  },

  async findReply(userId, telegramMessageId) {
    const row = await prisma.coachChatMessage.findUnique({
      where: { userId_telegramMessageId_role: { userId, telegramMessageId, role: 'coach' } },
    });
    return row
      ? { role: row.role, text: row.text, telegramMessageId, coachDecisionId: row.coachDecisionId }
      : null;
  },

  async listRecent(userId, limit, excludeMessageId) {
    const rows = await prisma.coachChatMessage.findMany({
      where: { userId, NOT: { telegramMessageId: excludeMessageId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { role: true, text: true },
    });
    return rows.reverse();
  },
};

type RowPatch = Exclude<CoachPatch, { kind: 'tombstone' }>;
type TombstonePatch = Extract<CoachPatch, { kind: 'tombstone' }>;

/** An update or cancel of an existing row; the row gets `coachDecisionId`. */
function writeRowPatch(
  tx: Prisma.TransactionClient,
  userId: string,
  coachDecisionId: string,
  patch: RowPatch,
  now: Date
) {
  const data =
    patch.kind === 'cancel'
      ? { deletedAt: now, coachDecisionId }
      : {
          date: patch.session.date,
          slot: patch.session.slot,
          ...plannedSessionContent(patch.session),
          status: 'draft' as const,
          deletedAt: null,
          coachDecisionId,
        };
  return tx.plannedSession.update({ where: { id: patch.id, userId }, data });
}

export const coachAnswerRepo: CoachAnswerRepo = {
  async findDecision(userId, decisionId) {
    const row = await prisma.coachDecision.findFirst({
      where: { id: decisionId, userId },
      select: { id: true, finalAction: true, finalChanges: true, accepted: true },
    });
    return row
      ? {
          id: row.id,
          finalAction: row.finalAction,
          finalChanges: row.finalChanges as unknown as SessionDiff[],
          accepted: row.accepted,
        }
      : null;
  },

  async decline(userId, decisionId, now) {
    const { count } = await prisma.coachDecision.updateMany({
      where: { id: decisionId, userId, accepted: null },
      data: { accepted: false, answeredAt: now },
    });
    return count > 0;
  },

  listWindow: (userId, from, to) => plannedSessionRepo.listWindow(userId, from, to),

  applyDecision(userId, decisionId, patches, now) {
    return prisma.$transaction(async (tx) => {
      // Conditional: a double tap or a concurrent Keep wins, nothing changes here
      const { count } = await tx.coachDecision.updateMany({
        where: { id: decisionId, userId, accepted: null },
        data: { accepted: true, answeredAt: now },
      });
      if (count === 0) return false;
      // Rows first: a moved session frees its (date, slot) before its tombstone takes it
      const rows = patches.filter((p): p is RowPatch => p.kind !== 'tombstone');
      const tombstones = patches.filter((p): p is TombstonePatch => p.kind === 'tombstone');
      await Promise.all(rows.map((p) => writeRowPatch(tx, userId, decisionId, p, now)));
      if (tombstones.length > 0) {
        await tx.plannedSession.createMany({
          data: tombstones.map(({ session }) => ({
            userId,
            date: session.date,
            slot: session.slot,
            ...plannedSessionContent(session),
            deletedAt: now,
            coachDecisionId: decisionId,
          })),
        });
      }
      return true;
    });
  },
};

/** Hours of synced intervals.icu activities dated from..to (athlete-local, inclusive). */
export async function loadTrainingHours(userId: string, from: string, to: string): Promise<number> {
  const { _sum } = await prisma.activity.aggregate({
    where: { userId, startDateLocal: { gte: from, lte: to } },
    _sum: { durationSec: true },
  });
  return (_sum.durationSec ?? 0) / 3600;
}

export const briefProfileRepo: BriefProfileRepo = {
  async findBriefProfile(userId) {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, profile: { select: { timezone: true, briefTime: true } } },
    });
    if (!row?.profile) return null;
    return {
      telegramChatId: Number(row.telegramId),
      timezone: row.profile.timezone,
      briefTime: row.profile.briefTime,
    };
  },
};

function toDailyBriefRun(row: DailyBriefRunRow): DailyBriefRun {
  return {
    id: row.id,
    status: row.status,
    coachDecisionId: row.coachDecisionId,
    briefText: row.briefText,
    briefKeyboard: row.briefKeyboard as InlineButton[][] | null,
    stale: row.stale,
    dataAsOf: row.dataAsOf,
    stageTimings: row.stageTimings as StageTimings,
  };
}

export const dailyBriefRunRepo: DailyBriefRunRepo = {
  async claim(userId, date, now, leaseMs) {
    // skipDuplicates: the (userId, date) row may exist from an earlier trigger or attempt
    await prisma.dailyBriefRun.createMany({ data: [{ userId, date }], skipDuplicates: true });
    // One conditional update takes the run over, so two concurrent triggers can't both win
    const { count } = await prisma.dailyBriefRun.updateMany({
      where: {
        userId,
        date,
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'running', startedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { status: 'running', startedAt: now, error: null },
    });
    const row = await prisma.dailyBriefRun.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
    });
    if (count > 0) return { status: 'claimed', run: toDailyBriefRun(row) };
    return { status: row.status === 'sent' ? 'already_sent' : 'in_progress' };
  },

  async saveBrief(id, brief) {
    await prisma.dailyBriefRun.update({
      where: { id },
      data: {
        ...brief,
        // undefined leaves the column NULL; Prisma rejects a plain null for Json
        briefKeyboard: brief.briefKeyboard === null ? undefined : toJson(brief.briefKeyboard),
        stageTimings: toJson(brief.stageTimings),
      },
    });
  },

  async markSent(id, sentAt, stageTimings) {
    await prisma.dailyBriefRun.update({
      where: { id },
      data: { status: 'sent', sentAt, error: null, stageTimings: toJson(stageTimings) },
    });
  },

  async markFailed(id, error, stageTimings) {
    await prisma.dailyBriefRun.update({
      where: { id },
      data: { status: 'failed', error, stageTimings: toJson(stageTimings) },
    });
  },
};

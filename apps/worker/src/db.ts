import {
  PrismaClient,
  type BlockReviewRun as BlockReviewRunRow,
  type DailyBriefRun as DailyBriefRunRow,
  type EveningCloseoutRun as EveningCloseoutRunRow,
  type PlannedSession,
  Prisma,
  type WeeklyReviewRun as WeeklyReviewRunRow,
} from '@prisma/client';
import {
  Intensity,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
} from '@triathlon/core';
import type {
  PlannedSessionDraft,
  TrainingBlock,
  WeeklyStats,
  WorkoutBlock,
} from '@triathlon/core';
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
import type { CoachPatch, RollbackPatch } from './coach-plan';
import type { InlineButton } from './reply';
import type {
  DailyBriefRun,
  DailyBriefRunRepo,
  DailyBriefStatus,
  StageTimings,
} from './daily-loop/run-store';
import type { BriefProfileRepo } from './daily-loop/scheduler';
import type {
  CloseoutRepo,
  EveningCloseoutRun,
  EveningCloseoutRunRepo,
} from './daily-loop/closeout-store';
import type { CheckInRepo } from './daily-loop/checkin';
import type { WeeklyStatsRepo } from './reviews/weekly-stats-store';
import type { WeeklyReviewRun, WeeklyReviewRunRepo } from './reviews/weekly-review-store';
import type {
  BlockReviewRun,
  BlockReviewRunRepo,
  ProposedSeason,
  SeasonReprojectRepo,
  WeeklyStatsReader,
} from './reviews/block-review-store';
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

const CHECKIN_COLUMNS = { r: 'subjectiveReadiness', s: 'soreness' } as const;

export const checkInRepo: CheckInRepo = {
  async recordCheckIn(userId, date, field, value) {
    const column = CHECKIN_COLUMNS[field];
    // The day may have no Wellness row yet (that is why the check-in was asked)
    await prisma.wellness.createMany({ data: [{ userId, date }], skipDuplicates: true });
    // First answer wins: a double tap or a second button never overwrites it
    await prisma.wellness.updateMany({
      where: { userId, date, [column]: null },
      data: { [column]: value },
    });
    return prisma.wellness.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
      select: { subjectiveReadiness: true, soreness: true },
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

  async findByDate(userId, date) {
    const rows = await prisma.race.findMany({
      where: { userId, date },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRaceRecord);
  },

  async moveDate(userId, raceId, date) {
    const { count } = await prisma.race.updateMany({
      where: { id: raceId, userId },
      data: { date },
    });
    return count > 0;
  },
};

function toTrainingBlock(b: Prisma.TrainingBlockGetPayload<object>): TrainingBlock {
  return {
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
  };
}

function activeSeasonQuery(userId: string) {
  return {
    where: { userId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
    include: { blocks: { orderBy: { order: 'asc' } }, aRace: true },
  } satisfies Prisma.SeasonPlanFindFirstArgs;
}

export const seasonRepo: SeasonStoreRepo = {
  async findActiveSeason(userId) {
    const row = await prisma.seasonPlan.findFirst(activeSeasonQuery(userId));
    if (!row) return null;
    return {
      startDate: row.startDate,
      status: row.status as SeasonPlanStatus,
      aRace: row.aRace ? toRaceRecord(row.aRace) : null,
      blocks: row.blocks.map(toTrainingBlock),
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
          weeklyHoursAvailable: draft.weeklyHoursAvailable,
          weakSport: draft.weakSport,
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
      select: {
        id: true,
        origin: true,
        date: true,
        finalAction: true,
        finalChanges: true,
        athleteMessage: true,
        accepted: true,
        createdAt: true,
      },
    });
    return row
      ? {
          id: row.id,
          origin: row.origin,
          date: row.date,
          finalAction: row.finalAction,
          finalChanges: row.finalChanges as unknown as SessionDiff[],
          athleteMessage: row.athleteMessage,
          accepted: row.accepted,
          createdAt: row.createdAt,
        }
      : null;
  },

  async decline(userId, decisionId, userAction, now) {
    const { count } = await prisma.coachDecision.updateMany({
      where: { id: decisionId, userId, accepted: null },
      data: { accepted: false, answeredAt: now, userAction },
    });
    return count > 0;
  },

  listWindow: (userId, from, to) => plannedSessionRepo.listWindow(userId, from, to),

  applyDecision(userId, decisionId, patches, now) {
    return prisma.$transaction(async (tx) => {
      // Conditional: a double tap or a concurrent Keep wins, nothing changes here
      const { count } = await tx.coachDecision.updateMany({
        where: { id: decisionId, userId, accepted: null },
        data: { accepted: true, answeredAt: now, userAction: 'apply' },
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

  revertDecision(userId, decisionId, patches) {
    return prisma.$transaction(async (tx) => {
      // Deletes first: a moved session goes back to the (date, slot) its tombstone holds
      const deletes = patches.flatMap((p) => (p.kind === 'delete' ? [p.id] : []));
      if (deletes.length > 0) {
        await tx.plannedSession.deleteMany({ where: { userId, id: { in: deletes } } });
      }
      await Promise.all(patches.map((p) => writeRollbackPatch(tx, userId, p)));
      await tx.coachDecision.updateMany({
        where: { id: decisionId, userId },
        data: { accepted: null, answeredAt: null, userAction: null },
      });
    });
  },

  async markDiscussed(userId, decisionId) {
    await prisma.coachDecision.updateMany({
      where: { id: decisionId, userId, accepted: null },
      data: { userAction: 'discuss' },
    });
  },

  async findAnswerText(userId, { id, origin }) {
    if (origin === 'block') {
      const review = await prisma.blockReviewRun.findFirst({
        where: { userId, coachDecisionId: id },
        select: { reportText: true },
      });
      return review?.reportText ?? null;
    }
    if (origin === 'weekly') {
      const review = await prisma.weeklyReviewRun.findFirst({
        where: { userId, coachDecisionId: id },
        select: { reportText: true },
      });
      return review?.reportText ?? null;
    }
    const run = await prisma.dailyBriefRun.findFirst({
      where: { userId, coachDecisionId: id },
      select: { briefText: true },
    });
    return run?.briefText ?? null;
  },
};

/** A restore or recreate of a rolled-back row; deletes are done before. */
function writeRollbackPatch(tx: Prisma.TransactionClient, userId: string, patch: RollbackPatch) {
  if (patch.kind === 'delete') return Promise.resolve();
  const { row } = patch;
  const data = {
    date: row.date,
    slot: row.slot,
    ...plannedSessionContent(row),
    status: row.status,
    icuEventId: row.icuEventId,
    pushedHash: row.pushedHash,
    externalChange: row.externalChange,
    deletedAt: row.deletedAt,
    coachDecisionId: row.coachDecisionId,
  };
  if (patch.kind === 'recreate') {
    return tx.plannedSession.create({ data: { id: row.id, userId, ...data } });
  }
  return tx.plannedSession.update({ where: { id: row.id, userId }, data });
}

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
      select: {
        telegramId: true,
        profile: { select: { timezone: true, briefTime: true, closeoutTime: true } },
      },
    });
    if (!row?.profile) return null;
    return {
      telegramChatId: Number(row.telegramId),
      timezone: row.profile.timezone,
      briefTime: row.profile.briefTime,
      closeoutTime: row.profile.closeoutTime,
    };
  },
};

function claimRefusal(
  status: DailyBriefStatus
): 'already_sent' | 'in_progress' | 'awaiting_checkin' {
  if (status === 'sent') return 'already_sent';
  return status === 'awaiting_checkin' ? 'awaiting_checkin' : 'in_progress';
}

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
    checkInSentAt: row.checkInSentAt,
  };
}

export const dailyBriefRunRepo: DailyBriefRunRepo = {
  async claim(userId, date, now, leaseMs, opts = {}) {
    // skipDuplicates: the (userId, date) row may exist from an earlier trigger or attempt
    await prisma.dailyBriefRun.createMany({ data: [{ userId, date }], skipDuplicates: true });
    const claimable: DailyBriefStatus[] = opts.continuation
      ? ['pending', 'failed', 'awaiting_checkin']
      : ['pending', 'failed'];
    // One conditional update takes the run over, so two concurrent triggers can't both win
    const { count } = await prisma.dailyBriefRun.updateMany({
      where: {
        userId,
        date,
        OR: [
          { status: { in: claimable } },
          { status: 'running', startedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { status: 'running', startedAt: now, error: null },
    });
    const row = await prisma.dailyBriefRun.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
    });
    if (count > 0) return { status: 'claimed', run: toDailyBriefRun(row) };
    return { status: claimRefusal(row.status) };
  },

  async saveCheckIn(id, checkIn) {
    await prisma.dailyBriefRun.update({
      where: { id },
      data: {
        status: 'awaiting_checkin',
        checkInMessageId: checkIn.messageId,
        checkInSentAt: checkIn.sentAt,
        stale: checkIn.stale,
        dataAsOf: checkIn.dataAsOf,
        stageTimings: toJson(checkIn.stageTimings),
      },
    });
  },

  findByCheckInMessage(userId, messageId) {
    return prisma.dailyBriefRun.findFirst({
      where: { userId, checkInMessageId: messageId },
      select: { id: true, date: true, status: true },
    });
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

function toEveningCloseoutRun(row: EveningCloseoutRunRow): EveningCloseoutRun {
  return {
    id: row.id,
    status: row.status,
    messageText: row.messageText,
    stageTimings: row.stageTimings as StageTimings,
  };
}

export const eveningCloseoutRunRepo: EveningCloseoutRunRepo = {
  async claim(userId, date, now, leaseMs) {
    // skipDuplicates: the (userId, date) row may exist from an earlier trigger or attempt
    await prisma.eveningCloseoutRun.createMany({ data: [{ userId, date }], skipDuplicates: true });
    // One conditional update takes the run over, so two concurrent triggers can't both win
    const { count } = await prisma.eveningCloseoutRun.updateMany({
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
    const row = await prisma.eveningCloseoutRun.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
    });
    if (count > 0) return { status: 'claimed', run: toEveningCloseoutRun(row) };
    return { status: row.status === 'running' ? 'in_progress' : 'already_done' };
  },

  async saveMessage(id, messageText, stageTimings) {
    await prisma.eveningCloseoutRun.update({
      where: { id },
      data: { messageText, stageTimings: toJson(stageTimings) },
    });
  },

  async markQuiet(id, stageTimings) {
    await prisma.eveningCloseoutRun.update({
      where: { id },
      data: { status: 'quiet', error: null, stageTimings: toJson(stageTimings) },
    });
  },

  async markSent(id, sentAt, stageTimings) {
    await prisma.eveningCloseoutRun.update({
      where: { id },
      data: { status: 'sent', sentAt, error: null, stageTimings: toJson(stageTimings) },
    });
  },

  async markFailed(id, error, stageTimings) {
    await prisma.eveningCloseoutRun.update({
      where: { id },
      data: { status: 'failed', error, stageTimings: toJson(stageTimings) },
    });
  },
};

export const closeoutRepo: CloseoutRepo = {
  async listDay(userId, date) {
    const [sessions, activities, profile] = await Promise.all([
      prisma.plannedSession.findMany({
        where: { userId, date },
        select: {
          id: true,
          slot: true,
          sport: true,
          title: true,
          durationMin: true,
          intensity: true,
          status: true,
          deletedAt: true,
        },
        orderBy: { slot: 'asc' },
      }),
      prisma.activity.findMany({
        where: { userId, startDateLocal: date },
        select: {
          id: true,
          icuId: true,
          sport: true,
          name: true,
          startTime: true,
          durationSec: true,
          avgHr: true,
          avgPower: true,
        },
        orderBy: { startTime: 'asc' },
      }),
      prisma.profile.findUnique({ where: { userId }, select: { ftp: true, lthr: true } }),
    ]);
    return {
      sessions: sessions.map(({ deletedAt, ...row }) => ({
        ...row,
        sport: row.sport as Sport,
        intensity: row.intensity as Intensity,
        deleted: deletedAt !== null,
      })),
      activities: activities.map((row) => ({ ...row, sport: row.sport as Sport })),
      thresholds: { ftp: profile?.ftp ?? null, lthr: profile?.lthr ?? null },
    };
  },

  async apply(userId, date, write) {
    const sessionIds = write.sessions.map((s) => s.sessionId);
    const activityIds = write.links.map((l) => l.activityId);
    // Array form: one transaction. Links are cleared before they are set, so a session that
    // moves to another activity doesn't trip the unique plannedSessionId
    await prisma.$transaction([
      prisma.activity.updateMany({
        where: { userId, plannedSessionId: { in: sessionIds }, id: { notIn: activityIds } },
        data: { plannedSessionId: null },
      }),
      prisma.activity.updateMany({
        where: { userId, startDateLocal: date, id: { in: activityIds } },
        data: { plannedSessionId: null, closedOutAt: write.closedOutAt },
      }),
      ...write.sessions.map((s) =>
        prisma.plannedSession.updateMany({
          where: { id: s.sessionId, userId, date, deletedAt: null },
          data: {
            status: s.status,
            deviationPct: s.deviationPct,
            actualIntensity: s.actualIntensity,
          },
        })
      ),
      ...write.links
        .filter((l) => l.sessionId !== null)
        .map((l) =>
          prisma.activity.updateMany({
            where: { id: l.activityId, userId, startDateLocal: date },
            data: { plannedSessionId: l.sessionId },
          })
        ),
    ]);
  },
};

export const weeklyStatsRepo: WeeklyStatsRepo & WeeklyStatsReader = {
  async listRange(userId, range) {
    const rows = await prisma.weeklyStats.findMany({
      where: { userId, weekStart: { gte: range.from, lte: range.to } },
      select: { stats: true },
    });
    return rows.map((r) => r.stats as unknown as WeeklyStats);
  },

  async loadRange(userId, { from, to }) {
    const [sessions, activities, wellness, profile] = await Promise.all([
      prisma.plannedSession.findMany({
        where: { userId, date: { gte: from, lte: to } },
        select: {
          date: true,
          slot: true,
          sport: true,
          title: true,
          durationMin: true,
          intensity: true,
          status: true,
          deletedAt: true,
        },
      }),
      prisma.activity.findMany({
        where: { userId, startDateLocal: { gte: from, lte: to } },
        select: {
          startDateLocal: true,
          sport: true,
          durationSec: true,
          distanceM: true,
          load: true,
          avgHr: true,
        },
      }),
      prisma.wellness.findMany({
        where: { userId, date: { gte: from, lte: to } },
        select: {
          date: true,
          hrv: true,
          restingHr: true,
          sleepHours: true,
          ctl: true,
          atl: true,
          tsb: true,
          subjectiveReadiness: true,
          soreness: true,
        },
      }),
      prisma.profile.findUnique({ where: { userId }, select: { lthr: true } }),
    ]);
    return {
      sessions: sessions.map(({ deletedAt, ...row }) => ({
        ...row,
        sport: row.sport as Sport,
        intensity: row.intensity as Intensity,
        deleted: deletedAt !== null,
      })),
      activities: activities.map((row) => ({ ...row, sport: row.sport as Sport })),
      wellness,
      lthr: profile?.lthr ?? null,
    };
  },

  async upsert(userId, stats, computedAt) {
    const data = {
      weekStart: stats.from,
      weekEnd: stats.to,
      unplannedWeek: stats.unplannedWeek,
      stats: toJson(stats),
      computedAt,
    };
    await prisma.weeklyStats.upsert({
      where: { userId_isoWeek: { userId, isoWeek: stats.isoWeek } },
      create: { userId, isoWeek: stats.isoWeek, ...data },
      update: data,
    });
  },
};

/** The run columns shared by `WeeklyReviewRun` and `BlockReviewRun` rows */
type ReviewRunRow = Pick<
  WeeklyReviewRunRow,
  'id' | 'status' | 'coachDecisionId' | 'reportText' | 'reportKeyboard' | 'stageTimings'
>;

function toWeeklyReviewRun(row: ReviewRunRow): WeeklyReviewRun {
  return {
    id: row.id,
    status: row.status,
    coachDecisionId: row.coachDecisionId,
    reportText: row.reportText,
    reportKeyboard: row.reportKeyboard as InlineButton[][] | null,
    stageTimings: row.stageTimings as StageTimings,
  };
}

export const weeklyReviewRunRepo: WeeklyReviewRunRepo = {
  async claim(userId, isoWeek, now, leaseMs) {
    // skipDuplicates: the (userId, isoWeek) row may exist from an earlier trigger or attempt
    await prisma.weeklyReviewRun.createMany({ data: [{ userId, isoWeek }], skipDuplicates: true });
    // One conditional update takes the run over, so two concurrent triggers can't both win
    const { count } = await prisma.weeklyReviewRun.updateMany({
      where: {
        userId,
        isoWeek,
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'running', startedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { status: 'running', startedAt: now, error: null },
    });
    const row = await prisma.weeklyReviewRun.findUniqueOrThrow({
      where: { userId_isoWeek: { userId, isoWeek } },
    });
    if (count > 0) return { status: 'claimed', run: toWeeklyReviewRun(row) };
    return { status: row.status === 'running' ? 'in_progress' : 'already_sent' };
  },

  async saveReport(id, report) {
    await prisma.weeklyReviewRun.update({
      where: { id },
      data: {
        coachDecisionId: report.coachDecisionId,
        reportText: report.reportText,
        reportKeyboard: toJson(report.reportKeyboard),
        stale: report.stale,
        stageTimings: toJson(report.stageTimings),
      },
    });
  },

  async markSent(id, sentAt, stageTimings) {
    await prisma.weeklyReviewRun.update({
      where: { id },
      data: { status: 'sent', sentAt, error: null, stageTimings: toJson(stageTimings) },
    });
  },

  async markFailed(id, error, stageTimings) {
    await prisma.weeklyReviewRun.update({
      where: { id },
      data: { status: 'failed', error, stageTimings: toJson(stageTimings) },
    });
  },
};

/** A block review run has the weekly review's run columns (and the same status values). */
function toBlockReviewRun(row: BlockReviewRunRow): BlockReviewRun {
  return toWeeklyReviewRun(row);
}

export const blockReviewRunRepo: BlockReviewRunRepo = {
  async claim({ userId, seasonPlanId, key, trigger }, now, leaseMs) {
    // skipDuplicates: the row may exist from an earlier trigger or attempt
    await prisma.blockReviewRun.createMany({
      data: [{ userId, seasonPlanId, key, trigger }],
      skipDuplicates: true,
    });
    // One conditional update takes the run over, so two concurrent triggers can't both win
    const { count } = await prisma.blockReviewRun.updateMany({
      where: {
        userId,
        seasonPlanId,
        key,
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'running', startedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { status: 'running', startedAt: now, error: null },
    });
    const row = await prisma.blockReviewRun.findUniqueOrThrow({
      where: { userId_seasonPlanId_key: { userId, seasonPlanId, key } },
    });
    if (count > 0) return { status: 'claimed', run: toBlockReviewRun(row) };
    return { status: row.status === 'running' ? 'in_progress' : 'already_sent' };
  },

  async saveReport(id, report) {
    await prisma.blockReviewRun.update({
      where: { id },
      data: {
        coachDecisionId: report.coachDecisionId,
        verdict: toJson(report.verdict),
        proposedBlocks: report.proposal === null ? Prisma.DbNull : toJson(report.proposal),
        freezeThrough: report.freezeThrough,
        seasonUpdatedAt: report.seasonUpdatedAt,
        reportText: report.reportText,
        reportKeyboard: toJson(report.reportKeyboard),
        stale: report.stale,
        stageTimings: toJson(report.stageTimings),
      },
    });
  },

  async markSent(id, sentAt, stageTimings) {
    await prisma.blockReviewRun.update({
      where: { id },
      data: { status: 'sent', sentAt, error: null, stageTimings: toJson(stageTimings) },
    });
  },

  async markFailed(id, error, stageTimings) {
    await prisma.blockReviewRun.update({
      where: { id },
      data: { status: 'failed', error, stageTimings: toJson(stageTimings) },
    });
  },

  async findAnswerable(userId, runId) {
    const row = await prisma.blockReviewRun.findFirst({
      where: { id: runId, userId },
      select: {
        id: true,
        seasonPlanId: true,
        coachDecisionId: true,
        proposedBlocks: true,
        seasonUpdatedAt: true,
        reportText: true,
      },
    });
    if (!row) return null;
    const { proposedBlocks, ...rest } = row;
    return { ...rest, proposal: proposedBlocks as unknown as ProposedSeason | null };
  },
};

/** Thrown inside the re-projection transaction to roll back the decision update. */
class StaleSeasonError extends Error {}

export const seasonReprojectRepo: SeasonReprojectRepo = {
  async findActiveRecord(userId) {
    const row = await prisma.seasonPlan.findFirst(activeSeasonQuery(userId));
    if (!row) return null;
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      weeklyHoursAvailable: row.weeklyHoursAvailable,
      weakSport: row.weakSport as Sport | null,
      season: {
        startDate: row.startDate,
        status: row.status as SeasonPlanStatus,
        aRace: row.aRace ? toRaceRecord(row.aRace) : null,
        blocks: row.blocks.map(toTrainingBlock),
      },
    };
  },

  async applyReprojection(userId, { seasonPlanId, expectedUpdatedAt, decisionId, proposal, now }) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Conditional: a double tap or a concurrent Decline wins, nothing changes here
        const decided = await tx.coachDecision.updateMany({
          where: { id: decisionId, userId, accepted: null },
          data: { accepted: true, answeredAt: now, userAction: 'apply' },
        });
        if (decided.count === 0) return 'answered' as const;
        // Optimistic lock: the proposal only applies to the season version it was computed from,
        // and to the A-race date it was planned for (moving a race doesn't touch the season row)
        const season = await tx.seasonPlan.updateMany({
          where: {
            id: seasonPlanId,
            userId,
            status: 'active',
            updatedAt: expectedUpdatedAt,
            aRace: { is: { date: proposal.raceDate } },
          },
          data: { startDate: proposal.startDate },
        });
        if (season.count === 0) throw new StaleSeasonError('season changed');

        const { frozenCount, truncated, blocks } = proposal;
        await tx.trainingBlock.deleteMany({ where: { seasonPlanId, order: { gt: frozenCount } } });
        if (truncated) {
          await tx.trainingBlock.updateMany({
            where: { seasonPlanId, order: truncated.order },
            data: { weeks: truncated.weeks },
          });
        }
        await tx.trainingBlock.createMany({
          data: blocks.slice(frozenCount).map((b) => ({ seasonPlanId, ...b })),
        });
        return 'applied' as const;
      });
    } catch (error) {
      if (error instanceof StaleSeasonError) return 'stale';
      throw error;
    }
  },
};

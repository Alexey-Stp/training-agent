import {
  isoWeekKey,
  isoWeekRange,
  localToday,
  nextIsoWeek,
  type RulesContext,
  type SeasonPlan,
} from '@triathlon/core';
import {
  runWeeklyReview,
  seasonPosition,
  type CoachDecisionSink,
  type LlmProvider,
  type WeeklyGuardrailConfig,
} from '@triathlon/ai';
import { toCoachPlanSession } from '../coach-plan';
import { errorText, sendOrFail, timedStage, type RunLogger } from '../daily-loop/run-helpers';
import type { StageTimings } from '../daily-loop/run-store';
import type { BriefProfileRepo } from '../daily-loop/scheduler';
import type { PlannedSessionRecord } from '../plan-store';
import { toTelegramMessage, type RichReply, type TelegramMessageOptions } from '../reply';
import { renderWeeklyReport } from './weekly-review-render';
import type { WeeklyReviewRun, WeeklyReviewRunRepo } from './weekly-review-store';
import { runWeeklyStats } from './weekly-stats';
import type { WeeklyStatsRepo } from './weekly-stats-store';

/** How long a running review holds the week's run before a retry may take it over */
export const WEEKLY_REVIEW_LEASE_MS = 5 * 60_000;

export type WeeklyReviewStage = 'activity' | 'stats' | 'coach' | 'send';

export interface WeeklyReviewDeps {
  runs: WeeklyReviewRunRepo;
  profiles: BriefProfileRepo;
  stats: WeeklyStatsRepo;
  seasons: { findActiveSeason(userId: string): Promise<SeasonPlan | null> };
  /** Next week's PlannedSession rows (the rolling publisher materialises them) */
  planned: {
    listWindow(userId: string, from: string, to: string): Promise<PlannedSessionRecord[]>;
  };
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: WeeklyGuardrailConfig;
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  logger: RunLogger;
  now(): Date;
}

export type WeeklyReviewResult =
  | { status: 'skipped'; reason: 'no_profile' | 'already_sent' }
  | {
      status: 'sent';
      isoWeek: string;
      /** A retry that only resent the report stored by an earlier attempt */
      resumed: boolean;
      decisionId: string | null;
      stale: boolean;
      timings: StageTimings;
    };

/** Another attempt holds the week's run; thrown so the job retries after the lease. */
export class WeeklyReviewInProgressError extends Error {
  constructor(userId: string, isoWeek: string) {
    super('Weekly review already running for ' + userId + ' in ' + isoWeek);
    this.name = 'WeeklyReviewInProgressError';
  }
}

interface RunCtx {
  userId: string;
  /** Review day, athlete-local */
  date: string;
  isoWeek: string;
  deps: WeeklyReviewDeps;
  timings: StageTimings;
}

function stage<T>(ctx: RunCtx, name: WeeklyReviewStage, fn: () => Promise<T>): Promise<T> {
  return timedStage({ ...ctx, logger: ctx.deps.logger }, 'weekly review stage', name, fn);
}

async function send(ctx: RunCtx, chatId: number, reply: RichReply): Promise<void> {
  const message = toTelegramMessage(reply);
  await stage(ctx, 'send', () =>
    sendOrFail(() => ctx.deps.sendMessage(chatId, message.text, message.options))
  );
}

/** A failed sync only makes the report stale: the stats use what was synced before. */
async function syncOrStale(ctx: RunCtx): Promise<boolean> {
  try {
    await stage(ctx, 'activity', () => ctx.deps.syncActivities(ctx.userId));
    return false;
  } catch (error) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, isoWeek: ctx.isoWeek, error: errorText(error) },
      'weekly review: activity sync failed, report is stale'
    );
    return true;
  }
}

interface Prepared {
  report: RichReply;
  decisionId: string;
  stale: boolean;
}

async function prepare(ctx: RunCtx): Promise<Prepared> {
  const { deps, userId, date, isoWeek } = ctx;
  const stale = await syncOrStale(ctx);
  // The current week, recomputed now; Monday's weekly-stats run replaces it with final numbers
  const saved = await stage(ctx, 'stats', () =>
    runWeeklyStats(
      userId,
      { profiles: deps.profiles, repo: deps.stats, logger: deps.logger, now: () => deps.now() },
      isoWeek
    )
  );
  if (saved.status !== 'saved') throw new Error('Weekly review: profile vanished for ' + userId);
  const { stats } = saved;

  const nextWeek = isoWeekRange(nextIsoWeek(date));
  const [season, rows, context] = await Promise.all([
    deps.seasons.findActiveSeason(userId),
    deps.planned.listWindow(userId, nextWeek.from, nextWeek.to),
    deps.getRulesContext(userId, nextWeek.from),
  ]);
  const sessions = rows.filter((r) => r.deletedAt === null).map(toCoachPlanSession);
  const position = seasonPosition(season, date);

  const result = await stage(ctx, 'coach', () =>
    runWeeklyReview(
      { provider: deps.provider, decisions: deps.decisions, guardrailConfig: deps.guardrailConfig },
      {
        userId,
        date,
        stats,
        season: position,
        nextSeason: seasonPosition(season, nextWeek.from),
        nextWeek,
        sessions,
        context,
      }
    )
  );
  const report = renderWeeklyReport({
    stats,
    season: position,
    review: result.review,
    finalChanges: result.record.finalChanges,
    sessions,
    decisionId: result.decisionId,
    stale,
  });
  return { report, decisionId: result.decisionId, stale };
}

async function runClaimed(
  ctx: RunCtx,
  run: WeeklyReviewRun,
  chatId: number
): Promise<WeeklyReviewResult> {
  const { deps, isoWeek } = ctx;
  const allTimings = () => ({ ...run.stageTimings, ...ctx.timings });

  if (run.reportText !== null) {
    // A retry after a failed send: same report and buttons, no second CoachDecision
    const stored: RichReply = {
      text: run.reportText,
      html: true,
      keyboard: run.reportKeyboard ?? [],
    };
    await send(ctx, chatId, stored);
    await deps.runs.markSent(run.id, deps.now(), allTimings());
    return {
      status: 'sent',
      isoWeek,
      resumed: true,
      decisionId: run.coachDecisionId,
      stale: false,
      timings: ctx.timings,
    };
  }

  const { report, decisionId, stale } = await prepare(ctx);
  await deps.runs.saveReport(run.id, {
    coachDecisionId: decisionId,
    reportText: report.text,
    reportKeyboard: report.keyboard ?? [],
    stale,
    stageTimings: allTimings(),
  });
  await send(ctx, chatId, report);
  await deps.runs.markSent(run.id, deps.now(), allTimings());
  return { status: 'sent', isoWeek, resumed: false, decisionId, stale, timings: ctx.timings };
}

/**
 * The Sunday weekly review of one athlete: activity sync (a failure only makes the report
 * stale) → this week's stats → AI review with next-week changes behind the weekly guardrails
 * (one CoachDecision, `origin: 'weekly'`) → a report of at most 15 lines with Apply next week.
 *
 * Runs at most once per athlete and ISO week: the `WeeklyReviewRun` row (userId, isoWeek) is
 * claimed first, and a sent review is never redone. The report is stored before the send, so
 * a retry after a failed send resends it without a second LLM call or decision.
 */
export async function runWeeklyReviewJob(
  userId: string,
  deps: WeeklyReviewDeps
): Promise<WeeklyReviewResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const now = deps.now();
  const date = localToday(now, profile.timezone);
  const isoWeek = isoWeekKey(date);
  const claim = await deps.runs.claim(userId, isoWeek, now, WEEKLY_REVIEW_LEASE_MS);
  if (claim.status === 'already_sent') return { status: 'skipped', reason: 'already_sent' };
  if (claim.status === 'in_progress') throw new WeeklyReviewInProgressError(userId, isoWeek);

  const ctx: RunCtx = { userId, date, isoWeek, deps, timings: {} };
  try {
    const result = await runClaimed(ctx, claim.run, profile.telegramChatId);
    deps.logger.info({ userId, ...result }, 'weekly review finished');
    return result;
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn({ userId, isoWeek, error: e }, 'weekly review: could not mark failed');
    });
    deps.logger.info(
      { userId, isoWeek, status: 'failed', timings: ctx.timings },
      'weekly review finished'
    );
    throw error;
  }
}

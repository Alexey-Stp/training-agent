import {
  addDaysIso,
  blockEndDate,
  blockIsoWeeks,
  blockWeekAt,
  computeBlockVerdict,
  isoWeekKey,
  isoWeekRange,
  localToday,
  reprojectionSeed,
  reprojectSeason,
  SeasonGenerationError,
  TrainingBlockType,
  type BlockVerdict,
  type ReprojectedSeason,
  type TrainingBlock,
} from '@triathlon/core';
import {
  runBlockReview,
  type BlockReviewConfig,
  type CoachDecisionSink,
  type LlmProvider,
} from '@triathlon/ai';
import { errorText, sendOrFail, timedStage, type RunLogger } from '../daily-loop/run-helpers';
import type { StageTimings } from '../daily-loop/run-store';
import type { BriefProfileRepo } from '../daily-loop/scheduler';
import { toTelegramMessage, type RichReply, type TelegramMessageOptions } from '../reply';
import { renderBlockReport } from './block-review-render';
import type {
  ActiveSeasonRecord,
  BlockReviewRun,
  BlockReviewRunRepo,
  BlockReviewTrigger,
  ProposedSeason,
  SeasonReprojectRepo,
  WeeklyStatsReader,
} from './block-review-store';
import { runWeeklyStats } from './weekly-stats';
import type { WeeklyStatsRepo } from './weekly-stats-store';

/** How long a running review holds its run before a retry may take it over */
export const BLOCK_REVIEW_LEASE_MS = 5 * 60_000;

/** Weeks of actual training that seed a race-move re-projection (no block has ended) */
const RACE_MOVE_LOAD_WEEKS = 4;

/** Blocks whose end leaves nothing to re-project but race week */
const NO_REVIEW_TYPES: ReadonlySet<TrainingBlockType> = new Set([
  TrainingBlockType.taper,
  TrainingBlockType.race,
]);

export type BlockReviewStage = 'activity' | 'stats' | 'coach' | 'send';

/** One job of the block-review queue. */
export interface BlockReviewJob {
  userId: string;
  /** Absent on the Sunday scheduler: a block end */
  trigger?: BlockReviewTrigger;
  /** race_move: the moved race and its dates */
  raceId?: string;
  previousDate?: string;
  newDate?: string;
}

export interface BlockReviewDeps {
  runs: BlockReviewRunRepo;
  profiles: BriefProfileRepo;
  stats: WeeklyStatsRepo & WeeklyStatsReader;
  seasons: SeasonReprojectRepo;
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  /** Actual training hours of a date range (season-command's current load) */
  loadTrainingHours(userId: string, from: string, to: string): Promise<number>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  config?: BlockReviewConfig;
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  logger: RunLogger;
  now(): Date;
}

export type BlockReviewSkip =
  | 'no_profile'
  | 'no_season'
  | 'not_block_end'
  | 'no_remaining_blocks'
  | 'race_changed'
  | 'already_sent';

export type BlockReviewResult =
  | { status: 'skipped'; reason: BlockReviewSkip }
  | {
      status: 'sent';
      key: string;
      /** A retry that only resent the report stored by an earlier attempt */
      resumed: boolean;
      decisionId: string | null;
      reproject: boolean;
      timings: StageTimings;
    };

/** Another attempt holds the run; thrown so the job retries after the lease. */
export class BlockReviewInProgressError extends Error {
  constructor(userId: string, key: string) {
    super('Block review already running for ' + userId + ' (' + key + ')');
    this.name = 'BlockReviewInProgressError';
  }
}

/** What is reviewed: the block, up to which day the season is frozen, and the run key. */
interface Target {
  trigger: BlockReviewTrigger;
  key: string;
  /** The reviewed block, cut to its elapsed weeks on a race move */
  block: TrainingBlock;
  /** The block after it in the old plan (block end only) */
  next: TrainingBlock | undefined;
  freezeThrough: string;
  previousRaceDate: string | null;
}

function blockEndTarget(record: ActiveSeasonRecord, date: string): Target | BlockReviewSkip {
  const blocks = record.season.blocks;
  const at = blockWeekAt(blocks, date);
  if (at === null || blockEndDate(at.block) !== date) return 'not_block_end';
  if (NO_REVIEW_TYPES.has(at.block.type)) return 'no_remaining_blocks';
  return {
    trigger: 'block_end',
    key: 'block:' + at.block.order.toString(),
    block: at.block,
    next: blocks.find((b) => b.order === at.block.order + 1),
    freezeThrough: date,
    previousRaceDate: null,
  };
}

function raceMoveTarget(
  record: ActiveSeasonRecord,
  job: BlockReviewJob,
  date: string
): Target | BlockReviewSkip {
  const race = record.season.aRace;
  const { raceId, newDate } = job;
  // The season's A-race must still be the moved race, at its new date
  if (raceId === undefined || race?.id !== raceId || race.date !== newDate) return 'race_changed';
  const freezeThrough = isoWeekRange(isoWeekKey(date)).to;
  const at = blockWeekAt(record.season.blocks, date);
  if (at === null) return 'no_remaining_blocks';
  return {
    trigger: 'race_move',
    key: 'race:' + race.id + ':' + race.date,
    block: { ...at.block, weeks: at.weekIndex + 1 },
    next: undefined,
    freezeThrough,
    previousRaceDate: job.previousDate ?? null,
  };
}

interface RunCtx {
  userId: string;
  /** Review day, athlete-local */
  date: string;
  key: string;
  deps: BlockReviewDeps;
  timings: StageTimings;
}

function stage<T>(ctx: RunCtx, name: BlockReviewStage, fn: () => Promise<T>): Promise<T> {
  return timedStage({ ...ctx, logger: ctx.deps.logger }, 'block review stage', name, fn);
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
      { userId: ctx.userId, key: ctx.key, error: errorText(error) },
      'block review: activity sync failed, report is stale'
    );
    return true;
  }
}

/** The block's verdict from its stored weeks; this week is recomputed first. */
async function blockVerdict(ctx: RunCtx, block: TrainingBlock): Promise<BlockVerdict> {
  const { deps, userId, date } = ctx;
  await stage(ctx, 'stats', () =>
    runWeeklyStats(
      userId,
      { profiles: deps.profiles, repo: deps.stats, logger: deps.logger, now: () => deps.now() },
      isoWeekKey(date)
    )
  );
  const weeks = blockIsoWeeks(block);
  const range = {
    from: isoWeekRange(weeks[0]).from,
    to: isoWeekRange(weeks.at(-1) ?? weeks[0]).from,
  };
  const rows = await deps.stats.listRange(userId, range);
  return computeBlockVerdict(block, rows);
}

async function seedLoad(ctx: RunCtx, target: Target, verdict: BlockVerdict): Promise<number> {
  if (target.trigger === 'block_end') return reprojectionSeed(verdict, target.next);
  const hours = await ctx.deps.loadTrainingHours(
    ctx.userId,
    addDaysIso(ctx.date, -RACE_MOVE_LOAD_WEEKS * 7),
    addDaysIso(ctx.date, -1)
  );
  return Math.round((hours / RACE_MOVE_LOAD_WEEKS) * 10) / 10;
}

function availableHours(record: ActiveSeasonRecord): number {
  if (record.weeklyHoursAvailable !== null) return record.weeklyHoursAvailable;
  // Seasons created before the wizard's answers were stored: their busiest block
  return Math.max(...record.season.blocks.map((b) => b.targetWeeklyHours));
}

type Projection = { season: ReprojectedSeason; issue: null } | { season: null; issue: string };

function project(record: ActiveSeasonRecord, target: Target, seed: number): Projection {
  const race = record.season.aRace;
  if (race === null) return { season: null, issue: 'the season has no A-race' };
  try {
    const season = reprojectSeason({
      season: record.season,
      aRace: race,
      freezeThrough: target.freezeThrough,
      seedWeeklyLoad: seed,
      weeklyHoursAvailable: availableHours(record),
      weakSport: record.weakSport ?? undefined,
    });
    return { season, issue: null };
  } catch (error) {
    if (!(error instanceof SeasonGenerationError)) throw error;
    return { season: null, issue: error.issues.join('; ') };
  }
}

function afterFreeze(blocks: TrainingBlock[], freezeThrough: string): TrainingBlock[] {
  return blocks.filter((b) => b.startDate > freezeThrough);
}

interface Prepared {
  report: RichReply;
  decisionId: string;
  verdict: BlockVerdict;
  proposal: ProposedSeason | null;
  stale: boolean;
}

async function prepare(
  ctx: RunCtx,
  run: BlockReviewRun,
  record: ActiveSeasonRecord,
  target: Target
): Promise<Prepared> {
  const { deps, userId, date } = ctx;
  const stale = await syncOrStale(ctx);
  const verdict = await blockVerdict(ctx, target.block);
  const projection = project(record, target, await seedLoad(ctx, target, verdict));
  const remaining = afterFreeze(record.season.blocks, target.freezeThrough);

  const result = await stage(ctx, 'coach', () =>
    runBlockReview(
      { provider: deps.provider, decisions: deps.decisions, config: deps.config },
      {
        userId,
        date,
        trigger: target.trigger,
        block: target.block,
        verdict,
        aRace: record.season.aRace,
        previousRaceDate: target.previousRaceDate,
        remaining,
        proposed: projection.season
          ? afterFreeze(projection.season.blocks, target.freezeThrough)
          : null,
        proposalIssue: projection.issue,
      }
    )
  );
  const proposed = result.reproject ? projection.season : null;
  const race = record.season.aRace;
  const report = renderBlockReport({
    runId: run.id,
    verdict,
    review: result.review,
    raceMove:
      target.trigger === 'race_move' && race
        ? { name: race.name, from: target.previousRaceDate ?? race.date, to: race.date }
        : null,
    diff: proposed
      ? {
          before: record.season.blocks,
          after: proposed.blocks,
          freezeThrough: target.freezeThrough,
        }
      : null,
    stale,
  });
  // A proposal exists only for a season with an A-race (`project`)
  const proposal =
    proposed && race
      ? {
          raceDate: race.date,
          startDate: proposed.startDate,
          frozenCount: proposed.frozenCount,
          truncated: proposed.truncated,
          blocks: proposed.blocks,
        }
      : null;
  return { report, decisionId: result.decisionId, verdict, proposal, stale };
}

async function runClaimed(
  ctx: RunCtx,
  run: BlockReviewRun,
  record: ActiveSeasonRecord,
  target: Target,
  chatId: number
): Promise<BlockReviewResult> {
  const { deps, key } = ctx;
  const allTimings = () => ({ ...run.stageTimings, ...ctx.timings });

  if (run.reportText !== null) {
    // A retry after a failed send: same report and buttons, no second CoachDecision
    const keyboard = run.reportKeyboard ?? [];
    await send(ctx, chatId, { text: run.reportText, html: true, keyboard });
    await deps.runs.markSent(run.id, deps.now(), allTimings());
    return {
      status: 'sent',
      key,
      resumed: true,
      decisionId: run.coachDecisionId,
      reproject: keyboard.length > 0,
      timings: ctx.timings,
    };
  }

  const prepared = await prepare(ctx, run, record, target);
  await deps.runs.saveReport(run.id, {
    coachDecisionId: prepared.decisionId,
    verdict: prepared.verdict,
    proposal: prepared.proposal,
    freezeThrough: target.freezeThrough,
    seasonUpdatedAt: record.updatedAt,
    reportText: prepared.report.text,
    reportKeyboard: prepared.report.keyboard ?? [],
    stale: prepared.stale,
    stageTimings: allTimings(),
  });
  await send(ctx, chatId, prepared.report);
  await deps.runs.markSent(run.id, deps.now(), allTimings());
  return {
    status: 'sent',
    key,
    resumed: false,
    decisionId: prepared.decisionId,
    reproject: prepared.proposal !== null,
    timings: ctx.timings,
  };
}

function resolveTarget(
  job: BlockReviewJob,
  record: ActiveSeasonRecord,
  date: string
): Target | BlockReviewSkip {
  return job.trigger === 'race_move'
    ? raceMoveTarget(record, job, date)
    : blockEndTarget(record, date);
}

/**
 * A block review of one athlete: on the last day of a training block (the Sunday scheduler
 * skips other days), or right after the A-race moved. Activity sync (a failure only makes the
 * report stale) → this week's stats → block verdict from the stored WeeklyStats → a
 * re-projection of the remaining blocks seeded with the achieved load (days up to the freeze
 * date never change) → AI keep/re-project (one CoachDecision, `origin: 'block'`) → a report
 * with the old-vs-new block tables and Confirm/Decline. Nothing changes until Confirm.
 *
 * Runs at most once per season and key: the `BlockReviewRun` row is claimed first, and the
 * report is stored before the send, so a retry resends it without a second decision.
 */
export async function runBlockReviewJob(
  job: BlockReviewJob,
  deps: BlockReviewDeps
): Promise<BlockReviewResult> {
  const { userId } = job;
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };
  const record = await deps.seasons.findActiveRecord(userId);
  if (!record) return { status: 'skipped', reason: 'no_season' };

  const now = deps.now();
  const date = localToday(now, profile.timezone);
  const target = resolveTarget(job, record, date);
  if (typeof target === 'string') return { status: 'skipped', reason: target };

  const { key, trigger } = target;
  const claimKey = { userId, seasonPlanId: record.id, key, trigger };
  const claim = await deps.runs.claim(claimKey, now, BLOCK_REVIEW_LEASE_MS);
  if (claim.status === 'already_sent') return { status: 'skipped', reason: 'already_sent' };
  if (claim.status === 'in_progress') throw new BlockReviewInProgressError(userId, key);

  const ctx: RunCtx = { userId, date, key, deps, timings: {} };
  try {
    const result = await runClaimed(ctx, claim.run, record, target, profile.telegramChatId);
    deps.logger.info({ userId, ...result }, 'block review finished');
    return result;
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn({ userId, key, error: e }, 'block review: could not mark failed');
    });
    deps.logger.info(
      { userId, key, status: 'failed', timings: ctx.timings },
      'block review finished'
    );
    throw error;
  }
}

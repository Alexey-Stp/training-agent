import { differenceInCalendarDays, parseISO } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import {
  addDaysIso,
  buildPacingPlan,
  computeRaceMetrics,
  localToday,
  pickRaceActivity,
  RACE_REACH_DAYS,
  recoveryDays,
  recoveryWindow,
  Sport,
  type PacingPlan,
  type RaceStreams,
  type RunEffort,
} from '@triathlon/core';
import { runRaceDebrief, type LlmProvider } from '@triathlon/ai';
import { errorText, sendOrFail, timedStage, type RunLogger } from '../daily-loop/run-helpers';
import type { StageTimings } from '../daily-loop/run-store';
import type { BriefProfileRepo } from '../daily-loop/scheduler';
import type { RaceRecord, RaceRepo } from '../race-command';
import { toTelegramMessage, type TelegramMessageOptions } from '../reply';
import {
  applyRecoveryBlocks,
  recoveryWindows,
  type RecoveryDeps,
  type RecoveryResult,
} from './post-race-recovery';
import { debriefFacts, renderNoActivityQuestion, renderRaceDebrief } from './race-debrief-render';
import { formatRaceDay } from './race-brief-render';
import type { RaceDebriefRun, RaceDebriefRunRepo } from './race-debrief-store';

/** How long a running debrief holds its run before a retry may take it over */
export const RACE_DEBRIEF_LEASE_MS = 5 * 60_000;

/** Days back whose runs feed the run pace estimate (a little more than the core window) */
const RUN_EFFORT_LOOKBACK_DAYS = 100;
const HOURS_PER_DAY = 24;

/** The race activity as stored by the activity sync. */
export interface RaceActivity {
  icuId: string;
  sport: Sport;
  startDateLocal: string;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  avgPower: number | null;
}

export interface PostRaceDeps extends RecoveryDeps {
  runs: RaceDebriefRunRepo;
  profiles: BriefProfileRepo;
  races: Pick<RaceRepo, 'listUpcoming'>;
  activities: { listByDate(userId: string, date: string): Promise<RaceActivity[]> };
  getFtp(userId: string): Promise<number | null>;
  runEfforts: { listRunEfforts(userId: string, from: string, to: string): Promise<RunEffort[]> };
  /** activity-sync `syncActivities`; throws when ICU is down */
  syncActivities(userId: string): Promise<unknown>;
  /** The activity's streams; null when there are none. Throws on ICU errors. */
  getStreams(userId: string, activityIcuId: string): Promise<RaceStreams | null>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  sendMessage(
    chatId: number,
    text: string,
    options: TelegramMessageOptions
  ): Promise<{ message_id: number }>;
  /** RACE_DEBRIEF_TIMEOUT_HOURS, counted from the end of race day */
  debriefTimeoutHours: number;
  logger: RunLogger;
  now(): Date;
}

export type DebriefOutcome =
  | { raceId: string; status: 'skipped'; reason: 'already_done' | 'no_activity' }
  | { raceId: string; status: 'waiting' }
  | { raceId: string; status: 'sent'; resumed: boolean; stale: boolean };

export type PostRaceResult =
  | { status: 'skipped'; reason: 'no_profile' }
  | { status: 'done'; date: string; recovery: RecoveryResult; debriefs: DebriefOutcome[] };

/** Another attempt holds the debrief's run; thrown so the job retries after the lease. */
export class RaceDebriefInProgressError extends Error {
  constructor(userId: string, raceId: string) {
    super('Race debrief already running for ' + userId + ', race ' + raceId);
    this.name = 'RaceDebriefInProgressError';
  }
}

interface DebriefCtx {
  userId: string;
  chatId: number;
  timezone: string;
  date: string;
  race: RaceRecord;
  deps: PostRaceDeps;
  timings: StageTimings;
}

/** Days after the race on which a debrief is still attempted: the timeout plus the day it expires */
function debriefDays(timeoutHours: number): number {
  return Math.ceil(timeoutHours / HOURS_PER_DAY) + 1;
}

/** The end of race day (athlete-local) plus the timeout. */
export function debriefDeadline(race: Pick<RaceRecord, 'date'>, timezone: string, hours: number) {
  const endOfRaceDay = fromZonedTime(addDaysIso(race.date, 1) + 'T00:00:00', timezone);
  return new Date(endOfRaceDay.getTime() + hours * 3_600_000);
}

function stage<T>(ctx: DebriefCtx, name: string, fn: () => Promise<T>): Promise<T> {
  return timedStage({ ...ctx, logger: ctx.deps.logger }, 'race debrief stage', name, fn);
}

async function sendText(ctx: DebriefCtx, text: string): Promise<void> {
  const message = toTelegramMessage({ text, html: true });
  await stage(ctx, 'send', () =>
    sendOrFail(() => ctx.deps.sendMessage(ctx.chatId, message.text, message.options))
  );
}

/** A failed sync only makes the debrief stale: the activities already stored are used. */
async function syncOrStale(ctx: DebriefCtx): Promise<boolean> {
  try {
    await stage(ctx, 'activity', () => ctx.deps.syncActivities(ctx.userId));
    return false;
  } catch (error) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, raceId: ctx.race.id, error: errorText(error) },
      'race debrief: activity sync failed, debrief is stale'
    );
    return true;
  }
}

/** Without streams (none recorded, or ICU failing) the stored averages are compared. */
async function streamsOrNull(ctx: DebriefCtx, icuId: string): Promise<RaceStreams | null> {
  try {
    return await stage(ctx, 'streams', () => ctx.deps.getStreams(ctx.userId, icuId));
  } catch (error) {
    ctx.deps.logger.warn(
      { userId: ctx.userId, raceId: ctx.race.id, error: errorText(error) },
      'race debrief: streams unavailable, comparing averages only'
    );
    return null;
  }
}

/** The T-1 targets the brief gave: FTP and run efforts as they were before the race. */
async function loadTargets(ctx: DebriefCtx): Promise<PacingPlan> {
  const { deps, userId, race } = ctx;
  const before = addDaysIso(race.date, -1);
  const [ftp, runEfforts] = await Promise.all([
    deps.getFtp(userId),
    deps.runEfforts.listRunEfforts(userId, addDaysIso(before, -RUN_EFFORT_LOOKBACK_DAYS), before),
  ]);
  return buildPacingPlan({ raceType: race.type, ftp: ftp ?? 0, runEfforts, today: race.date });
}

function activitySport(sport: Sport): 'bike' | 'run' | 'other' {
  if (sport === Sport.bike) return 'bike';
  return sport === Sport.run ? 'run' : 'other';
}

/** One plain line on the recovery block that follows the race. */
export function recoveryLine(race: RaceRecord): string {
  const window = recoveryWindow(race);
  if (!window) return '';
  const days = recoveryDays(race).toString();
  return days + ' easy days follow, rest or Z1 only, until ' + formatRaceDay(window.to) + '.';
}

async function analyze(
  ctx: DebriefCtx,
  run: RaceDebriefRun,
  activity: RaceActivity,
  stale: boolean
): Promise<void> {
  const { deps, race, userId } = ctx;
  const [targets, streams] = await Promise.all([
    loadTargets(ctx),
    streamsOrNull(ctx, activity.icuId),
  ]);
  const metrics = computeRaceMetrics({
    raceType: race.type,
    activitySport: activitySport(activity.sport),
    averages: {
      durationSec: activity.durationSec,
      distanceM: activity.distanceM,
      avgHr: activity.avgHr,
      avgPower: activity.avgPower,
    },
    streams,
    targets: { bike: targets.bike, run: targets.run },
  });
  const facts = debriefFacts(metrics);
  const note = recoveryLine(race);
  const result = await stage(ctx, 'narrative', () =>
    runRaceDebrief(
      { provider: deps.provider },
      {
        userId,
        raceName: race.name,
        raceType: race.type,
        priority: race.priority,
        tier: metrics.tier,
        facts: facts.join('\n'),
        recoveryNote: note,
      }
    )
  );
  if (result.fallbackReason) {
    deps.logger.warn(
      { userId, raceId: race.id, reason: result.fallbackReason, error: result.error },
      'race debrief: using the fixed text'
    );
  }
  const text = renderRaceDebrief({ race, text: result.text, facts, recoveryLine: note, stale });
  await deps.runs.saveDebrief(run.id, {
    activityIcuId: activity.icuId,
    tier: metrics.tier,
    metrics,
    narrative: result.text.narrative,
    takeaways: result.text.takeaways,
    debriefText: text,
    stageTimings: { ...run.stageTimings, ...ctx.timings },
  });
  await sendText(ctx, text);
}

/** No race activity: wait while the timeout runs, then ask the athlete if they raced. */
async function noActivity(
  ctx: DebriefCtx,
  run: RaceDebriefRun,
  stale: boolean
): Promise<DebriefOutcome> {
  const { deps, race, userId } = ctx;
  const timings = { ...run.stageTimings, ...ctx.timings };
  const deadline = debriefDeadline(race, ctx.timezone, deps.debriefTimeoutHours);
  // A failed sync proves nothing about the activity: look again on the next run
  if (stale || deps.now() < deadline) {
    await deps.runs.release(run.id, timings);
    return { raceId: race.id, status: 'waiting' };
  }
  deps.logger.warn(
    { userId, raceId: race.id, raceDate: race.date },
    'race debrief skipped: no race activity synced in time'
  );
  await sendText(ctx, renderNoActivityQuestion(race));
  await deps.runs.markSkipped(run.id, 'no_activity', deps.now(), timings);
  return { raceId: race.id, status: 'skipped', reason: 'no_activity' };
}

async function runClaimed(ctx: DebriefCtx, run: RaceDebriefRun): Promise<DebriefOutcome> {
  const { deps, race } = ctx;
  const allTimings = () => ({ ...run.stageTimings, ...ctx.timings });
  if (run.debriefText !== null) {
    // A retry after a failed send: the stored debrief, no new LLM call
    await sendText(ctx, run.debriefText);
    await deps.runs.markSent(run.id, deps.now(), allTimings());
    return { raceId: race.id, status: 'sent', resumed: true, stale: false };
  }
  const stale = await syncOrStale(ctx);
  const activities = await deps.activities.listByDate(ctx.userId, race.date);
  const activity = pickRaceActivity(activities, race.date);
  if (!activity) return noActivity(ctx, run, stale);
  await analyze(ctx, run, activity, stale);
  await deps.runs.markSent(run.id, deps.now(), allTimings());
  return { raceId: race.id, status: 'sent', resumed: false, stale };
}

async function debriefRace(ctx: DebriefCtx): Promise<DebriefOutcome> {
  const { deps, userId, race } = ctx;
  const key = { userId, raceId: race.id, raceDate: race.date };
  const claim = await deps.runs.claim(key, deps.now(), RACE_DEBRIEF_LEASE_MS);
  if (claim.status === 'already_done') {
    return { raceId: race.id, status: 'skipped', reason: 'already_done' };
  }
  if (claim.status === 'in_progress') throw new RaceDebriefInProgressError(userId, race.id);
  try {
    return await runClaimed(ctx, claim.run);
  } catch (error) {
    const timings = { ...claim.run.stageTimings, ...ctx.timings };
    // Best effort: the job retries either way, and the run's lease expires on its own
    await deps.runs.markFailed(claim.run.id, errorText(error), timings).catch((e: unknown) => {
      deps.logger.warn(
        { userId, raceId: race.id, error: e },
        'race debrief: could not mark failed'
      );
    });
    throw error;
  }
}

/** Races whose debrief is still attempted today: the day after the race up to the timeout day. */
function debriefable(races: readonly RaceRecord[], today: string, timeoutHours: number) {
  const limit = debriefDays(timeoutHours);
  return races.filter((race) => {
    const since = differenceInCalendarDays(parseISO(today), parseISO(race.date));
    return since >= 1 && since <= limit;
  });
}

/**
 * The daily post-race pass of one athlete, at the local POST_RACE_TIME.
 *
 * Recovery: from the day after a race the planned sessions of its recovery block (A: 7–14 days
 * by distance, B: 2–4, C: 0–2) are replaced with Z1 or rest and pushed to ICU.
 *
 * Debrief: once the race activity has synced (the longest activity of race day), core computes
 * the pacing metrics against the T-1 targets and the LLM only narrates them; the result is sent
 * once per (race, race date), stored before the send so a retry resends it. When no activity
 * turns up before the timeout, the debrief is skipped (logged) and the athlete is asked if they
 * raced.
 */
export async function runPostRaceJob(userId: string, deps: PostRaceDeps): Promise<PostRaceResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const date = localToday(deps.now(), profile.timezone);
  const reach = Math.max(RACE_REACH_DAYS, debriefDays(deps.debriefTimeoutHours));
  // Races dated on/after the oldest day a recovery block or debrief can still concern
  const races = await deps.races.listUpcoming(userId, addDaysIso(date, -reach));

  const recovery = await applyRecoveryBlocks(userId, recoveryWindows(races, date), deps);
  const due = debriefable(races, date, deps.debriefTimeoutHours);
  // Each due race has its own run row; a retry skips the ones already done
  const debriefs = await Promise.all(
    due.map((race) =>
      debriefRace({
        userId,
        chatId: profile.telegramChatId,
        timezone: profile.timezone,
        date,
        race,
        deps,
        timings: {},
      })
    )
  );
  deps.logger.info({ userId, date, recovery: recovery.status, debriefs }, 'post-race finished');
  return { status: 'done', date, recovery, debriefs };
}

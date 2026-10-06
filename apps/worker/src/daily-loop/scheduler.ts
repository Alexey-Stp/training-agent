import type { Queue } from 'bullmq';
import type { IcuSyncScheduler } from '../sync-scheduler';

export const DAILY_BRIEF_QUEUE = 'daily-brief';
export const DAILY_BRIEF_JOB = 'daily-brief';
/** Delayed one-off job that finishes a brief whose check-in is out */
export const DAILY_BRIEF_CONTINUE_JOB = 'daily-brief-continue';

export interface DailyBriefJob {
  userId: string;
  /** Continuation jobs only: the local date the check-in was asked for */
  checkInDate?: string;
}

export function dailyBriefSchedulerId(userId: string): string {
  return DAILY_BRIEF_JOB + ':' + userId;
}

export const EVENING_CLOSEOUT_QUEUE = 'evening-closeout';
export const EVENING_CLOSEOUT_JOB = 'evening-closeout';

export interface EveningCloseoutJob {
  userId: string;
}

export function eveningCloseoutSchedulerId(userId: string): string {
  return EVENING_CLOSEOUT_JOB + ':' + userId;
}

export const WEEKLY_STATS_QUEUE = 'weekly-stats';
export const WEEKLY_STATS_JOB = 'weekly-stats';

export const WEEKLY_REVIEW_QUEUE = 'weekly-review';
export const WEEKLY_REVIEW_JOB = 'weekly-review';

export const RACE_BRIEF_QUEUE = 'race-brief';
export const RACE_BRIEF_JOB = 'race-brief';

export const BLOCK_REVIEW_QUEUE = 'block-review';
/** The Sunday scheduler's job: it reviews only when today is the last day of a block */
export const BLOCK_REVIEW_JOB = 'block-review';
/** A one-off job enqueued by `/race move` */
export const BLOCK_REVIEW_RACE_MOVE_JOB = 'block-review-race-move';

/** Cron day-of-week numbers */
export const MONDAY = 1;
export const SUNDAY = 0;

export interface RaceBriefJob {
  userId: string;
}

export interface WeeklyReviewJob {
  userId: string;
}

export interface WeeklyStatsJob {
  userId: string;
  /** ISO week to compute (`2026-W40`); the scheduler leaves it out: the previous week */
  isoWeek?: string;
}

/** What the morning brief needs to know about an athlete. */
export interface BriefProfile {
  /** Private chat: the chat id is the athlete's Telegram user id */
  telegramChatId: number;
  timezone: string;
  /** `HH:mm` local; null uses DAILY_BRIEF_DEFAULT_TIME */
  briefTime: string | null;
  /** `HH:mm` local; null uses EVENING_CLOSEOUT_DEFAULT_TIME */
  closeoutTime: string | null;
}

export interface BriefProfileRepo {
  findBriefProfile(userId: string): Promise<BriefProfile | null>;
}

export interface DailyBriefSchedulerDeps {
  profiles: BriefProfileRepo;
  /** DAILY_BRIEF_DEFAULT_TIME, EVENING_CLOSEOUT_DEFAULT_TIME, WEEKLY_STATS_TIME or WEEKLY_REVIEW_TIME */
  defaultTime: string;
}

/** `'06:30'` → `'30 6 * * *'`: every day at that wall-clock time (the scheduler's tz applies). */
export function briefCron(briefTime: string): string {
  const [hours, minutes] = briefTime.split(':').map(Number);
  return [minutes, hours, '*', '*', '*'].join(' ');
}

/** `'06:00'` → `'0 6 * * 1'`: every Monday at that wall-clock time. */
export function weeklyCron(time: string, weekday: number = MONDAY): string {
  const [hours, minutes] = time.split(':').map(Number);
  return [minutes, hours, '*', '*', weekday].join(' ');
}

function repeatAt(time: string, timezone: string): { pattern: string; tz: string } {
  return { pattern: briefCron(time), tz: timezone };
}

/** The repeat options of an athlete's brief scheduler: local briefTime, every day. */
export function briefRepeat(
  profile: BriefProfile,
  defaultTime: string
): { pattern: string; tz: string } {
  return repeatAt(profile.briefTime ?? defaultTime, profile.timezone);
}

/** The repeat options of an athlete's close-out scheduler: local closeoutTime, every day. */
export function closeoutRepeat(
  profile: BriefProfile,
  defaultTime: string
): { pattern: string; tz: string } {
  return repeatAt(profile.closeoutTime ?? defaultTime, profile.timezone);
}

/** The repeat options of an athlete's weekly stats scheduler: Mondays at WEEKLY_STATS_TIME. */
export function weeklyStatsRepeat(
  profile: BriefProfile,
  time: string
): { pattern: string; tz: string } {
  return { pattern: weeklyCron(time), tz: profile.timezone };
}

/** The repeat options of an athlete's weekly review scheduler: Sundays at WEEKLY_REVIEW_TIME. */
export function weeklyReviewRepeat(
  profile: BriefProfile,
  time: string
): { pattern: string; tz: string } {
  return { pattern: weeklyCron(time, SUNDAY), tz: profile.timezone };
}

/**
 * The repeat options of an athlete's race brief scheduler: every day at RACE_BRIEF_TIME. The job
 * does nothing on days without a T-7 (A-race) or T-1 race.
 */
export function raceBriefRepeat(
  profile: BriefProfile,
  time: string
): { pattern: string; tz: string } {
  return { pattern: briefCron(time), tz: profile.timezone };
}

/**
 * The repeat options of an athlete's block review scheduler: Sundays at BLOCK_REVIEW_TIME. Every
 * block ends on a Sunday; the job skips the Sundays that don't end one.
 */
export function blockReviewRepeat(
  profile: BriefProfile,
  time: string
): { pattern: string; tz: string } {
  return { pattern: weeklyCron(time, SUNDAY), tz: profile.timezone };
}

/** Job data every daily cron job carries */
interface DailyCronJob {
  userId: string;
}

type CronQueue = Pick<
  Queue<DailyCronJob>,
  'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'
>;

/**
 * Upserts the job only. A send failure is retried by the job (3 attempts). The backoff is longer
 * than the run lease, so a retry after a crash can take over the run.
 */
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 120_000 },
  removeOnComplete: { age: 86400, count: 100 },
  removeOnFail: { age: 7 * 86400 },
};

/** One per-athlete cron job: its name (also the scheduler id prefix) and local schedule. */
interface DailyCronSpec {
  jobName: string;
  repeat(profile: BriefProfile, defaultTime: string): { pattern: string; tz: string };
}

const BRIEF_SPEC: DailyCronSpec = { jobName: DAILY_BRIEF_JOB, repeat: briefRepeat };

const CLOSEOUT_SPEC: DailyCronSpec = { jobName: EVENING_CLOSEOUT_JOB, repeat: closeoutRepeat };

const WEEKLY_STATS_SPEC: DailyCronSpec = { jobName: WEEKLY_STATS_JOB, repeat: weeklyStatsRepeat };

const WEEKLY_REVIEW_SPEC: DailyCronSpec = {
  jobName: WEEKLY_REVIEW_JOB,
  repeat: weeklyReviewRepeat,
};

const RACE_BRIEF_SPEC: DailyCronSpec = { jobName: RACE_BRIEF_JOB, repeat: raceBriefRepeat };

const BLOCK_REVIEW_SPEC: DailyCronSpec = {
  jobName: BLOCK_REVIEW_JOB,
  repeat: blockReviewRepeat,
};

function schedulerId(spec: { jobName: string }, userId: string): string {
  return spec.jobName + ':' + userId;
}

/**
 * One repeatable `<jobName>:<userId>` job per linked athlete, firing at the athlete's local
 * time. BullMQ evaluates the cron in `tz`, so DST shifts move the UTC instant, not the local
 * time. Unlike the `every` sync schedulers, a cron scheduler doesn't fire on creation.
 */
function createDailyCronScheduler(
  queue: CronQueue,
  spec: DailyCronSpec,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return {
    async schedule(userId) {
      const profile = await deps.profiles.findBriefProfile(userId);
      if (!profile) return;
      await queue.upsertJobScheduler(
        schedulerId(spec, userId),
        spec.repeat(profile, deps.defaultTime),
        { name: spec.jobName, data: { userId }, opts: JOB_OPTS }
      );
    },
    async unschedule(userId) {
      await queue.removeJobScheduler(schedulerId(spec, userId));
    },
  };
}

/** The morning brief scheduler: `daily-brief:<userId>` at the local briefTime. */
export function createDailyBriefScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, BRIEF_SPEC, deps);
}

/** The evening close-out scheduler: `evening-closeout:<userId>` at the local closeoutTime. */
export function createEveningCloseoutScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, CLOSEOUT_SPEC, deps);
}

/** The weekly stats scheduler: `weekly-stats:<userId>` on Mondays at the local WEEKLY_STATS_TIME. */
export function createWeeklyStatsScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, WEEKLY_STATS_SPEC, deps);
}

/** The weekly review scheduler: `weekly-review:<userId>` on Sundays at the local WEEKLY_REVIEW_TIME. */
export function createWeeklyReviewScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, WEEKLY_REVIEW_SPEC, deps);
}

/** The race brief scheduler: `race-brief:<userId>` daily at the local RACE_BRIEF_TIME; the job skips days without a T-7/T-1 race. */
export function createRaceBriefScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, RACE_BRIEF_SPEC, deps);
}

/** The block review scheduler: `block-review:<userId>` on Sundays at the local BLOCK_REVIEW_TIME. */
export function createBlockReviewScheduler(
  queue: CronQueue,
  deps: DailyBriefSchedulerDeps
): IcuSyncScheduler {
  return createDailyCronScheduler(queue, BLOCK_REVIEW_SPEC, deps);
}

/** BullMQ rejects `:` in custom job ids, hence the dashes. */
export function blockReviewRaceMoveJobId(userId: string, raceId: string, newDate: string): string {
  return ['block-review-race', userId, raceId, newDate].join('-');
}

/** BullMQ rejects `:` in custom job ids, hence the dashes. */
export function checkInContinuationJobId(userId: string, date: string): string {
  return 'checkin-' + userId + '-' + date;
}

type ContinuationQueue = Pick<Queue<DailyBriefJob>, 'add' | 'getJob'>;

export interface CheckInContinuation {
  /** Queues the brief continuation `delayMs` from now; a second call for the day is a no-op. */
  schedule(userId: string, date: string): Promise<void>;
  /** Runs the queued continuation now; does nothing when it already ran or is running. */
  resume(userId: string, date: string): Promise<void>;
}

/**
 * The check-in timeout as one delayed job per athlete and day. Its fixed job id makes a retried
 * check-in reuse it, and lets an answered check-in promote it instead of starting a second one.
 */
export function createCheckInContinuation(
  queue: ContinuationQueue,
  delayMs: number
): CheckInContinuation {
  return {
    async schedule(userId, date) {
      await queue.add(
        DAILY_BRIEF_CONTINUE_JOB,
        { userId, checkInDate: date },
        { ...JOB_OPTS, jobId: checkInContinuationJobId(userId, date), delay: delayMs }
      );
    },
    async resume(userId, date) {
      const job = await queue.getJob(checkInContinuationJobId(userId, date));
      if (!job || !(await job.isDelayed())) return;
      await job.promote();
    },
  };
}

/**
 * Runs each scheduler in turn, so the brief scheduler follows the sync schedulers on connect
 * and disconnect. Each one runs even when an earlier one fails; the first error is rethrown.
 */
export function combineSchedulers(...schedulers: IcuSyncScheduler[]): IcuSyncScheduler {
  const runAll = async (action: 'schedule' | 'unschedule', userId: string) => {
    const results = await Promise.allSettled(schedulers.map((s) => s[action](userId)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
  return {
    schedule: (userId) => runAll('schedule', userId),
    unschedule: (userId) => runAll('unschedule', userId),
  };
}

/**
 * Worker startup: (re)schedules every linked athlete whose scheduler is missing or has a stale
 * time or timezone, and removes the spec's schedulers whose connection is gone.
 */
async function reconcileDailyCronSchedulers(
  queue: CronQueue,
  spec: DailyCronSpec,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  const connected = [...new Set(connectedUserIds)];
  const [existing, profiles] = await Promise.all([
    queue.getJobSchedulers(),
    Promise.all(connected.map((userId) => deps.profiles.findBriefProfile(userId))),
  ]);
  const byKey = new Map(existing.map((s) => [s.key, s]));

  const stale = connected.filter((userId, i) => {
    const profile = profiles[i];
    if (!profile) return false;
    const want = spec.repeat(profile, deps.defaultTime);
    const have = byKey.get(schedulerId(spec, userId));
    return have?.pattern !== want.pattern || have.tz !== want.tz;
  });

  const prefix = spec.jobName + ':';
  const connectedSet = new Set(connected);
  const orphans = existing
    .filter((s) => s.key.startsWith(prefix))
    .map((s) => s.key.slice(prefix.length))
    .filter((userId) => !connectedSet.has(userId));

  await Promise.all([
    ...stale.map((userId) => scheduler.schedule(userId)),
    ...orphans.map((userId) => scheduler.unschedule(userId)),
  ]);
  return { scheduled: stale.length, removed: orphans.length };
}

/** Startup reconcile of the morning brief schedulers. */
export function reconcileDailyBriefSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, BRIEF_SPEC, scheduler, connectedUserIds, deps);
}

/** Startup reconcile of the evening close-out schedulers. */
export function reconcileEveningCloseoutSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, CLOSEOUT_SPEC, scheduler, connectedUserIds, deps);
}

/** Startup reconcile of the weekly stats schedulers. */
export function reconcileWeeklyStatsSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, WEEKLY_STATS_SPEC, scheduler, connectedUserIds, deps);
}

/** Startup reconcile of the weekly review schedulers. */
export function reconcileWeeklyReviewSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, WEEKLY_REVIEW_SPEC, scheduler, connectedUserIds, deps);
}

/** Startup reconcile of the race brief schedulers. */
export function reconcileRaceBriefSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, RACE_BRIEF_SPEC, scheduler, connectedUserIds, deps);
}

/** Startup reconcile of the block review schedulers. */
export function reconcileBlockReviewSchedulers(
  queue: CronQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  deps: DailyBriefSchedulerDeps
): Promise<{ scheduled: number; removed: number }> {
  return reconcileDailyCronSchedulers(queue, BLOCK_REVIEW_SPEC, scheduler, connectedUserIds, deps);
}

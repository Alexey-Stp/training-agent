import {
  BLOCK_REVIEW_JOB,
  BLOCK_REVIEW_QUEUE,
  BLOCK_REVIEW_RACE_MOVE_JOB,
  DAILY_BRIEF_CONTINUE_JOB,
  DAILY_BRIEF_JOB,
  DAILY_BRIEF_QUEUE,
  EVENING_CLOSEOUT_JOB,
  EVENING_CLOSEOUT_QUEUE,
  POST_RACE_JOB,
  POST_RACE_QUEUE,
  RACE_BRIEF_JOB,
  RACE_BRIEF_QUEUE,
  WEEKLY_REVIEW_JOB,
  WEEKLY_REVIEW_QUEUE,
  WEEKLY_STATS_JOB,
  WEEKLY_STATS_QUEUE,
} from '../daily-loop/scheduler';
import {
  ACTIVITY_SYNC_JOB,
  ICU_SYNC_QUEUE,
  PLAN_RECONCILE_JOB,
  SEASON_PUBLISH_JOB,
  WELLNESS_SYNC_JOB,
} from '../sync-scheduler';

/**
 * `every`/`cron` jobs are repeatable schedulers with id `<name>:<userId>`; `oneoff` jobs are
 * queued on demand and are listed so that nothing registered is ever mistaken for an orphan.
 */
export type JobKind = 'every' | 'cron' | 'oneoff';

export interface JobDef {
  name: string;
  queue: string;
  kind: JobKind;
  /** Env var or Profile field that sets the schedule (documentation, not read at runtime) */
  schedule: string;
  /** Epic or ticket that owns the job */
  owner: string;
}

/** Single source of truth for every job the worker may have scheduled in Redis */
export const JOB_REGISTRY: readonly JobDef[] = [
  {
    name: ACTIVITY_SYNC_JOB,
    queue: ICU_SYNC_QUEUE,
    kind: 'every',
    schedule: 'ICU_ACTIVITY_SYNC_EVERY_MIN',
    owner: 'ICU activity sync',
  },
  {
    name: WELLNESS_SYNC_JOB,
    queue: ICU_SYNC_QUEUE,
    kind: 'every',
    schedule: 'ICU_WELLNESS_SYNC_EVERY_MIN',
    owner: 'ICU wellness sync',
  },
  {
    name: PLAN_RECONCILE_JOB,
    queue: ICU_SYNC_QUEUE,
    kind: 'every',
    schedule: 'ICU_PLAN_RECONCILE_EVERY_MIN',
    owner: 'Planned workout push',
  },
  {
    name: SEASON_PUBLISH_JOB,
    queue: ICU_SYNC_QUEUE,
    kind: 'every',
    schedule: 'SEASON_PUBLISH_EVERY_MIN',
    owner: 'Seasons',
  },
  {
    name: DAILY_BRIEF_JOB,
    queue: DAILY_BRIEF_QUEUE,
    kind: 'cron',
    schedule: 'Profile.briefTime ?? DAILY_BRIEF_DEFAULT_TIME',
    owner: 'Morning brief',
  },
  {
    name: DAILY_BRIEF_CONTINUE_JOB,
    queue: DAILY_BRIEF_QUEUE,
    kind: 'oneoff',
    schedule: 'DAILY_CHECKIN_TIMEOUT_MINUTES',
    owner: 'Morning brief',
  },
  {
    name: EVENING_CLOSEOUT_JOB,
    queue: EVENING_CLOSEOUT_QUEUE,
    kind: 'cron',
    schedule: 'Profile.closeoutTime ?? EVENING_CLOSEOUT_DEFAULT_TIME',
    owner: 'TA-40 Evening close-out',
  },
  {
    name: WEEKLY_STATS_JOB,
    queue: WEEKLY_STATS_QUEUE,
    kind: 'cron',
    schedule: 'WEEKLY_STATS_TIME (Monday)',
    owner: 'Weekly stats',
  },
  {
    name: WEEKLY_REVIEW_JOB,
    queue: WEEKLY_REVIEW_QUEUE,
    kind: 'cron',
    schedule: 'WEEKLY_REVIEW_TIME (Sunday)',
    owner: 'Weekly review',
  },
  {
    name: BLOCK_REVIEW_JOB,
    queue: BLOCK_REVIEW_QUEUE,
    kind: 'cron',
    schedule: 'BLOCK_REVIEW_TIME (Sunday)',
    owner: 'Block review',
  },
  {
    name: BLOCK_REVIEW_RACE_MOVE_JOB,
    queue: BLOCK_REVIEW_QUEUE,
    kind: 'oneoff',
    schedule: '/race move',
    owner: 'Block review',
  },
  {
    name: RACE_BRIEF_JOB,
    queue: RACE_BRIEF_QUEUE,
    kind: 'cron',
    schedule: 'RACE_BRIEF_TIME',
    owner: 'TA-48 Race briefs',
  },
  {
    name: POST_RACE_JOB,
    queue: POST_RACE_QUEUE,
    kind: 'cron',
    schedule: 'POST_RACE_TIME',
    owner: 'TA-49 Post-race',
  },
];

/** Queue names that appear in the registry, in first-seen order */
export function registeredQueues(registry: readonly JobDef[] = JOB_REGISTRY): string[] {
  return [...new Set(registry.map((job) => job.queue))];
}

export function registeredJobNames(
  queue: string,
  registry: readonly JobDef[] = JOB_REGISTRY
): ReadonlySet<string> {
  return new Set(registry.filter((job) => job.queue === queue).map((job) => job.name));
}

import type { Queue } from 'bullmq';
import type { IcuSyncJob } from '@triathlon/core';

export const ICU_SYNC_QUEUE = 'icu-sync';
export const ACTIVITY_SYNC_JOB = 'icu-activity-sync';
export const WELLNESS_SYNC_JOB = 'icu-wellness-sync';

export type IcuSyncJobName = typeof ACTIVITY_SYNC_JOB | typeof WELLNESS_SYNC_JOB;

/** One repeatable job kind on the icu-sync queue and how often it runs. */
export interface IcuSyncJobSpec {
  job: IcuSyncJobName;
  everyMs: number;
}

export function syncSchedulerId(job: IcuSyncJobName, userId: string): string {
  return `${job}:${userId}`;
}

/** Keeps one repeatable job per sync kind (activities, wellness) per linked athlete. */
export interface IcuSyncScheduler {
  schedule(userId: string): Promise<void>;
  unschedule(userId: string): Promise<void>;
}

type SyncQueue = Pick<
  Queue<IcuSyncJob>,
  'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'
>;

export function createIcuSyncScheduler(queue: SyncQueue, jobs: IcuSyncJobSpec[]): IcuSyncScheduler {
  return {
    async schedule(userId) {
      // An `every` scheduler runs its first job immediately: that is the initial backfill
      for (const { job, everyMs } of jobs) {
        await queue.upsertJobScheduler(
          syncSchedulerId(job, userId),
          { every: everyMs },
          {
            name: job,
            data: { userId },
            opts: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: { age: 3600, count: 100 },
              removeOnFail: { age: 86400 },
            },
          }
        );
      }
    },
    async unschedule(userId) {
      for (const { job } of jobs) {
        await queue.removeJobScheduler(syncSchedulerId(job, userId));
      }
    },
  };
}

/**
 * Worker startup: schedules every linked athlete that is missing a scheduler (or has a
 * stale interval) for any job kind, and removes schedulers whose connection is gone.
 */
export async function reconcileSchedulers(
  queue: SyncQueue,
  scheduler: IcuSyncScheduler,
  connectedUserIds: string[],
  jobs: IcuSyncJobSpec[]
): Promise<{ scheduled: number; removed: number }> {
  const existing = await queue.getJobSchedulers();
  const everyByKey = new Map(existing.map((s) => [s.key, s.every]));
  const connected = new Set(connectedUserIds);

  let scheduled = 0;
  for (const userId of connected) {
    const stale = jobs.some(
      ({ job, everyMs }) => everyByKey.get(syncSchedulerId(job, userId)) !== everyMs
    );
    if (stale) {
      await scheduler.schedule(userId);
      scheduled++;
    }
  }

  const orphans = new Set<string>();
  for (const { key } of existing) {
    for (const { job } of jobs) {
      const prefix = `${job}:`;
      if (key.startsWith(prefix) && !connected.has(key.slice(prefix.length))) {
        orphans.add(key.slice(prefix.length));
      }
    }
  }
  for (const userId of orphans) await scheduler.unschedule(userId);

  return { scheduled, removed: orphans.size };
}

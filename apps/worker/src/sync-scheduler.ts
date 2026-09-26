import type { Queue } from 'bullmq';
import type { IcuSyncJob } from '@triathlon/core';

export const ACTIVITY_SYNC_QUEUE = 'icu-sync';
export const ACTIVITY_SYNC_JOB = 'icu-activity-sync';

export function activitySyncSchedulerId(userId: string): string {
  return `${ACTIVITY_SYNC_JOB}:${userId}`;
}

/** Keeps one repeatable activity sync per linked athlete. */
export interface ActivitySyncScheduler {
  schedule(userId: string): Promise<void>;
  unschedule(userId: string): Promise<void>;
}

type SyncQueue = Pick<
  Queue<IcuSyncJob>,
  'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'
>;

export function createActivitySyncScheduler(
  queue: SyncQueue,
  everyMs: number
): ActivitySyncScheduler {
  return {
    async schedule(userId) {
      // An `every` scheduler runs its first job immediately: that is the initial backfill
      await queue.upsertJobScheduler(
        activitySyncSchedulerId(userId),
        { every: everyMs },
        {
          name: ACTIVITY_SYNC_JOB,
          data: { userId },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { age: 3600, count: 100 },
            removeOnFail: { age: 86400 },
          },
        }
      );
    },
    async unschedule(userId) {
      await queue.removeJobScheduler(activitySyncSchedulerId(userId));
    },
  };
}

/**
 * Worker startup: schedules every linked athlete that has no scheduler (or a stale
 * interval) and removes schedulers whose connection is gone.
 */
export async function reconcileSchedulers(
  queue: SyncQueue,
  scheduler: ActivitySyncScheduler,
  connectedUserIds: string[],
  everyMs: number
): Promise<{ scheduled: number; removed: number }> {
  const existing = await queue.getJobSchedulers();
  const prefix = `${ACTIVITY_SYNC_JOB}:`;
  const byUser = new Map(
    existing.filter((s) => s.key.startsWith(prefix)).map((s) => [s.key.slice(prefix.length), s])
  );
  const connected = new Set(connectedUserIds);

  let scheduled = 0;
  for (const userId of connected) {
    if (byUser.get(userId)?.every !== everyMs) {
      await scheduler.schedule(userId);
      scheduled++;
    }
  }

  let removed = 0;
  for (const userId of byUser.keys()) {
    if (!connected.has(userId)) {
      await scheduler.unschedule(userId);
      removed++;
    }
  }

  return { scheduled, removed };
}

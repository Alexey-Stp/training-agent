import type { ProfileRescheduleJob } from '@triathlon/core';
import type { IcuConnectionRepo } from './icu-connect';
import type { IcuSyncScheduler } from './sync-scheduler';

export interface ProfileRescheduleDeps {
  connections: Pick<IcuConnectionRepo, 'findByUserId'>;
  /** Every per-connection scheduler (the same combination /connect icu registers) */
  scheduler: IcuSyncScheduler;
}

/**
 * After a dashboard settings change: re-upsert the athlete's schedulers so the next brief,
 * close-out and reviews use the new time, timezone and chat. Schedulers exist only for linked
 * athletes, so an unlinked athlete has nothing to do.
 */
export async function processProfileReschedule(
  job: ProfileRescheduleJob,
  deps: ProfileRescheduleDeps
): Promise<{ rescheduled: boolean }> {
  const connection = await deps.connections.findByUserId(job.userId);
  if (!connection) return { rescheduled: false };
  await deps.scheduler.schedule(job.userId);
  return { rescheduled: true };
}

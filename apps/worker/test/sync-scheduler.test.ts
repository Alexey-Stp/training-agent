import { describe, it, expect, vi } from 'vitest';
import {
  PLAN_RECONCILE_JOB,
  createIcuSyncScheduler,
  reconcileSchedulers,
  syncSchedulerId,
  type IcuSyncJobSpec,
} from '../src/sync-scheduler';

const ACTIVITY_EVERY_MS = 30 * 60_000;
const WELLNESS_EVERY_MS = 24 * 60 * 60_000;
const JOBS: IcuSyncJobSpec[] = [
  { job: 'icu-activity-sync', everyMs: ACTIVITY_EVERY_MS },
  { job: 'icu-wellness-sync', everyMs: WELLNESS_EVERY_MS },
];

function fakeQueue(existing: { key: string; every?: number }[] = []) {
  return {
    upsertJobScheduler: vi.fn(() => Promise.resolve()),
    removeJobScheduler: vi.fn(() => Promise.resolve(true)),
    getJobSchedulers: vi.fn(() =>
      Promise.resolve(existing.map((s) => ({ name: s.key.split(':')[0], ...s })))
    ),
  };
}

type SchedulerQueue = Parameters<typeof createIcuSyncScheduler>[0];

/** Both schedulers of a user, both up to date. */
function current(userId: string) {
  return [
    { key: `icu-activity-sync:${userId}`, every: ACTIVITY_EVERY_MS },
    { key: `icu-wellness-sync:${userId}`, every: WELLNESS_EVERY_MS },
  ];
}

describe('createIcuSyncScheduler', () => {
  it('upserts one repeatable job per sync kind with retries', async () => {
    const queue = fakeQueue();
    await createIcuSyncScheduler(queue as unknown as SchedulerQueue, JOBS).schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'icu-activity-sync:u1',
      { every: ACTIVITY_EVERY_MS },
      expect.objectContaining({
        name: 'icu-activity-sync',
        data: { userId: 'u1' },
        opts: expect.objectContaining({ attempts: 3 }) as unknown,
      })
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'icu-wellness-sync:u1',
      { every: WELLNESS_EVERY_MS },
      expect.objectContaining({ name: 'icu-wellness-sync', data: { userId: 'u1' } })
    );
  });

  it('unschedule removes both athlete schedulers', async () => {
    const queue = fakeQueue();
    await createIcuSyncScheduler(queue as unknown as SchedulerQueue, JOBS).unschedule('u1');
    expect(queue.removeJobScheduler.mock.calls).toEqual([
      [syncSchedulerId('icu-activity-sync', 'u1')],
      [syncSchedulerId('icu-wellness-sync', 'u1')],
    ]);
  });
});

describe('reconcileSchedulers', () => {
  it('adds missing/stale schedulers and removes orphaned ones', async () => {
    const queue = fakeQueue([
      ...current('kept'),
      { key: 'icu-activity-sync:stale', every: 60_000 },
      { key: 'icu-wellness-sync:stale', every: WELLNESS_EVERY_MS },
      // Linked before wellness sync existed: activity scheduler only
      { key: 'icu-activity-sync:no-wellness', every: ACTIVITY_EVERY_MS },
      ...current('gone'),
      { key: 'icu-wellness-sync:gone-too', every: WELLNESS_EVERY_MS },
      { key: 'something-else', every: ACTIVITY_EVERY_MS },
    ]);
    const scheduler = {
      schedule: vi.fn(() => Promise.resolve()),
      unschedule: vi.fn(() => Promise.resolve()),
    };

    const result = await reconcileSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['kept', 'stale', 'no-wellness', 'new'],
      JOBS
    );

    expect(result).toEqual({ scheduled: 3, removed: 2 });
    expect(scheduler.schedule.mock.calls).toEqual([['stale'], ['no-wellness'], ['new']]);
    expect(scheduler.unschedule.mock.calls).toEqual([['gone'], ['gone-too']]);
  });

  it('schedules the plan reconcile job for athletes linked before it existed', async () => {
    const PLAN_EVERY_MS = 60 * 60_000;
    const jobs: IcuSyncJobSpec[] = [...JOBS, { job: PLAN_RECONCILE_JOB, everyMs: PLAN_EVERY_MS }];
    const queue = fakeQueue([
      ...current('old'),
      ...current('up-to-date'),
      { key: 'icu-plan-reconcile:up-to-date', every: PLAN_EVERY_MS },
      { key: 'icu-plan-reconcile:gone', every: PLAN_EVERY_MS },
    ]);
    const scheduler = createIcuSyncScheduler(queue as unknown as SchedulerQueue, jobs);

    const result = await reconcileSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['old', 'up-to-date'],
      jobs
    );

    expect(result).toEqual({ scheduled: 1, removed: 1 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'icu-plan-reconcile:old',
      { every: PLAN_EVERY_MS },
      expect.objectContaining({ name: 'icu-plan-reconcile', data: { userId: 'old' } })
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('icu-plan-reconcile:gone');
  });
});

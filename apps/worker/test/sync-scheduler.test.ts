import { describe, it, expect, vi } from 'vitest';
import {
  createActivitySyncScheduler,
  reconcileSchedulers,
  activitySyncSchedulerId,
} from '../src/sync-scheduler';

const EVERY_MS = 30 * 60_000;

function fakeQueue(existing: { key: string; every?: number }[] = []) {
  return {
    upsertJobScheduler: vi.fn(() => Promise.resolve()),
    removeJobScheduler: vi.fn(() => Promise.resolve(true)),
    getJobSchedulers: vi.fn(() =>
      Promise.resolve(existing.map((s) => ({ name: 'icu-activity-sync', ...s })))
    ),
  };
}

type SchedulerQueue = Parameters<typeof createActivitySyncScheduler>[0];

describe('createActivitySyncScheduler', () => {
  it('upserts a per-athlete repeatable job with retries', async () => {
    const queue = fakeQueue();
    await createActivitySyncScheduler(queue as unknown as SchedulerQueue, EVERY_MS).schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'icu-activity-sync:u1',
      { every: EVERY_MS },
      expect.objectContaining({
        name: 'icu-activity-sync',
        data: { userId: 'u1' },
        opts: expect.objectContaining({ attempts: 3 }) as unknown,
      })
    );
  });

  it('unschedule removes the athlete scheduler', async () => {
    const queue = fakeQueue();
    await createActivitySyncScheduler(queue as unknown as SchedulerQueue, EVERY_MS).unschedule(
      'u1'
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(activitySyncSchedulerId('u1'));
  });
});

describe('reconcileSchedulers', () => {
  it('adds missing/stale schedulers and removes orphaned ones', async () => {
    const queue = fakeQueue([
      { key: 'icu-activity-sync:kept', every: EVERY_MS },
      { key: 'icu-activity-sync:stale', every: 60_000 },
      { key: 'icu-activity-sync:gone', every: EVERY_MS },
      { key: 'something-else', every: EVERY_MS },
    ]);
    const scheduler = {
      schedule: vi.fn(() => Promise.resolve()),
      unschedule: vi.fn(() => Promise.resolve()),
    };

    const result = await reconcileSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['kept', 'stale', 'new'],
      EVERY_MS
    );

    expect(result).toEqual({ scheduled: 2, removed: 1 });
    expect(scheduler.schedule.mock.calls).toEqual([['stale'], ['new']]);
    expect(scheduler.unschedule.mock.calls).toEqual([['gone']]);
  });
});

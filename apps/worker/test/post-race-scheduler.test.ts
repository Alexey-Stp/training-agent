import { describe, expect, it, vi } from 'vitest';
import { createPostRaceScheduler, reconcilePostRaceSchedulers } from '../src/daily-loop/scheduler';
import type { IcuSyncScheduler } from '../src/sync-scheduler';
import { fakeQueue, PRAGUE, schedulerDeps } from './scheduler-fakes';

type SchedulerQueue = Parameters<typeof createPostRaceScheduler>[0];

const asQueue = (queue: ReturnType<typeof fakeQueue>) => queue as unknown as SchedulerQueue;

describe('post-race schedulers', () => {
  it('upserts a daily cron at POST_RACE_TIME, not the morning brief time', async () => {
    const queue = fakeQueue();
    const scheduler = createPostRaceScheduler(
      asQueue(queue),
      schedulerDeps({ u1: PRAGUE }, '09:30')
    );

    await scheduler.schedule('u1');
    await scheduler.unschedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'post-race:u1',
      { pattern: '30 9 * * *', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'post-race', data: { userId: 'u1' } })
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('post-race:u1');
  });

  it('reconcile reschedules a changed time and leaves other schedulers alone', async () => {
    const queue = fakeQueue([
      { key: 'post-race:ok', pattern: '30 9 * * *', tz: 'Europe/Prague' },
      { key: 'post-race:moved', pattern: '0 8 * * *', tz: 'Europe/Prague' },
      { key: 'post-race:gone', pattern: '30 9 * * *', tz: 'Europe/Prague' },
      { key: 'race-brief:other', pattern: '0 9 * * *', tz: 'Europe/Prague' },
    ]);
    const scheduler: IcuSyncScheduler & { unschedule: ReturnType<typeof vi.fn> } = {
      schedule: vi.fn(() => Promise.resolve()),
      unschedule: vi.fn(() => Promise.resolve()),
    };

    const result = await reconcilePostRaceSchedulers(
      asQueue(queue),
      scheduler,
      ['ok', 'moved', 'new'],
      schedulerDeps({ ok: PRAGUE, moved: PRAGUE, new: PRAGUE }, '09:30')
    );

    expect(scheduler.schedule).toHaveBeenCalledWith('moved');
    expect(scheduler.schedule).toHaveBeenCalledWith('new');
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
    expect(result).toEqual({ scheduled: 2, removed: 1 });
  });
});

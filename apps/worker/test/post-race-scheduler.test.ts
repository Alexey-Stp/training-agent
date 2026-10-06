import { describe, expect, it, vi } from 'vitest';
import {
  createPostRaceScheduler,
  reconcilePostRaceSchedulers,
  type BriefProfile,
  type DailyBriefSchedulerDeps,
} from '../src/daily-loop/scheduler';
import type { IcuSyncScheduler } from '../src/sync-scheduler';

interface ExistingScheduler {
  key: string;
  pattern?: string;
  tz?: string;
}

function fakeQueue(existing: ExistingScheduler[] = []) {
  return {
    upsertJobScheduler: vi.fn(() => Promise.resolve()),
    removeJobScheduler: vi.fn(() => Promise.resolve(true)),
    getJobSchedulers: vi.fn(() =>
      Promise.resolve(existing.map((s) => ({ name: s.key.split(':')[0], ...s })))
    ),
  };
}

type SchedulerQueue = Parameters<typeof createPostRaceScheduler>[0];

const PRAGUE: BriefProfile = {
  telegramChatId: 1001,
  timezone: 'Europe/Prague',
  briefTime: '06:00',
  closeoutTime: null,
};

function schedulerDeps(
  profiles: Record<string, BriefProfile>,
  defaultTime = '09:30'
): DailyBriefSchedulerDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    defaultTime,
  };
}

describe('createPostRaceScheduler', () => {
  it('upserts a daily cron at POST_RACE_TIME, not the morning brief time', async () => {
    const queue = fakeQueue();
    const scheduler = createPostRaceScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: PRAGUE })
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'post-race:u1',
      { pattern: '30 9 * * *', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'post-race', data: { userId: 'u1' } })
    );
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createPostRaceScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({})
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('post-race:u1');
  });
});

describe('reconcilePostRaceSchedulers', () => {
  it('reschedules a changed time and leaves other schedulers alone', async () => {
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
      queue as unknown as SchedulerQueue,
      scheduler,
      ['ok', 'moved', 'new'],
      schedulerDeps({ ok: PRAGUE, moved: PRAGUE, new: PRAGUE })
    );

    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    expect(scheduler.schedule).toHaveBeenCalledWith('moved');
    expect(scheduler.schedule).toHaveBeenCalledWith('new');
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
    expect(result).toEqual({ scheduled: 2, removed: 1 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createRaceBriefScheduler,
  reconcileRaceBriefSchedulers,
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

type SchedulerQueue = Parameters<typeof createRaceBriefScheduler>[0];

const PRAGUE: BriefProfile = {
  telegramChatId: 1001,
  timezone: 'Europe/Prague',
  briefTime: '06:00',
  closeoutTime: null,
};

function schedulerDeps(
  profiles: Record<string, BriefProfile>,
  defaultTime = '09:00'
): DailyBriefSchedulerDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    defaultTime,
  };
}

describe('createRaceBriefScheduler', () => {
  it('upserts a daily cron at RACE_BRIEF_TIME, not the morning brief time', async () => {
    const queue = fakeQueue();
    const scheduler = createRaceBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: PRAGUE })
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'race-brief:u1',
      { pattern: '0 9 * * *', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'race-brief', data: { userId: 'u1' } })
    );
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createRaceBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({})
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('race-brief:u1');
  });
});

describe('reconcileRaceBriefSchedulers', () => {
  it('reschedules a changed time and leaves other schedulers alone', async () => {
    const queue = fakeQueue([
      { key: 'race-brief:ok', pattern: '0 9 * * *', tz: 'Europe/Prague' },
      { key: 'race-brief:moved', pattern: '0 8 * * *', tz: 'Europe/Prague' },
      { key: 'race-brief:gone', pattern: '0 9 * * *', tz: 'Europe/Prague' },
      { key: 'daily-brief:other', pattern: '30 6 * * *', tz: 'Europe/Prague' },
    ]);
    const scheduler: IcuSyncScheduler & { unschedule: ReturnType<typeof vi.fn> } = {
      schedule: vi.fn(() => Promise.resolve()),
      unschedule: vi.fn(() => Promise.resolve()),
    };

    const result = await reconcileRaceBriefSchedulers(
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

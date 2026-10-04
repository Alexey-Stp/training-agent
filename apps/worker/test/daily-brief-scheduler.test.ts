import { describe, expect, it, vi } from 'vitest';
import {
  briefCron,
  combineSchedulers,
  createDailyBriefScheduler,
  dailyBriefSchedulerId,
  reconcileDailyBriefSchedulers,
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

type SchedulerQueue = Parameters<typeof createDailyBriefScheduler>[0];

const PRAGUE: BriefProfile = { telegramChatId: 1001, timezone: 'Europe/Prague', briefTime: null };

function schedulerDeps(profiles: Record<string, BriefProfile>): DailyBriefSchedulerDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    defaultTime: '06:30',
  };
}

function fakeScheduler(): IcuSyncScheduler & {
  schedule: ReturnType<typeof vi.fn>;
  unschedule: ReturnType<typeof vi.fn>;
} {
  return {
    schedule: vi.fn(() => Promise.resolve()),
    unschedule: vi.fn(() => Promise.resolve()),
  };
}

describe('briefCron', () => {
  it.each([
    ['06:30', '30 6 * * *'],
    ['00:00', '0 0 * * *'],
    ['23:05', '5 23 * * *'],
    ['07:00', '0 7 * * *'],
  ])('%s → %s', (time, cron) => {
    expect(briefCron(time)).toBe(cron);
  });
});

describe('createDailyBriefScheduler', () => {
  it('upserts a daily cron in the athlete timezone, defaulting to 06:30', async () => {
    const queue = fakeQueue();
    const scheduler = createDailyBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: PRAGUE })
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'daily-brief:u1',
      { pattern: '30 6 * * *', tz: 'Europe/Prague' },
      expect.objectContaining({
        name: 'daily-brief',
        data: { userId: 'u1' },
        opts: expect.objectContaining({ attempts: 3 }) as unknown,
      })
    );
  });

  it("uses the athlete's briefTime and timezone", async () => {
    const queue = fakeQueue();
    const profile: BriefProfile = {
      telegramChatId: 1,
      timezone: 'America/New_York',
      briefTime: '05:45',
    };
    const scheduler = createDailyBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: profile })
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'daily-brief:u1',
      { pattern: '45 5 * * *', tz: 'America/New_York' },
      expect.anything()
    );
  });

  it('schedules nothing without a profile', async () => {
    const queue = fakeQueue();
    const scheduler = createDailyBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({})
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createDailyBriefScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({})
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith(dailyBriefSchedulerId('u1'));
  });
});

describe('reconcileDailyBriefSchedulers', () => {
  const current = { pattern: '30 6 * * *', tz: 'Europe/Prague' };

  it('schedules missing athletes and leaves up-to-date ones alone', async () => {
    const queue = fakeQueue([{ key: 'daily-brief:ok', ...current }]);
    const scheduler = fakeScheduler();

    const result = await reconcileDailyBriefSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['ok', 'new'],
      schedulerDeps({ ok: PRAGUE, new: PRAGUE })
    );

    expect(result).toEqual({ scheduled: 1, removed: 0 });
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule).toHaveBeenCalledWith('new');
  });

  it('reschedules when the brief time or timezone changed', async () => {
    const queue = fakeQueue([
      { key: 'daily-brief:moved-time', ...current },
      { key: 'daily-brief:moved-tz', ...current },
    ]);
    const scheduler = fakeScheduler();

    const result = await reconcileDailyBriefSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['moved-time', 'moved-tz'],
      schedulerDeps({
        'moved-time': { ...PRAGUE, briefTime: '07:15' },
        'moved-tz': { ...PRAGUE, timezone: 'Europe/London' },
      })
    );

    expect(result).toEqual({ scheduled: 2, removed: 0 });
  });

  it('removes schedulers of athletes no longer connected and ignores other queues', async () => {
    const queue = fakeQueue([
      { key: 'daily-brief:gone', ...current },
      { key: 'icu-activity-sync:gone' },
    ]);
    const scheduler = fakeScheduler();

    const result = await reconcileDailyBriefSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      [],
      schedulerDeps({})
    );

    expect(result).toEqual({ scheduled: 0, removed: 1 });
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
  });

  it('skips connected athletes without a profile', async () => {
    const scheduler = fakeScheduler();

    const result = await reconcileDailyBriefSchedulers(
      fakeQueue() as unknown as SchedulerQueue,
      scheduler,
      ['no-profile'],
      schedulerDeps({})
    );

    expect(result).toEqual({ scheduled: 0, removed: 0 });
  });
});

describe('combineSchedulers', () => {
  it('runs every scheduler', async () => {
    const a = fakeScheduler();
    const b = fakeScheduler();

    await combineSchedulers(a, b).schedule('u1');
    await combineSchedulers(a, b).unschedule('u1');

    expect(a.schedule).toHaveBeenCalledWith('u1');
    expect(b.schedule).toHaveBeenCalledWith('u1');
    expect(a.unschedule).toHaveBeenCalledWith('u1');
    expect(b.unschedule).toHaveBeenCalledWith('u1');
  });

  it('still runs the others when one fails, then reports the failure', async () => {
    const a = fakeScheduler();
    a.schedule.mockRejectedValue(new Error('redis down'));
    const b = fakeScheduler();

    await expect(combineSchedulers(a, b).schedule('u1')).rejects.toThrow('redis down');
    expect(b.schedule).toHaveBeenCalledWith('u1');
  });
});

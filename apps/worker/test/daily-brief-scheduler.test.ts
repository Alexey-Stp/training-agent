import { describe, expect, it, vi } from 'vitest';
import {
  briefCron,
  checkInContinuationJobId,
  combineSchedulers,
  createCheckInContinuation,
  createDailyBriefScheduler,
  createEveningCloseoutScheduler,
  createWeeklyReviewScheduler,
  createWeeklyStatsScheduler,
  dailyBriefSchedulerId,
  eveningCloseoutSchedulerId,
  reconcileDailyBriefSchedulers,
  reconcileEveningCloseoutSchedulers,
  reconcileWeeklyReviewSchedulers,
  reconcileWeeklyStatsSchedulers,
  weeklyCron,
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

const PRAGUE: BriefProfile = {
  telegramChatId: 1001,
  timezone: 'Europe/Prague',
  briefTime: null,
  closeoutTime: null,
};

function schedulerDeps(
  profiles: Record<string, BriefProfile>,
  defaultTime = '06:30'
): DailyBriefSchedulerDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    defaultTime,
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
      closeoutTime: null,
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

describe('createCheckInContinuation', () => {
  function continuationQueue(job: { delayed: boolean } | null = null) {
    const promote = vi.fn(() => Promise.resolve());
    const queue = {
      add: vi.fn(() => Promise.resolve()),
      getJob: vi.fn(() =>
        Promise.resolve(job ? { isDelayed: () => Promise.resolve(job.delayed), promote } : null)
      ),
    };
    return { queue, promote };
  }

  type ContinuationQueue = Parameters<typeof createCheckInContinuation>[0];

  it('queues one delayed continuation per athlete and day', async () => {
    const { queue } = continuationQueue();
    await createCheckInContinuation(queue as unknown as ContinuationQueue, 900_000).schedule(
      'u1',
      '2026-10-05'
    );

    expect(queue.add).toHaveBeenCalledWith(
      'daily-brief-continue',
      { userId: 'u1', checkInDate: '2026-10-05' },
      expect.objectContaining({ jobId: 'checkin-u1-2026-10-05', delay: 900_000, attempts: 3 })
    );
  });

  it('uses a job id without colons (BullMQ rejects them)', () => {
    expect(checkInContinuationJobId('cmg1x2', '2026-10-05')).not.toContain(':');
  });

  it('promotes the delayed continuation on resume', async () => {
    const { queue, promote } = continuationQueue({ delayed: true });
    await createCheckInContinuation(queue as unknown as ContinuationQueue, 900_000).resume(
      'u1',
      '2026-10-05'
    );

    expect(queue.getJob).toHaveBeenCalledWith('checkin-u1-2026-10-05');
    expect(promote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['already ran or is running', { delayed: false }],
    ['is gone', null],
  ])('does nothing when the continuation %s', async (_, job) => {
    const { queue, promote } = continuationQueue(job);
    await createCheckInContinuation(queue as unknown as ContinuationQueue, 900_000).resume(
      'u1',
      '2026-10-05'
    );

    expect(promote).not.toHaveBeenCalled();
  });
});

describe('createEveningCloseoutScheduler', () => {
  it('upserts a daily cron in the athlete timezone, defaulting to 20:30', async () => {
    const queue = fakeQueue();
    const scheduler = createEveningCloseoutScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: PRAGUE }, '20:30')
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'evening-closeout:u1',
      { pattern: '30 20 * * *', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'evening-closeout', data: { userId: 'u1' } })
    );
  });

  it("uses the athlete's closeoutTime, not the briefTime", async () => {
    const queue = fakeQueue();
    const profile: BriefProfile = { ...PRAGUE, briefTime: '05:45', closeoutTime: '21:15' };
    const scheduler = createEveningCloseoutScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: profile }, '20:30')
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'evening-closeout:u1',
      { pattern: '15 21 * * *', tz: 'Europe/Prague' },
      expect.anything()
    );
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createEveningCloseoutScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({}, '20:30')
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith(eveningCloseoutSchedulerId('u1'));
  });
});

describe('reconcileEveningCloseoutSchedulers', () => {
  it('schedules stale athletes and removes only close-out orphans', async () => {
    const queue = fakeQueue([
      { key: 'evening-closeout:ok', pattern: '30 20 * * *', tz: 'Europe/Prague' },
      { key: 'evening-closeout:gone', pattern: '30 20 * * *', tz: 'Europe/Prague' },
      { key: 'daily-brief:gone', pattern: '30 6 * * *', tz: 'Europe/Prague' },
    ]);
    const scheduler = fakeScheduler();

    const result = await reconcileEveningCloseoutSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['ok', 'new'],
      schedulerDeps({ ok: PRAGUE, new: PRAGUE }, '20:30')
    );

    expect(result).toEqual({ scheduled: 1, removed: 1 });
    expect(scheduler.schedule).toHaveBeenCalledWith('new');
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
  });
});

describe('weeklyCron', () => {
  it('fires on Mondays at the given wall-clock time', () => {
    expect(weeklyCron('06:00')).toBe('0 6 * * 1');
    expect(weeklyCron('21:45')).toBe('45 21 * * 1');
  });

  it('fires on another weekday when given one', () => {
    expect(weeklyCron('19:00', 0)).toBe('0 19 * * 0');
  });
});

describe('createWeeklyReviewScheduler', () => {
  it('upserts a Sunday cron at WEEKLY_REVIEW_TIME in the athlete timezone', async () => {
    const queue = fakeQueue();
    const scheduler = createWeeklyReviewScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: PRAGUE }, '19:00')
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'weekly-review:u1',
      { pattern: '0 19 * * 0', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'weekly-review', data: { userId: 'u1' } })
    );
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createWeeklyReviewScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({}, '19:00')
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('weekly-review:u1');
  });
});

describe('reconcileWeeklyReviewSchedulers', () => {
  it('reschedules a changed time and leaves the weekly stats schedulers alone', async () => {
    const queue = fakeQueue([
      { key: 'weekly-review:ok', pattern: '0 19 * * 0', tz: 'Europe/Prague' },
      { key: 'weekly-review:moved', pattern: '0 19 * * 1', tz: 'Europe/Prague' },
      { key: 'weekly-review:gone', pattern: '0 19 * * 0', tz: 'Europe/Prague' },
      { key: 'weekly-stats:gone', pattern: '0 6 * * 1', tz: 'Europe/Prague' },
    ]);
    const scheduler = fakeScheduler();

    const result = await reconcileWeeklyReviewSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['ok', 'moved'],
      schedulerDeps({ ok: PRAGUE, moved: PRAGUE }, '19:00')
    );

    expect(result).toEqual({ scheduled: 1, removed: 1 });
    expect(scheduler.schedule).toHaveBeenCalledWith('moved');
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
  });
});

describe('createWeeklyStatsScheduler', () => {
  it('upserts a Monday cron at WEEKLY_STATS_TIME in the athlete timezone', async () => {
    const queue = fakeQueue();
    const profile: BriefProfile = { ...PRAGUE, briefTime: '05:45', closeoutTime: '21:15' };
    const scheduler = createWeeklyStatsScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({ u1: profile }, '06:00')
    );

    await scheduler.schedule('u1');

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'weekly-stats:u1',
      { pattern: '0 6 * * 1', tz: 'Europe/Prague' },
      expect.objectContaining({ name: 'weekly-stats', data: { userId: 'u1' } })
    );
  });

  it('removes the scheduler on unschedule', async () => {
    const queue = fakeQueue();
    const scheduler = createWeeklyStatsScheduler(
      queue as unknown as SchedulerQueue,
      schedulerDeps({}, '06:00')
    );

    await scheduler.unschedule('u1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('weekly-stats:u1');
  });
});

describe('reconcileWeeklyStatsSchedulers', () => {
  it('reschedules a changed time and removes only weekly-stats orphans', async () => {
    const queue = fakeQueue([
      { key: 'weekly-stats:ok', pattern: '0 6 * * 1', tz: 'Europe/Prague' },
      { key: 'weekly-stats:moved', pattern: '0 7 * * 1', tz: 'Europe/Prague' },
      { key: 'weekly-stats:gone', pattern: '0 6 * * 1', tz: 'Europe/Prague' },
      { key: 'evening-closeout:gone', pattern: '30 20 * * *', tz: 'Europe/Prague' },
    ]);
    const scheduler = fakeScheduler();

    const result = await reconcileWeeklyStatsSchedulers(
      queue as unknown as SchedulerQueue,
      scheduler,
      ['ok', 'moved'],
      schedulerDeps({ ok: PRAGUE, moved: PRAGUE }, '06:00')
    );

    expect(result).toEqual({ scheduled: 1, removed: 1 });
    expect(scheduler.schedule).toHaveBeenCalledWith('moved');
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.unschedule).toHaveBeenCalledWith('gone');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { processProfileReschedule } from '../src/profile-reschedule';
import type { IcuConnectionRecord } from '../src/icu-connect';

function deps(connected: boolean) {
  const scheduler = { schedule: vi.fn(() => Promise.resolve()), unschedule: vi.fn() };
  const connections = {
    findByUserId: () =>
      Promise.resolve(connected ? ({ userId: 'u1' } as unknown as IcuConnectionRecord) : null),
  };
  return { scheduler, connections };
}

describe('processProfileReschedule', () => {
  it('re-registers the schedulers of a linked athlete', async () => {
    const d = deps(true);
    expect(await processProfileReschedule({ userId: 'u1' }, d)).toEqual({ rescheduled: true });
    expect(d.scheduler.schedule).toHaveBeenCalledWith('u1');
  });

  it('does nothing for an athlete without an intervals.icu link', async () => {
    const d = deps(false);
    expect(await processProfileReschedule({ userId: 'u1' }, d)).toEqual({ rescheduled: false });
    expect(d.scheduler.schedule).not.toHaveBeenCalled();
  });
});

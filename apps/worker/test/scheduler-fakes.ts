import { vi } from 'vitest';
import type { BriefProfile, DailyBriefSchedulerDeps } from '../src/daily-loop/scheduler';

export interface ExistingScheduler {
  key: string;
  pattern?: string;
  tz?: string;
}

/** A BullMQ queue double that only knows its job schedulers. */
export function fakeQueue(existing: ExistingScheduler[] = []) {
  return {
    upsertJobScheduler: vi.fn(() => Promise.resolve()),
    removeJobScheduler: vi.fn(() => Promise.resolve(true)),
    getJobSchedulers: vi.fn(() =>
      Promise.resolve(existing.map((s) => ({ name: s.key.split(':')[0], ...s })))
    ),
  };
}

export const PRAGUE: BriefProfile = {
  telegramChatId: 1001,
  timezone: 'Europe/Prague',
  briefTime: '06:00',
  closeoutTime: null,
};

export function schedulerDeps(
  profiles: Record<string, BriefProfile>,
  defaultTime: string
): DailyBriefSchedulerDeps {
  return {
    profiles: { findBriefProfile: (userId) => Promise.resolve(profiles[userId] ?? null) },
    defaultTime,
  };
}

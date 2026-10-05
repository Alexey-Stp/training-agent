import { describe, it, expect } from 'vitest';
import { buildWorkoutSteps, Intensity, Sport, type PlannedSessionDraft } from '@triathlon/core';
import { handlePlanToday, MSG_NOTHING_STORED_TODAY } from '../src/plan-today';
import { MSG_NO_PROFILE } from '../src/profile';
import { MemoryPlanRepo, USER_ID } from './planned-session-fakes';

// 00:30 on Tuesday in Prague, still Monday in UTC
const NOW = new Date('2026-10-05T22:30:00Z');
const USER = { id: USER_ID, profile: { timezone: 'Europe/Prague' } };

function draft(date: string, slot: string, sport: Sport, title: string): PlannedSessionDraft {
  const base = {
    date,
    slot,
    sport,
    title,
    description: null,
    durationMin: 60,
    intensity: Intensity.z2,
  };
  return { ...base, steps: buildWorkoutSteps(base) };
}

describe('handlePlanToday', () => {
  it('lists today’s stored sessions in the athlete’s timezone with their ICU status', async () => {
    const repo = new MemoryPlanRepo();
    repo.insert(draft('2026-10-05', 'run-0', Sport.run, 'Yesterday run'));
    repo.insert(draft('2026-10-06', 'bike-0', Sport.bike, 'VO2 5x4'), {
      status: 'pushed',
      icuEventId: 5000,
    });
    repo.insert(draft('2026-10-06', 'swim-0', Sport.swim, 'Cancelled swim'), {
      deletedAt: NOW,
    });

    const reply = await handlePlanToday(USER, { repo, now: () => NOW });

    expect(reply).toContain('VO2 5x4');
    expect(reply).toContain('📲 In intervals.icu');
    expect(reply).not.toContain('Yesterday run');
    expect(reply).not.toContain('Cancelled swim');
  });

  it('points to /plan when nothing is stored for today', async () => {
    const reply = await handlePlanToday(USER, { repo: new MemoryPlanRepo(), now: () => NOW });
    expect(reply).toBe(MSG_NOTHING_STORED_TODAY);
  });

  it('needs a profile', async () => {
    const reply = await handlePlanToday(
      { id: USER_ID, profile: null },
      { repo: new MemoryPlanRepo(), now: () => NOW }
    );
    expect(reply).toBe(MSG_NO_PROFILE);
  });
});

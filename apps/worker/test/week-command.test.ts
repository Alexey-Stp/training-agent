import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Profile } from '@prisma/client';
import {
  SeasonPlanStatus,
  TrainingBlockType,
  type RulesContext,
  type SeasonPlan,
  type TrainingBlock,
} from '@triathlon/core';
import {
  handleWeekShow,
  MSG_NO_SEASON,
  MSG_NOT_IN_SEASON,
  type SeasonRepo,
  type WeekShowDeps,
} from '../src/week-command';
import { MSG_NO_PROFILE } from '../src/profile';

const USER_ID = 'user-1';
// Wed 2026-10-07 in Prague: week 2 of the base block below
const NOW = new Date('2026-10-07T10:00:00Z');

const PROFILE: Profile = {
  id: 'profile-1',
  userId: USER_ID,
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: type === TrainingBlockType.base ? 'Aerobic endurance' : '',
    targetWeeklyHours: 10,
    targetSwimM: 3750, // 1.5 h
    targetBikeH: 5.5,
    targetRunKm: 30, // 3 h
    targetCtl: null,
  };
}

const SEASON: SeasonPlan = {
  startDate: '2026-09-28',
  status: SeasonPlanStatus.active,
  aRace: null,
  blocks: [
    block(1, TrainingBlockType.base, '2026-09-28', 4),
    block(2, TrainingBlockType.build, '2026-10-26', 3),
  ],
};

let season: SeasonPlan | null;
let getRulesContext: ReturnType<
  typeof vi.fn<(userId: string, date: string) => Promise<RulesContext>>
>;
let deps: WeekShowDeps;

beforeEach(() => {
  season = SEASON;
  const repo: SeasonRepo = { findActiveSeason: () => Promise.resolve(season) };
  getRulesContext = vi.fn(() => Promise.resolve({ last7dStats: { totalMinutes: 0, byDate: [] } }));
  deps = { repo, getRulesContext, now: () => NOW };
});

describe('handleWeekShow', () => {
  it('needs a profile', async () => {
    expect(await handleWeekShow({ id: USER_ID, profile: null }, deps)).toBe(MSG_NO_PROFILE);
  });

  it('says so when there is no active season', async () => {
    season = null;

    expect(await handleWeekShow({ id: USER_ID, profile: PROFILE }, deps)).toBe(MSG_NO_SEASON);
  });

  it('says so when today is outside every block', async () => {
    deps.now = () => new Date('2026-12-01T10:00:00Z');

    expect(await handleWeekShow({ id: USER_ID, profile: PROFILE }, deps)).toBe(MSG_NOT_IN_SEASON);
  });

  it('shows the current block week sized to its targets', async () => {
    const reply = await handleWeekShow({ id: USER_ID, profile: PROFILE }, deps);

    expect(getRulesContext).toHaveBeenCalledWith(USER_ID, '2026-10-05');
    expect(reply).toContain('📆 Week 2/4 · Base block (Oct 5 – Oct 11)');
    expect(reply).toContain('🎯 Aerobic endurance');
    expect(reply).toContain('⏱ 10.0h planned of 10.0h target');
    expect(reply).toContain('🏊 1.5h/1.5h · 🚴 5.5h/5.5h · 🏃 3.0h/3.0h');
    expect(reply).toContain('\nSun Oct 11:\n  🚴 Long Bike\n     165min • Z2');
    expect(reply).not.toContain('Still breaks hard rules');
  });

  it('shows the rules engine corrections in a build week', async () => {
    deps.now = () => new Date('2026-10-28T10:00:00Z');

    const reply = await handleWeekShow({ id: USER_ID, profile: PROFILE }, deps);

    expect(reply).toContain('📆 Week 1/3 · Build block (Oct 26 – Nov 1)');
    expect(reply).toContain('⚠️ Adjusted plan to avoid back-to-back hard sessions');
    expect(reply).not.toContain('Still breaks hard rules');
  });

  it('lists hard rules the corrected week still breaks', async () => {
    // 30min floor in WeeklyLoadCap keeps a tiny history week over the cap
    getRulesContext.mockResolvedValue({ last7dStats: { totalMinutes: 60, byDate: [] } });

    const reply = await handleWeekShow({ id: USER_ID, profile: PROFILE }, deps);

    expect(reply).toContain('❗ Still breaks hard rules:\n• Week totals');
  });
});

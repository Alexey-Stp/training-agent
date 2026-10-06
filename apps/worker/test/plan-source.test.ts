import { describe, it, expect, vi } from 'vitest';
import {
  seasonDraftsForRange,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
  type RulesContext,
  type SeasonPlan,
  type TrainingBlock,
  type UserProfile,
} from '@triathlon/core';
import { planWeek, type PlanSourceDeps } from '../src/plan-source';

const USER_ID = 'user-1';
const EMPTY_CONTEXT: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };
const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
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
    focus: '',
    targetWeeklyHours: 10,
    targetSwimM: 3750,
    targetBikeH: 5.5,
    targetRunKm: 30,
    targetCtl: null,
  };
}

// 2026-10-05..2026-10-18
const SEASON: SeasonPlan = {
  startDate: '2026-10-05',
  status: SeasonPlanStatus.active,
  aRace: null,
  blocks: [block(1, TrainingBlockType.build, '2026-10-05', 2)],
};

function deps(season: SeasonPlan | null): PlanSourceDeps {
  return {
    seasons: { findActiveSeason: () => Promise.resolve(season) },
    races: { listUpcoming: () => Promise.resolve([]) },
    getRulesContext: vi.fn(() => Promise.resolve(EMPTY_CONTEXT)),
  };
}

const dates = (drafts: { date: string }[]) => [...new Set(drafts.map((d) => d.date))];

describe('planWeek', () => {
  it('uses the 7-day generator without an active season', async () => {
    const week = await planWeek(USER_ID, PROFILE, '2026-10-07', deps(null));

    expect(week.seasonDays).toBeNull();
    expect(week.drafts.length).toBeGreaterThan(0);
    // Every stored session is shown under its own slot
    const stored = week.entries.filter((e) => e.slot !== null);
    expect(stored.map((e) => [e.session.date, e.session.title, e.slot])).toEqual(
      week.drafts.map((d) => [d.date, d.title, d.slot])
    );
    expect(week.entries.every((e) => (e.slot === null) === (e.session.sport === Sport.rest))).toBe(
      true
    );
  });

  it('uses the season sessions when the season covers the whole week', async () => {
    const week = await planWeek(USER_ID, PROFILE, '2026-10-07', deps(SEASON));

    expect(week.seasonDays).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    // Exactly what the rolling publisher stores for those days
    const expected = await seasonDraftsForRange(
      SEASON,
      PROFILE,
      { from: '2026-10-07', to: '2026-10-13' },
      () => Promise.resolve(EMPTY_CONTEXT)
    );
    expect(week.drafts).toEqual(expected.drafts);
    expect(week.drafts.some((d) => d.title === 'Bike VO2 Max')).toBe(true);
    expect(week.entries.map((e) => e.slot)).toEqual(week.drafts.map((d) => d.slot));
  });

  it('fills days after the season with the 7-day generator', async () => {
    const week = await planWeek(USER_ID, PROFILE, '2026-10-15', deps(SEASON));

    expect(week.seasonDays).toEqual({ from: '2026-10-15', to: '2026-10-18' });
    const seasonOnly = await seasonDraftsForRange(
      SEASON,
      PROFILE,
      { from: '2026-10-15', to: '2026-10-18' },
      () => Promise.resolve(EMPTY_CONTEXT)
    );
    const inSeason = week.drafts.filter((d) => d.date <= '2026-10-18');
    expect(inSeason).toEqual(seasonOnly.drafts);
    expect(dates(week.drafts).some((d) => d > '2026-10-18')).toBe(true);
    // No (date, slot) is planned twice
    const keys = week.drafts.map((d) => `${d.date}|${d.slot}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Shown in date order
    const shown = week.entries.map((e) => e.session.date);
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b)));
  });

  it('ignores a season that does not cover the week', async () => {
    const week = await planWeek(USER_ID, PROFILE, '2026-11-02', deps(SEASON));
    expect(week.seasonDays).toBeNull();
  });
});

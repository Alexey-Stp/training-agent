import { describe, it, expect, vi } from 'vitest';
import { RulesContext, UserProfile } from '../src/types';
import {
  clipToSeason,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  localToday,
  rollingWindow,
  seasonDraftsForRange,
  seasonRange,
  TrainingBlock,
  TrainingBlockType,
} from '../src/season';

const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};
const CFG = DEFAULT_BLOCK_GENERATOR_CONFIG;
const EMPTY_CONTEXT: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };

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
    focus: 'test',
    targetWeeklyHours: 10,
    targetSwimM: 1.5 * CFG.swimMPerHour,
    targetBikeH: 5.5,
    targetRunKm: 3 * CFG.runKmPerHour,
    targetCtl: null,
  };
}

// 2026-10-05..2026-11-01 base, 2026-11-02..2026-11-15 build
const SEASON = {
  blocks: [
    block(2, TrainingBlockType.build, '2026-11-02', 2),
    block(1, TrainingBlockType.base, '2026-10-05', 4),
  ],
};

describe('localToday', () => {
  it('uses the athlete timezone, not UTC', () => {
    const now = new Date('2026-10-04T22:30:00Z');
    expect(localToday(now, 'Europe/Prague')).toBe('2026-10-05'); // 00:30 CEST
    expect(localToday(now, 'America/Los_Angeles')).toBe('2026-10-04'); // 15:30 PDT
    expect(localToday(now, 'UTC')).toBe('2026-10-04');
  });

  it('follows the DST switch', () => {
    // Prague leaves CEST (UTC+2) for CET (UTC+1) on 2026-10-25
    expect(localToday(new Date('2026-10-24T22:30:00Z'), 'Europe/Prague')).toBe('2026-10-25');
    expect(localToday(new Date('2026-10-25T22:30:00Z'), 'Europe/Prague')).toBe('2026-10-25');
    expect(localToday(new Date('2026-10-25T23:00:00Z'), 'Europe/Prague')).toBe('2026-10-26');
  });
});

describe('rollingWindow', () => {
  it('is T+1..T+days and never includes today', () => {
    expect(rollingWindow('2026-10-07', 14)).toEqual({ from: '2026-10-08', to: '2026-10-21' });
    expect(rollingWindow('2026-10-07', 1)).toEqual({ from: '2026-10-08', to: '2026-10-08' });
  });

  it('crosses month and year ends', () => {
    expect(rollingWindow('2026-12-25', 14)).toEqual({ from: '2026-12-26', to: '2027-01-08' });
  });
});

describe('seasonRange / clipToSeason', () => {
  it('spans the first block start to the last block end, whatever the array order', () => {
    expect(seasonRange(SEASON)).toEqual({ from: '2026-10-05', to: '2026-11-15' });
    expect(seasonRange({ blocks: [] })).toBeNull();
  });

  it('clips at both ends and returns null outside the season', () => {
    expect(clipToSeason(SEASON, { from: '2026-09-28', to: '2026-10-11' })).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
    expect(clipToSeason(SEASON, { from: '2026-11-11', to: '2026-11-24' })).toEqual({
      from: '2026-11-11',
      to: '2026-11-15',
    });
    expect(clipToSeason(SEASON, { from: '2026-09-21', to: '2026-10-04' })).toBeNull();
    expect(clipToSeason(SEASON, { from: '2026-11-16', to: '2026-11-29' })).toBeNull();
  });
});

describe('seasonDraftsForRange', () => {
  it('expands every week touching the range and keeps only the range days', async () => {
    const getContext = vi.fn((_weekStart: string) => Promise.resolve(EMPTY_CONTEXT));
    const range = rollingWindow('2026-10-07', 14); // Thu 10-08 .. Wed 10-21

    const { covered, drafts } = await seasonDraftsForRange(SEASON, PROFILE, range, getContext);

    expect(covered).toEqual(range);
    expect(getContext.mock.calls.map(([d]) => d)).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.date >= '2026-10-08' && d.date <= '2026-10-21')).toBe(true);
    // Both ends of the window are planned (Thu key bike, Wed swim)
    expect(drafts.some((d) => d.date === '2026-10-08')).toBe(true);
    expect(drafts.some((d) => d.date === '2026-10-21')).toBe(true);
  });

  it('pairs every draft with the session it came from', async () => {
    const { drafts, sessions } = await seasonDraftsForRange(
      SEASON,
      PROFILE,
      rollingWindow('2026-10-07', 14),
      () => Promise.resolve(EMPTY_CONTEXT)
    );
    expect(sessions).toHaveLength(drafts.length);
    sessions.forEach((s, i) => {
      expect([s.date, s.sport, s.title, s.durationMin]).toEqual([
        drafts[i].date,
        drafts[i].sport,
        drafts[i].title,
        drafts[i].durationMin,
      ]);
    });
  });

  it('switches templates across a block boundary', async () => {
    const { drafts } = await seasonDraftsForRange(
      SEASON,
      PROFILE,
      rollingWindow('2026-10-26', 14),
      () => Promise.resolve(EMPTY_CONTEXT)
    );
    const titles = (from: string, to: string) =>
      drafts.filter((d) => d.date >= from && d.date <= to).map((d) => d.title);
    expect(titles('2026-10-27', '2026-11-01')).not.toContain('Bike VO2 Max');
    expect(titles('2026-11-02', '2026-11-08')).toContain('Bike VO2 Max');
  });

  it('is deterministic for the same inputs', async () => {
    const run = () =>
      seasonDraftsForRange(SEASON, PROFILE, rollingWindow('2026-10-07', 14), () =>
        Promise.resolve(EMPTY_CONTEXT)
      );
    expect(await run()).toEqual(await run());
  });

  it('returns nothing for a range outside the season', async () => {
    const getContext = vi.fn(() => Promise.resolve(EMPTY_CONTEXT));
    const result = await seasonDraftsForRange(
      SEASON,
      PROFILE,
      rollingWindow('2026-09-20', 14),
      getContext
    );
    expect(result).toEqual({ covered: null, drafts: [], sessions: [], warnings: [] });
    expect(getContext).not.toHaveBeenCalled();
  });
});

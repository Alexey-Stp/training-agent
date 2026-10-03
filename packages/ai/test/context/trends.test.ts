import { addDaysIso, Intensity, Sport } from '@triathlon/core';
import { describe, expect, it } from 'vitest';
import {
  compliance,
  daysBetween,
  emptyWellnessDay,
  hrvBaseline,
  missedKeySessions,
  powerZones,
  seasonPosition,
  trainingLoad,
  wellnessTrend,
  type ActivitySummary,
  type PlannedSessionSummary,
  type WellnessDay,
} from '../../src';
import { DATE, freshAthlete } from './fixtures';

const day = (offset: number, metrics: Partial<WellnessDay> = {}): WellnessDay => ({
  ...emptyWellnessDay(addDaysIso(DATE, offset)),
  ...metrics,
});

const session = (
  offset: number,
  overrides: Partial<PlannedSessionSummary> = {}
): PlannedSessionSummary => ({
  date: addDaysIso(DATE, offset),
  slot: 'bike-1',
  sport: Sport.bike,
  title: 'Session',
  durationMin: 60,
  intensity: Intensity.z2,
  status: 'completed',
  externalChange: null,
  ...overrides,
});

const activity = (offset: number, sport: Sport, minutes: number): ActivitySummary => ({
  startDateLocal: addDaysIso(DATE, offset),
  sport,
  name: 'Activity',
  durationSec: minutes * 60,
  load: null,
});

// Seven readings 50..62 the week before DATE: mean 56, population SD 4
const BASELINE = [50, 52, 54, 56, 58, 60, 62].map((hrv, i) => day(i - 7, { hrv }));

describe('hrvBaseline', () => {
  it('computes the mean and population SD of the 30 days before today', () => {
    const result = hrvBaseline([...BASELINE, day(0, { hrv: 57 })], DATE);
    expect(result).toEqual({ status: 'ok', samples: 7, mean: 56, sd: 4, today: 57, low: false });
  });

  it('flags today only when it is strictly below mean - 1 SD', () => {
    expect(hrvBaseline([...BASELINE, day(0, { hrv: 52 })], DATE).low).toBe(false);
    expect(hrvBaseline([...BASELINE, day(0, { hrv: 51.9 })], DATE).low).toBe(true);
  });

  it('ignores readings older than 30 days, today and empty days', () => {
    const rows = [day(-31, { hrv: 10 }), day(-8), ...BASELINE, day(0, { hrv: 200 })];
    const result = hrvBaseline(rows, DATE);
    expect(result.mean).toBe(56);
    expect(result.samples).toBe(7);
  });

  it('reports insufficient data below 7 readings', () => {
    const result = hrvBaseline([...BASELINE.slice(1), day(0, { hrv: 40 })], DATE);
    expect(result).toEqual({
      status: 'insufficient',
      samples: 6,
      mean: null,
      sd: null,
      today: 40,
      low: false,
    });
  });

  it('keeps the baseline when today has no reading', () => {
    expect(hrvBaseline(BASELINE, DATE)).toMatchObject({ status: 'no_today', mean: 56, low: false });
  });
});

describe('wellnessTrend', () => {
  it('returns 7 days oldest first, filling gaps with empty days', () => {
    const trend = wellnessTrend([day(-6, { hrv: 50, sleepHours: 7 }), day(0, { hrv: 60 })], DATE);
    expect(trend.days.map((d) => d.date)).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(trend.days[3].hrv).toBeNull();
    expect(trend.avgHrv).toBe(55);
    expect(trend.avgSleepHours).toBe(7);
    expect(trend.avgRestingHr).toBeNull();
  });
});

describe('trainingLoad', () => {
  it('uses the row of today when it has TSB', () => {
    const rows = [day(-1, { tsb: -3 }), day(0, { ctl: 70, atl: 72, tsb: -2 })];
    expect(trainingLoad(rows, DATE)).toEqual({ date: DATE, daysOld: 0, ctl: 70, atl: 72, tsb: -2 });
  });

  it('falls back to the latest earlier row and reports its age', () => {
    const load = trainingLoad([day(-2, { ctl: 70, atl: 60, tsb: 10 }), day(0, { hrv: 50 })], DATE);
    expect(load).toMatchObject({ date: '2026-10-01', daysOld: 2, tsb: 10 });
  });

  it('is null without any TSB', () => {
    expect(trainingLoad([day(0, { hrv: 50 })], DATE)).toBeNull();
  });
});

describe('compliance', () => {
  it('compares actual and planned minutes per sport over the 7 days before today', () => {
    const planned = [
      session(-1, { durationMin: 120 }),
      session(-7, { sport: Sport.swim, durationMin: 60, status: 'skipped' }),
      session(-8, { durationMin: 500 }), // outside the window
      session(0, { durationMin: 500 }), // today is not judged yet
    ];
    const activities = [activity(-1, Sport.bike, 90), activity(-3, Sport.run, 40)];
    const result = compliance(planned, activities, DATE);

    expect(result.from).toBe('2026-09-26');
    expect(result.to).toBe('2026-10-02');
    expect(result.bySport).toEqual([
      { sport: Sport.swim, plannedMin: 60, actualMin: 0, pct: 0 },
      { sport: Sport.bike, plannedMin: 120, actualMin: 90, pct: 75 },
      { sport: Sport.run, plannedMin: 0, actualMin: 40, pct: null },
    ]);
    expect(result.total).toEqual({ plannedMin: 180, actualMin: 130, pct: 72 });
  });

  it('has no sports and no percentage when nothing was planned or done', () => {
    const result = compliance([], [], DATE);
    expect(result.bySport).toEqual([]);
    expect(result.total.pct).toBeNull();
  });
});

describe('missedKeySessions', () => {
  it('lists hard or long sessions that were skipped or have no same-sport activity', () => {
    const planned = [
      session(-1, { title: 'VO2 undone', intensity: Intensity.z4, status: 'pushed' }),
      session(-2, { title: 'VO2 wrong sport', intensity: Intensity.z5, status: 'pushed' }),
      session(-3, { title: 'VO2 done', intensity: Intensity.z4, status: 'pushed' }),
      session(-4, { title: 'Long skipped', durationMin: 150, status: 'skipped' }),
      session(-5, { title: 'Long completed', durationMin: 150, status: 'completed' }),
      session(-6, { title: 'Easy skipped', status: 'skipped' }),
      session(-15, { title: 'Too old', intensity: Intensity.z4, status: 'skipped' }),
      session(0, { title: 'Today', intensity: Intensity.z4, status: 'pushed' }),
    ];
    const activities = [activity(-2, Sport.run, 60), activity(-3, Sport.bike, 70)];
    expect(missedKeySessions(planned, activities, DATE).map((s) => s.title)).toEqual([
      'VO2 undone',
      'VO2 wrong sport',
      'Long skipped',
    ]);
  });
});

describe('powerZones', () => {
  it('derives Coggan bands from FTP', () => {
    expect(powerZones(280).map((z) => [z.zone, z.minWatts, z.maxWatts])).toEqual([
      ['z1', 0, 154],
      ['z2', 157, 210],
      ['z3', 213, 252],
      ['z4', 255, 294],
      ['z5', 297, null],
    ]);
  });
});

describe('daysBetween', () => {
  it('counts calendar days across a DST change', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-10-26', '2026-10-24')).toBe(-2);
  });
});

describe('seasonPosition', () => {
  const season = freshAthlete().season;

  it('finds the block week, season week and days to the A-race', () => {
    expect(seasonPosition(season, DATE)).toEqual({
      seasonStart: '2026-06-08',
      seasonEnd: '2026-11-22',
      block: { type: 'build', focus: 'race-specific bike', order: 3, count: 6, week: 3, weeks: 4 },
      seasonWeek: 17,
      seasonWeeks: 24,
      aRace: season?.aRace,
      daysToARace: 50,
    });
  });

  it('has no block or season week outside the season', () => {
    expect(seasonPosition(season, '2026-05-01')).toMatchObject({
      block: null,
      seasonWeek: null,
      daysToARace: 205,
    });
  });

  it('is null without an active season or without blocks', () => {
    expect(seasonPosition(null, DATE)).toBeNull();
    if (season) expect(seasonPosition({ ...season, blocks: [] }, DATE)).toBeNull();
  });
});

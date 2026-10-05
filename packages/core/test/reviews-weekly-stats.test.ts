import { describe, it, expect } from 'vitest';
import {
  computeWeeklyStats,
  intensityDistribution,
  type WeeklyActivityInput,
  type WeeklyPlannedInput,
  type WeeklyStatsInput,
  type WeeklyWellnessInput,
} from '../src/reviews/weekly-stats';
import { Intensity, Sport } from '../src/types';

// ISO week 2026-W40: Monday 2026-09-28 .. Sunday 2026-10-04
const WEEK = '2026-W40';

function planned(
  date: string,
  sport: Sport,
  title: string,
  durationMin: number,
  extra: Partial<WeeklyPlannedInput> = {}
): WeeklyPlannedInput {
  return {
    date,
    slot: sport + '-1',
    sport,
    title,
    durationMin,
    intensity: Intensity.z2,
    status: 'completed',
    deleted: false,
    ...extra,
  };
}

function activity(
  startDateLocal: string,
  sport: Sport,
  durationMin: number,
  extra: Partial<WeeklyActivityInput> = {}
): WeeklyActivityInput {
  return {
    startDateLocal,
    sport,
    durationSec: durationMin * 60,
    distanceM: null,
    load: null,
    avgHr: null,
    ...extra,
  };
}

function wellness(date: string, extra: Partial<WeeklyWellnessInput> = {}): WeeklyWellnessInput {
  return {
    date,
    hrv: null,
    restingHr: null,
    sleepHours: null,
    ctl: null,
    atl: null,
    tsb: null,
    subjectiveReadiness: null,
    soreness: null,
    ...extra,
  };
}

function input(extra: Partial<WeeklyStatsInput> = {}): WeeklyStatsInput {
  return { isoWeek: WEEK, sessions: [], activities: [], wellness: [], lthr: 160, ...extra };
}

const GOLDEN_SESSIONS: WeeklyPlannedInput[] = [
  planned('2026-09-28', Sport.swim, 'Endurance swim', 60),
  planned('2026-09-29', Sport.bike, 'VO2 bike', 75, { intensity: Intensity.z5 }),
  planned('2026-09-30', Sport.run, 'Threshold run', 50, {
    intensity: Intensity.z4,
    status: 'skipped',
  }),
  planned('2026-10-01', Sport.swim, 'Technique swim', 45, { status: 'skipped' }),
  planned('2026-10-02', Sport.rest, 'Rest', 0, { status: 'draft' }),
  planned('2026-10-03', Sport.bike, 'Long ride', 180),
  planned('2026-10-04', Sport.run, 'Long run', 90, { status: 'skipped' }),
  planned('2026-10-04', Sport.run, 'Strides', 30, {
    slot: 'run-2',
    intensity: Intensity.z3,
    deleted: true,
  }),
  planned('2026-10-05', Sport.bike, 'Next week ride', 60, { status: 'draft' }),
];

const GOLDEN_ACTIVITIES: WeeklyActivityInput[] = [
  activity('2026-09-28', Sport.swim, 55, { distanceM: 2500, load: 40, avgHr: 130 }),
  activity('2026-09-29', Sport.bike, 75, { distanceM: 40000, load: 95, avgHr: 155 }),
  activity('2026-10-01', Sport.run, 40, { distanceM: 8000, load: 45 }),
  activity('2026-10-02', Sport.strength, 30, { avgHr: 110 }),
  activity('2026-10-03', Sport.bike, 180, { distanceM: 90000, load: 180, avgHr: 130 }),
  activity('2026-09-27', Sport.run, 60, { distanceM: 12000, load: 70, avgHr: 150 }),
];

const GOLDEN_WELLNESS: WeeklyWellnessInput[] = [
  wellness('2026-09-25', { ctl: 60, atl: 65, tsb: -5, hrv: 60 }),
  wellness('2026-09-27', { ctl: 61.2, atl: 70, tsb: -8.8, hrv: 64 }),
  wellness('2026-09-28', {
    ctl: 62,
    atl: 72,
    tsb: -10,
    hrv: 58,
    restingHr: 50,
    sleepHours: 7.5,
    subjectiveReadiness: 3,
    soreness: 2,
  }),
  wellness('2026-09-30', { ctl: 63, atl: 74, tsb: -11, hrv: 55, restingHr: 52, sleepHours: 6.5 }),
  wellness('2026-10-02', { ctl: 64, atl: 68, tsb: -4 }),
  wellness('2026-10-04', {
    ctl: 65.5,
    atl: 75,
    tsb: -9.5,
    hrv: 61,
    restingHr: 49,
    sleepHours: 8,
    subjectiveReadiness: 4,
    soreness: 1,
  }),
  wellness('2026-10-05', { ctl: 70, atl: 80, tsb: -10, hrv: 40 }),
];

describe('computeWeeklyStats: golden week', () => {
  const stats = computeWeeklyStats(
    input({ sessions: GOLDEN_SESSIONS, activities: GOLDEN_ACTIVITIES, wellness: GOLDEN_WELLNESS })
  );

  it('covers the ISO week and is a planned week', () => {
    expect(stats).toMatchObject({
      version: 1,
      isoWeek: WEEK,
      from: '2026-09-28',
      to: '2026-10-04',
      unplannedWeek: false,
    });
  });

  it('matches hand-calculated per-sport compliance', () => {
    // swim 55/105, bike 255/255, run 40/140; strength was not planned
    expect(stats.bySport.map((s) => [s.sport, s.plannedMin, s.actualMin, s.compliancePct])).toEqual(
      [
        [Sport.swim, 105, 55, 52.4],
        [Sport.bike, 255, 255, 100],
        [Sport.run, 140, 40, 28.6],
        [Sport.strength, 0, 30, null],
      ]
    );
  });

  it('reports actual distance and TSS, planned ones as null', () => {
    const bike = stats.bySport.find((s) => s.sport === Sport.bike);
    expect(bike).toMatchObject({
      actualDistanceKm: 130,
      actualTss: 275,
      plannedDistanceKm: null,
      plannedTss: null,
      plannedSessions: 2,
      activities: 2,
    });
  });

  it('sums the week totals', () => {
    expect(stats.total).toEqual({
      plannedMin: 500,
      actualMin: 380,
      compliancePct: 76,
      plannedDistanceKm: null,
      actualDistanceKm: 140.5,
      plannedTss: null,
      actualTss: 360,
      plannedSessions: 6,
      activities: 5,
    });
  });

  it('lists key-session hits and misses by title', () => {
    expect(stats.keySessions.hit.map((s) => s.title)).toEqual(['VO2 bike', 'Long ride']);
    expect(stats.keySessions.missed).toEqual([
      { date: '2026-09-30', title: 'Threshold run', sport: Sport.run },
      { date: '2026-10-04', title: 'Long run', sport: Sport.run },
    ]);
    expect(stats.keySessions.pending).toEqual([]);
  });

  it('buckets minutes by average heart rate zone', () => {
    // LTHR 160: 130 bpm and 110 bpm are Z1, 155 bpm is Z4, the run has no HR
    expect(stats.intensity).toEqual({
      easyMin: 265,
      hardMin: 75,
      unknownMin: 40,
      easyPct: 77.9,
      hardPct: 22.1,
    });
  });

  it('takes CTL/ATL/TSB from before the week to its last day', () => {
    expect(stats.load).toEqual({
      start: { date: '2026-09-27', ctl: 61.2, atl: 70, tsb: -8.8 },
      end: { date: '2026-10-04', ctl: 65.5, atl: 75, tsb: -9.5 },
      ctlDelta: 4.3,
      atlDelta: 5,
      tsbDelta: -0.7,
    });
  });

  it('summarises wellness against the week before', () => {
    expect(stats.wellness).toEqual({
      daysWithData: 3,
      avgHrv: 58,
      avgRestingHr: 50.3,
      avgSleepHours: 7.3,
      avgReadiness: 3.5,
      avgSoreness: 1.5,
      prevAvgHrv: 62,
      hrvDeltaPct: -6.5,
    });
  });

  it('does not depend on input order', () => {
    const shuffled = computeWeeklyStats(
      input({
        sessions: [...GOLDEN_SESSIONS].reverse(),
        activities: [...GOLDEN_ACTIVITIES].reverse(),
        wellness: [...GOLDEN_WELLNESS].reverse(),
      })
    );
    expect(shuffled).toEqual(stats);
  });
});

describe('computeWeeklyStats: unplanned week', () => {
  it('has null compliance, not 0, when nothing was planned', () => {
    const stats = computeWeeklyStats(
      input({ activities: [activity('2026-09-29', Sport.run, 45, { avgHr: 140 })] })
    );
    expect(stats.unplannedWeek).toBe(true);
    expect(stats.total.compliancePct).toBeNull();
    expect(stats.total.actualMin).toBe(45);
    expect(stats.bySport).toEqual([
      expect.objectContaining({ sport: Sport.run, compliancePct: null }),
    ]);
  });

  it('treats a week of only rest and tombstoned sessions as unplanned', () => {
    const stats = computeWeeklyStats(
      input({
        sessions: [
          planned('2026-09-28', Sport.rest, 'Rest', 0),
          planned('2026-09-29', Sport.run, 'Gone', 40, { deleted: true }),
        ],
      })
    );
    expect(stats.unplannedWeek).toBe(true);
    expect(stats.total.compliancePct).toBeNull();
  });

  it('is all zeros and nulls without any data', () => {
    const stats = computeWeeklyStats(input());
    expect(stats.bySport).toEqual([]);
    expect(stats.total).toMatchObject({ plannedMin: 0, actualMin: 0, compliancePct: null });
    expect(stats.keySessions).toEqual({ hit: [], missed: [], pending: [] });
    expect(stats.intensity).toEqual({
      easyMin: 0,
      hardMin: 0,
      unknownMin: 0,
      easyPct: null,
      hardPct: null,
    });
    expect(stats.load).toEqual({
      start: null,
      end: null,
      ctlDelta: null,
      atlDelta: null,
      tsbDelta: null,
    });
    expect(stats.wellness).toMatchObject({ daysWithData: 0, avgHrv: null, hrvDeltaPct: null });
  });
});

describe('computeWeeklyStats: partial data', () => {
  it('keeps not-closed-out key sessions as pending', () => {
    const stats = computeWeeklyStats(
      input({
        sessions: [
          planned('2026-10-03', Sport.bike, 'Long ride', 150, { status: 'pushed' }),
          planned('2026-10-04', Sport.run, 'Moved run', 50, {
            intensity: Intensity.z4,
            status: 'modified_externally',
          }),
        ],
      })
    );
    expect(stats.keySessions.pending.map((s) => s.title)).toEqual(['Long ride', 'Moved run']);
    expect(stats.keySessions.missed).toEqual([]);
  });

  it('leaves the load start null when there is no wellness before the week', () => {
    const stats = computeWeeklyStats(
      input({ wellness: [wellness('2026-10-01', { ctl: 50, atl: null, tsb: null })] })
    );
    expect(stats.load).toEqual({
      start: null,
      end: { date: '2026-10-01', ctl: 50, atl: null, tsb: null },
      ctlDelta: null,
      atlDelta: null,
      tsbDelta: null,
    });
  });

  it('has no HRV delta without HRV in the week before', () => {
    const stats = computeWeeklyStats(input({ wellness: [wellness('2026-09-29', { hrv: 50 })] }));
    expect(stats.wellness).toMatchObject({ avgHrv: 50, prevAvgHrv: null, hrvDeltaPct: null });
  });

  it('puts activities without heart rate in the unknown bucket', () => {
    const stats = computeWeeklyStats(
      input({
        activities: [
          activity('2026-09-29', Sport.bike, 60, { avgHr: 120 }),
          activity('2026-09-30', Sport.swim, 30),
        ],
      })
    );
    expect(stats.intensity).toMatchObject({
      easyMin: 60,
      unknownMin: 30,
      easyPct: 100,
      hardPct: 0,
    });
  });
});

describe('intensityDistribution', () => {
  it('splits Z1-2 from Z3+ at 90% of LTHR', () => {
    const result = intensityDistribution(
      [
        activity('2026-09-28', Sport.run, 40, { avgHr: 179 }),
        activity('2026-09-29', Sport.run, 20, { avgHr: 180 }),
      ],
      200
    );
    expect(result).toEqual({
      easyMin: 40,
      hardMin: 20,
      unknownMin: 0,
      easyPct: 66.7,
      hardPct: 33.3,
    });
  });

  it('cannot bucket anything without LTHR', () => {
    const result = intensityDistribution(
      [activity('2026-09-28', Sport.run, 40, { avgHr: 150 })],
      null
    );
    expect(result).toEqual({
      easyMin: 0,
      hardMin: 0,
      unknownMin: 40,
      easyPct: null,
      hardPct: null,
    });
  });
});

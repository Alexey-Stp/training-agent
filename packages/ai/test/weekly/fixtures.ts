import {
  computeWeeklyStats,
  Intensity,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
  type RulesContext,
  type WeeklyActivityInput,
  type WeeklyPlannedInput,
  type WeeklyStats,
} from '@triathlon/core';
import {
  seasonPosition,
  sessionKey,
  type CoachPlanSession,
  type RunWeeklyReviewInput,
  type SeasonPosition,
  type SessionDiff,
  type WeeklyReview,
} from '../../src';

export const USER_ID = 'user-1';
/** Sunday, the last day of 2026-W40 */
export const REVIEW_DATE = '2026-10-04';
export const NEXT_WEEK = { from: '2026-10-05', to: '2026-10-11' };

type Planned = [date: string, sport: Sport, min: number, intensity: Intensity, title: string];

/** 2026-W40: 600 min planned, Saturday's 180-min ride is the long one */
const WEEK_PLAN: Planned[] = [
  ['2026-09-28', Sport.swim, 60, Intensity.z2, 'Aerobic swim'],
  ['2026-09-29', Sport.bike, 75, Intensity.z4, 'VO2 5x4'],
  ['2026-09-30', Sport.run, 60, Intensity.z2, 'Easy run'],
  ['2026-10-01', Sport.run, 60, Intensity.z4, 'Threshold run'],
  ['2026-10-02', Sport.swim, 60, Intensity.z2, 'Technique swim'],
  ['2026-10-03', Sport.bike, 180, Intensity.z2, 'Long ride'],
  ['2026-10-04', Sport.run, 105, Intensity.z2, 'Long run'],
];

function planned(
  [date, sport, durationMin, intensity, title]: Planned,
  status: string
): WeeklyPlannedInput {
  return { date, slot: sport + '-1', sport, title, durationMin, intensity, status, deleted: false };
}

function done([date, sport, durationMin]: Planned): WeeklyActivityInput {
  const km: Partial<Record<Sport, number>> = { swim: 2.5, bike: 30, run: 10 };
  const perHour = km[sport] ?? 0;
  return {
    startDateLocal: date,
    sport,
    durationSec: durationMin * 60,
    distanceM: Math.round((durationMin / 60) * perHour * 1000),
    load: durationMin,
    avgHr: sport === Sport.swim ? null : 135,
  };
}

const LONG_RIDE = '2026-10-03';

function stats(sessions: WeeklyPlannedInput[], activities: WeeklyActivityInput[]): WeeklyStats {
  return computeWeeklyStats({
    isoWeek: '2026-W40',
    sessions,
    activities,
    wellness: [
      {
        date: '2026-09-27',
        hrv: 60,
        restingHr: 48,
        sleepHours: 7.5,
        ctl: 50,
        atl: 55,
        tsb: -5,
        subjectiveReadiness: null,
        soreness: null,
      },
      {
        date: '2026-10-04',
        hrv: 62,
        restingHr: 47,
        sleepHours: 7.8,
        ctl: 52,
        atl: 50,
        tsb: 2,
        subjectiveReadiness: 4,
        soreness: 1,
      },
    ],
    lthr: 165,
  });
}

/** Everything done as planned */
export function compliantWeek(): WeeklyStats {
  return stats(
    WEEK_PLAN.map((p) => planned(p, 'completed')),
    WEEK_PLAN.map(done)
  );
}

/** Everything done except Saturday's 180-min long ride */
export function missedLongRideWeek(): WeeklyStats {
  return stats(
    WEEK_PLAN.map((p) => planned(p, p[0] === LONG_RIDE ? 'skipped' : 'completed')),
    WEEK_PLAN.filter((p) => p[0] !== LONG_RIDE).map(done)
  );
}

function session(
  date: string,
  sport: Sport,
  durationMin: number,
  intensity: Intensity,
  title: string
): CoachPlanSession {
  const slot = sport + '-1';
  return {
    id: sessionKey({ date, slot }),
    date,
    slot,
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
  };
}

/** 2026-W41, 600 min; Friday is rest */
export function nextWeek(): CoachPlanSession[] {
  return [
    session('2026-10-05', Sport.swim, 60, Intensity.z2, 'Aerobic swim'),
    session('2026-10-06', Sport.bike, 75, Intensity.z4, 'VO2 5x4'),
    session('2026-10-07', Sport.run, 60, Intensity.z2, 'Easy run'),
    session('2026-10-08', Sport.run, 60, Intensity.z4, 'Threshold run'),
    session('2026-10-10', Sport.bike, 210, Intensity.z2, 'Long ride'),
    session('2026-10-11', Sport.run, 135, Intensity.z2, 'Long run'),
  ];
}

export const NEXT_LONG_RIDE = '2026-10-10/bike-1';
export const NEXT_LONG_RUN = '2026-10-11/run-1';

/** +45 min on next Saturday's ride: within the 8% ramp cap (600 → 645 min, cap 648) */
export const PARTIAL_CATCH_UP: SessionDiff = {
  sessionId: NEXT_LONG_RIDE,
  field: 'durationMin',
  before: 210,
  after: 255,
};

/** The whole missed ride on top of next Saturday: +180 min, 30% */
export const FULL_CATCH_UP: SessionDiff = {
  sessionId: NEXT_LONG_RIDE,
  field: 'durationMin',
  before: 210,
  after: 390,
};

/** A reviewed week of 600 min keeps the 110% weekly load cap out of the way */
export function reviewedWeekContext(totalMinutes = 600): RulesContext {
  return { last7dStats: { totalMinutes, byDate: [] } };
}

function seasonAt(date: string): SeasonPosition | null {
  return seasonPosition(
    {
      startDate: '2026-09-07',
      status: SeasonPlanStatus.active,
      aRace: {
        date: '2027-06-13',
        name: 'Challenge Prague',
        priority: RacePriority.A,
        type: RaceType.half,
      },
      blocks: [
        {
          order: 1,
          type: TrainingBlockType.base,
          startDate: '2026-09-07',
          weeks: 3,
          focus: 'aerobic base',
          targetWeeklyHours: 9,
          targetSwimM: 6000,
          targetBikeH: 4,
          targetRunKm: 30,
          targetCtl: null,
        },
        {
          order: 2,
          type: TrainingBlockType.build,
          startDate: '2026-09-28',
          weeks: 4,
          focus: 'threshold',
          targetWeeklyHours: 10,
          targetSwimM: 7000,
          targetBikeH: 5,
          targetRunKm: 35,
          targetCtl: null,
        },
      ],
    },
    date
  );
}

export function reviewInput(
  weekStats: WeeklyStats,
  overrides: Partial<RunWeeklyReviewInput> = {}
): RunWeeklyReviewInput {
  return {
    userId: USER_ID,
    date: REVIEW_DATE,
    stats: weekStats,
    season: seasonAt(REVIEW_DATE),
    nextSeason: seasonAt(NEXT_WEEK.from),
    nextWeek: NEXT_WEEK,
    sessions: nextWeek(),
    context: reviewedWeekContext(),
    ...overrides,
  };
}

export function review(overrides: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    summary: 'Solid week, but the 180-min long ride was missed: 420 of 600 min done.',
    wins: ['Both key run sessions done'],
    concerns: ['Bike volume 180 min short'],
    nextWeekChanges: [PARTIAL_CATCH_UP],
    blockAdjustment: null,
    ...overrides,
  };
}

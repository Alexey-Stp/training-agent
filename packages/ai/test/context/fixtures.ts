import {
  addDaysIso,
  Intensity,
  RacePriority,
  RaceType,
  SeasonPlanStatus,
  Sport,
  TrainingBlockType,
  type Race,
  type SeasonPlan,
  type TrainingBlock,
  type UserProfile,
} from '@triathlon/core';
import type {
  ActivitySummary,
  CoachDecision,
  DailyContextDeps,
  PlannedSessionStatus,
  PlannedSessionSummary,
  WellnessDay,
} from '../../src';
import { emptyWellnessDay } from '../../src';

/** Fixed "today" of every fixture (a Saturday) */
export const DATE = '2026-10-03';
export const USER_ID = 'user-1';

export interface AthleteFixture {
  profile: UserProfile | null;
  season: SeasonPlan | null;
  races: Race[];
  wellness: WellnessDay[];
  activities: ActivitySummary[];
  planned: PlannedSessionSummary[];
  decisions: CoachDecision[];
}

export interface FakeRepoOptions {
  /** Return rows in reverse order, to prove the builder doesn't rely on repository ordering */
  reversed?: boolean;
}

/** In-memory repositories over a fixture. Reads filter by user window like the Prisma ones would. */
export function fakeDeps(fixture: AthleteFixture, options: FakeRepoOptions = {}): DailyContextDeps {
  const order = <T>(rows: T[]): T[] => (options.reversed ? [...rows].reverse() : [...rows]);
  const between = (d: string, from: string, to: string) => d >= from && d <= to;
  return {
    profiles: { findProfile: () => Promise.resolve(fixture.profile) },
    seasons: { findActiveSeason: () => Promise.resolve(fixture.season) },
    races: {
      listUpcoming: (_userId, fromDate) =>
        Promise.resolve(order(fixture.races.filter((r) => r.date >= fromDate))),
    },
    wellness: {
      listRange: (_userId, from, to) =>
        Promise.resolve(order(fixture.wellness.filter((w) => between(w.date, from, to)))),
    },
    activities: {
      listRange: (_userId, from, to) =>
        Promise.resolve(
          order(fixture.activities.filter((a) => between(a.startDateLocal, from, to)))
        ),
    },
    planned: {
      listRange: (_userId, from, to) =>
        Promise.resolve(order(fixture.planned.filter((s) => between(s.date, from, to)))),
    },
    decisions: {
      listRecent: (_userId, upTo, limit) =>
        Promise.resolve(
          order(
            fixture.decisions
              .filter((d) => d.date <= upTo)
              .sort((a, b) => a.date.localeCompare(b.date))
              .slice(-limit)
          )
        ),
    },
  };
}

export const PROFILE: UserProfile = {
  ftp: 280,
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
  weeks: number,
  focus: string
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus,
    targetWeeklyHours: 10,
    targetSwimM: 6000,
    targetBikeH: 5,
    targetRunKm: 30,
    targetCtl: null,
  };
}

const HALF_A_RACE: Race = {
  date: '2026-11-22',
  name: 'Lake Half',
  priority: RacePriority.A,
  type: RaceType.half,
};

const OLYMPIC_A_RACE: Race = {
  date: '2026-10-09',
  name: 'Regional Olympic',
  priority: RacePriority.A,
  type: RaceType.olympic,
};

/** Build block, week 3 of 4, seven weeks out from a half */
const BUILD_SEASON: SeasonPlan = {
  startDate: '2026-06-08',
  status: SeasonPlanStatus.active,
  aRace: HALF_A_RACE,
  blocks: [
    block(1, TrainingBlockType.base, '2026-06-08', 8, 'aerobic base'),
    block(2, TrainingBlockType.build, '2026-08-03', 6, 'threshold'),
    block(3, TrainingBlockType.build, '2026-09-14', 4, 'race-specific bike'),
    block(4, TrainingBlockType.peak, '2026-10-12', 3, 'race pace'),
    block(5, TrainingBlockType.taper, '2026-11-02', 2, 'freshen up'),
    block(6, TrainingBlockType.race, '2026-11-16', 1, 'race'),
  ],
};

/** Taper block, race week next */
const TAPER_SEASON: SeasonPlan = {
  startDate: '2026-05-25',
  status: SeasonPlanStatus.active,
  aRace: OLYMPIC_A_RACE,
  blocks: [
    block(1, TrainingBlockType.base, '2026-05-25', 8, 'aerobic base'),
    block(2, TrainingBlockType.build, '2026-07-20', 6, 'threshold'),
    block(3, TrainingBlockType.peak, '2026-08-31', 3, 'race pace'),
    block(4, TrainingBlockType.taper, '2026-09-21', 2, 'freshen up'),
    block(5, TrainingBlockType.race, '2026-10-05', 1, 'race'),
  ],
};

type SessionSpec = [Sport, number, Intensity, string];

/** Training week by weekday (0 = Sunday) */
const BUILD_WEEK: Record<number, SessionSpec[]> = {
  0: [[Sport.bike, 180, Intensity.z2, 'Long ride']],
  1: [[Sport.swim, 45, Intensity.z2, 'Technique swim']],
  2: [[Sport.run, 50, Intensity.z2, 'Easy run']],
  3: [[Sport.swim, 60, Intensity.z3, 'CSS swim']],
  4: [[Sport.bike, 75, Intensity.z4, 'VO2 5x4']],
  5: [[Sport.swim, 45, Intensity.z2, 'Aerobic swim']],
  6: [[Sport.run, 95, Intensity.z2, 'Long run']],
};

const TAPER_WEEK: Record<number, SessionSpec[]> = {
  0: [[Sport.bike, 90, Intensity.z2, 'Steady ride']],
  1: [[Sport.swim, 30, Intensity.z2, 'Easy swim']],
  2: [[Sport.run, 35, Intensity.z4, 'Run openers']],
  3: [[Sport.swim, 40, Intensity.z3, 'Race-pace swim']],
  4: [[Sport.bike, 50, Intensity.z4, 'Bike openers']],
  5: [[Sport.swim, 30, Intensity.z2, 'Shakeout swim']],
  6: [[Sport.run, 40, Intensity.z2, 'Easy run']],
};

function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

/** One session per day from DATE-14 to DATE+3; past days completed, today and later pushed */
function plannedFrom(week: Record<number, SessionSpec[]>): PlannedSessionSummary[] {
  const sessions: PlannedSessionSummary[] = [];
  for (let date = addDaysIso(DATE, -14); date <= addDaysIso(DATE, 3); date = addDaysIso(date, 1)) {
    week[weekday(date)].forEach(([sport, durationMin, intensity, title], i) => {
      const status: PlannedSessionStatus = date < DATE ? 'completed' : 'pushed';
      sessions.push({
        date,
        slot: sport + '-' + (i + 1).toString(),
        sport,
        title,
        durationMin,
        intensity,
        status,
        externalChange: null,
      });
    });
  }
  return sessions;
}

/** An activity for every past planned session, two minutes longer than planned */
function activitiesFor(planned: PlannedSessionSummary[]): ActivitySummary[] {
  return planned
    .filter((s) => s.date < DATE)
    .map((s) => ({
      startDateLocal: s.date,
      sport: s.sport,
      name: s.title,
      durationSec: (s.durationMin + 2) * 60,
      load: Math.round(s.durationMin * 0.9),
    }));
}

/** 31 days of wellness ending today; `metrics(i)` with i = 0 for DATE-30 up to 30 for today */
function wellnessSeries(metrics: (i: number) => Partial<WellnessDay>): WellnessDay[] {
  return Array.from({ length: 31 }, (_, i) => {
    const date = addDaysIso(DATE, i - 30);
    return { ...emptyWellnessDay(date), ...metrics(i) };
  });
}

function withLoad(ctl: number, atl: number): Partial<WellnessDay> {
  return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10 };
}

/** Rested, on plan, mid build block */
export function freshAthlete(): AthleteFixture {
  const planned = plannedFrom(BUILD_WEEK);
  return {
    profile: PROFILE,
    season: BUILD_SEASON,
    races: [
      HALF_A_RACE,
      { date: '2026-10-18', name: 'Autumn 10k', priority: RacePriority.C, type: RaceType.run },
    ],
    wellness: wellnessSeries((i) => ({
      hrv: i === 30 ? 66 : 62 + (i % 3),
      restingHr: 46,
      sleepHours: 7.5,
      sleepScore: 84,
      ...withLoad(70, 65),
      ...(i === 30 ? { subjectiveReadiness: 4, soreness: 0 } : {}),
    })),
    activities: activitiesFor(planned),
    planned,
    decisions: [
      { date: '2026-09-24', kind: 'keep', summary: 'Kept VO2 5x4 as planned', accepted: true },
      {
        date: '2026-09-30',
        kind: 'swap',
        summary: 'Moved CSS swim to the evening',
        accepted: true,
      },
    ],
  };
}

/** HRV below baseline, deep negative TSB, missed the VO2 session, moved Sunday's long ride */
export function fatiguedAthlete(): AthleteFixture {
  const planned = plannedFrom(BUILD_WEEK).map((s): PlannedSessionSummary => {
    if (s.date === '2026-10-01') return { ...s, status: 'pushed' }; // VO2 5x4, never done
    if (s.date === '2026-09-30') return { ...s, status: 'skipped' }; // CSS swim
    if (s.date === '2026-10-04') {
      return { ...s, status: 'modified_externally', externalChange: 'moved to 2026-10-05' };
    }
    return s;
  });
  const done = new Set(['2026-09-30', '2026-10-01']);
  const activities = activitiesFor(planned)
    .filter((a) => !done.has(a.startDateLocal))
    .map((a) => (a.startDateLocal === '2026-09-27' ? { ...a, durationSec: 120 * 60 } : a));
  return {
    profile: PROFILE,
    season: BUILD_SEASON,
    races: [HALF_A_RACE],
    wellness: wellnessSeries((i) => ({
      hrv: i === 30 ? 52 : 60 + (i % 5) - 2,
      restingHr: i >= 27 ? 53 : 47,
      sleepHours: i >= 27 ? 5.8 : 7.2,
      sleepScore: i >= 27 ? 61 : 80,
      ...withLoad(75, i >= 24 ? 100 : 80),
      ...(i === 30 ? { subjectiveReadiness: 2, soreness: 2 } : {}),
    })),
    activities,
    planned,
    decisions: [
      { date: '2026-09-19', kind: 'keep', summary: 'Long run as planned', accepted: true },
      { date: '2026-09-22', kind: 'keep', summary: 'Easy run as planned', accepted: true },
      { date: '2026-09-25', kind: 'downgrade', summary: 'Long run cut to 70 min', accepted: false },
      { date: '2026-09-28', kind: 'keep', summary: 'Technique swim as planned', accepted: true },
      { date: '2026-10-01', kind: 'downgrade', summary: 'VO2 5x4 to Z2 60 min', accepted: null },
      { date: '2026-10-02', kind: 'rest', summary: 'Rest day suggested', accepted: true },
    ],
  };
}

/** Taper week, A-race in 6 days, B-race later in the season */
export function preRaceAthlete(): AthleteFixture {
  const planned = plannedFrom(TAPER_WEEK);
  return {
    profile: { ...PROFILE, ftp: 300 },
    season: TAPER_SEASON,
    races: [
      {
        date: '2026-11-15',
        name: 'Season Closer Sprint',
        priority: RacePriority.B,
        type: RaceType.sprint,
      },
      OLYMPIC_A_RACE,
    ],
    wellness: wellnessSeries((i) => ({
      hrv: 68 + (i % 4),
      restingHr: 44,
      sleepHours: 8.1,
      sleepScore: 88,
      ...withLoad(82, 70 - i * 0.2),
    })),
    activities: activitiesFor(planned),
    planned,
    decisions: [
      { date: '2026-09-21', kind: 'taper', summary: 'Taper volume to 60%', accepted: true },
      { date: '2026-09-29', kind: 'keep', summary: 'Run openers as planned', accepted: true },
      { date: '2026-10-02', kind: 'keep', summary: 'Bike openers as planned', accepted: true },
    ],
  };
}

/** Profile only: no wellness, season, races, sessions or decisions */
export function emptyAthlete(): AthleteFixture {
  return {
    profile: PROFILE,
    season: null,
    races: [],
    wellness: [],
    activities: [],
    planned: [],
    decisions: [],
  };
}

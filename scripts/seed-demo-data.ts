import type { Prisma } from '@prisma/client';
import {
  buildWorkoutSteps,
  Intensity,
  Sport,
  RacePriority,
  RaceType,
  TrainingBlockType,
} from '@triathlon/core';

/**
 * Deterministic synthetic athlete for local demos and CI: the same `today` and `seed` always give
 * the same rows. Pure (no DB, no clock); scripts/seed-demo.ts writes the result.
 */

export const DEMO_TELEGRAM_ID = 900_000_001n;
export const DEMO_DAYS = 30;
/** Days of planned sessions after today, so the athlete has an upcoming week. */
export const DEMO_PLAN_AHEAD_DAYS = 7;
export const DEMO_ICU_ATHLETE_ID = 'demo-athlete';

const DEMO_USER_ID = 'demo-user';
const DEMO_FTP = 250;
const DEMO_SEASON_ID = 'demo-season';
const DEMO_RACE_ID = 'demo-race-a';
const MS_PER_DAY = 86_400_000;
/** Lead time of the A-race: far enough that today falls inside the season's build block. */
const A_RACE_MIN_DAYS_AHEAD = 55;
const CTL_DAYS = 42;
const ATL_DAYS = 7;
const SKIP_CHANCE = 0.1;
const CHECKIN_EVERY_DAYS = 2;

export interface DemoData {
  user: Prisma.UserCreateManyInput;
  profile: Prisma.ProfileCreateManyInput;
  races: Prisma.RaceCreateManyInput[];
  seasonPlans: Prisma.SeasonPlanCreateManyInput[];
  trainingBlocks: Prisma.TrainingBlockCreateManyInput[];
  plannedSessions: Prisma.PlannedSessionCreateManyInput[];
  activities: Prisma.ActivityCreateManyInput[];
  wellness: Prisma.WellnessCreateManyInput[];
}

interface SessionTemplate {
  sport: Sport;
  intensity: Intensity;
  durationMin: number;
  title: string;
  icuType: string;
}

/** Mon rest; Tue run tempo, Wed swim, Thu bike VO2, Fri swim, Sat run, Sun long bike (key sessions). */
const WEEK_TEMPLATE: ReadonlyMap<number, SessionTemplate> = new Map([
  [
    2,
    {
      sport: Sport.run,
      intensity: Intensity.z3,
      durationMin: 50,
      title: 'Tempo run',
      icuType: 'Run',
    },
  ],
  [
    3,
    { sport: Sport.swim, intensity: Intensity.z2, durationMin: 45, title: 'Swim', icuType: 'Swim' },
  ],
  [
    4,
    {
      sport: Sport.bike,
      intensity: Intensity.z4,
      durationMin: 75,
      title: 'Bike VO2',
      icuType: 'Ride',
    },
  ],
  [
    5,
    { sport: Sport.swim, intensity: Intensity.z2, durationMin: 40, title: 'Swim', icuType: 'Swim' },
  ],
  [
    6,
    {
      sport: Sport.run,
      intensity: Intensity.z2,
      durationMin: 70,
      title: 'Easy run',
      icuType: 'Run',
    },
  ],
  [
    0,
    {
      sport: Sport.bike,
      intensity: Intensity.z2,
      durationMin: 150,
      title: 'Long ride',
      icuType: 'Ride',
    },
  ],
]);

/** Intensity factor (IF) of a zone, for the training-load estimate. */
const ZONE_IF: Readonly<Record<Intensity, number>> = {
  [Intensity.z1]: 0.55,
  [Intensity.z2]: 0.68,
  [Intensity.z3]: 0.85,
  [Intensity.z4]: 0.98,
  [Intensity.z5]: 1.1,
};

const ZONE_HR: Readonly<Record<Intensity, number>> = {
  [Intensity.z1]: 118,
  [Intensity.z2]: 135,
  [Intensity.z3]: 150,
  [Intensity.z4]: 163,
  [Intensity.z5]: 172,
};

/** Average speed in km/h by sport (z2 pace), nudged up with the zone. */
const SPORT_KMH: Readonly<Partial<Record<Sport, number>>> = {
  [Sport.swim]: 3.2,
  [Sport.bike]: 30,
  [Sport.run]: 11,
};

const BLOCK_PLAN: ReadonlyArray<{
  type: TrainingBlockType;
  weeks: number;
  focus: string;
  hours: number;
  ctl: number;
}> = [
  { type: TrainingBlockType.base, weeks: 4, focus: 'Aerobic base', hours: 8, ctl: 55 },
  { type: TrainingBlockType.build, weeks: 4, focus: 'Threshold and VO2', hours: 9, ctl: 65 },
  { type: TrainingBlockType.peak, weeks: 2, focus: 'Race-specific work', hours: 9, ctl: 72 },
  { type: TrainingBlockType.taper, weeks: 2, focus: 'Freshen up', hours: 6, ctl: 70 },
  { type: TrainingBlockType.race, weeks: 1, focus: 'Race week', hours: 4, ctl: 68 },
];

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** mulberry32: small seeded PRNG, so the demo data is reproducible. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `center` ± `spread`, uniformly. */
const around = (rng: () => number, center: number, spread: number): number =>
  center + (rng() * 2 - 1) * spread;

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** First Sunday on or after `date`. */
function sundayOnOrAfter(date: string): string {
  return addDays(date, (7 - weekdayOf(date)) % 7);
}

function buildSeason(today: string): Pick<DemoData, 'races' | 'seasonPlans' | 'trainingBlocks'> {
  const raceDate = sundayOnOrAfter(addDays(today, A_RACE_MIN_DAYS_AHEAD));
  const totalWeeks = BLOCK_PLAN.reduce((sum, b) => sum + b.weeks, 0);
  const startDate = addDays(raceDate, -(totalWeeks * 7 - 1));

  const races: Prisma.RaceCreateManyInput[] = [
    {
      id: DEMO_RACE_ID,
      userId: DEMO_USER_ID,
      date: raceDate,
      name: 'Demo Olympic',
      priority: RacePriority.A,
      type: RaceType.olympic,
    },
  ];
  const seasonPlans: Prisma.SeasonPlanCreateManyInput[] = [
    {
      id: DEMO_SEASON_ID,
      userId: DEMO_USER_ID,
      startDate,
      aRaceId: DEMO_RACE_ID,
      status: 'active',
      weeklyHoursAvailable: 10,
      weakSport: 'swim',
    },
  ];

  let blockStart = startDate;
  const trainingBlocks = BLOCK_PLAN.map((b, i): Prisma.TrainingBlockCreateManyInput => {
    const block: Prisma.TrainingBlockCreateManyInput = {
      id: `demo-block-${i + 1}`,
      seasonPlanId: DEMO_SEASON_ID,
      order: i + 1,
      type: b.type,
      startDate: blockStart,
      weeks: b.weeks,
      focus: b.focus,
      targetWeeklyHours: b.hours,
      targetSwimM: round(b.hours * 330, 0),
      targetBikeH: round(b.hours * 0.45),
      targetRunKm: round(b.hours * 4),
      targetCtl: b.ctl,
    };
    blockStart = addDays(blockStart, b.weeks * 7);
    return block;
  });

  return { races, seasonPlans, trainingBlocks };
}

interface PlannedDay {
  date: string;
  template: SessionTemplate;
  planned: Prisma.PlannedSessionCreateManyInput;
  skipped: boolean;
}

function pastStatus(past: boolean, skipped: boolean): 'draft' | 'completed' | 'skipped' {
  if (!past) return 'draft';
  return skipped ? 'skipped' : 'completed';
}

function planDays(today: string, rng: () => number): PlannedDay[] {
  const from = addDays(today, -(DEMO_DAYS - 1));
  const to = addDays(today, DEMO_PLAN_AHEAD_DAYS);
  return daysBetween(from, to).flatMap((date): PlannedDay[] => {
    const template = WEEK_TEMPLATE.get(weekdayOf(date));
    if (!template) return [];
    const past = date < today;
    const skipped = past && rng() < SKIP_CHANCE;
    const status = pastStatus(past, skipped);
    const planned: Prisma.PlannedSessionCreateManyInput = {
      id: `demo-ps-${date}`,
      userId: DEMO_USER_ID,
      date,
      slot: `${template.sport}-1`,
      sport: template.sport,
      title: template.title,
      description: 'Demo session',
      durationMin: template.durationMin,
      intensity: template.intensity,
      steps: buildWorkoutSteps({ ...template, tags: [] }) as unknown as Prisma.InputJsonValue,
      status,
    };
    return [{ date, template, planned, skipped }];
  });
}

function activityFor(
  day: PlannedDay,
  rng: () => number
): { activity: Prisma.ActivityCreateManyInput; deviationPct: number } {
  const { template, date } = day;
  const durationMin = template.durationMin * around(rng, 1, 0.1);
  const durationSec = Math.round(durationMin * 60);
  const zoneIf = ZONE_IF[template.intensity];
  const speed = (SPORT_KMH[template.sport] ?? 0) * (1 + (zoneIf - ZONE_IF[Intensity.z2]) * 0.3);
  const isBike = template.sport === Sport.bike;
  const activity: Prisma.ActivityCreateManyInput = {
    id: `demo-act-${date}`,
    icuId: `demo-${date}`,
    userId: DEMO_USER_ID,
    icuAthleteId: DEMO_ICU_ATHLETE_ID,
    sport: template.sport,
    icuType: template.icuType,
    name: template.title,
    startTime: new Date(`${date}T06:00:00.000Z`),
    startDateLocal: date,
    durationSec,
    distanceM: round((durationSec / 3600) * speed * 1000, 0),
    load: Math.round((durationSec / 3600) * zoneIf ** 2 * 100),
    avgHr: Math.round(around(rng, ZONE_HR[template.intensity], 4)),
    avgPower: isBike ? Math.round(DEMO_FTP * zoneIf * around(rng, 1, 0.03)) : null,
    source: 'GARMIN_CONNECT',
    plannedSessionId: `demo-ps-${date}`,
    closedOutAt: new Date(`${date}T20:30:00.000Z`),
  };
  const deviationPct = round(
    ((durationSec / 60 - template.durationMin) / template.durationMin) * 100
  );
  return { activity, deviationPct };
}

/** An easy run on a rest day: closed out with no planned session, the weekly review's "unplanned". */
function unplannedActivity(today: string): Prisma.ActivityCreateManyInput | null {
  const monday = daysBetween(addDays(today, -(DEMO_DAYS - 1)), addDays(today, -1)).find(
    (d, i) => weekdayOf(d) === 1 && i >= DEMO_DAYS / 2
  );
  if (!monday) return null;
  return {
    id: `demo-act-${monday}-extra`,
    icuId: `demo-${monday}-extra`,
    userId: DEMO_USER_ID,
    icuAthleteId: DEMO_ICU_ATHLETE_ID,
    sport: Sport.run,
    icuType: 'Run',
    name: 'Extra easy run',
    startTime: new Date(`${monday}T17:00:00.000Z`),
    startDateLocal: monday,
    durationSec: 30 * 60,
    distanceM: 5200,
    load: 22,
    avgHr: 128,
    avgPower: null,
    source: 'GARMIN_CONNECT',
    closedOutAt: new Date(`${monday}T20:30:00.000Z`),
  };
}

function buildWellness(
  today: string,
  loadByDate: ReadonlyMap<string, number>,
  rng: () => number
): Prisma.WellnessCreateManyInput[] {
  let ctl = 40;
  let atl = 40;
  const dates = daysBetween(addDays(today, -(DEMO_DAYS - 1)), today);
  return dates.map((date, i): Prisma.WellnessCreateManyInput => {
    const load = loadByDate.get(date) ?? 0;
    ctl += (load - ctl) / CTL_DAYS;
    atl += (load - atl) / ATL_DAYS;
    const checkedIn = i % CHECKIN_EVERY_DAYS === 0;
    return {
      id: `demo-wellness-${date}`,
      userId: DEMO_USER_ID,
      date,
      hrv: round(around(rng, 65, 7)),
      restingHr: Math.round(around(rng, 48, 2)),
      sleepHours: round(around(rng, 7.3, 0.8)),
      sleepScore: Math.round(around(rng, 80, 8)),
      weightKg: round(around(rng, 72, 0.3)),
      ctl: round(ctl),
      atl: round(atl),
      tsb: round(ctl - atl),
      subjectiveReadiness: checkedIn ? Math.round(around(rng, 3.8, 1)) : null,
      soreness: checkedIn ? Math.floor(rng() * 3) : null,
    };
  });
}

export function buildDemoData(today: string, seed = 42): DemoData {
  const rng = createRng(seed);
  const days = planDays(today, rng);
  const matched = days.filter((d) => d.date < today && !d.skipped).map((d) => activityFor(d, rng));
  const extra = unplannedActivity(today);
  const activities = [...matched.map((m) => m.activity), ...(extra ? [extra] : [])];

  const deviationByDate = new Map(matched.map((m) => [m.activity.startDateLocal, m.deviationPct]));
  const plannedSessions = days.map(({ planned }) => {
    const deviationPct = deviationByDate.get(planned.date);
    return deviationPct === undefined ? planned : { ...planned, deviationPct };
  });

  const loadByDate = new Map<string, number>();
  for (const a of activities) {
    loadByDate.set(a.startDateLocal, (loadByDate.get(a.startDateLocal) ?? 0) + (a.load ?? 0));
  }

  return {
    user: { id: DEMO_USER_ID, telegramId: DEMO_TELEGRAM_ID },
    profile: { id: 'demo-profile', userId: DEMO_USER_ID, ftp: DEMO_FTP, lthr: 165 },
    ...buildSeason(today),
    plannedSessions,
    activities,
    wellness: buildWellness(today, loadByDate, rng),
  };
}

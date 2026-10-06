import { describe, it, expect } from 'vitest';
import { addDays, format, parseISO } from 'date-fns';
import { dayNameOf } from '../src/plan-generator';
import {
  Intensity,
  isHardSession,
  isIntensitySession,
  isRaceSession,
  RulesContext,
  Session,
  Sport,
  UserProfile,
} from '../src/types';
import { buildWorkoutSteps } from '../src/workout';
import {
  aRaceWindow,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  expandWeek,
  generateSeasonPlan,
  Race,
  RacePriority,
  RaceType,
  seasonDraftsForRange,
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
const START = '2026-01-05'; // Monday
const WEEK = '2026-10-05'; // Monday of the single-week tests

function iso(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

function race(date: string, priority: RacePriority, type = RaceType.half): Race {
  return { date, name: 'Test Race', priority, type };
}

function block(type: TrainingBlockType, hours: number, startDate = WEEK): TrainingBlock {
  const split = CFG.sportSplit[RaceType.half];
  return {
    order: 1,
    type,
    startDate,
    weeks: 1,
    focus: 'test',
    targetWeeklyHours: hours,
    targetSwimM: hours * split.swim * CFG.swimMPerHour,
    targetBikeH: hours * split.bike,
    targetRunKm: hours * split.run * CFG.runKmPerHour,
    targetCtl: null,
  };
}

function trainingMinutes(sessions: Session[]): number {
  return sessions.filter((s) => !isRaceSession(s)).reduce((sum, s) => sum + s.durationMin, 0);
}

function on(sessions: Session[], date: string): Session[] {
  return sessions.filter((s) => s.date === date);
}

/** `date sport title min zone` per session, for template snapshots */
function render(sessions: Session[]): string {
  return sessions
    .map((s) =>
      [dayNameOf(s.date), s.sport, s.title, `${s.durationMin.toString()}m`, s.intensity].join(' ')
    )
    .join('\n');
}

describe('A-race taper (half distance)', () => {
  const weeks = 24;
  const raceDate = iso(START, weeks * 7 - 1); // a Sunday
  const aRace = race(raceDate, RacePriority.A);
  const season = generateSeasonPlan({
    aRace,
    weeklyHoursAvailable: 10,
    currentWeeklyLoad: 6,
    startDate: START,
  });
  const peak = season.weeks.findLast((w) => w.kind === 'load')?.hours ?? 0;
  const lastTaperStart = iso(raceDate, -13);
  const raceWeekStart = iso(raceDate, -6);

  async function draftsFor(from: string): Promise<Session[]> {
    const range = { from, to: iso(from, 6) };
    const result = await seasonDraftsForRange(
      season,
      PROFILE,
      range,
      () => Promise.resolve(EMPTY_CONTEXT),
      [aRace]
    );
    return result.sessions;
  }

  it('publishes the final 2 weeks at ~60% and ~40% of peak', async () => {
    const [taper, raceWeek] = await Promise.all([
      draftsFor(lastTaperStart),
      draftsFor(raceWeekStart),
    ]);
    expect(Math.abs(trainingMinutes(taper) / 60 / (peak * 0.6) - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(trainingMinutes(raceWeek) / 60 / (peak * 0.4) - 1)).toBeLessThanOrEqual(0.05);
  });

  it('keeps the weekly intensity-session count constant', async () => {
    const [taper, raceWeek] = await Promise.all([
      draftsFor(lastTaperStart),
      draftsFor(raceWeekStart),
    ]);
    expect(taper.filter(isIntensitySession).length).toBe(2);
    expect(raceWeek.filter(isIntensitySession).length).toBe(2);
  });

  it('declines from the first taper week to the last', async () => {
    const [first, last] = await Promise.all([
      draftsFor(iso(raceDate, -20)),
      draftsFor(lastTaperStart),
    ]);
    expect(trainingMinutes(first)).toBeGreaterThan(trainingMinutes(last));
  });

  it('puts the race on race day', async () => {
    const raceDay = on(await draftsFor(raceWeekStart), raceDate);
    expect(raceDay).toHaveLength(1);
    expect(raceDay[0]).toMatchObject({
      sport: Sport.other,
      title: '🏁 Test Race',
      durationMin: CFG.raceDurationMin[RaceType.half],
    });
  });
});

describe('race week', () => {
  const weekdays = Array.from({ length: 7 }, (_, i) => iso(WEEK, i));
  const cases = Object.values(RaceType).flatMap((type) =>
    weekdays.map((date) => ({ type, date, day: dayNameOf(date) }))
  );

  it.each(cases)('$type race on $day: opener at T-1, nothing hard after T-3', ({ type, date }) => {
    const aRace = race(date, RacePriority.A, type);
    const raceBlock = block(TrainingBlockType.race, 4);
    const taperBlock = block(TrainingBlockType.taper, 6, iso(WEEK, -7));
    const weeksOf = [
      expandWeek(taperBlock, 0, PROFILE, { races: [aRace], aRaceWeekHours: 4 }),
      expandWeek(raceBlock, 0, PROFILE, { races: [aRace] }),
    ];
    const sessions = weeksOf.flatMap((w) => w.plan.sessions);

    const openers = on(sessions, iso(date, -1));
    expect(openers).toHaveLength(1);
    expect(openers[0].durationMin).toBeLessThanOrEqual(CFG.openerMaxMin);
    expect(openers[0].tags).toContain('openers');
    const reps = buildWorkoutSteps(openers[0]).find((b) => b.kind === 'repeat');
    expect(reps?.kind === 'repeat' && reps.count).toBeGreaterThanOrEqual(2);
    expect(reps?.kind === 'repeat' && reps.count).toBeLessThanOrEqual(3);

    const late = sessions.filter((s) => s.date > iso(date, -3) && s.date < date);
    expect(late.filter(isHardSession)).toEqual([]);

    const t3 = on(sessions, iso(date, -3));
    expect(t3.every((s) => s.durationMin <= 20 && s.intensity === Intensity.z1)).toBe(true);
    for (const week of weeksOf) expect(week.violations).toEqual([]);
  });

  it('rests at T-3 before a half and spins 20′ before a sprint', () => {
    const date = iso(WEEK, 6);
    const half = aRaceWindow(race(date, RacePriority.A, RaceType.half), 4, CFG).sessions;
    const sprint = aRaceWindow(race(date, RacePriority.A, RaceType.sprint), 4, CFG).sessions;
    expect(on(half, iso(date, -3))).toEqual([]);
    expect(on(sprint, iso(date, -3))).toMatchObject([{ title: 'Easy Spin', durationMin: 20 }]);
  });

  it('turns a T-1 travel day into rest and moves the opener to T-2', () => {
    const date = iso(WEEK, 6);
    const travelling = { ...race(date, RacePriority.A), travelDate: iso(date, -1) };
    const sessions = aRaceWindow(travelling, 4, CFG).sessions;
    expect(on(sessions, iso(date, -1))).toEqual([]);
    expect(on(sessions, iso(date, -2)).some((s) => s.tags?.includes('openers'))).toBe(true);
  });

  it('ignores a travel day outside T-3..T-1', () => {
    const date = iso(WEEK, 6);
    const early = { ...race(date, RacePriority.A), travelDate: iso(date, -5) };
    expect(aRaceWindow(early, 4, CFG)).toEqual(aRaceWindow(race(date, RacePriority.A), 4, CFG));
  });

  it.each(Object.values(RaceType))('template snapshot: %s race on Sunday', (type) => {
    const sessions = aRaceWindow(race(iso(WEEK, 6), RacePriority.A, type), 5, CFG).sessions;
    expect(render(sessions)).toMatchSnapshot();
  });
});

describe('B-race mini-taper', () => {
  const build = block(TrainingBlockType.build, 10);

  it.each([
    [RaceType.sprint, 3],
    [RaceType.olympic, 3],
    [RaceType.half, 4],
    [RaceType.full, 5],
  ])('%s: tapers the %i days before the race', (type, days) => {
    const date = iso(WEEK, 6); // Sunday
    const plain = expandWeek(build, 0, PROFILE).plan.sessions;
    const tapered = expandWeek(build, 0, PROFILE, {
      races: [race(date, RacePriority.B, type)],
    }).plan.sessions;

    const window = (s: Session) => s.date >= iso(date, -days) && s.date < date;
    expect(trainingMinutes(tapered.filter(window))).toBeLessThan(
      trainingMinutes(plain.filter(window))
    );
    expect(tapered.filter((s) => window(s) && !s.tags?.includes('taper'))).toEqual([]);
    expect(trainingMinutes(tapered.filter((s) => s.date < iso(date, -days)))).toBe(
      trainingMinutes(plain.filter((s) => s.date < iso(date, -days)))
    );
    expect(on(tapered, iso(date, -1)).map((s) => s.title)).toEqual(['Race Openers']);
    expect(on(tapered, date).map((s) => s.title)).toEqual(['🏁 Test Race']);
  });

  it('starts the mini-taper in the week before a Monday race', () => {
    const date = iso(WEEK, 7);
    const week = expandWeek(build, 0, PROFILE, { races: [race(date, RacePriority.B)] });
    expect(on(week.plan.sessions, iso(date, -1)).map((s) => s.title)).toEqual(['Race Openers']);
    expect(week.plan.sessions.some(isRaceSession)).toBe(false);
  });

  it('is swapped in like a C-race inside the A taper', () => {
    const taper = block(TrainingBlockType.taper, 6);
    const date = iso(WEEK, 5);
    const week = expandWeek(taper, 0, PROFILE, { races: [race(date, RacePriority.B)] });
    expect(on(week.plan.sessions, iso(date, -1)).some((s) => s.title === 'Race Openers')).toBe(
      false
    );
    expect(on(week.plan.sessions, date).map((s) => s.title)).toEqual(['🏁 Test Race']);
  });
});

describe('C-race', () => {
  const build = block(TrainingBlockType.build, 10);

  it('keeps normal volume and swaps the Saturday key session for the race', () => {
    const saturday = iso(WEEK, 5);
    const plain = expandWeek(build, 0, PROFILE).plan.sessions;
    const week = expandWeek(build, 0, PROFILE, { races: [race(saturday, RacePriority.C)] });
    const sessions = week.plan.sessions;

    const replaced = on(plain, saturday);
    expect(replaced.some((s) => s.tags?.includes('long') || isHardSession(s))).toBe(true);
    expect(on(sessions, saturday).map((s) => s.title)).toEqual(['🏁 Test Race']);
    // Every other day is exactly what the block planned (up to rules-engine downgrades of
    // hard sessions next to the race)
    const strip = (s: Session) => [s.date, s.sport, s.durationMin];
    expect(sessions.filter((s) => s.date !== saturday).map(strip)).toEqual(
      plain.filter((s) => s.date !== saturday).map(strip)
    );
    expect(week.violations).toEqual([]);
  });

  it('drops the nearest key session when the race day had none', () => {
    const monday = WEEK;
    const plain = expandWeek(build, 0, PROFILE).plan.sessions;
    const week = expandWeek(build, 0, PROFILE, { races: [race(monday, RacePriority.C)] });
    expect(on(plain, monday).some((s) => isHardSession(s) || s.tags?.includes('long'))).toBe(false);
    const keys = (sessions: Session[]) =>
      sessions.filter((s) => !isRaceSession(s) && (isHardSession(s) || s.tags?.includes('long')));
    expect(keys(week.plan.sessions).length).toBe(keys(plain).length - 1);
  });

  it('never lets the rules engine downgrade the race', () => {
    const thursday = iso(WEEK, 3); // the profile's VO2 bike day
    const week = expandWeek(build, 0, PROFILE, { races: [race(thursday, RacePriority.C)] });
    const raceDay = on(week.plan.sessions, thursday);
    expect(raceDay).toMatchObject([{ title: '🏁 Test Race', intensity: Intensity.z4 }]);
    const neighbours = week.plan.sessions.filter(
      (s) => s.date === iso(thursday, -1) || s.date === iso(thursday, 1)
    );
    expect(neighbours.filter(isHardSession)).toEqual([]);
  });
});

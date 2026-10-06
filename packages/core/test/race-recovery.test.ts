import { describe, it, expect } from 'vitest';
import { addDays, format, parseISO } from 'date-fns';
import { Intensity, Session, UserProfile } from '../src/types';
import {
  applyRaceOverrides,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  DEFAULT_RECOVERY_CONFIG,
  expandWeek,
  maxRecoveryDays,
  Race,
  RacePriority,
  RaceType,
  recoveryDays,
  recoverySessions,
  recoveryWindow,
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
const WEEK = '2026-10-05'; // Monday
const RACE_DATE = '2026-10-11'; // Sunday

function iso(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

function race(priority: RacePriority, type: RaceType, date = RACE_DATE): Race {
  return { date, name: 'Test Race', priority, type };
}

function buildBlock(startDate: string): TrainingBlock {
  const split = CFG.sportSplit[RaceType.half];
  return {
    order: 1,
    type: TrainingBlockType.build,
    startDate,
    weeks: 1,
    focus: 'test',
    targetWeeklyHours: 10,
    targetSwimM: 10 * split.swim * CFG.swimMPerHour,
    targetBikeH: 10 * split.bike,
    targetRunKm: 10 * split.run * CFG.runKmPerHour,
  } as TrainingBlock;
}

describe('recovery matrix', () => {
  it.each([
    [RacePriority.A, RaceType.sprint, 7],
    [RacePriority.A, RaceType.olympic, 7],
    [RacePriority.A, RaceType.half, 10],
    [RacePriority.A, RaceType.full, 14],
    [RacePriority.B, RaceType.sprint, 2],
    [RacePriority.B, RaceType.olympic, 3],
    [RacePriority.B, RaceType.half, 4],
    [RacePriority.B, RaceType.full, 4],
    [RacePriority.C, RaceType.sprint, 0],
    [RacePriority.C, RaceType.olympic, 1],
    [RacePriority.C, RaceType.half, 2],
    [RacePriority.C, RaceType.full, 2],
  ])('%s %s race: %i days', (priority, type, days) => {
    expect(recoveryDays({ priority, type })).toBe(days);
  });

  it('stays inside the ticket ranges for every priority and type', () => {
    const ranges = {
      [RacePriority.A]: [7, 14],
      [RacePriority.B]: [2, 4],
      [RacePriority.C]: [0, 2],
    } as const;
    for (const priority of Object.values(RacePriority)) {
      for (const type of Object.values(RaceType)) {
        const days = recoveryDays({ priority, type });
        expect(days).toBeGreaterThanOrEqual(ranges[priority][0]);
        expect(days).toBeLessThanOrEqual(ranges[priority][1]);
      }
    }
    expect(maxRecoveryDays()).toBe(14);
  });

  it('has no window for a zero-day recovery', () => {
    expect(recoveryWindow(race(RacePriority.C, RaceType.sprint))).toBeNull();
    expect(recoveryWindow(race(RacePriority.A, RaceType.full))).toEqual({
      from: '2026-10-12',
      to: '2026-10-25',
    });
  });
});

describe('recoverySessions', () => {
  it('rests first, then one easy session every other day inside the window', () => {
    const sessions = recoverySessions(race(RacePriority.A, RaceType.full));
    expect(sessions.map((s) => s.date)).toEqual(
      [4, 6, 8, 10, 12, 14].map((d) => iso(RACE_DATE, d))
    );
    expect(sessions.every((s) => s.intensity === Intensity.z1)).toBe(true);
    expect(sessions.every((s) => s.durationMin === DEFAULT_RECOVERY_CONFIG.sessionMin)).toBe(true);
    expect(sessions.every((s) => s.tags?.includes('recovery'))).toBe(true);
  });

  it('is empty when the recovery is 0 days and starts with the bike for a run race', () => {
    expect(recoverySessions(race(RacePriority.C, RaceType.sprint))).toHaveLength(0);
    const run = recoverySessions(race(RacePriority.A, RaceType.run));
    expect(run[0].sport).toBe('bike');
  });

  it('is deterministic', () => {
    const a = race(RacePriority.B, RaceType.half);
    expect(recoverySessions(a)).toEqual(recoverySessions(a));
  });
});

describe('applyRaceOverrides recovery', () => {
  function weeks(r: Race, count: number): Session[] {
    const all: Session[] = [];
    for (let i = 0; i < count; i++) {
      const start = iso(WEEK, 7 * i);
      all.push(
        ...expandWeek(buildBlock(start), 0, PROFILE, { races: [r], aRaceWeekHours: 4 }).plan
          .sessions
      );
    }
    return all;
  }

  it('A full: the 14 days after the race hold only Z1 sessions or rest', () => {
    const r = race(RacePriority.A, RaceType.full);
    const after = weeks(r, 4).filter((s) => s.date > r.date && s.date <= iso(r.date, 14));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.intensity === Intensity.z1)).toBe(true);
    expect(after.every((s) => s.tags?.includes('recovery'))).toBe(true);
  });

  it('resumes the block plan after the recovery window', () => {
    const r = race(RacePriority.B, RaceType.sprint);
    const after = weeks(r, 3).filter((s) => s.date > iso(r.date, 2));
    expect(after.some((s) => !s.tags?.includes('recovery'))).toBe(true);
  });

  it('C sprint changes nothing after the race', () => {
    const r = race(RacePriority.C, RaceType.sprint);
    const after = weeks(r, 2).filter((s) => s.date > r.date);
    expect(after.some((s) => s.tags?.includes('recovery'))).toBe(false);
  });

  it('is idempotent', () => {
    const r = race(RacePriority.A, RaceType.half);
    const input = {
      weekStart: iso(WEEK, 7),
      weekEnd: iso(WEEK, 13),
      blockType: TrainingBlockType.build,
      races: [r],
      aRaceWeekHours: 4,
      config: CFG,
    };
    const once = applyRaceOverrides([], input);
    expect(applyRaceOverrides(once, input)).toEqual(once);
  });
});

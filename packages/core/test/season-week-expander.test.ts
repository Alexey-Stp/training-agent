import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkHardRules } from '../src/rules-engine';
import { dayNameOf } from '../src/plan-generator';
import { workoutMinutes } from '../src/workout';
import { Intensity, isHardSession, RulesContext, Sport, UserProfile } from '../src/types';
import {
  blockWeekStart,
  blockWeekTargets,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  draftBlockWeek,
  expandWeek,
  ExpandedWeek,
  RaceType,
  TrainingBlock,
  TrainingBlockType,
  weekIndexForDate,
  weekVolume,
} from '../src/season';

const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};
const START = '2026-10-05'; // Monday
const CFG = DEFAULT_BLOCK_GENERATOR_CONFIG;
const HALF_SPLIT = CFG.sportSplit[RaceType.half]; // 0.15 / 0.55 / 0.3

/** Block whose weekly targets are `hours` split by `split` */
function block(
  type: TrainingBlockType,
  hours = 10,
  split = HALF_SPLIT,
  overrides: Partial<TrainingBlock> = {}
): TrainingBlock {
  return {
    order: 1,
    type,
    startDate: START,
    weeks: 4,
    focus: 'test',
    targetWeeklyHours: hours,
    targetSwimM: hours * split.swim * CFG.swimMPerHour,
    targetBikeH: hours * split.bike,
    targetRunKm: hours * split.run * CFG.runKmPerHour,
    targetCtl: null,
    ...overrides,
  };
}

function expectWithin(actual: number, target: number, tolerance: number): void {
  if (target === 0) {
    expect(actual).toBe(0);
    return;
  }
  expect(Math.abs(actual - target) / target).toBeLessThanOrEqual(tolerance);
}

/** ±5% on the total, ±10% per sport */
function expectOnTarget(week: ExpandedWeek): void {
  const planned = weekVolume(week.plan.sessions);
  expectWithin(planned.hours, week.targets.hours, 0.05);
  expectWithin(planned.swimH, week.targets.swimH, 0.1);
  expectWithin(planned.bikeH, week.targets.bikeH, 0.1);
  expectWithin(planned.runH, week.targets.runH, 0.1);
}

function sessionsOn(week: ExpandedWeek, sport: Sport): string[] {
  return week.plan.sessions.filter((s) => s.sport === sport).map((s) => dayNameOf(s.date));
}

function readiness(subjectiveReadiness: number): RulesContext {
  return {
    last7dStats: { totalMinutes: 0, byDate: [] },
    todayWellness: { subjectiveReadiness, sleepScore: null, hrv: null, restingHr: null, tsb: null },
  };
}

describe('expandWeek', () => {
  describe('volume accuracy', () => {
    it('hits a 10 h base week within ±5% total and ±10% per sport', () => {
      const week = expandWeek(block(TrainingBlockType.base, 10), 0, PROFILE);

      expect(week.targets).toEqual({ hours: 10, swimH: 1.5, bikeH: 5.5, runH: 3 });
      expectOnTarget(week);
    });

    it.each([
      [TrainingBlockType.base, 10],
      [TrainingBlockType.build, 12],
      [TrainingBlockType.peak, 13],
      [TrainingBlockType.recovery, 6],
      [TrainingBlockType.transition, 5],
      [TrainingBlockType.taper, 6],
      [TrainingBlockType.race, 4],
    ])('hits the targets of a %s week (%d h)', (type, hours) => {
      expectOnTarget(expandWeek(block(type, hours), 1, PROFILE));
    });

    it('stays on target across hours and race splits', () => {
      const splits = Object.values(CFG.sportSplit);
      fc.assert(
        fc.property(
          fc.integer({ min: 8, max: 36 }).map((half) => half / 2),
          fc.constantFrom(...splits),
          fc.constantFrom(TrainingBlockType.base, TrainingBlockType.build),
          (hours, split, type) => {
            expectOnTarget(expandWeek(block(type, hours, split), 0, PROFILE));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('sizes sessions in 5-minute steps of at least 20 minutes', () => {
      const week = expandWeek(block(TrainingBlockType.build, 9), 0, PROFILE);

      for (const s of week.plan.sessions) {
        expect(s.durationMin % 5).toBe(0);
        expect(s.durationMin).toBeGreaterThanOrEqual(20);
      }
    });

    it('drops the optional swim first when swim volume is low', () => {
      const week = expandWeek(block(TrainingBlockType.base, 6), 0, PROFILE);

      expect(week.plan.sessions.some((s) => s.tags?.includes('optional'))).toBe(false);
      expect(sessionsOn(week, Sport.swim)).toEqual(['Wed', 'Fri']);
    });

    it('uses the targets override, e.g. a recovery week inside the block', () => {
      const targets = { hours: 6, swimH: 1, bikeH: 3, runH: 2 };
      const week = expandWeek(block(TrainingBlockType.build, 12), 2, PROFILE, { targets });

      expect(week.targets).toEqual(targets);
      expectOnTarget(week);
    });
  });

  describe('taper', () => {
    function expectTaperShape(week: ExpandedWeek): void {
      for (const s of week.plan.sessions) expect(s.durationMin).toBeLessThanOrEqual(75);
      expect(week.plan.sessions.filter(isHardSession).length).toBeLessThanOrEqual(2);
    }

    it('keeps sessions ≤ 75 min with at most 2 intensity touches', () => {
      const week = expandWeek(block(TrainingBlockType.taper, 6), 0, PROFILE);

      expectTaperShape(week);
      expect(week.plan.sessions.filter(isHardSession).map((s) => s.title)).toEqual([
        'Run Sharpening',
        'Bike Sharpening',
      ]);
    });

    it('holds the cap on a big taper week and says what did not fit', () => {
      const week = expandWeek(block(TrainingBlockType.taper, 12), 0, PROFILE);

      expectTaperShape(week);
      expect(week.plan.warnings).toContainEqual(
        expect.stringContaining("of bike doesn't fit under the 75min taper session cap")
      );
    });

    it('applies the same limits to race weeks', () => {
      expectTaperShape(expandWeek(block(TrainingBlockType.race, 8), 0, PROFILE));
    });
  });

  describe('rules engine gate', () => {
    it('corrects a hard-hard draft so the result passes every hard rule', () => {
      // Build: Thu VO2 bike (profile) is followed by the Fri threshold swim (profile)
      const b = block(TrainingBlockType.build, 10);
      const { plan: draft } = draftBlockWeek(b, 0, PROFILE);
      expect(checkHardRules(draft, readiness(5)).map((v) => v.rule)).toEqual(['NoHardHard']);

      const week = expandWeek(b, 0, PROFILE);

      expect(week.violations).toEqual([]);
      expect(week.plan.appliedRules).toContain(
        'NoHardHard: Prevented consecutive hard training days'
      );
      const friSwim = week.plan.sessions.find(
        (s) => s.sport === Sport.swim && dayNameOf(s.date) === 'Fri'
      );
      expect(friSwim?.intensity).toBe(Intensity.z2);
      expectOnTarget(week); // downgrades change intensity, not duration
    });

    it('downgrades a hard session on the first day when readiness is low', () => {
      const profile = { ...PROFILE, bikeVo2Day: 'Mon' };
      const week = expandWeek(block(TrainingBlockType.build, 10), 0, profile, {
        context: readiness(2),
      });

      const monday = week.plan.sessions.filter((s) => s.date === START);
      expect(monday.some(isHardSession)).toBe(false);
      expect(week.violations).toEqual([]);
    });

    it('never places the key run next to the key bike day', () => {
      for (const bikeVo2Day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
        const profile = { ...PROFILE, bikeVo2Day, swimDays: [] };
        const week = expandWeek(block(TrainingBlockType.build, 10), 0, profile);

        expect(week.plan.appliedRules).toEqual([]);
        expect(week.violations).toEqual([]);
      }
    });

    it('has no hard sessions in base and recovery weeks', () => {
      for (const type of [TrainingBlockType.base, TrainingBlockType.recovery]) {
        const week = expandWeek(block(type, 10), 0, PROFILE);
        expect(week.plan.sessions.filter(isHardSession)).toEqual([]);
      }
    });
  });

  describe('profile constraints', () => {
    it('puts swims on Wed/Fri (+ optional Sun) and the long bike on Sun', () => {
      const week = expandWeek(block(TrainingBlockType.base, 12), 0, PROFILE);

      expect(sessionsOn(week, Sport.swim)).toEqual(['Wed', 'Fri', 'Sun']);
      const sunSwim = week.plan.sessions.find(
        (s) => s.sport === Sport.swim && dayNameOf(s.date) === 'Sun'
      );
      expect(sunSwim?.tags).toEqual(['optional']);
      const longBike = week.plan.sessions.find((s) => s.title === 'Long Bike');
      expect(longBike && dayNameOf(longBike.date)).toBe('Sun');
      const longest = Math.max(...week.plan.sessions.map((s) => s.durationMin));
      expect(longBike?.durationMin).toBe(longest);
    });

    it('moves the long bike with longBikeDay and keeps the long run off it and noLongRunDay', () => {
      const profile = { ...PROFILE, longBikeDay: 'Sat' };
      const week = expandWeek(block(TrainingBlockType.base, 10), 0, profile);

      const longBike = week.plan.sessions.find((s) => s.title === 'Long Bike');
      const longRun = week.plan.sessions.find((s) => s.title === 'Long Run');
      expect(longBike && dayNameOf(longBike.date)).toBe('Sat');
      expect(longRun && dayNameOf(longRun.date)).not.toBe('Sat');
      expect(longRun && dayNameOf(longRun.date)).not.toBe('Sun');
    });

    it('puts the key bike on bikeVo2Day', () => {
      const week = expandWeek(block(TrainingBlockType.build, 10), 0, {
        ...PROFILE,
        bikeVo2Day: 'Tue',
      });

      const vo2 = week.plan.sessions.find((s) => s.tags?.includes('vo2'));
      expect(vo2 && dayNameOf(vo2.date)).toBe('Tue');
    });

    it('follows other swim days', () => {
      const week = expandWeek(block(TrainingBlockType.base, 10), 0, {
        ...PROFILE,
        swimDays: ['Mon', 'Thu'],
      });

      expect(sessionsOn(week, Sport.swim)).toEqual(['Mon', 'Thu']);
      expectOnTarget(week);
    });

    it('warns when the profile has no swim days', () => {
      const week = expandWeek(block(TrainingBlockType.base, 10), 0, { ...PROFILE, swimDays: [] });

      expect(sessionsOn(week, Sport.swim)).toEqual([]);
      expect(week.plan.warnings).toContain(
        '⚠️ No swim days in your profile, so 90min of swim is not planned'
      );
    });
  });

  describe('week layout', () => {
    it('starts week i at block start + 7·i and stays inside it', () => {
      const week = expandWeek(block(TrainingBlockType.base), 2, PROFILE);

      expect(week.weekStart).toBe('2026-10-19');
      expect(week.plan.startDate).toBe('2026-10-19');
      for (const s of week.plan.sessions) {
        expect(s.date >= '2026-10-19' && s.date <= '2026-10-25').toBe(true);
      }
    });

    it.each([-1, 4, 1.5])('rejects week index %d', (weekIndex) => {
      expect(() => expandWeek(block(TrainingBlockType.base), weekIndex, PROFILE)).toThrow(
        RangeError
      );
    });

    it('returns PlannedSession drafts whose steps add up to the duration', () => {
      const week = expandWeek(block(TrainingBlockType.build), 0, PROFILE);

      expect(week.sessions).toHaveLength(week.plan.sessions.length);
      for (const d of week.sessions) {
        expect(workoutMinutes(d.steps)).toBe(d.durationMin);
        expect(d.slot).toMatch(/^(swim|bike|run)-\d$/);
      }
    });
  });
});

describe('block week helpers', () => {
  it('converts swim metres and run km to hours and keeps the total', () => {
    const b = block(TrainingBlockType.base, 10, HALF_SPLIT, { targetSwimM: 3800 });

    const t = blockWeekTargets(b);
    expect(t.hours).toBe(10);
    expect(t.swimH + t.bikeH + t.runH).toBeCloseTo(10, 1);
  });

  it('finds the week of a date', () => {
    const b = block(TrainingBlockType.base);

    expect(weekIndexForDate(b, '2026-10-04')).toBeNull();
    expect(weekIndexForDate(b, START)).toBe(0);
    expect(weekIndexForDate(b, '2026-10-14')).toBe(1);
    expect(weekIndexForDate(b, '2026-11-01')).toBe(3);
    expect(weekIndexForDate(b, '2026-11-02')).toBeNull();
    expect(blockWeekStart(b, 3)).toBe('2026-10-26');
  });
});

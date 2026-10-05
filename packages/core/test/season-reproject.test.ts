import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addDays, differenceInCalendarDays, endOfISOWeek, format, parseISO } from 'date-fns';
import {
  addDaysIso,
  assertValidSeasonPlan,
  blockEndDate,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  generateSeasonPlan,
  GeneratedSeason,
  Race,
  RacePriority,
  RaceType,
  ReprojectedSeason,
  reprojectSeason,
  ReprojectInput,
  SeasonGenerationError,
  SeasonPlanStatus,
  SeasonWeek,
  TrainingBlock,
  TrainingBlockType,
} from '../src/season';
import { reprojectionSeed } from '../src/reviews';

const START = '2026-01-05'; // Monday
const CFG = DEFAULT_BLOCK_GENERATOR_CONFIG;
const EPS = 1e-6;

function sundayOfWeek(weeks: number): string {
  return format(addDays(parseISO(START), weeks * 7 - 1), 'yyyy-MM-dd');
}

function race(date: string, type = RaceType.half): Race {
  return { date, name: 'Challenge Prague', priority: RacePriority.A, type };
}

function season(weeks = 24, type = RaceType.half, hours = 10, load = 8): GeneratedSeason {
  return generateSeasonPlan({
    aRace: race(sundayOfWeek(weeks), type),
    weeklyHoursAvailable: hours,
    currentWeeklyLoad: load,
    startDate: START,
  });
}

function input(base: GeneratedSeason, overrides: Partial<ReprojectInput> = {}): ReprojectInput {
  return {
    season: { startDate: base.startDate, blocks: base.blocks },
    aRace: race(blockEndDate(base.blocks.at(-1) as TrainingBlock)),
    freezeThrough: blockEndDate(base.blocks[0]),
    seedWeeklyLoad: 8,
    weeklyHoursAvailable: 10,
    ...overrides,
  };
}

function floor1(x: number): number {
  return Math.floor(x * 10 + 1e-9) / 10;
}

function shape(blocks: TrainingBlock[]): string {
  return blocks.map((b) => b.type + ':' + b.weeks.toString()).join(' ');
}

/** Load weeks grow ≤ maxWeeklyRamp over the previous load week. */
function rampViolations(weeks: SeasonWeek[]): string[] {
  const out: string[] = [];
  let lastLoad: number | null = null;
  for (const w of weeks) {
    const prev = lastLoad ?? w.hours;
    if (w.kind === 'load' && w.hours > prev * (1 + CFG.maxWeeklyRamp) + EPS) {
      out.push('week ' + w.index.toString() + ': ' + w.hours.toString());
    }
    if (w.kind === 'load') lastLoad = w.hours;
  }
  return out;
}

function expectValid(blocks: TrainingBlock[], startDate: string, aRace: Race): void {
  assertValidSeasonPlan({ startDate, status: SeasonPlanStatus.active, aRace, blocks });
}

describe('reprojectSeason', () => {
  describe('under-compliance after the first block', () => {
    const base = season();
    const [first, next] = base.blocks;
    const seed = reprojectionSeed(
      {
        volumeAchievedPct: 70,
        achievedWeeklyHours: 5.6,
        targetWeeklyHours: first.targetWeeklyHours,
      },
      next
    );
    const result = reprojectSeason(input(base, { seedWeeklyLoad: seed }));

    it('seeds the next block at 70% of its planned level', () => {
      expect(seed).toBeCloseTo(next.targetWeeklyHours * 0.7, 1);
      expect(result.weeks[0].weekStart).toBe(next.startDate);
      expect(result.weeks[0].hours).toBe(floor1(seed));
    });

    it('lowers the next block and never raises a later one', () => {
      const old = base.blocks.slice(1);
      const fresh = result.blocks.slice(1);
      expect(fresh[0].targetWeeklyHours).toBeLessThan(old[0].targetWeeklyHours);
      fresh.forEach((b, k) =>
        expect(b.targetWeeklyHours).toBeLessThanOrEqual(old[k].targetWeeklyHours)
      );
    });

    it('keeps the remaining block structure when the race did not move', () => {
      expect(shape(result.blocks)).toBe(shape(base.blocks));
      expect(result.blocks.map((b) => b.startDate)).toEqual(base.blocks.map((b) => b.startDate));
      expect(result.truncated).toBeNull();
    });

    it('leaves the reviewed block untouched', () => {
      expect(result.frozenCount).toBe(1);
      expect(result.blocks[0]).toEqual(first);
    });

    it('stays valid and within the ramp cap', () => {
      expectValid(result.blocks, result.startDate, input(base).aRace);
      expect(rampViolations(result.weeks)).toEqual([]);
    });

    it('keeps the season recovery cadence', () => {
      const recovery = result.weeks.filter((w) => w.kind === 'recovery');
      expect(recovery.length).toBeGreaterThan(0);
      expect(recovery.every((w) => w.index % CFG.recoveryEvery === 0)).toBe(true);
      expect(result.weeks[0].index).toBe(first.weeks + 1);
    });
  });

  it('floors a very low seed at the minimum start with a warning', () => {
    const result = reprojectSeason(input(season(), { seedWeeklyLoad: 1 }));
    expect(result.weeks[0].hours).toBe(5);
    expect(result.warnings.join('\n')).toContain('is low');
  });

  describe('A-race moved', () => {
    const base = season();
    const build = base.blocks.find((b) => b.type === TrainingBlockType.build) as TrainingBlock;
    // Mid-build: the second week of the first build block
    const freezeThrough = addDaysIso(build.startDate, 13);
    const lastEnd = blockEndDate(base.blocks.at(-1) as TrainingBlock);

    it('later: truncates the current block, re-allocates the rest and never goes back to base', () => {
      const aRace = race(addDaysIso(lastEnd, 28));
      const result = reprojectSeason(input(base, { aRace, freezeThrough }));

      expect(result.truncated).toEqual({ order: build.order, weeks: 2 });
      const frozen = result.blocks.slice(0, result.frozenCount);
      expect(frozen.slice(0, -1)).toEqual(base.blocks.slice(0, build.order - 1));
      expect(frozen.at(-1)).toEqual({ ...build, weeks: 2 });

      const fresh = result.blocks.slice(result.frozenCount);
      expect(fresh.some((b) => b.type === TrainingBlockType.base)).toBe(false);
      expect(fresh[0].startDate).toBe(addDaysIso(freezeThrough, 1));
      expect(blockEndDate(fresh.at(-1) as TrainingBlock)).toBe(
        format(endOfISOWeek(parseISO(aRace.date)), 'yyyy-MM-dd')
      );
      expectValid(result.blocks, result.startDate, aRace);
      expect(rampViolations(result.weeks)).toEqual([]);
    });

    it('earlier: still fits a taper and race week', () => {
      const aRace = race(addDaysIso(freezeThrough, 20));
      const result = reprojectSeason(input(base, { aRace, freezeThrough }));
      expect(shape(result.blocks.slice(result.frozenCount))).toBe('taper:2 race:1');
      expectValid(result.blocks, result.startDate, aRace);
    });

    it('too early for a taper: throws', () => {
      const aRace = race(addDaysIso(freezeThrough, 6));
      expect(() => reprojectSeason(input(base, { aRace, freezeThrough }))).toThrow(
        SeasonGenerationError
      );
    });
  });

  it('rejects a freeze date that is not a Sunday', () => {
    const base = season();
    expect(() => reprojectSeason(input(base, { freezeThrough: START }))).toThrow(
      SeasonGenerationError
    );
  });

  it('property: frozen weeks are immutable and the plan stays valid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 12, max: 36 }),
        fc.constantFrom(RaceType.olympic, RaceType.half, RaceType.full),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: -4, max: 8 }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        (weeks, type, freezeWeek, shiftWeeks, seed) => {
          const base = season(weeks, type);
          const freezeThrough = sundayOfWeek(Math.min(freezeWeek, weeks - 1));
          const aRace = race(addDaysIso(sundayOfWeek(weeks), shiftWeeks * 7), type);
          const args = input(base, { aRace, freezeThrough, seedWeeklyLoad: seed });
          const remaining = differenceInCalendarDays(parseISO(aRace.date), parseISO(freezeThrough));
          const minimal = (CFG.raceWeeks + CFG.taperWeeks[type].min) * 7;

          let result: ReprojectedSeason;
          try {
            result = reprojectSeason(args);
          } catch (error) {
            // Only a runway too short for taper + race week may fail
            expect(error).toBeInstanceOf(SeasonGenerationError);
            expect(remaining).toBeLessThan(minimal);
            return;
          }
          expectValid(result.blocks, result.startDate, aRace);
          expect(rampViolations(result.weeks)).toEqual([]);
          const frozen = result.blocks.slice(0, result.frozenCount);
          frozen.forEach((b, i) => {
            const old = base.blocks[i];
            expect(b).toEqual(
              result.truncated?.order === b.order ? { ...old, weeks: b.weeks } : old
            );
            expect(blockEndDate(b) <= freezeThrough).toBe(true);
          });
          expect(result.weeks.every((w) => w.weekStart > freezeThrough)).toBe(true);
        }
      ),
      { numRuns: 150 }
    );
  });
});

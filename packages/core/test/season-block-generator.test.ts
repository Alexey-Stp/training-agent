import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addDays, format, parseISO } from 'date-fns';
import { Sport } from '../src/types';
import {
  assertValidSeasonPlan,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  GeneratedSeason,
  generateSeasonPlan,
  GenerateSeasonInput,
  RacePriority,
  RaceType,
  SeasonGenerationError,
  SeasonPlanStatus,
  SeasonWeek,
  sportShares,
  TrainingBlockType,
} from '../src/season';

const START = '2026-01-05'; // Monday
const CFG = DEFAULT_BLOCK_GENERATOR_CONFIG;
const EPS = 1e-6;

/** Sunday of the `weeks`th week counted from START */
function raceInWeeks(weeks: number): string {
  return format(addDays(parseISO(START), weeks * 7 - 1), 'yyyy-MM-dd');
}

function input(weeks: number, overrides: Partial<GenerateSeasonInput> = {}): GenerateSeasonInput {
  return {
    aRace: {
      date: raceInWeeks(weeks),
      name: 'Challenge Prague',
      priority: RacePriority.A,
      type: RaceType.half,
    },
    weeklyHoursAvailable: 10,
    currentWeeklyLoad: 6,
    startDate: START,
    ...overrides,
  };
}

function expectValid(season: GeneratedSeason, raceDate: string, type = RaceType.half): void {
  assertValidSeasonPlan({
    startDate: season.startDate,
    status: SeasonPlanStatus.draft,
    aRace: { date: raceDate, name: 'A', priority: RacePriority.A, type },
    blocks: season.blocks,
  });
}

function totalWeeks(season: GeneratedSeason): number {
  return season.blocks.reduce((sum, b) => sum + b.weeks, 0);
}

function shape(season: GeneratedSeason): string {
  return season.blocks.map((b) => `${b.type}:${b.weeks.toString()}`).join(' ');
}

/** Every load week ≤ previous load week × (1 + ramp); every recovery week ≈ factor × previous load. */
function rampViolations(weeks: SeasonWeek[]): string[] {
  const out: string[] = [];
  let lastLoad: number | null = null;
  for (const w of weeks) {
    const prev = lastLoad ?? w.hours;
    const over = w.kind === 'load' && w.hours > prev * (1 + CFG.maxWeeklyRamp) + EPS;
    const offRecovery =
      w.kind === 'recovery' && Math.abs(w.hours - prev * CFG.recoveryFactor) > 0.05 + EPS;
    if (over || offRecovery) {
      out.push(
        `${w.kind} week ${w.index.toString()}: ${w.hours.toString()} after ${prev.toString()}`
      );
    }
    if (w.kind === 'load') lastLoad = w.hours;
  }
  return out;
}

describe('generateSeasonPlan', () => {
  describe('24-week runway, 10 h/week', () => {
    const race = raceInWeeks(24);
    const season = generateSeasonPlan(input(24));

    it('covers exactly 24 weeks with a valid block sequence', () => {
      expect(totalWeeks(season)).toBe(24);
      expect(season.weeks).toHaveLength(24);
      expect(season.startDate).toBe(START);
      expect(shape(season)).toBe('base:5 base:5 build:4 build:4 peak:3 taper:2 race:1');
      expectValid(season, race);
      expect(season.warnings).toEqual([]);
    });

    it('never ramps load weeks more than 8%', () => {
      expect(rampViolations(season.weeks)).toEqual([]);
    });

    it('makes every 4th week a recovery week at ~60%', () => {
      const recovery = season.weeks.filter((w) => w.kind === 'recovery').map((w) => w.index);
      expect(recovery).toEqual([4, 8, 12, 16, 20]);
      const w3 = season.weeks[2];
      expect(season.weeks[3].hours).toBeCloseTo(w3.hours * 0.6, 1);
    });

    it('tapers into race week and never exceeds available hours', () => {
      const tail = season.weeks.slice(-3).map((w) => w.kind);
      expect(tail).toEqual(['taper', 'taper', 'race']);
      expect(Math.max(...season.weeks.map((w) => w.hours))).toBeLessThanOrEqual(10);
    });

    it('sets block targets from the weekly volumes', () => {
      const base1 = season.blocks[0];
      const weeks = season.weeks.filter((w) => w.blockOrder === 1);
      const avg = weeks.reduce((s, w) => s + w.hours, 0) / weeks.length;
      expect(base1.targetWeeklyHours).toBeCloseTo(avg, 1);
      expect(base1.targetSwimM % 100).toBe(0);
      expect(base1.targetBikeH).toBeGreaterThan(0);
      expect(base1.targetRunKm).toBeGreaterThan(0);
      expect(base1.targetCtl).toBeNull();
    });
  });

  it('16-week runway: shortens peak and warns that base is compressed', () => {
    const season = generateSeasonPlan(input(16));
    expect(totalWeeks(season)).toBe(16);
    expect(shape(season)).toBe('base:3 build:4 build:4 peak:2 taper:2 race:1');
    expect(season.warnings.some((w) => w.includes('peak shortened to 2'))).toBe(true);
    expect(season.warnings.some((w) => w.startsWith('Base compressed to 3 weeks'))).toBe(true);
    expectValid(season, raceInWeeks(16));
  });

  it('10-week runway: compresses base but keeps taper and a build block', () => {
    const season = generateSeasonPlan(input(10));
    expect(totalWeeks(season)).toBe(10);
    expect(shape(season)).toBe('base:3 build:3 peak:1 taper:2 race:1');
    expect(season.blocks.some((b) => b.type === TrainingBlockType.taper)).toBe(true);
    expect(season.blocks.some((b) => b.type === TrainingBlockType.build)).toBe(true);
    expect(season.warnings.some((w) => w.includes('build block 2 dropped'))).toBe(true);
    expect(season.warnings.some((w) => w.startsWith('Base compressed'))).toBe(true);
    expectValid(season, raceInWeeks(10));
  });

  it('aligns a mid-week start to the next Monday that leaves whole weeks', () => {
    const season = generateSeasonPlan(input(24, { startDate: '2026-01-07' }));
    expect(season.startDate).toBe('2026-01-12');
    expect(totalWeeks(season)).toBe(23);
    expectValid(season, raceInWeeks(24));
  });

  describe('availability', () => {
    it.each([6, 14])('%d h/week keeps the structure and stays within availability', (hours) => {
      const season = generateSeasonPlan(
        input(24, { weeklyHoursAvailable: hours, currentWeeklyLoad: hours * 0.6 })
      );
      expect(shape(season)).toBe('base:5 base:5 build:4 build:4 peak:3 taper:2 race:1');
      expect(Math.max(...season.weeks.map((w) => w.hours))).toBeLessThanOrEqual(hours);
      expect(rampViolations(season.weeks)).toEqual([]);
    });

    it('scales volume with availability', () => {
      const low = generateSeasonPlan(
        input(24, { weeklyHoursAvailable: 6, currentWeeklyLoad: 3.6 })
      );
      const high = generateSeasonPlan(
        input(24, { weeklyHoursAvailable: 14, currentWeeklyLoad: 8.4 })
      );
      for (let i = 0; i < 24; i++) {
        expect(high.weeks[i].hours).toBeGreaterThan(low.weeks[i].hours);
      }
    });
  });

  describe('starting load', () => {
    it('starts week 1 from a high current load, not from zero', () => {
      const season = generateSeasonPlan(input(24, { currentWeeklyLoad: 9 }));
      expect(season.weeks[0].hours).toBe(9);
      expect(season.warnings).toEqual([]);
    });

    it('starts at the floor with a warning when current load is low', () => {
      const season = generateSeasonPlan(input(24, { currentWeeklyLoad: 0 }));
      expect(season.weeks[0].hours).toBe(5);
      expect(season.warnings.some((w) => w.includes('is low'))).toBe(true);
    });

    it('clamps to availability with a warning when current load exceeds it', () => {
      const season = generateSeasonPlan(input(24, { currentWeeklyLoad: 12 }));
      expect(season.weeks[0].hours).toBe(10);
      expect(season.warnings.some((w) => w.includes('above the 10 h/week available'))).toBe(true);
    });
  });

  describe('per-sport split', () => {
    it('adds +10 pp to the weak sport in base, taken proportionally from the others', () => {
      const s = sportShares(RaceType.half, Sport.swim, true, CFG);
      expect(s.swim).toBeCloseTo(0.25, 10);
      expect(s.bike).toBeCloseTo(0.55 - (0.1 * 0.55) / 0.85, 10);
      expect(s.run).toBeCloseTo(0.3 - (0.1 * 0.3) / 0.85, 10);
      expect(s.swim + s.bike + s.run).toBeCloseTo(1, 10);
    });

    it('uses the race split outside base', () => {
      expect(sportShares(RaceType.half, Sport.swim, false, CFG)).toEqual({
        swim: 0.15,
        bike: 0.55,
        run: 0.3,
      });
    });

    it('applies the bias only to base weeks of a generated plan', () => {
      const season = generateSeasonPlan(input(24, { weakSport: Sport.run }));
      const base = season.weeks.find((w) => w.blockType === TrainingBlockType.base);
      const build = season.weeks.find((w) => w.blockType === TrainingBlockType.build);
      expect(base?.runH).toBeCloseTo((base?.hours ?? 0) * 0.4, 1);
      expect(build?.runH).toBeCloseTo((build?.hours ?? 0) * 0.3, 1);
      expect(season.blocks[0].focus).toContain('extra run');
    });

    it('ignores the bias with a warning when the weak sport is not in the race', () => {
      const raceDate = raceInWeeks(16);
      const season = generateSeasonPlan(
        input(16, {
          weakSport: Sport.swim,
          aRace: { date: raceDate, name: 'Marathon', priority: RacePriority.A, type: RaceType.run },
        })
      );
      expect(season.weeks.every((w) => w.swimH === 0 && w.bikeH === 0)).toBe(true);
      expect(season.warnings.some((w) => w.includes('Weak sport swim'))).toBe(true);
      expectValid(season, raceDate, RaceType.run);
    });
  });

  describe('invalid input', () => {
    it('rejects a race before the start date', () => {
      expect(() => generateSeasonPlan(input(24, { startDate: '2026-12-01' }))).toThrow(
        SeasonGenerationError
      );
    });

    it('rejects a runway shorter than race + min taper + min build', () => {
      expect(() => generateSeasonPlan(input(5))).toThrow(/needs at least 6/);
      expect(() => generateSeasonPlan(input(6))).not.toThrow();
    });

    it('rejects non-positive availability and bad dates', () => {
      expect(() => generateSeasonPlan(input(24, { weeklyHoursAvailable: 0 }))).toThrow(
        SeasonGenerationError
      );
      expect(() => generateSeasonPlan(input(24, { startDate: '2026-02-30' }))).toThrow(
        SeasonGenerationError
      );
    });
  });

  it('property: valid plans that respect the ramp cap across random inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 40 }),
        fc.constantFrom(...Object.values(RaceType)),
        fc.double({ min: 4, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 25, noNaN: true }),
        fc.option(fc.constantFrom(Sport.swim, Sport.bike, Sport.run), { nil: undefined }),
        (weeks, type, hours, load, weakSport) => {
          const raceDate = raceInWeeks(weeks);
          const season = generateSeasonPlan({
            aRace: { date: raceDate, name: 'A', priority: RacePriority.A, type },
            weeklyHoursAvailable: hours,
            currentWeeklyLoad: load,
            weakSport,
            startDate: START,
          });
          expectValid(season, raceDate, type);
          expect(totalWeeks(season)).toBe(weeks);
          expect(rampViolations(season.weeks)).toEqual([]);
          expect(season.weeks.every((w) => w.hours <= hours + EPS)).toBe(true);
          expect(season.blocks.some((b) => b.type === TrainingBlockType.build)).toBe(true);
          expect(season.blocks.at(-2)?.type).toBe(TrainingBlockType.taper);
          expect(season.blocks.at(-1)?.type).toBe(TrainingBlockType.race);
        }
      ),
      { numRuns: 100 }
    );
  });
});

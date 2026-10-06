import { RaceType } from './types';

export interface WeeksRange {
  ideal: number;
  min: number;
}

/** Fractions of weekly hours per sport; they sum to 1. */
export interface SportSplit {
  swim: number;
  bike: number;
  run: number;
}

export interface BlockGeneratorConfig {
  /** Length of the final `race` block (the A-race week) */
  raceWeeks: number;
  taperWeeks: Record<RaceType, WeeksRange>;
  peakWeeks: WeeksRange;
  buildBlocks: number;
  buildWeeks: WeeksRange;
  /** Short runways compress peak/build until base reaches this */
  minBaseWeeks: number;
  /** Base shorter than this gets a compression warning */
  idealBaseWeeks: number;
  /** Base is split into base1/base2 from this many weeks */
  baseSplitMinWeeks: number;

  /** Max week-over-week growth between load weeks (0.08 = 8%) */
  maxWeeklyRamp: number;
  /** Every Nth plan week in base/build/peak is a recovery week (3:1 for 4) */
  recoveryEvery: number;
  /** Recovery week volume as a fraction of the preceding load week */
  recoveryFactor: number;
  /** Week 1 never starts below this fraction of available hours */
  minStartFraction: number;
  /** Load-week ceiling per phase, as a fraction of available hours */
  phaseCeiling: { base: number; build: number; peak: number };
  /**
   * Taper week volume as a fraction of the last load week (peak), counted back from the race:
   * [0] is the last taper week, [1] the one before, ...; the last factor repeats.
   * Taper and race weeks are the explicit exception to `maxWeeklyRamp` (see `isRampException`).
   */
  taperWeekFactorsFromRace: number[];
  /** Training volume of the race week (the race itself excluded) as a fraction of peak */
  raceWeekFactor: number;
  /** Expected race duration per race type; the race session is excluded from week volume */
  raceDurationMin: Record<RaceType, number>;
  /** Days before a B-race that get the mini-taper (T-n..T-1) */
  miniTaperDays: Record<RaceType, number>;
  /** Session duration factor inside a B-race mini-taper */
  miniTaperFactor: number;
  /** Longest T-1 opener */
  openerMaxMin: number;

  sportSplit: Record<RaceType, SportSplit>;
  /** Percentage points moved to the weak sport during base (0.10 = +10 pp) */
  weakSportBias: number;
  swimMPerHour: number;
  runKmPerHour: number;
}

const TRI_SPLIT: SportSplit = { swim: 0.2, bike: 0.45, run: 0.35 };

export const DEFAULT_BLOCK_GENERATOR_CONFIG: BlockGeneratorConfig = {
  raceWeeks: 1,
  taperWeeks: {
    [RaceType.sprint]: { ideal: 1, min: 1 },
    [RaceType.olympic]: { ideal: 1, min: 1 },
    [RaceType.half]: { ideal: 2, min: 2 },
    [RaceType.full]: { ideal: 3, min: 2 },
    [RaceType.run]: { ideal: 1, min: 1 },
    [RaceType.other]: { ideal: 1, min: 1 },
  },
  peakWeeks: { ideal: 3, min: 2 },
  buildBlocks: 2,
  buildWeeks: { ideal: 4, min: 3 },
  minBaseWeeks: 3,
  idealBaseWeeks: 8,
  baseSplitMinWeeks: 6,

  maxWeeklyRamp: 0.08,
  recoveryEvery: 4,
  recoveryFactor: 0.6,
  minStartFraction: 0.5,
  phaseCeiling: { base: 0.85, build: 0.95, peak: 1 },
  taperWeekFactorsFromRace: [0.6, 0.75, 0.85],
  raceWeekFactor: 0.4,
  raceDurationMin: {
    [RaceType.sprint]: 75,
    [RaceType.olympic]: 150,
    [RaceType.half]: 330,
    [RaceType.full]: 780,
    [RaceType.run]: 90,
    [RaceType.other]: 120,
  },
  miniTaperDays: {
    [RaceType.sprint]: 3,
    [RaceType.olympic]: 3,
    [RaceType.half]: 4,
    [RaceType.full]: 5,
    [RaceType.run]: 3,
    [RaceType.other]: 3,
  },
  miniTaperFactor: 0.6,
  openerMaxMin: 30,

  sportSplit: {
    [RaceType.sprint]: TRI_SPLIT,
    [RaceType.olympic]: TRI_SPLIT,
    [RaceType.half]: { swim: 0.15, bike: 0.55, run: 0.3 },
    [RaceType.full]: { swim: 0.15, bike: 0.58, run: 0.27 },
    [RaceType.run]: { swim: 0, bike: 0, run: 1 },
    [RaceType.other]: TRI_SPLIT,
  },
  weakSportBias: 0.1,
  swimMPerHour: 2500,
  runKmPerHour: 10,
};

export class SeasonGenerationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot generate season plan: ${issues.join('; ')}`);
    this.name = 'SeasonGenerationError';
  }
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Rounds down to 0.1 (with a float epsilon so 2.3 stays 2.3) */
export function floor1(x: number): number {
  return Math.floor(x * 10 + 1e-9) / 10;
}

import { addDays, differenceInCalendarDays, endOfISOWeek, format, parseISO } from 'date-fns';
import { Sport } from '../types';
import { allocateBlockLengths, layoutBlocks, minRunwayWeeks } from './block-sequence';
import {
  BlockGeneratorConfig,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  SeasonGenerationError,
  SportSplit,
  round1,
} from './generator-config';
import { sportShares, weakSportBiasWarning } from './sport-split';
import { Race, TrainingBlock, TrainingBlockType } from './types';
import { isIsoDate } from './validate';
import { buildWeeklyVolumes, startingLoad, WeekKind } from './volume';

export interface GenerateSeasonInput {
  aRace: Race;
  weeklyHoursAvailable: number;
  /** Recent weekly training load in hours (e.g. the last 4 weeks' average) */
  currentWeeklyLoad: number;
  weakSport?: Sport;
  /** yyyy-MM-dd; the plan starts on the first Monday that leaves whole weeks to race week */
  startDate: string;
}

export interface SeasonWeek {
  /** 1-based plan week */
  index: number;
  weekStart: string; // YYYY-MM-DD, a Monday
  blockOrder: number;
  blockType: TrainingBlockType;
  kind: WeekKind;
  hours: number;
  swimH: number;
  bikeH: number;
  runH: number;
}

export interface GeneratedSeason {
  startDate: string;
  blocks: TrainingBlock[];
  weeks: SeasonWeek[];
  warnings: string[];
}

function inputIssues(input: GenerateSeasonInput): string[] {
  const issues: string[] = [];
  if (!isIsoDate(input.startDate)) issues.push(`startDate ${input.startDate} is not yyyy-MM-dd`);
  if (!isIsoDate(input.aRace.date)) issues.push(`race date ${input.aRace.date} is not yyyy-MM-dd`);
  // Number.isFinite also rejects NaN, which the comparisons alone would let through
  const hours = input.weeklyHoursAvailable;
  const load = input.currentWeeklyLoad;
  if (!Number.isFinite(hours) || hours <= 0) issues.push('weeklyHoursAvailable must be > 0');
  if (!Number.isFinite(load) || load < 0) issues.push('currentWeeklyLoad must be ≥ 0');
  return issues;
}

/** Whole Monday–Sunday weeks from `startDate` through the race's week, and the first Monday. */
function resolveRunway(
  input: GenerateSeasonInput,
  config: BlockGeneratorConfig
): { planStart: string; totalWeeks: number } {
  const issues = inputIssues(input);
  if (issues.length > 0) throw new SeasonGenerationError(issues);

  const raceWeekEnd = endOfISOWeek(parseISO(input.aRace.date));
  const days = differenceInCalendarDays(raceWeekEnd, parseISO(input.startDate)) + 1;
  const totalWeeks = Math.floor(days / 7);
  const minWeeks = minRunwayWeeks(input.aRace.type, config);
  if (totalWeeks < minWeeks) {
    throw new SeasonGenerationError([
      `race ${input.aRace.date} is ${totalWeeks.toString()} whole weeks after ${input.startDate}; a ${input.aRace.type} plan needs at least ${minWeeks.toString()}`,
    ]);
  }
  const planStart = format(addDays(raceWeekEnd, 1 - totalWeeks * 7), 'yyyy-MM-dd');
  return { planStart, totalWeeks };
}

function weeksOf(
  blocks: TrainingBlock[]
): Pick<SeasonWeek, 'weekStart' | 'blockOrder' | 'blockType'>[] {
  return blocks.flatMap((b) =>
    Array.from({ length: b.weeks }, (_, k) => ({
      weekStart: format(addDays(parseISO(b.startDate), k * 7), 'yyyy-MM-dd'),
      blockOrder: b.order,
      blockType: b.type,
    }))
  );
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function mean(weeks: SeasonWeek[], pick: (w: SeasonWeek) => number): number {
  return weeks.reduce((sum, w) => sum + pick(w), 0) / weeks.length;
}

/** Block targets are the mean of its weeks, converted to metres / km with the configured paces. */
function withTargets(
  block: TrainingBlock,
  weeks: SeasonWeek[],
  config: BlockGeneratorConfig
): TrainingBlock {
  const own = weeks.filter((w) => w.blockOrder === block.order);
  return {
    ...block,
    targetWeeklyHours: round1(mean(own, (w) => w.hours)),
    targetSwimM: Math.round((mean(own, (w) => w.swimH) * config.swimMPerHour) / 100) * 100,
    targetBikeH: round1(mean(own, (w) => w.bikeH)),
    targetRunKm: round1(mean(own, (w) => w.runH) * config.runKmPerHour),
  };
}

/**
 * Builds the season's block sequence backwards from the A-race: race week, taper, peak, two
 * build blocks, and base (split base1/base2) for the remaining weeks. Short runways compress
 * base first, then peak and build, but always keep a taper and one build block; each
 * compression is explained in `warnings`. Weekly volume starts from the athlete's current load,
 * ramps ≤ `maxWeeklyRamp` between load weeks, with a 3:1 load/recovery pattern, then tapers.
 * Pure; every constant comes from `config`. Throws `SeasonGenerationError` on invalid input.
 */
export function generateSeasonPlan(
  input: GenerateSeasonInput,
  config: BlockGeneratorConfig = DEFAULT_BLOCK_GENERATOR_CONFIG
): GeneratedSeason {
  const { planStart, totalWeeks } = resolveRunway(input, config);
  const raceType = input.aRace.type;
  const available = input.weeklyHoursAvailable;

  const allocation = allocateBlockLengths(totalWeeks, raceType, config);
  const skeleton = layoutBlocks(
    allocation.base,
    allocation.lengths,
    planStart,
    { raceName: input.aRace.name, weakSport: input.weakSport },
    config
  );

  const { start, warning: startWarning } = startingLoad(available, input.currentWeeklyLoad, config);
  const slots = weeksOf(skeleton);
  const volumes = buildWeeklyVolumes(
    slots.map((s) => s.blockType),
    available,
    start,
    config
  );
  const weeks = slots.map((slot, i): SeasonWeek => {
    const { kind, hours } = volumes[i];
    const inBase = slot.blockType === TrainingBlockType.base;
    const shares: SportSplit = sportShares(raceType, input.weakSport, inBase, config);
    return {
      index: i + 1,
      ...slot,
      kind,
      hours,
      swimH: round2(hours * shares.swim),
      bikeH: round2(hours * shares.bike),
      runH: round2(hours * shares.run),
    };
  });

  const warnings = [
    ...allocation.warnings,
    startWarning,
    weakSportBiasWarning(raceType, input.weakSport, config),
  ].filter((w): w is string => w !== null);

  return {
    startDate: planStart,
    blocks: skeleton.map((b) => withTargets(b, weeks, config)),
    weeks,
    warnings,
  };
}

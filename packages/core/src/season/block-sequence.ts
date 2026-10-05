import { addDays, format, parseISO } from 'date-fns';
import { BlockGeneratorConfig } from './generator-config';
import { RaceType, TrainingBlock, TrainingBlockType } from './types';

/** Weeks per phase. `builds` holds one entry per build block; `peak` 0 means no peak block. */
export interface BlockLengths {
  builds: number[];
  peak: number;
  taper: number;
  race: number;
}

interface LadderStep {
  apply: (l: BlockLengths) => BlockLengths | null;
  describe: (l: BlockLengths) => string;
}

function nonBaseWeeks(l: BlockLengths): number {
  return l.builds.reduce((sum, w) => sum + w, 0) + l.peak + l.taper + l.race;
}

/** Smallest runway that still fits race week, a minimal taper and one minimal build block. */
export function minRunwayWeeks(raceType: RaceType, config: BlockGeneratorConfig): number {
  return config.raceWeeks + config.taperWeeks[raceType].min + config.buildWeeks.min;
}

function shrinkBuild(i: number, min: number): LadderStep {
  return {
    apply: (l) => {
      if (l.builds.length <= i || l.builds[i] <= min) return null;
      return { ...l, builds: l.builds.map((w, j) => (j === i ? min : w)) };
    },
    describe: () => `build block ${(i + 1).toString()} shortened to ${min.toString()} weeks`,
  };
}

function dropBuild(i: number): LadderStep {
  return {
    apply: (l) => (l.builds.length > i ? { ...l, builds: l.builds.slice(0, i) } : null),
    describe: () => `build block ${(i + 1).toString()} dropped`,
  };
}

function shrinkPeak(to: number): LadderStep {
  return {
    apply: (l) => (l.peak > to ? { ...l, peak: to } : null),
    describe: () => (to === 0 ? 'peak block dropped' : `peak shortened to ${to.toString()} weeks`),
  };
}

/**
 * Reductions applied in order while base is shorter than `minBaseWeeks`: peak to its min, each
 * build (last first) to its min, extra builds dropped, peak to 1 week then dropped, taper to its
 * min. Taper and the first build block always survive.
 */
function shrinkTaper(min: number): LadderStep {
  return {
    apply: (l) => (l.taper > min ? { ...l, taper: min } : null),
    describe: () => `taper shortened to ${min.toString()} weeks`,
  };
}

function compressionLadder(raceType: RaceType, config: BlockGeneratorConfig): LadderStep[] {
  const n = config.buildBlocks;
  const lastFirst = Array.from({ length: n }, (_, k) => n - 1 - k);
  return [
    shrinkPeak(config.peakWeeks.min),
    ...lastFirst.map((i) => shrinkBuild(i, config.buildWeeks.min)),
    ...lastFirst.filter((i) => i >= 1).map((i) => dropBuild(i)),
    shrinkPeak(1),
    shrinkPeak(0),
    shrinkTaper(config.taperWeeks[raceType].min),
  ];
}

/**
 * Allocates weeks backwards from race week: race → taper → peak → builds, and base gets the
 * rest. Short runways walk the compression ladder until base fits; every step taken is a warning.
 * Callers guarantee `totalWeeks >= minRunwayWeeks`.
 */
export function allocateBlockLengths(
  totalWeeks: number,
  raceType: RaceType,
  config: BlockGeneratorConfig
): { base: number; lengths: BlockLengths; warnings: string[] } {
  let lengths: BlockLengths = {
    builds: Array.from({ length: config.buildBlocks }, () => config.buildWeeks.ideal),
    peak: config.peakWeeks.ideal,
    taper: config.taperWeeks[raceType].ideal,
    race: config.raceWeeks,
  };
  const warnings: string[] = [];
  for (const step of compressionLadder(raceType, config)) {
    if (totalWeeks - nonBaseWeeks(lengths) >= config.minBaseWeeks) break;
    const next = step.apply(lengths);
    if (next) {
      lengths = next;
      warnings.push(`Short runway (${totalWeeks.toString()} weeks): ${step.describe(next)}`);
    }
  }

  const base = Math.max(0, totalWeeks - nonBaseWeeks(lengths));
  if (base < config.idealBaseWeeks) {
    warnings.push(
      `Base compressed to ${base.toString()} weeks (ideal ≥ ${config.idealBaseWeeks.toString()}); fitness gains before build will be limited`
    );
  }
  return { base, lengths, warnings };
}

export interface FocusContext {
  raceName: string;
  weakSport?: string;
}

function focusFor(type: TrainingBlockType, ctx: FocusContext): string {
  switch (type) {
    case TrainingBlockType.base:
      return ctx.weakSport
        ? `Aerobic base and technique, extra ${ctx.weakSport} volume`
        : 'Aerobic base and technique';
    case TrainingBlockType.build:
      return 'Race-specific endurance and threshold';
    case TrainingBlockType.peak:
      return 'Race-pace sharpening at peak volume';
    case TrainingBlockType.taper:
      return 'Cut volume, keep intensity';
    case TrainingBlockType.race:
      return `Race week: ${ctx.raceName}`;
    default:
      return type;
  }
}

export interface Phase {
  type: TrainingBlockType;
  weeks: number;
}

/** base1/base2 when base is long enough to split, one base block, or none. */
function basePhases(base: number, config: BlockGeneratorConfig): Phase[] {
  if (base >= config.baseSplitMinWeeks) {
    return [
      { type: TrainingBlockType.base, weeks: Math.ceil(base / 2) },
      { type: TrainingBlockType.base, weeks: Math.floor(base / 2) },
    ];
  }
  return base > 0 ? [{ type: TrainingBlockType.base, weeks: base }] : [];
}

/** Season phases in order: base (split when long), builds, peak, taper, race. */
export function blockPhases(base: number, l: BlockLengths, config: BlockGeneratorConfig): Phase[] {
  return [
    ...basePhases(base, config),
    ...l.builds.map((weeks) => ({ type: TrainingBlockType.build, weeks })),
    ...(l.peak > 0 ? [{ type: TrainingBlockType.peak, weeks: l.peak }] : []),
    { type: TrainingBlockType.taper, weeks: l.taper },
    { type: TrainingBlockType.race, weeks: l.race },
  ];
}

/** Lays the blocks out contiguously from `planStart`, in season order, with zero targets. */
export function layoutBlocks(
  base: number,
  lengths: BlockLengths,
  planStart: string,
  ctx: FocusContext,
  config: BlockGeneratorConfig
): TrainingBlock[] {
  return layoutPhases(blockPhases(base, lengths, config), planStart, ctx);
}

/**
 * Lays `phases` out contiguously from `planStart` with zero targets; the first block gets
 * `firstOrder` (a re-projection continues after the frozen blocks).
 */
export function layoutPhases(
  phases: Phase[],
  planStart: string,
  ctx: FocusContext,
  firstOrder = 1
): TrainingBlock[] {
  let start = parseISO(planStart);
  return phases.map(({ type, weeks }, i) => {
    const block: TrainingBlock = {
      order: firstOrder + i,
      type,
      startDate: format(start, 'yyyy-MM-dd'),
      weeks,
      focus: focusFor(type, ctx),
      targetWeeklyHours: 0,
      targetSwimM: 0,
      targetBikeH: 0,
      targetRunKm: 0,
      targetCtl: null,
    };
    start = addDays(start, weeks * 7);
    return block;
  });
}

import { differenceInCalendarDays, endOfISOWeek, getISODay, parseISO } from 'date-fns';
import { Sport } from '../types';
import {
  allocateBlockLengths,
  blockPhases,
  layoutPhases,
  minRunwayWeeks,
  Phase,
} from './block-sequence';
import {
  BlockGeneratorConfig,
  DEFAULT_BLOCK_GENERATOR_CONFIG,
  SeasonGenerationError,
} from './generator-config';
import { SeasonWeek, sizeWeeks, weekSlots, withTargets } from './season-weeks';
import { Race, SeasonPlan, SeasonPlanStatus, TrainingBlock, TrainingBlockType } from './types';
import { blockEndDate, isIsoDate, validateSeasonPlan } from './validate';
import { buildWeeklyVolumes, startingLoad } from './volume';
import { addDaysIso } from './window';

export interface ReprojectInput {
  season: Pick<SeasonPlan, 'startDate' | 'blocks'>;
  /** The A-race, with its new date when it moved */
  aRace: Race;
  /** yyyy-MM-dd Sunday; every day up to and including it is immutable */
  freezeThrough: string;
  /** Weekly hours the first remaining load week starts from (achieved, not planned, load) */
  seedWeeklyLoad: number;
  weeklyHoursAvailable: number;
  weakSport?: Sport;
}

export interface ReprojectedSeason {
  startDate: string;
  /** Frozen blocks first (unchanged, or the current block cut at `freezeThrough`), then new ones */
  blocks: TrainingBlock[];
  /** Blocks kept from the old plan, including a truncated one */
  frozenCount: number;
  /** The frozen block that was cut short at `freezeThrough`, if any */
  truncated: { order: number; weeks: number } | null;
  /** The re-projected weeks only (frozen weeks keep their stored targets) */
  weeks: SeasonWeek[];
  warnings: string[];
}

/** How far into the season a phase is; folding never goes back to an earlier phase. */
const PHASE_RANK: Readonly<Record<TrainingBlockType, number>> = {
  [TrainingBlockType.base]: 0,
  [TrainingBlockType.recovery]: 0,
  [TrainingBlockType.transition]: 0,
  [TrainingBlockType.build]: 1,
  [TrainingBlockType.peak]: 2,
  [TrainingBlockType.taper]: 3,
  [TrainingBlockType.race]: 4,
};

/** A race that moves after the taper started gets a peak again, never a longer taper. */
const MAX_FOLD_RANK = PHASE_RANK[TrainingBlockType.peak];

function inputIssues(input: ReprojectInput): string[] {
  const issues: string[] = [];
  if (!isIsoDate(input.freezeThrough) || getISODay(parseISO(input.freezeThrough)) !== 7) {
    issues.push(`freezeThrough ${input.freezeThrough} is not a yyyy-MM-dd Sunday`);
  }
  if (!isIsoDate(input.aRace.date)) issues.push(`race date ${input.aRace.date} is not yyyy-MM-dd`);
  const hours = input.weeklyHoursAvailable;
  if (!Number.isFinite(hours) || hours <= 0) issues.push('weeklyHoursAvailable must be > 0');
  const seed = input.seedWeeklyLoad;
  if (!Number.isFinite(seed) || seed < 0) issues.push('seedWeeklyLoad must be ≥ 0');
  if (input.aRace.date <= input.freezeThrough) {
    issues.push(`race ${input.aRace.date} is not after ${input.freezeThrough}`);
  }
  return issues;
}

interface Frozen {
  blocks: TrainingBlock[];
  truncated: { order: number; weeks: number } | null;
}

/** Blocks that end by `freezeThrough` as they are; the block spanning it cut to its elapsed weeks. */
function freezeBlocks(sorted: TrainingBlock[], freezeThrough: string): Frozen {
  const blocks: TrainingBlock[] = [];
  let truncated: Frozen['truncated'] = null;
  for (const block of sorted) {
    if (block.startDate > freezeThrough) break;
    if (blockEndDate(block) <= freezeThrough) {
      blocks.push(block);
      continue;
    }
    const weeks =
      (differenceInCalendarDays(parseISO(freezeThrough), parseISO(block.startDate)) + 1) / 7;
    blocks.push({ ...block, weeks });
    truncated = { order: block.order, weeks };
    break;
  }
  return { blocks, truncated };
}

/** Old blocks after the freeze keep their types and lengths when the race week didn't move. */
function keptPhases(sorted: TrainingBlock[], freezeThrough: string): Phase[] {
  return sorted
    .filter((b) => b.startDate > freezeThrough)
    .map((b) => ({ type: b.type, weeks: b.weeks }));
}

/** Phases for a runway shorter than the generator's minimum: taper (≤ ideal) and race, rest peak. */
function shortRunwayPhases(
  weeks: number,
  input: ReprojectInput,
  config: BlockGeneratorConfig
): Phase[] {
  const taperRange = config.taperWeeks[input.aRace.type];
  const taper = Math.min(weeks - config.raceWeeks, taperRange.ideal);
  const peak = weeks - config.raceWeeks - taper;
  return [
    ...(peak > 0 ? [{ type: TrainingBlockType.peak, weeks: peak }] : []),
    { type: TrainingBlockType.taper, weeks: taper },
    { type: TrainingBlockType.race, weeks: config.raceWeeks },
  ];
}

/** Re-allocates `weeks` backwards from race week, like the generator does for a new season. */
function allocatedPhases(
  weeks: number,
  input: ReprojectInput,
  config: BlockGeneratorConfig,
  warnings: string[]
): Phase[] {
  const raceType = input.aRace.type;
  const minimal = config.raceWeeks + config.taperWeeks[raceType].min;
  if (weeks < minimal) {
    throw new SeasonGenerationError([
      `race ${input.aRace.date} leaves ${weeks.toString()} whole weeks after ${input.freezeThrough}; a ${raceType} race needs at least ${minimal.toString()}`,
    ]);
  }
  if (weeks < minRunwayWeeks(raceType, config)) {
    warnings.push(
      `Only ${weeks.toString()} weeks left: no build block, straight to peak and taper`
    );
    return shortRunwayPhases(weeks, input, config);
  }
  const allocation = allocateBlockLengths(weeks, raceType, config);
  warnings.push(...allocation.warnings);
  return blockPhases(allocation.base, allocation.lengths, config);
}

/** Phases earlier than the season already reached become the earliest allowed phase. */
function foldPhases(phases: Phase[], minRank: number, warnings: string[]): Phase[] {
  const target = phases.find((p) => PHASE_RANK[p.type] >= minRank)?.type;
  if (target === undefined) return phases;
  return phases.map((p) => {
    if (PHASE_RANK[p.type] >= minRank) return p;
    warnings.push(
      `${p.weeks.toString()} ${p.type} weeks re-planned as ${target} (the season is past ${p.type})`
    );
    return { type: target, weeks: p.weeks };
  });
}

function remainingWeeks(input: ReprojectInput): number {
  const raceWeekEnd = endOfISOWeek(parseISO(input.aRace.date));
  return differenceInCalendarDays(raceWeekEnd, parseISO(input.freezeThrough)) / 7;
}

/**
 * The old blocks after the freeze can stay as they are: the freeze sits on a block boundary, the
 * next block starts right after it, and the season still ends on the race's week.
 */
function canKeepStructure(sorted: TrainingBlock[], frozen: Frozen, input: ReprojectInput): boolean {
  if (frozen.truncated !== null) return false;
  const next = sorted.find((b) => b.startDate > input.freezeThrough);
  const last = sorted.at(-1);
  if (next?.startDate !== addDaysIso(input.freezeThrough, 1) || last === undefined) return false;
  return blockEndDate(last) === addDaysIso(input.freezeThrough, remainingWeeks(input) * 7);
}

function futurePhases(
  sorted: TrainingBlock[],
  frozen: Frozen,
  input: ReprojectInput,
  config: BlockGeneratorConfig,
  warnings: string[]
): Phase[] {
  if (canKeepStructure(sorted, frozen, input)) {
    return keptPhases(sorted, input.freezeThrough);
  }
  const phases = allocatedPhases(remainingWeeks(input), input, config, warnings);
  const reached = frozen.blocks.at(-1);
  const minRank = reached ? Math.min(PHASE_RANK[reached.type], MAX_FOLD_RANK) : 0;
  return foldPhases(phases, minRank, warnings);
}

/**
 * Re-plans the rest of a season from `freezeThrough + 1`, keeping every day up to
 * `freezeThrough` as it is. Blocks that ended by then are copied unchanged; a block spanning it
 * is cut to its elapsed weeks. When the race week is unchanged the remaining blocks keep their
 * types and lengths; when it moved, the remaining runway is allocated like a new season, and
 * phases the season is already past (e.g. base once build started) become the current phase.
 * Volume restarts from `seedWeeklyLoad` (the achieved load, so an under-trained block lowers the
 * next one), ramps ≤ `maxWeeklyRamp`, and keeps the season's 3:1 recovery cadence.
 * Pure. Throws `SeasonGenerationError` on invalid input or a runway too short for a taper.
 */
export function reprojectSeason(
  input: ReprojectInput,
  config: BlockGeneratorConfig = DEFAULT_BLOCK_GENERATOR_CONFIG
): ReprojectedSeason {
  const issues = inputIssues(input);
  if (issues.length > 0) throw new SeasonGenerationError(issues);

  const sorted = [...input.season.blocks].sort((a, b) => a.order - b.order);
  const frozen = freezeBlocks(sorted, input.freezeThrough);
  const warnings: string[] = [];
  const phases = futurePhases(sorted, frozen, input, config, warnings);

  const firstOrder = (frozen.blocks.at(-1)?.order ?? 0) + 1;
  const future = layoutPhases(
    phases,
    addDaysIso(input.freezeThrough, 1),
    { raceName: input.aRace.name, weakSport: input.weakSport },
    firstOrder
  );

  const available = input.weeklyHoursAvailable;
  const { start, warning } = startingLoad(available, input.seedWeeklyLoad, config);
  if (warning) warnings.push(warning);
  const frozenWeeks = frozen.blocks.reduce((sum, b) => sum + b.weeks, 0);
  const slots = weekSlots(future);
  const volumes = buildWeeklyVolumes(
    slots.map((s) => s.blockType),
    available,
    start,
    config,
    frozenWeeks + 1
  );
  const weeks = sizeWeeks(
    slots,
    volumes,
    { raceType: input.aRace.type, weakSport: input.weakSport, firstIndex: frozenWeeks + 1 },
    config
  );

  const blocks = [...frozen.blocks, ...future.map((b) => withTargets(b, weeks, config))];
  const startDate = blocks.at(0)?.startDate ?? input.season.startDate;
  const invalid = validateSeasonPlan({
    startDate,
    status: SeasonPlanStatus.active,
    aRace: input.aRace,
    blocks,
  });
  if (invalid.length > 0) throw new SeasonGenerationError(invalid.map((i) => i.message));

  return {
    startDate,
    blocks,
    frozenCount: frozen.blocks.length,
    truncated: frozen.truncated,
    weeks,
    warnings,
  };
}

import { addDays, differenceInCalendarDays, format, isValid, parseISO } from 'date-fns';
import { Race, RacePriority, SeasonPlan, TrainingBlock, TrainingBlockType } from './types';

export type SeasonIssueCode =
  | 'invalid_block'
  | 'duplicate_order'
  | 'gap'
  | 'overlap'
  | 'plan_start_mismatch'
  | 'race_block_missing'
  | 'race_block_wrong_type'
  | 'race_not_in_final_week'
  | 'taper_missing';

export interface SeasonIssue {
  code: SeasonIssueCode;
  message: string;
  /** `order` of every block the issue is about */
  blockOrders: number[];
}

export class SeasonValidationError extends Error {
  constructor(public readonly issues: SeasonIssue[]) {
    super(`Invalid season plan: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'SeasonValidationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in `yyyy-MM-dd` form (rejects e.g. 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = parseISO(value);
  return isValid(d) && format(d, 'yyyy-MM-dd') === value;
}

/** Last day of the block (inclusive): startDate + weeks * 7 - 1. */
export function blockEndDate(block: Pick<TrainingBlock, 'startDate' | 'weeks'>): string {
  return format(addDays(parseISO(block.startDate), block.weeks * 7 - 1), 'yyyy-MM-dd');
}

function label(block: TrainingBlock): string {
  return `block ${block.order.toString()} (${block.type})`;
}

function isWellFormed(block: TrainingBlock): boolean {
  return Number.isInteger(block.weeks) && block.weeks >= 1 && isIsoDate(block.startDate);
}

function checkBlockShape(blocks: TrainingBlock[]): SeasonIssue[] {
  const issues: SeasonIssue[] = [];
  const seen = new Set<number>();
  for (const b of blocks) {
    if (!isWellFormed(b)) {
      issues.push({
        code: 'invalid_block',
        message: `${label(b)} needs a yyyy-MM-dd startDate and a whole number of weeks ≥ 1 (got ${b.startDate}, ${b.weeks.toString()})`,
        blockOrders: [b.order],
      });
    }
    if (seen.has(b.order)) {
      issues.push({
        code: 'duplicate_order',
        message: `more than one block has order ${b.order.toString()}`,
        blockOrders: [b.order],
      });
    }
    seen.add(b.order);
  }
  return issues;
}

function pairIssue(prev: TrainingBlock, next: TrainingBlock): SeasonIssue | null {
  const prevEnd = blockEndDate(prev);
  const diff = differenceInCalendarDays(parseISO(next.startDate), parseISO(prevEnd));
  if (diff === 1) return null;

  const where = `${label(prev)} ends ${prevEnd} but ${label(next)} starts ${next.startDate}`;
  const blockOrders = [prev.order, next.order];
  if (diff > 1) {
    return { code: 'gap', message: `${where}: ${(diff - 1).toString()}-day gap`, blockOrders };
  }
  return {
    code: 'overlap',
    message: `${where}: ${(1 - diff).toString()}-day overlap`,
    blockOrders,
  };
}

function checkContiguity(sorted: TrainingBlock[]): SeasonIssue[] {
  const issues: SeasonIssue[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const issue = pairIssue(sorted[i - 1], sorted[i]);
    if (issue) issues.push(issue);
  }
  return issues;
}

function containsDate(block: TrainingBlock, date: string): boolean {
  return block.startDate <= date && date <= blockEndDate(block);
}

function raceBlockIssues(block: TrainingBlock, race: Race): SeasonIssue[] {
  const issues: SeasonIssue[] = [];
  if (block.type !== TrainingBlockType.race) {
    issues.push({
      code: 'race_block_wrong_type',
      message: `A-race ${race.name} (${race.date}) falls in ${label(block)}, expected a race block`,
      blockOrders: [block.order],
    });
  }
  const daysToEnd = differenceInCalendarDays(parseISO(blockEndDate(block)), parseISO(race.date));
  if (daysToEnd >= 7) {
    issues.push({
      code: 'race_not_in_final_week',
      message: `${label(block)} must end on the A-race week, but ends ${blockEndDate(block)} (race ${race.date})`,
      blockOrders: [block.order],
    });
  }
  return issues;
}

/** The block containing the A-race date is a `race` block ending that week, right after a `taper`. */
function checkARace(sorted: TrainingBlock[], race: Race): SeasonIssue[] {
  const idx = sorted.findIndex((b) => containsDate(b, race.date));
  if (idx === -1) {
    const last = sorted.at(-1);
    return [
      {
        code: 'race_block_missing',
        message: `A-race ${race.name} (${race.date}) is not inside any block`,
        blockOrders: last ? [last.order] : [],
      },
    ];
  }

  const raceBlock = sorted[idx];
  const issues = raceBlockIssues(raceBlock, race);
  const prev = idx > 0 ? sorted[idx - 1] : undefined;
  if (prev?.type !== TrainingBlockType.taper) {
    issues.push({
      code: 'taper_missing',
      message: prev
        ? `${label(raceBlock)} must be preceded by a taper block, not ${label(prev)}`
        : `${label(raceBlock)} must be preceded by a taper block`,
      blockOrders: prev ? [prev.order, raceBlock.order] : [raceBlock.order],
    });
  }
  return issues;
}

/**
 * Checks the block sequence invariants: well-formed blocks with unique `order`, contiguous
 * with no gaps or overlaps (in `order`), and, when an A-race is given, a `race` block ending
 * on race week right after a `taper` block. Returns every issue found (empty when valid).
 */
export function validateBlockSequence(
  blocks: TrainingBlock[],
  options: { aRace?: Race | null } = {}
): SeasonIssue[] {
  const issues = checkBlockShape(blocks);
  const sorted = blocks.filter(isWellFormed).sort((a, b) => a.order - b.order);
  issues.push(...checkContiguity(sorted));

  const race = options.aRace;
  if (race?.priority === RacePriority.A) issues.push(...checkARace(sorted, race));
  return issues;
}

/** `validateBlockSequence` plus: the first block starts on the plan's startDate. */
export function validateSeasonPlan(plan: SeasonPlan): SeasonIssue[] {
  const issues = validateBlockSequence(plan.blocks, { aRace: plan.aRace });
  const first = plan.blocks.reduce<TrainingBlock | undefined>(
    (min, b) => (min === undefined || b.order < min.order ? b : min),
    undefined
  );
  if (first && first.startDate !== plan.startDate) {
    issues.push({
      code: 'plan_start_mismatch',
      message: `season starts ${plan.startDate} but ${label(first)} starts ${first.startDate}`,
      blockOrders: [first.order],
    });
  }
  return issues;
}

/** Throws `SeasonValidationError` listing every issue if the plan breaks an invariant. */
export function assertValidSeasonPlan(plan: SeasonPlan): void {
  const issues = validateSeasonPlan(plan);
  if (issues.length > 0) throw new SeasonValidationError(issues);
}

import { BlockGeneratorConfig, DEFAULT_BLOCK_GENERATOR_CONFIG } from '../season/generator-config';
import { TrainingBlock, TrainingBlockType } from '../season/types';
import { blockEndDate } from '../season/validate';
import { addDaysIso } from '../season/window';
import { isoWeekKey } from './iso-week';
import { WeeklyStats } from './weekly-stats';

/** A fitted change in weekly compliance within this many points counts as flat */
export const COMPLIANCE_TREND_DEAD_BAND_PCT = 5;

export type ComplianceTrend = 'improving' | 'declining' | 'flat' | 'unknown';

export interface BlockWeekVerdict {
  isoWeek: string;
  plannedMin: number;
  actualMin: number;
  /** Actual / planned minutes of the week; null when nothing was planned */
  compliancePct: number | null;
}

export interface BlockVerdict {
  blockOrder: number;
  blockType: TrainingBlockType;
  from: string;
  to: string;
  weeks: number;
  targetWeeklyHours: number;
  /** Mean actual hours over the weeks that have stats */
  achievedWeeklyHours: number | null;
  /** Actual hours vs the block's weekly target over the weeks that have stats */
  volumeAchievedPct: number | null;
  ctlStart: number | null;
  ctlEnd: number | null;
  ctlDelta: number | null;
  targetCtl: number | null;
  /** ctlEnd − targetCtl; null without a target */
  ctlGap: number | null;
  /** Block weeks in order; missing ones are listed in `missingWeeks` instead */
  weekly: BlockWeekVerdict[];
  complianceTrend: ComplianceTrend;
  /** Block weeks without a WeeklyStats row */
  missingWeeks: string[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function delta(start: number | null, end: number | null): number | null {
  return start === null || end === null ? null : round1(end - start);
}

/** ISO weeks of the block, in order. */
export function blockIsoWeeks(block: Pick<TrainingBlock, 'startDate' | 'weeks'>): string[] {
  return Array.from({ length: block.weeks }, (_, k) =>
    isoWeekKey(addDaysIso(block.startDate, k * 7))
  );
}

/** Least-squares change from the first to the last value, in points. */
function fittedChange(values: number[]): number {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  return (num / den) * (n - 1);
}

export function complianceTrend(values: number[]): ComplianceTrend {
  if (values.length < 2) return 'unknown';
  const change = fittedChange(values);
  if (change > COMPLIANCE_TREND_DEAD_BAND_PCT) return 'improving';
  if (change < -COMPLIANCE_TREND_DEAD_BAND_PCT) return 'declining';
  return 'flat';
}

/**
 * How a block went against its targets, from the stored WeeklyStats of its weeks: volume
 * achieved vs `targetWeeklyHours`, CTL from before the block to its end (vs `targetCtl` when
 * set), and the trend of weekly compliance. Weeks without stats count neither way. Pure.
 */
export function computeBlockVerdict(block: TrainingBlock, stats: WeeklyStats[]): BlockVerdict {
  const byWeek = new Map(stats.map((s) => [s.isoWeek, s]));
  const keys = blockIsoWeeks(block);
  const present = keys.map((k) => byWeek.get(k)).filter((s): s is WeeklyStats => s !== undefined);

  const actualMin = present.reduce((sum, s) => sum + s.total.actualMin, 0);
  const achievedWeeklyHours = present.length > 0 ? round1(actualMin / 60 / present.length) : null;
  const targetMin = block.targetWeeklyHours * 60 * present.length;
  const volumeAchievedPct = targetMin > 0 ? round1((actualMin / targetMin) * 100) : null;

  const ctlStart = present.at(0)?.load.start?.ctl ?? null;
  const ctlEnd = present.at(-1)?.load.end?.ctl ?? null;
  const weekly = present.map((s) => ({
    isoWeek: s.isoWeek,
    plannedMin: s.total.plannedMin,
    actualMin: s.total.actualMin,
    compliancePct: s.total.compliancePct,
  }));
  const compliance = weekly.map((w) => w.compliancePct).filter((v): v is number => v !== null);

  return {
    blockOrder: block.order,
    blockType: block.type,
    from: block.startDate,
    to: blockEndDate(block),
    weeks: block.weeks,
    targetWeeklyHours: block.targetWeeklyHours,
    achievedWeeklyHours,
    volumeAchievedPct,
    ctlStart,
    ctlEnd,
    ctlDelta: delta(ctlStart, ctlEnd),
    targetCtl: block.targetCtl,
    ctlGap: delta(block.targetCtl, ctlEnd),
    weekly,
    complianceTrend: complianceTrend(compliance),
    missingWeeks: keys.filter((k) => !byWeek.has(k)),
  };
}

/**
 * Weekly hours a re-projection starts from: the next block's planned level scaled by the share
 * of volume achieved (70% achieved → 70% of the planned start). Over-achievement never seeds
 * more than one ramp step above plan. Without a verdict or next block, the achieved hours.
 */
export function reprojectionSeed(
  verdict: Pick<BlockVerdict, 'volumeAchievedPct' | 'achievedWeeklyHours' | 'targetWeeklyHours'>,
  nextBlock: Pick<TrainingBlock, 'targetWeeklyHours'> | undefined,
  config: BlockGeneratorConfig = DEFAULT_BLOCK_GENERATOR_CONFIG
): number {
  const planned = nextBlock?.targetWeeklyHours ?? verdict.targetWeeklyHours;
  if (verdict.volumeAchievedPct === null) return verdict.achievedWeeklyHours ?? planned;
  const ratio = Math.min(verdict.volumeAchievedPct / 100, 1 + config.maxWeeklyRamp);
  return round1(planned * ratio);
}

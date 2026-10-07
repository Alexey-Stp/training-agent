import { addDaysIso } from './season/window';
import type { RulesContext } from './types';

/** Days before `date` the HRV baseline averages over (today excluded) */
export const HRV_BASELINE_DAYS = 30;
/** Fewer HRV readings than this in the baseline window and no baseline is reported */
export const HRV_MIN_SAMPLES = 7;

export type HrvBaselineStatus = 'ok' | 'insufficient' | 'no_today';

export interface HrvBaseline {
  status: HrvBaselineStatus;
  /** HRV samples in the 30 days before `date` */
  samples: number;
  mean: number | null;
  sd: number | null;
  today: number | null;
  /** today < mean − 1 SD */
  low: boolean;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * HRV against its rolling baseline: mean and population SD of the readings in the
 * `HRV_BASELINE_DAYS` days before `date`. Today is low when it is below mean − 1 SD.
 */
export function hrvBaseline(
  rows: readonly { date: string; hrv: number | null }[],
  date: string
): HrvBaseline {
  const from = addDaysIso(date, -HRV_BASELINE_DAYS);
  const samples = rows.flatMap((row) =>
    row.date >= from && row.date < date && row.hrv !== null ? [row.hrv] : []
  );
  const today = rows.find((row) => row.date === date)?.hrv ?? null;
  if (samples.length < HRV_MIN_SAMPLES) {
    return {
      status: 'insufficient',
      samples: samples.length,
      mean: null,
      sd: null,
      today,
      low: false,
    };
  }
  const m = mean(samples);
  const sd = Math.sqrt(mean(samples.map((v) => (v - m) ** 2)));
  if (today === null) {
    return { status: 'no_today', samples: samples.length, mean: m, sd, today, low: false };
  }
  return { status: 'ok', samples: samples.length, mean: m, sd, today, low: today < m - sd };
}

export interface ReadinessVerdict {
  emoji: '🟢' | '🟡' | '🔴' | '⚪';
  sentence: string;
}

type TodayWellness =
  | Pick<NonNullable<RulesContext['todayWellness']>, 'subjectiveReadiness' | 'tsb'>
  | null
  | undefined;

/** What the verdict reads from the baseline */
export type HrvSignal = Pick<HrvBaseline, 'low' | 'today'>;

/** Check-in readiness at or below this is low: the same bound as core ReadinessDownshift */
const LOW_READINESS = 2;
/** Check-in readiness of exactly this is "so-so" */
const MID_READINESS = 3;
/** Form (CTL − ATL) below this means fatigue is building */
const HIGH_FATIGUE_TSB = -20;

function formatTsb(tsb: number): string {
  const rounded = Math.round(tsb);
  return rounded < 0 ? '−' + Math.abs(rounded).toString() : rounded.toString();
}

function hasData(wellness: TodayWellness, hrv: HrvSignal | null): boolean {
  const readiness = wellness?.subjectiveReadiness ?? null;
  const tsb = wellness?.tsb ?? null;
  return readiness !== null || tsb !== null || (hrv?.today ?? null) !== null;
}

/**
 * One-line readiness verdict from today's wellness: the athlete's check-in, HRV against the
 * 30-day baseline (null when unknown) and form (TSB). Worst signal wins; no data at all gives
 * a neutral line. Used by the morning brief and the dashboard's Today view.
 */
export function readinessVerdict(wellness: TodayWellness, hrv: HrvSignal | null): ReadinessVerdict {
  const readiness = wellness?.subjectiveReadiness ?? null;
  const tsb = wellness?.tsb ?? null;
  const hrvLow = hrv?.low === true;
  const fatigued = tsb !== null && tsb < HIGH_FATIGUE_TSB;

  if (readiness !== null && readiness <= LOW_READINESS) {
    const score = readiness.toString() + '/5';
    return { emoji: '🔴', sentence: 'Low readiness (' + score + '): keep today easy.' };
  }
  if (hrvLow && fatigued) {
    return {
      emoji: '🔴',
      sentence: 'HRV is below your baseline and fatigue is high: keep today easy.',
    };
  }
  if (hrvLow) {
    return {
      emoji: '🟡',
      sentence: 'HRV is below your 30-day baseline: listen to your body today.',
    };
  }
  if (fatigued) {
    const form = formatTsb(tsb);
    return {
      emoji: '🟡',
      sentence: 'Fatigue is building (form ' + form + '): keep the easy sessions easy.',
    };
  }
  if (readiness === MID_READINESS) {
    return { emoji: '🟡', sentence: 'You feel so-so (3/5): train as planned, but stay flexible.' };
  }
  if (!hasData(wellness, hrv)) {
    return { emoji: '⚪', sentence: 'No readiness data today: go by how you feel.' };
  }
  return { emoji: '🟢', sentence: 'Recovered: good to train as planned.' };
}

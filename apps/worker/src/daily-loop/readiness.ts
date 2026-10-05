import type { RulesContext } from '@triathlon/core';
import type { HrvBaseline } from '@triathlon/ai';

export interface ReadinessVerdict {
  emoji: '🟢' | '🟡' | '🔴' | '⚪';
  sentence: string;
}

type TodayWellness = RulesContext['todayWellness'];

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

function hasData(wellness: TodayWellness, hrv: HrvBaseline | null): boolean {
  const readiness = wellness?.subjectiveReadiness ?? null;
  const tsb = wellness?.tsb ?? null;
  return readiness !== null || tsb !== null || (hrv?.today ?? null) !== null;
}

/**
 * The brief's one-line readiness verdict from today's wellness: the athlete's check-in, HRV
 * against the 30-day baseline (null when the daily context couldn't be built) and form (TSB).
 * Worst signal wins; no data at all gives a neutral line.
 */
export function readinessVerdict(
  wellness: TodayWellness,
  hrv: HrvBaseline | null
): ReadinessVerdict {
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

import {
  escapeHtml,
  formatPace,
  type PaceMetrics,
  type PowerMetrics,
  type Race,
  type RaceMetrics,
  type SplitKind,
  type TargetStatus,
} from '@triathlon/core';
import type { RaceDebriefText } from '@triathlon/ai';
import { STALE_BRIEF_NOTE } from './race-brief-render';

const SPLIT_TEXT: Record<SplitKind, string> = {
  positive: 'positive split (second half slower)',
  negative: 'negative split (second half faster)',
  even: 'even split',
};

const POWER_STATUS_TEXT: Record<TargetStatus, string> = {
  below: 'below the band',
  within: 'within the band',
  above: 'above the band',
};

// Seconds per km: below the band is faster than the target
const PACE_STATUS_TEXT: Record<TargetStatus, string> = {
  below: 'faster than the band',
  within: 'within the band',
  above: 'slower than the band',
};

const DRIFT_BASIS_TEXT = {
  power: 'power per heartbeat',
  speed: 'speed per heartbeat',
  hr: 'heart rate rise',
} as const;

const TIER_NOTE = {
  power: null,
  hr: 'No power stream: heart rate and speed only.',
  none: 'No stream data: only whole-activity averages are compared.',
} as const;

export const NO_ACTIVITY_QUESTION =
  'I could not find an activity for this race in intervals.icu. Did you race? If you did, ' +
  'check that your device synced, then send /sync. I will not debrief this race automatically.';

/** 5h12m, or 52m under an hour */
export function formatDuration(sec: number): string {
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return minutes.toString() + 'm';
  return Math.floor(minutes / 60).toString() + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
}

function percent(value: number): string {
  return value.toFixed(1) + '%';
}

function powerLines(power: PowerMetrics): string[] {
  const lines: string[] = [];
  const target = power.vsTarget;
  if (target) {
    const band = target.lowW.toString() + '–' + target.highW.toString() + ' W';
    const what = target.basis === 'np' ? 'NP' : 'Average power';
    const watts = target.watts.toString() + ' W';
    lines.push(
      what + ' ' + watts + ' vs T-1 target ' + band + ': ' + POWER_STATUS_TEXT[target.status]
    );
  } else {
    lines.push('Average power ' + power.avgPower.toString() + ' W');
  }
  if (power.firstHalfPower !== null && power.secondHalfPower !== null) {
    const halves =
      power.firstHalfPower.toString() + ' W then ' + power.secondHalfPower.toString() + ' W';
    const fade = power.powerFadePct === null ? '' : ' (fade ' + percent(power.powerFadePct) + ')';
    lines.push('Power by half: ' + halves + fade);
  }
  return lines;
}

function paceLines(pace: PaceMetrics): string[] {
  const lines: string[] = [];
  const target = pace.vsTarget;
  if (target) {
    const band = formatPace(target.lowSecPerKm) + ' to ' + formatPace(target.highSecPerKm);
    lines.push(
      'Average pace ' +
        formatPace(pace.avgPaceSecPerKm) +
        ' vs T-1 target ' +
        band +
        ': ' +
        PACE_STATUS_TEXT[target.status]
    );
  } else {
    lines.push('Average pace ' + formatPace(pace.avgPaceSecPerKm));
  }
  if (pace.firstHalfPaceSecPerKm !== null && pace.secondHalfPaceSecPerKm !== null) {
    lines.push(
      'Pace by half: ' +
        formatPace(pace.firstHalfPaceSecPerKm) +
        ' then ' +
        formatPace(pace.secondHalfPaceSecPerKm)
    );
  }
  return lines;
}

/**
 * The measured facts as plain lines: everything the debrief says in numbers. The LLM may repeat
 * these figures and no others (`parseRaceDebriefText`).
 */
export function debriefFacts(metrics: RaceMetrics): string[] {
  const lines = ['Time ' + formatDuration(metrics.durationSec)];
  if (metrics.power) lines.push(...powerLines(metrics.power));
  if (metrics.pace) lines.push(...paceLines(metrics.pace));
  if (metrics.split) lines.push('Split: ' + SPLIT_TEXT[metrics.split]);
  if (metrics.avgHr !== null) {
    const drift =
      metrics.hrDriftPct !== null && metrics.hrDriftBasis
        ? ', drift ' +
          percent(metrics.hrDriftPct) +
          ' (' +
          DRIFT_BASIS_TEXT[metrics.hrDriftBasis] +
          ')'
        : '';
    lines.push('Heart rate: average ' + metrics.avgHr.toString() + ' bpm' + drift);
  }
  const note = TIER_NOTE[metrics.tier];
  if (note) lines.push(note);
  if (!metrics.power && !metrics.pace) lines.push('No power or pace data was recorded.');
  return lines;
}

export interface RenderRaceDebriefInput {
  race: Pick<Race, 'name'>;
  text: RaceDebriefText;
  facts: readonly string[];
  /** e.g. "10 easy days follow, rest first", or an empty string */
  recoveryLine: string;
  stale: boolean;
}

/** The Telegram HTML message. Every dynamic string, LLM text included, is escaped. */
export function renderRaceDebrief(input: RenderRaceDebriefInput): string {
  const lines: string[] = [
    '🏁 <b>' + escapeHtml(input.race.name) + '</b> · Debrief',
    '',
    escapeHtml(input.text.narrative),
    '',
    '<b>The numbers</b>',
    ...input.facts.map((f) => '• ' + escapeHtml(f)),
    '',
    '<b>Takeaways</b>',
    ...input.text.takeaways.map((t, i) => (i + 1).toString() + '. ' + escapeHtml(t)),
  ];
  if (input.recoveryLine) lines.push('', '<b>Recovery</b>', escapeHtml(input.recoveryLine));
  if (input.stale) lines.push('', STALE_BRIEF_NOTE);
  return lines.join('\n');
}

export function renderNoActivityQuestion(race: Pick<Race, 'name' | 'date'>): string {
  return (
    '🏁 <b>' +
    escapeHtml(race.name) +
    '</b> · ' +
    escapeHtml(race.date) +
    '\n\n' +
    escapeHtml(NO_ACTIVITY_QUESTION)
  );
}

import type { DateRange, KeySessionRef, WeekVolume, WeeklyStats } from '@triathlon/core';
import { loadPromptTemplate, renderTemplate } from '../context/template';
import type { SeasonPosition } from '../context/types';
import { DEFAULT_GUARDRAIL_CONFIG, type GuardrailConfig } from '../suggestion/guardrails';
import { renderSessionLines } from '../suggestion/prompt';
import type { CoachPlanSession } from '../suggestion/types';
import { MAX_VOLUME_FACTOR, MIN_VOLUME_FACTOR } from './schema';

export const WEEKLY_PROMPT_VERSION = 'weekly-v1';

/** The daily guardrails plus the next-week ramp cap */
export interface WeeklyGuardrailConfig extends GuardrailConfig {
  /** All changes together may add at most this share of next week's planned minutes */
  maxRamp: number;
}

export const DEFAULT_WEEKLY_GUARDRAIL_CONFIG: WeeklyGuardrailConfig = {
  ...DEFAULT_GUARDRAIL_CONFIG,
  maxRamp: 0.08,
};

export interface WeeklyPromptInput {
  /** Review day, athlete-local: the last day of the reviewed week */
  date: string;
  stats: WeeklyStats;
  /** Where the reviewed week and next week sit in the season */
  season: SeasonPosition | null;
  nextSeason: SeasonPosition | null;
  nextWeek: DateRange;
  /** Next week's planned sessions, the only ones the review may change */
  sessions: readonly CoachPlanSession[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `value` with fixed decimals, or 'n/a'. Fixed precision keeps the prompt byte-stable. */
function num(value: number | null, digits = 0): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function signed(value: number | null, digits = 1): string {
  if (value === null) return 'n/a';
  return value > 0 ? '+' + value.toFixed(digits) : value.toFixed(digits);
}

export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
}

function percent(share: number): string {
  return Math.round(share * 100).toString();
}

function blockLine(label: string, position: SeasonPosition | null): string {
  const block = position?.block;
  if (!block) return label + ': outside the season blocks.';
  const order = `block ${block.order.toString()} of ${block.count.toString()}`;
  const week = `week ${block.week.toString()} of ${block.weeks.toString()}`;
  return `${label}: ${order}, ${block.type} (focus: ${block.focus}), ${week}.`;
}

function aRaceLine(position: SeasonPosition): string {
  const race = position.aRace;
  if (!race || position.daysToARace === null) return 'No A-race set.';
  const days = position.daysToARace.toString();
  return `A-race: ${race.name} (${race.type}) on ${race.date}, in ${days} days.`;
}

export function renderWeeklySeason(input: WeeklyPromptInput): string {
  if (!input.season) return 'No active season.';
  return [blockLine('This week', input.season), aRaceLine(input.season)].join('\n');
}

function renderNextSeason(input: WeeklyPromptInput): string {
  if (!input.season) return 'No active season.';
  return blockLine('Season position', input.nextSeason);
}

function volumeLine(label: string, v: WeekVolume): string {
  const gap = v.actualMin - v.plannedMin;
  const done =
    v.compliancePct === null
      ? `${v.actualMin.toString()} min done, nothing planned`
      : `${v.actualMin.toString()} of ${v.plannedMin.toString()} min (${signed(gap, 0)} min, ${num(v.compliancePct)}%)`;
  const counts = `${v.activities.toString()} activities, ${v.plannedSessions.toString()} planned`;
  return `- ${label}: ${done}, ${num(v.actualDistanceKm, 1)} km, TSS ${num(v.actualTss)}; ${counts}.`;
}

export function renderVolume(stats: WeeklyStats): string {
  const head = stats.unplannedWeek ? ['No sessions were planned this week.'] : [];
  const sports = stats.bySport.map((s) => volumeLine(s.sport, s));
  if (sports.length === 0) return [...head, 'No training planned or done.'].join('\n');
  return [...head, ...sports, volumeLine('total', stats.total)].join('\n');
}

function keyLine(status: string, ref: KeySessionRef): string {
  return `- ${status}: ${ref.date} ${weekdayOf(ref.date)} ${ref.sport} "${ref.title}"`;
}

function renderWeeklyKeySessions(stats: WeeklyStats): string {
  const { hit, missed, pending } = stats.keySessions;
  const lines = [
    ...hit.map((r) => keyLine('done', r)),
    ...missed.map((r) => keyLine('missed', r)),
    ...pending.map((r) => keyLine('pending', r)),
  ];
  return lines.length > 0 ? lines.join('\n') : 'No key sessions this week.';
}

function renderIntensity(stats: WeeklyStats): string {
  const i = stats.intensity;
  const unknown = i.unknownMin.toString();
  if (i.easyPct === null || i.hardPct === null) {
    return `No heart-rate zones known (${unknown} min without HR or LTHR).`;
  }
  const easy = `Z1-2: ${i.easyMin.toString()} min (${num(i.easyPct)}%)`;
  const hard = `Z3+: ${i.hardMin.toString()} min (${num(i.hardPct)}%)`;
  return `${easy}, ${hard}, unknown: ${unknown} min.`;
}

function renderWeeklyLoad(stats: WeeklyStats): string {
  const { start, end, ctlDelta, atlDelta, tsbDelta } = stats.load;
  if (!end) return 'No CTL/ATL/TSB data this week.';
  const from = start ? num(start.ctl, 1) + ' → ' : '';
  const atl = `ATL ${num(end.atl, 1)} (${signed(atlDelta)})`;
  const tsb = `TSB ${num(end.tsb, 1)} (${signed(tsbDelta)})`;
  return [
    `CTL ${from}${num(end.ctl, 1)} (${signed(ctlDelta)}).`,
    `${atl}, ${tsb} at ${end.date}.`,
  ].join('\n');
}

function renderWeeklyWellness(stats: WeeklyStats): string {
  const w = stats.wellness;
  if (w.daysWithData === 0) return 'No wellness data this week.';
  const hrv = `HRV ${num(w.avgHrv, 1)} ms (week before ${num(w.prevAvgHrv, 1)}, ${signed(w.hrvDeltaPct)}%)`;
  const rest = `resting HR ${num(w.avgRestingHr, 1)} bpm, sleep ${num(w.avgSleepHours, 1)} h`;
  return [
    `${w.daysWithData.toString()} days with data.`,
    `${hrv}, ${rest}.`,
    `Check-in: readiness ${num(w.avgReadiness, 1)}/5, soreness ${num(w.avgSoreness, 1)}.`,
  ].join('\n');
}

/** Values for every placeholder of `weekly-v1`. Pure and byte-deterministic. */
export function renderWeeklySections(
  input: WeeklyPromptInput,
  config: WeeklyGuardrailConfig = DEFAULT_WEEKLY_GUARDRAIL_CONFIG
): Record<string, string> {
  const { stats } = input;
  return {
    isoWeek: stats.isoWeek,
    from: stats.from,
    to: stats.to,
    date: input.date,
    season: renderWeeklySeason(input),
    volume: renderVolume(stats),
    keySessions: renderWeeklyKeySessions(stats),
    intensity: renderIntensity(stats),
    load: renderWeeklyLoad(stats),
    wellness: renderWeeklyWellness(stats),
    nextFrom: input.nextWeek.from,
    nextTo: input.nextWeek.to,
    nextSeason: renderNextSeason(input),
    sessions: renderSessionLines(input.sessions, config),
    minFactor: MIN_VOLUME_FACTOR.toFixed(2),
    maxFactor: MAX_VOLUME_FACTOR.toFixed(2),
    maxRamp: percent(config.maxRamp),
    maxReduction: percent(config.maxReduction),
    lowReadiness: config.lowReadiness.toString(),
  };
}

/** The weekly review prompt: the week's data, next week's sessions and the answer format. */
export function buildWeeklyPrompt(
  input: WeeklyPromptInput,
  config: WeeklyGuardrailConfig = DEFAULT_WEEKLY_GUARDRAIL_CONFIG
): string {
  const template = loadPromptTemplate(WEEKLY_PROMPT_VERSION);
  return renderTemplate(template, renderWeeklySections(input, config));
}

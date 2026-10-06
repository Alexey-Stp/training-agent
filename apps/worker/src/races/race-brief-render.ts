import { format } from 'date-fns';
import {
  escapeHtml,
  formatPace,
  raceChecklist,
  RacePriority,
  RaceType,
  Sport,
  type PacingPlan,
  type Race,
  type RaceBriefKind,
} from '@triathlon/core';
import type { PlannedSessionRecord } from '../plan-store';
import { getSportIcon } from '../session-format';

/** A titled group of plain-text lines. Escaping happens only when the brief is rendered. */
export interface BriefSection {
  title: string;
  lines: string[];
}

export const NO_RUN_DATA_LINE = 'no recent data — race by feel/HR';
export const WEATHER_LINE = 'check the forecast the evening before and adjust kit and fluids';
export const STALE_BRIEF_NOTE =
  '⚠️ Training data may be out of date: intervals.icu could not be reached.';

/** Most sessions the week overview lists */
export const WEEK_OVERVIEW_MAX_LINES = 8;

export interface RaceBriefIntroOutro {
  intro: string;
  outro: string;
}

export function formatRaceDay(date: string): string {
  return format(new Date(date + 'T00:00:00'), 'EEE MMM d');
}

function weekOverview(sessions: readonly PlannedSessionRecord[]): BriefSection {
  const live = sessions.filter((s) => s.deletedAt === null && s.sport !== Sport.rest);
  const lines = live.slice(0, WEEK_OVERVIEW_MAX_LINES).map((s) => {
    const day = format(new Date(s.date + 'T00:00:00'), 'EEE');
    return (
      day + ' ' + getSportIcon(s.sport) + ' ' + s.title + ' ' + s.durationMin.toString() + 'min'
    );
  });
  if (live.length > WEEK_OVERVIEW_MAX_LINES) {
    lines.push('+' + (live.length - WEEK_OVERVIEW_MAX_LINES).toString() + ' more');
  }
  return {
    title: 'This week',
    lines: lines.length > 0 ? lines : ['no sessions planned: keep it light and rest up'],
  };
}

/** T-7: week overview, then the checklist. */
export function weekOutSections(
  race: Pick<Race, 'date' | 'type'>,
  sessions: readonly PlannedSessionRecord[]
): BriefSection[] {
  return [
    { title: 'Race', lines: [formatRaceDay(race.date) + ', ' + race.type] },
    weekOverview(sessions),
    ...raceChecklist(race.type).map((s) => ({ title: s.title, lines: s.items })),
  ];
}

function bikeSection(plan: PacingPlan): BriefSection | null {
  const bike = plan.bike;
  if (!bike) return null;
  const pct = bike.pctLow.toString() + '–' + bike.pctHigh.toString() + '% of FTP';
  const watts = bike.lowW.toString() + '–' + bike.highW.toString() + ' W';
  return { title: 'Bike', lines: [pct + ' = ' + watts + ' (' + bike.source + ')'] };
}

function runSection(plan: PacingPlan): BriefSection {
  const run = plan.run;
  if (!run) return { title: 'Run', lines: [NO_RUN_DATA_LINE] };
  const pace = formatPace(run.lowSecPerKm) + ' to ' + formatPace(run.highSecPerKm);
  return { title: 'Run', lines: [pace + ' (' + run.source + ')'] };
}

function fuelingSection(plan: PacingPlan): BriefSection | null {
  const fueling = plan.fueling;
  if (!fueling) return null;
  const grams = fueling.carbsLowGPerH.toString() + '–' + fueling.carbsHighGPerH.toString();
  return { title: 'Fueling', lines: [grams + ' g carbs/h, start early and keep to the plan'] };
}

/**
 * T-1: pacing targets and fueling. An A-race brief also has the swim note and the weather line;
 * B/C races get the shorter version.
 */
export function eveSections(
  race: Pick<Race, 'type' | 'priority'>,
  plan: PacingPlan
): BriefSection[] {
  const full = race.priority === RacePriority.A;
  const swim: BriefSection | null =
    full && race.type !== RaceType.run ? { title: 'Swim', lines: [plan.swimNote] } : null;
  const weather: BriefSection | null = full ? { title: 'Weather', lines: [WEATHER_LINE] } : null;
  return [bikeSection(plan), runSection(plan), swim, fuelingSection(plan), weather].filter(
    (s): s is BriefSection => s !== null
  );
}

/** The deterministic content as plain text, for the tone prompt. */
export function sectionsToPlainText(sections: readonly BriefSection[]): string {
  return sections.map((s) => s.title + ': ' + s.lines.join('; ')).join('\n');
}

export interface RenderRaceBriefInput {
  kind: RaceBriefKind;
  race: Pick<Race, 'name' | 'date'>;
  text: RaceBriefIntroOutro;
  sections: readonly BriefSection[];
  stale: boolean;
}

/** The Telegram HTML message. Every dynamic string, LLM text included, is escaped. */
export function renderRaceBrief(input: RenderRaceBriefInput): string {
  const label = input.kind === 't7' ? 'Race week' : 'Race eve';
  const lines: string[] = [
    '🏁 <b>' + escapeHtml(input.race.name) + '</b> · ' + label,
    '',
    escapeHtml(input.text.intro),
  ];
  for (const section of input.sections) {
    lines.push('', '<b>' + escapeHtml(section.title) + '</b>');
    for (const line of section.lines) lines.push('• ' + escapeHtml(line));
  }
  lines.push('', escapeHtml(input.text.outro));
  if (input.stale) lines.push('', STALE_BRIEF_NOTE);
  return lines.join('\n');
}

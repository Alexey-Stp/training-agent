import { format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { coachDecisionData, escapeHtml } from '@triathlon/core';
import {
  describeSessionChanges,
  type CoachDecisionRecord,
  type PlannedSessionSummary,
} from '@triathlon/ai';
import { toCoachPlanSession } from '../coach-plan';
import type { InlineButton, RichReply } from '../reply';
import { getSportIcon } from '../session-format';
import type { ReadinessVerdict } from './readiness';

export interface BriefInput {
  /** Athlete-local today */
  date: string;
  timezone: string;
  decision: CoachDecisionRecord;
  decisionId: string;
  /** The plan window the coach saw (today..+6): names the sessions the changes touch */
  planned: readonly PlannedSessionSummary[];
  readiness: ReadinessVerdict;
  /** An ICU sync failed: the brief uses data as of `dataAsOf` (null: never synced) */
  stale: boolean;
  dataAsOf: Date | null;
}

export function staleNote(dataAsOf: Date | null, timezone: string): string {
  const asOf =
    dataAsOf === null ? 'never synced' : formatInTimeZone(dataAsOf, timezone, 'yyyy-MM-dd HH:mm');
  return '⚠️ intervals.icu unavailable: data as of ' + asOf;
}

function sessionLine(s: PlannedSessionSummary): string {
  const detail = s.durationMin.toString() + 'min • ' + s.intensity.toUpperCase();
  return getSportIcon(s.sport) + ' ' + escapeHtml(s.title) + ' (' + detail + ')';
}

/** Apply / Keep plan when the coach proposes changes; Discuss always. */
export function briefKeyboard(decisionId: string, hasChanges: boolean): InlineButton[][] {
  const discuss = [{ text: '💬 Discuss', data: coachDecisionData('discuss', decisionId) }];
  if (!hasChanges) return [discuss];
  return [
    [
      { text: '✅ Apply', data: coachDecisionData('apply', decisionId) },
      { text: '➡️ Keep plan', data: coachDecisionData('keep', decisionId) },
    ],
    discuss,
  ];
}

function proposedLines(input: BriefInput): string[] {
  const { finalChanges } = input.decision;
  if (finalChanges.length === 0) return [];
  const sessions = input.planned.map(toCoachPlanSession);
  const lines = describeSessionChanges(finalChanges, sessions).map((l) => '• ' + escapeHtml(l));
  return ['', '<b>Proposed</b>', ...lines];
}

/**
 * The morning brief: date, stale-data note, readiness verdict, today's sessions, the coach's
 * recommendation and the exact changes it proposes, with Apply / Keep plan / Discuss buttons.
 */
export function renderBrief(input: BriefInput): RichReply {
  const heading = '☀️ <b>Morning brief: ' + format(parseISO(input.date), 'EEE d MMM') + '</b>';
  const todaySessions = input.planned.filter((s) => s.date === input.date);
  const today =
    todaySessions.length === 0
      ? ['Rest day: nothing planned today.']
      : ['<b>Today</b>', ...todaySessions.map(sessionLine)];
  const readiness = input.readiness.emoji + ' ' + escapeHtml(input.readiness.sentence);
  const lines = [
    heading,
    ...(input.stale ? ['', escapeHtml(staleNote(input.dataAsOf, input.timezone))] : []),
    '',
    readiness,
    '',
    ...today,
    '',
    '<b>Coach</b>',
    escapeHtml(input.decision.athleteMessage),
    ...proposedLines(input),
  ];
  return {
    text: lines.join('\n'),
    html: true,
    keyboard: briefKeyboard(input.decisionId, input.decision.finalChanges.length > 0),
  };
}

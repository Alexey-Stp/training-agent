import { format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { coachDecisionData, escapeHtml } from '@triathlon/core';
import type { CoachDecisionRecord, PlannedSessionSummary } from '@triathlon/ai';
import type { RichReply } from '../reply';
import { getSportIcon } from '../session-format';

export interface BriefInput {
  /** Athlete-local today */
  date: string;
  timezone: string;
  decision: CoachDecisionRecord;
  decisionId: string;
  /** Today's planned sessions */
  todaySessions: readonly PlannedSessionSummary[];
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

/**
 * The morning brief: date, stale-data note, today's sessions and the coach's message, with
 * Apply/Keep buttons when the coach proposes plan changes.
 */
export function renderBrief(input: BriefInput): RichReply {
  const heading = '☀️ <b>Morning brief: ' + format(parseISO(input.date), 'EEE d MMM') + '</b>';
  const today =
    input.todaySessions.length === 0
      ? ['Rest day: nothing planned today.']
      : ['<b>Today</b>', ...input.todaySessions.map(sessionLine)];
  const lines = [
    heading,
    ...(input.stale ? ['', escapeHtml(staleNote(input.dataAsOf, input.timezone))] : []),
    '',
    ...today,
    '',
    escapeHtml(input.decision.athleteMessage),
  ];

  const reply: RichReply = { text: lines.join('\n'), html: true };
  if (input.decision.finalChanges.length > 0) {
    reply.keyboard = [
      [
        { text: '✅ Apply', data: coachDecisionData('apply', input.decisionId) },
        { text: '↩️ Keep my plan', data: coachDecisionData('keep', input.decisionId) },
      ],
    ];
  }
  return reply;
}

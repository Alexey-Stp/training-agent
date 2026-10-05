import {
  coachDecisionData,
  escapeHtml,
  type SportWeekStats,
  type WeeklyStats,
} from '@triathlon/core';
import {
  describeSessionChanges,
  type CoachPlanSession,
  type SeasonPosition,
  type SessionDiff,
  type WeeklyReviewText,
} from '@triathlon/ai';
import type { InlineButton, RichReply } from '../reply';
import { getSportIcon } from '../session-format';

/** Telegram lines the report may take, buttons aside */
export const WEEKLY_REPORT_MAX_LINES = 15;

export const STALE_NOTE = '⚠️ intervals.icu unavailable: activities may be missing.';
export const NO_CHANGES_LINE = 'No changes to next week.';

export interface WeeklyReportInput {
  stats: WeeklyStats;
  season: SeasonPosition | null;
  review: WeeklyReviewText;
  finalChanges: readonly SessionDiff[];
  /** Next week's sessions: name the sessions the changes touch */
  sessions: readonly CoachPlanSession[];
  decisionId: string;
  /** The activity sync failed: the stats may miss activities */
  stale: boolean;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** LLM text on one line, HTML-escaped: the line budget counts newlines */
function oneLine(text: string): string {
  return escapeHtml(text.replaceAll('\n', ' ').trim());
}

function km(distance: number): string {
  return distance > 0 ? ' · ' + distance.toFixed(1) + ' km' : '';
}

/** `🚴 Bike 75/255 min (−180) · 37.5 km`, `🏃 Run 225/225 min ✓`, `💪 Strength 30 min (unplanned)` */
export function sportLine(s: SportWeekStats): string {
  const name = getSportIcon(s.sport) + ' ' + capitalize(s.sport);
  if (s.compliancePct === null) {
    return name + ' ' + s.actualMin.toString() + ' min (unplanned)' + km(s.actualDistanceKm);
  }
  const gap = s.actualMin - s.plannedMin;
  const delta = gap >= 0 ? ' ✓' : ' (−' + (-gap).toString() + ')';
  const minutes = s.actualMin.toString() + '/' + s.plannedMin.toString() + ' min';
  return name + ' ' + minutes + delta + km(s.actualDistanceKm);
}

function header(stats: WeeklyStats, season: SeasonPosition | null): string {
  const week = 'Week ' + String(Number(stats.isoWeek.slice(-2)));
  const block = season?.block;
  const position = block
    ? ' · ' + capitalize(block.type) + ' ' + block.week.toString() + '/' + block.weeks.toString()
    : '';
  return '📊 <b>' + week + ' review</b>' + position;
}

function keyLine(stats: WeeklyStats): string | null {
  const { hit, missed, pending } = stats.keySessions;
  const count = hit.length + missed.length + pending.length;
  if (count === 0) return null;
  const done = '🔑 Key ' + hit.length.toString() + '/' + count.toString();
  if (missed.length === 0) return done;
  return done + ' · missed ' + escapeHtml(missed.map((k) => k.title).join(', '));
}

/** The next-week section in `budget` lines: header plus changes, `+N more` when they don't fit. */
function nextWeekLines(input: WeeklyReportInput, budget: number): string[] {
  const changes = describeSessionChanges(input.finalChanges, input.sessions).map(
    (l) => '• ' + escapeHtml(l)
  );
  if (changes.length === 0) return [NO_CHANGES_LINE];
  const room = budget - 1;
  if (changes.length <= room) return ['<b>Next week</b>', ...changes];
  const shown = Math.max(room - 1, 0);
  const more = '• +' + (changes.length - shown).toString() + ' more';
  return ['<b>Next week</b>', ...changes.slice(0, shown), more];
}

/** Apply next week / Keep plan when the review proposes changes; Discuss always. */
export function weeklyReportKeyboard(decisionId: string, hasChanges: boolean): InlineButton[][] {
  const discuss = [{ text: '💬 Discuss', data: coachDecisionData('discuss', decisionId) }];
  if (!hasChanges) return [discuss];
  return [
    [
      { text: '✅ Apply next week', data: coachDecisionData('apply', decisionId) },
      { text: '➡️ Keep plan', data: coachDecisionData('keep', decisionId) },
    ],
    discuss,
  ];
}

/**
 * The Sunday report, at most `WEEKLY_REPORT_MAX_LINES` lines: header, summary, planned vs done
 * per sport, key sessions, wins, concerns, then next week's changes (cut to what fits).
 */
export function renderWeeklyReport(input: WeeklyReportInput): RichReply {
  const { stats, review } = input;
  const optional = (line: string | null) => (line === null ? [] : [line]);
  const body = [
    header(stats, input.season),
    ...(input.stale ? [STALE_NOTE] : []),
    oneLine(review.summary),
    ...stats.bySport.map(sportLine),
    ...optional(keyLine(stats)),
    ...review.wins.map((w) => '✅ ' + oneLine(w)),
    ...review.concerns.map((c) => '⚠️ ' + oneLine(c)),
    ...optional(review.note === null ? null : 'ℹ️ ' + oneLine(review.note)),
  ];
  // The next-week section needs at least two lines (header and one change)
  const head = body.slice(0, WEEKLY_REPORT_MAX_LINES - 2);
  const lines = [...head, ...nextWeekLines(input, WEEKLY_REPORT_MAX_LINES - head.length)];
  return {
    text: lines.join('\n'),
    html: true,
    keyboard: weeklyReportKeyboard(input.decisionId, input.finalChanges.length > 0),
  };
}

import { format } from 'date-fns';
import { Sport, type Session } from '@triathlon/core';
import type { PlannedSessionRecord } from './plan-store';

export function getSportIcon(sport: Sport): string {
  switch (sport) {
    case Sport.swim:
      return '🏊';
    case Sport.bike:
      return '🚴';
    case Sport.run:
      return '🏃';
    case Sport.strength:
      return '💪';
    case Sport.rest:
      return '😴';
    case Sport.other:
      return '🏅';
    default:
      return '🏋️';
  }
}

/** Sessions grouped by date, dates ascending, session order kept within a date. */
export function groupSessionsByDate(sessions: Session[]): [string, Session[]][] {
  const byDate = new Map<string, Session[]>();
  for (const session of sessions) {
    byDate.set(session.date, [...(byDate.get(session.date) ?? []), session]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** "\nMon Oct 5:\n" heading of a day in a plan reply. */
export function formatDayHeader(date: string): string {
  const dateObj = new Date(date + 'T00:00:00');
  return `\n${format(dateObj, 'EEE')} ${format(dateObj, 'MMM d')}:\n`;
}

/** One session of a plan reply, with an optional status line under it. */
export function formatSession(session: Session, status: string | null = null): string {
  const optional = session.tags?.includes('optional') ? ' (optional)' : '';
  let text = `  ${getSportIcon(session.sport)} ${session.title}${optional}\n`;
  text += `     ${session.durationMin}min • ${session.intensity.toUpperCase()}`;
  if (session.notes) {
    text += `\n     💡 ${session.notes}`;
  }
  if (status) {
    text += `\n     ${status}`;
  }
  return text + '\n';
}

/** intervals.icu status line of a stored session, if there is anything to say. */
export function syncStatusLabel(row: PlannedSessionRecord | undefined): string | null {
  if (!row) return null;
  switch (row.status) {
    case 'pushed':
      return '📲 In intervals.icu';
    case 'draft':
      return row.icuEventId !== null ? '✏️ Changed, not pushed yet (/plan push)' : null;
    case 'modified_externally':
      return `⚠️ Changed in intervals.icu (${row.externalChange ?? 'edited'}), your version kept`;
    case 'completed':
      return '✅ Completed';
    case 'skipped':
      return '⏭ Skipped';
  }
}

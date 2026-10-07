import {
  addDaysIso,
  isoWeekKey,
  isoWeekRange,
  localToday,
  nextIsoWeek,
  previousIsoWeek,
  Sport,
  type DateRange,
} from '@triathlon/core';
import type { DashboardReadRepo, DaySession } from '../plan/read-store';

export interface WeekDeps {
  reads: DashboardReadRepo;
  now: () => Date;
}

export interface DayCell {
  date: string;
  isToday: boolean;
  /** Live training sessions of the day (rest rows left out), in slot order */
  sessions: DaySession[];
  /** Distinct sports in session order */
  sports: Sport[];
  totalMin: number;
  /** Every session of the day is completed */
  done: boolean;
}

export type WeekModel =
  | { kind: 'no_profile' }
  | {
      kind: 'week';
      key: string;
      range: DateRange;
      today: string;
      days: DayCell[];
      totalMin: number;
      previous: string;
      next: string;
    };

/** A `?week=2026-W41` value that names a real ISO week, else null. */
export function parseWeekParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    isoWeekRange(value);
    return value;
  } catch {
    return null;
  }
}

function dayCell(date: string, today: string, rows: DaySession[]): DayCell {
  const sessions = rows.filter((s) => s.date === date && s.sport !== Sport.rest);
  return {
    date,
    isToday: date === today,
    sessions,
    sports: [...new Set(sessions.map((s) => s.sport))],
    totalMin: sessions.reduce((sum, s) => sum + s.durationMin, 0),
    done: sessions.length > 0 && sessions.every((s) => s.status === 'completed'),
  };
}

/**
 * Seven Monday..Sunday cells of the athlete's local week (or `?week=`), built from one
 * read of the stored PlannedSession rows. Reads only.
 */
export async function loadWeek(
  userId: string,
  requestedWeek: string | null,
  deps: WeekDeps
): Promise<WeekModel> {
  const timezone = await deps.reads.findTimezone(userId);
  if (!timezone) return { kind: 'no_profile' };
  const today = localToday(deps.now(), timezone);
  const key = requestedWeek ?? isoWeekKey(today);
  const range = isoWeekRange(key);
  const rows = await deps.reads.findSessions(userId, range.from, range.to);
  const days = Array.from({ length: 7 }, (_, i) => dayCell(addDaysIso(range.from, i), today, rows));
  return {
    kind: 'week',
    key,
    range,
    today,
    days,
    totalMin: days.reduce((sum, d) => sum + d.totalMin, 0),
    previous: previousIsoWeek(range.from),
    next: nextIsoWeek(range.from),
  };
}

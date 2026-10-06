import { addDaysIso, localToday, Sport } from '@triathlon/core';
import type { DashboardReadRepo, DaySession } from '../plan/read-store';

/** Days around the viewed day that count as "a plan exists" when no season is active */
export const PLAN_LOOKAROUND_DAYS = 7;

export interface TodayDeps {
  reads: DashboardReadRepo;
  now: () => Date;
}

interface DayContext {
  /** The viewed local day */
  date: string;
  /** The athlete's local today */
  today: string;
  timezone: string;
}

export type TodayModel =
  | { kind: 'no_profile' }
  | ({ kind: 'no_plan' } & DayContext)
  | ({ kind: 'rest' } & DayContext)
  | ({ kind: 'sessions'; sessions: DaySession[] } & DayContext);

/**
 * What the Today view shows for one local day, read from the persisted PlannedSession rows
 * (never regenerated): the day's sessions, a rest day, or "no plan yet" when the athlete has
 * no active season and no stored sessions around that day. Reads only.
 */
export async function loadToday(
  userId: string,
  requestedDate: string | null,
  deps: TodayDeps
): Promise<TodayModel> {
  const timezone = await deps.reads.findTimezone(userId);
  if (!timezone) return { kind: 'no_profile' };
  const today = localToday(deps.now(), timezone);
  const date = requestedDate ?? today;
  const context: DayContext = { date, today, timezone };

  const [around, activeSeason] = await Promise.all([
    deps.reads.findSessions(
      userId,
      addDaysIso(date, -PLAN_LOOKAROUND_DAYS),
      addDaysIso(date, PLAN_LOOKAROUND_DAYS)
    ),
    deps.reads.hasActiveSeason(userId),
  ]);
  const sessions = around.filter((s) => s.date === date && s.sport !== Sport.rest);
  if (sessions.length > 0) return { kind: 'sessions', sessions, ...context };
  if (activeSeason || around.length > 0) return { kind: 'rest', ...context };
  return { kind: 'no_plan', ...context };
}

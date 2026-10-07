import {
  addDaysIso,
  HRV_BASELINE_DAYS,
  hrvBaseline,
  localToday,
  readinessVerdict,
  Sport,
  type ReadinessVerdict,
} from '@triathlon/core';
import type { DashboardReadRepo, DaySession, WellnessDay } from '../plan/read-store';

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
  /** Local today only: the same verdict as the morning brief */
  readiness: ReadinessVerdict | null;
}

export type TodayModel =
  | { kind: 'no_profile' }
  | ({ kind: 'no_plan' } & DayContext)
  | ({ kind: 'rest' } & DayContext)
  | ({ kind: 'sessions'; sessions: DaySession[] } & DayContext);

/** Readiness from today's wellness and the HRV baseline of the 30 days before it. */
function readinessFor(rows: WellnessDay[], today: string): ReadinessVerdict {
  const todayRow = rows.find((row) => row.date === today) ?? null;
  return readinessVerdict(todayRow, hrvBaseline(rows, today));
}

function loadWellness(
  deps: TodayDeps,
  userId: string,
  date: string,
  today: string
): Promise<WellnessDay[] | null> {
  if (date !== today) return Promise.resolve(null);
  return deps.reads.findWellness(userId, addDaysIso(today, -HRV_BASELINE_DAYS), today);
}

/**
 * What the Today view shows for one local day, read from the persisted PlannedSession rows
 * (never regenerated): the day's sessions with their matched activities, a rest day, or
 * "no plan yet" when the athlete has no active season and no stored sessions around that day.
 * Reads only.
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

  const [around, activeSeason, wellness] = await Promise.all([
    deps.reads.findSessions(
      userId,
      addDaysIso(date, -PLAN_LOOKAROUND_DAYS),
      addDaysIso(date, PLAN_LOOKAROUND_DAYS)
    ),
    deps.reads.hasActiveSeason(userId),
    loadWellness(deps, userId, date, today),
  ]);
  const context: DayContext = {
    date,
    today,
    timezone,
    readiness: wellness ? readinessFor(wellness, today) : null,
  };
  const sessions = around.filter((s) => s.date === date && s.sport !== Sport.rest);
  if (sessions.length > 0) return { kind: 'sessions', sessions, ...context };
  if (activeSeason || around.length > 0) return { kind: 'rest', ...context };
  return { kind: 'no_plan', ...context };
}

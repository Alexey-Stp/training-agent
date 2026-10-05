import { localToday } from '@triathlon/core';
import type { PlanStoreRepo } from './plan-store';
import { MSG_NO_PROFILE } from './profile';
import { formatDayHeader, formatSession, syncStatusLabel } from './session-format';

export interface PlanTodayDeps {
  repo: Pick<PlanStoreRepo, 'listWindow'>;
  now(): Date;
}

export const MSG_NOTHING_STORED_TODAY =
  'Nothing planned for today yet. Send /plan for this week’s plan.';

/** `/plan today`: today's stored sessions (athlete-local) with their intervals.icu status. */
export async function handlePlanToday(
  user: { id: string; profile: { timezone: string } | null },
  deps: PlanTodayDeps
): Promise<string> {
  if (!user.profile) return MSG_NO_PROFILE;
  const today = localToday(deps.now(), user.profile.timezone);
  const rows = (await deps.repo.listWindow(user.id, today, today)).filter(
    (r) => r.deletedAt === null
  );
  if (rows.length === 0) return MSG_NOTHING_STORED_TODAY;
  const sessions = rows.map((r) => formatSession(r, syncStatusLabel(r)));
  return ['📅 Today', formatDayHeader(today), ...sessions].join('');
}

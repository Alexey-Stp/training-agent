import { format } from 'date-fns';
import { SecretDecryptError } from '@triathlon/core';
import type { PlannedSessionDraft } from '@triathlon/core';
import { IcuAuthError, IcuRateLimitError, IcuServerError } from '@triathlon/integrations-icu';
import { MSG_NOT_CONNECTED } from './icu-connect';
import { pushPlannedSessions, type PlanPushDeps } from './plan-push';
import { materializePlan, planWindowEnd, type PlanStoreDeps } from './plan-store';
import { MSG_SYNC_AUTH_FAILED } from './sync-command';

export const MSG_PUSH_UNAVAILABLE =
  '⚠️ intervals.icu is not responding right now. Your plan is saved, please try /plan push again later.';

export interface PlanPushCommandDeps {
  store: PlanStoreDeps;
  push: PlanPushDeps;
}

function dayLabel(date: string): string {
  return format(new Date(`${date}T00:00:00`), 'EEE MMM d');
}

/**
 * `/plan push`: stores the regenerated week (window starting `today`) and pushes it to the
 * intervals.icu calendar. Sessions the athlete changed in ICU are kept and listed.
 */
export async function handlePlanPush(
  userId: string,
  today: string,
  drafts: PlannedSessionDraft[],
  deps: PlanPushCommandDeps
): Promise<string> {
  await materializePlan(userId, today, drafts, deps.store);

  let result;
  try {
    result = await pushPlannedSessions(userId, today, deps.push);
  } catch (error) {
    if (error instanceof IcuAuthError || error instanceof SecretDecryptError) {
      return MSG_SYNC_AUTH_FAILED;
    }
    if (error instanceof IcuRateLimitError || error instanceof IcuServerError) {
      return MSG_PUSH_UNAVAILABLE;
    }
    throw error;
  }
  if (result.status === 'not_connected') return MSG_NOT_CONNECTED;

  const { created, updated, deleted, keptExternal } = result;
  const range = `${today} → ${planWindowEnd(today)}`;
  const lines =
    created + updated + deleted === 0
      ? [`✅ intervals.icu calendar is already up to date (${range})`]
      : [
          `✅ Pushed your plan to intervals.icu (${range})`,
          `📅 ${created} new, ${updated} updated, ${deleted} removed`,
        ];

  if (keptExternal.length > 0) {
    lines.push('', '⚠️ Changed in intervals.icu, kept as you left them:');
    for (const s of keptExternal) {
      lines.push(`• ${dayLabel(s.date)} ${s.title}: ${s.externalChange ?? 'edited'}`);
    }
  }
  return lines.join('\n');
}

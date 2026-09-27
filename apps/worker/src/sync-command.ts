import { SecretDecryptError } from '@triathlon/core';
import { IcuAuthError, IcuRateLimitError, IcuServerError } from '@triathlon/integrations-icu';
import { syncActivities, type ActivitySyncDeps } from './activity-sync';
import { syncWellness, type WellnessSyncDeps } from './wellness-sync';
import { MSG_NOT_CONNECTED } from './icu-connect';

export const MSG_SYNC_AUTH_FAILED =
  '❌ intervals.icu rejected the stored API key. Run /connect icu to link your account again.';
export const MSG_SYNC_UNAVAILABLE =
  '⚠️ intervals.icu is not responding right now. Please try /sync again later. The automatic sync will keep retrying.';

export interface SyncCommandDeps {
  activity: ActivitySyncDeps;
  wellness: WellnessSyncDeps;
}

/**
 * `/sync` command: pulls activities, then wellness, and replies with a summary.
 * Each sync commits its own cursor, so a failure in the second step keeps the first one's rows.
 */
export async function handleSync(userId: string, deps: SyncCommandDeps): Promise<string> {
  try {
    const activities = await syncActivities(userId, deps.activity);
    if (activities.status === 'not_connected') return MSG_NOT_CONNECTED;

    const wellness = await syncWellness(userId, deps.wellness);
    if (wellness.status === 'not_connected') return MSG_NOT_CONNECTED;

    return [
      '✅ Synced intervals.icu',
      `🏃 Activities: ${activities.created} new, ${activities.updated} updated, ${activities.unchanged} unchanged (${activities.oldest} → ${activities.newest})`,
      `💤 Wellness: ${wellness.created} new, ${wellness.updated} updated, ${wellness.unchanged} unchanged (${wellness.oldest} → ${wellness.newest})`,
    ].join('\n');
  } catch (error) {
    if (error instanceof IcuAuthError || error instanceof SecretDecryptError) {
      return MSG_SYNC_AUTH_FAILED;
    }
    if (error instanceof IcuRateLimitError || error instanceof IcuServerError) {
      return MSG_SYNC_UNAVAILABLE;
    }
    throw error;
  }
}

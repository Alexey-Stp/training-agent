import { decryptSecret } from '@triathlon/core';
import type { IcuSyncJob } from '@triathlon/core';
import type { IcuClient, IcuEvent } from '@triathlon/integrations-icu';
import { runIcuSyncJob } from './activity-sync';
import type { IcuConnectionRecord } from './icu-connect';
import { hashIcuEvent, isNotFound, REASON_DELETED_IN_ICU, type PlanPushRepo } from './plan-push';
import { dateRange, type PlannedSessionRecord } from './plan-store';

export const REASON_EDITED_IN_ICU = 'edited in intervals.icu';

export interface PlanReconcileRepo {
  findConnection(userId: string): Promise<IcuConnectionRecord | null>;
  /** Pushed, non-tombstoned sessions with an ICU event, dated on/after `fromDate`. */
  listPushed(userId: string, fromDate: string): Promise<PlannedSessionRecord[]>;
  flagExternal: PlanPushRepo['flagExternal'];
}

export interface PlanReconcileDeps {
  repo: PlanReconcileRepo;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): Pick<IcuClient, 'listEvents' | 'getEvent'>;
  now(): Date;
}

export type PlanReconcileResult =
  { status: 'not_connected' } | { status: 'ok'; checked: number; flagged: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why the ICU event no longer matches what we pushed, or null if it still does. */
export function describeExternalChange(
  row: PlannedSessionRecord,
  event: IcuEvent | null
): string | null {
  if (!event) return REASON_DELETED_IN_ICU;
  if (hashIcuEvent(event) === row.pushedHash) return null;
  const date = event.start_date_local.slice(0, 10);
  return date !== row.date ? `moved to ${date}` : REASON_EDITED_IN_ICU;
}

/**
 * Compares every upcoming pushed session with its ICU event and flags the ones the athlete
 * moved, edited or deleted as modified_externally. ICU/DB errors are thrown.
 */
export async function reconcilePlannedSessions(
  userId: string,
  deps: PlanReconcileDeps
): Promise<PlanReconcileResult> {
  const conn = await deps.repo.findConnection(userId);
  if (!conn) return { status: 'not_connected' };

  // UTC yesterday: the athlete's "today" may still be yesterday in UTC terms
  const fromDate = new Date(deps.now().getTime() - DAY_MS).toISOString().slice(0, 10);
  const rows = await deps.repo.listPushed(userId, fromDate);
  if (rows.length === 0) return { status: 'ok', checked: 0, flagged: 0 };

  const apiKey = decryptSecret({ ciphertext: conn.apiKeyCiphertext, iv: conn.apiKeyIv }, deps.keys);
  const client = deps.createClient(conn.icuAthleteId, apiKey);

  const events = await client.listEvents(...dateRange(rows));
  const byId = new Map(events.map((e) => [e.id, e]));

  let flagged = 0;
  for (const row of rows) {
    const eventId = row.icuEventId as number;
    // Not in the range: moved out of it, or deleted
    let event = byId.get(eventId) ?? null;
    if (!event) {
      try {
        event = await client.getEvent(eventId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const reason = describeExternalChange(row, event);
    if (reason && (await deps.repo.flagExternal(row.id, row.pushedHash, reason))) flagged++;
  }

  return { status: 'ok', checked: rows.length, flagged };
}

/** `icu-plan-reconcile` job processor. */
export function processPlanReconcileJob(
  data: IcuSyncJob,
  deps: PlanReconcileDeps
): Promise<PlanReconcileResult> {
  return runIcuSyncJob(() => reconcilePlannedSessions(data.userId, deps));
}

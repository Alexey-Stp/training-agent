import { createHash } from 'node:crypto';
import { decryptSecret, renderIcuWorkout, Sport } from '@triathlon/core';
import { IcuHttpError } from '@triathlon/integrations-icu';
import type { CreateEventInput, IcuClient, IcuEvent } from '@triathlon/integrations-icu';
import type { IcuConnectionRecord } from './icu-connect';
import type { PlannedSessionRecord } from './plan-store';

export const REASON_DELETED_IN_ICU = 'deleted in intervals.icu';

export interface MarkPushedInput {
  icuEventId: number;
  pushedHash: string;
  pushedAt: Date;
}

export interface PlanPushRepo {
  findConnection(userId: string): Promise<IcuConnectionRecord | null>;
  /** Rows dated on/after `fromDate` that need a push: tombstoned, or status draft. */
  listPending(userId: string, fromDate: string): Promise<PlannedSessionRecord[]>;
  /**
   * Stores the event id and marks the row pushed. If the row changed since it was read
   * (a concurrent /plan), only the event id is stored and the row stays draft.
   */
  markPushed(row: PlannedSessionRecord, input: MarkPushedInput): Promise<void>;
  /** Removes a tombstoned row after its ICU event is gone (if it was revived meanwhile, drops its event id). */
  remove(row: PlannedSessionRecord): Promise<void>;
  /**
   * Flags the row modified_externally, unless its pushedHash is no longer `expectedHash`
   * (a push rewrote the event meanwhile). Returns true if the row was flagged.
   */
  flagExternal(id: string, expectedHash: string | null, reason: string): Promise<boolean>;
  /** Flagged sessions dated on/after `fromDate`. */
  listModifiedExternally(userId: string, fromDate: string): Promise<PlannedSessionRecord[]>;
}

export type PlanPushClient = Pick<
  IcuClient,
  'listEvents' | 'createEvent' | 'updateEvent' | 'deleteEvent'
>;

export interface PlanPushDeps {
  repo: PlanPushRepo;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): PlanPushClient;
  now(): Date;
}

export type PlanPushResult =
  | { status: 'not_connected' }
  | {
      status: 'ok';
      created: number;
      updated: number;
      deleted: number;
      /** Sessions the athlete changed in ICU. Push leaves them alone. */
      keptExternal: PlannedSessionRecord[];
    };

const ICU_TYPE_BY_SPORT: Record<Sport, string> = {
  [Sport.bike]: 'Ride',
  [Sport.run]: 'Run',
  [Sport.swim]: 'Swim',
  [Sport.strength]: 'WeightTraining',
  [Sport.rest]: 'Workout',
  [Sport.other]: 'Workout',
};

/** external_id of our events: lets a retry find an event whose id was never stored. */
export function externalIdFor(sessionId: string): string {
  return `ta-${sessionId}`;
}

/** WORKOUT event body. The description holds the coach notes and the structured workout text. */
export function toIcuEvent(session: PlannedSessionRecord): CreateEventInput {
  const workout = renderIcuWorkout(session.steps, session.sport);
  return {
    category: 'WORKOUT',
    start_date_local: `${session.date}T00:00:00`,
    name: session.title,
    type: ICU_TYPE_BY_SPORT[session.sport],
    description: session.description ? `${session.description}\n\n${workout}` : workout,
    moving_time: session.durationMin * 60,
    external_id: externalIdFor(session.id),
  };
}

function normalizeDescription(description: string | null | undefined): string {
  return (description ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Content hash of an ICU event: the fields an athlete can change on the calendar (date,
 * name, sport, description). Push stores it from ICU's response, reconcile compares it.
 */
export function hashIcuEvent(
  event: Pick<IcuEvent, 'start_date_local' | 'name' | 'type' | 'description'>
): string {
  const content = [
    event.start_date_local.slice(0, 10),
    event.name,
    event.type ?? null,
    normalizeDescription(event.description),
  ];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function isNotFound(error: unknown): boolean {
  return error instanceof IcuHttpError && error.status === 404;
}

/**
 * Pushes pending sessions (from `today`, athlete-local) to the ICU calendar: creates
 * events for new sessions, updates the stored event for changed ones and deletes events of
 * tombstoned ones. Every row is saved right after its ICU call, so a retry only redoes
 * what is left. ICU/DB errors are thrown.
 */
export async function pushPlannedSessions(
  userId: string,
  today: string,
  deps: PlanPushDeps
): Promise<PlanPushResult> {
  const conn = await deps.repo.findConnection(userId);
  if (!conn) return { status: 'not_connected' };

  const pending = await deps.repo.listPending(userId, today);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const flagged: string[] = [];

  if (pending.length > 0) {
    const apiKey = decryptSecret(
      { ciphertext: conn.apiKeyCiphertext, iv: conn.apiKeyIv },
      deps.keys
    );
    const client = deps.createClient(conn.icuAthleteId, apiKey);

    const writes = pending.filter((row) => row.deletedAt === null);
    const eventIds = await adoptOrphanEvents(writes, client);

    for (const row of writes) {
      const body = toIcuEvent(row);
      const eventId = eventIds.get(row.id) ?? row.icuEventId;
      let event: IcuEvent;
      if (eventId === null) {
        event = await client.createEvent(body);
        created++;
      } else {
        try {
          event = await client.updateEvent(eventId, body);
          updated++;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          // The athlete deleted the event in ICU: their calendar wins
          if (await deps.repo.flagExternal(row.id, row.pushedHash, REASON_DELETED_IN_ICU)) {
            flagged.push(row.id);
          }
          continue;
        }
      }
      await deps.repo.markPushed(row, {
        icuEventId: event.id,
        pushedHash: hashIcuEvent(event),
        pushedAt: deps.now(),
      });
    }

    for (const row of pending.filter((r) => r.deletedAt !== null)) {
      if (row.icuEventId !== null) {
        try {
          await client.deleteEvent(row.icuEventId);
        } catch (error) {
          if (!isNotFound(error)) throw error; // already gone in ICU
        }
      }
      await deps.repo.remove(row);
      deleted++;
    }
  }

  const keptExternal = await deps.repo.listModifiedExternally(userId, today);
  return { status: 'ok', created, updated, deleted, keptExternal };
}

/**
 * Finds events we created whose id was never stored (crash between createEvent and the
 * DB write) by their external_id, so the retry updates them instead of duplicating.
 */
async function adoptOrphanEvents(
  writes: PlannedSessionRecord[],
  client: PlanPushClient
): Promise<Map<string, number>> {
  const adopted = new Map<string, number>();
  const unlinked = writes.filter((row) => row.icuEventId === null);
  if (unlinked.length === 0) return adopted;

  const dates = unlinked.map((row) => row.date).sort((a, b) => a.localeCompare(b));
  const events = await client.listEvents(dates[0], dates[dates.length - 1]);
  const byExternalId = new Map(
    events.filter((e) => e.external_id).map((e) => [e.external_id as string, e.id])
  );
  for (const row of unlinked) {
    const eventId = byExternalId.get(externalIdFor(row.id));
    if (eventId !== undefined) adopted.set(row.id, eventId);
  }
  return adopted;
}

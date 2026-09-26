import { UnrecoverableError } from 'bullmq';
import { decryptSecret, SecretDecryptError, Sport } from '@triathlon/core';
import type { IcuSyncJob } from '@triathlon/core';
import { IcuAuthError, IcuRateLimitError, IcuServerError } from '@triathlon/integrations-icu';
import type { Activity as IcuActivity, IcuClient } from '@triathlon/integrations-icu';
import { MSG_NOT_CONNECTED, type IcuConnectionRecord } from './icu-connect';

/** Local Activity row as written by the sync (DB-managed id/createdAt/updatedAt excluded). */
export interface ActivityData {
  icuId: string;
  userId: string;
  sport: Sport;
  icuType: string;
  name: string;
  startTime: Date;
  startDateLocal: string;
  durationSec: number;
  distanceM: number | null;
  load: number | null;
  avgHr: number | null;
  avgPower: number | null;
  source: string | null;
}

export interface ApplySyncInput {
  userId: string;
  creates: ActivityData[];
  updates: ActivityData[];
  /** New lastActivitySyncAt, written in the same transaction as the rows. */
  cursor: Date;
}

export interface ActivityRepo {
  findConnection(userId: string): Promise<IcuConnectionRecord | null>;
  /** Existing activities of this user with the given ICU ids. */
  findByIcuIds(userId: string, icuIds: string[]): Promise<ActivityData[]>;
  /** Writes creates + updates and advances the cursor atomically. Returns the number of rows created. */
  applySync(input: ApplySyncInput): Promise<{ created: number }>;
  listConnectedUserIds(): Promise<string[]>;
}

export interface ActivitySyncDeps {
  repo: ActivityRepo;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): Pick<IcuClient, 'listActivities'>;
  now(): Date;
  /** Days to pull on the first sync (no cursor yet). */
  backfillDays: number;
  /** Days re-read before the cursor on incremental syncs, to catch late uploads and edits. */
  overlapDays: number;
}

export type SyncResult =
  | { status: 'not_connected' }
  | {
      status: 'ok';
      created: number;
      updated: number;
      unchanged: number;
      oldest: string;
      newest: string;
    };

export const MSG_SYNC_AUTH_FAILED =
  '❌ intervals.icu rejected the stored API key. Run /connect icu to link your account again.';
export const MSG_SYNC_UNAVAILABLE =
  '⚠️ intervals.icu is not responding right now. Please try /sync again later. The automatic sync will keep retrying.';

const SPORT_BY_ICU_TYPE: Record<string, Sport> = {
  Ride: Sport.bike,
  VirtualRide: Sport.bike,
  GravelRide: Sport.bike,
  MountainBikeRide: Sport.bike,
  EBikeRide: Sport.bike,
  EMountainBikeRide: Sport.bike,
  TrackRide: Sport.bike,
  Velomobile: Sport.bike,
  Handcycle: Sport.bike,
  Run: Sport.run,
  VirtualRun: Sport.run,
  TrailRun: Sport.run,
  Swim: Sport.swim,
  OpenWaterSwim: Sport.swim,
  WeightTraining: Sport.strength,
};

export function mapIcuSport(icuType: string): Sport {
  return Object.hasOwn(SPORT_BY_ICU_TYPE, icuType) ? SPORT_BY_ICU_TYPE[icuType] : Sport.other;
}

function roundOrNull(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

/** ICU timestamps without an offset are parsed as UTC, not in the server's local zone. */
function parseUtc(timestamp: string): Date {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(timestamp);
  const date = new Date(hasOffset ? timestamp : `${timestamp}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ICU activity timestamp: ${timestamp}`);
  }
  return date;
}

export function mapIcuActivity(a: IcuActivity, userId: string): ActivityData {
  return {
    icuId: a.id,
    userId,
    sport: mapIcuSport(a.type),
    icuType: a.type,
    name: a.name,
    startTime: parseUtc(a.start_date ?? a.start_date_local),
    startDateLocal: a.start_date_local.slice(0, 10),
    durationSec: Math.round(a.moving_time ?? a.elapsed_time ?? 0),
    distanceM: a.distance ?? null,
    load: roundOrNull(a.icu_training_load),
    avgHr: roundOrNull(a.average_heartrate),
    avgPower: roundOrNull(a.icu_average_watts ?? a.average_watts),
    source: a.source ?? null,
  };
}

function isSameActivity(a: ActivityData, b: ActivityData): boolean {
  return (
    a.sport === b.sport &&
    a.icuType === b.icuType &&
    a.name === b.name &&
    a.startTime.getTime() === b.startTime.getTime() &&
    a.startDateLocal === b.startDateLocal &&
    a.durationSec === b.durationSec &&
    a.distanceM === b.distanceM &&
    a.load === b.load &&
    a.avgHr === b.avgHr &&
    a.avgPower === b.avgPower &&
    a.source === b.source
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(date: Date, offsetDays = 0): string {
  return new Date(date.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Fetch window as ICU `yyyy-MM-dd` dates (UTC). First sync: `backfillDays` back.
 * Incremental: from the cursor minus `overlapDays`. `newest` is tomorrow so no timezone is cut off.
 */
export function computeWindow(
  cursor: Date | null,
  now: Date,
  cfg: Pick<ActivitySyncDeps, 'backfillDays' | 'overlapDays'>
): { oldest: string; newest: string } {
  const oldest = cursor ? utcDate(cursor, -cfg.overlapDays) : utcDate(now, -cfg.backfillDays);
  return { oldest, newest: utcDate(now, 1) };
}

/**
 * Pulls the user's ICU activities in the sync window and upserts them by icuId.
 * Unchanged rows are not touched, so a repeated run modifies nothing. The cursor
 * only advances when the fetch and all writes succeed. ICU/DB errors are thrown.
 */
export async function syncActivities(userId: string, deps: ActivitySyncDeps): Promise<SyncResult> {
  const conn = await deps.repo.findConnection(userId);
  if (!conn) return { status: 'not_connected' };

  // Captured before the fetch so activities uploaded during the sync are re-read next time
  const startedAt = deps.now();
  const { oldest, newest } = computeWindow(conn.lastActivitySyncAt, startedAt, deps);

  const apiKey = decryptSecret({ ciphertext: conn.apiKeyCiphertext, iv: conn.apiKeyIv }, deps.keys);
  const icuActivities = await deps
    .createClient(conn.icuAthleteId, apiKey)
    .listActivities(oldest, newest);

  // ICU may list an activity twice across pages/edits: last one wins
  const incoming = new Map<string, ActivityData>();
  for (const a of icuActivities) incoming.set(a.id, mapIcuActivity(a, userId));

  const existing = new Map(
    (await deps.repo.findByIcuIds(userId, [...incoming.keys()])).map((row) => [row.icuId, row])
  );

  const creates: ActivityData[] = [];
  const updates: ActivityData[] = [];
  for (const row of incoming.values()) {
    const prev = existing.get(row.icuId);
    if (!prev) creates.push(row);
    else if (!isSameActivity(prev, row)) updates.push(row);
  }

  const { created } = await deps.repo.applySync({ userId, creates, updates, cursor: startedAt });

  return {
    status: 'ok',
    created,
    updated: updates.length,
    unchanged: incoming.size - creates.length - updates.length,
    oldest,
    newest,
  };
}

/** `/sync` command: runs a sync now and replies with a summary. */
export async function handleSync(userId: string, deps: ActivitySyncDeps): Promise<string> {
  let result: SyncResult;
  try {
    result = await syncActivities(userId, deps);
  } catch (error) {
    if (error instanceof IcuAuthError || error instanceof SecretDecryptError) {
      return MSG_SYNC_AUTH_FAILED;
    }
    if (error instanceof IcuRateLimitError || error instanceof IcuServerError) {
      return MSG_SYNC_UNAVAILABLE;
    }
    throw error;
  }

  if (result.status === 'not_connected') return MSG_NOT_CONNECTED;

  return `✅ Synced intervals.icu activities: ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged (${result.oldest} → ${result.newest}).`;
}

/**
 * `icu-sync` queue processor. Transient errors are rethrown so BullMQ retries;
 * a rejected or unreadable API key won't fix itself, so it fails without retry.
 */
export async function processSyncJob(
  data: IcuSyncJob,
  deps: ActivitySyncDeps
): Promise<SyncResult> {
  try {
    return await syncActivities(data.userId, deps);
  } catch (error) {
    if (error instanceof IcuAuthError) {
      throw new UnrecoverableError('intervals.icu rejected the stored API key');
    }
    if (error instanceof SecretDecryptError) {
      throw new UnrecoverableError('Stored intervals.icu API key could not be decrypted');
    }
    throw error;
  }
}

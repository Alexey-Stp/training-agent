import { decryptSecret } from '@triathlon/core';
import type { IcuSyncJob } from '@triathlon/core';
import type { IcuClient, Wellness as IcuWellness } from '@triathlon/integrations-icu';
import { computeWindow, runIcuSyncJob } from './activity-sync';
import type { IcuConnectionRecord } from './icu-connect';

/**
 * Device / ICU-derived columns of a Wellness row: the only columns the sync writes.
 * Subjective check-in columns (subjectiveReadiness, soreness) are deliberately absent.
 */
export const WELLNESS_DEVICE_FIELDS = [
  'hrv',
  'restingHr',
  'sleepHours',
  'sleepScore',
  'weightKg',
  'ctl',
  'atl',
  'tsb',
] as const;

export type WellnessDeviceField = (typeof WELLNESS_DEVICE_FIELDS)[number];

/** A Wellness row as written by the sync. */
export type WellnessDeviceData = { userId: string; date: string } & Record<
  WellnessDeviceField,
  number | null
>;

export interface ApplyWellnessSyncInput {
  userId: string;
  /** New or changed days. Upserted by (userId, date), writing device fields only. */
  upserts: WellnessDeviceData[];
  /** New lastWellnessSyncAt, written in the same transaction as the rows. */
  cursor: Date;
}

export interface WellnessRepo {
  findConnection(userId: string): Promise<IcuConnectionRecord | null>;
  /** Device fields of this user's existing Wellness rows on the given dates. */
  findByDates(userId: string, dates: string[]): Promise<WellnessDeviceData[]>;
  /** Upserts the rows and advances the cursor atomically. */
  applySync(input: ApplyWellnessSyncInput): Promise<void>;
}

export interface WellnessSyncDeps {
  repo: WellnessRepo;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): Pick<IcuClient, 'listWellness'>;
  now(): Date;
  /** Days to pull on the first sync (no cursor yet). */
  backfillDays: number;
  /** Days re-read before the cursor: ICU recomputes CTL/ATL when late activities arrive. */
  overlapDays: number;
}

export type WellnessSyncResult =
  | { status: 'not_connected' }
  | {
      status: 'ok';
      created: number;
      updated: number;
      unchanged: number;
      oldest: string;
      newest: string;
    };

function roundOrNull(value: number | null | undefined, decimals = 0): number | null {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Maps an ICU wellness day. Missing metrics (no strap, no scale) become null. */
export function mapIcuWellness(w: IcuWellness, userId: string): WellnessDeviceData {
  const ctl = w.ctl ?? null;
  const atl = w.atl ?? null;
  return {
    userId,
    date: w.id,
    hrv: w.hrv ?? null,
    restingHr: roundOrNull(w.restingHR),
    sleepHours: w.sleepSecs == null ? null : roundOrNull(w.sleepSecs / 3600, 2),
    sleepScore: roundOrNull(w.sleepScore),
    weightKg: w.weight ?? null,
    ctl,
    atl,
    tsb: ctl != null && atl != null ? roundOrNull(ctl - atl, 2) : null,
  };
}

function isSameWellness(a: WellnessDeviceData, b: WellnessDeviceData): boolean {
  return WELLNESS_DEVICE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Pulls the user's ICU wellness days in the sync window and upserts them by date.
 * Device fields are overwritten (nulls included), subjective check-in fields are never
 * touched, and unchanged days are not written. The cursor only advances when the fetch
 * and all writes succeed. ICU/DB errors are thrown.
 */
export async function syncWellness(
  userId: string,
  deps: WellnessSyncDeps
): Promise<WellnessSyncResult> {
  const conn = await deps.repo.findConnection(userId);
  if (!conn) return { status: 'not_connected' };

  const startedAt = deps.now();
  const { oldest, newest } = computeWindow(conn.lastWellnessSyncAt, startedAt, deps);

  const apiKey = decryptSecret({ ciphertext: conn.apiKeyCiphertext, iv: conn.apiKeyIv }, deps.keys);
  const icuDays = await deps.createClient(conn.icuAthleteId, apiKey).listWellness(oldest, newest);

  // One row per date: last one wins
  const incoming = new Map<string, WellnessDeviceData>();
  for (const w of icuDays) incoming.set(w.id, mapIcuWellness(w, userId));

  const existing = new Map(
    (await deps.repo.findByDates(userId, [...incoming.keys()])).map((row) => [row.date, row])
  );

  const upserts: WellnessDeviceData[] = [];
  let created = 0;
  for (const row of incoming.values()) {
    const prev = existing.get(row.date);
    if (!prev) created++;
    if (!prev || !isSameWellness(prev, row)) upserts.push(row);
  }

  await deps.repo.applySync({ userId, upserts, cursor: startedAt });

  return {
    status: 'ok',
    created,
    updated: upserts.length - created,
    unchanged: incoming.size - upserts.length,
    oldest,
    newest,
  };
}

/** `icu-wellness-sync` job processor. */
export function processWellnessSyncJob(
  data: IcuSyncJob,
  deps: WellnessSyncDeps
): Promise<WellnessSyncResult> {
  return runIcuSyncJob(() => syncWellness(data.userId, deps));
}

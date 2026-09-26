import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { encryptSecret, Sport } from '@triathlon/core';
import {
  ActivityListSchema,
  IcuAuthError,
  IcuServerError,
  type ActivityList,
} from '@triathlon/integrations-icu';
import {
  computeWindow,
  handleSync,
  mapIcuSport,
  processSyncJob,
  syncActivities,
  MSG_SYNC_AUTH_FAILED,
  MSG_SYNC_UNAVAILABLE,
  type ActivityData,
  type ActivityRepo,
  type ActivitySyncDeps,
  type ApplySyncInput,
} from '../src/activity-sync';
import { MSG_NOT_CONNECTED, type IcuConnectionRecord } from '../src/icu-connect';
import fixture from './fixtures/icu-activities-90d.json';

const USER_ID = 'user-1';
const KEY = randomBytes(32);
const API_KEY = 'secret-icu-api-key-123456';
const NOW = new Date('2026-09-26T10:00:00Z');

const FIXTURE: ActivityList = ActivityListSchema.parse(fixture);

interface StoredActivity extends ActivityData {
  createdAt: Date;
  updatedAt: Date;
}

/** In-memory ActivityRepo. applySync is all-or-nothing like the Prisma transaction. */
class MemoryActivityRepo implements ActivityRepo {
  readonly rows = new Map<string, StoredActivity>();
  connection: IcuConnectionRecord | null;
  failNextApply = false;
  private clock = 0;

  constructor() {
    const enc = encryptSecret(API_KEY, KEY);
    this.connection = {
      userId: USER_ID,
      icuAthleteId: 'i12345',
      icuAthleteName: 'Jane Athlete',
      apiKeyCiphertext: enc.ciphertext,
      apiKeyIv: enc.iv,
      lastActivitySyncAt: null,
      lastWellnessSyncAt: null,
    };
  }

  findConnection(userId: string) {
    return Promise.resolve(this.connection?.userId === userId ? this.connection : null);
  }

  findByIcuIds(userId: string, icuIds: string[]) {
    return Promise.resolve(
      icuIds
        .map((id) => this.rows.get(id))
        .filter((row): row is StoredActivity => row?.userId === userId)
        .map(({ createdAt: _c, updatedAt: _u, ...data }) => ({ ...data }))
    );
  }

  applySync({ creates, updates, cursor }: ApplySyncInput) {
    if (this.failNextApply) {
      this.failNextApply = false;
      return Promise.reject(new Error('db connection lost'));
    }
    const stamp = () => new Date(++this.clock);
    let created = 0;
    for (const row of creates) {
      if (this.rows.has(row.icuId)) continue;
      const at = stamp();
      this.rows.set(row.icuId, { ...row, createdAt: at, updatedAt: at });
      created++;
    }
    for (const row of updates) {
      const prev = this.rows.get(row.icuId)!;
      this.rows.set(row.icuId, { ...row, createdAt: prev.createdAt, updatedAt: stamp() });
    }
    this.connection!.lastActivitySyncAt = cursor;
    return Promise.resolve({ created });
  }

  listConnectedUserIds() {
    return Promise.resolve(this.connection ? [this.connection.userId] : []);
  }

  snapshot() {
    return structuredClone([...this.rows.values()]);
  }
}

let repo: MemoryActivityRepo;
let icuData: ActivityList;
let listActivities: ReturnType<
  typeof vi.fn<(oldest: string, newest: string) => Promise<ActivityList>>
>;
let createClient: ReturnType<typeof vi.fn>;
let now: Date;
let deps: ActivitySyncDeps;

beforeEach(() => {
  repo = new MemoryActivityRepo();
  icuData = structuredClone(FIXTURE);
  now = NOW;
  listActivities = vi.fn(() => Promise.resolve(structuredClone(icuData)));
  createClient = vi.fn(() => ({ listActivities }));
  deps = {
    repo,
    keys: [KEY],
    createClient: createClient as unknown as ActivitySyncDeps['createClient'],
    now: () => now,
    backfillDays: 90,
    overlapDays: 2,
  };
});

describe('syncActivities: first sync (backfill)', () => {
  it('pulls 90 days and stores every activity with mapped fields', async () => {
    const result = await syncActivities(USER_ID, deps);

    expect(createClient).toHaveBeenCalledWith('i12345', API_KEY);
    expect(listActivities).toHaveBeenCalledWith('2026-06-28', '2026-09-27');
    expect(result).toEqual({
      status: 'ok',
      created: 6,
      updated: 0,
      unchanged: 0,
      oldest: '2026-06-28',
      newest: '2026-09-27',
    });
    expect(repo.rows.size).toBe(6);
    expect(repo.connection!.lastActivitySyncAt).toEqual(NOW);

    const { createdAt: _c, updatedAt: _u, ...ride } = repo.rows.get('i1001')!;
    expect(ride).toEqual({
      icuId: 'i1001',
      userId: USER_ID,
      sport: Sport.bike,
      icuType: 'Ride',
      name: 'Endurance Ride',
      startTime: new Date('2026-07-01T05:30:00Z'),
      startDateLocal: '2026-07-01',
      durationSec: 7200, // moving time wins over elapsed
      distanceM: 62000.5,
      load: 95,
      avgHr: 139,
      avgPower: 221, // icu_average_watts wins over average_watts
      source: 'GARMIN_CONNECT',
    });
  });

  it('handles sparse activities: fallbacks and nulls', async () => {
    await syncActivities(USER_ID, deps);

    const gym = repo.rows.get('i1005')!;
    expect(gym.sport).toBe(Sport.strength);
    expect(gym.durationSec).toBe(2700); // elapsed time fallback
    expect(gym.startTime).toEqual(new Date('2026-09-20T19:00:00Z')); // local time read as UTC
    expect(gym).toMatchObject({ distanceM: null, load: null, avgHr: null, avgPower: null });

    expect(repo.rows.get('i1002')!.avgPower).toBe(248); // average_watts fallback
    expect(repo.rows.get('i1006')!).toMatchObject({ sport: Sport.other, source: 'UPLOAD' });
  });
});

describe('syncActivities: incremental', () => {
  it('second run with the same data creates and modifies nothing', async () => {
    await syncActivities(USER_ID, deps);
    const before = repo.snapshot();

    now = new Date('2026-09-26T10:30:00Z');
    const result = await syncActivities(USER_ID, deps);

    expect(result).toMatchObject({ status: 'ok', created: 0, updated: 0, unchanged: 6 });
    expect(repo.snapshot()).toEqual(before);
    // Incremental window: cursor date minus the overlap
    expect(listActivities).toHaveBeenLastCalledWith('2026-09-24', '2026-09-27');
  });

  it('a new activity results in exactly one insert', async () => {
    await syncActivities(USER_ID, deps);
    icuData.push({
      id: 'i1007',
      start_date_local: '2026-09-26T07:00:00',
      start_date: '2026-09-26T05:00:00Z',
      type: 'TrailRun',
      name: 'Trail Run',
      moving_time: 3000,
    });

    const result = await syncActivities(USER_ID, deps);

    expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 6 });
    expect(repo.rows.size).toBe(7);
    expect(repo.rows.get('i1007')!.sport).toBe(Sport.run);
  });

  it('a changed activity results in exactly one update', async () => {
    await syncActivities(USER_ID, deps);
    const untouched = repo.rows.get('i1001')!.updatedAt;
    icuData.find((a) => a.id === 'i1003')!.icu_training_load = 41;

    const result = await syncActivities(USER_ID, deps);

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 5 });
    expect(repo.rows.get('i1003')!.load).toBe(41);
    expect(repo.rows.get('i1001')!.updatedAt).toEqual(untouched);
  });
});

describe('syncActivities: failure keeps the cursor', () => {
  it('ICU unreachable: throws, nothing written, next run re-fetches the same window', async () => {
    listActivities.mockRejectedValueOnce(new IcuServerError(503, 3));

    await expect(syncActivities(USER_ID, deps)).rejects.toBeInstanceOf(IcuServerError);
    expect(repo.connection!.lastActivitySyncAt).toBeNull();
    expect(repo.rows.size).toBe(0);

    now = new Date('2026-09-26T10:05:00Z');
    await syncActivities(USER_ID, deps);
    expect(listActivities).toHaveBeenLastCalledWith('2026-06-28', '2026-09-27');
    expect(repo.rows.size).toBe(6);
  });

  it('write failure after fetch: cursor unchanged, incremental window retried', async () => {
    await syncActivities(USER_ID, deps);
    const cursor = repo.connection!.lastActivitySyncAt;

    now = new Date('2026-09-28T10:00:00Z');
    repo.failNextApply = true;
    await expect(syncActivities(USER_ID, deps)).rejects.toThrow('db connection lost');
    expect(repo.connection!.lastActivitySyncAt).toEqual(cursor);

    await syncActivities(USER_ID, deps);
    expect(listActivities.mock.calls.at(-2)).toEqual(listActivities.mock.calls.at(-1));
    expect(listActivities).toHaveBeenLastCalledWith('2026-09-24', '2026-09-29');
    expect(repo.connection!.lastActivitySyncAt).toEqual(now);
  });

  it('not connected: no ICU call', async () => {
    repo.connection = null;
    expect(await syncActivities(USER_ID, deps)).toEqual({ status: 'not_connected' });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('mapIcuSport', () => {
  it.each([
    ['Ride', Sport.bike],
    ['VirtualRide', Sport.bike],
    ['GravelRide', Sport.bike],
    ['MountainBikeRide', Sport.bike],
    ['Run', Sport.run],
    ['VirtualRun', Sport.run],
    ['TrailRun', Sport.run],
    ['Swim', Sport.swim],
    ['OpenWaterSwim', Sport.swim],
    ['WeightTraining', Sport.strength],
    ['Yoga', Sport.other],
    ['Rowing', Sport.other],
    ['', Sport.other],
    ['toString', Sport.other],
  ])('%s → %s', (icuType, sport) => {
    expect(mapIcuSport(icuType)).toBe(sport);
  });
});

describe('computeWindow', () => {
  it('first sync goes back backfillDays, newest is tomorrow', () => {
    expect(computeWindow(null, NOW, { backfillDays: 90, overlapDays: 2 })).toEqual({
      oldest: '2026-06-28',
      newest: '2026-09-27',
    });
  });

  it('incremental sync starts overlapDays before the cursor', () => {
    const cursor = new Date('2026-09-20T23:59:00Z');
    expect(computeWindow(cursor, NOW, { backfillDays: 90, overlapDays: 2 }).oldest).toBe(
      '2026-09-18'
    );
  });
});

describe('processSyncJob', () => {
  it('auth error fails without retry', async () => {
    listActivities.mockRejectedValueOnce(new IcuAuthError());
    await expect(processSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    );
    expect(repo.connection!.lastActivitySyncAt).toBeNull();
  });

  it('unreadable stored key fails without retry', async () => {
    deps.keys = [randomBytes(32)];
    await expect(processSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });

  it('transient errors are rethrown for BullMQ retry', async () => {
    listActivities.mockRejectedValueOnce(new IcuServerError(502, 3));
    await expect(processSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(IcuServerError);
  });
});

describe('handleSync', () => {
  it('replies with a summary', async () => {
    const reply = await handleSync(USER_ID, deps);
    expect(reply).toContain('6 new, 0 updated, 0 unchanged');
    expect(reply).toContain('2026-06-28 → 2026-09-27');
  });

  it('not connected', async () => {
    repo.connection = null;
    expect(await handleSync(USER_ID, deps)).toBe(MSG_NOT_CONNECTED);
  });

  it('rejected key', async () => {
    listActivities.mockRejectedValueOnce(new IcuAuthError());
    expect(await handleSync(USER_ID, deps)).toBe(MSG_SYNC_AUTH_FAILED);
  });

  it('ICU unavailable', async () => {
    listActivities.mockRejectedValueOnce(new IcuServerError(503, 3));
    expect(await handleSync(USER_ID, deps)).toBe(MSG_SYNC_UNAVAILABLE);
    expect(repo.connection!.lastActivitySyncAt).toBeNull();
  });

  it('unexpected errors are rethrown', async () => {
    listActivities.mockRejectedValueOnce(new Error('network down'));
    await expect(handleSync(USER_ID, deps)).rejects.toThrow('network down');
  });
});

import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { encryptSecret } from '@triathlon/core';
import {
  WellnessListSchema,
  IcuAuthError,
  IcuServerError,
  type WellnessList,
} from '@triathlon/integrations-icu';
import {
  mapIcuWellness,
  processWellnessSyncJob,
  syncWellness,
  WELLNESS_DEVICE_FIELDS,
  type ApplyWellnessSyncInput,
  type WellnessDeviceData,
  type WellnessRepo,
  type WellnessSyncDeps,
} from '../src/wellness-sync';
import type { IcuConnectionRecord } from '../src/icu-connect';
import fixture from './fixtures/icu-wellness.json';

const USER_ID = 'user-1';
const KEY = randomBytes(32);
const API_KEY = 'secret-icu-api-key-123456';
const NOW = new Date('2026-09-26T10:00:00Z');

const FIXTURE: WellnessList = WellnessListSchema.parse(fixture);

/** Full Wellness row as the DB holds it: device fields plus the athlete's check-in. */
interface StoredWellness extends WellnessDeviceData {
  subjectiveReadiness: number | null;
  soreness: number | null;
  updatedAt: Date;
}

/**
 * In-memory WellnessRepo. applySync mirrors the Prisma upsert: all-or-nothing,
 * creates with null check-in fields, updates copy device fields only.
 */
class MemoryWellnessRepo implements WellnessRepo {
  readonly rows = new Map<string, StoredWellness>();
  connection: IcuConnectionRecord | null;
  failNextApply = false;
  applyCalls: ApplyWellnessSyncInput[] = [];
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

  findByDates(userId: string, dates: string[]) {
    return Promise.resolve(
      dates
        .map((date) => this.rows.get(date))
        .filter((row): row is StoredWellness => row?.userId === userId)
        .map((row) => {
          const device: WellnessDeviceData = { userId: row.userId, date: row.date } as never;
          for (const f of WELLNESS_DEVICE_FIELDS) device[f] = row[f];
          return device;
        })
    );
  }

  applySync(input: ApplyWellnessSyncInput) {
    this.applyCalls.push(structuredClone(input));
    if (this.failNextApply) {
      this.failNextApply = false;
      return Promise.reject(new Error('db connection lost'));
    }
    for (const row of input.upserts) {
      const prev = this.rows.get(row.date);
      const next: StoredWellness = prev
        ? { ...prev }
        : { ...row, subjectiveReadiness: null, soreness: null, updatedAt: new Date(0) };
      for (const f of WELLNESS_DEVICE_FIELDS) next[f] = row[f];
      next.updatedAt = new Date(++this.clock);
      this.rows.set(row.date, next);
    }
    this.connection!.lastWellnessSyncAt = input.cursor;
    return Promise.resolve();
  }

  /** An athlete check-in (the future daily-loop writer): subjective fields only. */
  checkIn(date: string, subjectiveReadiness: number, soreness: number) {
    const prev = this.rows.get(date);
    const empty = Object.fromEntries(WELLNESS_DEVICE_FIELDS.map((f) => [f, null]));
    this.rows.set(date, {
      ...(prev ?? ({ userId: USER_ID, date, ...empty } as unknown as StoredWellness)),
      subjectiveReadiness,
      soreness,
      updatedAt: new Date(++this.clock),
    });
  }

  snapshot() {
    return structuredClone([...this.rows.values()]);
  }
}

let repo: MemoryWellnessRepo;
let icuData: WellnessList;
let listWellness: ReturnType<
  typeof vi.fn<(oldest: string, newest: string) => Promise<WellnessList>>
>;
let createClient: ReturnType<typeof vi.fn>;
let now: Date;
let deps: WellnessSyncDeps;

beforeEach(() => {
  repo = new MemoryWellnessRepo();
  icuData = structuredClone(FIXTURE);
  now = NOW;
  listWellness = vi.fn(() => Promise.resolve(structuredClone(icuData)));
  createClient = vi.fn(() => ({ listWellness }));
  deps = {
    repo,
    keys: [KEY],
    createClient: createClient as unknown as WellnessSyncDeps['createClient'],
    now: () => now,
    backfillDays: 90,
    overlapDays: 3,
  };
});

function day(date: string) {
  return icuData.find((w) => w.id === date)!;
}

describe('syncWellness: first sync (backfill)', () => {
  it('yesterday with full metrics: every field mapped', async () => {
    const result = await syncWellness(USER_ID, deps);

    expect(createClient).toHaveBeenCalledWith('i12345', API_KEY);
    expect(listWellness).toHaveBeenCalledWith('2026-06-28', '2026-09-27');
    expect(result).toEqual({
      status: 'ok',
      created: 3,
      updated: 0,
      unchanged: 0,
      oldest: '2026-06-28',
      newest: '2026-09-27',
    });
    expect(repo.connection!.lastWellnessSyncAt).toEqual(NOW);

    const { updatedAt: _u, ...yesterday } = repo.rows.get('2026-09-25')!;
    expect(yesterday).toEqual({
      userId: USER_ID,
      date: '2026-09-25',
      hrv: 68.5, // rMSSD, not hrvSDNN
      restingHr: 47,
      sleepHours: 7.63, // 27480 s
      sleepScore: 86,
      weightKg: 70.2,
      ctl: 62.4,
      atl: 71.9,
      tsb: -9.5,
      // ICU's own readiness/soreness are not copied into the check-in fields
      subjectiveReadiness: null,
      soreness: null,
    });
  });

  it('day without an HRV strap: row saved, nulls preserved', async () => {
    await syncWellness(USER_ID, deps);

    expect(repo.rows.get('2026-09-24')).toMatchObject({
      hrv: null,
      restingHr: null,
      weightKg: null,
      sleepHours: 7,
      sleepScore: 74,
      ctl: 61.9,
      atl: 68.3,
      tsb: -6.4,
    });
    // Fields ICU omits entirely are null too
    expect(repo.rows.get('2026-09-23')).toMatchObject({
      hrv: null,
      restingHr: null,
      sleepHours: null,
      sleepScore: null,
      weightKg: null,
      tsb: -9.2,
    });
  });
});

describe('syncWellness: merge', () => {
  it('re-sync keeps the athlete check-in and updates device fields', async () => {
    await syncWellness(USER_ID, deps);
    repo.checkIn('2026-09-25', 2, 4);

    day('2026-09-25').hrv = 55;
    day('2026-09-25').atl = 74.1; // late activity: ICU recomputed fatigue
    now = new Date('2026-09-26T11:00:00Z');
    const result = await syncWellness(USER_ID, deps);

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect(repo.rows.get('2026-09-25')).toMatchObject({
      hrv: 55,
      atl: 74.1,
      tsb: -11.7,
      subjectiveReadiness: 2,
      soreness: 4,
    });
  });

  it('check-in before the first sync of that day: device fields filled, check-in kept', async () => {
    repo.checkIn('2026-09-25', 3, 1);

    const result = await syncWellness(USER_ID, deps);

    expect(result).toMatchObject({ created: 2, updated: 1 });
    expect(repo.rows.get('2026-09-25')).toMatchObject({
      hrv: 68.5,
      ctl: 62.4,
      subjectiveReadiness: 3,
      soreness: 1,
    });
  });

  it('device fields overwrite, including a value that became null', async () => {
    await syncWellness(USER_ID, deps);
    day('2026-09-25').weight = null;

    await syncWellness(USER_ID, deps);

    expect(repo.rows.get('2026-09-25')!.weightKg).toBeNull();
  });

  it('never sends check-in fields to the repo', async () => {
    repo.checkIn('2026-09-25', 1, 5);
    await syncWellness(USER_ID, deps);

    for (const row of repo.applyCalls.flatMap((c) => c.upserts)) {
      expect(Object.keys(row).sort()).toEqual(['date', 'userId', ...WELLNESS_DEVICE_FIELDS].sort());
    }
  });
});

describe('syncWellness: incremental', () => {
  it('second run with the same data writes nothing', async () => {
    await syncWellness(USER_ID, deps);
    const before = repo.snapshot();

    now = new Date('2026-09-27T10:00:00Z');
    const result = await syncWellness(USER_ID, deps);

    expect(result).toMatchObject({ status: 'ok', created: 0, updated: 0, unchanged: 3 });
    expect(repo.applyCalls.at(-1)!.upserts).toEqual([]);
    expect(repo.snapshot()).toEqual(before);
    // Cursor date minus the overlap and one timezone day
    expect(listWellness).toHaveBeenLastCalledWith('2026-09-22', '2026-09-28');
    expect(repo.connection!.lastWellnessSyncAt).toEqual(now);
  });

  it('a new day results in exactly one upsert', async () => {
    await syncWellness(USER_ID, deps);
    icuData.push({ id: '2026-09-26', ctl: 62.9, atl: 69.8, hrv: 72 });

    const result = await syncWellness(USER_ID, deps);

    expect(result).toMatchObject({ created: 1, updated: 0, unchanged: 3 });
    expect(repo.applyCalls.at(-1)!.upserts.map((r) => r.date)).toEqual(['2026-09-26']);
  });
});

describe('syncWellness: failures keep the cursor', () => {
  it('ICU unreachable: throws, nothing written', async () => {
    listWellness.mockRejectedValueOnce(new IcuServerError(503, 3));

    await expect(syncWellness(USER_ID, deps)).rejects.toBeInstanceOf(IcuServerError);
    expect(repo.connection!.lastWellnessSyncAt).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('write failure: cursor unchanged, same window retried', async () => {
    await syncWellness(USER_ID, deps);
    const cursor = repo.connection!.lastWellnessSyncAt;

    now = new Date('2026-09-28T10:00:00Z');
    day('2026-09-25').hrv = 60;
    repo.failNextApply = true;
    await expect(syncWellness(USER_ID, deps)).rejects.toThrow('db connection lost');
    expect(repo.connection!.lastWellnessSyncAt).toEqual(cursor);

    await syncWellness(USER_ID, deps);
    expect(listWellness.mock.calls.at(-2)).toEqual(listWellness.mock.calls.at(-1));
    expect(repo.rows.get('2026-09-25')!.hrv).toBe(60);
  });

  it('not connected: no ICU call', async () => {
    repo.connection = null;
    expect(await syncWellness(USER_ID, deps)).toEqual({ status: 'not_connected' });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('mapIcuWellness', () => {
  it('tsb needs both ctl and atl', () => {
    expect(mapIcuWellness({ id: '2026-09-01', ctl: 50 }, USER_ID).tsb).toBeNull();
    expect(mapIcuWellness({ id: '2026-09-01', ctl: 50.15, atl: 40.05 }, USER_ID).tsb).toBe(10.1);
  });

  it('rounds resting HR and sleep score to integers', () => {
    const row = mapIcuWellness({ id: '2026-09-01', restingHR: 46.6, sleepScore: 80.4 }, USER_ID);
    expect(row).toMatchObject({ restingHr: 47, sleepScore: 80 });
  });
});

describe('processWellnessSyncJob', () => {
  it('auth error fails without retry', async () => {
    listWellness.mockRejectedValueOnce(new IcuAuthError());
    await expect(processWellnessSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    );
    expect(repo.connection!.lastWellnessSyncAt).toBeNull();
  });

  it('unreadable stored key fails without retry', async () => {
    deps.keys = [randomBytes(32)];
    await expect(processWellnessSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });

  it('transient errors are rethrown for BullMQ retry', async () => {
    listWellness.mockRejectedValueOnce(new IcuServerError(502, 3));
    await expect(processWellnessSyncJob({ userId: USER_ID }, deps)).rejects.toBeInstanceOf(
      IcuServerError
    );
  });
});

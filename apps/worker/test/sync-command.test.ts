import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret } from '@triathlon/core';
import { IcuAuthError, IcuServerError } from '@triathlon/integrations-icu';
import type { ActivityList, WellnessList } from '@triathlon/integrations-icu';
import {
  handleSync,
  MSG_SYNC_AUTH_FAILED,
  MSG_SYNC_UNAVAILABLE,
  type SyncCommandDeps,
} from '../src/sync-command';
import type { ActivityRepo } from '../src/activity-sync';
import type { WellnessRepo } from '../src/wellness-sync';
import { MSG_NOT_CONNECTED, type IcuConnectionRecord } from '../src/icu-connect';

const USER_ID = 'user-1';
const KEY = randomBytes(32);
const NOW = new Date('2026-09-26T10:00:00Z');

let connection: IcuConnectionRecord | null;
let listActivities: ReturnType<typeof vi.fn<() => Promise<ActivityList>>>;
let listWellness: ReturnType<typeof vi.fn<() => Promise<WellnessList>>>;
let wellnessApply: ReturnType<typeof vi.fn>;
let deps: SyncCommandDeps;

beforeEach(() => {
  const enc = encryptSecret('secret-icu-api-key-123456', KEY);
  connection = {
    userId: USER_ID,
    icuAthleteId: 'i12345',
    icuAthleteName: 'Jane Athlete',
    apiKeyCiphertext: enc.ciphertext,
    apiKeyIv: enc.iv,
    lastActivitySyncAt: null,
    lastWellnessSyncAt: null,
  };
  listActivities = vi.fn(() =>
    Promise.resolve([
      { id: 'i1', start_date_local: '2026-09-25T07:00:00', type: 'Run', name: 'Run' },
    ])
  );
  listWellness = vi.fn(() =>
    Promise.resolve([
      { id: '2026-09-24', ctl: 60, atl: 65 },
      { id: '2026-09-25', ctl: 61, atl: 66, hrv: 70 },
    ])
  );
  wellnessApply = vi.fn(() => Promise.resolve());

  const activityRepo: ActivityRepo = {
    findConnection: () => Promise.resolve(connection),
    findByIcuIds: () => Promise.resolve([]),
    applySync: ({ creates }) => Promise.resolve({ created: creates.length }),
    listConnectedUserIds: () => Promise.resolve([USER_ID]),
  };
  const wellnessRepo: WellnessRepo = {
    findConnection: () => Promise.resolve(connection),
    findByDates: () => Promise.resolve([]),
    applySync: wellnessApply as unknown as WellnessRepo['applySync'],
  };
  const common = { keys: [KEY], now: () => NOW, backfillDays: 90 };
  deps = {
    activity: {
      ...common,
      repo: activityRepo,
      overlapDays: 2,
      createClient: () => ({ listActivities }),
    },
    wellness: {
      ...common,
      repo: wellnessRepo,
      overlapDays: 3,
      createClient: () => ({ listWellness }),
    },
  };
});

describe('handleSync', () => {
  it('syncs activities then wellness and replies with both summaries', async () => {
    const reply = await handleSync(USER_ID, deps);

    expect(reply).toContain('Activities: 1 new, 0 updated, 0 unchanged (2026-06-28 → 2026-09-27)');
    expect(reply).toContain('Wellness: 2 new, 0 updated, 0 unchanged (2026-06-28 → 2026-09-27)');
    expect(listActivities.mock.invocationCallOrder[0]).toBeLessThan(
      listWellness.mock.invocationCallOrder[0]
    );
    expect(wellnessApply).toHaveBeenCalledOnce();
  });

  it('not connected', async () => {
    connection = null;
    expect(await handleSync(USER_ID, deps)).toBe(MSG_NOT_CONNECTED);
    expect(listWellness).not.toHaveBeenCalled();
  });

  it('rejected key', async () => {
    listActivities.mockRejectedValueOnce(new IcuAuthError());
    expect(await handleSync(USER_ID, deps)).toBe(MSG_SYNC_AUTH_FAILED);
  });

  it('ICU unavailable during the wellness step', async () => {
    listWellness.mockRejectedValueOnce(new IcuServerError(503, 3));
    expect(await handleSync(USER_ID, deps)).toBe(MSG_SYNC_UNAVAILABLE);
    expect(wellnessApply).not.toHaveBeenCalled();
  });

  it('unexpected errors are rethrown', async () => {
    listWellness.mockRejectedValueOnce(new Error('network down'));
    await expect(handleSync(USER_ID, deps)).rejects.toThrow('network down');
  });
});

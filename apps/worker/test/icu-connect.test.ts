import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decryptSecret, encryptSecret } from '@triathlon/core';
import type { IcuCredentialsPayload } from '@triathlon/core';
import {
  IcuAuthError,
  IcuHttpError,
  IcuServerError,
  type Athlete,
} from '@triathlon/integrations-icu';
import {
  handleConnectIcu,
  handleConnectStatus,
  handleDisconnectIcu,
  MSG_ATHLETE_NOT_FOUND,
  MSG_CREDENTIALS_UNREADABLE,
  MSG_ICU_UNAVAILABLE,
  MSG_INVALID_CREDENTIALS,
  MSG_NOT_CONNECTED,
  type IcuConnectDeps,
  type IcuConnectionRecord,
  type IcuConnectionRepo,
} from '../src/icu-connect';

class MemoryRepo implements IcuConnectionRepo {
  readonly rows = new Map<string, IcuConnectionRecord>();
  upsert(data: Parameters<IcuConnectionRepo['upsert']>[0]) {
    const prev = this.rows.get(data.userId);
    this.rows.set(data.userId, {
      lastActivitySyncAt: prev?.lastActivitySyncAt ?? null,
      lastWellnessSyncAt: prev?.lastWellnessSyncAt ?? null,
      ...data,
    });
    return Promise.resolve();
  }
  findByUserId(userId: string) {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }
  deleteByUserId(userId: string) {
    return Promise.resolve(this.rows.delete(userId));
  }
}

const USER_ID = 'user-1';
const KEY = randomBytes(32);
const API_KEY = 'secret-icu-api-key-123456';

function creds(apiKey = API_KEY, athleteId = 'i12345'): IcuCredentialsPayload {
  const enc = encryptSecret(apiKey, KEY);
  return { athleteId, apiKeyCiphertext: enc.ciphertext, apiKeyIv: enc.iv };
}

function makeDeps(getAthlete: () => Promise<Athlete>) {
  const repo = new MemoryRepo();
  const createClient = vi.fn(() => ({ getAthlete: vi.fn(getAthlete) }));
  const deps: IcuConnectDeps = { repo, keys: [KEY], createClient };
  return { repo, createClient, deps };
}

let ok: ReturnType<typeof makeDeps>;
beforeEach(() => {
  ok = makeDeps(() => Promise.resolve({ id: 'i12345', name: 'Jane Athlete' }));
});

describe('handleConnectIcu', () => {
  it('valid credentials: validates with getAthlete and stores an encrypted row', async () => {
    const reply = await handleConnectIcu(USER_ID, creds(), ok.deps);

    expect(ok.createClient).toHaveBeenCalledWith('i12345', API_KEY);
    expect(reply).toContain('Jane Athlete');
    expect(reply).not.toContain(API_KEY);

    const row = ok.repo.rows.get(USER_ID);
    expect(row).toBeDefined();
    expect(row!.icuAthleteId).toBe('i12345');
    expect(row!.icuAthleteName).toBe('Jane Athlete');
    expect(row!.apiKeyCiphertext).not.toBe(API_KEY);
    expect(row!.apiKeyCiphertext).not.toContain(API_KEY);
    expect(decryptSecret({ ciphertext: row!.apiKeyCiphertext, iv: row!.apiKeyIv }, KEY)).toBe(
      API_KEY
    );
  });

  it('invalid key (401): friendly error and no row stored', async () => {
    const bad = makeDeps(() => Promise.reject(new IcuAuthError()));
    const reply = await handleConnectIcu(USER_ID, creds(), bad.deps);
    expect(reply).toBe(MSG_INVALID_CREDENTIALS);
    expect(bad.repo.rows.size).toBe(0);
  });

  it('unknown athlete (404): friendly error and no row stored', async () => {
    const bad = makeDeps(() =>
      Promise.reject(new IcuHttpError(404, 'GET /athlete/:id', 'Not Found'))
    );
    expect(await handleConnectIcu(USER_ID, creds(), bad.deps)).toBe(MSG_ATHLETE_NOT_FOUND);
    expect(bad.repo.rows.size).toBe(0);
  });

  it('ICU unavailable: friendly error and no row stored', async () => {
    const bad = makeDeps(() => Promise.reject(new IcuServerError(503, 3)));
    expect(await handleConnectIcu(USER_ID, creds(), bad.deps)).toBe(MSG_ICU_UNAVAILABLE);
    expect(bad.repo.rows.size).toBe(0);
  });

  it('unexpected errors are rethrown so the job is retried', async () => {
    const bad = makeDeps(() => Promise.reject(new Error('network down')));
    await expect(handleConnectIcu(USER_ID, creds(), bad.deps)).rejects.toThrow('network down');
    expect(bad.repo.rows.size).toBe(0);
  });

  it('credentials encrypted with an unknown key: friendly error, no ICU call', async () => {
    const enc = encryptSecret(API_KEY, randomBytes(32));
    const reply = await handleConnectIcu(
      USER_ID,
      { athleteId: 'i12345', apiKeyCiphertext: enc.ciphertext, apiKeyIv: enc.iv },
      ok.deps
    );
    expect(reply).toBe(MSG_CREDENTIALS_UNREADABLE);
    expect(ok.createClient).not.toHaveBeenCalled();
    expect(ok.repo.rows.size).toBe(0);
  });

  it('re-link overwrites the previous credentials (single connection per user)', async () => {
    await handleConnectIcu(USER_ID, creds(), ok.deps);
    const newKey = 'another-icu-api-key-987654';
    await handleConnectIcu(USER_ID, creds(newKey, 'i99999'), ok.deps);

    expect(ok.repo.rows.size).toBe(1);
    const row = ok.repo.rows.get(USER_ID)!;
    expect(row.icuAthleteId).toBe('i99999');
    expect(decryptSecret({ ciphertext: row.apiKeyCiphertext, iv: row.apiKeyIv }, KEY)).toBe(newKey);
  });
});

describe('handleConnectStatus', () => {
  it('not connected', async () => {
    expect(await handleConnectStatus(USER_ID, ok.deps)).toBe(MSG_NOT_CONNECTED);
  });

  it('shows athlete name, masked key and sync times', async () => {
    await handleConnectIcu(USER_ID, creds(), ok.deps);
    const reply = await handleConnectStatus(USER_ID, ok.deps);

    expect(reply).toContain('Jane Athlete (i12345)');
    expect(reply).toContain('••••••••3456');
    expect(reply).not.toContain(API_KEY);
    expect(reply).toContain('Last activity sync: never');

    ok.repo.rows.get(USER_ID)!.lastActivitySyncAt = new Date('2026-09-20T08:00:00Z');
    expect(await handleConnectStatus(USER_ID, ok.deps)).not.toContain('Last activity sync: never');
  });
});

describe('handleDisconnectIcu', () => {
  it('deletes the connection', async () => {
    await handleConnectIcu(USER_ID, creds(), ok.deps);
    const reply = await handleDisconnectIcu(USER_ID, ok.deps);
    expect(reply).toContain('disconnected');
    expect(ok.repo.rows.size).toBe(0);
  });

  it('nothing to disconnect', async () => {
    expect(await handleDisconnectIcu(USER_ID, ok.deps)).toBe(MSG_NOT_CONNECTED);
  });
});

describe('activity sync scheduling', () => {
  function withScheduler(schedule = vi.fn(() => Promise.resolve())) {
    const scheduler = { schedule, unschedule: vi.fn(() => Promise.resolve()) };
    const onSchedulerError = vi.fn();
    const deps: IcuConnectDeps = { ...ok.deps, scheduler, onSchedulerError };
    return { scheduler, onSchedulerError, deps };
  }

  it('connect schedules the sync, disconnect removes it', async () => {
    const { scheduler, deps } = withScheduler();

    await handleConnectIcu(USER_ID, creds(), deps);
    expect(scheduler.schedule).toHaveBeenCalledWith(USER_ID);

    await handleDisconnectIcu(USER_ID, deps);
    expect(scheduler.unschedule).toHaveBeenCalledWith(USER_ID);
  });

  it('failed credentials do not schedule anything', async () => {
    const bad = makeDeps(() => Promise.reject(new IcuAuthError()));
    const { scheduler, deps } = withScheduler();
    await handleConnectIcu(USER_ID, creds(), { ...bad.deps, scheduler: deps.scheduler });
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('scheduler failure is reported but does not fail the connect', async () => {
    const error = new Error('redis down');
    const { onSchedulerError, deps } = withScheduler(vi.fn(() => Promise.reject(error)));

    const reply = await handleConnectIcu(USER_ID, creds(), deps);

    expect(reply).toContain('Connected');
    expect(ok.repo.rows.size).toBe(1);
    expect(onSchedulerError).toHaveBeenCalledWith(error, USER_ID);
  });
});

import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  alertedKey,
  createFailureStreakTracker,
  streakKey,
  type StreakJob,
  type StreakRedis,
} from '../src/observability/failure-streak';

/** In-memory stand-in for the four ioredis calls the tracker uses */
function fakeRedis(): StreakRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    incr: (key) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    expire: () => Promise.resolve(1),
    set: (key, value) => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    del: (...keys) => {
      const removed = keys.filter((key) => store.delete(key));
      return Promise.resolve(removed.length);
    },
  };
}

const LOGGER = { info: vi.fn(), warn: vi.fn() };
const ERROR = new Error('LLM exploded');

function finalJob(userId = 'u1'): StreakJob {
  return { data: { userId }, attemptsMade: 3, opts: { attempts: 3 } };
}

/** Records `count` final failures one after another */
async function fail(
  tracker: ReturnType<typeof createFailureStreakTracker>,
  count: number,
  userId = 'u1'
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await tracker.recordFailure(finalJob(userId), ERROR);
  }
}

function setup(options: { adminChatId?: number; sendFails?: boolean } = {}) {
  const redis = fakeRedis();
  const sendMessage = vi.fn((_chatId: number, _text: string) =>
    options.sendFails ? Promise.reject(new Error('telegram down')) : Promise.resolve({})
  );
  const tracker = createFailureStreakTracker({
    redis,
    adminChatId: options.adminChatId,
    threshold: 3,
    sendMessage,
    logger: LOGGER,
  });
  return { redis, sendMessage, tracker };
}

describe('daily brief failure streak', () => {
  it('does not alert before the threshold', async () => {
    const { tracker, sendMessage } = setup({ adminChatId: 4242 });
    await fail(tracker, 2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('alerts the admin exactly once per incident', async () => {
    const { tracker, sendMessage } = setup({ adminChatId: 4242 });
    await fail(tracker, 5);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe(4242);
    expect(text).toContain('u1');
    expect(text).toContain('LLM exploded');
  });

  it('starts a new incident after a success', async () => {
    const { tracker, sendMessage, redis } = setup({ adminChatId: 4242 });
    await fail(tracker, 3);
    await tracker.recordSuccess('u1');
    expect(redis.store.has(streakKey('u1'))).toBe(false);
    expect(redis.store.has(alertedKey('u1'))).toBe(false);

    await fail(tracker, 2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await fail(tracker, 1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores a failed attempt that BullMQ will retry', async () => {
    const { tracker, redis } = setup({ adminChatId: 4242 });
    await tracker.recordFailure(
      { data: { userId: 'u1' }, attemptsMade: 1, opts: { attempts: 3 } },
      ERROR
    );
    expect(redis.store.has(streakKey('u1'))).toBe(false);
  });

  it('counts an unrecoverable error on the first attempt', async () => {
    const { tracker, redis } = setup({ adminChatId: 4242 });
    await tracker.recordFailure(
      { data: { userId: 'u1' }, attemptsMade: 1, opts: { attempts: 3 } },
      new UnrecoverableError('blocked')
    );
    expect(redis.store.get(streakKey('u1'))).toBe('1');
  });

  it('tracks each user separately', async () => {
    const { tracker, sendMessage } = setup({ adminChatId: 4242 });
    await fail(tracker, 2, 'u1');
    await fail(tracker, 2, 'u2');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends nothing when no admin chat is configured', async () => {
    const { tracker, sendMessage } = setup();
    await fail(tracker, 4);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('survives a failed send and retries the alert on the next failure', async () => {
    const { tracker, sendMessage, redis } = setup({ adminChatId: 4242, sendFails: true });
    await fail(tracker, 3);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(redis.store.has(alertedKey('u1'))).toBe(false);

    await fail(tracker, 1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

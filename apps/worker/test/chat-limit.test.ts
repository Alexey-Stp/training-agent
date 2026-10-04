import { describe, it, expect } from 'vitest';
import type Redis from 'ioredis';
import { CHAT_LIMIT_TTL_SECONDS, chatLimitKey, RedisChatLimiter } from '../src/chat-limit';

/** The multi() chain RedisChatLimiter uses, over in-memory sets */
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  const redis = {
    multi() {
      const ops: (() => number)[] = [];
      const chain = {
        sadd(key: string, member: string) {
          ops.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            set.add(member);
            sets.set(key, set);
            return 1;
          });
          return chain;
        },
        expire(key: string, seconds: number) {
          ops.push(() => {
            ttls.set(key, seconds);
            return 1;
          });
          return chain;
        },
        scard(key: string) {
          ops.push(() => sets.get(key)?.size ?? 0);
          return chain;
        },
        exec() {
          return Promise.resolve(ops.map((op) => [null, op()]));
        },
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Pick<Redis, 'multi'>, ttls };
}

describe('RedisChatLimiter', () => {
  it('counts distinct messages per user and day, with an expiry', async () => {
    const { redis, ttls } = fakeRedis();
    const limiter = new RedisChatLimiter(redis);

    expect(await limiter.count('u1', '2026-10-05', 1)).toBe(1);
    expect(await limiter.count('u1', '2026-10-05', 2)).toBe(2);
    expect(await limiter.count('u1', '2026-10-06', 3)).toBe(1);
    expect(await limiter.count('u2', '2026-10-05', 4)).toBe(1);
    expect(ttls.get(chatLimitKey('u1', '2026-10-05'))).toBe(CHAT_LIMIT_TTL_SECONDS);
  });

  it('counts a retried message once', async () => {
    const limiter = new RedisChatLimiter(fakeRedis().redis);

    await limiter.count('u1', '2026-10-05', 7);
    expect(await limiter.count('u1', '2026-10-05', 7)).toBe(1);
  });
});

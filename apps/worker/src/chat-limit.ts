import type Redis from 'ioredis';

/** Counts coach-chat messages per athlete and local day. */
export interface ChatLimiter {
  /**
   * Counts `messageId` towards the user's `day` and returns the day's count so far. The same
   * message counts once, so a retried job doesn't use up the limit.
   */
  count(userId: string, day: string, messageId: number): Promise<number>;
}

/** Long enough to outlive the local day in any timezone */
export const CHAT_LIMIT_TTL_SECONDS = 2 * 24 * 60 * 60;

export function chatLimitKey(userId: string, day: string): string {
  return `coach-chat:${userId}:${day}`;
}

/** A Redis set of the day's message ids; its size is the count. */
export class RedisChatLimiter implements ChatLimiter {
  constructor(private readonly redis: Pick<Redis, 'multi'>) {}

  async count(userId: string, day: string, messageId: number): Promise<number> {
    const key = chatLimitKey(userId, day);
    const results = await this.redis
      .multi()
      .sadd(key, messageId.toString())
      .expire(key, CHAT_LIMIT_TTL_SECONDS)
      .scard(key)
      .exec();
    const [error, size] = results?.at(-1) ?? [new Error('Redis transaction aborted'), null];
    if (error) throw error;
    return Number(size);
  }
}

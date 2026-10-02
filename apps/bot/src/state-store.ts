import type Redis from 'ioredis';

/** Per-user dialog state. */
export interface StateStore<T> {
  get(telegramUserId: number): Promise<T | null>;
  set(telegramUserId: number, state: T): Promise<void>;
  delete(telegramUserId: number): Promise<void>;
}

/** Dialog state as JSON under `<prefix>:<telegramUserId>`, expiring `ttlSeconds` after the last step. */
export class RedisStateStore<T> implements StateStore<T> {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds: number
  ) {}

  private key(telegramUserId: number): string {
    return `${this.prefix}:${telegramUserId.toString()}`;
  }

  async get(telegramUserId: number): Promise<T | null> {
    const raw = await this.redis.get(this.key(telegramUserId));
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(telegramUserId: number, state: T): Promise<void> {
    await this.redis.set(this.key(telegramUserId), JSON.stringify(state), 'EX', this.ttlSeconds);
  }

  async delete(telegramUserId: number): Promise<void> {
    await this.redis.del(this.key(telegramUserId));
  }
}

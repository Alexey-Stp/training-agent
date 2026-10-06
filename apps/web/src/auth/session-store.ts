import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

/** A signed-in browser: bound to one User.id, with the CSRF token for its POST forms. */
export interface WebSession {
  id: string;
  userId: string;
  csrf: string;
}

export interface SessionStore {
  /** Marks a magic-link token id used; false when it already was (replay). */
  consumeToken(jti: string, ttlSeconds: number): Promise<boolean>;
  create(userId: string, ttlSeconds: number): Promise<WebSession>;
  get(id: string): Promise<WebSession | null>;
  destroy(id: string): Promise<void>;
}

const LINK_PREFIX = 'web:link:';
const SESSION_PREFIX = 'web:session:';

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Sessions and used link ids live in Redis with a TTL, so nothing needs cleaning up. */
export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async consumeToken(jti: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      LINK_PREFIX + jti,
      '1',
      'EX',
      Math.max(1, ttlSeconds),
      'NX'
    );
    return result === 'OK';
  }

  async create(userId: string, ttlSeconds: number): Promise<WebSession> {
    const session: WebSession = {
      id: newSessionId(),
      userId,
      csrf: randomBytes(24).toString('base64url'),
    };
    const value = JSON.stringify({ userId: session.userId, csrf: session.csrf });
    await this.redis.set(SESSION_PREFIX + session.id, value, 'EX', ttlSeconds);
    return session;
  }

  async get(id: string): Promise<WebSession | null> {
    const raw = await this.redis.get(SESSION_PREFIX + id);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { userId?: unknown; csrf?: unknown };
      if (typeof parsed.userId !== 'string' || typeof parsed.csrf !== 'string') return null;
      return { id, userId: parsed.userId, csrf: parsed.csrf };
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(SESSION_PREFIX + id);
  }
}

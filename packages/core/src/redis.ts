import type { EnvConfig } from './config';

/** ioredis options; BullMQ `connection` accepts the same object */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  /** 0 = IPv4 or IPv6 (DNS order); Railway's private network can resolve to IPv6 only */
  family?: number;
}

const DEFAULT_REDIS_PORT = 6379;

/**
 * Connection options for ioredis/BullMQ. `REDIS_URL` (`redis://user:pass@host:port/db`,
 * `rediss://` for TLS) wins over `REDIS_HOST`/`REDIS_PORT`, which stay for local dev.
 */
export function redisConnectionOptions(
  config: Pick<EnvConfig, 'REDIS_URL' | 'REDIS_HOST' | 'REDIS_PORT'>
): RedisConnectionOptions {
  if (!config.REDIS_URL) return { host: config.REDIS_HOST, port: config.REDIS_PORT };

  const url = new URL(config.REDIS_URL);
  const options: RedisConnectionOptions = {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : DEFAULT_REDIS_PORT,
    family: 0,
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  const db = url.pathname.slice(1);
  if (db) options.db = Number(db);
  if (url.protocol === 'rediss:') options.tls = {};
  return options;
}

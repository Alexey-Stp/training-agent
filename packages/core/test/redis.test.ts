import { describe, it, expect } from 'vitest';
import { redisConnectionOptions } from '../src/redis';

const LOCAL = { REDIS_HOST: 'localhost', REDIS_PORT: 6379 };

describe('redisConnectionOptions', () => {
  it('uses REDIS_HOST/REDIS_PORT when REDIS_URL is not set', () => {
    expect(redisConnectionOptions({ ...LOCAL, REDIS_URL: undefined })).toEqual({
      host: 'localhost',
      port: 6379,
    });
  });

  it('parses user and password from REDIS_URL and allows IPv6', () => {
    const options = redisConnectionOptions({
      ...LOCAL,
      REDIS_URL: 'redis://default:s3cr%40t@redis.railway.internal:6380',
    });
    expect(options).toEqual({
      host: 'redis.railway.internal',
      port: 6380,
      username: 'default',
      password: 's3cr@t',
      family: 0,
    });
  });

  it('turns on TLS for rediss and reads the db index', () => {
    const options = redisConnectionOptions({
      ...LOCAL,
      REDIS_URL: 'rediss://:pw@cache.example.com/2',
    });
    expect(options).toEqual({
      host: 'cache.example.com',
      port: 6379,
      password: 'pw',
      db: 2,
      tls: {},
      family: 0,
    });
  });

  it('strips brackets from an IPv6 host', () => {
    expect(redisConnectionOptions({ ...LOCAL, REDIS_URL: 'redis://[::1]:6379' }).host).toBe('::1');
  });
});

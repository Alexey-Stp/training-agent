import 'dotenv/config';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import { getConfig } from '@triathlon/core';
import { createApp } from './app';
import { RedisSessionStore } from './auth/session-store';
import { createUserRepo, prisma } from './db';
import { logger } from './logger';

const config = getConfig();

if (!config.DASHBOARD_LINK_SECRET) {
  logger.warn('DASHBOARD_LINK_SECRET is not set: every sign-in link will be rejected');
}

const redis = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });

const app = createApp({
  logger,
  sessions: new RedisSessionStore(redis),
  users: createUserRepo(prisma),
  linkSecret: config.DASHBOARD_LINK_SECRET,
  sessionTtlHours: config.DASHBOARD_SESSION_TTL_HOURS,
  secureCookies: config.NODE_ENV !== 'development',
  now: () => new Date(),
});

const server: Server = app.listen(config.WEB_PORT, () => {
  logger.info({ port: config.WEB_PORT }, 'Web dashboard listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down web dashboard');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

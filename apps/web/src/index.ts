import 'dotenv/config';
import type { Server } from 'node:http';
import { Queue } from 'bullmq';
import { Api } from 'grammy';
import Redis from 'ioredis';
import { getConfig, PROFILE_SETTINGS_QUEUE, type ProfileRescheduleJob } from '@triathlon/core';
import { createApp } from './app';
import { RedisSessionStore } from './auth/session-store';
import { createDashboardReadRepo, createSettingsRepo, createUserRepo, prisma } from './db';
import { logger } from './logger';
import { createProfileEvents } from './queue';
import { createChatVerifier } from './telegram';

const config = getConfig();

if (!config.DASHBOARD_LINK_SECRET) {
  logger.warn('DASHBOARD_LINK_SECRET is not set: every sign-in link will be rejected');
}

const redis = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT });
const profileQueue = new Queue<ProfileRescheduleJob>(PROFILE_SETTINGS_QUEUE, {
  connection: { host: config.REDIS_HOST, port: config.REDIS_PORT },
});

const app = createApp({
  logger,
  sessions: new RedisSessionStore(redis),
  users: createUserRepo(prisma),
  settings: createSettingsRepo(prisma),
  chats: createChatVerifier(new Api(config.TELEGRAM_BOT_TOKEN)),
  events: createProfileEvents(profileQueue),
  reads: createDashboardReadRepo(prisma),
  botUsername: config.TELEGRAM_BOT_USERNAME,
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
  await Promise.all([prisma.$disconnect(), redis.quit(), profileQueue.close()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

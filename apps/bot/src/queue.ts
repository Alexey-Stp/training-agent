import { Queue } from 'bullmq';
import { getConfig } from '@triathlon/core';
import type { CommandJob } from '@triathlon/core';
import { logger } from './logger';

const config = getConfig();

export const commandQueue = new Queue<CommandJob>('commands', {
  connection: {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
  },
});

logger.info('Command queue initialized');

export async function enqueueCommand(job: CommandJob): Promise<void> {
  await commandQueue.add('command', job, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 100,
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  });
}

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

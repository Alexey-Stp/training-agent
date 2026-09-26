import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { Bot } from 'grammy';
import { getConfig, getEncKeys } from '@triathlon/core';
import type { CommandJob } from '@triathlon/core';
import { IcuClient } from '@triathlon/integrations-icu';
import { logger } from './logger';
import {
  prisma,
  ensureUser,
  checkMessageProcessed,
  markMessageProcessed,
  icuConnectionRepo,
} from './db';
import {
  handleStart,
  handleProfile,
  handleSetFtp,
  handlePlan,
  handleLog,
  handleUnknown,
} from './handlers';
import {
  handleConnectIcu,
  handleConnectStatus,
  handleDisconnectIcu,
  type IcuConnectDeps,
} from './icu-connect';

const config = getConfig();

// Create Telegram API client for sending messages
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const api = bot.api;

const icuConnectDeps: IcuConnectDeps = {
  repo: icuConnectionRepo,
  keys: getEncKeys(config),
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
};

// Create worker
const worker = new Worker<CommandJob>(
  'commands',
  async (job: Job<CommandJob>) => {
    const { telegramChatId, telegramUserId, messageId, commandName, args } = job.data;

    logger.info(
      {
        jobId: job.id,
        userId: telegramUserId,
        command: commandName,
      },
      'Processing job'
    );

    try {
      // Ensure user exists
      const user = await ensureUser(telegramUserId);

      // Check if message already processed (idempotency)
      const alreadyProcessed = await checkMessageProcessed(user.id, messageId);
      if (alreadyProcessed) {
        logger.info({ userId: user.id, messageId }, 'Message already processed, skipping');
        return;
      }

      // Process command
      let response: string;

      switch (commandName) {
        case 'start':
          response = handleStart(user);
          break;

        case 'profile':
          response = handleProfile(user);
          break;

        case 'set':
          if (args.length >= 2 && args[0].toLowerCase() === 'ftp') {
            const ftp = parseInt(args[1], 10);
            if (isNaN(ftp) || ftp < 50 || ftp > 600) {
              response = '❌ Invalid FTP value. Must be between 50 and 600.';
            } else {
              response = await handleSetFtp(user, ftp);
            }
          } else {
            response = '❌ Usage: /set ftp <number>';
          }
          break;

        case 'plan':
          response = await handlePlan(user);
          break;

        case 'log':
          if (args.length < 2) {
            response = '❌ Usage: /log <sport> <minutes> [intensity]\nSport: swim|bike|run';
          } else {
            const sport = args[0].toLowerCase();
            const validSports = ['swim', 'bike', 'run'];
            if (!validSports.includes(sport)) {
              response = `❌ Sport must be one of: ${validSports.join(', ')}`;
            } else {
              const durationMin = parseInt(args[1], 10);
              if (isNaN(durationMin) || durationMin < 1 || durationMin > 1440) {
                response = '❌ Duration must be between 1 and 1440 minutes';
              } else {
                const intensity = args[2]?.toLowerCase();
                if (intensity) {
                  const validIntensities = ['z1', 'z2', 'z3', 'z4', 'z5'];
                  if (!validIntensities.includes(intensity)) {
                    response = `❌ Intensity must be one of: ${validIntensities.join(', ')}`;
                  } else {
                    response = await handleLog(user, sport, durationMin, intensity);
                  }
                } else {
                  response = await handleLog(user, sport, durationMin);
                }
              }
            }
          }
          break;

        case 'connect_icu':
          // Enqueued by the bot at the end of the /connect icu dialog
          response = job.data.icuCredentials
            ? await handleConnectIcu(user.id, job.data.icuCredentials, icuConnectDeps)
            : '❌ Missing credentials. Please run /connect icu again.';
          break;

        case 'connect':
          // `/connect icu` itself is handled by the bot dialog
          response =
            args[0]?.toLowerCase() === 'status'
              ? await handleConnectStatus(user.id, icuConnectDeps)
              : '❌ Usage: /connect icu | /connect status';
          break;

        case 'disconnect':
          response =
            args[0]?.toLowerCase() === 'icu'
              ? await handleDisconnectIcu(user.id, icuConnectDeps)
              : '❌ Usage: /disconnect icu';
          break;

        case 'unknown':
        default:
          response = handleUnknown();
          break;
      }

      // Send response via Telegram
      await api.sendMessage(telegramChatId, response);

      // Mark message as processed
      await markMessageProcessed(user.id, messageId);

      logger.info(
        {
          jobId: job.id,
          userId: user.id,
          command: commandName,
        },
        'Job processed successfully'
      );
    } catch (error) {
      logger.error(
        {
          error,
          jobId: job.id,
          userId: telegramUserId,
          command: commandName,
        },
        'Error processing job'
      );

      // Try to send error message to user
      try {
        await api.sendMessage(
          telegramChatId,
          '❌ Sorry, something went wrong processing your request. Please try again.'
        );
      } catch (sendError) {
        logger.error({ error: sendError }, 'Failed to send error message to user');
      }

      throw error; // Re-throw to mark job as failed
    }
  },
  {
    connection: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
    },
    concurrency: 5,
    limiter: {
      max: 10,
      duration: 1000,
    },
  }
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, 'Job failed');
});

worker.on('error', (err) => {
  logger.error({ error: err }, 'Worker error');
});

logger.info('Worker started and listening for jobs...');

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

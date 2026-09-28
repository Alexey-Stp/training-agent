import 'dotenv/config';
import { Worker, Job, Queue } from 'bullmq';
import { Bot } from 'grammy';
import { getConfig, getEncKeys } from '@triathlon/core';
import type { CommandJob, IcuSyncJob } from '@triathlon/core';
import { IcuClient } from '@triathlon/integrations-icu';
import { logger } from './logger';
import {
  prisma,
  ensureUser,
  checkMessageProcessed,
  markMessageProcessed,
  icuConnectionRepo,
  activityRepo,
  wellnessRepo,
  plannedSessionRepo,
} from './db';
import {
  handleStart,
  handleProfile,
  handleSetFtp,
  handlePlan,
  handlePlanPushCommand,
  handleLog,
  handleUnknown,
} from './handlers';
import {
  handleConnectIcu,
  handleConnectStatus,
  handleDisconnectIcu,
  type IcuConnectDeps,
} from './icu-connect';
import { processSyncJob, type ActivitySyncDeps } from './activity-sync';
import { processWellnessSyncJob, type WellnessSyncDeps } from './wellness-sync';
import { handleSync, type SyncCommandDeps } from './sync-command';
import type { PlanPushCommandDeps } from './plan-command';
import type { PlanStoreDeps } from './plan-store';
import { processPlanReconcileJob, type PlanReconcileDeps } from './plan-reconcile';
import {
  ACTIVITY_SYNC_JOB,
  ICU_SYNC_QUEUE,
  PLAN_RECONCILE_JOB,
  WELLNESS_SYNC_JOB,
  createIcuSyncScheduler,
  reconcileSchedulers,
  type IcuSyncJobSpec,
} from './sync-scheduler';

const config = getConfig();

// Create Telegram API client for sending messages
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const api = bot.api;

const redisConnection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
};
const encKeys = getEncKeys(config);

// intervals.icu sync: per linked athlete, one repeatable activity job, one wellness job and
// one planned-workout reconcile job on the icu-sync queue
const syncJobs: IcuSyncJobSpec[] = [
  { job: ACTIVITY_SYNC_JOB, everyMs: config.ICU_ACTIVITY_SYNC_EVERY_MIN * 60_000 },
  { job: WELLNESS_SYNC_JOB, everyMs: config.ICU_WELLNESS_SYNC_EVERY_MIN * 60_000 },
  { job: PLAN_RECONCILE_JOB, everyMs: config.ICU_PLAN_RECONCILE_EVERY_MIN * 60_000 },
];
const syncQueue = new Queue<IcuSyncJob>(ICU_SYNC_QUEUE, { connection: redisConnection });
const icuSyncScheduler = createIcuSyncScheduler(syncQueue, syncJobs);

const activitySyncDeps: ActivitySyncDeps = {
  repo: activityRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  now: () => new Date(),
  backfillDays: config.ICU_ACTIVITY_BACKFILL_DAYS,
  overlapDays: config.ICU_ACTIVITY_SYNC_OVERLAP_DAYS,
};

const wellnessSyncDeps: WellnessSyncDeps = {
  repo: wellnessRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  now: () => new Date(),
  backfillDays: config.ICU_WELLNESS_BACKFILL_DAYS,
  overlapDays: config.ICU_WELLNESS_SYNC_OVERLAP_DAYS,
};

const syncCommandDeps: SyncCommandDeps = { activity: activitySyncDeps, wellness: wellnessSyncDeps };

const planStoreDeps: PlanStoreDeps = { repo: plannedSessionRepo, now: () => new Date() };

const planPushCommandDeps: PlanPushCommandDeps = {
  store: planStoreDeps,
  push: {
    repo: plannedSessionRepo,
    keys: encKeys,
    createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
    now: () => new Date(),
  },
};

const planReconcileDeps: PlanReconcileDeps = {
  repo: plannedSessionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  now: () => new Date(),
};

const icuConnectDeps: IcuConnectDeps = {
  repo: icuConnectionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  scheduler: icuSyncScheduler,
  onSchedulerError: (error, userId) => {
    logger.error({ error, userId }, 'Failed to update intervals.icu sync schedule');
  },
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
          response =
            args[0]?.toLowerCase() === 'push'
              ? await handlePlanPushCommand(user, planPushCommandDeps)
              : await handlePlan(user, planStoreDeps);
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

        case 'sync':
          response = await handleSync(user.id, syncCommandDeps);
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
    connection: redisConnection,
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

const syncWorker = new Worker<IcuSyncJob>(
  ICU_SYNC_QUEUE,
  async (job: Job<IcuSyncJob>) => {
    let result;
    switch (job.name) {
      case WELLNESS_SYNC_JOB:
        result = await processWellnessSyncJob(job.data, wellnessSyncDeps);
        break;
      case PLAN_RECONCILE_JOB:
        result = await processPlanReconcileJob(job.data, planReconcileDeps);
        break;
      default:
        result = await processSyncJob(job.data, activitySyncDeps);
    }
    logger.info(
      { jobId: job.id, job: job.name, userId: job.data.userId, ...result },
      'intervals.icu sync finished'
    );
    return result;
  },
  { connection: redisConnection, concurrency: 2 }
);

syncWorker.on('failed', (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      job: job?.name,
      userId: job?.data.userId,
      attempt: job?.attemptsMade,
      error: err,
    },
    'intervals.icu sync failed'
  );
});

syncWorker.on('error', (err) => {
  logger.error({ error: err }, 'Sync worker error');
});

async function startIcuSync() {
  const userIds = await activityRepo.listConnectedUserIds();
  const result = await reconcileSchedulers(syncQueue, icuSyncScheduler, userIds, syncJobs);
  logger.info(result, 'intervals.icu sync schedules reconciled');
}

startIcuSync().catch((error: unknown) => {
  logger.error({ error }, 'Failed to reconcile intervals.icu sync schedules');
});

logger.info('Worker started and listening for jobs...');

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker...');
  await Promise.all([worker.close(), syncWorker.close()]);
  await syncQueue.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

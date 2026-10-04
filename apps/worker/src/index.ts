import 'dotenv/config';
import { Worker, Job, Queue } from 'bullmq';
import { Bot } from 'grammy';
import Redis from 'ioredis';
import {
  COACH_APPLY_COMMAND,
  COACH_CHAT_COMMAND,
  COACH_KEEP_COMMAND,
  getConfig,
  getEncKeys,
  SEASON_CANCEL_COMMAND,
  SEASON_CONFIRM_COMMAND,
  SEASON_PREVIEW_COMMAND,
} from '@triathlon/core';
import type { CommandJob, IcuSyncJob } from '@triathlon/core';
import { IcuClient } from '@triathlon/integrations-icu';
import { createLlmProvider, loadAiConfig, withCallLog } from '@triathlon/ai';
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
  seasonRepo,
  raceRepo,
  profileRepo,
  loadTrainingHours,
  llmCallLogRepo,
  coachDecisionRepo,
  coachChatRepo,
  coachAnswerRepo,
  dailyContextDeps,
  briefProfileRepo,
  dailyBriefRunRepo,
} from './db';
import {
  handleStart,
  handleProfile,
  handleSetFtp,
  handlePlan,
  handlePlanPushCommand,
  handleLog,
  handleUnknown,
  getRulesContext,
} from './handlers';
import { handleWeekShow, MSG_WEEK_USAGE, type WeekShowDeps } from './week-command';
import {
  handleConnectIcu,
  handleConnectStatus,
  handleDisconnectIcu,
  type IcuConnectDeps,
} from './icu-connect';
import { processSyncJob, syncActivities, type ActivitySyncDeps } from './activity-sync';
import { processWellnessSyncJob, syncWellness, type WellnessSyncDeps } from './wellness-sync';
import { handleSync, type SyncCommandDeps } from './sync-command';
import type { PlanPushCommandDeps } from './plan-command';
import type { PlanStoreDeps } from './plan-store';
import type { PlanSourceDeps } from './plan-source';
import { handleRace, type RaceCommandDeps } from './race-command';
import {
  handleSeason,
  handleSeasonCancel,
  handleSeasonConfirm,
  handleSeasonPreview,
  type SeasonCommandDeps,
} from './season-command';
import { processSeasonPublishJob, type SeasonPublishDeps } from './season-publish';
import { toTelegramMessage, type Reply } from './reply';
import { processPlanReconcileJob, type PlanReconcileDeps } from './plan-reconcile';
import { RedisChatLimiter } from './chat-limit';
import { handleCoachChat, type CoachChatDeps } from './coach-chat-command';
import { handleCoachAnswer, type CoachAnswerDeps } from './coach-apply';
import {
  ACTIVITY_SYNC_JOB,
  ICU_SYNC_QUEUE,
  PLAN_RECONCILE_JOB,
  SEASON_PUBLISH_JOB,
  WELLNESS_SYNC_JOB,
  createIcuSyncScheduler,
  reconcileSchedulers,
  type IcuSyncJobSpec,
} from './sync-scheduler';
import {
  DAILY_BRIEF_QUEUE,
  combineSchedulers,
  createDailyBriefScheduler,
  reconcileDailyBriefSchedulers,
  type DailyBriefJob,
  type DailyBriefSchedulerDeps,
} from './daily-loop/scheduler';
import { runDailyBrief, type DailyBriefDeps } from './daily-loop/pipeline';

const config = getConfig();

// Create Telegram API client for sending messages
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const api = bot.api;

const redisConnection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
};
const encKeys = getEncKeys(config);

// intervals.icu sync: per linked athlete, one repeatable activity job, one wellness job,
// one planned-workout reconcile job and one season publish job on the icu-sync queue
const syncJobs: IcuSyncJobSpec[] = [
  { job: ACTIVITY_SYNC_JOB, everyMs: config.ICU_ACTIVITY_SYNC_EVERY_MIN * 60_000 },
  { job: WELLNESS_SYNC_JOB, everyMs: config.ICU_WELLNESS_SYNC_EVERY_MIN * 60_000 },
  { job: PLAN_RECONCILE_JOB, everyMs: config.ICU_PLAN_RECONCILE_EVERY_MIN * 60_000 },
  { job: SEASON_PUBLISH_JOB, everyMs: config.SEASON_PUBLISH_EVERY_MIN * 60_000 },
];
const syncQueue = new Queue<IcuSyncJob>(ICU_SYNC_QUEUE, { connection: redisConnection });
const icuSyncScheduler = createIcuSyncScheduler(syncQueue, syncJobs);

// Morning brief: per linked athlete, one cron scheduler at the local Profile.briefTime
const briefSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.DAILY_BRIEF_DEFAULT_TIME,
};
const briefQueue = new Queue<DailyBriefJob>(DAILY_BRIEF_QUEUE, { connection: redisConnection });
const dailyBriefScheduler = createDailyBriefScheduler(briefQueue, briefSchedulerDeps);

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

// With an active season, /plan shows and stores the season's sessions
const planSourceDeps: PlanSourceDeps = { seasons: seasonRepo, getRulesContext };

const seasonPublishDeps: SeasonPublishDeps = {
  seasons: seasonRepo,
  profiles: profileRepo,
  getRulesContext,
  store: planStoreDeps,
  push: planPushCommandDeps.push,
  windowDays: config.SEASON_PUBLISH_WINDOW_DAYS,
  now: () => new Date(),
};

const raceCommandDeps: RaceCommandDeps = { repo: raceRepo, now: () => new Date() };

const seasonCommandDeps: SeasonCommandDeps = {
  seasons: seasonRepo,
  races: raceRepo,
  loadTrainingHours,
  hasIcuConnection: async (userId) => (await icuConnectionRepo.findByUserId(userId)) !== null,
  // One-off run right after a season is saved, so the athlete doesn't wait for the scheduler
  publish: async (userId, draftId) => {
    await syncQueue.add(
      SEASON_PUBLISH_JOB,
      { userId },
      {
        jobId: `season-publish-now-${userId}-${draftId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      }
    );
  },
  onPublishError: (error, userId) => {
    logger.error({ error, userId }, 'Failed to queue season publish');
  },
  now: () => new Date(),
};

const planReconcileDeps: PlanReconcileDeps = {
  repo: plannedSessionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  now: () => new Date(),
};

const weekShowDeps: WeekShowDeps = { repo: seasonRepo, getRulesContext, now: () => new Date() };

// Coach chat: one LLM provider for the worker, every call logged to LlmCallLog
const aiConfig = loadAiConfig();
const llmProvider = withCallLog(createLlmProvider(aiConfig), llmCallLogRepo, { logger });
const redis = new Redis(redisConnection);

const coachChatDeps: CoachChatDeps = {
  limiter: new RedisChatLimiter(redis),
  dailyLimit: config.COACH_CHAT_DAILY_LIMIT,
  chats: coachChatRepo,
  context: dailyContextDeps,
  getRulesContext,
  provider: llmProvider,
  decisions: coachDecisionRepo,
  tokenBudget: aiConfig.AI_CONTEXT_TOKEN_BUDGET,
  now: () => new Date(),
};

const coachAnswerDeps: CoachAnswerDeps = {
  repo: coachAnswerRepo,
  getRulesContext,
  push: planPushCommandDeps.push,
  onPushError: (error, userId) => {
    logger.error({ error, userId }, 'Failed to push applied coach changes');
  },
  now: () => new Date(),
};

const icuConnectDeps: IcuConnectDeps = {
  repo: icuConnectionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  scheduler: config.DAILY_BRIEF_ENABLED
    ? combineSchedulers(icuSyncScheduler, dailyBriefScheduler)
    : icuSyncScheduler,
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
      let response: Reply;

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
              ? await handlePlanPushCommand(user, planPushCommandDeps, planSourceDeps)
              : await handlePlan(user, planStoreDeps, planSourceDeps);
          break;

        case 'week':
          response =
            args[0]?.toLowerCase() === 'show'
              ? await handleWeekShow(user, weekShowDeps)
              : MSG_WEEK_USAGE;
          break;

        case 'race':
          response = await handleRace(user, args, raceCommandDeps);
          break;

        case 'season':
          response = await handleSeason(user, args, seasonCommandDeps);
          break;

        // Enqueued by the bot's /season new wizard and its preview buttons
        case SEASON_PREVIEW_COMMAND:
          response = await handleSeasonPreview(user, args, seasonCommandDeps);
          break;

        case SEASON_CONFIRM_COMMAND:
          response = await handleSeasonConfirm(user, args, seasonCommandDeps);
          break;

        case SEASON_CANCEL_COMMAND:
          response = await handleSeasonCancel(user, args, seasonCommandDeps);
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

        // Plain text from the bot; the message is in rawText (never logged)
        case COACH_CHAT_COMMAND:
          response = await handleCoachChat(
            user,
            { text: job.data.rawText, telegramMessageId: messageId },
            coachChatDeps
          );
          break;

        // Apply/Keep buttons under a coach-chat suggestion
        case COACH_APPLY_COMMAND:
          response = await handleCoachAnswer(user, args[0], 'apply', coachAnswerDeps);
          break;

        case COACH_KEEP_COMMAND:
          response = await handleCoachAnswer(user, args[0], 'keep', coachAnswerDeps);
          break;

        case 'unknown':
        default:
          response = handleUnknown();
          break;
      }

      // Send response via Telegram
      const message = toTelegramMessage(response);
      await api.sendMessage(telegramChatId, message.text, message.options);

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
      case SEASON_PUBLISH_JOB:
        result = await processSeasonPublishJob(job.data, seasonPublishDeps);
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

const dailyBriefDeps: DailyBriefDeps = {
  runs: dailyBriefRunRepo,
  profiles: briefProfileRepo,
  syncWellness: (userId) => syncWellness(userId, wellnessSyncDeps),
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  connections: icuConnectionRepo,
  context: dailyContextDeps,
  getRulesContext,
  provider: llmProvider,
  decisions: coachDecisionRepo,
  tokenBudget: aiConfig.AI_CONTEXT_TOKEN_BUDGET,
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  logger,
  now: () => new Date(),
};

const briefWorker = config.DAILY_BRIEF_ENABLED
  ? new Worker<DailyBriefJob>(
      DAILY_BRIEF_QUEUE,
      (job: Job<DailyBriefJob>) => runDailyBrief(job.data.userId, dailyBriefDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

briefWorker?.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, userId: job?.data.userId, attempt: job?.attemptsMade, error: err },
    'Daily brief failed'
  );
});

briefWorker?.on('error', (err) => {
  logger.error({ error: err }, 'Daily brief worker error');
});

async function startIcuSync() {
  const userIds = await activityRepo.listConnectedUserIds();
  const result = await reconcileSchedulers(syncQueue, icuSyncScheduler, userIds, syncJobs);
  logger.info(result, 'intervals.icu sync schedules reconciled');
  // Disabled: no athlete is connected as far as the brief is concerned, so every scheduler goes
  const briefUserIds = config.DAILY_BRIEF_ENABLED ? userIds : [];
  const brief = await reconcileDailyBriefSchedulers(
    briefQueue,
    dailyBriefScheduler,
    briefUserIds,
    briefSchedulerDeps
  );
  logger.info(brief, 'Daily brief schedules reconciled');
}

startIcuSync().catch((error: unknown) => {
  logger.error({ error }, 'Failed to reconcile intervals.icu sync schedules');
});

logger.info('Worker started and listening for jobs...');

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker...');
  await Promise.all([worker.close(), syncWorker.close(), briefWorker?.close()]);
  await Promise.all([syncQueue.close(), briefQueue.close()]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

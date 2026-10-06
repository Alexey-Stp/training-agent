import 'dotenv/config';
import { Worker, Job, Queue } from 'bullmq';
import { Bot } from 'grammy';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import {
  BLOCK_CONFIRM_COMMAND,
  BLOCK_DECLINE_COMMAND,
  CHECKIN_ANSWER_COMMAND,
  COACH_APPLY_COMMAND,
  COACH_CHAT_COMMAND,
  COACH_DISCUSS_COMMAND,
  COACH_KEEP_COMMAND,
  getConfig,
  getEncKeys,
  PROFILE_SETTINGS_QUEUE,
  SEASON_CANCEL_COMMAND,
  SEASON_CONFIRM_COMMAND,
  SEASON_PREVIEW_COMMAND,
} from '@triathlon/core';
import type {
  BlockReviewAnswer,
  CoachAnswer,
  CommandJob,
  IcuSyncJob,
  ProfileRescheduleJob,
} from '@triathlon/core';
import { IcuClient } from '@triathlon/integrations-icu';
import {
  createLlmProvider,
  DEFAULT_WEEKLY_GUARDRAIL_CONFIG,
  loadAiConfig,
  withCallLog,
  type WeeklyGuardrailConfig,
} from '@triathlon/ai';
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
  closeoutRepo,
  eveningCloseoutRunRepo,
  checkInRepo,
  weeklyStatsRepo,
  weeklyReviewRunRepo,
  raceBriefRunRepo,
  raceActivityRepo,
  raceDebriefRunRepo,
  runEffortRepo,
  blockReviewRunRepo,
  seasonReprojectRepo,
} from './db';
import {
  handleStart,
  handleProfile,
  handleSet,
  handlePlan,
  handlePlanPushCommand,
  handleLog,
  handleUnknown,
  getRulesContext,
} from './handlers';
import { handleWeekShow, MSG_WEEK_USAGE, type WeekShowDeps } from './week-command';
import { handleDashboard, type DashboardCommandDeps } from './dashboard-command';
import { processProfileReschedule } from './profile-reschedule';
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
import { handleBlockReviewAnswer, type BlockReviewAnswerDeps } from './block-review-apply';
import { handlePlanToday } from './plan-today';
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
  EVENING_CLOSEOUT_QUEUE,
  WEEKLY_STATS_QUEUE,
  WEEKLY_REVIEW_QUEUE,
  RACE_BRIEF_QUEUE,
  createRaceBriefScheduler,
  reconcileRaceBriefSchedulers,
  type RaceBriefJob,
  POST_RACE_QUEUE,
  createPostRaceScheduler,
  reconcilePostRaceSchedulers,
  type PostRaceJob,
  combineSchedulers,
  createCheckInContinuation,
  createDailyBriefScheduler,
  createEveningCloseoutScheduler,
  createWeeklyStatsScheduler,
  createWeeklyReviewScheduler,
  BLOCK_REVIEW_QUEUE,
  BLOCK_REVIEW_RACE_MOVE_JOB,
  blockReviewRaceMoveJobId,
  createBlockReviewScheduler,
  reconcileBlockReviewSchedulers,
  reconcileDailyBriefSchedulers,
  reconcileEveningCloseoutSchedulers,
  reconcileWeeklyStatsSchedulers,
  reconcileWeeklyReviewSchedulers,
  type DailyBriefJob,
  type DailyBriefSchedulerDeps,
  type EveningCloseoutJob,
  type WeeklyStatsJob,
  type WeeklyReviewJob,
} from './daily-loop/scheduler';
import { runDailyBrief, type DailyBriefDeps } from './daily-loop/pipeline';
import { runEveningCloseout, type EveningCloseoutDeps } from './daily-loop/closeout';
import { handleCheckInAnswer, type CheckInAnswerDeps } from './daily-loop/checkin-answer';
import { runWeeklyStats, type WeeklyStatsDeps } from './reviews/weekly-stats';
import { runWeeklyReviewJob, type WeeklyReviewDeps } from './reviews/weekly-review';
import { runRaceBriefJob, type RaceBriefDeps } from './races/race-brief';
import { runPostRaceJob, type PostRaceDeps } from './races/post-race';
import { fetchRaceStreams } from './races/race-streams';
import {
  runBlockReviewJob,
  type BlockReviewDeps,
  type BlockReviewJob,
} from './reviews/block-review';
import { reconcileRegistry } from './jobs/reconcile';
import { startBullBoard } from './observability/bull-board';
import { createFailureStreakTracker } from './observability/failure-streak';
import { instrumentWorker } from './observability/instrument';
import { createMetrics } from './observability/metrics';
import { closeServer, startMetricsServer } from './observability/server';

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
// Morning check-in: the brief waits for the answers at most this long
const checkInContinuation = createCheckInContinuation(
  briefQueue,
  config.DAILY_CHECKIN_TIMEOUT_MINUTES * 60_000
);
// Evening close-out: per linked athlete, one cron scheduler at the local Profile.closeoutTime
const closeoutSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.EVENING_CLOSEOUT_DEFAULT_TIME,
};
const closeoutQueue = new Queue<EveningCloseoutJob>(EVENING_CLOSEOUT_QUEUE, {
  connection: redisConnection,
});
const closeoutScheduler = createEveningCloseoutScheduler(closeoutQueue, closeoutSchedulerDeps);
// Weekly stats: per linked athlete, one cron scheduler on Mondays at the local WEEKLY_STATS_TIME
const weeklyStatsSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.WEEKLY_STATS_TIME,
};
const weeklyStatsQueue = new Queue<WeeklyStatsJob>(WEEKLY_STATS_QUEUE, {
  connection: redisConnection,
});
const weeklyStatsScheduler = createWeeklyStatsScheduler(weeklyStatsQueue, weeklyStatsSchedulerDeps);
// Weekly review: per linked athlete, one cron scheduler on Sundays at the local WEEKLY_REVIEW_TIME
const weeklyReviewSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.WEEKLY_REVIEW_TIME,
};
const weeklyReviewQueue = new Queue<WeeklyReviewJob>(WEEKLY_REVIEW_QUEUE, {
  connection: redisConnection,
});
const weeklyReviewScheduler = createWeeklyReviewScheduler(
  weeklyReviewQueue,
  weeklyReviewSchedulerDeps
);
// Block review: per linked athlete, one cron scheduler on Sundays at the local BLOCK_REVIEW_TIME;
// the job reviews only on the last day of a block. `/race move` adds one-off jobs.
const blockReviewSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.BLOCK_REVIEW_TIME,
};
const blockReviewQueue = new Queue<BlockReviewJob>(BLOCK_REVIEW_QUEUE, {
  connection: redisConnection,
});
const blockReviewScheduler = createBlockReviewScheduler(blockReviewQueue, blockReviewSchedulerDeps);
// Race briefs: per linked athlete, one daily cron scheduler at the local RACE_BRIEF_TIME; the job
// sends only when a race is 7 days (A) or 1 day (A/B/C) away
const raceBriefSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.RACE_BRIEF_TIME,
};
const raceBriefQueue = new Queue<RaceBriefJob>(RACE_BRIEF_QUEUE, {
  connection: redisConnection,
});
const raceBriefScheduler = createRaceBriefScheduler(raceBriefQueue, raceBriefSchedulerDeps);
// Post-race: per linked athlete, one daily cron scheduler at the local POST_RACE_TIME; the job
// replaces the sessions of a recovery block and debriefs the race activity
const postRaceSchedulerDeps: DailyBriefSchedulerDeps = {
  profiles: briefProfileRepo,
  defaultTime: config.POST_RACE_TIME,
};
const postRaceQueue = new Queue<PostRaceJob>(POST_RACE_QUEUE, {
  connection: redisConnection,
});
const postRaceScheduler = createPostRaceScheduler(postRaceQueue, postRaceSchedulerDeps);
const weeklyGuardrailConfig: WeeklyGuardrailConfig = {
  ...DEFAULT_WEEKLY_GUARDRAIL_CONFIG,
  maxRamp: config.WEEKLY_REVIEW_MAX_RAMP_PCT / 100,
};
const checkInAnswerDeps: CheckInAnswerDeps = {
  runs: dailyBriefRunRepo,
  wellness: checkInRepo,
  resume: (userId, date) => checkInContinuation.resume(userId, date),
};

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
const planSourceDeps: PlanSourceDeps = { seasons: seasonRepo, races: raceRepo, getRulesContext };

const seasonPublishDeps: SeasonPublishDeps = {
  seasons: seasonRepo,
  profiles: profileRepo,
  races: raceRepo,
  getRulesContext,
  store: planStoreDeps,
  push: planPushCommandDeps.push,
  windowDays: config.SEASON_PUBLISH_WINDOW_DAYS,
  now: () => new Date(),
};

const raceCommandDeps: RaceCommandDeps = {
  repo: raceRepo,
  // With block reviews off, a moved A-race is just a moved race
  activeARaceId: async (userId) =>
    config.BLOCK_REVIEW_ENABLED
      ? ((await seasonReprojectRepo.findActiveRecord(userId))?.season.aRace?.id ?? null)
      : null,
  queueBlockReview: async (userId, move) => {
    await blockReviewQueue.add(
      BLOCK_REVIEW_RACE_MOVE_JOB,
      { userId, trigger: 'race_move', ...move },
      {
        jobId: blockReviewRaceMoveJobId(userId, move.raceId, move.newDate),
        attempts: 3,
        backoff: { type: 'exponential', delay: 120_000 },
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 7 * 86400 },
      }
    );
  },
  now: () => new Date(),
};

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

const blockReviewAnswerDeps: BlockReviewAnswerDeps = {
  runs: blockReviewRunRepo,
  decisions: coachAnswerRepo,
  seasons: seasonReprojectRepo,
  // Republish the rolling window right away; the publisher writes T+1 onward only
  publish: async (userId, runId) => {
    await syncQueue.add(
      SEASON_PUBLISH_JOB,
      { userId },
      {
        jobId: `season-publish-block-${userId}-${runId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      }
    );
  },
  ttlHours: config.BLOCK_REVIEW_TTL_HOURS,
  now: () => new Date(),
};

const planReconcileDeps: PlanReconcileDeps = {
  repo: plannedSessionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  now: () => new Date(),
};

const weekShowDeps: WeekShowDeps = {
  repo: seasonRepo,
  races: raceRepo,
  getRulesContext,
  now: () => new Date(),
};

const dashboardDeps: DashboardCommandDeps = {
  baseUrl: config.DASHBOARD_BASE_URL,
  secret: config.DASHBOARD_LINK_SECRET,
  ttlMinutes: config.DASHBOARD_LINK_TTL_MINUTES,
  now: () => new Date(),
};

// Coach chat: one LLM provider for the worker, every call logged to LlmCallLog
const aiConfig = loadAiConfig();
const llmProvider = withCallLog(createLlmProvider(aiConfig), llmCallLogRepo, { logger });
const redis = new Redis(redisConnection);

// Job platform (TA-51): per-job metrics and the daily-brief failure-streak alert
const metrics = createMetrics();
if (config.ADMIN_TELEGRAM_ID === undefined) {
  logger.warn('ADMIN_TELEGRAM_ID is not set: daily brief failure alerts are off');
}
const briefFailureStreak = createFailureStreakTracker({
  redis,
  adminChatId: config.ADMIN_TELEGRAM_ID,
  threshold: config.BRIEF_FAILURE_ALERT_THRESHOLD,
  sendMessage: (chatId, text) => api.sendMessage(chatId, text),
  logger,
});

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
  chats: coachChatRepo,
  getRulesContext,
  push: planPushCommandDeps.push,
  onPushError: (error, userId) => {
    logger.error({ error, userId }, 'Failed to push applied coach changes');
  },
  weeklyGuardrailConfig,
  ttlHours: config.COACH_DECISION_TTL_HOURS,
  now: () => new Date(),
};

// Every per-connection scheduler: registered on /connect icu and after a dashboard settings change
const athleteSchedulers = combineSchedulers(
  icuSyncScheduler,
  ...(config.DAILY_BRIEF_ENABLED ? [dailyBriefScheduler] : []),
  ...(config.EVENING_CLOSEOUT_ENABLED ? [closeoutScheduler] : []),
  ...(config.WEEKLY_STATS_ENABLED ? [weeklyStatsScheduler] : []),
  ...(config.WEEKLY_REVIEW_ENABLED ? [weeklyReviewScheduler] : []),
  ...(config.BLOCK_REVIEW_ENABLED ? [blockReviewScheduler] : []),
  ...(config.RACE_BRIEF_ENABLED ? [raceBriefScheduler] : []),
  ...(config.POST_RACE_ENABLED ? [postRaceScheduler] : [])
);

const icuConnectDeps: IcuConnectDeps = {
  repo: icuConnectionRepo,
  keys: encKeys,
  createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
  scheduler: athleteSchedulers,
  onSchedulerError: (error, userId) => {
    logger.error({ error, userId }, 'Failed to update intervals.icu sync schedule');
  },
};

// Create worker
type WorkerUser = Awaited<ReturnType<typeof ensureUser>>;

/** `/plan`, `/plan today` and `/plan push` */
function planCommand(user: WorkerUser, sub: string | undefined): Promise<Reply> {
  if (sub === 'push') return handlePlanPushCommand(user, planPushCommandDeps, planSourceDeps);
  if (sub === 'today') return handlePlanToday(user, planStoreDeps);
  return handlePlan(user, planStoreDeps, planSourceDeps);
}

function coachAnswer(
  user: WorkerUser,
  decisionId: string | undefined,
  answer: CoachAnswer,
  telegramMessageId: number
): Promise<Reply> {
  return handleCoachAnswer(user, { decisionId, answer, telegramMessageId }, coachAnswerDeps);
}

function blockAnswer(
  user: WorkerUser,
  runId: string | undefined,
  answer: BlockReviewAnswer
): Promise<Reply> {
  return handleBlockReviewAnswer(user, { runId, answer }, blockReviewAnswerDeps);
}

/**
 * Sends the reply, or replaces the tapped message with it (`editTapped`, e.g. a morning
 * brief with the Apply result). A failed edit falls back to a new message.
 */
async function sendReply(chatId: number, messageId: number, reply: Reply): Promise<void> {
  const message = toTelegramMessage(reply);
  if (typeof reply !== 'string' && reply.editTapped) {
    try {
      await api.editMessageText(chatId, messageId, message.text, message.options);
      return;
    } catch (error) {
      logger.warn({ error, chatId, messageId }, 'Could not edit the tapped message, sending');
    }
  }
  await api.sendMessage(chatId, message.text, message.options);
}

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

      // Check-in taps skip the ProcessedMessage check: both questions sit on one message, so
      // the second answer has the same messageId. The write itself is idempotent (first wins).
      if (commandName === CHECKIN_ANSWER_COMMAND) {
        const reply = await handleCheckInAnswer(
          user.id,
          { args, telegramMessageId: messageId },
          checkInAnswerDeps
        );
        await sendReply(telegramChatId, messageId, reply);
        return;
      }

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
          response = await handleSet(user, args);
          break;

        case 'plan':
          response = await planCommand(user, args[0]?.toLowerCase());
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

        case 'dashboard':
          response = handleDashboard(user.id, dashboardDeps);
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

        // Apply / Keep plan / Discuss buttons under a morning brief or a coach-chat suggestion
        case COACH_APPLY_COMMAND:
          response = await coachAnswer(user, args[0], 'apply', messageId);
          break;

        case COACH_KEEP_COMMAND:
          response = await coachAnswer(user, args[0], 'keep', messageId);
          break;

        case COACH_DISCUSS_COMMAND:
          response = await coachAnswer(user, args[0], 'discuss', messageId);
          break;

        // Confirm / Decline under a block review's re-projection
        case BLOCK_CONFIRM_COMMAND:
          response = await blockAnswer(user, args[0], 'confirm');
          break;

        case BLOCK_DECLINE_COMMAND:
          response = await blockAnswer(user, args[0], 'decline');
          break;

        case 'unknown':
        default:
          response = handleUnknown();
          break;
      }

      await sendReply(telegramChatId, messageId, response);

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

metrics.observeWorker(worker, 'commands');

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

instrumentWorker(syncWorker, {
  queue: ICU_SYNC_QUEUE,
  label: 'intervals.icu sync',
  logger,
  metrics,
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
  scheduleCheckInTimeout: (userId, date) => checkInContinuation.schedule(userId, date),
  logger,
  now: () => new Date(),
};

const briefWorker = config.DAILY_BRIEF_ENABLED
  ? new Worker<DailyBriefJob>(
      DAILY_BRIEF_QUEUE,
      (job: Job<DailyBriefJob>) =>
        runDailyBrief(job.data.userId, dailyBriefDeps, { checkInDate: job.data.checkInDate }),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (briefWorker) {
  instrumentWorker(briefWorker, {
    queue: DAILY_BRIEF_QUEUE,
    label: 'Daily brief',
    logger,
    metrics,
    streak: briefFailureStreak,
  });
}

const closeoutDeps: EveningCloseoutDeps = {
  runs: eveningCloseoutRunRepo,
  profiles: briefProfileRepo,
  closeout: closeoutRepo,
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  deviationThresholdPct: config.CLOSEOUT_DEVIATION_THRESHOLD_PCT,
  logger,
  now: () => new Date(),
};

const closeoutWorker = config.EVENING_CLOSEOUT_ENABLED
  ? new Worker<EveningCloseoutJob>(
      EVENING_CLOSEOUT_QUEUE,
      (job: Job<EveningCloseoutJob>) => runEveningCloseout(job.data.userId, closeoutDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (closeoutWorker) {
  instrumentWorker(closeoutWorker, {
    queue: EVENING_CLOSEOUT_QUEUE,
    label: 'Evening close-out',
    logger,
    metrics,
  });
}

const weeklyStatsDeps: WeeklyStatsDeps = {
  profiles: briefProfileRepo,
  repo: weeklyStatsRepo,
  logger,
  now: () => new Date(),
};

const weeklyStatsWorker = config.WEEKLY_STATS_ENABLED
  ? new Worker<WeeklyStatsJob>(
      WEEKLY_STATS_QUEUE,
      (job: Job<WeeklyStatsJob>) =>
        runWeeklyStats(job.data.userId, weeklyStatsDeps, job.data.isoWeek),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (weeklyStatsWorker) {
  instrumentWorker(weeklyStatsWorker, {
    queue: WEEKLY_STATS_QUEUE,
    label: 'Weekly stats',
    logger,
    metrics,
  });
}

const weeklyReviewDeps: WeeklyReviewDeps = {
  runs: weeklyReviewRunRepo,
  profiles: briefProfileRepo,
  stats: weeklyStatsRepo,
  seasons: seasonRepo,
  planned: plannedSessionRepo,
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  getRulesContext,
  provider: llmProvider,
  decisions: coachDecisionRepo,
  guardrailConfig: weeklyGuardrailConfig,
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  logger,
  now: () => new Date(),
};

const weeklyReviewWorker = config.WEEKLY_REVIEW_ENABLED
  ? new Worker<WeeklyReviewJob>(
      WEEKLY_REVIEW_QUEUE,
      (job: Job<WeeklyReviewJob>) => runWeeklyReviewJob(job.data.userId, weeklyReviewDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (weeklyReviewWorker) {
  instrumentWorker(weeklyReviewWorker, {
    queue: WEEKLY_REVIEW_QUEUE,
    label: 'Weekly review',
    logger,
    metrics,
  });
}

const raceBriefDeps: RaceBriefDeps = {
  runs: raceBriefRunRepo,
  profiles: briefProfileRepo,
  races: raceRepo,
  planned: plannedSessionRepo,
  getFtp: async (userId) => (await profileRepo.findProfile(userId))?.ftp ?? null,
  runEfforts: runEffortRepo,
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  provider: llmProvider,
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  logger,
  now: () => new Date(),
};

const raceBriefWorker = config.RACE_BRIEF_ENABLED
  ? new Worker<RaceBriefJob>(
      RACE_BRIEF_QUEUE,
      (job: Job<RaceBriefJob>) => runRaceBriefJob(job.data.userId, raceBriefDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (raceBriefWorker) {
  instrumentWorker(raceBriefWorker, {
    queue: RACE_BRIEF_QUEUE,
    label: 'Race brief',
    logger,
    metrics,
  });
}

const postRaceDeps: PostRaceDeps = {
  runs: raceDebriefRunRepo,
  profiles: briefProfileRepo,
  races: raceRepo,
  store: planStoreDeps,
  push: planPushCommandDeps.push,
  activities: raceActivityRepo,
  getFtp: async (userId) => (await profileRepo.findProfile(userId))?.ftp ?? null,
  runEfforts: runEffortRepo,
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  getStreams: (userId, activityIcuId) =>
    fetchRaceStreams(userId, activityIcuId, {
      findConnection: (id) => activityRepo.findConnection(id),
      keys: encKeys,
      createClient: (athleteId, apiKey) => new IcuClient({ athleteId, apiKey }),
    }),
  provider: llmProvider,
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  debriefTimeoutHours: config.RACE_DEBRIEF_TIMEOUT_HOURS,
  logger,
  now: () => new Date(),
};

const postRaceWorker = config.POST_RACE_ENABLED
  ? new Worker<PostRaceJob>(
      POST_RACE_QUEUE,
      (job: Job<PostRaceJob>) => runPostRaceJob(job.data.userId, postRaceDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (postRaceWorker) {
  instrumentWorker(postRaceWorker, {
    queue: POST_RACE_QUEUE,
    label: 'Post-race',
    logger,
    metrics,
  });
}

const blockReviewDeps: BlockReviewDeps = {
  runs: blockReviewRunRepo,
  profiles: briefProfileRepo,
  stats: weeklyStatsRepo,
  seasons: seasonReprojectRepo,
  syncActivities: (userId) => syncActivities(userId, activitySyncDeps),
  loadTrainingHours,
  provider: llmProvider,
  decisions: coachDecisionRepo,
  config: { thresholdPct: config.BLOCK_REVIEW_REPROJECT_THRESHOLD_PCT },
  sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
  logger,
  now: () => new Date(),
};

const blockReviewWorker = config.BLOCK_REVIEW_ENABLED
  ? new Worker<BlockReviewJob>(
      BLOCK_REVIEW_QUEUE,
      (job: Job<BlockReviewJob>) => runBlockReviewJob(job.data, blockReviewDeps),
      { connection: redisConnection, concurrency: 2 }
    )
  : null;

if (blockReviewWorker) {
  instrumentWorker(blockReviewWorker, {
    queue: BLOCK_REVIEW_QUEUE,
    label: 'Block review',
    logger,
    metrics,
  });
}

const profileSettingsQueue = new Queue<ProfileRescheduleJob>(PROFILE_SETTINGS_QUEUE, {
  connection: redisConnection,
});

// Dashboard settings changes (TA-54): re-register the athlete's schedulers
const profileSettingsWorker = new Worker<ProfileRescheduleJob>(
  PROFILE_SETTINGS_QUEUE,
  async (job: Job<ProfileRescheduleJob>) => {
    const result = await processProfileReschedule(job.data, {
      connections: icuConnectionRepo,
      scheduler: athleteSchedulers,
    });
    logger.info({ jobId: job.id, userId: job.data.userId, ...result }, 'Profile settings applied');
    return result;
  },
  { connection: redisConnection, concurrency: 2 }
);

instrumentWorker(profileSettingsWorker, {
  queue: PROFILE_SETTINGS_QUEUE,
  label: 'Profile settings',
  logger,
  metrics,
});

const registryQueues = {
  [ICU_SYNC_QUEUE]: syncQueue,
  [DAILY_BRIEF_QUEUE]: briefQueue,
  [EVENING_CLOSEOUT_QUEUE]: closeoutQueue,
  [WEEKLY_STATS_QUEUE]: weeklyStatsQueue,
  [WEEKLY_REVIEW_QUEUE]: weeklyReviewQueue,
  [BLOCK_REVIEW_QUEUE]: blockReviewQueue,
  [RACE_BRIEF_QUEUE]: raceBriefQueue,
  [POST_RACE_QUEUE]: postRaceQueue,
  [PROFILE_SETTINGS_QUEUE]: profileSettingsQueue,
};

const servers: Server[] = [];

async function startObservability() {
  if (config.METRICS_ENABLED) {
    servers.push(await startMetricsServer(metrics.registry, config.METRICS_PORT));
    logger.info({ port: config.METRICS_PORT }, 'Metrics server listening on /metrics');
  }
  if (config.BULL_BOARD_ENABLED) {
    const commandsQueue = new Queue('commands', { connection: redisConnection });
    boardQueues.push(commandsQueue);
    servers.push(
      await startBullBoard(
        [commandsQueue, ...Object.values(registryQueues)],
        config.BULL_BOARD_PORT
      )
    );
    logger.info({ port: config.BULL_BOARD_PORT }, 'Bull Board listening on /admin/queues');
  }
}

const boardQueues: Queue[] = [];

async function startIcuSync() {
  // Delete schedulers whose job is no longer in the registry, then repair the known ones
  const orphans = await reconcileRegistry(registryQueues);
  logger.info(orphans, 'Job registry reconciled');
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
  const closeout = await reconcileEveningCloseoutSchedulers(
    closeoutQueue,
    closeoutScheduler,
    config.EVENING_CLOSEOUT_ENABLED ? userIds : [],
    closeoutSchedulerDeps
  );
  logger.info(closeout, 'Evening close-out schedules reconciled');
  const weekly = await reconcileWeeklyStatsSchedulers(
    weeklyStatsQueue,
    weeklyStatsScheduler,
    config.WEEKLY_STATS_ENABLED ? userIds : [],
    weeklyStatsSchedulerDeps
  );
  logger.info(weekly, 'Weekly stats schedules reconciled');
  const review = await reconcileWeeklyReviewSchedulers(
    weeklyReviewQueue,
    weeklyReviewScheduler,
    config.WEEKLY_REVIEW_ENABLED ? userIds : [],
    weeklyReviewSchedulerDeps
  );
  logger.info(review, 'Weekly review schedules reconciled');
  const block = await reconcileBlockReviewSchedulers(
    blockReviewQueue,
    blockReviewScheduler,
    config.BLOCK_REVIEW_ENABLED ? userIds : [],
    blockReviewSchedulerDeps
  );
  logger.info(block, 'Block review schedules reconciled');
  const raceBrief = await reconcileRaceBriefSchedulers(
    raceBriefQueue,
    raceBriefScheduler,
    config.RACE_BRIEF_ENABLED ? userIds : [],
    raceBriefSchedulerDeps
  );
  logger.info(raceBrief, 'Race brief schedules reconciled');
  const postRace = await reconcilePostRaceSchedulers(
    postRaceQueue,
    postRaceScheduler,
    config.POST_RACE_ENABLED ? userIds : [],
    postRaceSchedulerDeps
  );
  logger.info(postRace, 'Post-race schedules reconciled');
}

startObservability().catch((error: unknown) => {
  logger.error({ error }, 'Failed to start the metrics server or Bull Board');
});

startIcuSync().catch((error: unknown) => {
  logger.error({ error }, 'Failed to reconcile intervals.icu sync schedules');
});

logger.info('Worker started and listening for jobs...');

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker...');
  await Promise.all([
    worker.close(),
    syncWorker.close(),
    briefWorker?.close(),
    closeoutWorker?.close(),
    weeklyStatsWorker?.close(),
    weeklyReviewWorker?.close(),
    blockReviewWorker?.close(),
    raceBriefWorker?.close(),
    postRaceWorker?.close(),
    profileSettingsWorker.close(),
  ]);
  await Promise.all(servers.map((server) => closeServer(server)));
  await Promise.all([
    ...boardQueues.map((queue) => queue.close()),
    syncQueue.close(),
    briefQueue.close(),
    closeoutQueue.close(),
    weeklyStatsQueue.close(),
    weeklyReviewQueue.close(),
    blockReviewQueue.close(),
    raceBriefQueue.close(),
    postRaceQueue.close(),
    profileSettingsQueue.close(),
  ]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

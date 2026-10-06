import { UnrecoverableError } from 'bullmq';

/** The ioredis calls the tracker uses, so tests can inject an in-memory fake */
export interface StreakRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
}

export interface StreakLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** The slice of a failed BullMQ job the tracker needs */
export interface StreakJob {
  data: { userId?: string };
  attemptsMade: number;
  opts: { attempts?: number };
}

export interface FailureStreakDeps {
  redis: StreakRedis;
  /** Chat that gets the alert; undefined turns the alert off (the streak is still tracked) */
  adminChatId: number | undefined;
  threshold: number;
  sendMessage: (chatId: number, text: string) => Promise<unknown>;
  logger: StreakLogger;
}

/** Bounds a streak that nobody resets, e.g. for a user who disconnected */
const STREAK_TTL_SECONDS = 7 * 24 * 3600;
const MAX_ERROR_CHARS = 300;

export function streakKey(userId: string): string {
  return 'brief:fail-streak:' + userId;
}

export function alertedKey(userId: string): string {
  return 'brief:fail-alerted:' + userId;
}

/** BullMQ emits `failed` per attempt; a failure counts only when no retry is left */
export function isFinalFailure(job: StreakJob, error: Error): boolean {
  if (error instanceof UnrecoverableError) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

function alertText(userId: string, failures: number, error: Error): string {
  const reason = error.message.slice(0, MAX_ERROR_CHARS);
  return [
    '⚠️ Daily brief keeps failing',
    'User: ' + userId,
    'Consecutive failures: ' + failures,
    'Last error: ' + reason,
  ].join('\n');
}

export interface FailureStreakTracker {
  /** Call for every `failed` event of the daily-brief queue */
  recordFailure(job: StreakJob, error: Error): Promise<void>;
  /** Call for every `completed` event: ends the streak and the incident */
  recordSuccess(userId: string): Promise<void>;
}

/**
 * Counts consecutive final daily-brief failures per user in Redis. When the count reaches the
 * threshold, the admin gets one message; `SET NX` makes that once per incident, and a success
 * clears both keys so the next incident can alert again.
 */
export function createFailureStreakTracker(deps: FailureStreakDeps): FailureStreakTracker {
  async function alertOnce(userId: string, failures: number, error: Error): Promise<void> {
    const { adminChatId } = deps;
    if (adminChatId === undefined) return;
    const claimed = await deps.redis.set(alertedKey(userId), '1', 'EX', STREAK_TTL_SECONDS, 'NX');
    if (claimed !== 'OK') return;
    try {
      await deps.sendMessage(adminChatId, alertText(userId, failures, error));
      deps.logger.info({ userId, failures }, 'Daily brief failure alert sent');
    } catch (sendError) {
      // Release the claim so the next failure retries the alert instead of losing it
      await deps.redis.del(alertedKey(userId));
      deps.logger.warn({ userId, error: sendError }, 'Daily brief failure alert not sent');
    }
  }

  return {
    async recordFailure(job, error) {
      const userId = job.data.userId;
      if (!userId || !isFinalFailure(job, error)) return;
      const failures = await deps.redis.incr(streakKey(userId));
      await deps.redis.expire(streakKey(userId), STREAK_TTL_SECONDS);
      if (failures >= deps.threshold) await alertOnce(userId, failures, error);
    },
    async recordSuccess(userId) {
      await deps.redis.del(streakKey(userId), alertedKey(userId));
    },
  };
}

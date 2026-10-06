import { z } from 'zod';
import { isValidEncKey, parseEncKey } from './crypto';

const encKeySchema = z
  .string()
  .refine(isValidEncKey, 'must be base64 of 32 bytes (openssl rand -base64 32)');

/** `HH:mm`, 24h: Profile.briefTime/closeoutTime and their *_DEFAULT_TIME */
export const BRIEF_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DEFAULT_TIMEZONE: z.string().default('Europe/Prague'),
  SECRETS_ENC_KEY: encKeySchema,
  SECRETS_ENC_KEY_PREVIOUS: encKeySchema.optional(),
  // intervals.icu activity sync (worker icu-sync queue)
  ICU_ACTIVITY_SYNC_EVERY_MIN: z.coerce.number().int().positive().default(30),
  ICU_ACTIVITY_BACKFILL_DAYS: z.coerce.number().int().positive().default(90),
  ICU_ACTIVITY_SYNC_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(2),
  // intervals.icu wellness sync (same queue, daily by default)
  ICU_WELLNESS_SYNC_EVERY_MIN: z.coerce.number().int().positive().default(1440),
  ICU_WELLNESS_BACKFILL_DAYS: z.coerce.number().int().positive().default(90),
  ICU_WELLNESS_SYNC_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(3),
  // intervals.icu planned-workout reconcile: detects events the athlete moved/edited in ICU
  ICU_PLAN_RECONCILE_EVERY_MIN: z.coerce.number().int().positive().default(60),
  // Season rolling publisher: keeps the next N local days of the active season pushed to ICU
  SEASON_PUBLISH_EVERY_MIN: z.coerce.number().int().positive().default(360),
  SEASON_PUBLISH_WINDOW_DAYS: z.coerce.number().int().min(1).max(28).default(14),
  // Free-form coach chat: messages per athlete per local day before the limit notice
  COACH_CHAT_DAILY_LIMIT: z.coerce.number().int().positive().default(30),
  // Apply/Keep/Discuss buttons on a brief or chat suggestion stop working after this many hours
  COACH_DECISION_TTL_HOURS: z.coerce.number().positive().default(24),
  // Morning brief: one pipeline run per linked athlete at Profile.briefTime (local time)
  DAILY_BRIEF_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DAILY_BRIEF_DEFAULT_TIME: z.string().regex(BRIEF_TIME_RE, 'must be HH:mm (24h)').default('06:30'),
  // Morning check-in: minutes the brief waits for readiness/soreness answers before it goes out
  DAILY_CHECKIN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(15),
  // Evening close-out: matches the day's activities to the plan at Profile.closeoutTime (local)
  EVENING_CLOSEOUT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  EVENING_CLOSEOUT_DEFAULT_TIME: z
    .string()
    .regex(BRIEF_TIME_RE, 'must be HH:mm (24h)')
    .default('20:30'),
  // A matched session whose duration is off by more than this many percent gets a close-out note
  CLOSEOUT_DEVIATION_THRESHOLD_PCT: z.coerce.number().positive().default(25),
  // Weekly stats: every Monday at this local time, planned vs actual of the previous ISO week
  WEEKLY_STATS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WEEKLY_STATS_TIME: z.string().regex(BRIEF_TIME_RE, 'must be HH:mm (24h)').default('06:00'),
  // Weekly review: every Sunday at this local time, an AI review of the week with next-week changes
  WEEKLY_REVIEW_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WEEKLY_REVIEW_TIME: z.string().regex(BRIEF_TIME_RE, 'must be HH:mm (24h)').default('19:00'),
  // Next-week changes may add at most this % to next week's planned minutes (catch-up ramp cap)
  WEEKLY_REVIEW_MAX_RAMP_PCT: z.coerce.number().min(0).max(50).default(8),
  // Block review: on the last day of a training block (a Sunday), at this local time, a verdict
  // against the block targets and, when needed, a re-projection of the remaining blocks
  BLOCK_REVIEW_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BLOCK_REVIEW_TIME: z.string().regex(BRIEF_TIME_RE, 'must be HH:mm (24h)').default('19:30'),
  // Volume achieved outside 100 ± this % always proposes a re-projection, whatever the AI says
  BLOCK_REVIEW_REPROJECT_THRESHOLD_PCT: z.coerce.number().min(0).max(50).default(15),
  // Confirm/Decline buttons of a block review stop working after this many hours
  BLOCK_REVIEW_TTL_HOURS: z.coerce.number().positive().default(72),
  // Race briefs: at this local time, A-races get a T-7 overview + checklist and a T-1 pacing brief,
  // B/C races only the shorter T-1 brief
  RACE_BRIEF_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RACE_BRIEF_TIME: z.string().regex(BRIEF_TIME_RE, 'must be HH:mm (24h)').default('09:00'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:', result.error.format());
    throw new Error('Invalid environment configuration');
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function getConfig(): EnvConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/**
 * Encryption keyring for stored secrets: current key first (used for encrypt),
 * then the previous key (decrypt-only) during a rotation.
 */
export function getEncKeys(config: EnvConfig = getConfig()): Buffer[] {
  const keys = [parseEncKey(config.SECRETS_ENC_KEY)];
  if (config.SECRETS_ENC_KEY_PREVIOUS) {
    keys.push(parseEncKey(config.SECRETS_ENC_KEY_PREVIOUS));
  }
  return keys;
}

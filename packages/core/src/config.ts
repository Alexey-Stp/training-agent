import { z } from 'zod';
import { isValidEncKey, parseEncKey } from './crypto';

const encKeySchema = z
  .string()
  .refine(isValidEncKey, 'must be base64 of 32 bytes (openssl rand -base64 32)');

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

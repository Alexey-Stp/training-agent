import { format } from 'date-fns';
import { decryptSecret, maskSecret, SecretDecryptError } from '@triathlon/core';
import type { IcuCredentialsPayload } from '@triathlon/core';
import {
  IcuAuthError,
  IcuHttpError,
  IcuRateLimitError,
  IcuServerError,
} from '@triathlon/integrations-icu';
import type { IcuClient } from '@triathlon/integrations-icu';

export interface IcuConnectionRecord {
  userId: string;
  icuAthleteId: string;
  icuAthleteName: string | null;
  apiKeyCiphertext: string;
  apiKeyIv: string;
  lastActivitySyncAt: Date | null;
  lastWellnessSyncAt: Date | null;
}

export interface IcuConnectionUpsert {
  userId: string;
  icuAthleteId: string;
  icuAthleteName: string;
  apiKeyCiphertext: string;
  apiKeyIv: string;
}

export interface IcuConnectionRepo {
  /** One connection per user: re-linking overwrites the previous credentials. */
  upsert(data: IcuConnectionUpsert): Promise<void>;
  findByUserId(userId: string): Promise<IcuConnectionRecord | null>;
  /** Returns true if a connection was deleted. */
  deleteByUserId(userId: string): Promise<boolean>;
}

export interface IcuConnectDeps {
  repo: IcuConnectionRepo;
  /** Decryption keyring: current key first, then previous (see core getEncKeys). */
  keys: Buffer[];
  createClient(athleteId: string, apiKey: string): Pick<IcuClient, 'getAthlete'>;
}

export const MSG_INVALID_CREDENTIALS =
  '❌ intervals.icu rejected those credentials. Check your athlete ID and API key, then run /connect icu again.\n\nNothing was saved.';
export const MSG_ATHLETE_NOT_FOUND =
  '❌ intervals.icu could not find that athlete for this API key. Check the athlete ID, then run /connect icu again.\n\nNothing was saved.';
export const MSG_ICU_UNAVAILABLE =
  '⚠️ intervals.icu is not responding right now. Please try /connect icu again later.\n\nNothing was saved.';
export const MSG_CREDENTIALS_UNREADABLE =
  '❌ Could not read the submitted credentials. Please run /connect icu again.';
export const MSG_NOT_CONNECTED =
  'intervals.icu is not connected. Use /connect icu to link your account.';

/**
 * Validates submitted credentials with getAthlete and stores them on success.
 * Credential problems return a friendly reply instead of throwing, so BullMQ
 * doesn't retry a request that will keep failing. Unexpected errors still throw.
 */
export async function handleConnectIcu(
  userId: string,
  creds: IcuCredentialsPayload,
  deps: IcuConnectDeps
): Promise<string> {
  let apiKey: string;
  try {
    apiKey = decryptSecret({ ciphertext: creds.apiKeyCiphertext, iv: creds.apiKeyIv }, deps.keys);
  } catch (error) {
    if (error instanceof SecretDecryptError) return MSG_CREDENTIALS_UNREADABLE;
    throw error;
  }

  let athleteName: string;
  try {
    const athlete = await deps.createClient(creds.athleteId, apiKey).getAthlete();
    athleteName = athlete.name;
  } catch (error) {
    if (error instanceof IcuAuthError) return MSG_INVALID_CREDENTIALS;
    if (error instanceof IcuHttpError && (error.status === 403 || error.status === 404)) {
      return MSG_ATHLETE_NOT_FOUND;
    }
    if (error instanceof IcuRateLimitError || error instanceof IcuServerError) {
      return MSG_ICU_UNAVAILABLE;
    }
    throw error;
  }

  await deps.repo.upsert({
    userId,
    icuAthleteId: creds.athleteId,
    icuAthleteName: athleteName,
    apiKeyCiphertext: creds.apiKeyCiphertext,
    apiKeyIv: creds.apiKeyIv,
  });

  return `✅ Connected to intervals.icu as ${athleteName} (${creds.athleteId}).\n\nUse /connect status to check the link or /disconnect icu to remove it.`;
}

function formatSyncTime(date: Date | null): string {
  return date ? format(date, 'PPP p') : 'never';
}

export async function handleConnectStatus(userId: string, deps: IcuConnectDeps): Promise<string> {
  const conn = await deps.repo.findByUserId(userId);
  if (!conn) return MSG_NOT_CONNECTED;

  let maskedKey: string;
  try {
    maskedKey = maskSecret(
      decryptSecret({ ciphertext: conn.apiKeyCiphertext, iv: conn.apiKeyIv }, deps.keys)
    );
  } catch (error) {
    if (!(error instanceof SecretDecryptError)) throw error;
    maskedKey = '•••••••• (unreadable, run /connect icu again)';
  }

  return `🔗 intervals.icu connection

👤 Athlete: ${conn.icuAthleteName ?? 'unknown'} (${conn.icuAthleteId})
🔑 API key: ${maskedKey}
🏃 Last activity sync: ${formatSyncTime(conn.lastActivitySyncAt)}
💤 Last wellness sync: ${formatSyncTime(conn.lastWellnessSyncAt)}`;
}

export async function handleDisconnectIcu(userId: string, deps: IcuConnectDeps): Promise<string> {
  const deleted = await deps.repo.deleteByUserId(userId);
  return deleted
    ? '✅ intervals.icu disconnected. Your stored API key was deleted.'
    : MSG_NOT_CONNECTED;
}

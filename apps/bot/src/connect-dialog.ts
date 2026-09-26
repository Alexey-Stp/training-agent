import type Redis from 'ioredis';
import { encryptSecret } from '@triathlon/core';
import type { IcuCredentialsPayload } from '@triathlon/core';
import { parseCommand } from './parser';

/**
 * Two-step /connect icu dialog (athlete ID, then API key).
 *
 * It runs in the bot rather than the worker so the plaintext API key never
 * enters the BullMQ payload in Redis: the key is encrypted here and only the
 * ciphertext is enqueued. Dialog state holds the athlete ID only.
 */

export type DialogState = { step: 'athleteId' } | { step: 'apiKey'; athleteId: string };

export interface DialogStore {
  get(telegramUserId: number): Promise<DialogState | null>;
  set(telegramUserId: number, state: DialogState): Promise<void>;
  delete(telegramUserId: number): Promise<void>;
}

export type DialogOutcome =
  /** Not part of the dialog: continue with the normal enqueue path. */
  | { kind: 'pass' }
  /** Handled by the dialog: reply with this text, don't enqueue. */
  | { kind: 'reply'; text: string }
  /** Dialog complete: delete the user's key message and enqueue a connect_icu job. */
  | { kind: 'submit'; credentials: IcuCredentialsPayload };

export const DIALOG_TTL_SECONDS = 600;

const ATHLETE_ID_RE = /^i?(\d{1,12})$/i;
const API_KEY_RE = /^\S{8,256}$/;

export const PROMPT_ATHLETE_ID =
  '🔗 Connecting intervals.icu.\n\n' +
  'Send your athlete ID. Find it in intervals.icu → Settings → Developer Settings (e.g. i12345).\n\n' +
  'Send /cancel to stop.';

export const PROMPT_API_KEY =
  '🔑 Now send your API key (same page, "API Key").\n\n' +
  'I will delete your message right away and store the key encrypted.';

export const INVALID_ATHLETE_ID =
  '❌ That does not look like an athlete ID. It should look like i12345. Try again or send /cancel.';

export const INVALID_API_KEY =
  '❌ That does not look like an API key. Send the key exactly as shown, or send /cancel.';

export const CANCELLED = 'Cancelled. Your intervals.icu account was not changed.';

export async function handleConnectDialog(
  telegramUserId: number,
  text: string,
  store: DialogStore,
  encKey: Buffer
): Promise<DialogOutcome> {
  const trimmed = text.trim();

  if (trimmed.startsWith('/')) {
    const { commandName, args } = parseCommand(trimmed);

    if (commandName === 'connect' && args[0]?.toLowerCase() === 'icu') {
      await store.set(telegramUserId, { step: 'athleteId' });
      return { kind: 'reply', text: PROMPT_ATHLETE_ID };
    }

    const state = await store.get(telegramUserId);
    if (commandName === 'cancel' && state) {
      await store.delete(telegramUserId);
      return { kind: 'reply', text: CANCELLED };
    }

    // Any other command abandons an in-progress dialog.
    if (state) {
      await store.delete(telegramUserId);
    }
    return { kind: 'pass' };
  }

  const state = await store.get(telegramUserId);
  if (!state) {
    return { kind: 'pass' };
  }

  if (state.step === 'athleteId') {
    const match = ATHLETE_ID_RE.exec(trimmed);
    if (!match) {
      return { kind: 'reply', text: INVALID_ATHLETE_ID };
    }
    await store.set(telegramUserId, { step: 'apiKey', athleteId: `i${match[1]}` });
    return { kind: 'reply', text: PROMPT_API_KEY };
  }

  if (!API_KEY_RE.test(trimmed)) {
    return { kind: 'reply', text: INVALID_API_KEY };
  }

  const encrypted = encryptSecret(trimmed, encKey);
  await store.delete(telegramUserId);
  return {
    kind: 'submit',
    credentials: {
      athleteId: state.athleteId,
      apiKeyCiphertext: encrypted.ciphertext,
      apiKeyIv: encrypted.iv,
    },
  };
}

export class RedisDialogStore implements DialogStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = DIALOG_TTL_SECONDS
  ) {}

  private key(telegramUserId: number): string {
    return `icu-connect:${telegramUserId.toString()}`;
  }

  async get(telegramUserId: number): Promise<DialogState | null> {
    const raw = await this.redis.get(this.key(telegramUserId));
    return raw ? (JSON.parse(raw) as DialogState) : null;
  }

  async set(telegramUserId: number, state: DialogState): Promise<void> {
    await this.redis.set(this.key(telegramUserId), JSON.stringify(state), 'EX', this.ttlSeconds);
  }

  async delete(telegramUserId: number): Promise<void> {
    await this.redis.del(this.key(telegramUserId));
  }
}

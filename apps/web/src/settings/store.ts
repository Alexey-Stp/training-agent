import type { ProfileSettings } from './validate';

/** The athlete's settings plus the read-only Telegram identity shown next to the chat field. */
export interface SettingsView extends Omit<
  ProfileSettings,
  'bikeVo2Day' | 'longBikeDay' | 'noLongRunDay'
> {
  bikeVo2Day: string;
  longBikeDay: string;
  noLongRunDay: string;
  telegramId: string;
}

/** Profile read/write, always by the session's userId. The only write path of the web app. */
export interface SettingsRepo {
  load(userId: string): Promise<SettingsView | null>;
  save(userId: string, settings: ProfileSettings): Promise<void>;
}

/** Checks that the bot can post to a chat (and posts a confirmation there). */
export interface ChatVerifier {
  verify(chatId: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** Tells the worker that the athlete's schedules must be re-read. */
export interface ProfileEvents {
  changed(userId: string): Promise<void>;
}

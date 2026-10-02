import type Redis from 'ioredis';
import {
  isWeakSportChoice,
  parseWeeklyHours,
  SEASON_MAX_WEEKLY_HOURS,
  SEASON_MIN_WEEKLY_HOURS,
  type WeakSportChoice,
} from '@triathlon/core';
import { DIALOG_TTL_SECONDS } from './connect-dialog';
import { parseCommand } from './parser';
import { RedisStateStore, type StateStore } from './state-store';

/**
 * `/season new` wizard: weekly hours, then weak sport, both as inline buttons (typed answers
 * work too). The answers are submitted as one season_preview job; the worker generates the
 * season and replies with the block table and confirm/cancel buttons.
 */

export type SeasonDialogState = { step: 'hours' } | { step: 'weakSport'; hours: number };

export type SeasonDialogStore = StateStore<SeasonDialogState>;

export type SeasonDialogEvent = { kind: 'text'; text: string } | { kind: 'callback'; data: string };

export interface KeyboardButton {
  text: string;
  data: string;
}

export type SeasonDialogOutcome =
  /** Not part of the wizard */
  | { kind: 'pass' }
  /** Show this text (and buttons); for a button tap, in place of the wizard message */
  | { kind: 'reply'; text: string; keyboard?: KeyboardButton[][] }
  /** Wizard complete: show `text` and enqueue season_preview with `args` */
  | { kind: 'submit'; text: string; args: [hours: string, weakSport: WeakSportChoice] };

export const HOUR_OPTIONS = [6, 8, 10, 12, 15, 18];

export const PROMPT_HOURS =
  '🗓 New season plan.\n\n' +
  'How many hours per week can you train at most? Tap one or type a number ' +
  `(${SEASON_MIN_WEEKLY_HOURS.toString()}-${SEASON_MAX_WEEKLY_HOURS.toString()}).\n\n` +
  'Send /cancel to stop.';
export const INVALID_HOURS = `❌ Send a number of hours between ${SEASON_MIN_WEEKLY_HOURS.toString()} and ${SEASON_MAX_WEEKLY_HOURS.toString()}, e.g. 10, or tap a button.`;
export const INVALID_WEAK_SPORT = '❌ Tap a button, or send swim, bike, run or none.';
export const SEASON_CANCELLED = 'Cancelled. Your season plan was not changed.';
export const WIZARD_EXPIRED = '⌛ This wizard has expired. Run /season new to start again.';
export const SUBMITTED = '⏳ Building your season plan…';

export function promptWeakSport(hours: number): string {
  return `✅ Up to ${hours.toString()}h per week.\n\nWhich sport is your weakest? It gets extra volume in the base phase.`;
}

const HOURS_KEYBOARD: KeyboardButton[][] = [HOUR_OPTIONS.slice(0, 3), HOUR_OPTIONS.slice(3)].map(
  (row) => row.map((h) => ({ text: `${h.toString()}h`, data: `sn:h:${h.toString()}` }))
);

const WEAK_SPORT_KEYBOARD: KeyboardButton[][] = [
  [
    { text: '🏊 Swim', data: 'sn:w:swim' },
    { text: '🚴 Bike', data: 'sn:w:bike' },
    { text: '🏃 Run', data: 'sn:w:run' },
  ],
  [{ text: 'No weak sport', data: 'sn:w:none' }],
];

/** Wizard button data (`sn:h:<hours>` / `sn:w:<sport>`), or null for any other callback. */
export function parseWizardCallback(
  data: string
): { step: 'hours' | 'weakSport'; value: string } | null {
  const match = /^sn:([hw]):([a-z0-9.]{1,8})$/.exec(data);
  if (!match) return null;
  return { step: match[1] === 'h' ? 'hours' : 'weakSport', value: match[2] };
}

async function onCommand(
  userId: number,
  text: string,
  store: SeasonDialogStore
): Promise<SeasonDialogOutcome> {
  const { commandName, args } = parseCommand(text);
  if (commandName === 'season' && args[0]?.toLowerCase() === 'new') {
    await store.set(userId, { step: 'hours' });
    return { kind: 'reply', text: PROMPT_HOURS, keyboard: HOURS_KEYBOARD };
  }

  const state = await store.get(userId);
  if (!state) return { kind: 'pass' };
  // Any other command abandons the wizard
  await store.delete(userId);
  return commandName === 'cancel' ? { kind: 'reply', text: SEASON_CANCELLED } : { kind: 'pass' };
}

async function onAnswer(
  userId: number,
  state: SeasonDialogState,
  answer: string,
  store: SeasonDialogStore
): Promise<SeasonDialogOutcome> {
  if (state.step === 'hours') {
    const hours = parseWeeklyHours(answer);
    if (hours === null) return { kind: 'reply', text: INVALID_HOURS, keyboard: HOURS_KEYBOARD };
    await store.set(userId, { step: 'weakSport', hours });
    return { kind: 'reply', text: promptWeakSport(hours), keyboard: WEAK_SPORT_KEYBOARD };
  }

  const choice = answer.trim().toLowerCase();
  if (!isWeakSportChoice(choice)) {
    return { kind: 'reply', text: INVALID_WEAK_SPORT, keyboard: WEAK_SPORT_KEYBOARD };
  }
  await store.delete(userId);
  return { kind: 'submit', text: SUBMITTED, args: [state.hours.toString(), choice] };
}

export async function handleSeasonDialog(
  userId: number,
  event: SeasonDialogEvent,
  store: SeasonDialogStore
): Promise<SeasonDialogOutcome> {
  if (event.kind === 'text') {
    const trimmed = event.text.trim();
    if (trimmed.startsWith('/')) return onCommand(userId, trimmed, store);
    const state = await store.get(userId);
    return state ? onAnswer(userId, state, trimmed, store) : { kind: 'pass' };
  }

  const tap = parseWizardCallback(event.data);
  if (!tap) return { kind: 'pass' };
  // A button from an old or finished wizard message
  const state = await store.get(userId);
  if (state?.step !== tap.step) return { kind: 'reply', text: WIZARD_EXPIRED };
  return onAnswer(userId, state, tap.value, store);
}

export class RedisSeasonDialogStore extends RedisStateStore<SeasonDialogState> {
  constructor(redis: Redis, ttlSeconds = DIALOG_TTL_SECONDS) {
    super(redis, 'season-new', ttlSeconds);
  }
}

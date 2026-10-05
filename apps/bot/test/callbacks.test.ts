import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import {
  checkInData,
  coachDecisionData,
  MSG_DECISION_EXPIRED,
  seasonDecisionData,
  type CommandJob,
} from '@triathlon/core';
import { registerCallbackHandlers, type CallbackDeps } from '../src/callbacks';
import type { SeasonDialogState, SeasonDialogStore } from '../src/season-dialog';

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Coach',
  username: 'coach_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const CHAT_ID = 42;
const USER_ID = 4242;
const MESSAGE_ID = 777;
const DECISION = 'cmg1x2y3z0000abcd1234efgh';
/** When the brief was sent */
const SENT = new Date('2026-10-05T04:30:00Z');

class MemoryStore implements SeasonDialogStore {
  readonly states = new Map<number, SeasonDialogState>();

  get(telegramUserId: number) {
    return Promise.resolve(this.states.get(telegramUserId) ?? null);
  }

  set(telegramUserId: number, state: SeasonDialogState) {
    this.states.set(telegramUserId, state);
    return Promise.resolve();
  }

  delete(telegramUserId: number) {
    this.states.delete(telegramUserId);
    return Promise.resolve();
  }
}

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

let calls: ApiCall[];
let jobs: { job: CommandJob; jobId?: string }[];
let now: Date;
let bot: Bot;

beforeEach(async () => {
  calls = [];
  jobs = [];
  now = new Date('2026-10-05T07:00:00Z');
  const deps: CallbackDeps = {
    enqueue: (job, opts) => {
      jobs.push({ job, jobId: opts?.jobId });
      return Promise.resolve();
    },
    seasonDialogStore: new MemoryStore(),
    ttlHours: 24,
    now: () => now,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  bot = new Bot('test-token', { botInfo: BOT_INFO });
  // Every Bot API call is recorded and answered with success: no network
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return Promise.resolve({ ok: true, result: true } as never);
  });
  registerCallbackHandlers(bot, deps);
  await bot.init();
});

function tap(data: string, sentAt = SENT): Promise<void> {
  const update: Update = {
    update_id: 1,
    callback_query: {
      id: 'cbq-1',
      from: { id: USER_ID, is_bot: false, first_name: 'Ana' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: MESSAGE_ID,
        date: Math.floor(sentAt.getTime() / 1000),
        chat: { id: CHAT_ID, type: 'private', first_name: 'Ana' },
        text: 'Morning brief',
      },
    },
  };
  return bot.handleUpdate(update);
}

function methods(): string[] {
  return calls.map((c) => c.method);
}

describe('check-in buttons', () => {
  it('enqueues the answer with a per-button job id and keeps the buttons', async () => {
    await tap(checkInData('r', 4));

    expect(jobs).toEqual([
      {
        job: {
          telegramChatId: CHAT_ID,
          telegramUserId: USER_ID,
          messageId: MESSAGE_ID,
          commandName: 'checkin_answer',
          args: ['r', '4'],
          rawText: '',
        },
        jobId: `cb-${CHAT_ID.toString()}-${MESSAGE_ID.toString()}-r4`,
      },
    ]);
    // The worker edits the message, so the other question stays answerable
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(calls[0].payload).toMatchObject({ text: 'Saved' });
  });

  it('is not subject to the coach TTL', async () => {
    await tap(checkInData('s', 0), new Date(now.getTime() - 48 * 3_600_000));

    expect(jobs).toHaveLength(1);
    expect(methods()).toEqual(['answerCallbackQuery']);
  });
});

describe('coach decision buttons', () => {
  it.each([
    ['apply', 'coach_apply', 'Applying…'],
    ['keep', 'coach_keep', 'Keeping your plan'],
    ['discuss', 'coach_discuss', 'Opening chat…'],
  ] as const)('%s enqueues %s for the tapped brief', async (answer, commandName, toast) => {
    await tap(coachDecisionData(answer, DECISION));

    expect(jobs).toEqual([
      {
        job: {
          telegramChatId: CHAT_ID,
          telegramUserId: USER_ID,
          messageId: MESSAGE_ID,
          commandName,
          args: [DECISION],
          rawText: '',
        },
        jobId: `cb-${CHAT_ID.toString()}-${MESSAGE_ID.toString()}`,
      },
    ]);
    // The buttons go first, so they can't be tapped again
    expect(methods()).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery']);
    expect(calls[1].payload).toMatchObject({ callback_query_id: 'cbq-1', text: toast });
  });

  it('turns a tap after 24 h into the expiry notice and enqueues nothing', async () => {
    now = new Date(SENT.getTime() + 24 * 3_600_000 + 1000);

    await tap(coachDecisionData('apply', DECISION));

    expect(jobs).toEqual([]);
    expect(methods()).toEqual(['editMessageReplyMarkup', 'answerCallbackQuery', 'sendMessage']);
    expect(calls[2].payload).toMatchObject({ chat_id: CHAT_ID, text: MSG_DECISION_EXPIRED });
    expect(MSG_DECISION_EXPIRED).toContain('/plan today');
  });

  it('still takes a tap just inside 24 h', async () => {
    now = new Date(SENT.getTime() + 24 * 3_600_000);

    await tap(coachDecisionData('keep', DECISION));

    expect(jobs).toHaveLength(1);
  });
});

describe('other buttons', () => {
  it('routes a season preview button regardless of age', async () => {
    now = new Date(SENT.getTime() + 72 * 3_600_000);

    await tap(seasonDecisionData('save', 'draft1'));

    expect(jobs.map((j) => j.job.commandName)).toEqual(['season_confirm']);
  });

  it('answers a tap on a message Telegram no longer has', async () => {
    const update: Update = {
      update_id: 2,
      callback_query: {
        id: 'cbq-2',
        from: { id: USER_ID, is_bot: false, first_name: 'Ana' },
        chat_instance: 'ci',
        data: coachDecisionData('apply', DECISION),
      },
    };

    await bot.handleUpdate(update);

    expect(jobs).toEqual([]);
    expect(methods()).toEqual(['answerCallbackQuery']);
  });
});

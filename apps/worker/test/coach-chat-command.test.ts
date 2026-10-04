import { beforeEach, describe, expect, it } from 'vitest';
import {
  COACH_CHAT_HISTORY_SIZE,
  Intensity,
  parseCoachDecision,
  Sport,
  type RulesContext,
  type UserProfile,
} from '@triathlon/core';
import {
  CHAT_UNAVAILABLE_REPLY,
  LlmServerError,
  MockProvider,
  type ChatReply,
  type ChatTurn,
  type CoachDecisionRecord,
  type CoachDecisionSink,
  type DailyContextDeps,
  type PlannedSessionSummary,
} from '@triathlon/ai';
import type { ChatLimiter } from '../src/chat-limit';
import {
  chatLimitNotice,
  handleCoachChat,
  MSG_EMPTY_CHAT,
  type CoachChatDeps,
  type CoachChatRepo,
  type StoredChatMessage,
} from '../src/coach-chat-command';
import type { RichReply } from '../src/reply';

const USER = { id: 'user-1', profile: { timezone: 'Europe/Prague' } };
const NOW = new Date('2026-10-05T08:00:00Z'); // Monday
const LIMIT = 30;
const NO_HISTORY: RulesContext = { last7dStats: { totalMinutes: 0, byDate: [] } };
const PROFILE: UserProfile = {
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Tue',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
};

function planned(
  date: string,
  slot: string,
  sport: Sport,
  intensity: Intensity,
  durationMin: number,
  title: string
): PlannedSessionSummary {
  return {
    date,
    slot,
    sport,
    title,
    durationMin,
    intensity,
    status: 'pushed',
    externalChange: null,
  };
}

const WEEK: PlannedSessionSummary[] = [
  planned('2026-10-06', 'bike-0', Sport.bike, Intensity.z4, 60, 'VO2 5x4'),
  planned('2026-10-07', 'run-0', Sport.run, Intensity.z2, 45, 'Easy run'),
  planned('2026-10-08', 'run-0', Sport.run, Intensity.z4, 50, 'Threshold run'),
  planned('2026-10-10', 'run-0', Sport.run, Intensity.z2, 60, 'Long run'),
  planned('2026-10-11', 'bike-0', Sport.bike, Intensity.z2, 180, 'Long ride'),
];

const MOVE_LONG_RIDE: ChatReply = {
  reply: 'Yes: your "Long ride" (180 min Z2) on Sunday fits on Saturday next to the easy long run.',
  suggestion: {
    assessment: 'Both Saturday sessions are easy, so the week stays balanced.',
    action: 'move',
    changes: [
      {
        sessionId: '2026-10-11/bike-0',
        field: 'date',
        before: '2026-10-11',
        after: '2026-10-10',
      },
    ],
    confidence: 0.8,
    athleteMessage: 'Long ride moved to Saturday.',
  },
};

const WHY_Z2: ChatReply = {
  reply: 'Z2 builds your aerobic base without adding fatigue before Tuesday’s VO2 5x4.',
  suggestion: null,
};

class MemoryChats implements CoachChatRepo {
  readonly rows: StoredChatMessage[] = [];

  saveMessage(_userId: string, message: StoredChatMessage): Promise<void> {
    const exists = this.rows.some(
      (r) => r.telegramMessageId === message.telegramMessageId && r.role === message.role
    );
    if (!exists) this.rows.push(structuredClone(message));
    return Promise.resolve();
  }

  findReply(_userId: string, telegramMessageId: number): Promise<StoredChatMessage | null> {
    const row = this.rows.find(
      (r) => r.telegramMessageId === telegramMessageId && r.role === 'coach'
    );
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  listRecent(_userId: string, limit: number, excludeMessageId: number): Promise<ChatTurn[]> {
    const turns = this.rows
      .filter((r) => r.telegramMessageId !== excludeMessageId)
      .map(({ role, text }) => ({ role, text }));
    return Promise.resolve(turns.slice(-limit));
  }
}

class MemoryLimiter implements ChatLimiter {
  readonly days = new Map<string, Set<number>>();

  count(userId: string, day: string, messageId: number): Promise<number> {
    const key = userId + ':' + day;
    const ids = this.days.get(key) ?? new Set<number>();
    ids.add(messageId);
    this.days.set(key, ids);
    return Promise.resolve(ids.size);
  }
}

class MemoryDecisions implements CoachDecisionSink {
  readonly records: CoachDecisionRecord[] = [];

  write(record: CoachDecisionRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve('dec' + this.records.length.toString());
  }
}

function contextDeps(sessions: PlannedSessionSummary[]): DailyContextDeps {
  return {
    profiles: { findProfile: () => Promise.resolve(PROFILE) },
    seasons: { findActiveSeason: () => Promise.resolve(null) },
    races: { listUpcoming: () => Promise.resolve([]) },
    wellness: { listRange: () => Promise.resolve([]) },
    activities: { listRange: () => Promise.resolve([]) },
    planned: {
      listRange: (_userId, from, to) =>
        Promise.resolve(sessions.filter((s) => s.date >= from && s.date <= to)),
    },
    decisions: { listRecent: () => Promise.resolve([]) },
  };
}

/** Plays back replies in order; an Error reply is thrown. */
function scripted(...replies: (ChatReply | string | Error)[]): MockProvider {
  const queue = [...replies];
  return new MockProvider({
    respond: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('No scripted reply left');
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? next : JSON.stringify(next);
    },
  });
}

let chats: MemoryChats;
let limiter: MemoryLimiter;
let decisions: MemoryDecisions;

function deps(provider: MockProvider): CoachChatDeps {
  return {
    limiter,
    dailyLimit: LIMIT,
    chats,
    context: contextDeps(WEEK),
    getRulesContext: () => Promise.resolve(NO_HISTORY),
    provider,
    decisions,
    now: () => NOW,
  };
}

function chat(provider: MockProvider, text: string, telegramMessageId = 100) {
  return handleCoachChat(USER, { text, telegramMessageId }, deps(provider));
}

function rich(reply: unknown): RichReply {
  if (typeof reply !== 'object' || reply === null) throw new Error('Expected a rich reply');
  return reply as RichReply;
}

beforeEach(() => {
  chats = new MemoryChats();
  limiter = new MemoryLimiter();
  decisions = new MemoryDecisions();
});

describe('handleCoachChat', () => {
  it('answers a plan change with the actual ride and Apply/Keep buttons', async () => {
    const provider = scripted(MOVE_LONG_RIDE);

    const reply = rich(await chat(provider, 'can I move the long ride to Saturday?'));

    const { prompt } = provider.calls[0];
    expect(prompt).toContain('- `2026-10-11/bike-0`: bike 180 min Z2 "Long ride"');
    expect(prompt).toContain('can I move the long ride to Saturday?');
    expect(reply.text).toContain('your "Long ride" (180 min Z2) on Sunday');
    expect(reply.text).toContain('bike "Long ride" 2026-10-11: moved to 2026-10-10');

    const buttons = (reply.keyboard ?? []).flat().map((b) => parseCoachDecision(b.data));
    expect(buttons).toEqual([
      { answer: 'apply', decisionId: 'dec1' },
      { answer: 'keep', decisionId: 'dec1' },
    ]);
    expect(decisions.records[0]).toMatchObject({ origin: 'chat', verdict: 'accept' });
    expect(chats.rows).toEqual([
      {
        role: 'user',
        text: 'can I move the long ride to Saturday?',
        telegramMessageId: 100,
        coachDecisionId: null,
      },
      { role: 'coach', text: reply.text, telegramMessageId: 100, coachDecisionId: 'dec1' },
    ]);
  });

  it('answers a general question with plain text and no suggestion', async () => {
    const reply = await chat(scripted(WHY_Z2), 'why Z2?');

    expect(reply).toBe(WHY_Z2.reply);
    expect(decisions.records).toEqual([]);
    expect(chats.rows.map((r) => r.role)).toEqual(['user', 'coach']);
    expect(chats.rows[1].coachDecisionId).toBeNull();
  });

  it('sends the limit notice without an LLM call once the daily cap is reached', async () => {
    for (let id = 1; id <= LIMIT; id++) await limiter.count(USER.id, '2026-10-05', id);
    const provider = scripted(WHY_Z2);

    const reply = await chat(provider, 'why Z2?', 999);

    expect(reply).toBe(chatLimitNotice(LIMIT));
    expect(provider.calls).toEqual([]);
    expect(chats.rows).toEqual([]);
  });

  it('counts the athlete’s local day', async () => {
    // 23:30 UTC on Monday is already Tuesday in Prague
    for (let id = 1; id <= LIMIT; id++) await limiter.count(USER.id, '2026-10-05', id);
    const provider = scripted(WHY_Z2);
    const late = { ...deps(provider), now: () => new Date('2026-10-05T23:30:00Z') };

    await handleCoachChat(USER, { text: 'why Z2?', telegramMessageId: 999 }, late);

    expect(provider.calls).toHaveLength(1);
  });

  it(`sends the last ${COACH_CHAT_HISTORY_SIZE.toString()} messages, oldest first`, async () => {
    for (let i = 1; i <= 12; i++) {
      const text = 'turn-' + i.toString().padStart(2, '0');
      await chats.saveMessage(USER.id, {
        role: i % 2 === 1 ? 'user' : 'coach',
        text,
        telegramMessageId: i,
        coachDecisionId: null,
      });
    }
    const provider = scripted(WHY_Z2);

    await chat(provider, 'why Z2?');

    const { prompt } = provider.calls[0];
    expect(prompt).not.toContain('turn-02');
    expect(prompt).toContain('Athlete: turn-03\n\nCoach: turn-04');
    expect(prompt).toContain('Coach: turn-12');
    expect(prompt.indexOf('turn-03')).toBeLessThan(prompt.indexOf('turn-12'));
    // The new message is not part of its own history
    expect(prompt.match(/why Z2\?/g)).toHaveLength(1);
  });

  it('resends the stored reply on a retry instead of asking again', async () => {
    const provider = scripted(MOVE_LONG_RIDE);

    const first = await chat(provider, 'can I move the long ride to Saturday?');
    const retry = await chat(provider, 'can I move the long ride to Saturday?');

    expect(retry).toEqual(first);
    expect(provider.calls).toHaveLength(1);
    expect(decisions.records).toHaveLength(1);
    expect(chats.rows).toHaveLength(2);
  });

  it('apologises when the LLM is down and stores no coach reply', async () => {
    const reply = await chat(scripted(new LlmServerError(503)), 'why Z2?');

    expect(reply).toBe(CHAT_UNAVAILABLE_REPLY);
    expect(chats.rows.map((r) => r.role)).toEqual(['user']);
  });

  it('asks for a question when the message is blank', async () => {
    const provider = scripted(WHY_Z2);
    expect(await chat(provider, '   ')).toBe(MSG_EMPTY_CHAT);
    expect(provider.calls).toEqual([]);
  });
});

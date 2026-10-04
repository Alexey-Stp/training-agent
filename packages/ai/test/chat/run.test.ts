import { describe, expect, it } from 'vitest';
import {
  CHAT_PROMPT_VERSION,
  CHAT_PURPOSE,
  CHAT_REPAIR_PURPOSE,
  CHAT_UNAVAILABLE_REPLY,
  ChatReplySchema,
  DAILY_PROMPT_VERSION,
  LlmServerError,
  runCoachChat,
  type ChatReply,
  type ChatTurn,
  type CoachChatResult,
  type MockProvider,
  type SessionDiff,
} from '../../src';
import {
  DAILY_PROMPT,
  FakeDecisionSink,
  HARD_HARD_MOVE,
  NO_HISTORY,
  scripted,
  suggestion,
  TODAY,
  USER_ID,
  week,
} from '../suggestion/fixtures';

const SUN_RUN = '2026-10-11/run-1';
/** Moves Sunday's long run onto Saturday, next to the long ride */
const MOVE_LONG_RUN: SessionDiff = {
  sessionId: SUN_RUN,
  field: 'date',
  before: '2026-10-11',
  after: '2026-10-10',
};
const CUT_LONG_RIDE: SessionDiff = {
  sessionId: '2026-10-10/bike-1',
  field: 'durationMin',
  before: 120,
  after: 20,
};

const PLAIN: ChatReply = {
  reply: 'Z2 builds your aerobic base: your "Long ride" on Saturday stays easy for that reason.',
  suggestion: null,
};

function withChange(changes: SessionDiff[], reply = 'Sure, move it to Saturday.'): string {
  const value: ChatReply = { reply, suggestion: suggestion(changes, { action: 'move' }) };
  return JSON.stringify(value);
}

interface Chat {
  result: CoachChatResult;
  sink: FakeDecisionSink;
  provider: MockProvider;
}

async function chat(
  provider: MockProvider,
  message = 'can I move the long run to Saturday?',
  history: ChatTurn[] = []
): Promise<Chat> {
  const sink = new FakeDecisionSink();
  const result = await runCoachChat(
    { provider, decisions: sink },
    {
      userId: USER_ID,
      date: TODAY,
      dailyPrompt: DAILY_PROMPT,
      promptVersion: DAILY_PROMPT_VERSION,
      sessions: week(),
      context: NO_HISTORY,
      history,
      message,
    }
  );
  return { result, sink, provider };
}

describe('runCoachChat', () => {
  it('answers a general question with text only and stores no decision', async () => {
    const { result, sink, provider } = await chat(scripted(JSON.stringify(PLAIN)), 'why Z2?');

    expect(result).toEqual({
      reply: PLAIN.reply,
      decisionId: null,
      applicable: false,
      verdict: null,
      attempts: 1,
      unavailable: false,
    });
    expect(sink.records).toEqual([]);
    expect(provider.calls[0].opts).toMatchObject({
      purpose: CHAT_PURPOSE,
      promptVersion: CHAT_PROMPT_VERSION,
      userId: USER_ID,
    });
  });

  it('stores an applicable decision for a suggestion that passes the guardrails', async () => {
    const { result, sink } = await chat(scripted(withChange([MOVE_LONG_RUN])));

    expect(result.decisionId).toBe('decision-1');
    expect(result.applicable).toBe(true);
    expect(result.verdict).toBe('accept');
    expect(result.reply).toContain('Sure, move it to Saturday.');
    expect(result.reply).toContain('run "Long run" 2026-10-11: moved to 2026-10-10');

    const [record] = sink.records;
    expect(record).toMatchObject({
      userId: USER_ID,
      origin: 'chat',
      date: TODAY,
      promptVersion: DAILY_PROMPT_VERSION,
      suggestionPromptVersion: CHAT_PROMPT_VERSION,
      source: 'llm',
      fallbackReason: null,
      verdict: 'accept',
      finalAction: 'move',
      finalChanges: [MOVE_LONG_RUN],
      summary: 'run "Long run" 2026-10-11: moved to 2026-10-10',
      athleteMessage: result.reply,
    });
    expect(record.contextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('offers a clamped change with the reason', async () => {
    const { result, sink } = await chat(scripted(withChange([CUT_LONG_RIDE])));

    expect(result.applicable).toBe(true);
    expect(result.verdict).toBe('clamp');
    expect(sink.records[0].finalChanges).toEqual([{ ...CUT_LONG_RIDE, after: 60 }]);
    expect(result.reply).toContain('120 → 60 min');
    expect(result.reply).toContain('Why:');
  });

  it('answers without buttons when the guardrails reject the suggestion', async () => {
    const { result, sink } = await chat(scripted(withChange([HARD_HARD_MOVE])));

    expect(result.applicable).toBe(false);
    expect(result.verdict).toBe('reject');
    expect(result.decisionId).toBe('decision-1');
    expect(result.reply).toContain("I can't apply that change safely");
    expect(sink.records[0]).toMatchObject({
      verdict: 'reject',
      finalAction: 'keep',
      finalChanges: [],
    });
  });

  it('treats a suggestion without changes as a plain answer', async () => {
    const reply: ChatReply = { reply: 'Keep it as planned.', suggestion: suggestion([]) };
    const { result, sink } = await chat(scripted(JSON.stringify(reply)));

    expect(result).toMatchObject({ reply: 'Keep it as planned.', decisionId: null });
    expect(sink.records).toEqual([]);
  });

  it('repairs one invalid reply', async () => {
    const { result, provider } = await chat(scripted('{"reply": ""}', JSON.stringify(PLAIN)));

    expect(result).toMatchObject({ reply: PLAIN.reply, attempts: 2 });
    expect(provider.calls.map((c) => c.opts.purpose)).toEqual([CHAT_PURPOSE, CHAT_REPAIR_PURPOSE]);
  });

  it('marks a repaired suggestion as repaired', async () => {
    const { sink } = await chat(scripted('not json', withChange([MOVE_LONG_RUN])));
    expect(sink.records[0].source).toBe('repaired');
  });

  it('apologises when the LLM is down, or invalid twice, and stores nothing', async () => {
    for (const provider of [scripted(new LlmServerError(503)), scripted('nope', 'still nope')]) {
      const { result, sink } = await chat(provider);
      expect(result).toMatchObject({
        reply: CHAT_UNAVAILABLE_REPLY,
        decisionId: null,
        unavailable: true,
      });
      expect(sink.records).toEqual([]);
    }
  });

  it('grounds the prompt in the plan, the history and the new message', async () => {
    const history: ChatTurn[] = [
      { role: 'user', text: 'How was my week?' },
      { role: 'coach', text: 'Solid: you hit every key session.' },
    ];
    const { provider } = await chat(
      scripted(JSON.stringify(PLAIN)),
      'can I move the long ride?',
      history
    );
    const { prompt, opts } = provider.calls[0];

    expect(prompt.startsWith(DAILY_PROMPT.trimEnd())).toBe(true);
    expect(prompt).toContain('- `2026-10-10/bike-1`: bike 120 min Z2 "Long ride"');
    expect(prompt).toContain(
      'Athlete: How was my week?\n\nCoach: Solid: you hit every key session.'
    );
    expect(prompt).toContain('<message>\ncan I move the long ride?\n</message>');
    expect(opts.system).toContain("I'm not a doctor");
    expect(opts.jsonSchema).toBeDefined();
  });

  it('never re-scans placeholders in the athlete message', async () => {
    const { provider } = await chat(scripted(JSON.stringify(PLAIN)), 'what is {{date}}?');
    expect(provider.calls[0].prompt).toContain('what is {{date}}?');
  });
});

describe('ChatReplySchema', () => {
  it('requires the suggestion key, null when there is none', () => {
    expect(ChatReplySchema.safeParse({ reply: 'Hi' }).success).toBe(false);
    expect(ChatReplySchema.safeParse(PLAIN).success).toBe(true);
  });
});

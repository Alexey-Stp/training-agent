import { Sport, type RulesContext } from '@triathlon/core';
import { describe, expect, it } from 'vitest';
import {
  DAILY_PROMPT_VERSION,
  DEFAULT_GUARDRAIL_CONFIG,
  LlmServerError,
  runCoachSuggestion,
  SUGGESTION_PROMPT_VERSION,
  type CoachDecisionRecord,
  type CoachPlanSession,
  type GuardrailConfig,
  type MockProvider,
  type SessionDiff,
} from '../../src';
import {
  DAILY_PROMPT,
  easy,
  FakeDecisionSink,
  hard,
  HARD_HARD_MOVE,
  NO_HISTORY,
  readiness,
  REDUCE_SAT,
  scripted,
  suggestion,
  TODAY,
  TUE_BIKE,
  USER_ID,
  week,
} from './fixtures';

const LLM_MESSAGE = 'Take it a bit easier this week.';
const OVER_CUT: SessionDiff = { sessionId: TUE_BIKE, field: 'durationMin', before: 60, after: 12 };
const json = (changes: SessionDiff[]) => JSON.stringify(suggestion(changes));

interface Run {
  record: CoachDecisionRecord;
  sink: FakeDecisionSink;
  provider: MockProvider;
}

async function run(
  provider: MockProvider,
  options: {
    sessions?: CoachPlanSession[];
    context?: RulesContext;
    guardrailConfig?: GuardrailConfig;
  } = {}
): Promise<Run> {
  const sink = new FakeDecisionSink();
  const record = await runCoachSuggestion(
    { provider, decisions: sink, guardrailConfig: options.guardrailConfig },
    {
      userId: USER_ID,
      date: TODAY,
      dailyPrompt: DAILY_PROMPT,
      promptVersion: DAILY_PROMPT_VERSION,
      sessions: options.sessions ?? week(),
      context: options.context ?? NO_HISTORY,
    }
  );
  return { record, sink, provider };
}

/** Today's VO2 ride on a low-readiness day: the rules engine downgrades it */
const lowReadinessDay = {
  sessions: [hard(TODAY, Sport.bike, 60, 'VO2 5x4'), easy('2026-10-06', Sport.run, 45)],
  context: readiness(2),
};

describe('runCoachSuggestion', () => {
  it('accepts a safe suggestion and keeps the LLM message', async () => {
    const { record, provider } = await run(scripted(json([REDUCE_SAT])));

    expect(record).toMatchObject({
      source: 'llm',
      fallbackReason: null,
      attempts: 1,
      verdict: 'accept',
      finalAction: 'reduce',
      finalChanges: [REDUCE_SAT],
      athleteMessage: LLM_MESSAGE,
      summary: 'bike "Long ride" 2026-10-10: 120 → 90 min',
    });
    expect(provider.calls[0].prompt.startsWith(DAILY_PROMPT.trimEnd())).toBe(true);
    expect(provider.calls[0].prompt).toContain('`2026-10-10/bike-1`');
  });

  it('clamps an over-large cut and explains the safe result', async () => {
    const { record } = await run(scripted(json([OVER_CUT])));

    expect(record).toMatchObject({ source: 'llm', verdict: 'clamp', finalAction: 'reduce' });
    expect(record.finalChanges).toEqual([{ ...OVER_CUT, after: 30 }]);
    expect(record.athleteMessage).toContain('bike "VO2 5x4" 2026-10-06: 60 → 30 min');
    expect(record.athleteMessage).toContain('never removes more than 50%');
    expect(record.athleteMessage).not.toContain(LLM_MESSAGE);
  });

  it('rejects a hard-hard suggestion and falls back to the rules engine', async () => {
    const { record } = await run(scripted(json([HARD_HARD_MOVE])));

    expect(record).toMatchObject({
      source: 'fallback',
      fallbackReason: 'guardrail_reject',
      verdict: 'reject',
      finalAction: 'keep',
      finalChanges: [],
    });
    expect(record.suggestion?.changes).toEqual([HARD_HARD_MOVE]);
    expect(record.athleteMessage).toBe(
      [
        'Keep your plan as it is.',
        '',
        'Why:',
        '• Hard sessions on consecutive days (2026-10-06, 2026-10-07)',
      ].join('\n')
    );
  });

  it('marks a suggestion that needed the repair call', async () => {
    const { record } = await run(scripted('{"assessment":', json([REDUCE_SAT])));
    expect(record).toMatchObject({ source: 'repaired', attempts: 2, verdict: 'accept' });
    expect(record.rawResponses).toHaveLength(2);
  });

  it('falls back to the rules engine when the LLM is down', async () => {
    const { record, provider } = await run(scripted(new LlmServerError(503)), lowReadinessDay);

    expect(provider.calls).toHaveLength(1);
    expect(record).toMatchObject({
      source: 'fallback',
      fallbackReason: 'llm_unavailable',
      attempts: 1,
      rawResponses: [],
      suggestion: null,
      verdict: null,
      finalAction: 'reduce',
      finalChanges: [
        { sessionId: '2026-10-05/bike-1', field: 'intensity', before: 'z4', after: 'z2' },
      ],
    });
    expect(record.reasons[0]).toBe('LlmServerError');
    expect(record.athleteMessage).toContain('standard safety rules');
    expect(record.athleteMessage).toContain('bike "VO2 5x4" 2026-10-05: Z4 → Z2');
  });

  it('falls back after a second invalid reply and flags it', async () => {
    const { record } = await run(scripted('nope', '{"action":"keep"}'));

    expect(record).toMatchObject({
      source: 'fallback',
      fallbackReason: 'invalid_output',
      attempts: 2,
      verdict: null,
      suggestion: null,
    });
    expect(record.rawResponses).toEqual(['nope', '{"action":"keep"}']);
  });

  it('still writes a decision when something unexpected throws', async () => {
    const broken: GuardrailConfig = {
      ...DEFAULT_GUARDRAIL_CONFIG,
      lockedStatuses: {
        has: () => {
          throw new Error('boom');
        },
      } as unknown as ReadonlySet<never>,
    };
    const { record, sink, provider } = await run(scripted(json([])), { guardrailConfig: broken });

    expect(provider.calls).toHaveLength(0);
    expect(sink.records).toHaveLength(1);
    expect(record).toMatchObject({
      source: 'fallback',
      fallbackReason: 'internal_error',
      attempts: 0,
      finalAction: 'keep',
      finalChanges: [],
    });
    expect(record.reasons).toContain('Error: boom');
  });

  it('propagates a failing decision write so the job retries', async () => {
    const provider = scripted(json([]));
    const sink = { write: () => Promise.reject(new Error('db down')) };
    await expect(
      runCoachSuggestion(
        { provider, decisions: sink },
        {
          userId: USER_ID,
          date: TODAY,
          dailyPrompt: DAILY_PROMPT,
          promptVersion: DAILY_PROMPT_VERSION,
          sessions: week(),
          context: NO_HISTORY,
        }
      )
    ).rejects.toThrow('db down');
  });

  describe('audit completeness', () => {
    const scenarios: [string, () => MockProvider][] = [
      ['accept', () => scripted(json([REDUCE_SAT]))],
      ['clamp', () => scripted(json([OVER_CUT]))],
      ['reject', () => scripted(json([HARD_HARD_MOVE]))],
      ['repaired', () => scripted('x', json([REDUCE_SAT]))],
      ['invalid', () => scripted('x', 'y')],
      ['LLM down', () => scripted(new LlmServerError(500))],
    ];

    it.each(scenarios)('writes exactly one complete decision (%s)', async (_label, provider) => {
      const { record, sink } = await run(provider());

      expect(sink.records).toEqual([record]);
      expect(Object.values(record).every((v) => v !== undefined)).toBe(true);
      expect(record).toMatchObject({
        userId: USER_ID,
        date: TODAY,
        promptVersion: DAILY_PROMPT_VERSION,
        suggestionPromptVersion: SUGGESTION_PROMPT_VERSION,
      });
      expect(record.contextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.summary.length).toBeGreaterThan(0);
      expect(record.athleteMessage.length).toBeGreaterThan(0);
      expect(record.source === 'fallback').toBe(record.fallbackReason !== null);
    });

    it('hashes the same context to the same value', async () => {
      const [a, b] = await Promise.all([run(scripted(json([]))), run(scripted(json([])))]);
      expect(a.record.contextHash).toBe(b.record.contextHash);
    });
  });
});

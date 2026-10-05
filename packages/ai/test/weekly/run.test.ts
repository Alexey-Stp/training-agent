import { describe, expect, it } from 'vitest';
import {
  LlmServerError,
  NOTE_REJECTED,
  runWeeklyReview,
  WEEKLY_PROMPT_VERSION,
  WeeklyReviewSchema,
  type MockProvider,
  type RunWeeklyReviewInput,
  type WeeklyReview,
} from '../../src';
import { FakeDecisionSink, scripted } from '../suggestion/fixtures';
import {
  compliantWeek,
  FULL_CATCH_UP,
  missedLongRideWeek,
  PARTIAL_CATCH_UP,
  review,
  reviewedWeekContext,
  reviewInput,
} from './fixtures';

const json = (r: WeeklyReview) => JSON.stringify(r);

async function run(provider: MockProvider, input: RunWeeklyReviewInput) {
  const sink = new FakeDecisionSink();
  const result = await runWeeklyReview({ provider, decisions: sink }, input);
  return { ...result, sink, provider };
}

describe('runWeeklyReview', () => {
  it('missed long ride: accepts a partial catch-up within the ramp cap', async () => {
    const {
      record,
      review: text,
      sink,
      provider,
      decisionId,
    } = await run(scripted(json(review())), reviewInput(missedLongRideWeek()));
    expect(decisionId).toBe('decision-1');
    expect(sink.records).toHaveLength(1);
    expect(record).toMatchObject({
      origin: 'weekly',
      date: '2026-10-04',
      promptVersion: WEEKLY_PROMPT_VERSION,
      source: 'llm',
      verdict: 'accept',
      finalAction: 'adjust',
      finalChanges: [PARTIAL_CATCH_UP],
      fallbackReason: null,
    });
    expect(text.summary).toContain('420 of 600 min');
    expect(text.note).toBeNull();
    expect(provider.calls[0].opts.purpose).toBe('weekly-review');
    expect(provider.calls[0].prompt).toContain('- bike: 75 of 255 min (-180 min, 29%)');
  });

  it('compliant week: positive review and no changes', async () => {
    const positive = review({
      summary: 'Every session done: 600 of 600 min.',
      wins: ['All key sessions done', 'Long ride and long run complete'],
      concerns: [],
      nextWeekChanges: [],
    });
    const { record, review: text } = await run(
      scripted(json(positive)),
      reviewInput(compliantWeek())
    );
    expect(record).toMatchObject({ verdict: 'accept', finalAction: 'keep', finalChanges: [] });
    expect(record.summary).toBe('No changes, plan kept');
    expect(text.wins).toHaveLength(2);
  });

  it('rejects an over-aggressive catch-up and falls back to the rules engine', async () => {
    const greedy = review({ nextWeekChanges: [FULL_CATCH_UP] });
    const { record, review: text } = await run(
      scripted(json(greedy)),
      reviewInput(missedLongRideWeek(), { context: reviewedWeekContext(1000) })
    );
    expect(record).toMatchObject({
      source: 'fallback',
      fallbackReason: 'guardrail_reject',
      verdict: 'reject',
      finalChanges: [],
      finalAction: 'keep',
    });
    expect(record.reasons.join('\n')).toContain('ramp cap');
    // The coach's words stay; only the changes are replaced
    expect(text.summary).toBe(greedy.summary);
    expect(text.note).toBe(NOTE_REJECTED);
  });

  it('repairs an invalid first reply', async () => {
    const { record } = await run(
      scripted('{"summary":', json(review())),
      reviewInput(missedLongRideWeek())
    );
    expect(record).toMatchObject({ source: 'repaired', attempts: 2 });
  });

  it('falls back to a stats-only review when the LLM is down', async () => {
    const { record, review: text } = await run(
      scripted(new LlmServerError(503)),
      reviewInput(missedLongRideWeek())
    );
    expect(record).toMatchObject({ source: 'fallback', fallbackReason: 'llm_unavailable' });
    expect(text.summary).toBe('You trained 420 min of 600 min planned (70%).');
    expect(text.concerns).toEqual([
      'Missed key sessions: Long ride.',
      'Volume gap: bike 180 min short.',
    ]);
  });

  it('falls back after two invalid replies', async () => {
    const { record, sink } = await run(
      scripted('nope', 'still nope'),
      reviewInput(compliantWeek())
    );
    expect(record).toMatchObject({ fallbackReason: 'invalid_output', attempts: 2 });
    expect(sink.records).toHaveLength(1);
  });

  it('caps wins and concerns at two', async () => {
    const chatty = review({ wins: ['a', 'b', 'c'], concerns: ['d', 'e', 'f'] });
    const { review: text } = await run(scripted(json(chatty)), reviewInput(missedLongRideWeek()));
    expect(text.wins).toEqual(['a', 'b']);
    expect(text.concerns).toEqual(['d', 'e']);
  });
});

describe('WeeklyReviewSchema', () => {
  it('rejects a block adjustment factor outside 0.6..1.08', () => {
    const bad = {
      ...review(),
      blockAdjustment: { kind: 'scale_volume', factor: 1.3, reason: 'r' },
    };
    expect(WeeklyReviewSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a review with a block adjustment', () => {
    const ok = {
      ...review({ nextWeekChanges: [] }),
      blockAdjustment: { kind: 'scale_volume', factor: 0.7, reason: 'recovery' },
    };
    expect(WeeklyReviewSchema.safeParse(ok).success).toBe(true);
  });
});

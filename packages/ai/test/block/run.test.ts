import { describe, expect, it } from 'vitest';
import {
  BLOCK_PROMPT_VERSION,
  BlockReviewSchema,
  LlmServerError,
  NOTE_FORCED_RACE,
  NOTE_FORCED_VOLUME,
  NOTE_NO_PROPOSAL,
  runBlockReview,
  type BlockReview,
  type MockProvider,
  type RunBlockReviewInput,
} from '../../src';
import { FakeDecisionSink, scripted } from '../suggestion/fixtures';
import { blockInput, blockReview, REVIEW_DATE } from './fixtures';

const json = (r: BlockReview) => JSON.stringify(r);

async function run(provider: MockProvider, input: RunBlockReviewInput) {
  const sink = new FakeDecisionSink();
  const result = await runBlockReview({ provider, decisions: sink }, input);
  return { ...result, sink, provider };
}

describe('runBlockReview', () => {
  it('70% block: re-projects and records one block decision', async () => {
    const { record, reproject, overridden, sink, provider } = await run(
      scripted(json(blockReview())),
      blockInput(70)
    );
    expect(reproject).toBe(true);
    expect(overridden).toBe(false);
    expect(sink.records).toHaveLength(1);
    expect(record).toMatchObject({
      origin: 'block',
      date: REVIEW_DATE,
      promptVersion: BLOCK_PROMPT_VERSION,
      source: 'llm',
      verdict: 'accept',
      finalAction: 'adjust',
      finalChanges: [],
    });
    expect(provider.calls[0].opts.purpose).toBe('block-review');
    expect(provider.calls[0].prompt).toContain('Volume achieved: 70.0% of target');
  });

  it('overrides a keep when volume is outside the threshold', async () => {
    const { reproject, overridden, review, record } = await run(
      scripted(json(blockReview({ recommendation: 'keep' }))),
      blockInput(70)
    );
    expect(reproject).toBe(true);
    expect(overridden).toBe(true);
    expect(review.note).toBe(NOTE_FORCED_VOLUME);
    expect(record.verdict).toBe('clamp');
    expect(record.reasons).toContain('volume 70.0% outside 100 ± 15%');
  });

  it('keeps a compliant block when the coach says keep', async () => {
    const { reproject, record, review } = await run(
      scripted(json(blockReview({ recommendation: 'keep' }))),
      blockInput(95)
    );
    expect(reproject).toBe(false);
    expect(review.note).toBeNull();
    expect(record).toMatchObject({ finalAction: 'keep', summary: 'No changes, season kept' });
  });

  it('follows the coach re-projecting inside the band', async () => {
    const { reproject, overridden } = await run(scripted(json(blockReview())), blockInput(90));
    expect(reproject).toBe(true);
    expect(overridden).toBe(false);
  });

  it('always re-projects on a race move', async () => {
    const { reproject, review } = await run(
      scripted(json(blockReview({ recommendation: 'keep' }))),
      blockInput(100, { trigger: 'race_move', previousRaceDate: '2026-11-01' })
    );
    expect(reproject).toBe(true);
    expect(review.note).toBe(NOTE_FORCED_RACE);
  });

  it('proposes nothing without a valid re-projection', async () => {
    const { reproject, review, record } = await run(
      scripted(json(blockReview())),
      blockInput(70, { proposed: null, proposalIssue: 'too short' })
    );
    expect(reproject).toBe(false);
    expect(review.note).toBe(NOTE_NO_PROPOSAL);
    expect(record.finalAction).toBe('keep');
  });

  it('LLM down: the threshold rule decides and the verdict writes the text', async () => {
    const { reproject, review, record } = await run(
      scripted(new LlmServerError(503)),
      blockInput(70)
    );
    expect(reproject).toBe(true);
    expect(record).toMatchObject({ source: 'fallback', fallbackReason: 'llm_unavailable' });
    expect(review.summary).toBe('Block 2 (build): 70% of the target volume (7.0 of 10.0 h/week).');
    expect(review.wins).toEqual(['Fitness (CTL) up 2.5.']);
    expect(review.concerns).toEqual(['Compliance declined through the block.']);
    expect(review.note).toBeNull();
  });

  it('LLM down inside the band: keeps the season', async () => {
    const { reproject } = await run(scripted(new LlmServerError(503)), blockInput(95));
    expect(reproject).toBe(false);
  });

  it('repairs an invalid first reply', async () => {
    const { record } = await run(scripted('{"summary":', json(blockReview())), blockInput(70));
    expect(record).toMatchObject({ source: 'repaired', attempts: 2 });
  });

  it('falls back after two invalid replies and still writes one decision', async () => {
    const { record, sink } = await run(scripted('nope', 'still nope'), blockInput(95));
    expect(record).toMatchObject({ fallbackReason: 'invalid_output', attempts: 2 });
    expect(sink.records).toHaveLength(1);
  });

  it('caps wins and concerns at two', async () => {
    const chatty = blockReview({ wins: ['a', 'b', 'c'], concerns: ['d', 'e', 'f'] });
    const { review } = await run(scripted(json(chatty)), blockInput(95));
    expect(review.wins).toEqual(['a', 'b']);
    expect(review.concerns).toEqual(['d', 'e']);
  });
});

describe('BlockReviewSchema', () => {
  it('rejects an unknown recommendation', () => {
    const bad = { ...blockReview(), recommendation: 'rebuild' };
    expect(BlockReviewSchema.safeParse(bad).success).toBe(false);
  });
});

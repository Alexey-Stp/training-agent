import { describe, expect, it } from 'vitest';
import {
  LlmServerError,
  LlmTimeoutError,
  parseSuggestion,
  requestSuggestion,
  SUGGESTION_PURPOSE,
  SUGGESTION_REPAIR_PURPOSE,
} from '../../src';
import { REDUCE_SAT, scripted, suggestion } from './fixtures';

const PROMPT = 'coach prompt';
const VALID = JSON.stringify(suggestion([REDUCE_SAT]));
const OUT_OF_RANGE = JSON.stringify({ ...suggestion([]), confidence: 2 });

describe('parseSuggestion', () => {
  it('accepts a JSON string and an already parsed value', () => {
    expect(parseSuggestion(VALID)).toMatchObject({ ok: true });
    expect(parseSuggestion(JSON.parse(VALID))).toMatchObject({ ok: true });
  });

  it('reports invalid JSON', () => {
    const result = parseSuggestion('```json\n{}\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^Not valid JSON/);
  });

  it('reports schema errors by path', () => {
    const result = parseSuggestion(OUT_OF_RANGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('confidence');
  });
});

describe('requestSuggestion', () => {
  it('returns the suggestion from a valid first reply with one call', async () => {
    const provider = scripted(VALID);
    const attempt = await requestSuggestion(provider, PROMPT, { userId: 'u1' });

    expect(attempt).toMatchObject({
      status: 'ok',
      attempts: 1,
      rawResponses: [VALID],
      error: null,
    });
    expect(attempt.suggestion?.changes).toEqual([REDUCE_SAT]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].opts).toMatchObject({ purpose: SUGGESTION_PURPOSE, userId: 'u1' });
    expect(provider.calls[0].opts.jsonSchema).toBeDefined();
  });

  it('makes exactly one repair call that carries the bad reply and the error', async () => {
    const provider = scripted('not json', VALID);
    const attempt = await requestSuggestion(provider, PROMPT);

    expect(attempt).toMatchObject({ status: 'repaired', attempts: 2 });
    expect(attempt.rawResponses).toEqual(['not json', VALID]);
    expect(provider.calls).toHaveLength(2);
    const repair = provider.calls[1];
    expect(repair.opts.purpose).toBe(SUGGESTION_REPAIR_PURPOSE);
    expect(repair.prompt.startsWith(PROMPT)).toBe(true);
    expect(repair.prompt).toContain('not json');
    expect(repair.prompt).toContain('not valid JSON');
  });

  it('repairs a reply that is JSON but breaks the schema', async () => {
    const provider = scripted(OUT_OF_RANGE, VALID);
    const attempt = await requestSuggestion(provider, PROMPT);

    expect(attempt.status).toBe('repaired');
    expect(provider.calls[1].prompt).toContain('confidence');
  });

  it('gives up after the repair call also fails validation', async () => {
    const provider = scripted('not json', OUT_OF_RANGE);
    const attempt = await requestSuggestion(provider, PROMPT);

    expect(attempt).toMatchObject({ status: 'invalid', attempts: 2, suggestion: null });
    expect(attempt.rawResponses).toEqual(['not json', OUT_OF_RANGE]);
    expect(attempt.error).toContain('confidence');
    expect(provider.calls).toHaveLength(2);
  });

  it('does not retry when the LLM is unavailable', async () => {
    const provider = scripted(new LlmTimeoutError(30000));
    const attempt = await requestSuggestion(provider, PROMPT);

    expect(attempt).toMatchObject({
      status: 'unavailable',
      attempts: 1,
      rawResponses: [],
      error: 'LlmTimeoutError',
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('reports unavailable when the repair call fails', async () => {
    const provider = scripted('not json', new LlmServerError(503));
    const attempt = await requestSuggestion(provider, PROMPT);

    expect(attempt).toMatchObject({ status: 'unavailable', attempts: 2 });
    expect(attempt.rawResponses).toEqual(['not json']);
  });
});

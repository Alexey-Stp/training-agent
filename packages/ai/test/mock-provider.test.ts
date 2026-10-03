import { describe, it, expect, vi } from 'vitest';
import { createLlmProvider, loadAiConfig, MockProvider, type CompleteOptions } from '../src';

const OPTS: CompleteOptions = { purpose: 'weekly_summary', promptVersion: 'v1' };

describe('MockProvider', () => {
  it('returns a deterministic default reply and records the call', async () => {
    const mock = new MockProvider();
    const result = await mock.complete('hello', OPTS);

    expect(result).toEqual({
      text: 'mock:weekly_summary',
      model: 'mock',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 19, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(mock.calls).toEqual([{ prompt: 'hello', opts: OPTS }]);
  });

  it('returns parsed JSON when a schema is requested', async () => {
    const mock = new MockProvider({ respond: () => '{"sessions":3}' });
    const result = await mock.complete('plan', { ...OPTS, jsonSchema: { type: 'object' } });
    expect(result.json).toEqual({ sessions: 3 });
  });

  it('accepts a partial result from the responder', async () => {
    const mock = new MockProvider({
      model: 'claude-opus-5-5',
      respond: () => ({ text: 'hi', stopReason: 'max_tokens' }),
    });
    const result = await mock.complete('x', OPTS);
    expect(result).toMatchObject({ text: 'hi', stopReason: 'max_tokens', model: 'claude-opus-5-5' });
  });

  it('rejects when the responder throws', async () => {
    const mock = new MockProvider({
      respond: () => {
        throw new Error('scripted failure');
      },
    });
    await expect(mock.complete('x', OPTS)).rejects.toThrow('scripted failure');
  });
});

describe('createLlmProvider', () => {
  it('makes no network calls when AI_PROVIDER=mock', async () => {
    const fetch = vi.fn();
    const llm = createLlmProvider(loadAiConfig({ AI_PROVIDER: 'mock' }), { fetch });

    const result = await llm.complete('hello', OPTS);

    expect(llm.name).toBe('mock');
    expect(result.text).toBe('mock:weekly_summary');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds an Anthropic provider from config', () => {
    const llm = createLlmProvider(
      loadAiConfig({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-test', AI_MODEL: 'claude-sonnet-5-5' })
    );
    expect(llm.name).toBe('anthropic');
    expect(llm.model).toBe('claude-sonnet-5-5');
  });
});

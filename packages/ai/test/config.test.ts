import { describe, it, expect } from 'vitest';
import { loadAiConfig } from '../src';

describe('loadAiConfig', () => {
  it('defaults to the mock provider with a 30 s timeout', () => {
    expect(loadAiConfig({})).toEqual({
      AI_PROVIDER: 'mock',
      AI_MODEL: 'claude-opus-5-5',
      AI_TIMEOUT_MS: 30000,
    });
  });

  it('parses an Anthropic configuration', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'sk-test',
      AI_MODEL: 'claude-sonnet-5-5',
      AI_TIMEOUT_MS: '15000',
    });
    expect(config).toEqual({
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'sk-test',
      AI_MODEL: 'claude-sonnet-5-5',
      AI_TIMEOUT_MS: 15000,
    });
  });

  it('requires an API key for the Anthropic provider', () => {
    expect(() => loadAiConfig({ AI_PROVIDER: 'anthropic' })).toThrow(/AI_API_KEY/);
  });

  it('rejects unknown providers and non-positive timeouts', () => {
    expect(() => loadAiConfig({ AI_PROVIDER: 'openai' })).toThrow();
    expect(() => loadAiConfig({ AI_TIMEOUT_MS: '0' })).toThrow();
  });
});

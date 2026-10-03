import { AnthropicProvider } from './anthropic-provider';
import type { AiConfig } from './config';
import { MockProvider } from './mock-provider';
import type { LlmProvider } from './types';

export interface LlmProviderDeps {
  fetch?: typeof globalThis.fetch;
  baseDelayMs?: number;
}

export function createLlmProvider(config: AiConfig, deps: LlmProviderDeps = {}): LlmProvider {
  if (config.AI_PROVIDER === 'mock') return new MockProvider();
  if (!config.AI_API_KEY) throw new Error('AI_API_KEY is required when AI_PROVIDER=anthropic');
  return new AnthropicProvider({
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
    fetch: deps.fetch,
    baseDelayMs: deps.baseDelayMs,
  });
}

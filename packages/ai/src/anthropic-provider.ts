import { z } from 'zod';
import {
  LlmAuthError,
  LlmContractError,
  LlmHttpError,
  LlmNetworkError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmServerError,
  LlmTimeoutError,
  type LlmError,
} from './errors';
import type { CompleteOptions, LlmProvider, LlmResult, LlmUsage } from './types';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 16000;

// Server-side refusal fallback: on a policy decline the API re-runs the request on another model
// inside the same call. Only sent for models that support the "default" routing mode.
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const responseSchema = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_details: z.object({ category: z.string().nullable().optional() }).nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullable().optional(),
    cache_creation_input_tokens: z.number().nullable().optional(),
  }),
});

type AnthropicResponse = z.infer<typeof responseSchema>;

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable fetch for testing */
  fetch?: typeof globalThis.fetch;
  /** Delay before the single retry. Set to 0 in tests. Defaults to 1000. */
  baseDelayMs?: number;
}

type RawResponse = { status: number; body: string } | { networkError: unknown };
type Attempt = { body: string } | { retry: LlmError };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyResponse(status: number, body: string): Attempt {
  if (status >= 200 && status < 300) return { body };
  if (status === 401 || status === 403) throw new LlmAuthError(status);
  if (status === 429) return { retry: new LlmRateLimitError() };
  // 5xx includes 529 overloaded
  if (status >= 500) return { retry: new LlmServerError(status) };
  throw new LlmHttpError(status, body);
}

function toUsage(usage: AnthropicResponse['usage']): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function parseJson(text: string, what: string, rawText: string | null = null): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LlmContractError(`${what} is not valid JSON`, error, rawText);
  }
}

function buildOutputConfig(opts: CompleteOptions): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (opts.effort) config.effort = opts.effort;
  if (opts.jsonSchema) config.format = { type: 'json_schema', schema: opts.jsonSchema };
  return Object.keys(config).length > 0 ? config : undefined;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly baseDelayMs: number;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseDelayMs = config.baseDelayMs ?? 1000;
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<LlmResult> {
    const init = this.buildRequest(prompt, opts);
    // One retry on transient failures (429, 5xx, network). Timeouts throw straight away.
    let outcome = await this.attempt(init);
    if ('retry' in outcome) {
      if (this.baseDelayMs > 0) await sleep(this.baseDelayMs);
      outcome = await this.attempt(init);
    }
    if ('retry' in outcome) throw outcome.retry;
    return this.parseResult(outcome.body, opts);
  }

  private buildRequest(prompt: string, opts: CompleteOptions): RequestInit {
    const useFallback = FALLBACK_MODELS.has(this.model);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (useFallback) headers['anthropic-beta'] = FALLBACK_BETA;

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    };
    if (opts.system) body.system = opts.system;
    const outputConfig = buildOutputConfig(opts);
    if (outputConfig) body.output_config = outputConfig;
    if (useFallback) body.fallbacks = 'default';

    return { method: 'POST', headers, body: JSON.stringify(body) };
  }

  private async attempt(init: RequestInit): Promise<Attempt> {
    const raw = await this.send(init);
    if ('networkError' in raw) return { retry: new LlmNetworkError(raw.networkError) };
    return classifyResponse(raw.status, raw.body);
  }

  /** Sends one request. The timeout covers both the headers and the body. */
  private async send(init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(ANTHROPIC_API_URL, {
        ...init,
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new LlmTimeoutError(this.timeoutMs);
      return { networkError: error };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResult(body: string, opts: CompleteOptions): LlmResult {
    const parsed = responseSchema.safeParse(parseJson(body, 'Response body'));
    if (!parsed.success) {
      throw new LlmContractError('Response contract violation for POST /v1/messages', parsed.error);
    }
    const response = parsed.data;
    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(response.stop_details?.category ?? null);
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const result: LlmResult = {
      text,
      usage: toUsage(response.usage),
      model: response.model,
      stopReason: response.stop_reason ?? 'unknown',
    };
    if (opts.jsonSchema) result.json = parseJson(text, 'Structured output', text);
    return result;
  }
}

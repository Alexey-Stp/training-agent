import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ANTHROPIC_API_URL,
  AnthropicProvider,
  FALLBACK_BETA,
  LlmAuthError,
  LlmContractError,
  LlmHttpError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmServerError,
  LlmTimeoutError,
  type CompleteOptions,
} from '../src';

const OPTS: CompleteOptions = { purpose: 'test', promptVersion: 'v1' };

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'athlete' },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetch: typeof globalThis.fetch, model = 'claude-opus-5-5'): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'sk-test', model, timeoutMs: 30_000, fetch, baseDelayMs: 0 });
}

function sentRequest(mock: ReturnType<typeof vi.fn>): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

/** A fetch that never resolves until its signal is aborted, like a hung connection. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })
  );
}

describe('AnthropicProvider request', () => {
  it('posts to the messages API with auth, version and fallback headers', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(messageBody()));
    await provider(fetch).complete('Plan my week', { ...OPTS, system: 'You are a coach' });

    const req = sentRequest(fetch);
    expect(req.url).toBe(ANTHROPIC_API_URL);
    expect(req.headers['x-api-key']).toBe('sk-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['anthropic-beta']).toBe(FALLBACK_BETA);
    expect(req.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'You are a coach',
      messages: [{ role: 'user', content: 'Plan my week' }],
      fallbacks: 'default',
    });
  });

  it('omits the fallback for models that do not support it', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(messageBody({ model: 'claude-haiku-4-5' })));
    await provider(fetch, 'claude-haiku-4-5').complete('hi', OPTS);

    const req = sentRequest(fetch);
    expect(req.headers['anthropic-beta']).toBeUndefined();
    expect(req.body.fallbacks).toBeUndefined();
  });

  it('sends structured output and effort through output_config', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(messageBody({ content: [{ type: 'text', text: '{"ok":true}' }] })));

    const result = await provider(fetch).complete('hi', {
      ...OPTS,
      jsonSchema: schema,
      effort: 'low',
      maxTokens: 512,
    });

    const req = sentRequest(fetch);
    expect(req.body.max_tokens).toBe(512);
    expect(req.body.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema },
    });
    expect(result.json).toEqual({ ok: true });
  });
});

describe('AnthropicProvider response', () => {
  it('returns joined text, usage, model and stop reason', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(messageBody()));
    const result = await provider(fetch).complete('hi', OPTS);

    expect(result).toEqual({
      text: 'Hello athlete',
      model: 'claude-opus-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0 },
    });
  });

  it('throws LlmContractError on an unexpected body', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ hello: 'world' }));
    await expect(provider(fetch).complete('hi', OPTS)).rejects.toBeInstanceOf(LlmContractError);
  });

  it('throws LlmContractError when structured output is not JSON', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(messageBody({ content: [{ type: 'text', text: 'nope' }] })));
    await expect(
      provider(fetch).complete('hi', { ...OPTS, jsonSchema: { type: 'object' } })
    ).rejects.toBeInstanceOf(LlmContractError);
  });

  it('throws LlmRefusalError with the category when the model declines', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        messageBody({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })
      )
    );
    const error = await provider(fetch)
      .complete('hi', OPTS)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRefusalError);
    expect((error as LlmRefusalError).category).toBe('cyber');
  });
});

describe('AnthropicProvider retries', () => {
  it('retries once after a 5xx and succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse(messageBody()));

    const result = await provider(fetch).complete('hi', OPTS);
    expect(result.text).toBe('Hello athlete');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries once after a network error and succeeds', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(messageBody()));

    await expect(provider(fetch).complete('hi', OPTS)).resolves.toMatchObject({ text: 'Hello athlete' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries once then fails with LlmServerError when overloaded twice', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, 529)));
    const error = await provider(fetch)
      .complete('hi', OPTS)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmServerError);
    expect((error as LlmServerError).status).toBe(529);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries once then fails with LlmRateLimitError on repeated 429', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, 429)));
    await expect(provider(fetch).complete('hi', OPTS)).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 401', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    await expect(provider(fetch).complete('hi', OPTS)).rejects.toBeInstanceOf(LlmAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 400 and truncates the body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('x'.repeat(2000), { status: 400 }));
    const error = await provider(fetch)
      .complete('hi', OPTS)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmHttpError);
    expect((error as LlmHttpError).body).toHaveLength(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicProvider timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws LlmTimeoutError after 30 s when the provider hangs, without retrying', async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    const pending = provider(fetch).complete('hi', OPTS);
    const assertion = expect(pending).rejects.toBeInstanceOf(LlmTimeoutError);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

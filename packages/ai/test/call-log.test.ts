import { describe, it, expect, vi } from 'vitest';
import {
  LlmTimeoutError,
  MockProvider,
  withCallLog,
  type CompleteOptions,
  type LlmCallLogEntry,
  type LlmCallLogSink,
  type LlmLogger,
  type LlmProvider,
} from '../src';

const OPTS: CompleteOptions = { purpose: 'weekly_summary', promptVersion: 'v3', userId: 'u1' };

class FakeSink implements LlmCallLogSink {
  readonly entries: LlmCallLogEntry[] = [];

  write(entry: LlmCallLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

function fakeLogger(): LlmLogger & { [K in keyof LlmLogger]: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Clock that advances 250 ms per reading. */
function steppingClock(): () => number {
  let t = 1_000;
  return () => {
    t += 250;
    return t;
  };
}

function failingProvider(error: Error): LlmProvider {
  return {
    name: 'anthropic',
    model: 'claude-opus-5-5',
    complete: () => Promise.reject(error),
  };
}

describe('withCallLog', () => {
  it('returns the response and writes one row with tokens, latency and cost', async () => {
    const sink = new FakeSink();
    const inner = new MockProvider({
      model: 'claude-opus-5-5',
      respond: () => ({
        text: 'done',
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });
    const llm = withCallLog(inner, sink, { now: steppingClock() });

    const result = await llm.complete('prompt', OPTS);

    expect(result.text).toBe('done');
    expect(sink.entries).toEqual([
      {
        purpose: 'weekly_summary',
        promptVersion: 'v3',
        provider: 'mock',
        model: 'claude-opus-5-5',
        status: 'ok',
        errorType: null,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 250,
        costEstimate: 0.014,
        userId: 'u1',
      },
    ]);
  });

  it('logs a timeout, writes one timeout row and rethrows the typed error', async () => {
    const sink = new FakeSink();
    const logger = fakeLogger();
    const llm = withCallLog(failingProvider(new LlmTimeoutError(30_000)), sink, {
      logger,
      now: steppingClock(),
    });

    await expect(llm.complete('prompt', OPTS)).rejects.toBeInstanceOf(LlmTimeoutError);

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({
      status: 'timeout',
      errorType: 'LlmTimeoutError',
      model: 'claude-opus-5-5',
      inputTokens: 0,
      costEstimate: null,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ purpose: 'weekly_summary' });
  });

  it('records other failures with status error', async () => {
    const sink = new FakeSink();
    const llm = withCallLog(failingProvider(new TypeError('bad')), sink);

    await expect(llm.complete('prompt', OPTS)).rejects.toThrow('bad');
    expect(sink.entries[0]).toMatchObject({ status: 'error', errorType: 'TypeError' });
  });

  it('does not fail the call when the sink fails', async () => {
    const logger = fakeLogger();
    const sink: LlmCallLogSink = { write: () => Promise.reject(new Error('db down')) };
    const llm = withCallLog(new MockProvider(), sink, { logger });

    await expect(llm.complete('prompt', OPTS)).resolves.toMatchObject({ text: 'mock:weekly_summary' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('exposes the wrapped provider name and model', () => {
    const llm = withCallLog(new MockProvider({ model: 'm' }), new FakeSink());
    expect(llm.name).toBe('mock');
    expect(llm.model).toBe('m');
  });
});

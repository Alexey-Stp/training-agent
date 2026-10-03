import { LlmTimeoutError } from './errors';
import { estimateCostUsd } from './pricing';
import { EMPTY_USAGE, type CompleteOptions, type LlmProvider, type LlmResult } from './types';

export type LlmCallStatus = 'ok' | 'error' | 'timeout';

export interface LlmCallLogEntry {
  purpose: string;
  promptVersion: string;
  provider: string;
  model: string;
  status: LlmCallStatus;
  errorType: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costEstimate: number | null;
  userId: string | null;
}

export interface LlmCallLogSink {
  write(entry: LlmCallLogEntry): Promise<void>;
}

/** Minimal logger shape (pino-compatible), so this package doesn't depend on core. */
export interface LlmLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface CallLogOptions {
  logger?: LlmLogger;
  /** Clock in ms, injectable for tests */
  now?: () => number;
}

function errorStatus(error: unknown): LlmCallStatus {
  return error instanceof LlmTimeoutError ? 'timeout' : 'error';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Wraps a provider so every complete() call writes exactly one LlmCallLog entry, on success
 * and on failure. A failing sink is logged and never fails the call.
 */
export function withCallLog(
  provider: LlmProvider,
  sink: LlmCallLogSink,
  options: CallLogOptions = {}
): LlmProvider {
  const { logger } = options;
  const now = options.now ?? Date.now;

  function baseEntry(opts: CompleteOptions, latencyMs: number) {
    return {
      purpose: opts.purpose,
      promptVersion: opts.promptVersion,
      provider: provider.name,
      latencyMs,
      userId: opts.userId ?? null,
    };
  }

  async function record(entry: LlmCallLogEntry): Promise<void> {
    try {
      await sink.write(entry);
    } catch (error) {
      logger?.warn({ err: error, purpose: entry.purpose }, 'Failed to write LLM call log');
    }
  }

  async function complete(prompt: string, opts: CompleteOptions): Promise<LlmResult> {
    const startedAt = now();
    try {
      const result = await provider.complete(prompt, opts);
      await record({
        ...baseEntry(opts, now() - startedAt),
        ...result.usage,
        model: result.model,
        status: 'ok',
        errorType: null,
        costEstimate: estimateCostUsd(result.model, result.usage),
      });
      return result;
    } catch (error) {
      const entry: LlmCallLogEntry = {
        ...baseEntry(opts, now() - startedAt),
        ...EMPTY_USAGE,
        model: provider.model,
        status: errorStatus(error),
        errorType: errorName(error),
        costEstimate: null,
      };
      logger?.error(
        { err: error, purpose: opts.purpose, model: provider.model, latencyMs: entry.latencyMs },
        'LLM call failed'
      );
      await record(entry);
      throw error;
    }
  }

  return { name: provider.name, model: provider.model, complete };
}

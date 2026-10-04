import { LlmContractError } from './errors';
import type { CompleteOptions, LlmProvider, LlmResult } from './types';

export type MockResponder = (prompt: string, opts: CompleteOptions) => string | Partial<LlmResult>;

export interface MockProviderConfig {
  respond?: MockResponder;
  model?: string;
}

export interface MockCall {
  prompt: string;
  opts: CompleteOptions;
}

function defaultReply(_prompt: string, opts: CompleteOptions): string {
  return opts.jsonSchema ? '{}' : 'mock:' + opts.purpose;
}

/** Deterministic in-process provider. Never touches the network. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model: string;
  readonly calls: MockCall[] = [];
  private readonly respond: MockResponder;

  constructor(config: MockProviderConfig = {}) {
    this.model = config.model ?? 'mock';
    this.respond = config.respond ?? defaultReply;
  }

  complete(prompt: string, opts: CompleteOptions): Promise<LlmResult> {
    this.calls.push({ prompt, opts });
    try {
      return Promise.resolve(this.buildResult(prompt, opts));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private buildResult(prompt: string, opts: CompleteOptions): LlmResult {
    const reply = this.respond(prompt, opts);
    const partial = typeof reply === 'string' ? { text: reply } : reply;
    const text = partial.text ?? '';
    const result: LlmResult = {
      text,
      model: this.model,
      stopReason: 'end_turn',
      usage: {
        inputTokens: prompt.length,
        outputTokens: text.length,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      ...partial,
    };
    if (opts.jsonSchema && result.json === undefined) result.json = parseJson(text);
    return result;
  }
}

/** Same contract as AnthropicProvider: a structured reply that isn't JSON is a contract error. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LlmContractError('Structured output is not valid JSON', error, text);
  }
}

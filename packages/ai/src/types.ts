export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompleteOptions {
  /** What the call is for, e.g. 'weekly_summary'. Logged on every call. */
  purpose: string;
  /** Version of the prompt template that produced `prompt`. Logged on every call. */
  promptVersion: string;
  system?: string;
  maxTokens?: number;
  effort?: LlmEffort;
  /** JSON Schema for structured output. When set, the reply is parsed into `LlmResult.json`. */
  jsonSchema?: Record<string, unknown>;
  userId?: string;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  /** Model that actually served the call (may differ from the requested one after a fallback). */
  model: string;
  stopReason: string;
  json?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(prompt: string, opts: CompleteOptions): Promise<LlmResult>;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

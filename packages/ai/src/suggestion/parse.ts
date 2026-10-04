import { z } from 'zod';
import { LlmContractError } from '../errors';
import type { CompleteOptions, LlmProvider, LlmResult } from '../types';
import { buildRepairPrompt, SUGGESTION_PROMPT_VERSION } from './prompt';
import { CoachSuggestionSchema, coachSuggestionJsonSchema, type CoachSuggestion } from './schema';

export const SUGGESTION_PURPOSE = 'coach-suggestion';
export const SUGGESTION_REPAIR_PURPOSE = 'coach-suggestion-repair';

export type ParseResult = { ok: true; value: CoachSuggestion } | { ok: false; error: string };

/** Strict parse of an LLM reply (a JSON string or an already parsed value). */
export function parseSuggestion(raw: unknown): ParseResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, error: 'Not valid JSON: ' + detail };
    }
  }
  const parsed = CoachSuggestionSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/**
 * - `ok`: the first reply was valid
 * - `repaired`: the repair reply was valid
 * - `invalid`: both replies were invalid
 * - `unavailable`: a call failed (timeout, auth, server, network, refusal)
 */
export type SuggestionStatus = 'ok' | 'repaired' | 'invalid' | 'unavailable';

export interface SuggestionAttempt {
  status: SuggestionStatus;
  suggestion: CoachSuggestion | null;
  /** LLM calls made: 1 or 2 */
  attempts: number;
  rawResponses: string[];
  /** Why the last call didn't produce a suggestion */
  error: string | null;
}

export interface RequestSuggestionOptions {
  userId?: string;
  maxTokens?: number;
}

type CallOutcome =
  | { kind: 'parsed'; raw: string; value: CoachSuggestion }
  | { kind: 'invalid'; raw: string | null; error: string }
  | { kind: 'unavailable'; error: string };

async function callOnce(
  provider: LlmProvider,
  prompt: string,
  opts: CompleteOptions
): Promise<CallOutcome> {
  let result: LlmResult;
  try {
    result = await provider.complete(prompt, opts);
  } catch (error) {
    // The provider couldn't parse the reply: the model answered, just not with valid JSON
    if (error instanceof LlmContractError) {
      return { kind: 'invalid', raw: error.rawText, error: error.message };
    }
    const name = error instanceof Error ? error.name : 'UnknownError';
    return { kind: 'unavailable', error: name };
  }
  const parsed = parseSuggestion(result.json ?? result.text);
  return parsed.ok
    ? { kind: 'parsed', raw: result.text, value: parsed.value }
    : { kind: 'invalid', raw: result.text, error: parsed.error };
}

function rawOf(outcome: CallOutcome): string[] {
  return outcome.kind !== 'unavailable' && outcome.raw !== null ? [outcome.raw] : [];
}

function toAttempt(
  outcome: CallOutcome,
  attempts: number,
  rawResponses: string[],
  okStatus: SuggestionStatus
): SuggestionAttempt {
  if (outcome.kind === 'parsed') {
    return { status: okStatus, suggestion: outcome.value, attempts, rawResponses, error: null };
  }
  return {
    status: outcome.kind,
    suggestion: null,
    attempts,
    rawResponses,
    error: outcome.error,
  };
}

/**
 * Asks for a suggestion. An invalid reply gets exactly one repair call that re-prompts with the
 * validation error; an unavailable LLM gets none.
 */
export async function requestSuggestion(
  provider: LlmProvider,
  prompt: string,
  options: RequestSuggestionOptions = {}
): Promise<SuggestionAttempt> {
  const opts: CompleteOptions = {
    purpose: SUGGESTION_PURPOSE,
    promptVersion: SUGGESTION_PROMPT_VERSION,
    jsonSchema: coachSuggestionJsonSchema(),
    userId: options.userId,
    maxTokens: options.maxTokens,
  };
  const first = await callOnce(provider, prompt, opts);
  if (first.kind !== 'invalid') return toAttempt(first, 1, rawOf(first), 'ok');

  const repairPrompt = buildRepairPrompt(prompt, first.raw ?? '(unreadable)', first.error);
  const second = await callOnce(provider, repairPrompt, {
    ...opts,
    purpose: SUGGESTION_REPAIR_PURPOSE,
  });
  return toAttempt(second, 2, [...rawOf(first), ...rawOf(second)], 'repaired');
}

import type { LlmProvider } from '../types';
import { errorName } from '../util';
import {
  buildRaceBriefPrompt,
  RACE_BRIEF_PROMPT_VERSION,
  type RaceBriefPromptInput,
} from './prompt';

export const RACE_BRIEF_PURPOSE = 'race-brief';

export type RaceBriefFallbackReason = 'llm_unavailable' | 'invalid_output';

export interface RaceBriefText {
  intro: string;
  outro: string;
}

export interface RunRaceBriefDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
}

export interface RaceBriefResult {
  text: RaceBriefText;
  /** Null when the LLM text was used */
  fallbackReason: RaceBriefFallbackReason | null;
  /** `Name: message` of the error when the LLM call threw */
  error: string | null;
}

const MAX_PART_CHARS = 400;
const SEPARATOR = /^\s*---\s*$/m;

export function fallbackRaceBriefText(kind: RaceBriefPromptInput['kind']): RaceBriefText {
  return kind === 't7'
    ? {
        intro: 'Race week is here. The hard work is done, so keep things simple and sharp.',
        outro: 'Trust your preparation.',
      }
    : {
        intro: 'Tomorrow is race day. Stay calm, rest your legs and stick to the plan.',
        outro: 'Trust your preparation.',
      };
}

/**
 * Digits belong to the deterministic part of the brief. A reply with any digit outside the race
 * name is rejected, so the LLM can't state a number.
 */
export function parseRaceBriefText(raw: string, raceName: string): RaceBriefText | null {
  const parts = raw.split(SEPARATOR).map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '' || part.length > MAX_PART_CHARS)) {
    return null;
  }
  const withoutName = raceName === '' ? raw : raw.replaceAll(raceName, '');
  if (/\d/.test(withoutName)) return null;
  return { intro: parts[0], outro: parts[1] };
}

/** Tone-only LLM call. Never throws: any failure falls back to a fixed text. */
export async function runRaceBrief(
  deps: RunRaceBriefDeps,
  input: RaceBriefPromptInput & { userId?: string }
): Promise<RaceBriefResult> {
  const fallback = fallbackRaceBriefText(input.kind);
  try {
    const result = await deps.provider.complete(buildRaceBriefPrompt(input), {
      purpose: RACE_BRIEF_PURPOSE,
      promptVersion: RACE_BRIEF_PROMPT_VERSION,
      maxTokens: 300,
      userId: input.userId,
    });
    const text = parseRaceBriefText(result.text, input.raceName);
    if (!text) return { text: fallback, fallbackReason: 'invalid_output', error: null };
    return { text, fallbackReason: null, error: null };
  } catch (e) {
    return { text: fallback, fallbackReason: 'llm_unavailable', error: errorName(e) };
  }
}

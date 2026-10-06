import type { LlmProvider } from '../types';
import { errorName } from '../util';
import {
  buildRaceDebriefPrompt,
  RACE_DEBRIEF_PROMPT_VERSION,
  type RaceDebriefPromptInput,
} from './debrief-prompt';

export const RACE_DEBRIEF_PURPOSE = 'race-debrief';

export type RaceDebriefFallbackReason = 'llm_unavailable' | 'invalid_output';

export interface RaceDebriefText {
  narrative: string;
  /** Exactly three */
  takeaways: string[];
}

export interface RunRaceDebriefDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
}

export interface RaceDebriefResult {
  text: RaceDebriefText;
  /** Null when the LLM text was used */
  fallbackReason: RaceDebriefFallbackReason | null;
  /** `Name: message` of the error when the LLM call threw */
  error: string | null;
}

const TAKEAWAY_COUNT = 3;
const MAX_NARRATIVE_CHARS = 700;
const MAX_TAKEAWAY_CHARS = 220;
const SEPARATOR_LINE = '---';
const BULLET = '- ';
const NUMBER = /\d+(?:[.,:]\d+)*/g;

export const FALLBACK_DEBRIEF_TEXT: RaceDebriefText = {
  narrative: 'Congratulations on finishing. The numbers above show how you paced the race.',
  takeaways: [
    'Compare your first and second half: an even or negative split is the goal.',
    'Look at the heart rate drift as a sign of how well you fuelled and paced.',
    'Rest as planned, the easy block after the race is part of the training.',
  ],
};

/** The text before and after the line holding only `---`. */
function splitOnSeparator(raw: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === SEPARATOR_LINE) {
      parts.push(current.join('\n').trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  parts.push(current.join('\n').trim());
  return parts;
}

function numbersIn(text: string): string[] {
  return text.match(NUMBER) ?? [];
}

/**
 * A narrative, `---`, then exactly three `- ` takeaways. Every number in the reply must also
 * appear in the facts, so the LLM can't state a figure the code did not compute.
 */
export function parseRaceDebriefText(raw: string, facts: string): RaceDebriefText | null {
  const parts = splitOnSeparator(raw);
  if (parts.length !== 2) return null;
  const [narrative, list] = parts;
  const takeaways = list
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const valid =
    narrative !== '' &&
    narrative.length <= MAX_NARRATIVE_CHARS &&
    takeaways.length === TAKEAWAY_COUNT &&
    takeaways.every((t) => t.startsWith(BULLET) && t.length - BULLET.length <= MAX_TAKEAWAY_CHARS);
  if (!valid) return null;
  const known = new Set(numbersIn(facts));
  if (numbersIn(raw).some((n) => !known.has(n))) return null;
  return { narrative, takeaways: takeaways.map((t) => t.slice(BULLET.length).trim()) };
}

/** Narration-only LLM call. Never throws: any failure falls back to a fixed text. */
export async function runRaceDebrief(
  deps: RunRaceDebriefDeps,
  input: RaceDebriefPromptInput & { userId?: string }
): Promise<RaceDebriefResult> {
  try {
    const result = await deps.provider.complete(buildRaceDebriefPrompt(input), {
      purpose: RACE_DEBRIEF_PURPOSE,
      promptVersion: RACE_DEBRIEF_PROMPT_VERSION,
      maxTokens: 600,
      userId: input.userId,
    });
    const text = parseRaceDebriefText(result.text, input.facts);
    if (!text) {
      return { text: FALLBACK_DEBRIEF_TEXT, fallbackReason: 'invalid_output', error: null };
    }
    return { text, fallbackReason: null, error: null };
  } catch (e) {
    return {
      text: FALLBACK_DEBRIEF_TEXT,
      fallbackReason: 'llm_unavailable',
      error: errorName(e),
    };
  }
}

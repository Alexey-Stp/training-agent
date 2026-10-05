import type { BlockVerdict } from '@triathlon/core';
import type { LlmProvider } from '../types';
import { errorName, sha256 } from '../util';
import { parseJsonReply, requestStructured, type StructuredAttempt } from '../suggestion/parse';
import type {
  CoachDecisionRecord,
  CoachDecisionSink,
  FallbackReason,
  GuardrailVerdict,
} from '../suggestion/types';
import {
  BLOCK_PROMPT_VERSION,
  buildBlockPrompt,
  DEFAULT_BLOCK_REVIEW_CONFIG,
  type BlockPromptInput,
  type BlockReviewConfig,
} from './prompt';
import { blockReviewJsonSchema, BlockReviewSchema, type BlockReview } from './schema';

export const BLOCK_PURPOSE = 'block-review';
export const BLOCK_REPAIR_PURPOSE = 'block-review-repair';

/** Wins and concerns shown in the report; the LLM is asked for at most this many */
export const BLOCK_MAX_POINTS = 2;

export interface RunBlockReviewDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  config?: BlockReviewConfig;
}

export interface RunBlockReviewInput extends BlockPromptInput {
  userId: string;
}

/** What the report shows */
export interface BlockReviewText {
  summary: string;
  wins: string[];
  concerns: string[];
  /** Why the recommendation differs from the coach's, or why nothing can be re-projected */
  note: string | null;
}

export interface BlockReviewResult {
  decisionId: string;
  record: CoachDecisionRecord;
  review: BlockReviewText;
  /** Propose the re-projection to the athlete */
  reproject: boolean;
  /** The threshold or a race move overrode the coach's `keep` */
  overridden: boolean;
}

export const NOTE_FORCED_VOLUME =
  'Volume was far enough off target that the re-projection is proposed anyway.';
export const NOTE_FORCED_RACE =
  'The A-race moved, so the remaining blocks have to be re-projected.';
export const NOTE_NO_PROPOSAL =
  'No re-projection fits the remaining weeks; the season stays as it is.';

const RACE_MOVE_REASON = 'race_move';

type ReviewText = Pick<BlockReview, 'summary' | 'wins' | 'concerns'>;

/** Why the re-projection is proposed whatever the coach says, or null when it isn't forced. */
export function forcedReason(
  input: Pick<BlockPromptInput, 'trigger' | 'verdict'>,
  config: BlockReviewConfig
): string | null {
  if (input.trigger === 'race_move') return RACE_MOVE_REASON;
  const pct = input.verdict.volumeAchievedPct;
  if (pct !== null && Math.abs(pct - 100) > config.thresholdPct) {
    return `volume ${pct.toFixed(1)}% outside 100 ± ${config.thresholdPct.toFixed(0)}%`;
  }
  return null;
}

/** A review built from the verdict alone, for when the LLM's can't be used. */
export function fallbackBlockReview(v: BlockVerdict): ReviewText {
  const block = `Block ${v.blockOrder.toString()} (${v.blockType})`;
  let summary = `${block}: no weekly stats to compare with the targets.`;
  if (v.volumeAchievedPct !== null) {
    const hours = `${(v.achievedWeeklyHours ?? 0).toFixed(1)} of ${v.targetWeeklyHours.toFixed(1)} h/week`;
    summary = `${block}: ${v.volumeAchievedPct.toFixed(0)}% of the target volume (${hours}).`;
  }
  const wins =
    v.ctlDelta !== null && v.ctlDelta > 0 ? [`Fitness (CTL) up ${v.ctlDelta.toFixed(1)}.`] : [];
  const concerns =
    v.complianceTrend === 'declining' ? ['Compliance declined through the block.'] : [];
  return { summary, wins, concerns };
}

type Decided = Pick<
  CoachDecisionRecord,
  'source' | 'fallbackReason' | 'attempts' | 'rawResponses' | 'suggestion' | 'verdict' | 'reasons'
> & { text: ReviewText; wants: boolean };

function fromAttempt(attempt: StructuredAttempt<BlockReview>, input: RunBlockReviewInput): Decided {
  const base = { attempts: attempt.attempts, rawResponses: attempt.rawResponses };
  const value = attempt.value;
  if (value === null) {
    const reason: FallbackReason =
      attempt.status === 'unavailable' ? 'llm_unavailable' : 'invalid_output';
    return {
      ...base,
      source: 'fallback',
      fallbackReason: reason,
      suggestion: null,
      verdict: null,
      reasons: attempt.error === null ? [] : [attempt.error],
      text: fallbackBlockReview(input.verdict),
      wants: false,
    };
  }
  return {
    ...base,
    source: attempt.status === 'repaired' ? 'repaired' : 'llm',
    fallbackReason: null,
    suggestion: value,
    verdict: 'accept',
    reasons: [value.reason],
    text: value,
    wants: value.recommendation === 'reproject',
  };
}

function internalError(
  attempt: StructuredAttempt<BlockReview> | null,
  input: RunBlockReviewInput,
  error: unknown
): Decided {
  return {
    source: 'fallback',
    fallbackReason: 'internal_error',
    attempts: attempt?.attempts ?? 0,
    rawResponses: attempt?.rawResponses ?? [],
    suggestion: attempt?.value ?? null,
    verdict: null,
    reasons: [errorName(error)],
    text: fallbackBlockReview(input.verdict),
    wants: false,
  };
}

interface Outcome {
  forced: string | null;
  reproject: boolean;
  overridden: boolean;
  possible: boolean;
  wants: boolean;
}

function noteFor(o: Outcome): string | null {
  if (!o.possible) return o.forced !== null || o.wants ? NOTE_NO_PROPOSAL : null;
  if (!o.overridden) return null;
  return o.forced === RACE_MOVE_REASON ? NOTE_FORCED_RACE : NOTE_FORCED_VOLUME;
}

function athleteMessage(review: BlockReviewText): string {
  return [
    review.summary,
    ...review.wins.map((w) => '✅ ' + w),
    ...review.concerns.map((c) => '⚠️ ' + c),
    ...(review.note === null ? [] : [review.note]),
  ].join('\n');
}

async function ask(
  deps: RunBlockReviewDeps,
  input: RunBlockReviewInput,
  config: BlockReviewConfig
): Promise<{ prompt: string; decided: Decided }> {
  let prompt = '';
  let attempt: StructuredAttempt<BlockReview> | null = null;
  try {
    prompt = buildBlockPrompt(input, config);
    attempt = await requestStructured(deps.provider, prompt, {
      opts: {
        purpose: BLOCK_PURPOSE,
        promptVersion: BLOCK_PROMPT_VERSION,
        jsonSchema: blockReviewJsonSchema(),
        userId: input.userId,
      },
      repairPurpose: BLOCK_REPAIR_PURPOSE,
      parse: (raw) => parseJsonReply(BlockReviewSchema, raw),
    });
    return { prompt, decided: fromAttempt(attempt, input) };
  } catch (error) {
    return { prompt, decided: internalError(attempt, input, error) };
  }
}

/**
 * One block review: prompt → LLM (one repair at most) → keep or re-project → CoachDecision
 * (`origin: 'block'`). A race move, or volume outside 100 ± `thresholdPct`, always proposes the
 * re-projection; so does the coach's `reproject`. Nothing is proposed without a valid
 * re-projection. Writes exactly one decision whatever happens; only a failing write throws.
 */
export async function runBlockReview(
  deps: RunBlockReviewDeps,
  input: RunBlockReviewInput
): Promise<BlockReviewResult> {
  const config = deps.config ?? DEFAULT_BLOCK_REVIEW_CONFIG;
  const { prompt, decided } = await ask(deps, input, config);

  const forced = forcedReason(input, config);
  const possible = input.proposed !== null;
  const outcome: Outcome = {
    forced,
    possible,
    wants: decided.wants,
    reproject: possible && (decided.wants || forced !== null),
    // Only a coach answer can be overridden; without one the rules decide alone
    overridden: possible && forced !== null && decided.suggestion !== null && !decided.wants,
  };
  const review: BlockReviewText = {
    summary: decided.text.summary,
    wins: decided.text.wins.slice(0, BLOCK_MAX_POINTS),
    concerns: decided.text.concerns.slice(0, BLOCK_MAX_POINTS),
    note: noteFor(outcome),
  };
  const verdict: GuardrailVerdict | null = outcome.overridden ? 'clamp' : decided.verdict;
  const { text: _text, wants: _wants, ...audit } = decided;
  const record: CoachDecisionRecord = {
    userId: input.userId,
    origin: 'block',
    date: input.date,
    promptVersion: BLOCK_PROMPT_VERSION,
    suggestionPromptVersion: BLOCK_PROMPT_VERSION,
    contextHash: sha256(prompt),
    ...audit,
    verdict,
    reasons: forced === null ? audit.reasons : [...audit.reasons, forced],
    finalAction: outcome.reproject ? 'adjust' : 'keep',
    finalChanges: [],
    summary: outcome.reproject ? 'Re-project the remaining blocks' : 'No changes, season kept',
    athleteMessage: athleteMessage(review),
  };
  const decisionId = await deps.decisions.write(record);
  return {
    decisionId,
    record,
    review,
    reproject: outcome.reproject,
    overridden: outcome.overridden,
  };
}

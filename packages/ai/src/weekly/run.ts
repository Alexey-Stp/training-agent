import type { RulesContext, WeeklyStats } from '@triathlon/core';
import type { LlmProvider } from '../types';
import { errorName, sha256 } from '../util';
import { deterministicRecommendation, type Recommendation } from '../suggestion/guardrails';
import { summarizeChanges } from '../suggestion/message';
import { parseJsonReply, requestStructured, type StructuredAttempt } from '../suggestion/parse';
import type {
  CoachDecisionRecord,
  CoachDecisionSink,
  FallbackReason,
  GuardrailVerdict,
} from '../suggestion/types';
import { runWeeklyGuardrails, weeklyAction } from './guardrails';
import {
  buildWeeklyPrompt,
  DEFAULT_WEEKLY_GUARDRAIL_CONFIG,
  WEEKLY_PROMPT_VERSION,
  type WeeklyGuardrailConfig,
  type WeeklyPromptInput,
} from './prompt';
import { weeklyReviewJsonSchema, WeeklyReviewSchema, type WeeklyReview } from './schema';

export const WEEKLY_PURPOSE = 'weekly-review';
export const WEEKLY_REPAIR_PURPOSE = 'weekly-review-repair';

/** Wins and concerns shown in the report; the LLM is asked for at most this many */
export const WEEKLY_MAX_POINTS = 2;

export interface RunWeeklyReviewDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: WeeklyGuardrailConfig;
}

export interface RunWeeklyReviewInput extends WeeklyPromptInput {
  userId: string;
  /** Rules context for next week: last7dStats is the reviewed week */
  context: RulesContext;
}

/** What the report shows */
export interface WeeklyReviewText {
  summary: string;
  wins: string[];
  concerns: string[];
  /** Why the coach's next-week changes were cut back or not applied; null when they were */
  note: string | null;
}

export interface WeeklyReviewResult {
  decisionId: string;
  record: CoachDecisionRecord;
  review: WeeklyReviewText;
}

type Outcome = Pick<
  CoachDecisionRecord,
  | 'source'
  | 'fallbackReason'
  | 'attempts'
  | 'rawResponses'
  | 'suggestion'
  | 'verdict'
  | 'reasons'
  | 'finalAction'
  | 'finalChanges'
> & { review: WeeklyReviewText };

interface Audit {
  attempts: number;
  rawResponses: string[];
  suggestion: WeeklyReview | null;
  verdict: GuardrailVerdict | null;
  reasons: string[];
}

export const NOTE_REJECTED =
  'The suggested changes to next week broke a safety limit, so only the standard safety rules apply.';
export const NOTE_CLAMPED = 'Some suggested changes were cut back to stay within safety limits.';

function minutes(value: number): string {
  return value.toString() + ' min';
}

/** A review built from the stats alone, for when the LLM's can't be used. */
export function fallbackReview(stats: WeeklyStats): Omit<WeeklyReviewText, 'note'> {
  const { total, keySessions } = stats;
  const summary =
    total.compliancePct === null
      ? `No sessions were planned this week; you trained ${minutes(total.actualMin)}.`
      : `You trained ${minutes(total.actualMin)} of ${minutes(total.plannedMin)} planned (${Math.round(total.compliancePct).toString()}%).`;
  const wins =
    keySessions.hit.length > 0
      ? [`Key sessions done: ${keySessions.hit.map((k) => k.title).join(', ')}.`]
      : [];
  const short = stats.bySport
    .filter((s) => s.compliancePct !== null && s.actualMin < s.plannedMin)
    .map((s) => `${s.sport} ${minutes(s.plannedMin - s.actualMin)} short`);
  const concerns = [
    ...(keySessions.missed.length > 0
      ? [`Missed key sessions: ${keySessions.missed.map((k) => k.title).join(', ')}.`]
      : []),
    ...(short.length > 0 ? ['Volume gap: ' + short.join(', ') + '.'] : []),
  ];
  return { summary, wins, concerns: concerns.slice(0, WEEKLY_MAX_POINTS) };
}

function safeRecommendation(
  input: RunWeeklyReviewInput,
  config: WeeklyGuardrailConfig
): { rec: Recommendation; error: string | null } {
  try {
    const rec = deterministicRecommendation(input.date, input.sessions, input.context, config);
    return { rec, error: null };
  } catch (error) {
    return { rec: { action: 'keep', changes: [], notes: [] }, error: errorName(error) };
  }
}

function fallback(
  input: RunWeeklyReviewInput,
  config: WeeklyGuardrailConfig,
  reason: FallbackReason,
  audit: Audit
): Outcome {
  const { rec, error } = safeRecommendation(input, config);
  const errors = error === null ? [] : [error];
  // A rejected review still has the coach's words; only its changes are replaced
  const llm = reason === 'guardrail_reject' ? audit.suggestion : null;
  const text = llm ?? fallbackReview(input.stats);
  return {
    ...audit,
    source: 'fallback',
    fallbackReason: reason,
    reasons: [...audit.reasons, ...errors, ...rec.notes],
    finalAction: rec.action,
    finalChanges: rec.changes,
    review: {
      summary: text.summary,
      wins: text.wins.slice(0, WEEKLY_MAX_POINTS),
      concerns: text.concerns.slice(0, WEEKLY_MAX_POINTS),
      note: reason === 'guardrail_reject' ? NOTE_REJECTED : null,
    },
  };
}

function decide(
  attempt: StructuredAttempt<WeeklyReview>,
  input: RunWeeklyReviewInput,
  config: WeeklyGuardrailConfig
): Outcome {
  const base = {
    attempts: attempt.attempts,
    rawResponses: attempt.rawResponses,
    suggestion: attempt.value,
  };
  const review = attempt.value;
  if (review === null) {
    const reason = attempt.status === 'unavailable' ? 'llm_unavailable' : 'invalid_output';
    const reasons = attempt.error === null ? [] : [attempt.error];
    return fallback(input, config, reason, { ...base, verdict: null, reasons });
  }

  const result = runWeeklyGuardrails(
    {
      date: input.date,
      sessions: input.sessions,
      context: input.context,
      changes: review.nextWeekChanges,
      blockAdjustment: review.blockAdjustment,
    },
    config
  );
  if (result.verdict === 'reject') {
    const audit = { ...base, verdict: result.verdict, reasons: result.reasons };
    return fallback(input, config, 'guardrail_reject', audit);
  }
  return {
    ...base,
    source: attempt.status === 'repaired' ? 'repaired' : 'llm',
    fallbackReason: null,
    verdict: result.verdict,
    reasons: result.reasons,
    finalAction: weeklyAction(result.changes),
    finalChanges: result.changes,
    review: {
      summary: review.summary,
      wins: review.wins.slice(0, WEEKLY_MAX_POINTS),
      concerns: review.concerns.slice(0, WEEKLY_MAX_POINTS),
      note: result.verdict === 'clamp' ? NOTE_CLAMPED : null,
    },
  };
}

function athleteMessage(review: WeeklyReviewText): string {
  return [
    review.summary,
    ...review.wins.map((w) => '✅ ' + w),
    ...review.concerns.map((c) => '⚠️ ' + c),
    ...(review.note === null ? [] : [review.note]),
  ].join('\n');
}

/**
 * One weekly review: prompt → LLM (one repair at most) → weekly guardrails → CoachDecision
 * (`origin: 'weekly'`). Writes exactly one decision whatever happens; only a failing write
 * throws, so the job retries.
 */
export async function runWeeklyReview(
  deps: RunWeeklyReviewDeps,
  input: RunWeeklyReviewInput
): Promise<WeeklyReviewResult> {
  const config = deps.guardrailConfig ?? DEFAULT_WEEKLY_GUARDRAIL_CONFIG;
  let prompt = '';
  let attempt: StructuredAttempt<WeeklyReview> | null = null;
  let outcome: Outcome;
  try {
    prompt = buildWeeklyPrompt(input, config);
    attempt = await requestStructured(deps.provider, prompt, {
      opts: {
        purpose: WEEKLY_PURPOSE,
        promptVersion: WEEKLY_PROMPT_VERSION,
        jsonSchema: weeklyReviewJsonSchema(),
        userId: input.userId,
      },
      repairPurpose: WEEKLY_REPAIR_PURPOSE,
      parse: (raw) => parseJsonReply(WeeklyReviewSchema, raw),
    });
    outcome = decide(attempt, input, config);
  } catch (error) {
    const audit: Audit = {
      attempts: attempt?.attempts ?? 0,
      rawResponses: attempt?.rawResponses ?? [],
      suggestion: attempt?.value ?? null,
      verdict: null,
      reasons: [errorName(error)],
    };
    outcome = fallback(input, config, 'internal_error', audit);
  }

  const { review, ...decided } = outcome;
  const record: CoachDecisionRecord = {
    userId: input.userId,
    origin: 'weekly',
    date: input.date,
    promptVersion: WEEKLY_PROMPT_VERSION,
    suggestionPromptVersion: WEEKLY_PROMPT_VERSION,
    contextHash: sha256(prompt),
    ...decided,
    summary: summarizeChanges(decided.finalChanges, input.sessions),
    athleteMessage: athleteMessage(review),
  };
  const decisionId = await deps.decisions.write(record);
  return { decisionId, record, review };
}

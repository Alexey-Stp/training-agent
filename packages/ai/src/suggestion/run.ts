import type { RulesContext } from '@triathlon/core';
import type { LlmProvider } from '../types';
import { errorName, sha256 } from '../util';
import {
  DEFAULT_GUARDRAIL_CONFIG,
  deterministicRecommendation,
  runGuardrails,
  type GuardrailConfig,
  type Recommendation,
} from './guardrails';
import { renderSafeMessage, summarizeChanges } from './message';
import { requestSuggestion, type SuggestionAttempt } from './parse';
import { buildSuggestionPrompt, SUGGESTION_PROMPT_VERSION } from './prompt';
import type { CoachSuggestion } from './schema';
import type {
  CoachDecisionRecord,
  CoachDecisionSink,
  CoachPlanSession,
  FallbackReason,
  GuardrailVerdict,
} from './types';

export interface RunCoachSuggestionDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: GuardrailConfig;
}

export interface RunCoachSuggestionInput {
  userId: string;
  /** Today, athlete-local */
  date: string;
  /** `buildDailyContext(...).prompt` */
  dailyPrompt: string;
  /** `buildDailyContext(...).promptVersion` */
  promptVersion: string;
  /** The plan window the coach may change, ideally today..today+6 */
  sessions: readonly CoachPlanSession[];
  context: RulesContext;
}

type Outcome = Omit<
  CoachDecisionRecord,
  | 'userId'
  | 'origin'
  | 'date'
  | 'promptVersion'
  | 'suggestionPromptVersion'
  | 'contextHash'
  | 'summary'
>;

interface Audit {
  attempts: number;
  rawResponses: string[];
  suggestion: CoachSuggestion | null;
  verdict: GuardrailVerdict | null;
  reasons: string[];
}

const RULES_ONLY_NOTE = "Today's advice comes from your plan's standard safety rules.";

/** The rules engine's recommendation; if even that fails, keep the plan unchanged. */
function safeRecommendation(
  input: RunCoachSuggestionInput,
  config: GuardrailConfig
): { rec: Recommendation; error: string | null } {
  try {
    const rec = deterministicRecommendation(input.date, input.sessions, input.context, config);
    return { rec, error: null };
  } catch (error) {
    return { rec: { action: 'keep', changes: [], notes: [] }, error: errorName(error) };
  }
}

function fallback(
  input: RunCoachSuggestionInput,
  config: GuardrailConfig,
  reason: FallbackReason,
  audit: Audit,
  athleteNotes: string[]
): Outcome {
  const { rec, error } = safeRecommendation(input, config);
  const errors = error === null ? [] : [error];
  return {
    ...audit,
    source: 'fallback',
    fallbackReason: reason,
    reasons: [...audit.reasons, ...errors, ...rec.notes],
    finalAction: rec.action,
    finalChanges: rec.changes,
    athleteMessage: renderSafeMessage(rec.changes, input.sessions, [...athleteNotes, ...rec.notes]),
  };
}

function auditOf(attempt: SuggestionAttempt | null): Omit<Audit, 'verdict' | 'reasons'> {
  return {
    attempts: attempt?.attempts ?? 0,
    rawResponses: attempt?.rawResponses ?? [],
    suggestion: attempt?.suggestion ?? null,
  };
}

function decide(
  attempt: SuggestionAttempt,
  input: RunCoachSuggestionInput,
  config: GuardrailConfig
): Outcome {
  const llm = auditOf(attempt);
  const { suggestion } = attempt;
  if (suggestion === null) {
    const reason = attempt.status === 'unavailable' ? 'llm_unavailable' : 'invalid_output';
    const reasons = attempt.error === null ? [] : [attempt.error];
    return fallback(input, config, reason, { ...llm, verdict: null, reasons }, [RULES_ONLY_NOTE]);
  }

  const result = runGuardrails(
    { date: input.date, sessions: input.sessions, context: input.context, suggestion },
    config
  );
  if (result.verdict === 'reject') {
    const audit = { ...llm, verdict: result.verdict, reasons: result.reasons };
    return fallback(input, config, 'guardrail_reject', audit, result.reasons);
  }
  // Every change was dropped: what is left is keeping the plan
  const keptNothing = result.changes.length === 0 && suggestion.changes.length > 0;
  return {
    ...llm,
    source: attempt.status === 'repaired' ? 'repaired' : 'llm',
    fallbackReason: null,
    verdict: result.verdict,
    reasons: result.reasons,
    finalAction: keptNothing ? 'keep' : suggestion.action,
    finalChanges: result.changes,
    athleteMessage:
      result.verdict === 'accept'
        ? suggestion.athleteMessage
        : renderSafeMessage(result.changes, input.sessions, result.reasons),
  };
}

/**
 * One daily coaching run: prompt → LLM (one repair at most) → guardrails → CoachDecision.
 * Writes exactly one decision whatever happens; only a failing write throws, so the job retries.
 */
export async function runCoachSuggestion(
  deps: RunCoachSuggestionDeps,
  input: RunCoachSuggestionInput
): Promise<CoachDecisionRecord> {
  const config = deps.guardrailConfig ?? DEFAULT_GUARDRAIL_CONFIG;
  let prompt = input.dailyPrompt;
  let attempt: SuggestionAttempt | null = null;
  let outcome: Outcome;
  try {
    prompt = buildSuggestionPrompt(input.dailyPrompt, input.sessions, input.date, config);
    attempt = await requestSuggestion(deps.provider, prompt, { userId: input.userId });
    outcome = decide(attempt, input, config);
  } catch (error) {
    const audit = { ...auditOf(attempt), verdict: null, reasons: [errorName(error)] };
    outcome = fallback(input, config, 'internal_error', audit, [RULES_ONLY_NOTE]);
  }

  const record: CoachDecisionRecord = {
    userId: input.userId,
    origin: 'daily',
    date: input.date,
    promptVersion: input.promptVersion,
    suggestionPromptVersion: SUGGESTION_PROMPT_VERSION,
    contextHash: sha256(prompt),
    ...outcome,
    summary: summarizeChanges(outcome.finalChanges, input.sessions),
  };
  await deps.decisions.write(record);
  return record;
}

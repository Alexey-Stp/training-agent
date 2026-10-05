import type { Intensity, Sport } from '@triathlon/core';
import type { PlannedSessionStatus } from '../context/types';
import type { BlockReview } from '../block/schema';
import type { WeeklyReview } from '../weekly/schema';
import type { CoachAction, CoachSuggestion, SessionDiff } from './schema';

/** A planned session the coach may change. `id` is `sessionKey(session)`. */
export interface CoachPlanSession {
  id: string;
  date: string; // YYYY-MM-DD, athlete-local
  slot: string;
  sport: Sport;
  title: string;
  durationMin: number;
  intensity: Intensity;
  status: PlannedSessionStatus;
  tags?: string[];
}

export type GuardrailVerdict = 'accept' | 'clamp' | 'reject';

export type CoachDecisionSource = 'llm' | 'repaired' | 'fallback';

/**
 * `daily`: the daily coaching run; `chat`: a suggestion from free-form coach chat; `weekly`: the
 * Sunday weekly review, whose changes target next week; `block`: a block review, whose `adjust`
 * is a season re-projection (no session changes)
 */
export type CoachDecisionOrigin = 'daily' | 'chat' | 'weekly' | 'block';

/** A stored decision's action: the LLM's actions plus `adjust`, a weekly change that adds minutes */
export type CoachDecisionAction = CoachAction | 'adjust';

export type FallbackReason =
  'llm_unavailable' | 'invalid_output' | 'guardrail_reject' | 'internal_error';

/**
 * Everything one daily coaching run, chat suggestion or weekly review decided, stored as a
 * `CoachDecision` row.
 */
export interface CoachDecisionRecord {
  userId: string;
  origin: CoachDecisionOrigin;
  date: string;
  promptVersion: string;
  suggestionPromptVersion: string;
  /** sha256 of the full prompt sent to the LLM */
  contextHash: string;
  source: CoachDecisionSource;
  fallbackReason: FallbackReason | null;
  /** LLM calls made (0 when none was attempted, at most 2) */
  attempts: number;
  /** Raw LLM replies, one per call that returned */
  rawResponses: string[];
  /** The parsed suggestion (a weekly or block review for those origins), before guardrails */
  suggestion: CoachSuggestion | WeeklyReview | BlockReview | null;
  /** null when no suggestion reached the guardrails */
  verdict: GuardrailVerdict | null;
  reasons: string[];
  finalAction: CoachDecisionAction;
  finalChanges: SessionDiff[];
  summary: string;
  athleteMessage: string;
}

export interface CoachDecisionSink {
  /** Stores the decision and returns its id */
  write(record: CoachDecisionRecord): Promise<string>;
}

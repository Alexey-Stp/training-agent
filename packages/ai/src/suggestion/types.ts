import type { Intensity, Sport } from '@triathlon/core';
import type { PlannedSessionStatus } from '../context/types';
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

export type FallbackReason =
  'llm_unavailable' | 'invalid_output' | 'guardrail_reject' | 'internal_error';

/** Everything one daily coaching run decided, stored as a `CoachDecision` row. */
export interface CoachDecisionRecord {
  userId: string;
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
  /** The parsed suggestion, before guardrails */
  suggestion: CoachSuggestion | null;
  /** null when no suggestion reached the guardrails */
  verdict: GuardrailVerdict | null;
  reasons: string[];
  finalAction: CoachAction;
  finalChanges: SessionDiff[];
  summary: string;
  athleteMessage: string;
}

export interface CoachDecisionSink {
  write(record: CoachDecisionRecord): Promise<void>;
}

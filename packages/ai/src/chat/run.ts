import type { RulesContext } from '@triathlon/core';
import type { LlmProvider } from '../types';
import { errorName, sha256 } from '../util';
import {
  DEFAULT_GUARDRAIL_CONFIG,
  runGuardrails,
  type GuardrailConfig,
  type GuardrailResult,
} from '../suggestion/guardrails';
import { renderSafeMessage, summarizeChanges } from '../suggestion/message';
import { parseJsonReply, requestStructured, type StructuredAttempt } from '../suggestion/parse';
import type { CoachSuggestion } from '../suggestion/schema';
import type {
  CoachDecisionRecord,
  CoachDecisionSink,
  CoachPlanSession,
  GuardrailVerdict,
} from '../suggestion/types';
import { buildChatPrompt, chatSystemPrompt, CHAT_PROMPT_VERSION, type ChatTurn } from './prompt';
import { chatReplyJsonSchema, ChatReplySchema, type ChatReply } from './schema';

export const CHAT_PURPOSE = 'coach-chat';
export const CHAT_REPAIR_PURPOSE = 'coach-chat-repair';

export const CHAT_UNAVAILABLE_REPLY =
  "Sorry, I can't answer right now. Please try again in a few minutes.";

export interface RunCoachChatDeps {
  /** Wrap it in `withCallLog` so every call lands in LlmCallLog */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: GuardrailConfig;
}

export interface RunCoachChatInput {
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
  /** Earlier messages, oldest first */
  history: readonly ChatTurn[];
  message: string;
}

export interface CoachChatResult {
  /** What to send the athlete */
  reply: string;
  /** The stored decision, when the reply carried a suggestion */
  decisionId: string | null;
  /** True when the decision has changes the athlete can apply (show Apply/Keep) */
  applicable: boolean;
  verdict: GuardrailVerdict | null;
  /** LLM calls made: 1 or 2 */
  attempts: number;
  /** True when the LLM was down or invalid twice and `reply` is the apology */
  unavailable: boolean;
}

type Judged = Pick<
  CoachDecisionRecord,
  'verdict' | 'reasons' | 'finalAction' | 'finalChanges' | 'athleteMessage'
>;

function withNote(reply: string, note: string): string {
  return reply.trimEnd() + '\n\n' + note;
}

/** Guardrails on the chat suggestion. Unlike the daily run there is no rules-engine fallback. */
function judge(
  reply: string,
  suggestion: CoachSuggestion,
  input: RunCoachChatInput,
  config: GuardrailConfig
): Judged {
  let result: GuardrailResult;
  try {
    result = runGuardrails(
      { date: input.date, sessions: input.sessions, context: input.context, suggestion },
      config
    );
  } catch (error) {
    result = { verdict: 'reject', reasons: [errorName(error)], changes: [], sessions: [] };
  }
  if (result.verdict === 'reject' || result.changes.length === 0) {
    const why = result.reasons.map((r) => '• ' + r);
    const note = ["I can't apply that change safely, so your plan stays as it is.", ...why];
    return {
      verdict: result.verdict,
      reasons: result.reasons,
      finalAction: 'keep',
      finalChanges: [],
      athleteMessage: withNote(reply, note.join('\n')),
    };
  }
  const notes = result.verdict === 'clamp' ? result.reasons : [];
  return {
    verdict: result.verdict,
    reasons: result.reasons,
    finalAction: suggestion.action,
    finalChanges: result.changes,
    athleteMessage: withNote(reply, renderSafeMessage(result.changes, input.sessions, notes)),
  };
}

function toResult(
  attempt: StructuredAttempt<ChatReply>,
  reply: string,
  verdict: GuardrailVerdict | null = null,
  decisionId: string | null = null,
  applicable = false
): CoachChatResult {
  return {
    reply,
    decisionId,
    applicable,
    verdict,
    attempts: attempt.attempts,
    unavailable: attempt.value === null,
  };
}

/**
 * One coach-chat answer: daily context + history + message → LLM (one repair at most).
 * A reply that changes the plan goes through the guardrails and is stored as a `CoachDecision`
 * the athlete can apply; a plain answer writes nothing. Only a failing decision write throws.
 */
export async function runCoachChat(
  deps: RunCoachChatDeps,
  input: RunCoachChatInput
): Promise<CoachChatResult> {
  const config = deps.guardrailConfig ?? DEFAULT_GUARDRAIL_CONFIG;
  const prompt = buildChatPrompt(input, config);
  const attempt = await requestStructured(deps.provider, prompt, {
    opts: {
      purpose: CHAT_PURPOSE,
      promptVersion: CHAT_PROMPT_VERSION,
      system: chatSystemPrompt(),
      jsonSchema: chatReplyJsonSchema(),
      userId: input.userId,
    },
    repairPurpose: CHAT_REPAIR_PURPOSE,
    parse: (raw) => parseJsonReply(ChatReplySchema, raw),
  });

  const { value } = attempt;
  if (value === null) return toResult(attempt, CHAT_UNAVAILABLE_REPLY);
  const { reply, suggestion } = value;
  if (suggestion === null || suggestion.changes.length === 0) return toResult(attempt, reply);

  const judged = judge(reply, suggestion, input, config);
  const record: CoachDecisionRecord = {
    userId: input.userId,
    origin: 'chat',
    date: input.date,
    promptVersion: input.promptVersion,
    suggestionPromptVersion: CHAT_PROMPT_VERSION,
    contextHash: sha256(prompt),
    source: attempt.status === 'repaired' ? 'repaired' : 'llm',
    fallbackReason: null,
    attempts: attempt.attempts,
    rawResponses: attempt.rawResponses,
    suggestion,
    ...judged,
    summary: summarizeChanges(judged.finalChanges, input.sessions),
  };
  const decisionId = await deps.decisions.write(record);
  const applicable = judged.finalChanges.length > 0;
  return toResult(attempt, judged.athleteMessage, judged.verdict, decisionId, applicable);
}

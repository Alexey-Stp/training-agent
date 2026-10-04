import {
  COACH_CHAT_HISTORY_SIZE,
  coachDecisionData,
  localToday,
  type RulesContext,
} from '@triathlon/core';
import {
  buildDailyContext,
  runCoachChat,
  type ChatTurn,
  type CoachDecisionSink,
  type DailyContextDeps,
  type GuardrailConfig,
  type LlmProvider,
} from '@triathlon/ai';
import type { ChatLimiter } from './chat-limit';
import { coachPlanWindow, toCoachPlanSession } from './coach-plan';
import { MSG_NO_PROFILE } from './profile';
import type { Reply } from './reply';

export interface StoredChatMessage {
  role: ChatTurn['role'];
  text: string;
  /** The athlete's message the row is, or answers */
  telegramMessageId: number;
  /** The decision the Apply/Keep buttons of a coach reply carry */
  coachDecisionId: string | null;
}

export interface CoachChatRepo {
  /** Stores a message; one per (telegramMessageId, role), so a retry writes nothing new. */
  saveMessage(userId: string, message: StoredChatMessage): Promise<void>;
  /** The coach reply already stored for the athlete's message, if a previous attempt got that far */
  findReply(userId: string, telegramMessageId: number): Promise<StoredChatMessage | null>;
  /** The latest `limit` messages, oldest first, leaving out those of `excludeMessageId` */
  listRecent(userId: string, limit: number, excludeMessageId: number): Promise<ChatTurn[]>;
}

export interface CoachChatDeps {
  limiter: ChatLimiter;
  /** Messages per athlete and local day (`COACH_CHAT_DAILY_LIMIT`) */
  dailyLimit: number;
  chats: CoachChatRepo;
  /** Daily context reads; `planned` also gives the sessions the coach may change */
  context: DailyContextDeps;
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  /** Wrapped in `withCallLog` */
  provider: LlmProvider;
  decisions: CoachDecisionSink;
  guardrailConfig?: GuardrailConfig;
  /** `AI_CONTEXT_TOKEN_BUDGET` */
  tokenBudget?: number;
  now(): Date;
}

export interface CoachChatUser {
  id: string;
  profile: { timezone: string } | null;
}

export interface ChatMessage {
  text: string;
  telegramMessageId: number;
}

export const MSG_EMPTY_CHAT = 'Send me a question about your training and I’ll answer.';

export function chatLimitNotice(limit: number): string {
  return (
    `You’ve reached today’s limit of ${limit.toString()} coach messages. ` +
    'I’ll be glad to pick this up tomorrow. Your commands (/plan, /week show, …) still work.'
  );
}

function toReply(text: string, decisionId: string | null): Reply {
  if (decisionId === null) return text;
  return {
    text,
    keyboard: [
      [
        { text: '✅ Apply', data: coachDecisionData('apply', decisionId) },
        { text: '↩️ Keep my plan', data: coachDecisionData('keep', decisionId) },
      ],
    ],
  };
}

/**
 * Free-form coach chat: rate limit → daily context + plan + last messages → LLM → reply,
 * with Apply/Keep buttons when the coach proposes a plan change that passed the guardrails.
 * Both messages are stored. Over the daily limit, no LLM call is made.
 */
export async function handleCoachChat(
  user: CoachChatUser,
  message: ChatMessage,
  deps: CoachChatDeps
): Promise<Reply> {
  if (!user.profile) return MSG_NO_PROFILE;
  const text = message.text.trim();
  if (text === '') return MSG_EMPTY_CHAT;

  const { telegramMessageId } = message;
  // A retry after the reply was stored resends it instead of asking the LLM again
  const stored = await deps.chats.findReply(user.id, telegramMessageId);
  if (stored) return toReply(stored.text, stored.coachDecisionId);

  const today = localToday(deps.now(), user.profile.timezone);
  const count = await deps.limiter.count(user.id, today, telegramMessageId);
  if (count > deps.dailyLimit) return chatLimitNotice(deps.dailyLimit);

  await deps.chats.saveMessage(user.id, {
    role: 'user',
    text,
    telegramMessageId,
    coachDecisionId: null,
  });

  const window = coachPlanWindow(today);
  const [history, daily, planned, context] = await Promise.all([
    deps.chats.listRecent(user.id, COACH_CHAT_HISTORY_SIZE, telegramMessageId),
    buildDailyContext(deps.context, user.id, today, { tokenBudget: deps.tokenBudget }),
    deps.context.planned.listRange(user.id, window.from, window.to),
    deps.getRulesContext(user.id, today),
  ]);

  const result = await runCoachChat(
    { provider: deps.provider, decisions: deps.decisions, guardrailConfig: deps.guardrailConfig },
    {
      userId: user.id,
      date: today,
      dailyPrompt: daily.prompt,
      promptVersion: daily.promptVersion,
      sessions: planned.map(toCoachPlanSession),
      context,
      history,
      message: text,
    }
  );
  const decisionId = result.applicable ? result.decisionId : null;
  // The apology isn't an answer: a retry or the next message asks the coach again
  if (result.unavailable) return result.reply;
  await deps.chats.saveMessage(user.id, {
    role: 'coach',
    text: result.reply,
    telegramMessageId,
    coachDecisionId: decisionId,
  });
  return toReply(result.reply, decisionId);
}

import { loadPromptTemplate, renderTemplate } from '../context/template';
import { DEFAULT_GUARDRAIL_CONFIG, type GuardrailConfig } from '../suggestion/guardrails';
import { renderSessionLines } from '../suggestion/prompt';
import type { CoachPlanSession } from '../suggestion/types';

export const CHAT_PROMPT_VERSION = 'chat-v1';
export const CHAT_SYSTEM_PROMPT_VERSION = 'chat-system-v1';

/** One stored chat message; `coach` is a reply the bot sent */
export interface ChatTurn {
  role: 'user' | 'coach';
  text: string;
}

const SPEAKERS: Readonly<Record<ChatTurn['role'], string>> = { user: 'Athlete', coach: 'Coach' };

/** Earlier messages, oldest first, as given; `None.` for a first message. */
export function renderChatHistory(history: readonly ChatTurn[]): string {
  if (history.length === 0) return 'None.';
  return history.map((turn) => SPEAKERS[turn.role] + ': ' + turn.text.trim()).join('\n\n');
}

/** Coach persona, grounding rules and the medical boundary; sent as the system prompt */
export function chatSystemPrompt(): string {
  return loadPromptTemplate(CHAT_SYSTEM_PROMPT_VERSION);
}

export interface ChatPromptInput {
  dailyPrompt: string;
  date: string;
  sessions: readonly CoachPlanSession[];
  history: readonly ChatTurn[];
  message: string;
}

/** The daily context prompt plus the chat history, the new message and the answer format. */
export function buildChatPrompt(
  input: ChatPromptInput,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): string {
  const chat = renderTemplate(loadPromptTemplate(CHAT_PROMPT_VERSION), {
    date: input.date,
    history: renderChatHistory(input.history),
    message: input.message.trim(),
    maxReduction: Math.round(config.maxReduction * 100).toString(),
    lowReadiness: config.lowReadiness.toString(),
    sessions: renderSessionLines(input.sessions, config),
  });
  return input.dailyPrompt.trimEnd() + '\n\n' + chat;
}

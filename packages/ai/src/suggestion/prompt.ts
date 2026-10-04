import { loadPromptTemplate, renderTemplate } from '../context/template';
import { DEFAULT_GUARDRAIL_CONFIG, type GuardrailConfig } from './guardrails';
import type { CoachPlanSession } from './types';

export const SUGGESTION_PROMPT_VERSION = 'suggestion-v1';

function sessionLine(s: CoachPlanSession, config: GuardrailConfig): string {
  const locked = config.lockedStatuses.has(s.status) ? ' (locked: ' + s.status + ')' : '';
  const zone = s.intensity.toUpperCase();
  return `- \`${s.id}\`: ${s.sport} ${s.durationMin.toString()} min ${zone} "${s.title}"${locked}`;
}

/** The sessions the coach may change, one line each with its id; `None.` when there are none. */
export function renderSessionLines(
  sessions: readonly CoachPlanSession[],
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): string {
  const lines = [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
    .map((s) => sessionLine(s, config));
  return lines.length > 0 ? lines.join('\n') : 'None.';
}

/** The daily context prompt plus the answer format and the guardrail limits, stated up front. */
export function buildSuggestionPrompt(
  dailyPrompt: string,
  sessions: readonly CoachPlanSession[],
  date: string,
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): string {
  const instructions = renderTemplate(loadPromptTemplate(SUGGESTION_PROMPT_VERSION), {
    date,
    maxReduction: Math.round(config.maxReduction * 100).toString(),
    lowReadiness: config.lowReadiness.toString(),
    sessions: renderSessionLines(sessions, config),
  });
  return dailyPrompt.trimEnd() + '\n\n' + instructions;
}

/** Re-prompt after an invalid reply: the original prompt, the reply, and what was wrong. */
export function buildRepairPrompt(prompt: string, badReply: string, error: string): string {
  return [
    prompt.trimEnd(),
    '',
    '## Your previous reply was invalid',
    '',
    'It failed validation with:',
    '',
    error,
    '',
    'Your previous reply:',
    '',
    badReply,
    '',
    'Reply again with one corrected JSON object only.',
  ].join('\n');
}

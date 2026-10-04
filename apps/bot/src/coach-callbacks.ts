import { COACH_APPLY_COMMAND, COACH_KEEP_COMMAND, parseCoachDecision } from '@triathlon/core';
import type { DecisionJob } from './season-callbacks';

/** Maps a coach Apply/Keep button (`cc:<a|k>:<decisionId>`) to its job, or null for other data. */
export function routeCoachDecision(data: string): DecisionJob | null {
  const parsed = parseCoachDecision(data);
  if (!parsed) return null;
  const { answer, decisionId } = parsed;
  return answer === 'apply'
    ? { commandName: COACH_APPLY_COMMAND, args: [decisionId], toast: 'Applying…' }
    : { commandName: COACH_KEEP_COMMAND, args: [decisionId], toast: 'Keeping your plan' };
}

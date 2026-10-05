import {
  COACH_APPLY_COMMAND,
  COACH_DISCUSS_COMMAND,
  COACH_KEEP_COMMAND,
  parseCoachDecision,
  type CoachAnswer,
} from '@triathlon/core';
import type { DecisionJob } from './season-callbacks';

const JOBS: Readonly<Record<CoachAnswer, { commandName: string; toast: string }>> = {
  apply: { commandName: COACH_APPLY_COMMAND, toast: 'Applying…' },
  keep: { commandName: COACH_KEEP_COMMAND, toast: 'Keeping your plan' },
  discuss: { commandName: COACH_DISCUSS_COMMAND, toast: 'Opening chat…' },
};

/**
 * Maps a coach Apply/Keep/Discuss button (`cc:<a|k|d>:<decisionId>`) to its job, or null for
 * other data.
 */
export function routeCoachDecision(data: string): DecisionJob | null {
  const parsed = parseCoachDecision(data);
  if (!parsed) return null;
  const { commandName, toast } = JOBS[parsed.answer];
  return { commandName, args: [parsed.decisionId], toast };
}

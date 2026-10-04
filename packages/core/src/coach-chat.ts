/**
 * Contract between the bot and the worker for free-form coach chat: the internal command names
 * the bot enqueues and the callback data of the Apply/Keep buttons on a coach reply.
 */

/** Plain (non-command) text; the message travels in `CommandJob.rawText`, args: [] */
export const COACH_CHAT_COMMAND = 'coach_chat';
/** args: [decisionId] */
export const COACH_APPLY_COMMAND = 'coach_apply';
/** args: [decisionId] */
export const COACH_KEEP_COMMAND = 'coach_keep';

/** Messages a chat history window holds (both directions) */
export const COACH_CHAT_HISTORY_SIZE = 10;

export type CoachAnswer = 'apply' | 'keep';

const ANSWER_CODES: Readonly<Record<CoachAnswer, string>> = { apply: 'a', keep: 'k' };
const CODE_ANSWERS: ReadonlyMap<string, CoachAnswer> = new Map([
  ['a', 'apply'],
  ['k', 'keep'],
]);
/** Decision ids are Prisma cuids; the bound also keeps callback data under Telegram's 64 bytes */
const DECISION_ID_RE = /^[a-z0-9]{1,40}$/i;

/** Callback data of an Apply/Keep button, e.g. `cc:a:<decisionId>`. */
export function coachDecisionData(answer: CoachAnswer, decisionId: string): string {
  return `cc:${ANSWER_CODES[answer]}:${decisionId}`;
}

/** Inverse of `coachDecisionData`; null for anything else. */
export function parseCoachDecision(
  data: string
): { answer: CoachAnswer; decisionId: string } | null {
  const [prefix, code, decisionId, ...rest] = data.split(':');
  if (prefix !== 'cc' || rest.length > 0 || decisionId === undefined) return null;
  const answer = CODE_ANSWERS.get(code);
  if (answer === undefined || !DECISION_ID_RE.test(decisionId)) return null;
  return { answer, decisionId };
}

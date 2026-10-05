/**
 * Contract between the bot and the worker for free-form coach chat: the internal command names
 * the bot enqueues and the callback data of the Apply/Keep/Discuss buttons on a coach reply or
 * a morning brief.
 */

/** Plain (non-command) text; the message travels in `CommandJob.rawText`, args: [] */
export const COACH_CHAT_COMMAND = 'coach_chat';
/** args: [decisionId] */
export const COACH_APPLY_COMMAND = 'coach_apply';
/** args: [decisionId] */
export const COACH_KEEP_COMMAND = 'coach_keep';
/** args: [decisionId]; opens coach chat seeded with the suggestion */
export const COACH_DISCUSS_COMMAND = 'coach_discuss';

/** Messages a chat history window holds (both directions) */
export const COACH_CHAT_HISTORY_SIZE = 10;

export type CoachAnswer = 'apply' | 'keep' | 'discuss';

const ANSWER_CODES: Readonly<Record<CoachAnswer, string>> = { apply: 'a', keep: 'k', discuss: 'd' };
const CODE_ANSWERS: ReadonlyMap<string, CoachAnswer> = new Map([
  ['a', 'apply'],
  ['k', 'keep'],
  ['d', 'discuss'],
]);
/** Decision ids are Prisma cuids; the bound also keeps callback data under Telegram's 64 bytes */
const DECISION_ID_RE = /^[a-z0-9]{1,40}$/i;

/** Callback data of an Apply/Keep/Discuss button, e.g. `cc:a:<decisionId>`. */
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

/** Shown when an Apply/Keep/Discuss button is tapped after the decision's buttons expired */
export const MSG_DECISION_EXPIRED =
  '⌛ This brief has expired. Send /plan today to see today’s plan.';

/** A decision's buttons expire `ttlHours` after it was issued. */
export function isDecisionExpired(issuedAt: Date, now: Date, ttlHours: number): boolean {
  return now.getTime() - issuedAt.getTime() > ttlHours * 3_600_000;
}

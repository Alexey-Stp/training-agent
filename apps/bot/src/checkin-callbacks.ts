import { CHECKIN_ANSWER_COMMAND, parseCheckInData } from '@triathlon/core';
import type { DecisionJob } from './season-callbacks';

/**
 * Maps a morning check-in button (`ci:<r|s>:<value>`) to its job, or null for other data.
 * Unlike a decision, a check-in keeps its buttons on the tap: the worker edits the message so
 * the other question stays answerable.
 */
export function routeCheckIn(data: string): DecisionJob | null {
  const parsed = parseCheckInData(data);
  if (!parsed) return null;
  return {
    commandName: CHECKIN_ANSWER_COMMAND,
    args: [parsed.field, parsed.value.toString()],
    toast: 'Saved',
  };
}

/**
 * Both check-in questions sit on one message, so the job id names the button too: a double tap
 * enqueues once, and the second question still gets its own job.
 */
export function checkInJobId(chatId: number, messageId: number, job: DecisionJob): string {
  return `cb-${chatId.toString()}-${messageId.toString()}-${job.args.join('')}`;
}

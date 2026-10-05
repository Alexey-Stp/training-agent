import { parseCheckInAnswer } from '@triathlon/core';
import type { Reply } from '../reply';
import { isCheckInComplete, renderCheckIn, renderCheckInDone, type CheckInRepo } from './checkin';
import type { DailyBriefRunRepo } from './run-store';

export interface CheckInAnswerDeps {
  runs: Pick<DailyBriefRunRepo, 'findByCheckInMessage'>;
  wellness: CheckInRepo;
  /** Promotes the day's delayed brief continuation (scheduler `CheckInContinuation.resume`) */
  resume(userId: string, date: string): Promise<void>;
}

/** A tap on a check-in button */
export interface CheckInAnswerInput {
  /** `CommandJob.args`: [field, value] */
  args: readonly string[];
  /** The check-in message that carried the button */
  telegramMessageId: number;
}

export const MSG_CHECKIN_NOT_FOUND = 'That check-in is no longer available.';
export const MSG_CHECKIN_INVALID = '❌ I didn’t understand that answer.';

/**
 * Stores one check-in answer for the day of the tapped check-in and edits the check-in message:
 * the answered row disappears. Once both answers are in while the brief is still waiting, the
 * brief continuation runs right away; a late answer is still stored, for later briefs and chat.
 *
 * Safe to repeat: the first answer per field wins, and resuming a continuation that already ran
 * does nothing.
 */
export async function handleCheckInAnswer(
  userId: string,
  input: CheckInAnswerInput,
  deps: CheckInAnswerDeps
): Promise<Reply> {
  const answer = parseCheckInAnswer(input.args[0], input.args[1]);
  if (!answer) return MSG_CHECKIN_INVALID;
  const run = await deps.runs.findByCheckInMessage(userId, input.telegramMessageId);
  if (!run) return MSG_CHECKIN_NOT_FOUND;

  const answers = await deps.wellness.recordCheckIn(userId, run.date, answer.field, answer.value);
  const waiting = run.status === 'awaiting_checkin';
  if (waiting && !isCheckInComplete(answers)) {
    return { ...renderCheckIn(answers), editTapped: true };
  }
  if (waiting) await deps.resume(userId, run.date);
  return { ...renderCheckInDone(answers, run.status !== 'sent'), editTapped: true };
}

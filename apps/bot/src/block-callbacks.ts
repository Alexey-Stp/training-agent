import {
  BLOCK_CONFIRM_COMMAND,
  BLOCK_DECLINE_COMMAND,
  parseBlockReview,
  type BlockReviewAnswer,
} from '@triathlon/core';
import type { DecisionJob } from './season-callbacks';

const JOBS: Readonly<Record<BlockReviewAnswer, { commandName: string; toast: string }>> = {
  confirm: { commandName: BLOCK_CONFIRM_COMMAND, toast: 'Re-projecting your season…' },
  decline: { commandName: BLOCK_DECLINE_COMMAND, toast: 'Keeping your season' },
};

/**
 * Maps a block review Confirm/Decline button (`br:<c|d>:<runId>`) to its job, or null for other
 * data. The worker checks BLOCK_REVIEW_TTL_HOURS.
 */
export function routeBlockReview(data: string): DecisionJob | null {
  const parsed = parseBlockReview(data);
  if (!parsed) return null;
  const { commandName, toast } = JOBS[parsed.answer];
  return { commandName, args: [parsed.runId], toast };
}

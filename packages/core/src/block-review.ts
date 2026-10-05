/**
 * Contract between the bot and the worker for the block review: the internal command names the
 * bot enqueues and the callback data of the Confirm/Decline buttons on a re-projection proposal.
 */

/** args: [runId]; applies the proposed re-projection */
export const BLOCK_CONFIRM_COMMAND = 'block_confirm';
/** args: [runId]; keeps the season unchanged */
export const BLOCK_DECLINE_COMMAND = 'block_decline';

export type BlockReviewAnswer = 'confirm' | 'decline';

const ANSWER_CODES: Readonly<Record<BlockReviewAnswer, string>> = { confirm: 'c', decline: 'd' };
const CODE_ANSWERS: ReadonlyMap<string, BlockReviewAnswer> = new Map([
  ['c', 'confirm'],
  ['d', 'decline'],
]);
/** Run ids are Prisma cuids; the bound also keeps callback data under Telegram's 64 bytes */
const RUN_ID_RE = /^[a-z0-9]{1,40}$/i;

/** Callback data of a Confirm/Decline button, e.g. `br:c:<runId>`. */
export function blockReviewData(answer: BlockReviewAnswer, runId: string): string {
  return `br:${ANSWER_CODES[answer]}:${runId}`;
}

/** Inverse of `blockReviewData`; null for anything else. */
export function parseBlockReview(
  data: string
): { answer: BlockReviewAnswer; runId: string } | null {
  const [prefix, code, runId, ...rest] = data.split(':');
  if (prefix !== 'br' || rest.length > 0 || runId === undefined) return null;
  const answer = CODE_ANSWERS.get(code);
  if (answer === undefined || !RUN_ID_RE.test(runId)) return null;
  return { answer, runId };
}

/** Shown when Confirm/Decline is tapped after the proposal expired */
export const MSG_BLOCK_REVIEW_EXPIRED =
  '⌛ This block review has expired. The season is unchanged; send /season show to see it.';

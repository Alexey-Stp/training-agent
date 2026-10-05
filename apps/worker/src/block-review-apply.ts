import type { Profile } from '@prisma/client';
import {
  escapeHtml,
  isDecisionExpired,
  MSG_BLOCK_REVIEW_EXPIRED,
  type BlockReviewAnswer,
} from '@triathlon/core';
import type { CoachAnswerRepo } from './coach-apply';
import { MSG_NO_PROFILE } from './profile';
import type { Reply } from './reply';
import type { BlockReviewRunRepo, SeasonReprojectRepo } from './reviews/block-review-store';

export const MSG_BLOCK_REVIEW_NOT_FOUND = 'That block review is no longer available.';
export const MSG_BLOCK_REVIEW_ANSWERED = 'You already answered that block review.';
export const MSG_REPROJECTION_APPLIED =
  '✅ Season re-projected. The new blocks start tomorrow; past weeks are unchanged.';
export const MSG_REPROJECTION_DECLINED = '👍 Season kept as it is.';
export const MSG_SEASON_CHANGED =
  '⚠️ The season changed since this review, so nothing was applied. Send /season show to see it.';

export interface BlockReviewAnswerInput {
  runId: string | undefined;
  answer: BlockReviewAnswer;
}

export interface BlockReviewAnswerDeps {
  runs: Pick<BlockReviewRunRepo, 'findAnswerable'>;
  decisions: Pick<CoachAnswerRepo, 'findDecision' | 'decline'>;
  seasons: Pick<SeasonReprojectRepo, 'applyReprojection'>;
  /** Republishes the rolling window of the season (the publisher writes T+1 onward only) */
  publish(userId: string, runId: string): Promise<void>;
  /** BLOCK_REVIEW_TTL_HOURS */
  ttlHours: number;
  now(): Date;
}

/** The report the buttons were on, with the outcome below it and no buttons left. */
function answered(reportText: string | null, result: string): Reply {
  if (reportText === null) return result;
  return { text: reportText + '\n\n' + escapeHtml(result), html: true, editTapped: true };
}

/**
 * Confirm or Decline on a block review. Decline records the answer on the review's
 * CoachDecision (`keep`) and leaves the season alone. Confirm applies the stored
 * re-projection in one transaction, only while the decision is unanswered and the season is
 * still the version it was computed from, then republishes the rolling window.
 */
export async function handleBlockReviewAnswer(
  user: { id: string; profile: Profile | null },
  input: BlockReviewAnswerInput,
  deps: BlockReviewAnswerDeps
): Promise<Reply> {
  if (!user.profile) return MSG_NO_PROFILE;
  const run =
    input.runId === undefined ? null : await deps.runs.findAnswerable(user.id, input.runId);
  const decisionId = run?.coachDecisionId ?? null;
  const decision =
    decisionId === null ? null : await deps.decisions.findDecision(user.id, decisionId);
  if (!run || decision?.origin !== 'block') return MSG_BLOCK_REVIEW_NOT_FOUND;
  if (decision.accepted !== null) return MSG_BLOCK_REVIEW_ANSWERED;

  const now = deps.now();
  if (isDecisionExpired(decision.createdAt, now, deps.ttlHours)) {
    return answered(run.reportText, MSG_BLOCK_REVIEW_EXPIRED);
  }
  if (input.answer === 'decline' || run.proposal === null || run.seasonUpdatedAt === null) {
    const declined = await deps.decisions.decline(user.id, decision.id, 'keep', now);
    return declined
      ? answered(run.reportText, MSG_REPROJECTION_DECLINED)
      : MSG_BLOCK_REVIEW_ANSWERED;
  }

  const result = await deps.seasons.applyReprojection(user.id, {
    seasonPlanId: run.seasonPlanId,
    expectedUpdatedAt: run.seasonUpdatedAt,
    decisionId: decision.id,
    proposal: run.proposal,
    now,
  });
  if (result === 'answered') return MSG_BLOCK_REVIEW_ANSWERED;
  if (result === 'stale') {
    await deps.decisions.decline(user.id, decision.id, 'apply', now);
    return answered(run.reportText, MSG_SEASON_CHANGED);
  }
  await deps.publish(user.id, run.id);
  return answered(run.reportText, MSG_REPROJECTION_APPLIED);
}

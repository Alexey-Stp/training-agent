import { beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '@prisma/client';
import { MSG_BLOCK_REVIEW_EXPIRED, TrainingBlockType, type TrainingBlock } from '@triathlon/core';
import {
  handleBlockReviewAnswer,
  MSG_BLOCK_REVIEW_ANSWERED,
  MSG_BLOCK_REVIEW_NOT_FOUND,
  MSG_REPROJECTION_APPLIED,
  MSG_REPROJECTION_DECLINED,
  MSG_SEASON_CHANGED,
  type BlockReviewAnswerDeps,
} from '../src/block-review-apply';
import type { AnswerableDecision } from '../src/coach-apply';
import type {
  ApplyReprojectionInput,
  ApplyReprojectionResult,
  BlockReviewAnswerable,
  ProposedSeason,
} from '../src/reviews/block-review-store';

const PROFILE: Profile = {
  id: 'profile-1',
  userId: 'user-1',
  ftp: 300,
  timezone: 'Europe/Prague',
  swimDays: ['Wed', 'Fri', 'Sun_optional'],
  bikeVo2Day: 'Thu',
  longBikeDay: 'Sun',
  noLongRunDay: 'Sun',
  briefTime: null,
  closeoutTime: null,
  lthr: null,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};
const USER = { id: 'user-1', profile: PROFILE };
const NOW = new Date('2026-10-04T18:00:00Z');
const SEASON_VERSION = new Date('2026-08-10T08:00:00Z');
const REPORT = '🧱 <b>Block 2 (build) review</b>';

function block(order: number, type: TrainingBlockType, startDate: string, hours: number) {
  return {
    order,
    type,
    startDate,
    weeks: 3,
    focus: type,
    targetWeeklyHours: hours,
    targetSwimM: 5000,
    targetBikeH: 5,
    targetRunKm: 30,
    targetCtl: null,
  } satisfies TrainingBlock;
}

const PROPOSAL: ProposedSeason = {
  raceDate: '2026-11-15',
  startDate: '2026-09-14',
  frozenCount: 1,
  truncated: null,
  blocks: [
    block(1, TrainingBlockType.build, '2026-09-14', 10),
    block(2, TrainingBlockType.peak, '2026-10-05', 8.2),
  ],
};

let run: BlockReviewAnswerable | null;
let decision: AnswerableDecision | null;
let applyResult: ApplyReprojectionResult;
let applied: ApplyReprojectionInput[];
let declined: string[];
let published: string[];

function deps(): BlockReviewAnswerDeps {
  return {
    runs: { findAnswerable: () => Promise.resolve(run) },
    decisions: {
      findDecision: () => Promise.resolve(decision),
      decline: (_userId, _id, userAction) => {
        declined.push(userAction);
        return Promise.resolve(true);
      },
    },
    seasons: {
      applyReprojection: (_userId, input) => {
        applied.push(input);
        return Promise.resolve(applyResult);
      },
    },
    publish: (_userId, runId) => {
      published.push(runId);
      return Promise.resolve();
    },
    ttlHours: 72,
    now: () => NOW,
  };
}

beforeEach(() => {
  run = {
    id: 'run1',
    seasonPlanId: 'season1',
    coachDecisionId: 'dec1',
    proposal: structuredClone(PROPOSAL),
    seasonUpdatedAt: SEASON_VERSION,
    reportText: REPORT,
  };
  decision = {
    id: 'dec1',
    origin: 'block',
    date: '2026-10-04',
    finalAction: 'adjust',
    finalChanges: [],
    athleteMessage: 'You managed 70%.',
    accepted: null,
    createdAt: new Date('2026-10-04T17:30:00Z'),
  };
  applyResult = 'applied';
  applied = [];
  declined = [];
  published = [];
});

describe('handleBlockReviewAnswer', () => {
  it('decline: leaves the season alone and records the answer', async () => {
    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'decline' }, deps());

    expect(applied).toEqual([]);
    expect(published).toEqual([]);
    expect(declined).toEqual(['keep']);
    expect(reply).toEqual({
      text: REPORT + '\n\n' + MSG_REPROJECTION_DECLINED,
      html: true,
      editTapped: true,
    });
  });

  it('confirm: applies the stored proposal to the season version it came from', async () => {
    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps());

    expect(applied).toEqual([
      {
        seasonPlanId: 'season1',
        expectedUpdatedAt: SEASON_VERSION,
        decisionId: 'dec1',
        proposal: PROPOSAL,
        now: NOW,
      },
    ]);
    expect(published).toEqual(['run1']);
    expect(declined).toEqual([]);
    expect(reply).toMatchObject({ text: REPORT + '\n\n' + MSG_REPROJECTION_APPLIED });
  });

  it('confirm on a season that changed since: nothing applied, the answer recorded', async () => {
    applyResult = 'stale';

    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps());

    expect(published).toEqual([]);
    expect(declined).toEqual(['apply']);
    expect(reply).toMatchObject({ text: REPORT + '\n\n' + MSG_SEASON_CHANGED });
  });

  it('a concurrent answer wins', async () => {
    applyResult = 'answered';
    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps());
    expect(reply).toBe(MSG_BLOCK_REVIEW_ANSWERED);
    expect(published).toEqual([]);
  });

  it('an answered review stays answered', async () => {
    if (decision) decision.accepted = false;
    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps());
    expect(reply).toBe(MSG_BLOCK_REVIEW_ANSWERED);
    expect(applied).toEqual([]);
  });

  it('an expired review changes nothing', async () => {
    if (decision) decision.createdAt = new Date(NOW.getTime() - 73 * 3_600_000);
    const reply = await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps());
    expect(reply).toMatchObject({ text: REPORT + '\n\n' + MSG_BLOCK_REVIEW_EXPIRED });
    expect(applied).toEqual([]);
    expect(declined).toEqual([]);
  });

  it('only answers block decisions', async () => {
    if (decision) decision.origin = 'weekly';
    expect(await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'confirm' }, deps())).toBe(
      MSG_BLOCK_REVIEW_NOT_FOUND
    );
    run = null;
    expect(await handleBlockReviewAnswer(USER, { runId: 'run1', answer: 'decline' }, deps())).toBe(
      MSG_BLOCK_REVIEW_NOT_FOUND
    );
  });
});

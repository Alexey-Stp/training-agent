import {
  RacePriority,
  RaceType,
  TrainingBlockType,
  type BlockVerdict,
  type TrainingBlock,
} from '@triathlon/core';
import type { BlockReview, RunBlockReviewInput } from '../../src';
import { USER_ID } from '../suggestion/fixtures';

export const REVIEW_DATE = '2026-10-04';

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number,
  hours: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: type === TrainingBlockType.build ? 'Race-specific endurance and threshold' : type,
    targetWeeklyHours: hours,
    targetSwimM: Math.round(hours * 375) * 2,
    targetBikeH: Math.round(hours * 5.5) / 10,
    targetRunKm: Math.round(hours * 30) / 10,
    targetCtl: null,
  };
}

export const BUILD = block(2, TrainingBlockType.build, '2026-09-14', 3, 10);

export const REMAINING: TrainingBlock[] = [
  block(3, TrainingBlockType.peak, '2026-10-05', 3, 10.8),
  block(4, TrainingBlockType.taper, '2026-10-26', 2, 6.4),
  block(5, TrainingBlockType.race, '2026-11-09', 1, 4.6),
];

export const PROPOSED: TrainingBlock[] = [
  { ...REMAINING[0], targetWeeklyHours: 7.6 },
  { ...REMAINING[1], targetWeeklyHours: 4.9 },
  { ...REMAINING[2], targetWeeklyHours: 3.5 },
];

export function verdict(volumeAchievedPct: number | null): BlockVerdict {
  const share = (volumeAchievedPct ?? 100) / 100;
  return {
    blockOrder: 2,
    blockType: TrainingBlockType.build,
    from: '2026-09-14',
    to: REVIEW_DATE,
    weeks: 3,
    targetWeeklyHours: 10,
    achievedWeeklyHours: volumeAchievedPct === null ? null : 10 * share,
    volumeAchievedPct,
    ctlStart: 50,
    ctlEnd: 52.5,
    ctlDelta: 2.5,
    targetCtl: null,
    ctlGap: null,
    weekly: [
      { isoWeek: '2026-W38', plannedMin: 600, actualMin: 600 * share + 60, compliancePct: null },
      { isoWeek: '2026-W39', plannedMin: 600, actualMin: 600 * share, compliancePct: null },
      { isoWeek: '2026-W40', plannedMin: 600, actualMin: 600 * share - 60, compliancePct: null },
    ].map((w) => ({ ...w, compliancePct: Math.round((w.actualMin / w.plannedMin) * 1000) / 10 })),
    complianceTrend: 'declining',
    missingWeeks: [],
  };
}

export function blockInput(
  volumeAchievedPct: number | null,
  overrides: Partial<RunBlockReviewInput> = {}
): RunBlockReviewInput {
  return {
    userId: USER_ID,
    date: REVIEW_DATE,
    trigger: 'block_end',
    block: BUILD,
    verdict: verdict(volumeAchievedPct),
    aRace: {
      date: '2026-11-15',
      name: 'Challenge Prague',
      priority: RacePriority.A,
      type: RaceType.half,
    },
    previousRaceDate: null,
    remaining: REMAINING,
    proposed: PROPOSED,
    proposalIssue: null,
    ...overrides,
  };
}

export function blockReview(overrides: Partial<BlockReview> = {}): BlockReview {
  return {
    summary: 'You did 70% of the planned volume (7.0 of 10.0 h/week).',
    wins: ['CTL up 2.5'],
    concerns: ['Compliance declined to 60% in the last week'],
    recommendation: 'reproject',
    reason: 'Start the peak from the volume you actually handled.',
    ...overrides,
  };
}

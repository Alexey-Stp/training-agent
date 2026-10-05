import type {
  BlockVerdict,
  DateRange,
  SeasonPlan,
  Sport,
  TrainingBlock,
  WeeklyStats,
} from '@triathlon/core';
import type { StageTimings } from '../daily-loop/run-store';
import type { RaceRecord } from '../race-command';
import type { InlineButton } from '../reply';

export type BlockReviewTrigger = 'block_end' | 'race_move';
export type BlockReviewStatus = 'pending' | 'running' | 'sent' | 'failed';

/** The `BlockReviewRun` row of one season and block end (or A-race move). */
export interface BlockReviewRun {
  id: string;
  status: BlockReviewStatus;
  coachDecisionId: string | null;
  /** The rendered report; set before the send, so a retry only resends it */
  reportText: string | null;
  reportKeyboard: InlineButton[][] | null;
  stageTimings: StageTimings;
}

export type BlockReviewClaimResult =
  | { status: 'claimed'; run: BlockReviewRun }
  /** Sent earlier: a second trigger does nothing */
  | { status: 'already_sent' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

/** The whole re-projected season: frozen blocks first, then the new ones. */
export interface ProposedSeason {
  /** The A-race date it was planned for; a later race move makes it stale */
  raceDate: string;
  startDate: string;
  frozenCount: number;
  truncated: { order: number; weeks: number } | null;
  blocks: TrainingBlock[];
}

export interface SavedBlockReport {
  coachDecisionId: string;
  verdict: BlockVerdict;
  /** null when the review keeps the season */
  proposal: ProposedSeason | null;
  freezeThrough: string;
  /** `SeasonPlan.updatedAt` the proposal was computed from */
  seasonUpdatedAt: Date;
  reportText: string;
  reportKeyboard: InlineButton[][];
  stale: boolean;
  stageTimings: StageTimings;
}

/** What a Confirm/Decline tap needs from the run. */
export interface BlockReviewAnswerable {
  id: string;
  seasonPlanId: string;
  coachDecisionId: string | null;
  proposal: ProposedSeason | null;
  seasonUpdatedAt: Date | null;
  reportText: string | null;
}

export interface ClaimKey {
  userId: string;
  seasonPlanId: string;
  /** `block:<order>` or `race:<raceId>:<newDate>` */
  key: string;
  trigger: BlockReviewTrigger;
}

/** One `BlockReviewRun` per (userId, seasonPlanId, key): the block review's idempotency key. */
export interface BlockReviewRunRepo {
  /**
   * Creates the run if needed and takes it over atomically: pending and failed runs can be
   * taken over, and so can a running one whose lease has expired.
   */
  claim(key: ClaimKey, now: Date, leaseMs: number): Promise<BlockReviewClaimResult>;
  saveReport(id: string, report: SavedBlockReport): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
  findAnswerable(userId: string, runId: string): Promise<BlockReviewAnswerable | null>;
}

/** The athlete's active season with what a re-projection needs beyond the plan itself. */
export interface ActiveSeasonRecord {
  id: string;
  updatedAt: Date;
  /** The wizard's answers; null for seasons created before they were stored */
  weeklyHoursAvailable: number | null;
  weakSport: Sport | null;
  season: SeasonPlan & { aRace: RaceRecord | null };
}

export type ApplyReprojectionResult = 'applied' | 'stale' | 'answered';

export interface ApplyReprojectionInput {
  seasonPlanId: string;
  expectedUpdatedAt: Date;
  decisionId: string;
  proposal: ProposedSeason;
  now: Date;
}

export interface SeasonReprojectRepo {
  findActiveRecord(userId: string): Promise<ActiveSeasonRecord | null>;
  /**
   * In one transaction: marks the decision applied (only while unanswered, else `answered`),
   * then, only while the season is still active at `expectedUpdatedAt` with its A-race on
   * `proposal.raceDate` (else `stale`, nothing changes), cuts the truncated block, replaces every
   * block after the frozen ones and bumps the season's `updatedAt`.
   */
  applyReprojection(
    userId: string,
    input: ApplyReprojectionInput
  ): Promise<ApplyReprojectionResult>;
}

/** Stored WeeklyStats of a range of weeks. */
export interface WeeklyStatsReader {
  /** Rows of the ISO weeks starting in `range` (Mondays, inclusive), any order */
  listRange(userId: string, range: DateRange): Promise<WeeklyStats[]>;
}

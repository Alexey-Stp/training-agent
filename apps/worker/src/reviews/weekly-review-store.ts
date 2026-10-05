import type { StageTimings } from '../daily-loop/run-store';
import type { InlineButton } from '../reply';

export type WeeklyReviewStatus = 'pending' | 'running' | 'sent' | 'failed';

/** The `WeeklyReviewRun` row of one athlete and ISO week. */
export interface WeeklyReviewRun {
  id: string;
  status: WeeklyReviewStatus;
  coachDecisionId: string | null;
  /** The rendered report; set before the send, so a retry only resends it */
  reportText: string | null;
  reportKeyboard: InlineButton[][] | null;
  stageTimings: StageTimings;
}

export type WeeklyReviewClaimResult =
  | { status: 'claimed'; run: WeeklyReviewRun }
  /** Sent earlier: a second trigger does nothing */
  | { status: 'already_sent' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

export interface SavedReport {
  coachDecisionId: string;
  reportText: string;
  reportKeyboard: InlineButton[][];
  stale: boolean;
  stageTimings: StageTimings;
}

/** One `WeeklyReviewRun` per (userId, isoWeek): the weekly review's idempotency key. */
export interface WeeklyReviewRunRepo {
  /**
   * Creates the week's run if needed and takes it over atomically: pending and failed runs can
   * be taken over, and so can a running one whose lease has expired.
   */
  claim(
    userId: string,
    isoWeek: string,
    now: Date,
    leaseMs: number
  ): Promise<WeeklyReviewClaimResult>;
  saveReport(id: string, report: SavedReport): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

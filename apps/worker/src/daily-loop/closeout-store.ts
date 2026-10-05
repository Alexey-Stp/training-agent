import type {
  CloseoutActivity,
  CloseoutSession,
  Intensity,
  IntensityThresholds,
} from '@triathlon/core';
import type { PlannedSessionStatus } from '../plan-store';
import type { StageTimings } from './run-store';

export type EveningCloseoutStatus = 'pending' | 'running' | 'quiet' | 'sent' | 'failed';

/** The `EveningCloseoutRun` row of one athlete and local day. */
export interface EveningCloseoutRun {
  id: string;
  status: EveningCloseoutStatus;
  /** The rendered close-out; set before the send, so a retry only resends it */
  messageText: string | null;
  stageTimings: StageTimings;
}

export type CloseoutClaimResult =
  | { status: 'claimed'; run: EveningCloseoutRun }
  /** Closed out earlier today (quiet or sent): a second trigger does nothing */
  | { status: 'already_done' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

/** One `EveningCloseoutRun` per (userId, date): the close-out's idempotency key. */
export interface EveningCloseoutRunRepo {
  /**
   * Creates the day's run if needed and takes it over atomically: pending and failed runs can
   * be taken over, and so can a running one whose lease has expired.
   */
  claim(userId: string, date: string, now: Date, leaseMs: number): Promise<CloseoutClaimResult>;
  saveMessage(id: string, messageText: string, stageTimings: StageTimings): Promise<void>;
  markQuiet(id: string, stageTimings: StageTimings): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

/** A planned session of the day, with the status the close-out decides from. */
export interface CloseoutDaySession extends CloseoutSession {
  status: PlannedSessionStatus;
}

export interface CloseoutDay {
  /** The day's sessions, tombstones included */
  sessions: CloseoutDaySession[];
  /** Activities whose local start date is the day */
  activities: CloseoutActivity[];
  thresholds: IntensityThresholds;
}

export interface SessionCloseout {
  sessionId: string;
  status: 'completed' | 'skipped';
  /** Completed only: actual vs planned duration */
  deviationPct: number | null;
  actualIntensity: Intensity | null;
}

export interface CloseoutWrite {
  sessions: SessionCloseout[];
  /** Every activity of the day: the session it fulfilled, or null for an unplanned one */
  links: { activityId: string; sessionId: string | null }[];
  closedOutAt: Date;
}

export interface CloseoutRepo {
  listDay(userId: string, date: string): Promise<CloseoutDay>;
  /**
   * Writes the day's statuses, deviations and activity links in one transaction. Only rows of
   * `date` change: sessions that aren't tombstoned, and activities that start on it.
   */
  apply(userId: string, date: string, write: CloseoutWrite): Promise<void>;
}

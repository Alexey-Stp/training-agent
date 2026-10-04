import type { InlineButton } from '../reply';

/** Pipeline stage → milliseconds of its latest attempt */
export type StageTimings = Record<string, number>;

export type DailyBriefStatus = 'pending' | 'running' | 'sent' | 'failed';

/** The `DailyBriefRun` row of one athlete and local day. */
export interface DailyBriefRun {
  id: string;
  status: DailyBriefStatus;
  coachDecisionId: string | null;
  /** The rendered brief; set once the coach has decided, so a retry only resends it */
  briefText: string | null;
  briefKeyboard: InlineButton[][] | null;
  stale: boolean;
  dataAsOf: Date | null;
  stageTimings: StageTimings;
}

export type ClaimResult =
  | { status: 'claimed'; run: DailyBriefRun }
  /** Sent earlier today: a second trigger does nothing */
  | { status: 'already_sent' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

export interface SavedBrief {
  coachDecisionId: string;
  briefText: string;
  briefKeyboard: InlineButton[][] | null;
  stale: boolean;
  dataAsOf: Date | null;
  stageTimings: StageTimings;
}

/** One `DailyBriefRun` per (userId, date): the morning pipeline's idempotency key. */
export interface DailyBriefRunRepo {
  /**
   * Creates the day's run if needed and takes it over atomically. A run that is pending or
   * failed can be taken over, and so can a running one whose lease (`startedAt + leaseMs`) has
   * expired. A sent run, or a running one still within its lease, is not taken over.
   */
  claim(userId: string, date: string, now: Date, leaseMs: number): Promise<ClaimResult>;
  saveBrief(id: string, brief: SavedBrief): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

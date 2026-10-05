import type { InlineButton } from '../reply';

/** Pipeline stage → milliseconds of its latest attempt */
export type StageTimings = Record<string, number>;

export type DailyBriefStatus = 'pending' | 'running' | 'awaiting_checkin' | 'sent' | 'failed';

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
  /** Set once the check-in was sent: the run then skips sync and only finishes the brief */
  checkInSentAt: Date | null;
}

export type ClaimResult =
  | { status: 'claimed'; run: DailyBriefRun }
  /** Sent earlier today: a second trigger does nothing */
  | { status: 'already_sent' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' }
  /** The check-in is out; only the continuation job may finish the brief */
  | { status: 'awaiting_checkin' };

export interface SavedBrief {
  coachDecisionId: string;
  briefText: string;
  briefKeyboard: InlineButton[][] | null;
  stale: boolean;
  dataAsOf: Date | null;
  stageTimings: StageTimings;
}

export interface SavedCheckIn {
  messageId: number;
  sentAt: Date;
  /** Freshness of the synced data, reused by the continuation */
  stale: boolean;
  dataAsOf: Date | null;
  stageTimings: StageTimings;
}

/** The run a check-in message belongs to */
export interface CheckInRun {
  id: string;
  date: string;
  status: DailyBriefStatus;
}

/** One `DailyBriefRun` per (userId, date): the morning pipeline's idempotency key. */
export interface DailyBriefRunRepo {
  /**
   * Creates the day's run if needed and takes it over atomically. A run that is pending or
   * failed can be taken over, and so can a running one whose lease (`startedAt + leaseMs`) has
   * expired. A sent run, or a running one still within its lease, is not taken over. A run
   * awaiting its check-in is taken over only by the continuation (`continuation: true`).
   */
  claim(
    userId: string,
    date: string,
    now: Date,
    leaseMs: number,
    opts?: { continuation?: boolean }
  ): Promise<ClaimResult>;
  saveBrief(id: string, brief: SavedBrief): Promise<void>;
  /** Records the sent check-in and sets the run `awaiting_checkin`, releasing the lease. */
  saveCheckIn(id: string, checkIn: SavedCheckIn): Promise<void>;
  findByCheckInMessage(userId: string, messageId: number): Promise<CheckInRun | null>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

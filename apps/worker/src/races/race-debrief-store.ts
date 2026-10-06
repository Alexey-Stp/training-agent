import type { DebriefTier, RaceMetrics } from '@triathlon/core';
import type { StageTimings } from '../daily-loop/run-store';

export type RaceDebriefStatus = 'pending' | 'running' | 'sent' | 'skipped' | 'failed';

/** The `RaceDebrief` row of one race and race date. */
export interface RaceDebriefRun {
  id: string;
  status: RaceDebriefStatus;
  /** The rendered debrief; set before the send, so a retry only resends it */
  debriefText: string | null;
  stageTimings: StageTimings;
}

export interface RaceDebriefKey {
  userId: string;
  raceId: string;
  /** The race date: a moved race is debriefed again */
  raceDate: string;
}

export type RaceDebriefClaimResult =
  | { status: 'claimed'; run: RaceDebriefRun }
  /** Sent or skipped earlier: a second trigger does nothing */
  | { status: 'already_done' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

export interface SaveDebriefInput {
  activityIcuId: string;
  tier: DebriefTier;
  metrics: RaceMetrics;
  narrative: string;
  takeaways: string[];
  debriefText: string;
  stageTimings: StageTimings;
}

/** One `RaceDebrief` per (user, race, race date): the debrief's idempotency key. */
export interface RaceDebriefRunRepo {
  /** Creates the run if needed and takes it over atomically (pending, failed or expired lease). */
  claim(key: RaceDebriefKey, now: Date, leaseMs: number): Promise<RaceDebriefClaimResult>;
  saveDebrief(id: string, input: SaveDebriefInput): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  /** No race activity within the timeout; `askedAt` is when the athlete was asked if they raced. */
  markSkipped(id: string, reason: string, askedAt: Date, stageTimings: StageTimings): Promise<void>;
  /** Back to pending: the race activity may still sync, a later run looks again. */
  release(id: string, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

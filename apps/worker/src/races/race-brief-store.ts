import type { RaceBriefKind } from '@triathlon/core';
import type { StageTimings } from '../daily-loop/run-store';

export type RaceBriefStatus = 'pending' | 'running' | 'sent' | 'failed';

/** The `RaceBriefRun` row of one race, brief kind and race date. */
export interface RaceBriefRun {
  id: string;
  status: RaceBriefStatus;
  /** The rendered brief; set before the send, so a retry only resends it */
  briefText: string | null;
  stageTimings: StageTimings;
}

export interface RaceBriefKey {
  userId: string;
  raceId: string;
  kind: RaceBriefKind;
  /** The race date: a moved race is briefed again */
  raceDate: string;
}

export type RaceBriefClaimResult =
  | { status: 'claimed'; run: RaceBriefRun }
  /** Sent earlier: a second trigger does nothing */
  | { status: 'already_sent' }
  /** Another attempt holds the lease */
  | { status: 'in_progress' };

/** One `RaceBriefRun` per (user, race, kind, race date): the race brief's idempotency key. */
export interface RaceBriefRunRepo {
  /** Creates the run if needed and takes it over atomically (pending, failed or expired lease). */
  claim(key: RaceBriefKey, now: Date, leaseMs: number): Promise<RaceBriefClaimResult>;
  saveBrief(
    id: string,
    briefText: string,
    stale: boolean,
    stageTimings: StageTimings
  ): Promise<void>;
  markSent(id: string, sentAt: Date, stageTimings: StageTimings): Promise<void>;
  markFailed(id: string, error: string, stageTimings: StageTimings): Promise<void>;
}

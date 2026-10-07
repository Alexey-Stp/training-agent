import type { Intensity, Sport, WorkoutBlock } from '@triathlon/core';

export type SessionStatus = 'draft' | 'pushed' | 'modified_externally' | 'completed' | 'skipped';

/** The activity the evening close-out matched to a session (`Activity.plannedSessionId`). */
export interface MatchedActivity {
  name: string;
  startTime: Date;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  avgPower: number | null;
}

/** A live (not tombstoned) PlannedSession row, as the bot and the ICU push see it. */
export interface DaySession {
  id: string;
  date: string;
  slot: string;
  sport: Sport;
  title: string;
  description: string | null;
  durationMin: number;
  intensity: Intensity;
  /** null when the stored JSON is not a valid WorkoutBlock[] */
  steps: WorkoutBlock[] | null;
  status: SessionStatus;
  externalChange: string | null;
  deviationPct: number | null;
  actualIntensity: Intensity | null;
  activity: MatchedActivity | null;
}

/** Device wellness and check-in of one day (TA-56 readiness line). */
export interface WellnessDay {
  date: string;
  hrv: number | null;
  restingHr: number | null;
  sleepHours: number | null;
  tsb: number | null;
  subjectiveReadiness: number | null;
  soreness: number | null;
}

/**
 * Read-only access to training data for the Today and Week views. There are no write methods
 * on purpose; every method takes the session's userId and scopes its query by it.
 */
export interface DashboardReadRepo {
  /** Profile.timezone, or null when the athlete has no profile */
  findTimezone(userId: string): Promise<string | null>;
  /** Live sessions dated from..to (inclusive), ordered by date, then slot */
  findSessions(userId: string, from: string, to: string): Promise<DaySession[]>;
  hasActiveSeason(userId: string): Promise<boolean>;
  /** Wellness rows dated from..to (inclusive), ordered by date */
  findWellness(userId: string, from: string, to: string): Promise<WellnessDay[]>;
}

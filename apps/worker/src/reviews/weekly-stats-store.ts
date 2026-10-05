import type {
  DateRange,
  WeeklyActivityInput,
  WeeklyPlannedInput,
  WeeklyStats,
  WeeklyWellnessInput,
} from '@triathlon/core';

/** Everything `computeWeeklyStats` reads for one athlete and date range. */
export interface WeeklyStatsData {
  sessions: WeeklyPlannedInput[];
  activities: WeeklyActivityInput[];
  wellness: WeeklyWellnessInput[];
  /** Profile.lthr */
  lthr: number | null;
}

export interface WeeklyStatsRepo {
  /** Planned sessions (tombstones included), activities and wellness of `range`, plus LTHR */
  loadRange(userId: string, range: DateRange): Promise<WeeklyStatsData>;
  /** Inserts or replaces the row of `(userId, stats.isoWeek)` */
  upsert(userId: string, stats: WeeklyStats, computedAt: Date): Promise<void>;
}

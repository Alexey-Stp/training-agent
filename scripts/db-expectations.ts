/**
 * What the migrated schema must provide. Shared by the PGlite migration test
 * (apps/worker/test/schema-migration-set.test.ts) and scripts/verify-db.ts (CI, real Postgres).
 */

/**
 * Access paths the app queries. Each needs an index (a unique constraint counts, and so does a
 * longer index) whose leading columns are these, in this order.
 */
export const INDEX_ACCESS_PATHS: ReadonlyArray<readonly [table: string, columns: string[]]> = [
  ['Workout', ['userId', 'date']],
  ['Wellness', ['userId', 'date']],
  ['Activity', ['userId', 'startDateLocal']],
  ['Activity', ['userId', 'startTime']],
  ['Activity', ['userId', 'icuId']],
  ['PlannedSession', ['userId', 'date']],
  ['PlannedSession', ['userId', 'status']],
  ['Race', ['userId', 'date']],
  ['SeasonPlan', ['userId', 'status']],
  ['TrainingBlock', ['seasonPlanId', 'order']],
  ['LlmCallLog', ['userId', 'createdAt']],
  ['LlmCallLog', ['purpose', 'createdAt']],
  ['CoachDecision', ['userId', 'date']],
  ['CoachChatMessage', ['userId', 'createdAt']],
  ['DailyBriefRun', ['userId', 'date']],
  ['EveningCloseoutRun', ['userId', 'date']],
  ['WeeklyStats', ['userId', 'isoWeek']],
  ['WeeklyReviewRun', ['userId', 'isoWeek']],
  ['BlockReviewRun', ['userId', 'seasonPlanId']],
  ['RaceBriefRun', ['userId', 'raceId']],
];

/** True when some index on the table starts with `columns`. */
export function hasIndexPrefix(indexes: readonly string[][], columns: readonly string[]): boolean {
  return indexes.some((idx) => columns.every((c, i) => idx[i] === c));
}

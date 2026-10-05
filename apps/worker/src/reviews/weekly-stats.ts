import {
  addDaysIso,
  computeWeeklyStats,
  isoWeekRange,
  localToday,
  previousIsoWeek,
  type WeeklyStats,
} from '@triathlon/core';
import type { RunLogger } from '../daily-loop/run-helpers';
import type { BriefProfileRepo } from '../daily-loop/scheduler';
import type { WeeklyStatsRepo } from './weekly-stats-store';

/** Days before the week that are loaded too: the CTL start and the HRV comparison need them */
const WEEKLY_STATS_LOOKBACK_DAYS = 7;

export interface WeeklyStatsDeps {
  profiles: BriefProfileRepo;
  repo: WeeklyStatsRepo;
  logger: RunLogger;
  now(): Date;
}

export type WeeklyStatsResult =
  { status: 'skipped'; reason: 'no_profile' } | { status: 'saved'; stats: WeeklyStats };

/**
 * Computes and stores one athlete's WeeklyStats. Without `isoWeek` it takes the ISO week before
 * the athlete's local today, so the Monday run closes the week that just ended. The row is
 * upserted by (userId, isoWeek): a retry or rerun recomputes and replaces it, nothing more.
 */
export async function runWeeklyStats(
  userId: string,
  deps: WeeklyStatsDeps,
  isoWeek?: string
): Promise<WeeklyStatsResult> {
  const profile = await deps.profiles.findBriefProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };

  const now = deps.now();
  const week = isoWeek ?? previousIsoWeek(localToday(now, profile.timezone));
  const range = isoWeekRange(week);
  const data = await deps.repo.loadRange(userId, {
    from: addDaysIso(range.from, -WEEKLY_STATS_LOOKBACK_DAYS),
    to: range.to,
  });
  const stats = computeWeeklyStats({ isoWeek: week, ...data });
  await deps.repo.upsert(userId, stats, now);

  deps.logger.info(
    {
      userId,
      isoWeek: week,
      unplannedWeek: stats.unplannedWeek,
      compliancePct: stats.total.compliancePct,
      missedKeySessions: stats.keySessions.missed.length,
    },
    'weekly stats saved'
  );
  return { status: 'saved', stats };
}

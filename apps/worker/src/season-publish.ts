import {
  localToday,
  rollingWindow,
  seasonDraftsForRange,
  type IcuSyncJob,
  type RulesContext,
  type UserProfile,
} from '@triathlon/core';
import { runIcuSyncJob } from './activity-sync';
import { pushPlannedSessions, type PlanPushDeps } from './plan-push';
import { materializeRange, type PlanStoreDeps } from './plan-store';
import type { SeasonRepo } from './week-command';

export interface ProfileRepo {
  findProfile(userId: string): Promise<UserProfile | null>;
}

export interface SeasonPublishDeps {
  seasons: SeasonRepo;
  profiles: ProfileRepo;
  /** Rules-engine input for a week starting on `date` (handlers.ts `getRulesContext`) */
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
  store: PlanStoreDeps;
  push: PlanPushDeps;
  /** Days after today that are kept expanded and pushed (SEASON_PUBLISH_WINDOW_DAYS) */
  windowDays: number;
  now(): Date;
}

export type SeasonPublishResult =
  | { status: 'skipped'; reason: 'not_connected' | 'no_profile' | 'no_season' | 'outside_season' }
  | {
      status: 'ok';
      from: string;
      to: string;
      sessions: number;
      created: number;
      updated: number;
      deleted: number;
    };

/**
 * Rolling publisher: expands the active season for local days T+1..T+windowDays, stores the
 * sessions and pushes them to the ICU calendar. Today and earlier days are never read,
 * diffed or pushed, so whatever the athlete has on them stays as it is. Unchanged sessions
 * are not written, so repeated runs make no ICU calls. ICU/DB errors are thrown.
 */
export async function publishSeasonWindow(
  userId: string,
  deps: SeasonPublishDeps
): Promise<SeasonPublishResult> {
  // Checked first so nothing is stored for an athlete we can't push to
  if (!(await deps.push.repo.findConnection(userId))) {
    return { status: 'skipped', reason: 'not_connected' };
  }
  const profile = await deps.profiles.findProfile(userId);
  if (!profile) return { status: 'skipped', reason: 'no_profile' };
  const season = await deps.seasons.findActiveSeason(userId);
  if (!season) return { status: 'skipped', reason: 'no_season' };

  const window = rollingWindow(localToday(deps.now(), profile.timezone), deps.windowDays);
  const { covered, drafts } = await seasonDraftsForRange(season, profile, window, (weekStart) =>
    deps.getRulesContext(userId, weekStart)
  );
  if (!covered) return { status: 'skipped', reason: 'outside_season' };

  await materializeRange(userId, covered, drafts, deps.store);
  const pushed = await pushPlannedSessions(userId, covered.from, deps.push);
  if (pushed.status === 'not_connected') return { status: 'skipped', reason: 'not_connected' };

  const { created, updated, deleted } = pushed;
  return { status: 'ok', ...covered, sessions: drafts.length, created, updated, deleted };
}

/** `season-rolling-publish` job processor. */
export function processSeasonPublishJob(
  data: IcuSyncJob,
  deps: SeasonPublishDeps
): Promise<SeasonPublishResult> {
  return runIcuSyncJob(() => publishSeasonWindow(data.userId, deps));
}

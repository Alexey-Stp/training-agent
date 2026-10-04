import { addDaysIso, type Race, type SeasonPlan, type UserProfile } from '@triathlon/core';
import { MissingProfileError } from './errors';
import { HISTORY_DAYS, HRV_BASELINE_DAYS, UPCOMING_DAYS } from './trends';
import type {
  ActivitySummary,
  CoachDecision,
  DailyContextDeps,
  PlannedSessionSummary,
  WellnessDay,
} from './types';

/** Coach decisions shown in the prompt */
export const DECISION_LIMIT = 5;

/** Everything the daily context reads, filtered to its windows and in a fixed order. */
export interface DailyData {
  profile: UserProfile;
  season: SeasonPlan | null;
  races: Race[];
  wellness: WellnessDay[];
  activities: ActivitySummary[];
  planned: PlannedSessionSummary[];
  decisions: CoachDecision[];
}

const PRIORITY_ORDER = { A: 0, B: 1, C: 2 } as const;

function compareRaces(a: Race, b: Race): number {
  return (
    a.date.localeCompare(b.date) ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    a.name.localeCompare(b.name)
  );
}

function compareActivities(a: ActivitySummary, b: ActivitySummary): number {
  return (
    a.startDateLocal.localeCompare(b.startDateLocal) ||
    a.sport.localeCompare(b.sport) ||
    a.name.localeCompare(b.name) ||
    a.durationSec - b.durationSec
  );
}

function comparePlanned(a: PlannedSessionSummary, b: PlannedSessionSummary): number {
  return a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot);
}

function compareDecisions(a: CoachDecision, b: CoachDecision): number {
  return (
    a.date.localeCompare(b.date) ||
    a.kind.localeCompare(b.kind) ||
    a.summary.localeCompare(b.summary)
  );
}

/**
 * Reads the daily context's data. All reads start together. Results are re-filtered to their
 * windows and re-sorted, so the prompt doesn't depend on how a repository orders rows.
 */
export async function collectDailyData(
  deps: DailyContextDeps,
  userId: string,
  date: string
): Promise<DailyData> {
  const wellnessFrom = addDaysIso(date, -HRV_BASELINE_DAYS);
  const historyFrom = addDaysIso(date, -HISTORY_DAYS);
  const historyTo = addDaysIso(date, -1);
  const upcomingTo = addDaysIso(date, UPCOMING_DAYS);

  const [profile, season, races, wellness, activities, planned, decisions] = await Promise.all([
    deps.profiles.findProfile(userId),
    deps.seasons.findActiveSeason(userId),
    deps.races.listUpcoming(userId, date),
    deps.wellness.listRange(userId, wellnessFrom, date),
    deps.activities.listRange(userId, historyFrom, historyTo),
    deps.planned.listRange(userId, historyFrom, upcomingTo),
    deps.decisions.listRecent(userId, date, DECISION_LIMIT),
  ]);
  if (!profile) throw new MissingProfileError(userId);

  const within = (d: string, from: string, to: string) => d >= from && d <= to;
  return {
    profile,
    season,
    races: races.filter((r) => r.date >= date).sort(compareRaces),
    wellness: wellness
      .filter((w) => within(w.date, wellnessFrom, date))
      .sort((a, b) => a.date.localeCompare(b.date)),
    activities: activities
      .filter((a) => within(a.startDateLocal, historyFrom, historyTo))
      .sort(compareActivities),
    planned: planned.filter((s) => within(s.date, historyFrom, upcomingTo)).sort(comparePlanned),
    decisions: decisions
      .filter((d) => d.date <= date)
      .sort(compareDecisions)
      .slice(-DECISION_LIMIT),
  };
}

import {
  addOptionalSundaySwim,
  applyRules,
  generateDraftPlan,
  seasonDraftsForRange,
  Sport,
  toPlannedSessions,
  type DateRange,
  type PlannedSessionDraft,
  type RulesContext,
  type Session,
  type UserProfile,
} from '@triathlon/core';
import { planWindowEnd } from './plan-store';
import { racesForRange, type UpcomingRaces } from './season-races';
import type { SeasonRepo } from './week-command';

export interface PlanSourceDeps {
  seasons: SeasonRepo;
  /** A, B and C races shape the season weeks around them */
  races: UpcomingRaces;
  /** Rules-engine input for a plan or week starting on `date` (handlers.ts `getRulesContext`) */
  getRulesContext(userId: string, date: string): Promise<RulesContext>;
}

/** A session to show, with the PlannedSession slot it is stored under (null for rest days). */
export interface WeekEntry {
  session: Session;
  slot: string | null;
}

export interface PlannedWeek {
  /** Display order: date ascending, generator order within a date */
  entries: WeekEntry[];
  drafts: PlannedSessionDraft[];
  warnings: string[];
  appliedRules: number;
  /** Days that came from the active season; null when none did */
  seasonDays: DateRange | null;
}

/** The rules-applied 7-day generator plan from `today`, each session paired with its slot. */
async function legacyWeek(
  userId: string,
  profile: UserProfile,
  today: string,
  deps: PlanSourceDeps
): Promise<PlannedWeek> {
  const draft = addOptionalSundaySwim(generateDraftPlan(profile, today), profile);
  const plan = applyRules(draft, await deps.getRulesContext(userId, today));
  const drafts = toPlannedSessions(plan);
  // toPlannedSessions keeps session order and only drops rest days
  let next = 0;
  const entries = plan.sessions.map((session) => {
    const stored = session.sport !== Sport.rest && session.durationMin > 0;
    return { session, slot: stored ? drafts[next++].slot : null };
  });
  return {
    entries,
    drafts,
    warnings: plan.warnings,
    appliedRules: plan.appliedRules.length,
    seasonDays: null,
  };
}

/**
 * The week `/plan` shows and stores (today..today+6). Days the active season covers come
 * from the week expander, the same sessions the rolling publisher pushes, so the two never
 * overwrite each other. Other days come from the 7-day generator.
 */
export async function planWeek(
  userId: string,
  profile: UserProfile,
  today: string,
  deps: PlanSourceDeps
): Promise<PlannedWeek> {
  const season = await deps.seasons.findActiveSeason(userId);
  const range = { from: today, to: planWindowEnd(today) };
  const fromSeason = season
    ? await seasonDraftsForRange(
        season,
        profile,
        range,
        (weekStart) => deps.getRulesContext(userId, weekStart),
        await racesForRange(deps.races, userId, season, range)
      )
    : null;
  const covered = fromSeason?.covered;
  if (!fromSeason || !covered) return legacyWeek(userId, profile, today, deps);

  const seasonEntries = fromSeason.sessions.map((session, i) => ({
    session,
    slot: fromSeason.drafts[i].slot,
  }));
  const fullyCovered = covered.from === range.from && covered.to === range.to;
  const rest = fullyCovered ? null : await legacyWeek(userId, profile, today, deps);
  const outside = (date: string) => date < covered.from || date > covered.to;

  const entries = [
    ...seasonEntries,
    ...(rest?.entries.filter((e) => outside(e.session.date)) ?? []),
  ];
  entries.sort((a, b) => a.session.date.localeCompare(b.session.date));
  return {
    entries,
    drafts: [...fromSeason.drafts, ...(rest?.drafts.filter((d) => outside(d.date)) ?? [])],
    warnings: [...fromSeason.warnings, ...(rest?.warnings ?? [])],
    appliedRules: rest?.appliedRules ?? 0,
    seasonDays: covered,
  };
}

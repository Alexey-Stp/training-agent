import {
  addDaysIso,
  RACE_REACH_DAYS,
  RacePriority,
  type DateRange,
  type Race,
  type SeasonPlan,
} from '@triathlon/core';

export interface UpcomingRaces {
  /** Races dated on/after `fromDate`, date ascending (`RaceRepo.listUpcoming`). */
  listUpcoming(userId: string, fromDate: string): Promise<Race[]>;
}

/**
 * Races that can shape the days of `range`: an A-race reaches 6 days before it and to the end
 * of its ISO week, a B-race mini-taper up to 5 days before it, so the lookup reaches
 * `RACE_REACH_DAYS` past both ends. Only the season's own A-race gets the A treatment; another
 * A-race (e.g. one for next season) is handled like a B-race.
 */
export async function racesForRange(
  repo: UpcomingRaces,
  userId: string,
  season: Pick<SeasonPlan, 'aRace'>,
  range: DateRange
): Promise<Race[]> {
  const races = await repo.listUpcoming(userId, addDaysIso(range.from, -RACE_REACH_DAYS));
  const until = addDaysIso(range.to, RACE_REACH_DAYS);
  return races
    .filter((r) => r.date <= until)
    .map((r) =>
      r.priority === RacePriority.A && r.date !== season.aRace?.date
        ? { ...r, priority: RacePriority.B }
        : r
    );
}

import { differenceInCalendarDays, parseISO } from 'date-fns';
import { Race, RacePriority } from '../season/types';

export type RaceBriefKind = 't7' | 't1';

export const RACE_BRIEF_DAYS: Record<RaceBriefKind, number> = { t7: 7, t1: 1 };

/**
 * Which brief goes out on `today` for this race, or null. A-races get T-7 and T-1,
 * B/C races only the shorter T-1.
 */
export function raceBriefKind(
  race: Pick<Race, 'date' | 'priority'>,
  today: string
): RaceBriefKind | null {
  const days = differenceInCalendarDays(parseISO(race.date), parseISO(today));
  if (days === RACE_BRIEF_DAYS.t1) return 't1';
  if (days === RACE_BRIEF_DAYS.t7 && race.priority === RacePriority.A) return 't7';
  return null;
}

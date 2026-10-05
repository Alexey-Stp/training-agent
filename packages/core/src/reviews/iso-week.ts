import { format, getISOWeek, getISOWeekYear, parseISO, startOfISOWeek } from 'date-fns';
import { addDaysIso, DateRange } from '../season/window';

const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;

/** ISO week of a `yyyy-MM-dd` date, e.g. `2026-W40`. The year is the ISO week-numbering year. */
export function isoWeekKey(date: string): string {
  const day = parseISO(date);
  const week = String(getISOWeek(day)).padStart(2, '0');
  return String(getISOWeekYear(day)) + '-W' + week;
}

/** Monday..Sunday of an ISO week key. Throws on a malformed key or a week the year lacks. */
export function isoWeekRange(key: string): DateRange {
  const match = ISO_WEEK_RE.exec(key);
  if (!match) throw new Error('Invalid ISO week: ' + key);
  // Jan 4th always falls in ISO week 1
  const week1 = format(startOfISOWeek(parseISO(match[1] + '-01-04')), 'yyyy-MM-dd');
  const from = addDaysIso(week1, (Number(match[2]) - 1) * 7);
  if (isoWeekKey(from) !== key) throw new Error('Invalid ISO week: ' + key);
  return { from, to: addDaysIso(from, 6) };
}

/** The ISO week before the one that contains `date`. */
export function previousIsoWeek(date: string): string {
  return isoWeekKey(addDaysIso(date, -7));
}

/** The ISO week after the one that contains `date`. */
export function nextIsoWeek(date: string): string {
  return isoWeekKey(addDaysIso(date, 7));
}

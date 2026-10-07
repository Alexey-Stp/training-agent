import { format, isValid, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { Sport } from '@triathlon/core';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `?date=` value that is a real calendar date, else null. */
export function parseDateParam(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
  const parsed = parseISO(value);
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === value ? value : null;
}

/** `2026-10-06` → `Tue 6 Oct` */
export function dayLabel(date: string): string {
  return format(parseISO(date), 'EEE d MMM');
}

/** `Tue` */
export function weekdayShort(date: string): string {
  return format(parseISO(date), 'EEE');
}

/** Wall-clock `HH:mm` of an instant in the athlete's timezone. */
export function localTime(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, 'HH:mm');
}

const SPORT_ICONS: Record<Sport, string> = {
  [Sport.swim]: '🏊',
  [Sport.bike]: '🚴',
  [Sport.run]: '🏃',
  [Sport.strength]: '💪',
  [Sport.rest]: '😴',
  [Sport.other]: '🏅',
};

export function sportIcon(sport: Sport): string {
  return SPORT_ICONS[sport];
}

/** `95` → `1h 35m`, `45` → `45m` */
export function formatMinutes(total: number): string {
  const minutes = Math.round(total);
  if (minutes < 60) return String(minutes) + 'm';
  const rest = minutes % 60;
  const hours = String(Math.floor(minutes / 60)) + 'h';
  return rest === 0 ? hours : hours + ' ' + String(rest) + 'm';
}

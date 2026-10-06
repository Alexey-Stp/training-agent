import { addDaysIso, isKeySession, Sport } from '@triathlon/core';
import type {
  ActivitySummary,
  Compliance,
  HistoryDay,
  PlannedSessionSummary,
  SportCompliance,
  TrainingLoad,
  WellnessDay,
  WellnessTrend,
} from './types';

// The HRV baseline moved to core (TA-56) so the web dashboard can use it without this package
export { HRV_BASELINE_DAYS, HRV_MIN_SAMPLES, hrvBaseline } from '@triathlon/core';
/** Wellness trend length, today included */
export const TREND_DAYS = 7;
/** Compliance window: the days before `date` */
export const COMPLIANCE_DAYS = 7;
/** Planned-vs-actual history and missed key sessions: the days before `date` */
export const HISTORY_DAYS = 14;
/** Days after `date` shown as upcoming, so today plus this many */
export const UPCOMING_DAYS = 3;
// Shared with the evening close-out, which lives in the worker
export { isKeySession, KEY_SESSION_MIN_MINUTES, powerZones } from '@triathlon/core';

const DAY_MS = 86_400_000;

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

/** `from`..`to` inclusive, one yyyy-MM-dd per day. */
export function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDaysIso(date, 1)) dates.push(date);
  return dates;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function averageOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? mean(present) : null;
}

/** True when the day has any device/ICU reading (the athlete check-in alone does not count). */
export function hasDeviceData(day: WellnessDay): boolean {
  return [day.hrv, day.restingHr, day.sleepHours, day.sleepScore, day.tsb].some((v) => v !== null);
}

export function emptyWellnessDay(date: string): WellnessDay {
  return {
    date,
    hrv: null,
    restingHr: null,
    sleepHours: null,
    sleepScore: null,
    weightKg: null,
    ctl: null,
    atl: null,
    tsb: null,
    subjectiveReadiness: null,
    soreness: null,
  };
}

/** The `TREND_DAYS` days up to `date`, oldest first. Days without a row keep null metrics. */
export function wellnessTrend(rows: WellnessDay[], date: string): WellnessTrend {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days = datesInRange(addDaysIso(date, 1 - TREND_DAYS), date).map(
    (d) => byDate.get(d) ?? emptyWellnessDay(d)
  );
  return {
    days,
    avgHrv: averageOf(days.map((d) => d.hrv)),
    avgSleepHours: averageOf(days.map((d) => d.sleepHours)),
    avgRestingHr: averageOf(days.map((d) => d.restingHr)),
  };
}

/** CTL/ATL/TSB of the latest row on or before `date` that has TSB, or null when none has. */
export function trainingLoad(rows: WellnessDay[], date: string): TrainingLoad | null {
  const latest = rows.findLast((row) => row.date <= date && row.tsb !== null);
  if (!latest) return null;
  return {
    date: latest.date,
    daysOld: daysBetween(latest.date, date),
    ctl: latest.ctl,
    atl: latest.atl,
    tsb: latest.tsb,
  };
}

const COMPLIANCE_SPORTS: readonly Sport[] = [
  Sport.swim,
  Sport.bike,
  Sport.run,
  Sport.strength,
  Sport.other,
];

function pct(planned: number, actual: number): number | null {
  return planned > 0 ? Math.round((actual / planned) * 100) : null;
}

function sumBySport<T>(items: T[], sportOf: (item: T) => Sport, valueOf: (item: T) => number) {
  const sums = new Map<Sport, number>();
  for (const item of items) {
    const sport = sportOf(item);
    sums.set(sport, (sums.get(sport) ?? 0) + valueOf(item));
  }
  return sums;
}

/**
 * Planned vs actual minutes per sport over the `COMPLIANCE_DAYS` days before `date`.
 * Skipped sessions still count as planned.
 */
export function compliance(
  planned: PlannedSessionSummary[],
  activities: ActivitySummary[],
  date: string
): Compliance {
  const from = addDaysIso(date, -COMPLIANCE_DAYS);
  const to = addDaysIso(date, -1);
  const inWindow = (d: string) => d >= from && d <= to;
  const plannedMin = sumBySport(
    planned.filter((s) => inWindow(s.date)),
    (s) => s.sport,
    (s) => s.durationMin
  );
  const actualSec = sumBySport(
    activities.filter((a) => inWindow(a.startDateLocal)),
    (a) => a.sport,
    (a) => a.durationSec
  );
  const bySport: SportCompliance[] = COMPLIANCE_SPORTS.filter(
    (sport) => plannedMin.has(sport) || actualSec.has(sport)
  ).map((sport) => {
    const p = plannedMin.get(sport) ?? 0;
    const a = Math.round((actualSec.get(sport) ?? 0) / 60);
    return { sport, plannedMin: p, actualMin: a, pct: pct(p, a) };
  });
  const totalPlanned = bySport.reduce((sum, s) => sum + s.plannedMin, 0);
  const totalActual = bySport.reduce((sum, s) => sum + s.actualMin, 0);
  return {
    from,
    to,
    bySport,
    total: {
      plannedMin: totalPlanned,
      actualMin: totalActual,
      pct: pct(totalPlanned, totalActual),
    },
  };
}

/**
 * Key sessions of the `HISTORY_DAYS` days before `date` that were skipped, or had no
 * activity of the same sport on their day.
 */
export function missedKeySessions(
  planned: PlannedSessionSummary[],
  activities: ActivitySummary[],
  date: string
): PlannedSessionSummary[] {
  const from = addDaysIso(date, -HISTORY_DAYS);
  const done = new Set(activities.map((a) => a.startDateLocal + '|' + a.sport));
  return planned.filter(
    (s) =>
      s.date >= from &&
      s.date < date &&
      isKeySession(s) &&
      s.status !== 'completed' &&
      (s.status === 'skipped' || !done.has(s.date + '|' + s.sport))
  );
}

/** One entry per day of the `HISTORY_DAYS` days before `date`, oldest first. */
export function trainingHistory(
  planned: PlannedSessionSummary[],
  activities: ActivitySummary[],
  date: string
): HistoryDay[] {
  return datesInRange(addDaysIso(date, -HISTORY_DAYS), addDaysIso(date, -1)).map((d) => ({
    date: d,
    planned: planned.filter((s) => s.date === d),
    actual: activities.filter((a) => a.startDateLocal === d),
  }));
}

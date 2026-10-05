import { hrIntensity, isKeySession } from '../closeout';
import { addDaysIso, DateRange } from '../season/window';
import { Intensity, Sport } from '../types';
import { isoWeekRange } from './iso-week';

/** Bumped when the stored `WeeklyStats` JSON changes shape */
export const WEEKLY_STATS_VERSION = 1;

/** Sports reported per week, in display order. Rest days carry no training. */
const WEEKLY_SPORTS: readonly Sport[] = [
  Sport.swim,
  Sport.bike,
  Sport.run,
  Sport.strength,
  Sport.other,
];

/** Z1-Z2 count as easy; Z3 and above as hard (the 80/20 split). */
const EASY_INTENSITIES: ReadonlySet<Intensity> = new Set([Intensity.z1, Intensity.z2]);

/** A planned session of the week, with its close-out status. */
export interface WeeklyPlannedInput {
  date: string;
  slot: string;
  sport: Sport;
  title: string;
  durationMin: number;
  intensity: Intensity;
  /** PlannedSession.status: draft | pushed | modified_externally | completed | skipped */
  status: string;
  deleted: boolean;
}

export interface WeeklyActivityInput {
  startDateLocal: string;
  sport: Sport;
  durationSec: number;
  distanceM: number | null;
  /** ICU training load (TSS-equivalent) */
  load: number | null;
  avgHr: number | null;
}

export interface WeeklyWellnessInput {
  date: string;
  hrv: number | null;
  restingHr: number | null;
  sleepHours: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  subjectiveReadiness: number | null;
  soreness: number | null;
}

export interface WeeklyStatsInput {
  isoWeek: string;
  sessions: WeeklyPlannedInput[];
  activities: WeeklyActivityInput[];
  /** The week plus the 7 days before it (load start and the HRV comparison need them) */
  wellness: WeeklyWellnessInput[];
  /** Profile.lthr; null puts every activity's minutes in `unknownMin` */
  lthr: number | null;
}

export interface WeekVolume {
  plannedMin: number;
  actualMin: number;
  /** Actual / planned minutes in percent; null when nothing was planned (not 0) */
  compliancePct: number | null;
  /** Planned sessions carry no distance or TSS yet */
  plannedDistanceKm: null;
  actualDistanceKm: number;
  plannedTss: null;
  actualTss: number;
  plannedSessions: number;
  activities: number;
}

export interface SportWeekStats extends WeekVolume {
  sport: Sport;
}

export interface KeySessionRef {
  date: string;
  title: string;
  sport: Sport;
}

export interface KeySessionStats {
  hit: KeySessionRef[];
  missed: KeySessionRef[];
  /** Not closed out (yet): still draft, pushed or moved in ICU */
  pending: KeySessionRef[];
}

/** Actual minutes by the zone of each activity's average heart rate */
export interface IntensityDistribution {
  easyMin: number;
  hardMin: number;
  /** No avgHr on the activity, or no LTHR on the profile */
  unknownMin: number;
  /** Shares of the minutes with a known zone; null when there are none */
  easyPct: number | null;
  hardPct: number | null;
}

export interface LoadPoint {
  date: string;
  ctl: number;
  atl: number | null;
  tsb: number | null;
}

export interface LoadTrend {
  /** Last value before the week starts */
  start: LoadPoint | null;
  /** Last value inside the week */
  end: LoadPoint | null;
  ctlDelta: number | null;
  atlDelta: number | null;
  tsbDelta: number | null;
}

export interface WellnessSummary {
  daysWithData: number;
  avgHrv: number | null;
  avgRestingHr: number | null;
  avgSleepHours: number | null;
  avgReadiness: number | null;
  avgSoreness: number | null;
  /** Average HRV of the 7 days before the week */
  prevAvgHrv: number | null;
  hrvDeltaPct: number | null;
}

export interface WeeklyStats {
  version: number;
  isoWeek: string;
  from: string;
  to: string;
  /** No planned sessions: an off week, compliance is null throughout */
  unplannedWeek: boolean;
  bySport: SportWeekStats[];
  total: WeekVolume;
  keySessions: KeySessionStats;
  intensity: IntensityDistribution;
  load: LoadTrend;
  wellness: WellnessSummary;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length > 0 ? round1(sum(known) / known.length) : null;
}

function delta(start: number | null, end: number | null): number | null {
  return start === null || end === null ? null : round1(end - start);
}

function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

function volume(sessions: WeeklyPlannedInput[], activities: WeeklyActivityInput[]): WeekVolume {
  const plannedMin = sum(sessions.map((s) => s.durationMin));
  const actualSec = sum(activities.map((a) => a.durationSec));
  return {
    plannedMin,
    actualMin: round1(actualSec / 60),
    compliancePct: pct(actualSec / 60, plannedMin),
    plannedDistanceKm: null,
    actualDistanceKm: round1(sum(activities.map((a) => a.distanceM ?? 0)) / 1000),
    plannedTss: null,
    actualTss: round1(sum(activities.map((a) => a.load ?? 0))),
    plannedSessions: sessions.length,
    activities: activities.length,
  };
}

function bySport(
  sessions: WeeklyPlannedInput[],
  activities: WeeklyActivityInput[]
): SportWeekStats[] {
  return WEEKLY_SPORTS.map((sport) => ({
    sport,
    ...volume(
      sessions.filter((s) => s.sport === sport),
      activities.filter((a) => a.sport === sport)
    ),
  })).filter((s) => s.plannedSessions > 0 || s.activities > 0);
}

function keySessions(sessions: WeeklyPlannedInput[]): KeySessionStats {
  const keys = sessions
    .filter((s) => isKeySession(s))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  const ref = (s: WeeklyPlannedInput): KeySessionRef => ({
    date: s.date,
    title: s.title,
    sport: s.sport,
  });
  return {
    hit: keys.filter((s) => s.status === 'completed').map(ref),
    missed: keys.filter((s) => s.status === 'skipped').map(ref),
    pending: keys.filter((s) => s.status !== 'completed' && s.status !== 'skipped').map(ref),
  };
}

type IntensityBucket = 'easy' | 'hard' | 'unknown';

function bucketOf(activity: WeeklyActivityInput, lthr: number | null): IntensityBucket {
  if (activity.avgHr === null || lthr === null || lthr <= 0) return 'unknown';
  return EASY_INTENSITIES.has(hrIntensity(activity.avgHr, lthr)) ? 'easy' : 'hard';
}

/** Splits the week's minutes into Z1-2 vs Z3+ by each activity's average heart rate. */
export function intensityDistribution(
  activities: WeeklyActivityInput[],
  lthr: number | null
): IntensityDistribution {
  const seconds: Record<IntensityBucket, number> = { easy: 0, hard: 0, unknown: 0 };
  for (const activity of activities) seconds[bucketOf(activity, lthr)] += activity.durationSec;
  const known = seconds.easy + seconds.hard;
  return {
    easyMin: round1(seconds.easy / 60),
    hardMin: round1(seconds.hard / 60),
    unknownMin: round1(seconds.unknown / 60),
    easyPct: pct(seconds.easy, known),
    hardPct: pct(seconds.hard, known),
  };
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round1(value);
}

/** The latest row in `range` that has a CTL. */
function loadAt(rows: WeeklyWellnessInput[], range: DateRange): LoadPoint | null {
  const points = rows.flatMap((r): LoadPoint[] =>
    r.ctl !== null && inRange(r.date, range)
      ? [{ date: r.date, ctl: round1(r.ctl), atl: nullableRound(r.atl), tsb: nullableRound(r.tsb) }]
      : []
  );
  points.sort((a, b) => b.date.localeCompare(a.date));
  return points.at(0) ?? null;
}

/** The 7 days before the week: the load start and HRV comparison look there. */
function weekBefore(week: DateRange): DateRange {
  return { from: addDaysIso(week.from, -7), to: addDaysIso(week.from, -1) };
}

function loadTrend(rows: WeeklyWellnessInput[], week: DateRange): LoadTrend {
  const start = loadAt(rows, weekBefore(week));
  const end = loadAt(rows, week);
  return {
    start,
    end,
    ctlDelta: delta(start?.ctl ?? null, end?.ctl ?? null),
    atlDelta: delta(start?.atl ?? null, end?.atl ?? null),
    tsbDelta: delta(start?.tsb ?? null, end?.tsb ?? null),
  };
}

function hasWellnessData(row: WeeklyWellnessInput): boolean {
  return [row.hrv, row.restingHr, row.sleepHours, row.subjectiveReadiness, row.soreness].some(
    (v) => v !== null
  );
}

function wellnessSummary(rows: WeeklyWellnessInput[], week: DateRange): WellnessSummary {
  const inWeek = rows.filter((r) => inRange(r.date, week));
  const before = weekBefore(week);
  const avgHrv = average(inWeek.map((r) => r.hrv));
  const prevAvgHrv = average(rows.filter((r) => inRange(r.date, before)).map((r) => r.hrv));
  const hrvDeltaPct =
    avgHrv !== null && prevAvgHrv !== null && prevAvgHrv > 0
      ? round1(((avgHrv - prevAvgHrv) / prevAvgHrv) * 100)
      : null;
  return {
    daysWithData: inWeek.filter(hasWellnessData).length,
    avgHrv,
    avgRestingHr: average(inWeek.map((r) => r.restingHr)),
    avgSleepHours: average(inWeek.map((r) => r.sleepHours)),
    avgReadiness: average(inWeek.map((r) => r.subjectiveReadiness)),
    avgSoreness: average(inWeek.map((r) => r.soreness)),
    prevAvgHrv,
    hrvDeltaPct,
  };
}

/**
 * Planned vs actual for one ISO week. Pure and deterministic: inputs outside the week are
 * ignored (except the wellness lookback), lists come out sorted, and numbers carry one
 * decimal. Planned = live (not tombstoned) non-rest sessions; actual = every activity of the
 * week, unplanned ones included. A week with no planned sessions is an `unplannedWeek` and
 * its compliance is null, not 0.
 */
export function computeWeeklyStats(input: WeeklyStatsInput): WeeklyStats {
  const week = isoWeekRange(input.isoWeek);
  const sessions = input.sessions.filter(
    (s) => !s.deleted && s.sport !== Sport.rest && inRange(s.date, week)
  );
  const activities = input.activities.filter(
    (a) => a.sport !== Sport.rest && inRange(a.startDateLocal, week)
  );
  const unplannedWeek = sessions.length === 0;

  return {
    version: WEEKLY_STATS_VERSION,
    isoWeek: input.isoWeek,
    from: week.from,
    to: week.to,
    unplannedWeek,
    bySport: bySport(sessions, activities),
    // Nothing planned means 0 planned minutes, so the totals' compliance is null too
    total: volume(sessions, activities),
    keySessions: keySessions(sessions),
    intensity: intensityDistribution(activities, input.lthr),
    load: loadTrend(input.wellness, week),
    wellness: wellnessSummary(input.wellness, week),
  };
}

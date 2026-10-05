import { HARD_INTENSITIES, Intensity, Sport } from './types';

/** A session at least this long counts as key even when it is easy (long ride/run) */
export const KEY_SESSION_MIN_MINUTES = 90;

/** Hard (Z4/Z5) or long sessions: the ones a missed day should be judged by. */
export function isKeySession(session: { intensity: Intensity; durationMin: number }): boolean {
  return HARD_INTENSITIES.has(session.intensity) || session.durationMin >= KEY_SESSION_MIN_MINUTES;
}

export interface PowerZone {
  zone: Intensity;
  label: string;
  minWatts: number;
  /** null for the open-ended top zone */
  maxWatts: number | null;
}

const ZONE_BANDS: readonly [Intensity, string, number, number | null][] = [
  [Intensity.z1, 'Recovery', 0, 0.55],
  [Intensity.z2, 'Endurance', 0.56, 0.75],
  [Intensity.z3, 'Tempo', 0.76, 0.9],
  [Intensity.z4, 'Threshold', 0.91, 1.05],
  [Intensity.z5, 'VO2max+', 1.06, null],
];

/** Coggan-style power zones from FTP, one per `Intensity`. */
export function powerZones(ftp: number): PowerZone[] {
  return ZONE_BANDS.map(([zone, label, lo, hi]) => ({
    zone,
    label,
    minWatts: Math.round(ftp * lo),
    maxWatts: hi === null ? null : Math.round(ftp * hi),
  }));
}

/** Upper bounds (exclusive) of avgHr / LTHR per zone; above the last is z5 (Friel). */
const HR_BANDS: readonly [Intensity, number][] = [
  [Intensity.z1, 0.85],
  [Intensity.z2, 0.9],
  [Intensity.z3, 0.95],
  [Intensity.z4, 1],
];

/** A planned session of the close-out day. */
export interface CloseoutSession {
  id: string;
  slot: string;
  sport: Sport;
  title: string;
  durationMin: number;
  intensity: Intensity;
  deleted: boolean;
}

/** An activity done on the close-out day. */
export interface CloseoutActivity {
  id: string;
  icuId: string;
  sport: Sport;
  name: string;
  /** UTC */
  startTime: Date;
  durationSec: number;
  avgHr: number | null;
  avgPower: number | null;
}

export interface ActivityMatch<
  S extends CloseoutSession = CloseoutSession,
  A extends CloseoutActivity = CloseoutActivity,
> {
  session: S;
  activity: A;
}

export interface MatchResult<
  S extends CloseoutSession = CloseoutSession,
  A extends CloseoutActivity = CloseoutActivity,
> {
  matches: ActivityMatch<S, A>[];
  /** Planned sessions no activity matched */
  skipped: S[];
  /** Activities that match no planned session: unplanned workouts */
  unmatched: A[];
}

function durationDeltaMin(session: CloseoutSession, activity: CloseoutActivity): number {
  return Math.abs(activity.durationSec / 60 - session.durationMin);
}

interface Pair<S extends CloseoutSession, A extends CloseoutActivity> extends ActivityMatch<S, A> {
  delta: number;
}

function comparePairs<S extends CloseoutSession, A extends CloseoutActivity>(
  a: Pair<S, A>,
  b: Pair<S, A>
): number {
  return (
    a.delta - b.delta ||
    a.session.slot.localeCompare(b.session.slot) ||
    a.activity.startTime.getTime() - b.activity.startTime.getTime() ||
    a.activity.icuId.localeCompare(b.activity.icuId)
  );
}

/**
 * Matches one day's activities to its planned sessions, one-to-one. Only the same sport can
 * match; of all such pairs the one with the smallest duration gap is taken first, then the
 * next among the sessions and activities still free. Ties break by slot, start time and ICU
 * id, so the result does not depend on the input order. Rest days and tombstoned sessions
 * take no part.
 */
export function matchActivities<S extends CloseoutSession, A extends CloseoutActivity>(
  sessions: S[],
  activities: A[]
): MatchResult<S, A> {
  const candidates = sessions.filter((s) => !s.deleted && s.sport !== Sport.rest);
  const pairs = candidates
    .flatMap((session) =>
      activities
        .filter((activity) => activity.sport === session.sport)
        .map((activity) => ({ session, activity, delta: durationDeltaMin(session, activity) }))
    )
    .sort(comparePairs);

  const usedSessions = new Set<string>();
  const usedActivities = new Set<string>();
  const matches: ActivityMatch<S, A>[] = [];
  for (const { session, activity } of pairs) {
    if (usedSessions.has(session.id) || usedActivities.has(activity.id)) continue;
    usedSessions.add(session.id);
    usedActivities.add(activity.id);
    matches.push({ session, activity });
  }

  return {
    matches,
    skipped: candidates.filter((s) => !usedSessions.has(s.id)),
    unmatched: activities.filter((a) => !usedActivities.has(a.id)),
  };
}

/** Actual vs planned duration in percent, one decimal; null when nothing was planned. */
export function deviationPct(plannedMin: number, actualSec: number): number | null {
  if (plannedMin <= 0) return null;
  const pct = ((actualSec / 60 - plannedMin) / plannedMin) * 100;
  return Math.round(pct * 10) / 10;
}

export interface IntensityThresholds {
  ftp: number | null;
  /** Lactate threshold heart rate (bpm); null when the athlete hasn't set it */
  lthr: number | null;
}

function powerZone(avgPower: number, ftp: number): Intensity {
  const zones = powerZones(ftp);
  const zone = zones.find((z) => z.maxWatts !== null && avgPower <= z.maxWatts);
  return zone?.zone ?? Intensity.z5;
}

/** Zone of an average heart rate against LTHR (Friel bands). */
export function hrIntensity(avgHr: number, lthr: number): Intensity {
  const ratio = avgHr / lthr;
  const band = HR_BANDS.find(([, upper]) => ratio < upper);
  return band?.[0] ?? Intensity.z5;
}

/**
 * A rough zone for the whole activity: bike average power against FTP, otherwise average
 * heart rate against LTHR. Null when the activity or the profile lacks the numbers.
 */
export function guessIntensity(
  activity: Pick<CloseoutActivity, 'sport' | 'avgHr' | 'avgPower'>,
  thresholds: IntensityThresholds
): Intensity | null {
  const { ftp, lthr } = thresholds;
  if (activity.sport === Sport.bike && activity.avgPower !== null && ftp !== null && ftp > 0) {
    return powerZone(activity.avgPower, ftp);
  }
  if (activity.avgHr !== null && lthr !== null && lthr > 0)
    return hrIntensity(activity.avgHr, lthr);
  return null;
}

export type CloseoutNotice =
  | { kind: 'missed_key'; session: CloseoutSession }
  | {
      kind: 'deviation';
      session: CloseoutSession;
      activity: CloseoutActivity;
      deviationPct: number;
    }
  | { kind: 'unplanned'; activity: CloseoutActivity };

export interface CloseoutNoticeConfig {
  /** CLOSEOUT_DEVIATION_THRESHOLD_PCT: a larger |deviation| is worth a message */
  deviationThresholdPct: number;
}

/**
 * What is worth telling the athlete about the day: a missed key session, a session whose
 * duration was off by more than the threshold, or an unplanned workout. Empty means the day
 * went (roughly) as planned and the close-out stays quiet.
 */
export function closeoutNotices(
  result: MatchResult,
  config: CloseoutNoticeConfig
): CloseoutNotice[] {
  const missed = result.skipped
    .filter((session) => isKeySession(session))
    .map((session): CloseoutNotice => ({ kind: 'missed_key', session }));

  const deviations = result.matches.flatMap(({ session, activity }): CloseoutNotice[] => {
    const pct = deviationPct(session.durationMin, activity.durationSec);
    if (pct === null || Math.abs(pct) <= config.deviationThresholdPct) return [];
    return [{ kind: 'deviation', session, activity, deviationPct: pct }];
  });

  const unplanned = result.unmatched.map((activity): CloseoutNotice => ({
    kind: 'unplanned',
    activity,
  }));

  return [...missed, ...deviations, ...unplanned];
}

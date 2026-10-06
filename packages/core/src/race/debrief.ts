import { RaceType } from '../season/types';
import { BikeTarget, RunTarget } from './pacing';

/**
 * Pacing metrics of a finished race, computed from the activity's streams. Pure: the LLM only
 * narrates what is computed here.
 */

/** Per-second streams of one activity. A missing stream is null or empty. */
export interface RaceStreams {
  timeSec: readonly number[];
  watts?: readonly (number | null)[] | null;
  heartrate?: readonly (number | null)[] | null;
  /** Speed in m/s */
  velocity?: readonly (number | null)[] | null;
}

/** Whole-activity averages stored by the sync: the fallback when there are no streams */
export interface RaceActivityAverages {
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  avgPower: number | null;
}

/** power: a power stream. hr: heart rate and/or speed streams only. none: averages only. */
export type DebriefTier = 'power' | 'hr' | 'none';
export type SplitKind = 'positive' | 'negative' | 'even';
export type TargetStatus = 'below' | 'within' | 'above';
export type DriftBasis = 'power' | 'speed' | 'hr';

export interface RaceDebriefConfig {
  /** Window of the normalized-power rolling average */
  npWindowSec: number;
  /** A second half within this % of the first counts as an even split */
  evenSplitPct: number;
  /** Streams shorter than this are not split into halves */
  minStreamSec: number;
  /** Speeds below this (m/s) count as stopped when averaging pace */
  minMovingSpeed: number;
}

export const DEFAULT_RACE_DEBRIEF_CONFIG: RaceDebriefConfig = {
  npWindowSec: 30,
  evenSplitPct: 2,
  minStreamSec: 600,
  minMovingSpeed: 0.3,
};

export interface PowerVsTarget {
  /** np when a power stream gave a normalized power, else the activity average */
  basis: 'np' | 'avg';
  watts: number;
  lowW: number;
  highW: number;
  status: TargetStatus;
}

export interface PowerMetrics {
  avgPower: number;
  normalizedPower: number | null;
  firstHalfPower: number | null;
  secondHalfPower: number | null;
  /** (first − second) / first × 100, positive = faded */
  powerFadePct: number | null;
  vsTarget: PowerVsTarget | null;
}

export interface PaceVsTarget {
  paceSecPerKm: number;
  lowSecPerKm: number;
  highSecPerKm: number;
  /** Seconds per km: below = faster than the band, above = slower */
  status: TargetStatus;
}

export interface PaceMetrics {
  avgPaceSecPerKm: number;
  firstHalfPaceSecPerKm: number | null;
  secondHalfPaceSecPerKm: number | null;
  vsTarget: PaceVsTarget | null;
}

export interface RaceMetrics {
  tier: DebriefTier;
  durationSec: number;
  avgHr: number | null;
  power: PowerMetrics | null;
  pace: PaceMetrics | null;
  /** positive = second half slower, from power (bike) or pace (run); null without halves */
  split: SplitKind | null;
  /** % loss of output per heartbeat between the halves (or the raw HR rise when basis is hr) */
  hrDriftPct: number | null;
  hrDriftBasis: DriftBasis | null;
}

export interface RaceMetricsInput {
  raceType: RaceType;
  activitySport: 'bike' | 'run' | 'other';
  averages: RaceActivityAverages;
  streams: RaceStreams | null;
  targets: { bike: BikeTarget | null; run: RunTarget | null };
}

type Series = readonly (number | null)[];
type Pair = [number | null, number | null];

function usable(series: Series | null | undefined, length: number): series is Series {
  return !!series && series.length === length && series.some((v) => v !== null && v > 0);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Values of `series[from..to)` that are at least `min` (null counts as missing) */
function valuesAtLeast(series: Series, from: number, to: number, min: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const v = series[i];
    if (v !== null && v >= min) out.push(v);
  }
  return out;
}

/** Index of the first sample at or after half of the elapsed time */
function halfIndex(time: readonly number[]): number {
  const mid = (time[0] + (time.at(-1) ?? time[0])) / 2;
  const at = time.findIndex((t) => t >= mid);
  return at < 0 ? time.length : at;
}

/** Normalized power: 4th-power mean of the rolling average, defined once a full window has passed. */
export function normalizedPower(
  time: readonly number[],
  watts: Series,
  windowSec: number = DEFAULT_RACE_DEBRIEF_CONFIG.npWindowSec
): number | null {
  let start = 0;
  let sum = 0;
  let fourth = 0;
  let n = 0;
  for (let i = 0; i < time.length; i++) {
    sum += watts[i] ?? 0;
    while (time[i] - time[start] >= windowSec) {
      sum -= watts[start] ?? 0;
      start++;
    }
    if (time[i] - time[0] >= windowSec - 1) {
      fourth += (sum / (i - start + 1)) ** 4;
      n++;
    }
  }
  return n === 0 ? null : (fourth / n) ** 0.25;
}

function status(value: number, low: number, high: number): TargetStatus {
  if (value < low) return 'below';
  return value > high ? 'above' : 'within';
}

/** `worse` over `better` by more than evenPct is positive; the reverse is negative */
function classify(better: number, worse: number, evenPct: number): SplitKind {
  const change = ((worse - better) / better) * 100;
  if (change > evenPct) return 'positive';
  return change < -evenPct ? 'negative' : 'even';
}

function paceOf(meanSpeed: number | null): number | null {
  return meanSpeed && meanSpeed > 0 ? 1000 / meanSpeed : null;
}

function roundTo(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function fadePct(first: number | null, second: number | null): number | null {
  return first && second ? ((first - second) / first) * 100 : null;
}

interface HalfSeries {
  power: Pair;
  speed: Pair;
  hr: Pair;
}

function halvesOf(
  series: Series | null | undefined,
  length: number,
  cut: number,
  min: number
): Pair {
  if (!usable(series, length)) return [null, null];
  return [mean(valuesAtLeast(series, 0, cut, min)), mean(valuesAtLeast(series, cut, length, min))];
}

function halves(streams: RaceStreams, cfg: RaceDebriefConfig): HalfSeries | null {
  const time = streams.timeSec;
  const length = time.length;
  if (length < 2 || (time.at(-1) ?? time[0]) - time[0] < cfg.minStreamSec) return null;
  const cut = halfIndex(time);
  return {
    power: halvesOf(streams.watts, length, cut, 0),
    speed: halvesOf(streams.velocity, length, cut, cfg.minMovingSpeed),
    hr: halvesOf(streams.heartrate, length, cut, 1),
  };
}

function powerMetrics(
  input: RaceMetricsInput,
  streams: RaceStreams | null,
  parts: HalfSeries | null,
  cfg: RaceDebriefConfig
): PowerMetrics | null {
  const watts = streams && usable(streams.watts, streams.timeSec.length) ? streams.watts : null;
  const avg = watts ? mean(valuesAtLeast(watts, 0, watts.length, 0)) : input.averages.avgPower;
  if (avg === null || avg <= 0) return null;
  const np = watts && streams ? normalizedPower(streams.timeSec, watts, cfg.npWindowSec) : null;
  const [first, second] = parts?.power ?? [null, null];
  const band = input.activitySport === 'bike' ? input.targets.bike : null;
  const compared = np ?? avg;
  return {
    avgPower: Math.round(avg),
    normalizedPower: np === null ? null : Math.round(np),
    firstHalfPower: roundTo(first, 0),
    secondHalfPower: roundTo(second, 0),
    powerFadePct: roundTo(fadePct(first, second)),
    vsTarget: band
      ? {
          basis: np === null ? 'avg' : 'np',
          watts: Math.round(compared),
          lowW: band.lowW,
          highW: band.highW,
          status: status(compared, band.lowW, band.highW),
        }
      : null,
  };
}

function paceMetrics(
  input: RaceMetricsInput,
  streams: RaceStreams | null,
  parts: HalfSeries | null,
  cfg: RaceDebriefConfig
): PaceMetrics | null {
  const velocity =
    streams && usable(streams.velocity, streams.timeSec.length) ? streams.velocity : null;
  const streamAvg = velocity
    ? paceOf(mean(valuesAtLeast(velocity, 0, velocity.length, cfg.minMovingSpeed)))
    : null;
  const { distanceM, durationSec } = input.averages;
  const overall =
    streamAvg ?? (distanceM && distanceM > 0 ? durationSec / (distanceM / 1000) : null);
  if (overall === null) return null;
  const band = input.activitySport === 'run' ? input.targets.run : null;
  const [first, second] = parts?.speed ?? [null, null];
  return {
    avgPaceSecPerKm: Math.round(overall),
    firstHalfPaceSecPerKm: roundTo(paceOf(first), 0),
    secondHalfPaceSecPerKm: roundTo(paceOf(second), 0),
    vsTarget: band
      ? {
          paceSecPerKm: Math.round(overall),
          lowSecPerKm: band.lowSecPerKm,
          highSecPerKm: band.highSecPerKm,
          status: status(overall, band.lowSecPerKm, band.highSecPerKm),
        }
      : null,
  };
}

function splitOf(
  input: RaceMetricsInput,
  parts: HalfSeries | null,
  cfg: RaceDebriefConfig
): SplitKind | null {
  if (!parts) return null;
  const [p1, p2] = parts.power;
  const [s1, s2] = parts.speed;
  const byPower = p1 && p2 ? classify(p2, p1, cfg.evenSplitPct) : null;
  // Slower second half = lower speed, so the second half is the "better" side of the ratio
  const bySpeed = s1 && s2 ? classify(s2, s1, cfg.evenSplitPct) : null;
  return input.activitySport === 'run' ? (bySpeed ?? byPower) : (byPower ?? bySpeed);
}

function drift(parts: HalfSeries | null): { pct: number | null; basis: DriftBasis | null } {
  const [h1, h2] = parts?.hr ?? [null, null];
  if (!parts || !h1 || !h2) return { pct: null, basis: null };
  const outputs: [DriftBasis, Pair][] = [
    ['power', parts.power],
    ['speed', parts.speed],
  ];
  for (const [basis, [o1, o2]] of outputs) {
    if (o1 && o2) return { pct: roundTo(((o1 / h1 - o2 / h2) / (o1 / h1)) * 100), basis };
  }
  // No output stream: the raw HR rise
  return { pct: roundTo(((h2 - h1) / h1) * 100), basis: 'hr' };
}

function tierOf(streams: RaceStreams | null): DebriefTier {
  if (!streams) return 'none';
  const length = streams.timeSec.length;
  if (usable(streams.watts, length)) return 'power';
  return usable(streams.heartrate, length) || usable(streams.velocity, length) ? 'hr' : 'none';
}

/**
 * Pacing metrics for the race activity. Streams give the power tier (a watts stream) or the hr
 * tier (heart rate and/or speed only); without streams only the stored averages are compared.
 */
export function computeRaceMetrics(
  input: RaceMetricsInput,
  cfg: RaceDebriefConfig = DEFAULT_RACE_DEBRIEF_CONFIG
): RaceMetrics {
  const streams = input.streams && input.streams.timeSec.length > 1 ? input.streams : null;
  const parts = streams ? halves(streams, cfg) : null;
  const { pct, basis } = drift(parts);
  const hr =
    streams && usable(streams.heartrate, streams.timeSec.length) ? streams.heartrate : null;
  const hrAvg = hr ? mean(valuesAtLeast(hr, 0, hr.length, 1)) : input.averages.avgHr;
  return {
    tier: tierOf(streams),
    durationSec: input.averages.durationSec,
    avgHr: hrAvg === null ? null : Math.round(hrAvg),
    power: powerMetrics(input, streams, parts, cfg),
    pace: paceMetrics(input, streams, parts, cfg),
    split: splitOf(input, parts, cfg),
    hrDriftPct: pct,
    hrDriftBasis: basis,
  };
}

/** The race activity: same local day as the race, the longest one (a tie goes to the smaller id). */
export function pickRaceActivity<
  T extends { startDateLocal: string; durationSec: number; icuId: string },
>(activities: readonly T[], raceDate: string): T | null {
  return activities
    .filter((a) => a.startDateLocal.slice(0, 10) === raceDate)
    .reduce<T | null>((best, a) => {
      if (best === null || a.durationSec > best.durationSec) return a;
      return a.durationSec === best.durationSec && a.icuId < best.icuId ? a : best;
    }, null);
}

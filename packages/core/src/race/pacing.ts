import { differenceInCalendarDays, parseISO } from 'date-fns';
import { RaceType } from '../season/types';

/** Inclusive low/high range */
type Band = readonly [number, number];

export interface RacePacingConfig {
  /** Bike target as % of FTP; null when the race type has no bike leg */
  bikeFtpPct: Record<RaceType, Band | null>;
  /** Carbohydrate intake in g/h; null when there is no sensible default */
  carbsGPerHour: Record<RaceType, Band | null>;
  /** Race pace as a multiple of the threshold pace (slower than 1) */
  runPaceFactor: Record<RaceType, number | null>;
  /** Width of the run pace band around the target (fraction of the pace) */
  runBandPct: number;
  runThresholdWindowDays: number;
  minEffortMin: number;
  maxEffortMin: number;
}

const OLYMPIC_BIKE: Band = [83, 87];

export const DEFAULT_RACE_PACING_CONFIG: RacePacingConfig = {
  bikeFtpPct: {
    [RaceType.sprint]: [88, 92],
    [RaceType.olympic]: OLYMPIC_BIKE,
    [RaceType.half]: [78, 82],
    [RaceType.full]: [68, 72],
    [RaceType.run]: null,
    [RaceType.other]: null,
  },
  carbsGPerHour: {
    [RaceType.sprint]: [30, 60],
    [RaceType.olympic]: [30, 60],
    [RaceType.half]: [60, 80],
    [RaceType.full]: [70, 90],
    [RaceType.run]: [30, 60],
    [RaceType.other]: null,
  },
  runPaceFactor: {
    [RaceType.sprint]: 1.02,
    [RaceType.olympic]: 1.06,
    [RaceType.half]: 1.1,
    [RaceType.full]: 1.18,
    [RaceType.run]: 1.06,
    [RaceType.other]: null,
  },
  runBandPct: 0.02,
  runThresholdWindowDays: 90,
  minEffortMin: 20,
  maxEffortMin: 60,
};

export interface BikeTarget {
  lowW: number;
  highW: number;
  pctLow: number;
  pctHigh: number;
  /** e.g. "from FTP 300" */
  source: string;
}

export interface RunEffort {
  date: string; // yyyy-MM-dd
  durationSec: number;
  distanceM: number | null;
  avgHr?: number | null;
}

export interface RunThreshold {
  paceSecPerKm: number;
  /** e.g. "best 20–60 min run, 2026-09-20 (10.0 km)" */
  basedOn: string;
}

export interface RunTarget {
  lowSecPerKm: number;
  highSecPerKm: number;
  source: string;
}

export interface FuelingPlan {
  carbsLowGPerH: number;
  carbsHighGPerH: number;
}

export interface PacingPlan {
  bike: BikeTarget | null;
  /** null when there is no recent run threshold data: the brief says so instead of inventing a pace */
  run: RunTarget | null;
  swimNote: string;
  fueling: FuelingPlan | null;
}

export function bikeTarget(
  ftp: number,
  raceType: RaceType,
  config: RacePacingConfig = DEFAULT_RACE_PACING_CONFIG
): BikeTarget | null {
  const band = config.bikeFtpPct[raceType];
  if (!band || !(ftp > 0)) return null;
  return {
    lowW: Math.round((ftp * band[0]) / 100),
    highW: Math.round((ftp * band[1]) / 100),
    pctLow: band[0],
    pctHigh: band[1],
    source: 'from FTP ' + ftp,
  };
}

function effortPace(effort: RunEffort): number | null {
  if (!effort.distanceM || effort.distanceM <= 0) return null;
  return effort.durationSec / (effort.distanceM / 1000);
}

/**
 * Threshold-pace estimate: the fastest recent 20–60 min run. Activities only carry whole-run
 * averages, so this is a rough proxy. Null when nothing qualifies.
 */
export function estimateRunThreshold(
  efforts: readonly RunEffort[],
  today: string,
  config: RacePacingConfig = DEFAULT_RACE_PACING_CONFIG
): RunThreshold | null {
  const minSec = config.minEffortMin * 60;
  const maxSec = config.maxEffortMin * 60;
  let best: { effort: RunEffort; pace: number } | null = null;
  for (const effort of efforts) {
    const age = differenceInCalendarDays(parseISO(today), parseISO(effort.date));
    if (age < 0 || age > config.runThresholdWindowDays) continue;
    if (effort.durationSec < minSec || effort.durationSec > maxSec) continue;
    const pace = effortPace(effort);
    if (pace !== null && (best === null || pace < best.pace)) best = { effort, pace };
  }
  if (!best) return null;
  const km = ((best.effort.distanceM ?? 0) / 1000).toFixed(1);
  return {
    paceSecPerKm: Math.round(best.pace),
    basedOn:
      'best ' +
      config.minEffortMin +
      '–' +
      config.maxEffortMin +
      ' min run, ' +
      best.effort.date +
      ' (' +
      km +
      ' km)',
  };
}

export function runTarget(
  threshold: RunThreshold | null,
  raceType: RaceType,
  config: RacePacingConfig = DEFAULT_RACE_PACING_CONFIG
): RunTarget | null {
  const factor = config.runPaceFactor[raceType];
  if (!threshold || factor === null) return null;
  const center = threshold.paceSecPerKm * factor;
  return {
    lowSecPerKm: Math.round(center * (1 - config.runBandPct)),
    highSecPerKm: Math.round(center * (1 + config.runBandPct)),
    source: 'from ' + threshold.basedOn,
  };
}

const SWIM_NOTES: Record<RaceType, string> = {
  [RaceType.sprint]: 'Start controlled for the first 100 m, then settle into a steady hard effort.',
  [RaceType.olympic]: 'Find feet early and hold a steady effort, no sprint off the start.',
  [RaceType.half]: 'Smooth and easy, stay aerobic and save your legs for the bike.',
  [RaceType.full]: 'Very easy and relaxed, sight often and avoid the crowd at the start.',
  [RaceType.run]: 'No swim leg.',
  [RaceType.other]: 'Settle into a steady effort you can hold to the end.',
};

export function swimNote(raceType: RaceType): string {
  return SWIM_NOTES[raceType];
}

export function fuelingPlan(
  raceType: RaceType,
  config: RacePacingConfig = DEFAULT_RACE_PACING_CONFIG
): FuelingPlan | null {
  const band = config.carbsGPerHour[raceType];
  return band ? { carbsLowGPerH: band[0], carbsHighGPerH: band[1] } : null;
}

export interface PacingInput {
  raceType: RaceType;
  ftp: number;
  runEfforts: readonly RunEffort[];
  today: string;
}

export function buildPacingPlan(
  input: PacingInput,
  config: RacePacingConfig = DEFAULT_RACE_PACING_CONFIG
): PacingPlan {
  const threshold = estimateRunThreshold(input.runEfforts, input.today, config);
  return {
    bike: bikeTarget(input.ftp, input.raceType, config),
    run: runTarget(threshold, input.raceType, config),
    swimNote: swimNote(input.raceType),
    fueling: fuelingPlan(input.raceType, config),
  };
}

/** 312 → "5:12/km" */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const sec = total % 60;
  return Math.floor(total / 60) + ':' + String(sec).padStart(2, '0') + '/km';
}

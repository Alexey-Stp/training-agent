import { BlockGeneratorConfig, floor1, round1 } from './generator-config';
import { TrainingBlockType } from './types';

export type WeekKind = 'load' | 'recovery' | 'taper' | 'race';

export interface VolumeWeek {
  kind: WeekKind;
  hours: number;
}

interface RampState {
  start: number;
  /** Hours of the most recent load week; null before the first one */
  lastLoad: number | null;
  taperWeek: number;
}

/**
 * Week-1 load: the athlete's current weekly load, clamped to
 * [available × minStartFraction, available], so a fit athlete doesn't restart from zero.
 */
export function startingLoad(
  available: number,
  currentLoad: number,
  config: BlockGeneratorConfig
): { start: number; warning: string | null } {
  const floor = floor1(available * config.minStartFraction);
  if (currentLoad > available) {
    return {
      start: floor1(available),
      warning: `Current load ${currentLoad.toString()} h/week is above the ${available.toString()} h/week available; starting at ${floor1(available).toString()} h`,
    };
  }
  if (currentLoad < floor) {
    return {
      start: floor,
      warning: `Current load ${currentLoad.toString()} h/week is low; starting at ${floor.toString()} h/week (${Math.round(config.minStartFraction * 100).toString()}% of available), ease in if this feels like a jump`,
    };
  }
  return { start: floor1(currentLoad), warning: null };
}

function phaseCeiling(type: TrainingBlockType, config: BlockGeneratorConfig): number {
  if (type === TrainingBlockType.base) return config.phaseCeiling.base;
  if (type === TrainingBlockType.build) return config.phaseCeiling.build;
  return config.phaseCeiling.peak;
}

function loadWeek(
  type: TrainingBlockType,
  s: RampState,
  available: number,
  config: BlockGeneratorConfig
): VolumeWeek {
  if (s.lastLoad === null) {
    s.lastLoad = s.start;
    return { kind: 'load', hours: s.start };
  }
  const cap = Math.max(phaseCeiling(type, config) * available, s.start);
  const hours = floor1(Math.min(s.lastLoad * (1 + config.maxWeeklyRamp), cap));
  s.lastLoad = hours;
  return { kind: 'load', hours };
}

function nextWeek(
  index: number,
  type: TrainingBlockType,
  s: RampState,
  available: number,
  config: BlockGeneratorConfig
): VolumeWeek {
  const reference = s.lastLoad ?? s.start;
  if (type === TrainingBlockType.race) {
    return { kind: 'race', hours: round1(reference * config.raceWeekFactor) };
  }
  if (type === TrainingBlockType.taper) {
    const factors = config.taperWeekFactors;
    const factor = factors[Math.min(s.taperWeek, factors.length - 1)];
    s.taperWeek++;
    return { kind: 'taper', hours: round1(reference * factor) };
  }
  if (s.lastLoad !== null && index % config.recoveryEvery === 0) {
    return { kind: 'recovery', hours: round1(s.lastLoad * config.recoveryFactor) };
  }
  return loadWeek(type, s, available, config);
}

/**
 * Weekly hours for each plan week (block types in order, week 1 first). Load weeks grow at most
 * `maxWeeklyRamp` over the previous load week up to the phase ceiling; every `recoveryEvery`th
 * plan week in base/build/peak drops to `recoveryFactor` of the last load week; taper and race
 * weeks scale down from the last load week. `firstIndex` is the plan week of the first entry, so
 * a re-projection that starts mid-season keeps the season's recovery cadence.
 */
export function buildWeeklyVolumes(
  weekTypes: TrainingBlockType[],
  available: number,
  start: number,
  config: BlockGeneratorConfig,
  firstIndex = 1
): VolumeWeek[] {
  const state: RampState = { start, lastLoad: null, taperWeek: 0 };
  return weekTypes.map((type, i) => nextWeek(firstIndex + i, type, state, available, config));
}

import { Sport } from '../types';
import { BlockGeneratorConfig, SportSplit } from './generator-config';
import { RaceType } from './types';

type SplitSport = keyof SportSplit;

function splitKey(sport: Sport | undefined): SplitSport | null {
  if (sport === Sport.swim || sport === Sport.bike || sport === Sport.run) return sport;
  return null;
}

/** True when the weak-sport bias can be applied for this race type (the sport is in the mix). */
function canBias(split: SportSplit, key: SplitSport | null): key is SplitSport {
  return key !== null && split[key] > 0 && split[key] < 1;
}

/**
 * Share of weekly hours per sport. In base weeks the weak sport gains `weakSportBias` percentage
 * points, taken from the other sports in proportion to their shares. Shares always sum to 1.
 */
export function sportShares(
  raceType: RaceType,
  weakSport: Sport | undefined,
  inBase: boolean,
  config: BlockGeneratorConfig
): SportSplit {
  const split = config.sportSplit[raceType];
  const key = splitKey(weakSport);
  if (!inBase || !canBias(split, key)) return { ...split };

  const others = 1 - split[key];
  const bias = Math.min(config.weakSportBias, others);
  const take = (s: SplitSport) =>
    s === key ? split[s] + bias : split[s] - (bias * split[s]) / others;
  return { swim: take('swim'), bike: take('bike'), run: take('run') };
}

/** Why the weak-sport bias was not applied, or null when it was (or none was asked for). */
export function weakSportBiasWarning(
  raceType: RaceType,
  weakSport: Sport | undefined,
  config: BlockGeneratorConfig
): string | null {
  if (weakSport === undefined) return null;
  if (canBias(config.sportSplit[raceType], splitKey(weakSport))) return null;
  return `Weak sport ${weakSport} is not part of the ${raceType} race volume split; no bias applied`;
}

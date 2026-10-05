import { addDays, format, parseISO } from 'date-fns';
import { Sport } from '../types';
import { BlockGeneratorConfig, round1, SportSplit } from './generator-config';
import { sportShares } from './sport-split';
import { RaceType, TrainingBlock, TrainingBlockType } from './types';
import { VolumeWeek, WeekKind } from './volume';

export interface SeasonWeek {
  /** 1-based plan week */
  index: number;
  weekStart: string; // YYYY-MM-DD, a Monday
  blockOrder: number;
  blockType: TrainingBlockType;
  kind: WeekKind;
  hours: number;
  swimH: number;
  bikeH: number;
  runH: number;
}

export type WeekSlot = Pick<SeasonWeek, 'weekStart' | 'blockOrder' | 'blockType'>;

/** One slot per block week, in block order. */
export function weekSlots(blocks: TrainingBlock[]): WeekSlot[] {
  return blocks.flatMap((b) =>
    Array.from({ length: b.weeks }, (_, k) => ({
      weekStart: format(addDays(parseISO(b.startDate), k * 7), 'yyyy-MM-dd'),
      blockOrder: b.order,
      blockType: b.type,
    }))
  );
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface SportSizing {
  raceType: RaceType;
  weakSport?: Sport;
  /** Plan week of the first slot */
  firstIndex: number;
}

/** Splits each week's hours by sport (weak-sport bias in base weeks). */
export function sizeWeeks(
  slots: WeekSlot[],
  volumes: VolumeWeek[],
  sizing: SportSizing,
  config: BlockGeneratorConfig
): SeasonWeek[] {
  return slots.map((slot, i): SeasonWeek => {
    const { kind, hours } = volumes[i];
    const inBase = slot.blockType === TrainingBlockType.base;
    const shares: SportSplit = sportShares(sizing.raceType, sizing.weakSport, inBase, config);
    return {
      index: sizing.firstIndex + i,
      ...slot,
      kind,
      hours,
      swimH: round2(hours * shares.swim),
      bikeH: round2(hours * shares.bike),
      runH: round2(hours * shares.run),
    };
  });
}

function mean(weeks: SeasonWeek[], pick: (w: SeasonWeek) => number): number {
  return weeks.reduce((sum, w) => sum + pick(w), 0) / weeks.length;
}

/** Block targets are the mean of its weeks, converted to metres / km with the configured paces. */
export function withTargets(
  block: TrainingBlock,
  weeks: SeasonWeek[],
  config: BlockGeneratorConfig
): TrainingBlock {
  const own = weeks.filter((w) => w.blockOrder === block.order);
  return {
    ...block,
    targetWeeklyHours: round1(mean(own, (w) => w.hours)),
    targetSwimM: Math.round((mean(own, (w) => w.swimH) * config.swimMPerHour) / 100) * 100,
    targetBikeH: round1(mean(own, (w) => w.bikeH)),
    targetRunKm: round1(mean(own, (w) => w.runH) * config.runKmPerHour),
  };
}

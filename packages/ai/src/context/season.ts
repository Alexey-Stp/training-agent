import { blockWeekAt, seasonRange, type SeasonPlan } from '@triathlon/core';
import { daysBetween } from './trends';
import type { SeasonPosition } from './types';

/** Where `date` sits in the season: block, week of block, season week and days to the A-race. */
export function seasonPosition(season: SeasonPlan | null, date: string): SeasonPosition | null {
  if (!season) return null;
  const blocks = [...season.blocks].sort((a, b) => a.order - b.order);
  const range = seasonRange({ blocks });
  if (!range) return null;

  const at = blockWeekAt(blocks, date);
  const inSeason = date >= range.from && date <= range.to;
  const aRace = season.aRace;
  return {
    seasonStart: range.from,
    seasonEnd: range.to,
    block: at && {
      type: at.block.type,
      focus: at.block.focus,
      order: at.block.order,
      count: blocks.length,
      week: at.weekIndex + 1,
      weeks: at.block.weeks,
    },
    seasonWeek: inSeason ? Math.floor(daysBetween(range.from, date) / 7) + 1 : null,
    seasonWeeks: blocks.reduce((sum, b) => sum + b.weeks, 0),
    aRace,
    daysToARace: aRace ? daysBetween(date, aRace.date) : null,
  };
}

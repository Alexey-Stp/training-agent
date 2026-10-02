import { addDays, format, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { PlannedSessionDraft } from '../planned-session';
import { RulesContext, Session, Sport, UserProfile } from '../types';
import { SeasonPlan, TrainingBlock } from './types';
import { blockEndDate } from './validate';
import { blockWeekStart, expandWeek, weekIndexForDate } from './week-expander';

/** Inclusive `yyyy-MM-dd` date range */
export interface DateRange {
  from: string;
  to: string;
}

/** The athlete's calendar date (yyyy-MM-dd) at `now` in `timezone`. */
export function localToday(now: Date, timezone: string): string {
  return format(toZonedTime(now, timezone), 'yyyy-MM-dd');
}

export function addDaysIso(date: string, days: number): string {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

/** The `days` days after `today`: T+1..T+days. Today itself is never in the window. */
export function rollingWindow(today: string, days: number): DateRange {
  return { from: addDaysIso(today, 1), to: addDaysIso(today, days) };
}

/** First and last day of the season, or null when it has no blocks. */
export function seasonRange(season: Pick<SeasonPlan, 'blocks'>): DateRange | null {
  const blocks = [...season.blocks].sort((a, b) => a.order - b.order);
  const first = blocks.at(0);
  const last = blocks.at(-1);
  if (!first || !last) return null;
  return { from: first.startDate, to: blockEndDate(last) };
}

/** `range` clipped to the season, or null when they don't overlap. */
export function clipToSeason(
  season: Pick<SeasonPlan, 'blocks'>,
  range: DateRange
): DateRange | null {
  const bounds = seasonRange(season);
  if (!bounds) return null;
  const from = range.from > bounds.from ? range.from : bounds.from;
  const to = range.to < bounds.to ? range.to : bounds.to;
  return from <= to ? { from, to } : null;
}

interface BlockWeek {
  block: TrainingBlock;
  weekIndex: number;
}

function blockWeekAt(blocks: TrainingBlock[], date: string): BlockWeek | null {
  for (const block of blocks) {
    const weekIndex = weekIndexForDate(block, date);
    if (weekIndex !== null) return { block, weekIndex };
  }
  return null;
}

/** Every block week that has a day in `range`, in date order. */
function blockWeeksIn(blocks: TrainingBlock[], range: DateRange): BlockWeek[] {
  const weeks: BlockWeek[] = [];
  const seen = new Set<string>();
  for (let date = range.from; date <= range.to; date = addDaysIso(date, 1)) {
    const week = blockWeekAt(blocks, date);
    const key = week ? `${week.block.order.toString()}:${week.weekIndex.toString()}` : '';
    if (week && !seen.has(key)) {
      seen.add(key);
      weeks.push(week);
    }
  }
  return weeks;
}

export interface SeasonDrafts {
  /** Part of the requested range the season covers; null when it covers none of it */
  covered: DateRange | null;
  /** Sessions of the covered days, from `expandWeek` of each block week they fall in */
  drafts: PlannedSessionDraft[];
  /** The rules-applied session each draft came from: `sessions[i]` ↔ `drafts[i]` */
  sessions: Session[];
  /** Expander and rules-engine notes of the expanded weeks */
  warnings: string[];
}

/**
 * Season sessions for the days of `range`. Each block week touching the range is expanded
 * whole (so day placement and the rules engine see the full week) and then cut to the range.
 * `getContext` gets the week's first day, like `/week show`.
 */
export async function seasonDraftsForRange(
  season: Pick<SeasonPlan, 'blocks'>,
  profile: UserProfile,
  range: DateRange,
  getContext: (weekStart: string) => Promise<RulesContext>
): Promise<SeasonDrafts> {
  const covered = clipToSeason(season, range);
  const result: SeasonDrafts = { covered, drafts: [], sessions: [], warnings: [] };
  if (!covered) return result;

  const inRange = (date: string) => date >= covered.from && date <= covered.to;
  const weeks = blockWeeksIn(season.blocks, covered);
  // Independent reads, so they run in parallel; results keep the week order
  const contexts = await Promise.all(
    weeks.map(({ block, weekIndex }) => getContext(blockWeekStart(block, weekIndex)))
  );
  weeks.forEach(({ block, weekIndex }, w) => {
    const week = expandWeek(block, weekIndex, profile, { context: contexts[w] });
    // toPlannedSessions keeps session order and only drops rest days, so the lists line up
    const stored = week.plan.sessions.filter((s) => s.sport !== Sport.rest && s.durationMin > 0);
    week.sessions.forEach((draft, i) => {
      if (!inRange(draft.date)) return;
      result.drafts.push(draft);
      result.sessions.push(stored[i]);
    });
    result.warnings.push(...week.plan.warnings);
  });
  return result;
}
